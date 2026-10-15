package ru.sphere.stock.security;

import java.io.Serial;
import java.io.Serializable;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import ru.sphere.stock.ledger.Actor;
import ru.sphere.stock.tenant.TenantDirectory;

/**
 * Кто вошёл: сотрудник под своей учёткой или внешняя система по API-ключу.
 * Роль и точка — из членства в текущем предприятии (ТЗ 16.4): у одного человека в разных
 * ресторанах может быть разная роль.
 *
 * @param role       роль в текущем предприятии; {@code NONE} — человек ещё ни в одном предприятии
 * @param locationId точка сотрудника; {@code null} — все точки предприятия
 * @param scopes     права API-ключа (для сотрудника пусто — работают роли)
 * @param tenantId   текущее предприятие; 0 — нет ни одного
 */
public record StockPrincipal(Actor.Kind kind, long id, String login, String name, String role, String locationId,
                             Set<String> scopes, long tenantId, String tenantName) implements Serializable {

    @Serial
    private static final long serialVersionUID = 2L;

    public static final List<String> ROLES = List.of("COOK", "CASHIER", "STOREKEEPER", "MANAGER", "ADMIN");
    public static final String NO_ROLE = "NONE";

    public Actor actor() {
        return kind == Actor.Kind.API ? Actor.api(id, name) : Actor.user(id, role, name);
    }

    /** Точка своего предприятия и (если сотрудник привязан к точке) — именно его. */
    public boolean canAccess(String location) {
        Long owner = TenantDirectory.get().tenantOfOrNull(location);
        return owner != null && (owner == tenantId || platformKey()) && (locationId == null || locationId.equals(location));
    }

    /**
     * Ключ поставщика платформы (ТЗ 16.17): API-ключ без предприятия — открыты точки всех предприятий, но только
     * в пределах его права {@code deliveries:create}. Такой ключ заводит лишь сервер, не админ предприятия.
     */
    public boolean platformKey() {
        return kind == Actor.Kind.API && tenantId == 0;
    }

    public boolean hasRole(String... roles) {
        for (String r : roles) {
            if (Objects.equals(r, role)) {
                return true;
            }
        }
        return false;
    }

    public boolean hasScope(String scope) {
        return scopes != null && scopes.contains(scope);
    }
}
