package ru.sphere.stock.demo;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import ru.sphere.stock.tenant.TenantDirectory;
import ru.sphere.stock.antifraud.WriteoffService;
import ru.sphere.stock.catalog.CatalogService;
import ru.sphere.stock.delivery.DeliveryService;
import ru.sphere.stock.domain.BatchState;
import ru.sphere.stock.domain.Fefo;
import ru.sphere.stock.domain.ProductInfo;
import ru.sphere.stock.domain.ProductKind;
import ru.sphere.stock.domain.Production;
import ru.sphere.stock.domain.RecipeLine;
import ru.sphere.stock.domain.Requirements;
import ru.sphere.stock.infra.AppClock;
import ru.sphere.stock.ledger.Actor;
import ru.sphere.stock.menu.ForecastService;
import ru.sphere.stock.menu.MenuService;
import ru.sphere.stock.order.OrderService;
import ru.sphere.stock.stock.ProductionService;
import ru.sphere.stock.stock.ExpiryJob;
import ru.sphere.stock.stock.StockRepository;

/**
 * Генератор событий (ТЗ 5.14, Д6): эмулирует работу ресторана через настоящие сервисы — как внешние
 * системы через API. Утром приходят поставки, повар готовит заготовки, гости заказывают с пиками в обед
 * и вечером, часть заказов отменяется. Сценарии для демо включаются кнопками.
 */
@Service
public class DemoSimulator {

    private static final Logger log = LoggerFactory.getLogger(DemoSimulator.class);

    static final Map<String, Double> CATEGORY_WEIGHT = Map.ofEntries(
            Map.entry("Бургеры", 3.0), Map.entry("Пицца", 2.4), Map.entry("Холодные роллы", 1.4),
            Map.entry("Запечённые роллы", 1.6), Map.entry("Напитки", 3.2), Map.entry("Закуски", 2.0),
            Map.entry("Шаурма и гирос", 1.6), Map.entry("Салаты", 1.0), Map.entry("Супы", 0.6),
            Map.entry("Горячее", 1.0), Map.entry("Сеты", 0.4));

    /** Профиль спроса по часам (локальное время): пики в обед и вечером. */
    static final double[] HOUR_PROFILE = new double[24];

    static {
        double[][] p = {{10, 0.4}, {11, 0.7}, {12, 1.6}, {13, 1.8}, {14, 1.2}, {15, 0.7}, {16, 0.6}, {17, 0.9},
                {18, 1.5}, {19, 1.8}, {20, 1.6}, {21, 1.0}, {22, 0.5}};
        for (double[] e : p) {
            HOUR_PROFILE[(int) e[0]] = e[1];
        }
    }

    static final double AVG_LINES = 1.8;
    static final double AVG_QTY = 1.15;

    /** Активные сценарии точки (ТЗ 5.14). */
    public record Scenario(double demandFactor, Instant rushUntil) {
    }

    public record Actors(Actor generator, Actor cook, Actor suspicious, Actor manager, Actor cashier,
                         Actor storekeeper) {
    }

    private final JdbcClient jdbc;
    private final AppClock clock;
    private final CatalogService catalog;
    private final MenuService menu;
    private final ForecastService forecast;
    private final StockRepository batches;
    private final DeliveryService deliveries;
    private final OrderService orders;
    private final ProductionService production;
    private final WriteoffService writeoffs;
    private final DemoPhotos photos;
    private final ExpiryJob expiry;
    private final Map<String, Scenario> scenarios = new ConcurrentHashMap<>();
    private final Map<String, Integer> ordersPerDay = new ConcurrentHashMap<>();
    private volatile Actors actors;
    private final Random rnd = new Random(42);
    private long seq = 0;

    public DemoSimulator(JdbcClient jdbc, AppClock clock, CatalogService catalog, MenuService menu,
                         ForecastService forecast, StockRepository batches, DeliveryService deliveries,
                         OrderService orders, ProductionService production, WriteoffService writeoffs,
                         DemoPhotos photos, ExpiryJob expiry) {
        this.expiry = expiry;
        this.jdbc = jdbc;
        this.clock = clock;
        this.catalog = catalog;
        this.menu = menu;
        this.forecast = forecast;
        this.batches = batches;
        this.deliveries = deliveries;
        this.orders = orders;
        this.production = production;
        this.writeoffs = writeoffs;
        this.photos = photos;
    }

    public void configure(Actors actors, Map<String, Integer> ordersPerDay) {
        this.actors = actors;
        this.ordersPerDay.putAll(ordersPerDay);
    }

    public Actors actors() {
        return actors;
    }

    public boolean ready() {
        return actors != null;
    }

    public void setScenario(String loc, Scenario s) {
        scenarios.put(loc, s);
    }

    // ── Модель спроса ──────────────────────────────────────────────────────

    /** Обычные продажи варианта в день. */
    public Map<String, Double> variantDailySales(String loc) {
        CatalogService.Snapshot cat = catalog.forLocation(loc);
        Map<String, Integer> variantsPerDish = new HashMap<>();
        cat.variantInfos().forEach(v -> variantsPerDish.merge(v.dishId(), 1, Integer::sum));
        Map<String, Double> w = new HashMap<>();
        double total = 0;
        for (var v : cat.variantInfos()) {
            var dish = cat.dishes().get(v.dishId());
            double cw = CATEGORY_WEIGHT.getOrDefault(dish.category(), 1.0);
            double weight = cw / variantsPerDish.get(v.dishId()) * (v.sort() == 0 ? 1.2 : 0.8);
            w.put(v.id(), weight);
            total += weight;
        }
        double portions = ordersPerDay.getOrDefault(loc, 100) * AVG_LINES * AVG_QTY;
        Map<String, Double> out = new HashMap<>();
        double t = total;
        w.forEach((k, v) -> out.put(k, portions * v / t));
        return out;
    }

    /** Ожидаемый расход продуктов в день (включая сырьё на заготовки). */
    public Map<String, Double> productDailyUse(String loc) {
        CatalogService.Snapshot cat = catalog.forLocation(loc);
        Map<String, Double> use = new HashMap<>();
        Map<String, Map<String, Long>> pp = menu.perPortion(loc);
        variantDailySales(loc).forEach((vid, sales) -> pp.getOrDefault(vid, Map.of())
                .forEach((pid, g) -> use.merge(pid, g * sales, Double::sum)));
        for (CatalogService.SemiRecipe r : cat.semis()) {
            double semiUse = use.getOrDefault(r.productId(), 0.0);
            if (semiUse > 0) {
                Production.needs(r.lines(), r.yield(), Math.round(semiUse), cat)
                        .forEach((pid, g) -> use.merge(pid, g.doubleValue(), Double::sum));
            }
        }
        return use;
    }

    // ── Шаг симуляции ──────────────────────────────────────────────────────

    /** Обработать события точки в интервале (from, to]. Часы системы уже стоят на {@code to}. */
    public void step(String loc, Instant from, Instant to) {
        if (actors == null || !to.isAfter(from)) {
            return;
        }
        ZoneId zone = forecast.hours(loc).zone();
        for (LocalDate day = LocalDate.ofInstant(from, zone); !day.isAfter(LocalDate.ofInstant(to, zone));
             day = day.plusDays(1)) {
            // Обход просрочки: кладовщик списывает истёкшее перед поставкой и после обеда (ТЗ 16.1, шаг 6).
            for (LocalTime t : List.of(LocalTime.of(8, 45), LocalTime.of(16, 0))) {
                if (crossed(day, t, zone, from, to)) {
                    expiry.writeOffExpired(loc, actors.storekeeper());
                }
            }
            if (crossed(day, LocalTime.of(9, 0), zone, from, to)) {
                morningDeliveries(loc, day);
            }
            for (LocalTime t : List.of(LocalTime.of(9, 30), LocalTime.of(12, 30), LocalTime.of(15, 30),
                    LocalTime.of(18, 30))) {
                if (crossed(day, t, zone, from, to)) {
                    kitchenPrep(loc, t.getHour() == 9);
                }
            }
            if (crossed(day, LocalTime.of(10, 15), zone, from, to)) {
                managerSigns(loc);
            }
            if (crossed(day, LocalTime.of(22, 20), zone, from, to) && day.getDayOfMonth() % 2 == 0) {
                suspiciousWriteoffs(loc, 2);
            }
        }
        guestOrders(loc, from, to);
        progressOrders(loc, to);
    }

    private static boolean crossed(LocalDate day, LocalTime t, ZoneId zone, Instant from, Instant to) {
        Instant at = ZonedDateTime.of(day, t, zone).toInstant();
        return at.isAfter(from) && !at.isAfter(to);
    }

    /** Утренние поставки: довозим до запаса на 1–3 дня; иногда — перебор или пропуск (ради демо). */
    public void morningDeliveries(String loc, LocalDate day) {
        CatalogService.Snapshot cat = catalog.forLocation(loc);
        Instant now = clock.now();
        Map<String, Double> daily = productDailyUse(loc);
        Map<String, List<BatchState>> live = batches.liveByProduct(loc);
        List<DeliveryService.LineIn> lines = new ArrayList<>();
        for (ProductInfo p : cat.products()) {
            if (p.kind() != ProductKind.RAW) {
                continue;
            }
            double use = daily.getOrDefault(p.id(), 0.0);
            if (use <= 0) {
                continue;
            }
            long shelfH = p.shelfLife() == null ? 72 : p.shelfLife().toHours();
            double cover = shelfH >= 24 * 7 ? 3 : shelfH >= 72 ? 2 : shelfH >= 48 ? 1.5 : 1.2;
            boolean perishable = shelfH <= 96;
            double factor = 1;
            if (perishable) {
                double r = rnd.nextDouble();
                factor = r < 0.05 ? 0 : r < 0.2 ? 1.8 : 1;    // 5% — пропуск, 15% — перебор
            }
            long avail = Fefo.available(live.getOrDefault(p.id(), List.of()), now.plus(Duration.ofHours(12)));
            double need = (use * cover - avail) * factor;
            if (need < use * 0.1) {
                continue;
            }
            long qty = roundUp((long) Math.ceil(need), p);
            double unitCost = cat.extra(p.id()).lastUnitCostKop() == null ? 0 : cat.extra(p.id()).lastUnitCostKop();
            long cost = Math.round(qty * unitCost * (0.95 + rnd.nextDouble() * 0.1));
            int shelf = (int) Math.max(4, Math.round(shelfH * (0.85 + rnd.nextDouble() * 0.15)));
            lines.add(new DeliveryService.LineIn(p.id(), p.name(), p.unit().name(), qty, shelf, null, cost));
        }
        if (lines.isEmpty()) {
            return;
        }
        String id = "DEMO-" + loc + "-" + day + "-" + (++seq);
        try {
            deliveries.receive(loc, new DeliveryService.DeliveryIn(id, "П-" + day.getDayOfYear() + "/" + seq, now,
                    "ООО «Фреш-Поставка»", lines), actors.generator(), true);
        } catch (RuntimeException e) {
            log.warn("demo delivery failed: {}", e.getMessage());
        }
    }

    private static long roundUp(long qty, ProductInfo p) {
        long step = p.packSize() != null ? p.packSize() : p.unit() == ru.sphere.stock.domain.Unit.PCS ? 1 : 100;
        return Math.max(step, ((qty + step - 1) / step) * step);
    }

    /** Повар готовит заготовки: короткоживущие — на ближайшие часы, остальные — на день. */
    public void kitchenPrep(String loc, boolean morning) {
        CatalogService.Snapshot cat = catalog.forLocation(loc);
        Instant now = clock.now();
        Map<String, Double> daily = productDailyUse(loc);
        Map<String, List<BatchState>> live = batches.liveByProduct(loc);
        Map<String, Long> available = menu.available(live, now);
        for (CatalogService.SemiRecipe r : cat.semis()) {
            ProductInfo semi = cat.product(r.productId());
            double use = daily.getOrDefault(semi.id(), 0.0);
            if (use <= 0) {
                continue;
            }
            long shelfH = semi.shelfLife().toHours();
            double target = shelfH <= 8 ? use * Math.min(shelfH, 3) / 13.0 * 1.3 : use * 1.1;
            long have = Fefo.available(live.getOrDefault(semi.id(), List.of()), now.plus(Duration.ofHours(1)));
            // Долгоживущие заготовки — утром на день; днём дозаготовка, если осталось меньше трети дневного расхода.
            double threshold = shelfH <= 8 || morning ? target * 0.6 : use * 0.35;
            if (have >= threshold) {
                continue;
            }
            long amount = Math.min(roundUp((long) (target - have), semi),
                    Production.maxAmount(r.lines(), r.yield(), available, cat) / 100 * 100);
            if (amount < 100) {
                continue;
            }
            try {
                production.produce(loc, semi.id(), amount, actors.cook());
            } catch (RuntimeException e) {
                log.debug("demo prep skipped {}: {}", semi.id(), e.getMessage());
            }
        }
    }

    /** Гости: число заказов — пуассоновское по профилю часа; 85% выбирают из доступного меню. */
    public void guestOrders(String loc, Instant from, Instant to) {
        ZoneId zone = forecast.hours(loc).zone();
        double profileSum = 0;
        for (double v : HOUR_PROFILE) {
            profileSum += v;
        }
        Scenario sc = scenarios.get(loc);
        double lambda = 0;
        for (Instant t = from; t.isBefore(to); ) {
            Instant next = t.plus(Duration.ofMinutes(5));
            if (next.isAfter(to)) {
                next = to;
            }
            int hour = t.atZone(zone).getHour();
            double factor = (sc != null && sc.rushUntil() != null && t.isBefore(sc.rushUntil())) ? sc.demandFactor() : 1;
            lambda += ordersPerDay.getOrDefault(loc, 100) * HOUR_PROFILE[hour] / profileSum
                    * Duration.between(t, next).toMinutes() / 60.0 * factor;
            t = next;
        }
        int count = poisson(lambda);
        if (count == 0) {
            return;
        }
        Map<String, Double> weights = variantDailySales(loc);
        var statuses = menu.menu(loc);
        Map<String, Boolean> availableNow = new HashMap<>();
        statuses.forEach(s -> availableNow.put(s.variantId(), !s.inStop()));
        for (int i = 0; i < count; i++) {
            int lines = 1 + (rnd.nextDouble() < 0.55 ? 0 : rnd.nextDouble() < 0.6 ? 1 : 2);
            boolean blind = rnd.nextDouble() < 0.15;
            List<OrderService.LineIn> ls = new ArrayList<>();
            for (int j = 0; j < lines; j++) {
                String vid = pick(weights, blind ? null : availableNow);
                if (vid != null && ls.stream().noneMatch(l -> l.variantId().equals(vid))) {
                    ls.add(new OrderService.LineIn(vid, rnd.nextDouble() < 0.85 ? 1 : 2));
                }
            }
            if (ls.isEmpty()) {
                continue;
            }
            try {
                orders.create(loc, new OrderService.OrderIn("G-" + loc + "-" + clock.now().toEpochMilli() + "-" + i,
                        "GENERATOR", ls), actors.generator());
            } catch (RuntimeException e) {
                log.debug("demo order failed: {}", e.getMessage());
            }
        }
    }

    private String pick(Map<String, Double> weights, Map<String, Boolean> onlyAvailable) {
        double total = 0;
        for (var e : weights.entrySet()) {
            if (onlyAvailable == null || onlyAvailable.getOrDefault(e.getKey(), false)) {
                total += e.getValue();
            }
        }
        double r = rnd.nextDouble() * total;
        for (var e : weights.entrySet()) {
            if (onlyAvailable == null || onlyAvailable.getOrDefault(e.getKey(), false)) {
                r -= e.getValue();
                if (r <= 0) {
                    return e.getKey();
                }
            }
        }
        return null;
    }

    private int poisson(double lambda) {
        double l = Math.exp(-lambda);
        int k = 0;
        double p = 1;
        do {
            k++;
            p *= rnd.nextDouble();
        } while (p > l && k < 500);
        return k - 1;
    }

    /** Заказы проходят кухню: статусы двигаются по возрасту; 2% отменяют до готовки. */
    public void progressOrders(String loc, Instant now) {
        List<long[]> early = jdbc.sql("SELECT id FROM orders WHERE location_id = ? AND status = 'NEW' AND source = 'GENERATOR'")
                .param(loc).query((rs, n) -> new long[]{rs.getLong(1)}).list();
        for (long[] o : early) {
            if (rnd.nextDouble() < 0.02) {
                try {
                    orders.cancel(loc, o[0], "Гость передумал", actors.cashier());
                } catch (RuntimeException e) {
                    log.debug("demo cancel failed: {}", e.getMessage());
                }
            }
        }
        java.sql.Timestamp t = java.sql.Timestamp.from(now);
        jdbc.sql("""
                        UPDATE orders SET status = CASE
                            WHEN created_at <= ?::timestamptz - INTERVAL '25 minutes' THEN 'DONE'
                            WHEN created_at <= ?::timestamptz - INTERVAL '15 minutes' THEN 'READY'
                            WHEN created_at <= ?::timestamptz - INTERVAL '5 minutes' THEN 'COOKING'
                            ELSE 'ACCEPTED' END,
                            status_at = ?
                        WHERE location_id = ? AND status IN ('NEW', 'ACCEPTED', 'COOKING', 'READY') AND source = 'GENERATOR'
                          AND created_at <= ?::timestamptz - INTERVAL '2 minutes'""")
                .params(t, t, t, t, loc, t).update();
    }

    /** Управляющий утром подписывает заявки на списание (свои подписать не может). */
    public void managerSigns(String loc) {
        for (var r : writeoffs.list(loc, "PENDING")) {
            try {
                if (r.createdBy() != actors.manager().userId()) {
                    writeoffs.approve(loc, r.id(), "Подтверждаю", actors.manager());
                }
            } catch (RuntimeException e) {
                log.debug("demo approve failed: {}", e.getMessage());
            }
        }
    }

    /**
     * Сценарий «подозрительный сотрудник» (ТЗ 5.14): перед закрытием списывает свежий дорогой продукт
     * как «порчу». Антифрод должен это поймать (A1–A3).
     */
    public int suspiciousWriteoffs(String loc, int count) {
        CatalogService.Snapshot cat = catalog.forLocation(loc);
        Instant now = clock.now();
        List<BatchState> candidates = new ArrayList<>();
        for (String pid : List.of("salmon", "shrimp", "cream_cheese", "parmesan", "bacon", "masago")) {
            for (BatchState b : batches.liveByProduct(loc).getOrDefault(pid, List.of())) {
                if (b.availableAt(now) > 0 && Duration.between(now, b.expiresAt()).toMinutes()
                        > 0.6 * Duration.between(b.baseDate(), b.expiresAt()).toMinutes()) {
                    candidates.add(b);
                }
            }
        }
        int done = 0;
        for (BatchState b : candidates) {
            if (done >= count) {
                break;
            }
            ProductInfo p = cat.product(b.productId());
            long qty = Math.min(b.availableAt(now), p.unit() == ru.sphere.stock.domain.Unit.PCS ? 2 : 300);
            try {
                writeoffs.create(loc, b.id(), qty, "SPOILED", "Испортилось", List.of(photos.placeholder()), actors.suspicious());
                done++;
            } catch (RuntimeException e) {
                log.debug("suspicious writeoff failed: {}", e.getMessage());
            }
        }
        return done;
    }

    /** Сценарий «поставка с коротким сроком» и перебором: появляются горячие предложения. */
    public void shortLifeDelivery(String loc) {
        CatalogService.Snapshot cat = catalog.forLocation(loc);
        Map<String, Double> daily = productDailyUse(loc);
        List<DeliveryService.LineIn> lines = new ArrayList<>();
        for (String pid : List.of("salmon", "cream", "mushrooms", "shrimp")) {
            ProductInfo p = cat.product(pid);
            long qty = roundUp((long) (daily.getOrDefault(pid, 1000.0) * 1.5), p);
            double unitCost = cat.extra(pid).lastUnitCostKop() == null ? 0 : cat.extra(pid).lastUnitCostKop();
            lines.add(new DeliveryService.LineIn(pid, p.name(), p.unit().name(), qty, 20, null, Math.round(qty * unitCost)));
        }
        deliveries.receive(loc, new DeliveryService.DeliveryIn("DEMO-SHORT-" + loc + "-" + (++seq), "П-К/" + seq,
                clock.now(), "ООО «Рыбный двор»", lines), actors.generator(), true);
    }

    /** Сценарий «дефицит»: большой банкет выбирает лосось почти до нуля. */
    public void shortage(String loc, String productId) {
        Map<String, Long> per = new HashMap<>();
        String best = null;
        for (var e : menu.perPortion(loc).entrySet()) {
            Long g = e.getValue().get(productId);
            if (g != null && e.getValue().size() <= 6 && (best == null || g > per.get(best))) {
                best = e.getKey();
                per.put(best, g);
            }
        }
        if (best == null) {
            return;
        }
        Instant now = clock.now();
        long avail = Fefo.available(batches.live(loc, List.of(productId), false), now);
        int n = (int) Math.max(1, (avail - per.get(best)) / per.get(best));
        try {
            orders.create(loc, new OrderService.OrderIn("BANQUET-" + now.toEpochMilli(), "GENERATOR",
                    List.of(new OrderService.LineIn(best, Math.min(n, 100)))), actors.generator());
        } catch (RuntimeException e) {
            log.debug("banquet failed: {}", e.getMessage());
        }
    }

    /** Сценарий «поздние отмены»: кассир отменяет готовящиеся заказы. */
    public int lateCancels(String loc, int count) {
        List<Long> cooking = jdbc.sql("SELECT id FROM orders WHERE location_id = ? AND status IN ('COOKING', 'READY') "
                        + "ORDER BY created_at DESC LIMIT ?")
                .params(loc, count).query(Long.class).list();
        int n = 0;
        for (long id : cooking) {
            try {
                orders.cancel(loc, id, "Гость ушёл", actors.cashier());
                n++;
            } catch (RuntimeException e) {
                log.debug("late cancel failed: {}", e.getMessage());
            }
        }
        return n;
    }

    /** Ожидаемый расход продуктов: пишем в карточки, чтобы прогноз работал даже без истории. */
    public void storeExpectedUse() {
        Map<String, Double> total = new HashMap<>();
        for (String loc : ordersPerDay.keySet()) {
            productDailyUse(loc).forEach((k, v) -> total.merge(k, v / ordersPerDay.size(), Double::sum));
        }
        total.forEach((pid, v) -> jdbc.sql("UPDATE products SET expected_daily_use = ? WHERE tenant_id = ? AND id = ?")
                .params(Math.round(v), TenantDirectory.DEMO, pid).update());
        catalog.invalidate(TenantDirectory.DEMO);
    }

    static List<RecipeLine> lines(CatalogService.SemiRecipe r) {
        return r.lines();
    }

    static Map<String, Long> perPortion(String vid, CatalogService.Snapshot cat) {
        return Requirements.perPortion(vid, cat);
    }
}
