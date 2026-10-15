package ru.sphere.stock.menu;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;
import ru.sphere.stock.catalog.CatalogService;
import ru.sphere.stock.domain.BatchState;
import ru.sphere.stock.domain.HotOffers;
import ru.sphere.stock.domain.Money;
import ru.sphere.stock.domain.OpenHours;
import ru.sphere.stock.domain.ProductInfo;
import ru.sphere.stock.domain.PurchasePlanner;
import ru.sphere.stock.domain.RiskAnalyzer;
import ru.sphere.stock.domain.StopForecast;
import ru.sphere.stock.domain.StopList;
import ru.sphere.stock.infra.AppClock;
import ru.sphere.stock.redis.LocationCache;
import ru.sphere.stock.stock.StockRepository;

/**
 * Всё, что строится на прогнозе расхода: горячие предложения (ТЗ 5.10), предложение поставок (5.9),
 * прогноз стоп-листа (5.12, Д4).
 */
@Service
public class InsightsService {

    public record HotOfferDto(int rank, String variantId, String name, long priceKop, long portions, double score,
                              String productId, String productName, String atRiskText, double hoursLeft,
                              long lossKop, String explanation) {
    }

    /** {@code error} — например, функция оценки ещё не реализована (TODO(human)). */
    public record HotOffersResult(Instant computedAt, List<HotOfferDto> offers, String error) {
    }

    public record PurchaseDto(String productId, String productName, String unit, long orderQty, String orderText,
                              long availableQty, String availableText, long survives, long expiresBefore,
                              double dailyRate, String dailyText, double leadDays, boolean cappedByLife,
                              boolean noData, long estCostKop, String explanation) {
    }

    public record SurplusDto(String productId, String productName, long atRisk, String atRiskText, long lossKop,
                             double hoursLeft) {
    }

    public record PurchasesResult(Instant computedAt, List<PurchaseDto> toOrder, List<SurplusDto> doNotOrder) {
    }

    public record StopEtaDto(String variantId, String variantName, Instant at, String productId, String productName,
                             String cause, String text) {
    }

    /** Горячие предложения пересчитываются не реже, чем раз в 15 минут времени склада (ТЗ 5.10, шаг 6). */
    private static final Duration HOT_PERIOD = Duration.ofMinutes(15);

    private final AppClock clock;
    private final StockRepository batches;
    private final CatalogService catalog;
    private final MenuService menu;
    private final ForecastService forecast;
    private final LocationCache cache;

    public InsightsService(AppClock clock, StockRepository batches, CatalogService catalog, MenuService menu,
                           ForecastService forecast, LocationCache cache) {
        this.clock = clock;
        this.batches = batches;
        this.catalog = catalog;
        this.menu = menu;
        this.forecast = forecast;
        this.cache = cache;
    }

    /** Кеш Redis до следующего изменения склада или 15 минут системного времени (ТЗ 5.10, шаг 6). */
    public HotOffersResult hotOffers(String locationId) {
        Instant now = clock.now();
        return cache.get(locationId, "hot", hotBucket(now), HotOffersResult.class, HOT_PERIOD, r -> true,
                () -> computeHot(locationId, now));
    }

    /** Горячие блюда, если они уже посчитаны, — без расчёта (подсказка «похожие блюда» на кассе). */
    public List<String> cachedHotIds(String locationId) {
        return cache.peek(locationId, "hot", hotBucket(clock.now()), HotOffersResult.class)
                .map(r -> r.offers().stream().map(HotOfferDto::variantId).toList()).orElse(List.of());
    }

    private static long hotBucket(Instant now) {
        return now.getEpochSecond() / HOT_PERIOD.toSeconds();
    }

    private HotOffersResult computeHot(String locationId, Instant now) {
        CatalogService.Snapshot cat = catalog.forLocation(locationId);
        Map<String, List<BatchState>> live = batches.liveByProduct(locationId);
        Map<String, Long> available = menu.available(live, now);
        ForecastService.Rates rates = forecast.rates(locationId, now);
        OpenHours hours = forecast.hours(locationId);

        Map<String, List<RiskAnalyzer.BatchRisk>> risks = new HashMap<>();
        live.forEach((pid, list) -> risks.put(pid,
                RiskAnalyzer.analyze(list, rates.productPerOpenHour().getOrDefault(pid, 0.0), hours, now)));
        Map<String, StopList.Portions> portions = new HashMap<>();
        for (MenuService.VariantStatus s : menu.statuses(locationId, available)) {
            portions.put(s.variantId(), new StopList.Portions(s.variantId(), s.tracked(),
                    s.tracked() ? s.portions() : 0, s.limitingProductId()));
        }
        List<HotOffers.Offer> offers;
        try {
            offers = HotOffers.compute(cat, portions, risks, rates.productPerOpenHour(), rates.variantPerDay(), now,
                    HotOffers.DEFAULT_LIMIT);
        } catch (UnsupportedOperationException e) {
            return new HotOffersResult(now, List.of(), "Функция оценки горячих предложений ещё не реализована: "
                    + "HotOffers.contribution (TODO(human))");
        }
        List<HotOfferDto> out = new ArrayList<>();
        int rank = 1;
        for (HotOffers.Offer o : offers) {
            HotOffers.Factor m = o.main();
            ProductInfo p = cat.product(m.productId());
            var vi = cat.variantInfo(o.variantId());
            out.add(new HotOfferDto(rank++, o.variantId(), vi.name(), vi.priceKop(),
                    portions.get(o.variantId()).portions(), o.score(), p.id(), p.name(), p.format(m.atRisk()),
                    m.hoursLeft(), m.lossKop(), HotOffers.explain(o, cat)));
        }
        return new HotOffersResult(now, out, null);
    }

    public PurchasesResult purchases(String locationId) {
        Instant now = clock.now();
        CatalogService.Snapshot cat = catalog.forLocation(locationId);
        Map<String, List<BatchState>> live = batches.liveByProduct(locationId);
        ForecastService.Rates rates = forecast.rates(locationId, now);
        OpenHours hours = forecast.hours(locationId);
        List<PurchaseDto> toOrder = new ArrayList<>();
        List<SurplusDto> surplus = new ArrayList<>();
        for (ProductInfo p : cat.products()) {
            List<BatchState> list = live.getOrDefault(p.id(), List.of());
            double rate = rates.productPerOpenHour().getOrDefault(p.id(), 0.0);
            if (rate <= 0 && list.isEmpty()) {
                continue;
            }
            var s = PurchasePlanner.plan(p, list, rate, hours, now, PurchasePlanner.DEFAULT_REVIEW,
                    PurchasePlanner.DEFAULT_SAFETY_DAYS);
            var ex = cat.extra(p.id());
            long cost = ex != null && ex.lastUnitCostKop() != null ? Math.round(ex.lastUnitCostKop() * s.orderQty()) : 0;
            if (s.orderQty() > 0) {
                StringBuilder why = new StringBuilder("На складе ").append(p.format(s.available()));
                if (s.expiresBefore() > 0) {
                    why.append(", из них ").append(p.format(s.expiresBefore())).append(" истечёт до поставки");
                }
                why.append("; расход ").append(p.format(Math.round(s.dailyRate()))).append(" в день; поставка через ")
                        .append(HotOffers.humanHours(s.leadTime().toMinutes() / 60.0)).append('.');
                if (s.cappedByLife()) {
                    why.append(" Больше не берём: не успеем продать до конца срока.");
                }
                toOrder.add(new PurchaseDto(p.id(), p.name(), p.unit().name(), s.orderQty(), p.format(s.orderQty()),
                        s.available(), p.format(s.available()), s.survives(), s.expiresBefore(), s.dailyRate(),
                        p.format(Math.round(s.dailyRate())) + " в день", s.leadTime().toMinutes() / 1440.0,
                        s.cappedByLife(), s.noData(), cost, why.toString()));
            }
            var risk = RiskAnalyzer.analyze(list, rate, hours, now);
            long atRisk = RiskAnalyzer.totalAtRisk(risk);
            if (atRisk > 0) {
                long loss = risk.stream().mapToLong(r -> r.batch().costOf(r.atRisk())).sum();
                double hoursLeft = risk.stream().filter(r -> r.atRisk() > 0).findFirst()
                        .map(r -> Duration.between(now, r.batch().expiresAt()).toMinutes() / 60.0).orElse(0.0);
                surplus.add(new SurplusDto(p.id(), p.name(), atRisk, p.format(atRisk), loss, hoursLeft));
            }
        }
        toOrder.sort(Comparator.comparing(PurchaseDto::productName));
        surplus.sort(Comparator.comparingLong(SurplusDto::lossKop).reversed());
        return new PurchasesResult(now, toOrder, surplus);
    }

    public List<StopEtaDto> stopForecast(String locationId, Duration horizon) {
        Instant now = clock.now();
        CatalogService.Snapshot cat = catalog.forLocation(locationId);
        Map<String, List<BatchState>> live = batches.liveByProduct(locationId);
        Map<String, Map<String, Long>> per = new HashMap<>();
        menu.perPortion(locationId).forEach((vid, pp) -> {
            if (!pp.isEmpty()) {
                per.put(vid, pp);
            }
        });
        var rates = forecast.rates(locationId, now);
        var etas = StopForecast.forecast(per, live, rates.productPerOpenHour(), forecast.hours(locationId), now,
                horizon, Duration.ofMinutes(15));
        List<StopEtaDto> out = new ArrayList<>();
        for (var e : etas) {
            if (e.cause() == StopForecast.Cause.ALREADY) {
                continue;
            }
            String pname = cat.productName(e.limitingProductId());
            String vname = cat.variantName(e.variantId());
            String text = e.cause() == StopForecast.Cause.EXPIRED
                    ? "истечёт партия «" + pname + "»"
                    : "закончится «" + pname + "»";
            out.add(new StopEtaDto(e.variantId(), vname, e.at(), e.limitingProductId(), pname, e.cause().name(), text));
        }
        out.sort(Comparator.comparing(StopEtaDto::at));
        return out;
    }

    public static String rub(long kop) {
        return Money.format(kop);
    }
}
