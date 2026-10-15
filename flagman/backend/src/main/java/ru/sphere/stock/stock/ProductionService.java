package ru.sphere.stock.stock;

import io.swagger.v3.oas.annotations.media.Schema;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.sphere.stock.catalog.CatalogService;
import ru.sphere.stock.domain.BatchState;
import ru.sphere.stock.domain.ProductInfo;
import ru.sphere.stock.domain.ProductKind;
import ru.sphere.stock.domain.Production;
import ru.sphere.stock.events.StockChanged;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.infra.AppClock;
import ru.sphere.stock.ledger.Actor;
import ru.sphere.stock.ledger.Ledger;
import ru.sphere.stock.ledger.MovementType;

/** Приготовление заготовки (ТЗ 5.4, п. 12): всё в одной транзакции, при нехватке — отказ с объяснением. */
@Service
public class ProductionService {

    @Schema(name = "ProductionResult")
    public record Result(long batchId, String label, long qty, String qtyText, java.time.Instant expiresAt, long costKop) {
    }

    @Schema(name = "ProductionShortage")
    public record ShortageDto(String productId, String productName, String needText, String availableText) {
    }

    private final AppClock clock;
    private final Ledger ledger;
    private final StockRepository batches;
    private final StockOps ops;
    private final CatalogService catalog;
    private final ApplicationEventPublisher events;

    public ProductionService(AppClock clock, Ledger ledger, StockRepository batches, StockOps ops,
                             CatalogService catalog, ApplicationEventPublisher events) {
        this.clock = clock;
        this.ledger = ledger;
        this.batches = batches;
        this.ops = ops;
        this.catalog = catalog;
        this.events = events;
    }

    @Transactional
    public Result produce(String locationId, String semiId, long amount, Actor actor) {
        CatalogService.Snapshot cat = catalog.forLocation(locationId);
        ProductInfo semi = cat.product(semiId);
        if (semi == null || semi.kind() != ProductKind.SEMI) {
            throw ApiException.badRequest("Это не заготовка: " + semiId);
        }
        CatalogService.SemiRecipe r = cat.semi(semiId);
        if (r == null) {
            throw ApiException.badRequest("У заготовки нет техкарты: " + semi.name());
        }
        if (amount <= 0) {
            throw ApiException.badRequest("Количество должно быть больше нуля");
        }
        Ledger.Tx tx = ledger.lock(locationId, clock.now());
        Map<String, Long> needs = Production.needs(r.lines(), r.yield(), amount, cat);
        Map<String, List<BatchState>> locked = batches.live(locationId, needs.keySet(), true).stream()
                .collect(Collectors.groupingBy(BatchState::productId));
        Production.Result plan = Production.plan(semi, r.lines(), r.yield(), amount, locked, cat, tx.at());
        if (!plan.ok()) {
            List<ShortageDto> sh = plan.shortages().stream().map(s -> {
                ProductInfo p = cat.product(s.productId());
                return new ShortageDto(p.id(), p.name(), p.format(s.need()), p.format(s.available()));
            }).toList();
            throw ApiException.conflict("Не хватает сырья на " + semi.format(amount) + " «" + semi.name() + "»", sh);
        }
        UUID op = UUID.randomUUID();
        long cost = ops.consume(tx, needs, locked, MovementType.PRODUCTION_USE, actor, null, "production",
                op.toString(), op, cat).stream().mapToLong(StockOps.Consumed::costKop).sum();
        var p = plan.plan();
        long id = batches.insert(new StockRepository.NewBatch(locationId, semiId, "PRODUCTION", null, null, op,
                amount, cost, tx.at(), p.expiresAt(), tx.at(), false, "З"));
        tx.append(MovementType.PRODUCTION_OUT, id, amount, cost, actor, null, "production", op.toString(), op, null);
        events.publishEvent(new StockChanged(locationId, "production"));
        return new Result(id, "З" + id, amount, semi.format(amount), p.expiresAt(), cost);
    }
}
