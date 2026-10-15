package ru.sphere.stock.stock;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;
import ru.sphere.stock.domain.Money;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.tenant.TenantDirectory;
import ru.sphere.stock.admin.SettingsService;
import ru.sphere.stock.alerts.AlertService;
import ru.sphere.stock.catalog.CatalogService;
import ru.sphere.stock.domain.BatchState;
import ru.sphere.stock.domain.BatchStatus;
import ru.sphere.stock.domain.ExpiryPolicy;
import ru.sphere.stock.domain.HotOffers;
import ru.sphere.stock.domain.ProductInfo;
import ru.sphere.stock.events.EventBus;
import ru.sphere.stock.events.StockChanged;
import ru.sphere.stock.infra.AppClock;
import ru.sphere.stock.ledger.Actor;
import ru.sphere.stock.ledger.Ledger;
import ru.sphere.stock.ledger.MovementType;

/**
 * Каждые 2 секунды реального времени (ТЗ 5.8, 16.1): партии с истёкшим сроком — «под списание»
 * (из продаж они уходят сами: доступно только годное), сигналы «скоро истекает» и «критично», тик
 * демо-часов для браузеров. Просрочку списывает человек — кнопкой «Списать просрочку»; автосписание
 * системой (Д1 из PDF) — настройка предприятия, по умолчанию выключена.
 */
@Component
public class ExpiryJob {

    private static final Logger log = LoggerFactory.getLogger(ExpiryJob.class);

    /** Партия под списанием: что, сколько, на какую сумму и сколько уже лежит. */
    public record ExpiredBatch(long batchId, String label, String productId, String productName, long qty,
                               String qtyText, long costKop, Instant expiredAt, double hoursAgo) {
    }

    private final JdbcClient jdbc;
    private final AppClock clock;
    private final Ledger ledger;
    private final StockRepository batches;
    private final CatalogService catalog;
    private final AlertService alerts;
    private final EventBus bus;
    private final ApplicationEventPublisher events;
    private final TransactionTemplate tx;
    private final SettingsService settings;
    private final TenantDirectory tenants;

    public ExpiryJob(JdbcClient jdbc, AppClock clock, Ledger ledger, StockRepository batches, CatalogService catalog,
                     AlertService alerts, EventBus bus, ApplicationEventPublisher events, TransactionTemplate tx,
                     SettingsService settings, TenantDirectory tenants) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.ledger = ledger;
        this.batches = batches;
        this.catalog = catalog;
        this.alerts = alerts;
        this.bus = bus;
        this.events = events;
        this.tx = tx;
        this.settings = settings;
        this.tenants = tenants;
    }

    /** Раз в 2 секунды — по расписанию из {@link ru.sphere.stock.infra.ScheduledJobs}. */
    public void tick() {
        try {
            for (String loc : tenants.allLocations()) {
                if (settings.getBool(tenants.tenantOf(loc), SettingsService.AUTO_WRITEOFF_EXPIRED)) {
                    writeOffExpired(loc, Actor.SYSTEM);
                } else {
                    flagExpired(loc);
                }
                statusAlerts(loc);
            }
            var s = clock.state();
            bus.publishAll("clock", Map.of("now", clock.now().toString(), "mode", s.mode().name(),
                    "speed", s.speed(), "paused", s.paused()));
        } catch (RuntimeException e) {
            log.warn("expiry tick failed: {}", e.toString());
        }
    }

    /** Партии точки, у которых истёк срок, а остаток ещё числится: их надо списать. */
    public List<ExpiredBatch> expired(String locationId) {
        Instant now = clock.now();
        CatalogService.Snapshot cat = catalog.forLocation(locationId);
        return jdbc.sql("""
                        SELECT id, label, product_id, qty_left, cost_total_kop, qty_initial, expires_at FROM batches
                        WHERE location_id = ? AND qty_left > 0 AND expires_at <= ? ORDER BY expires_at, id""")
                .params(locationId, Timestamp.from(now))
                .query((rs, n) -> {
                    ProductInfo p = cat.product(rs.getString(3));
                    long qty = rs.getLong(4);
                    long cost = Math.round((double) rs.getLong(5) * qty / rs.getLong(6));
                    Instant at = rs.getTimestamp(7).toInstant();
                    return new ExpiredBatch(rs.getLong(1), rs.getString(2), p.id(), p.name(), qty, p.format(qty), cost,
                            at, java.time.Duration.between(at, now).toMinutes() / 60.0);
                })
                .list();
    }

    /**
     * Критичный сигнал «спишите» — один на партию. Отметка «увидел» его закрывает, но напоминание остаётся:
     * партия висит в «Под списанием» и красной кнопкой на дашборде, пока её не спишут.
     */
    private void flagExpired(String locationId) {
        Instant now = clock.now();
        for (ExpiredBatch e : expired(locationId)) {
            alerts.raiseOnce(locationId, "BATCH_EXPIRED", "CRITICAL", "batch", Long.toString(e.batchId()),
                    "Истёк срок — спишите: " + e.productName(),
                    e.qtyText() + " на " + Money.format(e.costKop()) + " · партия " + e.label(), now);
        }
    }

    /**
     * Списать всю просрочку точки.
     *
     * @param actor человек (кнопка «Списать всю просрочку», утренний обход в демо) или система (автосписание)
     * @return сколько партий списано
     */
    public int writeOffExpired(String locationId, Actor actor) {
        Integer n = tx.execute(status -> {
            List<Long> ids = jdbc.sql("SELECT id FROM batches WHERE location_id = ? AND qty_left > 0 AND expires_at <= ?")
                    .params(locationId, Timestamp.from(clock.now())).query(Long.class).list();
            if (ids.isEmpty()) {
                return 0;
            }
            Ledger.Tx ltx = ledger.lock(locationId, clock.now());
            UUID op = UUID.randomUUID();
            int count = 0;
            for (long id : ids) {
                count += writeOff(locationId, id, ltx, op, actor) > 0 ? 1 : 0;
            }
            if (count > 0) {
                events.publishEvent(new StockChanged(locationId, "batch.expired"));
            }
            return count;
        });
        return n == null ? 0 : n;
    }

    /**
     * Списать одну партию как просрочку. Только если срок действительно истёк по серверным часам —
     * свежую партию так не спишешь (ТЗ 6.6). Списывается весь остаток.
     *
     * @return списанная сумма, коп.
     */
    public long writeOffExpiredBatch(String locationId, long batchId, Actor actor) {
        Long cost = tx.execute(status -> {
            String loc = jdbc.sql("SELECT location_id FROM batches WHERE id = ?").param(batchId).query(String.class)
                    .optional().orElse(null);
            if (!locationId.equals(loc)) {
                throw ApiException.notFound("Партия");
            }
            // Сначала склад точки, потом партия — тот же порядок блокировок, что у заказов: без взаимоблокировок.
            Ledger.Tx ltx = ledger.lock(locationId, clock.now());
            BatchState b = batches.get(batchId, true);
            if (b == null || b.qtyLeft() <= 0) {
                throw ApiException.conflict("Партия уже списана или израсходована");
            }
            if (b.expiresAt().isAfter(ltx.at())) {
                throw ApiException.conflict("Срок партии ещё не истёк — списать её как просрочку нельзя. "
                        + "Если она испортилась раньше, оформите заявку на списание (порча)");
            }
            long c = writeOff(locationId, batchId, ltx, UUID.randomUUID(), actor);
            events.publishEvent(new StockChanged(locationId, "batch.expired"));
            return c;
        });
        return cost == null ? 0 : cost;
    }

    /** @return списанная сумма; 0 — списывать нечего. Вызывается под блокировкой склада точки. */
    private long writeOff(String locationId, long id, Ledger.Tx ltx, UUID op, Actor actor) {
        BatchState b = batches.get(id, true);
        if (b == null || b.qtyLeft() <= 0 || b.expiresAt().isAfter(ltx.at())) {
            return 0;
        }
        boolean system = actor.kind() == Actor.Kind.SYSTEM;
        // Заявка на порчу по истёкшей партии теряет смысл — партию списывают как просрочку.
        jdbc.sql("""
                        UPDATE writeoff_requests SET status = 'REJECTED', decided_at = ?,
                               decision_comment = 'Партия истекла раньше решения — списана как просрочка'
                        WHERE batch_id = ? AND status = 'PENDING'""")
                .params(Timestamp.from(ltx.at()), id).update();
        if (b.heldQty() > 0) {
            batches.setHeld(id, -b.heldQty());
        }
        long cost = b.costOf(b.qtyLeft());
        ltx.append(MovementType.WRITEOFF_EXPIRED, id, -b.qtyLeft(), -cost, actor, "Истёк срок годности",
                "expiry", Long.toString(id), op, null);
        ProductInfo p = catalog.forLocation(locationId).product(b.productId());
        if (system) {
            alerts.raise(locationId, "BATCH_EXPIRED", "WARN", "batch", Long.toString(id),
                    "Списана просрочка: " + p.name(), p.format(b.qtyLeft()) + " на " + Money.format(cost), ltx.at());
        } else {
            // Сигнал «спишите» выполнен: закрываем его от имени того, кто списал.
            jdbc.sql("""
                            UPDATE alerts SET ack_by = ?, ack_at = ? WHERE location_id = ? AND type = 'BATCH_EXPIRED'
                              AND object_type = 'batch' AND object_id = ? AND ack_at IS NULL""")
                    .params(actor.userId(), Timestamp.from(ltx.at()), locationId, Long.toString(id)).update();
        }
        return cost;
    }

    private void statusAlerts(String locationId) {
        Instant now = clock.now();
        CatalogService.Snapshot cat = catalog.forLocation(locationId);
        tx.executeWithoutResult(status -> batches.liveByProduct(locationId).forEach((pid, list) -> {
            ProductInfo p = cat.product(pid);
            for (BatchState b : list) {
                if (b.blocked() || !b.usableAt(now)) {
                    continue;
                }
                BatchStatus st = ExpiryPolicy.status(b, p, now);
                double hours = java.time.Duration.between(now, b.expiresAt()).toMinutes() / 60.0;
                if (st == BatchStatus.CRITICAL) {
                    alerts.raiseOnce(locationId, "BATCH_CRITICAL", "CRITICAL", "batch", Long.toString(b.id()),
                            "Критично: " + p.name(), p.format(b.qtyLeft()) + ", осталось " + HotOffers.humanHours(hours), now);
                } else if (st == BatchStatus.SOON) {
                    alerts.raiseOnce(locationId, "BATCH_SOON", "INFO", "batch", Long.toString(b.id()),
                            "Скоро истекает: " + p.name(), p.format(b.qtyLeft()) + ", осталось " + HotOffers.humanHours(hours), now);
                }
            }
        }));
    }
}
