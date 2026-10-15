package ru.sphere.stock.antifraud;

import io.swagger.v3.oas.annotations.media.Schema;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import ru.sphere.stock.catalog.CatalogService;
import ru.sphere.stock.domain.Money;
import ru.sphere.stock.domain.ProductInfo;
import ru.sphere.stock.infra.Json;

/**
 * Подробности подозрительной операции (ТЗ 6.11): как сработало правило, цифры человеческим языком, связанные
 * заявки на списание с фото, отмены заказов и ссылки туда, где разбираться дальше — карточка партии, заявки,
 * поставка в «Приёмке», техкарты, пересчёт.
 */
@Service
public class AnomalyDetails {

    @Schema(name = "AnomalyFact", description = "Цифра правила: подпись и значение")
    public record Fact(String label, String value) {
    }

    @Schema(name = "AnomalyWriteoff", description = "Заявка на списание, к которой относится операция")
    public record WriteoffItem(long id, long batchId, String batchLabel, String productName, String qtyText,
                               long costKop, String reason, String comment, String status, Instant createdAt,
                               boolean hasPhoto, int photoCount, int leftPercent, String deliveryId,
                               String deliveryNumber) {
    }

    @Schema(name = "AnomalyOrder", description = "Заказ, отменённый после начала готовки")
    public record OrderItem(long id, long number, Instant canceledAt, String reason, long costKop) {
    }

    @Schema(name = "AnomalyLink", description = "Куда перейти: путь внутри точки, например acceptance?delivery=ID")
    public record Link(String label, String to) {
    }

    @Schema(name = "AnomalyDetail")
    public record Detail(AnomalyService.AnomalyDto anomaly, String ruleHow, List<Fact> facts,
                         List<WriteoffItem> writeoffs, List<OrderItem> orders, List<Link> links) {
    }

    /** Как срабатывает каждое правило — чтобы управляющий понимал, что именно проверять. */
    private static final Map<String, String> HOW = Map.of(
            "A1", "Сотрудник за 7 дней списал вручную заметно больше коллег той же роли: сумма выше порога и в несколько раз больше медианы по роли.",
            "A2", "Продукт списали как испорченный, хотя у партии оставалось больше половины срока годности.",
            "A3", "Большая часть ручных списаний сотрудника за день сделана в последний час перед закрытием.",
            "A4", "Одно списание дороже порога или это самая дорогая позиция склада.",
            "A5", "Сотрудник за 7 дней часто отменял заказы после начала готовки — продукты ушли в потери.",
            "A6", "В новой версии техкарты граммовка продукта выросла больше чем на 20 %.",
            "A7", "Недостача одного и того же продукта при двух пересчётах подряд.",
            "A8", "Третья приёмка с расхождениями за 30 дней у одного кладовщика или поставщика.");

    private static final Map<String, String> ROLE = Map.of("COOK", "повар", "CASHIER", "кассир",
            "STOREKEEPER", "кладовщик", "MANAGER", "управляющий", "ADMIN", "админ");
    private static final Map<String, String> REASON = Map.of("SPOILED", "порча", "DAMAGED", "бой, пролив",
            "OTHER", "прочее");

    private final JdbcClient jdbc;
    private final CatalogService catalog;
    private final AnomalyService anomalies;
    private final Json json;

    public AnomalyDetails(JdbcClient jdbc, CatalogService catalog, AnomalyService anomalies, Json json) {
        this.jdbc = jdbc;
        this.catalog = catalog;
        this.anomalies = anomalies;
        this.json = json;
    }

    public Detail detail(String loc, long id) {
        AnomalyService.AnomalyDto a = anomalies.one(loc, id);
        @SuppressWarnings("unchecked")
        Map<String, Object> ev = a.evidence() == null ? Map.of() : json.read(a.evidence(), Map.class);
        CatalogService.Snapshot cat = catalog.forLocation(loc);
        List<Fact> facts = new ArrayList<>();
        List<WriteoffItem> writeoffs = new ArrayList<>();
        List<OrderItem> orders = new ArrayList<>();
        List<Link> links = new ArrayList<>();
        Instant at = a.detectedAt();

        if (ev.get("costKop") instanceof Number n) {
            facts.add(new Fact("Сумма списания", Money.format(n.longValue())));
        }
        if (ev.get("sumKop") instanceof Number n) {
            facts.add(new Fact("Списано за 7 дней", Money.format(n.longValue())));
        }
        if (ev.get("medianKop") instanceof Number n) {
            facts.add(new Fact("Обычно у роли (медиана)", Money.format(Math.round(n.doubleValue()))));
        }
        if (ev.get("role") instanceof String r) {
            facts.add(new Fact("Роль", ROLE.getOrDefault(r, r)));
        }
        if (ev.get("leftPercent") instanceof Number n) {
            facts.add(new Fact("Срока у партии оставалось", n + " %"));
        }
        if (ev.get("qty") instanceof String q) {
            facts.add(new Fact("Количество", q));
        }
        if (ev.get("topPriceItem") instanceof Boolean top && top) {
            facts.add(new Fact("Позиция", "самая дорогая на складе"));
        }
        if (ev.get("late") instanceof Number late && ev.get("total") instanceof Number total) {
            facts.add(new Fact("Списаний за день", total.toString()));
            facts.add(new Fact("Из них в последний час", late.toString()));
        }
        if (ev.get("count") instanceof Number n) {
            facts.add(new Fact("A8".equals(a.rule()) ? "Приёмок с расхождениями за 30 дней" : "Отмен после готовки за 7 дней",
                    n.toString()));
        }
        if (ev.get("lossKop") instanceof Number n) {
            facts.add(new Fact("Потери", Money.format(n.longValue())));
        }
        if (ev.get("old") instanceof Number o && ev.get("new") instanceof Number nw) {
            facts.add(new Fact("Было в техкарте", o + " (нетто)"));
            facts.add(new Fact("Стало", nw + " (нетто), +" + Math.round(100.0 * (nw.longValue() - o.longValue())
                    / Math.max(1, o.longValue())) + " %"));
            links.add(new Link("Открыть техкарты", "recipes"));
        }
        if (ev.get("supplier") instanceof String s) {
            facts.add(new Fact("Поставщик", s));
        }
        if (ev.get("productId") instanceof String pid) {
            ProductInfo p = cat.product(pid);
            facts.add(new Fact("Продукт", p == null ? pid : p.name()));
        }
        if (ev.get("countId") instanceof Number n) {
            facts.add(new Fact("Пересчёт", "№" + n));
            links.add(new Link("Открыть инвентаризацию", "inventory"));
        }
        if (ev.get("deliveryId") instanceof String d) {
            String number = jdbc.sql("SELECT number FROM deliveries WHERE location_id = ? AND id = ?").params(loc, d)
                    .query(String.class).optional().orElse(d);
            facts.add(new Fact("Поставка", number));
            links.add(new Link("Открыть поставку " + number, "acceptance?delivery=" + d));
        }

        // Заявки на списание: сама заявка (A2, A4) или все списания сотрудника за окно правила (A1 — 7 дней, A3 — сутки).
        if (ev.get("groupId") instanceof String g) {
            writeoffs.addAll(writeoffs(loc, cat, "r.group_id = ?::uuid", g));
        } else if (ev.get("requestId") instanceof Number r) {
            writeoffs.addAll(writeoffs(loc, cat, "r.id = ?", r.longValue()));
        } else if (("A1".equals(a.rule()) || "A3".equals(a.rule())) && a.actorId() != null) {
            Duration window = "A1".equals(a.rule()) ? Duration.ofDays(7) : Duration.ofHours(24);
            writeoffs.addAll(writeoffs(loc, cat, "r.created_by = ? AND r.created_at > ? AND r.created_at <= ?",
                    a.actorId(), Timestamp.from(at.minus(window)), Timestamp.from(at)));
        }
        if (!writeoffs.isEmpty()) {
            links.add(new Link("Открыть заявки на списание", "writeoffs?status=ALL"));
            WriteoffItem first = writeoffs.getFirst();
            links.add(new Link("Карточка партии " + first.batchLabel(), "batches/" + first.batchId()));
            if (first.deliveryId() != null) {
                links.add(new Link("Поставка " + first.deliveryNumber(), "acceptance?delivery=" + first.deliveryId()));
            }
        }

        // A5: какие заказы отменены после начала готовки.
        if ("A5".equals(a.rule()) && a.actorId() != null) {
            orders.addAll(jdbc.sql("""
                            SELECT id, number, canceled_at, cancel_reason, cost_kop FROM orders
                            WHERE location_id = ? AND status = 'CANCELED_LATE' AND canceled_by = ?
                              AND canceled_at > ? AND canceled_at <= ?
                            ORDER BY canceled_at DESC LIMIT 50""")
                    .params(loc, a.actorId(), Timestamp.from(at.minus(Duration.ofDays(7))), Timestamp.from(at))
                    .query((rs, n) -> new OrderItem(rs.getLong(1), rs.getLong(2), rs.getTimestamp(3).toInstant(),
                            rs.getString(4), rs.getLong(5)))
                    .list());
            links.add(new Link("Открыть прослеживаемость заказов", "trace"));
        }
        return new Detail(a, HOW.getOrDefault(a.rule(), ""), facts, writeoffs, orders, links);
    }

    private List<WriteoffItem> writeoffs(String loc, CatalogService.Snapshot cat, String where, Object... params) {
        Object[] all = new Object[params.length + 1];
        all[0] = loc;
        System.arraycopy(params, 0, all, 1, params.length);
        return jdbc.sql("""
                        SELECT r.id, r.batch_id, b.label, b.product_id, r.qty, r.cost_kop, r.reason, r.comment, r.status,
                               r.created_at, r.photo IS NOT NULL, b.base_date, b.expires_at, dv.id, dv.number,
                               GREATEST(cardinality(r.photos), CASE WHEN r.photo IS NULL THEN 0 ELSE 1 END)
                        FROM writeoff_requests r JOIN batches b ON b.id = r.batch_id
                        LEFT JOIN batches pb ON pb.id = b.parent_batch_id
                        LEFT JOIN delivery_lines dl ON dl.id = COALESCE(b.delivery_line_id, pb.delivery_line_id)
                        LEFT JOIN deliveries dv ON dv.tenant_id = dl.tenant_id AND dv.id = dl.delivery_id
                        WHERE r.location_id = ?""" + " AND " + where + " ORDER BY r.created_at DESC LIMIT 50")
                .params(all)
                .query((rs, n) -> {
                    ProductInfo p = cat.product(rs.getString(4));
                    Instant base = rs.getTimestamp(12).toInstant();
                    Instant exp = rs.getTimestamp(13).toInstant();
                    Instant created = rs.getTimestamp(10).toInstant();
                    double life = Duration.between(base, exp).toMinutes();
                    int left = life <= 0 ? 0
                            : (int) Math.max(0, Math.round(100 * Duration.between(created, exp).toMinutes() / life));
                    return new WriteoffItem(rs.getLong(1), rs.getLong(2), rs.getString(3),
                            p == null ? rs.getString(4) : p.name(), p == null ? Long.toString(rs.getLong(5)) : p.format(rs.getLong(5)),
                            rs.getLong(6), REASON.getOrDefault(rs.getString(7), rs.getString(7)), rs.getString(8),
                            rs.getString(9), created, rs.getBoolean(11), rs.getInt(16), left, rs.getString(14),
                            rs.getString(15));
                })
                .list();
    }
}
