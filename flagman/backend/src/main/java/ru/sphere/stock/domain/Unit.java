package ru.sphere.stock.domain;

import java.util.Locale;

/** Базовая единица учёта (ТЗ 4.2): количества хранятся целыми числами в г, мл или шт. */
public enum Unit {
    G("г", "кг"),
    ML("мл", "л"),
    PCS("шт", "шт");

    private final String base;
    private final String large;

    Unit(String base, String large) {
        this.base = base;
        this.large = large;
    }

    /** Неразрывный пробел: «1,5 кг» не разъезжается на две строки на узком экране. */
    public static final String NBSP = "\u00A0";

    /** Человекочитаемое количество: 1500 г → «1,5 кг», 300 мл → «300 мл». */
    public String format(long qty) {
        if (this == PCS || Math.abs(qty) < 1000) {
            return qty + NBSP + base;
        }
        double v = qty / 1000.0;
        String s = (v == Math.rint(v)) ? String.valueOf((long) v)
                : String.format(Locale.ROOT, "%.1f", v).replace('.', ',');
        return s + NBSP + large;
    }
}
