package ru.sphere.stock.delivery;

import io.swagger.v3.oas.annotations.media.Schema;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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
import ru.sphere.stock.domain.ProductInfo;
import ru.sphere.stock.events.StockChanged;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.infra.AppClock;
import ru.sphere.stock.ledger.Actor;
import ru.sphere.stock.ledger.Ledger;
import ru.sphere.stock.ledger.MovementType;
import ru.sphere.stock.stock.StockRepository;

/**
 * Возврат поставщику (ТЗ 16.7). Кладовщик выбирает принятую поставку, позиции и количество, причину и
 * прикладывает фото. Пока заявка ждёт, это количество удержано — не продаётся. Подтверждает управляющий
 * или админ, но не автор: тогда партии уменьшаются движением «Возврат поставщику». Отказ возвращает
 * количество в продажу. Управляющий и админ сами решают — их возврат проходит сразу. Это не потери
 * ресторана — правила списаний и их аналитика возврат не считают.
 */
@Service
public class SupplierReturnService {

    public static final Map<String, String> REASONS = Map.of(
            "DEFECT", "брак",
            "WRONG_ITEM", "не тот товар",
            "SHORT_LIFE", "короткий срок",
            "DAMAGED_PACK", "повреждена упаковка",
            "QUALITY", "не то качество",
            "OTHER", "прочее");

    private static final Set<String> RETURNABLE = Set.of("ACCEPTED", "PARTIAL", "ACCEPTED_DIFF");

    @Schema(name = "ReturnLineIn", description = "Сколько вернуть из партии")
    public record LineIn(@Schema(description = "Партия из этой поставки", example = "594") long batchId,
                         @Schema(description = "Количество в базовых единицах (г, мл, шт)", example = "500") long qty) {
    }

    @Schema(name = "ReturnableLine", description = "Что из поставки ещё можно вернуть")
    public record Returnable(int lineNo, String productId, String productName, String unit, long batchId,
                             String batchLabel, boolean opened, long available, String availableText,
                             long availableCostKop, Instant expiresAt) {
    }

    @Schema(name = "SupplierReturnCreated")
    public record Created(long id, String status, long costKop) {
    }

    @Schema(name = "SupplierReturnLine")
    public record LineDto(long batchId, String batchLabel, String productId, String productName, long qty,
                          String qtyText, long costKop) {
    }

    @Schema(name = "SupplierReturn", description = "Заявка на возврат поставщику")
    public record ReturnDto(long id, String deliveryId, String deliveryNumber, String supplier, String reason,
                            String reasonText, String comment, int photoCount, long costKop, long createdBy, String createdByName,
                            Instant createdAt, String status, String decidedByName, Instant decidedAt,
                            String decisionComment, List<LineDto> lines) {
    }

    private final JdbcClient jdbc;
    private final AppClock clock;
    private final Ledger ledger;
    private final StockRepository batches;
    private final CatalogService catalog;
    private final AlertService alerts;
    private final ApplicationEventPublisher events;

    public SupplierReturnService(JdbcClient jdbc, AppClock clock, Ledger ledger, StockRepository batches,
                                 CatalogService catalog, AlertService alerts, ApplicationEventPublisher events) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.ledger = ledger;
        this.batches = batches;
        this.catalog = catalog;
        this.alerts = alerts;
        this.events = events;
    }

    /** Партии поставки (и их вскрытые подпартии) с тем, что ещё можно вернуть: остаток минус удержанное. */
    public List<Returnable> returnable(String loc, String deliveryId) {
        delivery(loc, deliveryId);
        CatalogService.Snapshot cat = catalog.forLocation(loc);
        return jdbc.sql("""
                        WITH RECURSIVE fam(id, line_no) AS (
                            SELECT b.id, l.line_no FROM batches b JOIN delivery_lines l ON l.id = b.delivery_line_id
                            WHERE b.location_id = ? AND l.tenant_id = b.tenant_id AND l.delivery_id = ?
                            UNION ALL
                            SELECT c.id, f.line_no FROM batches c JOIN fam f ON c.parent_batch_id = f.id
                            WHERE c.source = 'OPENING')
                        SELECT f.line_no, b.id, b.label, b.product_id, b.qty_left - b.held_qty, b.source, b.expires_at,
                               b.cost_total_kop, b.qty_initial
                        FROM fam f JOIN batches b ON b.id = f.id
                        WHERE b.qty_left - b.held_qty > 0
                        ORDER BY f.line_no, b.id""")
                .params(loc, deliveryId)
                .query((rs, n) -> {
                    ProductInfo p = cat.product(rs.getString(4));
                    long available = rs.getLong(5);
                    return new Returnable(rs.getInt(1), p.id(), p.name(), p.unit().name(), rs.getLong(2),
                            rs.getString(3), "OPENING".equals(rs.getString(6)), available, p.format(available),
                            Money.share(rs.getLong(8), available, rs.getLong(9)), rs.getTimestamp(7).toInstant());
                })
                .list();
    }

    @Transactional
    public Created create(String loc, String deliveryId, List<LineIn> lines, String reason, String comment,
                          List<String> photos, Actor actor) {
        if (!REASONS.containsKey(reason)) {
            throw ApiException.badRequest("Причина — брак, не тот товар, короткий срок, повреждена упаковка, "
                    + "не то качество или прочее");
        }
        if ("OTHER".equals(reason) && (comment == null || comment.isBlank())) {
            throw ApiException.badRequest("Для причины «прочее» нужен комментарий");
        }
        if (photos == null || photos.isEmpty()) {
            throw ApiException.badRequest("Нужно фото товара или накладной");
        }
        if (lines == null || lines.isEmpty()) {
            throw ApiException.badRequest("Выберите, что вернуть");
        }
        Set<Long> seen = new HashSet<>();
        for (LineIn l : lines) {
            if (l.qty() <= 0) {
                throw ApiException.badRequest("Количество должно быть больше нуля");
            }
            if (!seen.add(l.batchId())) {
                throw ApiException.badRequest("Партия указана дважды");
            }
        }
        Object[] d = delivery(loc, deliveryId);
        if (!RETURNABLE.contains((String) d[0])) {
            throw ApiException.conflict("Вернуть можно только из принятой поставки");
        }
        Set<Long> own = new HashSet<>();
        returnableIds(loc, deliveryId).forEach(own::add);

        Ledger.Tx tx = ledger.lock(loc, clock.now());
        Instant now = tx.at();
        CatalogService.Snapshot cat = catalog.forLocation(loc);
        long total = 0;
        List<long[]> rows = new ArrayList<>();          // партия, количество, стоимость
        List<String> what = new ArrayList<>();
        for (LineIn l : lines) {
            if (!own.contains(l.batchId())) {
                throw ApiException.badRequest("Партия не из этой поставки");
            }
            BatchState b = batches.get(l.batchId(), true);
            ProductInfo p = cat.product(b.productId());
            long available = b.qtyLeft() - b.heldQty();
            if (l.qty() > available) {
                throw ApiException.badRequest(p.name() + ": можно вернуть не больше " + p.format(Math.max(0, available)));
            }
            long cost = b.costOf(l.qty());
            total += cost;
            rows.add(new long[]{l.batchId(), l.qty(), cost});
            what.add(p.name() + " " + p.format(l.qty()));
        }
        // Управляющий и админ сами решают — их возврат проходит сразу, без запроса самому себе.
        boolean immediate = actor.hasRole("MANAGER", "ADMIN");
        long id = jdbc.sql("""
                        INSERT INTO supplier_returns (location_id, delivery_id, reason, comment, photo, photos, cost_kop,
                                                      created_by, created_at, status)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id""")
                .params(loc, deliveryId, reason, blankToNull(comment), photos.getFirst(), photos.toArray(String[]::new),
                        total, actor.userId(), Timestamp.from(now),
                        immediate ? "EXECUTED" : "PENDING")
                .query(Long.class).single();
        UUID op = UUID.randomUUID();
        String why = "Возврат поставщику: " + REASONS.get(reason) + (blankToNull(comment) == null ? "" : " — " + comment.trim());
        for (long[] r : rows) {
            jdbc.sql("""
                            INSERT INTO supplier_return_lines (tenant_id, return_id, batch_id, qty, cost_kop)
                            VALUES ((SELECT tenant_id FROM supplier_returns WHERE id = ?), ?, ?, ?, ?)""")
                    .params(id, id, r[0], r[1], r[2]).update();
            if (immediate) {
                tx.append(MovementType.RETURN_SUPPLIER, r[0], -r[1], -r[2], actor, why, "return", Long.toString(id), op, null);
            } else {
                batches.setHeld(r[0], r[1]);             // пока ждёт — не продаётся
            }
        }
        if (!immediate) {
            alerts.raise(loc, "RETURN_PENDING", "WARN", "return", Long.toString(id),
                    "Возврат поставщику ждёт подтверждения",
                    actor.name() + ": поставка " + d[1] + (d[2] == null ? "" : " · " + d[2]) + " — "
                            + String.join(", ", what) + " на " + Money.format(total) + " (" + REASONS.get(reason) + ")", now);
        }
        events.publishEvent(new StockChanged(loc, immediate ? "return.approved" : "return.pending"));
        return new Created(id, immediate ? "EXECUTED" : "PENDING", total);
    }

    /** Подтвердить: удержанное уходит со склада движением «Возврат поставщику». Свою заявку — нельзя. */
    @Transactional
    public void approve(String loc, long id, String comment, Actor actor) {
        Ledger.Tx tx = ledger.lock(loc, clock.now());
        Object[] head = lockPending(loc, id, actor, "подтверждает");
        UUID op = UUID.randomUUID();
        String why = "Возврат поставщику: " + REASONS.get((String) head[1]) + (head[2] == null ? "" : " — " + head[2]);
        for (long[] l : lines(id)) {
            BatchState b = batches.get(l[0], true);
            batches.setHeld(l[0], -l[1]);
            tx.append(MovementType.RETURN_SUPPLIER, l[0], -l[1], -b.costOf(l[1]), actor, why, "return",
                    Long.toString(id), op, null);
        }
        decide(loc, id, "EXECUTED", comment, actor, tx.at());
        events.publishEvent(new StockChanged(loc, "return.approved"));
    }

    /** Отклонить: удержанное количество возвращается в продажу. */
    @Transactional
    public void reject(String loc, long id, String comment, Actor actor) {
        Ledger.Tx tx = ledger.lock(loc, clock.now());
        lockPending(loc, id, actor, "решает");
        for (long[] l : lines(id)) {
            batches.setHeld(l[0], -l[1]);
        }
        decide(loc, id, "REJECTED", comment, actor, tx.at());
        events.publishEvent(new StockChanged(loc, "return.rejected"));
    }

    public List<ReturnDto> list(String loc, String status, String deliveryId) {
        CatalogService.Snapshot cat = catalog.forLocation(loc);
        Map<Long, ReturnDto> byId = new LinkedHashMap<>();
        jdbc.sql("""
                        SELECT r.*, d.number, d.supplier, u.name AS creator, x.name AS decider
                        FROM supplier_returns r
                        JOIN deliveries d ON d.tenant_id = r.tenant_id AND d.id = r.delivery_id
                        JOIN users u ON u.id = r.created_by LEFT JOIN users x ON x.id = r.decided_by
                        WHERE r.location_id = ? AND (?::text IS NULL OR r.status = ?)
                          AND (?::text IS NULL OR r.delivery_id = ?)
                        ORDER BY r.created_at DESC LIMIT 200""")
                .params(loc, status, status, deliveryId, deliveryId)
                .query(rs -> {
                    String reason = rs.getString("reason");
                    byId.put(rs.getLong("id"), new ReturnDto(rs.getLong("id"), rs.getString("delivery_id"),
                            rs.getString("number"), rs.getString("supplier"), reason, REASONS.get(reason),
                            rs.getString("comment"), Math.max(1, ((Object[]) rs.getArray("photos").getArray()).length),
                            rs.getLong("cost_kop"), rs.getLong("created_by"),
                            rs.getString("creator"), rs.getTimestamp("created_at").toInstant(), rs.getString("status"),
                            rs.getString("decider"),
                            rs.getTimestamp("decided_at") == null ? null : rs.getTimestamp("decided_at").toInstant(),
                            rs.getString("decision_comment"), new ArrayList<>()));
                });
        if (byId.isEmpty()) {
            return List.of();
        }
        jdbc.sql("""
                        SELECT l.return_id, l.batch_id, b.label, b.product_id, l.qty, l.cost_kop
                        FROM supplier_return_lines l JOIN batches b ON b.id = l.batch_id
                        WHERE l.return_id = ANY(?) ORDER BY l.return_id, b.id""")
                .param(byId.keySet().toArray(Long[]::new))
                .query(rs -> {
                    ProductInfo p = cat.product(rs.getString(4));
                    byId.get(rs.getLong(1)).lines().add(new LineDto(rs.getLong(2), rs.getString(3), p.id(), p.name(),
                            rs.getLong(5), p.format(rs.getLong(5)), rs.getLong(6)));
                });
        return new ArrayList<>(byId.values());
    }

    /** Фото возврата по номеру (0 — первое). */
    public String photoOf(String loc, long id, int index) {
        List<String> all = jdbc.sql("""
                        SELECT CASE WHEN cardinality(photos) > 0 THEN photos ELSE ARRAY[photo] END
                        FROM supplier_returns WHERE id = ? AND location_id = ?""")
                .params(id, loc)
                .query((rs, n) -> java.util.Arrays.asList((String[]) rs.getArray(1).getArray()))
                .optional().orElseThrow(() -> ApiException.notFound("Заявка на возврат"));
        if (index < 0 || index >= all.size()) {
            throw ApiException.notFound("Фото");
        }
        return all.get(index);
    }

    // ── Внутреннее ─────────────────────────────────────────────────────────

    /** [статус, номер, поставщик] поставки этой точки. */
    private Object[] delivery(String loc, String deliveryId) {
        return jdbc.sql("SELECT status, number, supplier FROM deliveries WHERE location_id = ? AND id = ?")
                .params(loc, deliveryId)
                .query((rs, n) -> new Object[]{rs.getString(1), rs.getString(2), rs.getString(3)})
                .optional().orElseThrow(() -> ApiException.notFound("Поставка"));
    }

    private List<Long> returnableIds(String loc, String deliveryId) {
        return jdbc.sql("""
                        WITH RECURSIVE fam(id) AS (
                            SELECT b.id FROM batches b JOIN delivery_lines l ON l.id = b.delivery_line_id
                            WHERE b.location_id = ? AND l.tenant_id = b.tenant_id AND l.delivery_id = ?
                            UNION ALL
                            SELECT c.id FROM batches c JOIN fam f ON c.parent_batch_id = f.id WHERE c.source = 'OPENING')
                        SELECT id FROM fam""")
                .params(loc, deliveryId).query(Long.class).list();
    }

    /** [id, причина, комментарий] ждущей заявки под блокировкой; автор решать не может. */
    private Object[] lockPending(String loc, long id, Actor actor, String verb) {
        Object[] r = jdbc.sql("""
                        SELECT id, reason, comment, created_by, status FROM supplier_returns
                        WHERE id = ? AND location_id = ? FOR UPDATE""")
                .params(id, loc)
                .query((rs, n) -> new Object[]{rs.getLong(1), rs.getString(2), rs.getString(3), rs.getLong(4),
                        rs.getString(5)})
                .optional().orElseThrow(() -> ApiException.notFound("Заявка на возврат"));
        if (!"PENDING".equals(r[4])) {
            throw ApiException.conflict("Заявка уже решена");
        }
        if (Long.valueOf((Long) r[3]).equals(actor.userId())) {
            throw ApiException.forbidden("Свою заявку " + verb + " другой управляющий или админ");
        }
        return r;
    }

    private List<long[]> lines(long id) {
        return jdbc.sql("SELECT batch_id, qty FROM supplier_return_lines WHERE return_id = ? ORDER BY batch_id")
                .param(id).query((rs, n) -> new long[]{rs.getLong(1), rs.getLong(2)}).list();
    }

    private void decide(String loc, long id, String status, String comment, Actor actor, Instant at) {
        jdbc.sql("""
                        UPDATE supplier_returns SET status = ?, decided_by = ?, decided_at = ?, decision_comment = ?
                        WHERE id = ?""")
                .params(status, actor.userId(), Timestamp.from(at), blankToNull(comment), id).update();
        jdbc.sql("""
                        UPDATE alerts SET ack_by = ?, ack_at = ? WHERE location_id = ? AND type = 'RETURN_PENDING'
                          AND object_id = ? AND ack_at IS NULL""")
                .params(actor.userId(), Timestamp.from(at), loc, Long.toString(id)).update();
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.trim();
    }
}
