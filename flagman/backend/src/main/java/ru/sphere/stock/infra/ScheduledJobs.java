package ru.sphere.stock.infra;

import java.time.Duration;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import ru.sphere.stock.antifraud.AnomalyService;
import ru.sphere.stock.demo.DemoService;
import ru.sphere.stock.redis.SharedStore;
import ru.sphere.stock.stock.ExpiryJob;

/**
 * Задачи по расписанию. Если серверов склада несколько, каждый такт выполняет один из них — тот, кто первым занял
 * блокировку в Redis ({@code lock:job:expiry}, SET NX PX); остальные этот такт пропускают. Блокировка живёт чуть
 * меньше такта, поэтому упавший сервер подменяется уже на следующем. Сами задачи безопасны и при повторе
 * (всё под блокировкой склада точки в базе) — Redis лишь убирает двойную работу.
 */
@Component
class ScheduledJobs {

    private final SharedStore shared;
    private final ExpiryJob expiry;
    private final AnomalyService anomalies;
    private final DemoService demo;

    ScheduledJobs(SharedStore shared, ExpiryJob expiry, AnomalyService anomalies, DemoService demo) {
        this.shared = shared;
        this.expiry = expiry;
        this.anomalies = anomalies;
        this.demo = demo;
    }

    /** Сроки годности, автосписание просрочки, часы склада в браузерах. */
    @Scheduled(fixedDelay = 2000, initialDelay = 3000)
    void expiry() {
        if (shared.tryLock("job:expiry", Duration.ofMillis(1900))) {
            expiry.tick();
        }
    }

    /** Антифрод: правила, которые проверяются периодически. */
    @Scheduled(fixedDelay = 15000, initialDelay = 10000)
    void anomalies() {
        if (shared.tryLock("job:anomalies", Duration.ofSeconds(14))) {
            anomalies.scan();
        }
    }

    /** Генератор заказов демо-стенда. */
    @Scheduled(fixedDelay = 2000, initialDelay = 5000)
    void demo() {
        if (shared.tryLock("job:demo", Duration.ofMillis(1900))) {
            demo.tick();
        }
    }
}
