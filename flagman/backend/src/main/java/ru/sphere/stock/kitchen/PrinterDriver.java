package ru.sphere.stock.kitchen;

import java.io.IOException;

/**
 * Куда уходит чек на кухню — стратегия по режиму принтера точки: экран кухни или сетевой термопринтер.
 * Новый способ (облачный агент, Bluetooth) — ещё одна реализация, сервис печати не меняется.
 */
public interface PrinterDriver {

    /** Режим точки, который обслуживает драйвер: SCREEN, NETWORK. */
    String mode();

    /** Подпись цели для журнала чеков: «экран кухни», «192.168.1.50:9100». */
    String target(PrinterConfig printer);

    /** @return статус чека: SHOWN — на экране кухни, PRINTED — напечатан */
    String print(KitchenTicket ticket, PrinterConfig printer) throws IOException;
}
