package ru.sphere.stock.domain;

import java.time.Instant;
import java.util.Optional;

/**
 * Срок после вскрытия (ТЗ 5.2, п. 15). Закрытая партия всегда содержит целое число упаковок;
 * остаток начатой упаковки отделяется во «вскрытую подпартию» с коротким сроком.
 */
public final class OpeningRule {

    /** Отделить {@code qty} из партии в подпартию со сроком {@code expiresAt}. */
    public record Split(long parentBatchId, long qty, Instant expiresAt) {
    }

    private OpeningRule() {
    }

    public static boolean applies(ProductInfo p) {
        return p.packSize() != null && p.afterOpen() != null;
    }

    /** Срок вскрытой подпартии: не позже срока родителя. */
    public static Instant openedExpiry(BatchState parent, ProductInfo p, Instant now) {
        Instant byOpening = now.plus(p.afterOpen());
        return byOpening.isBefore(parent.expiresAt()) ? byOpening : parent.expiresAt();
    }

    /**
     * После списания {@code take} из закрытой партии: если осталась начатая упаковка,
     * её остаток уходит во вскрытую подпартию.
     */
    public static Optional<Split> afterTake(BatchState b, long take, ProductInfo p, Instant now) {
        if (b.opened() || !applies(p)) {
            return Optional.empty();
        }
        long remaining = b.qtyLeft() - take;
        long partial = remaining % p.packSize();
        if (partial == 0) {
            return Optional.empty();
        }
        return Optional.of(new Split(b.id(), partial, openedExpiry(b, p, now)));
    }

    /** Ручное действие «Вскрыть N упаковок». */
    public static Split open(BatchState b, int packs, ProductInfo p, Instant now) {
        if (!applies(p)) {
            throw new IllegalArgumentException("У продукта не задана упаковка или срок после вскрытия");
        }
        if (b.opened()) {
            throw new IllegalArgumentException("Партия уже вскрыта");
        }
        long qty = packs * p.packSize();
        if (packs <= 0 || qty > b.availableAt(now)) {
            throw new IllegalArgumentException("Нельзя вскрыть " + packs + " уп.: доступно "
                    + p.format(b.availableAt(now)));
        }
        return new Split(b.id(), qty, openedExpiry(b, p, now));
    }
}
