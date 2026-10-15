package ru.sphere.stock.menu;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import ru.sphere.stock.catalog.CatalogService;
import ru.sphere.stock.domain.OpenHours;

/**
 * Единая модель прогноза (п. 6): расход продукта в рабочий час и продажи вариантов в день.
 * Средний за 7 дней, свежие дни весят больше (вес 7 у последних суток … 1 у седьмых),
 * списания не учитываются (ТЗ 5.9). Окна — скользящие сутки от «сейчас», а не календарные дни:
 * иначе сегодняшний неполный день занижал бы прогноз.
 */
@Service
public class ForecastService {

    public record Rates(Map<String, Double> productPerOpenHour, Map<String, Double> variantPerDay, double hoursPerDay) {
    }

    private record Key(String locationId, long hourBucket) {
    }

    private final JdbcClient jdbc;
    private final CatalogService catalog;
    private final Map<Key, Rates> cache = new ConcurrentHashMap<>();
    private final Map<String, OpenHours> hours = new ConcurrentHashMap<>();

    public ForecastService(JdbcClient jdbc, CatalogService catalog) {
        this.jdbc = jdbc;
        this.catalog = catalog;
    }

    public OpenHours hours(String locationId) {
        return hours.computeIfAbsent(locationId, loc -> jdbc.sql(
                        "SELECT open_time, close_time, timezone FROM locations WHERE id = ?")
                .param(loc)
                .query((rs, n) -> new OpenHours(rs.getObject(1, LocalTime.class), rs.getObject(2, LocalTime.class),
                        ZoneId.of(rs.getString(3))))
                .optional()
                .orElse(OpenHours.defaultMsk()));
    }

    public void invalidateHours() {
        hours.clear();
    }

    /** Кэш на час «системного» времени: прогноз меняется медленно. */
    public Rates rates(String locationId, Instant now) {
        Key key = new Key(locationId, now.getEpochSecond() / 3600);
        return cache.computeIfAbsent(key, k -> {
            cache.keySet().removeIf(old -> old.locationId().equals(locationId) && old.hourBucket() != k.hourBucket());
            return compute(locationId, now);
        });
    }

    public void invalidate(String locationId) {
        cache.keySet().removeIf(k -> k.locationId().equals(locationId));
    }

    private Rates compute(String locationId, Instant now) {
        double hpd = hours(locationId).hoursPerDay();
        Timestamp t = Timestamp.from(now);
        Timestamp from = Timestamp.from(now.minus(Duration.ofDays(7)));

        Instant first = jdbc.sql("SELECT MIN(at) FROM movements WHERE location_id = ? AND type IN ('ORDER', 'PRODUCTION_USE')")
                .param(locationId).query((rs, n) -> rs.getTimestamp(1)).optional()
                .map(ts -> ts == null ? null : ts.toInstant()).orElse(null);
        int span = first == null ? 1
                : (int) Math.max(1, Math.min(7, Math.ceil(Duration.between(first, now).toMinutes() / 1440.0)));
        double weightSum = 0;
        for (int d = 0; d < span; d++) {
            weightSum += 7 - d;
        }
        final double ws = weightSum;

        Map<String, Double> product = new HashMap<>();
        jdbc.sql("""
                        SELECT b.product_id, FLOOR(EXTRACT(EPOCH FROM (?::timestamptz - m.at)) / 86400)::int AS d, -SUM(m.qty)
                        FROM movements m JOIN batches b ON b.id = m.batch_id
                        WHERE m.location_id = ? AND m.type IN ('ORDER', 'PRODUCTION_USE', 'ORDER_RETURN')
                          AND m.at > ? AND m.at <= ?
                        GROUP BY 1, 2""")
                .params(t, locationId, from, t)
                .query(rs -> {
                    int d = rs.getInt(2);
                    if (d < span) {
                        product.merge(rs.getString(1), (7 - d) * rs.getDouble(3) / ws, Double::sum);
                    }
                });
        Map<String, Double> perHour = new HashMap<>();
        product.forEach((pid, daily) -> perHour.put(pid, Math.max(0, daily) / hpd));
        // Новый продукт без истории — ручной «ожидаемый расход» (ТЗ 5.9).
        CatalogService.Snapshot cat = catalog.forLocation(locationId);
        for (var p : cat.products()) {
            var ex = cat.extra(p.id());
            if (!perHour.containsKey(p.id()) && ex != null && ex.expectedDailyUse() != null) {
                perHour.put(p.id(), ex.expectedDailyUse() / hpd);
            }
        }

        Map<String, Double> variant = new HashMap<>();
        jdbc.sql("""
                        SELECT l.variant_id, FLOOR(EXTRACT(EPOCH FROM (?::timestamptz - o.created_at)) / 86400)::int AS d, SUM(l.qty)
                        FROM order_lines l JOIN orders o ON o.id = l.order_id
                        WHERE o.location_id = ? AND o.status <> 'CANCELED' AND o.created_at > ? AND o.created_at <= ?
                        GROUP BY 1, 2""")
                .params(t, locationId, from, t)
                .query(rs -> {
                    int d = rs.getInt(2);
                    if (d < span) {
                        variant.merge(rs.getString(1), (7 - d) * rs.getDouble(3) / ws, Double::sum);
                    }
                });
        return new Rates(perHour, variant, hpd);
    }
}
