package ru.sphere.stock.catalog;

import io.swagger.v3.oas.annotations.media.Schema;
import java.sql.Timestamp;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import ru.sphere.stock.tenant.TenantDirectory;
import org.springframework.transaction.annotation.Transactional;
import ru.sphere.stock.admin.AuditService;
import ru.sphere.stock.antifraud.AnomalyService;
import ru.sphere.stock.domain.RecipeLine;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.infra.AppClock;
import ru.sphere.stock.ledger.Actor;

/**
 * Импорт каталога (ТЗ п. 48): продукты, заготовки, блюда, варианты, техкарты и сеты из JSON с внешними
 * ID клиента. Повторный импорт обновляет каталог; техкарта, которая изменилась, получает новую версию
 * (старые не меняются, ТЗ 6.9).
 */
@Service
public class CatalogImportService {

    public record ProductIn(String id, String name, String unit, String kind, String category, Double price,
                            Integer shelfLifeHours, Long packSize, Integer afterOpenHours, Double lossPct,
                            Integer alertBeforeHours, Integer leadTimeHours, Long expectedDailyUse) {
    }

    @Schema(name = "RecipeLineIn")
    public record LineIn(String productId, long net, Integer lossBp) {
    }

    public record SemiIn(String productId, long yieldQty, List<LineIn> lines) {
    }

    public record VariantIn(String id, String name, String label, long priceKop, Boolean isSet, List<LineIn> lines) {
    }

    public record DishIn(String id, String name, String category, String description, Integer sort,
                         List<VariantIn> variants) {
    }

    public record SetItemIn(String variantId, int qty) {
    }

    public record SetIn(String variantId, List<SetItemIn> items) {
    }

    public record CatalogIn(List<ProductIn> products, List<SemiIn> semi, List<DishIn> dishes, List<SetIn> sets) {
    }

    @Schema(name = "CatalogImportResult")
    public record Result(int products, int dishes, int variants, int newRecipeVersions) {
    }

    private final JdbcClient jdbc;
    private final AppClock clock;
    private final CatalogService catalog;
    private final AuditService audit;
    private final AnomalyService anomalies;
    private final TenantDirectory tenants;

    public CatalogImportService(JdbcClient jdbc, AppClock clock, CatalogService catalog, AuditService audit,
                                AnomalyService anomalies, TenantDirectory tenants) {
        this.tenants = tenants;
        this.jdbc = jdbc;
        this.clock = clock;
        this.catalog = catalog;
        this.audit = audit;
        this.anomalies = anomalies;
    }

    /** Каталог предприятия {@code tenantId}: ID — внешние ID ресторана, уникальны внутри предприятия (ТЗ 16.4). */
    @Transactional
    public Result importCatalog(long tenantId, CatalogIn in, Actor actor) {
        int products = 0, variants = 0, versions = 0;
        for (ProductIn p : in.products() == null ? List.<ProductIn>of() : in.products()) {
            if (p.id() == null || p.name() == null || !List.of("G", "ML", "PCS").contains(p.unit())) {
                throw ApiException.badRequest("Продукт: нужны id, name и unit (G, ML, PCS)");
            }
            Double unitCost = p.price() == null ? null
                    : "PCS".equals(p.unit()) ? p.price() * 100 : p.price() * 100 / 1000.0;
            jdbc.sql("""
                            INSERT INTO products (tenant_id, id, name, unit, kind, category, pack_size, after_open_minutes,
                                                  loss_bp, alert_before_minutes, shelf_life_minutes, lead_time_minutes,
                                                  expected_daily_use, last_unit_cost_kop, needs_review)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE)
                            ON CONFLICT (tenant_id, id) DO UPDATE SET name = EXCLUDED.name, unit = EXCLUDED.unit, kind = EXCLUDED.kind,
                                category = EXCLUDED.category, pack_size = EXCLUDED.pack_size,
                                after_open_minutes = EXCLUDED.after_open_minutes, loss_bp = EXCLUDED.loss_bp,
                                alert_before_minutes = EXCLUDED.alert_before_minutes,
                                shelf_life_minutes = EXCLUDED.shelf_life_minutes, lead_time_minutes = EXCLUDED.lead_time_minutes,
                                expected_daily_use = COALESCE(EXCLUDED.expected_daily_use, products.expected_daily_use),
                                last_unit_cost_kop = COALESCE(products.last_unit_cost_kop, EXCLUDED.last_unit_cost_kop),
                                needs_review = FALSE""")
                    .params(tenantId, p.id(), p.name(), p.unit(), p.kind() == null ? "RAW" : p.kind(), p.category(), p.packSize(),
                            minutes(p.afterOpenHours()), p.lossPct() == null ? 0 : (int) Math.round(p.lossPct() * 100),
                            minutes(p.alertBeforeHours()), minutes(p.shelfLifeHours()), minutes(p.leadTimeHours()),
                            p.expectedDailyUse(), unitCost)
                    .update();
            products++;
        }
        for (SemiIn s : in.semi() == null ? List.<SemiIn>of() : in.semi()) {
            versions += upsertRecipe(tenantId, null, s.productId(), s.yieldQty(), s.lines(), actor, "Импорт каталога");
        }
        for (DishIn d : in.dishes() == null ? List.<DishIn>of() : in.dishes()) {
            jdbc.sql("""
                            INSERT INTO dishes (tenant_id, id, name, category, description, sort) VALUES (?, ?, ?, ?, ?, ?)
                            ON CONFLICT (tenant_id, id) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category,
                                description = EXCLUDED.description, sort = EXCLUDED.sort""")
                    .params(tenantId, d.id(), d.name(), d.category(), d.description(), d.sort() == null ? 0 : d.sort())
                    .update();
            int vs = 0;
            for (VariantIn v : d.variants()) {
                jdbc.sql("""
                                INSERT INTO dish_variants (tenant_id, id, dish_id, name, variant_label, price_kop, is_set,
                                                           active, sort)
                                VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, ?)
                                ON CONFLICT (tenant_id, id) DO UPDATE SET dish_id = EXCLUDED.dish_id, name = EXCLUDED.name,
                                    variant_label = EXCLUDED.variant_label, price_kop = EXCLUDED.price_kop,
                                    is_set = EXCLUDED.is_set, active = TRUE, sort = EXCLUDED.sort""")
                        .params(tenantId, v.id(), d.id(), v.name(), v.label(), v.priceKop(), Boolean.TRUE.equals(v.isSet()), vs++)
                        .update();
                if (!Boolean.TRUE.equals(v.isSet()) && v.lines() != null && !v.lines().isEmpty()) {
                    versions += upsertRecipe(tenantId, v.id(), null, null, v.lines(), actor, "Импорт каталога");
                }
                variants++;
            }
        }
        for (SetIn s : in.sets() == null ? List.<SetIn>of() : in.sets()) {
            jdbc.sql("DELETE FROM set_items WHERE tenant_id = ? AND set_variant_id = ?").params(tenantId, s.variantId())
                    .update();
            for (SetItemIn it : s.items()) {
                jdbc.sql("INSERT INTO set_items (tenant_id, set_variant_id, variant_id, qty) VALUES (?, ?, ?, ?)")
                        .params(tenantId, s.variantId(), it.variantId(), it.qty()).update();
            }
        }
        catalog.invalidate(tenantId);
        audit.record(tenantId, actor, "catalog.import", Map.of("products", products, "variants", variants,
                "newRecipeVersions", versions));
        return new Result(products, in.dishes() == null ? 0 : in.dishes().size(), variants, versions);
    }

    /**
     * Новая версия техкарты, если состав изменился. Старая версия архивируется, а не меняется.
     *
     * @return 1 — создана новая версия, 0 — состав тот же
     */
    @Transactional
    public int upsertRecipe(long tenantId, String variantId, String semiId, Long yieldQty, List<LineIn> lines,
                            Actor actor, String comment) {
        if (lines == null || lines.isEmpty()) {
            throw ApiException.badRequest("В техкарте нет строк");
        }
        for (LineIn l : lines) {
            if (l.net() <= 0) {
                throw ApiException.badRequest("Нетто должно быть больше нуля: " + l.productId());
            }
        }
        String ownerCol = variantId != null ? "variant_id" : "semi_product_id";
        String owner = variantId != null ? variantId : semiId;
        var current = jdbc.sql("SELECT id, version, yield_qty FROM recipe_versions WHERE tenant_id = ? AND " + ownerCol
                        + " = ? AND status = 'ACTIVE'")
                .params(tenantId, owner)
                .query((rs, n) -> new long[]{rs.getLong(1), rs.getLong(2), rs.getLong(3)})
                .optional();
        Map<String, long[]> old = new HashMap<>();
        if (current.isPresent()) {
            jdbc.sql("SELECT product_id, net_qty, COALESCE(loss_bp, -1) FROM recipe_lines WHERE version_id = ?")
                    .param(current.get()[0])
                    .query(rs -> {
                        old.put(rs.getString(1), new long[]{rs.getLong(2), rs.getLong(3)});
                    });
            boolean same = old.size() == lines.size()
                    && (yieldQty == null || yieldQty == current.get()[2])
                    && lines.stream().allMatch(l -> {
                        long[] o = old.get(l.productId());
                        return o != null && o[0] == l.net() && o[1] == (l.lossBp() == null ? -1 : l.lossBp());
                    });
            if (same) {
                return 0;
            }
            jdbc.sql("UPDATE recipe_versions SET status = 'ARCHIVED' WHERE id = ?").param(current.get()[0]).update();
        }
        long version = current.map(c -> c[1] + 1).orElse(1L);
        long id = jdbc.sql("""
                        INSERT INTO recipe_versions (tenant_id, variant_id, semi_product_id, version, yield_qty, created_by,
                                                     created_at, comment, status)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE') RETURNING id""")
                .params(tenantId, variantId, semiId, version, yieldQty, actor.userId(), Timestamp.from(clock.now()), comment)
                .query(Long.class).single();
        for (LineIn l : lines) {
            jdbc.sql("INSERT INTO recipe_lines (tenant_id, version_id, product_id, net_qty, loss_bp) VALUES (?, ?, ?, ?, ?)")
                    .params(tenantId, id, l.productId(), l.net(), l.lossBp()).update();
        }
        if (current.isPresent()) {
            String ownerName = jdbc.sql(variantId != null ? "SELECT name FROM dish_variants WHERE tenant_id = ? AND id = ?"
                    : "SELECT name FROM products WHERE tenant_id = ? AND id = ?").params(tenantId, owner)
                    .query(String.class).single();
            audit.record(tenantId, actor, "recipe.version", Map.of("owner", owner, "version", version));
            for (LineIn l : lines) {
                long[] o = old.get(l.productId());
                if (o != null) {
                    String pname = jdbc.sql("SELECT name FROM products WHERE tenant_id = ? AND id = ?")
                            .params(tenantId, l.productId()).query(String.class).single();
                    for (String loc : tenants.locations(tenantId)) {
                        anomalies.onRecipeChange(loc, ownerName, pname, o[0], l.net(), actor, id);
                    }
                }
            }
        }
        catalog.invalidate(tenantId);
        return 1;
    }

    /**
     * Откат техкарты блюда к старой версии (ТЗ 6.9): старые версии неизменны, поэтому откат — новая версия
     * с тем же составом. Заказы, списанные по промежуточной версии, так и помнят её.
     *
     * @return номер старой версии, к которой откатили
     */
    @Transactional
    public int restoreVersion(long tenantId, String variantId, long versionId, Actor actor, String comment) {
        Integer number = jdbc.sql("""
                        SELECT version FROM recipe_versions WHERE id = ? AND tenant_id = ? AND variant_id = ?""")
                .params(versionId, tenantId, variantId).query(Integer.class).optional()
                .orElseThrow(() -> ApiException.notFound("Версия техкарты"));
        List<LineIn> lines = jdbc.sql("SELECT product_id, net_qty, loss_bp FROM recipe_lines WHERE version_id = ?")
                .param(versionId)
                .query((rs, n) -> new LineIn(rs.getString(1), rs.getLong(2), (Integer) rs.getObject(3)))
                .list();
        String note = "Откат к v" + number + (comment == null || comment.isBlank() ? "" : ": " + comment.trim());
        if (upsertRecipe(tenantId, variantId, null, null, lines, actor, note) == 0) {
            throw ApiException.conflict("Состав v" + number + " уже действует — откатывать нечего");
        }
        return number;
    }

    /** Строки активной техкарты (для админки и AI-черновиков). */
    public List<RecipeLine> activeLines(long tenantId, String variantId) {
        return jdbc.sql("""
                        SELECT rl.product_id, rl.net_qty, rl.loss_bp FROM recipe_lines rl
                        JOIN recipe_versions rv ON rv.id = rl.version_id
                        WHERE rv.tenant_id = ? AND rv.variant_id = ? AND rv.status = 'ACTIVE'""")
                .params(tenantId, variantId)
                .query((rs, n) -> new RecipeLine(rs.getString(1), rs.getLong(2), (Integer) rs.getObject(3)))
                .list();
    }

    private static Integer minutes(Integer hours) {
        return hours == null ? null : hours * 60;
    }
}
