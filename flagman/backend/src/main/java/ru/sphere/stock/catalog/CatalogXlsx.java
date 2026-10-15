package ru.sphere.stock.catalog;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import ru.sphere.stock.catalog.CatalogImportService.CatalogIn;
import ru.sphere.stock.catalog.CatalogImportService.DishIn;
import ru.sphere.stock.catalog.CatalogImportService.LineIn;
import ru.sphere.stock.catalog.CatalogImportService.ProductIn;
import ru.sphere.stock.catalog.CatalogImportService.SemiIn;
import ru.sphere.stock.catalog.CatalogImportService.SetIn;
import ru.sphere.stock.catalog.CatalogImportService.SetItemIn;
import ru.sphere.stock.catalog.CatalogImportService.VariantIn;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.infra.Xlsx;

/**
 * Меню предприятия из Excel (ТЗ п. 48, 16.4): листы «Продукты», «Заготовки», «Блюда» и необязательный «Сеты».
 * В «Заготовках» и «Блюдах» — строка на ингредиент: пустые первые колонки продолжают предыдущую заготовку или
 * вариант блюда. Тот же каталог можно прислать JSON-ом в API — пример у обоих один.
 */
public final class CatalogXlsx {

    private CatalogXlsx() {
    }

    public static CatalogIn parse(byte[] bytes) {
        Map<String, List<List<String>>> book = new LinkedHashMap<>();
        Xlsx.read(bytes).forEach((k, v) -> book.put(k.strip().toLowerCase(Locale.ROOT), v));
        List<List<String>> products = sheet(book, "продукты", true);
        List<ProductIn> outProducts = new ArrayList<>();
        for (int r = 1; r < products.size(); r++) {
            List<String> row = products.get(r);
            if (blank(row)) {
                continue;
            }
            String where = "Продукты, строка " + (r + 1);
            String id = need(row, 0, where, "ID");
            String kind = cell(row, 3).toLowerCase(Locale.ROOT).startsWith("загот") || "semi".equalsIgnoreCase(cell(row, 3))
                    ? "SEMI" : "RAW";
            outProducts.add(new ProductIn(id, need(row, 1, where, "название"), unit(cell(row, 2), where), kind,
                    emptyToNull(cell(row, 4)), dbl(cell(row, 5), where), integer(cell(row, 6), where), lng(cell(row, 7), where),
                    integer(cell(row, 8), where), dbl(cell(row, 9), where), null, integer(cell(row, 10), where), null));
        }

        List<SemiIn> semi = new ArrayList<>();
        List<List<String>> preps = sheet(book, "заготовки", false);
        String prepId = null;
        long yield = 0;
        List<LineIn> prepLines = new ArrayList<>();
        for (int r = 1; r < preps.size(); r++) {
            List<String> row = preps.get(r);
            if (blank(row)) {
                continue;
            }
            String where = "Заготовки, строка " + (r + 1);
            if (!cell(row, 0).isBlank()) {
                if (prepId != null) {
                    semi.add(new SemiIn(prepId, yield, List.copyOf(prepLines)));
                }
                prepId = cell(row, 0);
                Long y = lng(cell(row, 1), where);
                if (y == null || y <= 0) {
                    throw ApiException.badRequest(where + ": укажите выход заготовки");
                }
                yield = y;
                prepLines = new ArrayList<>();
            } else if (prepId == null) {
                throw ApiException.badRequest(where + ": сначала ID заготовки");
            }
            prepLines.add(line(row, 2, where));
        }
        if (prepId != null) {
            semi.add(new SemiIn(prepId, yield, List.copyOf(prepLines)));
        }

        Set<String> setVariants = new HashSet<>();
        Map<String, List<SetItemIn>> setItems = new LinkedHashMap<>();
        List<List<String>> sets = sheet(book, "сеты", false);
        for (int r = 1; r < sets.size(); r++) {
            List<String> row = sets.get(r);
            if (blank(row)) {
                continue;
            }
            String where = "Сеты, строка " + (r + 1);
            String set = need(row, 0, where, "ID сета");
            Long qty = lng(cell(row, 2), where);
            setVariants.add(set);
            setItems.computeIfAbsent(set, k -> new ArrayList<>())
                    .add(new SetItemIn(need(row, 1, where, "ID варианта в сете"), qty == null ? 1 : qty.intValue()));
        }

        // Блюда: строка на ингредиент; пустой «ID блюда» — тот же вариант или новый вариант того же блюда.
        Map<String, String[]> dishHead = new LinkedHashMap<>();          // id → [название, категория]
        Map<String, Map<String, Object[]>> variants = new LinkedHashMap<>(); // блюдо → вариант → [название, подпись, цена, строки]
        List<List<String>> dishes = sheet(book, "блюда", true);
        String dish = null, variant = null;
        for (int r = 1; r < dishes.size(); r++) {
            List<String> row = dishes.get(r);
            if (blank(row)) {
                continue;
            }
            String where = "Блюда, строка " + (r + 1);
            if (!cell(row, 0).isBlank()) {
                dish = cell(row, 0);
                dishHead.putIfAbsent(dish, new String[]{need(row, 1, where, "название блюда"), cell(row, 2).isBlank() ? "Меню" : cell(row, 2)});
                variant = null;
            } else if (dish == null) {
                throw ApiException.badRequest(where + ": сначала ID блюда");
            }
            if (!cell(row, 3).isBlank()) {
                variant = cell(row, 3);
                String label = emptyToNull(cell(row, 4));
                Double price = dbl(cell(row, 5), where);
                if (price == null) {
                    throw ApiException.badRequest(where + ": укажите цену варианта в рублях");
                }
                String name = dishHead.get(dish)[0] + (label == null ? "" : " " + label);
                variants.computeIfAbsent(dish, k -> new LinkedHashMap<>()).put(variant,
                        new Object[]{name, label, Math.round(price * 100), new ArrayList<LineIn>()});
            } else if (variant == null) {
                throw ApiException.badRequest(where + ": укажите ID варианта (например, тот же, что ID блюда)");
            }
            if (!cell(row, 6).isBlank()) {
                @SuppressWarnings("unchecked")
                List<LineIn> lines = (List<LineIn>) variants.get(dish).get(variant)[3];
                lines.add(line(row, 6, where));
            }
        }
        List<DishIn> outDishes = new ArrayList<>();
        int sort = 0;
        for (var e : dishHead.entrySet()) {
            List<VariantIn> vs = new ArrayList<>();
            for (var v : variants.getOrDefault(e.getKey(), Map.of()).entrySet()) {
                Object[] x = v.getValue();
                @SuppressWarnings("unchecked")
                List<LineIn> lines = (List<LineIn>) x[3];
                boolean isSet = setVariants.contains(v.getKey());
                if (!isSet && lines.isEmpty()) {
                    throw ApiException.badRequest("Блюда: у варианта «" + x[0] + "» нет ни одного продукта");
                }
                vs.add(new VariantIn(v.getKey(), (String) x[0], (String) x[1], (Long) x[2], isSet, isSet ? List.of() : lines));
            }
            if (vs.isEmpty()) {
                throw ApiException.badRequest("Блюда: у «" + e.getValue()[0] + "» нет ни одного варианта с ценой");
            }
            outDishes.add(new DishIn(e.getKey(), e.getValue()[0], e.getValue()[1], null, ++sort, vs));
        }
        List<SetIn> outSets = new ArrayList<>();
        setItems.forEach((k, v) -> outSets.add(new SetIn(k, v)));
        if (outProducts.isEmpty() && outDishes.isEmpty()) {
            throw ApiException.badRequest("В файле нет ни продуктов, ни блюд — скачайте пример и заполните его");
        }
        return new CatalogIn(outProducts, semi, outDishes, outSets);
    }

    /** Каталог в Excel — тем же форматом, что читает {@link #parse}: пример и выгрузка. */
    public static byte[] write(CatalogIn in) {
        Map<String, ProductIn> byId = new LinkedHashMap<>();
        in.products().forEach(p -> byId.put(p.id(), p));
        List<List<Object>> products = new ArrayList<>();
        products.add(List.of("ID", "Название", "Ед. (г, мл, шт)", "Тип (сырьё / заготовка)", "Категория",
                "Цена за кг, л или шт, ₽", "Срок хранения, ч", "Упаковка (г, мл, шт)", "После вскрытия, ч", "Потери, %",
                "Срок доставки, ч"));
        for (ProductIn p : in.products()) {
            products.add(row(p.id(), p.name(), unitRu(p.unit()), "SEMI".equals(p.kind()) ? "заготовка" : "сырьё",
                    p.category(), p.price(), p.shelfLifeHours(), p.packSize(), p.afterOpenHours(), p.lossPct(), p.leadTimeHours()));
        }
        List<List<Object>> preps = new ArrayList<>();
        preps.add(List.of("ID заготовки", "Выход (г, мл, шт)", "ID продукта", "Нетто (г, мл, шт)", "Потери, %"));
        for (SemiIn s : in.semi()) {
            for (int i = 0; i < s.lines().size(); i++) {
                LineIn l = s.lines().get(i);
                preps.add(row(i == 0 ? s.productId() : null, i == 0 ? s.yieldQty() : null, l.productId(), l.net(),
                        l.lossBp() == null ? null : l.lossBp() / 100.0));
            }
        }
        List<List<Object>> dishes = new ArrayList<>();
        dishes.add(List.of("ID блюда", "Блюдо", "Категория", "ID варианта", "Вариант (размер)", "Цена, ₽", "ID продукта",
                "Нетто (г, мл, шт)", "Потери, %"));
        for (DishIn d : in.dishes()) {
            boolean firstOfDish = true;
            for (VariantIn v : d.variants()) {
                List<LineIn> lines = v.lines().isEmpty() ? java.util.Collections.singletonList(null) : v.lines();
                boolean firstOfVariant = true;
                for (LineIn l : lines) {
                    dishes.add(row(firstOfDish ? d.id() : null, firstOfDish ? d.name() : null, firstOfDish ? d.category() : null,
                            firstOfVariant ? v.id() : null, firstOfVariant ? v.label() : null,
                            firstOfVariant ? v.priceKop() / 100.0 : null,
                            l == null ? null : l.productId(), l == null ? null : l.net(),
                            l == null || l.lossBp() == null ? null : l.lossBp() / 100.0));
                    firstOfDish = false;
                    firstOfVariant = false;
                }
            }
        }
        List<List<Object>> sets = new ArrayList<>();
        sets.add(List.of("ID сета (вариант из «Блюда»)", "ID варианта в сете", "Кол-во"));
        for (SetIn s : in.sets()) {
            for (SetItemIn it : s.items()) {
                sets.add(row(s.variantId(), it.variantId(), it.qty()));
            }
        }
        List<List<Object>> help = List.of(
                List.of("Как заполнить меню"),
                List.of("«Продукты» — всё, что лежит на складе: ID (латиницей, как в вашей учётной системе), единица г, мл или шт, цена за кг, л или шт."),
                List.of("Тип «заготовка» — то, что готовят на кухне из других продуктов (соус, тесто); её состав — на листе «Заготовки»."),
                List.of("«Заготовки» — строка на ингредиент: в первой строке ID заготовки и выход, в следующих эти колонки пустые."),
                List.of("«Блюда» — строка на ингредиент: ID блюда и название — в первой строке блюда; у каждого варианта (размера) свой ID и цена."),
                List.of("Нетто — сколько продукта идёт в одну порцию, в г, мл или шт; потери, % — если при обработке часть уходит (чистка)."),
                List.of("«Сеты» (необязательно): сет — вариант на листе «Блюда» без продуктов, его состав — здесь."),
                List.of("Повторная загрузка обновляет меню; изменившаяся техкарта получает новую версию, старые заказы помнят свою."),
                List.of("То же можно прислать в API: POST /api/catalog/import (JSON, пример — «Пример JSON» в админке)."));
        return Xlsx.write(List.of(
                new Xlsx.Sheet("Продукты", products, List.of(18, 30, 14, 22, 16, 22, 16, 18, 18, 10, 16)),
                new Xlsx.Sheet("Заготовки", preps, List.of(20, 18, 18, 18, 10)),
                new Xlsx.Sheet("Блюда", dishes, List.of(16, 30, 16, 16, 18, 10, 18, 18, 10)),
                new Xlsx.Sheet("Сеты", sets, List.of(30, 22, 10)),
                new Xlsx.Sheet("Как заполнить", help, List.of(120))));
    }

    /** Небольшое меню кофейни — пример для нового предприятия: 10 продуктов, заготовка, 6 блюд и сет. */
    public static CatalogIn sample() {
        List<ProductIn> products = List.of(
                p("kf_beans", "Кофе в зёрнах", "G", "RAW", "Кофе", 2400.0, 720, 1000L, null, 0.0),
                p("kf_milk", "Молоко 3,2 %", "ML", "RAW", "Молочное", 95.0, 120, 1000L, 48, 0.0),
                p("kf_syrup_vanilla", "Сироп ванильный", "ML", "RAW", "Сиропы", 650.0, 2160, null, null, 0.0),
                p("kf_cream", "Сливки 33 %", "ML", "RAW", "Молочное", 420.0, 168, 500L, 48, 0.0),
                p("kf_tea", "Чай чёрный", "G", "RAW", "Чай", 1600.0, 4320, null, null, 0.0),
                p("kf_lemon", "Лимон", "G", "RAW", "Фрукты", 260.0, 336, null, null, 10.0),
                p("kf_croissant", "Круассан (заготовка из пекарни)", "PCS", "RAW", "Выпечка", 55.0, 72, null, null, 0.0),
                p("kf_ham", "Ветчина", "G", "RAW", "Мясное", 780.0, 168, null, null, 0.0),
                p("kf_cheese", "Сыр полутвёрдый", "G", "RAW", "Молочное", 950.0, 336, null, null, 0.0),
                p("kf_filling", "Начинка ветчина-сыр", "G", "SEMI", "Заготовки", null, 36, null, null, 0.0));
        List<SemiIn> semi = List.of(new SemiIn("kf_filling", 500, List.of(
                new LineIn("kf_ham", 300, null), new LineIn("kf_cheese", 200, null))));
        List<DishIn> dishes = List.of(
                new DishIn("kf_espresso", "Эспрессо", "Кофе", null, 1, List.of(
                        new VariantIn("kf_espresso", "Эспрессо", null, 12_000, false, List.of(new LineIn("kf_beans", 9, null))))),
                new DishIn("kf_cappuccino", "Капучино", "Кофе", null, 2, List.of(
                        new VariantIn("kf_cappuccino_300", "Капучино 0,3 л", "0,3 л", 22_000, false, List.of(
                                new LineIn("kf_beans", 9, null), new LineIn("kf_milk", 180, null))),
                        new VariantIn("kf_cappuccino_400", "Капучино 0,4 л", "0,4 л", 26_000, false, List.of(
                                new LineIn("kf_beans", 18, null), new LineIn("kf_milk", 240, null))))),
                new DishIn("kf_raf", "Раф ванильный", "Кофе", null, 3, List.of(
                        new VariantIn("kf_raf", "Раф ванильный", null, 29_000, false, List.of(
                                new LineIn("kf_beans", 9, null), new LineIn("kf_cream", 120, null),
                                new LineIn("kf_syrup_vanilla", 20, null))))),
                new DishIn("kf_tea_lemon", "Чай с лимоном", "Чай", null, 4, List.of(
                        new VariantIn("kf_tea_lemon", "Чай с лимоном", null, 15_000, false, List.of(
                                new LineIn("kf_tea", 5, null), new LineIn("kf_lemon", 15, null))))),
                new DishIn("kf_croissant_ham", "Круассан с ветчиной и сыром", "Выпечка", null, 5, List.of(
                        new VariantIn("kf_croissant_ham", "Круассан с ветчиной и сыром", null, 25_000, false, List.of(
                                new LineIn("kf_croissant", 1, null), new LineIn("kf_filling", 60, null))))),
                new DishIn("kf_breakfast", "Завтрак: капучино и круассан", "Сеты", null, 6, List.of(
                        new VariantIn("kf_breakfast", "Завтрак: капучино и круассан", null, 42_000, true, List.of()))));
        List<SetIn> sets = List.of(new SetIn("kf_breakfast", List.of(
                new SetItemIn("kf_cappuccino_300", 1), new SetItemIn("kf_croissant_ham", 1))));
        return new CatalogIn(products, semi, dishes, sets);
    }

    private static ProductIn p(String id, String name, String unit, String kind, String category, Double price,
                               Integer shelfHours, Long pack, Integer afterOpen, Double lossPct) {
        return new ProductIn(id, name, unit, kind, category, price, shelfHours, pack, afterOpen, lossPct, null, 24, null);
    }

    private static LineIn line(List<String> row, int from, String where) {
        String pid = need(row, from, where, "ID продукта");
        Long net = lng(cell(row, from + 1), where);
        if (net == null || net <= 0) {
            throw ApiException.badRequest(where + ": нетто — целое число больше нуля (г, мл или шт)");
        }
        Double loss = dbl(cell(row, from + 2), where);
        return new LineIn(pid, net, loss == null ? null : (int) Math.round(loss * 100));
    }

    private static List<List<String>> sheet(Map<String, List<List<String>>> book, String name, boolean required) {
        List<List<String>> s = book.get(name);
        if (s == null && required) {
            throw ApiException.badRequest("В файле нет листа «" + Character.toUpperCase(name.charAt(0)) + name.substring(1)
                    + "» — скачайте пример и заполните его");
        }
        return s == null ? List.of() : s;
    }

    private static String unit(String raw, String where) {
        return switch (raw.strip().toLowerCase(Locale.ROOT).replace(".", "")) {
            case "г", "гр", "кг", "g" -> "G";
            case "мл", "л", "ml" -> "ML";
            case "шт", "pcs", "штук" -> "PCS";
            default -> throw ApiException.badRequest(where + ": единица — г, мл или шт, а указано «" + raw + "»");
        };
    }

    private static String unitRu(String unit) {
        return switch (unit) {
            case "G" -> "г";
            case "ML" -> "мл";
            default -> "шт";
        };
    }

    private static List<Object> row(Object... cells) {
        List<Object> r = new ArrayList<>();
        for (Object c : cells) {
            r.add(c == null ? "" : c);
        }
        return r;
    }

    private static boolean blank(List<String> row) {
        return row.stream().allMatch(c -> c == null || c.isBlank());
    }

    private static String cell(List<String> row, int i) {
        return i < row.size() && row.get(i) != null ? row.get(i).strip() : "";
    }

    private static String need(List<String> row, int i, String where, String what) {
        String v = cell(row, i);
        if (v.isBlank()) {
            throw ApiException.badRequest(where + ": не заполнено «" + what + "»");
        }
        return v;
    }

    private static String emptyToNull(String s) {
        return s == null || s.isBlank() ? null : s;
    }

    private static Double dbl(String raw, String where) {
        if (raw.isBlank()) {
            return null;
        }
        try {
            return Double.parseDouble(raw.replace(" ", "").replace(" ", "").replace(",", "."));
        } catch (NumberFormatException e) {
            throw ApiException.badRequest(where + ": «" + raw + "» — не число");
        }
    }

    private static Long lng(String raw, String where) {
        Double d = dbl(raw, where);
        return d == null ? null : BigDecimal.valueOf(d).setScale(0, RoundingMode.HALF_UP).longValue();
    }

    private static Integer integer(String raw, String where) {
        Long l = lng(raw, where);
        return l == null ? null : l.intValue();
    }
}
