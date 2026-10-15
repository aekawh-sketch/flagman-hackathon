package ru.sphere.stock.events;

import java.io.IOException;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * Реальное время через SSE (ТЗ 5.13): сервер → браузер. События — короткие сигналы
 * «что изменилось»; интерфейс по ним перезапрашивает данные.
 */
@Component
public class EventBus {

    private static final Logger log = LoggerFactory.getLogger(EventBus.class);

    /** Ключ в данных события со списком ролей-адресатов; пустой список — всем. */
    public static final String AUDIENCE = "audience";

    private final Map<String, Set<SseEmitter>> byLocation = new ConcurrentHashMap<>();
    /** Роль подписчика; нет записи — внешняя система по ключу, ей отдаём всё. */
    private final Map<SseEmitter, String> roles = new ConcurrentHashMap<>();
    private final AtomicLong ids = new AtomicLong();

    /** @param role роль сотрудника; {@code null} — внешняя система по ключу */
    public SseEmitter subscribe(String locationId, String role) {
        SseEmitter emitter = new SseEmitter(0L);
        Set<SseEmitter> set = byLocation.computeIfAbsent(locationId, k -> new CopyOnWriteArraySet<>());
        set.add(emitter);
        if (role != null) {
            roles.put(emitter, role);
        }
        Runnable drop = () -> {
            set.remove(emitter);
            roles.remove(emitter);
        };
        emitter.onCompletion(drop);
        emitter.onTimeout(drop);
        emitter.onError(e -> drop.run());
        send(emitter, set, "hello", Map.of("location", locationId));
        return emitter;
    }

    public void publish(String locationId, String type, Object data) {
        Set<SseEmitter> set = byLocation.get(locationId);
        if (set == null) {
            return;
        }
        for (SseEmitter e : set) {
            if (forRole(data, roles.get(e))) {
                send(e, set, type, data);
            }
        }
    }

    /** Событие с адресатами доходит только до них; без адресатов и внешним системам — всем. */
    private static boolean forRole(Object data, String role) {
        if (role == null || !(data instanceof Map<?, ?> m) || !(m.get(AUDIENCE) instanceof java.util.Collection<?> who)) {
            return true;
        }
        return who.isEmpty() || who.contains(role);
    }

    public void publishAll(String type, Object data) {
        byLocation.keySet().forEach(loc -> publish(loc, type, data));
    }

    private void send(SseEmitter e, Set<SseEmitter> set, String type, Object data) {
        try {
            e.send(SseEmitter.event().id(Long.toString(ids.incrementAndGet())).name(type)
                    .data(data, MediaType.APPLICATION_JSON));
        } catch (IOException | IllegalStateException ex) {
            set.remove(e);
            roles.remove(e);
            log.debug("SSE client dropped: {}", ex.getMessage());
        }
    }

    public int subscribers() {
        return byLocation.values().stream().mapToInt(Set::size).sum();
    }
}
