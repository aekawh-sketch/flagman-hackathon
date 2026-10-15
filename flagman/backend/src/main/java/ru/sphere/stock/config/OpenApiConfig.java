package ru.sphere.stock.config;

import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.security.SecurityRequirement;
import io.swagger.v3.oas.models.security.SecurityScheme;
import io.swagger.v3.oas.models.servers.Server;
import io.swagger.v3.oas.models.tags.Tag;
import java.util.List;
import java.util.Map;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Документация API на русском (п. 35): жюри и интеграторы видят формат запросов без вопросов к разработчикам. */
@Configuration
public class OpenApiConfig {

    public static final String SESSION = "Session";
    public static final String API_KEY = "ApiKey";

    public static final String T_AUTH = "Вход";
    public static final String T_DELIVERIES = "Поставки и приёмка";
    public static final String T_ORDERS = "Заказы";
    public static final String T_KITCHEN = "Чек на кухню";
    public static final String T_STOCK = "Склад и партии";
    public static final String T_PRODUCTION = "Заготовки";
    public static final String T_MENU = "Меню, стоп-лист, горячие предложения";
    public static final String T_PURCHASES = "Закупки";
    public static final String T_WRITEOFFS = "Списания";
    public static final String T_INVENTORY = "Инвентаризация";
    public static final String T_SECURITY = "Антифрод и журнал";
    public static final String T_ANALYTICS = "Аналитика и дашборд";
    public static final String T_TRACE = "Прослеживаемость";
    public static final String T_PLATFORM = "Платформа";
    public static final String T_ALERTS = "Сигналы и реальное время";
    public static final String T_CATALOG = "Каталог и техкарты";
    public static final String T_ADMIN = "Администрирование";
    public static final String T_DEMO = "Демо";
    public static final String T_PUBLIC = "Виджет для сайта";

    private static final String DESCRIPTION = """
            Учёт поставок по партиям, сроки годности и FEFO, автоматический стоп-лист, горячие предложения
            и защита от умышленных списаний.

            **Как войти**
            * Из браузера — войдите в интерфейсе (демо-вход под любой ролью): эта страница работает от вашего имени.
            * Внешняя система (сайт, касса, генератор) — заголовок `X-Api-Key` с ключом из «Админка → API-ключи».

            **Договорённости**
            * Количества — целые числа в граммах, миллилитрах или штуках; деньги — в копейках.
            * Время — серверное, в формате ISO 8601 (UTC).
            * `{loc}` в пути — точка: `kush` («Истокград») или `kan` («Ясноречье»).
            * Поставки и заказы **идемпотентны**: повтор с тем же ID не задваивает склад.

            **Ответы**
            * `201` — создано, `200` — повтор уже созданного или успешный запрос.
            * `409` при заказе — отказ: заказ не создан, в `details` объяснение — чего не хватает, «максимум N» и похожие блюда.
            * Ошибки всегда в виде `{"error": "текст", "details": …}`.
            """;

    @Bean
    OpenAPI stockOpenApi() {
        return new OpenAPI()
                .info(new Info().title("Склад ресторана — API").version("1.0").description(DESCRIPTION))
                .servers(List.of(new Server().url("/").description("Этот сервер")))
                .components(new Components()
                        .addSecuritySchemes(API_KEY, new SecurityScheme().type(SecurityScheme.Type.APIKEY)
                                .in(SecurityScheme.In.HEADER).name("X-Api-Key")
                                .description("Ключ внешней системы с узкими правами (например, orders:create)"))
                        .addSecuritySchemes(SESSION, new SecurityScheme().type(SecurityScheme.Type.APIKEY)
                                .in(SecurityScheme.In.COOKIE).name("JSESSIONID")
                                .description("Сессия сотрудника после входа в интерфейсе")))
                .addSecurityItem(new SecurityRequirement().addList(SESSION))
                .addSecurityItem(new SecurityRequirement().addList(API_KEY))
                .tags(List.of(
                        tag(T_AUTH, "Пароль, личный PIN для списаний, демо-вход под ролью"),
                        tag(T_DELIVERIES, "Поставка приходит документом; партии появляются только после приёмки (ТЗ 5.1)"),
                        tag(T_ORDERS, "Заказ «всё или ничего»: проверка, списание по FEFO, отказ с объяснением, отмена (ТЗ 5.5–5.6)"),
                        tag(T_KITCHEN, "Кассир пробил заказ — на кухне печатается чек: экран кухни или термопринтер ESC/POS по сети (ТЗ 16.15)"),
                        tag(T_STOCK, "Остатки, партии, прослеживаемость, вскрытие упаковок, отзыв партии (ТЗ 5.2–5.3, 5.16)"),
                        tag(T_PRODUCTION, "Полуфабрикаты: сырьё по FEFO → новая партия со своим сроком (ТЗ 5.4)"),
                        tag(T_MENU, "Доступные порции, стоп-лист и его прогноз, горячие предложения (ТЗ 5.7, 5.10, 5.12)"),
                        tag(T_PURCHASES, "Что заказать и чего не заказывать (ТЗ 5.9)"),
                        tag(T_WRITEOFFS, "Ручное списание — только заявкой с фото; подпись управляющего (ТЗ 6.5)"),
                        tag(T_INVENTORY, "Пересчёт по факту против журнала на момент T (ТЗ 6.10)"),
                        tag(T_SECURITY, "Журнал только на добавление, хэш-цепочка, подозрительные операции (ТЗ 6.3–6.11)"),
                        tag(T_ANALYTICS, "Потери, дефицит, показатели дня (ТЗ 5.12, 5.15)"),
                        tag(T_PLATFORM, "Над всеми предприятиями: заявки на создание предприятия, режимы — администратор платформы или внешняя админка / CRM по ключу X-Platform-Key (ТЗ 16.9)"),
                        tag(T_TRACE, "Из каких партий сделаны заготовки, какие продукты ушли в каждое блюдо и заказ (ТЗ 16.6)"),
                        tag(T_ALERTS, "Сигналы о сроках, стопе, заявках, аномалиях; поток событий SSE (ТЗ 5.8, 5.13)"),
                        tag(T_CATALOG, "Продукты, блюда, варианты, техкарты с версиями, импорт каталога (ТЗ 5.4, 6.9, п. 48)"),
                        tag(T_ADMIN, "Сотрудники, API-ключи, настройки и пороги, аудит"),
                        tag(T_DEMO, "Часы с ускорением, генератор событий, сценарии, сброс (только в демо-режиме)"),
                        tag(T_PUBLIC, "Только чтение по публичному ключу точки — для сайта ресторана (п. 49)")));
    }

    /** Подписи параметров одинаковы во всех командах — задаём их в одном месте. */
    private static final Map<String, String> PARAMS = Map.ofEntries(
            Map.entry("loc", "Точка: kush — «Истокград», kan — «Ясноречье»"),
            Map.entry("id", "Идентификатор"),
            Map.entry("product", "ID продукта, например salmon"),
            Map.entry("includeEmpty", "Показывать и пустые партии"),
            Map.entry("status", "Фильтр по статусу"),
            Map.entry("limit", "Сколько записей вернуть"),
            Map.entry("hours", "Горизонт прогноза, часов"),
            Map.entry("days", "Период, дней"),
            Map.entry("type", "Тип движения, например ORDER или WRITEOFF_SPOILED"),
            Map.entry("beforeSeq", "Записи раньше этого номера — для листания"),
            Map.entry("open", "Только неотмеченные"),
            Map.entry("location", "Точка"),
            Map.entry("batchId", "ID партии"),
            Map.entry("qty", "Количество: граммы, миллилитры или штуки"),
            Map.entry("reason", "Причина: SPOILED — порча, DAMAGED — бой, OTHER — прочее"),
            Map.entry("comment", "Комментарий (для «прочее» обязателен)"),
            Map.entry("date", "День в формате ГГГГ-ММ-ДД по времени точки"),
            Map.entry("variantId", "ID напитка или блюда из меню, например dr15-1"),
            Map.entry("portions", "Сколько порций списать"),
            Map.entry("productId", "ID продукта со склада, например milk"));

    /** Вызывается из {@link OpenApiI18n} до перевода — иначе русские подписи легли бы поверх английских. */
    static void describeParameters(OpenAPI api) {
        if (api.getPaths() == null) {
            return;
        }
        api.getPaths().forEach((url, path) -> path.readOperations().forEach(op -> {
            if (op.getParameters() == null) {
                return;
            }
            op.getParameters().forEach(p -> {
                if ("key".equals(p.getName())) {
                    p.setDescription(url.startsWith("/public") ? "Публичный ключ точки (для виджета)" : "Ключ настройки");
                } else if (PARAMS.containsKey(p.getName())) {
                    p.setDescription(PARAMS.get(p.getName()));
                }
                if ("loc".equals(p.getName())) {
                    p.setExample("kush");
                }
            });
        }));
    }

    private static Tag tag(String name, String description) {
        return new Tag().name(name).description(description);
    }
}
