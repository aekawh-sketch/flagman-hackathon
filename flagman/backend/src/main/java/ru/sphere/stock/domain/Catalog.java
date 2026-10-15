package ru.sphere.stock.domain;

import java.util.Collection;

/** Каталог продуктов и вариантов — источник техкарт для алгоритмов. */
public interface Catalog {

    ProductInfo product(String productId);

    VariantDef variant(String variantId);

    Collection<VariantDef> variants();
}
