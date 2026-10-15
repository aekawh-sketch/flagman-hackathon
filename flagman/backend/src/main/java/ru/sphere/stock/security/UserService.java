package ru.sphere.stock.security;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.infra.Hashing;
import ru.sphere.stock.ledger.Actor;
import ru.sphere.stock.redis.SharedStore;
import ru.sphere.stock.tenant.TenantDirectory;

/**
 * Учётные записи (ТЗ 6.1, 16.4): учётка одна на всю систему — логин, пароль, личный PIN (подпись под списанием
 * в панели ресторана). Роль и точка — у членства в предприятии, поэтому один человек может работать
 * в нескольких ресторанах. После 5 неверных попыток — блокировка на 5 минут. Пароли и PIN — только хэши.
 * Счётчики попыток и блокировки — в Redis: перебор не обойти перезапуском склада или запросами к другому серверу.
 */
@Service
public class UserService {

    public record UserDto(long id, String login, String name, String role, String locationId, boolean active,
                          boolean hasPin) {
    }

    /** Членство: в каком предприятии и с какой ролью работает человек. */
    public record MembershipDto(long tenantId, String tenantName, String role, String locationId) {
    }

    public record ApiKeyCreated(long id, String name, String key, List<String> scopes) {
    }

    private static final int MAX_ATTEMPTS = 5;
    private static final Duration LOCKOUT = Duration.ofMinutes(5);
    /** Неверные попытки считаются в этом окне: пять ошибок за неделю — не перебор. */
    private static final Duration ATTEMPTS_WINDOW = Duration.ofMinutes(15);

    private final JdbcClient jdbc;
    private final PasswordEncoder encoder;
    private final TenantDirectory tenants;
    private final SharedStore shared;

    public UserService(JdbcClient jdbc, PasswordEncoder encoder, TenantDirectory tenants, SharedStore shared) {
        this.jdbc = jdbc;
        this.encoder = encoder;
        this.tenants = tenants;
        this.shared = shared;
    }

    // ── Вход ───────────────────────────────────────────────────────────────

    /**
     * Вход по логину и паролю.
     *
     * @param locationId точка: вход в её предприятие с проверкой доступа к точке (так панель ресторана узнаёт роль
     *                   сотрудника именно у себя); {@code null} — в последнее предприятие человека
     */
    public StockPrincipal login(String login, String password, String locationId) {
        String key = "pwd:" + login;
        checkLock(key);
        var row = jdbc.sql("SELECT id, password_hash FROM users WHERE login = ? AND active")
                .param(login)
                .query((rs, n) -> new Object[]{rs.getLong(1), rs.getString(2)})
                .optional();
        if (row.isEmpty() || row.get()[1] == null || !encoder.matches(password, (String) row.get()[1])) {
            fail(key);
            throw new ApiException(HttpStatus.UNAUTHORIZED, "Неверный логин или пароль");
        }
        shared.delete("auth:fail:" + key);
        if (locationId == null || locationId.isBlank()) {
            return principal((Long) row.get()[0], null);
        }
        Long tenant = tenants.tenantOfOrNull(locationId);
        if (tenant == null) {
            throw ApiException.notFound("Точка");
        }
        StockPrincipal p = principal((Long) row.get()[0], tenant);
        if (!p.canAccess(locationId)) {
            throw ApiException.forbidden("Нет доступа к этой точке");
        }
        return p;
    }

    /**
     * Вход по личному PIN: панель ресторана так подписывает списание от имени сотрудника (вкладки входа
     * по PIN во Флагмане нет — ТЗ 16.12).
     *
     * @param locationId точка: вход — в её предприятие; {@code null} — в последнее предприятие человека
     */
    public StockPrincipal loginPin(long userId, String pin, String locationId) {
        String key = "pin:" + userId;
        checkLock(key);
        String hash = jdbc.sql("SELECT pin_hash FROM users WHERE id = ? AND active").param(userId)
                .query(String.class).optional().orElse(null);
        if (hash == null || !encoder.matches(pin, hash)) {
            fail(key);
            throw new ApiException(HttpStatus.UNAUTHORIZED, "Неверный PIN");
        }
        shared.delete("auth:fail:" + key);
        Long tenant = locationId == null ? null : tenants.tenantOfOrNull(locationId);
        StockPrincipal p = principal(userId, tenant);
        if (locationId != null && !p.canAccess(locationId)) {
            throw ApiException.forbidden("Нет доступа к этой точке");
        }
        return p;
    }

    /** Демо-вход под ролью — только в демо-режиме, для жюри (п. 34). Всегда в демо-предприятие. */
    public StockPrincipal demoLogin(String role) {
        if ("PLATFORM".equals(role)) {
            // Администратор платформы — над всеми предприятиями и ни в одном не работает.
            long id = jdbc.sql("SELECT id FROM users WHERE login = 'demo-platform' AND platform_admin AND active")
                    .query(Long.class).optional()
                    .orElseThrow(() -> ApiException.notFound("Демо-учётка администратора платформы"));
            return principal(id, null);
        }
        long id = jdbc.sql("""
                        SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id
                        WHERE m.tenant_id = ? AND m.role = ? AND m.active AND u.active AND u.login LIKE 'demo-%'
                        ORDER BY u.id LIMIT 1""")
                .params(TenantDirectory.DEMO, role)
                .query(Long.class).optional()
                .orElseThrow(() -> ApiException.notFound("Демо-учётка с ролью " + role));
        return principal(id, TenantDirectory.DEMO);
    }

    /**
     * Принципал человека в предприятии. {@code tenantId == null} — последнее, где он работал, иначе первое.
     * Нет ни одного членства — принципал без роли: можно только создать предприятие или принять приглашение.
     */
    public StockPrincipal principal(long userId, Long tenantId) {
        var u = jdbc.sql("SELECT login, name, last_tenant_id FROM users WHERE id = ? AND active").param(userId)
                .query((rs, n) -> new Object[]{rs.getString(1), rs.getString(2), rs.getObject(3)})
                .optional().orElseThrow(() -> new ApiException(HttpStatus.UNAUTHORIZED, "Учётная запись отключена"));
        Long wanted = tenantId != null ? tenantId : (Long) u[2];
        var m = jdbc.sql("""
                        SELECT m.tenant_id, t.name, m.role, m.location_id FROM memberships m JOIN tenants t ON t.id = m.tenant_id
                        WHERE m.user_id = ? AND m.active
                        ORDER BY (m.tenant_id = ?) DESC, m.created_at, m.tenant_id LIMIT 1""")
                .params(userId, wanted == null ? -1L : wanted)
                .query((rs, n) -> new MembershipDto(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getString(4)))
                .optional();
        if (tenantId != null && (m.isEmpty() || m.get().tenantId() != tenantId)) {
            throw ApiException.forbidden("Вы не работаете в этом предприятии");
        }
        if (m.isEmpty()) {
            return new StockPrincipal(Actor.Kind.USER, userId, (String) u[0], (String) u[1], StockPrincipal.NO_ROLE,
                    null, Set.of(), 0, null);
        }
        MembershipDto ms = m.get();
        jdbc.sql("UPDATE users SET last_tenant_id = ? WHERE id = ?").params(ms.tenantId(), userId).update();
        return new StockPrincipal(Actor.Kind.USER, userId, (String) u[0], (String) u[1], ms.role(), ms.locationId(),
                Set.of(), ms.tenantId(), ms.tenantName());
    }

    public List<MembershipDto> memberships(long userId) {
        return jdbc.sql("""
                        SELECT m.tenant_id, t.name, m.role, m.location_id FROM memberships m JOIN tenants t ON t.id = m.tenant_id
                        WHERE m.user_id = ? AND m.active ORDER BY t.name""")
                .param(userId)
                .query((rs, n) -> new MembershipDto(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getString(4)))
                .list();
    }

    // ── Сотрудники предприятия ─────────────────────────────────────────────

    /** Список для экрана PIN: только имена и роли сотрудников точки. */
    public List<UserDto> pinUsers(String locationId) {
        Long tenant = tenants.tenantOfOrNull(locationId);
        if (tenant == null) {
            return List.of();
        }
        return jdbc.sql("""
                        SELECT u.id, u.login, u.name, m.role, m.location_id, m.active, TRUE FROM memberships m
                        JOIN users u ON u.id = m.user_id
                        WHERE m.tenant_id = ? AND m.active AND u.active AND u.pin_hash IS NOT NULL
                          AND (m.location_id IS NULL OR m.location_id = ?)
                        ORDER BY m.role, u.name""")
                .params(tenant, locationId)
                .query((rs, n) -> new UserDto(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getString(4),
                        rs.getString(5), rs.getBoolean(6), rs.getBoolean(7)))
                .list();
    }

    public List<UserDto> list(long tenantId) {
        return jdbc.sql("""
                        SELECT u.id, u.login, u.name, m.role, m.location_id, m.active AND u.active, u.pin_hash IS NOT NULL
                        FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? ORDER BY m.role, u.name""")
                .param(tenantId)
                .query((rs, n) -> new UserDto(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getString(4),
                        rs.getString(5), rs.getBoolean(6), rs.getBoolean(7)))
                .list();
    }

    /**
     * Открытая регистрация (ТЗ 16.9): учётка без предприятия — дальше человек принимает приглашение или создаёт своё.
     */
    @Transactional
    public long createAccount(String login, String name, String password) {
        if (password == null || password.length() < 6) {
            throw ApiException.badRequest("Пароль — не короче 6 символов");
        }
        return create(0, login, name, "ADMIN", null, password, null);
    }

    /** Администратор платформы — роль над всеми предприятиями, не зависящая от ролей внутри них. */
    public boolean isPlatformAdmin(long userId) {
        return jdbc.sql("SELECT EXISTS (SELECT 1 FROM users WHERE id = ? AND active AND platform_admin)")
                .param(userId).query(Boolean.class).single();
    }

    /** Новая учётка сразу с членством в предприятии. Уже есть такой логин — приглашайте ссылкой. */
    @Transactional
    public long create(long tenantId, String login, String name, String role, String locationId, String password,
                       String pin) {
        validateRole(role);
        if (login == null || !login.matches("[A-Za-z0-9._@-]{3,64}")) {
            throw ApiException.badRequest("Логин — 3–64 символа: латиница, цифры, точка, дефис, @");
        }
        if (name == null || name.isBlank()) {
            throw ApiException.badRequest("Нужно имя");
        }
        if (pin != null && !pin.matches("\\d{4,6}")) {
            throw ApiException.badRequest("PIN — 4–6 цифр");
        }
        if (password != null && password.length() < 6) {
            throw ApiException.badRequest("Пароль — не короче 6 символов");
        }
        boolean taken = jdbc.sql("SELECT EXISTS (SELECT 1 FROM users WHERE login = ?)").param(login)
                .query(Boolean.class).single();
        if (taken) {
            throw ApiException.conflict("Логин «" + login + "» уже занят. Если это ваш сотрудник из другого ресторана — "
                    + "пригласите его ссылкой");
        }
        long id = jdbc.sql("""
                        INSERT INTO users (login, name, password_hash, pin_hash, last_tenant_id)
                        VALUES (?, ?, ?, ?, ?) RETURNING id""")
                .params(login, name.trim(), password == null ? null : encoder.encode(password),
                        pin == null ? null : encoder.encode(pin), tenantId == 0 ? null : tenantId)
                .query(Long.class).single();
        if (tenantId != 0) {
            addMembership(id, tenantId, role, locationId);
        }
        return id;
    }

    /** Членство в предприятии: одно на человека и предприятие. */
    @Transactional
    public void addMembership(long userId, long tenantId, String role, String locationId) {
        validateRole(role);
        if (locationId != null && !locationId.isBlank() && !Long.valueOf(tenantId).equals(tenants.tenantOfOrNull(locationId))) {
            throw ApiException.badRequest("Точка не принадлежит предприятию");
        }
        int n = jdbc.sql("""
                        INSERT INTO memberships (user_id, tenant_id, role, location_id) VALUES (?, ?, ?, ?)
                        ON CONFLICT (user_id, tenant_id) DO NOTHING""")
                .params(userId, tenantId, role, locationId == null || locationId.isBlank() ? null : locationId)
                .update();
        if (n == 0) {
            throw ApiException.conflict("Этот человек уже работает в предприятии");
        }
    }

    /** Отключить человека в своём предприятии; в других ресторанах он продолжает работать. */
    @Transactional
    public void setActive(long tenantId, long userId, boolean active) {
        updateMembership(tenantId, userId, null, null, false, active);
    }

    /**
     * Роль, точка и активность сотрудника в предприятии — только из админки. Последнего активного админа
     * не понизить и не отключить: иначе предприятием станет некому управлять.
     *
     * @param role       новая роль; {@code null} — не менять
     * @param changeLoc  менять ли точку ({@code locationId == null} — все точки)
     * @param active     новая активность; {@code null} — не менять
     */
    @Transactional
    public void updateMembership(long tenantId, long userId, String role, String locationId, boolean changeLoc,
                                 Boolean active) {
        var cur = jdbc.sql("SELECT role, active FROM memberships WHERE tenant_id = ? AND user_id = ? FOR UPDATE")
                .params(tenantId, userId)
                .query((rs, n) -> new Object[]{rs.getString(1), rs.getBoolean(2)})
                .optional().orElseThrow(() -> ApiException.notFound("Сотрудник"));
        if (role != null) {
            validateRole(role);
        }
        String loc = locationId == null || locationId.isBlank() ? null : locationId;
        if (changeLoc && loc != null && !Long.valueOf(tenantId).equals(tenants.tenantOfOrNull(loc))) {
            throw ApiException.badRequest("Точка не принадлежит предприятию");
        }
        boolean wasActiveAdmin = "ADMIN".equals(cur[0]) && (Boolean) cur[1];
        boolean staysActiveAdmin = "ADMIN".equals(role == null ? cur[0] : role)
                && (active == null ? (Boolean) cur[1] : active);
        if (wasActiveAdmin && !staysActiveAdmin) {
            long admins = jdbc.sql("SELECT COUNT(*) FROM memberships WHERE tenant_id = ? AND role = 'ADMIN' AND active")
                    .param(tenantId).query(Long.class).single();
            if (admins <= 1) {
                throw ApiException.conflict("Это последний админ предприятия — сначала назначьте другого");
            }
        }
        jdbc.sql("""
                        UPDATE memberships SET role = COALESCE(?, role), active = COALESCE(?, active),
                               location_id = CASE WHEN ? THEN ? ELSE location_id END
                        WHERE tenant_id = ? AND user_id = ?""")
                .params(role, active, changeLoc, loc, tenantId, userId).update();
    }

    // ── API-ключи ──────────────────────────────────────────────────────────

    /** Ключ показывается один раз; в базе — только хэш (ТЗ 6.13). Ключ принадлежит предприятию. */
    @Transactional
    public ApiKeyCreated createApiKey(long tenantId, String name, List<String> scopes, String locationId) {
        return createApiKey(tenantId, name, scopes, locationId, "sk_" + Hashing.randomToken(24));
    }

    /** Ключ с заранее известным значением — для интеграции, настроенной через конфиг (демо-сайт ресторана). */
    @Transactional
    public ApiKeyCreated createApiKey(long tenantId, String name, List<String> scopes, String locationId, String key) {
        if (locationId != null && !Long.valueOf(tenantId).equals(tenants.tenantOfOrNull(locationId))) {
            throw ApiException.badRequest("Точка не принадлежит предприятию");
        }
        long id = jdbc.sql("""
                        INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, scopes, location_id)
                        VALUES (?, ?, ?, ?, ?, ?) RETURNING id""")
                .params(tenantId, name, key.substring(0, 10), Hashing.sha256(key), scopes.toArray(String[]::new),
                        locationId)
                .query(Long.class).single();
        return new ApiKeyCreated(id, name, key, scopes);
    }

    /** Ключ из настройки — завести, если такого ещё нет; повторный запуск ничего не дублирует. */
    public void ensureApiKey(long tenantId, String name, List<String> scopes, String key) {
        jdbc.sql("""
                        INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, scopes, location_id)
                        VALUES (?, ?, ?, ?, ?, NULL)
                        ON CONFLICT (key_hash) DO NOTHING""")
                .params(tenantId, name, key.substring(0, 10), Hashing.sha256(key), scopes.toArray(String[]::new))
                .update();
    }

    @Transactional
    public void revokeApiKey(long tenantId, long id) {
        int n = jdbc.sql("UPDATE api_keys SET revoked_at = now() WHERE id = ? AND tenant_id = ?").params(id, tenantId)
                .update();
        if (n == 0) {
            throw ApiException.notFound("Ключ");
        }
    }

    /**
     * Ключ поставщика платформы (ТЗ 16.17): без предприятия — присылает поставки в любое предприятие, в том числе
     * созданное позже. Заводит его только сервер по своей настройке; права — только {@code deliveries:create}.
     * Повторный вызов с тем же ключом ничего не дублирует, а ключ, раньше привязанный к предприятию, делает общим.
     */
    @Transactional
    public void ensurePlatformApiKey(String name, String key) {
        jdbc.sql("""
                        INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, scopes, location_id)
                        VALUES (NULL, ?, ?, ?, ?, NULL)
                        ON CONFLICT (key_hash) DO UPDATE SET tenant_id = NULL, location_id = NULL, name = EXCLUDED.name,
                            scopes = EXCLUDED.scopes""")
                .params(name, key.substring(0, 10), Hashing.sha256(key), new String[]{"deliveries:create"})
                .update();
    }

    /** Ключ без предприятия — tenantId 0: ему открыты точки всех предприятий ({@link StockPrincipal#canAccess}). */
    public StockPrincipal byApiKey(String key) {
        return jdbc.sql("""
                        SELECT k.id, k.name, k.scopes, k.location_id, COALESCE(k.tenant_id, 0), COALESCE(t.name, 'Платформа')
                        FROM api_keys k LEFT JOIN tenants t ON t.id = k.tenant_id WHERE k.key_hash = ? AND k.revoked_at IS NULL""")
                .param(Hashing.sha256(key))
                .query((rs, n) -> new StockPrincipal(Actor.Kind.API, rs.getLong(1), "api:" + rs.getLong(1),
                        rs.getString(2), "API", rs.getString(4),
                        Set.of((String[]) rs.getArray(3).getArray()), rs.getLong(5), rs.getString(6)))
                .optional().orElse(null);
    }

    // ── Служебное ──────────────────────────────────────────────────────────

    private static void validateRole(String role) {
        if (!StockPrincipal.ROLES.contains(role)) {
            throw ApiException.badRequest("Роль — одна из " + StockPrincipal.ROLES);
        }
    }

    /** Блокировка — ключ Redis {@code auth:lock:…} со сроком жизни 5 минут; в значении — до какого момента. */
    private void checkLock(String key) {
        Instant until = shared.get("auth:lock:" + key, Instant.class).orElse(null);
        if (until != null && Instant.now().isBefore(until)) {
            long min = Math.max(1, (Duration.between(Instant.now(), until).toSeconds() + 59) / 60);   // 4:59 → «5 мин»
            throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, "Слишком много попыток. Подождите " + min + " мин.");
        }
    }

    /** Неверная попытка: счётчик {@code auth:fail:…} +1 (INCR); пятая — блокировка, счёт заново. */
    private void fail(String key) {
        if (shared.hit("auth:fail:" + key, ATTEMPTS_WINDOW).count() >= MAX_ATTEMPTS) {
            shared.put("auth:lock:" + key, Instant.now().plus(LOCKOUT), LOCKOUT);
            shared.delete("auth:fail:" + key);
        }
    }
}
