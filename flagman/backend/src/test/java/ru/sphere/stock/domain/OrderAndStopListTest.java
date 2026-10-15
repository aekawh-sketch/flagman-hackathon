package ru.sphere.stock.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static ru.sphere.stock.domain.Fixtures.raw;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** ТЗ 5.4, 5.5, 5.7: брутто/нетто, сеты, заказ «всё или ничего», стоп-лист. */
class OrderAndStopListTest {

    private final Fixtures.MemCatalog catalog = new Fixtures.MemCatalog()
            .product(raw("salmon"))
            .product(raw("rice"))
            .product(raw("cheese"))
            .product(ProductInfo.builder("potato", "Картофель", Unit.G).lossBp(2500).build())
            .dish("philadelphia", 43_000, RecipeLine.of("salmon", 100), RecipeLine.of("rice", 120),
                    RecipeLine.of("cheese", 30))
            .dish("poke", 45_000, RecipeLine.of("salmon", 120), RecipeLine.of("rice", 200))
            .dish("fries", 18_500, RecipeLine.of("potato", 150))
            .set("set2", new VariantDef.SetItem("philadelphia", 2), new VariantDef.SetItem("poke", 1));

    @Test
    void grossIsCeilingOfNetOverYieldWithoutFloatErrors() {
        assertThat(RecipeLine.gross(150, 2500)).isEqualTo(200);
        // 140 / 0.7 в double даёт 200.00000000000003 → ceil = 201. Целочисленно — ровно 200.
        assertThat(RecipeLine.gross(140, 3000)).isEqualTo(200);
        assertThat(RecipeLine.gross(100, 3000)).isEqualTo(143);
        assertThat(Requirements.perPortion("fries", catalog)).containsEntry("potato", 200L);
    }

    @Test
    void setExpandsRecursivelyAndCyclesAreRejected() {
        assertThat(Requirements.perPortion("set2", catalog))
                .containsEntry("salmon", 320L).containsEntry("rice", 440L).containsEntry("cheese", 60L);
        catalog.set("loopA", new VariantDef.SetItem("loopB", 1));
        catalog.set("loopB", new VariantDef.SetItem("loopA", 1));
        assertThatThrownBy(() -> Requirements.perPortion("loopA", catalog))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("Цикл");
    }

    @Test
    void needIsSummedAcrossLinesBeforeCheck() {
        // Филадельфия ×3 — 300 г лосося, поке ×1 — 120 г: каждой строке по отдельности 400 г хватает, вместе — нет.
        var need = Requirements.expand(List.of(new OrderLine("philadelphia", 3), new OrderLine("poke", 1)), catalog);
        var result = OrderCheck.check(need, Map.of("salmon", 400L, "rice", 10_000L, "cheese", 1_000L));

        assertThat(result.ok()).isFalse();
        assertThat(result.shortages()).singleElement().satisfies(s -> {
            assertThat(s.productId()).isEqualTo("salmon");
            assertThat(s.need()).isEqualTo(420);
            assertThat(s.available()).isEqualTo(400);
            assertThat(s.contributions()).extracting(OrderCheck.Contribution::gross).containsExactly(300L, 120L);
        });
        // «Максимум N, если остальные строки не менять»: филадельфия — (400−120)/100 = 2; поке — (400−300)/120 = 0.
        assertThat(result.maxima()).extracting(OrderCheck.LineMax::variantId, OrderCheck.LineMax::max)
                .containsExactly(org.assertj.core.groups.Tuple.tuple("philadelphia", 2),
                        org.assertj.core.groups.Tuple.tuple("poke", 0));
    }

    @Test
    void enoughStockPasses() {
        var need = Requirements.expand(List.of(new OrderLine("philadelphia", 2)), catalog);
        assertThat(OrderCheck.check(need, Map.of("salmon", 200L, "rice", 240L, "cheese", 60L)).ok()).isTrue();
    }

    @Test
    void stopListCountsPortionsAndNamesTheLimitingProduct() {
        Map<String, Long> avail = Map.of("salmon", 250L, "rice", 10_000L, "cheese", 1_000L);
        var p = StopList.portions("philadelphia", Requirements.perPortion("philadelphia", catalog), avail);
        assertThat(p.portions()).isEqualTo(2);
        assertThat(p.limiting()).isEqualTo("salmon");
        assertThat(p.low()).isTrue();

        var poke = StopList.portions("poke", Requirements.perPortion("poke", catalog), Map.of("salmon", 100L));
        assertThat(poke.inStop()).isTrue();
    }

    @Test
    void variantWithoutRecipeIsNotTracked() {
        catalog.variants.put("water", new VariantDef("water", "water", "Вода", 5_000, 0, List.of(), List.of()));
        var p = StopList.portions("water", Requirements.perPortion("water", catalog), Map.of());
        assertThat(p.tracked()).isFalse();
        assertThat(p.inStop()).isFalse();
    }
}
