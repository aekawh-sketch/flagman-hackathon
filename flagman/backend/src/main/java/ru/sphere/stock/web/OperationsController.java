package ru.sphere.stock.web;

import io.swagger.v3.oas.annotations.media.Schema;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.http.HttpHeaders;
import io.swagger.v3.oas.annotations.media.ExampleObject;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.Parameter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import io.swagger.v3.oas.annotations.Operation;
import ru.sphere.stock.config.OpenApiConfig;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaTypeFactory;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import ru.sphere.stock.delivery.DeliveryService;
import ru.sphere.stock.delivery.DeliveryXml;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.ledger.Actor;
import ru.sphere.stock.infra.Json;
import org.springframework.web.multipart.MultipartFile;
import ru.sphere.stock.order.OrderService;
import ru.sphere.stock.security.Access;
import ru.sphere.stock.security.StockPrincipal;

/** Поставки (ТЗ 5.1) и заказы (ТЗ 5.5, 5.6). */
@RestController
@RequestMapping("/api/{loc}")
public class OperationsController {

    @Schema(description = "Приёмка поставки")
    public record AcceptIn(
            @Schema(description = "Факт по строкам; пусто — всё как в накладной") List<DeliveryService.AcceptLine> lines,
            @Schema(description = "Подтверждаю приёмку продукта, который скоро истекает") boolean confirmShortLife) {
    }

    @Schema(description = "Одобрение поставки управляющим")
    public record ApproveIn(
            @Schema(description = "Решение по строкам; пусто — одобрить всё как в накладной") List<DeliveryService.ApproveLine> lines,
            @Schema(description = "Комментарий для кладовщика", example = "Муку берём, молоко — только 8 л") String comment) {
    }

    @Schema(description = "Отказ от поставки")
    public record RejectIn(@Schema(description = "Почему поставка не принята", example = "Привезли не то") String comment) {
    }

    @Schema(description = "Новый статус заказа")
    public record StatusIn(
            @Schema(description = "ACCEPTED, COOKING, READY, DELIVERING или DONE", example = "COOKING") String status) {
    }

    @Schema(description = "Отмена заказа")
    public record CancelIn(
            @Schema(description = "Причина; обязательна, если заказ уже готовится", example = "Гость ушёл") String reason) {
    }

    private final DeliveryService deliveries;
    private final OrderService orders;
    private final QueryService query;
    private final UploadService uploads;
    private final Json json;
    private final ru.sphere.stock.catalog.CatalogService catalog;
    private final ru.sphere.stock.infra.AppClock clock;

    public OperationsController(DeliveryService deliveries, OrderService orders, QueryService query,
                                UploadService uploads, Json json, ru.sphere.stock.catalog.CatalogService catalog,
                                ru.sphere.stock.infra.AppClock clock) {
        this.json = json;
        this.catalog = catalog;
        this.clock = clock;
        this.deliveries = deliveries;
        this.orders = orders;
        this.query = query;
        this.uploads = uploads;
    }

    // ── Поставки ───────────────────────────────────────────────────────────

    private static final String EXAMPLE_JSON = """
            {
              "id": "SUP-2026-0042",
              "number": "П-42",
              "createdAt": "2026-10-11T08:00:00Z",
              "supplier": "ООО «Ромашка»",
              "lines": [
                {"productId": "milk", "name": "Молоко", "unit": "ML", "qty": 10000, "shelfLifeHours": 168, "costKop": 90000},
                {"productId": "flour", "name": "Мука", "unit": "G", "qty": 25000, "shelfLifeHours": 4320, "costKop": 75000}
              ]
            }""";

    private static final String EXAMPLE_XML = """
            <delivery id="SUP-2026-0043" number="П-43" createdAt="2026-10-11T08:00:00Z" supplier="ООО Ромашка">
              <line productId="milk" name="Молоко" unit="ML" qty="10000" shelfLifeHours="168" costKop="90000"/>
              <line productId="flour" name="Мука" unit="G" qty="25000" shelfLifeHours="4320" costKop="75000"/>
            </delivery>""";

    /**
     * Получение новой поставки (ТЗ 5.1, 16.3) — один адрес для JSON и XML: формат по Content-Type.
     * API-ключ с правом {@code deliveries:auto-accept} — сразу приёмка (демо-генератор).
     */
    @Operation(summary = "Получить новую поставку",
            description = "JSON или XML — формат по Content-Type. Идемпотентно по id: 201 — создана и ждёт приёмки, "
                    + "200 — повтор той же (поменяйте id, чтобы создать новую), 409 — тот же id с другим содержимым. "
                    + "Ключ с правом deliveries:auto-accept принимает поставку сразу.",
            tags = OpenApiConfig.T_DELIVERIES,
            requestBody = @io.swagger.v3.oas.annotations.parameters.RequestBody(required = true, content = {
                    @Content(mediaType = MediaType.APPLICATION_JSON_VALUE,
                            schema = @Schema(implementation = DeliveryService.DeliveryIn.class),
                            examples = @ExampleObject(name = "SUP-2026-0042", value = EXAMPLE_JSON)),
                    @Content(mediaType = MediaType.APPLICATION_XML_VALUE, schema = @Schema(type = "string"),
                            examples = @ExampleObject(name = "SUP-2026-0043", value = EXAMPLE_XML))}))
    @PostMapping(value = "/deliveries",
            consumes = {MediaType.APPLICATION_JSON_VALUE, MediaType.APPLICATION_XML_VALUE, MediaType.TEXT_XML_VALUE})
    public ResponseEntity<DeliveryService.Result> receive(@PathVariable String loc, @RequestBody String body,
                                                          @Parameter(hidden = true) @RequestHeader(HttpHeaders.CONTENT_TYPE) String contentType,
                                                          @Parameter(hidden = true) @RequestParam(defaultValue = "API") String channel) {
        StockPrincipal p = Access.require(loc, "deliveries:create", "STOREKEEPER", "MANAGER", "ADMIN");
        DeliveryService.DeliveryIn in = contentType.contains("xml") ? DeliveryXml.parse(body) : parseJson(body);
        return created(deliveries.receive(loc, in, p.actor(), p.hasScope("deliveries:auto-accept"),
                "FORM".equals(channel) ? "FORM" : "API"));
    }

    /** Загрузка файла накладной из интерфейса: формат — по расширению или первому символу. */
    @Operation(summary = "Загрузить файл поставки (Excel, XML или JSON)", description = "Excel (.xlsx) — как в примере: номер, поставщик и дата сверху, ниже строки «ID продукта, название, единица (кг, л, шт), количество, срок хранения или «годен до», сумма в рублях».", tags = OpenApiConfig.T_DELIVERIES)
    @PostMapping(value = "/deliveries/upload", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<DeliveryService.Result> upload(@PathVariable String loc,
                                                         @RequestParam("file") MultipartFile file) throws IOException {
        StockPrincipal p = Access.requireRole(loc, "STOREKEEPER", "MANAGER", "ADMIN");
        if (file.isEmpty() || file.getSize() > 10_000_000) {
            throw ApiException.badRequest("Файл пустой или больше 10 МБ");
        }
        byte[] bytes = file.getBytes();
        String name = file.getOriginalFilename() == null ? "" : file.getOriginalFilename().toLowerCase();
        if (name.endsWith(".xlsx") || ru.sphere.stock.infra.Xlsx.looksLike(bytes)) {
            return created(deliveries.receive(loc, ru.sphere.stock.delivery.DeliveryXlsx.parse(bytes), p.actor(), false, "FILE"));
        }
        String text = new String(bytes, StandardCharsets.UTF_8).strip();
        if (text.startsWith("\uFEFF")) {
            text = text.substring(1);
        }
        DeliveryService.DeliveryIn in = name.endsWith(".xml") || text.startsWith("<") ? DeliveryXml.parse(text)
                : parseJson(text);
        return created(deliveries.receive(loc, in, p.actor(), false, "FILE"));
    }

    @Operation(summary = "Пример поставки в Excel", description = "Файл .xlsx из продуктов вашего каталога: заполните и загрузите через «Загрузить файл».", tags = OpenApiConfig.T_DELIVERIES)
    @GetMapping("/deliveries/sample.xlsx")
    public ResponseEntity<byte[]> sampleXlsx(@PathVariable String loc) {
        Access.requireRole(loc, "STOREKEEPER", "MANAGER", "ADMIN");
        var cat = catalog.forLocation(loc);
        // Разные единицы — чтобы в примере были и кг, и л, и шт.
        java.util.List<ru.sphere.stock.domain.ProductInfo> pick = new java.util.ArrayList<>();
        for (var unit : ru.sphere.stock.domain.Unit.values()) {
            cat.products().stream().filter(x -> x.kind() == ru.sphere.stock.domain.ProductKind.RAW && x.unit() == unit)
                    .limit(2).forEach(pick::add);
        }
        java.util.Map<String, Double> cost = new java.util.HashMap<>();
        pick.forEach(x -> {
            var ex = cat.extra(x.id());
            if (ex != null && ex.lastUnitCostKop() != null) {
                cost.put(x.id(), ex.lastUnitCostKop());
            }
        });
        byte[] body = ru.sphere.stock.delivery.DeliveryXlsx.sample(pick, cost, clock.now());
        return ResponseEntity.ok()
                .header("Content-Disposition", "attachment; filename=\"delivery-sample.xlsx\"")
                .contentType(MediaType.parseMediaType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
                .body(body);
    }

    private DeliveryService.DeliveryIn parseJson(String text) {
        try {
            return json.read(text, DeliveryService.DeliveryIn.class);
        } catch (RuntimeException e) {
            throw ApiException.badRequest("Не удалось прочитать JSON поставки: " + e.getMessage());
        }
    }

    private static ResponseEntity<DeliveryService.Result> created(DeliveryService.Result r) {
        return ResponseEntity.status(r.duplicate() ? HttpStatus.OK : HttpStatus.CREATED).body(r);
    }

    @Operation(summary = "Список поставок", tags = OpenApiConfig.T_DELIVERIES)
    @GetMapping("/deliveries")
    public List<QueryService.DeliveryDto> listDeliveries(@PathVariable String loc,
                                                         @RequestParam(required = false) String status) {
        StockPrincipal p = Access.require(loc, "deliveries:create", "STOREKEEPER", "MANAGER", "ADMIN");
        // Поставщик по ключу видит только свои поставки — не накладные других поставщиков ресторана
        return query.deliveries(loc, status, 100, p.kind() == Actor.Kind.API ? p.id() : null);
    }

    @Operation(summary = "Принять поставку: факт против накладной", description = "Создаёт партии и навсегда фиксирует сроки. Можно принять частично: по строке факт от 0 и причина (SHORTAGE, DEFECT, EXPIRED, NOT_ORDERED, OTHER). 428 — продукт скоро истекает, повторите с confirmShortLife=true; 422 — просроченное принять нельзя (кроме тестовой поставки в демо).", tags = OpenApiConfig.T_DELIVERIES)
    @PostMapping("/deliveries/{id}/accept")
    public DeliveryService.Result accept(@PathVariable String loc, @PathVariable String id, @RequestBody AcceptIn in) {
        StockPrincipal p = Access.require(loc, "deliveries:accept", "STOREKEEPER", "MANAGER");
        return deliveries.accept(loc, id, in.lines() == null ? List.of() : in.lines(), uploads.pendingInvoice(loc + "/" + id),
                p.actor(), in.confirmShortLife());
    }

    @Operation(summary = "Одобрить поставку", description = "Управляющий решает, что из накладной берём: целиком или частично (по строке — сколько, 0 — не берём). Принимает потом другой сотрудник — кладовщик.", tags = OpenApiConfig.T_DELIVERIES)
    @PostMapping("/deliveries/{id}/approve")
    public DeliveryService.Result approve(@PathVariable String loc, @PathVariable String id, @RequestBody(required = false) ApproveIn in) {
        StockPrincipal p = Access.requireRole(loc, "MANAGER", "ADMIN");
        return deliveries.approve(loc, id, in == null || in.lines() == null ? List.of() : in.lines(),
                in == null ? null : in.comment(), p.actor());
    }

    @Operation(summary = "Фото накладной", description = "i — номер фото, с нуля.", tags = OpenApiConfig.T_DELIVERIES)
    @GetMapping("/deliveries/{id}/photo")
    public ResponseEntity<FileSystemResource> invoicePhotoFile(@PathVariable String loc, @PathVariable String id,
                                                               @RequestParam(defaultValue = "0") int i) {
        Access.requireRole(loc, "STOREKEEPER", "MANAGER", "ADMIN");
        String name = query.invoicePhoto(loc, id, i);
        if (name == null) {
            throw ApiException.notFound("Фото накладной");
        }
        var res = new FileSystemResource(uploads.resolve(name));
        return ResponseEntity.ok()
                .contentType(MediaTypeFactory.getMediaType(res).orElse(MediaType.APPLICATION_OCTET_STREAM))
                .body(res);
    }

    @Operation(summary = "Фото накладной перед приёмкой", description = "Можно несколько файлов в поле file (до 10).", tags = OpenApiConfig.T_DELIVERIES)
    @PostMapping(value = "/deliveries/{id}/photo", consumes = "multipart/form-data")
    public Map<String, Object> invoicePhoto(@PathVariable String loc, @PathVariable String id,
                                            @RequestParam("file") List<org.springframework.web.multipart.MultipartFile> file) {
        Access.requireRole(loc, "STOREKEEPER", "MANAGER");
        uploads.stageInvoice(loc + "/" + id, file);
        return Map.of("ok", true);
    }

    @Operation(summary = "Отклонить поставку", tags = OpenApiConfig.T_DELIVERIES)
    @PostMapping("/deliveries/{id}/reject")
    public Map<String, Object> reject(@PathVariable String loc, @PathVariable String id,
                                      @RequestBody(required = false) RejectIn in) {
        // Админ одобряет поставку — значит, может её и отклонить, но только на одобрении, не у двери
        StockPrincipal p = Access.requireRole(loc, "STOREKEEPER", "MANAGER", "ADMIN");
        deliveries.reject(loc, id, in == null ? null : in.comment(), p.actor(), p.hasRole("ADMIN"));
        return Map.of("ok", true);
    }

    // ── Заказы ─────────────────────────────────────────────────────────────

    /** 201 — заказ создан, 200 — повтор того же заказа, 409 — отказ с объяснением. */
    @Operation(summary = "Создать заказ «всё или ничего»", description = "201 — создан, продукты списаны по FEFO; 200 — повтор с тем же externalId; 409 — отказ: заказ не создан, в details — чего не хватает, «максимум N» и похожие доступные блюда.", tags = OpenApiConfig.T_ORDERS)
    @PostMapping("/orders")
    public ResponseEntity<?> create(@PathVariable String loc, @RequestBody OrderService.OrderIn in) {
        // Пробивает только кассир (или внешняя система по ключу): управляющий кассой не пользуется.
        StockPrincipal p = Access.require(loc, "orders:create", "CASHIER");
        var outcome = orders.create(loc, in, p.actor());
        return switch (outcome) {
            case OrderService.Created c -> ResponseEntity.status(c.duplicate() ? HttpStatus.OK : HttpStatus.CREATED).body(c);
            case OrderService.Refused r -> ResponseEntity.status(HttpStatus.CONFLICT)
                    .body(Map.of("error", r.message(), "details", r));
        };
    }

    @Operation(summary = "Список заказов", tags = OpenApiConfig.T_ORDERS)
    @GetMapping("/orders")
    public List<QueryService.OrderDto> list(@PathVariable String loc, @RequestParam(required = false) String status,
                                            @RequestParam(defaultValue = "50") int limit) {
        Access.require(loc, "orders:create", Access.STAFF);
        return query.orders(loc, status, Math.min(limit, 500));
    }

    @Operation(summary = "Сменить статус заказа", description = "Только вперёд: NEW → ACCEPTED → COOKING → READY → DELIVERING → DONE.", tags = OpenApiConfig.T_ORDERS)
    @PostMapping("/orders/{id}/status")
    public Map<String, Object> status(@PathVariable String loc, @PathVariable long id, @RequestBody StatusIn in) {
        StockPrincipal p = Access.require(loc, "orders:status", "COOK", "CASHIER", "MANAGER");
        orders.setStatus(loc, id, in.status(), p.actor());
        return Map.of("ok", true);
    }

    @Operation(summary = "Отменить заказ", description = "До «готовится» — продукты возвращаются в те же партии. После — продукты не возвращаются, потеря записывается на сотрудника, причина обязательна.", tags = OpenApiConfig.T_ORDERS)
    @PostMapping("/orders/{id}/cancel")
    public Map<String, Object> cancel(@PathVariable String loc, @PathVariable long id, @RequestBody CancelIn in) {
        StockPrincipal p = Access.require(loc, "orders:cancel", "CASHIER", "MANAGER");
        return Map.of("status", orders.cancel(loc, id, in.reason(), p.actor()));
    }
}
