package ru.sphere.stock.antifraud;

import io.swagger.v3.oas.annotations.media.Schema;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.sphere.stock.admin.SettingsService;
import ru.sphere.stock.alerts.AlertService;
import ru.sphere.stock.catalog.CatalogService;
import ru.sphere.stock.domain.BatchState;
import ru.sphere.stock.domain.Fefo;
import ru.sphere.stock.domain.Money;
import ru.sphere.stock.domain.ProductInfo;
import ru.sphere.stock.events.StockChanged;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.infra.AppClock;
import ru.sphere.stock.ledger.Actor;
import ru.sphere.stock.ledger.Ledger;
import ru.sphere.stock.ledger.MovementType;
import ru.sphere.stock.stock.StockRepository;

/**
 * Инвентаризация (ТЗ 6.10). Система фиксирует момент T, продажи не останавливаются. Ожидаемое на T
 * считается по журналу — сумма всех движений до T, поэтому продажи во время пересчёта не мешают.
 * Недостача — списание «недостача» по FEFO; излишек — партия «излишек» со сроком самой ранней
 * партии продукта (консервативно).
 */
@Service
public class InventoryService {

    @Schema(name = "InventoryLineIn")
    public record LineIn(String productId, long actual) {
    }

    @Schema(name = "InventoryLine")
    public record LineDto(String productId, String productName, String unit, long expected, long actual, long diff,
                          String expectedText, String actualText, String diffText, long diffKop) {
    }

    public record CountDto(long id, Instant startedAt, String startedBy, String status, String confirmedBy,
                           Instant confirmedAt, Long diffKop, List<LineDto> lines) {
    }

    private final JdbcClient jdbc;
    private final AppClock clock;
    private final Ledger ledger;
    private final StockRepository batches;
    private final CatalogService catalog;
    private final SettingsService settings;
    private final AlertService alerts;
    private final AnomalyService anomalies;
    private final ApplicationEventPublisher events;

    public InventoryService(JdbcClient jdbc, AppClock clock, Ledger ledger, StockRepository batches,
                            CatalogService catalog, SettingsService settings, AlertService alerts,
                            AnomalyService anomalies, ApplicationEventPublisher events) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.ledger = ledger;
        this.batches = batches;
        this.catalog = catalog;
        this.settings = settings;
        this.alerts = alerts;
        this.anomalies = anomalies;
        this.events = events;
    }

    @Transactional
    public long start(String locationId, Actor actor) {
        long open = jdbc.sql("SELECT COUNT(*) FROM inventory_counts WHERE location_id = ? AND status IN ('OPEN', 'AWAITING_APPROVAL')")
                .param(locationId).query(Long.class).single();
        if (open > 0) {
            throw ApiException.conflict("Уже идёт инвентаризация");
        }
        return jdbc.sql("INSERT INTO inventory_counts (location_id, started_at, started_by, status) VALUES (?, ?, ?, 'OPEN') RETURNING id")
                .params(locationId, Timestamp.from(clock.now()), actor.userId()).query(Long.class).single();
    }

    /** Ввести факт: ожидаемое на момент T фиксируется по журналу. */
    @Transactional
    public CountDto setLines(String locationId, long countId, List<LineIn> lines) {
        Object[] c = lockCount(locationId, countId);
        if (!"OPEN".equals(c[1])) {
            throw ApiException.conflict("Пересчёт уже отправлен");
        }
        Instant t = (Instant) c[2];
        Map<String, Long> expected = expectedAt(locationId, t);
        for (LineIn l : lines) {
            if (catalog.forLocation(locationId).product(l.productId()) == null || l.actual() < 0) {
                throw ApiException.badRequest("Проверьте строку " + l.productId());
            }
            jdbc.sql("""
                            INSERT INTO inventory_lines (count_id, product_id, expected, actual) VALUES (?, ?, ?, ?)
                            ON CONFLICT (count_id, product_id) DO UPDATE SET actual = EXCLUDED.actual""")
                    .params(countId, l.productId(), expected.getOrDefault(l.productId(), 0L), l.actual()).update();
        }
        return get(locationId, countId);
    }

    /** Отправить: если расхождение дороже порога и отправил не управляющий — ждёт подтверждения. */
    @Transactional
    public CountDto submit(String locationId, long countId, Actor actor) {
        Object[] c = lockCount(locationId, countId);
        if (!"OPEN".equals(c[1])) {
            throw ApiException.conflict("Пересчёт уже отправлен");
        }
        CountDto dto = get(locationId, countId);
        long diffKop = dto.lines().stream().mapToLong(l -> Math.abs(l.diffKop())).sum();
        jdbc.sql("UPDATE inventory_counts SET diff_kop = ? WHERE id = ?").params(diffKop, countId).update();
        if (diffKop > settings.getLongFor(locationId, SettingsService.WRITEOFF_THRESHOLD_KOP) && !actor.hasRole("MANAGER", "ADMIN")) {
            jdbc.sql("UPDATE inventory_counts SET status = 'AWAITING_APPROVAL' WHERE id = ?").param(countId).update();
            alerts.raise(locationId, "INVENTORY_APPROVAL", "WARN", "inventory", Long.toString(countId),
                    "Инвентаризация ждёт подтверждения", "Расхождение " + Money.format(diffKop), clock.now());
            return get(locationId, countId);
        }
        apply(locationId, countId, dto, actor);
        return get(locationId, countId);
    }

    @Transactional
    public CountDto confirm(String locationId, long countId, Actor actor) {
        Object[] c = lockCount(locationId, countId);
        if (!"AWAITING_APPROVAL".equals(c[1])) {
            throw ApiException.conflict("Пересчёт не ждёт подтверждения");
        }
        apply(locationId, countId, get(locationId, countId), actor);
        return get(locationId, countId);
    }

    private void apply(String locationId, long countId, CountDto dto, Actor actor) {
        Ledger.Tx tx = ledger.lock(locationId, clock.now());
        CatalogService.Snapshot cat = catalog.forLocation(locationId);
        UUID op = UUID.randomUUID();
        for (LineDto l : dto.lines()) {
            if (l.diff() == 0) {
                continue;
            }
            ProductInfo p = cat.product(l.productId());
            List<BatchState> live = batches.live(locationId, List.of(l.productId()), true);
            if (l.diff() < 0) {
                // Недостача — по FEFO из того, что физически есть (включая просроченное, но не удержанное).
                long rest = -l.diff();
                for (BatchState b : live.stream().sorted(Fefo.ORDER).toList()) {
                    long take = Math.min(rest, b.qtyLeft() - b.heldQty());
                    if (take <= 0) {
                        continue;
                    }
                    tx.append(MovementType.WRITEOFF_SHORTAGE, b.id(), -take, -b.costOf(take), actor,
                            "Инвентаризация №" + countId, "inventory", Long.toString(countId), op, null);
                    rest -= take;
                    if (rest == 0) {
                        break;
                    }
                }
            } else {
                Instant earliest = live.stream().map(BatchState::expiresAt).min(Instant::compareTo)
                        .orElse(tx.at().plus(p.shelfLife() != null ? p.shelfLife() : Duration.ofDays(1)));
                if (!earliest.isAfter(tx.at())) {
                    earliest = tx.at().plus(Duration.ofHours(1));
                }
                var ex = cat.extra(p.id());
                long cost = ex != null && ex.lastUnitCostKop() != null ? Math.round(ex.lastUnitCostKop() * l.diff()) : 0;
                long id = batches.insert(new StockRepository.NewBatch(locationId, p.id(), "SURPLUS", null, null, op,
                        l.diff(), cost, tx.at(), earliest, tx.at(), false, "И"));
                tx.append(MovementType.SURPLUS, id, l.diff(), cost, actor, "Инвентаризация №" + countId,
                        "inventory", Long.toString(countId), op, null);
            }
        }
        jdbc.sql("UPDATE inventory_counts SET status = 'CONFIRMED', confirmed_by = ?, confirmed_at = ? WHERE id = ?")
                .params(actor.userId(), Timestamp.from(tx.at()), countId).update();
        anomalies.onInventoryConfirmed(locationId, countId);
        events.publishEvent(new StockChanged(locationId, "inventory.confirmed"));
    }

    /** Физический остаток на момент T = сумма всех движений до T (просроченное до списания ещё на полке). */
    public Map<String, Long> expectedAt(String locationId, Instant t) {
        Map<String, Long> m = new HashMap<>();
        jdbc.sql("""
                        SELECT b.product_id, SUM(m.qty) FROM movements m JOIN batches b ON b.id = m.batch_id
                        WHERE m.location_id = ? AND m.at <= ? GROUP BY b.product_id""")
                .params(locationId, Timestamp.from(t))
                .query(rs -> {
                    m.put(rs.getString(1), rs.getLong(2));
                });
        return m;
    }

    public CountDto get(String locationId, long countId) {
        CatalogService.Snapshot cat = catalog.forLocation(locationId);
        var head = jdbc.sql("""
                        SELECT c.id, c.started_at, s.name, c.status, f.name, c.confirmed_at, c.diff_kop
                        FROM inventory_counts c JOIN users s ON s.id = c.started_by LEFT JOIN users f ON f.id = c.confirmed_by
                        WHERE c.id = ? AND c.location_id = ?""")
                .params(countId, locationId)
                .query((rs, n) -> new Object[]{rs.getLong(1), rs.getTimestamp(2).toInstant(), rs.getString(3),
                        rs.getString(4), rs.getString(5),
                        rs.getTimestamp(6) == null ? null : rs.getTimestamp(6).toInstant(), rs.getObject(7)})
                .optional().orElseThrow(() -> ApiException.notFound("Инвентаризация"));
        List<LineDto> lines = new ArrayList<>();
        jdbc.sql("SELECT product_id, expected, actual FROM inventory_lines WHERE count_id = ? ORDER BY product_id")
                .param(countId)
                .query(rs -> {
                    ProductInfo p = cat.product(rs.getString(1));
                    long exp = rs.getLong(2);
                    long act = rs.getLong(3);
                    var ex = cat.extra(p.id());
                    long kop = ex != null && ex.lastUnitCostKop() != null ? Math.round(ex.lastUnitCostKop() * (act - exp)) : 0;
                    lines.add(new LineDto(p.id(), p.name(), p.unit().name(), exp, act, act - exp, p.format(exp),
                            p.format(act), (act - exp > 0 ? "+" : "") + p.format(act - exp), kop));
                });
        return new CountDto((Long) head[0], (Instant) head[1], (String) head[2], (String) head[3], (String) head[4],
                (Instant) head[5], head[6] == null ? null : ((Number) head[6]).longValue(), lines);
    }

    public List<CountDto> list(String locationId) {
        return jdbc.sql("SELECT id FROM inventory_counts WHERE location_id = ? ORDER BY started_at DESC LIMIT 20")
                .param(locationId).query(Long.class).list().stream().map(id -> get(locationId, id)).toList();
    }

    /** Пересчёты, начатые за период [from, to); незавершённый показывается всегда — его нужно довести. */
    public List<CountDto> list(String locationId, java.time.Instant from, java.time.Instant to) {
        return jdbc.sql("""
                        SELECT id FROM inventory_counts WHERE location_id = ?
                          AND ((started_at >= ? AND started_at < ?) OR status IN ('OPEN', 'AWAITING_APPROVAL'))
                        ORDER BY started_at DESC LIMIT 200""")
                .params(locationId, java.sql.Timestamp.from(from), java.sql.Timestamp.from(to))
                .query(Long.class).list().stream().map(id -> get(locationId, id)).toList();
    }

    private Object[] lockCount(String locationId, long countId) {
        return jdbc.sql("SELECT id, status, started_at FROM inventory_counts WHERE id = ? AND location_id = ? FOR UPDATE")
                .params(countId, locationId)
                .query((rs, n) -> new Object[]{rs.getLong(1), rs.getString(2), rs.getTimestamp(3).toInstant()})
                .optional().orElseThrow(() -> ApiException.notFound("Инвентаризация"));
    }
}
