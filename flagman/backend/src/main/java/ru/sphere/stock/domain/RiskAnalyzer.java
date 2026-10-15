package ru.sphere.stock.domain;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

/**
 * Шаг 1 горячих предложений (ТЗ 5.10): что реально пропадёт при текущих продажах.
 *
 * <p>Партии идут по FEFO. Прогноз продаж до срока партии сначала «съедается» более ранними
 * партиями (каждая — не больше своего остатка), остаток прогноза достаётся этой. Если ранняя
 * партия испортилась с остатком, продажи после её срока переходят на следующие — поэтому
 * копим именно проданное ({@code absorbed}), а не остатки.
 */
public final class RiskAnalyzer {

    /**
     * @param willSell сколько из партии успеют продать до её срока
     * @param atRisk   сколько пропадёт, если ничего не делать
     */
    public record BatchRisk(BatchState batch, long available, long willSell, long atRisk) {
    }

    private RiskAnalyzer() {
    }

    public static List<BatchRisk> analyze(Collection<BatchState> batches, double ratePerOpenHour,
                                          OpenHours hours, Instant now) {
        List<BatchRisk> out = new ArrayList<>();
        double absorbed = 0;
        for (BatchState b : Fefo.usableInOrder(batches, now)) {
            long avail = b.availableAt(now);
            double demandUntilExpiry = ratePerOpenHour * hours.hoursBetween(now, b.expiresAt());
            double sold = Math.max(0, Math.min(avail, demandUntilExpiry - absorbed));
            absorbed += sold;
            long willSell = Math.round(sold);
            out.add(new BatchRisk(b, avail, willSell, avail - willSell));
        }
        return out;
    }

    public static long totalAtRisk(List<BatchRisk> risks) {
        return risks.stream().mapToLong(BatchRisk::atRisk).sum();
    }
}
