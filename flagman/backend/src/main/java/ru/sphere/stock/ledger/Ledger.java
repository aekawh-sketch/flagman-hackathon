package ru.sphere.stock.ledger;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import ru.sphere.stock.infra.Hashing;

/**
 * Журнал движений: только добавление и хэш-цепочка (ТЗ 6.3, 6.4).
 *
 * <p>{@link #lock} берёт строку {@code ledger_heads} точки {@code FOR UPDATE}. Это одновременно
 * «блокировка склада точки» из ТЗ 5.5 (складские операции точки идут строго по очереди — два заказа
 * на последнюю порцию не пройдут оба) и голова цепочки, поэтому цепочка всегда линейна.
 */
@Component
public class Ledger {

    private final JdbcClient jdbc;

    public Ledger(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** Открытая под блокировкой цепочка точки. Живёт до конца транзакции. */
    public final class Tx {
        private final String locationId;
        private final Instant at;
        private long seq;
        private String hash;

        private Tx(String locationId, Instant at, long seq, String hash) {
            this.locationId = locationId;
            this.at = at.truncatedTo(ChronoUnit.MICROS);
            this.seq = seq;
            this.hash = hash;
        }

        public String locationId() {
            return locationId;
        }

        /** «Сейчас», зафиксированное один раз на всю операцию (ТЗ 5.5, шаг 4). */
        public Instant at() {
            return at;
        }

        /**
         * Записать движение и изменить остаток партии в той же транзакции.
         * Отрицательный остаток отвергнет сама база ({@code CHECK qty_left >= 0}).
         */
        public long append(MovementType type, long batchId, long qty, long costKop, Actor actor, String reason,
                           String docType, String docId, UUID operationId, Long reversesId) {
            long nextSeq = seq + 1;
            String content = String.join("|", locationId, Long.toString(nextSeq), type.name(),
                    Long.toString(batchId), Long.toString(qty), Long.toString(costKop), actor.kind().name(),
                    String.valueOf(actor.userId()), String.valueOf(actor.apiKeyId()), at.toString(),
                    String.valueOf(reason), String.valueOf(docType), String.valueOf(docId),
                    operationId.toString(), String.valueOf(reversesId), hash);
            String newHash = Hashing.sha256(content);
            long id = jdbc.sql("""
                            INSERT INTO movements (location_id, seq, type, batch_id, qty, cost_kop, actor_kind, actor_id,
                                                   api_key_id, at, reason, doc_type, doc_id, operation_id, reverses_id,
                                                   prev_hash, hash)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id""")
                    .params(locationId, nextSeq, type.name(), batchId, qty, costKop, actor.kind().name(),
                            actor.userId(), actor.apiKeyId(), Timestamp.from(at), reason, docType, docId,
                            operationId, reversesId, hash, newHash)
                    .query(Long.class).single();
            jdbc.sql("UPDATE batches SET qty_left = qty_left + ? WHERE id = ?").params(qty, batchId).update();
            jdbc.sql("UPDATE ledger_heads SET seq = ?, hash = ? WHERE location_id = ?")
                    .params(nextSeq, newHash, locationId).update();
            seq = nextSeq;
            hash = newHash;
            return id;
        }
    }

    /** Взять блокировку склада точки. Вызывать внутри транзакции. */
    @Transactional(propagation = Propagation.MANDATORY)
    public Tx lock(String locationId, Instant now) {
        if (!TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("Ledger.lock requires a transaction");
        }
        jdbc.sql("INSERT INTO ledger_heads (location_id, seq, hash) VALUES (?, 0, ?) ON CONFLICT DO NOTHING")
                .params(locationId, Hashing.GENESIS).update();
        return jdbc.sql("SELECT seq, hash FROM ledger_heads WHERE location_id = ? FOR UPDATE")
                .param(locationId)
                .query((rs, n) -> new Tx(locationId, now, rs.getLong(1), rs.getString(2)))
                .single();
    }

    /** Результат проверки целостности цепочки. */
    public record Verification(String locationId, boolean ok, long checked, Long brokenAtSeq, String headHash) {
    }

    /** Пройти цепочку с начала и сверить хэши (ТЗ 6.4). */
    @Transactional(readOnly = true)
    public Verification verify(String locationId) {
        List<Object[]> broken = new ArrayList<>();
        long[] count = {0};
        String[] prev = {Hashing.GENESIS};
        jdbc.sql("""
                        SELECT seq, type, batch_id, qty, cost_kop, actor_kind, actor_id, api_key_id, at, reason,
                               doc_type, doc_id, operation_id, reverses_id, prev_hash, hash
                        FROM movements WHERE location_id = ? ORDER BY seq""")
                .param(locationId)
                .query(rs -> {
                    if (!broken.isEmpty()) {
                        return;
                    }
                    long seq = rs.getLong("seq");
                    String content = String.join("|", locationId, Long.toString(seq), rs.getString("type"),
                            Long.toString(rs.getLong("batch_id")), Long.toString(rs.getLong("qty")),
                            Long.toString(rs.getLong("cost_kop")), rs.getString("actor_kind"),
                            String.valueOf(rs.getObject("actor_id")), String.valueOf(rs.getObject("api_key_id")),
                            rs.getTimestamp("at").toInstant().toString(), String.valueOf(rs.getString("reason")),
                            String.valueOf(rs.getString("doc_type")), String.valueOf(rs.getString("doc_id")),
                            rs.getObject("operation_id").toString(), String.valueOf(rs.getObject("reverses_id")),
                            prev[0]);
                    String expected = Hashing.sha256(content);
                    if (!prev[0].equals(rs.getString("prev_hash")) || !expected.equals(rs.getString("hash"))) {
                        broken.add(new Object[]{seq});
                        return;
                    }
                    prev[0] = expected;
                    count[0]++;
                });
        Long brokenAt = broken.isEmpty() ? null : (Long) broken.getFirst()[0];
        return new Verification(locationId, brokenAt == null, count[0], brokenAt, prev[0]);
    }
}
