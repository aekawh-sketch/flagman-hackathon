package ru.sphere.stock;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import ru.sphere.stock.alerts.AlertService;
import ru.sphere.stock.antifraud.WriteoffService;
import ru.sphere.stock.delivery.DeliveryXml;
import ru.sphere.stock.web.QueryService;
import ru.sphere.stock.web.OperationsService;
import ru.sphere.stock.admin.SettingsService;
import ru.sphere.stock.tenant.InviteService;
import ru.sphere.stock.tenant.TenantService;
import ru.sphere.stock.tenant.TenantDirectory;
import ru.sphere.stock.tenant.PlatformService;
import ru.sphere.stock.catalog.CatalogImportService;
import ru.sphere.stock.catalog.CatalogService;
import ru.sphere.stock.delivery.DeliveryService;
import ru.sphere.stock.demo.DemoPhotos;
import ru.sphere.stock.demo.DemoService;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.infra.AppClock;
import ru.sphere.stock.ledger.Actor;
import ru.sphere.stock.ledger.Ledger;
import ru.sphere.stock.menu.ForecastService;
import ru.sphere.stock.order.OrderService;
import ru.sphere.stock.security.UserService;
import ru.sphere.stock.stock.ExpiryJob;
import ru.sphere.stock.stock.ProductionService;
import ru.sphere.stock.menu.MenuService;
import ru.sphere.stock.trace.TraceService;
import ru.sphere.stock.delivery.SupplierReturnService;
import ru.sphere.stock.antifraud.AnomalyDetails;
import ru.sphere.stock.antifraud.AnomalyService;
import ru.sphere.stock.kitchen.EscPos;
import ru.sphere.stock.kitchen.KitchenPrintService;
import ru.sphere.stock.kitchen.KitchenTicket;

/**
 * ТЗ, раздел 12, на настоящей базе: гонка заказов, идемпотентность, отказ без побочных эффектов,
 * возврат при отмене, журнал только на добавление и хэш-цепочка, правила ручного списания.
 */
@SpringBootTest
@ActiveProfiles("test")
class StockIntegrationTest {

    static final String LOC = "t1";

    @Autowired Flyway flyway;
    @Autowired JdbcClient jdbc;
    @Autowired AppClock clock;
    @Autowired CatalogService catalog;
    @Autowired ForecastService forecast;
    @Autowired CatalogImportService importer;
    @Autowired DeliveryService deliveries;
    @Autowired OrderService orders;
    @Autowired WriteoffService writeoffs;
    @Autowired UserService users;
    @Autowired Ledger ledger;
    @Autowired ExpiryJob expiry;
    @Autowired DemoPhotos photos;
    @Autowired DemoService demo;
    @Autowired TenantDirectory tenants;
    @Autowired TenantService tenantService;
    @Autowired InviteService invites;
    @Autowired SettingsService settings;
    @Autowired QueryService query;
    @Autowired AlertService alerts;
    @Autowired ProductionService production;
    @Autowired MenuService menu;
    @Autowired TraceService trace;
    @Autowired SupplierReturnService returns;
    @Autowired AnomalyService anomalyService;
    @Autowired AnomalyDetails anomalyDetails;
    @Autowired OperationsService operations;
    @Autowired PlatformService platform;
    @Autowired KitchenPrintService kitchen;
    @Autowired ru.sphere.stock.web.ProfitService profits;

    Actor cashier;
    Actor cook;
    Actor storekeeper;
    Actor manager;
    Actor manager2;

    @BeforeEach
    void setUp() {
        flyway.clean();
        flyway.migrate();
        tenants.invalidate();
        clock.reload();
        catalog.invalidate();
        forecast.invalidateHours();
        clock.reset(Instant.parse("2026-10-09T07:00:00Z"), 1);
        clock.configure(1, true);
        jdbc.sql("INSERT INTO locations (tenant_id, id, name, public_key) VALUES (1, ?, 'Тест', 'pk_test')").param(LOC).update();
        cashier = user("cashier", "CASHIER");
        cook = user("cook", "COOK");
        storekeeper = user("store", "STOREKEEPER");
        manager = user("manager", "MANAGER");
        manager2 = user("manager2", "MANAGER");
        importer.importCatalog(TenantDirectory.DEMO, new CatalogImportService.CatalogIn(
                List.of(product("salmon", "Лосось", 1800), product("rice", "Рис", 150)),
                List.of(),
                List.of(new CatalogImportService.DishIn("roll", "Ролл", "Роллы", null, 1, List.of(
                                new CatalogImportService.VariantIn("roll", "Ролл", null, 30_000, false,
                                        List.of(new CatalogImportService.LineIn("salmon", 100, null),
                                                new CatalogImportService.LineIn("rice", 100, null))))),
                        new CatalogImportService.DishIn("poke", "Поке", "Горячее", null, 2, List.of(
                                new CatalogImportService.VariantIn("poke", "Поке", null, 45_000, false,
                                        List.of(new CatalogImportService.LineIn("salmon", 120, null))))),
                        new CatalogImportService.DishIn("set", "Сет", "Сеты", null, 3, List.of(
                                new CatalogImportService.VariantIn("set", "Сет", null, 50_000, true, List.of())))),
                List.of(new CatalogImportService.SetIn("set", List.of(new CatalogImportService.SetItemIn("roll", 2))))),
                manager);
    }

    private Actor user(String login, String role) {
        long id = users.create(TenantDirectory.DEMO, login, login, role, null, "password1", null);
        return Actor.user(id, role, login);
    }

    private static CatalogImportService.ProductIn product(String id, String name, double price) {
        return new CatalogImportService.ProductIn(id, name, "G", "RAW", null, price, 72, null, null, 0.0, null, null, null);
    }

    private DeliveryService.Result deliver(String id, String pid, long qty, int shelfHours) {
        return deliveries.receive(LOC, new DeliveryService.DeliveryIn(id, "N-" + id, clock.now(), "Поставщик",
                List.of(new DeliveryService.LineIn(pid, pid, "G", qty, shelfHours, null, qty * 180L))), storekeeper, true);
    }

    private long qtyLeft(String pid) {
        return jdbc.sql("SELECT COALESCE(SUM(qty_left), 0) FROM batches WHERE location_id = ? AND product_id = ?")
                .params(LOC, pid).query(Long.class).single();
    }

    private OrderService.Outcome order(String ext, String variant, int qty) {
        return orders.create(LOC, new OrderService.OrderIn(ext, "POS", List.of(new OrderService.LineIn(variant, qty))),
                cashier);
    }

    @Test
    void fiftyParallelOrdersOnLastPortionsNeverGoNegative() throws Exception {
        deliver("d1", "salmon", 1000, 72);
        deliver("d2", "rice", 100_000, 72);
        ExecutorService pool = Executors.newFixedThreadPool(16);
        List<Callable<OrderService.Outcome>> tasks = new ArrayList<>();
        for (int i = 0; i < 50; i++) {
            int n = i;
            tasks.add(() -> order("race-" + n, "roll", 1));
        }
        int created = 0;
        int refused = 0;
        for (Future<OrderService.Outcome> f : pool.invokeAll(tasks)) {
            if (f.get() instanceof OrderService.Created) {
                created++;
            } else {
                refused++;
            }
        }
        pool.shutdown();
        assertThat(created).isEqualTo(10);           // 1000 г / 100 г
        assertThat(refused).isEqualTo(40);
        assertThat(qtyLeft("salmon")).isZero();
        assertThat(jdbc.sql("SELECT COUNT(*) FROM order_refusals").query(Long.class).single()).isEqualTo(40);
        assertThat(ledger.verify(LOC).ok()).isTrue();
    }

    @Test
    void sameDeliveryAndOrderTwiceDoNotDuplicate() {
        deliver("d1", "salmon", 1000, 72);
        var again = deliver("d1", "salmon", 1000, 72);
        assertThat(again.duplicate()).isTrue();
        assertThat(qtyLeft("salmon")).isEqualTo(1000);
        assertThatThrownBy(() -> deliver("d1", "salmon", 999, 72))
                .isInstanceOf(ApiException.class).hasMessageContaining("другим содержимым");

        deliver("d2", "rice", 1000, 72);
        var first = (OrderService.Created) order("ext-1", "roll", 2);
        var second = (OrderService.Created) order("ext-1", "roll", 2);
        assertThat(second.duplicate()).isTrue();
        assertThat(second.id()).isEqualTo(first.id());
        assertThat(qtyLeft("salmon")).isEqualTo(800);
    }

    @Test
    void refusalSumsLinesAndChangesNothing() {
        deliver("d1", "salmon", 400, 72);
        deliver("d2", "rice", 10_000, 72);
        // Каждой строке по отдельности хватает, вместе — нет: ролл ×3 (300 г) + поке ×1 (120 г) > 400 г.
        var outcome = orders.create(LOC, new OrderService.OrderIn("x", "POS", List.of(
                new OrderService.LineIn("roll", 3), new OrderService.LineIn("poke", 1))), cashier);
        assertThat(outcome).isInstanceOf(OrderService.Refused.class);
        var r = (OrderService.Refused) outcome;
        assertThat(r.shortages()).singleElement().satisfies(s -> {
            assertThat(s.need()).isEqualTo(420);
            assertThat(s.available()).isEqualTo(400);
        });
        assertThat(r.message()).contains("максимум 2");
        assertThat(qtyLeft("salmon")).isEqualTo(400);
        assertThat(jdbc.sql("SELECT COUNT(*) FROM orders").query(Long.class).single()).isZero();
    }

    @Test
    void setIsExpandedIntoItsRolls() {
        deliver("d1", "salmon", 1000, 72);
        deliver("d2", "rice", 1000, 72);
        assertThat(order("s1", "set", 1)).isInstanceOf(OrderService.Created.class);
        assertThat(qtyLeft("salmon")).isEqualTo(800);   // 2 ролла × 100 г
    }

    @Test
    void fefoTakesBatchThatExpiresFirstEvenIfItArrivedLater() {
        deliver("old", "salmon", 500, 120);
        clock.advance(Duration.ofHours(1));
        deliver("fresh", "salmon", 500, 24);           // пришла позже, но истекает раньше
        deliver("rice", "rice", 1000, 72);
        order("o1", "roll", 3);
        long freshLeft = jdbc.sql("SELECT b.qty_left FROM batches b JOIN delivery_lines l ON l.id = b.delivery_line_id "
                + "WHERE l.delivery_id = 'fresh'").query(Long.class).single();
        assertThat(freshLeft).isEqualTo(200);
    }

    @Test
    void cancelBeforeCookingReturnsToSameBatchesAfterCookingIsALoss() {
        deliver("d1", "salmon", 1000, 72);
        deliver("d2", "rice", 1000, 72);
        var a = (OrderService.Created) order("a", "roll", 2);
        orders.cancel(LOC, a.id(), null, cashier);
        assertThat(qtyLeft("salmon")).isEqualTo(1000);

        var b = (OrderService.Created) order("b", "roll", 2);
        orders.setStatus(LOC, b.id(), "COOKING", cook);
        assertThatThrownBy(() -> orders.cancel(LOC, b.id(), "", cashier)).isInstanceOf(ApiException.class);
        assertThat(orders.cancel(LOC, b.id(), "Гость ушёл", cashier)).isEqualTo("CANCELED_LATE");
        assertThat(qtyLeft("salmon")).isEqualTo(800);   // продукты не вернулись
    }

    @Test
    void expiredBatchLeavesSaleAtOnceButOnlyAPersonWritesItOff() {
        deliver("d1", "salmon", 1000, 5);
        deliver("d2", "rice", 10_000, 72);
        long batch = jdbc.sql("SELECT id FROM batches WHERE product_id = 'salmon'").query(Long.class).single();
        assertThatThrownBy(() -> writeoffs.create(LOC, batch, 100, "EXPIRED", null, List.of(photos.placeholder()), storekeeper))
                .isInstanceOf(ApiException.class).hasMessageContaining("Списать просрочку");
        assertThatThrownBy(() -> expiry.writeOffExpiredBatch(LOC, batch, storekeeper))
                .as("свежую партию как просрочку не списать").hasMessageContaining("ещё не истёк");

        clock.advance(Duration.ofHours(5));
        expiry.tick();
        assertThat(qtyLeft("salmon")).as("сама система не списывает").isEqualTo(1000);
        assertThat(order("o1", "roll", 1)).as("под списанием — не продаётся").isInstanceOf(OrderService.Refused.class);
        assertThat(expiry.expired(LOC)).extracting(ExpiryJob.ExpiredBatch::batchId).containsExactly(batch);
        assertThat(jdbc.sql("SELECT severity FROM alerts WHERE type = 'BATCH_EXPIRED' AND ack_at IS NULL")
                .query(String.class).single()).isEqualTo("CRITICAL");

        assertThat(expiry.writeOffExpiredBatch(LOC, batch, storekeeper)).isEqualTo(180_000);
        assertThat(qtyLeft("salmon")).isZero();
        assertThat(jdbc.sql("SELECT actor_kind || ':' || actor_id FROM movements WHERE type = 'WRITEOFF_EXPIRED'")
                .query(String.class).single()).isEqualTo("USER:" + storekeeper.userId());
        assertThat(jdbc.sql("SELECT COUNT(*) FROM alerts WHERE type = 'BATCH_EXPIRED' AND ack_at IS NULL")
                .query(Long.class).single()).as("сигнал «спишите» закрыт тем, кто списал").isZero();
        assertThat(ledger.verify(LOC).ok()).isTrue();
    }

    @Test
    void autoWriteoffIsAnOptInSetting() {
        settings.set(TenantDirectory.DEMO, SettingsService.AUTO_WRITEOFF_EXPIRED, "true");
        deliver("d1", "salmon", 1000, 5);
        clock.advance(Duration.ofHours(5));
        expiry.tick();
        assertThat(qtyLeft("salmon")).isZero();
        assertThat(jdbc.sql("SELECT actor_kind FROM movements WHERE type = 'WRITEOFF_EXPIRED'").query(String.class)
                .single()).isEqualTo("SYSTEM");
    }

    @Test
    void manualWriteoffNeedsSomeoneElsesSignatureAndHoldsStock() {
        deliver("d1", "salmon", 1000, 72);
        deliver("d2", "rice", 10_000, 72);
        long batch = jdbc.sql("SELECT id FROM batches WHERE product_id = 'salmon'").query(Long.class).single();
        // Повар — всегда на подпись; пока ждёт, 900 г не продаются.
        var req = writeoffs.create(LOC, batch, 900, "SPOILED", null, List.of(photos.placeholder()), cook);
        assertThat(req.needsApproval()).isTrue();
        assertThat(order("o1", "roll", 2)).isInstanceOf(OrderService.Refused.class);
        // Управляющий сам и решает: его списание проходит сразу, без запроса самому себе.
        var own = writeoffs.create(LOC, batch, 50, "DAMAGED", null, List.of(photos.placeholder()), manager);
        assertThat(own.needsApproval()).isFalse();
        assertThat(own.status()).isEqualTo("EXECUTED");
        assertThat(jdbc.sql("SELECT COUNT(*) FROM movements WHERE type = 'WRITEOFF_DAMAGED' AND doc_id = ?")
                .param(Long.toString(own.id())).query(Long.class).single()).isEqualTo(1);
        assertThat(jdbc.sql("SELECT COUNT(*) FROM alerts WHERE type = 'WRITEOFF_PENDING' AND object_id = ?")
                .param(Long.toString(own.id())).query(Long.class).single()).as("запроса самому себе нет").isZero();
        // Отклонили заявку повара — количество вернулось в продажу.
        writeoffs.reject(LOC, req.id(), "Не подтверждаю", manager);
        assertThat(order("o2", "roll", 2)).isInstanceOf(OrderService.Created.class);
        // Кладовщик тоже только подаёт заявку — даже на копейки решает управляющий или админ.
        var cheap = writeoffs.create(LOC, batch, 10, "DAMAGED", null, List.of(photos.placeholder()), storekeeper);
        assertThat(cheap.needsApproval()).isTrue();
        assertThat(cheap.status()).isEqualTo("PENDING");
        assertThat(jdbc.sql("SELECT COUNT(*) FROM movements WHERE type = 'WRITEOFF_DAMAGED' AND doc_id = ?")
                .param(Long.toString(cheap.id())).query(Long.class).single()).as("без решения со склада не ушло").isZero();
    }

    @Test
    void ledgerIsAppendOnlyAndTamperingBreaksTheChain() {
        deliver("d1", "salmon", 1000, 72);
        deliver("d2", "rice", 1000, 72);
        order("o1", "roll", 1);
        assertThat(ledger.verify(LOC).ok()).isTrue();
        assertThatThrownBy(() -> jdbc.sql("UPDATE movements SET qty = 1 WHERE seq = 1").update())
                .hasMessageContaining("append-only");
        assertThatThrownBy(() -> jdbc.sql("DELETE FROM movements").update()).hasMessageContaining("append-only");
        assertThatThrownBy(() -> jdbc.sql("TRUNCATE movements CASCADE").update()).hasMessageContaining("append-only");
        assertThatThrownBy(() -> jdbc.sql("UPDATE batches SET expires_at = expires_at + INTERVAL '1 day'").update())
                .hasMessageContaining("immutable");
        // Злоумышленник с правами владельца БД отключает триггер и правит запись — цепочка это видит.
        jdbc.sql("ALTER TABLE movements DISABLE TRIGGER movements_append_only").update();
        jdbc.sql("UPDATE movements SET qty = qty - 1 WHERE seq = 2").update();
        jdbc.sql("ALTER TABLE movements ENABLE TRIGGER movements_append_only").update();
        Ledger.Verification v = ledger.verify(LOC);
        assertThat(v.ok()).isFalse();
        assertThat(v.brokenAtSeq()).isEqualTo(2);
    }

    private long count(String table) {
        return jdbc.sql("SELECT COUNT(*) FROM " + table).query(Long.class).single();
    }

    @Test
    void cleanSlateWipesLogsKeepsReferenceDataAndRestoresGuards() {
        deliver("d1", "salmon", 1000, 72);
        deliver("d2", "rice", 1000, 72);
        order("o1", "roll", 1);
        long users = count("users");
        long products = count("products");
        long recipes = count("recipe_versions");

        demo.clean(TenantDirectory.DEMO, false, manager);

        for (String t : List.of("movements", "batches", "deliveries", "orders", "order_lines", "anomalies")) {
            assertThat(count(t)).as(t).isZero();
        }
        assertThat(jdbc.sql("SELECT COUNT(*) FROM alerts WHERE ack_at IS NULL").query(Long.class).single())
                .as("новых сигналов нет: стоп после очистки — её следствие").isZero();
        assertThat(count("users")).isEqualTo(users);
        assertThat(count("products")).isEqualTo(products);
        assertThat(count("recipe_versions")).isEqualTo(recipes);
        assertThat(count("audit_log")).as("первая запись нового аудита — сама очистка").isEqualTo(1);
        // Защита от очистки вернулась: журнал снова неизменяем
        assertThatThrownBy(() -> jdbc.sql("TRUNCATE movements").update()).hasMessageContaining("append-only");
        // Склад работает с нуля: новая цепочка начинается с первой записи
        deliver("d3", "salmon", 500, 72);
        Ledger.Verification v = ledger.verify(LOC);
        assertThat(v.ok()).isTrue();
        assertThat(v.checked()).isEqualTo(1);
    }

    @Test
    void cashierWritesOffADrinkByRecipeAsOneGroupThatOnlyAManagerSigns() {
        deliver("d1", "salmon", 1000, 72);
        deliver("d2", "rice", 1000, 72);
        List<String> photo = List.of(photos.placeholder());
        // Кассир списывает 2 «ролла» по техкарте: лосось 200 г + рис 200 г — одной группой, на подпись
        WriteoffService.GroupCreated g = writeoffs.createFefo(LOC, null, 0, "roll", 2, "DAMAGED", "Уронил", photo, cashier);
        assertThat(g.needsApproval()).isTrue();
        assertThat(g.ids()).hasSize(2);
        // «Уронил» свежее — не подозрительно: A2 не срабатывает, и нет записи на каждый ингредиент
        assertThat(count("anomalies")).as("пролитое свежее — без A2").isZero();
        assertThat(order("o1", "poke", 7).getClass().getSimpleName()).as("удержанное не продаётся").isEqualTo("Refused");
        // Свою заявку не подписать; управляющий подписывает всю группу одним действием
        assertThatThrownBy(() -> writeoffs.approve(LOC, g.ids().getFirst(), "", cashier)).isInstanceOf(ApiException.class);
        writeoffs.approve(LOC, g.ids().getLast(), "ок", manager);
        assertThat(qtyLeft("salmon")).isEqualTo(800);
        assertThat(qtyLeft("rice")).isEqualTo(800);
        assertThat(jdbc.sql("SELECT COUNT(*) FROM writeoff_requests WHERE group_id = ?::uuid AND status = 'EXECUTED'")
                .param(g.groupId()).query(Long.class).single()).isEqualTo(2);
        // Продукт без выбора партии — по FEFO; отказ возвращает удержанное в продажу
        WriteoffService.GroupCreated p = writeoffs.createFefo(LOC, "salmon", 300, null, 0, "SPOILED", null, photo, cook);
        // «Испортилось», а партия свежая — ровно одна запись A2 на всю заявку
        assertThat(jdbc.sql("SELECT COUNT(*) FROM anomalies WHERE rule = 'A2'").query(Long.class).single()).isEqualTo(1);
        writeoffs.reject(LOC, p.ids().getFirst(), "не подтверждаю", manager);
        assertThat(jdbc.sql("SELECT COALESCE(SUM(held_qty), 0) FROM batches").query(Long.class).single()).isZero();
        assertThat(ledger.verify(LOC).ok()).isTrue();
    }

    // ── Версия 2 (ТЗ 16) ───────────────────────────────────────────────────

    /** Админ демо-предприятия — для проверок управления ролями внутри предприятия. */
    private Actor newAdmin(String login) {
        long id = users.create(TenantDirectory.DEMO, login, login, "ADMIN", null, "password1", null);
        return Actor.user(id, "ADMIN", login);
    }

    @Test
    void twoEnterprisesWithTheSameIdsNeverMix() {
        Actor owner = newAdmin("owner2");
        var cafe = tenantService.create("Кофейня", "Центр", owner);
        String loc2 = cafe.locationId();
        Actor owner2 = Actor.user(owner.userId(), "ADMIN", "owner2");
        // Тот же ID продукта и блюда, но своя техкарта: ролл кофейни берёт 50 г лосося
        importer.importCatalog(cafe.tenantId(), new CatalogImportService.CatalogIn(
                List.of(new CatalogImportService.ProductIn("salmon", "Лосось кофейни", "G", "RAW", null, 2000.0, 72,
                        null, null, 0.0, null, null, null)),
                List.of(),
                List.of(new CatalogImportService.DishIn("roll", "Ролл", "Роллы", null, 1, List.of(
                        new CatalogImportService.VariantIn("roll", "Ролл", null, 30_000, false,
                                List.of(new CatalogImportService.LineIn("salmon", 50, null)))))),
                List.of()), owner2);
        deliver("d1", "salmon", 1000, 72);
        deliver("d2", "rice", 1000, 72);
        // Тот же ID поставки у другого предприятия — не конфликт
        deliveries.receive(loc2, new DeliveryService.DeliveryIn("d1", "N-1", clock.now(), "Поставщик",
                List.of(new DeliveryService.LineIn("salmon", "Лосось", "G", 300, 72, null, 60_000L))), owner2, true);

        assertThat(order("o1", "roll", 1)).isInstanceOf(OrderService.Created.class);
        assertThat(orders.create(loc2, new OrderService.OrderIn("o1", "POS", List.of(new OrderService.LineIn("roll", 1))),
                owner2)).isInstanceOf(OrderService.Created.class);
        assertThat(qtyLeft("salmon")).isEqualTo(900);
        assertThat(jdbc.sql("SELECT SUM(qty_left) FROM batches WHERE location_id = ?").param(loc2).query(Long.class)
                .single()).as("у кофейни списано по её техкарте").isEqualTo(250);
        assertThat(catalog.get(1).product("salmon").name()).isEqualTo("Лосось");
        assertThat(catalog.get(cafe.tenantId()).product("salmon").name()).isEqualTo("Лосось кофейни");
        assertThat(jdbc.sql("SELECT DISTINCT tenant_id FROM movements WHERE location_id = ?").param(loc2)
                .query(Long.class).list()).containsExactly(cafe.tenantId());

        // Права: сотрудник и ключ кофейни не видят точку ИСТОК
        var cafePrincipal = users.principal(owner.userId(), cafe.tenantId());
        assertThat(cafePrincipal.canAccess(loc2)).isTrue();
        assertThat(cafePrincipal.canAccess(LOC)).isFalse();
        var key = users.createApiKey(cafe.tenantId(), "Сайт кофейни", List.of("menu:read"), null);
        assertThat(users.byApiKey(key.key()).canAccess(LOC)).isFalse();
        assertThat(users.byApiKey(key.key()).canAccess(loc2)).isTrue();
        // База сама не даст партии кофейни сослаться на продукт ИСТОК
        assertThatThrownBy(() -> jdbc.sql("""
                INSERT INTO batches (location_id, product_id, label, source, qty_initial, qty_left, base_date, expires_at,
                                     received_at) VALUES (?, 'rice', 'X', 'DELIVERY', 1, 1, now(), now() + interval '1 day', now())""")
                .param(loc2).update()).hasMessageContaining("foreign key");
        assertThat(ledger.verify(LOC).ok()).isTrue();
        assertThat(ledger.verify(loc2).ok()).isTrue();
    }

    @Test
    void inviteLinkCreatesMembershipOnceAndExistingPeopleCanJoinMoreRestaurants() {
        var inv = invites.create(TenantDirectory.DEMO, "COOK", LOC, "новый повар", manager);
        assertThat(invites.info(inv.token()).status()).isEqualTo("ACTIVE");
        long newCook = invites.register(inv.token(), "new.cook", "Новый повар", "secret12", "7777");
        var p = users.principal(newCook, null);
        assertThat(p.role()).isEqualTo("COOK");
        assertThat(p.locationId()).isEqualTo(LOC);
        assertThat(invites.info(inv.token()).status()).isEqualTo("ACCEPTED");
        assertThatThrownBy(() -> invites.register(inv.token(), "other", "Другой", "secret12", null))
                .hasMessageContaining("уже использовано");
        assertThat(jdbc.sql("SELECT token_hash FROM invitations").query(String.class).single())
                .as("в базе — только хэш").doesNotContain(inv.token());

        // Уже работающий повар принимает приглашение в другой ресторан — роли у ресторанов свои
        Actor owner = newAdmin("owner3");
        var cafe = tenantService.create("Пекарня", null, owner);
        var inv2 = invites.create(cafe.tenantId(), "MANAGER", null, null, Actor.user(owner.userId(), "ADMIN", "owner3"));
        invites.accept(inv2.token(), cook.userId());
        assertThat(users.memberships(cook.userId())).extracting(UserService.MembershipDto::role)
                .containsExactlyInAnyOrder("COOK", "MANAGER");
        assertThat(users.principal(cook.userId(), cafe.tenantId()).role()).isEqualTo("MANAGER");
        assertThat(users.principal(cook.userId(), TenantDirectory.DEMO).role()).isEqualTo("COOK");
    }

    @Test
    void managerAcceptsDeliveryPartiallyAndExpiredLinesCannotSlipIn() {
        Instant old = clock.now().minus(Duration.ofDays(10));
        deliveries.receive(LOC, new DeliveryService.DeliveryIn("p1", "П-1", old, "Поставщик", List.of(
                new DeliveryService.LineIn("salmon", "Лосось", "G", 1000, 24 * 30, null, 180_000L),
                new DeliveryService.LineIn("rice", "Рис", "G", 1000, 24 * 30, null, 15_000L),
                new DeliveryService.LineIn("salmon", "Лосось (вчерашний)", "G", 500, 48, null, 90_000L))), manager, false);
        var list = query.deliveries(LOC, "PENDING", 10);
        assertThat(list.getFirst().lines()).extracting(QueryService.DeliveryLineDto::expiryStatus)
                .as("система сроков видна уже при приёмке").containsExactly("FRESH", "FRESH", "EXPIRED");
        deliveries.approve(LOC, "p1", List.of(), null, manager);
        assertThatThrownBy(() -> deliveries.accept(LOC, "p1", List.of(), null, storekeeper, true))
                .hasMessageContaining("просроченное");
        var r = deliveries.accept(LOC, "p1", List.of(
                new DeliveryService.AcceptLine(1, 800L, "SHORTAGE", "довезут завтра"),
                new DeliveryService.AcceptLine(3, 0L, "EXPIRED", null)), null, storekeeper, true);
        assertThat(r.status()).isEqualTo("PARTIAL");
        assertThat(r.batchIds()).hasSize(2);
        assertThat(qtyLeft("salmon")).isEqualTo(800);
        assertThat(jdbc.sql("SELECT string_agg(COALESCE(reject_reason, '-'), ',' ORDER BY line_no) FROM delivery_lines")
                .query(String.class).single()).isEqualTo("SHORTAGE,-,EXPIRED");
        assertThat(jdbc.sql("SELECT COUNT(*) FROM alerts WHERE type = 'DELIVERY_DIFF'").query(Long.class).single())
                .isEqualTo(1);
    }

    @Test
    void mockBackdatedDeliveryLetsYouRehearseTheExpiredWriteoff() {
        Instant old = clock.now().minus(Duration.ofDays(5));
        deliveries.receive(LOC, new DeliveryService.DeliveryIn("m1", "Тест-1", old, "Тест", List.of(
                new DeliveryService.LineIn("salmon", "Лосось", "G", 600, 48, null, 108_000L)), true), manager, false);
        deliveries.approve(LOC, "m1", List.of(), null, manager);
        var r = deliveries.accept(LOC, "m1", List.of(), null, storekeeper, true);
        assertThat(r.status()).isEqualTo("ACCEPTED");
        assertThat(expiry.expired(LOC)).hasSize(1);
        assertThat(order("o1", "poke", 1)).isInstanceOf(OrderService.Refused.class);
        assertThat(expiry.writeOffExpired(LOC, storekeeper)).isEqualTo(1);
        assertThat(qtyLeft("salmon")).isZero();
    }

    @Test
    void xmlAndJsonAreTheSameDeliveryAndXxeIsRejected() {
        String xml = """
                <delivery id="x1" number="П-7" createdAt="2026-10-09T06:00:00Z" supplier="ООО Ромашка">
                  <line productId="salmon" name="Лосось" unit="G" qty="2000" shelfLifeHours="72" costKop="360000"/>
                  <line><productId>rice</productId><name>Рис</name><unit>G</unit><qty>5000</qty>
                        <expiresAt>2026-10-20T00:00:00Z</expiresAt></line>
                </delivery>""";
        var fromXml = DeliveryXml.parse(xml);
        var json = new DeliveryService.DeliveryIn("x1", "П-7", Instant.parse("2026-10-09T06:00:00Z"), "ООО Ромашка", List.of(
                new DeliveryService.LineIn("salmon", "Лосось", "G", 2000, 72, null, 360_000L),
                new DeliveryService.LineIn("rice", "Рис", "G", 5000, null, Instant.parse("2026-10-20T00:00:00Z"), null)));
        assertThat(deliveries.receive(LOC, fromXml, storekeeper, false).duplicate()).isFalse();
        assertThat(deliveries.receive(LOC, json, storekeeper, false).duplicate())
                .as("тот же документ в JSON — повтор, а не вторая поставка").isTrue();
        assertThatThrownBy(() -> DeliveryXml.parse("""
                <?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]>
                <delivery id="&x;"/>""")).isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> deliveries.receive(LOC, new DeliveryService.DeliveryIn("x2", "П-8", clock.now(), null,
                List.of(new DeliveryService.LineIn("salmon", "Лосось", "PCS", 3, 72, null, null))), storekeeper, false))
                .as("единица не совпадает с карточкой").hasMessageContaining("в карточке продукта");
    }

    @Test
    void supplyReportShowsWhatWasBroughtEatenAndThrownAway() {
        deliver("d1", "salmon", 1000, 10);
        deliver("d2", "rice", 1000, 72);
        order("o1", "roll", 2);
        clock.advance(Duration.ofHours(11));
        expiry.writeOffExpired(LOC, storekeeper);
        var salmon = query.supply(LOC, 30).stream().filter(r -> r.productId().equals("salmon")).findFirst().orElseThrow();
        assertThat(salmon.received()).isEqualTo(1000);
        assertThat(salmon.consumed()).isEqualTo(200);
        assertThat(salmon.expired()).isEqualTo(800);
        assertThat(salmon.adviceLevel()).isEqualTo("bad");
        assertThat(salmon.advice()).contains("Просрочено 80 %");
    }

    @Test
    void acknowledgedExpiryAlertStaysAcknowledgedOnTheNextCheck() {
        deliver("d1", "salmon", 1000, 10);
        clock.advance(Duration.ofHours(8));          // осталось 2 ч из 10 — «скоро истекает» или «критично»
        expiry.tick();
        var open = alerts.list(LOC, true, 10, "MANAGER");
        assertThat(open).isNotEmpty();
        open.forEach(a -> alerts.ack(LOC, a.id(), manager, "MANAGER"));
        expiry.tick();
        expiry.tick();
        assertThat(alerts.list(LOC, true, 10, "MANAGER")).as("отметка не слетает на следующей проверке").isEmpty();

        clock.advance(Duration.ofHours(3));          // новое состояние — «под списание» — это новый сигнал
        expiry.tick();
        assertThat(alerts.list(LOC, true, 10, "MANAGER")).extracting(AlertService.Alert::type).containsExactly("BATCH_EXPIRED");
    }

    @Test
    void creatorBecomesAdminAndRolesAreManagedWithoutLockingThemselvesOut() {
        Actor admin = newAdmin("boss");
        assertThat(tenantService.create("Кофейня", null, admin).tenantId()).isGreaterThan(1);

        // Роли — из админки: повар стал управляющим и привязан к точке
        users.updateMembership(TenantDirectory.DEMO, cook.userId(), "MANAGER", LOC, true, null);
        var p = users.principal(cook.userId(), TenantDirectory.DEMO);
        assertThat(p.role()).isEqualTo("MANAGER");
        assertThat(p.locationId()).isEqualTo(LOC);

        // Последнего активного админа предприятия не понизить и не отключить
        Actor solo = newAdmin("solo");
        var cafe = tenantService.create("Пекарня", null, solo);
        assertThatThrownBy(() -> users.updateMembership(cafe.tenantId(), solo.userId(), "COOK", null, false, null))
                .hasMessageContaining("последний админ");
        assertThatThrownBy(() -> users.setActive(cafe.tenantId(), solo.userId(), false))
                .hasMessageContaining("последний админ");
    }

    @Test
    void managerApprovesPartlyThenAnotherPersonReceivesNoMoreThanApproved() {
        deliveries.receive(LOC, new DeliveryService.DeliveryIn("a1", "П-1", clock.now(), "ООО Ромашка", List.of(
                new DeliveryService.LineIn("salmon", "Лосось", "G", 1000, 72, null, 180_000L),
                new DeliveryService.LineIn("rice", "Рис", "G", 5000, 72, null, 75_000L))), storekeeper, false);
        assertThat(jdbc.sql("SELECT COUNT(*) FROM alerts WHERE type = 'DELIVERY_APPROVAL' AND ack_at IS NULL")
                .query(Long.class).single()).as("управляющему — сигнал «ждёт одобрения»").isEqualTo(1);
        assertThatThrownBy(() -> deliveries.accept(LOC, "a1", List.of(), null, storekeeper, true))
                .hasMessageContaining("сначала одобряет управляющий");

        // Управляющий: лосося берём 600 г из 1000, рис не берём вовсе
        deliveries.approve(LOC, "a1", List.of(new DeliveryService.ApproveLine(1, 600L, "Столько не заказывали"),
                new DeliveryService.ApproveLine(2, 0L, "Рис есть")), "Принимай только лосось", manager);
        assertThatThrownBy(() -> deliveries.accept(LOC, "a1", List.of(), null, manager, true))
                .as("кто одобрил — тот не принимает").hasMessageContaining("принимает другой");
        assertThatThrownBy(() -> deliveries.accept(LOC, "a1", List.of(new DeliveryService.AcceptLine(1, 700L)), null,
                storekeeper, true)).as("больше одобренного — нельзя").hasMessageContaining("одобрил не больше");

        var r = deliveries.accept(LOC, "a1", List.of(), null, storekeeper, true);
        assertThat(r.status()).isEqualTo("PARTIAL");
        assertThat(qtyLeft("salmon")).isEqualTo(600);
        assertThat(qtyLeft("rice")).isZero();
        assertThat(jdbc.sql("SELECT string_agg(reject_reason, ',' ORDER BY line_no) FROM delivery_lines WHERE delivery_id = 'a1'")
                .query(String.class).single()).isEqualTo("NOT_APPROVED,NOT_APPROVED");
        assertThat(jdbc.sql("SELECT COUNT(*) FROM alerts WHERE type = 'DELIVERY_DIFF'").query(Long.class).single())
                .as("урезал управляющий — это не расхождение у двери").isZero();
        assertThat(jdbc.sql("SELECT COUNT(*) FROM alerts WHERE type = 'DELIVERY_APPROVAL' AND ack_at IS NULL")
                .query(Long.class).single()).as("сигнал закрыт одобрением").isZero();
    }

    @Test
    void cashierSeesPortionsLeftAfterCartIncludingSharedProducts() {
        deliver("d1", "salmon", 500, 72);
        deliver("d2", "rice", 10_000, 72);
        assertThat(portions(List.of())).containsEntry("roll", 5L).containsEntry("poke", 4L).containsEntry("set", 2L);
        // Пробили два ролла: ролла осталось 3, а поке на том же лососе — 2 (300 г / 120 г), сета из двух роллов — 1
        assertThat(portions(List.of(new ru.sphere.stock.domain.OrderLine("roll", 2))))
                .containsEntry("roll", 3L).containsEntry("poke", 2L).containsEntry("set", 1L);
        assertThat(portions(List.of(new ru.sphere.stock.domain.OrderLine("roll", 5)))).containsEntry("roll", 0L)
                .as("корзина больше склада — не минус, а ноль").containsEntry("poke", 0L);
        assertThat(qtyLeft("salmon")).as("подсчёт ничего не списывает").isEqualTo(500);
    }

    private java.util.Map<String, Long> portions(List<ru.sphere.stock.domain.OrderLine> cart) {
        java.util.Map<String, Long> out = new java.util.HashMap<>();
        menu.menuAfter(LOC, cart).forEach(v -> out.put(v.variantId(), v.portions()));
        return out;
    }

    @Test
    void traceSplitsSharedProductByDishesAndOpensPrepsDownToRawBatches() {
        importer.importCatalog(TenantDirectory.DEMO, new CatalogImportService.CatalogIn(
                List.of(product("mayo", "Майонез", 300), product("garlic", "Чеснок", 400),
                        new CatalogImportService.ProductIn("sauce", "Соус", "G", "SEMI", null, null, 24, null, null,
                                0.0, null, null, null)),
                List.of(new CatalogImportService.SemiIn("sauce", 1000, List.of(
                        new CatalogImportService.LineIn("mayo", 800, null),
                        new CatalogImportService.LineIn("garlic", 200, null)))),
                List.of(new CatalogImportService.DishIn("spicy", "Спайси", "Роллы", null, 4, List.of(
                        new CatalogImportService.VariantIn("spicy", "Спайси", null, 35_000, false, List.of(
                                new CatalogImportService.LineIn("salmon", 100, null),
                                new CatalogImportService.LineIn("sauce", 40, null)))))),
                List.of()), manager);
        deliver("d1", "salmon", 250, 48);            // кончится посреди заказа: FEFO берёт её первой
        deliver("d2", "salmon", 1000, 72);
        deliver("d3", "rice", 10_000, 72);
        deliver("d4", "mayo", 2000, 72);
        deliver("d5", "garlic", 1000, 72);
        var sauce = production.produce(LOC, "sauce", 1000, cook);

        // Ролл ×2 (200 г лосося) + поке (120 г) + спайси (100 г и 40 г соуса): склад списал лосось одной суммой — 420 г
        var o = (OrderService.Created) orders.create(LOC, new OrderService.OrderIn("tr-1", "POS", List.of(
                new OrderService.LineIn("roll", 2), new OrderService.LineIn("poke", 1),
                new OrderService.LineIn("spicy", 1))), cashier);
        var t = trace.order(LOC, o.id());
        assertThat(t.dishes()).extracting(TraceService.DishPart::name).containsExactly("Ролл", "Поке", "Спайси");
        assertThat(t.unassigned()).isEmpty();
        assertThat(t.dishes().stream().mapToLong(TraceService.DishPart::costKop).sum())
                .as("себестоимость блюд сходится с заказом до копейки").isEqualTo(o.costKop());
        assertThat(salmonTakes(t.dishes().get(0))).containsExactly(200L);          // ролл — из первой партии
        assertThat(salmonTakes(t.dishes().get(1))).containsExactly(50L, 70L);      // поке — остаток первой + вторая
        assertThat(salmonTakes(t.dishes().get(2))).containsExactly(100L);

        // Соус в спайси раскрыт до сырья: 40 г из 1 кг — это 32 г майонеза и 8 г чеснока
        var sauceTake = t.dishes().get(2).parts().stream().filter(TraceService.Part::semi).findFirst().orElseThrow()
                .batches().getFirst();
        assertThat(sauceTake.batchId()).isEqualTo(sauce.batchId());
        assertThat(sauceTake.madeFrom()).extracting(TraceService.Part::productId, TraceService.Part::qty)
                .containsExactlyInAnyOrder(org.assertj.core.groups.Tuple.tuple("mayo", 32L),
                        org.assertj.core.groups.Tuple.tuple("garlic", 8L));

        // Заготовка: из чего сделана и куда ушла
        assertThat(trace.preps(LOC, 1, 10)).singleElement().satisfies(p -> {
            assertThat(p.parts()).extracting(TraceService.Part::productId).containsExactlyInAnyOrder("mayo", "garlic");
            assertThat(p.toOrders()).isEqualTo(40);
            assertThat(p.left()).isEqualTo(960);
        });
        assertThat(trace.batchDishes(LOC, sauce.batchId())).singleElement().satisfies(d -> {
            assertThat(d.name()).isEqualTo("Спайси");
            assertThat(d.qty()).isEqualTo(40);
            assertThat(d.portions()).isEqualTo(1);
        });

        // Продукт: лосось — по блюдам, майонез — в спайси через соус
        var salmon = trace.product(LOC, "salmon", 1);
        assertThat(salmon.toDishes()).isEqualTo(420);
        assertThat(salmon.dishes()).extracting(TraceService.DishUse::name, TraceService.DishUse::qty)
                .containsExactly(org.assertj.core.groups.Tuple.tuple("Ролл", 200L),
                        org.assertj.core.groups.Tuple.tuple("Поке", 120L), org.assertj.core.groups.Tuple.tuple("Спайси", 100L));
        var mayo = trace.product(LOC, "mayo", 1);
        assertThat(mayo.toPreps()).isEqualTo(800);
        assertThat(mayo.dishes()).singleElement().satisfies(d -> {
            assertThat(d.name()).isEqualTo("Спайси");
            assertThat(d.qty()).isEqualTo(32);
            assertThat(d.via()).isEqualTo("Соус");
        });

        // Техкарту ролла поменяли — старый заказ раскладывается по той версии, по которой списан
        importer.importCatalog(TenantDirectory.DEMO, new CatalogImportService.CatalogIn(List.of(), List.of(),
                List.of(new CatalogImportService.DishIn("roll", "Ролл", "Роллы", null, 1, List.of(
                        new CatalogImportService.VariantIn("roll", "Ролл", null, 30_000, false, List.of(
                                new CatalogImportService.LineIn("salmon", 150, null),
                                new CatalogImportService.LineIn("rice", 100, null)))))),
                List.of()), manager);
        var again = trace.order(LOC, o.id());
        assertThat(salmonTakes(again.dishes().get(0))).containsExactly(200L);
        assertThat(again.dishes().get(0).recipeVersion()).isEqualTo(1);
        assertThat(again.unassigned()).isEmpty();
    }

    private static List<Long> salmonTakes(TraceService.DishPart dish) {
        return dish.parts().stream().filter(p -> p.productId().equals("salmon")).findFirst().orElseThrow()
                .batches().stream().map(TraceService.Take::qty).toList();
    }

    @Test
    void storekeeperReturnsPartOfDeliveryOnlyAfterManagerOrAdminApproves() {
        deliver("d1", "salmon", 1000, 72);
        deliver("d2", "rice", 5000, 72);
        var line = returns.returnable(LOC, "d1").getFirst();
        assertThat(line.available()).isEqualTo(1000);

        assertThatThrownBy(() -> returns.create(LOC, "d1", List.of(new SupplierReturnService.LineIn(line.batchId(), 300)),
                "DEFECT", null, List.of(), storekeeper)).as("без фото — нельзя").hasMessageContaining("фото");
        assertThatThrownBy(() -> returns.create(LOC, "d1", List.of(new SupplierReturnService.LineIn(line.batchId(), 1200)),
                "DEFECT", null, List.of("p.jpg"), storekeeper)).hasMessageContaining("не больше");
        long riceBatch = returns.returnable(LOC, "d2").getFirst().batchId();
        assertThatThrownBy(() -> returns.create(LOC, "d1", List.of(new SupplierReturnService.LineIn(riceBatch, 100)),
                "DEFECT", null, List.of("p.jpg"), storekeeper)).as("партия чужой поставки").hasMessageContaining("не из этой поставки");

        // Кладовщик подал: 300 г брака — сразу не продаются, но со склада ещё не ушли
        var r = returns.create(LOC, "d1", List.of(new SupplierReturnService.LineIn(line.batchId(), 300)),
                "DEFECT", "Тёмные пятна", List.of("p.jpg"), storekeeper);
        assertThat(r.status()).isEqualTo("PENDING");
        assertThat(qtyLeft("salmon")).isEqualTo(1000);
        assertThat(held(line.batchId())).isEqualTo(300);
        assertThat(returns.returnable(LOC, "d1").getFirst().available()).isEqualTo(700);
        assertThat(order("after-hold", "roll", 8)).as("удержанное не продаётся: 700 г — максимум 7 роллов")
                .isInstanceOf(OrderService.Refused.class);
        assertThat(jdbc.sql("SELECT COUNT(*) FROM alerts WHERE type = 'RETURN_PENDING' AND ack_at IS NULL")
                .query(Long.class).single()).isEqualTo(1);

        // Подтвердил управляющий — ушло движением «Возврат поставщику», сигнал закрыт
        returns.approve(LOC, r.id(), "Звоню поставщику", manager);
        assertThat(qtyLeft("salmon")).isEqualTo(700);
        assertThat(held(line.batchId())).isZero();
        assertThat(jdbc.sql("SELECT -SUM(qty) FROM movements WHERE type = 'RETURN_SUPPLIER'").query(Long.class).single())
                .isEqualTo(300);
        assertThat(jdbc.sql("SELECT COUNT(*) FROM alerts WHERE type = 'RETURN_PENDING' AND ack_at IS NULL")
                .query(Long.class).single()).isZero();
        assertThat(returns.list(LOC, null, "d1")).singleElement().satisfies(x -> {
            assertThat(x.status()).isEqualTo("EXECUTED");
            assertThat(x.reasonText()).isEqualTo("брак");
            assertThat(x.lines()).singleElement().satisfies(l -> assertThat(l.qty()).isEqualTo(300));
        });
        assertThat(query.supply(LOC, 1)).filteredOn(s -> s.productId().equals("salmon")).singleElement()
                .satisfies(s -> assertThat(s.received()).as("привезли — за вычетом возврата").isEqualTo(700));
        assertThat(ledger.verify(LOC).ok()).isTrue();

        // Отказ возвращает количество в продажу; решённую заявку второй раз не решить
        var second = returns.create(LOC, "d1", List.of(new SupplierReturnService.LineIn(line.batchId(), 100)),
                "OTHER", "Пересорт", List.of("p.jpg"), storekeeper);
        returns.reject(LOC, second.id(), "Поставщик не принимает", manager2);
        assertThat(held(line.batchId())).isZero();
        assertThat(qtyLeft("salmon")).isEqualTo(700);
        assertThatThrownBy(() -> returns.approve(LOC, second.id(), null, manager2)).hasMessageContaining("уже решена");

        // Управляющий сам решает: его возврат проходит сразу, запроса самому себе нет
        var own = returns.create(LOC, "d1", List.of(new SupplierReturnService.LineIn(line.batchId(), 100)),
                "QUALITY", null, List.of("p.jpg"), manager);
        assertThat(own.status()).isEqualTo("EXECUTED");
        assertThat(qtyLeft("salmon")).isEqualTo(600);
        assertThat(jdbc.sql("SELECT COUNT(*) FROM alerts WHERE type = 'RETURN_PENDING' AND object_id = ?")
                .param(Long.toString(own.id())).query(Long.class).single()).isZero();
        assertThat(ledger.verify(LOC).ok()).isTrue();
    }

    private long held(long batchId) {
        return jdbc.sql("SELECT held_qty FROM batches WHERE id = ?").param(batchId).query(Long.class).single();
    }

    @Test
    void storekeeperPicksDeliveryThenItsProductsAsOneRequestManagerDecidesWhole() {
        deliveries.receive(LOC, new DeliveryService.DeliveryIn("w1", "П-7", clock.now(), "ООО Ромашка", List.of(
                new DeliveryService.LineIn("salmon", "Лосось", "G", 1000, 72, null, 180_000L),
                new DeliveryService.LineIn("rice", "Рис", "G", 5000, 72, null, 75_000L))), storekeeper, true);
        var source = writeoffs.sources(LOC).stream().filter(x -> "w1".equals(x.deliveryId())).findFirst().orElseThrow();
        assertThat(source.kind()).isEqualTo("DELIVERY");
        assertThat(source.number()).isEqualTo("П-7");
        assertThat(source.lines()).extracting(WriteoffService.SourceLine::productId).containsExactlyInAnyOrder("salmon", "rice");
        long salmon = source.lines().stream().filter(l -> l.productId().equals("salmon")).findFirst().orElseThrow().batchId();
        long rice = source.lines().stream().filter(l -> l.productId().equals("rice")).findFirst().orElseThrow().batchId();

        // Из поставки П-7 — лосось и рис одной заявкой: сразу не списано, удержано, управляющему — запрос
        var g = writeoffs.createBatches(LOC, List.of(new WriteoffService.LineIn(salmon, 200),
                new WriteoffService.LineIn(rice, 500)), "SPOILED", "Протекла камера", List.of(photos.placeholder()), storekeeper);
        assertThat(g.needsApproval()).isTrue();
        assertThat(g.ids()).hasSize(2);
        assertThat(qtyLeft("salmon")).isEqualTo(1000);
        assertThat(writeoffs.sources(LOC).stream().filter(x -> "w1".equals(x.deliveryId())).findFirst().orElseThrow()
                .lines()).filteredOn(l -> l.batchId() == salmon).singleElement()
                .satisfies(l -> assertThat(l.available()).as("удержанное уже не предлагается").isEqualTo(800));
        assertThat(writeoffs.list(LOC, "PENDING")).allSatisfy(r -> assertThat(r.deliveryNumber()).isEqualTo("П-7"));
        assertThatThrownBy(() -> writeoffs.createBatches(LOC, List.of(new WriteoffService.LineIn(salmon, 900)),
                "SPOILED", null, List.of(photos.placeholder()), storekeeper)).hasMessageContaining("не больше");

        // Управляющий одобряет одну строку — уходит вся заявка
        writeoffs.approve(LOC, g.ids().getLast(), null, manager);
        assertThat(qtyLeft("salmon")).isEqualTo(800);
        assertThat(qtyLeft("rice")).isEqualTo(4500);
        assertThat(jdbc.sql("SELECT COUNT(*) FROM alerts WHERE type = 'WRITEOFF_PENDING' AND ack_at IS NULL")
                .query(Long.class).single()).as("запрос закрыт решением").isZero();
        assertThat(ledger.verify(LOC).ok()).isTrue();
    }

    @Test
    void storekeeperDoesNotSeeOrCloseManagersSignals() {
        deliver("d1", "salmon", 1000, 72);
        long batch = jdbc.sql("SELECT id FROM batches WHERE product_id = 'salmon'").query(Long.class).single();
        Instant now = clock.now();
        alerts.raise(LOC, "ANOMALY", "WARN", "anomaly", "A4:1", "Подозрительная операция: Списание дорогой позиции",
                "Кладовщик списывает дорогую позицию", now);
        writeoffs.create(LOC, batch, 100, "SPOILED", null, List.of(photos.placeholder()), storekeeper);
        alerts.raise(LOC, "STOP_IN", "WARN", "product", "rice", "Закончилось «Рис»", null, now);

        // Кладовщику — только своё: «стоп» есть, антифрода и запроса на одобрение нет
        assertThat(alerts.list(LOC, true, 50, "STOREKEEPER")).extracting(AlertService.Alert::type)
                .contains("STOP_IN").doesNotContain("ANOMALY", "WRITEOFF_PENDING");
        assertThat(alerts.list(LOC, true, 50, "MANAGER")).extracting(AlertService.Alert::type)
                .contains("STOP_IN", "ANOMALY", "WRITEOFF_PENDING");
        // «Отметить все» у кладовщика не закрывает сигналы управляющего; чужой сигнал по id — не найден
        alerts.ackAll(LOC, storekeeper, "STOREKEEPER");
        assertThat(alerts.list(LOC, true, 50, "MANAGER")).extracting(AlertService.Alert::type)
                .contains("ANOMALY", "WRITEOFF_PENDING").doesNotContain("STOP_IN");
        long anomaly = alerts.list(LOC, true, 50, "MANAGER").stream().filter(a -> a.type().equals("ANOMALY"))
                .findFirst().orElseThrow().id();
        assertThatThrownBy(() -> alerts.ack(LOC, anomaly, storekeeper, "STOREKEEPER")).hasMessageContaining("Сигнал");
        assertThat(AlertService.visibleTo("ANOMALY", null)).as("сайту по ключу видно всё").isTrue();
    }

    @Test
    void anomalyOpensDetailsFiltersByPeriodAndTakesOneOfTwoDecisions() {
        deliver("d1", "salmon", 1000, 72);
        long batch = jdbc.sql("SELECT id FROM batches WHERE product_id = 'salmon'").query(Long.class).single();
        // Свежий лосось списан как «испорченный» — правило A2
        writeoffs.create(LOC, batch, 300, "SPOILED", "Запах", List.of(photos.placeholder()), storekeeper);
        var a = anomalyService.list(LOC, "NEW", null, null).stream().filter(x -> x.rule().equals("A2"))
                .findFirst().orElseThrow();

        var d = anomalyDetails.detail(LOC, a.id());
        assertThat(d.ruleHow()).contains("половины срока");
        assertThat(d.facts()).extracting(AnomalyDetails.Fact::label).contains("Количество");
        assertThat(d.writeoffs()).singleElement().satisfies(w -> {
            assertThat(w.batchId()).isEqualTo(batch);
            assertThat(w.reason()).isEqualTo("порча");
            assertThat(w.hasPhoto()).isTrue();
        });
        assertThat(d.links()).extracting(AnomalyDetails.Link::to).contains("batches/" + batch);

        // Период: сегодня — есть, вчера — нет
        java.time.LocalDate today = java.time.LocalDate.ofInstant(clock.now(), ru.sphere.stock.domain.OpenHours.MSK);
        assertThat(anomalyService.list(LOC, null, today, today)).isNotEmpty();
        assertThat(anomalyService.list(LOC, null, today.minusDays(3), today.minusDays(1))).isEmpty();

        // Решений два; «проверено» больше нет; разобранную второй раз не решить; сигнал закрывается
        assertThatThrownBy(() -> anomalyService.review(LOC, a.id(), "REVIEWED", null, manager))
                .hasMessageContaining("CONFIRMED");
        anomalyService.review(LOC, a.id(), "CONFIRMED", "Лосось был свежий — разговор с кладовщиком", manager);
        assertThat(anomalyService.one(LOC, a.id()).status()).isEqualTo("CONFIRMED");
        assertThatThrownBy(() -> anomalyService.review(LOC, a.id(), "FALSE", null, manager2))
                .hasMessageContaining("уже разобрана");
        assertThat(jdbc.sql("SELECT COUNT(*) FROM alerts WHERE type = 'ANOMALY' AND object_id = ?")
                .param(Long.toString(a.id())).query(Long.class).single()).as("сигнал ссылается на саму операцию").isEqualTo(1);
        assertThat(jdbc.sql("SELECT COUNT(*) FROM alerts WHERE type = 'ANOMALY' AND object_id = ? AND ack_at IS NULL")
                .param(Long.toString(a.id())).query(Long.class).single()).as("разобрали — сигнал закрыт").isZero();
    }

    @Test
    void recipeRollbackIsANewVersionWithTheOldLines() {
        long v1 = jdbc.sql("SELECT id FROM recipe_versions WHERE variant_id = 'roll' AND status = 'ACTIVE'")
                .query(Long.class).single();
        // Управляющий поднял лосося в ролле до 150 г — v2
        importer.upsertRecipe(TenantDirectory.DEMO, "roll", null, null, List.of(
                new CatalogImportService.LineIn("salmon", 150, null), new CatalogImportService.LineIn("rice", 100, null)),
                manager, "Больше рыбы");
        // Откат к v1 — это v3 с составом v1, история не переписывается
        assertThat(importer.restoreVersion(TenantDirectory.DEMO, "roll", v1, manager, "Гости жалуются на цену")).isEqualTo(1);
        assertThat(jdbc.sql("SELECT version, status, comment FROM recipe_versions WHERE variant_id = 'roll' ORDER BY version")
                .query((rs, n) -> rs.getInt(1) + ":" + rs.getString(2)).list())
                .containsExactly("1:ARCHIVED", "2:ARCHIVED", "3:ACTIVE");
        assertThat(jdbc.sql("SELECT comment FROM recipe_versions WHERE variant_id = 'roll' AND version = 3")
                .query(String.class).single()).startsWith("Откат к v1");
        assertThat(importer.activeLines(TenantDirectory.DEMO, "roll")).extracting(ru.sphere.stock.domain.RecipeLine::netQty)
                .containsExactlyInAnyOrder(100L, 100L);
        assertThatThrownBy(() -> importer.restoreVersion(TenantDirectory.DEMO, "roll", v1, manager, null))
                .as("v1 уже действует").hasMessageContaining("уже действует");

        // Заказ после отката списывает по v3: 100 г лосося
        catalog.invalidate();
        deliver("d1", "salmon", 1000, 72);
        deliver("d2", "rice", 1000, 72);
        assertThat(order("after-rollback", "roll", 1)).isInstanceOf(OrderService.Created.class);
        assertThat(qtyLeft("salmon")).isEqualTo(900);
    }

    @Test
    void requestKeepsSeveralPhotosAndServesEachByIndex() {
        deliver("d1", "salmon", 1000, 72);
        long batch = jdbc.sql("SELECT id FROM batches WHERE product_id = 'salmon'").query(Long.class).single();
        var r = writeoffs.create(LOC, batch, 100, "DAMAGED", "Упала коробка", List.of("a.jpg", "b.jpg", "c.png"), storekeeper);
        assertThat(writeoffs.photoOf(LOC, r.id(), 0)).isEqualTo("a.jpg");
        assertThat(writeoffs.photoOf(LOC, r.id(), 2)).isEqualTo("c.png");
        assertThatThrownBy(() -> writeoffs.photoOf(LOC, r.id(), 3)).hasMessageContaining("Фото");
        assertThat(writeoffs.list(LOC, "PENDING")).singleElement().satisfies(x -> assertThat(x.photoCount()).isEqualTo(3));
        assertThatThrownBy(() -> writeoffs.create(LOC, batch, 100, "DAMAGED", null, List.of(), storekeeper))
                .hasMessageContaining("фото");
    }

    @Test
    void lossesForAPeriodHaveAnEndAndDaysGoInOrder() {
        deliver("d1", "salmon", 1000, 240);
        long batch = jdbc.sql("SELECT id FROM batches WHERE product_id = 'salmon'").query(Long.class).single();
        java.time.LocalDate day0 = java.time.LocalDate.ofInstant(clock.now(), ru.sphere.stock.domain.OpenHours.MSK);
        var first = writeoffs.create(LOC, batch, 100, "DAMAGED", null, List.of(photos.placeholder()), manager);
        clock.advance(Duration.ofDays(5));
        writeoffs.create(LOC, batch, 50, "DAMAGED", null, List.of(photos.placeholder()), manager);

        // Неделя по day0: списание через 5 дней — уже за концом периода, в неё не попадает
        var week = query.writeoffs(LOC, query.period(LOC, 7, day0.minusDays(6), day0));
        long firstCost = jdbc.sql("SELECT cost_kop FROM writeoff_requests WHERE id = ?").param(first.id()).query(Long.class).single();
        assertThat(week.totalKop()).isEqualTo(firstCost);
        assertThat(week.byDay()).extracting(QueryService.DayValue::day)
                .as("каждый день периода, по порядку").containsExactly(java.util.stream.IntStream.rangeClosed(0, 6)
                        .mapToObj(i -> day0.minusDays(6 - i).toString()).toArray(String[]::new));
        assertThat(week.from()).isEqualTo(day0.minusDays(6).toString());

        var both = query.writeoffs(LOC, query.period(LOC, 7, day0, day0.plusDays(5)));
        assertThat(both.byDay()).hasSize(6);
        assertThat(both.byDay().getLast().valueKop()).isPositive();
        assertThatThrownBy(() -> query.period(LOC, 7, day0, day0.minusDays(1))).hasMessageContaining("позже");
    }

    @Test
    void typoPriceInInvoiceIsNotRememberedAndRaisesASignal() {
        deliver("d1", "salmon", 1000, 72);                       // 180 коп/г — как в справочнике (1 800 ₽/кг)
        java.util.function.Supplier<Double> price = () -> jdbc.sql(
                "SELECT last_unit_cost_kop FROM products WHERE id = 'salmon'").query(Double.class).single();
        assertThat(price.get()).isEqualTo(180.0);
        // «2 г за 45 232 ₽» — опечатка: 2 261 600 коп за грамм
        deliveries.receive(LOC, new DeliveryService.DeliveryIn("typo", "П-9", clock.now(), "Поставщик", List.of(
                new DeliveryService.LineIn("salmon", "salmon", "G", 2, 72, null, 4_523_200L))), storekeeper, true);
        assertThat(price.get()).as("опечатка не становится ценой продукта").isEqualTo(180.0);
        assertThat(jdbc.sql("SELECT needs_review FROM products WHERE id = 'salmon'").query(Boolean.class).single()).isTrue();
        assertThat(alerts.list(LOC, true, 50, "MANAGER")).filteredOn(a -> a.type().equals("PRICE_OUTLIER"))
                .singleElement().satisfies(a -> assertThat(a.title()).contains("раз выше"));
        assertThat(alerts.list(LOC, true, 50, "STOREKEEPER")).extracting(AlertService.Alert::type).contains("PRICE_OUTLIER");
        // Обычная цена дальше запоминается как прежде
        deliveries.receive(LOC, new DeliveryService.DeliveryIn("ok", "П-10", clock.now(), "Поставщик", List.of(
                new DeliveryService.LineIn("salmon", "salmon", "G", 1000, 72, null, 200_000L))), storekeeper, true);
        assertThat(price.get()).isEqualTo(200.0);
    }

    @Test
    void operationsShowWhatWhereFromAndWhoForAnalyticsDrillDown() {
        deliver("d1", "salmon", 1000, 72);
        deliver("d2", "rice", 1000, 72);
        var o = (OrderService.Created) order("op-1", "roll", 1);
        long batch = jdbc.sql("SELECT id FROM batches WHERE product_id = 'salmon'").query(Long.class).single();
        var w = writeoffs.create(LOC, batch, 50, "SPOILED", "Запах", List.of(photos.placeholder()), storekeeper);
        writeoffs.approve(LOC, w.id(), null, manager);
        var period = query.period(LOC, 1, null, null);

        // Сотрудник: его заявка видна у него, хотя движение записал подписавший управляющий
        var mine = operations.list(LOC, period, Long.toString(storekeeper.userId()), null, null, 100);
        assertThat(mine.items()).filteredOn(x -> x.type().equals("WRITEOFF_SPOILED")).singleElement().satisfies(x -> {
            assertThat(x.actor()).isEqualTo("manager");
            assertThat(x.author()).isEqualTo("store");
            assertThat(x.docLabel()).isEqualTo("заявка на списание №" + w.id());
            assertThat(x.batchId()).isEqualTo(batch);
        });
        // Лосось за день: приход по поставке, расход по заказу, списание — с документами
        var salmon = operations.list(LOC, period, null, null, "salmon", 100);
        assertThat(salmon.summary()).extracting(OperationsService.TypeSum::type)
                .containsExactlyInAnyOrder("RECEIPT", "ORDER", "WRITEOFF_SPOILED");
        assertThat(salmon.items()).filteredOn(x -> x.type().equals("RECEIPT")).singleElement()
                .satisfies(x -> assertThat(x.docLabel()).isEqualTo("поставка N-d1"));
        assertThat(salmon.items()).filteredOn(x -> x.type().equals("ORDER")).singleElement().satisfies(x -> {
            assertThat(x.docType()).isEqualTo("order");
            assertThat(x.docId()).isEqualTo(Long.toString(o.id()));
            assertThat(x.docLabel()).isEqualTo("заказ №" + o.number());
        });
        assertThat(operations.list(LOC, period, null, "LOSS", null, 100).items())
                .extracting(OperationsService.Op::type).containsOnly("WRITEOFF_SPOILED");

        // Кто что делал: кладовщик — приёмка и своя заявка на списание (хотя подписал управляющий), кассир — заказ
        var byActor = operations.byActor(LOC, period);
        assertThat(byActor).filteredOn(x -> x.actor().equals(Long.toString(storekeeper.userId()))).singleElement()
                .satisfies(x -> assertThat(x.types()).extracting(OperationsService.TypeSum::type)
                        .contains("RECEIPT", "WRITEOFF_SPOILED"));
        assertThat(byActor).filteredOn(x -> x.actor().equals(Long.toString(cashier.userId()))).singleElement()
                .satisfies(x -> assertThat(x.types()).extracting(OperationsService.TypeSum::type).containsExactly("ORDER"));
    }

    @Test
    void menuFromExcelBuildsANewEnterpriseCatalog() {
        // Пример меню → Excel → обратно: тот же каталог
        byte[] xlsx = ru.sphere.stock.catalog.CatalogXlsx.write(ru.sphere.stock.catalog.CatalogXlsx.sample());
        assertThat(ru.sphere.stock.infra.Xlsx.looksLike(xlsx)).isTrue();
        var in = ru.sphere.stock.catalog.CatalogXlsx.parse(xlsx);
        var sample = ru.sphere.stock.catalog.CatalogXlsx.sample();
        assertThat(in.products()).hasSize(sample.products().size());
        assertThat(in.semi()).singleElement().satisfies(x -> assertThat(x.lines()).hasSize(2));
        assertThat(in.dishes()).hasSize(sample.dishes().size());
        assertThat(in.dishes()).filteredOn(d -> d.id().equals("kf_cappuccino")).singleElement()
                .satisfies(d -> assertThat(d.variants()).extracting(CatalogImportService.VariantIn::priceKop)
                        .containsExactly(22_000L, 26_000L));
        assertThat(in.sets()).singleElement().satisfies(x -> assertThat(x.items()).hasSize(2));

        // Новое предприятие получает меню из Excel
        Actor admin = newAdmin("cafe");
        var cafe = tenantService.create("Кофейня", null, admin);
        importer.importCatalog(cafe.tenantId(), in, admin);
        var cat = catalog.get(cafe.tenantId());
        assertThat(cat.variant("kf_raf").lines()).hasSize(3);
        assertThat(cat.variant("kf_breakfast").isSet()).isTrue();
        assertThat(cat.semi("kf_filling").yield()).isEqualTo(500);
        assertThat(catalog.get(TenantDirectory.DEMO).variant("kf_raf")).as("демо-предприятие не тронуто").isNull();
    }

    @Test
    void deliveryFromExcelUnderstandsKilogramsRublesAndDates() {
        byte[] xlsx = ru.sphere.stock.infra.Xlsx.write(List.of(new ru.sphere.stock.infra.Xlsx.Sheet("Поставка", List.of(
                List.<Object>of("Номер поставки", "П-77"),
                List.<Object>of("Поставщик", "ООО Ромашка"),
                List.<Object>of("Дата отгрузки", "09.10.2026 09:00"),
                List.<Object>of(),
                List.<Object>of("ID продукта", "Название", "Ед.", "Количество", "Срок хранения, ч", "Годен до", "Сумма, ₽"),
                List.<Object>of("salmon", "Лосось", "кг", "2,5", 72, "", "1 250,50"),
                List.<Object>of("rice", "Рис", "г", 500, "", "2026-10-20 18:00", 75)), List.of())));
        var d = ru.sphere.stock.delivery.DeliveryXlsx.parse(xlsx);
        assertThat(d.number()).isEqualTo("П-77");
        assertThat(d.createdAt()).isEqualTo(Instant.parse("2026-10-09T06:00:00Z"));
        assertThat(d.lines()).extracting(DeliveryService.LineIn::qty).containsExactly(2500L, 500L);
        assertThat(d.lines()).extracting(DeliveryService.LineIn::costKop).containsExactly(125_050L, 7_500L);
        assertThat(d.lines().get(1).expiresAt()).isEqualTo(Instant.parse("2026-10-20T15:00:00Z"));
        assertThat(ru.sphere.stock.delivery.DeliveryXlsx.parse(xlsx).id()).as("тот же файл — тот же ID").isEqualTo(d.id());
        deliveries.receive(LOC, d, storekeeper, true);
        assertThat(qtyLeft("salmon")).isEqualTo(2500);

        // Пример из каталога читается обратно
        var sample = ru.sphere.stock.delivery.DeliveryXlsx.sample(List.of(catalog.get(TenantDirectory.DEMO).product("salmon")),
                java.util.Map.of("salmon", 180.0), clock.now());
        assertThat(ru.sphere.stock.delivery.DeliveryXlsx.parse(sample).lines()).singleElement()
                .satisfies(l -> assertThat(l.qty()).isEqualTo(2000));
        assertThatThrownBy(() -> ru.sphere.stock.delivery.DeliveryXlsx.parse(ru.sphere.stock.infra.Xlsx.write(List.of(
                new ru.sphere.stock.infra.Xlsx.Sheet("Лист", List.of(List.<Object>of("просто текст")), List.of())))))
                .hasMessageContaining("ID продукта");
    }

    @Test
    void onlyThePlatformAdminCreatesEnterprisesOthersOnlyRequest() {
        // Открытая регистрация: учётка без предприятия
        long anna = users.createAccount("anna", "Анна", "secret1");
        assertThat(users.principal(anna, null).tenantId()).isZero();
        assertThat(users.memberships(anna)).isEmpty();

        // Режим «через заявку» (по умолчанию): заявка администратору платформы, предприятия пока нет
        assertThat(platform.settings().tenantCreation()).isEqualTo("APPROVAL");
        var r = platform.createOrRequest(anna, "Анна", false, "Кофейня у дома", "Центр", "Открываемся в ноябре");
        assertThat(r.status()).isEqualTo("PENDING");
        assertThatThrownBy(() -> platform.createOrRequest(anna, "Анна", false, "Ещё одна", null, null))
                .as("одна ждущая заявка").hasMessageContaining("уже ждёт");
        users.addMembership(anna, TenantDirectory.DEMO, "COOK", null);     // пока ждёт — работает поваром в ИСТОК
        assertThat(users.principal(anna, null).tenantId()).isEqualTo(TenantDirectory.DEMO);
        long platformAdmin = jdbc.sql("SELECT id FROM users WHERE login = 'demo-platform'").query(Long.class).single();
        assertThat(users.isPlatformAdmin(platformAdmin)).isTrue();
        assertThat(users.isPlatformAdmin(anna)).isFalse();

        // Администратор платформы одобряет — предприятие создано, заявитель в нём админ
        var approved = platform.approve(r.request().id(), platformAdmin, "Добро пожаловать");
        assertThat(approved.status()).isEqualTo("APPROVED");
        assertThat(approved.decidedVia()).isEqualTo("CONSOLE");
        assertThat(users.principal(anna, null).tenantId()).as("после одобрения вход ведёт в новое предприятие")
                .isEqualTo(approved.tenantId());
        var p = users.principal(anna, approved.tenantId());
        assertThat(p.role()).isEqualTo("ADMIN");
        assertThat(tenantService.locations(approved.tenantId())).singleElement()
                .satisfies(l -> assertThat(l.name()).isEqualTo("Центр"));
        assertThatThrownBy(() -> platform.reject(r.request().id(), platformAdmin, null)).hasMessageContaining("уже решена");

        // Отклонить из CRM по ключу платформы (decidedBy = null)
        long boris = users.createAccount("boris", "Борис", "secret1");
        var rb = platform.createOrRequest(boris, "Борис", false, "Пекарня", null, null);
        assertThat(platform.reject(rb.request().id(), null, "Нет документов").decidedVia()).isEqualTo("API");
        assertThat(users.memberships(boris)).isEmpty();

        // Режима «сразу» нет (ТЗ 16.14): предприятия создаёт только администратор платформы
        assertThatThrownBy(() -> platform.update(new PlatformService.Settings("INSTANT", true)))
                .hasMessageContaining("только администратор платформы");
        var rb2 = platform.createOrRequest(boris, "Борис", false, "Пекарня", null, null);
        assertThat(rb2.status()).as("без предприятия — только заявка").isEqualTo("PENDING");
        long bakery = platform.approve(rb2.request().id(), platformAdmin, null).tenantId();
        assertThat(users.principal(boris, bakery).role()).isEqualTo("ADMIN");
        assertThat(platform.tenants()).extracting(PlatformService.TenantDto::name).contains("Кофейня у дома", "Пекарня");

        // Сотрудник предприятия — админ, управляющий, повар — ни создать, ни подать заявку не может
        assertThatThrownBy(() -> platform.createOrRequest(boris, "Борис", false, "Вторая пекарня", null, null))
                .hasMessageContaining("только администратор платформы");
        assertThatThrownBy(() -> platform.createOrRequest(anna, "Анна", false, "Вторая кофейня", null, null))
                .hasMessageContaining("только администратор платформы");
        long vera = users.createAccount("vera", "Вера", "secret1");
        users.addMembership(vera, TenantDirectory.DEMO, "MANAGER", null);
        assertThatThrownBy(() -> platform.createOrRequest(vera, "Вера", false, "Своё кафе", null, null))
                .hasMessageContaining("только администратор платформы");
        assertThat(platform.createOrRequest(platformAdmin, "Платформа", true, "Для клиента", null, null).status())
                .isEqualTo("CREATED");
    }

    @Test
    void platformAdminDeletesAnEnterpriseOnlyWithItsExactName() {
        Actor owner = newAdmin("owner9");
        var cafe = tenantService.create("Кофейня", "Центр", owner);
        String loc2 = cafe.locationId();
        Actor owner2 = Actor.user(owner.userId(), "ADMIN", "owner9");
        importer.importCatalog(cafe.tenantId(), new CatalogImportService.CatalogIn(
                List.of(product("salmon", "Лосось кофейни", 2000.0)), List.of(),
                List.of(new CatalogImportService.DishIn("roll", "Ролл", "Роллы", null, 1, List.of(
                        new CatalogImportService.VariantIn("roll", "Ролл", null, 30_000, false,
                                List.of(new CatalogImportService.LineIn("salmon", 50, null)))))),
                List.of()), owner2);
        deliveries.receive(loc2, new DeliveryService.DeliveryIn("d1", "N-1", clock.now(), "Поставщик",
                List.of(new DeliveryService.LineIn("salmon", "Лосось", "G", 300, 72, null, 60_000L))), owner2, true);
        orders.create(loc2, new OrderService.OrderIn("o1", "POS", List.of(new OrderService.LineIn("roll", 1))), owner2);
        invites.create(cafe.tenantId(), "COOK", null, null, owner2);
        users.createApiKey(cafe.tenantId(), "Сайт кофейни", List.of("menu:read"), null);
        deliver("d1", "salmon", 1000, 72);                      // у ИСТОК — своя поставка с тем же ID
        long platformAdmin = jdbc.sql("SELECT id FROM users WHERE login = 'demo-platform'").query(Long.class).single();

        assertThatThrownBy(() -> platform.deleteTenant(cafe.tenantId(), platformAdmin, "кофейня", null))
                .as("подтверждение — точное название").hasMessageContaining("«Кофейня»");
        assertThatThrownBy(() -> platform.deleteTenant(TenantDirectory.DEMO, platformAdmin, "ИСТОК", null))
                .hasMessageContaining("Демо-предприятие");

        var d = platform.deleteTenant(cafe.tenantId(), platformAdmin, " Кофейня ", "Закрылись");
        assertThat(d.deletedVia()).isEqualTo("CONSOLE");
        assertThat(d.stats()).containsEntry("orders", 1).containsEntry("locations", 1);
        for (String table : List.of("tenants", "locations", "products", "movements", "batches", "orders", "deliveries",
                "audit_log", "memberships", "invitations", "api_keys")) {
            String col = table.equals("tenants") ? "id" : "tenant_id";
            assertThat(jdbc.sql("SELECT COUNT(*) FROM " + table + " WHERE " + col + " = ?").param(cafe.tenantId())
                    .query(Long.class).single()).as(table).isZero();
        }
        // Человек остался — с членством только в ИСТОК; демо-предприятие не задето, защита журнала вернулась
        assertThat(users.memberships(owner.userId())).extracting(UserService.MembershipDto::tenantId)
                .containsExactly(TenantDirectory.DEMO);
        assertThat(qtyLeft("salmon")).isEqualTo(1000);
        assertThat(ledger.verify(LOC).ok()).isTrue();
        assertThatThrownBy(() -> jdbc.sql("DELETE FROM movements WHERE location_id = ?").param(LOC).update())
                .hasMessageContaining("append-only");
        assertThat(platform.deletions()).singleElement().satisfies(x -> {
            assertThat(x.name()).isEqualTo("Кофейня");
            assertThat(x.reason()).isEqualTo("Закрылись");
            assertThat(x.deletedBy()).isEqualTo("Администратор платформы");
        });
        // ID точки освободился — новое предприятие может занять его
        assertThat(tenantService.create("Другая кофейня", "Центр", owner).locationId()).isEqualTo(loc2);
    }

    @Test
    void restaurantPanelLearnsTheStaffRoleAtItsLocation() {
        // Кассир ИСТОК, привязанный к точке; он же — повар в другой кофейне
        long cashierId = users.create(TenantDirectory.DEMO, "maria", "Мария", "CASHIER", LOC, "secret12", null);
        Actor owner = newAdmin("owner7");
        var cafe = tenantService.create("Кофейня", "Центр", owner);
        users.addMembership(cashierId, cafe.tenantId(), "COOK", null);
        assertThat(users.principal(cashierId, cafe.tenantId()).role()).isEqualTo("COOK");   // последнее — кофейня

        // Панель ресторана входит с точкой — роль из предприятия этой точки, а не из последнего
        var atIstok = users.login("maria", "secret12", LOC);
        assertThat(atIstok.tenantId()).isEqualTo(TenantDirectory.DEMO);
        assertThat(atIstok.role()).isEqualTo("CASHIER");
        assertThat(atIstok.locationId()).isEqualTo(LOC);
        assertThat(users.login("maria", "secret12", cafe.locationId()).role()).isEqualTo("COOK");

        // Другая точка ИСТОК — нет доступа; чужое предприятие — «не работаете»; неверный пароль — 401
        jdbc.sql("INSERT INTO locations (tenant_id, id, name, public_key) VALUES (1, 't2', 'Вторая', 'pk_t2')").update();
        tenants.invalidate();
        assertThatThrownBy(() -> users.login("maria", "secret12", "t2")).hasMessageContaining("Нет доступа к этой точке");
        long stranger = users.createAccount("stranger", "Чужой", "secret12");
        assertThatThrownBy(() -> users.login("stranger", "secret12", LOC)).hasMessageContaining("не работаете");
        assertThatThrownBy(() -> users.login("maria", "wrong-pass", LOC)).hasMessageContaining("Неверный логин или пароль");
        assertThat(stranger).isPositive();
    }

    @Test
    void adminRejectsADeliveryOnlyWhileItAwaitsApproval() {
        Actor admin = user("admin1", "ADMIN");
        for (String id : List.of("r1", "r2")) {
            deliveries.receive(LOC, new DeliveryService.DeliveryIn(id, "П-" + id, clock.now(), "ООО Ромашка", List.of(
                    new DeliveryService.LineIn("salmon", "Лосось", "G", 1000, 72, null, 180_000L))), storekeeper, false);
        }
        // На одобрении админ решает, как управляющий: одобрить или отклонить
        deliveries.reject(LOC, "r1", "Не заказывали", admin, true);
        assertThat(jdbc.sql("SELECT status FROM deliveries WHERE id = 'r1'").query(String.class).single()).isEqualTo("REJECTED");
        // Одобренную принимает или отклоняет у двери кладовщик — не админ
        deliveries.approve(LOC, "r2", List.of(), null, manager);
        assertThatThrownBy(() -> deliveries.reject(LOC, "r2", "Не нравится", admin, true)).hasMessageContaining("у двери");
        deliveries.reject(LOC, "r2", "Мятые коробки", storekeeper);
        assertThat(jdbc.sql("SELECT status FROM deliveries WHERE id = 'r2'").query(String.class).single()).isEqualTo("REJECTED");
    }

    @Test
    void profitIsRevenueMinusCostAndInThePlusSubtractsLosses() {
        deliver("d1", "salmon", 3000, 72);
        deliver("d2", "rice", 3000, 72);
        var a = (OrderService.Created) orders.create(LOC, new OrderService.OrderIn("p1", "POS", List.of(
                new OrderService.LineIn("roll", 2), new OrderService.LineIn("poke", 1))), cashier);
        var b = (OrderService.Created) orders.create(LOC, new OrderService.OrderIn("p2", "POS",
                List.of(new OrderService.LineIn("set", 1))), cashier);
        var canceled = (OrderService.Created) orders.create(LOC, new OrderService.OrderIn("p3", "POS",
                List.of(new OrderService.LineIn("roll", 1))), cashier);
        orders.cancel(LOC, canceled.id(), "Гость передумал", cashier);
        // Потеря: управляющий списал порчу — проходит сразу
        long batch = jdbc.sql("SELECT id FROM batches WHERE product_id = 'salmon' LIMIT 1").query(Long.class).single();
        writeoffs.create(LOC, batch, 200, "SPOILED", null, List.of(photos.placeholder()), manager);

        var p = profits.profit(LOC, query.period(LOC, 1, null, null));
        assertThat(p.orders()).as("отменённый заказ — не выручка").isEqualTo(2);
        assertThat(p.revenueKop()).isEqualTo(a.totalKop() + b.totalKop());
        assertThat(p.costKop()).isEqualTo(a.costKop() + b.costKop());
        assertThat(p.grossKop()).isEqualTo(p.revenueKop() - p.costKop());
        assertThat(p.lossesKop()).isEqualTo(200 * 1800 * 100 / 1000);   // 200 г лосося по 1800 ₽/кг = 360 ₽
        assertThat(p.netKop()).isEqualTo(p.grossKop() - p.lossesKop());
        assertThat(p.byDay()).hasSize(1).first().satisfies(d -> {
            assertThat(d.revenueKop()).isEqualTo(p.revenueKop());
            assertThat(d.netKop()).isEqualTo(p.netKop());
        });
        // По блюдам: себестоимость заказов разложена по блюдам без остатка — сумма сходится
        assertThat(p.byDish().stream().mapToLong(ru.sphere.stock.web.ProfitService.DishProfit::costKop).sum()).isEqualTo(p.costKop());
        assertThat(p.byDish().stream().mapToLong(ru.sphere.stock.web.ProfitService.DishProfit::revenueKop).sum()).isEqualTo(p.revenueKop());
        assertThat(p.byDish()).filteredOn(x -> "roll".equals(x.variantId())).singleElement()
                .satisfies(x -> assertThat(x.qty()).as("сет считается отдельным блюдом").isEqualTo(2));
    }

    @Test
    void kitchenTicketsAreFilteredByDayAndTime() throws Exception {
        deliver("d1", "salmon", 3000, 72);
        deliver("d2", "rice", 3000, 72);
        Instant morning = clock.now();
        var first = (OrderService.Created) orders.create(LOC, new OrderService.OrderIn("t1", "POS",
                List.of(new OrderService.LineIn("poke", 1))), cashier);
        clock.advance(Duration.ofHours(3));
        var second = (OrderService.Created) orders.create(LOC, new OrderService.OrderIn("t2", "POS",
                List.of(new OrderService.LineIn("poke", 1))), cashier);
        ticketOf(first.id());
        ticketOf(second.id());
        assertThat(kitchen.tickets(LOC, morning, morning.plus(Duration.ofHours(1)), 50))
                .extracting(KitchenPrintService.TicketDto::orderId).containsExactly(first.id());
        assertThat(kitchen.tickets(LOC, morning.plus(Duration.ofHours(2)), null, 50))
                .extracting(KitchenPrintService.TicketDto::orderId).containsExactly(second.id());
        assertThat(kitchen.tickets(LOC, null, null, 50)).hasSize(2);
        assertThatThrownBy(() -> kitchen.tickets(LOC, morning, morning, 50)).hasMessageContaining("раньше конца");
    }

    // ── Чек на кухню (ТЗ 16.15) ────────────────────────────────────────────

    /** Чек печатается в фоне после коммита — ждём, пока статус станет итоговым. */
    private KitchenPrintService.TicketDto ticketOf(long orderId) throws InterruptedException {
        for (int i = 0; i < 100; i++) {
            var t = kitchen.tickets(LOC, 50).stream().filter(x -> x.orderId() == orderId).findFirst();
            if (t.isPresent() && !t.get().status().equals("QUEUED")) {
                return t.get();
            }
            Thread.sleep(50);
        }
        throw new AssertionError("чек заказа " + orderId + " так и не напечатан");
    }

    /** «Принтер» в тесте — TCP-сервер на этом компьютере: принимает одно задание и отдаёт байты. */
    private static java.util.concurrent.CompletableFuture<byte[]> fakePrinter(java.net.ServerSocket server) {
        return java.util.concurrent.CompletableFuture.supplyAsync(() -> {
            try (var socket = server.accept()) {
                return socket.getInputStream().readAllBytes();
            } catch (java.io.IOException e) {
                throw new java.io.UncheckedIOException(e);
            }
        });
    }

    @Test
    void cashierRingsUpAndTheKitchenPrinterPrintsTheTicket() throws Exception {
        deliver("d1", "salmon", 2000, 72);
        deliver("d2", "rice", 2000, 72);
        try (var server = new java.net.ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress())) {
            var printed = fakePrinter(server);
            kitchen.savePrinter(LOC, new KitchenPrintService.PrinterIn("NETWORK", "127.0.0.1", server.getLocalPort(), 58, 1), manager);
            var o = (OrderService.Created) orders.create(LOC, new OrderService.OrderIn("k-1", "POS", List.of(
                    new OrderService.LineIn("roll", 2), new OrderService.LineIn("set", 1))), cashier);

            var t = ticketOf(o.id());
            assertThat(t.status()).isEqualTo("PRINTED");
            assertThat(t.printer()).isEqualTo("127.0.0.1:" + server.getLocalPort());
            assertThat(t.lines()).extracting(KitchenTicket.Line::name).containsExactly("Ролл", "Сет");
            assertThat(t.lines().get(1).items()).singleElement()
                    .satisfies(i -> assertThat(i.qty()).as("сет — с составом для повара").isEqualTo(2));
            // Принтер получил ESC/POS: сброс, CP866, номер заказа по-русски, отрезка ленты
            byte[] bytes = printed.get(5, java.util.concurrent.TimeUnit.SECONDS);
            String text = new String(bytes, EscPos.CP866);
            assertThat(bytes[0]).isEqualTo((byte) 0x1B);
            assertThat(bytes[1]).isEqualTo((byte) '@');
            assertThat(text).contains("КУХНЯ  №" + o.number(), "2 x Ролл", "1 x Сет", "- 2 x Ролл");
            assertThat(bytes[bytes.length - 4]).as("отрезать ленту").isEqualTo((byte) 0x1D);
        }
        // Повтор того же заказа (тот же externalId) второго чека не печатает
        orders.create(LOC, new OrderService.OrderIn("k-1", "POS", List.of(
                new OrderService.LineIn("roll", 2), new OrderService.LineIn("set", 1))), cashier);
        Thread.sleep(300);
        assertThat(kitchen.tickets(LOC, 50)).hasSize(1);
    }

    @Test
    void printerDownIsReportedAndTheCookPrintsAgain() throws Exception {
        deliver("d1", "salmon", 2000, 72);
        deliver("d2", "rice", 2000, 72);
        int dead;
        try (var probe = new java.net.ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress())) {
            dead = probe.getLocalPort();    // порт закрыт — «принтер выключен»
        }
        kitchen.savePrinter(LOC, new KitchenPrintService.PrinterIn("NETWORK", "127.0.0.1", dead, 80, 1), manager);
        var o = (OrderService.Created) orders.create(LOC, new OrderService.OrderIn("k-2", "POS",
                List.of(new OrderService.LineIn("roll", 1))), cashier);
        var t = ticketOf(o.id());
        assertThat(t.status()).isEqualTo("FAILED");
        assertThat(t.error()).contains("не ответил");
        assertThat(alerts.list(LOC, true, 50, "COOK")).extracting(AlertService.Alert::type).contains("PRINTER_FAILED");
        assertThat(alerts.list(LOC, true, 50, "CASHIER")).extracting(AlertService.Alert::type).doesNotContain("PRINTER_FAILED");

        // Принтер включили — «Ещё раз» с экрана кухни
        try (var server = new java.net.ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress())) {
            var printed = fakePrinter(server);
            kitchen.savePrinter(LOC, new KitchenPrintService.PrinterIn("NETWORK", "127.0.0.1", server.getLocalPort(), 80, 1), manager);
            assertThat(kitchen.print(t.id()).status()).isEqualTo("PRINTED");
            assertThat(new String(printed.get(5, java.util.concurrent.TimeUnit.SECONDS), EscPos.CP866)).contains("1 x Ролл");
        }
        var again = kitchen.ticket(t.id());
        assertThat(again.attempts()).isEqualTo(2);
        assertThat(again.error()).isNull();
    }

    @Test
    void withoutAPrinterTheTicketIsShownOnTheKitchenScreenAndPrintersStayInTheRestaurantNetwork() throws Exception {
        deliver("d1", "salmon", 2000, 72);
        deliver("d2", "rice", 2000, 72);
        assertThat(kitchen.printer(LOC).mode()).as("по умолчанию — экран кухни").isEqualTo("SCREEN");
        var o = (OrderService.Created) orders.create(LOC, new OrderService.OrderIn("k-3", "SITE",
                List.of(new OrderService.LineIn("poke", 1))), cashier);
        var t = ticketOf(o.id());
        assertThat(t.status()).isEqualTo("SHOWN");
        assertThat(t.printer()).isEqualTo("экран кухни");

        // Принтер — только в сети ресторана: чужой адрес в интернете — нет (защита от SSRF)
        assertThatThrownBy(() -> kitchen.savePrinter(LOC, new KitchenPrintService.PrinterIn("NETWORK", "8.8.8.8", 9100, 80, 1), manager))
                .hasMessageContaining("сети ресторана");
        assertThatThrownBy(() -> kitchen.savePrinter(LOC, new KitchenPrintService.PrinterIn("NETWORK", "http://printer", 9100, 80, 1), manager))
                .hasMessageContaining("без http");
        assertThatThrownBy(() -> kitchen.savePrinter(LOC, new KitchenPrintService.PrinterIn("NETWORK", null, 9100, 80, 1), manager))
                .hasMessageContaining("Укажите адрес");
        assertThat(kitchen.savePrinter(LOC, new KitchenPrintService.PrinterIn("NETWORK", "192.168.1.50", 9100, 80, 2), manager).copies())
                .isEqualTo(2);

        // Выключили печать — новых чеков нет
        kitchen.savePrinter(LOC, new KitchenPrintService.PrinterIn("OFF", null, null, null, null), manager);
        orders.create(LOC, new OrderService.OrderIn("k-4", "POS", List.of(new OrderService.LineIn("poke", 1))), cashier);
        Thread.sleep(300);
        assertThat(kitchen.tickets(LOC, 50)).hasSize(1);
    }

    @Test
    void escPosTicketFitsThePaperAndSpeaksRussian() {
        var t = new KitchenTicket(7, "Центр", "Касса", Instant.parse("2026-10-13T09:30:00Z").atZone(java.time.ZoneId.of("Europe/Moscow")),
                List.of(new KitchenTicket.Line("Пицца «Четыре сыра» на тонком тесте с двойным сыром", 1, null)));
        byte[] bytes = EscPos.ticket(t, 58);
        String text = new String(bytes, EscPos.CP866);
        assertThat(text).contains("КУХНЯ  №7", "Центр", "12:30", "\"Четыре сыра\"");
        // Длинное название переносится по словам: ни одна строка не шире ленты 58 мм (32 знака)
        for (String line : text.split("\n")) {
            String visible = line.replaceAll("[\\x00-\\x1F]", "").replaceAll("^[@t!aEdV]+", "");
            assertThat(visible.length()).as(line).isLessThanOrEqualTo(EscPos.width(58) + 3);
        }
    }
}
