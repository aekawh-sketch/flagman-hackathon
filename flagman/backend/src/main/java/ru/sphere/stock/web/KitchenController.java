package ru.sphere.stock.web;

import io.swagger.v3.oas.annotations.Operation;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import ru.sphere.stock.config.OpenApiConfig;
import ru.sphere.stock.kitchen.KitchenPrintService;
import ru.sphere.stock.kitchen.PrinterConfig;
import ru.sphere.stock.security.Access;

/** Чеки на кухню и принтер точки (ТЗ 16.15). */
@RestController
@RequestMapping("/api/{loc}/kitchen")
public class KitchenController {

    private final KitchenPrintService kitchen;

    public KitchenController(KitchenPrintService kitchen) {
        this.kitchen = kitchen;
    }

    @Operation(summary = "Чеки на кухню", description = "Чеки точки: блюда заказа и куда ушла печать. from и to — отрезок времени (день и часы); без них — последние.", tags = OpenApiConfig.T_KITCHEN)
    @GetMapping("/tickets")
    public List<KitchenPrintService.TicketDto> tickets(@PathVariable String loc, @RequestParam(defaultValue = "20") int limit,
                                                       @RequestParam(required = false) java.time.Instant from,
                                                       @RequestParam(required = false) java.time.Instant to) {
        Access.requireRole(loc, "COOK", "CASHIER", "MANAGER", "ADMIN");
        return kitchen.tickets(loc, from, to, limit);
    }

    @Operation(summary = "Напечатать чек ещё раз", description = "Повар нажал «Ещё раз»: чек уходит на принтер точки, попытка и ошибка — в журнал чеков.", tags = OpenApiConfig.T_KITCHEN)
    @PostMapping("/tickets/{id}/print")
    public KitchenPrintService.PrintResult reprint(@PathVariable String loc, @PathVariable long id) {
        Access.requireRole(loc, "COOK", "CASHIER", "MANAGER", "ADMIN");
        kitchen.ticketAt(loc, id);
        return kitchen.print(id);
    }

    @Operation(summary = "Принтер кухни точки", tags = OpenApiConfig.T_KITCHEN)
    @GetMapping("/printer")
    public PrinterConfig printer(@PathVariable String loc) {
        Access.requireRole(loc, "COOK", "MANAGER", "ADMIN");
        return kitchen.printer(loc);
    }

    @Operation(summary = "Настроить принтер кухни", description = "Только админ. NETWORK — термопринтер ESC/POS по TCP (обычно порт 9100), адрес — только в сети ресторана.", tags = OpenApiConfig.T_KITCHEN)
    @PutMapping("/printer")
    public PrinterConfig savePrinter(@PathVariable String loc, @RequestBody KitchenPrintService.PrinterIn in) {
        var p = Access.requireRole(loc, "ADMIN");
        return kitchen.savePrinter(loc, in, p.actor());
    }

    @Operation(summary = "Пробная печать", description = "Проверить принтер, не создавая заказа.", tags = OpenApiConfig.T_KITCHEN)
    @PostMapping("/printer/test")
    public KitchenPrintService.PrintResult test(@PathVariable String loc) {
        Access.requireRole(loc, "ADMIN");
        return kitchen.test(loc);
    }
}
