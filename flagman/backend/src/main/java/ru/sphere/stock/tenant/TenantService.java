package ru.sphere.stock.tenant;

import java.time.LocalTime;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.sphere.stock.admin.AuditService;
import ru.sphere.stock.admin.SettingsService;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.infra.Hashing;
import ru.sphere.stock.ledger.Actor;
import ru.sphere.stock.security.UserService;

/**
 * Предприятия и их точки-склады (ТЗ 16.4, 16.9). Кто создаёт предприятие, тот становится в нём админом; сразу
 * появляется первая точка — без неё некуда принимать поставку. Можно ли создать сразу или нужна заявка
 * администратору платформы — решает {@link PlatformService}.
 */
@Service
public class TenantService {

    public record LocationDto(String id, String name, String openTime, String closeTime, String publicKey) {
    }

    public record Created(long tenantId, String name, String locationId) {
    }

    private final JdbcClient jdbc;
    private final TenantDirectory directory;
    private final UserService users;
    private final SettingsService settings;
    private final AuditService audit;

    public TenantService(JdbcClient jdbc, TenantDirectory directory, UserService users, SettingsService settings,
                         AuditService audit) {
        this.jdbc = jdbc;
        this.directory = directory;
        this.users = users;
        this.settings = settings;
        this.audit = audit;
    }

    /** Новое предприятие: создатель — его админ и владелец. Право создавать проверяет {@link PlatformService}. */
    @Transactional
    public Created create(String name, String locationName, Actor owner) {
        Created c = create(name, locationName, owner, true);
        jdbc.sql("UPDATE tenants SET owner_id = ? WHERE id = ?").params(owner.userId(), c.tenantId()).update();
        return c;
    }

    /**
     * Предприятие без владельца — его создаёт платформа для клиента. Владельцем станет первый, кто примет
     * приглашение с ролью «Админ» ({@link InviteService}); администратор платформы им не становится,
     * даже если сам работает в предприятии ({@code creatorJoins}).
     */
    @Transactional
    public Created create(String name, String locationName, Actor creator, boolean creatorJoins) {
        String n = clean(name, "Название предприятия");
        long id = jdbc.sql("INSERT INTO tenants (name, created_by) VALUES (?, ?) RETURNING id")
                .params(n, creator.userId()).query(Long.class).single();
        settings.set(id, SettingsService.RESTAURANT_NAME, n);
        // Генератор демо-событий работает только в демо-предприятии; новое начинается с чистого склада.
        settings.set(id, SettingsService.GENERATOR_ENABLED, "false");
        String loc = createLocation(id, locationName == null || locationName.isBlank() ? n : locationName, null, null,
                creator);
        if (creatorJoins) {
            users.addMembership(creator.userId(), id, "ADMIN", null);
        }
        audit.record(id, creator, "tenant.create", Map.of("name", n, "location", loc));
        return new Created(id, n, loc);
    }

    /** Новая точка-склад предприятия. ID — понятный латинский slug из названия: он виден в адресе. */
    @Transactional
    public String createLocation(long tenantId, String name, LocalTime open, LocalTime close, Actor actor) {
        String n = clean(name, "Название точки");
        String id = uniqueSlug(n);
        jdbc.sql("""
                        INSERT INTO locations (tenant_id, id, name, open_time, close_time, public_key)
                        VALUES (?, ?, ?, ?, ?, ?)""")
                .params(tenantId, id, n, open == null ? LocalTime.of(10, 0) : open,
                        close == null ? LocalTime.of(23, 0) : close, "pk_" + Hashing.randomToken(12))
                .update();
        directory.invalidate();
        audit.record(tenantId, actor, "location.create", Map.of("id", id, "name", n));
        return id;
    }

    /** Точка для пакетного создания: название и часы работы (без часов — 10:00–23:00). */
    public record NewLocation(String name, LocalTime open, LocalTime close) {
    }

    /**
     * Несколько точек одним действием (ТЗ 16.17) — все или ни одной: названия не пустые и не повторяются ни между
     * собой, ни с уже существующими точками предприятия; за раз — не больше 20.
     */
    @Transactional
    public List<String> createLocations(long tenantId, List<NewLocation> list, Actor actor) {
        if (list == null || list.isEmpty()) {
            throw ApiException.badRequest("Добавьте хотя бы одну точку");
        }
        if (list.size() > 20) {
            throw ApiException.badRequest("За раз — не больше 20 точек");
        }
        Set<String> taken = new HashSet<>(jdbc.sql("SELECT lower(name) FROM locations WHERE tenant_id = ?")
                .param(tenantId).query(String.class).list());
        for (int i = 0; i < list.size(); i++) {
            String n = list.get(i).name() == null ? "" : list.get(i).name().strip();
            if (n.isEmpty()) {
                throw ApiException.badRequest("Точка " + (i + 1) + ": укажите название");
            }
            if (!taken.add(n.toLowerCase())) {
                throw ApiException.badRequest("Точка «" + n + "» уже есть — названия точек не повторяются");
            }
        }
        return list.stream().map(l -> createLocation(tenantId, l.name(), l.open(), l.close(), actor)).toList();
    }

    public List<LocationDto> locations(long tenantId) {
        return jdbc.sql("SELECT id, name, open_time, close_time, public_key FROM locations WHERE tenant_id = ? ORDER BY name")
                .param(tenantId)
                .query((rs, i) -> new LocationDto(rs.getString(1), rs.getString(2),
                        rs.getTime(3).toLocalTime().toString(), rs.getTime(4).toLocalTime().toString(), rs.getString(5)))
                .list();
    }

    private String uniqueSlug(String name) {
        String base = slug(name);
        String id = base;
        for (int i = 2; directory.tenantOfOrNull(id) != null || reserved(id); i++) {
            id = base + "-" + i;
        }
        return id;
    }

    /** Эти слова заняты адресами самого приложения (см. SpaController). */
    private static boolean reserved(String id) {
        return List.of("api", "public", "swagger-ui", "v3", "actuator", "assets", "docs", "login", "invite", "platform")
                .contains(id);
    }

    static String slug(String name) {
        StringBuilder sb = new StringBuilder();
        for (char c : name.toLowerCase().toCharArray()) {
            String t = TRANSLIT.get(c);
            if (t != null) {
                sb.append(t);
            } else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
                sb.append(c);
            } else if (!sb.isEmpty() && sb.charAt(sb.length() - 1) != '-') {
                sb.append('-');
            }
        }
        String s = sb.toString().replaceAll("-+$", "");
        if (s.length() > 24) {
            s = s.substring(0, 24).replaceAll("-+$", "");
        }
        return s.isEmpty() ? "tochka" : s;
    }

    private static String clean(String s, String what) {
        if (s == null || s.isBlank()) {
            throw ApiException.badRequest(what + " — обязательно");
        }
        String t = s.trim();
        if (t.length() > 80) {
            throw ApiException.badRequest(what + " — не длиннее 80 символов");
        }
        return t;
    }

    private static final Map<Character, String> TRANSLIT = Map.ofEntries(
            Map.entry('а', "a"), Map.entry('б', "b"), Map.entry('в', "v"), Map.entry('г', "g"), Map.entry('д', "d"),
            Map.entry('е', "e"), Map.entry('ё', "e"), Map.entry('ж', "zh"), Map.entry('з', "z"), Map.entry('и', "i"),
            Map.entry('й', "y"), Map.entry('к', "k"), Map.entry('л', "l"), Map.entry('м', "m"), Map.entry('н', "n"),
            Map.entry('о', "o"), Map.entry('п', "p"), Map.entry('р', "r"), Map.entry('с', "s"), Map.entry('т', "t"),
            Map.entry('у', "u"), Map.entry('ф', "f"), Map.entry('х', "h"), Map.entry('ц', "ts"), Map.entry('ч', "ch"),
            Map.entry('ш', "sh"), Map.entry('щ', "sch"), Map.entry('ъ', ""), Map.entry('ы', "y"), Map.entry('ь', ""),
            Map.entry('э', "e"), Map.entry('ю', "yu"), Map.entry('я', "ya"));
}
