package ru.sphere.stock.redis;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.dao.DataAccessException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;
import org.springframework.stereotype.Component;
import ru.sphere.stock.infra.Json;
import tools.jackson.core.JacksonException;

/**
 * {@link SharedStore} в Redis. Значения — JSON-строки со сроком жизни, счётчики — INCR, события — Pub/Sub.
 *
 * <p>Redis здесь ускоряет и связывает серверы, но не хранит ничего, без чего склад неверен: источник правды —
 * PostgreSQL. Поэтому при недоступном Redis склад продолжает работать: кеш промахивается и считается заново,
 * ограничение частоты пропускает, события доставляются в пределах этого сервера.
 */
@Component
@ConditionalOnProperty(name = "stock.redis.enabled", havingValue = "true", matchIfMissing = true)
public class RedisSharedStore implements SharedStore {

    private static final Logger log = LoggerFactory.getLogger(RedisSharedStore.class);

    /** Счётчик окна: INCR и срок окна при первом попадании — одним атомарным скриптом, без гонки между командами. */
    private static final RedisScript<List> HIT = RedisScript.of("""
            local n = redis.call('INCR', KEYS[1])
            if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
            return {n, redis.call('PTTL', KEYS[1])}
            """, List.class);

    /** Версия данных: +1, срок жизни продлевается — забытые версии (точку удалили) исчезнут сами. */
    private static final RedisScript<Long> INCREMENT = RedisScript.of("""
            local n = redis.call('INCR', KEYS[1])
            redis.call('PEXPIRE', KEYS[1], ARGV[1])
            return n
            """, Long.class);

    private static final Duration VERSION_TTL = Duration.ofDays(7);

    private final StringRedisTemplate redis;
    private final RedisMessageListenerContainer listeners;
    private final Json json;
    private final String prefix;
    private final Map<String, List<Consumer<String>>> handlers = new ConcurrentHashMap<>();
    private volatile long warnedAt;

    public RedisSharedStore(StringRedisTemplate redis, RedisMessageListenerContainer listeners, Json json,
                            @Value("${stock.redis.prefix:flagman:}") String prefix) {
        this.redis = redis;
        this.listeners = listeners;
        this.json = json;
        this.prefix = prefix;
    }

    /** Префикс ключей и каналов этого склада: {@code flagman:}. */
    public String prefix() {
        return prefix;
    }

    @Override
    public <T> Optional<T> get(String key, Class<T> type) {
        try {
            String value = redis.opsForValue().get(prefix + key);                         // GET
            return value == null ? Optional.empty() : Optional.of(json.read(value, type));
        } catch (DataAccessException e) {
            unavailable(e);
        } catch (JacksonException e) {
            log.debug("cache entry {} is unreadable, recomputing: {}", key, e.getMessage());   // формат сменился
        }
        return Optional.empty();
    }

    @Override
    public void put(String key, Object value, Duration ttl) {
        try {
            redis.opsForValue().set(prefix + key, json.write(value), ttl);                 // SET … PX
        } catch (DataAccessException e) {
            unavailable(e);
        }
    }

    @Override
    public void delete(String... keys) {
        try {
            redis.delete(java.util.Arrays.stream(keys).map(k -> prefix + k).toList());   // DEL
        } catch (DataAccessException e) {
            unavailable(e);
        }
    }

    @Override
    public List<Long> counters(List<String> keys) {
        try {
            List<String> values = redis.opsForValue().multiGet(keys.stream().map(k -> prefix + k).toList());   // MGET
            if (values != null) {
                return values.stream().map(v -> v == null ? 0L : Long.parseLong(v)).toList();
            }
        } catch (DataAccessException e) {
            unavailable(e);
        }
        return keys.stream().map(k -> -1L).toList();      // −1: версию не узнать — ключ, которого нет в кеше
    }

    @Override
    public long increment(String key) {
        try {
            Long n = redis.execute(INCREMENT, List.of(prefix + key), Long.toString(VERSION_TTL.toMillis()));
            return n == null ? 0 : n;
        } catch (DataAccessException e) {
            unavailable(e);
            return 0;
        }
    }

    @Override
    public Hit hit(String key, Duration window) {
        try {
            List<?> r = redis.execute(HIT, List.of(prefix + key), Long.toString(window.toMillis()));
            if (r != null && r.size() == 2) {
                long ttl = ((Number) r.get(1)).longValue();
                return new Hit(((Number) r.get(0)).longValue(), ttl > 0 ? Duration.ofMillis(ttl) : window);
            }
        } catch (DataAccessException e) {
            unavailable(e);
        }
        return new Hit(0, window);                         // Redis недоступен — не ограничиваем
    }

    @Override
    public boolean tryLock(String name, Duration ttl) {
        try {
            return Boolean.TRUE.equals(redis.opsForValue().setIfAbsent(prefix + "lock:" + name, "1", ttl));   // SET NX PX
        } catch (DataAccessException e) {
            unavailable(e);
            return true;                                   // один сервер без Redis всё равно должен списывать просрочку
        }
    }

    @Override
    public void publish(String channel, Object message) {
        String payload = json.write(message);
        try {
            Long receivers = redis.convertAndSend(prefix + channel, payload);             // PUBLISH
            if (receivers != null && receivers > 0) {
                return;
            }
            // Никто не подписан — значит, и этот сервер ещё переподключается к Redis: доставим своим сами
        } catch (DataAccessException e) {
            unavailable(e);
        }
        handlers.getOrDefault(channel, List.of()).forEach(h -> h.accept(payload));
    }

    @Override
    public void subscribe(String channel, Consumer<String> handler) {
        handlers.computeIfAbsent(channel, c -> new CopyOnWriteArrayList<>()).add(handler);
        listeners.addMessageListener((message, pattern) -> handler.accept(
                new String(message.getBody(), StandardCharsets.UTF_8)), new ChannelTopic(prefix + channel));   // SUBSCRIBE
    }

    /** Предупреждение — не чаще раза в минуту: при упавшем Redis им был бы забит весь журнал. */
    private void unavailable(DataAccessException e) {
        long now = System.currentTimeMillis();
        if (now - warnedAt > 60_000) {
            warnedAt = now;
            log.warn("Redis недоступен — работаем без общего кеша: {}", e.getMessage());
        }
    }
}
