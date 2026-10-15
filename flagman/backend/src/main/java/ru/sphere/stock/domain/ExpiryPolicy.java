package ru.sphere.stock.domain;

import java.time.Duration;
import java.time.Instant;

/**
 * Окна «скоро истекает» и «критично» и статус партии (ТЗ 5.2, 4.4).
 *
 * <p>Окно «скоро» = порог продукта, иначе 25% срока хранения партии, но в пределах 1–72 ч.
 * Окно «критично» = порог продукта, иначе ¼ окна «скоро». Процент, а не фиксированные 24 ч,
 * нужен для короткоживущих заготовок: варёная тапиока живёт ~4 ч и не должна быть «истекающей»
 * сразу после варки.
 */
public final class ExpiryPolicy {

    static final Duration MIN_SOON = Duration.ofHours(1);
    static final Duration MAX_SOON = Duration.ofHours(72);

    private ExpiryPolicy() {
    }

    public static Duration soonWindow(BatchState b, ProductInfo p) {
        if (p.alertBefore() != null) {
            return p.alertBefore();
        }
        Duration quarter = b.totalLife().dividedBy(4);
        if (quarter.compareTo(MIN_SOON) < 0) {
            return MIN_SOON;
        }
        return quarter.compareTo(MAX_SOON) > 0 ? MAX_SOON : quarter;
    }

    public static Duration criticalWindow(BatchState b, ProductInfo p) {
        if (p.criticalBefore() != null) {
            return p.criticalBefore();
        }
        return soonWindow(b, p).dividedBy(4);
    }

    public static BatchStatus status(BatchState b, ProductInfo p, Instant now) {
        Duration left = b.timeLeft(now);
        if (left.isZero() || left.isNegative()) {
            return BatchStatus.EXPIRED;
        }
        if (left.compareTo(criticalWindow(b, p)) <= 0) {
            return BatchStatus.CRITICAL;
        }
        if (left.compareTo(soonWindow(b, p)) <= 0) {
            return BatchStatus.SOON;
        }
        return BatchStatus.FRESH;
    }
}
