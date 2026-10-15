package ru.sphere.stock.domain;

import java.time.Duration;
import java.time.Instant;

/**
 * Снимок партии для алгоритмов (ТЗ 5.2).
 *
 * @param qtyLeft      текущий остаток
 * @param heldQty      удержано заявками на списание — не продаётся (ТЗ 6.5)
 * @param baseDate     от чего считался срок (дата поставки, момент вскрытия или приготовления)
 * @param expiresAt    срок годности — неизменяем после приёмки
 * @param costTotalKop сумма закупки всей партии
 * @param qtyInitial   начальное количество (для цены единицы)
 */
public record BatchState(
        long id,
        String productId,
        long qtyLeft,
        long heldQty,
        Instant baseDate,
        Instant expiresAt,
        Instant receivedAt,
        boolean opened,
        boolean blocked,
        long costTotalKop,
        long qtyInitial) {

    /** Можно ли брать из партии в момент {@code now}: не просрочена и не заблокирована. */
    public boolean usableAt(Instant now) {
        return !blocked && now.isBefore(expiresAt);
    }

    /** Доступно для продажи: остаток минус удержанное, если партия годна. */
    public long availableAt(Instant now) {
        return usableAt(now) ? Math.max(0, qtyLeft - heldQty) : 0;
    }

    public Duration totalLife() {
        return Duration.between(baseDate, expiresAt);
    }

    public Duration timeLeft(Instant now) {
        return Duration.between(now, expiresAt);
    }

    /** Себестоимость {@code qty} единиц из этой партии. */
    public long costOf(long qty) {
        return Money.share(costTotalKop, qty, qtyInitial);
    }

    public double unitCostKop() {
        return qtyInitial <= 0 ? 0 : (double) costTotalKop / qtyInitial;
    }

    public BatchState withQtyLeft(long newQty) {
        return new BatchState(id, productId, newQty, heldQty, baseDate, expiresAt, receivedAt,
                opened, blocked, costTotalKop, qtyInitial);
    }
}
