package ru.sphere.stock.web;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import jakarta.servlet.http.HttpServletRequest;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import ru.sphere.stock.config.OpenApiConfig;
import ru.sphere.stock.config.StockProperties;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.infra.Hashing;
import ru.sphere.stock.ledger.Actor;
import ru.sphere.stock.security.StockPrincipal;
import ru.sphere.stock.security.UserService;
import ru.sphere.stock.tenant.InviteService;
import ru.sphere.stock.tenant.PlatformService;
import ru.sphere.stock.tenant.TenantService;

/**
 * Админка платформы (ТЗ 16.9) — над всеми предприятиями: заявки на создание предприятия, список предприятий,
 * режимы. Вход — администратор платформы своей учёткой или внешняя админка / CRM с ключом {@code X-Platform-Key}.
 */
@RestController
@RequestMapping("/api/platform")
public class PlatformController {

    public static final String KEY_HEADER = "X-Platform-Key";

    public record DecisionIn(String comment) {
    }

    @io.swagger.v3.oas.annotations.media.Schema(name = "TenantDeleteIn", description = "Подтверждение удаления предприятия")
    public record DeleteIn(
            @io.swagger.v3.oas.annotations.media.Schema(description = "Точное название предприятия — подтверждение") String confirm,
            @io.swagger.v3.oas.annotations.media.Schema(description = "Причина — останется в истории удалений") String reason) {
    }

    private final PlatformService platform;
    private final UserService users;
    private final StockProperties props;

    public PlatformController(PlatformService platform, UserService users, StockProperties props) {
        this.platform = platform;
        this.users = users;
        this.props = props;
    }

    @Operation(summary = "Заявки на создание предприятия", description = "status — PENDING, APPROVED, REJECTED, CANCELED; без него — все, ждущие сверху.", tags = OpenApiConfig.T_PLATFORM)
    @GetMapping("/tenant-requests")
    public List<PlatformService.RequestDto> requests(HttpServletRequest req, @RequestParam(required = false) String status) {
        requirePlatform(req);
        return platform.requests(status);
    }

    @Operation(summary = "Одобрить заявку", description = "Предприятие создаётся, заявитель становится его админом, появляется первая точка.", tags = OpenApiConfig.T_PLATFORM)
    @PostMapping("/tenant-requests/{id}/approve")
    public PlatformService.RequestDto approve(HttpServletRequest req, @PathVariable long id,
                                              @RequestBody(required = false) DecisionIn in) {
        return platform.approve(id, requirePlatform(req), in == null ? null : in.comment());
    }

    @Operation(summary = "Отклонить заявку", tags = OpenApiConfig.T_PLATFORM)
    @PostMapping("/tenant-requests/{id}/reject")
    public PlatformService.RequestDto reject(HttpServletRequest req, @PathVariable long id,
                                             @RequestBody(required = false) DecisionIn in) {
        return platform.reject(id, requirePlatform(req), in == null ? null : in.comment());
    }

    @Operation(summary = "Предприятия на платформе", tags = OpenApiConfig.T_PLATFORM)
    @GetMapping("/tenants")
    public List<PlatformService.TenantDto> tenants(HttpServletRequest req) {
        requirePlatform(req);
        return platform.tenants();
    }

    @io.swagger.v3.oas.annotations.media.Schema(name = "PlatformTenantIn", description = "Новое предприятие от платформы")
    public record TenantIn(String name,
                           @io.swagger.v3.oas.annotations.media.Schema(description = "Первая точка-склад; без неё — как предприятие") String locationName,
                           @io.swagger.v3.oas.annotations.media.Schema(description = "Сразу несколько точек-складов: первая — основная; если указаны, locationName не нужен") List<String> locations,
                           @io.swagger.v3.oas.annotations.media.Schema(description = "Администратор платформы и сам становится админом предприятия") boolean joinAsAdmin) {
    }

    @io.swagger.v3.oas.annotations.media.Schema(name = "PlatformInviteIn", description = "Приглашение от платформы")
    public record InviteIn(
            @io.swagger.v3.oas.annotations.media.Schema(description = "ADMIN, MANAGER, STOREKEEPER, COOK или CASHIER") String role,
            @io.swagger.v3.oas.annotations.media.Schema(description = "Точка предприятия; без неё — все точки") String locationId,
            @io.swagger.v3.oas.annotations.media.Schema(description = "Для кого — заметка") String note) {
    }

    @Operation(summary = "Создать предприятие",
            description = "Для клиента: создатель в нём не работает, владельца приглашают ссылкой с ролью ADMIN. "
                    + "joinAsAdmin — администратор платформы и сам становится его админом (по ключу CRM — нет).",
            tags = OpenApiConfig.T_PLATFORM)
    @PostMapping("/tenants")
    public TenantService.Created create(HttpServletRequest req, @RequestBody TenantIn in) {
        List<String> locations = in.locations() != null && !in.locations().isEmpty() ? in.locations()
                : java.util.Collections.singletonList(in.locationName());
        return platform.createTenantWithLocations(in.name(), locations, requirePlatform(req), in.joinAsAdmin());
    }

    @Operation(summary = "Точки предприятия", tags = OpenApiConfig.T_PLATFORM)
    @GetMapping("/tenants/{id}/locations")
    public List<TenantService.LocationDto> locations(HttpServletRequest req, @PathVariable long id) {
        requirePlatform(req);
        return platform.locations(id);
    }

    @Operation(summary = "Приглашения в предприятие", tags = OpenApiConfig.T_PLATFORM)
    @GetMapping("/tenants/{id}/invites")
    public List<InviteService.InviteDto> invites(HttpServletRequest req, @PathVariable long id) {
        requirePlatform(req);
        return platform.invites(id);
    }

    @Operation(summary = "Пригласить в предприятие",
            description = "Одноразовая ссылка с ролью и точкой на 7 дней — как у админа предприятия. Токен показывается один раз.",
            tags = OpenApiConfig.T_PLATFORM)
    @PostMapping("/tenants/{id}/invites")
    public InviteService.Created invite(HttpServletRequest req, @PathVariable long id, @RequestBody InviteIn in) {
        return platform.invite(id, in.role(), in.locationId(), in.note(), requirePlatform(req));
    }

    @Operation(summary = "Отозвать приглашение в предприятие", tags = OpenApiConfig.T_PLATFORM)
    @DeleteMapping("/tenants/{id}/invites/{inviteId}")
    public Map<String, Object> revokeInvite(HttpServletRequest req, @PathVariable long id, @PathVariable long inviteId) {
        platform.revokeInvite(id, inviteId, requirePlatform(req));
        return Map.of("ok", true);
    }

    @Operation(summary = "Удалить предприятие",
            description = "Безвозвратно: точки, каталог, сотрудники в нём, ключи, журнал, документы и фото. Учётки людей остаются. "
                    + "В теле — confirm: точное название предприятия. Демо-предприятие удалить нельзя. След — в истории удалений.",
            tags = OpenApiConfig.T_PLATFORM)
    @PostMapping("/tenants/{id}/delete")
    public PlatformService.DeletionDto delete(HttpServletRequest req, @PathVariable long id, @RequestBody DeleteIn in) {
        return platform.deleteTenant(id, requirePlatform(req), in.confirm(), in.reason());
    }

    @Operation(summary = "История удалений предприятий", tags = OpenApiConfig.T_PLATFORM)
    @GetMapping("/tenants/deleted")
    public List<PlatformService.DeletionDto> deleted(HttpServletRequest req) {
        requirePlatform(req);
        return platform.deletions();
    }

    @Operation(summary = "Режимы платформы", tags = OpenApiConfig.T_PLATFORM)
    @GetMapping("/settings")
    public PlatformService.Settings settings(HttpServletRequest req) {
        requirePlatform(req);
        return platform.settings();
    }

    @Operation(summary = "Изменить режимы платформы", description = "tenantCreation — всегда APPROVAL (предприятия создаёт только администратор платформы, INSTANT — 400); registrationOpen — открытая регистрация.", tags = OpenApiConfig.T_PLATFORM)
    @PutMapping("/settings")
    public PlatformService.Settings update(HttpServletRequest req, @RequestBody PlatformService.Settings in) {
        requirePlatform(req);
        return platform.update(in);
    }

    /**
     * Кто решает: ID администратора платформы, {@code null} — внешняя система по ключу платформы.
     * Ключ сравнивается по хэшу за постоянное время.
     */
    private Long requirePlatform(@Parameter(hidden = true) HttpServletRequest req) {
        String key = req.getHeader(KEY_HEADER);
        String expected = props.platformApiKey();
        if (key != null && expected != null && !expected.isBlank()) {
            if (MessageDigest.isEqual(Hashing.sha256(key).getBytes(StandardCharsets.UTF_8),
                    Hashing.sha256(expected).getBytes(StandardCharsets.UTF_8))) {
                return null;
            }
            throw ApiException.forbidden("Неверный ключ платформы");
        }
        Authentication a = SecurityContextHolder.getContext().getAuthentication();
        if (a == null || !(a.getPrincipal() instanceof StockPrincipal p) || p.kind() != Actor.Kind.USER) {
            throw new ApiException(HttpStatus.UNAUTHORIZED, "Нужно войти администратором платформы или передать ключ платформы");
        }
        if (!users.isPlatformAdmin(p.id())) {
            throw ApiException.forbidden("Только для администратора платформы");
        }
        return p.id();
    }
}
