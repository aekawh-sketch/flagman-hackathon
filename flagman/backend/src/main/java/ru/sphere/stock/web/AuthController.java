package ru.sphere.stock.web;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;
import java.util.List;
import java.util.Map;
import io.swagger.v3.oas.annotations.Operation;
import ru.sphere.stock.config.OpenApiConfig;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.context.SecurityContextRepository;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import ru.sphere.stock.admin.SettingsService;
import ru.sphere.stock.config.StockProperties;
import ru.sphere.stock.demo.SeedService;
import ru.sphere.stock.infra.AppClock;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.ledger.Actor;
import ru.sphere.stock.security.Access;
import ru.sphere.stock.security.StockPrincipal;
import ru.sphere.stock.security.UserService;
import ru.sphere.stock.tenant.InviteService;
import ru.sphere.stock.tenant.TenantDirectory;
import ru.sphere.stock.tenant.TenantService;

/**
 * Вход: пароль, личный PIN (подпись списания в панели ресторана), демо-вход под ролью для жюри (ТЗ 6.1, п. 34),
 * переключение предприятий и приглашения по ссылке (ТЗ 16.4).
 */
@RestController
@RequestMapping("/api/auth")
public class AuthController {

    public record LoginIn(String login, String password,
                          @io.swagger.v3.oas.annotations.media.Schema(description = "Точка: вход в её предприятие с проверкой доступа — так панель ресторана узнаёт роль сотрудника у себя. Без неё — последнее предприятие") String location) {
    }

    /** {@code location} — точка: вход в её предприятие. Без неё — в последнее предприятие человека. */
    public record PinIn(long userId, String pin, String location) {
    }

    public record DemoIn(String role) {
    }

    public record SwitchIn(long tenantId) {
    }

    public record RegisterIn(String login, String name, String password, String pin) {
    }

    public record TenantIn(String name, String locationName,
                           @io.swagger.v3.oas.annotations.media.Schema(description = "Комментарий к заявке для администратора платформы") String comment) {
    }

    @io.swagger.v3.oas.annotations.media.Schema(name = "SignUpIn", description = "Открытая регистрация")
    public record SignUpIn(String login, String name, String password) {
    }

    /** «Создать предприятие»: CREATED — создано, сессия уже в нём; PENDING — заявка ждёт администратора платформы. */
    @io.swagger.v3.oas.annotations.media.Schema(name = "CreateTenantResult")
    public record CreateTenantResult(String status, MeDto me, ru.sphere.stock.tenant.PlatformService.RequestDto request) {
    }

    public record LocationDto(String id, String name, String publicKey) {
    }

    public record ClockDto(String now, String mode, int speed, boolean paused) {
    }

    public record ConfigDto(String restaurantName, boolean demoMode, String seedStatus, List<LocationDto> locations,
                            ClockDto clock, long tenantId, boolean registrationOpen, String tenantCreation,
                            @io.swagger.v3.oas.annotations.media.Schema(description = "Адрес кассы — панели ресторана, куда входит кассир") String posUrl) {
    }

    @io.swagger.v3.oas.annotations.media.Schema(name = "Workplace", description = "Место работы: предприятие, роль в нём и точки")
    public record WorkplaceDto(long tenantId, String tenantName, String role,
                               @io.swagger.v3.oas.annotations.media.Schema(description = "Точки, где человек работает: все точки предприятия или одна, если он к ней привязан") List<PlaceDto> locations) {
    }

    @io.swagger.v3.oas.annotations.media.Schema(name = "WorkplaceLocation", description = "Точка места работы")
    public record PlaceDto(String id, String name) {
    }

    /** Кто я + в каких предприятиях работаю (для переключателя в шапке). */
    public record MeDto(String kind, long id, String login, String name, String role, String locationId,
                        long tenantId, String tenantName, List<UserService.MembershipDto> tenants,
                        @io.swagger.v3.oas.annotations.media.Schema(description = "Администратор платформы — над всеми предприятиями") boolean platformAdmin) {
    }

    private final UserService users;
    private final InviteService invites;
    private final TenantService tenants;
    private final SecurityContextRepository repo;
    private final StockProperties props;
    private final SettingsService settings;
    private final JdbcClient jdbc;
    private final SeedService seed;
    private final AppClock clock;
    private final ru.sphere.stock.tenant.PlatformService platform;

    public AuthController(UserService users, InviteService invites, TenantService tenants,
                          SecurityContextRepository repo, StockProperties props, SettingsService settings,
                          JdbcClient jdbc, SeedService seed, AppClock clock,
                          ru.sphere.stock.tenant.PlatformService platform) {
        this.platform = platform;
        this.users = users;
        this.tenants = tenants;
        this.invites = invites;
        this.clock = clock;
        this.repo = repo;
        this.props = props;
        this.settings = settings;
        this.jdbc = jdbc;
        this.seed = seed;
    }

    /**
     * Точки текущего предприятия. До входа — точки демо-предприятия или предприятия точки из {@code ?loc=}.
     */
    @Operation(summary = "Настройки интерфейса: точки, демо-режим, часы сервера", tags = OpenApiConfig.T_AUTH)
    @GetMapping("/config")
    public ConfigDto config(@RequestParam(required = false) String loc) {
        long tenant = TenantDirectory.DEMO;
        Authentication a = SecurityContextHolder.getContext().getAuthentication();
        if (a != null && a.getPrincipal() instanceof StockPrincipal p && p.tenantId() != 0) {
            tenant = p.tenantId();
        } else if (loc != null) {
            Long t = TenantDirectory.get().tenantOfOrNull(loc);
            tenant = t == null ? tenant : t;
        }
        var s = clock.state();
        var ps = platform.settings();
        return new ConfigDto(settings.get(tenant, SettingsService.RESTAURANT_NAME), props.demoMode(), seed.status(),
                jdbc.sql("SELECT id, name, public_key FROM locations WHERE tenant_id = ? ORDER BY name").param(tenant)
                        .query((rs, n) -> new LocationDto(rs.getString(1), rs.getString(2), rs.getString(3))).list(),
                new ClockDto(clock.now().toString(), s.mode().name(), s.speed(), s.paused()), tenant,
                ps.registrationOpen(), ps.tenantCreation(), settings.get(tenant, SettingsService.POS_URL));
    }

    @Operation(summary = "Вход по логину и паролю", tags = OpenApiConfig.T_AUTH)
    @PostMapping("/login")
    public MeDto login(@RequestBody LoginIn in, HttpServletRequest req, HttpServletResponse res) {
        return signIn(users.login(in.login(), in.password(), in.location()), req, res);
    }

    @Operation(summary = "Вход по личному PIN", description = "После 5 неверных попыток — блокировка на 5 минут.", tags = OpenApiConfig.T_AUTH)
    @PostMapping("/pin")
    public MeDto pin(@RequestBody PinIn in, HttpServletRequest req, HttpServletResponse res) {
        return signIn(users.loginPin(in.userId(), in.pin(), in.location()), req, res);
    }

    @Operation(summary = "Регистрация без приглашения", description = "Открытая регистрация (если включена на платформе): учётка без предприятия — дальше принять приглашение или создать своё.", tags = OpenApiConfig.T_AUTH)
    @PostMapping("/register")
    public MeDto signUp(@RequestBody SignUpIn in, HttpServletRequest req, HttpServletResponse res) {
        if (!platform.settings().registrationOpen()) {
            throw ApiException.forbidden("Регистрация закрыта — попросите приглашение у ресторана");
        }
        long id = users.createAccount(in.login(), in.name(), in.password());
        return signIn(users.principal(id, null), req, res);
    }

    @Operation(summary = "Демо-вход под ролью", description = "Только в демо-режиме. Роли: COOK, CASHIER, STOREKEEPER, MANAGER, ADMIN; PLATFORM — администратор платформы.", tags = OpenApiConfig.T_AUTH)
    @PostMapping("/demo")
    public MeDto demo(@RequestBody DemoIn in, HttpServletRequest req, HttpServletResponse res) {
        if (!props.demoMode()) {
            throw ApiException.forbidden("Демо-вход выключен");
        }
        return signIn(users.demoLogin(in.role()), req, res);
    }

    @Operation(summary = "Сотрудники точки с PIN", tags = OpenApiConfig.T_AUTH)
    @GetMapping("/pin-users")
    public List<UserService.UserDto> pinUsers(@RequestParam String location) {
        return users.pinUsers(location).stream()
                .map(u -> new UserService.UserDto(u.id(), null, u.name(), u.role(), u.locationId(), true, true))
                .toList();
    }

    /** Заодно освежает роль: если админ сменил роль или отключил человека — увидим без перелогина. */
    @Operation(summary = "Кто я", description = "Роль в текущем предприятии и список предприятий, где работает человек.", tags = OpenApiConfig.T_AUTH)
    @GetMapping("/me")
    public MeDto me(HttpServletRequest req, HttpServletResponse res) {
        StockPrincipal p = Access.current();
        if (p.kind() == Actor.Kind.API) {
            return toMe(p);
        }
        StockPrincipal fresh;
        try {
            fresh = users.principal(p.id(), p.tenantId() == 0 ? null : p.tenantId());
        } catch (ApiException e) {
            fresh = users.principal(p.id(), null);    // из предприятия убрали — в другое, где он есть
        }
        if (!fresh.equals(p)) {
            store(fresh, req, res);
        }
        return toMe(fresh);
    }

    /** Панель ресторана после входа предлагает выбрать, где человек сейчас работает. */
    @Operation(summary = "Где я работаю", description = "Все предприятия человека: роль в каждом и точки, где он работает. Панель ресторана после входа предлагает выбрать место работы.", tags = OpenApiConfig.T_AUTH)
    @GetMapping("/workplaces")
    public List<WorkplaceDto> workplaces() {
        StockPrincipal p = Access.current();
        if (p.kind() == Actor.Kind.API) {
            throw ApiException.forbidden("Места работы есть только у сотрудника, не у API-ключа");
        }
        return users.memberships(p.id()).stream()
                .map(m -> new WorkplaceDto(m.tenantId(), m.tenantName(), m.role(), tenants.locations(m.tenantId()).stream()
                        .filter(l -> m.locationId() == null || m.locationId().equals(l.id()))
                        .map(l -> new PlaceDto(l.id(), l.name()))
                        .toList()))
                .toList();
    }

    @Operation(summary = "Переключить предприятие", description = "Сессия переходит в другое предприятие, где человек работает.", tags = OpenApiConfig.T_AUTH)
    @PostMapping("/tenant")
    public MeDto switchTenant(@RequestBody SwitchIn in, HttpServletRequest req, HttpServletResponse res) {
        StockPrincipal p = Access.current();
        if (p.kind() == Actor.Kind.API) {
            throw ApiException.forbidden("API-ключ привязан к одному предприятию");
        }
        StockPrincipal next = users.principal(p.id(), in.tenantId());
        store(next, req, res);
        return toMe(next);
    }

    @Operation(summary = "Заявка на новое предприятие", description = "Предприятия создаёт только администратор платформы: ему — сразу (CREATED, он становится админом, сессия переходит в предприятие). Человек без предприятия подаёт заявку администратору платформы (PENDING). Сотрудникам предприятий любой роли — 403.", tags = OpenApiConfig.T_AUTH)
    @PostMapping("/tenants")
    public CreateTenantResult createTenant(@RequestBody TenantIn in, HttpServletRequest req, HttpServletResponse res) {
        StockPrincipal p = Access.current();
        if (p.kind() == Actor.Kind.API) {
            throw ApiException.forbidden("Предприятие создаёт человек");
        }
        var r = platform.createOrRequest(p.id(), p.name(), users.isPlatformAdmin(p.id()), in.name(), in.locationName(),
                in.comment());
        if (r.created() == null) {
            return new CreateTenantResult("PENDING", toMe(p), r.request());
        }
        StockPrincipal next = users.principal(p.id(), r.created().tenantId());
        store(next, req, res);
        return new CreateTenantResult("CREATED", toMe(next), null);
    }

    @Operation(summary = "Мои заявки на предприятие", tags = OpenApiConfig.T_AUTH)
    @GetMapping("/tenant-requests")
    public List<ru.sphere.stock.tenant.PlatformService.RequestDto> myRequests() {
        StockPrincipal p = Access.current();
        return p.kind() == Actor.Kind.API ? List.of() : platform.mine(p.id());
    }

    @Operation(summary = "Отозвать свою заявку на предприятие", tags = OpenApiConfig.T_AUTH)
    @PostMapping("/tenant-requests/{id}/cancel")
    public ru.sphere.stock.tenant.PlatformService.RequestDto cancelRequest(@PathVariable long id) {
        StockPrincipal p = Access.current();
        return platform.cancel(id, p.id());
    }

    // ── Приглашения по ссылке ──────────────────────────────────────────────

    @Operation(summary = "Приглашение по ссылке", description = "Куда зовут и с какой ролью — до входа.", tags = OpenApiConfig.T_AUTH)
    @GetMapping("/invites/{token}")
    public InviteService.PublicInfo invite(@PathVariable String token) {
        return invites.info(token);
    }

    @Operation(summary = "Принять приглашение своим входом", tags = OpenApiConfig.T_AUTH)
    @PostMapping("/invites/{token}/accept")
    public MeDto acceptInvite(@PathVariable String token, HttpServletRequest req, HttpServletResponse res) {
        StockPrincipal p = Access.current();
        if (p.kind() == Actor.Kind.API) {
            throw ApiException.forbidden("Приглашение принимает человек");
        }
        long tenant = invites.accept(token, p.id());
        StockPrincipal next = users.principal(p.id(), tenant);
        store(next, req, res);
        return toMe(next);
    }

    @Operation(summary = "Зарегистрироваться по приглашению", description = "Новая учётка сразу с ролью из приглашения.", tags = OpenApiConfig.T_AUTH)
    @PostMapping("/invites/{token}/register")
    public MeDto register(@PathVariable String token, @RequestBody RegisterIn in, HttpServletRequest req,
                          HttpServletResponse res) {
        long userId = invites.register(token, in.login(), in.name(), in.password(), in.pin());
        return signIn(users.principal(userId, null), req, res);
    }

    @Operation(summary = "Выход", tags = OpenApiConfig.T_AUTH)
    @PostMapping("/logout")
    public Map<String, Object> logout(HttpServletRequest req) {
        HttpSession s = req.getSession(false);
        if (s != null) {
            s.invalidate();
        }
        SecurityContextHolder.clearContext();
        return Map.of("ok", true);
    }

    private MeDto signIn(StockPrincipal p, HttpServletRequest req, HttpServletResponse res) {
        req.getSession(true);
        req.changeSessionId();                 // защита от фиксации сессии
        store(p, req, res);
        return toMe(p);
    }

    private void store(StockPrincipal p, HttpServletRequest req, HttpServletResponse res) {
        var auth = new UsernamePasswordAuthenticationToken(p, null,
                List.of(new SimpleGrantedAuthority("ROLE_" + p.role())));
        var ctx = SecurityContextHolder.createEmptyContext();
        ctx.setAuthentication(auth);
        SecurityContextHolder.setContext(ctx);
        repo.saveContext(ctx, req, res);
    }

    private MeDto toMe(StockPrincipal p) {
        boolean user = p.kind() != Actor.Kind.API;
        return new MeDto(p.kind().name(), p.id(), p.login(), p.name(), p.role(), p.locationId(), p.tenantId(),
                p.tenantName(), user ? users.memberships(p.id()) : List.of(), user && users.isPlatformAdmin(p.id()));
    }
}
