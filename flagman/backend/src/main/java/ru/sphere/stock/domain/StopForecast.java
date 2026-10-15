package ru.sphere.stock.domain;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Прогноз стоп-листа (ТЗ 5.12, Д4): проигрываем следующие часы — расход по FEFO плюс истечение
 * партий — и находим, когда у варианта кончатся порции и почему.
 */
public final class StopForecast {

    public enum Cause {
        ALREADY,
        CONSUMED,
        EXPIRED
    }

    public record Eta(String variantId, Instant at, String limitingProductId, Cause cause) {
    }

    private StopForecast() {
    }

    /**
     * @param perPortion брутто на порцию для отслеживаемых вариантов
     * @param batches    партии по продуктам
     * @param rates      расход продукта в рабочий час
     */
    public static List<Eta> forecast(Map<String, Map<String, Long>> perPortion,
                                     Map<String, ? extends Collection<BatchState>> batches,
                                     Map<String, Double> rates, OpenHours hours,
                                     Instant now, Duration horizon, Duration step) {
        // Состояние: по продукту — остатки партий в порядке FEFO (double: расход дробный).
        Map<String, List<BatchState>> order = new HashMap<>();
        Map<String, double[]> left = new HashMap<>();
        batches.forEach((pid, list) -> {
            List<BatchState> o = Fefo.usableInOrder(list, now);
            order.put(pid, o);
            left.put(pid, o.stream().mapToDouble(b -> b.availableAt(now)).toArray());
        });

        List<Eta> out = new ArrayList<>();
        Map<String, Map<String, Long>> pending = new HashMap<>(perPortion);
        // Уже в стопе.
        for (var it = pending.entrySet().iterator(); it.hasNext(); ) {
            var e = it.next();
            String lim = limiting(e.getValue(), left);
            if (lim != null) {
                out.add(new Eta(e.getKey(), now, lim, Cause.ALREADY));
                it.remove();
            }
        }
        Map<String, Double> consumedStep = new HashMap<>();
        Map<String, Double> expiredStep = new HashMap<>();
        for (Instant t = now; t.isBefore(now.plus(horizon)) && !pending.isEmpty(); t = t.plus(step)) {
            Instant next = t.plus(step);
            consumedStep.clear();
            expiredStep.clear();
            for (Map.Entry<String, double[]> e : left.entrySet()) {
                String pid = e.getKey();
                double[] q = e.getValue();
                List<BatchState> o = order.get(pid);
                double demand = rates.getOrDefault(pid, 0.0) * hours.hoursBetween(t, next);
                for (int i = 0; i < q.length && demand > 0; i++) {
                    if (o.get(i).expiresAt().isAfter(t) && q[i] > 0) {
                        double d = Math.min(q[i], demand);
                        q[i] -= d;
                        demand -= d;
                        consumedStep.merge(pid, d, Double::sum);
                    }
                }
                for (int i = 0; i < q.length; i++) {
                    if (!o.get(i).expiresAt().isAfter(next) && q[i] > 0) {
                        expiredStep.merge(pid, q[i], Double::sum);
                        q[i] = 0;
                    }
                }
            }
            for (var it = pending.entrySet().iterator(); it.hasNext(); ) {
                var e = it.next();
                String lim = limiting(e.getValue(), left);
                if (lim != null) {
                    Cause cause = expiredStep.getOrDefault(lim, 0.0) > consumedStep.getOrDefault(lim, 0.0)
                            ? Cause.EXPIRED : Cause.CONSUMED;
                    out.add(new Eta(e.getKey(), next, lim, cause));
                    it.remove();
                }
            }
        }
        return out;
    }

    /** Продукт, из-за которого порций 0, или {@code null}, если порции есть. */
    private static String limiting(Map<String, Long> perPortion, Map<String, double[]> left) {
        for (Map.Entry<String, Long> e : perPortion.entrySet()) {
            double[] q = left.get(e.getKey());
            double total = 0;
            if (q != null) {
                for (double v : q) {
                    total += v;
                }
            }
            if (Math.floor(total + 1e-9) < e.getValue()) {
                return e.getKey();
            }
        }
        return null;
    }
}
