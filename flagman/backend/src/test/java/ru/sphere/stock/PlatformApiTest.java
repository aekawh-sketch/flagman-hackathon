package ru.sphere.stock;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.test.context.ActiveProfiles;
import ru.sphere.stock.security.UserService;
import ru.sphere.stock.tenant.PlatformService;

/**
 * Заявки из внешней админки или CRM (ТЗ 16.9): по ключу платформы в заголовке, без входа.
 * Без ключа и входа — 401, с чужим ключом — 403; решение по ключу помечается как «из API».
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "stock.platform-api-key=crm-test-key")
@ActiveProfiles("test")
class PlatformApiTest {

    @Value("${local.server.port}")
    int port;

    @Autowired
    UserService users;

    @Autowired
    PlatformService platform;

    @Autowired
    ru.sphere.stock.tenant.InviteService invites;

    @Autowired
    ru.sphere.stock.delivery.DeliveryService deliveries;

    @Autowired
    ru.sphere.stock.tenant.TenantService tenantService;

    @Autowired
    StringRedisTemplate redis;

    private HttpResponse<String> call(String method, String path, String key) throws Exception {
        return call(method, path, key, "{\"comment\":\"Проверено в CRM\"}");
    }

    private HttpResponse<String> call(String method, String path, String key, String body) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
                .header("Content-Type", "application/json")
                .method(method, method.equals("GET") || method.equals("DELETE") ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofString(body));
        if (key != null) {
            b.header("X-Platform-Key", key);
        }
        return HttpClient.newHttpClient().send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    @Test
    void crmDecidesRequestsWithPlatformKey() throws Exception {
        assertThat(call("GET", "/api/platform/tenant-requests", null).statusCode()).isEqualTo(401);
        assertThat(call("GET", "/api/platform/tenant-requests", "wrong").statusCode()).isEqualTo(403);
        assertThat(call("GET", "/api/platform/settings", "crm-test-key").statusCode()).isEqualTo(200);

        platform.update(new PlatformService.Settings("APPROVAL", true));   // режим мог переключить другой тест
        String login = "crm-" + UUID.randomUUID().toString().substring(0, 8);
        long user = users.createAccount(login, "Заявитель", "secret1");
        long id = platform.createOrRequest(user, "Заявитель", false, "Бар из CRM", null, null).request().id();

        assertThat(call("GET", "/api/platform/tenant-requests?status=PENDING", "crm-test-key").body()).contains("Бар из CRM");
        var approved = call("POST", "/api/platform/tenant-requests/" + id + "/approve", "crm-test-key");
        assertThat(approved.statusCode()).isEqualTo(200);
        assertThat(approved.body()).contains("\"status\":\"APPROVED\"", "\"decidedVia\":\"API\"", "Проверено в CRM");
        assertThat(users.memberships(user)).singleElement().satisfies(m -> assertThat(m.role()).isEqualTo("ADMIN"));
    }

    @Test
    void crmCreatesAnEnterpriseForAClientAndInvitesItsOwner() throws Exception {
        String name = "Бистро " + UUID.randomUUID().toString().substring(0, 6);
        var created = call("POST", "/api/platform/tenants", "crm-test-key",
                "{\"name\":\"" + name + "\",\"locationName\":\"Зал\",\"joinAsAdmin\":true}");
        assertThat(created.statusCode()).isEqualTo(200);
        long tenantId = Long.parseLong(created.body().replaceAll(".*\"tenantId\":(\\d+).*", "$1"));
        String loc = created.body().replaceAll(".*\"locationId\":\"([^\"]+)\".*", "$1");
        assertThat(call("GET", "/api/platform/tenants/" + tenantId + "/locations", "crm-test-key").body()).contains("Зал");

        // Владельца приглашают ссылкой с ролью «Админ»; по ключу CRM у приглашения нет автора-пользователя
        var inv = call("POST", "/api/platform/tenants/" + tenantId + "/invites", "crm-test-key",
                "{\"role\":\"ADMIN\",\"locationId\":null,\"note\":\"Владелец\"}");
        assertThat(inv.statusCode()).isEqualTo(200);
        String token = inv.body().replaceAll(".*\"token\":\"([^\"]+)\".*", "$1");
        assertThat(invites.info(token).invitedBy()).isEqualTo("Платформа");
        assertThat(tenant(tenantId)).satisfies(t -> {
            assertThat(t.owner()).isNull();
            assertThat(t.ownerInvited()).isTrue();
        });
        String login = "owner-" + UUID.randomUUID().toString().substring(0, 8);
        long owner = invites.register(token, login, "Владелец", "secret12", null);
        assertThat(users.memberships(owner)).singleElement().satisfies(m -> {
            assertThat(m.tenantId()).isEqualTo(tenantId);
            assertThat(m.role()).isEqualTo("ADMIN");
        });
        // Владелец — тот, кто пришёл по ссылке, а не платформа, создавшая предприятие
        assertThat(tenant(tenantId)).satisfies(t -> {
            assertThat(t.owner()).isEqualTo("Владелец");
            assertThat(t.ownerInvited()).isFalse();
        });
        assertThat(call("GET", "/api/platform/tenants/" + tenantId + "/invites", "crm-test-key").body())
                .contains("\"status\":\"ACCEPTED\"", "Владелец");
        // Точка чужого предприятия в приглашении — ошибка; несуществующее предприятие — 404
        assertThat(call("POST", "/api/platform/tenants/" + tenantId + "/invites", "crm-test-key",
                "{\"role\":\"COOK\",\"locationId\":\"nowhere\"}").statusCode()).isEqualTo(400);
        assertThat(call("GET", "/api/platform/tenants/999999/invites", "crm-test-key").statusCode()).isEqualTo(404);
        assertThat(loc).isNotBlank();
    }

    @Test
    void platformAdminWhoJoinsANewEnterpriseIsNotItsOwner() {
        long admin = users.createAccount("pa-" + UUID.randomUUID().toString().substring(0, 8), "Админ платформы", "secret1");
        var created = platform.createTenant("Столовая " + UUID.randomUUID().toString().substring(0, 6), null, admin, true);
        assertThat(users.memberships(admin)).singleElement().satisfies(m -> assertThat(m.role()).isEqualTo("ADMIN"));
        assertThat(tenant(created.tenantId()).owner()).isNull();

        // Владельцем становится первый админ по ссылке; повар по ссылке владельцем не становится
        long cook = users.createAccount("ck-" + UUID.randomUUID().toString().substring(0, 8), "Повар", "secret1");
        invites.accept(platform.invite(created.tenantId(), "COOK", null, null, admin).token(), cook);
        assertThat(tenant(created.tenantId()).owner()).isNull();
        long client = users.createAccount("cl-" + UUID.randomUUID().toString().substring(0, 8), "Клиент", "secret1");
        invites.accept(platform.invite(created.tenantId(), "ADMIN", null, null, admin).token(), client);
        assertThat(tenant(created.tenantId()).owner()).isEqualTo("Клиент");
        // Второй админ по ссылке владельца не меняет
        long second = users.createAccount("cl2-" + UUID.randomUUID().toString().substring(0, 8), "Второй", "secret1");
        invites.accept(platform.invite(created.tenantId(), "ADMIN", null, null, admin).token(), second);
        assertThat(tenant(created.tenantId()).owner()).isEqualTo("Клиент");
    }

    @Test
    void restaurantPanelAsksWhereThePersonWorks() throws Exception {
        String suffix = UUID.randomUUID().toString().substring(0, 6);
        String login = "wp-" + suffix;
        long person = users.createAccount(login, "Мария", "secret1");
        var cafe = platform.createTenant("Кафе " + suffix, "Центр", person, true);
        var bar = platform.createTenant("Бар " + suffix, "Зал", null, false);
        invites.accept(platform.invite(bar.tenantId(), "CASHIER", bar.locationId(), null, null).token(), person);

        HttpClient http = HttpClient.newHttpClient();
        assertThat(http.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/auth/workplaces")).build(),
                HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(401);
        var login1 = http.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/auth/login"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString("{\"login\":\"" + login + "\",\"password\":\"secret1\"}"))
                .build(), HttpResponse.BodyHandlers.ofString());
        assertThat(login1.statusCode()).isEqualTo(200);
        String cookie = login1.headers().allValues("set-cookie").stream().map(c -> c.split(";")[0])
                .reduce((x, y) -> x + "; " + y).orElseThrow();
        String body = http.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/auth/workplaces"))
                .header("Cookie", cookie).build(), HttpResponse.BodyHandlers.ofString()).body();
        // Админ кафе — во всех его точках; кассир бара — только в своей точке
        assertThat(body).contains("\"tenantId\":" + cafe.tenantId(), "\"role\":\"ADMIN\"", "\"id\":\"" + cafe.locationId() + "\"",
                "\"tenantId\":" + bar.tenantId(), "\"role\":\"CASHIER\"", "\"id\":\"" + bar.locationId() + "\"");
    }

    private HttpResponse<String> api(String method, String path, String key, String body) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
                .header("Content-Type", "application/json").header("X-Api-Key", key)
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
        return HttpClient.newHttpClient().send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    @Test
    void platformSupplierSeesNewEnterprisesSendsThereAndSeesOnlyItsOwnDeliveries() throws Exception {
        String suffix = UUID.randomUUID().toString().substring(0, 6);
        String key = "sk_supplier_" + suffix + "_test";
        users.ensurePlatformApiKey("Поставщик " + suffix, key);
        users.ensurePlatformApiKey("Поставщик " + suffix, key);    // повтор ничего не дублирует
        var bakery = platform.createTenantWithLocations("Пекарня " + suffix, List.of("Центр", "Вокзал"), null, false);
        var cafe = platform.createTenant("Кафе " + suffix, "Зал", null, false);
        String loc = bakery.locationId();

        // Новое предприятие сразу в списке — с обеими точками
        var list = api("GET", "/api/supplier/restaurants", key, null);
        assertThat(list.statusCode()).isEqualTo(200);
        assertThat(list.body()).contains("Пекарня " + suffix, "Вокзал", "Кафе " + suffix);
        // Каталог нового предприятия пуст — поставщик присылает новый продукт, ресторан проверит карточку
        assertThat(api("GET", "/api/" + loc + "/supply-catalog", key, null).body()).isEqualTo("[]");
        var sent = api("POST", "/api/" + loc + "/deliveries", key, """
                {"id":"FP-%s","number":"ФП-1","createdAt":"2026-10-01T10:00:00Z","supplier":"ООО Тест",
                 "lines":[{"productId":"fp-muka","name":"Мука","unit":"G","qty":5000,"shelfLifeHours":720,"costKop":30000}]}"""
                .formatted(suffix));
        assertThat(sent.statusCode()).as(sent.body()).isEqualTo(201);
        assertThat(api("GET", "/api/" + loc + "/supply-catalog", key, null).body()).contains("fp-muka", "Мука");

        // Поставку, оформленную сотрудником ресторана, поставщик не видит — только свои
        long storekeeper = users.createAccount("sk-" + suffix, "Кладовщик", "secret1");
        deliveries.receive(loc, new ru.sphere.stock.delivery.DeliveryService.DeliveryIn("STAFF-" + suffix, "Н-1",
                java.time.Instant.parse("2026-10-01T09:00:00Z"), "Другой поставщик", List.of(
                        new ru.sphere.stock.delivery.DeliveryService.LineIn("fp-muka", "Мука", "G", 1000, 720, null, 9000L))),
                ru.sphere.stock.ledger.Actor.user(storekeeper, "STOREKEEPER", "Кладовщик"), false, "FORM");
        String mine = api("GET", "/api/" + loc + "/deliveries", key, null).body();
        assertThat(mine).contains("FP-" + suffix).doesNotContain("STAFF-" + suffix, "Другой поставщик");

        // Ключ одного предприятия — только его точки
        String own = users.createApiKey(bakery.tenantId(), "Свой поставщик", List.of("deliveries:create"), null).key();
        assertThat(api("GET", "/api/supplier/restaurants", own, null).body())
                .contains("Пекарня " + suffix).doesNotContain("Кафе " + suffix);
        assertThat(api("GET", "/api/" + cafe.locationId() + "/supply-catalog", own, null).statusCode()).isEqualTo(403);
    }

    @Test
    void enterpriseIsCreatedWithSeveralLocationsAllOrNone() {
        String suffix = UUID.randomUUID().toString().substring(0, 6);
        var t = platform.createTenantWithLocations("Сеть " + suffix, List.of("Центр", " Вокзал ", "", "Набережная"), null, false);
        assertThat(tenantService.locations(t.tenantId())).extracting(ru.sphere.stock.tenant.TenantService.LocationDto::name)
                .containsExactlyInAnyOrder("Центр", "Вокзал", "Набережная");
        // Повтор названия — предприятие не создаётся вовсе
        long before = platform.tenants().size();
        org.assertj.core.api.Assertions.assertThatThrownBy(() ->
                platform.createTenantWithLocations("Дубль " + suffix, List.of("Центр", "центр"), null, false))
                .hasMessageContaining("уже есть");
        assertThat(platform.tenants()).hasSize((int) before);

        // Админ добавляет несколько точек разом: одна пустая — не создаётся ни одной
        var actor = ru.sphere.stock.ledger.Actor.user(users.createAccount("ad-" + suffix, "Админ", "secret1"), "ADMIN", "Админ");
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> tenantService.createLocations(t.tenantId(), List.of(
                        new ru.sphere.stock.tenant.TenantService.NewLocation("Аэропорт", null, null),
                        new ru.sphere.stock.tenant.TenantService.NewLocation(" ", null, null)), actor))
                .hasMessageContaining("Точка 2");
        assertThat(tenantService.locations(t.tenantId())).hasSize(3);
        assertThat(tenantService.createLocations(t.tenantId(), List.of(
                new ru.sphere.stock.tenant.TenantService.NewLocation("Аэропорт", java.time.LocalTime.of(6, 0), java.time.LocalTime.of(23, 0)),
                new ru.sphere.stock.tenant.TenantService.NewLocation("Порт", null, null)), actor)).hasSize(2);
        assertThat(tenantService.locations(t.tenantId())).hasSize(5);
    }

    private PlatformService.TenantDto tenant(long id) {
        return platform.tenants().stream().filter(t -> t.id() == id).findFirst().orElseThrow();
    }

    /** Сессия сотрудника — в Redis (Spring Session): её найдёт любой сервер склада, перезапуск её не стирает. */
    @Test
    void staffSessionIsKeptInRedis() throws Exception {
        String login = "s-" + UUID.randomUUID().toString().substring(0, 8);
        users.createAccount(login, "Сотрудник", "secret1");
        HttpResponse<String> res = HttpClient.newHttpClient().send(HttpRequest.newBuilder(
                        URI.create("http://localhost:" + port + "/api/auth/login"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString("{\"login\":\"" + login + "\",\"password\":\"secret1\"}"))
                .build(), HttpResponse.BodyHandlers.ofString());
        assertThat(res.statusCode()).isEqualTo(200);
        String cookie = res.headers().allValues("set-cookie").stream().filter(c -> c.startsWith("SESSION="))
                .reduce((a, b) -> b).orElseThrow();
        assertThat(cookie).contains("HttpOnly", "SameSite=Strict");
        String value = cookie.substring("SESSION=".length(), cookie.indexOf(';'));
        String id = new String(Base64.getDecoder().decode(value), StandardCharsets.UTF_8);
        assertThat(redis.keys("flagman-test-*:session:sessions:" + id)).as("сессия в Redis, в ключах склада").hasSize(1);

        // Новый клиент, только с cookie: сервер нашёл сессию в Redis — это тот же сотрудник
        HttpResponse<String> me = HttpClient.newHttpClient().send(HttpRequest.newBuilder(
                        URI.create("http://localhost:" + port + "/api/auth/me")).header("Cookie", "SESSION=" + value).build(),
                HttpResponse.BodyHandlers.ofString());
        assertThat(me.statusCode()).isEqualTo(200);
        assertThat(me.body()).contains(login);
    }
}
