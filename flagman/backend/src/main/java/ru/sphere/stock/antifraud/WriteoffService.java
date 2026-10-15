package ru.sphere.stock.antifraud;

import io.swagger.v3.oas.annotations.media.Schema;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.sphere.stock.alerts.AlertService;
import ru.sphere.stock.catalog.CatalogService;
import ru.sphere.stock.domain.BatchState;
import ru.sphere.stock.domain.Fefo;
import ru.sphere.stock.domain.Money;
import ru.sphere.stock.domain.ProductInfo;
import ru.sphere.stock.domain.Requirements;
import ru.sphere.stock.events.StockChanged;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.infra.AppClock;
import ru.sphere.stock.ledger.Actor;
import ru.sphere.stock.ledger.Ledger;
import ru.sphere.stock.ledger.MovementType;
import ru.sphere.stock.stock.StockRepository;

/**
 * Ручное списание = заявка (ТЗ 6.5, 16.7): причина и фото. Заявку кладовщика, повара или кассира одобряет
 * или отклоняет управляющий или админ, свою подписать нельзя. Управляющий и админ сами и решают: их списание
 * проходит сразу — без запроса самому себе, но с фото, автором в журнале и проверкой правилами A1–A4. Пока заявка ждёт, количество не продаётся. Причину «просрочка»
 * в заявке поставить нельзя: просрочку списывают отдельной кнопкой и только после срока по часам сервера
 * (ТЗ 6.6, 16.1).
 *
 * <p>Групповая заявка — напиток или блюдо по техкарте либо продукт без выбора партии: потребность раскладывается
 * по партиям FEFO, каждая строка — обычная заявка на партию с общим {@code group_id}. Журнал, потери и правила
 * A1–A4 работают как прежде, а подпись и отказ действуют на всю группу.
 */
@Service
public class WriteoffService {

    public record RequestDto(long id, long batchId, String batchLabel, String productId, String productName, long qty,
                             String qtyText, String reason, String comment, boolean hasPhoto, int photoCount, long costKop,
                             long createdBy, String createdByName, Instant createdAt, String status, String decidedByName,
                             Instant decidedAt, String decisionComment, int leftPercent, String groupId,
                             String dishVariantId, String dishName, Integer dishQty, String deliveryNumber) {
    }

    @Schema(name = "WriteoffGroupCreated")
    public record GroupCreated(String groupId, List<Long> ids, String status, boolean needsApproval, long costKop,
                               List<String> lines) {
    }

    @Schema(name = "WriteoffCreated")
    public record Created(long id, String status, boolean needsApproval) {
    }

    @Schema(name = "WriteoffLineIn", description = "Сколько списать из партии")
    public record LineIn(@Schema(description = "Партия", example = "594") long batchId,
                         @Schema(description = "Количество в базовых единицах (г, мл, шт)", example = "500") long qty) {
    }

    @Schema(name = "WriteoffSourceLine", description = "Партия, которую можно списать вручную")
    public record SourceLine(long batchId, String label, String productId, String productName, String unit,
                             boolean opened, long available, String availableText, Instant expiresAt) {
    }

    /**
     * Откуда списывать (ТЗ 16.7): сначала выбирают поставку, потом её продукты. Заготовки кухни и излишки
     * пересчёта не из поставки — у них свой источник.
     */
    @Schema(name = "WriteoffSource", description = "Поставка (или заготовки кухни, излишки) и её партии, которые можно списать")
    public record Source(@Schema(description = "DELIVERY, PRODUCTION или SURPLUS") String kind, String deliveryId,
                         String number, String supplier, Instant at, List<SourceLine> lines) {
    }

    private static final Set<String> REASONS = Set.of("SPOILED", "DAMAGED", "OTHER");

    private final JdbcClient jdbc;
    private final AppClock clock;
    private final Ledger ledger;
    private final StockRepository batches;
    private final CatalogService catalog;
    private final AlertService alerts;
    private final AnomalyService anomalies;
    private final ApplicationEventPublisher events;

    public WriteoffService(JdbcClient jdbc, AppClock clock, Ledger ledger, StockRepository batches,
                           CatalogService catalog, AlertService alerts,
                           AnomalyService anomalies, ApplicationEventPublisher events) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.ledger = ledger;
        this.batches = batches;
        this.catalog = catalog;
        this.alerts = alerts;
        this.anomalies = anomalies;
        this.events = events;
    }

    private static void validate(String reason, String comment, List<String> photos) {
        if ("EXPIRED".equals(reason)) {
            throw ApiException.forbidden("Просрочку списывают кнопкой «Списать просрочку» — когда срок партии истёк, "
                    + "система сама проверит его по своим часам");
        }
        if (!REASONS.contains(reason)) {
            throw ApiException.badRequest("Причина — порча, бой или прочее");
        }
        if ("OTHER".equals(reason) && (comment == null || comment.isBlank())) {
            throw ApiException.badRequest("Для причины «прочее» нужен комментарий");
        }
        if (photos == null || photos.isEmpty()) {
            throw ApiException.badRequest("Нужно фото");
        }
    }

    /** Управляющий и админ — те, кто решает: их списание и возврат не ждут ничьего одобрения (ТЗ 16.7). */
    public static boolean decidesItself(Actor actor) {
        return actor.hasRole("MANAGER", "ADMIN");
    }

    private String labelOf(long batchId) {
        return jdbc.sql("SELECT label FROM batches WHERE id = ?").param(batchId).query(String.class).single();
    }

    @Transactional
    public Created create(String locationId, long batchId, long qty, String reason, String comment, List<String> photos,
                          Actor actor) {
        validate(reason, comment, photos);
        if (qty <= 0) {
            throw ApiException.badRequest("Количество должно быть больше нуля");
        }
        Ledger.Tx tx = ledger.lock(locationId, clock.now());
        Instant now = tx.at();
        if (!locationId.equals(batches.locationOf(batchId))) {
            throw ApiException.notFound("Партия");
        }
        BatchState b = batches.get(batchId, true);
        ProductInfo p = catalog.forLocation(locationId).product(b.productId());
        if (!b.expiresAt().isAfter(now)) {
            throw ApiException.conflict("Партия уже просрочена — её спишет система");
        }
        if (qty > b.qtyLeft() - b.heldQty()) {
            throw ApiException.badRequest("Можно списать не больше " + p.format(b.qtyLeft() - b.heldQty()));
        }
        long cost = b.costOf(qty);
        // Кладовщик, повар, кассир — заявка на одобрение; управляющий и админ решают сами — списано сразу.
        boolean immediate = decidesItself(actor);
        long id = jdbc.sql("""
                        INSERT INTO writeoff_requests (location_id, batch_id, qty, reason, comment, photo, photos, cost_kop,
                                                       created_by, created_at, status)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id""")
                .params(locationId, batchId, qty, reason, comment, photos.getFirst(), photoArray(photos), cost,
                        actor.userId(), Timestamp.from(now),
                        immediate ? "EXECUTED" : "PENDING")
                .query(Long.class).single();
        if (immediate) {
            tx.append(MovementType.valueOf("WRITEOFF_" + reason), batchId, -qty, -cost, actor, comment,
                    "writeoff", Long.toString(id), UUID.randomUUID(), null);
        } else {
            batches.setHeld(batchId, qty);   // пока ждёт — не продаётся
            alerts.raise(locationId, "WRITEOFF_PENDING", "WARN", "writeoff", Long.toString(id),
                    "Заявка на списание ждёт подписи", actor.name() + ": " + p.name() + " " + p.format(qty) + " на "
                            + Money.format(cost), now);
        }
        anomalies.onManualWriteoff(locationId, id, b, p, qty, cost, reason, actor, now);
        events.publishEvent(new StockChanged(locationId, "writeoff." + (immediate ? "executed" : "pending")));
        return new Created(id, immediate ? "EXECUTED" : "PENDING", !immediate);
    }

    /**
     * Групповая заявка: {@code variantId} + {@code portions} — напиток или блюдо по техкарте (брутто),
     * иначе {@code productId} + {@code qty} — продукт. Партии выбираются по FEFO, как при продаже.
     */
    @Transactional
    public GroupCreated createFefo(String locationId, String productId, long qty, String variantId, int portions,
                                   String reason, String comment, List<String> photos, Actor actor) {
        validate(reason, comment, photos);
        CatalogService.Snapshot cat = catalog.forLocation(locationId);
        String dish = variantId == null || variantId.isBlank() ? null : variantId;
        Map<String, Long> need = new LinkedHashMap<>();
        if (dish != null) {
            if (cat.variant(dish) == null) {
                throw ApiException.notFound("Блюдо");
            }
            if (portions <= 0 || portions > 50) {
                throw ApiException.badRequest("Порций — от 1 до 50");
            }
            Requirements.perPortion(dish, cat).forEach((pid, q) -> need.merge(pid, q * portions, Long::sum));
            if (need.isEmpty()) {
                throw ApiException.badRequest("У блюда нет техкарты — списывать нечего");
            }
        } else {
            if (productId == null || cat.product(productId) == null) {
                throw ApiException.notFound("Продукт");
            }
            if (qty <= 0) {
                throw ApiException.badRequest("Количество должно быть больше нуля");
            }
            need.put(productId, qty);
        }
        Ledger.Tx tx = ledger.lock(locationId, clock.now());
        Instant now = tx.at();
        Map<String, List<BatchState>> live = batches.liveByProduct(locationId);
        List<String> shortages = new ArrayList<>();
        need.forEach((pid, q) -> {
            long have = Fefo.available(live.getOrDefault(pid, List.of()), now);
            if (have < q) {
                ProductInfo p = cat.product(pid);
                shortages.add(p.name() + ": нужно " + p.format(q) + ", есть " + p.format(have));
            }
        });
        if (!shortages.isEmpty()) {
            throw ApiException.badRequest("На складе не хватает — " + String.join("; ", shortages));
        }
        List<Fefo.Take> takes = new ArrayList<>();
        need.forEach((pid, q) -> takes.addAll(Fefo.allocate(live.getOrDefault(pid, List.of()), q, now)));
        long total = takes.stream().mapToLong(Fefo.Take::cost).sum();
        boolean immediate = decidesItself(actor);
        UUID group = UUID.randomUUID();
        UUID op = UUID.randomUUID();
        List<Long> ids = new ArrayList<>();
        List<String> lines = new ArrayList<>();
        List<AnomalyService.GroupLine> checked = new ArrayList<>();
        for (Fefo.Take t : takes) {
            BatchState b = t.batch();
            ProductInfo p = cat.product(b.productId());
            long id = jdbc.sql("INSERT INTO writeoff_requests (location_id, batch_id, qty, reason, comment, photo, photos, "
                            + "cost_kop, created_by, created_at, status, group_id, dish_variant_id, dish_qty) "
                            + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
                    .params(locationId, b.id(), t.qty(), reason, comment, photos.getFirst(), photoArray(photos), t.cost(),
                            actor.userId(),
                            Timestamp.from(now), immediate ? "EXECUTED" : "PENDING", group, dish,
                            dish == null ? null : portions)
                    .query(Long.class).single();
            ids.add(id);
            lines.add(p.name() + " " + p.format(t.qty()) + " (партия " + labelOf(b.id()) + ")");
            if (immediate) {
                tx.append(MovementType.valueOf("WRITEOFF_" + reason), b.id(), -t.qty(), -t.cost(), actor, comment,
                        "writeoff", Long.toString(id), op, null);
            } else {
                batches.setHeld(b.id(), t.qty());   // пока ждёт — не продаётся
            }
            checked.add(new AnomalyService.GroupLine(b, p, t.qty(), t.cost()));
        }
        String what = dish != null ? cat.variantName(dish) + " ×" + portions
                : cat.product(productId).name() + " " + cat.product(productId).format(qty);
        anomalies.onGroupWriteoff(locationId, group.toString(), ids.getFirst(), what, dish != null, checked, total,
                reason, actor, now);
        if (!immediate) {
            alerts.raise(locationId, "WRITEOFF_PENDING", "WARN", "writeoff", Long.toString(ids.getFirst()),
                    "Заявка на списание ждёт подписи", actor.name() + ": «" + what + "» на " + Money.format(total), now);
        }
        events.publishEvent(new StockChanged(locationId, "writeoff." + (immediate ? "executed" : "pending")));
        return new GroupCreated(group.toString(), ids, immediate ? "EXECUTED" : "PENDING", !immediate, total, lines);
    }

    /** Поставки, заготовки кухни и излишки с партиями, которые можно списать: не просрочены, не заблокированы. */
    public List<Source> sources(String locationId) {
        CatalogService.Snapshot cat = catalog.forLocation(locationId);
        Map<String, Source> out = new LinkedHashMap<>();
        jdbc.sql("""
                        SELECT b.id, b.label, b.product_id, b.qty_left - b.held_qty, b.expires_at, b.source,
                               COALESCE(pb.source, b.source) AS root_source, d.id, d.number, d.supplier, d.created_at
                        FROM batches b
                        LEFT JOIN batches pb ON pb.id = b.parent_batch_id
                        LEFT JOIN delivery_lines l ON l.id = COALESCE(b.delivery_line_id, pb.delivery_line_id)
                        LEFT JOIN deliveries d ON d.tenant_id = l.tenant_id AND d.id = l.delivery_id
                        WHERE b.location_id = ? AND b.qty_left - b.held_qty > 0 AND b.expires_at > ? AND NOT b.blocked
                        ORDER BY d.created_at DESC NULLS LAST, b.expires_at, b.id""")
                .params(locationId, Timestamp.from(clock.now()))
                .query(rs -> {
                    String deliveryId = rs.getString(8);
                    String root = rs.getString(7);
                    String kind = deliveryId != null ? "DELIVERY" : "SURPLUS".equals(root) ? "SURPLUS" : "PRODUCTION";
                    String number = rs.getString(9) != null ? rs.getString(9)
                            : "SURPLUS".equals(kind) ? "Излишки пересчёта" : "Заготовки кухни";
                    String supplier = rs.getString(10);
                    Instant at = rs.getTimestamp(11) == null ? null : rs.getTimestamp(11).toInstant();
                    Source src = out.computeIfAbsent(deliveryId != null ? "D:" + deliveryId : kind,
                            k -> new Source(kind, deliveryId, number, supplier, at, new ArrayList<>()));
                    ProductInfo p = cat.product(rs.getString(3));
                    long available = rs.getLong(4);
                    src.lines().add(new SourceLine(rs.getLong(1), rs.getString(2), p.id(), p.name(), p.unit().name(),
                            "OPENING".equals(rs.getString(6)), available, p.format(available),
                            rs.getTimestamp(5).toInstant()));
                });
        // Поставки — по дате, заготовки и излишки — в конце списка.
        List<Source> list = new ArrayList<>(out.values());
        list.sort(java.util.Comparator.comparing((Source x) -> !"DELIVERY".equals(x.kind())));
        return list;
    }

    /**
     * Заявка по выбранным партиям (ТЗ 16.7): «из поставки N — эти продукты, столько». Несколько партий — одна
     * группа: одобряют или отклоняют её целиком. Правила те же, что у обычной заявки.
     */
    @Transactional
    public GroupCreated createBatches(String locationId, List<LineIn> in, String reason, String comment, List<String> photos,
                                      Actor actor) {
        validate(reason, comment, photos);
        if (in == null || in.isEmpty()) {
            throw ApiException.badRequest("Выберите, что списать");
        }
        java.util.Set<Long> seen = new java.util.HashSet<>();
        for (LineIn l : in) {
            if (l.qty() <= 0) {
                throw ApiException.badRequest("Количество должно быть больше нуля");
            }
            if (!seen.add(l.batchId())) {
                throw ApiException.badRequest("Партия указана дважды");
            }
        }
        CatalogService.Snapshot cat = catalog.forLocation(locationId);
        Ledger.Tx tx = ledger.lock(locationId, clock.now());
        Instant now = tx.at();
        boolean immediate = decidesItself(actor);
        UUID group = UUID.randomUUID();
        UUID op = UUID.randomUUID();
        List<Long> ids = new ArrayList<>();
        List<String> lines = new ArrayList<>();
        List<String> names = new ArrayList<>();
        List<AnomalyService.GroupLine> checked = new ArrayList<>();
        long total = 0;
        for (LineIn l : in) {
            if (!locationId.equals(batches.locationOf(l.batchId()))) {
                throw ApiException.notFound("Партия");
            }
            BatchState b = batches.get(l.batchId(), true);
            ProductInfo p = cat.product(b.productId());
            if (!b.expiresAt().isAfter(now)) {
                throw ApiException.conflict(p.name() + ": партия уже просрочена — её списывают кнопкой «Списать просрочку»");
            }
            if (b.blocked()) {
                throw ApiException.conflict(p.name() + ": партия заблокирована — её списывают отзывом");
            }
            if (l.qty() > b.qtyLeft() - b.heldQty()) {
                throw ApiException.badRequest(p.name() + ": можно списать не больше " + p.format(b.qtyLeft() - b.heldQty()));
            }
            long cost = b.costOf(l.qty());
            total += cost;
            long id = jdbc.sql("INSERT INTO writeoff_requests (location_id, batch_id, qty, reason, comment, photo, photos, "
                            + "cost_kop, created_by, created_at, status, group_id) "
                            + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
                    .params(locationId, b.id(), l.qty(), reason, comment, photos.getFirst(), photoArray(photos), cost,
                            actor.userId(), Timestamp.from(now),
                            immediate ? "EXECUTED" : "PENDING", group)
                    .query(Long.class).single();
            ids.add(id);
            names.add(p.name() + " " + p.format(l.qty()));
            lines.add(names.getLast() + " (партия " + labelOf(b.id()) + ")");
            if (immediate) {
                tx.append(MovementType.valueOf("WRITEOFF_" + reason), b.id(), -l.qty(), -cost, actor, comment,
                        "writeoff", Long.toString(id), op, null);
            } else {
                batches.setHeld(b.id(), l.qty());   // пока ждёт — не продаётся
            }
            checked.add(new AnomalyService.GroupLine(b, p, l.qty(), cost));
        }
        String what = String.join(", ", names);
        anomalies.onGroupWriteoff(locationId, group.toString(), ids.getFirst(), what, false, checked, total, reason,
                actor, now);
        if (!immediate) {
            alerts.raise(locationId, "WRITEOFF_PENDING", "WARN", "writeoff", Long.toString(ids.getFirst()),
                    "Заявка на списание ждёт подписи", actor.name() + ": " + what + " на " + Money.format(total), now);
        }
        events.publishEvent(new StockChanged(locationId, "writeoff." + (immediate ? "executed" : "pending")));
        return new GroupCreated(group.toString(), ids, immediate ? "EXECUTED" : "PENDING", !immediate, total, lines);
    }

    /** Подпись — на всю группу сразу: напиток списывается целиком или никак. */
    @Transactional
    public void approve(String locationId, long requestId, String comment, Actor actor) {
        List<Object[]> rows = lockAll(locationId, requestId);
        if (java.util.Objects.equals(rows.getFirst()[5], actor.userId())) {
            throw ApiException.forbidden("Свою заявку подписать нельзя — нужен другой управляющий или админ");
        }
        Ledger.Tx tx = ledger.lock(locationId, clock.now());
        UUID op = UUID.randomUUID();
        for (Object[] r : rows) {
            long batchId = (Long) r[1];
            long qty = (Long) r[2];
            BatchState b = batches.get(batchId, true);
            if (!b.expiresAt().isAfter(tx.at())) {
                throw ApiException.conflict("Партия " + labelOf(batchId) + " уже истекла — её спишет система; отклоните заявку");
            }
            batches.setHeld(batchId, -qty);
            long cost = b.costOf(qty);
            tx.append(MovementType.valueOf("WRITEOFF_" + r[3]), batchId, -qty, -cost, actor, (String) r[4],
                    "writeoff", Long.toString((Long) r[0]), op, null);
            decide((Long) r[0], "EXECUTED", comment, actor, tx.at());
        }
        events.publishEvent(new StockChanged(locationId, "writeoff.approved"));
    }

    @Transactional
    public void reject(String locationId, long requestId, String comment, Actor actor) {
        List<Object[]> rows = lockAll(locationId, requestId);
        if (java.util.Objects.equals(rows.getFirst()[5], actor.userId())) {
            throw ApiException.forbidden("Свою заявку решает другой управляющий");
        }
        Instant now = clock.now();
        for (Object[] r : rows) {
            batches.setHeld((Long) r[1], -(Long) r[2]);   // количество возвращается в продажу
            decide((Long) r[0], "REJECTED", comment, actor, now);
        }
        events.publishEvent(new StockChanged(locationId, "writeoff.rejected"));
    }

    private void decide(long id, String status, String comment, Actor actor, Instant at) {
        jdbc.sql("UPDATE writeoff_requests SET status = ?, decided_by = ?, decided_at = ?, decision_comment = ? WHERE id = ?")
                .params(status, actor.userId(), Timestamp.from(at), comment, id).update();
        // Запрос решён — сигнал «ждёт подписи» закрывается сам (у группы он висит на первой строке).
        jdbc.sql("""
                        UPDATE alerts SET ack_by = ?, ack_at = ? WHERE type = 'WRITEOFF_PENDING' AND object_id = ?
                          AND ack_at IS NULL""")
                .params(actor.userId(), Timestamp.from(at), Long.toString(id)).update();
    }

    /** Заявка и вся её группа под блокировкой; решить можно, только пока ждут все строки. */
    private List<Object[]> lockAll(String locationId, long id) {
        String cols = "id, batch_id, qty, reason, comment, created_by, status, group_id";
        Object[] first = jdbc.sql("SELECT " + cols + " FROM writeoff_requests WHERE id = ? AND location_id = ? FOR UPDATE")
                .params(id, locationId)
                .query((rs, n) -> row(rs))
                .optional().orElseThrow(() -> ApiException.notFound("Заявка"));
        List<Object[]> rows = first[7] == null ? List.<Object[]>of(first)
                : jdbc.sql("SELECT " + cols + " FROM writeoff_requests WHERE group_id = ? AND location_id = ? "
                                + "ORDER BY id FOR UPDATE")
                        .params(first[7], locationId)
                        .query((rs, n) -> row(rs))
                        .list();
        for (Object[] r : rows) {
            if (!"PENDING".equals(r[6])) {
                throw new ApiException(HttpStatus.CONFLICT, "Заявка уже решена: " + r[6]);
            }
        }
        return rows;
    }

    private static Object[] row(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new Object[]{rs.getLong(1), rs.getLong(2), rs.getLong(3), rs.getString(4), rs.getString(5),
                rs.getLong(6), rs.getString(7), rs.getObject(8)};
    }

    public List<RequestDto> list(String locationId, String status) {
        CatalogService.Snapshot cat = catalog.forLocation(locationId);
        Instant now = clock.now();
        return jdbc.sql("""
                        SELECT r.*, b.label, b.product_id, b.base_date, b.expires_at, u.name AS creator, d.name AS decider,
                               dv.number AS delivery_number
                        FROM writeoff_requests r JOIN batches b ON b.id = r.batch_id JOIN users u ON u.id = r.created_by
                        LEFT JOIN users d ON d.id = r.decided_by
                        LEFT JOIN batches pb ON pb.id = b.parent_batch_id
                        LEFT JOIN delivery_lines dl ON dl.id = COALESCE(b.delivery_line_id, pb.delivery_line_id)
                        LEFT JOIN deliveries dv ON dv.tenant_id = dl.tenant_id AND dv.id = dl.delivery_id
                        WHERE r.location_id = ? AND (?::text IS NULL OR r.status = ?)
                        ORDER BY r.created_at DESC LIMIT 200""")
                .params(locationId, status, status)
                .query((rs, n) -> {
                    ProductInfo p = cat.product(rs.getString("product_id"));
                    Instant base = rs.getTimestamp("base_date").toInstant();
                    Instant exp = rs.getTimestamp("expires_at").toInstant();
                    Instant created = rs.getTimestamp("created_at").toInstant();
                    double life = java.time.Duration.between(base, exp).toMinutes();
                    int left = life <= 0 ? 0 : (int) Math.max(0, Math.round(
                            100 * java.time.Duration.between(created, exp).toMinutes() / life));
                    return new RequestDto(rs.getLong("id"), rs.getLong("batch_id"), rs.getString("label"), p.id(),
                            p.name(), rs.getLong("qty"), p.format(rs.getLong("qty")), rs.getString("reason"),
                            rs.getString("comment"), rs.getString("photo") != null, photoCount(rs), rs.getLong("cost_kop"),
                            rs.getLong("created_by"), rs.getString("creator"), created, rs.getString("status"),
                            rs.getString("decider"),
                            rs.getTimestamp("decided_at") == null ? null : rs.getTimestamp("decided_at").toInstant(),
                            rs.getString("decision_comment"), left,
                            rs.getObject("group_id") == null ? null : rs.getObject("group_id").toString(),
                            rs.getString("dish_variant_id"),
                            rs.getString("dish_variant_id") == null ? null : cat.variantName(rs.getString("dish_variant_id")),
                            (Integer) rs.getObject("dish_qty"), rs.getString("delivery_number"));
                })
                .list();
    }

    /** Фото заявки по номеру (0 — первое): у заявки их может быть несколько. */
    public String photoOf(String locationId, long requestId, int index) {
        List<String> all = jdbc.sql("""
                        SELECT CASE WHEN cardinality(photos) > 0 THEN photos ELSE ARRAY[photo] END
                        FROM writeoff_requests WHERE id = ? AND location_id = ?""")
                .params(requestId, locationId)
                .query((rs, n) -> rs.getArray(1) == null ? List.<String>of()
                        : java.util.Arrays.asList((String[]) rs.getArray(1).getArray()))
                .optional().orElseThrow(() -> ApiException.notFound("Заявка"));
        if (index < 0 || index >= all.size() || all.get(index) == null) {
            throw ApiException.notFound("Фото");
        }
        return all.get(index);
    }

    static String[] photoArray(List<String> photos) {
        return photos.toArray(String[]::new);
    }

    static int photoCount(java.sql.ResultSet rs) throws java.sql.SQLException {
        java.sql.Array a = rs.getArray("photos");
        int n = a == null ? 0 : ((Object[]) a.getArray()).length;
        return n > 0 ? n : rs.getString("photo") != null ? 1 : 0;
    }

    static long now(AppClock c) {
        return c.now().toEpochMilli();
    }
}
