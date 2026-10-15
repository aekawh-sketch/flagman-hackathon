package ru.sphere.stock.domain;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;

/**
 * FEFO — First Expired, First Out (ТЗ 5.2): первой расходуется партия, которая раньше испортится.
 * При равных сроках — сначала вскрытая, потом пришедшая раньше, потом с меньшим ID,
 * чтобы порядок был всегда однозначным.
 */
public final class Fefo {

    public static final Comparator<BatchState> ORDER = Comparator
            .comparing(BatchState::expiresAt)
            .thenComparing(b -> !b.opened())
            .thenComparing(BatchState::receivedAt)
            .thenComparingLong(BatchState::id);

    /** Сколько взять из какой партии. */
    public record Take(BatchState batch, long qty) {
        public long cost() {
            return batch.costOf(qty);
        }
    }

    private Fefo() {
    }

    /** Годные партии в порядке FEFO. */
    public static List<BatchState> usableInOrder(Collection<BatchState> batches, Instant now) {
        return batches.stream()
                .filter(b -> b.availableAt(now) > 0)
                .sorted(ORDER)
                .toList();
    }

    public static long available(Collection<BatchState> batches, Instant now) {
        return batches.stream().mapToLong(b -> b.availableAt(now)).sum();
    }

    /**
     * Распределить расход {@code need} по партиям. Вызывающий обязан заранее проверить,
     * что доступного хватает — иначе {@link IllegalStateException}.
     */
    public static List<Take> allocate(Collection<BatchState> batches, long need, Instant now) {
        if (need < 0) {
            throw new IllegalArgumentException("need < 0");
        }
        List<Take> takes = new ArrayList<>();
        long rest = need;
        for (BatchState b : usableInOrder(batches, now)) {
            if (rest == 0) {
                break;
            }
            long take = Math.min(rest, b.availableAt(now));
            takes.add(new Take(b, take));
            rest -= take;
        }
        if (rest > 0) {
            throw new IllegalStateException("not enough stock: short by " + rest);
        }
        return takes;
    }
}
