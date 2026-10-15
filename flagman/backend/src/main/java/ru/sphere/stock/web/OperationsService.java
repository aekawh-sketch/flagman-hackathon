package ru.sphere.stock.web;

import io.swagger.v3.oas.annotations.media.Schema;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import ru.sphere.stock.catalog.CatalogService;
import ru.sphere.stock.domain.ProductInfo;
import ru.sphere.stock.ledger.MovementType;

/**
 * Операции склада за период — для «провалиться» из аналитики (ТЗ 5.12): что, откуда и куда. Каждая строка —
 * движение журнала с продуктом, количеством, суммой, кто сделал (и кто подал заявку), партией и документом,
 * из которого движение пришло: поставка, заказ, заготовка, заявка на списание, возврат, пересчёт.
 */
@Service
public class OperationsService {

    @Schema(name = "Operation", description = "Движение журнала с документом-источником")
    public record Op(long id, Instant at, String type, String typeTitle, String productId, String productName,
                     long qty, String qtyText, long costKop, String actor,
                     @Schema(description = "Автор заявки на списание, если списал (подписал) другой") String author,
                     long batchId, String batchLabel,
                     @Schema(description = "delivery, order, production, writeoff, return, inventory, recall…") String docType,
                     @Schema(description = "ID документа: поставки, заказа, партии заготовки, заявки") String docId,
                     String docLabel, String reason) {
    }

    @Schema(name = "OperationTypeSum")
    public record TypeSum(String type, String title, long count, long costKop) {
    }

    @Schema(name = "Operations", description = "Операции за период: сводка по типам и список")
    public record Result(String from, String to, long count, List<TypeSum> summary, List<Op> items) {
    }

    private final JdbcClient jdbc;
    private final CatalogService catalog;

    public OperationsService(JdbcClient jdbc, CatalogService catalog) {
        this.jdbc = jdbc;
        this.catalog = catalog;
    }

    /**
     * @param actor   ID сотрудника (его действия и его заявки на списание) или {@code system} — без человека
     * @param type    тип движения, {@code LOSS} — любые списания; без типа — всё, кроме технического вскрытия упаковок
     * @param product ID продукта
     */
    public Result list(String loc, QueryService.Period period, String actor, String type, String product, int limit) {
        CatalogService.Snapshot cat = catalog.forLocation(loc);
        StringBuilder where = new StringBuilder("m.location_id = ? AND m.at >= ? AND m.at < ?");
        List<Object> params = new ArrayList<>(List.of(loc, Timestamp.from(period.from()), Timestamp.from(period.to())));
        if (product != null && !product.isBlank()) {
            where.append(" AND b.product_id = ?");
            params.add(product);
        }
        if (type == null || type.isBlank()) {
            where.append(" AND m.type NOT IN ('OPEN_IN', 'OPEN_OUT')");
        } else if ("LOSS".equals(type)) {
            where.append(" AND m.type LIKE 'WRITEOFF\\_%'");
        } else {
            where.append(" AND m.type = ?");
            params.add(type);
        }
        if ("system".equals(actor)) {
            where.append(" AND m.actor_id IS NULL AND r.created_by IS NULL");
        } else if (actor != null && actor.matches("\\d{1,18}")) {
            where.append(" AND (m.actor_id = ? OR r.created_by = ?)");
            params.add(Long.parseLong(actor));
            params.add(Long.parseLong(actor));
        }
        String from = """
                FROM movements m JOIN batches b ON b.id = m.batch_id
                LEFT JOIN writeoff_requests r ON m.doc_type = 'writeoff' AND r.id::text = m.doc_id
                """;

        List<TypeSum> summary = new ArrayList<>();
        jdbc.sql("SELECT m.type, COUNT(*), SUM(ABS(m.cost_kop)) " + from + " WHERE " + where
                        + " GROUP BY m.type ORDER BY 3 DESC")
                .params(params)
                .query(rs -> {
                    summary.add(new TypeSum(rs.getString(1), title(rs.getString(1)), rs.getLong(2), rs.getLong(3)));
                });

        List<Object> listParams = new ArrayList<>(params);
        listParams.add(Math.min(Math.max(limit, 1), 500));
        List<Op> items = jdbc.sql("""
                        SELECT m.id, m.at, m.type, b.product_id, m.qty, m.cost_kop, COALESCE(u.name, k.name, 'Система'),
                               ru.name, m.batch_id, b.label, m.doc_type, m.doc_id, m.reason,
                               d.number, o.number, pb.id, pb.label, m.actor_id, r.created_by
                        """ + from + """
                        LEFT JOIN users u ON u.id = m.actor_id LEFT JOIN api_keys k ON k.id = m.api_key_id
                        LEFT JOIN users ru ON ru.id = r.created_by
                        LEFT JOIN deliveries d ON m.doc_type = 'delivery' AND d.tenant_id = m.tenant_id AND d.id = m.doc_id
                        LEFT JOIN orders o ON m.doc_type = 'order' AND o.id::text = m.doc_id
                        LEFT JOIN batches pb ON m.doc_type = 'production' AND pb.source = 'PRODUCTION'
                                            AND pb.operation_id::text = m.doc_id
                        WHERE """ + " " + where + " ORDER BY m.at DESC, m.id DESC LIMIT ?")
                .params(listParams)
                .query((rs, n) -> {
                    ProductInfo p = cat.product(rs.getString(4));
                    String docType = rs.getString(11);
                    String docId = rs.getString(12);
                    String label = null;
                    if ("delivery".equals(docType)) {
                        label = "поставка " + (rs.getString(14) != null ? rs.getString(14) : docId);
                    } else if ("order".equals(docType)) {
                        label = rs.getObject(15) != null ? "заказ №" + rs.getLong(15) : "заказ";
                    } else if ("production".equals(docType)) {
                        // Ссылка ведёт на партию заготовки — там видно, из чего она и куда ушла.
                        docId = rs.getObject(16) != null ? Long.toString(rs.getLong(16)) : null;
                        label = rs.getString(17) != null ? "заготовка " + rs.getString(17) : "заготовка";
                    } else if ("writeoff".equals(docType)) {
                        label = "заявка на списание №" + docId;
                    } else if ("return".equals(docType)) {
                        label = "возврат поставщику №" + docId;
                    } else if ("inventory".equals(docType)) {
                        label = "пересчёт №" + docId;
                    } else if ("recall".equals(docType)) {
                        label = "отзыв партии";
                    }
                    long qty = rs.getLong(5);
                    Object actorId = rs.getObject(18);
                    Object authorId = rs.getObject(19);
                    String author = authorId != null && !authorId.equals(actorId) ? rs.getString(8) : null;
                    return new Op(rs.getLong(1), rs.getTimestamp(2).toInstant(), rs.getString(3), title(rs.getString(3)),
                            p == null ? rs.getString(4) : p.id(), p == null ? rs.getString(4) : p.name(), qty,
                            p == null ? Long.toString(qty) : p.format(qty), Math.abs(rs.getLong(6)), rs.getString(7),
                            author, rs.getLong(9), rs.getString(10), docType, docId, label, rs.getString(13));
                })
                .list();
        long count = summary.stream().mapToLong(TypeSum::count).sum();
        return new Result(period.fromDay().toString(), period.toDay().toString(), count, summary, items);
    }

    @Schema(name = "OperationsByActor", description = "Сколько и каких операций у сотрудника за период")
    public record ActorSum(@Schema(description = "ID сотрудника или system") String actor, String name, long count,
                           long costKop, List<TypeSum> types) {
    }

    /**
     * Кто что делал за период: операции по сотрудникам. Списание по заявке засчитывается автору заявки — кто
     * инициировал, а не кто подписал; без человека (просрочка по правилу, сайт по ключу) — «Система».
     */
    public List<ActorSum> byActor(String loc, QueryService.Period period) {
        java.util.Map<String, ActorSum> out = new java.util.LinkedHashMap<>();
        jdbc.sql("""
                        SELECT COALESCE(r.created_by, m.actor_id)::text AS who, COALESCE(ru.name, u.name, k.name, 'Система'),
                               m.type, COUNT(*), SUM(ABS(m.cost_kop))
                        FROM movements m
                        LEFT JOIN writeoff_requests r ON m.doc_type = 'writeoff' AND r.id::text = m.doc_id
                        LEFT JOIN users ru ON ru.id = r.created_by
                        LEFT JOIN users u ON u.id = m.actor_id LEFT JOIN api_keys k ON k.id = m.api_key_id
                        WHERE m.location_id = ? AND m.at >= ? AND m.at < ? AND m.type NOT IN ('OPEN_IN', 'OPEN_OUT')
                        GROUP BY 1, 2, 3 ORDER BY 4 DESC""")
                .params(loc, Timestamp.from(period.from()), Timestamp.from(period.to()))
                .query(rs -> {
                    String who = rs.getString(1) == null ? "system" : rs.getString(1);
                    String name = rs.getString(2);
                    TypeSum t = new TypeSum(rs.getString(3), title(rs.getString(3)), rs.getLong(4), rs.getLong(5));
                    ActorSum cur = out.get(who);
                    List<TypeSum> types = new ArrayList<>(cur == null ? List.of() : cur.types());
                    types.add(t);
                    out.put(who, new ActorSum(who, name, (cur == null ? 0 : cur.count()) + t.count(),
                            (cur == null ? 0 : cur.costKop()) + t.costKop(), types));
                });
        List<ActorSum> list = new ArrayList<>(out.values());
        list.sort(java.util.Comparator.comparingLong(ActorSum::count).reversed());
        return list;
    }

    private static String title(String type) {
        try {
            return MovementType.valueOf(type).title();
        } catch (IllegalArgumentException e) {
            return type;
        }
    }
}
