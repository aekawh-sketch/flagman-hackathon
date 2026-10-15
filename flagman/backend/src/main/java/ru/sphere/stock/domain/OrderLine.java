package ru.sphere.stock.domain;

/** Строка заказа: вариант × количество. */
public record OrderLine(String variantId, int qty) {

    public OrderLine {
        if (qty <= 0) {
            throw new IllegalArgumentException("qty must be positive");
        }
    }
}
