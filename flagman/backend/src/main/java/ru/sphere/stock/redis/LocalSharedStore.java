package ru.sphere.stock.redis;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;
import ru.sphere.stock.infra.Json;

/**
 * {@link SharedStore} в памяти процесса — коробочная версия без Redis (профиль {@code no-redis}): один сервер,
 * делить состояние не с кем. Значения тоже хранятся JSON-ом — чтобы поведение не отличалось от Redis.
 */
@Component
@ConditionalOnProperty(name = "stock.redis.enabled", havingValue = "false")
public class LocalSharedStore implements SharedStore {

    private record Entry(String json, long count, long expiresAt) {
        boolean alive(long now) {
            return expiresAt > now;
        }
    }

    private final Json json;
    private final Map<String, Entry> entries = new ConcurrentHashMap<>();
    private final Map<String, List<Consumer<String>>> handlers = new ConcurrentHashMap<>();
    private final AtomicLong writes = new AtomicLong();

    public LocalSharedStore(Json json) {
        this.json = json;
    }

    @Override
    public <T> Optional<T> get(String key, Class<T> type) {
        Entry e = alive(key);
        return e == null || e.json() == null ? Optional.empty() : Optional.of(json.read(e.json(), type));
    }

    @Override
    public void put(String key, Object value, Duration ttl) {
        write(key, new Entry(json.write(value), 0, now() + ttl.toMillis()));
    }

    @Override
    public void delete(String... keys) {
        for (String k : keys) {
            entries.remove(k);
        }
    }

    @Override
    public List<Long> counters(List<String> keys) {
        return keys.stream().map(k -> {
            Entry e = alive(k);
            return e == null ? 0L : e.count();
        }).toList();
    }

    @Override
    public long increment(String key) {
        long expires = now() + Duration.ofDays(7).toMillis();
        return entries.compute(key, (k, e) -> new Entry(null, (e == null || !e.alive(now()) ? 0 : e.count()) + 1,
                expires)).count();
    }

    @Override
    public Hit hit(String key, Duration window) {
        long now = now();
        Entry e = entries.compute(key, (k, old) -> old == null || !old.alive(now)
                ? new Entry(null, 1, now + window.toMillis())
                : new Entry(null, old.count() + 1, old.expiresAt()));
        return new Hit(e.count(), Duration.ofMillis(e.expiresAt() - now));
    }

    @Override
    public boolean tryLock(String name, Duration ttl) {
        long now = now();
        boolean[] mine = {false};
        entries.compute("lock:" + name, (k, e) -> {
            if (e != null && e.alive(now)) {
                return e;
            }
            mine[0] = true;
            return new Entry(null, 1, now + ttl.toMillis());
        });
        return mine[0];
    }

    @Override
    public void publish(String channel, Object message) {
        String payload = json.write(message);
        handlers.getOrDefault(channel, List.of()).forEach(h -> h.accept(payload));
    }

    @Override
    public void subscribe(String channel, Consumer<String> handler) {
        handlers.computeIfAbsent(channel, c -> new CopyOnWriteArrayList<>()).add(handler);
    }

    private Entry alive(String key) {
        Entry e = entries.get(key);
        return e != null && e.alive(now()) ? e : null;
    }

    /** Истёкшее убираем по ходу записи: у Redis это делает срок жизни ключа. */
    private void write(String key, Entry e) {
        entries.put(key, e);
        if (writes.incrementAndGet() % 256 == 0) {
            long now = now();
            entries.values().removeIf(x -> !x.alive(now));
        }
    }

    private static long now() {
        return System.currentTimeMillis();
    }
}
