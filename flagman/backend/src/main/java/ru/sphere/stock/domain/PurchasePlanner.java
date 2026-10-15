package ru.sphere.stock.domain;

import java.time.Duration;
import java.time.Instant;
import java.util.Collection;

/**
 * Предложение поставок (ТЗ 5.9 — базовая часть). Хватить до следующей поставки и не закупить
 * лишнего, что испортится.
 */
public final class PurchasePlanner {

    public static final Duration DEFAULT_LEAD = Duration.ofDays(1);
    public static final Duration DEFAULT_REVIEW = Duration.ofDays(1);
    public static final double DEFAULT_SAFETY_DAYS = 0.5;

    /**
     * @param orderQty       сколько заказать (0 — не нужно)
     * @param survives       сколько годного останется к приходу поставки
     * @param expiresBefore  сколько истечёт до прихода поставки
     * @param dailyRate      расход в день
     * @param cappedByLife   количество урезано сроком хранения новой партии
     * @param noData         нет истории расхода
     */
    public record Suggestion(String productId, long orderQty, long available, long survives, long expiresBefore,
                             double dailyRate, Duration leadTime, boolean cappedByLife, boolean noData) {
    }

    private PurchasePlanner() {
    }

    public static Suggestion plan(ProductInfo p, Collection<BatchState> batches, double ratePerOpenHour,
                                  OpenHours hours, Instant now, Duration review, double safetyDays) {
        Duration lead = p.leadTime() != null ? p.leadTime() : DEFAULT_LEAD;
        Instant arrival = now.plus(lead);
        long available = Fefo.available(batches, now);
        double dailyRate = ratePerOpenHour * hours.hoursPerDay();
        if (ratePerOpenHour <= 0) {
            return new Suggestion(p.id(), 0, available, available, 0, 0, lead, false, true);
        }
        // Проигрываем расход по FEFO и истечения до прихода поставки.
        double absorbed = 0;
        long survives = 0;
        long expiresBefore = 0;
        for (BatchState b : Fefo.usableInOrder(batches, now)) {
            long avail = b.availableAt(now);
            Instant until = b.expiresAt().isBefore(arrival) ? b.expiresAt() : arrival;
            double demand = ratePerOpenHour * hours.hoursBetween(now, until);
            double sold = Math.max(0, Math.min(avail, demand - absorbed));
            absorbed += sold;
            long left = avail - Math.round(sold);
            if (b.expiresAt().isAfter(arrival)) {
                survives += left;
            } else {
                expiresBefore += left;
            }
        }
        double demandAfter = ratePerOpenHour * hours.hoursBetween(arrival, arrival.plus(review))
                + dailyRate * safetyDays;
        double need = Math.max(0, demandAfter - survives);
        boolean capped = false;
        if (p.shelfLife() != null) {
            double cap = ratePerOpenHour * hours.hoursBetween(arrival, arrival.plus(p.shelfLife()));
            if (need > cap) {
                need = cap;
                capped = true;
            }
        }
        long qty = (long) Math.ceil(need);
        if (qty > 0 && p.packSize() != null) {
            qty = ((qty + p.packSize() - 1) / p.packSize()) * p.packSize();
        }
        return new Suggestion(p.id(), qty, available, survives, expiresBefore, dailyRate, lead, capped, false);
    }
}
