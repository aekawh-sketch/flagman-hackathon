package ru.sphere.stock.web;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.media.Schema;
import ru.sphere.stock.config.OpenApiConfig;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import ru.sphere.stock.alerts.AlertService;
import ru.sphere.stock.domain.OrderLine;
import ru.sphere.stock.events.EventBus;
import ru.sphere.stock.ledger.Ledger;
import ru.sphere.stock.menu.InsightsService;
import ru.sphere.stock.menu.MenuService;
import ru.sphere.stock.order.OrderService;
import ru.sphere.stock.security.Access;
import ru.sphere.stock.stock.BatchService;
import ru.sphere.stock.stock.ExpiryJob;
import ru.sphere.stock.stock.ProductionService;

/** Склад, партии, заготовки, меню и стоп-лист, горячие предложения, закупки, сигналы, SSE. */
@RestController
@RequestMapping("/api/{loc}")
public class StockController {

    public record OpenIn(int packs) {
    }

    public record BlockIn(String reason, boolean cascade) {
    }

    public record ReasonIn(String reason) {
    }

    public record DisposeIn(boolean toSupplier) {
    }

    public record ProduceIn(String productId, long qty) {
    }

    public record DashboardDto(QueryService.Kpis kpis, Ledger.Verification integrity) {
    }

    private final QueryService query;
    private final BatchService batches;
    private final ProductionService production;
    private final MenuService menu;
    private final InsightsService insights;
    private final AlertService alerts;
    private final EventBus bus;
    private final ExpiryJob expiry;

    public StockController(QueryService query, BatchService batches, ProductionService production, MenuService menu,
                           InsightsService insights, AlertService alerts, EventBus bus, ExpiryJob expiry) {
        this.expiry = expiry;
        this.query = query;
        this.batches = batches;
        this.production = production;
        this.menu = menu;
        this.insights = insights;
        this.alerts = alerts;
        this.bus = bus;
    }

    @Operation(summary = "Показатели дня и целостность журнала", tags = OpenApiConfig.T_ANALYTICS)
    @GetMapping("/dashboard")
    public DashboardDto dashboard(@PathVariable String loc,
                                  @RequestParam(required = false) java.time.LocalDate from,
                                  @RequestParam(required = false) java.time.LocalDate to) {
        Access.requireRole(loc, Access.MANAGERS);
        return new DashboardDto(query.kpis(loc, query.period(loc, 1, from, to)), query.integrity(loc, false));
    }

    @Operation(summary = "Остатки по продуктам", description = "Доступно, скоро истекает, ждёт списания, заблокировано, на сколько дней хватит.", tags = OpenApiConfig.T_STOCK)
    @GetMapping("/stock")
    public List<QueryService.ProductStock> stock(@PathVariable String loc) {
        Access.require(loc, "stock:read", Access.STOCK_VIEW);
        return query.stock(loc);
    }

    @Operation(summary = "Партии в порядке FEFO", description = "Первой идёт партия, которая раньше испортится.", tags = OpenApiConfig.T_STOCK)
    @GetMapping("/batches")
    public List<QueryService.BatchDto> batches(@PathVariable String loc, @RequestParam(required = false) String product,
                                               @RequestParam(defaultValue = "false") boolean includeEmpty) {
        Access.require(loc, "stock:read", Access.STOCK_VIEW);
        return query.batches(loc, product, includeEmpty);
    }

    @Operation(summary = "Карточка партии: откуда пришла и куда ушла", description = "Все движения партии, заказы из неё, подпартии и заготовки.", tags = OpenApiConfig.T_STOCK)
    @GetMapping("/batches/{id}")
    public BatchService.Trace trace(@PathVariable String loc, @PathVariable long id) {
        Access.require(loc, "stock:read", Access.STOCK_VIEW);
        return batches.trace(loc, id);
    }

    @Operation(summary = "Вскрыть упаковки", description = "Вскрытая часть отделяется в подпартию с коротким сроком (срок после вскрытия).", tags = OpenApiConfig.T_STOCK)
    @PostMapping("/batches/{id}/open")
    public Map<String, Object> open(@PathVariable String loc, @PathVariable long id, @RequestBody OpenIn in) {
        var p = Access.requireRole(loc, "COOK", "STOREKEEPER", "MANAGER");
        return Map.of("childBatchId", batches.open(loc, id, in.packs(), p.actor()));
    }

    @Operation(summary = "Заблокировать партию (отзыв)", description = "Партия сразу исключается из продажи; cascade=true — и заготовки, сделанные из неё.", tags = OpenApiConfig.T_STOCK)
    @PostMapping("/batches/{id}/block")
    public Map<String, Object> block(@PathVariable String loc, @PathVariable long id, @RequestBody BlockIn in) {
        var p = Access.requireRole(loc, "MANAGER");
        return Map.of("blocked", batches.block(loc, id, in.reason(), in.cascade(), p.actor()));
    }

    @Operation(summary = "Снять блокировку партии", tags = OpenApiConfig.T_STOCK)
    @PostMapping("/batches/{id}/unblock")
    public Map<String, Object> unblock(@PathVariable String loc, @PathVariable long id, @RequestBody ReasonIn in) {
        var p = Access.requireRole(loc, "MANAGER");
        batches.unblock(loc, id, in.reason(), p.actor());
        return Map.of("ok", true);
    }

    @Operation(summary = "Списать остаток заблокированной партии", description = "Отзыв или возврат поставщику.", tags = OpenApiConfig.T_STOCK)
    @PostMapping("/batches/{id}/dispose")
    public Map<String, Object> dispose(@PathVariable String loc, @PathVariable long id, @RequestBody DisposeIn in) {
        var p = Access.requireRole(loc, "MANAGER");
        batches.disposeBlocked(loc, id, in.toSupplier(), p.actor());
        return Map.of("ok", true);
    }

    // ── Просрочка: под списание → списывает человек (ТЗ 16.1, шаг 6) ──────

    @Operation(summary = "Партии под списанием", description = "Срок истёк, остаток ещё числится. Из продаж они уже исключены — их надо списать.", tags = OpenApiConfig.T_STOCK)
    @GetMapping("/expired")
    public List<ExpiryJob.ExpiredBatch> expired(@PathVariable String loc) {
        Access.require(loc, "stock:read", Access.STOCK_VIEW);
        return expiry.expired(loc);
    }

    @Operation(summary = "Списать просроченную партию", description = "Только если срок истёк по серверным часам; списывается весь остаток, в журнал — кто и когда.", tags = OpenApiConfig.T_STOCK)
    @PostMapping("/batches/{id}/writeoff-expired")
    public Map<String, Object> writeOffExpired(@PathVariable String loc, @PathVariable long id) {
        var p = Access.requireRole(loc, Access.STOCK_VIEW);
        return Map.of("ok", true, "costKop", expiry.writeOffExpiredBatch(loc, id, p.actor()));
    }

    @Operation(summary = "Списать всю просрочку точки", tags = OpenApiConfig.T_STOCK)
    @PostMapping("/expired/writeoff")
    public Map<String, Object> writeOffAllExpired(@PathVariable String loc) {
        var p = Access.requireRole(loc, "STOREKEEPER", "MANAGER", "ADMIN");
        return Map.of("ok", true, "batches", expiry.writeOffExpired(loc, p.actor()));
    }

    @Operation(summary = "Приготовить заготовку", description = "Сырьё списывается по FEFO; срок новой партии — не позже самого раннего срока сырья. При нехватке — 409 с объяснением.", tags = OpenApiConfig.T_PRODUCTION)
    @PostMapping("/production")
    public ProductionService.Result produce(@PathVariable String loc, @RequestBody ProduceIn in) {
        var p = Access.requireRole(loc, "COOK", "STOREKEEPER", "MANAGER");
        return production.produce(loc, in.productId(), in.qty(), p.actor());
    }

    @Operation(summary = "Меню с доступными порциями и стоп-листом", description = "Порции = минимум по продуктам техкарты ⌊доступно / брутто⌋.", tags = OpenApiConfig.T_MENU)
    @GetMapping("/menu")
    public List<MenuService.VariantStatus> menu(@PathVariable String loc) {
        Access.require(loc, "menu:read", Access.STAFF);
        return menu.menu(loc);
    }

    @Schema(name = "CartIn", description = "Корзина кассы: ещё не пробитые блюда")
    public record CartIn(@Schema(description = "Блюда корзины") List<OrderService.LineIn> lines) {
    }

    @Operation(summary = "Сколько останется после корзины", description = "То же меню, но за вычетом корзины: касса показывает «осталось 5, 4, 3…» по мере того, как пробивают блюдо. Общие продукты учтены: два ролла на лососе уменьшают и порции поке.", tags = OpenApiConfig.T_MENU)
    @PostMapping("/menu/left")
    public List<MenuService.VariantStatus> menuLeft(@PathVariable String loc, @RequestBody CartIn in) {
        Access.require(loc, "menu:read", Access.STAFF);
        List<OrderLine> cart = in.lines() == null ? List.of() : in.lines().stream()
                .filter(l -> l.variantId() != null && l.qty() > 0)
                .limit(100)
                .map(l -> new OrderLine(l.variantId(), Math.min(l.qty(), 100)))
                .toList();
        return menu.menuAfter(loc, cart);
    }

    @Operation(summary = "Прогноз стоп-листа", description = "Когда у блюда кончатся порции и почему: закончится продукт или истечёт партия.", tags = OpenApiConfig.T_MENU)
    @GetMapping("/stoplist/forecast")
    public List<InsightsService.StopEtaDto> stopForecast(@PathVariable String loc,
                                                         @RequestParam(defaultValue = "48") int hours) {
        Access.require(loc, "menu:read", Access.STAFF);
        return insights.stopForecast(loc, Duration.ofHours(Math.min(Math.max(hours, 1), 168)));
    }

    @Operation(summary = "Горячие предложения с объяснениями", description = "Блюда, продажа которых спасёт продукты, которые иначе пропадут.", tags = OpenApiConfig.T_MENU)
    @GetMapping("/hot-offers")
    public InsightsService.HotOffersResult hot(@PathVariable String loc) {
        Access.require(loc, "menu:read", Access.STAFF);
        return insights.hotOffers(loc);
    }

    @Operation(summary = "Что заказать и чего не заказывать", tags = OpenApiConfig.T_PURCHASES)
    @GetMapping("/purchase-suggestions")
    public InsightsService.PurchasesResult purchases(@PathVariable String loc) {
        Access.require(loc, "analytics:read", "STOREKEEPER", "MANAGER", "ADMIN");
        return insights.purchases(loc);
    }

    @Operation(summary = "Сигналы", tags = OpenApiConfig.T_ALERTS)
    @GetMapping("/alerts")
    public List<AlertService.Alert> alerts(@PathVariable String loc, @RequestParam(defaultValue = "false") boolean open) {
        var p = Access.requireRole(loc, Access.STAFF);
        return alerts.list(loc, open, 100, roleOf(p));
    }

    @Operation(summary = "Отметить сигнал «увидел»", tags = OpenApiConfig.T_ALERTS)
    @PostMapping("/alerts/{id}/ack")
    public Map<String, Object> ack(@PathVariable String loc, @PathVariable long id) {
        var p = Access.requireRole(loc, Access.STAFF);
        alerts.ack(loc, id, p.actor(), roleOf(p));
        return Map.of("ok", true);
    }

    @Operation(summary = "Отметить все сигналы", tags = OpenApiConfig.T_ALERTS)
    @PostMapping("/alerts/ack-all")
    public Map<String, Object> ackAll(@PathVariable String loc) {
        var p = Access.requireRole(loc, Access.STAFF);
        return Map.of("acked", alerts.ackAll(loc, p.actor(), roleOf(p)));
    }

    /** Поток событий реального времени (ТЗ 5.13). */
    @Operation(summary = "Поток событий реального времени (SSE)", description = "События: stock, alert, clock, reset.", tags = OpenApiConfig.T_ALERTS)
    @GetMapping(value = "/events", produces = "text/event-stream")
    public SseEmitter events(@PathVariable String loc) {
        var p = Access.require(loc, "events:read", Access.STAFF);
        return bus.subscribe(loc, roleOf(p));
    }

    /** Роль для адресатов сигналов; у внешней системы по ключу — {@code null}: ей видно всё. */
    private static String roleOf(ru.sphere.stock.security.StockPrincipal p) {
        return p.kind() == ru.sphere.stock.ledger.Actor.Kind.API ? null : p.role();
    }
}
