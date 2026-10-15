package ru.sphere.stock.ledger;

/** Типы движений журнала (ТЗ 6.3). */
public enum MovementType {
    RECEIPT("Приход"),
    ORDER("Расход по заказу"),
    PRODUCTION_USE("Расход на заготовку"),
    PRODUCTION_OUT("Выход заготовки"),
    OPEN_OUT("Вскрытие: отделено"),
    OPEN_IN("Вскрытие: подпартия"),
    ORDER_RETURN("Возврат по отмене"),
    WRITEOFF_EXPIRED("Списание: просрочка"),
    WRITEOFF_SPOILED("Списание: порча"),
    WRITEOFF_DAMAGED("Списание: бой, пролив"),
    WRITEOFF_OTHER("Списание: прочее"),
    WRITEOFF_RECALL("Списание: отзыв"),
    WRITEOFF_SHORTAGE("Списание: недостача"),
    SURPLUS("Излишек инвентаризации"),
    RETURN_SUPPLIER("Возврат поставщику");

    private final String title;

    MovementType(String title) {
        this.title = title;
    }

    public String title() {
        return title;
    }

    /** Потери для аналитики списаний (ТЗ 5.12, Д2). */
    public boolean isLoss() {
        return name().startsWith("WRITEOFF_");
    }

    /** Ручное списание — то, что проверяет антифрод. */
    public boolean isManualWriteoff() {
        return this == WRITEOFF_SPOILED || this == WRITEOFF_DAMAGED || this == WRITEOFF_OTHER;
    }

    /** Расход «в продажу» — на нём строится прогноз (списания не учитываются, ТЗ 5.9). */
    public boolean isConsumption() {
        return this == ORDER || this == PRODUCTION_USE;
    }
}
