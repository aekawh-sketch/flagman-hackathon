package ru.sphere.stock.web;

import io.swagger.v3.oas.annotations.Operation;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import ru.sphere.stock.config.OpenApiConfig;
import ru.sphere.stock.security.Access;
import ru.sphere.stock.trace.TraceService;

/** Прослеживаемость (ТЗ 16.6): только управляющий и админ — там себестоимость и партии. */
@RestController
@RequestMapping("/api/{loc}/trace")
public class TraceController {

    private final TraceService trace;
    private final QueryService query;
    private final OperationsService operations;

    public TraceController(TraceService trace, QueryService query, OperationsService operations) {
        this.trace = trace;
        this.query = query;
        this.operations = operations;
    }

    @Operation(summary = "Заказы для разбора по составу", description = "q — номер заказа или часть названия блюда. Период — from и to (дни включительно) или последние days дней.", tags = OpenApiConfig.T_TRACE)
    @GetMapping("/orders")
    public List<TraceService.OrderRow> orders(@PathVariable String loc, @RequestParam(defaultValue = "1") int days,
                                              @RequestParam(required = false) String q,
                                              @RequestParam(required = false) java.time.LocalDate from,
                                              @RequestParam(required = false) java.time.LocalDate to,
                                              @RequestParam(defaultValue = "100") int limit) {
        Access.requireRole(loc, Access.MANAGERS);
        int max = Math.min(Math.max(limit, 1), 300);
        if (from == null && to == null) {
            return trace.orders(loc, days, q, max);
        }
        var p = query.period(loc, days, from, to);
        return trace.orders(loc, p.from(), p.to(), q, max);
    }

    @Operation(summary = "Состав заказа: блюда → продукты → партии", description = "Сколько каждого продукта и из какой партии ушло в каждое блюдо; у заготовок — из какого сырья они сделаны.", tags = OpenApiConfig.T_TRACE)
    @GetMapping("/orders/{id}")
    public TraceService.OrderTrace order(@PathVariable String loc, @PathVariable long id) {
        Access.requireRole(loc, Access.MANAGERS);
        return trace.order(loc, id);
    }

    @Operation(summary = "Заготовки: из чего сделаны и куда ушли", tags = OpenApiConfig.T_TRACE)
    @GetMapping("/preps")
    public List<TraceService.Prep> preps(@PathVariable String loc, @RequestParam(defaultValue = "7") int days,
                                         @RequestParam(required = false) java.time.LocalDate from,
                                         @RequestParam(required = false) java.time.LocalDate to,
                                         @RequestParam(defaultValue = "100") int limit) {
        Access.requireRole(loc, Access.MANAGERS);
        int max = Math.min(Math.max(limit, 1), 300);
        if (from == null && to == null) {
            return trace.preps(loc, days, max);
        }
        var p = query.period(loc, days, from, to);
        return trace.preps(loc, p.from(), p.to(), max);
    }

    @Operation(summary = "В какие блюда ушла партия", description = "Вместе со вскрытыми подпартиями; отменённые до готовки заказы не считаются.", tags = OpenApiConfig.T_TRACE)
    @GetMapping("/batches/{id}/dishes")
    public List<TraceService.DishUse> batchDishes(@PathVariable String loc, @PathVariable long id) {
        Access.requireRole(loc, Access.MANAGERS);
        return trace.batchDishes(loc, id);
    }

    @Operation(summary = "Куда ушёл продукт", description = "В какие блюда напрямую и через заготовки, сколько ушло в заготовки и сколько списано.", tags = OpenApiConfig.T_TRACE)
    @GetMapping("/products/{productId}")
    public TraceService.ProductTrace product(@PathVariable String loc, @PathVariable String productId,
                                             @RequestParam(defaultValue = "7") int days,
                                             @RequestParam(required = false) java.time.LocalDate from,
                                             @RequestParam(required = false) java.time.LocalDate to) {
        Access.requireRole(loc, Access.MANAGERS);
        if (from == null && to == null) {
            return trace.product(loc, productId, days);
        }
        var p = query.period(loc, days, from, to);
        return trace.product(loc, productId, p.from(), p.to(), p.days());
    }

    @Operation(summary = "Кто что делал", description = "Операции за период по сотрудникам: сколько и каких. Списание по заявке — автору заявки.", tags = OpenApiConfig.T_TRACE)
    @GetMapping("/operations/actors")
    public List<OperationsService.ActorSum> operationsByActor(@PathVariable String loc,
                                                              @RequestParam(defaultValue = "7") int days,
                                                              @RequestParam(required = false) java.time.LocalDate from,
                                                              @RequestParam(required = false) java.time.LocalDate to) {
        Access.requireRole(loc, Access.MANAGERS);
        return operations.byActor(loc, query.period(loc, Math.min(Math.max(days, 1), 366), from, to));
    }

    @Operation(summary = "Операции за период", description = "Что, откуда и куда: движения журнала с документом-источником (поставка, заказ, заготовка, заявка на списание, возврат). Фильтры: actor — ID сотрудника (его действия и заявки) или system; type — тип движения или LOSS (все списания); product — продукт.", tags = OpenApiConfig.T_TRACE)
    @GetMapping("/operations")
    public OperationsService.Result operations(@PathVariable String loc, @RequestParam(defaultValue = "7") int days,
                                               @RequestParam(required = false) java.time.LocalDate from,
                                               @RequestParam(required = false) java.time.LocalDate to,
                                               @RequestParam(required = false) String actor,
                                               @RequestParam(required = false) String type,
                                               @RequestParam(required = false) String product,
                                               @RequestParam(defaultValue = "300") int limit) {
        Access.requireRole(loc, Access.MANAGERS);
        return operations.list(loc, query.period(loc, Math.min(Math.max(days, 1), 366), from, to), actor, type, product, limit);
    }
}
