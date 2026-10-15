package ru.sphere.stock.catalog;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.stereotype.Service;
import ru.sphere.stock.tenant.TenantDirectory;
import ru.sphere.stock.domain.Catalog;
import ru.sphere.stock.domain.ProductInfo;
import ru.sphere.stock.domain.ProductKind;
import ru.sphere.stock.domain.RecipeLine;
import ru.sphere.stock.domain.Unit;
import ru.sphere.stock.domain.VariantDef;

/**
 * Каталог продуктов, блюд и активных техкарт. Читается из базы целиком в неизменяемый снимок —
 * его и получают алгоритмы ядра. Снимок сбрасывается при любом изменении каталога.
 */
@Service
public class CatalogService {

    public record DishInfo(String id, String name, String category, String description, int sort) {
    }

    public record VariantInfo(String id, String dishId, String name, String label, long priceKop,
                              boolean isSet, int sort) {
    }

    /** Активная техкарта заготовки: строки заданы на выход {@code yield}. */
    public record SemiRecipe(String productId, long versionId, long yield, List<RecipeLine> lines) {
    }

    public record ProductExtra(String category, Long expectedDailyUse, Double lastUnitCostKop, boolean needsReview) {
    }

    /** Неизменяемый снимок каталога. */
    public static final class Snapshot implements Catalog {
        private final Map<String, ProductInfo> products;
        private final Map<String, ProductExtra> productExtra;
        private final Map<String, DishInfo> dishes;
        private final Map<String, VariantInfo> variantInfo;
        private final Map<String, VariantDef> variants;
        private final Map<String, SemiRecipe> semi;

        Snapshot(Map<String, ProductInfo> products, Map<String, ProductExtra> productExtra,
                 Map<String, DishInfo> dishes, Map<String, VariantInfo> variantInfo,
                 Map<String, VariantDef> variants, Map<String, SemiRecipe> semi) {
            this.products = products;
            this.productExtra = productExtra;
            this.dishes = dishes;
            this.variantInfo = variantInfo;
            this.variants = variants;
            this.semi = semi;
        }

        @Override
        public ProductInfo product(String productId) {
            return products.get(productId);
        }

        @Override
        public VariantDef variant(String variantId) {
            return variants.get(variantId);
        }

        @Override
        public Collection<VariantDef> variants() {
            return variants.values();
        }

        public Collection<ProductInfo> products() {
            return products.values();
        }

        public ProductExtra extra(String productId) {
            return productExtra.get(productId);
        }

        public Map<String, DishInfo> dishes() {
            return dishes;
        }

        public VariantInfo variantInfo(String variantId) {
            return variantInfo.get(variantId);
        }

        public Collection<VariantInfo> variantInfos() {
            return variantInfo.values();
        }

        public SemiRecipe semi(String productId) {
            return semi.get(productId);
        }

        public Collection<SemiRecipe> semis() {
            return semi.values();
        }

        public String productName(String productId) {
            ProductInfo p = products.get(productId);
            return p == null ? productId : p.name();
        }

        public String variantName(String variantId) {
            VariantInfo v = variantInfo.get(variantId);
            return v == null ? variantId : v.name();
        }
    }

    private final JdbcClient jdbc;
    private final TenantDirectory tenants;
    /** У каждого предприятия свой каталог (ТЗ 16.4): ID продукта уникален только внутри предприятия. */
    private final Map<Long, Snapshot> snapshots = new ConcurrentHashMap<>();

    public CatalogService(JdbcClient jdbc, TenantDirectory tenants) {
        this.jdbc = jdbc;
        this.tenants = tenants;
    }

    public Snapshot get(long tenantId) {
        return snapshots.computeIfAbsent(tenantId, this::load);
    }

    /** Каталог предприятия, которому принадлежит точка. */
    public Snapshot forLocation(String locationId) {
        return get(tenants.tenantOf(locationId));
    }

    /**
     * Сбросить снимок предприятия. Правку каталога видят только после фиксации транзакции, а фоновые задачи
     * (сроки, антифрод) читают каталог всё время: снимок, перечитанный ими до фиксации, был бы старым — поэтому
     * сбрасываем ещё раз, когда транзакция завершится (и при откате: снимок с несохранёнными правками — тоже).
     */
    public void invalidate(long tenantId) {
        snapshots.remove(tenantId);
        afterTransaction(() -> snapshots.remove(tenantId));
    }

    public void invalidate() {
        snapshots.clear();
        afterTransaction(snapshots::clear);
    }

    private static void afterTransaction(Runnable action) {
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCompletion(int status) {
                    action.run();
                }
            });
        }
    }

    private Snapshot load(long tenantId) {
        Map<String, ProductInfo> products = new LinkedHashMap<>();
        Map<String, ProductExtra> extra = new HashMap<>();
        jdbc.sql("SELECT * FROM products WHERE tenant_id = ? ORDER BY category NULLS LAST, name").param(tenantId).query(rs -> {
            ProductInfo p = mapProduct(rs);
            products.put(p.id(), p);
            extra.put(p.id(), new ProductExtra(rs.getString("category"), (Long) rs.getObject("expected_daily_use"),
                    rs.getObject("last_unit_cost_kop") == null ? null : rs.getDouble("last_unit_cost_kop"),
                    rs.getBoolean("needs_review")));
        });

        Map<String, DishInfo> dishes = new LinkedHashMap<>();
        jdbc.sql("SELECT id, name, category, description, sort FROM dishes WHERE tenant_id = ? ORDER BY sort, name")
                .param(tenantId).query(rs -> {
            dishes.put(rs.getString("id"), new DishInfo(rs.getString("id"), rs.getString("name"),
                    rs.getString("category"), rs.getString("description"), rs.getInt("sort")));
        });

        Map<String, VariantInfo> infos = new LinkedHashMap<>();
        jdbc.sql("""
                SELECT v.* FROM dish_variants v JOIN dishes d ON d.tenant_id = v.tenant_id AND d.id = v.dish_id
                WHERE v.tenant_id = ? AND v.active ORDER BY d.sort, d.name, v.sort""").param(tenantId).query(rs -> {
            infos.put(rs.getString("id"), new VariantInfo(rs.getString("id"), rs.getString("dish_id"),
                    rs.getString("name"), rs.getString("variant_label"), rs.getLong("price_kop"),
                    rs.getBoolean("is_set"), rs.getInt("sort")));
        });

        Map<String, Long> versionOf = new HashMap<>();
        Map<String, List<RecipeLine>> linesOf = new HashMap<>();
        jdbc.sql("""
                SELECT rv.variant_id, rv.id, rl.product_id, rl.net_qty, rl.loss_bp
                FROM recipe_versions rv JOIN recipe_lines rl ON rl.version_id = rv.id
                WHERE rv.tenant_id = ? AND rv.status = 'ACTIVE' AND rv.variant_id IS NOT NULL
                ORDER BY rv.variant_id, rl.product_id""").param(tenantId).query(rs -> {
            String vid = rs.getString(1);
            versionOf.put(vid, rs.getLong(2));
            linesOf.computeIfAbsent(vid, k -> new ArrayList<>()).add(mapLine(rs));
        });

        Map<String, List<VariantDef.SetItem>> setItems = new HashMap<>();
        jdbc.sql("SELECT set_variant_id, variant_id, qty FROM set_items WHERE tenant_id = ? ORDER BY set_variant_id, variant_id")
                .param(tenantId).query(rs -> {
                    setItems.computeIfAbsent(rs.getString(1), k -> new ArrayList<>())
                            .add(new VariantDef.SetItem(rs.getString(2), rs.getInt(3)));
                });

        Map<String, VariantDef> variants = new LinkedHashMap<>();
        for (VariantInfo v : infos.values()) {
            variants.put(v.id(), new VariantDef(v.id(), v.dishId(), v.name(), v.priceKop(),
                    versionOf.getOrDefault(v.id(), 0L), linesOf.get(v.id()), setItems.get(v.id())));
        }

        Map<String, SemiRecipe> semi = new LinkedHashMap<>();
        Map<String, long[]> semiHead = new HashMap<>();
        Map<String, List<RecipeLine>> semiLines = new HashMap<>();
        jdbc.sql("""
                SELECT rv.semi_product_id, rv.id, rv.yield_qty, rl.product_id, rl.net_qty, rl.loss_bp
                FROM recipe_versions rv JOIN recipe_lines rl ON rl.version_id = rv.id
                WHERE rv.tenant_id = ? AND rv.status = 'ACTIVE' AND rv.semi_product_id IS NOT NULL
                ORDER BY rv.semi_product_id, rl.product_id""").param(tenantId).query(rs -> {
            String pid = rs.getString(1);
            semiHead.put(pid, new long[]{rs.getLong(2), rs.getLong(3)});
            semiLines.computeIfAbsent(pid, k -> new ArrayList<>()).add(new RecipeLine(rs.getString(4),
                    rs.getLong(5), (Integer) rs.getObject(6)));
        });
        semiHead.forEach((pid, h) -> semi.put(pid, new SemiRecipe(pid, h[0], h[1], List.copyOf(semiLines.get(pid)))));

        return new Snapshot(products, extra, dishes, infos, variants, semi);
    }

    private static RecipeLine mapLine(ResultSet rs) throws SQLException {
        return new RecipeLine(rs.getString("product_id"), rs.getLong("net_qty"), (Integer) rs.getObject("loss_bp"));
    }

    static ProductInfo mapProduct(ResultSet rs) throws SQLException {
        return new ProductInfo(
                rs.getString("id"),
                rs.getString("name"),
                Unit.valueOf(rs.getString("unit")),
                ProductKind.valueOf(rs.getString("kind")),
                (Long) rs.getObject("pack_size"),
                minutes(rs, "after_open_minutes"),
                rs.getInt("loss_bp"),
                minutes(rs, "alert_before_minutes"),
                minutes(rs, "critical_before_minutes"),
                minutes(rs, "shelf_life_minutes"),
                minutes(rs, "lead_time_minutes"));
    }

    private static Duration minutes(ResultSet rs, String col) throws SQLException {
        Object v = rs.getObject(col);
        return v == null ? null : Duration.ofMinutes(((Number) v).longValue());
    }
}
