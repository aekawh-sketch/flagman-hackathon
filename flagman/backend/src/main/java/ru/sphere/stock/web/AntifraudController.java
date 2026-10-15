package ru.sphere.stock.web;

import java.util.List;
import java.util.Map;
import io.swagger.v3.oas.annotations.Operation;
import ru.sphere.stock.config.OpenApiConfig;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.MediaType;
import org.springframework.http.MediaTypeFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import ru.sphere.stock.antifraud.AnomalyDetails;
import ru.sphere.stock.antifraud.AnomalyService;
import ru.sphere.stock.antifraud.InventoryService;
import ru.sphere.stock.antifraud.WriteoffService;
import ru.sphere.stock.ledger.Ledger;
import ru.sphere.stock.security.Access;
import ru.sphere.stock.security.StockPrincipal;

/** Заявки на списание, инвентаризация, аномалии, журнал, аналитика (ТЗ 6, 5.12). */
@RestController
@RequestMapping("/api/{loc}")
public class AntifraudController {

    public record DecisionIn(String comment) {
    }

    public record ReviewIn(String status, String comment) {
    }

    private final WriteoffService writeoffs;
    private final InventoryService inventory;
    private final AnomalyService anomalies;
    private final AnomalyDetails anomalyDetails;
    private final QueryService query;
    private final UploadService uploads;
    private final ProfitService profits;

    public AntifraudController(WriteoffService writeoffs, InventoryService inventory, AnomalyService anomalies,
                               AnomalyDetails anomalyDetails, QueryService query, UploadService uploads,
                               ProfitService profits) {
        this.profits = profits;
        this.anomalyDetails = anomalyDetails;
        this.writeoffs = writeoffs;
        this.inventory = inventory;
        this.anomalies = anomalies;
        this.query = query;
        this.uploads = uploads;
    }

    // ── Заявки на списание (6.5) ───────────────────────────────────────────

    @Operation(summary = "Заявка на ручное списание с фото", description = "Причины: SPOILED — порча, DAMAGED — бой, OTHER — прочее. «Просрочку» списывают отдельно — POST /batches/{id}/writeoff-expired, только после срока. Сразу не списывается ничего: любую заявку, в том числе кладовщика, одобряет или отклоняет управляющий или админ (свою — нельзя); пока ждёт — не продаётся.", tags = OpenApiConfig.T_WRITEOFFS)
    @PostMapping(value = "/writeoff-requests", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public WriteoffService.Created create(@PathVariable String loc, @RequestParam long batchId, @RequestParam long qty,
                                          @RequestParam String reason,
                                          @RequestParam(required = false) String comment,
                                          @RequestParam("photo") List<MultipartFile> photo) {
        StockPrincipal p = Access.requireRole(loc, "COOK", "CASHIER", "STOREKEEPER", "MANAGER");
        return writeoffs.create(loc, batchId, qty, reason, comment, uploads.saveAll(photo), p.actor());
    }

    @Operation(summary = "Списать напиток, блюдо или продукт — партии по FEFO", description = "variantId + portions — напиток или блюдо из меню: списываются все продукты по техкарте; иначе productId + qty — продукт. Партии выбирает система по FEFO. Одна заявка — одна подпись управляющего на всю группу; правила как у обычной заявки.", tags = OpenApiConfig.T_WRITEOFFS)
    @PostMapping(value = "/writeoff-requests/fefo", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public WriteoffService.GroupCreated createFefo(@PathVariable String loc,
                                                   @RequestParam(required = false) String variantId,
                                                   @RequestParam(defaultValue = "1") int portions,
                                                   @RequestParam(required = false) String productId,
                                                   @RequestParam(defaultValue = "0") long qty,
                                                   @RequestParam String reason,
                                                   @RequestParam(required = false) String comment,
                                                   @RequestParam("photo") List<MultipartFile> photo) {
        StockPrincipal p = Access.requireRole(loc, "COOK", "CASHIER", "STOREKEEPER", "MANAGER");
        return writeoffs.createFefo(loc, productId, qty, variantId, portions, reason, comment, uploads.saveAll(photo), p.actor());
    }

    @Operation(summary = "Откуда списывать: поставки и их партии", description = "Сначала выбирают поставку, потом её продукты. Только то, что можно списать вручную: не просрочено, не заблокировано, не удержано другой заявкой. Заготовки кухни и излишки пересчёта — отдельными источниками.", tags = OpenApiConfig.T_WRITEOFFS)
    @GetMapping("/writeoff-sources")
    public List<WriteoffService.Source> sources(@PathVariable String loc) {
        Access.requireRole(loc, "COOK", "CASHIER", "STOREKEEPER", "MANAGER");
        return writeoffs.sources(loc);
    }

    @Operation(summary = "Заявка на списание по выбранным партиям поставки", description = "batchId и qty — парами, по порядку. Несколько партий — одна заявка: управляющий или админ одобряет или отклоняет её целиком. Заявка управляющего проходит сразу.", tags = OpenApiConfig.T_WRITEOFFS)
    @PostMapping(value = "/writeoff-requests/batches", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public WriteoffService.GroupCreated createBatches(@PathVariable String loc,
                                                      @io.swagger.v3.oas.annotations.Parameter(description = "ID партий") @RequestParam List<Long> batchId,
                                                      @io.swagger.v3.oas.annotations.Parameter(description = "Сколько списать из каждой партии") @RequestParam List<Long> qty,
                                                      @RequestParam String reason,
                                                      @RequestParam(required = false) String comment,
                                                      @RequestParam("photo") List<MultipartFile> photo) {
        StockPrincipal p = Access.requireRole(loc, "COOK", "CASHIER", "STOREKEEPER", "MANAGER");
        if (batchId.size() != qty.size()) {
            throw ru.sphere.stock.infra.ApiException.badRequest("batchId и qty — парами");
        }
        List<WriteoffService.LineIn> lines = new java.util.ArrayList<>();
        for (int i = 0; i < batchId.size(); i++) {
            lines.add(new WriteoffService.LineIn(batchId.get(i), qty.get(i)));
        }
        return writeoffs.createBatches(loc, lines, reason, comment, uploads.saveAll(photo), p.actor());
    }

    @Operation(summary = "Список заявок на списание", tags = OpenApiConfig.T_WRITEOFFS)
    @GetMapping("/writeoff-requests")
    public List<WriteoffService.RequestDto> list(@PathVariable String loc, @RequestParam(required = false) String status) {
        Access.requireRole(loc, "COOK", "STOREKEEPER", "MANAGER", "ADMIN");
        return writeoffs.list(loc, status);
    }

    @Operation(summary = "Фото заявки", description = "i — номер фото, с нуля: у заявки их может быть несколько.", tags = OpenApiConfig.T_WRITEOFFS)
    @GetMapping("/writeoff-requests/{id}/photo")
    public ResponseEntity<FileSystemResource> photo(@PathVariable String loc, @PathVariable long id,
                                                    @RequestParam(defaultValue = "0") int i) {
        Access.requireRole(loc, "STOREKEEPER", "MANAGER", "ADMIN");
        var path = uploads.resolve(writeoffs.photoOf(loc, id, i));
        var res = new FileSystemResource(path);
        return ResponseEntity.ok()
                .contentType(MediaTypeFactory.getMediaType(res).orElse(MediaType.APPLICATION_OCTET_STREAM))
                .body(res);
    }

    @Operation(summary = "Подписать списание", description = "Свою заявку подписать нельзя.", tags = OpenApiConfig.T_WRITEOFFS)
    @PostMapping("/writeoff-requests/{id}/approve")
    public Map<String, Object> approve(@PathVariable String loc, @PathVariable long id, @RequestBody DecisionIn in) {
        StockPrincipal p = Access.requireRole(loc, Access.MANAGERS);
        writeoffs.approve(loc, id, in.comment(), p.actor());
        return Map.of("ok", true);
    }

    @Operation(summary = "Отклонить заявку", description = "Удержанное количество возвращается в продажу.", tags = OpenApiConfig.T_WRITEOFFS)
    @PostMapping("/writeoff-requests/{id}/reject")
    public Map<String, Object> reject(@PathVariable String loc, @PathVariable long id, @RequestBody DecisionIn in) {
        StockPrincipal p = Access.requireRole(loc, Access.MANAGERS);
        writeoffs.reject(loc, id, in.comment(), p.actor());
        return Map.of("ok", true);
    }

    // ── Инвентаризация (6.10) ──────────────────────────────────────────────

    @Operation(summary = "Начать пересчёт", description = "Фиксируется момент T; продажи не останавливаются.", tags = OpenApiConfig.T_INVENTORY)
    @PostMapping("/inventory")
    public InventoryService.CountDto start(@PathVariable String loc) {
        StockPrincipal p = Access.requireRole(loc, "STOREKEEPER", "MANAGER");
        return inventory.get(loc, inventory.start(loc, p.actor()));
    }

    @Operation(summary = "История пересчётов", description = "from и to — период по дням начала пересчёта; незавершённый пересчёт показывается всегда.", tags = OpenApiConfig.T_INVENTORY)
    @GetMapping("/inventory")
    public List<InventoryService.CountDto> counts(@PathVariable String loc,
                                                  @RequestParam(required = false) java.time.LocalDate from,
                                                  @RequestParam(required = false) java.time.LocalDate to) {
        Access.requireRole(loc, "STOREKEEPER", "MANAGER", "ADMIN");
        if (from == null && to == null) {
            return inventory.list(loc);
        }
        var p = query.period(loc, 30, from, to);
        return inventory.list(loc, p.from(), p.to());
    }

    @Operation(summary = "Ввести факт по продуктам", description = "Ожидаемое на момент T считается по журналу.", tags = OpenApiConfig.T_INVENTORY)
    @PutMapping("/inventory/{id}/lines")
    public InventoryService.CountDto lines(@PathVariable String loc, @PathVariable long id,
                                           @RequestBody List<InventoryService.LineIn> lines) {
        Access.requireRole(loc, "STOREKEEPER", "MANAGER");
        return inventory.setLines(loc, id, lines);
    }

    @Operation(summary = "Провести пересчёт", description = "Если расхождение дороже порога и отправил не управляющий — ждёт подтверждения.", tags = OpenApiConfig.T_INVENTORY)
    @PostMapping("/inventory/{id}/submit")
    public InventoryService.CountDto submit(@PathVariable String loc, @PathVariable long id) {
        StockPrincipal p = Access.requireRole(loc, "STOREKEEPER", "MANAGER");
        return inventory.submit(loc, id, p.actor());
    }

    @Operation(summary = "Подтвердить пересчёт", tags = OpenApiConfig.T_INVENTORY)
    @PostMapping("/inventory/{id}/confirm")
    public InventoryService.CountDto confirm(@PathVariable String loc, @PathVariable long id) {
        StockPrincipal p = Access.requireRole(loc, "MANAGER");
        return inventory.confirm(loc, id, p.actor());
    }

    // ── Аномалии, журнал (6.3, 6.4, 6.11) ──────────────────────────────────

    @Operation(summary = "Подозрительные операции", description = "Правила A1–A8: кто списывает больше других, списание свежего, перед закрытием, дорогие позиции, поздние отмены, рост граммовки, повторные недостачи и расхождения приёмки. from и to — период по дням (МСК, включительно).", tags = OpenApiConfig.T_SECURITY)
    @GetMapping("/anomalies")
    public List<AnomalyService.AnomalyDto> anomalies(@PathVariable String loc,
                                                     @RequestParam(required = false) String status,
                                                     @RequestParam(required = false) java.time.LocalDate from,
                                                     @RequestParam(required = false) java.time.LocalDate to) {
        Access.requireRole(loc, Access.MANAGERS);
        return anomalies.list(loc, status, from, to);
    }

    @Operation(summary = "Подробности подозрительной операции", description = "Как сработало правило, цифры, связанные заявки на списание с фото, отмены заказов и ссылки, куда перейти разбираться.", tags = OpenApiConfig.T_SECURITY)
    @GetMapping("/anomalies/{id}")
    public AnomalyDetails.Detail anomaly(@PathVariable String loc, @PathVariable long id) {
        Access.requireRole(loc, Access.MANAGERS);
        return anomalyDetails.detail(loc, id);
    }

    @Operation(summary = "Разобрать аномалию", description = "Решение: CONFIRMED — подтвердить подозрение, FALSE — ложная тревога.", tags = OpenApiConfig.T_SECURITY)
    @PatchMapping("/anomalies/{id}")
    public Map<String, Object> review(@PathVariable String loc, @PathVariable long id, @RequestBody ReviewIn in) {
        StockPrincipal p = Access.requireRole(loc, Access.MANAGERS);
        anomalies.review(loc, id, in.status(), in.comment(), p.actor());
        return Map.of("ok", true);
    }

    @Operation(summary = "Журнал движений", description = "Только добавление; у каждой записи — хэш предыдущей.", tags = OpenApiConfig.T_SECURITY)
    @GetMapping("/ledger")
    public List<QueryService.LedgerRow> ledger(@PathVariable String loc, @RequestParam(required = false) String type,
                                               @RequestParam(required = false) String product,
                                               @RequestParam(required = false) Long beforeSeq,
                                               @RequestParam(defaultValue = "100") int limit) {
        Access.requireRole(loc, Access.MANAGERS);
        return query.ledger(loc, type, product, beforeSeq, Math.min(limit, 500));
    }

    @Operation(summary = "Проверить целостность хэш-цепочки", description = "Показывает номер первой изменённой записи, если цепочка нарушена.", tags = OpenApiConfig.T_SECURITY)
    @GetMapping("/ledger/verify")
    public Ledger.Verification verify(@PathVariable String loc) {
        Access.requireRole(loc, Access.MANAGERS);
        return query.integrity(loc, true);
    }

    // ── Аналитика (Д2, Д3) ─────────────────────────────────────────────────

    @Operation(summary = "Прибыль за период", description = "Выручка, себестоимость проданного, прибыль, потери и «в плюсе» — по дням и по блюдам. from и to — дни периода включительно.", tags = OpenApiConfig.T_ANALYTICS)
    @GetMapping("/analytics/profit")
    public ProfitService.ProfitAnalytics profit(@PathVariable String loc,
                                                @RequestParam(defaultValue = "7") int days,
                                                @RequestParam(required = false) java.time.LocalDate from,
                                                @RequestParam(required = false) java.time.LocalDate to) {
        Access.require(loc, "analytics:read", Access.MANAGERS);
        return profits.profit(loc, query.period(loc, Math.min(Math.max(days, 1), 366), from, to));
    }

    @Operation(summary = "Потери", description = "По причинам, продуктам, сотрудникам и дням; доля от закупок. Период — from и to (дни включительно) или последние days дней.", tags = OpenApiConfig.T_ANALYTICS)
    @GetMapping("/analytics/writeoffs")
    public QueryService.WriteoffAnalytics writeoffAnalytics(@PathVariable String loc,
                                                            @RequestParam(defaultValue = "7") int days,
                                                            @RequestParam(required = false) java.time.LocalDate from,
                                                            @RequestParam(required = false) java.time.LocalDate to) {
        Access.require(loc, "analytics:read", Access.MANAGERS);
        return query.writeoffs(loc, query.period(loc, Math.min(Math.max(days, 1), 366), from, to));
    }

    @Operation(summary = "Потери за день", description = "Каждое списание дня: что, сколько, на какую сумму, кто списал и кто подписал; плюс отмены после готовки.", tags = OpenApiConfig.T_ANALYTICS)
    @GetMapping("/analytics/writeoffs/day")
    public QueryService.LossDay lossDay(@PathVariable String loc, @RequestParam String date) {
        Access.require(loc, "analytics:read", Access.MANAGERS);
        try {
            return query.lossDay(loc, java.time.LocalDate.parse(date));
        } catch (java.time.format.DateTimeParseException e) {
            throw ru.sphere.stock.infra.ApiException.badRequest("Дата — в формате ГГГГ-ММ-ДД");
        }
    }

    @Operation(summary = "Поставлено — съедено — просрочено", description = "По продукту за период: приход, расход в заказы и заготовки, просрочка, прочие потери, остаток и подсказка, возить ли меньше.", tags = OpenApiConfig.T_ANALYTICS)
    @GetMapping("/analytics/supply")
    public List<QueryService.SupplyRow> supply(@PathVariable String loc, @RequestParam(defaultValue = "30") int days,
                                               @RequestParam(required = false) java.time.LocalDate from,
                                               @RequestParam(required = false) java.time.LocalDate to) {
        Access.require(loc, "analytics:read", "STOREKEEPER", "MANAGER", "ADMIN");
        return query.supply(loc, query.period(loc, Math.min(Math.max(days, 1), 366), from, to));
    }

    @Operation(summary = "Самые дефицитные ингредиенты", description = "Отказы, входы в стоп, часы в стопе, упущенная выручка.", tags = OpenApiConfig.T_ANALYTICS)
    @GetMapping("/analytics/deficit")
    public List<QueryService.DeficitRow> deficit(@PathVariable String loc, @RequestParam(defaultValue = "7") int days,
                                                 @RequestParam(required = false) java.time.LocalDate from,
                                                 @RequestParam(required = false) java.time.LocalDate to) {
        Access.require(loc, "analytics:read", Access.MANAGERS);
        return query.deficit(loc, query.period(loc, Math.min(Math.max(days, 1), 366), from, to));
    }
}
