package ru.sphere.stock.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static ru.sphere.stock.domain.Fixtures.HOURS;
import static ru.sphere.stock.domain.Fixtures.NOW;
import static ru.sphere.stock.domain.Fixtures.batch;
import static ru.sphere.stock.domain.Fixtures.raw;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * ТЗ 5.10 и раздел 12: блюдо в стопе не попадает; продукт без риска не продвигается; дорогое важнее
 * дешёвого; срочное важнее; при общем продукте соблюдается разнообразие; объяснение понятное.
 */
class HotOffersTest {

    private final Fixtures.MemCatalog catalog = new Fixtures.MemCatalog()
            .product(raw("salmon")).product(raw("cream")).product(raw("x")).product(raw("y"))
            .dish("rollA", 43_000, RecipeLine.of("salmon", 100))
            .dish("rollB", 43_000, RecipeLine.of("salmon", 100))
            .dish("rollC", 43_000, RecipeLine.of("salmon", 100))
            .dish("pasta", 36_000, RecipeLine.of("cream", 100))
            .dish("dx", 30_000, RecipeLine.of("x", 100))
            .dish("dy", 30_000, RecipeLine.of("y", 100));

    // Лосось: 300 г по 1200 ₽/кг, истекает через 14 ч. Сливки: 1 л по 300 ₽/л, тоже через 14 ч.
    private final Map<String, List<BatchState>> batches = new HashMap<>(Map.of(
            "salmon", List.of(batch(1, "salmon", 300, 50, 14, 36_000)),
            "cream", List.of(batch(2, "cream", 1000, 50, 14, 30_000))));

    private List<HotOffers.Offer> run(Map<String, Double> rates, Map<String, Long> portionsOverride) {
        Map<String, List<RiskAnalyzer.BatchRisk>> risks = new HashMap<>();
        batches.forEach((pid, list) ->
                risks.put(pid, RiskAnalyzer.analyze(list, rates.getOrDefault(pid, 0.0), HOURS, NOW)));
        Map<String, StopList.Portions> portions = new HashMap<>();
        for (VariantDef v : catalog.variants()) {
            long n = portionsOverride.getOrDefault(v.id(), 10L);
            portions.put(v.id(), new StopList.Portions(v.id(), true, n, null));
        }
        return HotOffers.compute(catalog, portions, risks, rates, Map.of(), NOW, HotOffers.DEFAULT_LIMIT);
    }

    @Test
    void sharedProductDoesNotFillTheWholeListAndExpensiveGoesFirst() {
        List<HotOffers.Offer> offers = run(Map.of(), Map.of());
        // Под угрозой 300 г лосося; каждое продвинутое блюдо «спасает» 2 порции × 100 г.
        // Значит, хватает двух блюд с лососем, третье уже ничего не спасает — место отдаём сливкам.
        assertThat(offers).extracting(HotOffers.Offer::variantId).containsExactly("rollA", "rollB", "pasta");
    }

    @Test
    void dishInStopIsNeverOffered() {
        assertThat(run(Map.of(), Map.of("rollA", 0L))).extracting(HotOffers.Offer::variantId)
                .doesNotContain("rollA").contains("rollB");
    }

    @Test
    void productThatSellsAnywayIsNotPromoted() {
        // 1 кг/ч лосося и сливок — всё продадим до срока, спасать нечего.
        assertThat(run(Map.of("salmon", 1000.0, "cream", 1000.0), Map.of())).isEmpty();
    }

    @Test
    void soonerExpiryRanksHigherAtEqualValue() {
        batches.clear();
        batches.put("x", List.of(batch(3, "x", 500, 10, 2, 50_000)));
        batches.put("y", List.of(batch(4, "y", 500, 10, 40, 50_000)));
        assertThat(run(Map.of(), Map.of())).extracting(HotOffers.Offer::variantId).startsWith("dx", "dy");
    }

    @Test
    void explanationNamesProductRiskAndLoss() {
        HotOffers.Offer first = run(Map.of(), Map.of()).getFirst();
        assertThat(HotOffers.explain(first, catalog).replace('\u00a0', ' '))
                .contains("salmon: под угрозой 300 г, истекает через 14 ч, пропадёт ≈ 360 ₽")
                .contains("Одна порция расходует 100 г");
    }
}
