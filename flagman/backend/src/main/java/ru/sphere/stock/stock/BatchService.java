package ru.sphere.stock.stock;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.sphere.stock.alerts.AlertService;
import ru.sphere.stock.catalog.CatalogService;
import ru.sphere.stock.domain.BatchState;
import ru.sphere.stock.domain.Money;
import ru.sphere.stock.domain.OpeningRule;
import ru.sphere.stock.domain.ProductInfo;
import ru.sphere.stock.events.StockChanged;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.infra.AppClock;
import ru.sphere.stock.ledger.Actor;
import ru.sphere.stock.ledger.Ledger;
import ru.sphere.stock.ledger.MovementType;

/** Действия с партией: вскрыть, заблокировать (отзыв), списать отозванное, прослеживаемость (ТЗ 5.2, 5.16). */
@Service
public class BatchService {

    public record MovementDto(long id, long seq, String type, String typeTitle, long qty, String qtyText, long costKop,
                              Instant at, String actor, String reason, String docType, String docId) {
    }

    public record TraceOrder(long orderId, long number, String status, Instant at, long qty, String qtyText) {
    }

    public record TraceBatch(long batchId, String label, String productName, String source, long qty, String qtyText) {
    }

    /** Откуда партия пришла и куда ушла. */
    public record Trace(long batchId, String label, String productId, String productName, String source,
                        String deliveryId, String deliveryNumber, String supplier, Long parentBatchId,
                        List<MovementDto> movements, List<TraceOrder> orders, List<TraceBatch> derived,
                        List<TraceOrder> ordersViaDerived) {
    }

    private final JdbcClient jdbc;
    private final AppClock clock;
    private final Ledger ledger;
    private final StockRepository batches;
    private final StockOps ops;
    private final CatalogService catalog;
    private final AlertService alerts;
    private final ApplicationEventPublisher events;

    public BatchService(JdbcClient jdbc, AppClock clock, Ledger ledger, StockRepository batches, StockOps ops,
                        CatalogService catalog, AlertService alerts, ApplicationEventPublisher events) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.ledger = ledger;
        this.batches = batches;
        this.ops = ops;
        this.catalog = catalog;
        this.alerts = alerts;
        this.events = events;
    }

    /** «Вскрыть N упаковок» (ТЗ 5.2): отделяется подпартия с коротким сроком. */
    @Transactional
    public long open(String locationId, long batchId, int packs, Actor actor) {
        Ledger.Tx tx = ledger.lock(locationId, clock.now());
        BatchState b = own(locationId, batchId);
        ProductInfo p = catalog.forLocation(locationId).product(b.productId());
        OpeningRule.Split split;
        try {
            split = OpeningRule.open(b, packs, p, tx.at());
        } catch (IllegalArgumentException e) {
            throw ApiException.badRequest(e.getMessage());
        }
        long child = ops.openSplit(tx, b, split, actor, "open", Long.toString(batchId), UUID.randomUUID());
        events.publishEvent(new StockChanged(locationId, "batch.opened"));
        return child;
    }

    /**
     * Отзыв (ТЗ 5.16): партия мгновенно исключается из доступного остатка; по галочке блокируются
     * и заготовки, сделанные из неё.
     */
    @Transactional
    public List<Long> block(String locationId, long batchId, String reason, boolean cascade, Actor actor) {
        if (reason == null || reason.isBlank()) {
            throw ApiException.badRequest("Укажите причину блокировки");
        }
        own(locationId, batchId);
        List<Long> blocked = new ArrayList<>();
        Set<Long> todo = new LinkedHashSet<>(List.of(batchId));
        while (!todo.isEmpty()) {
            long id = todo.iterator().next();
            todo.remove(id);
            if (blocked.contains(id)) {
                continue;
            }
            batches.setBlocked(id, true, reason);
            blocked.add(id);
            if (cascade) {
                todo.addAll(derivedBatchIds(id));
            }
        }
        var p = catalog.forLocation(locationId).product(batches.get(batchId, false).productId());
        alerts.raise(locationId, "BATCH_BLOCKED", "CRITICAL", "batch", Long.toString(batchId),
                "Партия заблокирована: " + p.name(), reason + (blocked.size() > 1
                        ? ". Заблокированы и заготовки из неё: " + (blocked.size() - 1) : ""), clock.now());
        events.publishEvent(new StockChanged(locationId, "batch.blocked"));
        return blocked;
    }

    @Transactional
    public void unblock(String locationId, long batchId, String reason, Actor actor) {
        if (reason == null || reason.isBlank()) {
            throw ApiException.badRequest("Укажите причину разблокировки");
        }
        own(locationId, batchId);
        batches.setBlocked(batchId, false, null);
        events.publishEvent(new StockChanged(locationId, "batch.unblocked"));
    }

    /** Списать остаток отозванной партии: «отзыв» или «возврат поставщику». */
    @Transactional
    public void disposeBlocked(String locationId, long batchId, boolean toSupplier, Actor actor) {
        Ledger.Tx tx = ledger.lock(locationId, clock.now());
        BatchState b = own(locationId, batchId);
        if (!b.blocked()) {
            throw ApiException.conflict("Сначала заблокируйте партию");
        }
        if (b.qtyLeft() == 0) {
            throw ApiException.conflict("Партия уже пустая");
        }
        if (b.heldQty() > 0) {
            batches.setHeld(batchId, -b.heldQty());
        }
        tx.append(toSupplier ? MovementType.RETURN_SUPPLIER : MovementType.WRITEOFF_RECALL, batchId, -b.qtyLeft(),
                -b.costOf(b.qtyLeft()), actor, toSupplier ? "Возврат поставщику" : "Отзыв партии",
                "recall", Long.toString(batchId), UUID.randomUUID(), null);
        events.publishEvent(new StockChanged(locationId, "batch.disposed"));
    }

    public Trace trace(String locationId, long batchId) {
        CatalogService.Snapshot cat = catalog.forLocation(locationId);
        var head = jdbc.sql("""
                        SELECT b.id, b.label, b.product_id, b.source, b.parent_batch_id, d.id AS did, d.number, d.supplier,
                               b.location_id
                        FROM batches b
                        LEFT JOIN delivery_lines l ON l.id = b.delivery_line_id
                        LEFT JOIN deliveries d ON d.tenant_id = l.tenant_id AND d.id = l.delivery_id
                        WHERE b.id = ?""")
                .param(batchId)
                .query((rs, n) -> new Object[]{rs.getLong(1), rs.getString(2), rs.getString(3), rs.getString(4),
                        rs.getObject(5), rs.getString(6), rs.getString(7), rs.getString(8), rs.getString(9)})
                .optional().orElseThrow(() -> ApiException.notFound("Партия"));
        if (!locationId.equals(head[8])) {
            throw ApiException.notFound("Партия");
        }
        ProductInfo p = cat.product((String) head[2]);
        List<MovementDto> moves = movements(batchId, p);
        List<TraceOrder> orders = ordersOf(locationId, List.of(batchId), p);
        List<Long> derived = new ArrayList<>(derivedBatchIds(batchId));
        List<TraceBatch> derivedDtos = new ArrayList<>();
        for (long d : derived) {
            jdbc.sql("SELECT id, label, product_id, source, qty_initial FROM batches WHERE id = ?").param(d)
                    .query(rs -> {
                        ProductInfo dp = cat.product(rs.getString(3));
                        derivedDtos.add(new TraceBatch(rs.getLong(1), rs.getString(2), dp.name(), rs.getString(4),
                                rs.getLong(5), dp.format(rs.getLong(5))));
                    });
        }
        List<TraceOrder> viaDerived = derived.isEmpty() ? List.of() : ordersOf(locationId, derived, null);
        return new Trace(batchId, (String) head[1], p.id(), p.name(), (String) head[3], (String) head[5],
                (String) head[6], (String) head[7], head[4] == null ? null : ((Number) head[4]).longValue(),
                moves, orders, derivedDtos, viaDerived);
    }

    public List<MovementDto> movements(long batchId, ProductInfo p) {
        return jdbc.sql("""
                        SELECT m.id, m.seq, m.type, m.qty, m.cost_kop, m.at, COALESCE(u.name, k.name, 'Система'),
                               m.reason, m.doc_type, m.doc_id
                        FROM movements m LEFT JOIN users u ON u.id = m.actor_id LEFT JOIN api_keys k ON k.id = m.api_key_id
                        WHERE m.batch_id = ? ORDER BY m.seq""")
                .param(batchId)
                .query((rs, n) -> {
                    MovementType t = MovementType.valueOf(rs.getString(3));
                    return new MovementDto(rs.getLong(1), rs.getLong(2), t.name(), t.title(), rs.getLong(4),
                            p.format(rs.getLong(4)), rs.getLong(5), rs.getTimestamp(6).toInstant(), rs.getString(7),
                            rs.getString(8), rs.getString(9), rs.getString(10));
                })
                .list();
    }

    private List<TraceOrder> ordersOf(String locationId, List<Long> batchIds, ProductInfo p) {
        CatalogService.Snapshot cat = catalog.forLocation(locationId);
        return jdbc.sql("""
                        SELECT o.id, o.number, o.status, o.created_at, -SUM(m.qty), MIN(b.product_id)
                        FROM movements m JOIN orders o ON o.id::text = m.doc_id JOIN batches b ON b.id = m.batch_id
                        WHERE m.batch_id = ANY(?) AND m.doc_type = 'order' AND m.type = 'ORDER'
                        GROUP BY o.id ORDER BY o.created_at""")
                .param(batchIds.toArray(Long[]::new))
                .query((rs, n) -> {
                    ProductInfo pp = p != null ? p : cat.product(rs.getString(6));
                    return new TraceOrder(rs.getLong(1), rs.getLong(2), rs.getString(3),
                            rs.getTimestamp(4).toInstant(), rs.getLong(5), pp.format(rs.getLong(5)));
                })
                .list();
    }

    /** Вскрытые подпартии и заготовки, сделанные из партии. */
    private List<Long> derivedBatchIds(long batchId) {
        List<Long> out = new ArrayList<>(jdbc.sql("SELECT id FROM batches WHERE parent_batch_id = ?").param(batchId)
                .query(Long.class).list());
        out.addAll(jdbc.sql("""
                        SELECT DISTINCT out_b.id FROM movements use_m
                        JOIN batches out_b ON out_b.operation_id = use_m.operation_id AND out_b.source = 'PRODUCTION'
                        WHERE use_m.batch_id = ? AND use_m.type = 'PRODUCTION_USE'""")
                .param(batchId).query(Long.class).list());
        return out;
    }

    private BatchState own(String locationId, long batchId) {
        if (!locationId.equals(batches.locationOf(batchId))) {
            throw ApiException.notFound("Партия");
        }
        return batches.get(batchId, true);
    }

    public static String rub(long kop) {
        return Money.format(kop);
    }

    static Timestamp ts(Instant i) {
        return Timestamp.from(i);
    }
}
