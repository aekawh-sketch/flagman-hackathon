package ru.sphere.stock.web;

import io.swagger.v3.oas.annotations.media.Schema;
import java.sql.Timestamp;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import ru.sphere.stock.menu.ForecastService;
import ru.sphere.stock.trace.TraceService;

/**
 * Прибыль точки за период (ТЗ 16.18): второй режим «Аналитики».
 * <ul>
 *   <li>Выручка — заказы без отмены; себестоимость — фактическая, из партий по FEFO (orders.cost_kop).</li>
 *   <li>Прибыль = выручка − себестоимость проданного.</li>
 *   <li>В плюсе = прибыль − потери (списания, просрочка, отмены после готовки) — те же потери, что в первом режиме.</li>
 * </ul>
 * Аренду, зарплаты и налоги склад не знает — их здесь нет.
 */
@Service
public class ProfitService {

    @Schema(name = "ProfitAnalytics", description = "Прибыль точки за период")
    public record ProfitAnalytics(int days, long orders, long revenueKop, long costKop,
                                  @Schema(description = "Прибыль: выручка минус себестоимость проданного") long grossKop,
                                  @Schema(description = "Потери: списания, просрочка, отмены после готовки") long lossesKop,
                                  @Schema(description = "В плюсе: прибыль минус потери") long netKop,
                                  @Schema(description = "Доля прибыли в выручке, 0–1") double grossShare,
                                  @Schema(description = "Доля «в плюсе» в выручке, 0–1") double netShare,
                                  List<ProfitDay> byDay, List<DishProfit> byDish) {
    }

    @Schema(name = "ProfitDay", description = "Прибыль за день")
    public record ProfitDay(String date, long revenueKop, long grossKop, long lossesKop, long netKop) {
    }

    @Schema(name = "DishProfit", description = "Прибыль по блюду: себестоимость — из партий, ушедших в его порции")
    public record DishProfit(String variantId, String name, long qty, long revenueKop, long costKop, long profitKop,
                             double margin) {
    }

    private final JdbcClient jdbc;
    private final QueryService query;
    private final TraceService trace;
    private final ForecastService forecast;

    public ProfitService(JdbcClient jdbc, QueryService query, TraceService trace, ForecastService forecast) {
        this.jdbc = jdbc;
        this.query = query;
        this.trace = trace;
        this.forecast = forecast;
    }

    public ProfitAnalytics profit(String loc, QueryService.Period period) {
        ZoneId zone = forecast.hours(loc).zone();
        Timestamp from = Timestamp.from(period.from());
        Timestamp until = Timestamp.from(period.to());

        // Каждый день периода — и пустые, чтобы шкала времени была честной.
        Map<String, long[]> daily = new LinkedHashMap<>();    // дата → [выручка, себестоимость, потери]
        for (LocalDate d = period.fromDay(); !d.isAfter(period.toDay()); d = d.plusDays(1)) {
            daily.put(d.toString(), new long[3]);
        }
        List<Long> ids = new ArrayList<>();
        long[] total = new long[2];
        jdbc.sql("""
                        SELECT id, (created_at AT TIME ZONE ?)::date, total_kop, cost_kop FROM orders
                        WHERE location_id = ? AND created_at >= ? AND created_at < ?
                          AND status NOT IN ('CANCELED', 'CANCELED_LATE')""")
                .params(zone.getId(), loc, from, until)
                .query(rs -> {
                    ids.add(rs.getLong(1));
                    long revenue = rs.getLong(3);
                    long cost = rs.getLong(4);
                    total[0] += revenue;
                    total[1] += cost;
                    long[] d = daily.get(rs.getDate(2).toLocalDate().toString());
                    if (d != null) {
                        d[0] += revenue;
                        d[1] += cost;
                    }
                });

        // Потери — те же, что в первом режиме «Аналитики»: списания по дням и отмены после готовки
        QueryService.WriteoffAnalytics losses = query.writeoffs(loc, period);
        losses.byDay().forEach(l -> {
            long[] d = daily.get(l.day());
            if (d != null) {
                d[2] += l.valueKop();
            }
        });
        jdbc.sql("""
                        SELECT (canceled_at AT TIME ZONE ?)::date, SUM(cost_kop) FROM orders
                        WHERE location_id = ? AND status = 'CANCELED_LATE' AND canceled_at >= ? AND canceled_at < ? GROUP BY 1""")
                .params(zone.getId(), loc, from, until)
                .query(rs -> {
                    long[] d = daily.get(rs.getDate(1).toLocalDate().toString());
                    if (d != null) {
                        d[2] += rs.getLong(2);
                    }
                });

        List<ProfitDay> byDay = new ArrayList<>();
        daily.forEach((date, d) -> byDay.add(new ProfitDay(date, d[0], d[0] - d[1], d[2], d[0] - d[1] - d[2])));
        List<DishProfit> byDish = trace.dishMoney(loc, ids).stream()
                .map(m -> new DishProfit(m.variantId(), m.name(), m.qty(), m.revenueKop(), m.costKop(),
                        m.revenueKop() - m.costKop(), m.revenueKop() == 0 ? 0 : (double) (m.revenueKop() - m.costKop()) / m.revenueKop()))
                .sorted(Comparator.comparingLong(DishProfit::profitKop).reversed())
                .toList();
        long revenue = total[0];
        long gross = revenue - total[1];
        long lossesKop = losses.totalKop();
        return new ProfitAnalytics(period.days(), ids.size(), revenue, total[1], gross, lossesKop, gross - lossesKop,
                revenue == 0 ? 0 : (double) gross / revenue, revenue == 0 ? 0 : (double) (gross - lossesKop) / revenue,
                byDay, byDish);
    }
}
