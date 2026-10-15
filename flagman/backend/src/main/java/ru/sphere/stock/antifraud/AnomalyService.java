package ru.sphere.stock.antifraud;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.sphere.stock.admin.SettingsService;
import ru.sphere.stock.alerts.AlertService;
import ru.sphere.stock.domain.BatchState;
import ru.sphere.stock.domain.Money;
import ru.sphere.stock.domain.OpenHours;
import ru.sphere.stock.domain.ProductInfo;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.infra.AppClock;
import ru.sphere.stock.infra.Json;
import ru.sphere.stock.ledger.Actor;
import ru.sphere.stock.menu.ForecastService;
import ru.sphere.stock.tenant.TenantDirectory;

/**
 * Поиск аномалий (ТЗ 6.11). Найденное попадает в отчёт «Подозрительные операции» с цифрами-доказательствами,
 * управляющий получает сигнал. Одно и то же нарушение не дублируется (правило + ключ).
 */
@Service
public class AnomalyService {

    private static final Logger log = LoggerFactory.getLogger(AnomalyService.class);

    public record AnomalyDto(long id, String rule, String ruleTitle, Long actorId, String actorName, Instant detectedAt,
                             String title, String evidence, String status, String comment, String reviewedBy) {
    }

    public static final Map<String, String> RULES = new LinkedHashMap<>();

    static {
        RULES.put("A1", "Списывает больше других");
        RULES.put("A2", "Списание свежего продукта");
        RULES.put("A3", "Списания перед закрытием");
        RULES.put("A4", "Списание дорогой позиции");
        RULES.put("A5", "Частые отмены после готовки");
        RULES.put("A6", "Рост граммовки в техкарте");
        RULES.put("A7", "Повторная недостача");
        RULES.put("A8", "Повторные расхождения приёмки");
    }

    private final JdbcClient jdbc;
    private final AppClock clock;
    private final SettingsService settings;
    private final AlertService alerts;
    private final ForecastService forecast;
    private final Json json;
    private final TenantDirectory tenants;

    public AnomalyService(JdbcClient jdbc, AppClock clock, SettingsService settings, AlertService alerts,
                          ForecastService forecast, Json json, TenantDirectory tenants) {
        this.tenants = tenants;
        this.jdbc = jdbc;
        this.clock = clock;
        this.settings = settings;
        this.alerts = alerts;
        this.forecast = forecast;
        this.json = json;
    }

    /** @return {@code true}, если аномалия новая. */
    public boolean record(String locationId, String rule, String dedupKey, Long actorId, String title,
                          Map<String, ?> evidence, Instant at) {
        Long id = jdbc.sql("""
                        INSERT INTO anomalies (location_id, rule, dedup_key, actor_id, detected_at, title, evidence)
                        VALUES (?, ?, ?, ?, ?, ?, ?::jsonb) ON CONFLICT (tenant_id, rule, dedup_key) DO NOTHING
                        RETURNING id""")
                .params(locationId, rule, dedupKey, actorId, Timestamp.from(at), title, json.write(evidence))
                .query(Long.class).optional().orElse(null);
        if (id != null) {
            // Сигнал ссылается на саму операцию: по нему сразу открываются её подробности.
            alerts.raise(locationId, "ANOMALY", "WARN", "anomaly", Long.toString(id),
                    "Подозрительная операция: " + RULES.get(rule), title, at);
        }
        return id != null;
    }

    // ── Правила, которые проверяются в момент действия ─────────────────────

    /**
     * A2 и A4 — при ручном списании. A2 («списание свежего») — только когда продукт объявляют испорченным:
     * разбитое или пролитое свежим и должно быть, а частые «проливы» ловит A1.
     */
    public void onManualWriteoff(String locationId, long requestId, BatchState b, ProductInfo p, long qty, long costKop,
                                 String reason, Actor actor, Instant now) {
        double life = Duration.between(b.baseDate(), b.expiresAt()).toMinutes();
        double left = Duration.between(now, b.expiresAt()).toMinutes();
        double share = settings.getDoubleFor(locationId, SettingsService.A2_FRESH_SHARE);
        if (!"DAMAGED".equals(reason) && life > 0 && left / life > share) {
            record(locationId, "A2", "req:" + requestId, actor.userId(),
                    actor.name() + " списывает «" + p.name() + "», у которого осталось "
                            + Math.round(100 * left / life) + "% срока",
                    Map.of("requestId", requestId, "batchId", b.id(), "qty", p.format(qty),
                            "leftPercent", Math.round(100 * left / life), "costKop", costKop), now);
        }
        long threshold = settings.getLongFor(locationId, SettingsService.WRITEOFF_THRESHOLD_KOP);
        Double p90 = jdbc.sql("SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY last_unit_cost_kop) FROM products "
                        + "WHERE tenant_id = ? AND last_unit_cost_kop IS NOT NULL AND unit = ?")
                .params(tenants.tenantOf(locationId), p.unit().name()).query(Double.class).optional().orElse(null);
        boolean expensiveItem = p90 != null && b.unitCostKop() >= p90 && b.unitCostKop() > 0;
        if (costKop > 2 * threshold || expensiveItem) {
            record(locationId, "A4", "req:" + requestId, actor.userId(),
                    actor.name() + " списывает дорогую позицию «" + p.name() + "» на " + Money.format(costKop),
                    Map.of("requestId", requestId, "costKop", costKop, "topPriceItem", expensiveItem), now);
        }
    }

    /** Строка групповой заявки: партия, продукт, сколько и на сколько. */
    public record GroupLine(BatchState batch, ProductInfo product, long qty, long costKop) {
    }

    /**
     * A2 и A4 для групповой заявки — одна запись на всю группу, а не на каждый ингредиент напитка.
     * A4 для напитка или блюда — по общей сумме: дорогой за грамм кофе в чашке не делает чашку «дорогой позицией».
     */
    public void onGroupWriteoff(String locationId, String groupId, long firstRequestId, String what, boolean dish,
                                List<GroupLine> lines, long totalKop, String reason, Actor actor, Instant now) {
        double share = settings.getDoubleFor(locationId, SettingsService.A2_FRESH_SHARE);
        double freshest = 0;
        for (GroupLine l : lines) {
            double life = Duration.between(l.batch().baseDate(), l.batch().expiresAt()).toMinutes();
            double left = Duration.between(now, l.batch().expiresAt()).toMinutes();
            if (life > 0) {
                freshest = Math.max(freshest, left / life);
            }
        }
        if (!"DAMAGED".equals(reason) && freshest > share) {
            record(locationId, "A2", "group:" + groupId, actor.userId(),
                    actor.name() + " списывает «" + what + "» как испорченное, а продукты свежие: оставалось до "
                            + Math.round(100 * freshest) + "% срока",
                    Map.of("requestId", firstRequestId, "groupId", groupId, "leftPercent", Math.round(100 * freshest),
                            "costKop", totalKop), now);
        }
        long threshold = settings.getLongFor(locationId, SettingsService.WRITEOFF_THRESHOLD_KOP);
        boolean expensiveItem = false;
        if (!dish) {
            GroupLine l = lines.getFirst();
            Double p90 = jdbc.sql("SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY last_unit_cost_kop) FROM products "
                            + "WHERE tenant_id = ? AND last_unit_cost_kop IS NOT NULL AND unit = ?")
                    .params(tenants.tenantOf(locationId), l.product().unit().name()).query(Double.class).optional()
                    .orElse(null);
            expensiveItem = p90 != null && l.batch().unitCostKop() >= p90 && l.batch().unitCostKop() > 0;
        }
        if (totalKop > 2 * threshold || expensiveItem) {
            record(locationId, "A4", "group:" + groupId, actor.userId(),
                    actor.name() + " списывает дорогую позицию «" + what + "» на " + Money.format(totalKop),
                    Map.of("requestId", firstRequestId, "groupId", groupId, "costKop", totalKop,
                            "topPriceItem", expensiveItem), now);
        }
    }

    /** A6 — рост брутто строки техкарты больше чем на 20%. */
    public void onRecipeChange(String locationId, String ownerName, String productName, long oldNet, long newNet,
                               Actor actor, long versionId) {
        double growth = settings.getDoubleFor(locationId, SettingsService.A6_RECIPE_GROWTH);
        if (oldNet > 0 && (double) (newNet - oldNet) / oldNet > growth) {
            record(locationId, "A6", "v" + versionId + ":" + productName, actor.userId(),
                    "Техкарта «" + ownerName + "»: " + productName + " " + oldNet + " → " + newNet
                            + " (+" + Math.round(100.0 * (newNet - oldNet) / oldNet) + "%)",
                    Map.of("versionId", versionId, "old", oldNet, "new", newNet), clock.now());
        }
    }

    /** A7 — недостача одного продукта в двух инвентаризациях подряд. */
    public void onInventoryConfirmed(String locationId, long countId) {
        jdbc.sql("""
                        WITH last2 AS (
                            SELECT id FROM inventory_counts WHERE location_id = ? AND status = 'CONFIRMED'
                            ORDER BY confirmed_at DESC LIMIT 2)
                        SELECT l.product_id, p.name, COUNT(*) FROM inventory_lines l
                            JOIN products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id
                        WHERE l.count_id IN (SELECT id FROM last2) AND l.actual < l.expected
                        GROUP BY l.product_id, p.name HAVING COUNT(*) = 2""")
                .param(locationId)
                .query(rs -> {
                    record(locationId, "A7", "count:" + countId + ":" + rs.getString(1), null,
                            "Недостача «" + rs.getString(2) + "» вторую инвентаризацию подряд",
                            Map.of("countId", countId, "productId", rs.getString(1)), clock.now());
                });
    }

    /** A8 — третье расхождение приёмки за 30 дней у кладовщика или поставщика. */
    public void onDeliveryDiff(String locationId, String deliveryId, Long storekeeperId, String supplier) {
        Instant now = clock.now();
        Timestamp from = Timestamp.from(now.minus(Duration.ofDays(30)));
        long byUser = storekeeperId == null ? 0 : jdbc.sql("SELECT COUNT(*) FROM deliveries WHERE location_id = ? "
                        + "AND status IN ('ACCEPTED_DIFF', 'PARTIAL') AND accepted_by = ? AND accepted_at > ?")
                .params(locationId, storekeeperId, from).query(Long.class).single();
        long bySupplier = supplier == null ? 0 : jdbc.sql("SELECT COUNT(*) FROM deliveries WHERE location_id = ? "
                        + "AND status IN ('ACCEPTED_DIFF', 'PARTIAL') AND supplier = ? AND accepted_at > ?")
                .params(locationId, supplier, from).query(Long.class).single();
        if (byUser >= 3) {
            record(locationId, "A8", "user:" + storekeeperId + ":" + deliveryId, storekeeperId,
                    byUser + " приёмки с расхождениями за 30 дней у одного кладовщика",
                    Map.of("deliveryId", deliveryId, "count", byUser), now);
        }
        if (bySupplier >= 3) {
            record(locationId, "A8", "supplier:" + supplier + ":" + deliveryId, null,
                    bySupplier + " приёмки с расхождениями за 30 дней от поставщика «" + supplier + "»",
                    Map.of("deliveryId", deliveryId, "count", bySupplier, "supplier", supplier), now);
        }
    }

    // ── Правила, которые проверяются периодически ──────────────────────────

    /** Раз в 15 секунд — по расписанию из {@link ru.sphere.stock.infra.ScheduledJobs}. */
    public void scan() {
        try {
            for (String loc : jdbc.sql("SELECT id FROM locations").query(String.class).list()) {
                scanLocation(loc);
            }
        } catch (RuntimeException e) {
            log.warn("anomaly scan failed: {}", e.toString());
        }
    }

    public void scanLocation(String loc) {
        Instant now = clock.now();
        Timestamp week = Timestamp.from(now.minus(Duration.ofDays(7)));
        long threshold = settings.getLongFor(loc, SettingsService.WRITEOFF_THRESHOLD_KOP);
        String bucket = LocalDate.ofInstant(now, OpenHours.MSK).toString();

        // A1: ручные списания сотрудника за 7 дней больше медианы его роли в N раз.
        double factor = settings.getDoubleFor(loc, SettingsService.A1_FACTOR);
        Map<String, List<long[]>> byRole = new HashMap<>();
        Map<Long, String> names = new HashMap<>();
        jdbc.sql("""
                        SELECT m.role, u.id, u.name, SUM(r.cost_kop) FROM writeoff_requests r JOIN users u ON u.id = r.created_by
                        JOIN memberships m ON m.user_id = u.id AND m.tenant_id = r.tenant_id
                        WHERE r.location_id = ? AND r.created_at > ? AND r.status <> 'REJECTED'
                        GROUP BY m.role, u.id, u.name""")
                .params(loc, week)
                .query(rs -> {
                    byRole.computeIfAbsent(rs.getString(1), k -> new ArrayList<>())
                            .add(new long[]{rs.getLong(2), rs.getLong(4)});
                    names.put(rs.getLong(2), rs.getString(3));
                });
        byRole.forEach((role, list) -> {
            if (list.size() < 2) {
                return;
            }
            long[] sums = list.stream().mapToLong(a -> a[1]).sorted().toArray();
            double median = sums.length % 2 == 1 ? sums[sums.length / 2]
                    : (sums[sums.length / 2 - 1] + sums[sums.length / 2]) / 2.0;
            for (long[] u : list) {
                if (u[1] >= threshold && u[1] > factor * median) {
                    record(loc, "A1", u[0] + ":" + bucket, u[0],
                            names.get(u[0]) + " списал(а) за неделю " + Money.format(u[1]) + " — в "
                                    + Math.round(u[1] / Math.max(1, median)) + " раз больше медианы по роли",
                            Map.of("sumKop", u[1], "medianKop", median, "role", role), now);
                }
            }
        });

        // A3: доля ручных списаний в последний час перед закрытием.
        OpenHours hours = forecast.hours(loc);
        Instant closing = hours.closingOf(now);
        Instant dayStart = closing.minus(Duration.ofHours(24));
        double share = settings.getDoubleFor(loc, SettingsService.A3_CLOSING_SHARE);
        jdbc.sql("""
                        SELECT r.created_by, u.name, COUNT(*) AS total,
                               COUNT(*) FILTER (WHERE r.created_at > ?::timestamptz - INTERVAL '1 hour' AND r.created_at <= ?) AS late
                        FROM writeoff_requests r JOIN users u ON u.id = r.created_by
                        WHERE r.location_id = ? AND r.created_at > ? AND r.created_at <= ?
                        GROUP BY r.created_by, u.name""")
                .params(Timestamp.from(closing), Timestamp.from(closing), loc, Timestamp.from(dayStart),
                        Timestamp.from(closing))
                .query(rs -> {
                    long total = rs.getLong(3);
                    long late = rs.getLong(4);
                    if (total >= 3 && (double) late / total > share) {
                        record(loc, "A3", rs.getLong(1) + ":" + LocalDate.ofInstant(closing, hours.zone()), rs.getLong(1),
                                rs.getString(2) + ": " + late + " из " + total + " списаний за день — в последний час перед закрытием",
                                Map.of("late", late, "total", total), now);
                    }
                });

        // A5: поздние отмены сотрудника.
        long maxLate = settings.getLongFor(loc, SettingsService.A5_LATE_CANCELS);
        jdbc.sql("""
                        SELECT o.canceled_by, u.name, COUNT(*), SUM(o.cost_kop) FROM orders o JOIN users u ON u.id = o.canceled_by
                        WHERE o.location_id = ? AND o.status = 'CANCELED_LATE' AND o.canceled_at > ?
                        GROUP BY o.canceled_by, u.name HAVING COUNT(*) > ?""")
                .params(loc, week, maxLate)
                .query(rs -> {
                    record(loc, "A5", rs.getLong(1) + ":" + bucket, rs.getLong(1),
                            rs.getString(2) + ": " + rs.getLong(3) + " отмен после начала готовки за 7 дней, потери "
                                    + Money.format(rs.getLong(4)),
                            Map.of("count", rs.getLong(3), "lossKop", rs.getLong(4)), now);
                });
    }

    /**
     * Подозрительные операции точки за период (ТЗ 6.11): {@code from} и {@code to} — дни по московскому времени
     * включительно; {@code null} — без границы.
     */
    public List<AnomalyDto> list(String locationId, String status, LocalDate from, LocalDate to) {
        Timestamp since = from == null ? null : Timestamp.from(from.atStartOfDay(OpenHours.MSK).toInstant());
        Timestamp until = to == null ? null : Timestamp.from(to.plusDays(1).atStartOfDay(OpenHours.MSK).toInstant());
        return jdbc.sql(SELECT + """
                        WHERE a.location_id = ? AND (?::text IS NULL OR a.status = ?)
                          AND (?::timestamptz IS NULL OR a.detected_at >= ?)
                          AND (?::timestamptz IS NULL OR a.detected_at < ?)
                        ORDER BY a.detected_at DESC LIMIT 500""")
                .params(locationId, status, status, since, since, until, until)
                .query((rs, n) -> map(rs))
                .list();
    }

    public AnomalyDto one(String locationId, long id) {
        return jdbc.sql(SELECT + " WHERE a.location_id = ? AND a.id = ?").params(locationId, id)
                .query((rs, n) -> map(rs)).optional()
                .orElseThrow(() -> ApiException.notFound("Подозрительная операция"));
    }

    private static final String SELECT = """
            SELECT a.id, a.rule, a.actor_id, u.name, a.detected_at, a.title, a.evidence::text, a.status,
                   a.comment, r.name
            FROM anomalies a LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN users r ON r.id = a.reviewed_by
            """;

    private static AnomalyDto map(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new AnomalyDto(rs.getLong(1), rs.getString(2), RULES.get(rs.getString(2)), (Long) rs.getObject(3),
                rs.getString(4), rs.getTimestamp(5).toInstant(), rs.getString(6), rs.getString(7), rs.getString(8),
                rs.getString(9), rs.getString(10));
    }

    /**
     * Решение по операции — одно из двух: CONFIRMED — подозрение подтвердилось, FALSE — ложная тревога.
     * Решить можно новую (и старую «проверенную»); уже решённую — нет.
     */
    @Transactional
    public void review(String locationId, long id, String status, String comment, Actor actor) {
        if (!List.of("CONFIRMED", "FALSE").contains(status)) {
            throw ApiException.badRequest("Решение — CONFIRMED (подтвердить подозрение) или FALSE (ложная тревога)");
        }
        int n = jdbc.sql("""
                        UPDATE anomalies SET status = ?, comment = ?, reviewed_by = ?
                        WHERE id = ? AND location_id = ? AND status IN ('NEW', 'REVIEWED')""")
                .params(status, comment == null || comment.isBlank() ? null : comment.trim(), actor.userId(), id,
                        locationId).update();
        if (n == 0) {
            one(locationId, id);                         // нет такой — 404, иначе уже решена
            throw ApiException.conflict("Операция уже разобрана");
        }
        // Разобрали — сигнал «Подозрительная операция» в колокольчике закрывается сам.
        jdbc.sql("""
                        UPDATE alerts SET ack_by = ?, ack_at = ? WHERE location_id = ? AND type = 'ANOMALY' AND ack_at IS NULL
                          AND object_id IN (?, (SELECT rule || ':' || dedup_key FROM anomalies WHERE id = ?))""")
                .params(actor.userId(), Timestamp.from(clock.now()), locationId, Long.toString(id), id).update();
    }
}
