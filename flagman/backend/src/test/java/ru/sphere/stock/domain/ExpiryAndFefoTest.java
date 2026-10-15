package ru.sphere.stock.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.tuple;
import static ru.sphere.stock.domain.Fixtures.NOW;
import static ru.sphere.stock.domain.Fixtures.batch;
import static ru.sphere.stock.domain.Fixtures.inHours;
import static ru.sphere.stock.domain.Fixtures.raw;

import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;

/** ТЗ 5.2: окна сроков, статусы, FEFO, вскрытие. */
class ExpiryAndFefoTest {

    @Test
    void soonWindowIsQuarterOfLifeClampedTo1And72Hours() {
        ProductInfo p = raw("x");
        // Сливки: срок 72 ч → окно 18 ч.
        assertThat(ExpiryPolicy.soonWindow(batch(1, "x", 1, 0, 72), p)).isEqualTo(Duration.ofHours(18));
        // Мука: 30 дней → 25% = 7,5 дня, но не больше 72 ч.
        assertThat(ExpiryPolicy.soonWindow(batch(1, "x", 1, 0, 720), p)).isEqualTo(Duration.ofHours(72));
        // Варёная тапиока: 4 ч → 25% = 1 ч, а не «сразу истекает».
        assertThat(ExpiryPolicy.soonWindow(batch(1, "x", 1, 0, 4), p)).isEqualTo(Duration.ofHours(1));
        assertThat(ExpiryPolicy.status(batch(1, "x", 1, 0, 4), p, NOW)).isEqualTo(BatchStatus.FRESH);
    }

    @Test
    void statusMovesFreshSoonCriticalExpired() {
        ProductInfo p = raw("x");
        BatchState cream = batch(1, "x", 1000, 0, 72); // окно «скоро» 18 ч, «критично» 4,5 ч
        assertThat(ExpiryPolicy.status(cream, p, NOW)).isEqualTo(BatchStatus.FRESH);
        assertThat(ExpiryPolicy.status(cream, p, inHours(55))).isEqualTo(BatchStatus.SOON);
        assertThat(ExpiryPolicy.status(cream, p, inHours(68))).isEqualTo(BatchStatus.CRITICAL);
        assertThat(ExpiryPolicy.status(cream, p, inHours(72))).isEqualTo(BatchStatus.EXPIRED);
    }

    @Test
    void productThresholdOverridesDefault() {
        ProductInfo fish = ProductInfo.builder("fish", "Лосось", Unit.G).alertBefore(Duration.ofHours(12)).build();
        assertThat(ExpiryPolicy.soonWindow(batch(1, "fish", 1, 0, 96), fish)).isEqualTo(Duration.ofHours(12));
        assertThat(ExpiryPolicy.criticalWindow(batch(1, "fish", 1, 0, 96), fish)).isEqualTo(Duration.ofHours(3));
    }

    @Test
    void fefoTakesShorterExpiryEvenIfItArrivedLater() {
        BatchState old = batch(1, "cream", 500, 48, 120);   // пришла 2 дня назад, живёт ещё 5 дней
        BatchState fresh = batch(2, "cream", 500, 1, 24);   // пришла час назад, но истекает завтра
        List<Fefo.Take> takes = Fefo.allocate(List.of(old, fresh), 700, NOW);
        assertThat(takes).extracting(t -> t.batch().id(), Fefo.Take::qty)
                .containsExactly(tuple(2L, 500L), tuple(1L, 200L));
    }

    @Test
    void expiredBlockedAndHeldAreNotAvailable() {
        BatchState expired = batch(1, "x", 100, 10, -1);
        BatchState blocked = new BatchState(2, "x", 100, 0, NOW, inHours(10), NOW, false, true, 0, 100);
        BatchState held = new BatchState(3, "x", 100, 30, NOW, inHours(10), NOW, false, false, 0, 100);
        assertThat(Fefo.available(List.of(expired, blocked, held), NOW)).isEqualTo(70);
        assertThatThrownBy(() -> Fefo.allocate(List.of(expired, blocked, held), 71, NOW))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void batchBecomesUnavailableExactlyAtExpiry() {
        BatchState b = batch(1, "x", 100, 0, 5);
        assertThat(b.availableAt(inHours(4.99))).isEqualTo(100);
        assertThat(b.availableAt(inHours(5))).isZero();
    }

    @Test
    void openedBatchGoesFirstOnEqualExpiry() {
        BatchState sealed = batch(1, "x", 100, 5, 10);
        BatchState opened = new BatchState(2, "x", 100, 0, NOW, inHours(10), NOW, true, false, 0, 100);
        assertThat(Fefo.usableInOrder(List.of(sealed, opened), NOW)).extracting(BatchState::id)
                .containsExactly(2L, 1L);
    }

    @Test
    void partialPackIsSplitIntoOpenedSubBatchWithShortExpiry() {
        ProductInfo cream = ProductInfo.builder("cream", "Сливки", Unit.ML)
                .pack(1000).afterOpen(Duration.ofDays(3)).build();
        BatchState b = batch(1, "cream", 5000, 0, 240); // 5 пачек по 1 л, живут 10 дней
        // Взяли 300 мл → начатая пачка: 700 мл уходят во вскрытую подпартию со сроком 3 дня.
        OpeningRule.Split split = OpeningRule.afterTake(b, 300, cream, NOW).orElseThrow();
        assertThat(split.qty()).isEqualTo(700);
        assertThat(split.expiresAt()).isEqualTo(NOW.plus(Duration.ofDays(3)));
        // Взяли ровно пачку — подпартии нет.
        assertThat(OpeningRule.afterTake(b, 1000, cream, NOW)).isEmpty();
        // Срок вскрытой не может быть позже срока родителя.
        BatchState almostExpired = batch(2, "cream", 2000, 200, 24);
        assertThat(OpeningRule.afterTake(almostExpired, 100, cream, NOW).orElseThrow().expiresAt())
                .isEqualTo(inHours(24));
    }

    @Test
    void manualOpenValidatesPacks() {
        ProductInfo cream = ProductInfo.builder("cream", "Сливки", Unit.ML)
                .pack(1000).afterOpen(Duration.ofDays(3)).build();
        BatchState b = batch(1, "cream", 2000, 0, 240);
        assertThat(OpeningRule.open(b, 1, cream, NOW).qty()).isEqualTo(1000);
        assertThatThrownBy(() -> OpeningRule.open(b, 3, cream, NOW)).isInstanceOf(IllegalArgumentException.class);
    }
}
