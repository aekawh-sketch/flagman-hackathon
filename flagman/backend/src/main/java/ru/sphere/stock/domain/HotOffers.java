package ru.sphere.stock.domain;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Горячие предложения (ТЗ 5.10, критерий К3): блюда, продажа которых спасёт продукты,
 * которые иначе пропадут.
 *
 * <ol>
 *   <li>Что реально пропадёт — {@link RiskAnalyzer}.</li>
 *   <li>Срочность и 3. ценность одной порции — {@link #contribution}.</li>
 *   <li value="4">Жадный отбор с разнообразием: выбрали лучшее блюдо → считаем, что продвижение
 *       даст E доп. продаж → вычитаем спасённое из «под угрозой» → пересчитываем остальных.
 *       Так продукт из пяти блюд не учитывается пять раз, и одно сырьё не забивает весь список.</li>
 *   <li>Объяснение — из самого большого слагаемого, {@link #explain}.</li>
 * </ol>
 */
public final class HotOffers {

    public static final int DEFAULT_LIMIT = 5;
    /** Доля обычных продаж варианта, которую добавляет продвижение (допущение, ТЗ 5.10 шаг 4). */
    public static final double PROMO_UPLIFT = 0.3;
    public static final double MIN_EXTRA_SALES = 2;

    /**
     * Что видит оценка по одному продукту.
     *
     * @param atRisk          сколько продукта ещё под угрозой (уже за вычетом выбранных блюд)
     * @param hoursLeft       часов до срока самой ранней рискованной партии
     * @param soonWindowHours окно «скоро истекает» этой партии, ч (ТЗ 5.2)
     * @param unitCostKop     цена единицы этой партии, коп.; 0 — цена неизвестна
     * @param ratePerOpenHour обычный расход продукта в рабочий час (для «дней продаж», если нет цены)
     */
    public record ProductRisk(ProductInfo product, long atRisk, double hoursLeft, double soonWindowHours,
                              double unitCostKop, double ratePerOpenHour) {
    }

    /** Слагаемое оценки: вклад одного продукта. */
    public record Factor(String productId, long grossPerPortion, long atRisk, double hoursLeft,
                         long lossKop, double value) {
    }

    public record Offer(String variantId, double score, List<Factor> factors, double expectedExtraSales) {
        public Factor main() {
            return factors.stream().max(Comparator.comparingDouble(Factor::value)).orElseThrow();
        }
    }

    private HotOffers() {
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Шаги 2–3: оценка вклада одного продукта в ценность одной проданной порции.
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Сколько «спасает» одна порция по одному продукту, с поправкой на срочность (ТЗ 5.10):
     * min(брутто, под угрозой) × цена единицы × U, где U = 1 / (1 + часов до срока / окно «скоро истекает»).
     *
     * <p>Цена неизвестна — 0: рубли не посчитать, а смешивать их с другими единицами нельзя — сравнение
     * блюд перестанет быть честным. Цена приходит с накладной, так что на практике она есть почти всегда.
     *
     * @param grossPerPortion брутто продукта на одну порцию варианта
     * @param risk            что сейчас под угрозой по этому продукту (atRisk > 0 гарантировано)
     * @return вклад в оценку, коп. «спасённого» с поправкой на срочность; 0 — продукт этому блюду не помогает
     */
    static double contribution(long grossPerPortion, ProductRisk risk) {
        // Порция спасает не больше, чем реально пропадёт: блюдо, берущее больше продукта, лишней заслуги не получает
        long saved = Math.min(grossPerPortion, risk.atRisk());
        if (saved <= 0 || risk.unitCostKop() <= 0) {
            return 0;
        }
        // Срочность растёт к концу срока; окно «скоро» — масштаб: через одно окно до срока U = ½
        double urgency = 1 / (1 + risk.hoursLeft() / Math.max(risk.soonWindowHours(), 1));
        return saved * risk.unitCostKop() * urgency;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Шаг 4: жадный отбор с разнообразием.
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * @param portions      стоп-лист: кандидаты — только варианты с порциями > 0
     * @param risks         шаг 1 по каждому продукту
     * @param rates         обычный расход продукта в рабочий час
     * @param expectedSales обычные продажи варианта за горизонт (для E)
     */
    public static List<Offer> compute(Catalog catalog,
                                      Map<String, StopList.Portions> portions,
                                      Map<String, List<RiskAnalyzer.BatchRisk>> risks,
                                      Map<String, Double> rates,
                                      Map<String, Double> expectedSales,
                                      Instant now,
                                      int limit) {
        RiskState state = new RiskState(catalog, risks, rates, now);
        if (state.isEmpty()) {
            return List.of();
        }
        Map<String, Map<String, Long>> perPortion = new HashMap<>();
        for (StopList.Portions sp : portions.values()) {
            if (sp.tracked() && sp.portions() > 0) {
                perPortion.put(sp.variantId(), Requirements.perPortion(sp.variantId(), catalog));
            }
        }
        List<Offer> chosen = new ArrayList<>();
        Set<String> taken = new HashSet<>();
        while (chosen.size() < limit) {
            Offer best = null;
            for (Map.Entry<String, Map<String, Long>> e : perPortion.entrySet()) {
                if (taken.contains(e.getKey())) {
                    continue;
                }
                Offer o = score(e.getKey(), e.getValue(), state);
                if (o != null && (best == null || o.score() > best.score()
                        || (o.score() == best.score() && o.variantId().compareTo(best.variantId()) < 0))) {
                    best = o;
                }
            }
            if (best == null) {
                break;
            }
            long maxPortions = portions.get(best.variantId()).portions();
            double extra = Math.min(maxPortions,
                    Math.max(MIN_EXTRA_SALES, PROMO_UPLIFT * expectedSales.getOrDefault(best.variantId(), 0.0)));
            Offer withExtra = new Offer(best.variantId(), best.score(), best.factors(), extra);
            chosen.add(withExtra);
            taken.add(best.variantId());
            perPortion.get(best.variantId()).forEach((pid, gross) -> state.reduce(pid, Math.round(extra * gross)));
        }
        return chosen;
    }

    private static Offer score(String variantId, Map<String, Long> perPortion, RiskState state) {
        List<Factor> factors = new ArrayList<>();
        double total = 0;
        for (Map.Entry<String, Long> e : perPortion.entrySet()) {
            ProductRisk r = state.view(e.getKey());
            if (r == null) {
                continue;
            }
            double v = contribution(e.getValue(), r);
            if (v > 0) {
                factors.add(new Factor(e.getKey(), e.getValue(), r.atRisk(), r.hoursLeft(),
                        state.lossKop(e.getKey()), v));
                total += v;
            }
        }
        return factors.isEmpty() ? null : new Offer(variantId, total, List.copyOf(factors), 0);
    }

    /** Остаток «под угрозой» по партиям; уменьшается, когда выбираем блюдо. */
    private static final class RiskState {
        private final Catalog catalog;
        private final Map<String, Double> rates;
        private final Instant now;
        private final Map<String, List<BatchState>> batches = new HashMap<>();
        private final Map<String, long[]> atRisk = new HashMap<>();

        RiskState(Catalog catalog, Map<String, List<RiskAnalyzer.BatchRisk>> risks, Map<String, Double> rates,
                  Instant now) {
            this.catalog = catalog;
            this.rates = rates;
            this.now = now;
            risks.forEach((pid, list) -> {
                if (RiskAnalyzer.totalAtRisk(list) > 0) {
                    batches.put(pid, list.stream().map(RiskAnalyzer.BatchRisk::batch).toList());
                    atRisk.put(pid, list.stream().mapToLong(RiskAnalyzer.BatchRisk::atRisk).toArray());
                }
            });
        }

        boolean isEmpty() {
            return atRisk.isEmpty();
        }

        ProductRisk view(String pid) {
            long[] arr = atRisk.get(pid);
            if (arr == null) {
                return null;
            }
            long total = 0;
            int first = -1;
            for (int i = 0; i < arr.length; i++) {
                total += arr[i];
                if (first < 0 && arr[i] > 0) {
                    first = i;
                }
            }
            if (total <= 0) {
                return null;
            }
            BatchState b = batches.get(pid).get(first);
            ProductInfo p = catalog.product(pid);
            double hoursLeft = Math.max(0, Duration.between(now, b.expiresAt()).toMinutes() / 60.0);
            double soon = ExpiryPolicy.soonWindow(b, p).toMinutes() / 60.0;
            return new ProductRisk(p, total, hoursLeft, soon, b.unitCostKop(), rates.getOrDefault(pid, 0.0));
        }

        long lossKop(String pid) {
            long[] arr = atRisk.get(pid);
            List<BatchState> bs = batches.get(pid);
            long sum = 0;
            for (int i = 0; i < arr.length; i++) {
                sum += bs.get(i).costOf(arr[i]);
            }
            return sum;
        }

        /** Продвижение продаст {@code qty}: по FEFO это уменьшает риск самых ранних партий. */
        void reduce(String pid, long qty) {
            long[] arr = atRisk.get(pid);
            if (arr == null) {
                return;
            }
            for (int i = 0; i < arr.length && qty > 0; i++) {
                long d = Math.min(arr[i], qty);
                arr[i] -= d;
                qty -= d;
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Шаг 5: объяснение.
    // ─────────────────────────────────────────────────────────────────────────────

    public static String explain(Offer o, Catalog catalog) {
        Factor m = o.main();
        ProductInfo p = catalog.product(m.productId());
        StringBuilder sb = new StringBuilder();
        sb.append(p.name()).append(": под угрозой ").append(p.format(m.atRisk()))
                .append(", истекает через ").append(humanHours(m.hoursLeft()));
        if (m.lossKop() > 0) {
            sb.append(", пропадёт ≈ ").append(Money.format(roundRub(m.lossKop())));
        }
        sb.append(". Одна порция расходует ").append(p.format(m.grossPerPortion())).append('.');
        List<Factor> others = o.factors().stream().filter(f -> f != m)
                .sorted(Comparator.comparingDouble(Factor::value).reversed()).toList();
        if (!others.isEmpty()) {
            sb.append(" Также помогает: ");
            for (int i = 0; i < others.size(); i++) {
                Factor f = others.get(i);
                if (i > 0) {
                    sb.append(", ");
                }
                sb.append(catalog.product(f.productId()).name().toLowerCase())
                        .append(" (истекает через ").append(humanHours(f.hoursLeft())).append(')');
            }
            sb.append('.');
        }
        return sb.toString();
    }

    private static long roundRub(long kop) {
        return Math.round(kop / 100.0) * 100;
    }

    public static String humanHours(double hours) {
        if (hours < 1) {
            return Math.max(1, Math.round(hours * 60)) + Unit.NBSP + "мин";
        }
        if (hours < 48) {
            return Math.round(hours) + Unit.NBSP + "ч";
        }
        return Math.round(hours / 24) + Unit.NBSP + "дн.";
    }
}
