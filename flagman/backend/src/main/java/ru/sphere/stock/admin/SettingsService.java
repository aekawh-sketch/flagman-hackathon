package ru.sphere.stock.admin;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import ru.sphere.stock.tenant.TenantDirectory;
import org.springframework.transaction.annotation.Transactional;
import ru.sphere.stock.infra.ApiException;

/** Настройки по умолчанию из ТЗ 4.4 (меняются в админке). */
@Service
public class SettingsService {

    public static final String RESTAURANT_NAME = "restaurant_name";
    public static final String WRITEOFF_THRESHOLD_KOP = "writeoff_threshold_kop";
    public static final String A1_FACTOR = "anomaly_a1_factor";
    public static final String A2_FRESH_SHARE = "anomaly_a2_fresh_share";
    public static final String A3_CLOSING_SHARE = "anomaly_a3_closing_share";
    public static final String A5_LATE_CANCELS = "anomaly_a5_late_cancels";
    public static final String A6_RECIPE_GROWTH = "anomaly_a6_recipe_growth";
    public static final String GENERATOR_ENABLED = "generator_enabled";
    /** Д1 из PDF. По умолчанию выключено: просрочку списывает человек (ТЗ 16.1, шаг 6). */
    public static final String AUTO_WRITEOFF_EXPIRED = "auto_writeoff_expired";
    /** Касса — в панели ресторана, не во Флагмане: адрес, куда отправляем кассира. */
    public static final String POS_URL = "pos_url";

    public static final Map<String, String> DEFAULTS = new LinkedHashMap<>();

    static {
        DEFAULTS.put(RESTAURANT_NAME, "Демо-ресторан");
        DEFAULTS.put(WRITEOFF_THRESHOLD_KOP, "100000");
        DEFAULTS.put(A1_FACTOR, "3");
        DEFAULTS.put(A2_FRESH_SHARE, "0.5");
        DEFAULTS.put(A3_CLOSING_SHARE, "0.4");
        DEFAULTS.put(A5_LATE_CANCELS, "3");
        DEFAULTS.put(A6_RECIPE_GROWTH, "0.2");
        DEFAULTS.put(GENERATOR_ENABLED, "true");
        DEFAULTS.put(AUTO_WRITEOFF_EXPIRED, "false");
        // Касса — общая панель ресторанов (сервер ИСТОК): у нового предприятия она открывается сразу,
        // сотрудник входит своим логином и выбирает место работы. Другой адрес — переменная PANEL_URL
        DEFAULTS.put(POS_URL, System.getenv().getOrDefault("PANEL_URL", "http://localhost:3001/panel/login.html"));
    }

    private final JdbcClient jdbc;
    private final TenantDirectory tenants;

    public SettingsService(JdbcClient jdbc, TenantDirectory tenants) {
        this.jdbc = jdbc;
        this.tenants = tenants;
    }

    /** Настройки у каждого предприятия свои (ТЗ 16.4); не заданное — значение по умолчанию. */
    public String get(long tenantId, String key) {
        return jdbc.sql("SELECT value FROM settings WHERE tenant_id = ? AND key = ?").params(tenantId, key)
                .query(String.class).optional().orElse(DEFAULTS.get(key));
    }

    public long getLong(long tenantId, String key) {
        return Long.parseLong(get(tenantId, key));
    }

    public double getDouble(long tenantId, String key) {
        return Double.parseDouble(get(tenantId, key));
    }

    public boolean getBool(long tenantId, String key) {
        return "true".equals(get(tenantId, key));
    }

    /** Настройка предприятия, которому принадлежит точка. */
    public String forLocation(String locationId, String key) {
        return get(tenants.tenantOf(locationId), key);
    }

    public long getLongFor(String locationId, String key) {
        return Long.parseLong(forLocation(locationId, key));
    }

    public double getDoubleFor(String locationId, String key) {
        return Double.parseDouble(forLocation(locationId, key));
    }

    public Map<String, String> all(long tenantId) {
        Map<String, String> m = new LinkedHashMap<>(DEFAULTS);
        jdbc.sql("SELECT key, value FROM settings WHERE tenant_id = ?").param(tenantId).query(rs -> {
            m.put(rs.getString(1), rs.getString(2));
        });
        return m;
    }

    @Transactional
    public void set(long tenantId, String key, String value) {
        if (!DEFAULTS.containsKey(key)) {
            throw ApiException.badRequest("Неизвестная настройка: " + key);
        }
        // Адрес кассы становится ссылкой у кассира: только http(s), иначе в ссылку можно подложить javascript:
        if (POS_URL.equals(key) && value != null && !value.isBlank() && !value.strip().matches("(?i)https?://\\S+")) {
            throw ApiException.badRequest("Адрес кассы — ссылка вида https://…");
        }
        jdbc.sql("""
                        INSERT INTO settings (tenant_id, key, value) VALUES (?, ?, ?)
                        ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value""")
                .params(tenantId, key, value).update();
    }
}
