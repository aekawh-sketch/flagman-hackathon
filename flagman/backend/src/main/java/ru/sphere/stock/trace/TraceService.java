package ru.sphere.stock.trace;

import io.swagger.v3.oas.annotations.media.Schema;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import ru.sphere.stock.catalog.CatalogService;
import ru.sphere.stock.domain.Money;
import ru.sphere.stock.domain.ProductInfo;
import ru.sphere.stock.domain.ProductKind;
import ru.sphere.stock.domain.RecipeLine;
import ru.sphere.stock.domain.Requirements;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.infra.AppClock;

/**
 * Прослеживаемость (ТЗ 16.6): из каких партий сделана каждая заготовка и какие продукты, из каких партий,
 * ушли в каждое блюдо каждого заказа. Отдельного учёта нет — всё восстанавливается из журнала движений
 * и версий техкарт, поэтому сходится с журналом до грамма.
 *
 * <p>Заказ списывает продукты одной суммой на весь заказ: два блюда на одном лососе — одно движение по
 * партии. По блюдам эта сумма раскладывается по техкарте, действовавшей в момент заказа, в порядке строк
 * заказа и в FEFO-порядке партий — так же, как их брал склад.
 */
@Service
public class TraceService {

    @Schema(name = "IngredientTake", description = "Сколько взяли из одной партии")
    public record Take(long batchId, String label,
                       @Schema(description = "DELIVERY, PRODUCTION, OPENING или SURPLUS") String source,
                       String deliveryNumber, String supplier,
                       @Schema(description = "Когда приготовлена — для заготовки") Instant producedAt,
                       @Schema(description = "Этикетка исходной партии — для вскрытой упаковки") String parentLabel,
                       long qty, String qtyText, long costKop,
                       @Schema(description = "Для заготовки: сырьё на взятое количество") List<Part> madeFrom) {
    }

    @Schema(name = "IngredientPart", description = "Продукт в составе: сколько всего и из каких партий")
    public record Part(String productId, String productName, boolean semi, long qty, String qtyText, long costKop,
                       List<Take> batches) {
    }

    @Schema(name = "DishComposition", description = "Блюдо заказа и что на него ушло")
    public record DishPart(int lineNo, String variantId, String name, int qty, long priceKop, long costKop,
                           @Schema(description = "Версия техкарты в момент заказа; null — сет") Integer recipeVersion,
                           List<Part> parts) {
    }

    @Schema(name = "OrderComposition", description = "Заказ: блюда → продукты → партии")
    public record OrderTrace(long id, long number, String status, String source, Instant at, String createdBy,
                             long totalKop, long costKop, List<DishPart> dishes,
                             @Schema(description = "Не удалось отнести к блюду (техкарта блюда удалена)") List<Part> unassigned) {
    }

    @Schema(name = "OrderTraceRow")
    public record OrderRow(long id, long number, String status, String source, Instant at, long totalKop, long costKop,
                           List<String> dishes) {
    }

    @Schema(name = "DishUse", description = "Сколько продукта ушло в блюдо")
    public record DishUse(String variantId, String name, long portions, long orders, long qty, String qtyText,
                          long costKop, @Schema(description = "Через какую заготовку; null — напрямую") String via) {
    }

    @Schema(name = "PrepTrace", description = "Приготовленная заготовка: из чего и куда ушла")
    public record Prep(long batchId, String label, String productId, String productName, Instant at, String cook,
                       long qty, String qtyText, long costKop, Instant expiresAt, long left, String leftText,
                       long toOrders, String toOrdersText, long orders, long lost, String lostText, List<Part> parts) {
    }

    @Schema(name = "PrepUse", description = "Сколько продукта ушло в одну заготовку")
    public record PrepUse(long batchId, String label, String productName, Instant at, long qty, String qtyText,
                          long costKop) {
    }

    @Schema(name = "ProductOrderUse")
    public record OrderUse(long orderId, long number, Instant at, String dish, long qty, String qtyText, String via) {
    }

    @Schema(name = "ProductTrace", description = "Куда ушёл продукт за период")
    public record ProductTrace(String productId, String productName, boolean semi, int days,
                               long toDishes, String toDishesText, long toPreps, String toPrepsText,
                               long lost, String lostText, List<DishUse> dishes, List<PrepUse> preps,
                               List<OrderUse> orders) {
    }

    private record Line(int lineNo, String variantId, int qty, long priceKop, Long recipeVersionId) {
    }

    private record Head(long id, long number, String status, Instant at) {
    }

    private record Move(String productId, long batchId, long qty, long costKop) {
    }

    /** Строка заказа {@code lineNo} получила {@code qty} продукта из партии; 0 — без строки. */
    private record Alloc(int lineNo, String productId, long batchId, long qty, long costKop) {
    }

    private record Split(Head head, List<Line> lines, List<Alloc> allocs) {
    }

    private record BatchInfo(long id, String label, String productId, String source, Long parentId, String op,
                             long qtyInitial, Instant baseDate, String deliveryNumber, String supplier) {
    }

    /** Всё, что нужно одному запросу: снимок каталога и подгруженные версии техкарт, партии, заготовки. */
    private static final class Ctx {
        final String loc;
        final CatalogService.Snapshot cat;
        final Map<Long, List<RecipeLine>> versions = new HashMap<>();
        final Map<Long, Integer> versionNo = new HashMap<>();
        final Map<Long, BatchInfo> batches = new HashMap<>();
        final Map<String, List<Move>> productionUse = new HashMap<>();

        Ctx(String loc, CatalogService.Snapshot cat) {
            this.loc = loc;
            this.cat = cat;
        }

        String name(String productId) {
            ProductInfo p = cat.product(productId);
            return p == null ? productId : p.name();
        }

        String fmt(String productId, long qty) {
            ProductInfo p = cat.product(productId);
            return p == null ? Long.toString(qty) : p.format(qty);
        }

        boolean semi(String productId) {
            ProductInfo p = cat.product(productId);
            return p != null && p.kind() == ProductKind.SEMI;
        }
    }

    private static final int MAX_DEPTH = 3;

    private final JdbcClient jdbc;
    private final AppClock clock;
    private final CatalogService catalog;

    public TraceService(JdbcClient jdbc, AppClock clock, CatalogService catalog) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.catalog = catalog;
    }

    // ── Заказы ─────────────────────────────────────────────────────────────

    /** Заказы за период; {@code q} — номер заказа или часть названия блюда. */
    public List<OrderRow> orders(String loc, int days, String q, int limit) {
        return orders(loc, since(days), clock.now().plus(Duration.ofDays(1)), q, limit);
    }

    /** Заказы за период [since, until). */
    public List<OrderRow> orders(String loc, Instant since, Instant until, String q, int limit) {
        CatalogService.Snapshot cat = catalog.forLocation(loc);
        String query = q == null || q.isBlank() ? null : q.trim();
        Long number = query != null && query.matches("\\d{1,12}") ? Long.parseLong(query) : null;
        String like = query == null || number != null ? null : "%" + query.replace("%", "").replace("_", "") + "%";
        List<OrderRow> rows = jdbc.sql("""
                        SELECT o.id, o.number, o.status, o.source, o.created_at, o.total_kop, o.cost_kop FROM orders o
                        WHERE o.location_id = ? AND o.created_at >= ? AND o.created_at < ?
                          AND (?::bigint IS NULL OR o.number = ?)
                          AND (?::text IS NULL OR EXISTS (
                                SELECT 1 FROM order_lines ol
                                JOIN dish_variants v ON v.tenant_id = o.tenant_id AND v.id = ol.variant_id
                                WHERE ol.order_id = o.id AND v.name ILIKE ?))
                        ORDER BY o.created_at DESC LIMIT ?""")
                .params(loc, Timestamp.from(since), Timestamp.from(until), number, number, like, like, limit)
                .query((rs, n) -> new OrderRow(rs.getLong(1), rs.getLong(2), rs.getString(3), rs.getString(4),
                        rs.getTimestamp(5).toInstant(), rs.getLong(6), rs.getLong(7), new ArrayList<>()))
                .list();
        if (rows.isEmpty()) {
            return rows;
        }
        Map<Long, OrderRow> byId = new HashMap<>();
        rows.forEach(r -> byId.put(r.id(), r));
        jdbc.sql("SELECT order_id, variant_id, qty FROM order_lines WHERE order_id = ANY(?) ORDER BY order_id, line_no")
                .param(byId.keySet().toArray(Long[]::new))
                .query(rs -> {
                    byId.get(rs.getLong(1)).dishes().add(cat.variantName(rs.getString(2)) + " ×" + rs.getInt(3));
                });
        return rows;
    }

    /** Состав заказа: блюда → продукты → партии, у заготовок — из какого сырья они сделаны. */
    public OrderTrace order(String loc, long orderId) {
        var head = jdbc.sql("""
                        SELECT o.source, o.total_kop, o.cost_kop, COALESCE(u.name, k.name) FROM orders o
                        LEFT JOIN users u ON u.id = o.created_by LEFT JOIN api_keys k ON k.id = o.api_key_id
                        WHERE o.id = ? AND o.location_id = ?""")
                .params(orderId, loc)
                .query((rs, n) -> new Object[]{rs.getString(1), rs.getLong(2), rs.getLong(3), rs.getString(4)})
                .optional().orElseThrow(() -> ApiException.notFound("Заказ"));
        Ctx c = new Ctx(loc, catalog.forLocation(loc));
        Split s = allocate(c, List.of(orderId)).get(orderId);
        loadBatches(c, s.allocs().stream().map(Alloc::batchId).toList());
        List<DishPart> dishes = new ArrayList<>();
        for (Line l : s.lines()) {
            List<Alloc> mine = s.allocs().stream().filter(a -> a.lineNo() == l.lineNo()).toList();
            dishes.add(new DishPart(l.lineNo(), l.variantId(), c.cat.variantName(l.variantId()), l.qty(), l.priceKop(),
                    mine.stream().mapToLong(Alloc::costKop).sum(),
                    l.recipeVersionId() == null ? null : c.versionNo.get(l.recipeVersionId()), parts(c, mine, 0)));
        }
        List<Alloc> loose = s.allocs().stream().filter(a -> a.lineNo() == 0).toList();
        return new OrderTrace(orderId, s.head().number(), s.head().status(), (String) head[0], s.head().at(),
                (String) head[3], (Long) head[1], (Long) head[2], dishes, parts(c, loose, 0));
    }

    /** Блюдо за период: продано, выручка и фактическая себестоимость — из партий, ушедших в его порции. */
    public record DishMoney(String variantId, String name, long qty, long revenueKop, long costKop) {
    }

    /**
     * Деньги по блюдам для заказов (ТЗ 16.18, аналитика прибыли): себестоимость каждого заказа разложена по его
     * блюдам той же раскладкой, что и прослеживаемость (по техкарте на момент заказа), — сумма сходится с заказами.
     * Неразложимый остаток (lineNo 0) — отдельной строкой с id {@code null}.
     */
    public List<DishMoney> dishMoney(String loc, Collection<Long> orderIds) {
        Ctx c = new Ctx(loc, catalog.forLocation(loc));
        Map<String, long[]> by = new LinkedHashMap<>();   // variantId → [qty, revenue, cost]
        long loose = 0;
        for (Split s : allocate(c, orderIds).values()) {
            for (Line l : s.lines()) {
                long[] v = by.computeIfAbsent(l.variantId(), k -> new long[3]);
                v[0] += l.qty();
                v[1] += l.priceKop() * l.qty();
            }
            for (Alloc a : s.allocs()) {
                if (a.lineNo() == 0) {
                    loose += a.costKop();
                    continue;
                }
                Line l = s.lines().stream().filter(x -> x.lineNo() == a.lineNo()).findFirst().orElse(null);
                if (l == null) {
                    loose += a.costKop();
                } else {
                    by.get(l.variantId())[2] += a.costKop();
                }
            }
        }
        List<DishMoney> out = new ArrayList<>();
        by.forEach((id, v) -> out.add(new DishMoney(id, c.cat.variantName(id), v[0], v[1], v[2])));
        if (loose != 0) {
            out.add(new DishMoney(null, "Не разложено по блюдам", 0, 0, loose));
        }
        return out;
    }

    // ── Заготовки ──────────────────────────────────────────────────────────

    /** Приготовленные заготовки за период: из каких партий сырья и сколько ушло в заказы. */
    public List<Prep> preps(String loc, int days, int limit) {
        return preps(loc, since(days), clock.now().plus(Duration.ofDays(1)), limit);
    }

    /** Заготовки, приготовленные за период [since, until). */
    public List<Prep> preps(String loc, Instant since, Instant until, int limit) {
        Ctx c = new Ctx(loc, catalog.forLocation(loc));
        record Row(long id, String label, String productId, long qty, long cost, Instant at, Instant expires,
                   String op, String cook) {
        }
        List<Row> rows = jdbc.sql("""
                        SELECT b.id, b.label, b.product_id, b.qty_initial, b.cost_total_kop, b.base_date, b.expires_at,
                               b.operation_id::text, COALESCE(u.name, k.name, 'Система')
                        FROM batches b
                        LEFT JOIN movements m ON m.batch_id = b.id AND m.type = 'PRODUCTION_OUT'
                        LEFT JOIN users u ON u.id = m.actor_id LEFT JOIN api_keys k ON k.id = m.api_key_id
                        WHERE b.location_id = ? AND b.source = 'PRODUCTION' AND b.base_date >= ? AND b.base_date < ?
                        ORDER BY b.base_date DESC, b.id DESC LIMIT ?""")
                .params(loc, Timestamp.from(since), Timestamp.from(until), limit)
                .query((rs, n) -> new Row(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getLong(4), rs.getLong(5),
                        rs.getTimestamp(6).toInstant(), rs.getTimestamp(7).toInstant(), rs.getString(8), rs.getString(9)))
                .list();
        if (rows.isEmpty()) {
            return List.of();
        }
        loadProductionUse(c, rows.stream().map(Row::op).toList());
        Map<Long, long[]> usage = familyUsage(rows.stream().map(Row::id).toList());
        List<Prep> out = new ArrayList<>();
        for (Row r : rows) {
            long[] u = usage.getOrDefault(r.id(), new long[4]);
            List<Alloc> uses = c.productionUse.getOrDefault(r.op(), List.of()).stream()
                    .map(m -> new Alloc(0, m.productId(), m.batchId(), m.qty(), m.costKop())).toList();
            out.add(new Prep(r.id(), r.label(), r.productId(), c.name(r.productId()), r.at(), r.cook(), r.qty(),
                    c.fmt(r.productId(), r.qty()), r.cost(), r.expires(), u[3], c.fmt(r.productId(), u[3]),
                    u[0], c.fmt(r.productId(), u[0]), u[1], u[2], c.fmt(r.productId(), u[2]), parts(c, uses, 1)));
        }
        return out;
    }

    /** В какие блюда ушла партия (любая: заготовка, сырьё), включая её вскрытые подпартии. */
    public List<DishUse> batchDishes(String loc, long batchId) {
        String owner = jdbc.sql("SELECT location_id FROM batches WHERE id = ?").param(batchId)
                .query(String.class).optional().orElse(null);
        if (!loc.equals(owner)) {
            throw ApiException.notFound("Партия");
        }
        Ctx c = new Ctx(loc, catalog.forLocation(loc));
        Set<Long> family = family(List.of(batchId)).getOrDefault(batchId, Set.of(batchId));
        Map<String, DishAcc> acc = new LinkedHashMap<>();
        allocate(c, ordersOf(family)).forEach((oid, s) -> {
            if ("CANCELED".equals(s.head().status())) {
                return;
            }
            for (Alloc a : s.allocs()) {
                if (family.contains(a.batchId())) {
                    add(acc, s, a, a.qty(), a.costKop(), null);
                }
            }
        });
        return dishUses(c, acc, batchProduct(c, batchId));
    }

    // ── Продукт ────────────────────────────────────────────────────────────

    /** Куда ушёл продукт за период: в какие блюда напрямую, в какие — через заготовки, сколько списано. */
    public ProductTrace product(String loc, String productId, int days) {
        return product(loc, productId, since(days), clock.now().plus(Duration.ofDays(1)), days);
    }

    /** То же за период [since, until) — для аналитики «с … по …». */
    public ProductTrace product(String loc, String productId, Instant since, Instant until, int days) {
        Ctx c = new Ctx(loc, catalog.forLocation(loc));
        ProductInfo p = c.cat.product(productId);
        if (p == null) {
            throw ApiException.notFound("Продукт");
        }
        // 1. Напрямую: заказы, взявшие партии этого продукта.
        Set<Long> orderIds = new LinkedHashSet<>(jdbc.sql("""
                        SELECT DISTINCT m.doc_id::bigint FROM movements m JOIN batches b ON b.id = m.batch_id
                        WHERE m.location_id = ? AND m.doc_type = 'order' AND m.type = 'ORDER'
                          AND b.product_id = ? AND m.at >= ? AND m.at < ?""")
                .params(loc, productId, Timestamp.from(since), Timestamp.from(until)).query(Long.class).list());
        // 2. Через заготовки: какие заготовки за период сделаны с этим продуктом и сколько его в каждой.
        record PrepRow(long id, String label, String productId, long qtyInitial, Instant at, long qty, long cost) {
        }
        List<PrepRow> prepRows = jdbc.sql("""
                        SELECT pb.id, pb.label, pb.product_id, pb.qty_initial, pb.base_date, x.qty, x.cost
                        FROM (SELECT m.doc_id AS op, -SUM(m.qty) AS qty, -SUM(m.cost_kop) AS cost
                              FROM movements m JOIN batches b ON b.id = m.batch_id
                              WHERE m.location_id = ? AND m.type = 'PRODUCTION_USE' AND m.doc_type = 'production'
                                AND b.product_id = ? AND m.at >= ? AND m.at < ?
                              GROUP BY m.doc_id) x
                        JOIN batches pb ON pb.location_id = ? AND pb.source = 'PRODUCTION' AND pb.operation_id::text = x.op
                        ORDER BY pb.base_date DESC""")
                .params(loc, productId, Timestamp.from(since), Timestamp.from(until), loc)
                .query((rs, n) -> new PrepRow(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getLong(4),
                        rs.getTimestamp(5).toInstant(), rs.getLong(6), rs.getLong(7)))
                .list();
        Map<Long, Set<Long>> families = family(prepRows.stream().map(PrepRow::id).toList());
        Map<Long, PrepRow> prepOfBatch = new HashMap<>();
        for (PrepRow r : prepRows) {
            families.getOrDefault(r.id(), Set.of(r.id())).forEach(b -> prepOfBatch.put(b, r));
        }
        if (!prepOfBatch.isEmpty()) {
            orderIds.addAll(ordersOf(prepOfBatch.keySet()));
        }

        Map<String, DishAcc> acc = new LinkedHashMap<>();
        List<OrderUse> recent = new ArrayList<>();
        long toDishes = 0;
        for (Split s : allocate(c, orderIds).values()) {
            if ("CANCELED".equals(s.head().status())) {
                continue;
            }
            for (Alloc a : s.allocs()) {
                long qty;
                long cost;
                String via;
                if (a.productId().equals(productId)) {
                    qty = a.qty();
                    cost = a.costKop();
                    via = null;
                } else if (prepOfBatch.containsKey(a.batchId())) {
                    // Доля продукта в взятой заготовке: продукт в партии заготовки × взято / выход партии.
                    PrepRow r = prepOfBatch.get(a.batchId());
                    qty = Money.share(r.qty(), a.qty(), r.qtyInitial());
                    cost = Money.share(r.cost(), a.qty(), r.qtyInitial());
                    via = c.name(r.productId());
                } else {
                    continue;
                }
                if (qty <= 0) {
                    continue;
                }
                toDishes += qty;
                add(acc, s, a, qty, cost, via);
                Line l = line(s, a.lineNo());
                recent.add(new OrderUse(s.head().id(), s.head().number(), s.head().at(),
                        l == null ? "—" : c.cat.variantName(l.variantId()) + " ×" + l.qty(), qty, p.format(qty), via));
            }
        }
        recent.sort(Comparator.comparing(OrderUse::at).reversed());
        long toPreps = prepRows.stream().mapToLong(PrepRow::qty).sum();
        long lost = jdbc.sql("""
                        SELECT COALESCE(-SUM(m.qty), 0) FROM movements m JOIN batches b ON b.id = m.batch_id
                        WHERE m.location_id = ? AND b.product_id = ? AND m.at >= ? AND m.at < ?
                          AND (m.type LIKE 'WRITEOFF%' OR m.type = 'RETURN_SUPPLIER')""")
                .params(loc, productId, Timestamp.from(since), Timestamp.from(until)).query(Long.class).single();
        List<PrepUse> preps = prepRows.stream().map(r -> new PrepUse(r.id(), r.label(), c.name(r.productId()), r.at(),
                r.qty(), p.format(r.qty()), r.cost())).toList();
        return new ProductTrace(p.id(), p.name(), p.kind() == ProductKind.SEMI, days, toDishes, p.format(toDishes),
                toPreps, p.format(toPreps), lost, p.format(lost), dishUses(c, acc, productId), preps,
                recent.subList(0, Math.min(30, recent.size())));
    }

    // ── Раскладка заказа по блюдам ─────────────────────────────────────────

    /** Для каждого заказа: какие строки какие партии получили. */
    private Map<Long, Split> allocate(Ctx c, Collection<Long> orderIds) {
        Map<Long, Split> out = new LinkedHashMap<>();
        if (orderIds.isEmpty()) {
            return out;
        }
        Long[] ids = orderIds.toArray(Long[]::new);
        Map<Long, Head> heads = new LinkedHashMap<>();
        jdbc.sql("SELECT id, number, status, created_at FROM orders WHERE location_id = ? AND id = ANY(?) ORDER BY created_at")
                .params(c.loc, ids)
                .query(rs -> {
                    heads.put(rs.getLong(1), new Head(rs.getLong(1), rs.getLong(2), rs.getString(3),
                            rs.getTimestamp(4).toInstant()));
                });
        Map<Long, List<Line>> lines = new HashMap<>();
        jdbc.sql("""
                        SELECT order_id, line_no, variant_id, qty, price_kop, recipe_version_id FROM order_lines
                        WHERE order_id = ANY(?) ORDER BY order_id, line_no""")
                .param(ids)
                .query(rs -> {
                    lines.computeIfAbsent(rs.getLong(1), k -> new ArrayList<>()).add(new Line(rs.getInt(2),
                            rs.getString(3), rs.getInt(4), rs.getLong(5), (Long) rs.getObject(6)));
                });
        loadVersions(c, lines.values().stream().flatMap(List::stream).map(Line::recipeVersionId)
                .filter(v -> v != null && !c.versions.containsKey(v)).distinct().toList());
        Map<Long, List<Move>> moves = new HashMap<>();
        jdbc.sql("""
                        SELECT m.doc_id::bigint, b.product_id, m.batch_id, -m.qty, -m.cost_kop
                        FROM movements m JOIN batches b ON b.id = m.batch_id
                        WHERE m.location_id = ? AND m.doc_type = 'order' AND m.type = 'ORDER' AND m.doc_id = ANY(?)
                        ORDER BY m.seq""")
                .params(c.loc, Arrays.stream(ids).map(String::valueOf).toArray(String[]::new))
                .query(rs -> {
                    moves.computeIfAbsent(rs.getLong(1), k -> new ArrayList<>()).add(new Move(rs.getString(2),
                            rs.getLong(3), rs.getLong(4), rs.getLong(5)));
                });
        heads.forEach((id, h) -> {
            List<Line> ls = lines.getOrDefault(id, List.of());
            out.put(id, new Split(h, ls, split(c, ls, moves.getOrDefault(id, List.of()))));
        });
        return out;
    }

    /**
     * Разложить взятое заказом по строкам: строки по порядку забирают свою потребность из партий в том
     * порядке, в каком их списал склад (FEFO). Остаток — последней строке с этим продуктом.
     */
    private static List<Alloc> split(Ctx c, List<Line> lines, List<Move> moves) {
        Map<String, ArrayDeque<long[]>> queue = new LinkedHashMap<>();   // продукт → [партия, осталось, ₽ осталось]
        for (Move m : moves) {
            queue.computeIfAbsent(m.productId(), k -> new ArrayDeque<>())
                    .add(new long[]{m.batchId(), m.qty(), m.costKop()});
        }
        Map<String, Integer> lastLine = new HashMap<>();
        List<Alloc> out = new ArrayList<>();
        for (Line l : lines) {
            for (var e : lineNeed(c, l).entrySet()) {
                String pid = e.getKey();
                lastLine.put(pid, l.lineNo());
                long need = e.getValue();
                ArrayDeque<long[]> q = queue.get(pid);
                while (need > 0 && q != null && !q.isEmpty()) {
                    long[] head = q.peek();
                    long t = Math.min(need, head[1]);
                    long cost = t == head[1] ? head[2] : Money.share(head[2], t, head[1]);
                    out.add(new Alloc(l.lineNo(), pid, head[0], t, cost));
                    head[1] -= t;
                    head[2] -= cost;
                    need -= t;
                    if (head[1] == 0) {
                        q.poll();
                    }
                }
            }
        }
        queue.forEach((pid, q) -> q.forEach(h -> {
            if (h[1] > 0) {
                out.add(new Alloc(lastLine.getOrDefault(pid, 0), pid, h[0], h[1], h[2]));
            }
        }));
        // Одна строка могла взять из одной партии в два приёма — складываем.
        Map<String, Alloc> merged = new LinkedHashMap<>();
        for (Alloc a : out) {
            merged.merge(a.lineNo() + "|" + a.productId() + "|" + a.batchId(), a, (x, y) ->
                    new Alloc(x.lineNo(), x.productId(), x.batchId(), x.qty() + y.qty(), x.costKop() + y.costKop()));
        }
        return new ArrayList<>(merged.values());
    }

    /** Брутто строки по продуктам — по версии техкарты, сохранённой в заказе; у сета — по составу. */
    private static Map<String, Long> lineNeed(Ctx c, Line l) {
        Map<String, Long> per;
        List<RecipeLine> version = l.recipeVersionId() == null ? null : c.versions.get(l.recipeVersionId());
        if (version != null) {
            per = new LinkedHashMap<>();
            for (RecipeLine r : version) {
                ProductInfo p = c.cat.product(r.productId());
                int loss = r.lossBpOverride() != null ? r.lossBpOverride() : p == null ? 0 : p.lossBp();
                per.merge(r.productId(), RecipeLine.gross(r.netQty(), loss), Long::sum);
            }
        } else if (c.cat.variant(l.variantId()) != null) {
            per = Requirements.perPortion(l.variantId(), c.cat);
        } else {
            per = Map.of();
        }
        Map<String, Long> out = new LinkedHashMap<>();
        per.forEach((pid, g) -> out.put(pid, g * l.qty()));
        return out;
    }

    // ── Сборка ответа ──────────────────────────────────────────────────────

    /** Сгруппировать взятое по продуктам; у заготовок — раскрыть сырьё на взятое количество. */
    private List<Part> parts(Ctx c, List<Alloc> allocs, int depth) {
        if (allocs.isEmpty()) {
            return List.of();
        }
        loadBatches(c, allocs.stream().map(Alloc::batchId).toList());
        Map<String, List<Alloc>> byProduct = new LinkedHashMap<>();
        allocs.forEach(a -> byProduct.computeIfAbsent(a.productId(), k -> new ArrayList<>()).add(a));
        List<Part> out = new ArrayList<>();
        byProduct.forEach((pid, list) -> {
            long qty = list.stream().mapToLong(Alloc::qty).sum();
            long cost = list.stream().mapToLong(Alloc::costKop).sum();
            out.add(new Part(pid, c.name(pid), c.semi(pid), qty, c.fmt(pid, qty), cost,
                    list.stream().map(a -> take(c, a, depth)).toList()));
        });
        out.sort(Comparator.comparingLong(Part::costKop).reversed());
        return out;
    }

    private Take take(Ctx c, Alloc a, int depth) {
        BatchInfo b = c.batches.get(a.batchId());
        if (b == null) {
            return new Take(a.batchId(), "#" + a.batchId(), null, null, null, null, null, a.qty(),
                    c.fmt(a.productId(), a.qty()), a.costKop(), List.of());
        }
        BatchInfo root = root(c, b);
        List<Part> madeFrom = List.of();
        if ("PRODUCTION".equals(root.source()) && root.op() != null && depth < MAX_DEPTH) {
            loadProductionUse(c, List.of(root.op()));
            // Сырьё заготовки пропорционально взятому: взяли 40 г из 1 кг соуса — это 4 % его сырья.
            List<Alloc> scaled = c.productionUse.getOrDefault(root.op(), List.of()).stream()
                    .map(m -> new Alloc(0, m.productId(), m.batchId(), Money.share(m.qty(), a.qty(), root.qtyInitial()),
                            Money.share(m.costKop(), a.qty(), root.qtyInitial())))
                    .filter(x -> x.qty() > 0)
                    .toList();
            madeFrom = parts(c, scaled, depth + 1);
        }
        return new Take(b.id(), b.label(), b.source(), root.deliveryNumber(), root.supplier(),
                "PRODUCTION".equals(root.source()) ? root.baseDate() : null, root == b ? null : root.label(),
                a.qty(), c.fmt(a.productId(), a.qty()), a.costKop(), madeFrom);
    }

    /** Накопитель «блюдо ← продукт»: порции считаем по строкам заказа, а не по партиям. */
    private static final class DishAcc {
        final String variantId;
        final String via;
        long qty;
        long cost;
        long portions;
        final Set<Long> orders = new HashSet<>();
        final Set<String> lines = new HashSet<>();

        DishAcc(String variantId, String via) {
            this.variantId = variantId;
            this.via = via;
        }
    }

    private static void add(Map<String, DishAcc> acc, Split s, Alloc a, long qty, long cost, String via) {
        Line l = line(s, a.lineNo());
        String vid = l == null ? "" : l.variantId();
        DishAcc d = acc.computeIfAbsent(vid + "|" + via, k -> new DishAcc(vid, via));
        d.qty += qty;
        d.cost += cost;
        d.orders.add(s.head().id());
        if (l != null && d.lines.add(s.head().id() + "|" + l.lineNo())) {
            d.portions += l.qty();
        }
    }

    private static List<DishUse> dishUses(Ctx c, Map<String, DishAcc> acc, String productId) {
        return acc.values().stream()
                .map(d -> new DishUse(d.variantId, d.variantId.isEmpty() ? "Без блюда" : c.cat.variantName(d.variantId),
                        d.portions, d.orders.size(), d.qty, c.fmt(productId, d.qty), d.cost, d.via))
                .sorted(Comparator.comparingLong(DishUse::qty).reversed())
                .toList();
    }

    private static Line line(Split s, int lineNo) {
        for (Line l : s.lines()) {
            if (l.lineNo() == lineNo) {
                return l;
            }
        }
        return null;
    }

    // ── Загрузка ───────────────────────────────────────────────────────────

    private void loadVersions(Ctx c, List<Long> ids) {
        if (ids.isEmpty()) {
            return;
        }
        jdbc.sql("SELECT version_id, product_id, net_qty, loss_bp FROM recipe_lines WHERE version_id = ANY(?) ORDER BY version_id, product_id")
                .param(ids.toArray(Long[]::new))
                .query(rs -> {
                    c.versions.computeIfAbsent(rs.getLong(1), k -> new ArrayList<>()).add(new RecipeLine(rs.getString(2),
                            rs.getLong(3), (Integer) rs.getObject(4)));
                });
        jdbc.sql("SELECT id, version FROM recipe_versions WHERE id = ANY(?)").param(ids.toArray(Long[]::new))
                .query(rs -> {
                    c.versionNo.put(rs.getLong(1), rs.getInt(2));
                });
    }

    /** Партии и их родители (вскрытая подпартия → исходная упаковка) с поставкой, откуда пришли. */
    private void loadBatches(Ctx c, Collection<Long> ids) {
        Set<Long> need = new HashSet<>();
        ids.forEach(id -> {
            if (!c.batches.containsKey(id)) {
                need.add(id);
            }
        });
        for (int round = 0; round < 5 && !need.isEmpty(); round++) {
            jdbc.sql("""
                            SELECT b.id, b.label, b.product_id, b.source, b.parent_batch_id, b.operation_id::text,
                                   b.qty_initial, b.base_date, d.number, d.supplier
                            FROM batches b
                            LEFT JOIN delivery_lines l ON l.id = b.delivery_line_id
                            LEFT JOIN deliveries d ON d.tenant_id = l.tenant_id AND d.id = l.delivery_id
                            WHERE b.location_id = ? AND b.id = ANY(?)""")
                    .params(c.loc, need.toArray(Long[]::new))
                    .query(rs -> {
                        Object parent = rs.getObject(5);
                        c.batches.put(rs.getLong(1), new BatchInfo(rs.getLong(1), rs.getString(2), rs.getString(3),
                                rs.getString(4), parent == null ? null : ((Number) parent).longValue(), rs.getString(6),
                                rs.getLong(7), rs.getTimestamp(8).toInstant(), rs.getString(9), rs.getString(10)));
                    });
            need.clear();
            for (BatchInfo b : c.batches.values()) {
                if (b.parentId() != null && !c.batches.containsKey(b.parentId())) {
                    need.add(b.parentId());
                }
            }
        }
    }

    private static BatchInfo root(Ctx c, BatchInfo b) {
        BatchInfo cur = b;
        for (int i = 0; i < 10 && "OPENING".equals(cur.source()) && cur.parentId() != null; i++) {
            BatchInfo parent = c.batches.get(cur.parentId());
            if (parent == null) {
                break;
            }
            cur = parent;
        }
        return cur;
    }

    /** Сырьё, взятое на заготовку: движения «расход на заготовку» её операции. */
    private void loadProductionUse(Ctx c, List<String> ops) {
        List<String> need = ops.stream().filter(op -> op != null && !c.productionUse.containsKey(op)).distinct().toList();
        if (need.isEmpty()) {
            return;
        }
        need.forEach(op -> c.productionUse.put(op, new ArrayList<>()));
        jdbc.sql("""
                        SELECT m.doc_id, b.product_id, m.batch_id, -m.qty, -m.cost_kop
                        FROM movements m JOIN batches b ON b.id = m.batch_id
                        WHERE m.location_id = ? AND m.doc_type = 'production' AND m.type = 'PRODUCTION_USE'
                          AND m.doc_id = ANY(?)
                        ORDER BY m.seq""")
                .params(c.loc, need.toArray(String[]::new))
                .query(rs -> {
                    c.productionUse.get(rs.getString(1)).add(new Move(rs.getString(2), rs.getLong(3), rs.getLong(4),
                            rs.getLong(5)));
                });
    }

    /** Партия и все её вскрытые подпартии — одна «семья»: что ушло из любой, ушло из партии. */
    private Map<Long, Set<Long>> family(List<Long> roots) {
        Map<Long, Set<Long>> out = new HashMap<>();
        if (roots.isEmpty()) {
            return out;
        }
        jdbc.sql("""
                        WITH RECURSIVE fam(root, id) AS (
                            SELECT id, id FROM batches WHERE id = ANY(?)
                            UNION ALL
                            SELECT f.root, b.id FROM batches b JOIN fam f ON b.parent_batch_id = f.id
                            WHERE b.source = 'OPENING')
                        SELECT root, id FROM fam""")
                .param(roots.toArray(Long[]::new))
                .query(rs -> {
                    out.computeIfAbsent(rs.getLong(1), k -> new LinkedHashSet<>()).add(rs.getLong(2));
                });
        return out;
    }

    /** По каждой партии с подпартиями: [в заказы, заказов, списано, осталось]. */
    private Map<Long, long[]> familyUsage(List<Long> roots) {
        Map<Long, long[]> out = new HashMap<>();
        jdbc.sql("""
                        WITH RECURSIVE fam(root, id) AS (
                            SELECT id, id FROM batches WHERE id = ANY(?)
                            UNION ALL
                            SELECT f.root, b.id FROM batches b JOIN fam f ON b.parent_batch_id = f.id
                            WHERE b.source = 'OPENING')
                        SELECT f.root,
                               COALESCE(-SUM(m.qty) FILTER (WHERE m.type IN ('ORDER', 'ORDER_RETURN')), 0),
                               COUNT(DISTINCT m.doc_id) FILTER (WHERE m.type = 'ORDER'),
                               COALESCE(-SUM(m.qty) FILTER (WHERE m.type LIKE 'WRITEOFF%' OR m.type = 'RETURN_SUPPLIER'), 0),
                               (SELECT SUM(b.qty_left) FROM fam f2 JOIN batches b ON b.id = f2.id WHERE f2.root = f.root)
                        FROM fam f LEFT JOIN movements m ON m.batch_id = f.id
                        GROUP BY f.root""")
                .param(roots.toArray(Long[]::new))
                .query(rs -> {
                    out.put(rs.getLong(1), new long[]{rs.getLong(2), rs.getLong(3), rs.getLong(4), rs.getLong(5)});
                });
        return out;
    }

    private List<Long> ordersOf(Collection<Long> batchIds) {
        if (batchIds.isEmpty()) {
            return List.of();
        }
        return jdbc.sql("""
                        SELECT DISTINCT doc_id::bigint FROM movements
                        WHERE batch_id = ANY(?) AND doc_type = 'order' AND type = 'ORDER'""")
                .param(batchIds.toArray(Long[]::new)).query(Long.class).list();
    }

    private String batchProduct(Ctx c, long batchId) {
        loadBatches(c, List.of(batchId));
        BatchInfo b = c.batches.get(batchId);
        return b == null ? "" : b.productId();
    }

    private Instant since(int days) {
        return clock.now().minus(Duration.ofDays(Math.min(Math.max(days, 1), 31)));
    }
}
