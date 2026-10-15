package ru.sphere.stock.web;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.media.Schema;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import ru.sphere.stock.catalog.CatalogService;
import ru.sphere.stock.config.OpenApiConfig;
import ru.sphere.stock.domain.ProductInfo;
import ru.sphere.stock.domain.ProductKind;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.ledger.Actor;
import ru.sphere.stock.security.Access;
import ru.sphere.stock.security.StockPrincipal;

/**
 * Для поставщика по API-ключу (ТЗ 16.17): куда можно отправить поставку и что возит ресторан. Ключ поставщика
 * платформы видит все предприятия — и созданные позже; ключ предприятия — только своё.
 */
@RestController
@RequestMapping("/api")
public class SupplierController {

    @Schema(name = "SupplierRestaurant", description = "Предприятие, куда поставщик может отправить поставку")
    public record Restaurant(long tenantId, String name,
                             @Schema(description = "Когда предприятие появилось на платформе — новые поставщик видит сверху") Instant createdAt,
                             List<Place> locations) {
    }

    @Schema(name = "SupplierLocation", description = "Точка доставки")
    public record Place(String id, String name) {
    }

    @Schema(name = "SupplyProduct", description = "Продукт из каталога ресторана — то, что поставщик может привезти")
    public record Product(String id, String name, String unit, String category, Long shelfLifeHours, Double unitCostKop,
                          Long packSize) {
    }

    private final JdbcClient jdbc;
    private final CatalogService catalog;

    public SupplierController(JdbcClient jdbc, CatalogService catalog) {
        this.jdbc = jdbc;
        this.catalog = catalog;
    }

    @Operation(summary = "Куда отправлять поставки", description = "Предприятия и их точки, открытые этому API-ключу: ключу поставщика платформы — все, новые сверху; ключу предприятия — только его.", tags = OpenApiConfig.T_DELIVERIES)
    @GetMapping("/supplier/restaurants")
    public List<Restaurant> restaurants() {
        StockPrincipal p = Access.current();
        if (p.kind() != Actor.Kind.API || !p.hasScope("deliveries:create")) {
            throw ApiException.forbidden("Только для поставщика — API-ключ с правом deliveries:create");
        }
        Map<Long, Restaurant> out = new LinkedHashMap<>();
        jdbc.sql("""
                        SELECT t.id, t.name, t.created_at, l.id, l.name FROM tenants t JOIN locations l ON l.tenant_id = t.id
                        WHERE (? OR t.id = ?) AND (?::text IS NULL OR l.id = ?)
                        ORDER BY t.created_at DESC, t.id DESC, l.name""")
                .params(p.platformKey(), p.tenantId(), p.locationId(), p.locationId())
                .query(rs -> {
                    String name = rs.getString(2);
                    Instant at = rs.getTimestamp(3).toInstant();
                    out.computeIfAbsent(rs.getLong(1), id -> new Restaurant(id, name, at, new ArrayList<>()))
                            .locations().add(new Place(rs.getString(4), rs.getString(5)));
                });
        return List.copyOf(out.values());
    }

    @Operation(summary = "Каталог ресторана для поставщика", description = "Сырьё предприятия этой точки: id, единица, срок годности, последняя цена. Нового продукта в каталоге нет — его можно прислать в поставке, ресторан проверит карточку.", tags = OpenApiConfig.T_DELIVERIES)
    @GetMapping("/{loc}/supply-catalog")
    public List<Product> supplyCatalog(@PathVariable String loc) {
        Access.require(loc, "deliveries:create", "STOREKEEPER", "MANAGER", "ADMIN");
        var cat = catalog.forLocation(loc);
        return cat.products().stream()
                .filter(pr -> pr.kind() == ProductKind.RAW)
                .map(pr -> {
                    var ex = cat.extra(pr.id());
                    return new Product(pr.id(), pr.name(), pr.unit().name(), ex == null ? null : ex.category(),
                            hours(pr), ex == null ? null : ex.lastUnitCostKop(), pr.packSize());
                })
                .sorted(Comparator.comparing((Product x) -> x.category() == null ? "яяя" : x.category()).thenComparing(Product::name))
                .toList();
    }

    private static Long hours(ProductInfo p) {
        return p.shelfLife() == null ? null : p.shelfLife().toHours();
    }
}
