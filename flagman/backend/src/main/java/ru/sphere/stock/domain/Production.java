package ru.sphere.stock.domain;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Приготовление заготовки (ТЗ 5.4, п. 12): техкарта масштабируется на нужный выход →
 * сырьё списывается по FEFO → новая партия заготовки.
 * Срок = min(сейчас + срок заготовки, самый ранний срок использованного сырья) — консервативно.
 */
public final class Production {

    public record Plan(String semiId, long qty, Map<String, Long> needs, List<Fefo.Take> takes,
                       Instant expiresAt, long costKop) {
    }

    public record Shortage(String productId, long need, long available) {
    }

    /** Либо план, либо список нехваток. */
    public record Result(Plan plan, List<Shortage> shortages) {
        public boolean ok() {
            return plan != null;
        }
    }

    private Production() {
    }

    /**
     * Брутто сырья на выход {@code amount}, если техкарта задана на выход {@code yield}:
     * ⌈нетто × amount / yield / (1 − потери)⌉ в целых числах.
     */
    public static Map<String, Long> needs(List<RecipeLine> lines, long yield, long amount, Catalog catalog) {
        Map<String, Long> out = new LinkedHashMap<>();
        for (RecipeLine l : lines) {
            int loss = l.lossBpOverride() != null ? l.lossBpOverride() : catalog.product(l.productId()).lossBp();
            long num = l.netQty() * amount * 10_000L;
            long den = yield * (10_000L - loss);
            out.merge(l.productId(), (num + den - 1) / den, Long::sum);
        }
        return out;
    }

    public static Result plan(ProductInfo semi, List<RecipeLine> lines, long yield, long amount,
                              Map<String, List<BatchState>> batchesByProduct, Catalog catalog, Instant now) {
        if (semi.shelfLife() == null) {
            throw new IllegalArgumentException("У заготовки не задан срок хранения: " + semi.name());
        }
        Map<String, Long> needs = needs(lines, yield, amount, catalog);
        List<Shortage> shortages = new ArrayList<>();
        needs.forEach((pid, need) -> {
            long avail = Fefo.available(batchesByProduct.getOrDefault(pid, List.of()), now);
            if (avail < need) {
                shortages.add(new Shortage(pid, need, avail));
            }
        });
        if (!shortages.isEmpty()) {
            return new Result(null, shortages);
        }
        List<Fefo.Take> takes = new ArrayList<>();
        Instant expires = now.plus(semi.shelfLife());
        long cost = 0;
        for (Map.Entry<String, Long> e : needs.entrySet()) {
            for (Fefo.Take t : Fefo.allocate(batchesByProduct.get(e.getKey()), e.getValue(), now)) {
                takes.add(t);
                cost += t.cost();
                if (t.batch().expiresAt().isBefore(expires)) {
                    expires = t.batch().expiresAt();
                }
            }
        }
        return new Result(new Plan(semi.id(), amount, needs, takes, expires, cost), List.of());
    }

    /** Сколько заготовки можно приготовить из текущего сырья (подсказка в стоп-листе, п. 33). */
    public static long maxAmount(List<RecipeLine> lines, long yield, Map<String, Long> available, Catalog catalog) {
        long best = Long.MAX_VALUE;
        for (RecipeLine l : lines) {
            long perYield = needs(List.of(l), yield, yield, catalog).get(l.productId());
            long avail = available.getOrDefault(l.productId(), 0L);
            best = Math.min(best, avail * yield / perYield);
        }
        return best == Long.MAX_VALUE ? 0 : best;
    }
}
