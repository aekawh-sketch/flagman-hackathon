package ru.sphere.stock.demo;

import java.io.IOException;
import java.io.InputStream;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import ru.sphere.stock.tenant.TenantDirectory;
import ru.sphere.stock.admin.SettingsService;
import ru.sphere.stock.catalog.CatalogImportService;
import ru.sphere.stock.config.StockProperties;
import ru.sphere.stock.domain.OpenHours;
import ru.sphere.stock.infra.AppClock;
import ru.sphere.stock.infra.Hashing;
import ru.sphere.stock.infra.Json;
import ru.sphere.stock.ledger.Actor;
import ru.sphere.stock.security.UserService;
import ru.sphere.stock.stock.ExpiryJob;

/**
 * Демо-данные (ТЗ 11.2, п. 11): точки, сотрудники на каждую роль, каталог пилотного ресторана
 * и 7 дней истории, прогнанной через настоящие сервисы — прогнозы работают с первой минуты.
 */
@Service
public class SeedService implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(SeedService.class);

    public static final String DEMO_PASSWORD = "demo1234";
    static final String RESTAURANT = "ИСТОК — бургеры, пицца, роллы";
    static final String SUPPLIER_KEY_NAME = "Портал поставщика «ФрешПоставка»";
    public static final Map<String, Integer> ORDERS_PER_DAY = Map.of("kush", 110, "kan", 80);

    /** Права ключа сайта ресторана: заказы, меню, остатки, поставки на приёмку, аналитика и живые события — только чтение склада. */
    public static final List<String> SITE_SCOPES = List.of("orders:create", "orders:status", "orders:cancel", "menu:read",
            "stock:read", "deliveries:create", "analytics:read", "events:read");

    private final JdbcClient jdbc;
    private final StockProperties props;
    private final AppClock clock;
    private final UserService users;
    private final CatalogImportService importer;
    private final DemoSimulator simulator;
    private final ExpiryJob expiry;
    private final SettingsService settings;
    private final Json json;
    private final AtomicReference<String> status = new AtomicReference<>("idle");

    public SeedService(JdbcClient jdbc, StockProperties props, AppClock clock, UserService users,
                       CatalogImportService importer, DemoSimulator simulator, ExpiryJob expiry,
                       SettingsService settings, Json json) {
        this.jdbc = jdbc;
        this.props = props;
        this.clock = clock;
        this.users = users;
        this.importer = importer;
        this.simulator = simulator;
        this.expiry = expiry;
        this.settings = settings;
        this.json = json;
    }

    public String status() {
        return status.get();
    }

    @Override
    public void run(ApplicationArguments args) {
        long locations = jdbc.sql("SELECT COUNT(*) FROM locations").query(Long.class).single();
        if (locations == 0 && props.seed()) {
            Thread.ofVirtual().name("seed").start(this::seed);
        } else {
            connectSite();
            connectSupplier();
            configureSimulator();
        }
    }

    /**
     * Сайт ИСТОК к уже заполненной базе: база могла приехать дампом с другого компьютера (программа для Windows),
     * где у сайта был другой ключ. Ключ из настройки добавляется, если его ещё нет; прежние ключи не трогаем.
     */
    private void connectSite() {
        if (props.siteApiKey() != null && !props.siteApiKey().isBlank()) {
            users.ensureApiKey(TenantDirectory.DEMO, "Сайт ИСТОК", SITE_SCOPES, props.siteApiKey().trim());
        }
    }

    /**
     * Портал поставщика (../supplier) — поставщик платформы (ТЗ 16.17): по ключу из настройки stock.supplier-api-key
     * присылает поставки на приёмку в любое предприятие, и в созданные позже. Других прав у ключа нет.
     */
    private void connectSupplier() {
        if (props.supplierApiKey() != null && !props.supplierApiKey().isBlank()) {
            users.ensurePlatformApiKey(SUPPLIER_KEY_NAME, props.supplierApiKey().trim());
        }
    }

    public synchronized void seed() {
        status.set("seeding");
        long started = System.currentTimeMillis();
        try {
            createBasics();
            Actor admin = actorOf("demo-admin");
            importer.importCatalog(TenantDirectory.DEMO, loadCatalog(), admin);
            configureSimulator();
            simulator.storeExpectedUse();
            history(7);
            // Сигналы истории считаем просмотренными: колокольчик показывает только живые события.
            jdbc.sql("UPDATE alerts SET ack_at = created_at WHERE ack_at IS NULL").update();
            status.set("ready");
            log.info("Демо-данные готовы за {} с", (System.currentTimeMillis() - started) / 1000);
        } catch (RuntimeException e) {
            status.set("failed: " + e.getMessage());
            log.error("seed failed", e);
        }
    }

    private void createBasics() {
        // Демо-предприятие № 1 создаёт миграция V4; здесь — его точки, люди и ключи (ТЗ 16.4).
        jdbc.sql("UPDATE tenants SET name = ? WHERE id = ?").params(RESTAURANT, TenantDirectory.DEMO).update();
        jdbc.sql("INSERT INTO locations (tenant_id, id, name, open_time, close_time, public_key) VALUES (1, ?, ?, ?, ?, ?)")
                .params("kush", "Истокград", LocalTime.of(10, 0), LocalTime.of(23, 0), "pk_" + Hashing.randomToken(12))
                .update();
        jdbc.sql("INSERT INTO locations (tenant_id, id, name, open_time, close_time, public_key) VALUES (1, ?, ?, ?, ?, ?)")
                .params("kan", "Ясноречье", LocalTime.of(10, 0), LocalTime.of(22, 0), "pk_" + Hashing.randomToken(12))
                .update();
        // Сотрудники на каждую роль (п. 34): пароль для входа и PIN для подписи списаний.
        users.create(TenantDirectory.DEMO, "demo-admin", "Администратор", "ADMIN", null, DEMO_PASSWORD, "1111");
        users.create(TenantDirectory.DEMO, "demo-manager", "Анна Смирнова", "MANAGER", null, DEMO_PASSWORD, "2222");
        users.create(TenantDirectory.DEMO, "demo-manager2", "Дмитрий Ковалёв", "MANAGER", null, DEMO_PASSWORD, "2223");
        users.create(TenantDirectory.DEMO, "demo-storekeeper", "Сергей Орлов", "STOREKEEPER", null, DEMO_PASSWORD, "3333");
        users.create(TenantDirectory.DEMO, "demo-cook", "Мария Белова", "COOK", null, DEMO_PASSWORD, "4444");
        users.create(TenantDirectory.DEMO, "demo-cook2", "Игорь Лебедев", "COOK", null, DEMO_PASSWORD, "4445");
        users.create(TenantDirectory.DEMO, "demo-cashier", "Ольга Петрова", "CASHIER", null, DEMO_PASSWORD, "5555");
        users.createApiKey(TenantDirectory.DEMO, "Генератор событий", List.of("orders:create", "orders:status", "orders:cancel",
                "deliveries:create", "deliveries:accept", "deliveries:auto-accept", "stock:read", "menu:read"), null);
        // Сайт ресторана ИСТОК подключается по ключу из конфига (stock.site-api-key): в базе — только хэш.
        if (props.siteApiKey() != null && !props.siteApiKey().isBlank()) {
            users.createApiKey(TenantDirectory.DEMO, "Сайт ИСТОК", SITE_SCOPES, null, props.siteApiKey().trim());
        } else {
            log.warn("stock.site-api-key не задан — сайт ресторана не сможет подключиться к складу");
        }
        connectSupplier();
        settings.set(TenantDirectory.DEMO, SettingsService.RESTAURANT_NAME, RESTAURANT);
        // Касса пилотного ресторана — его панель персонала: кассир входит туда логином и паролем Флагмана
        // На сервере в интернете панель — не localhost: адрес из PANEL_URL (deploy/docker-compose.yml)
        settings.set(TenantDirectory.DEMO, SettingsService.POS_URL,
                System.getenv().getOrDefault("PANEL_URL", "http://localhost:3001/panel/login.html"));
    }

    public void configureSimulator() {
        // Демо-сотрудники заведены сидом; «demo-platform» (администратор платформы) создаёт миграция — он не в счёт.
        long n = jdbc.sql("SELECT COUNT(*) FROM users WHERE login LIKE 'demo-%' AND login <> 'demo-platform'")
                .query(Long.class).single();
        if (n == 0) {
            return;
        }
        long keyId = jdbc.sql("SELECT id FROM api_keys WHERE name = 'Генератор событий' ORDER BY id LIMIT 1")
                .query(Long.class).single();
        simulator.configure(new DemoSimulator.Actors(Actor.api(keyId, "Генератор событий"), actorOf("demo-cook"),
                actorOf("demo-cook2"), actorOf("demo-manager"), actorOf("demo-cashier"), actorOf("demo-storekeeper")),
                ORDERS_PER_DAY);
    }

    /** История: часы в демо-режиме на паузе, перематываем по 10 минут и прогоняем события. */
    private void history(int days) {
        Instant end = Instant.now();
        Instant start = LocalDate.ofInstant(end, OpenHours.MSK).minusDays(days).atTime(8, 0)
                .atZone(OpenHours.MSK).toInstant();
        clock.reset(start, 1);
        clock.configure(1, true);
        Duration step = Duration.ofMinutes(10);
        Instant prev = clock.now();
        int i = 0;
        while (clock.now().plus(step).isBefore(end)) {
            clock.advance(step);
            Instant now = clock.now();
            for (String loc : ORDERS_PER_DAY.keySet()) {
                simulator.step(loc, prev, now);     // в нём же утренний и дневной обход просрочки кладовщиком
            }
            prev = now;
            if (++i % 144 == 0) {
                log.info("История: день {} из {}", i / 144, days);
                status.set("seeding: день " + i / 144 + " из " + days);
            }
        }
        clock.configure(1, false);
    }

    private Actor actorOf(String login) {
        return jdbc.sql("""
                        SELECT u.id, m.role, u.name FROM users u JOIN memberships m ON m.user_id = u.id AND m.tenant_id = ?
                        WHERE u.login = ?""")
                .params(TenantDirectory.DEMO, login)
                .query((rs, n) -> Actor.user(rs.getLong(1), rs.getString(2), rs.getString(3))).single();
    }

    private CatalogImportService.CatalogIn loadCatalog() {
        try (InputStream in = new ClassPathResource("seed/catalog.json").getInputStream()) {
            return json.read(new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8),
                    CatalogImportService.CatalogIn.class);
        } catch (IOException e) {
            throw new IllegalStateException("seed/catalog.json not found", e);
        }
    }
}
