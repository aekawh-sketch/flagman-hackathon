package ru.sphere.stock.domain;

/**
 * Строка техкарты: продукт и нетто на порцию (ТЗ 5.4).
 *
 * @param lossBpOverride свой % потерь для этой строки (картофель для фри и для пюре чистится
 *                       по-разному); {@code null} — берём из карточки продукта
 */
public record RecipeLine(String productId, long netQty, Integer lossBpOverride) {

    public RecipeLine {
        if (netQty <= 0) {
            throw new IllegalArgumentException("netQty must be positive");
        }
    }

    public static RecipeLine of(String productId, long netQty) {
        return new RecipeLine(productId, netQty, null);
    }

    /** Брутто = ⌈нетто / (1 − потери)⌉, в целых числах без ошибок округления. */
    public static long gross(long net, int lossBp) {
        long denom = 10_000L - lossBp;
        return (net * 10_000L + denom - 1) / denom;
    }
}
