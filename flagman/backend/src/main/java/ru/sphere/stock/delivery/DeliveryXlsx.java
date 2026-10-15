package ru.sphere.stock.delivery;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import ru.sphere.stock.domain.ProductInfo;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.infra.Hashing;
import ru.sphere.stock.infra.Xlsx;

/**
 * Поставка из Excel (ТЗ 16.3): человек заполняет таблицу как привык — количество в кг, л или шт (можно в г и мл),
 * сумма в рублях, дата как в календаре. Сверху — номер, поставщик и дата, ниже — шапка «ID продукта …» и строки.
 * Без ID поставки он считается из номера, поставщика и даты: тот же файл второй раз не задвоит склад.
 */
public final class DeliveryXlsx {

    static final ZoneId MSK = ZoneId.of("Europe/Moscow");
    private static final List<String> HEADER = List.of("ID продукта", "Название", "Ед. (кг, л, шт, г, мл)", "Количество",
            "Срок хранения, ч", "Годен до", "Сумма, ₽");

    private DeliveryXlsx() {
    }

    public static DeliveryService.DeliveryIn parse(byte[] bytes) {
        Map<String, List<List<String>>> book = Xlsx.read(bytes);
        if (book.isEmpty()) {
            throw ApiException.badRequest("В файле нет листов");
        }
        List<List<String>> rows = book.values().iterator().next();
        String id = null, number = null, supplier = null;
        Instant created = null;
        int header = -1;
        for (int r = 0; r < rows.size(); r++) {
            String key = cell(rows.get(r), 0).toLowerCase(Locale.ROOT);
            String val = cell(rows.get(r), 1);
            if (key.startsWith("id продукта") || key.equals("productid")) {
                header = r;
                break;
            }
            if (key.startsWith("номер")) {
                number = val;
            } else if (key.startsWith("поставщик")) {
                supplier = val;
            } else if (key.startsWith("дата")) {
                created = date(val, "Дата отгрузки");
            } else if (key.startsWith("id поставки")) {
                id = val;
            }
        }
        if (header < 0) {
            throw ApiException.badRequest("Не нашли шапку таблицы — строку, которая начинается с «ID продукта». Скачайте пример файла");
        }
        if (number == null || number.isBlank()) {
            throw ApiException.badRequest("Укажите «Номер поставки» в верхней части листа");
        }
        if (created == null) {
            throw ApiException.badRequest("Укажите «Дату отгрузки» — от неё считаются сроки годности");
        }
        List<DeliveryService.LineIn> lines = new ArrayList<>();
        for (int r = header + 1; r < rows.size(); r++) {
            List<String> row = rows.get(r);
            String pid = cell(row, 0);
            if (pid.isBlank() && cell(row, 1).isBlank()) {
                continue;                                          // пустая строка — пропускаем
            }
            int n = r + 1;
            if (pid.isBlank()) {
                throw ApiException.badRequest("Строка " + n + ": нет ID продукта");
            }
            String[] unit = unit(cell(row, 2), n);
            BigDecimal qty = decimal(cell(row, 3), "Строка " + n + ": количество");
            long base = qty.multiply(new BigDecimal(unit[1])).setScale(0, RoundingMode.HALF_UP).longValueExact();
            if (base <= 0) {
                throw ApiException.badRequest("Строка " + n + ": количество должно быть больше нуля");
            }
            String shelf = cell(row, 4);
            String until = cell(row, 5);
            if (shelf.isBlank() && until.isBlank()) {
                throw ApiException.badRequest("Строка " + n + ": нужен срок хранения в часах или дата «Годен до»");
            }
            Integer hours = shelf.isBlank() ? null : decimal(shelf, "Строка " + n + ": срок хранения").intValue();
            Instant expires = until.isBlank() ? null : date(until, "Строка " + n + ": «Годен до»");
            String sum = cell(row, 6);
            Long kop = sum.isBlank() ? null
                    : decimal(sum, "Строка " + n + ": сумма").multiply(BigDecimal.valueOf(100)).setScale(0, RoundingMode.HALF_UP).longValueExact();
            String name = cell(row, 1).isBlank() ? pid : cell(row, 1);
            lines.add(new DeliveryService.LineIn(pid, name, unit[0], base, hours, expires, kop));
        }
        if (lines.isEmpty()) {
            throw ApiException.badRequest("В таблице нет ни одной строки с продуктом");
        }
        if (id == null || id.isBlank()) {
            id = "XLSX-" + Hashing.sha256(number + "|" + supplier + "|" + created).substring(0, 12);
        }
        return new DeliveryService.DeliveryIn(id, number, created, supplier == null || supplier.isBlank() ? null : supplier, lines);
    }

    /** Пример файла из продуктов каталога предприятия: как заполнить, по одной строке на продукт. */
    public static byte[] sample(List<ProductInfo> products, Map<String, Double> unitCostKop, Instant now) {
        String day = LocalDateTime.ofInstant(now, MSK).format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm"));
        List<List<Object>> rows = new ArrayList<>();
        rows.add(List.of("Поставка", ""));
        rows.add(List.of("Номер поставки", "П-" + LocalDate.ofInstant(now, MSK).format(DateTimeFormatter.ofPattern("MMdd")) + "-1"));
        rows.add(List.of("Поставщик", "ООО «ФрешПоставка»"));
        rows.add(List.of("Дата отгрузки", day));
        rows.add(List.of("ID поставки (необязательно)", ""));
        rows.add(List.of());
        rows.add(new ArrayList<>(HEADER));
        for (ProductInfo p : products) {
            String unit = switch (p.unit()) {
                case G -> "кг";
                case ML -> "л";
                case PCS -> "шт";
            };
            double qty = p.unit() == ru.sphere.stock.domain.Unit.PCS ? 10 : 2;
            double perUnit = unitCostKop.getOrDefault(p.id(), 0.0) * (p.unit() == ru.sphere.stock.domain.Unit.PCS ? 1 : 1000);
            long hours = p.shelfLife() == null ? 72 : Math.max(1, p.shelfLife().toHours());
            List<Object> row = new ArrayList<>(List.of(p.id(), p.name(), unit, qty, hours, ""));
            row.add(perUnit > 0 ? Math.round(perUnit * qty) / 100.0 : "");
            rows.add(row);
        }
        List<List<Object>> help = List.of(
                List.of("Как заполнить"),
                List.of("Сверху — номер поставки, поставщик и дата отгрузки (по Москве): от неё считаются сроки годности."),
                List.of("Ниже шапки «ID продукта …» — по строке на продукт. ID — как в каталоге ресторана; новый продукт заведётся сам с пометкой «проверить»."),
                List.of("Единица — кг, л или шт (можно г и мл): количество 2,5 кг = 2500 г."),
                List.of("Срок — в часах («Срок хранения, ч») или датой «Годен до» (2026-10-20 18:00 или 20.10.2026)."),
                List.of("Сумма — в рублях за всю строку; без суммы возьмётся последняя цена закупки."),
                List.of("ID поставки можно не заполнять: повторная загрузка того же файла не задвоит склад."));
        return Xlsx.write(List.of(
                new Xlsx.Sheet("Поставка", rows, List.of(26, 30, 22, 12, 18, 18, 12)),
                new Xlsx.Sheet("Как заполнить", help, List.of(110))));
    }

    /** [единица склада, множитель к базовой]: «кг» → [G, 1000], «шт» → [PCS, 1]. */
    private static String[] unit(String raw, int row) {
        String u = raw.strip().toLowerCase(Locale.ROOT).replace(".", "");
        return switch (u) {
            case "кг", "kg" -> new String[]{"G", "1000"};
            case "г", "гр", "g" -> new String[]{"G", "1"};
            case "л", "l" -> new String[]{"ML", "1000"};
            case "мл", "ml" -> new String[]{"ML", "1"};
            case "шт", "pcs", "штук", "шт." -> new String[]{"PCS", "1"};
            default -> throw ApiException.badRequest("Строка " + row + ": единица — кг, л, шт, г или мл, а указано «" + raw + "»");
        };
    }

    private static BigDecimal decimal(String raw, String what) {
        try {
            return new BigDecimal(raw.strip().replace(" ", "").replace(" ", "").replace(",", "."));
        } catch (NumberFormatException e) {
            throw ApiException.badRequest(what + " — число, а указано «" + raw + "»");
        }
    }

    /** Дата: «2026-10-13 09:00», «13.10.2026 09:00», «13.10.2026» или число-дата Excel; время — по Москве. */
    static Instant date(String raw, String what) {
        String s = raw.strip();
        try {
            if (s.matches("\\d+(\\.\\d+)?")) {                    // дата Excel: дни от 30.12.1899
                double serial = Double.parseDouble(s);
                long seconds = Math.round(serial * 86_400);
                return LocalDateTime.of(1899, 12, 30, 0, 0).plusSeconds(seconds).atZone(MSK).toInstant();
            }
            for (String pattern : List.of("yyyy-MM-dd HH:mm", "yyyy-MM-dd'T'HH:mm", "dd.MM.yyyy HH:mm", "yyyy-MM-dd HH:mm:ss")) {
                try {
                    return LocalDateTime.parse(s, DateTimeFormatter.ofPattern(pattern)).atZone(MSK).toInstant();
                } catch (java.time.format.DateTimeParseException ignored) {
                    // следующий формат
                }
            }
            for (String pattern : List.of("yyyy-MM-dd", "dd.MM.yyyy")) {
                try {
                    return LocalDate.parse(s, DateTimeFormatter.ofPattern(pattern)).atStartOfDay(MSK).toInstant();
                } catch (java.time.format.DateTimeParseException ignored) {
                    // следующий формат
                }
            }
        } catch (RuntimeException e) {
            // ниже — понятная ошибка
        }
        throw ApiException.badRequest(what + ": дата вида 2026-10-13 09:00 или 13.10.2026, а указано «" + raw + "»");
    }

    private static String cell(List<String> row, int i) {
        return i < row.size() && row.get(i) != null ? row.get(i).strip() : "";
    }
}
