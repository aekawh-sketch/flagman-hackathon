package ru.sphere.stock.kitchen;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import org.springframework.stereotype.Component;

/**
 * Сетевой термопринтер: RAW-печать по TCP (обычно порт 9100) — байты ESC/POS уходят прямо в принтер,
 * без драйверов. Адрес проверяется ещё раз перед печатью: только сеть ресторана.
 */
@Component
class NetworkPrinter implements PrinterDriver {

    private static final int CONNECT_TIMEOUT_MS = 3000;
    private static final int WRITE_TIMEOUT_MS = 5000;

    @Override
    public String mode() {
        return "NETWORK";
    }

    @Override
    public String target(PrinterConfig printer) {
        return printer.host() + ":" + printer.port();
    }

    @Override
    public String print(KitchenTicket ticket, PrinterConfig printer) throws IOException {
        byte[] bytes = EscPos.ticket(ticket, printer.paperMm());
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(KitchenPrintService.lanAddress(printer.host()), printer.port()),
                    CONNECT_TIMEOUT_MS);
            socket.setSoTimeout(WRITE_TIMEOUT_MS);
            OutputStream out = socket.getOutputStream();
            for (int i = 0; i < printer.copies(); i++) {
                out.write(bytes);
            }
            out.flush();
        }
        return "PRINTED";
    }
}
