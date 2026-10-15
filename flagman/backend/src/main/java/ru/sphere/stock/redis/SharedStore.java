package ru.sphere.stock.redis;

import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.function.Consumer;

/**
 * Общее состояние серверов склада: кеш, счётчики, блокировки задач по расписанию и события между серверами.
 * На сервере — Redis ({@link RedisSharedStore}): все экземпляры склада видят одно и то же, перезапуск склада
 * ничего не стирает. В коробочной версии без Redis (профиль {@code no-redis}) — память процесса
 * ({@link LocalSharedStore}): поведение то же, но в пределах одного процесса.
 *
 * <p>Ключи — без общего префикса: его добавляет реализация ({@code flagman:} на сервере, свой у каждого прогона тестов).
 */
public interface SharedStore {

    /** Значение кеша (JSON → {@code type}); пусто — нет, истекло или Redis недоступен. */
    <T> Optional<T> get(String key, Class<T> type);

    /** Положить в кеш на {@code ttl}. */
    void put(String key, Object value, Duration ttl);

    void delete(String... keys);

    /** Значения счётчиков одним запросом; нет счётчика — 0. */
    List<Long> counters(List<String> keys);

    /** Счётчик +1 без срока жизни — версии данных. */
    long increment(String key);

    /** Попадание в окно: счётчик +1, срок окна задаётся первым попаданием. */
    record Hit(long count, Duration resetIn) {
    }

    /** Атомарно: +1 к счётчику окна {@code window} (ограничение частоты запросов, неверные пароли). */
    Hit hit(String key, Duration window);

    /** Занять задачу по расписанию на {@code ttl}: {@code true} — её выполняет этот сервер. */
    boolean tryLock(String name, Duration ttl);

    /** Отправить сообщение всем серверам склада, включая этот. */
    void publish(String channel, Object message);

    /** Получать сообщения канала (JSON) — от всех серверов. */
    void subscribe(String channel, Consumer<String> handler);
}
