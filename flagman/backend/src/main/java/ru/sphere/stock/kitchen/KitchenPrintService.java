package ru.sphere.stock.kitchen;

import io.swagger.v3.oas.annotations.media.Schema;
import java.io.IOException;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;
import ru.sphere.stock.admin.AuditService;
import ru.sphere.stock.alerts.AlertService;
import ru.sphere.stock.catalog.CatalogService;
import ru.sphere.stock.domain.VariantDef;
import ru.sphere.stock.events.EventBus;
import ru.sphere.stock.events.OrderPlaced;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.infra.AppClock;
import ru.sphere.stock.infra.Json;
import ru.sphere.stock.ledger.Actor;
import ru.sphere.stock.tenant.TenantDirectory;

/**
 * Чек на кухню (ТЗ 16.15): кассир пробил заказ — после коммита создаётся чек и уходит на принтер точки.
 * Печать — в фоне: медленный или выключенный принтер не задерживает кассу. Не напечаталось — чек помечен
 * «ошибка», повару и управляющему приходит сигнал, «Печать ещё раз» — с экрана кухни.
 */
@Service
public class KitchenPrintService {

    private static final Logger log = LoggerFactory.getLogger(KitchenPrintService.class);
    public static final Set<String> MODES = Set.of("OFF", "SCREEN", "NETWORK");
    private static final Map<String, String> SOURCE = Map.of("POS", "Касса", "SITE", "Сайт", "GENERATOR", "Демо-генератор",
            "API", "Внешняя система");

    @Schema(name = "KitchenTicket", description = "Чек на кухню: что пробили и куда ушла печать")
    public record TicketDto(long id, long orderId, long orderNumber, String source, Instant createdAt,
                            List<KitchenTicket.Line> lines,
                            @Schema(description = "QUEUED — ждёт печати, PRINTED — напечатан, SHOWN — на экране кухни, FAILED — принтер не ответил") String status,
                            String printer, int attempts, Instant printedAt, String error) {
    }

    @Schema(name = "KitchenPrinterIn", description = "Настройка принтера кухни точки")
    public record PrinterIn(String mode, String host, Integer port, Integer paperMm, Integer copies) {
    }

    @Schema(name = "PrintResult", description = "Итог печати")
    public record PrintResult(String status, String printer, String error) {
    }

    private final JdbcClient jdbc;
    private final CatalogService catalog;
    private final Json json;
    private final EventBus bus;
    private final AlertService alerts;
    private final AuditService audit;
    private final AppClock clock;
    private final Map<String, PrinterDriver> drivers;
    /** Печать в фоне — на виртуальных потоках: ожидание принтера не занимает поток ОС. */
    private final ExecutorService printing = Executors.newThreadPerTaskExecutor(
            Thread.ofVirtual().name("kitchen-print-", 0).factory());
    /** Один принтер — одно задание за раз, иначе два чека перемешаются на ленте. */
    private final Map<String, ReentrantLock> locks = new ConcurrentHashMap<>();

    public KitchenPrintService(JdbcClient jdbc, CatalogService catalog, Json json, EventBus bus, AlertService alerts,
                               AuditService audit, AppClock clock, List<PrinterDriver> drivers) {
        this.jdbc = jdbc;
        this.catalog = catalog;
        this.json = json;
        this.bus = bus;
        this.alerts = alerts;
        this.audit = audit;
        this.clock = clock;
        this.drivers = drivers.stream().collect(Collectors.toMap(PrinterDriver::mode, Function.identity()));
    }

    // ── Заказ создан → чек ─────────────────────────────────────────────────

    /** Только после коммита: откатившийся заказ чека не печатает. */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    public void onOrderPlaced(OrderPlaced e) {
        printing.submit(() -> {
            try {
                Long id = createTicket(e.locationId(), e.orderId());
                if (id != null) {
                    print(id);
                }
            } catch (RuntimeException ex) {
                log.warn("kitchen ticket for order {} failed: {}", e.orderId(), ex.getMessage());
            }
        });
    }

    /** Чек заказа — снимок блюд на момент заказа. @return id чека; {@code null} — у точки печать выключена */
    Long createTicket(String locationId, long orderId) {
        if ("OFF".equals(printer(locationId).mode())) {
            return null;
        }
        Object[] o = jdbc.sql("SELECT number, source, created_at FROM orders WHERE id = ? AND location_id = ?")
                .params(orderId, locationId)
                .query((rs, n) -> new Object[]{rs.getLong(1), rs.getString(2), rs.getTimestamp(3)})
                .single();
        var cat = catalog.forLocation(locationId);
        Function<String, String> name = id -> {
            VariantDef v = cat.variant(id);
            return v == null ? id : v.name();
        };
        List<KitchenTicket.Line> lines = jdbc.sql("SELECT variant_id, qty FROM order_lines WHERE order_id = ? ORDER BY line_no")
                .param(orderId)
                .query((rs, n) -> {
                    String vid = rs.getString(1);
                    int qty = rs.getInt(2);
                    VariantDef v = cat.variant(vid);
                    List<KitchenTicket.Line> items = v == null ? List.of() : v.setItems().stream()
                            .map(si -> new KitchenTicket.Line(name.apply(si.variantId()), si.qty() * qty, null))
                            .toList();
                    return new KitchenTicket.Line(name.apply(vid), qty, items);
                })
                .list();
        return jdbc.sql("""
                        INSERT INTO kitchen_tickets (location_id, order_id, order_number, source, created_at, lines, status)
                        VALUES (?, ?, ?, ?, ?, ?::jsonb, 'QUEUED')
                        ON CONFLICT (order_id) DO NOTHING RETURNING id""")
                .params(locationId, orderId, o[0], o[1], o[2], json.write(lines))
                .query(Long.class).optional().orElse(null);
    }

    /** Напечатать чек (первый раз или «ещё раз»): статус, попытка и ошибка — в журнал чеков. */
    public PrintResult print(long ticketId) {
        TicketDto t = ticket(ticketId);
        String loc = locationOf(ticketId);
        PrinterConfig p = printer(loc);
        PrinterDriver driver = drivers.get(p.mode());
        if (driver == null) {
            throw ApiException.conflict("Печать на кухню выключена — включите её в «Админке → Принтер кухни»");
        }
        KitchenTicket ticket = new KitchenTicket(t.orderNumber(), locationName(loc), SOURCE.getOrDefault(t.source(), t.source()),
                t.createdAt().atZone(zone(loc)), t.lines());
        PrintResult r = send(loc, driver, ticket, p);
        jdbc.sql("""
                        UPDATE kitchen_tickets SET status = ?, printer = ?, error = ?, attempts = attempts + 1,
                               printed_at = CASE WHEN ? = 'FAILED' THEN printed_at ELSE now() END
                        WHERE id = ?""")
                .params(r.status(), r.printer(), r.error(), r.status(), ticketId).update();
        if ("FAILED".equals(r.status())) {
            alerts.raise(loc, "PRINTER_FAILED", "WARN", "kitchen_ticket", Long.toString(ticketId),
                    "Чек на кухню №" + t.orderNumber() + " не напечатан", r.error(), clock.now());
        }
        bus.publish(loc, "kitchen", Map.of("ticket", ticketId, "status", r.status()));
        return r;
    }

    private PrintResult send(String loc, PrinterDriver driver, KitchenTicket ticket, PrinterConfig p) {
        ReentrantLock lock = locks.computeIfAbsent(loc, k -> new ReentrantLock());
        lock.lock();
        try {
            return new PrintResult(driver.print(ticket, p), driver.target(p), null);
        } catch (IOException | ApiException e) {
            return new PrintResult("FAILED", driver.target(p),
                    "Принтер " + driver.target(p) + " не ответил: " + e.getMessage());
        } finally {
            lock.unlock();
        }
    }

    /** Пробный чек — проверить принтер из «Админки», не создавая заказа. */
    public PrintResult test(String locationId) {
        PrinterConfig p = printer(locationId);
        PrinterDriver driver = drivers.get(p.mode());
        if (driver == null) {
            throw ApiException.conflict("Печать выключена — выберите экран кухни или сетевой принтер");
        }
        KitchenTicket ticket = new KitchenTicket(0, locationName(locationId), "Проверка принтера",
                clock.now().atZone(zone(locationId)), List.of(new KitchenTicket.Line("Пробная строка", 1,
                List.of(new KitchenTicket.Line("Кириллица и цифры 0123456789", 1, null)))));
        return send(locationId, driver, ticket, p);
    }

    // ── Чеки и принтер точки ───────────────────────────────────────────────

    public List<TicketDto> tickets(String locationId, int limit) {
        return tickets(locationId, null, null, limit);
    }

    /** Чеки за отрезок времени (ТЗ 16.18): день и часы с экрана кухни; без границ — последние. */
    public List<TicketDto> tickets(String locationId, Instant from, Instant to, int limit) {
        if (from != null && to != null && !from.isBefore(to)) {
            throw ApiException.badRequest("Начало отрезка должно быть раньше конца");
        }
        return jdbc.sql("""
                        SELECT * FROM kitchen_tickets WHERE location_id = ?
                          AND (?::timestamptz IS NULL OR created_at >= ?) AND (?::timestamptz IS NULL OR created_at < ?)
                        ORDER BY created_at DESC, id DESC LIMIT ?""")
                .params(locationId, ts(from), ts(from), ts(to), ts(to), Math.min(Math.max(limit, 1), 200))
                .query((rs, n) -> map(rs)).list();
    }

    private static Timestamp ts(Instant i) {
        return i == null ? null : Timestamp.from(i);
    }

    public TicketDto ticket(long id) {
        return jdbc.sql("SELECT * FROM kitchen_tickets WHERE id = ?").param(id)
                .query((rs, n) -> map(rs)).optional().orElseThrow(() -> ApiException.notFound("Чек"));
    }

    /** Чек этой точки — чужой по id не напечатать. */
    public TicketDto ticketAt(String locationId, long id) {
        TicketDto t = ticket(id);
        if (!locationOf(id).equals(locationId)) {
            throw ApiException.notFound("Чек");
        }
        return t;
    }

    private String locationOf(long ticketId) {
        return jdbc.sql("SELECT location_id FROM kitchen_tickets WHERE id = ?").param(ticketId).query(String.class).single();
    }

    private TicketDto map(java.sql.ResultSet rs) throws java.sql.SQLException {
        Timestamp printed = rs.getTimestamp("printed_at");
        return new TicketDto(rs.getLong("id"), rs.getLong("order_id"), rs.getLong("order_number"), rs.getString("source"),
                rs.getTimestamp("created_at").toInstant(),
                List.of(json.read(rs.getString("lines"), KitchenTicket.Line[].class)),
                rs.getString("status"), rs.getString("printer"), rs.getInt("attempts"),
                printed == null ? null : printed.toInstant(), rs.getString("error"));
    }

    /** Принтер точки; не настроен — чеки на экране кухни. */
    public PrinterConfig printer(String locationId) {
        return jdbc.sql("SELECT mode, host, port, paper_mm, copies FROM kitchen_printers WHERE location_id = ?")
                .param(locationId)
                .query((rs, n) -> new PrinterConfig(locationId, rs.getString(1), rs.getString(2), rs.getInt(3),
                        rs.getInt(4), rs.getInt(5)))
                .optional()
                .orElse(new PrinterConfig(locationId, "SCREEN", null, 9100, 80, 1));
    }

    public PrinterConfig savePrinter(String locationId, PrinterIn in, Actor actor) {
        String mode = in.mode() == null ? "" : in.mode().strip().toUpperCase();
        if (!MODES.contains(mode)) {
            throw ApiException.badRequest("Режим — OFF, SCREEN или NETWORK");
        }
        String host = in.host() == null || in.host().isBlank() ? null : in.host().strip();
        int port = in.port() == null ? 9100 : in.port();
        int paper = in.paperMm() == null ? 80 : in.paperMm();
        int copies = in.copies() == null ? 1 : in.copies();
        if ("NETWORK".equals(mode)) {
            if (host == null) {
                throw ApiException.badRequest("Укажите адрес принтера в сети ресторана, например 192.168.1.50");
            }
            lanAddress(host);
        }
        if (port < 1 || port > 65535) {
            throw ApiException.badRequest("Порт — от 1 до 65535 (у термопринтеров обычно 9100)");
        }
        if (paper != 58 && paper != 80) {
            throw ApiException.badRequest("Ширина ленты — 58 или 80 мм");
        }
        if (copies < 1 || copies > 3) {
            throw ApiException.badRequest("Копий — от 1 до 3");
        }
        jdbc.sql("""
                        INSERT INTO kitchen_printers (location_id, mode, host, port, paper_mm, copies, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, now())
                        ON CONFLICT (location_id) DO UPDATE SET mode = EXCLUDED.mode, host = EXCLUDED.host,
                            port = EXCLUDED.port, paper_mm = EXCLUDED.paper_mm, copies = EXCLUDED.copies, updated_at = now()""")
                .params(locationId, mode, host, port, paper, copies).update();
        audit.record(TenantDirectory.get().tenantOf(locationId), actor, "printer.update",
                Map.of("location", locationId, "mode", mode, "target", host == null ? "" : host + ":" + port));
        return printer(locationId);
    }

    /**
     * Принтер — только в сети ресторана (192.168.x.x, 10.x.x.x, 172.16–31.x.x, этот компьютер): иначе через
     * «принтер» сервер можно было бы заставить стучаться куда угодно (SSRF). Проверяется и при настройке,
     * и перед каждой печатью — адрес по имени мог смениться.
     */
    static InetAddress lanAddress(String host) {
        if (host == null || !host.matches("[A-Za-z0-9.\\-]{1,253}")) {
            throw ApiException.badRequest("Адрес принтера — IP или имя в сети ресторана, без http:// и порта");
        }
        InetAddress a;
        try {
            a = InetAddress.getByName(host);
        } catch (UnknownHostException e) {
            throw ApiException.badRequest("Не нахожу принтер «" + host + "» в сети");
        }
        if (!(a.isSiteLocalAddress() || a.isLoopbackAddress() || a.isLinkLocalAddress())) {
            throw ApiException.badRequest("Принтер должен быть в сети ресторана: 192.168.x.x, 10.x.x.x или 172.16–31.x.x");
        }
        return a;
    }

    private String locationName(String locationId) {
        return jdbc.sql("SELECT name FROM locations WHERE id = ?").param(locationId).query(String.class).single();
    }

    private ZoneId zone(String locationId) {
        return ZoneId.of(jdbc.sql("SELECT timezone FROM locations WHERE id = ?").param(locationId).query(String.class).single());
    }
}
