package ru.sphere.stock.alerts;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.sphere.stock.events.EventBus;
import ru.sphere.stock.infra.AfterCommit;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.infra.AppClock;
import ru.sphere.stock.ledger.Actor;

/**
 * Сигнализация (ТЗ 5.8): система сама сообщает о проблемах. Один сигнал на пару «объект + тип»;
 * если его уже отметили «увидел», а событие повторилось — сигнал поднимается заново.
 */
@Service
public class AlertService {

    public record Alert(long id, String type, String severity, String objectType, String objectId, String title,
                        String body, Instant createdAt, Long ackBy, Instant ackAt) {
    }

    private static final Set<String> BOSSES = Set.of("MANAGER", "ADMIN");
    private static final Set<String> STOCK = Set.of("COOK", "STOREKEEPER", "MANAGER", "ADMIN");

    /**
     * Кому какой сигнал. Антифрод и запросы «одобрить или нет» — только управляющему и админу: кладовщику
     * незачем видеть «подозрительную операцию» про самого себя. Сроки и блокировка партий — тем, кто работает
     * со складом; отказ в заказе — кассе и руководству. Остальное (например, «закончилось — блюда в стопе») — всем.
     */
    public static final Map<String, Set<String>> AUDIENCE = Map.ofEntries(
            Map.entry("ANOMALY", BOSSES),
            Map.entry("WRITEOFF_PENDING", BOSSES),
            Map.entry("RETURN_PENDING", BOSSES),
            Map.entry("DELIVERY_APPROVAL", BOSSES),
            Map.entry("INVENTORY_APPROVAL", BOSSES),
            Map.entry("DELIVERY_DIFF", BOSSES),
            Map.entry("LATE_CANCEL", BOSSES),
            Map.entry("BATCH_SOON", STOCK),
            Map.entry("BATCH_CRITICAL", STOCK),
            Map.entry("BATCH_EXPIRED", STOCK),
            Map.entry("BATCH_BLOCKED", STOCK),
            Map.entry("ORDER_REFUSED", Set.of("CASHIER", "MANAGER", "ADMIN")),
            Map.entry("PRINTER_FAILED", Set.of("COOK", "MANAGER", "ADMIN")),
            Map.entry("PRICE_OUTLIER", Set.of("STOREKEEPER", "MANAGER", "ADMIN")));

    /** Видит ли роль сигнал этого типа; {@code null} — внешняя система по ключу, ей видно всё. */
    public static boolean visibleTo(String type, String role) {
        Set<String> who = AUDIENCE.get(type);
        return role == null || who == null || who.contains(role);
    }

    /** Типы, которых роль не видит, — для фильтра в запросах. */
    private static String[] hiddenFor(String role) {
        return AUDIENCE.keySet().stream().filter(t -> !visibleTo(t, role)).toArray(String[]::new);
    }

    /** Событие для живого потока: адресаты едут вместе с ним — поток отдаёт его только им. */
    private static Map<String, Object> event(String type, String severity, String objectType, String objectId,
                                             String title, String body) {
        Set<String> who = AUDIENCE.get(type);
        return Map.of("type", type, "severity", severity, "title", title, "body", body == null ? "" : body,
                "objectType", objectType, "objectId", objectId,
                EventBus.AUDIENCE, who == null ? List.of() : List.copyOf(who));
    }

    private final JdbcClient jdbc;
    private final EventBus bus;
    private final AppClock clock;

    public AlertService(JdbcClient jdbc, EventBus bus, AppClock clock) {
        this.jdbc = jdbc;
        this.bus = bus;
        this.clock = clock;
    }

    /**
     * Сигнал о событии (отказ, расхождение приёмки, вход в стоп): то же событие ещё раз поднимает
     * уже отмеченный сигнал заново. Для состояний, которые проверяются по кругу, — {@link #raiseOnce}.
     *
     * @return {@code true}, если сигнал новый или поднят заново
     */
    public boolean raise(String locationId, String type, String severity, String objectType, String objectId,
                         String title, String body, Instant at) {
        int n = jdbc.sql("""
                        INSERT INTO alerts (location_id, type, severity, object_type, object_id, title, body, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT (location_id, type, object_type, object_id) DO UPDATE
                        SET severity = EXCLUDED.severity, title = EXCLUDED.title, body = EXCLUDED.body,
                            created_at = EXCLUDED.created_at, ack_by = NULL, ack_at = NULL
                        WHERE alerts.ack_at IS NOT NULL""")
                .params(locationId, type, severity, objectType, objectId, title, body, Timestamp.from(at))
                .update();
        if (n > 0) {
            AfterCommit.run(() -> bus.publish(locationId, "alert",
                    event(type, severity, objectType, objectId, title, body)));
        }
        return n > 0;
    }

    /**
     * Сигнал о состоянии, которое проверяется по кругу (партия скоро истекает, критично, под списание):
     * поднимается один раз на объект и тип. «Увидел» остаётся в силе, пока состояние то же — иначе отметка
     * слетала бы на следующей проверке через 2 секунды. Переход в следующее состояние — это другой тип,
     * то есть новый сигнал.
     *
     * @return {@code true}, если сигнал новый
     */
    public boolean raiseOnce(String locationId, String type, String severity, String objectType, String objectId,
                             String title, String body, Instant at) {
        int n = jdbc.sql("""
                        INSERT INTO alerts (location_id, type, severity, object_type, object_id, title, body, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT (location_id, type, object_type, object_id) DO NOTHING""")
                .params(locationId, type, severity, objectType, objectId, title, body, Timestamp.from(at))
                .update();
        if (n > 0) {
            AfterCommit.run(() -> bus.publish(locationId, "alert",
                    event(type, severity, objectType, objectId, title, body)));
        }
        return n > 0;
    }

    /** Сигналы точки, которые видит эта роль ({@code null} — все). */
    public List<Alert> list(String locationId, boolean openOnly, int limit, String role) {
        return jdbc.sql("SELECT * FROM alerts WHERE location_id = ? AND NOT (type = ANY(?))"
                        + (openOnly ? " AND ack_at IS NULL" : "") + " ORDER BY created_at DESC LIMIT ?")
                .params(locationId, hiddenFor(role), limit)
                .query((rs, n) -> new Alert(rs.getLong("id"), rs.getString("type"), rs.getString("severity"),
                        rs.getString("object_type"), rs.getString("object_id"), rs.getString("title"),
                        rs.getString("body"), rs.getTimestamp("created_at").toInstant(),
                        (Long) rs.getObject("ack_by"),
                        rs.getTimestamp("ack_at") == null ? null : rs.getTimestamp("ack_at").toInstant()))
                .list();
    }

    public long openCount(String locationId) {
        return jdbc.sql("SELECT count(*) FROM alerts WHERE location_id = ? AND ack_at IS NULL")
                .param(locationId).query(Long.class).single();
    }

    @Transactional
    public void ack(String locationId, long id, Actor actor, String role) {
        int n = jdbc.sql("""
                        UPDATE alerts SET ack_by = ?, ack_at = ? WHERE id = ? AND location_id = ? AND ack_at IS NULL
                          AND NOT (type = ANY(?))""")
                .params(actor.userId(), Timestamp.from(clock.now()), id, locationId, hiddenFor(role)).update();
        if (n == 0) {
            throw ApiException.notFound("Сигнал");
        }
        AfterCommit.run(() -> bus.publish(locationId, "alert", Map.of("ack", id)));
    }

    @Transactional
    /**
     * «Отметить все» — все свои, и критичные тоже: человек сказал «увидел всё». Только свои: кладовщик не закроет
     * управляющему запрос на одобрение.
     */
    public int ackAll(String locationId, Actor actor, String role) {
        int n = jdbc.sql("""
                        UPDATE alerts SET ack_by = ?, ack_at = ? WHERE location_id = ? AND ack_at IS NULL
                          AND NOT (type = ANY(?))""")
                .params(actor.userId(), Timestamp.from(clock.now()), locationId, hiddenFor(role)).update();
        AfterCommit.run(() -> bus.publish(locationId, "alert", Map.of("ackAll", true)));
        return n;
    }
}
