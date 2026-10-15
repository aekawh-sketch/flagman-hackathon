package ru.sphere.stock.redis;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Predicate;
import java.util.function.Supplier;
import org.springframework.stereotype.Component;

/**
 * Кеш данных, которые выводятся из склада точки: меню со стоп-листом, горячие предложения, прогноз расхода.
 * Два уровня: L2 — Redis, общий для всех серверов склада и переживает перезапуск; L1 — последнее значение
 * прямо в памяти этого сервера, чтобы не гонять его по сети и не разбирать JSON на каждый запрос.
 *
 * <p>В ключе — версия склада точки: {@code menu:kush:v3.418}. Любое изменение склада (заказ, поставка, списание…)
 * увеличивает версию в Redis на 1 — и все записи точки разом перестают читаться на всех серверах: каждый запрос
 * сверяет версию одним коротким MGET, и L1 с устаревшей версией не используется. Удалять записи не нужно (их уберёт
 * срок жизни), и нет гонки «пересчитал по старым данным — положил уже после сброса»: такое значение ляжет под
 * старую версию, которую никто не прочтёт. Версия читается до расчёта, поэтому расчёт видит всё, что зафиксировано
 * до неё. Первая часть версии — общая: её увеличивает сброс демо-данных или каталога всех предприятий.
 */
@Component
public class LocationCache {

    private static final String ALL = "ver:all";

    /** L1: по одной записи на «что и где» ({@code menu:kush}) — объём не растёт со временем. */
    private record Near(String key, Object value, long expiresAt) {
    }

    private final SharedStore store;
    private final Map<String, Near> near = new ConcurrentHashMap<>();

    public LocationCache(SharedStore store) {
        this.store = store;
    }

    /**
     * Значение из кеша, а нет его — посчитать и положить.
     *
     * @param kind   что кешируем: {@code menu}, {@code hot}, {@code forecast}
     * @param bucket отрезок времени, если значение зависит от часов (например, номер часа); {@code null} — нет
     * @param fresh  годится ли найденное значение ещё и по времени склада
     */
    public <T> T get(String locationId, String kind, Object bucket, Class<T> type, Duration ttl,
                     Predicate<T> fresh, Supplier<T> compute) {
        String key = key(locationId, kind, bucket);                 // MGET версий — один короткий запрос в Redis
        if (key == null) {
            return compute.get();                                   // Redis недоступен: версий не знаем — считаем сами
        }
        Near n = near.get(kind + ":" + locationId);
        if (n != null && n.key().equals(key) && n.expiresAt() > System.currentTimeMillis()
                && type.isInstance(n.value()) && fresh.test(type.cast(n.value()))) {
            return type.cast(n.value());                            // L1: версия та же — значение уже в памяти
        }
        T value = store.get(key, type).filter(fresh).orElse(null);  // L2: возможно, посчитал другой сервер
        if (value == null) {
            value = compute.get();
            store.put(key, value, ttl);
        }
        remember(locationId, kind, key, value, ttl);
        return value;
    }

    /** Посчитать заново и положить, не заглядывая в кеш (стоп-лист пересчитывается после каждого изменения). */
    public <T> T refresh(String locationId, String kind, Object bucket, Duration ttl, Supplier<T> compute) {
        String key = key(locationId, kind, bucket);
        T value = compute.get();
        if (key != null) {
            store.put(key, value, ttl);
            remember(locationId, kind, key, value, ttl);
        }
        return value;
    }

    /** Только то, что уже лежит в кеше, — без расчёта. */
    public <T> Optional<T> peek(String locationId, String kind, Object bucket, Class<T> type) {
        String key = key(locationId, kind, bucket);
        if (key == null) {
            return Optional.empty();
        }
        Near n = near.get(kind + ":" + locationId);
        if (n != null && n.key().equals(key) && type.isInstance(n.value())) {
            return Optional.of(type.cast(n.value()));
        }
        return store.get(key, type);
    }

    /** Склад точки изменился — всё, что из него выведено, устарело на всех серверах. */
    public void changed(String locationId) {
        store.increment("ver:" + locationId);
    }

    /** Устарело всё у всех точек: сброс демо-данных, каталог всех предприятий. */
    public void changedAll() {
        store.increment(ALL);
    }

    private void remember(String locationId, String kind, String key, Object value, Duration ttl) {
        near.put(kind + ":" + locationId, new Near(key, value, System.currentTimeMillis() + ttl.toMillis()));
    }

    /** {@code null} — версий не узнать (Redis недоступен). */
    private String key(String locationId, String kind, Object bucket) {
        List<Long> v = store.counters(List.of(ALL, "ver:" + locationId));       // обе версии — одним MGET
        if (v.get(0) < 0 || v.get(1) < 0) {
            return null;
        }
        return kind + ":" + locationId + ":v" + v.get(0) + "." + v.get(1) + (bucket == null ? "" : ":" + bucket);
    }
}
