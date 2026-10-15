package ru.sphere.stock.demo;

import io.swagger.v3.oas.annotations.media.Schema;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.flywaydb.core.Flyway;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import ru.sphere.stock.admin.AuditService;
import ru.sphere.stock.admin.SettingsService;
import ru.sphere.stock.catalog.CatalogService;
import ru.sphere.stock.config.StockProperties;
import ru.sphere.stock.events.EventBus;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.domain.OpenHours;
import ru.sphere.stock.infra.AppClock;
import ru.sphere.stock.ledger.Actor;
import ru.sphere.stock.menu.ForecastService;
import ru.sphere.stock.menu.MenuService;
import ru.sphere.stock.tenant.TenantDirectory;

/**
 * Живое демо (ТЗ 5.14): генератор работает поверх часов системы — при ×600 рабочий день проходит
 * за пару минут. Сценарии включаются кнопками на демо-панели.
 */
@Service
public class DemoService {

    private static final Logger log = LoggerFactory.getLogger(DemoService.class);

    @Schema(name = "DemoState")
    public record State(AppClock.State clock, Instant now, boolean generator, String seed, List<String> scenarios) {
    }

    public static final List<String> SCENARIOS = List.of("RUSH", "SHORT_LIFE", "SHORTAGE", "SUSPICIOUS", "LATE_CANCELS");

    private final JdbcClient jdbc;
    private final AppClock clock;
    private final DemoSimulator simulator;
    private final SeedService seed;
    private final SettingsService settings;
    private final StockProperties props;
    private final Flyway flyway;
    private final CatalogService catalog;
    private final ForecastService forecast;
    private final EventBus bus;
    private final MenuService menu;
    private final AuditService audit;
    private final TransactionTemplate tx;
    private final TenantDirectory tenants;
    private final Map<String, Instant> last = new ConcurrentHashMap<>();

    public DemoService(JdbcClient jdbc, AppClock clock, DemoSimulator simulator, SeedService seed,
                       SettingsService settings, StockProperties props, Flyway flyway, CatalogService catalog,
                       ForecastService forecast, EventBus bus, MenuService menu, AuditService audit,
                       TransactionTemplate tx, TenantDirectory tenants) {
        this.tenants = tenants;
        this.jdbc = jdbc;
        this.clock = clock;
        this.simulator = simulator;
        this.seed = seed;
        this.settings = settings;
        this.props = props;
        this.flyway = flyway;
        this.catalog = catalog;
        this.forecast = forecast;
        this.bus = bus;
        this.menu = menu;
        this.audit = audit;
        this.tx = tx;
    }

    public State state() {
        return new State(clock.state(), clock.now(), settings.getBool(TenantDirectory.DEMO, SettingsService.GENERATOR_ENABLED),
                seed.status(), SCENARIOS);
    }

    /** Генератор догоняет часы системы. */
    /** Раз в 2 секунды — по расписанию из {@link ru.sphere.stock.infra.ScheduledJobs}. */
    public void tick() {
        if (!props.demoMode() || !simulator.ready() || seed.status().startsWith("seeding")
                || !settings.getBool(TenantDirectory.DEMO, SettingsService.GENERATOR_ENABLED)) {
            last.clear();
            return;
        }
        try {
            Instant now = clock.now();
            // Генератор знает меню и сотрудников только демо-предприятия.
            for (String loc : tenants.locations(TenantDirectory.DEMO)) {
                Instant from = last.getOrDefault(loc, now);
                if (now.isAfter(from)) {
                    simulator.step(loc, from, now);
                }
                last.put(loc, now);
            }
        } catch (RuntimeException e) {
            log.warn("demo tick failed: {}", e.toString());
        }
    }

    public void setGenerator(boolean enabled) {
        requireDemo();
        settings.set(TenantDirectory.DEMO, SettingsService.GENERATOR_ENABLED, Boolean.toString(enabled));
        last.clear();
    }

    public Map<String, Object> scenario(String loc, String type) {
        requireDemo();
        if (!simulator.ready()) {
            throw ApiException.conflict("Демо-данные ещё готовятся");
        }
        return switch (type) {
            case "RUSH" -> {
                simulator.setScenario(loc, new DemoSimulator.Scenario(3.0,
                        clock.now().plus(java.time.Duration.ofHours(2))));
                yield Map.of("ok", true, "message", "Час пик: спрос ×3 на 2 часа");
            }
            case "SHORT_LIFE" -> {
                simulator.shortLifeDelivery(loc);
                yield Map.of("ok", true, "message", "Пришла поставка с коротким сроком и перебором");
            }
            case "SHORTAGE" -> {
                simulator.shortage(loc, "salmon");
                yield Map.of("ok", true, "message", "Банкет выбрал почти весь лосось");
            }
            case "SUSPICIOUS" -> Map.of("ok", true, "message",
                    "Подозрительных списаний: " + simulator.suspiciousWriteoffs(loc, 3));
            case "LATE_CANCELS" -> Map.of("ok", true, "message",
                    "Отменено после готовки: " + simulator.lateCancels(loc, 4));
            default -> throw ApiException.badRequest("Сценарий — один из " + SCENARIOS);
        };
    }

    /** Полный сброс: пересоздать схему и заново залить демо-данные (только в демо-режиме). */
    public void reset() {
        requireDemo();
        if (seed.status().startsWith("seeding")) {
            throw ApiException.conflict("Демо-данные уже готовятся");
        }
        flyway.clean();
        flyway.migrate();
        tenants.invalidate();
        clock.reload();
        catalog.invalidate();
        forecast.invalidateHours();
        last.clear();
        bus.publishAll("reset", Map.of());
        Thread.ofVirtual().name("seed").start(seed::seed);
    }

    /**
     * Журнал и всё, что из него следует, в порядке удаления (дети раньше родителей). Справочники (точки,
     * сотрудники, каталог, техкарты, ключи, настройки) не трогаем.
     */
    private static final List<String> LOG_TABLES = List.of("supplier_return_lines", "supplier_returns",
            "inventory_lines", "inventory_counts", "writeoff_requests",
            "anomalies", "alerts", "stoplist_events", "stoplist_state", "order_refusals", "movements", "kitchen_tickets", "order_lines",
            "orders", "batches", "delivery_lines", "deliveries", "ledger_heads", "audit_log");
    /** Таблицы, которые база защищает от удаления строк, и их триггеры (V1__schema.sql). */
    private static final Map<String, String> DELETE_GUARDS = Map.of(
            "movements", "movements_append_only", "batches", "batches_no_delete", "audit_log", "audit_append_only");

    /**
     * Чистый лист для тестов — только своего предприятия (ТЗ 16.4): удалить журнал движений, партии, поставки,
     * заказы, списания, пересчёты, сигналы, аномалии и аудит. Сотрудники, каталог, техкарты, API-ключи и
     * настройки остаются. Только в демо-режиме: в рабочем журнал неизменяем. Защиту снимаем лишь внутри одной
     * транзакции — при любой ошибке она откатывается вместе с триггерами.
     *
     * @param startStock сразу принять стартовую поставку и приготовить заготовки, чтобы меню было рабочим
     *                   (только демо-предприятие: генератор знает его меню)
     */
    public void clean(long tenantId, boolean startStock, Actor actor) {
        requireDemo();
        if (seed.status().startsWith("seeding")) {
            throw ApiException.conflict("Демо-данные ещё готовятся");
        }
        boolean demoTenant = tenantId == TenantDirectory.DEMO;
        tx.executeWithoutResult(status -> {
            DELETE_GUARDS.forEach((table, trigger) ->
                    jdbc.sql("ALTER TABLE " + table + " DISABLE TRIGGER " + trigger).update());
            for (String table : LOG_TABLES) {
                jdbc.sql("DELETE FROM " + table + " WHERE tenant_id = ?").param(tenantId).update();
            }
            if (demoTenant) {
                jdbc.sql("DELETE FROM clock_state").update();   // без истории демо-время ни к чему — реальные часы
            }
            DELETE_GUARDS.forEach((table, trigger) ->
                    jdbc.sql("ALTER TABLE " + table + " ENABLE TRIGGER " + trigger).update());
        });
        clock.reload();
        if (demoTenant) {
            settings.set(TenantDirectory.DEMO, SettingsService.GENERATOR_ENABLED, "false");   // иначе логи снова наполнятся
        }
        last.clear();
        catalog.invalidate(tenantId);
        forecast.invalidateHours();
        // Первая запись новой цепочки аудита предприятия — сама очистка: кто и когда.
        audit.record(tenantId, actor, "demo.clean", Map.of("startStock", startStock));
        List<String> locations = tenants.locations(tenantId);
        if (startStock && demoTenant) {
            LocalDate today = LocalDate.now(OpenHours.MSK);
            for (String loc : locations) {
                simulator.morningDeliveries(loc, today);
                simulator.kitchenPrep(loc, true);
            }
        }
        locations.forEach(menu::refreshStopList);
        // Стоп-лист после очистки — следствие самой очистки, а не событие смены: колокольчик начинает с нуля.
        jdbc.sql("UPDATE alerts SET ack_at = created_at WHERE ack_at IS NULL AND tenant_id = ?").param(tenantId).update();
        bus.publishAll("reset", Map.of());
        log.info("Чистый лист предприятия {}: история удалена{}", tenantId,
                startStock && demoTenant ? ", стартовая поставка принята" : "");
    }

    private void requireDemo() {
        if (!props.demoMode()) {
            throw ApiException.forbidden("Доступно только в демо-режиме");
        }
    }
}
