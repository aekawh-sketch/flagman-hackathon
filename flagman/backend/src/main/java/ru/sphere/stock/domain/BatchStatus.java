package ru.sphere.stock.domain;

/** Статус партии по сроку (ТЗ 5.2). */
public enum BatchStatus {
    FRESH,
    SOON,
    CRITICAL,
    EXPIRED
}
