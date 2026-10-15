package ru.sphere.stock.tenant;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.sphere.stock.admin.AuditService;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.infra.Hashing;
import ru.sphere.stock.ledger.Actor;
import ru.sphere.stock.security.StockPrincipal;
import ru.sphere.stock.security.UserService;

/**
 * Приглашения в предприятие (ТЗ 16.4): одноразовая ссылка с ролью и точкой, действует 7 дней.
 * В базе — только хэш токена, как у паролей и API-ключей: утечка базы не даёт войти по ссылке.
 * Срок считается по настоящим часам, а не по демо-часам: ускорение демо не должно сжигать ссылки.
 */
@Service
public class InviteService {

    public static final Duration TTL = Duration.ofDays(7);

    public record Created(long id, String token, Instant expiresAt) {
    }

    public record InviteDto(long id, String role, String locationId, String note, String createdBy, Instant createdAt,
                            Instant expiresAt, String status, String acceptedBy) {
    }

    /** Что видит человек по ссылке до входа. */
    public record PublicInfo(String tenantName, String role, String locationName, String invitedBy, Instant expiresAt,
                             String status) {
    }

    private final JdbcClient jdbc;
    private final UserService users;
    private final AuditService audit;
    private final TenantDirectory directory;

    public InviteService(JdbcClient jdbc, UserService users, AuditService audit, TenantDirectory directory) {
        this.jdbc = jdbc;
        this.users = users;
        this.audit = audit;
        this.directory = directory;
    }

    @Transactional
    public Created create(long tenantId, String role, String locationId, String note, Actor actor) {
        if (!StockPrincipal.ROLES.contains(role)) {
            throw ApiException.badRequest("Роль — одна из " + StockPrincipal.ROLES);
        }
        String loc = locationId == null || locationId.isBlank() ? null : locationId;
        if (loc != null && !Long.valueOf(tenantId).equals(directory.tenantOfOrNull(loc))) {
            throw ApiException.badRequest("Точка не принадлежит предприятию");
        }
        String token = "inv_" + Hashing.randomToken(18);
        Instant now = Instant.now();
        Instant expires = now.plus(TTL);
        long id = jdbc.sql("""
                        INSERT INTO invitations (tenant_id, token_hash, role, location_id, note, created_by, created_at, expires_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id""")
                .params(tenantId, Hashing.sha256(token), role, loc, note == null || note.isBlank() ? null : note.trim(),
                        actor.userId(), Timestamp.from(now), Timestamp.from(expires))
                .query(Long.class).single();
        audit.record(tenantId, actor, "invite.create", Map.of("id", id, "role", role, "location", String.valueOf(loc)));
        return new Created(id, token, expires);
    }

    public List<InviteDto> list(long tenantId) {
        return jdbc.sql("""
                        SELECT i.id, i.role, i.location_id, i.note, COALESCE(c.name, 'Платформа'), i.created_at, i.expires_at, i.accepted_at,
                               i.revoked_at, a.name
                        FROM invitations i LEFT JOIN users c ON c.id = i.created_by LEFT JOIN users a ON a.id = i.accepted_by
                        WHERE i.tenant_id = ? ORDER BY i.created_at DESC LIMIT 100""")
                .param(tenantId)
                .query((rs, n) -> new InviteDto(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getString(4),
                        rs.getString(5), rs.getTimestamp(6).toInstant(), rs.getTimestamp(7).toInstant(),
                        status(rs.getTimestamp(8), rs.getTimestamp(9), rs.getTimestamp(7).toInstant()),
                        rs.getString(10)))
                .list();
    }

    @Transactional
    public void revoke(long tenantId, long id, Actor actor) {
        int n = jdbc.sql("""
                        UPDATE invitations SET revoked_at = now()
                        WHERE id = ? AND tenant_id = ? AND accepted_at IS NULL AND revoked_at IS NULL""")
                .params(id, tenantId).update();
        if (n == 0) {
            throw ApiException.conflict("Приглашение уже использовано или отозвано");
        }
        audit.record(tenantId, actor, "invite.revoke", Map.of("id", id));
    }

    public PublicInfo info(String token) {
        return jdbc.sql("""
                        SELECT t.name, i.role, l.name, COALESCE(c.name, 'Платформа'), i.expires_at, i.accepted_at, i.revoked_at
                        FROM invitations i JOIN tenants t ON t.id = i.tenant_id LEFT JOIN users c ON c.id = i.created_by
                        LEFT JOIN locations l ON l.id = i.location_id
                        WHERE i.token_hash = ?""")
                .param(Hashing.sha256(token))
                .query((rs, n) -> new PublicInfo(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4),
                        rs.getTimestamp(5).toInstant(),
                        status(rs.getTimestamp(6), rs.getTimestamp(7), rs.getTimestamp(5).toInstant())))
                .optional()
                .orElseThrow(() -> ApiException.notFound("Приглашение"));
    }

    /** Уже зарегистрированный человек принимает приглашение своим входом. @return предприятие */
    @Transactional
    public long accept(String token, long userId) {
        var inv = take(token);
        users.addMembership(userId, inv.tenantId, inv.role, inv.locationId);
        markAccepted(inv, userId);
        audit.record(inv.tenantId, Actor.user(userId, inv.role, "приглашённый"), "invite.accept", Map.of("id", inv.id));
        return inv.tenantId;
    }

    /** Новый человек: учётка + членство одним действием. @return id новой учётки */
    @Transactional
    public long register(String token, String login, String name, String password, String pin) {
        if (password == null || password.length() < 6) {
            throw ApiException.badRequest("Пароль — не короче 6 символов");
        }
        var inv = take(token);
        long userId = users.create(inv.tenantId, login, name, inv.role, inv.locationId, password,
                pin == null || pin.isBlank() ? null : pin);
        markAccepted(inv, userId);
        audit.record(inv.tenantId, Actor.user(userId, inv.role, name), "invite.register", Map.of("id", inv.id,
                "login", login));
        return userId;
    }

    private record Pending(long id, long tenantId, String role, String locationId) {
    }

    /** Приглашение под блокировкой: одну ссылку не примут дважды даже одновременно. */
    private Pending take(String token) {
        var row = jdbc.sql("""
                        SELECT id, tenant_id, role, location_id, expires_at, accepted_at, revoked_at FROM invitations
                        WHERE token_hash = ? FOR UPDATE""")
                .param(token == null ? "" : Hashing.sha256(token))
                .query((rs, n) -> new Object[]{rs.getLong(1), rs.getLong(2), rs.getString(3), rs.getString(4),
                        rs.getTimestamp(5).toInstant(), rs.getTimestamp(6), rs.getTimestamp(7)})
                .optional()
                .orElseThrow(() -> ApiException.notFound("Приглашение"));
        String st = status((Timestamp) row[5], (Timestamp) row[6], (Instant) row[4]);
        if (!"ACTIVE".equals(st)) {
            throw ApiException.conflict(switch (st) {
                case "ACCEPTED" -> "Приглашение уже использовано";
                case "REVOKED" -> "Приглашение отозвано";
                default -> "Срок приглашения истёк — попросите новое";
            });
        }
        return new Pending((Long) row[0], (Long) row[1], (String) row[2], (String) row[3]);
    }

    /** Первый админ по ссылке в предприятие без владельца (его создала платформа) становится владельцем. */
    private void markAccepted(Pending inv, long userId) {
        jdbc.sql("UPDATE invitations SET accepted_by = ?, accepted_at = now() WHERE id = ?").params(userId, inv.id).update();
        if ("ADMIN".equals(inv.role)) {
            jdbc.sql("UPDATE tenants SET owner_id = ? WHERE id = ? AND owner_id IS NULL")
                    .params(userId, inv.tenantId).update();
        }
    }

    private static String status(Timestamp accepted, Timestamp revoked, Instant expires) {
        if (accepted != null) {
            return "ACCEPTED";
        }
        if (revoked != null) {
            return "REVOKED";
        }
        return Instant.now().isAfter(expires) ? "EXPIRED" : "ACTIVE";
    }
}
