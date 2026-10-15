package ru.sphere.stock.kitchen;

import java.time.ZonedDateTime;
import java.util.List;

/**
 * Чек на кухню — что пробили: номер заказа, откуда, когда и блюда. Сет печатается вместе с составом,
 * чтобы повар видел, что собирать.
 *
 * @param number номер заказа в точке; 0 — пробная печать
 */
public record KitchenTicket(long number, String location, String source, ZonedDateTime at, List<Line> lines) {

    /** Строка чека: блюдо, количество и (у сета) входящие блюда. */
    public record Line(String name, int qty, List<Line> items) {
        public Line {
            items = items == null ? List.of() : List.copyOf(items);
        }
    }

    public KitchenTicket {
        lines = lines == null ? List.of() : List.copyOf(lines);
    }
}
