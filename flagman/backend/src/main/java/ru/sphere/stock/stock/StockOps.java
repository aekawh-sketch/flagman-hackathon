package ru.sphere.stock.stock;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Component;
import ru.sphere.stock.domain.BatchState;
import ru.sphere.stock.domain.Catalog;
import ru.sphere.stock.domain.Fefo;
import ru.sphere.stock.domain.Money;
import ru.sphere.stock.domain.OpeningRule;
import ru.sphere.stock.domain.ProductInfo;
import ru.sphere.stock.ledger.Actor;
import ru.sphere.stock.ledger.Ledger;
import ru.sphere.stock.ledger.MovementType;

/**
 * Общие складские операции поверх журнала: списание по FEFO с автоматическим вскрытием упаковок
 * (ТЗ 5.2) и отделение вскрытой подпартии. Вызываются внутри транзакции под блокировкой точки.
 */
@Component
public class StockOps {

    /** Что списали: партия, количество, себестоимость. */
    public record Consumed(String productId, long batchId, long qty, long costKop, long movementId) {
    }

    private final StockRepository batches;

    public StockOps(StockRepository batches) {
        this.batches = batches;
    }

    /**
     * Списать {@code needs} по FEFO из партий {@code locked} (заблокированы заранее).
     * Вызывающий уже проверил, что доступного хватает.
     */
    public List<Consumed> consume(Ledger.Tx tx, Map<String, Long> needs, Map<String, List<BatchState>> locked,
                                  MovementType type, Actor actor, String reason, String docType, String docId,
                                  UUID op, Catalog catalog) {
        List<Consumed> out = new ArrayList<>();
        needs.forEach((pid, need) -> {
            if (need <= 0) {
                return;
            }
            ProductInfo p = catalog.product(pid);
            for (Fefo.Take t : Fefo.allocate(locked.getOrDefault(pid, List.of()), need, tx.at())) {
                BatchState b = t.batch();
                long cost = t.cost();
                long mid = tx.append(type, b.id(), -t.qty(), -cost, actor, reason, docType, docId, op, null);
                out.add(new Consumed(pid, b.id(), t.qty(), cost, mid));
                OpeningRule.afterTake(b, t.qty(), p, tx.at())
                        .ifPresent(split -> openSplit(tx, b, split, actor, docType, docId, op));
            }
        });
        return out;
    }

    /** Отделить вскрытую подпартию: два движения с одним ID операции, подпартия помнит родителя. */
    public long openSplit(Ledger.Tx tx, BatchState parent, OpeningRule.Split split, Actor actor,
                          String docType, String docId, UUID op) {
        long cost = Money.share(parent.costTotalKop(), split.qty(), parent.qtyInitial());
        String loc = tx.locationId();
        long child = batches.insert(new StockRepository.NewBatch(loc, parent.productId(), "OPENING", null,
                parent.id(), op, split.qty(), cost, tx.at(), split.expiresAt(), tx.at(), true, "В"));
        tx.append(MovementType.OPEN_OUT, parent.id(), -split.qty(), -cost, actor, "Вскрытие упаковки",
                docType, docId, op, null);
        tx.append(MovementType.OPEN_IN, child, split.qty(), cost, actor, "Вскрытие упаковки",
                docType, docId, op, null);
        return child;
    }

    public Optional<BatchState> find(long batchId, boolean forUpdate) {
        return Optional.ofNullable(batches.get(batchId, forUpdate));
    }
}
