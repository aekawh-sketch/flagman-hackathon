package ru.sphere.stock.order;

import io.swagger.v3.oas.annotations.media.Schema;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.sphere.stock.alerts.AlertService;
import ru.sphere.stock.catalog.CatalogService;
import ru.sphere.stock.domain.BatchState;
import ru.sphere.stock.domain.Fefo;
import ru.sphere.stock.domain.Money;
import ru.sphere.stock.domain.OrderCheck;
import ru.sphere.stock.domain.OrderLine;
import ru.sphere.stock.domain.ProductInfo;
import ru.sphere.stock.domain.Requirements;
import ru.sphere.stock.domain.VariantDef;
import ru.sphere.stock.events.OrderPlaced;
import ru.sphere.stock.events.StockChanged;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.infra.AppClock;
import ru.sphere.stock.infra.Hashing;
import ru.sphere.stock.infra.Json;
import ru.sphere.stock.ledger.Actor;
import ru.sphere.stock.ledger.Ledger;
import ru.sphere.stock.ledger.MovementType;
import ru.sphere.stock.menu.MenuService;
import ru.sphere.stock.stock.StockOps;
import ru.sphere.stock.stock.StockRepository;

/**
 * Заказы (ТЗ 5.5, 5.6): «всё или ничего» в одной транзакции под блокировкой склада точки,
 * списание по FEFO, отказ с объяснением, отмена с возвратом в те же партии.
 */
@Service
public class OrderService {

    public static final List<String> FLOW = List.of("NEW", "ACCEPTED", "COOKING", "READY", "DELIVERING", "DONE");
    private static final Set<String> EARLY = Set.of("NEW", "ACCEPTED");
    private static final Set<String> SOURCES = Set.of("POS", "SITE", "GENERATOR", "API");

    @Schema(name = "OrderLineIn", description = "Строка заказа")
    public record LineIn(
            @Schema(description = "ID блюда (варианта): например rc9 — «Филадельфия», pz1-30 — «Болоньезе 30 см»", example = "rc9") String variantId,
            @Schema(description = "Количество порций, 1–100", example = "2") int qty) {
    }

    @Schema(description = "Заказ")
    public record OrderIn(
            @Schema(description = "Номер заказа во внешней системе — повтор с тем же номером не списывает второй раз", example = "SITE-1001") String externalId,
            @Schema(description = "Источник: POS — касса, SITE — сайт, GENERATOR — генератор, API — другое", example = "SITE") String source,
            @Schema(description = "Блюда заказа") List<LineIn> lines) {
    }

    public sealed interface Outcome permits Created, Refused {
    }

    @Schema(name = "OrderCreated")
    public record Created(long id, long number, String status, long totalKop, long costKop, boolean duplicate)
            implements Outcome {
    }

    /** Объяснение отказа (ТЗ 5.5): чего не хватает, «максимум N», похожие доступные блюда. */
    public record Refused(String message, List<ShortageDto> shortages, List<MaxDto> maxima,
                          List<MenuService.Alternative> alternatives) implements Outcome {
    }

    @Schema(name = "OrderShortage")
    public record ShortageDto(String productId, String productName, String unit, long need, long available,
                              String needText, String availableText, List<String> byLines) {
    }

    public record MaxDto(String variantId, String variantName, int requested, int max) {
    }

    private final JdbcClient jdbc;
    private final AppClock clock;
    private final Ledger ledger;
    private final StockRepository batches;
    private final StockOps ops;
    private final CatalogService catalog;
    private final MenuService menu;
    private final AlertService alerts;
    private final Json json;
    private final ApplicationEventPublisher events;

    public OrderService(JdbcClient jdbc, AppClock clock, Ledger ledger, StockRepository batches, StockOps ops,
                        CatalogService catalog, MenuService menu, AlertService alerts, Json json,
                        ApplicationEventPublisher events) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.ledger = ledger;
        this.batches = batches;
        this.ops = ops;
        this.catalog = catalog;
        this.menu = menu;
        this.alerts = alerts;
        this.json = json;
        this.events = events;
    }

    @Transactional
    public Outcome create(String locationId, OrderIn in, Actor actor) {
        CatalogService.Snapshot cat = catalog.forLocation(locationId);
        List<OrderLine> lines = validate(in, cat);
        String payloadHash = Hashing.sha256(in.lines().stream().map(l -> l.variantId() + "x" + l.qty())
                .collect(Collectors.joining(",")));

        // 1. Идемпотентность: тот же внешний ID — вернуть уже созданный заказ.
        var existing = findByExternal(locationId, in.externalId());
        if (existing != null) {
            if (!existing.payloadHash.equals(payloadHash)) {
                throw ApiException.conflict("Заказ " + in.externalId() + " уже есть с другим составом");
            }
            return new Created(existing.id, existing.number, existing.status, existing.total, existing.cost, true);
        }

        // 2. Потребность по продуктам: сеты раскрыты, всё сложено в брутто.
        Requirements.Need need = Requirements.expand(lines, cat);

        // 3–4. Блокировка склада точки, партии FOR UPDATE, «сейчас» фиксируется один раз.
        Ledger.Tx tx = ledger.lock(locationId, clock.now());
        Instant now = tx.at();
        Map<String, List<BatchState>> locked = batches.live(locationId, need.total().keySet(), true).stream()
                .collect(Collectors.groupingBy(BatchState::productId, LinkedHashMap::new, Collectors.toList()));
        Map<String, Long> available = new LinkedHashMap<>();
        need.total().keySet().forEach(pid -> available.put(pid, Fefo.available(locked.getOrDefault(pid, List.of()), now)));

        OrderCheck.Result check = OrderCheck.check(need, available);
        long total = lines.stream().mapToLong(l -> cat.variant(l.variantId()).priceKop() * l.qty()).sum();

        // 5. Не хватает — заказ не создаётся, отказ пишем для статистики дефицита.
        if (!check.ok()) {
            Refused refused = explain(locationId, check, lines, cat, now);
            jdbc.sql("""
                            INSERT INTO order_refusals (location_id, at, external_id, source, actor_id, lines, shortages, lost_kop)
                            VALUES (?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?)""")
                    .params(locationId, Timestamp.from(now), in.externalId(), in.source(), actor.userId(),
                            json.write(in.lines()), json.write(refused.shortages()), total)
                    .update();
            alerts.raise(locationId, "ORDER_REFUSED", "WARN", "refusal", in.externalId() == null
                            ? UUID.randomUUID().toString() : in.externalId(),
                    "Отказ в заказе", refused.message(), now);
            events.publishEvent(new StockChanged(locationId, "order.refused"));
            return refused;
        }

        // 6–7. Хватает — создаём заказ и списываем по FEFO.
        long number = jdbc.sql("SELECT COALESCE(MAX(number), 0) + 1 FROM orders WHERE location_id = ?")
                .param(locationId).query(Long.class).single();
        long orderId = jdbc.sql("""
                        INSERT INTO orders (location_id, external_id, number, source, status, created_at, created_by,
                                            api_key_id, payload_hash, total_kop, cost_kop, status_at)
                        VALUES (?, ?, ?, ?, 'NEW', ?, ?, ?, ?, ?, 0, ?) RETURNING id""")
                .params(locationId, in.externalId(), number, in.source(), Timestamp.from(now), actor.userId(),
                        actor.apiKeyId(), payloadHash, total, Timestamp.from(now))
                .query(Long.class).single();
        for (int i = 0; i < lines.size(); i++) {
            VariantDef v = cat.variant(lines.get(i).variantId());
            jdbc.sql("""
                            INSERT INTO order_lines (order_id, line_no, variant_id, qty, price_kop, recipe_version_id)
                            VALUES (?, ?, ?, ?, ?, ?)""")
                    .params(orderId, i + 1, v.id(), lines.get(i).qty(), v.priceKop(),
                            v.recipeVersionId() == 0 ? null : v.recipeVersionId())
                    .update();
        }
        long cost = ops.consume(tx, need.total(), locked, MovementType.ORDER, actor, null, "order",
                        Long.toString(orderId), UUID.randomUUID(), cat).stream()
                .mapToLong(StockOps.Consumed::costKop).sum();
        jdbc.sql("UPDATE orders SET cost_kop = ? WHERE id = ?").params(cost, orderId).update();
        events.publishEvent(new StockChanged(locationId, "order.created"));
        events.publishEvent(new OrderPlaced(locationId, orderId));    // после коммита — чек на кухню
        return new Created(orderId, number, "NEW", total, cost, false);
    }

    private Refused explain(String locationId, OrderCheck.Result check, List<OrderLine> lines,
                            CatalogService.Snapshot cat, Instant now) {
        List<ShortageDto> shortages = new ArrayList<>();
        StringBuilder msg = new StringBuilder("Заказ не принят.");
        for (OrderCheck.Shortage s : check.shortages()) {
            ProductInfo p = cat.product(s.productId());
            List<String> byLines = s.contributions().stream()
                    .map(c -> cat.variantName(c.variantId()) + " ×" + c.qty() + " — " + p.format(c.gross()))
                    .toList();
            shortages.add(new ShortageDto(p.id(), p.name(), p.unit().name(), s.need(), s.available(),
                    p.format(s.need()), p.format(s.available()), byLines));
            msg.append(" Не хватает «").append(p.name()).append("»: нужно ").append(p.format(s.need()));
            if (byLines.size() > 1) {
                msg.append(" (").append(String.join(", ", byLines)).append(')');
            }
            msg.append(", доступно ").append(p.format(s.available())).append('.');
        }
        List<MaxDto> maxima = check.maxima().stream()
                .map(m -> new MaxDto(m.variantId(), cat.variantName(m.variantId()), m.requested(), m.max()))
                .toList();
        for (MaxDto m : maxima) {
            msg.append(' ').append(m.variantName()).append(": ")
                    .append(m.max() == 0 ? "сейчас нельзя" : "максимум " + m.max())
                    .append(lines.size() > 1 ? ", если остальной заказ не менять." : ".");
        }
        List<MenuService.Alternative> alts = menu.alternatives(locationId,
                lines.stream().map(OrderLine::variantId).toList(), now);
        return new Refused(msg.toString(), shortages, maxima, alts);
    }

    /** Смена статуса — только вперёд по потоку. */
    @Transactional
    public void setStatus(String locationId, long orderId, String status, Actor actor) {
        Row o = lockOrder(locationId, orderId);
        int from = FLOW.indexOf(o.status);
        int to = FLOW.indexOf(status);
        if (from < 0 || to < 0 || to <= from) {
            throw ApiException.conflict("Нельзя перевести заказ из «" + o.status + "» в «" + status + "»");
        }
        jdbc.sql("UPDATE orders SET status = ?, status_at = ? WHERE id = ?")
                .params(status, Timestamp.from(clock.now()), orderId).update();
        events.publishEvent(new StockChanged(locationId, "order.status"));
    }

    /**
     * Отмена (ТЗ 5.6). До «готовится» — сторно: те же количества в те же партии.
     * Начали готовить — остатки не меняются, себестоимость уходит в потери с автором и причиной.
     */
    @Transactional
    public String cancel(String locationId, long orderId, String reason, Actor actor) {
        Row o = lockOrder(locationId, orderId);
        if (o.status.startsWith("CANCELED") || "DONE".equals(o.status)) {
            throw ApiException.conflict("Заказ уже завершён: " + o.status);
        }
        if (EARLY.contains(o.status)) {
            Ledger.Tx tx = ledger.lock(locationId, clock.now());
            UUID op = UUID.randomUUID();
            List<long[]> taken = jdbc.sql("""
                            SELECT id, batch_id, qty, cost_kop FROM movements
                            WHERE location_id = ? AND doc_type = 'order' AND doc_id = ? AND type = 'ORDER' ORDER BY seq""")
                    .params(locationId, Long.toString(orderId))
                    .query((rs, n) -> new long[]{rs.getLong(1), rs.getLong(2), rs.getLong(3), rs.getLong(4)})
                    .list();
            for (long[] m : taken) {
                tx.append(MovementType.ORDER_RETURN, m[1], -m[2], -m[3], actor, reason, "order",
                        Long.toString(orderId), op, m[0]);
            }
            jdbc.sql("UPDATE orders SET status = 'CANCELED', status_at = ?, canceled_by = ?, canceled_at = ?, "
                            + "cancel_reason = ? WHERE id = ?")
                    .params(Timestamp.from(tx.at()), actor.userId(), Timestamp.from(tx.at()), reason, orderId).update();
            events.publishEvent(new StockChanged(locationId, "order.canceled"));
            return "CANCELED";
        }
        if (reason == null || reason.isBlank()) {
            throw ApiException.badRequest("Заказ уже готовится — укажите причину отмены");
        }
        Instant now = clock.now();
        jdbc.sql("UPDATE orders SET status = 'CANCELED_LATE', status_at = ?, canceled_by = ?, canceled_at = ?, "
                        + "cancel_reason = ? WHERE id = ?")
                .params(Timestamp.from(now), actor.userId(), Timestamp.from(now), reason, orderId).update();
        alerts.raise(locationId, "LATE_CANCEL", "WARN", "order", Long.toString(orderId),
                "Отмена после начала готовки", "Заказ №" + o.number + ": потери " + Money.format(o.cost)
                        + ", отменил(а) " + actor.name() + ". Причина: " + reason, now);
        events.publishEvent(new StockChanged(locationId, "order.canceled_late"));
        return "CANCELED_LATE";
    }

    private record Row(long id, long number, String status, long total, long cost, String payloadHash) {
    }

    private Row findByExternal(String locationId, String externalId) {
        if (externalId == null) {
            return null;
        }
        return jdbc.sql("SELECT id, number, status, total_kop, cost_kop, payload_hash FROM orders "
                        + "WHERE location_id = ? AND external_id = ?")
                .params(locationId, externalId)
                .query((rs, n) -> new Row(rs.getLong(1), rs.getLong(2), rs.getString(3), rs.getLong(4),
                        rs.getLong(5), rs.getString(6)))
                .optional().orElse(null);
    }

    private Row lockOrder(String locationId, long orderId) {
        return jdbc.sql("SELECT id, number, status, total_kop, cost_kop, payload_hash FROM orders "
                        + "WHERE id = ? AND location_id = ? FOR UPDATE")
                .params(orderId, locationId)
                .query((rs, n) -> new Row(rs.getLong(1), rs.getLong(2), rs.getString(3), rs.getLong(4),
                        rs.getLong(5), rs.getString(6)))
                .optional().orElseThrow(() -> ApiException.notFound("Заказ"));
    }

    private static List<OrderLine> validate(OrderIn in, CatalogService.Snapshot cat) {
        if (in.externalId() == null || in.externalId().isBlank()) {
            throw ApiException.badRequest("Нужен externalId — номер заказа во внешней системе (для идемпотентности)");
        }
        if (in.source() == null || !SOURCES.contains(in.source())) {
            throw ApiException.badRequest("source — одно из " + SOURCES);
        }
        if (in.lines() == null || in.lines().isEmpty()) {
            throw ApiException.badRequest("В заказе нет блюд");
        }
        List<OrderLine> out = new ArrayList<>();
        for (LineIn l : in.lines()) {
            if (cat.variant(l.variantId()) == null) {
                throw ApiException.badRequest("Неизвестное блюдо: " + l.variantId());
            }
            if (l.qty() <= 0 || l.qty() > 100) {
                throw ApiException.badRequest("Количество — от 1 до 100");
            }
            out.add(new OrderLine(l.variantId(), l.qty()));
        }
        return out;
    }
}
