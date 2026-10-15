package ru.sphere.stock.domain;

import java.util.Locale;

/** Деньги — целые копейки (ТЗ 4.2). */
public final class Money {

    private Money() {
    }

    /**
     * Доля суммы партии, приходящаяся на {@code qty} из {@code qtyInitial}, с округлением до копейки.
     * Целочисленная арифметика: никаких ошибок округления double.
     */
    public static long share(long totalKop, long qty, long qtyInitial) {
        if (qtyInitial <= 0 || qty == 0 || totalKop == 0) {
            return 0;
        }
        long sign = Long.signum(qty) * Long.signum(totalKop);
        long a = Math.abs(totalKop) * Math.abs(qty);
        return sign * ((2 * a + qtyInitial) / (2 * qtyInitial));
    }

    /** «1 234,50 ₽» — разряды и знак рубля через неразрывный пробел. */
    public static String format(long kop) {
        long rub = Math.abs(kop) / 100;
        long k = Math.abs(kop) % 100;
        String rubStr = String.format(Locale.ROOT, "%,d", rub).replace(",", Unit.NBSP);
        String s = k == 0 ? rubStr : rubStr + "," + String.format("%02d", k);
        return (kop < 0 ? "−" : "") + s + Unit.NBSP + "₽";
    }
}
