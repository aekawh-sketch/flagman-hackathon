package ru.sphere.stock.web;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import ru.sphere.stock.alerts.AlertService;
import ru.sphere.stock.catalog.CatalogService;
import ru.sphere.stock.domain.BatchState;
import ru.sphere.stock.domain.BatchStatus;
import ru.sphere.stock.domain.ExpiryPolicy;
import ru.sphere.stock.domain.ProductInfo;
import ru.sphere.stock.infra.AppClock;
import ru.sphere.stock.ledger.Ledger;
import ru.sphere.stock.ledger.MovementType;
import ru.sphere.stock.menu.ForecastService;
import ru.sphere.stock.menu.MenuService;
import ru.sphere.stock.stock.StockRepository;

/** Представления для экранов: склад, партии, дашборд, аналитика, журнал (ТЗ 5.3, 5.12, 5.15). */
@Service
public class QueryService {

    public record ProductStock(String productId, String name, String unit, String kind, String category,
                               long available, String availableText, long soon, long critical, long expired,
                               long blocked, long held, long valueKop, Double daysOfCover, Instant nearestExpiry,
                               String worstStatus, int batches, boolean needsReview) {
    }

    public record BatchDto(long id, String label, String productId, String productName, String unit, String source,
                           String deliveryNumber, long qtyLeft, long qtyInitial, String qtyText, String qtyInitialText, long held,
                           Instant receivedAt, Instant expiresAt, Instant baseDate, String status, double hoursLeft,
                           double lifeLeftShare, boolean opened, boolean blocked, String blockReason,
                           double unitCostKop, Long parentBatchId) {
    }

    public record Kpis(long stockValueKop, long soonBatches, long criticalBatches, long inStop, long low,
                       long lossesTodayKop, long refusalsToday, long ordersToday, long revenueTodayKop,
                       long openAlerts, long pendingWriteoffs, long pendingDeliveries, long approvedDeliveries,
                       long expiredBatches, long expiredKop) {
    }

    public record DayValue(String day, long valueKop) {
    }

    public record NamedValue(String key, String name, long valueKop, long qty, String qtyText, long count) {
    }

    public record WriteoffAnalytics(int days, long totalKop, long purchasesKop, double lossShare,
                                    List<NamedValue> byReason, List<NamedValue> byProduct, List<NamedValue> byEmployee,
                                    List<DayValue> byDay, String from, String to) {
    }

    public record DeficitRow(String productId, String productName, long refusals, long stopEvents, double stopHours,
                             long lostRevenueKop) {
    }

    public record LedgerRow(long id, long seq, Instant at, String type, String typeTitle, long batchId, String batchLabel,
                            String productName, long qty, String qtyText, long costKop, String actor, String reason,
                            String docType, String docId, String hash) {
    }

    public record OrderLineDto(String variantId, String name, int qty, long priceKop) {
    }

    public record OrderDto(long id, long number, String externalId, String source, String status, Instant createdAt,
                           String createdBy, long totalKop, long costKop, String cancelReason, String canceledBy,
                           List<OrderLineDto> lines) {
    }

    /**
     * Строка поставки. {@code expiryStatus} и {@code hoursLeft} — срок на сейчас (ТЗ 16.1, шаг 2):
     * приёмка сразу видит, что просрочено, а что скоро истечёт.
     */
    public record DeliveryLineDto(int lineNo, String productId, String name, String unit, long qtyInvoice,
                                  Long qtyActual, String qtyText, String qtyActualText, Integer shelfLifeHours,
                                  Instant expiresAt, Long costKop, String expiryStatus, double hoursLeft,
                                  String rejectReason, String rejectComment, Long approvedQty, String approvedQtyText,
                                  String approveNote, Long batchId, String batchLabel, String batchLeftText) {
    }

    public record DeliveryDto(String id, String number, Instant createdAt, String supplier, String status,
                              Instant receivedAt, String acceptedBy, Instant acceptedAt, boolean mock, String channel,
                              String rejectComment, Long approvedById, String approvedBy, Instant approvedAt,
                              String approvalComment, boolean hasInvoicePhoto, int invoicePhotoCount,
                              List<DeliveryLineDto> lines) {
    }

    /**
     * «Поставлено — съедено — просрочено» по продукту за период (ТЗ 16.1, шаг 7).
     *
     * @param advice      подсказка по объёму поставок; {@code adviceLevel}: bad — много просрочки, warn — впритык,
     *                    info — расходуется медленно, ok — по расходу
     */
    public record SupplyRow(String productId, String productName, String unit, long received, String receivedText,
                            long consumed, String consumedText, long expired, String expiredText, long expiredKop,
                            long otherLoss, String otherLossText, long left, String leftText, long deliveries,
                            double expiredShare, String advice, String adviceLevel) {
    }

    private final JdbcClient jdbc;
    private final AppClock clock;
    private final StockRepository batches;
    private final CatalogService catalog;
    private final ForecastService forecast;
    private final MenuService menu;
    private final AlertService alerts;
    private final Ledger ledger;
    private final Map<String, Object[]> verifyCache = new ConcurrentHashMap<>();

    public QueryService(JdbcClient jdbc, AppClock clock, StockRepository batches, CatalogService catalog,
                        ForecastService forecast, MenuService menu, AlertService alerts, Ledger ledger) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.batches = batches;
        this.catalog = catalog;
        this.forecast = forecast;
        this.menu = menu;
        this.alerts = alerts;
        this.ledger = ledger;
    }

    // ── Склад ──────────────────────────────────────────────────────────────

    public List<ProductStock> stock(String loc) {
        Instant now = clock.now();
        CatalogService.Snapshot cat = catalog.forLocation(loc);
        Map<String, List<BatchState>> live = batches.liveByProduct(loc);
        var rates = forecast.rates(loc, now);
        List<ProductStock> out = new ArrayList<>();
        for (ProductInfo p : cat.products()) {
            List<BatchState> list = live.getOrDefault(p.id(), List.of());
            double rate = rates.productPerOpenHour().getOrDefault(p.id(), 0.0);
            if (list.isEmpty() && rate == 0) {
                continue;
            }
            long avail = 0, soon = 0, crit = 0, expired = 0, blocked = 0, held = 0, value = 0;
            Instant nearest = null;
            BatchStatus worst = null;
            for (BatchState b : list) {
                held += b.heldQty();
                if (b.blocked()) {
                    blocked += b.qtyLeft();
                    continue;
                }
                BatchStatus st = ExpiryPolicy.status(b, p, now);
                if (st == BatchStatus.EXPIRED) {
                    expired += b.qtyLeft();
                } else {
                    avail += b.availableAt(now);
                    value += b.costOf(b.qtyLeft());
                    if (st == BatchStatus.SOON) {
                        soon += b.qtyLeft();
                    }
                    if (st == BatchStatus.CRITICAL) {
                        crit += b.qtyLeft();
                    }
                    if (nearest == null || b.expiresAt().isBefore(nearest)) {
                        nearest = b.expiresAt();
                    }
                }
                if (worst == null || st.ordinal() > worst.ordinal()) {
                    worst = st;
                }
            }
            double daily = rate * rates.hoursPerDay();
            var ex = cat.extra(p.id());
            out.add(new ProductStock(p.id(), p.name(), p.unit().name(), p.kind().name(),
                    ex == null ? null : ex.category(), avail, p.format(avail), soon, crit, expired, blocked, held,
                    value, daily > 0 ? avail / daily : null, nearest, worst == null ? null : worst.name(), list.size(),
                    ex != null && ex.needsReview()));
        }
        return out;
    }

    public List<BatchDto> batches(String loc, String productId, boolean includeEmpty) {
        Instant now = clock.now();
        CatalogService.Snapshot cat = catalog.forLocation(loc);
        return jdbc.sql("""
                        SELECT b.*, d.number AS delivery_number FROM batches b
                        LEFT JOIN delivery_lines l ON l.id = b.delivery_line_id
                        LEFT JOIN deliveries d ON d.tenant_id = l.tenant_id AND d.id = l.delivery_id
                        WHERE b.location_id = ? AND (?::text IS NULL OR b.product_id = ?)
                          AND (? OR b.qty_left > 0)
                        ORDER BY b.expires_at, b.id LIMIT 500""")
                .params(loc, productId, productId, includeEmpty)
                .query((rs, n) -> {
                    ProductInfo p = cat.product(rs.getString("product_id"));
                    BatchState b = new BatchState(rs.getLong("id"), p.id(), rs.getLong("qty_left"), rs.getLong("held_qty"),
                            rs.getTimestamp("base_date").toInstant(), rs.getTimestamp("expires_at").toInstant(),
                            rs.getTimestamp("received_at").toInstant(), rs.getBoolean("opened"),
                            rs.getBoolean("blocked"), rs.getLong("cost_total_kop"), rs.getLong("qty_initial"));
                    double life = Duration.between(b.baseDate(), b.expiresAt()).toMinutes();
                    double left = Duration.between(now, b.expiresAt()).toMinutes();
                    return new BatchDto(b.id(), rs.getString("label"), p.id(), p.name(), p.unit().name(),
                            rs.getString("source"), rs.getString("delivery_number"), b.qtyLeft(), b.qtyInitial(),
                            p.format(b.qtyLeft()), p.format(b.qtyInitial()), b.heldQty(), b.receivedAt(), b.expiresAt(), b.baseDate(),
                            ExpiryPolicy.status(b, p, now).name(), left / 60.0, life > 0 ? Math.max(0, left / life) : 0,
                            b.opened(), b.blocked(), rs.getString("block_reason"), b.unitCostKop(),
                            (Long) rs.getObject("parent_batch_id"));
                })
                .list();
    }

    // ── Дашборд ────────────────────────────────────────────────────────────

    public Kpis kpis(String loc) {
        return kpis(loc, period(loc, 1, null, null));
    }

    /**
     * Показатели дашборда. Состояние склада (стоимость, сроки, стоп-лист, ждущие заявки) — на сейчас; потери,
     * заказы, выручка и отказы — за период (по умолчанию сегодня).
     */
    public Kpis kpis(String loc, Period period) {
        Instant now = clock.now();
        Timestamp dayStart = Timestamp.from(period.from());
        Timestamp until = Timestamp.from(period.to());
        List<ProductStock> stock = stock(loc);
        long value = stock.stream().mapToLong(ProductStock::valueKop).sum();
        long soon = 0, crit = 0;
        for (BatchDto b : batches(loc, null, false)) {
            if (b.blocked()) {
                continue;
            }
            if ("SOON".equals(b.status())) {
                soon++;
            } else if ("CRITICAL".equals(b.status())) {
                crit++;
            }
        }
        var statuses = menu.menu(loc);
        long inStop = statuses.stream().filter(MenuService.VariantStatus::inStop).count();
        long low = statuses.stream().filter(MenuService.VariantStatus::low).count();
        long losses = jdbc.sql("SELECT COALESCE(-SUM(cost_kop), 0) FROM movements WHERE location_id = ? "
                        + "AND type LIKE 'WRITEOFF_%' AND at >= ? AND at < ?")
                .params(loc, dayStart, until).query(Long.class).single();
        losses += jdbc.sql("SELECT COALESCE(SUM(cost_kop), 0) FROM orders WHERE location_id = ? AND status = 'CANCELED_LATE' "
                        + "AND canceled_at >= ? AND canceled_at < ?")
                .params(loc, dayStart, until).query(Long.class).single();
        long refusals = jdbc.sql("SELECT COUNT(*) FROM order_refusals WHERE location_id = ? AND at >= ? AND at < ?")
                .params(loc, dayStart, until).query(Long.class).single();
        Object[] orders = jdbc.sql("SELECT COUNT(*), COALESCE(SUM(total_kop), 0) FROM orders WHERE location_id = ? "
                        + "AND created_at >= ? AND created_at < ? AND status NOT IN ('CANCELED', 'CANCELED_LATE')")
                .params(loc, dayStart, until).query((rs, n) -> new Object[]{rs.getLong(1), rs.getLong(2)}).single();
        long pendingW = jdbc.sql("SELECT COUNT(*) FROM writeoff_requests WHERE location_id = ? AND status = 'PENDING'")
                .param(loc).query(Long.class).single();
        long pendingD = jdbc.sql("SELECT COUNT(*) FROM deliveries WHERE location_id = ? AND status = 'PENDING'")
                .param(loc).query(Long.class).single();
        long approvedD = jdbc.sql("SELECT COUNT(*) FROM deliveries WHERE location_id = ? AND status = 'APPROVED'")
                .param(loc).query(Long.class).single();
        long[] expired = jdbc.sql("""
                        SELECT COUNT(*), COALESCE(SUM(ROUND(cost_total_kop::numeric * qty_left / qty_initial)), 0)
                        FROM batches WHERE location_id = ? AND qty_left > 0 AND expires_at <= ?""")
                .params(loc, Timestamp.from(now)).query((rs, n) -> new long[]{rs.getLong(1), rs.getLong(2)}).single();
        return new Kpis(value, soon, crit, inStop, low, losses, refusals, (Long) orders[0], (Long) orders[1],
                alerts.openCount(loc), pendingW, pendingD, approvedD, expired[0], expired[1]);
    }

    /** Проверка целостности журнала — не чаще раза в 10 секунд на точку. */
    public Ledger.Verification integrity(String loc, boolean force) {
        Object[] c = verifyCache.get(loc);
        long nowMs = System.currentTimeMillis();
        if (!force && c != null && nowMs - (Long) c[0] < 10_000) {
            return (Ledger.Verification) c[1];
        }
        Ledger.Verification v = ledger.verify(loc);
        verifyCache.put(loc, new Object[]{nowMs, v});
        return v;
    }

    // ── Аналитика (Д2, Д3) ─────────────────────────────────────────────────

    /**
     * Период аналитики: календарные дни точки включительно — [from 00:00, to + 1 день 00:00). Без дат —
     * последние {@code days} дней по сегодня. У периода всегда есть конец: записи «из будущего» (демо-часы
     * когда-то шли с ускорением) не попадают в «последние 7 дней».
     */
    public record Period(LocalDate fromDay, LocalDate toDay, Instant from, Instant to) {
        public int days() {
            return (int) (toDay.toEpochDay() - fromDay.toEpochDay()) + 1;
        }
    }

    public Period period(String loc, int days, LocalDate fromDay, LocalDate toDay) {
        ZoneId zone = forecast.hours(loc).zone();
        LocalDate to = toDay != null ? toDay : LocalDate.ofInstant(clock.now(), zone);
        LocalDate from = fromDay != null ? fromDay : to.minusDays(Math.max(1, days) - 1L);
        if (from.isAfter(to)) {
            throw ru.sphere.stock.infra.ApiException.badRequest("Начало периода позже конца");
        }
        if (to.toEpochDay() - from.toEpochDay() > 366) {
            throw ru.sphere.stock.infra.ApiException.badRequest("Период — не больше года");
        }
        return new Period(from, to, from.atStartOfDay(zone).toInstant(), to.plusDays(1).atStartOfDay(zone).toInstant());
    }

    public WriteoffAnalytics writeoffs(String loc, int days) {
        return writeoffs(loc, period(loc, days, null, null));
    }

    public WriteoffAnalytics writeoffs(String loc, Period period) {
        ZoneId zone = forecast.hours(loc).zone();
        Timestamp from = Timestamp.from(period.from());
        Timestamp until = Timestamp.from(period.to());
        CatalogService.Snapshot cat = catalog.forLocation(loc);
        List<NamedValue> byReason = new ArrayList<>();
        jdbc.sql("SELECT type, -SUM(cost_kop), COUNT(*) FROM movements WHERE location_id = ? AND type LIKE 'WRITEOFF_%' "
                        + "AND at >= ? AND at < ? GROUP BY type ORDER BY 2 DESC")
                .params(loc, from, until)
                .query(rs -> {
                    byReason.add(new NamedValue(rs.getString(1), MovementType.valueOf(rs.getString(1)).title()
                            .replace("Списание: ", ""), rs.getLong(2), 0, null, rs.getLong(3)));
                });
        long lateCancel = jdbc.sql("SELECT COALESCE(SUM(cost_kop), 0) FROM orders WHERE location_id = ? "
                        + "AND status = 'CANCELED_LATE' AND canceled_at >= ? AND canceled_at < ?")
                .params(loc, from, until).query(Long.class).single();
        if (lateCancel > 0) {
            byReason.add(new NamedValue("CANCELED_LATE", "отмена после готовки", lateCancel, 0, null, 0));
        }
        List<NamedValue> byProduct = new ArrayList<>();
        jdbc.sql("""
                        SELECT b.product_id, -SUM(m.cost_kop), -SUM(m.qty), COUNT(*) FROM movements m JOIN batches b ON b.id = m.batch_id
                        WHERE m.location_id = ? AND m.type LIKE 'WRITEOFF_%' AND m.at >= ? AND m.at < ?
                        GROUP BY b.product_id ORDER BY 2 DESC LIMIT 10""")
                .params(loc, from, until)
                .query(rs -> {
                    ProductInfo p = cat.product(rs.getString(1));
                    byProduct.add(new NamedValue(p.id(), p.name(), rs.getLong(2), rs.getLong(3), p.format(rs.getLong(3)),
                            rs.getLong(4)));
                });
        List<NamedValue> byEmployee = new ArrayList<>();
        jdbc.sql("""
                        SELECT COALESCE(r.created_by::text, 'system'), COALESCE(u.name, 'Система (просрочка)'),
                               -SUM(m.cost_kop), COUNT(*)
                        FROM movements m
                        LEFT JOIN writeoff_requests r ON m.doc_type = 'writeoff' AND r.id::text = m.doc_id
                        LEFT JOIN users u ON u.id = COALESCE(r.created_by, m.actor_id)
                        WHERE m.location_id = ? AND m.type LIKE 'WRITEOFF_%' AND m.at >= ? AND m.at < ?
                        GROUP BY 1, 2 ORDER BY 3 DESC""")
                .params(loc, from, until)
                .query(rs -> {
                    byEmployee.add(new NamedValue(rs.getString(1), rs.getString(2), rs.getLong(3), 0, null, rs.getLong(4)));
                });
        // Каждый день периода по порядку — и пустые, чтобы на графике была честная шкала времени.
        Map<String, Long> daily = new LinkedHashMap<>();
        for (LocalDate d = period.fromDay(); !d.isAfter(period.toDay()); d = d.plusDays(1)) {
            daily.put(d.toString(), 0L);
        }
        jdbc.sql("""
                        SELECT (at AT TIME ZONE ?)::date, -SUM(cost_kop) FROM movements
                        WHERE location_id = ? AND type LIKE 'WRITEOFF_%' AND at >= ? AND at < ? GROUP BY 1""")
                .params(zone.getId(), loc, from, until)
                .query(rs -> {
                    long kop = rs.getLong(2);
                    daily.computeIfPresent(rs.getDate(1).toLocalDate().toString(), (k, v) -> v + kop);
                });
        long total = byReason.stream().mapToLong(NamedValue::valueKop).sum();
        long purchases = jdbc.sql("SELECT COALESCE(SUM(cost_kop), 0) FROM movements WHERE location_id = ? "
                        + "AND type = 'RECEIPT' AND at >= ? AND at < ?")
                .params(loc, from, until).query(Long.class).single();
        List<DayValue> byDay = daily.entrySet().stream().map(e -> new DayValue(e.getKey(), e.getValue())).toList();
        return new WriteoffAnalytics(period.days(), total, purchases, purchases > 0 ? (double) total / purchases : 0,
                byReason, byProduct, byEmployee, byDay, period.fromDay().toString(), period.toDay().toString());
    }

    // ── Потери за конкретный день (клик по столбцу графика) ────────────────

    /**
     * @param author    кто списал: автор заявки или «Система» для просрочки
     * @param signedBy  кто подписал заявку, если это другой человек
     * @param requestId номер заявки на списание, если списание ручное
     */
    public record LossEntry(Instant at, String type, String reason, long batchId, String batchLabel, String productName,
                            long qty, String qtyText, long costKop, String author, String signedBy, String comment,
                            Long requestId) {
    }

    public record LateCancel(long orderId, long number, Instant at, long costKop, String canceledBy, String reason) {
    }

    public record LossDay(String date, long totalKop, List<NamedValue> byReason, List<LossEntry> entries,
                          List<LateCancel> lateCancels) {
    }

    /** Всё, что ушло в потери за день по времени точки: каждое списание и отмены после готовки. */
    public LossDay lossDay(String loc, LocalDate day) {
        ZoneId zone = forecast.hours(loc).zone();
        Timestamp from = Timestamp.from(day.atStartOfDay(zone).toInstant());
        Timestamp to = Timestamp.from(day.plusDays(1).atStartOfDay(zone).toInstant());
        CatalogService.Snapshot cat = catalog.forLocation(loc);
        List<LossEntry> entries = jdbc.sql("""
                        SELECT m.at, m.type, m.batch_id, b.label, b.product_id, -m.qty, -m.cost_kop, m.reason,
                               r.id AS request_id, r.comment, author.name AS author, signer.name AS signer
                        FROM movements m
                        JOIN batches b ON b.id = m.batch_id
                        LEFT JOIN writeoff_requests r ON m.doc_type = 'writeoff' AND r.id::text = m.doc_id
                        LEFT JOIN users author ON author.id = COALESCE(r.created_by, m.actor_id)
                        LEFT JOIN users signer ON signer.id = m.actor_id AND r.created_by IS NOT NULL
                                               AND m.actor_id <> r.created_by
                        WHERE m.location_id = ? AND m.type LIKE 'WRITEOFF_%' AND m.at >= ? AND m.at < ?
                        ORDER BY m.at""")
                .params(loc, from, to)
                .query((rs, n) -> {
                    ProductInfo p = cat.product(rs.getString("product_id"));
                    MovementType t = MovementType.valueOf(rs.getString("type"));
                    String comment = rs.getString("comment") != null ? rs.getString("comment") : rs.getString("reason");
                    return new LossEntry(rs.getTimestamp("at").toInstant(), t.name(),
                            t.title().replace("Списание: ", ""), rs.getLong("batch_id"), rs.getString("label"),
                            p.name(), rs.getLong(6), p.format(rs.getLong(6)), rs.getLong(7),
                            rs.getString("author") != null ? rs.getString("author") : "Система",
                            rs.getString("signer"), comment, (Long) rs.getObject("request_id"));
                })
                .list();
        List<LateCancel> late = jdbc.sql("""
                        SELECT o.id, o.number, o.canceled_at, o.cost_kop, u.name, o.cancel_reason FROM orders o
                        LEFT JOIN users u ON u.id = o.canceled_by
                        WHERE o.location_id = ? AND o.status = 'CANCELED_LATE' AND o.canceled_at >= ? AND o.canceled_at < ?
                        ORDER BY o.canceled_at""")
                .params(loc, from, to)
                .query((rs, n) -> new LateCancel(rs.getLong(1), rs.getLong(2), rs.getTimestamp(3).toInstant(),
                        rs.getLong(4), rs.getString(5), rs.getString(6)))
                .list();
        Map<String, long[]> reasons = new LinkedHashMap<>();
        entries.forEach(e -> {
            long[] v = reasons.computeIfAbsent(e.type() + "|" + e.reason(), k -> new long[2]);
            v[0] += e.costKop();
            v[1]++;
        });
        List<NamedValue> byReason = new ArrayList<>();
        reasons.forEach((k, v) -> byReason.add(new NamedValue(k.split("\\|")[0], k.split("\\|")[1], v[0], 0, null, v[1])));
        long lateKop = late.stream().mapToLong(LateCancel::costKop).sum();
        if (!late.isEmpty()) {
            byReason.add(new NamedValue("CANCELED_LATE", "отмена после готовки", lateKop, 0, null, late.size()));
        }
        byReason.sort(Comparator.comparingLong(NamedValue::valueKop).reversed());
        long total = entries.stream().mapToLong(LossEntry::costKop).sum() + lateKop;
        return new LossDay(day.toString(), total, byReason, entries, late);
    }

    public List<DeficitRow> deficit(String loc, int days) {
        return deficit(loc, period(loc, days, null, null));
    }

    public List<DeficitRow> deficit(String loc, Period period) {
        Instant now = clock.now();
        Timestamp from = Timestamp.from(period.from());
        Timestamp until = Timestamp.from(period.to());
        // Конец окна для «часов в стопе»: конец периода, но не позже «сейчас» — стоп ещё может длиться.
        Timestamp end = Timestamp.from(period.to().isBefore(now) ? period.to() : now);
        CatalogService.Snapshot cat = catalog.forLocation(loc);
        Map<String, long[]> refusals = new LinkedHashMap<>();
        jdbc.sql("""
                        SELECT s->>'productId', COUNT(*), SUM(r.lost_kop)
                        FROM order_refusals r, jsonb_array_elements(r.shortages) s
                        WHERE r.location_id = ? AND r.at >= ? AND r.at < ? GROUP BY 1""")
                .params(loc, from, until)
                .query(rs -> {
                    refusals.put(rs.getString(1), new long[]{rs.getLong(2), rs.getLong(3)});
                });
        Map<String, double[]> stops = new LinkedHashMap<>();
        jdbc.sql("""
                        SELECT limiting, COUNT(*),
                               SUM(GREATEST(0, EXTRACT(EPOCH FROM (LEAST(COALESCE(out_at, ?::timestamptz), ?::timestamptz)
                                   - GREATEST(in_at, ?::timestamptz))) / 3600))
                        FROM stoplist_events WHERE location_id = ? AND limiting IS NOT NULL
                          AND in_at < ? AND (out_at IS NULL OR out_at > ?) GROUP BY limiting""")
                .params(end, end, from, loc, until, from)
                .query(rs -> {
                    stops.put(rs.getString(1), new double[]{rs.getLong(2), rs.getDouble(3)});
                });
        java.util.Set<String> ids = new java.util.LinkedHashSet<>(refusals.keySet());
        ids.addAll(stops.keySet());
        List<DeficitRow> out = new ArrayList<>();
        for (String pid : ids) {
            long[] r = refusals.getOrDefault(pid, new long[]{0, 0});
            double[] s = stops.getOrDefault(pid, new double[]{0, 0});
            out.add(new DeficitRow(pid, cat.productName(pid), r[0], (long) s[0], s[1], r[1]));
        }
        out.sort(Comparator.comparingDouble((DeficitRow d) -> d.refusals() * 10 + d.stopHours()).reversed());
        return out;
    }

    // ── Журнал, заказы, поставки ───────────────────────────────────────────

    public List<LedgerRow> ledger(String loc, String type, String productId, Long beforeSeq, int limit) {
        CatalogService.Snapshot cat = catalog.forLocation(loc);
        return jdbc.sql("""
                        SELECT m.id, m.seq, m.at, m.type, m.batch_id, b.label, b.product_id, m.qty, m.cost_kop,
                               COALESCE(u.name, k.name, 'Система'), m.reason, m.doc_type, m.doc_id, m.hash
                        FROM movements m JOIN batches b ON b.id = m.batch_id
                        LEFT JOIN users u ON u.id = m.actor_id LEFT JOIN api_keys k ON k.id = m.api_key_id
                        WHERE m.location_id = ? AND (?::text IS NULL OR m.type = ?) AND (?::text IS NULL OR b.product_id = ?)
                          AND (?::bigint IS NULL OR m.seq < ?)
                        ORDER BY m.seq DESC LIMIT ?""")
                .params(loc, type, type, productId, productId, beforeSeq, beforeSeq, limit)
                .query((rs, n) -> {
                    ProductInfo p = cat.product(rs.getString(7));
                    MovementType t = MovementType.valueOf(rs.getString(4));
                    return new LedgerRow(rs.getLong(1), rs.getLong(2), rs.getTimestamp(3).toInstant(), t.name(), t.title(),
                            rs.getLong(5), rs.getString(6), p.name(), rs.getLong(8), p.format(rs.getLong(8)),
                            rs.getLong(9), rs.getString(10), rs.getString(11), rs.getString(12), rs.getString(13),
                            rs.getString(14));
                })
                .list();
    }

    public List<OrderDto> orders(String loc, String status, int limit) {
        CatalogService.Snapshot cat = catalog.forLocation(loc);
        List<OrderDto> orders = jdbc.sql("""
                        SELECT o.*, u.name AS creator, c.name AS canceler, k.name AS api_name FROM orders o
                        LEFT JOIN users u ON u.id = o.created_by LEFT JOIN users c ON c.id = o.canceled_by
                        LEFT JOIN api_keys k ON k.id = o.api_key_id
                        WHERE o.location_id = ? AND (?::text IS NULL OR o.status = ?)
                        ORDER BY o.created_at DESC LIMIT ?""")
                .params(loc, status, status, limit)
                .query((rs, n) -> new OrderDto(rs.getLong("id"), rs.getLong("number"), rs.getString("external_id"),
                        rs.getString("source"), rs.getString("status"), rs.getTimestamp("created_at").toInstant(),
                        rs.getString("creator") != null ? rs.getString("creator") : rs.getString("api_name"),
                        rs.getLong("total_kop"), rs.getLong("cost_kop"), rs.getString("cancel_reason"),
                        rs.getString("canceler"), new ArrayList<>()))
                .list();
        if (orders.isEmpty()) {
            return orders;
        }
        Map<Long, OrderDto> byId = new LinkedHashMap<>();
        orders.forEach(o -> byId.put(o.id(), o));
        jdbc.sql("SELECT order_id, variant_id, qty, price_kop FROM order_lines WHERE order_id = ANY(?) ORDER BY order_id, line_no")
                .param(byId.keySet().toArray(Long[]::new))
                .query(rs -> {
                    byId.get(rs.getLong(1)).lines().add(new OrderLineDto(rs.getString(2), cat.variantName(rs.getString(2)),
                            rs.getInt(3), rs.getLong(4)));
                });
        return orders;
    }

    public List<DeliveryDto> deliveries(String loc, String status, int limit) {
        return deliveries(loc, status, limit, null);
    }

    /** @param onlyKey внешней системе — только её поставки: чужие накладные с ценами ей не показываем */
    public List<DeliveryDto> deliveries(String loc, String status, int limit, Long onlyKey) {
        CatalogService.Snapshot cat = catalog.forLocation(loc);
        Instant now = clock.now();
        List<DeliveryDto> list = jdbc.sql("""
                        SELECT d.*, u.name AS accepter, a.name AS approver FROM deliveries d
                        LEFT JOIN users u ON u.id = d.accepted_by LEFT JOIN users a ON a.id = d.approved_by
                        WHERE d.location_id = ? AND (?::text IS NULL OR d.status = ?)
                          AND (?::bigint IS NULL OR d.api_key_id = ?)
                        ORDER BY d.received_at DESC LIMIT ?""")
                .params(loc, status, status, onlyKey, onlyKey, limit)
                .query((rs, n) -> new DeliveryDto(rs.getString("id"), rs.getString("number"),
                        rs.getTimestamp("created_at").toInstant(), rs.getString("supplier"), rs.getString("status"),
                        rs.getTimestamp("received_at").toInstant(), rs.getString("accepter"),
                        rs.getTimestamp("accepted_at") == null ? null : rs.getTimestamp("accepted_at").toInstant(),
                        rs.getBoolean("mock"), rs.getString("channel"), rs.getString("reject_comment"),
                        (Long) rs.getObject("approved_by"), rs.getString("approver"),
                        rs.getTimestamp("approved_at") == null ? null : rs.getTimestamp("approved_at").toInstant(),
                        rs.getString("approval_comment"), rs.getString("invoice_photo") != null,
                        Math.max(rs.getString("invoice_photo") != null ? 1 : 0,
                                ((Object[]) rs.getArray("invoice_photos").getArray()).length), new ArrayList<>()))
                .list();
        if (list.isEmpty()) {
            return list;
        }
        Map<String, DeliveryDto> byId = new LinkedHashMap<>();
        list.forEach(d -> byId.put(d.id(), d));
        jdbc.sql("""
                        SELECT l.*, b.id AS batch_id, b.label AS batch_label, b.qty_left AS batch_left
                        FROM delivery_lines l
                        LEFT JOIN LATERAL (SELECT id, label, qty_left FROM batches
                                           WHERE delivery_line_id = l.id ORDER BY id LIMIT 1) b ON TRUE
                        WHERE l.tenant_id = (SELECT tenant_id FROM locations WHERE id = ?)
                          AND l.delivery_id = ANY(?) ORDER BY l.delivery_id, l.line_no""")
                .params(loc, byId.keySet().toArray(String[]::new))
                .query(rs -> {
                    DeliveryDto d = byId.get(rs.getString("delivery_id"));
                    ProductInfo p = cat.product(rs.getString("product_id"));
                    Object shelf = rs.getObject("shelf_life_minutes");
                    Instant expires = rs.getTimestamp("expires_at") != null ? rs.getTimestamp("expires_at").toInstant()
                            : d.createdAt().plus(Duration.ofMinutes(((Number) shelf).longValue()));
                    // Статус срока на сейчас: та же политика «скоро истекает», что у партий на складе.
                    BatchState probe = new BatchState(0, p.id(), 1, 0, d.createdAt(), expires, now, false, false, 0, 1);
                    Long actual = (Long) rs.getObject("qty_actual");
                    Long approvedQty = (Long) rs.getObject("approved_qty");
                    d.lines().add(new DeliveryLineDto(rs.getInt("line_no"), p.id(), rs.getString("name"),
                            rs.getString("unit"), rs.getLong("qty_invoice"), actual, p.format(rs.getLong("qty_invoice")),
                            actual == null ? null : p.format(actual), shelf == null ? null : ((Number) shelf).intValue() / 60,
                            expires, (Long) rs.getObject("cost_total_kop"), ExpiryPolicy.status(probe, p, now).name(),
                            Duration.between(now, expires).toMinutes() / 60.0, rs.getString("reject_reason"),
                            rs.getString("reject_comment"), approvedQty, approvedQty == null ? null : p.format(approvedQty),
                            rs.getString("approve_note"), (Long) rs.getObject("batch_id"), rs.getString("batch_label"),
                            rs.getObject("batch_left") == null ? null : p.format(rs.getLong("batch_left"))));
                });
        return list;
    }

    // ── Поставлено — съедено — просрочено (ТЗ 16.1, шаг 7) ─────────────────

    public List<SupplyRow> supply(String loc, int days) {
        return supply(loc, period(loc, days, null, null));
    }

    public List<SupplyRow> supply(String loc, Period period) {
        CatalogService.Snapshot cat = catalog.forLocation(loc);
        Timestamp from = Timestamp.from(period.from());
        Timestamp until = Timestamp.from(period.to());
        Map<String, long[]> agg = new LinkedHashMap<>();   // received, consumed, expired, expiredKop, otherLoss, deliveries
        jdbc.sql("""
                        SELECT b.product_id,
                               COALESCE(SUM(m.qty) FILTER (WHERE m.type IN ('RECEIPT', 'PRODUCTION_OUT', 'RETURN_SUPPLIER')), 0),
                               COALESCE(-SUM(m.qty) FILTER (WHERE m.type IN ('ORDER', 'PRODUCTION_USE', 'ORDER_RETURN')), 0),
                               COALESCE(-SUM(m.qty) FILTER (WHERE m.type = 'WRITEOFF_EXPIRED'), 0),
                               COALESCE(-SUM(m.cost_kop) FILTER (WHERE m.type = 'WRITEOFF_EXPIRED'), 0),
                               COALESCE(-SUM(m.qty) FILTER (WHERE m.type LIKE 'WRITEOFF_%' AND m.type <> 'WRITEOFF_EXPIRED'), 0),
                               COUNT(DISTINCT m.doc_id) FILTER (WHERE m.type IN ('RECEIPT', 'PRODUCTION_OUT'))
                        FROM movements m JOIN batches b ON b.id = m.batch_id
                        WHERE m.location_id = ? AND m.at >= ? AND m.at < ?
                        GROUP BY b.product_id""")
                .params(loc, from, until)
                .query(rs -> {
                    agg.put(rs.getString(1), new long[]{rs.getLong(2), rs.getLong(3), rs.getLong(4), rs.getLong(5),
                            rs.getLong(6), rs.getLong(7)});
                });
        Map<String, Long> left = new HashMap<>();
        jdbc.sql("SELECT product_id, SUM(qty_left) FROM batches WHERE location_id = ? AND qty_left > 0 GROUP BY product_id")
                .param(loc).query(rs -> {
                    left.put(rs.getString(1), rs.getLong(2));
                });
        List<SupplyRow> out = new ArrayList<>();
        agg.forEach((pid, a) -> {
            ProductInfo p = cat.product(pid);
            if (p == null || a[0] == 0) {
                return;
            }
            double share = (double) a[2] / a[0];
            String advice;
            String level;
            if (share >= 0.1) {
                // Сколько на самом деле съедают между поставками — столько и возить, плюс 10 % запаса.
                double perDelivery = a[5] > 0 ? (double) a[1] / a[5] * 1.1 : 0;
                long perDeliveryRounded = p.packSize() != null && p.packSize() > 0
                        ? (long) Math.ceil(perDelivery / p.packSize()) * p.packSize() : Math.round(perDelivery);
                advice = "Просрочено " + Math.round(share * 100) + " % привезённого. Возите меньше"
                        + (perDeliveryRounded > 0 ? ": около " + p.format(perDeliveryRounded) + " на поставку" : "");
                level = "bad";
            } else if (a[1] >= a[0] * 0.95 && a[2] == 0) {
                advice = "Съедают почти всё — следите за стоп-листом";
                level = "warn";
            } else if (a[1] < a[0] * 0.5 && left.getOrDefault(pid, 0L) > 0) {
                // Ещё не просрочено, но расходуется медленно: следующая поставка рискует уйти в просрочку.
                advice = "Съели меньше половины — запас ещё лежит, с поставкой не спешите";
                level = "info";
            } else {
                advice = "Поставки по расходу";
                level = "ok";
            }
            long l = left.getOrDefault(pid, 0L);
            out.add(new SupplyRow(pid, p.name(), p.unit().name(), a[0], p.format(a[0]), a[1], p.format(a[1]), a[2],
                    p.format(a[2]), a[3], a[4], p.format(a[4]), l, p.format(l), a[5], share, advice, level));
        });
        out.sort(java.util.Comparator.comparingLong(SupplyRow::expiredKop).reversed()
                .thenComparing(SupplyRow::productName));
        return out;
    }

    /** Имя файла фото накладной; {@code null} — фото не прикладывали. */
    /** Фото накладной по номеру (0 — первое); {@code null} — фото нет. */
    public String invoicePhoto(String loc, String deliveryId, int index) {
        List<String> all = jdbc.sql("""
                        SELECT CASE WHEN cardinality(invoice_photos) > 0 THEN invoice_photos ELSE ARRAY[invoice_photo] END
                        FROM deliveries WHERE location_id = ? AND id = ?""")
                .params(loc, deliveryId)
                .query((rs, n) -> java.util.Arrays.asList((String[]) rs.getArray(1).getArray()))
                .optional().orElse(List.of());
        return index >= 0 && index < all.size() ? all.get(index) : null;
    }
}
