package ru.sphere.stock.domain;

import java.time.Duration;
import java.time.Instant;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Общие заготовки для тестов ядра. */
final class Fixtures {

    /** 10:00 по Москве — точка открылась. */
    static final Instant NOW = Instant.parse("2026-10-09T07:00:00Z");
    static final OpenHours HOURS = OpenHours.defaultMsk();

    private Fixtures() {
    }

    static Instant inHours(double h) {
        return NOW.plus(Duration.ofMinutes(Math.round(h * 60)));
    }

    /** Партия: пришла {@code ageHours} назад, истекает через {@code leftHours}, цена — за всю партию. */
    static BatchState batch(long id, String pid, long qty, double ageHours, double leftHours, long costKop) {
        Instant base = inHours(-ageHours);
        return new BatchState(id, pid, qty, 0, base, inHours(leftHours), base, false, false, costKop, qty);
    }

    static BatchState batch(long id, String pid, long qty, double ageHours, double leftHours) {
        return batch(id, pid, qty, ageHours, leftHours, 0);
    }

    /** Каталог в памяти. */
    static final class MemCatalog implements Catalog {
        final Map<String, ProductInfo> products = new LinkedHashMap<>();
        final Map<String, VariantDef> variants = new LinkedHashMap<>();

        MemCatalog product(ProductInfo p) {
            products.put(p.id(), p);
            return this;
        }

        MemCatalog dish(String id, long priceKop, RecipeLine... lines) {
            variants.put(id, new VariantDef(id, id, id, priceKop, 1, List.of(lines), List.of()));
            return this;
        }

        MemCatalog set(String id, VariantDef.SetItem... items) {
            variants.put(id, new VariantDef(id, id, id, 0, 0, List.of(), List.of(items)));
            return this;
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
    }

    static ProductInfo raw(String id) {
        return ProductInfo.builder(id, id, Unit.G).build();
    }
}
