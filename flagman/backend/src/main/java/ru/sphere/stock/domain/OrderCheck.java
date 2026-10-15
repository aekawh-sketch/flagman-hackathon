package ru.sphere.stock.domain;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Проверка заказа «всё или ничего» (ТЗ 5.5, шаги 4–5) с объяснением отказа:
 * чего не хватает, какие строки сколько требуют и «максимум N» по каждой строке.
 */
public final class OrderCheck {

    /** Вклад строки заказа в потребность продукта. */
    public record Contribution(int lineIndex, String variantId, int qty, long gross) {
    }

    public record Shortage(String productId, long need, long available, List<Contribution> contributions) {
        public long missing() {
            return need - available;
        }
    }

    /** Сколько штук строки поместится, если остальные строки не менять. */
    public record LineMax(int lineIndex, String variantId, int requested, int max) {
    }

    public record Result(List<Shortage> shortages, List<LineMax> maxima) {
        public boolean ok() {
            return shortages.isEmpty();
        }
    }

    private OrderCheck() {
    }

    public static Result check(Requirements.Need need, Map<String, Long> available) {
        List<Shortage> shortages = new ArrayList<>();
        need.total().forEach((pid, total) -> {
            long avail = available.getOrDefault(pid, 0L);
            if (total > avail) {
                List<Contribution> contrib = new ArrayList<>();
                for (int i = 0; i < need.lines().size(); i++) {
                    long g = need.lineNeed(i, pid);
                    if (g > 0) {
                        OrderLine l = need.lines().get(i);
                        contrib.add(new Contribution(i, l.variantId(), l.qty(), g));
                    }
                }
                shortages.add(new Shortage(pid, total, avail, contrib));
            }
        });
        if (shortages.isEmpty()) {
            return new Result(List.of(), List.of());
        }
        List<LineMax> maxima = new ArrayList<>();
        for (int i = 0; i < need.lines().size(); i++) {
            OrderLine line = need.lines().get(i);
            int max = maxForLine(need, i, available);
            if (max < line.qty()) {
                maxima.add(new LineMax(i, line.variantId(), line.qty(), max));
            }
        }
        return new Result(shortages, maxima);
    }

    private static int maxForLine(Requirements.Need need, int i, Map<String, Long> available) {
        long best = Long.MAX_VALUE;
        for (Map.Entry<String, Long> e : need.perUnit().get(i).entrySet()) {
            String pid = e.getKey();
            long perUnit = e.getValue();
            long others = need.total().getOrDefault(pid, 0L) - need.lineNeed(i, pid);
            long room = available.getOrDefault(pid, 0L) - others;
            best = Math.min(best, room <= 0 ? 0 : room / perUnit);
        }
        if (best == Long.MAX_VALUE) {
            return need.lines().get(i).qty();
        }
        return (int) Math.min(best, Integer.MAX_VALUE);
    }
}
