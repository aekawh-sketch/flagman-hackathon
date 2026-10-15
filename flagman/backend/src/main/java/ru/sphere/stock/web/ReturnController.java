package ru.sphere.stock.web;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.MediaType;
import org.springframework.http.MediaTypeFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import ru.sphere.stock.config.OpenApiConfig;
import ru.sphere.stock.delivery.SupplierReturnService;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.security.Access;
import ru.sphere.stock.security.StockPrincipal;

/** Возврат поставщику (ТЗ 16.7): подаёт кладовщик с фото, подтверждает управляющий или админ — не автор. */
@RestController
@RequestMapping("/api/{loc}")
public class ReturnController {

    private final SupplierReturnService returns;
    private final UploadService uploads;

    public ReturnController(SupplierReturnService returns, UploadService uploads) {
        this.returns = returns;
        this.uploads = uploads;
    }

    @Operation(summary = "Что из поставки можно вернуть", description = "Партии принятой поставки и их вскрытые подпартии: остаток минус то, что уже удержано заявками.", tags = OpenApiConfig.T_DELIVERIES)
    @GetMapping("/deliveries/{id}/returnable")
    public List<SupplierReturnService.Returnable> returnable(@PathVariable String loc, @PathVariable String id) {
        Access.requireRole(loc, "STOREKEEPER", "MANAGER", "ADMIN");
        return returns.returnable(loc, id);
    }

    @Operation(summary = "Заявка на возврат поставщику с фото", description = "Поставка, партии и количество (batchId и qty — парами, по порядку), причина: DEFECT — брак, WRONG_ITEM — не тот товар, SHORT_LIFE — короткий срок, DAMAGED_PACK — повреждена упаковка, QUALITY — не то качество, OTHER — прочее (с комментарием). Фото обязательно. Пока ждёт — не продаётся; подтверждает управляющий или админ.", tags = OpenApiConfig.T_DELIVERIES)
    @PostMapping(value = "/returns", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public SupplierReturnService.Created create(@PathVariable String loc, @RequestParam String deliveryId,
                                                @Parameter(description = "ID партий") @RequestParam List<Long> batchId,
                                                @Parameter(description = "Сколько вернуть из каждой партии") @RequestParam List<Long> qty,
                                                @RequestParam String reason,
                                                @RequestParam(required = false) String comment,
                                                @RequestParam("photo") List<MultipartFile> photo) {
        StockPrincipal p = Access.requireRole(loc, "STOREKEEPER", "MANAGER", "ADMIN");
        if (batchId.size() != qty.size()) {
            throw ApiException.badRequest("batchId и qty — парами");
        }
        List<SupplierReturnService.LineIn> lines = new ArrayList<>();
        for (int i = 0; i < batchId.size(); i++) {
            lines.add(new SupplierReturnService.LineIn(batchId.get(i), qty.get(i)));
        }
        return returns.create(loc, deliveryId, lines, reason, comment, uploads.saveAll(photo), p.actor());
    }

    @Operation(summary = "Заявки на возврат поставщику", tags = OpenApiConfig.T_DELIVERIES)
    @GetMapping("/returns")
    public List<SupplierReturnService.ReturnDto> list(@PathVariable String loc,
                                                     @RequestParam(required = false) String status,
                                                     @RequestParam(required = false) String deliveryId) {
        Access.requireRole(loc, "STOREKEEPER", "MANAGER", "ADMIN");
        return returns.list(loc, status, deliveryId);
    }

    @Operation(summary = "Фото к возврату", description = "i — номер фото, с нуля.", tags = OpenApiConfig.T_DELIVERIES)
    @GetMapping("/returns/{id}/photo")
    public ResponseEntity<FileSystemResource> photo(@PathVariable String loc, @PathVariable long id,
                                                    @RequestParam(defaultValue = "0") int i) {
        Access.requireRole(loc, "STOREKEEPER", "MANAGER", "ADMIN");
        var res = new FileSystemResource(uploads.resolve(returns.photoOf(loc, id, i)));
        return ResponseEntity.ok()
                .contentType(MediaTypeFactory.getMediaType(res).orElse(MediaType.APPLICATION_OCTET_STREAM))
                .body(res);
    }

    @Operation(summary = "Подтвердить возврат", description = "Удержанное уходит со склада движением «Возврат поставщику». Свою заявку подтвердить нельзя.", tags = OpenApiConfig.T_DELIVERIES)
    @PostMapping("/returns/{id}/approve")
    public Map<String, Object> approve(@PathVariable String loc, @PathVariable long id,
                                       @RequestBody AntifraudController.DecisionIn in) {
        StockPrincipal p = Access.requireRole(loc, Access.MANAGERS);
        returns.approve(loc, id, in.comment(), p.actor());
        return Map.of("ok", true);
    }

    @Operation(summary = "Отклонить возврат", description = "Удержанное количество возвращается в продажу.", tags = OpenApiConfig.T_DELIVERIES)
    @PostMapping("/returns/{id}/reject")
    public Map<String, Object> reject(@PathVariable String loc, @PathVariable long id,
                                      @RequestBody AntifraudController.DecisionIn in) {
        StockPrincipal p = Access.requireRole(loc, Access.MANAGERS);
        returns.reject(loc, id, in.comment(), p.actor());
        return Map.of("ok", true);
    }
}
