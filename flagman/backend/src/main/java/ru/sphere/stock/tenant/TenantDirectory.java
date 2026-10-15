package ru.sphere.stock.tenant;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import ru.sphere.stock.infra.ApiException;

/**
 * Чья это точка (ТЗ 16.4). Точки создаются редко, а спрашивают о них на каждом запросе — поэтому
 * кэш «точка → предприятие» в памяти, сбрасывается при создании точки или предприятия.
 */
@Service
public class TenantDirectory {

    /** Демо-предприятие: в него переехали все данные до версии 2; его сбрасывает «Пересоздать демо-данные». */
    public static final long DEMO = 1L;

    private static volatile TenantDirectory instance;

    private final JdbcClient jdbc;
    private volatile Map<String, Long> tenantOfLocation;

    public TenantDirectory(JdbcClient jdbc) {
        this.jdbc = jdbc;
        instance = this;
    }

    /** Для статических проверок прав ({@code Access}): там нет внедрения зависимостей. */
    public static TenantDirectory get() {
        return instance;
    }

    /** Предприятие точки; {@code null} — такой точки нет. */
    public Long tenantOfOrNull(String locationId) {
        if (locationId == null) {
            return null;
        }
        Long t = map().get(locationId);
        if (t == null) {
            invalidate();               // точку могли создать в другом потоке минуту назад
            t = map().get(locationId);
        }
        return t;
    }

    public long tenantOf(String locationId) {
        Long t = tenantOfOrNull(locationId);
        if (t == null) {
            throw ApiException.notFound("Точка");
        }
        return t;
    }

    public List<String> locations(long tenantId) {
        return map().entrySet().stream().filter(e -> e.getValue() == tenantId).map(Map.Entry::getKey).sorted().toList();
    }

    public List<String> allLocations() {
        return map().keySet().stream().sorted().toList();
    }

    public String name(long tenantId) {
        return jdbc.sql("SELECT name FROM tenants WHERE id = ?").param(tenantId).query(String.class).optional()
                .orElse("—");
    }

    public void invalidate() {
        tenantOfLocation = null;
    }

    private Map<String, Long> map() {
        Map<String, Long> m = tenantOfLocation;
        if (m == null) {
            Map<String, Long> fresh = new ConcurrentHashMap<>();
            jdbc.sql("SELECT id, tenant_id FROM locations").query(rs -> {
                fresh.put(rs.getString(1), rs.getLong(2));
            });
            tenantOfLocation = m = fresh;
        }
        return m;
    }
}
