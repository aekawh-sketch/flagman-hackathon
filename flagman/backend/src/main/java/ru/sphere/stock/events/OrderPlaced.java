package ru.sphere.stock.events;

/**
 * Создан новый заказ (не повтор того же externalId). Публикуется внутри транзакции заказа, обрабатывается
 * после коммита: чек на кухню печатается только для заказа, который действительно сохранён (ТЗ 16.15).
 */
public record OrderPlaced(String locationId, long orderId) {
}
