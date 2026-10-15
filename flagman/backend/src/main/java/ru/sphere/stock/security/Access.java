package ru.sphere.stock.security;

import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.ledger.Actor;

/**
 * Проверки прав по матрице ТЗ 6.2. Права проверяются в коде у каждого действия, а не только на
 * уровне URL: так матрицу легко сверить с ТЗ построчно.
 */
public final class Access {

    private Access() {
    }

    public static StockPrincipal current() {
        Authentication a = SecurityContextHolder.getContext().getAuthentication();
        if (a != null && a.getPrincipal() instanceof StockPrincipal p) {
            return p;
        }
        throw new ApiException(HttpStatus.UNAUTHORIZED, "Нужно войти");
    }

    public static Actor actor() {
        return current().actor();
    }

    /** Доступ к точке + одна из ролей (или право API-ключа, если оно указано). */
    public static StockPrincipal require(String locationId, String scope, String... roles) {
        StockPrincipal p = current();
        if (!p.canAccess(locationId)) {
            throw ApiException.forbidden("Нет доступа к этой точке");
        }
        if (p.kind() == Actor.Kind.API) {
            if (scope == null || !p.hasScope(scope)) {
                throw ApiException.forbidden("У API-ключа нет права " + scope);
            }
            return p;
        }
        if (roles.length > 0 && !p.hasRole(roles)) {
            throw ApiException.forbidden("Недостаточно прав для этого действия");
        }
        return p;
    }

    public static StockPrincipal requireRole(String locationId, String... roles) {
        return require(locationId, null, roles);
    }

    /** Действие над своим предприятием целиком (админка, каталог): нужна одна из ролей в нём. */
    public static StockPrincipal requireTenantRole(String... roles) {
        StockPrincipal p = current();
        if (p.tenantId() == 0) {
            throw ApiException.forbidden("Сначала создайте предприятие или примите приглашение");
        }
        if (p.kind() == Actor.Kind.API || !p.hasRole(roles)) {
            throw ApiException.forbidden("Недостаточно прав для этого действия");
        }
        return p;
    }

    /** Текущее предприятие вошедшего; 0 — ещё ни одного. */
    public static long tenant() {
        return current().tenantId();
    }

    public static final String[] STAFF = {"COOK", "CASHIER", "STOREKEEPER", "MANAGER", "ADMIN"};
    public static final String[] STOCK_VIEW = {"COOK", "STOREKEEPER", "MANAGER", "ADMIN"};
    public static final String[] MANAGERS = {"MANAGER", "ADMIN"};
}
