package ru.sphere.stock.admin;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import ru.sphere.stock.infra.AppClock;
import ru.sphere.stock.infra.Hashing;
import ru.sphere.stock.infra.Json;
import ru.sphere.stock.ledger.Actor;

/**
 * Аудит действий админа (ТЗ 6.4): техкарты, пользователи, ключи, настройки, часы.
 * Как и журнал движений — только добавление и хэш-цепочка, своя у каждого предприятия (ТЗ 16.4).
 */
@Service
public class AuditService {

    public record Entry(long seq, Instant at, Long actorId, String actorName, String action, String details) {
    }

    private final JdbcClient jdbc;
    private final AppClock clock;
    private final Json json;

    public AuditService(JdbcClient jdbc, AppClock clock, Json json) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.json = json;
    }

    /**
     * @param tenantId предприятие, к которому относится действие; {@code null} — действие над всей системой
     *                 (демо-часы, полный сброс). Цепочка общая: так удаление записей одного предприятия тоже видно.
     */
    @Transactional(propagation = Propagation.REQUIRED)
    public void record(Long tenantId, Actor actor, String action, Map<String, ?> details) {
        // Своя цепочка у каждого предприятия: очередь записи — тоже своя.
        jdbc.sql("SELECT pg_advisory_xact_lock(42, ?)").param(tenantId == null ? 0 : tenantId.intValue()).query(rs -> {
        });
        var head = jdbc.sql("SELECT seq, hash FROM audit_log WHERE tenant_id IS NOT DISTINCT FROM ? ORDER BY seq DESC LIMIT 1")
                .param(tenantId)
                .query((rs, n) -> new Object[]{rs.getLong(1), rs.getString(2)})
                .optional().orElse(new Object[]{0L, Hashing.GENESIS});
        long seq = (Long) head[0] + 1;
        Instant at = clock.now();
        String d = json.write(details);
        String hash = Hashing.sha256(seq + "|" + at + "|" + actor.userId() + "|" + action + "|" + d + "|" + head[1]);
        jdbc.sql("""
                        INSERT INTO audit_log (tenant_id, seq, at, actor_id, action, details, prev_hash, hash)
                        VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?)""")
                .params(tenantId, seq, Timestamp.from(at), actor.userId(), action, d, head[1], hash)
                .update();
    }

    /** Аудит своего предприятия и общесистемные действия (часы, сброс). */
    public List<Entry> list(long tenantId, int limit) {
        return jdbc.sql("""
                        SELECT a.seq, a.at, a.actor_id, u.name, a.action, a.details::text
                        FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
                        WHERE a.tenant_id = ? OR a.tenant_id IS NULL ORDER BY a.seq DESC LIMIT ?""")
                .params(tenantId, limit)
                .query((rs, n) -> new Entry(rs.getLong(1), rs.getTimestamp(2).toInstant(), (Long) rs.getObject(3),
                        rs.getString(4), rs.getString(5), rs.getString(6)))
                .list();
    }
}
