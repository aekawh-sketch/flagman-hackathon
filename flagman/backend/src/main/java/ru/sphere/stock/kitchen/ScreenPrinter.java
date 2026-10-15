package ru.sphere.stock.kitchen;

import org.springframework.stereotype.Component;

/** Принтера нет — чек показывается на экране кухни (по умолчанию у новой точки). */
@Component
class ScreenPrinter implements PrinterDriver {

    @Override
    public String mode() {
        return "SCREEN";
    }

    @Override
    public String target(PrinterConfig printer) {
        return "экран кухни";
    }

    @Override
    public String print(KitchenTicket ticket, PrinterConfig printer) {
        return "SHOWN";
    }
}
