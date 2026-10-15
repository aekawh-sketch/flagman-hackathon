package ru.sphere.stock.tenant;

import io.swagger.v3.oas.annotations.media.Schema;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.sphere.stock.catalog.CatalogService;
import ru.sphere.stock.config.StockProperties;
import ru.sphere.stock.infra.AfterCommit;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.infra.AppClock;
import ru.sphere.stock.infra.Json;
import ru.sphere.stock.ledger.Actor;
import ru.sphere.stock.menu.ForecastService;
import ru.sphere.stock.redis.LocationCache;
import ru.sphere.stock.web.UploadService;

/**
 * Платформа (ТЗ 16.9). Пользователи равноправны и регистрируются сами; ролевая модель работает внутри предприятия.
 * Без предприятия человек принимает приглашение или создаёт своё: сразу или через заявку администратору платформы
 * (режим переключается). Администратор платформы — отдельная роль над всеми предприятиями; те же заявки можно вести
 * из внешней админки или CRM по ключу платформы, а о новой заявке CRM узнаёт по веб-хуку.
 */
@Service
public class PlatformService {

    private static final Logger log = LoggerFactory.getLogger(PlatformService.class);

    /** Режим «сразу» убран (ТЗ 16.14): предприятия создаёт только администратор платформы */
    public static final String INSTANT = "INSTANT";
    public static final String APPROVAL = "APPROVAL";

    @Schema(name = "PlatformSettings", description = "Режимы платформы")
    public record Settings(
            @Schema(description = "Всегда APPROVAL: предприятия создаёт только администратор платформы — сам или одобрив заявку") String tenantCreation,
            @Schema(description = "Открытая регистрация без приглашения") boolean registrationOpen) {
    }

    @Schema(name = "TenantRequest", description = "Заявка на создание предприятия")
    public record RequestDto(long id, long userId, String userName, String userLogin, String name, String locationName,
                             String comment, String status, Instant createdAt, String decidedBy, String decidedVia,
                             Instant decidedAt, String decisionComment, Long tenantId) {
    }

    @Schema(name = "PlatformTenant", description = "Предприятие на платформе")
    public record TenantDto(long id, String name, Instant createdAt,
                            @Schema(description = "Владелец — админ предприятия: создал сам или пришёл по ссылке владельца") String owner,
                            @Schema(description = "Владельца ещё нет, но ссылка с ролью «Админ» выпущена и ждёт") boolean ownerInvited,
                            long members, long locations,
                            @Schema(description = "Демо-предприятие — пилот ИСТОК: удалить нельзя") boolean demo) {
    }

    @Schema(name = "TenantDeletion", description = "Удалённое предприятие: след на уровне платформы")
    public record DeletionDto(long id, long tenantId, String name, String owner, String reason, Map<String, Object> stats,
                              String deletedBy, String deletedVia, Instant deletedAt) {
    }

    /**
     * Данные предприятия — от зависимых к главным, чтобы внешние ключи не мешали. Новая таблица с tenant_id
     * должна попасть сюда, иначе удаление упадёт на ссылке на точку или предприятие — и откатится целиком.
     */
    private static final List<String> TENANT_TABLES = List.of("supplier_return_lines", "supplier_returns",
            "inventory_lines", "inventory_counts", "writeoff_requests", "anomalies", "alerts", "stoplist_events",
            "stoplist_state", "order_refusals", "movements", "kitchen_tickets", "order_lines", "orders", "batches", "delivery_lines",
            "deliveries", "ledger_heads", "audit_log", "invitations", "memberships", "api_keys", "settings", "set_items",
            "recipe_lines", "recipe_versions", "dish_variants", "dishes", "products", "kitchen_printers", "locations");
    /** Таблицы, которые база защищает от удаления строк (журнал, партии, аудит), и их триггеры. */
    private static final Map<String, String> DELETE_GUARDS = Map.of(
            "movements", "movements_append_only", "batches", "batches_no_delete", "audit_log", "audit_append_only");

    /** Итог «создать предприятие»: CREATED — создано сразу, PENDING — ушла заявка администратору платформы. */
    public record CreateResult(String status, TenantService.Created created, RequestDto request) {
    }

    private final JdbcClient jdbc;
    private final AppClock clock;
    private final TenantService tenants;
    private final StockProperties props;
    private final Json json;
    private final TenantDirectory directory;
    private final CatalogService catalog;
    private final LocationCache cache;
    private final ForecastService forecast;
    private final UploadService uploads;
    private final InviteService invites;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

    public PlatformService(JdbcClient jdbc, AppClock clock, TenantService tenants, StockProperties props, Json json,
                           TenantDirectory directory, CatalogService catalog, LocationCache cache,
                           ForecastService forecast, UploadService uploads, InviteService invites) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.tenants = tenants;
        this.props = props;
        this.json = json;
        this.directory = directory;
        this.catalog = catalog;
        this.cache = cache;
        this.forecast = forecast;
        this.uploads = uploads;
        this.invites = invites;
    }

    /** Администраторы платформы из настройки сервера (stock.platform-admins) получают роль при старте. */
    @EventListener(ApplicationReadyEvent.class)
    public void grantConfiguredAdmins() {
        if (props.platformAdmins() == null) {
            return;
        }
        for (String login : props.platformAdmins()) {
            if (login != null && !login.isBlank()) {
                jdbc.sql("UPDATE users SET platform_admin = TRUE WHERE login = ?").param(login.strip()).update();
            }
        }
    }

    // ── Настройки ──────────────────────────────────────────────────────────

    public Settings settings() {
        Map<String, String> s = new java.util.HashMap<>();
        jdbc.sql("SELECT key, value FROM platform_settings").query(rs -> {
            s.put(rs.getString(1), rs.getString(2));
        });
        return new Settings(s.getOrDefault("tenant_creation", APPROVAL),
                !"false".equals(s.getOrDefault("registration_open", "true")));
    }

    @Transactional
    public Settings update(Settings in) {
        if (INSTANT.equals(in.tenantCreation())) {
            throw ApiException.badRequest("Режима «сразу» нет: предприятия создаёт только администратор платформы");
        }
        if (!APPROVAL.equals(in.tenantCreation())) {
            throw ApiException.badRequest("tenantCreation — APPROVAL");
        }
        put("tenant_creation", in.tenantCreation());
        put("registration_open", Boolean.toString(in.registrationOpen()));
        return settings();
    }

    private void put(String key, String value) {
        jdbc.sql("INSERT INTO platform_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value")
                .params(key, value).update();
    }

    // ── Новое предприятие: создаёт только администратор платформы ──────────

    /**
     * Предприятия создаёт только администратор платформы (ТЗ 16.14): ему — сразу, он становится админом нового.
     * Человек без предприятия подаёт заявку — решает администратор платформы. Сотрудник предприятия (любая роль,
     * в том числе админ и управляющий) ни создать, ни подать заявку не может.
     */
    @Transactional
    public CreateResult createOrRequest(long userId, String userName, boolean platformAdmin, String name,
                                        String locationName, String comment) {
        String n = name == null ? "" : name.strip();
        if (n.isEmpty() || n.length() > 120) {
            throw ApiException.badRequest("Название предприятия — от 1 до 120 символов");
        }
        if (platformAdmin) {
            var created = tenants.create(n, locationName, Actor.user(userId, "ADMIN", userName));
            return new CreateResult("CREATED", created, null);
        }
        boolean member = jdbc.sql("SELECT EXISTS (SELECT 1 FROM memberships WHERE user_id = ? AND active)")
                .param(userId).query(Boolean.class).single();
        if (member) {
            throw ApiException.forbidden("Предприятия создаёт только администратор платформы — обратитесь к нему");
        }
        boolean pending = jdbc.sql("SELECT EXISTS (SELECT 1 FROM tenant_requests WHERE user_id = ? AND status = 'PENDING')")
                .param(userId).query(Boolean.class).single();
        if (pending) {
            throw ApiException.conflict("Ваша заявка уже ждёт решения администратора платформы");
        }
        long id = jdbc.sql("""
                        INSERT INTO tenant_requests (user_id, name, location_name, comment, status, created_at)
                        VALUES (?, ?, ?, ?, 'PENDING', ?) RETURNING id""")
                .params(userId, n, blank(locationName), blank(comment), Timestamp.from(clock.now()))
                .query(Long.class).single();
        RequestDto dto = one(id);
        AfterCommit.run(() -> notifyCrm(dto));
        return new CreateResult("PENDING", null, dto);
    }

    /**
     * Одобрить: предприятие создаётся, заявитель становится его админом.
     *
     * @param decidedBy администратор платформы; {@code null} — решение из внешней системы по ключу платформы
     */
    @Transactional
    public RequestDto approve(long id, Long decidedBy, String comment) {
        Object[] r = lockPending(id);
        long userId = (Long) r[0];
        String userName = jdbc.sql("SELECT name FROM users WHERE id = ?").param(userId).query(String.class).single();
        var created = tenants.create((String) r[1], (String) r[2], Actor.user(userId, "ADMIN", userName));
        decide(id, "APPROVED", decidedBy, comment, created.tenantId());
        // Следующий вход и «кто я» заявителя без предприятия ведут сразу в новое предприятие
        jdbc.sql("UPDATE users SET last_tenant_id = ? WHERE id = ?").params(created.tenantId(), userId).update();
        return one(id);
    }

    @Transactional
    public RequestDto reject(long id, Long decidedBy, String comment) {
        lockPending(id);
        decide(id, "REJECTED", decidedBy, comment, null);
        return one(id);
    }

    /** Заявитель передумал — отзывает свою ждущую заявку. */
    @Transactional
    public RequestDto cancel(long id, long userId) {
        Object[] r = lockPending(id);
        if ((Long) r[0] != userId) {
            throw ApiException.notFound("Заявка");
        }
        jdbc.sql("UPDATE tenant_requests SET status = 'CANCELED', decided_at = ? WHERE id = ?")
                .params(Timestamp.from(clock.now()), id).update();
        return one(id);
    }

    private Object[] lockPending(long id) {
        Object[] r = jdbc.sql("SELECT user_id, name, location_name, status FROM tenant_requests WHERE id = ? FOR UPDATE")
                .param(id)
                .query((rs, n) -> new Object[]{rs.getLong(1), rs.getString(2), rs.getString(3), rs.getString(4)})
                .optional().orElseThrow(() -> ApiException.notFound("Заявка"));
        if (!"PENDING".equals(r[3])) {
            throw ApiException.conflict("Заявка уже решена: " + r[3]);
        }
        return r;
    }

    private void decide(long id, String status, Long decidedBy, String comment, Long tenantId) {
        jdbc.sql("""
                        UPDATE tenant_requests SET status = ?, decided_by = ?, decided_via = ?, decided_at = ?,
                                                   decision_comment = ?, tenant_id = ?
                        WHERE id = ?""")
                .params(status, decidedBy, decidedBy == null ? "API" : "CONSOLE", Timestamp.from(clock.now()),
                        blank(comment), tenantId, id).update();
    }

    // ── Списки ─────────────────────────────────────────────────────────────

    private static final String SELECT = """
            SELECT r.id, r.user_id, u.name, u.login, r.name, r.location_name, r.comment, r.status, r.created_at,
                   d.name, r.decided_via, r.decided_at, r.decision_comment, r.tenant_id
            FROM tenant_requests r JOIN users u ON u.id = r.user_id LEFT JOIN users d ON d.id = r.decided_by
            """;

    public List<RequestDto> requests(String status) {
        return jdbc.sql(SELECT + " WHERE (?::text IS NULL OR r.status = ?) ORDER BY (r.status = 'PENDING') DESC, r.created_at DESC LIMIT 300")
                .params(status, status).query((rs, n) -> map(rs)).list();
    }

    public List<RequestDto> mine(long userId) {
        return jdbc.sql(SELECT + " WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 20")
                .param(userId).query((rs, n) -> map(rs)).list();
    }

    public List<TenantDto> tenants() {
        return jdbc.sql("""
                        SELECT t.id, t.name, t.created_at, o.name,
                               EXISTS (SELECT 1 FROM invitations i WHERE i.tenant_id = t.id AND i.role = 'ADMIN'
                                       AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()),
                               (SELECT COUNT(*) FROM memberships m WHERE m.tenant_id = t.id AND m.active),
                               (SELECT COUNT(*) FROM locations l WHERE l.tenant_id = t.id)
                        FROM tenants t LEFT JOIN users o ON o.id = t.owner_id ORDER BY t.id""")
                .query((rs, n) -> new TenantDto(rs.getLong(1), rs.getString(2),
                        rs.getTimestamp(3) == null ? null : rs.getTimestamp(3).toInstant(), rs.getString(4),
                        rs.getBoolean(5), rs.getLong(6), rs.getLong(7), rs.getLong(1) == TenantDirectory.DEMO))
                .list();
    }

    // ── Создать предприятие и пригласить людей — из админки платформы или CRM ──

    /**
     * Платформа создаёт предприятие — например, для клиента: создатель в нём не работает ({@code join = false}),
     * владельца приглашают ссылкой с ролью «Админ». {@code join = true} — администратор платформы и сам в нём админ,
     * но не владелец: владельцем станет тот, кто примет ссылку.
     *
     * @param by администратор платформы; {@code null} — внешняя система по ключу платформы
     */
    @Transactional
    public TenantService.Created createTenant(String name, String locationName, Long by, boolean join) {
        return createTenantWithLocations(name, java.util.Collections.singletonList(locationName), by, join);
    }

    /**
     * Предприятие сразу с несколькими точками (ТЗ 16.17): первая — основная, остальные создаются в той же транзакции.
     * Ошибка в любой точке (пустое или повторное название) отменяет создание целиком.
     *
     * @param locationNames точки-склады; пусто — одна точка с названием предприятия
     */
    @Transactional
    public TenantService.Created createTenantWithLocations(String name, List<String> locationNames, Long by, boolean join) {
        String n = name == null ? "" : name.strip();
        if (n.isEmpty() || n.length() > 120) {
            throw ApiException.badRequest("Название предприятия — от 1 до 120 символов");
        }
        List<String> names = locationNames == null ? List.of() : locationNames.stream()
                .map(s -> s == null ? "" : s.strip()).filter(s -> !s.isEmpty()).toList();
        var created = tenants.create(n, names.isEmpty() ? null : names.getFirst(), actor(by), join && by != null);
        if (names.size() > 1) {
            tenants.createLocations(created.tenantId(), names.subList(1, names.size()).stream()
                    .map(s -> new TenantService.NewLocation(s, null, null)).toList(), actor(by));
        }
        return created;
    }

    public List<TenantService.LocationDto> locations(long tenantId) {
        requireTenant(tenantId);
        return tenants.locations(tenantId);
    }

    public List<InviteService.InviteDto> invites(long tenantId) {
        requireTenant(tenantId);
        return invites.list(tenantId);
    }

    /** Ссылка-приглашение в любое предприятие платформы: роль и точка — как у приглашения от админа предприятия. */
    @Transactional
    public InviteService.Created invite(long tenantId, String role, String locationId, String note, Long by) {
        requireTenant(tenantId);
        return invites.create(tenantId, role, locationId, note, actor(by));
    }

    @Transactional
    public void revokeInvite(long tenantId, long inviteId, Long by) {
        requireTenant(tenantId);
        invites.revoke(tenantId, inviteId, actor(by));
    }

    private void requireTenant(long tenantId) {
        boolean exists = jdbc.sql("SELECT EXISTS (SELECT 1 FROM tenants WHERE id = ?)").param(tenantId)
                .query(Boolean.class).single();
        if (!exists) {
            throw ApiException.notFound("Предприятие");
        }
    }

    /** От чьего имени платформа действует в предприятии — для аудита и автора приглашения. */
    private Actor actor(Long by) {
        if (by == null) {
            return new Actor(Actor.Kind.SYSTEM, null, null, "PLATFORM", "Платформа (API)");
        }
        String name = jdbc.sql("SELECT name FROM users WHERE id = ?").param(by).query(String.class).single();
        return Actor.user(by, "PLATFORM", name);
    }

    // ── Удалить предприятие ────────────────────────────────────────────────

    /**
     * Удалить предприятие целиком: точки, каталог, сотрудников в нём, ключи, журнал, документы, фото. Учётки людей
     * остаются — они равноправные пользователи платформы, у кого не останется предприятий, увидят экран выбора.
     * Подтверждение — точное название предприятия. Демо-предприятие (пилот ИСТОК) удалить нельзя: к нему подключены
     * сайт ресторана и демо. Журнал защищён от удаления строк — защита снимается только внутри этой транзакции
     * и при любой ошибке откатывается вместе с удалением.
     *
     * @param deletedBy администратор платформы; {@code null} — внешняя система по ключу платформы
     */
    @Transactional
    public DeletionDto deleteTenant(long tenantId, Long deletedBy, String confirm, String reason) {
        if (tenantId == TenantDirectory.DEMO) {
            throw ApiException.forbidden("Демо-предприятие (пилот ИСТОК) удалить нельзя — к нему подключены сайт ресторана и демо");
        }
        Object[] t = jdbc.sql("SELECT t.name, o.name FROM tenants t LEFT JOIN users o ON o.id = t.owner_id WHERE t.id = ? FOR UPDATE OF t")
                .param(tenantId).query((rs, n) -> new Object[]{rs.getString(1), rs.getString(2)})
                .optional().orElseThrow(() -> ApiException.notFound("Предприятие"));
        String name = (String) t[0];
        if (confirm == null || !name.equals(confirm.strip())) {
            throw ApiException.badRequest("Для подтверждения введите название предприятия точно: «" + name + "»");
        }
        List<String> locations = directory.locations(tenantId);
        Map<String, Object> stats = new java.util.LinkedHashMap<>();
        for (String table : List.of("locations", "memberships", "products", "dishes", "deliveries", "orders", "movements")) {
            stats.put(table, jdbc.sql("SELECT COUNT(*) FROM " + table + " WHERE tenant_id = ?").param(tenantId)
                    .query(Long.class).single());
        }
        List<String> photos = jdbc.sql("""
                        SELECT unnest(photos) FROM writeoff_requests WHERE tenant_id = ?
                        UNION SELECT unnest(photos) FROM supplier_returns WHERE tenant_id = ?
                        UNION SELECT unnest(invoice_photos) FROM deliveries WHERE tenant_id = ?""")
                .params(tenantId, tenantId, tenantId).query(String.class).list();

        DELETE_GUARDS.forEach((table, trigger) -> jdbc.sql("ALTER TABLE " + table + " DISABLE TRIGGER " + trigger).update());
        for (String table : TENANT_TABLES) {
            jdbc.sql("DELETE FROM " + table + " WHERE tenant_id = ?").param(tenantId).update();
        }
        DELETE_GUARDS.forEach((table, trigger) -> jdbc.sql("ALTER TABLE " + table + " ENABLE TRIGGER " + trigger).update());
        // Заявка, по которой его создали, остаётся в истории — без ссылки на предприятие
        jdbc.sql("UPDATE tenant_requests SET tenant_id = NULL WHERE tenant_id = ?").param(tenantId).update();
        jdbc.sql("UPDATE users SET last_tenant_id = NULL WHERE last_tenant_id = ?").param(tenantId).update();
        jdbc.sql("DELETE FROM tenants WHERE id = ?").param(tenantId).update();

        long id = jdbc.sql("""
                        INSERT INTO tenant_deletions (tenant_id, name, owner, reason, stats, deleted_by, deleted_via, deleted_at)
                        VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, ?) RETURNING id""")
                .params(tenantId, name, t[1], blank(reason), json.write(stats), deletedBy,
                        deletedBy == null ? "API" : "CONSOLE", Timestamp.from(clock.now()))
                .query(Long.class).single();
        AfterCommit.run(() -> {
            // ID точек освободились: новая точка с тем же ID не должна получить прогнозы и предложения удалённой
            directory.invalidate();
            catalog.invalidate(tenantId);
            locations.forEach(cache::changed);         // меню, предложения и прогноз этих точек в Redis
            forecast.invalidateHours();
            for (String photo : photos) {
                boolean used = jdbc.sql("""
                                SELECT EXISTS (SELECT 1 FROM writeoff_requests WHERE ? = ANY (photos))
                                    OR EXISTS (SELECT 1 FROM supplier_returns WHERE ? = ANY (photos))
                                    OR EXISTS (SELECT 1 FROM deliveries WHERE ? = ANY (invoice_photos))""")
                        .params(photo, photo, photo).query(Boolean.class).single();
                if (!used) {
                    uploads.delete(photo);
                }
            }
            log.info("Предприятие {} «{}» удалено ({}): {}", tenantId, name, deletedBy == null ? "API" : "админка платформы", stats);
        });
        return deletion(id);
    }

    public List<DeletionDto> deletions() {
        return jdbc.sql(DELETIONS + " ORDER BY d.deleted_at DESC LIMIT 100").query((rs, n) -> mapDeletion(rs)).list();
    }

    private DeletionDto deletion(long id) {
        return jdbc.sql(DELETIONS + " WHERE d.id = ?").param(id).query((rs, n) -> mapDeletion(rs)).single();
    }

    private static final String DELETIONS = """
            SELECT d.id, d.tenant_id, d.name, d.owner, d.reason, d.stats::text, u.name, d.deleted_via, d.deleted_at
            FROM tenant_deletions d LEFT JOIN users u ON u.id = d.deleted_by""";

    @SuppressWarnings("unchecked")
    private DeletionDto mapDeletion(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new DeletionDto(rs.getLong(1), rs.getLong(2), rs.getString(3), rs.getString(4), rs.getString(5),
                json.read(rs.getString(6), Map.class), rs.getString(7), rs.getString(8), rs.getTimestamp(9).toInstant());
    }

    private RequestDto one(long id) {
        return jdbc.sql(SELECT + " WHERE r.id = ?").param(id).query((rs, n) -> map(rs)).single();
    }

    private static RequestDto map(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new RequestDto(rs.getLong(1), rs.getLong(2), rs.getString(3), rs.getString(4), rs.getString(5),
                rs.getString(6), rs.getString(7), rs.getString(8), rs.getTimestamp(9).toInstant(), rs.getString(10),
                rs.getString(11), rs.getTimestamp(12) == null ? null : rs.getTimestamp(12).toInstant(), rs.getString(13),
                (Long) rs.getObject(14));
    }

    /** Новая заявка — во внешнюю админку или CRM (если адрес задан): решение потом придёт по API платформы. */
    private void notifyCrm(RequestDto r) {
        String url = props.platformWebhookUrl();
        if (url == null || url.isBlank()) {
            return;
        }
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(10))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(json.write(Map.of("event", "tenant_request.created", "request", r))))
                    .build();
            http.sendAsync(req, HttpResponse.BodyHandlers.discarding())
                    .whenComplete((res, e) -> {
                        if (e != null || res.statusCode() >= 300) {
                            log.warn("Веб-хук заявки {} не доставлен: {}", r.id(), e != null ? e.getMessage() : res.statusCode());
                        }
                    });
        } catch (RuntimeException e) {
            log.warn("Веб-хук заявки {} не отправлен: {}", r.id(), e.getMessage());
        }
    }

    private static String blank(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }
}
