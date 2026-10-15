package ru.sphere.stock.domain;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Разворачивает заказ в потребность по продуктам (ТЗ 5.5, шаг 2): техкарта каждого варианта ×
 * количество, сеты раскрываются рекурсивно, всё складывается в брутто. Сложение до проверки
 * обязательно: два блюда заказа могут расходовать один продукт.
 */
public final class Requirements {

    /**
     * @param total   брутто по продуктам на весь заказ
     * @param perUnit брутто по продуктам на одну единицу каждой строки (индексы как у строк заказа)
     */
    public record Need(List<OrderLine> lines, Map<String, Long> total, List<Map<String, Long>> perUnit) {

        /** Сколько продукта требует строка целиком. */
        public long lineNeed(int lineIndex, String productId) {
            return perUnit.get(lineIndex).getOrDefault(productId, 0L) * lines.get(lineIndex).qty();
        }
    }

    private Requirements() {
    }

    /** Брутто на одну порцию варианта. Пустая карта — у варианта нет техкарты. */
    public static Map<String, Long> perPortion(String variantId, Catalog catalog) {
        Map<String, Long> acc = new LinkedHashMap<>();
        addPortion(variantId, 1, catalog, acc, new HashSet<>());
        return acc;
    }

    private static void addPortion(String variantId, long times, Catalog catalog,
                                   Map<String, Long> acc, Set<String> path) {
        if (!path.add(variantId)) {
            throw new IllegalStateException("Цикл в составе сета: " + variantId);
        }
        VariantDef v = catalog.variant(variantId);
        if (v == null) {
            throw new IllegalArgumentException("Неизвестный вариант: " + variantId);
        }
        if (v.isSet()) {
            for (VariantDef.SetItem item : v.setItems()) {
                addPortion(item.variantId(), times * item.qty(), catalog, acc, path);
            }
        } else {
            for (RecipeLine line : v.lines()) {
                ProductInfo p = catalog.product(line.productId());
                int loss = line.lossBpOverride() != null ? line.lossBpOverride() : p.lossBp();
                acc.merge(line.productId(), RecipeLine.gross(line.netQty(), loss) * times, Long::sum);
            }
        }
        path.remove(variantId);
    }

    public static Need expand(List<OrderLine> lines, Catalog catalog) {
        Map<String, Long> total = new LinkedHashMap<>();
        List<Map<String, Long>> perUnit = new ArrayList<>();
        for (OrderLine line : lines) {
            Map<String, Long> unit = perPortion(line.variantId(), catalog);
            perUnit.add(unit);
            unit.forEach((pid, g) -> total.merge(pid, g * line.qty(), Long::sum));
        }
        return new Need(List.copyOf(lines), total, perUnit);
    }
}
