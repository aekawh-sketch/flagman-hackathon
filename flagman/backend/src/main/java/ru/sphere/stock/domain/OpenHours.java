package ru.sphere.stock.domain;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;

/**
 * Часы работы точки. Расход продуктов бывает только в рабочие часы: партия, истекающая в 3 ночи,
 * ночью не продаётся (ТЗ 5.9, 5.10).
 */
public record OpenHours(LocalTime open, LocalTime close, ZoneId zone) {

    public static final ZoneId MSK = ZoneId.of("Europe/Moscow");

    public static OpenHours defaultMsk() {
        return new OpenHours(LocalTime.of(10, 0), LocalTime.of(23, 0), MSK);
    }

    /** Закрытие после полуночи: например, 10:00–02:00. */
    private boolean overnight() {
        return !close.isAfter(open);
    }

    public double hoursPerDay() {
        Duration d = Duration.between(open, close);
        if (overnight()) {
            d = d.plusHours(24);
        }
        return d.toMillis() / 3_600_000.0;
    }

    /** Сколько рабочих часов в интервале [from, to). */
    public double hoursBetween(Instant from, Instant to) {
        if (!to.isAfter(from)) {
            return 0;
        }
        LocalDate day = from.atZone(zone).toLocalDate().minusDays(1);
        LocalDate last = to.atZone(zone).toLocalDate();
        long millis = 0;
        for (; !day.isAfter(last); day = day.plusDays(1)) {
            Instant start = day.atTime(open).atZone(zone).toInstant();
            Instant end = (overnight() ? day.plusDays(1) : day).atTime(close).atZone(zone).toInstant();
            Instant a = start.isAfter(from) ? start : from;
            Instant b = end.isBefore(to) ? end : to;
            if (b.isAfter(a)) {
                millis += Duration.between(a, b).toMillis();
            }
        }
        return millis / 3_600_000.0;
    }

    /** Время закрытия в день момента {@code at} (для правила аномалий A3). */
    public Instant closingOf(Instant at) {
        LocalDate day = at.atZone(zone).toLocalDate();
        return (overnight() && at.atZone(zone).toLocalTime().isAfter(open) ? day.plusDays(1) : day)
                .atTime(close).atZone(zone).toInstant();
    }
}
