package ru.sphere.stock.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static ru.sphere.stock.domain.Fixtures.HOURS;
import static ru.sphere.stock.domain.Fixtures.NOW;
import static ru.sphere.stock.domain.Fixtures.batch;
import static ru.sphere.stock.domain.Fixtures.inHours;
import static ru.sphere.stock.domain.Fixtures.raw;

import java.time.Duration;
import java.time.LocalTime;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** ТЗ 5.9, 5.10 (шаг 1), 5.12 (Д4), 5.4 (заготовки), 4.2 (деньги). */
class ForecastTest {

    @Test
    void openHoursCountOnlyWorkingTime() {
        // 10:00–23:00 МСК = 13 ч в день; с 10:00 сегодня до 10:00 завтра — 13 ч.
        assertThat(HOURS.hoursBetween(NOW, inHours(24))).isEqualTo(13.0);
        assertThat(HOURS.hoursBetween(inHours(13), inHours(24))).isZero(); // 23:00 → 10:00 ночью
        OpenHours late = new OpenHours(LocalTime.of(18, 0), LocalTime.of(2, 0), OpenHours.MSK);
        assertThat(late.hoursPerDay()).isEqualTo(8.0);
        assertThat(late.hoursBetween(NOW, inHours(24))).isEqualTo(8.0);
    }

    @Test
    void fastMovingProductIsNotAtRiskSlowOneIs() {
        BatchState cream = batch(1, "cream", 2000, 40, 9); // истекает в 19:00, 9 рабочих часов
        // Расход 300 мл/ч → за 9 ч продадим 2,7 л: всё уйдёт.
        assertThat(RiskAnalyzer.totalAtRisk(RiskAnalyzer.analyze(List.of(cream), 300, HOURS, NOW))).isZero();
        // Расход 100 мл/ч → продадим 900 мл, пропадёт 1,1 л.
        assertThat(RiskAnalyzer.totalAtRisk(RiskAnalyzer.analyze(List.of(cream), 100, HOURS, NOW))).isEqualTo(1100);
    }

    @Test
    void salesAfterEarlyBatchExpiryFlowToNextBatch() {
        BatchState early = batch(1, "x", 1000, 10, 2);  // за 2 ч продадим 200 — 800 пропадёт
        BatchState later = batch(2, "x", 500, 10, 10);  // до её срока спрос 1000, 200 ушло в первую → 500 уйдут все
        var risks = RiskAnalyzer.analyze(List.of(early, later), 100, HOURS, NOW);
        assertThat(risks).extracting(RiskAnalyzer.BatchRisk::atRisk).containsExactly(800L, 0L);
    }

    @Test
    void purchaseCountsWhatExpiresBeforeArrivalAndIsCappedByShelfLife() {
        ProductInfo milk = ProductInfo.builder("milk", "Молоко", Unit.ML)
                .pack(1000).shelfLife(Duration.ofDays(2)).leadTime(Duration.ofDays(1)).build();
        BatchState expiring = batch(1, "milk", 3000, 48, 5); // истечёт до поставки
        BatchState ok = batch(2, "milk", 1000, 10, 72);
        // Расход 200 мл/ч × 13 ч = 2,6 л в день.
        var s = PurchasePlanner.plan(milk, List.of(expiring, ok), 200, HOURS, NOW,
                PurchasePlanner.DEFAULT_REVIEW, PurchasePlanner.DEFAULT_SAFETY_DAYS);
        assertThat(s.expiresBefore()).isEqualTo(2000); // 5 ч × 200 = 1 л продали, 2 л пропадёт
        // С 15:00 до 23:00 спрос 1,6 л переходит на вторую партию — к поставке от неё ничего не останется.
        assertThat(s.survives()).isZero();
        // Нужно: 2,6 л (день) + 1,3 л (запас) − 0 = 3,9 л → округляем до пачки → 4 л.
        assertThat(s.orderQty()).isEqualTo(4000);
    }

    @Test
    void purchaseIsCappedByWhatWeCanSellBeforeNewBatchSpoils() {
        ProductInfo herbs = ProductInfo.builder("herbs", "Зелень", Unit.G).shelfLife(Duration.ofHours(24)).build();
        // Расход 10 г/ч: за 24 ч после прихода продадим 130 г — больше заказывать бессмысленно.
        var s = PurchasePlanner.plan(herbs, List.of(), 10, HOURS, NOW, Duration.ofDays(3), 0.5);
        assertThat(s.orderQty()).isEqualTo(130);
        assertThat(s.cappedByLife()).isTrue();
    }

    @Test
    void stopForecastSeesExpiryAndConsumption() {
        Map<String, Map<String, Long>> perPortion = Map.of(
                "caesar", Map.of("chicken", 100L),
                "roll", Map.of("salmon", 100L));
        Map<String, List<BatchState>> batches = Map.of(
                "chicken", List.of(batch(1, "chicken", 5000, 10, 8)),   // много, но истечёт в 18:00
                "salmon", List.of(batch(2, "salmon", 450, 10, 100)));   // 450 г, расход 50 г/ч
        var etas = StopForecast.forecast(perPortion, batches,
                Map.of("chicken", 100.0, "salmon", 50.0), HOURS, NOW, Duration.ofHours(48), Duration.ofMinutes(15));
        assertThat(etas).anySatisfy(e -> {
            assertThat(e.variantId()).isEqualTo("caesar");
            assertThat(e.at()).isEqualTo(inHours(8));
            assertThat(e.cause()).isEqualTo(StopForecast.Cause.EXPIRED);
        });
        // Лосось: меньше 100 г останется после 7 ч продаж (450 − 7×50 = 100 → ещё чуть-чуть).
        assertThat(etas).anySatisfy(e -> {
            assertThat(e.variantId()).isEqualTo("roll");
            assertThat(e.cause()).isEqualTo(StopForecast.Cause.CONSUMED);
            assertThat(e.at()).isBetween(inHours(7), inHours(7.5));
        });
    }

    @Test
    void semiFinishedExpiryIsCappedByEarliestRawBatch() {
        Fixtures.MemCatalog catalog = new Fixtures.MemCatalog()
                .product(raw("cream"))
                .product(raw("cheese"))
                .product(ProductInfo.builder("sauce", "Сырный соус", Unit.G).semi().shelfLife(Duration.ofHours(48)).build());
        var lines = List.of(RecipeLine.of("cream", 600), RecipeLine.of("cheese", 400)); // на 1000 г
        var batches = Map.of(
                "cream", List.of(batch(1, "cream", 1000, 60, 6, 30_000)),   // истекает через 6 ч
                "cheese", List.of(batch(2, "cheese", 1000, 10, 200, 80_000)));
        var r = Production.plan(catalog.product("sauce"), lines, 1000, 500, batches, catalog, NOW);
        assertThat(r.ok()).isTrue();
        assertThat(r.plan().needs()).containsEntry("cream", 300L).containsEntry("cheese", 200L);
        assertThat(r.plan().expiresAt()).isEqualTo(inHours(6)); // не 48 ч: сливки истекают раньше
        assertThat(r.plan().costKop()).isEqualTo(9_000 + 16_000);

        var tooMuch = Production.plan(catalog.product("sauce"), lines, 1000, 5000, batches, catalog, NOW);
        assertThat(tooMuch.ok()).isFalse();
        assertThat(Production.maxAmount(lines, 1000, Map.of("cream", 1000L, "cheese", 1000L), catalog))
                .isEqualTo(1666);
    }

    @Test
    void moneyShareRoundsToKopeck() {
        assertThat(Money.share(10_000, 1, 3)).isEqualTo(3_333);
        assertThat(Money.share(10_000, 2, 3)).isEqualTo(6_667);
        assertThat(Money.format(123_450)).isEqualTo("1\u00a0234,50\u00a0₽");
    }
}
