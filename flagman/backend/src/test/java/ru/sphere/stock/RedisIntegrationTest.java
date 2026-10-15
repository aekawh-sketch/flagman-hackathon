package ru.sphere.stock;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import ru.sphere.stock.catalog.CatalogImportService;
import ru.sphere.stock.catalog.CatalogService;
import ru.sphere.stock.delivery.DeliveryService;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.infra.AppClock;
import ru.sphere.stock.ledger.Actor;
import ru.sphere.stock.menu.ForecastService;
import ru.sphere.stock.menu.MenuService;
import ru.sphere.stock.order.OrderService;
import ru.sphere.stock.redis.RedisSharedStore;
import ru.sphere.stock.security.UserService;
import ru.sphere.stock.tenant.TenantDirectory;

/**
 * Redis на настоящем сервере Redis (как PostgreSQL в остальных тестах): кеш меню и его сброс, блокировка
 * перебора паролей, события между серверами через Pub/Sub. У каждого прогона свой префикс ключей.
 */
@SpringBootTest
@ActiveProfiles("test")
class RedisIntegrationTest {

    static final String LOC = "t1";

    @Autowired Flyway flyway;
    @Autowired JdbcClient jdbc;
    @Autowired AppClock clock;
    @Autowired TenantDirectory tenants;
    @Autowired CatalogService catalog;
    @Autowired ForecastService forecast;
    @Autowired CatalogImportService importer;
    @Autowired DeliveryService deliveries;
    @Autowired OrderService orders;
    @Autowired MenuService menu;
    @Autowired UserService users;
    @Autowired RedisSharedStore store;
    @Autowired StringRedisTemplate redis;

    Actor manager;
    Actor storekeeper;
    Actor cashier;

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
        redis.delete(redis.keys(store.prefix() + "auth:*"));      // счётчики входа других тестов этого прогона
        jdbc.sql("INSERT INTO locations (tenant_id, id, name, public_key) VALUES (1, ?, 'Тест', 'pk_test')").param(LOC).update();
        manager = user("manager", "MANAGER");
        storekeeper = user("store", "STOREKEEPER");
        cashier = user("cashier", "CASHIER");
        importer.importCatalog(TenantDirectory.DEMO, new CatalogImportService.CatalogIn(
                List.of(new CatalogImportService.ProductIn("salmon", "Лосось", "G", "RAW", null, 1800.0, 72, null, null, 0.0,
                        null, null, null)),
                List.of(),
                List.of(new CatalogImportService.DishIn("roll", "Ролл", "Роллы", null, 1, List.of(
                        new CatalogImportService.VariantIn("roll", "Ролл", null, 30_000, false,
                                List.of(new CatalogImportService.LineIn("salmon", 100, null)))))),
                List.of()), manager);
    }

    private Actor user(String login, String role) {
        long id = users.create(TenantDirectory.DEMO, login, login, role, null, "password1", null);
        return Actor.user(id, role, login);
    }

    private long rolls() {
        return menu.menu(LOC).stream().filter(v -> v.variantId().equals("roll")).findFirst().orElseThrow().portions();
    }

    @Test
    void menuIsServedFromRedisUntilStockChangesOrABatchExpires() throws Exception {
        deliveries.receive(LOC, new DeliveryService.DeliveryIn("d1", "N-1", clock.now(), "Поставщик",
                List.of(new DeliveryService.LineIn("salmon", "Лосось", "G", 1000, 10, null, 180_000L))), storekeeper, true);
        Thread.sleep(600);                                  // стоп-лист пересчитывается через 300 мс после изменения
        assertThat(rolls()).isEqualTo(10);
        assertThat(redis.keys(store.prefix() + "menu:" + LOC + ":*")).as("меню легло в Redis").isNotEmpty();

        // В обход приложения: событий нет — меню по-прежнему из кеша
        jdbc.sql("UPDATE batches SET qty_left = 500 WHERE location_id = ? AND product_id = 'salmon'").param(LOC).update();
        assertThat(rolls()).as("из кеша, база не читалась").isEqualTo(10);

        // Заказ через приложение: версия склада точки +1 — меню пересчитано по базе
        orders.create(LOC, new OrderService.OrderIn("o1", "POS", List.of(new OrderService.LineIn("roll", 2))), cashier);
        assertThat(rolls()).isEqualTo(3);                  // 500 − 200 = 300 г → 3 ролла

        // Срок партии истёк — никто ничего не менял, но кеш годен только до ближайшего срока
        clock.advance(Duration.ofHours(11));
        assertThat(rolls()).isZero();
    }

    @Test
    void changeOnAnotherServerIsSeenThroughTheStockVersionInRedis() throws Exception {
        deliveries.receive(LOC, new DeliveryService.DeliveryIn("d1", "N-1", clock.now(), "Поставщик",
                List.of(new DeliveryService.LineIn("salmon", "Лосось", "G", 1000, 10, null, 180_000L))), storekeeper, true);
        Thread.sleep(600);
        assertThat(rolls()).isEqualTo(10);                  // теперь меню и в Redis, и в памяти этого сервера

        // Другой сервер провёл изменение склада и увеличил версию точки в Redis
        jdbc.sql("UPDATE batches SET qty_left = 500 WHERE location_id = ? AND product_id = 'salmon'").param(LOC).update();
        redis.opsForValue().increment(store.prefix() + "ver:" + LOC);
        assertThat(rolls()).as("память этого сервера со старой версией не используется").isEqualTo(5);
    }

    @Test
    void fiveWrongPasswordsLockTheLoginInRedis() {
        for (int i = 0; i < 5; i++) {
            assertThatThrownBy(() -> users.login("manager", "wrong", null)).hasMessageContaining("Неверный логин");
        }
        assertThatThrownBy(() -> users.login("manager", "password1", null))
                .isInstanceOfSatisfying(ApiException.class, e -> assertThat(e.getMessage()).contains("Подождите 5 мин"));
        Long ttl = redis.getExpire(store.prefix() + "auth:lock:pwd:manager", TimeUnit.SECONDS);
        assertThat(ttl).as("блокировка снимется сама — срок жизни ключа").isBetween(1L, 300L);

        redis.delete(store.prefix() + "auth:lock:pwd:manager");      // как будто 5 минут прошли
        assertThat(users.login("manager", "password1", null).login()).isEqualTo("manager");
    }

    @Test
    void eventsReachEveryServerThroughRedisPubSub() throws Exception {
        BlockingQueue<String> received = new LinkedBlockingQueue<>();
        store.subscribe("test-events", received::add);
        Thread.sleep(200);                                  // подписка в Redis оформляется асинхронно

        // Сообщение «с другого сервера» — прямо в канал Redis, минуя этот склад
        redis.convertAndSend(store.prefix() + "test-events", "{\"from\":\"server-2\"}");
        assertThat(received.poll(5, TimeUnit.SECONDS)).isEqualTo("{\"from\":\"server-2\"}");

        store.publish("test-events", Map.of("from", "server-1"));
        assertThat(received.poll(5, TimeUnit.SECONDS)).isEqualTo("{\"from\":\"server-1\"}");
    }
}
