package ru.sphere.stock.domain;

import java.util.Map;

/**
 * Стоп-лист с количеством (ТЗ 5.7): доступные порции варианта = минимум по продуктам его
 * раскрытой техкарты ⌊доступно / брутто на порцию⌋. Считается для каждого варианта отдельно,
 * поэтому «осталось N» — верхняя граница: блюда делят общие продукты.
 */
public final class StopList {

    public static final int LOW_PORTIONS = 3;

    /**
     * @param tracked  есть ли у варианта техкарта; без неё склад его не ограничивает
     * @param limiting продукт, который ограничивает порции (причина стопа)
     */
    public record Portions(String variantId, boolean tracked, long portions, String limiting) {
        public boolean inStop() {
            return tracked && portions == 0;
        }

        public boolean low() {
            return tracked && portions > 0 && portions <= LOW_PORTIONS;
        }
    }

    private StopList() {
    }

    public static Portions portions(String variantId, Map<String, Long> perPortion, Map<String, Long> available) {
        if (perPortion.isEmpty()) {
            return new Portions(variantId, false, Long.MAX_VALUE, null);
        }
        long best = Long.MAX_VALUE;
        String limiting = null;
        for (Map.Entry<String, Long> e : perPortion.entrySet()) {
            long n = available.getOrDefault(e.getKey(), 0L) / e.getValue();
            if (n < best) {
                best = n;
                limiting = e.getKey();
            }
        }
        return new Portions(variantId, true, best, limiting);
    }
}
