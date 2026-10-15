package ru.sphere.stock.kitchen;

import java.io.ByteArrayOutputStream;
import java.nio.charset.Charset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Чек в командах ESC/POS — языке кухонных термопринтеров (Epson TM, Xprinter, Атол и большинство 58/80 мм).
 * Чистая функция «чек → байты», без сети: её легко проверить тестом, а отправка — дело {@link PrinterDriver}.
 * Кириллица — кодовая страница CP866 (команда ESC t 17).
 */
public final class EscPos {

    private static final int ESC = 0x1B;
    private static final int GS = 0x1D;
    public static final Charset CP866 = Charset.forName("IBM866");
    /** Символы, которых нет в CP866, — на понятные принтеру замены. */
    private static final Map<Character, String> PLAIN = Map.of('«', "\"", '»', "\"", '—', "-", '–', "-", '×', "x",
            '…', "...");
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("HH:mm");
    private static final DateTimeFormatter DATE = DateTimeFormatter.ofPattern("dd.MM HH:mm");

    private EscPos() {
    }

    /** Знаков в строке шрифтом A: 58 мм — 32, 80 мм — 48. */
    public static int width(int paperMm) {
        return paperMm == 58 ? 32 : 48;
    }

    public static byte[] ticket(KitchenTicket t, int paperMm) {
        int width = width(paperMm);
        Out out = new Out();
        out.cmd(ESC, '@');                       // сброс принтера
        out.cmd(ESC, 't', 17);                   // кодовая страница CP866
        out.cmd(ESC, 'a', 1);                    // по центру
        out.cmd(GS, '!', 0x11);                  // двойная ширина и высота
        out.line(t.number() == 0 ? "ПРОБНАЯ ПЕЧАТЬ" : "КУХНЯ  №" + t.number());
        out.cmd(GS, '!', 0);
        out.line(t.location() + " · " + t.at().format(DATE));
        out.line(t.source());
        out.cmd(ESC, 'a', 0);                    // влево
        out.line("-".repeat(width));
        for (KitchenTicket.Line l : t.lines()) {
            out.cmd(ESC, 'E', 1);                // жирный
            for (String s : wrap(l.qty() + " x " + l.name(), width, "    ")) {
                out.line(s);
            }
            out.cmd(ESC, 'E', 0);
            for (KitchenTicket.Line i : l.items()) {
                for (String s : wrap("   - " + i.qty() + " x " + i.name(), width, "       ")) {
                    out.line(s);
                }
            }
        }
        out.line("-".repeat(width));
        out.cmd(ESC, 'a', 1);
        out.line("Пробито в " + t.at().format(TIME));
        out.cmd(ESC, 'd', 4);                    // промотать 4 строки
        out.cmd(GS, 'V', 66, 0);                 // отрезать бумагу
        return out.bytes();
    }

    /** Перенос по словам: длинное название блюда не обрезается, продолжение — с отступом. */
    static List<String> wrap(String text, int width, String indent) {
        List<String> out = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        for (String word : text.split(" ")) {
            if (!cur.isEmpty() && cur.length() + 1 + word.length() > width) {
                out.add(cur.toString());
                cur = new StringBuilder(indent);
            }
            if (!cur.isEmpty() && !cur.toString().equals(indent)) {
                cur.append(' ');
            }
            cur.append(word);
        }
        out.add(cur.toString());
        return out;
    }

    private static final class Out {
        private final ByteArrayOutputStream buf = new ByteArrayOutputStream();

        void cmd(int... bytes) {
            for (int b : bytes) {
                buf.write(b);
            }
        }

        void line(String s) {
            StringBuilder plain = new StringBuilder();
            for (char c : s.toCharArray()) {
                plain.append(PLAIN.getOrDefault(c, String.valueOf(c)));
            }
            buf.writeBytes(plain.toString().getBytes(CP866));
            buf.write('\n');
        }

        byte[] bytes() {
            return buf.toByteArray();
        }
    }
}
