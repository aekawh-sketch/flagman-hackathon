package ru.sphere.stock.events;

import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;
import ru.sphere.stock.menu.MenuService;
import ru.sphere.stock.redis.LocationCache;

/**
 * После коммита изменения склада: пересчитать стоп-лист и горячие предложения и сообщить браузерам
 * (ТЗ 5.7, 5.10 шаг 6, 5.13). События за 300 мс по одной точке склеиваются: при ускоренных демо-часах
 * заказы идут потоком, и пересчитывать на каждый — расточительно.
 */
@Component
public class DerivedStateListener {

    private static final Logger log = LoggerFactory.getLogger(DerivedStateListener.class);

    private final MenuService menu;
    private final LocationCache cache;
    private final EventBus bus;
    private final ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor(
            Thread.ofVirtual().name("derived-state").factory());
    private final Map<String, Set<String>> pending = new ConcurrentHashMap<>();

    public DerivedStateListener(MenuService menu, LocationCache cache, EventBus bus) {
        this.menu = menu;
        this.cache = cache;
        this.bus = bus;
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    public void onStockChanged(StockChanged e) {
        cache.changed(e.locationId());          // меню, горячие предложения и прогноз точки в Redis устарели — сразу
        boolean[] first = {false};
        pending.compute(e.locationId(), (k, v) -> {
            if (v == null) {
                v = ConcurrentHashMap.newKeySet();
                first[0] = true;
            }
            v.add(e.reason());
            return v;
        });
        if (first[0]) {
            executor.schedule(() -> flush(e.locationId()), 300, TimeUnit.MILLISECONDS);
        }
    }

    private void flush(String locationId) {
        Set<String> reasons = pending.remove(locationId);
        if (reasons == null) {
            return;
        }
        boolean stopChanged = false;
        try {
            stopChanged = menu.refreshStopList(locationId);
        } catch (RuntimeException ex) {
            log.warn("stop-list refresh failed for {}: {}", locationId, ex.getMessage());
        }
        bus.publish(locationId, "stock", Map.of("reasons", new LinkedHashSet<>(reasons), "stopList", stopChanged));
    }
}
