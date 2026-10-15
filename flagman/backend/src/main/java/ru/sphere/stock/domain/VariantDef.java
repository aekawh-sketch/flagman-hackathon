package ru.sphere.stock.domain;

import java.util.List;

/**
 * Заказываемый вариант блюда (размер или вид). Либо своя техкарта, либо состав сета.
 *
 * @param recipeVersionId версия техкарты, по которой списываем (ТЗ 6.9); 0 — у сета своей нет
 */
public record VariantDef(
        String id,
        String dishId,
        String name,
        long priceKop,
        long recipeVersionId,
        List<RecipeLine> lines,
        List<SetItem> setItems) {

    /** Позиция сета: вариант и количество. */
    public record SetItem(String variantId, int qty) {
    }

    public VariantDef {
        lines = lines == null ? List.of() : List.copyOf(lines);
        setItems = setItems == null ? List.of() : List.copyOf(setItems);
    }

    public boolean isSet() {
        return !setItems.isEmpty();
    }

    /** Есть ли техкарта вообще: без неё вариант не учитывается складом. */
    public boolean tracked() {
        return isSet() || !lines.isEmpty();
    }
}
