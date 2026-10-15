package ru.sphere.stock.stock;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import ru.sphere.stock.domain.BatchState;

/** Партии: чтение снимков для ядра и создание новых партий. */
@Repository
public class StockRepository {

    private static final String COLS = """
            id, product_id, qty_left, held_qty, base_date, expires_at, received_at, opened, blocked,
            cost_total_kop, qty_initial""";

    private final JdbcClient jdbc;

    public StockRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    static BatchState map(ResultSet rs) throws SQLException {
        return new BatchState(
                rs.getLong("id"),
                rs.getString("product_id"),
                rs.getLong("qty_left"),
                rs.getLong("held_qty"),
                rs.getTimestamp("base_date").toInstant(),
                rs.getTimestamp("expires_at").toInstant(),
                rs.getTimestamp("received_at").toInstant(),
                rs.getBoolean("opened"),
                rs.getBoolean("blocked"),
                rs.getLong("cost_total_kop"),
                rs.getLong("qty_initial"));
    }

    /**
     * Живые партии нужных продуктов. {@code forUpdate} — заблокировать в фиксированном порядке
     * (продукт, срок, id), чтобы не было взаимоблокировок (ТЗ 5.5, шаг 3).
     */
    public List<BatchState> live(String locationId, Collection<String> productIds, boolean forUpdate) {
        if (productIds.isEmpty()) {
            return List.of();
        }
        return jdbc.sql("SELECT " + COLS + " FROM batches WHERE location_id = ? AND qty_left > 0 "
                        + "AND product_id = ANY(?) ORDER BY product_id, expires_at, id"
                        + (forUpdate ? " FOR UPDATE" : ""))
                .params(locationId, productIds.toArray(String[]::new))
                .query((rs, n) -> map(rs))
                .list();
    }

    /** Все живые партии точки по продуктам. */
    public Map<String, List<BatchState>> liveByProduct(String locationId) {
        Map<String, List<BatchState>> out = new LinkedHashMap<>();
        jdbc.sql("SELECT " + COLS + " FROM batches WHERE location_id = ? AND qty_left > 0 ORDER BY product_id, expires_at, id")
                .param(locationId)
                .query(rs -> {
                    BatchState b = map(rs);
                    out.computeIfAbsent(b.productId(), k -> new ArrayList<>()).add(b);
                });
        return out;
    }

    public BatchState get(long batchId, boolean forUpdate) {
        return jdbc.sql("SELECT " + COLS + " FROM batches WHERE id = ?" + (forUpdate ? " FOR UPDATE" : ""))
                .param(batchId)
                .query((rs, n) -> map(rs))
                .optional()
                .orElse(null);
    }

    public String locationOf(long batchId) {
        return jdbc.sql("SELECT location_id FROM batches WHERE id = ?").param(batchId).query(String.class)
                .optional().orElse(null);
    }

    /** Новая партия с нулевым остатком: количество приходит движением журнала. */
    public record NewBatch(String locationId, String productId, String source, Long deliveryLineId,
                           Long parentBatchId, UUID operationId, long qtyInitial, long costTotalKop,
                           Instant baseDate, Instant expiresAt, Instant receivedAt, boolean opened, String labelPrefix) {
    }

    public long insert(NewBatch b) {
        long id = jdbc.sql("SELECT nextval('batches_id_seq')").query(Long.class).single();
        jdbc.sql("""
                        INSERT INTO batches (id, location_id, product_id, label, source, delivery_line_id, parent_batch_id,
                                             operation_id, qty_initial, qty_left, cost_total_kop, base_date, expires_at,
                                             received_at, opened)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)""")
                .params(id, b.locationId(), b.productId(), b.labelPrefix() + id, b.source(), b.deliveryLineId(),
                        b.parentBatchId(), b.operationId(), b.qtyInitial(), b.costTotalKop(), Timestamp.from(b.baseDate()),
                        Timestamp.from(b.expiresAt()), Timestamp.from(b.receivedAt()), b.opened())
                .update();
        return id;
    }

    public void setHeld(long batchId, long delta) {
        jdbc.sql("UPDATE batches SET held_qty = held_qty + ? WHERE id = ?").params(delta, batchId).update();
    }

    public void setBlocked(long batchId, boolean blocked, String reason) {
        jdbc.sql("UPDATE batches SET blocked = ?, block_reason = ? WHERE id = ?").params(blocked, reason, batchId).update();
    }
}
