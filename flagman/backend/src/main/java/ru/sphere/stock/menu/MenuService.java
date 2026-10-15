package ru.sphere.stock.menu;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.sphere.stock.alerts.AlertService;
import ru.sphere.stock.catalog.CatalogService;
import ru.sphere.stock.domain.BatchState;
import ru.sphere.stock.domain.Fefo;
import ru.sphere.stock.domain.OrderLine;
import ru.sphere.stock.domain.ProductInfo;
import ru.sphere.stock.domain.ProductKind;
import ru.sphere.stock.domain.Production;
import ru.sphere.stock.domain.Requirements;
import ru.sphere.stock.domain.StopList;
import ru.sphere.stock.infra.AppClock;
import ru.sphere.stock.stock.StockRepository;

/**
 * Меню и стоп-лист (ТЗ 5.7): доступные порции каждого варианта, причина стопа, подсказка
 * «приготовь заготовку» (п. 33), похожие доступные блюда при отказе (п. 32).
 */
@Service
public class MenuService {

    public record VariantStatus(String variantId, String dishId, String name, String label, String category,
                                long priceKop, boolean isSet, boolean tracked, long portions, boolean inStop,
                                boolean low, String limitingProductId, String limitingProductName, String hint) {
    }

    public record Alternative(String variantId, String name, long portions, long priceKop, boolean hot) {
    }

    private final JdbcClient jdbc;
    private final AppClock clock;
    private final StockRepository batches;
    private final CatalogService catalog;
    private final AlertService alerts;
    private final ObjectProvider<InsightsService> insights;
    /** Брутто на порцию по снимку каталога: у каждого предприятия свой снимок (ТЗ 16.4). */
    private final Map<CatalogService.Snapshot, Map<String, Map<String, Long>>> memo =
            java.util.Collections.synchronizedMap(new java.util.WeakHashMap<>());

    public MenuService(JdbcClient jdbc, AppClock clock, StockRepository batches, CatalogService catalog,
                       AlertService alerts, ObjectProvider<InsightsService> insights) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.batches = batches;
        this.catalog = catalog;
        this.alerts = alerts;
        this.insights = insights;
    }

    /** Брутто на порцию для всех вариантов с техкартой — пересчитывается только при смене каталога. */
    public Map<String, Map<String, Long>> perPortion(String locationId) {
        CatalogService.Snapshot cat = catalog.forLocation(locationId);
        return memo.computeIfAbsent(cat, c -> {
            Map<String, Map<String, Long>> m = new LinkedHashMap<>();
            for (var v : c.variants()) {
                m.put(v.id(), Requirements.perPortion(v.id(), c));
            }
            return m;
        });
    }

    public Map<String, Long> available(Map<String, List<BatchState>> live, Instant now) {
        Map<String, Long> out = new HashMap<>();
        live.forEach((pid, list) -> out.put(pid, Fefo.available(list, now)));
        return out;
    }

    public List<VariantStatus> menu(String locationId) {
        Instant now = clock.now();
        return statuses(locationId, available(batches.liveByProduct(locationId), now));
    }

    /**
     * Меню «если пробить эту корзину» (касса): сколько порций каждого блюда останется после неё.
     * Потребность корзины вычитается из доступного по продуктам, поэтому учтены общие продукты:
     * пробили два ролла — у поке на том же лососе тоже стало меньше.
     */
    public List<VariantStatus> menuAfter(String locationId, List<OrderLine> cart) {
        CatalogService.Snapshot cat = catalog.forLocation(locationId);
        List<OrderLine> known = cart.stream().filter(l -> cat.variant(l.variantId()) != null).toList();
        Map<String, Long> available = available(batches.liveByProduct(locationId), clock.now());
        if (!known.isEmpty()) {
            Requirements.expand(known, cat).total()
                    .forEach((pid, need) -> available.merge(pid, -need, Long::sum));
            available.replaceAll((pid, left) -> Math.max(0, left));
        }
        return statuses(locationId, available);
    }

    public List<VariantStatus> statuses(String locationId, Map<String, Long> available) {
        CatalogService.Snapshot cat = catalog.forLocation(locationId);
        Map<String, Map<String, Long>> pp = perPortion(locationId);
        List<VariantStatus> out = new ArrayList<>();
        for (var vi : cat.variantInfos()) {
            Map<String, Long> per = pp.getOrDefault(vi.id(), Map.of());
            StopList.Portions sp = StopList.portions(vi.id(), per, available);
            String hint = null;
            String limName = null;
            if (sp.limiting() != null) {
                ProductInfo lim = cat.product(sp.limiting());
                limName = lim.name();
                if (sp.inStop() && lim.kind() == ProductKind.SEMI && cat.semi(lim.id()) != null) {
                    var r = cat.semi(lim.id());
                    long can = Production.maxAmount(r.lines(), r.yield(), available, cat);
                    hint = can > 0
                            ? "Сырья хватит на " + lim.format(can) + " заготовки «" + lim.name() + "»"
                            : "Нет сырья на заготовку «" + lim.name() + "»";
                }
            }
            var dish = cat.dishes().get(vi.dishId());
            out.add(new VariantStatus(vi.id(), vi.dishId(), vi.name(), vi.label(),
                    dish == null ? null : dish.category(), vi.priceKop(), vi.isSet(), sp.tracked(),
                    sp.tracked() ? sp.portions() : -1, sp.inStop(), sp.low(), sp.limiting(), limName, hint));
        }
        return out;
    }

    /** Похожие доступные блюда той же категории, сначала — из горячих предложений (п. 32). */
    public List<Alternative> alternatives(String locationId, List<String> ordered, Instant now) {
        CatalogService.Snapshot cat = catalog.forLocation(locationId);
        Set<String> categories = new java.util.HashSet<>();
        for (String vid : ordered) {
            var vi = cat.variantInfo(vid);
            var dish = vi == null ? null : cat.dishes().get(vi.dishId());
            if (dish != null) {
                categories.add(dish.category());
            }
        }
        Set<String> hot = new java.util.HashSet<>();
        InsightsService ins = insights.getIfAvailable();
        if (ins != null) {
            hot.addAll(ins.cachedHotIds(locationId));
        }
        return statuses(locationId, available(batches.liveByProduct(locationId), now)).stream()
                .filter(s -> categories.contains(s.category()) && !ordered.contains(s.variantId()))
                .filter(s -> !s.tracked() || s.portions() > 0)
                .sorted(Comparator.comparing((VariantStatus s) -> !hot.contains(s.variantId()))
                        .thenComparing(s -> -Math.min(s.portions(), 1000)))
                .limit(3)
                .map(s -> new Alternative(s.variantId(), s.name(), s.portions(), s.priceKop(), hot.contains(s.variantId())))
                .toList();
    }

    /**
     * Сверить стоп-лист с прошлым состоянием: входы и выходы из стопа пишутся в историю (для
     * статистики дефицита и «часов в стопе»), о каждом входе — сигнал.
     *
     * @return изменился ли стоп-лист
     */
    @Transactional
    public boolean refreshStopList(String locationId) {
        Instant now = clock.now();
        Map<String, Long> prev = new HashMap<>();
        jdbc.sql("SELECT variant_id, portions FROM stoplist_state WHERE location_id = ?").param(locationId)
                .query(rs -> {
                    prev.put(rs.getString(1), rs.getLong(2));
                });
        boolean changed = false;
        Timestamp ts = Timestamp.from(now);
        List<VariantStatus> all = menu(locationId);
        Map<String, List<VariantStatus>> enteredByProduct = new LinkedHashMap<>();
        for (VariantStatus s : all) {
            if (!s.tracked()) {
                continue;
            }
            Long before = prev.get(s.variantId());
            boolean wasStop = before != null && before == 0;
            if (s.inStop() && !wasStop) {
                jdbc.sql("INSERT INTO stoplist_events (location_id, variant_id, in_at, limiting) VALUES (?, ?, ?, ?)")
                        .params(locationId, s.variantId(), ts, s.limitingProductId()).update();
                enteredByProduct.computeIfAbsent(s.limitingProductId(), k -> new ArrayList<>()).add(s);
                changed = true;
            } else if (!s.inStop() && wasStop) {
                jdbc.sql("UPDATE stoplist_events SET out_at = ? WHERE location_id = ? AND variant_id = ? AND out_at IS NULL")
                        .params(ts, locationId, s.variantId()).update();
                changed = true;
            }
            if (before == null || before != s.portions()) {
                jdbc.sql("""
                                INSERT INTO stoplist_state (location_id, variant_id, portions, limiting, since)
                                VALUES (?, ?, ?, ?, ?)
                                ON CONFLICT (location_id, variant_id) DO UPDATE
                                SET portions = EXCLUDED.portions, limiting = EXCLUDED.limiting,
                                    since = CASE WHEN (stoplist_state.portions = 0) = (EXCLUDED.portions = 0)
                                                 THEN stoplist_state.since ELSE EXCLUDED.since END""")
                        .params(locationId, s.variantId(), s.portions(), s.limitingProductId(), ts).update();
                changed |= before == null || (before <= 3) != (s.portions() <= 3);
            }
        }
        // Один сигнал на продукт, а не на каждое блюдо: «закончился рис — в стопе 29 блюд».
        enteredByProduct.forEach((pid, entered) -> {
            List<String> names = all.stream().filter(v -> v.inStop() && pid.equals(v.limitingProductId()))
                    .map(VariantStatus::name).toList();
            VariantStatus first = entered.getFirst();
            String list = String.join(", ", names.subList(0, Math.min(5, names.size())))
                    + (names.size() > 5 ? " и ещё " + (names.size() - 5) : "");
            alerts.raise(locationId, "STOP_IN", "WARN", "product", pid,
                    "Закончилось «" + first.limitingProductName() + "»: в стопе " + names.size() + " блюд",
                    list + (first.hint() == null ? "" : ". " + first.hint()), now);
        });
        return changed;
    }
}
