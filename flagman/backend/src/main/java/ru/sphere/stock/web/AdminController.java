package ru.sphere.stock.web;

import io.swagger.v3.oas.annotations.media.Schema;
import java.time.Duration;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import io.swagger.v3.oas.annotations.Operation;
import ru.sphere.stock.config.OpenApiConfig;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import ru.sphere.stock.admin.AuditService;
import ru.sphere.stock.admin.SettingsService;
import ru.sphere.stock.catalog.CatalogImportService;
import ru.sphere.stock.catalog.CatalogService;
import ru.sphere.stock.demo.DemoService;
import ru.sphere.stock.domain.ProductInfo;
import ru.sphere.stock.domain.RecipeLine;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.infra.AppClock;
import ru.sphere.stock.security.Access;
import ru.sphere.stock.security.StockPrincipal;
import ru.sphere.stock.security.UserService;
import ru.sphere.stock.tenant.InviteService;
import ru.sphere.stock.tenant.TenantDirectory;
import ru.sphere.stock.tenant.TenantService;

/** Админка (ТЗ 6.2: продукты, техкарты, пользователи, ключи, настройки) и демо-панель (5.14). */
@RestController
@RequestMapping("/api")
public class AdminController {

    public record UserIn(String login, String name, String role, String locationId, String password, String pin) {
    }

    /** Что поменять у сотрудника; не указанное — не меняется. */
    public record MemberIn(
            @Schema(description = "Включён ли сотрудник в этом предприятии") Boolean active,
            @Schema(description = "Роль: COOK, CASHIER, STOREKEEPER, MANAGER, ADMIN", example = "MANAGER") String role,
            @Schema(description = "Точка; пустая строка — все точки предприятия") String locationId) {
    }

    public record KeyIn(
            @Schema(description = "Кто будет ходить с ключом", example = "Поставщик «Ромашка»") String name,
            @Schema(description = "Права ключа: только то, что нужно этой системе", example = "[\"deliveries:create\"]") List<String> scopes,
            @Schema(description = "Точка; не указана — все точки предприятия") String locationId) {
    }

    public record ValueIn(String value) {
    }

    public record RecipeIn(List<CatalogImportService.LineIn> lines, Long yieldQty, String comment) {
    }

    @Schema(name = "RecipeVersion", description = "Версия техкарты с составом")
    public record VersionDto(long id, int version, String status, java.time.Instant createdAt, String author,
                             String comment, List<LineDto> lines) {
    }

    public record RestoreIn(String comment) {
    }

    @Schema(name = "RecipeLine")
    public record LineDto(String productId, String productName, String unit, long net, long gross, Integer lossBp) {
    }

    public record VariantDto(String id, String name, String label, long priceKop, boolean isSet, long recipeVersionId,
                             List<LineDto> lines, List<Map<String, Object>> setItems) {
    }

    public record DishDto(String id, String name, String category, String description, List<VariantDto> variants) {
    }

    public record ProductDto(String id, String name, String unit, String kind, String category, Long packSize,
                             Long afterOpenHours, int lossBp, Long alertBeforeHours, Long shelfLifeHours,
                             Long leadTimeHours, Double unitCostKop, boolean needsReview, Long semiYield,
                             List<LineDto> semiLines) {
    }

    public record CatalogDto(List<ProductDto> products, List<DishDto> dishes) {
    }

    public record ClockIn(Integer speed, Boolean paused, Integer advanceHours, Boolean real) {
    }

    public record ScenarioIn(String location, String type) {
    }

    public record GeneratorIn(boolean enabled) {
    }

    public record LocationIn(String name, String openTime, String closeTime) {
    }

    public record InviteIn(String role, String locationId, String note,
                           @Schema(description = "Предприятие, где вы тоже админ; без него — текущее") Long tenantId) {
    }

    public record CleanIn(
            @Schema(description = "Подтверждение — слово УДАЛИТЬ", example = "УДАЛИТЬ") String confirm,
            @Schema(description = "Сразу принять стартовую поставку и приготовить заготовки, чтобы меню было рабочим") boolean startStock) {
    }

    private final UserService users;
    private final SettingsService settings;
    private final AuditService audit;
    private final CatalogService catalog;
    private final CatalogImportService importer;
    private final DemoService demo;
    private final AppClock clock;
    private final JdbcClient jdbc;
    private final TenantService tenants;
    private final InviteService invites;

    public AdminController(UserService users, SettingsService settings, AuditService audit, CatalogService catalog,
                           CatalogImportService importer, DemoService demo, AppClock clock, JdbcClient jdbc,
                           TenantService tenants, InviteService invites) {
        this.tenants = tenants;
        this.invites = invites;
        this.users = users;
        this.settings = settings;
        this.audit = audit;
        this.catalog = catalog;
        this.importer = importer;
        this.demo = demo;
        this.clock = clock;
        this.jdbc = jdbc;
    }

    /** Админ текущего предприятия: админка видит и меняет только своё предприятие (ТЗ 16.4). */
    private static StockPrincipal admin() {
        return Access.requireTenantRole("ADMIN");
    }

    // ── Пользователи и ключи ───────────────────────────────────────────────

    @Operation(summary = "Сотрудники", tags = OpenApiConfig.T_ADMIN)
    @GetMapping("/admin/users")
    public List<UserService.UserDto> users() {
        return users.list(admin().tenantId());
    }

    @Operation(summary = "Создать сотрудника", description = "Пароль — для входа, PIN (4–6 цифр) — подпись под списанием в панели ресторана. Хранятся только хэши.", tags = OpenApiConfig.T_ADMIN)
    @PostMapping("/admin/users")
    public Map<String, Object> createUser(@RequestBody UserIn in) {
        StockPrincipal p = admin();
        long id = users.create(p.tenantId(), in.login(), in.name(), in.role(), in.locationId(), in.password(), in.pin());
        audit.record(p.tenantId(), p.actor(), "user.create", Map.of("id", id, "login", in.login(), "role", in.role()));
        return Map.of("id", id);
    }

    @Operation(summary = "Роль, точка или активность сотрудника", description = "Только админ. Себя не понизить и не отключить; последнего админа предприятия — тоже.", tags = OpenApiConfig.T_ADMIN)
    @PatchMapping("/admin/users/{id}")
    public Map<String, Object> updateMember(@PathVariable long id, @RequestBody MemberIn in) {
        StockPrincipal p = admin();
        if (id == p.id() && (Boolean.FALSE.equals(in.active()) || (in.role() != null && !"ADMIN".equals(in.role())))) {
            throw ApiException.badRequest("Себя отключить или понизить нельзя — это сделает другой админ");
        }
        users.updateMembership(p.tenantId(), id, in.role(), in.locationId(), in.locationId() != null, in.active());
        Map<String, Object> details = new java.util.LinkedHashMap<>();
        details.put("id", id);
        details.put("role", String.valueOf(in.role()));
        details.put("location", String.valueOf(in.locationId()));
        details.put("active", String.valueOf(in.active()));
        audit.record(p.tenantId(), p.actor(), "user.update", details);
        return Map.of("ok", true);
    }

    @Operation(summary = "API-ключи", tags = OpenApiConfig.T_ADMIN)
    @GetMapping("/admin/api-keys")
    public List<Map<String, Object>> keys() {
        long tenant = admin().tenantId();
        return jdbc.sql("""
                        SELECT id, name, key_prefix, scopes, location_id, revoked_at, created_at FROM api_keys
                        WHERE tenant_id = ? ORDER BY id""")
                .param(tenant)
                .query((rs, n) -> Map.<String, Object>of("id", rs.getLong(1), "name", rs.getString(2),
                        "prefix", rs.getString(3), "scopes", List.of((String[]) rs.getArray(4).getArray()),
                        "locationId", String.valueOf(rs.getString(5)), "revoked", rs.getTimestamp(6) != null))
                .list();
    }

    /** Ключ показывается один раз — в базе только хэш. */
    @Operation(summary = "Выпустить API-ключ", description = "Ключ показывается один раз — в базе только хэш.", tags = OpenApiConfig.T_ADMIN)
    @PostMapping("/admin/api-keys")
    public UserService.ApiKeyCreated createKey(@RequestBody KeyIn in) {
        StockPrincipal p = admin();
        var k = users.createApiKey(p.tenantId(), in.name(), in.scopes(), in.locationId());
        audit.record(p.tenantId(), p.actor(), "apikey.create", Map.of("id", k.id(), "name", in.name(), "scopes", in.scopes()));
        return k;
    }

    @Operation(summary = "Отозвать API-ключ", tags = OpenApiConfig.T_ADMIN)
    @DeleteMapping("/admin/api-keys/{id}")
    public Map<String, Object> revokeKey(@PathVariable long id) {
        StockPrincipal p = admin();
        users.revokeApiKey(p.tenantId(), id);
        audit.record(p.tenantId(), p.actor(), "apikey.revoke", Map.of("id", id));
        return Map.of("ok", true);
    }

    // ── Настройки и аудит ──────────────────────────────────────────────────

    @Operation(summary = "Настройки и пороги", tags = OpenApiConfig.T_ADMIN)
    @GetMapping("/admin/settings")
    public Map<String, String> settings() {
        return settings.all(admin().tenantId());
    }

    @Operation(summary = "Изменить настройку", tags = OpenApiConfig.T_ADMIN)
    @PutMapping("/admin/settings/{key}")
    public Map<String, Object> set(@PathVariable String key, @RequestBody ValueIn in) {
        StockPrincipal p = admin();
        settings.set(p.tenantId(), key, in.value());
        audit.record(p.tenantId(), p.actor(), "settings.set", Map.of("key", key, "value", in.value()));
        return Map.of("ok", true);
    }

    @Operation(summary = "Аудит действий админа", description = "Только добавление, своя хэш-цепочка.", tags = OpenApiConfig.T_ADMIN)
    @GetMapping("/admin/audit")
    public List<AuditService.Entry> audit() {
        return audit.list(admin().tenantId(), 200);
    }

    // ── Каталог и техкарты ─────────────────────────────────────────────────

    @Operation(summary = "Каталог: продукты, блюда, варианты, техкарты", tags = OpenApiConfig.T_CATALOG)
    @GetMapping("/catalog")
    public CatalogDto catalog() {
        CatalogService.Snapshot cat = catalog.get(requireTenant());
        List<ProductDto> products = new ArrayList<>();
        for (ProductInfo p : cat.products()) {
            var ex = cat.extra(p.id());
            var semi = cat.semi(p.id());
            products.add(new ProductDto(p.id(), p.name(), p.unit().name(), p.kind().name(),
                    ex == null ? null : ex.category(), p.packSize(), hours(p.afterOpen()), p.lossBp(),
                    hours(p.alertBefore()), hours(p.shelfLife()), hours(p.leadTime()),
                    ex == null ? null : ex.lastUnitCostKop(), ex != null && ex.needsReview(),
                    semi == null ? null : semi.yield(), semi == null ? null : lines(semi.lines(), cat)));
        }
        List<DishDto> dishes = new ArrayList<>();
        for (var d : cat.dishes().values()) {
            List<VariantDto> vs = new ArrayList<>();
            for (var vi : cat.variantInfos()) {
                if (!vi.dishId().equals(d.id())) {
                    continue;
                }
                var v = cat.variant(vi.id());
                vs.add(new VariantDto(vi.id(), vi.name(), vi.label(), vi.priceKop(), vi.isSet(), v.recipeVersionId(),
                        lines(v.lines(), cat), v.setItems().stream()
                        .map(s -> Map.<String, Object>of("variantId", s.variantId(), "name",
                                cat.variantName(s.variantId()), "qty", s.qty())).toList()));
            }
            dishes.add(new DishDto(d.id(), d.name(), d.category(), d.description(), vs));
        }
        return new CatalogDto(products, dishes);
    }

    /** Импорт каталога (п. 48): админ или внешняя система с правом {@code catalog:import}. */
    @Operation(summary = "Импорт каталога", description = "JSON с внешними ID клиента. Изменившаяся техкарта получает новую версию, старые не меняются.", tags = OpenApiConfig.T_CATALOG)
    @PostMapping("/catalog/import")
    public CatalogImportService.Result importCatalog(@RequestBody CatalogImportService.CatalogIn in) {
        StockPrincipal p = Access.current();
        if (!p.hasRole("ADMIN") && !p.hasScope("catalog:import")) {
            throw ApiException.forbidden("Только для администратора");
        }
        if (p.tenantId() == 0) {
            throw ApiException.forbidden("Сначала создайте предприятие");
        }
        return importer.importCatalog(p.tenantId(), in, p.actor());
    }

    @Operation(summary = "Импорт меню из Excel", description = "Листы «Продукты», «Заготовки», «Блюда» и необязательный «Сеты» — как в примере (GET /api/catalog/sample.xlsx). Повторная загрузка обновляет меню; изменившаяся техкарта получает новую версию.", tags = OpenApiConfig.T_CATALOG)
    @PostMapping(value = "/catalog/import/xlsx", consumes = org.springframework.http.MediaType.MULTIPART_FORM_DATA_VALUE)
    public CatalogImportService.Result importCatalogXlsx(@org.springframework.web.bind.annotation.RequestParam("file") org.springframework.web.multipart.MultipartFile file)
            throws java.io.IOException {
        StockPrincipal p = Access.current();
        if (!p.hasRole("ADMIN") && !p.hasScope("catalog:import")) {
            throw ApiException.forbidden("Только для администратора");
        }
        if (p.tenantId() == 0) {
            throw ApiException.forbidden("Сначала создайте предприятие");
        }
        if (file.isEmpty() || file.getSize() > 10_000_000) {
            throw ApiException.badRequest("Файл пустой или больше 10 МБ");
        }
        return importer.importCatalog(p.tenantId(), ru.sphere.stock.catalog.CatalogXlsx.parse(file.getBytes()), p.actor());
    }

    @Operation(summary = "Пример меню в Excel", description = "Небольшое меню кофейни: 10 продуктов, заготовка, 6 блюд и сет — заполните своим и загрузите.", tags = OpenApiConfig.T_CATALOG)
    @GetMapping("/catalog/sample.xlsx")
    public org.springframework.http.ResponseEntity<byte[]> catalogSampleXlsx() {
        Access.current();
        return org.springframework.http.ResponseEntity.ok()
                .header("Content-Disposition", "attachment; filename=\"menu-sample.xlsx\"")
                .contentType(org.springframework.http.MediaType.parseMediaType(
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
                .body(ru.sphere.stock.catalog.CatalogXlsx.write(ru.sphere.stock.catalog.CatalogXlsx.sample()));
    }

    @Operation(summary = "Пример меню в JSON для API", description = "То же меню кофейни — тело для POST /api/catalog/import.", tags = OpenApiConfig.T_CATALOG)
    @GetMapping("/catalog/sample.json")
    public CatalogImportService.CatalogIn catalogSampleJson() {
        Access.current();
        return ru.sphere.stock.catalog.CatalogXlsx.sample();
    }

    /** Техкарты меняют управляющий и админ (ТЗ 6.9): каждая правка — новая версия, старые не меняются. */
    private static StockPrincipal recipeEditor() {
        return Access.requireTenantRole("MANAGER", "ADMIN");
    }

    /** Новая версия техкарты варианта (ТЗ 6.9): старые версии не меняются. */
    @Operation(summary = "Новая версия техкарты блюда", description = "Рост граммовки больше 20% попадёт в подозрительные операции.", tags = OpenApiConfig.T_CATALOG)
    @PutMapping("/catalog/variants/{id}/recipe")
    public Map<String, Object> recipe(@PathVariable String id, @RequestBody RecipeIn in) {
        StockPrincipal p = recipeEditor();
        return Map.of("newVersion",
                importer.upsertRecipe(p.tenantId(), id, null, null, in.lines(), p.actor(), in.comment()) == 1);
    }

    @Operation(summary = "Новая версия техкарты заготовки", tags = OpenApiConfig.T_CATALOG)
    @PutMapping("/catalog/products/{id}/recipe")
    public Map<String, Object> semiRecipe(@PathVariable String id, @RequestBody RecipeIn in) {
        StockPrincipal p = recipeEditor();
        return Map.of("newVersion",
                importer.upsertRecipe(p.tenantId(), null, id, in.yieldQty(), in.lines(), p.actor(), in.comment()) == 1);
    }

    @Operation(summary = "Версии техкарты", description = "Все версии блюда с составом — от новой к старой.", tags = OpenApiConfig.T_CATALOG)
    @GetMapping("/catalog/variants/{id}/versions")
    public List<VersionDto> versions(@PathVariable String id) {
        long tenant = requireTenant();
        CatalogService.Snapshot cat = catalog.get(tenant);
        List<VersionDto> list = jdbc.sql("""
                        SELECT rv.id, rv.version, rv.status, rv.created_at, u.name, rv.comment FROM recipe_versions rv
                        LEFT JOIN users u ON u.id = rv.created_by WHERE rv.tenant_id = ? AND rv.variant_id = ?
                        ORDER BY rv.version DESC""")
                .params(tenant, id)
                .query((rs, n) -> new VersionDto(rs.getLong(1), rs.getInt(2), rs.getString(3),
                        rs.getTimestamp(4).toInstant(), rs.getString(5), rs.getString(6), new java.util.ArrayList<>()))
                .list();
        Map<Long, VersionDto> byId = new java.util.HashMap<>();
        list.forEach(v -> byId.put(v.id(), v));
        if (!byId.isEmpty()) {
            jdbc.sql("SELECT version_id, product_id, net_qty, loss_bp FROM recipe_lines WHERE version_id = ANY(?) ORDER BY product_id")
                    .param(byId.keySet().toArray(Long[]::new))
                    .query(rs -> {
                        RecipeLine l = new RecipeLine(rs.getString(2), rs.getLong(3), (Integer) rs.getObject(4));
                        byId.get(rs.getLong(1)).lines().addAll(lines(List.of(l), cat));
                    });
        }
        return list;
    }

    @Operation(summary = "Откатить техкарту к старой версии", description = "Создаёт новую версию с составом выбранной: история не переписывается, заказы помнят свою версию.", tags = OpenApiConfig.T_CATALOG)
    @PostMapping("/catalog/variants/{id}/versions/{versionId}/restore")
    public Map<String, Object> restore(@PathVariable String id, @PathVariable long versionId,
                                       @RequestBody(required = false) RestoreIn in) {
        StockPrincipal p = recipeEditor();
        int from = importer.restoreVersion(p.tenantId(), id, versionId, p.actor(), in == null ? null : in.comment());
        return Map.of("ok", true, "restoredFrom", from);
    }

    private static List<LineDto> lines(List<RecipeLine> lines, CatalogService.Snapshot cat) {
        return lines.stream().map(l -> {
            ProductInfo p = cat.product(l.productId());
            if (p == null) {                         // продукт убрали из каталога — строка старой версии всё равно видна
                return new LineDto(l.productId(), l.productId(), "G", l.netQty(), l.netQty(), l.lossBpOverride());
            }
            int loss = l.lossBpOverride() != null ? l.lossBpOverride() : p.lossBp();
            return new LineDto(p.id(), p.name(), p.unit().name(), l.netQty(), RecipeLine.gross(l.netQty(), loss),
                    l.lossBpOverride());
        }).toList();
    }

    private static Long hours(Duration d) {
        return d == null ? null : d.toHours();
    }

    private static long requireTenant() {
        long t = Access.tenant();
        if (t == 0) {
            throw ApiException.forbidden("Сначала создайте предприятие или примите приглашение");
        }
        return t;
    }

    // ── Точки и приглашения предприятия (ТЗ 16.4) ──────────────────────────

    @Operation(summary = "Точки предприятия", tags = OpenApiConfig.T_ADMIN)
    @GetMapping("/admin/locations")
    public List<TenantService.LocationDto> locations(@io.swagger.v3.oas.annotations.Parameter(description = "Предприятие, где вы тоже админ; без него — текущее") @org.springframework.web.bind.annotation.RequestParam(required = false) Long tenantId) {
        return tenants.locations(adminTenant(tenantId));
    }

    @Operation(summary = "Создать точку-склад", description = "ID точки — латинский slug из названия, он виден в адресе.", tags = OpenApiConfig.T_ADMIN)
    @PostMapping("/admin/locations")
    public Map<String, Object> createLocation(@RequestBody LocationIn in) {
        StockPrincipal p = admin();
        String id = tenants.createLocation(p.tenantId(), in.name(),
                in.openTime() == null ? null : LocalTime.parse(in.openTime()),
                in.closeTime() == null ? null : LocalTime.parse(in.closeTime()), p.actor());
        return Map.of("id", id);
    }

    public record LocationsIn(@Schema(description = "Новые точки: название и часы работы") List<LocationIn> locations) {
    }

    @Operation(summary = "Создать несколько точек", description = "Все или ни одной: названия не пустые и не повторяются; за раз — до 20.", tags = OpenApiConfig.T_ADMIN)
    @PostMapping("/admin/locations/batch")
    public Map<String, Object> createLocations(@RequestBody LocationsIn in) {
        StockPrincipal p = admin();
        List<String> ids = tenants.createLocations(p.tenantId(), in.locations() == null ? List.of() : in.locations().stream()
                .map(l -> new TenantService.NewLocation(l.name(),
                        l.openTime() == null || l.openTime().isBlank() ? null : LocalTime.parse(l.openTime()),
                        l.closeTime() == null || l.closeTime().isBlank() ? null : LocalTime.parse(l.closeTime())))
                .toList(), p.actor());
        return Map.of("ids", ids);
    }

    @Operation(summary = "Приглашения", tags = OpenApiConfig.T_ADMIN)
    @GetMapping("/admin/invites")
    public List<InviteService.InviteDto> invites(@io.swagger.v3.oas.annotations.Parameter(description = "Предприятие, где вы тоже админ; без него — текущее") @org.springframework.web.bind.annotation.RequestParam(required = false) Long tenantId) {
        return invites.list(adminTenant(tenantId));
    }

    @Operation(summary = "Пригласить сотрудника", description = "Одноразовая ссылка с ролью и точкой, действует 7 дней. Токен показывается один раз — в базе только хэш.", tags = OpenApiConfig.T_ADMIN)
    @PostMapping("/admin/invites")
    public InviteService.Created invite(@RequestBody InviteIn in) {
        StockPrincipal p = admin();
        return invites.create(adminTenant(in.tenantId()), in.role(), in.locationId(), in.note(), p.actor());
    }

    @Operation(summary = "Отозвать приглашение", tags = OpenApiConfig.T_ADMIN)
    @DeleteMapping("/admin/invites/{id}")
    public Map<String, Object> revokeInvite(@PathVariable long id, @io.swagger.v3.oas.annotations.Parameter(description = "Предприятие, где вы тоже админ; без него — текущее") @org.springframework.web.bind.annotation.RequestParam(required = false) Long tenantId) {
        StockPrincipal p = admin();
        invites.revoke(adminTenant(tenantId), id, p.actor());
        return Map.of("ok", true);
    }

    /**
     * Предприятие для приглашений и точек: текущее или другое, где этот человек тоже админ (ТЗ 16.9) —
     * например, только что созданное. Чужие предприятия не видны: изоляция данных.
     */
    private long adminTenant(Long tenantId) {
        StockPrincipal p = admin();
        if (tenantId == null || tenantId == p.tenantId()) {
            return p.tenantId();
        }
        boolean admin = users.memberships(p.id()).stream()
                .anyMatch(m -> m.tenantId() == tenantId && "ADMIN".equals(m.role()));
        if (!admin) {
            throw ApiException.forbidden("Вы не админ этого предприятия");
        }
        return tenantId;
    }

    // ── Демо-панель (5.14) ─────────────────────────────────────────────────

    @Operation(summary = "Состояние демо: часы и генератор", tags = OpenApiConfig.T_DEMO)
    @GetMapping("/demo/state")
    public DemoService.State demoState() {
        Access.current();
        return demo.state();
    }

    @Operation(summary = "Часы: скорость, пауза, перемотка вперёд", description = "Назад время не идёт.", tags = OpenApiConfig.T_DEMO)
    @PostMapping("/demo/clock")
    public DemoService.State clock(@RequestBody ClockIn in) {
        StockPrincipal p = admin();
        if (Boolean.TRUE.equals(in.real())) {
            clock.real();
        } else if (in.advanceHours() != null) {
            clock.advance(Duration.ofHours(in.advanceHours()));
        } else {
            clock.configure(in.speed() == null ? clock.state().speed() : in.speed(), Boolean.TRUE.equals(in.paused()));
        }
        audit.record(null, p.actor(), "clock", Map.of("speed", String.valueOf(in.speed()), "paused",
                String.valueOf(in.paused()), "advanceHours", String.valueOf(in.advanceHours())));
        return demo.state();
    }

    @Operation(summary = "Включить или выключить генератор событий", tags = OpenApiConfig.T_DEMO)
    @PostMapping("/demo/generator")
    public DemoService.State generator(@RequestBody GeneratorIn in) {
        admin();
        demo.setGenerator(in.enabled());
        return demo.state();
    }

    @Operation(summary = "Запустить сценарий", description = "RUSH — час пик, SHORT_LIFE — поставка с коротким сроком, SHORTAGE — дефицит лосося, SUSPICIOUS — подозрительный сотрудник, LATE_CANCELS — поздние отмены.", tags = OpenApiConfig.T_DEMO)
    @PostMapping("/demo/scenario")
    public Map<String, Object> scenario(@RequestBody ScenarioIn in) {
        StockPrincipal p = admin();
        Access.requireRole(in.location(), "ADMIN");
        audit.record(p.tenantId(), p.actor(), "demo.scenario", Map.of("location", in.location(), "type", in.type()));
        return demo.scenario(in.location(), in.type());
    }

    @Operation(summary = "Удалить все логи — чистый лист для тестов",
            description = "Удаляет журнал движений, партии, поставки, заказы, списания, пересчёты, сигналы, аномалии и аудит. "
                    + "Сотрудники, каталог, техкарты, API-ключи и настройки остаются. Только админ и только в демо-режиме; "
                    + "в теле — confirm: «УДАЛИТЬ».", tags = OpenApiConfig.T_DEMO)
    @PostMapping("/demo/clean")
    public Map<String, Object> clean(@RequestBody CleanIn in) {
        StockPrincipal p = admin();
        if (!"УДАЛИТЬ".equals(in.confirm()) && !"DELETE".equals(in.confirm())) {
            throw ApiException.badRequest("Для подтверждения отправьте confirm: «УДАЛИТЬ»");
        }
        demo.clean(p.tenantId(), in.startStock(), p.actor());
        return Map.of("ok", true, "message", in.startStock()
                ? "Логи удалены. Принята стартовая поставка, повар приготовил заготовки"
                : "Логи удалены. Склад пуст — начните с поставки");
    }

    @Operation(summary = "Пересоздать демо-данные", tags = OpenApiConfig.T_DEMO)
    @PostMapping("/demo/reset")
    public Map<String, Object> reset() {
        StockPrincipal p = admin();
        if (p.tenantId() != TenantDirectory.DEMO) {
            throw ApiException.forbidden("Пересоздать демо-данные может только админ демо-предприятия");
        }
        demo.reset();
        return Map.of("ok", true, "message", "Демо-данные пересоздаются — около минуты");
    }
}
