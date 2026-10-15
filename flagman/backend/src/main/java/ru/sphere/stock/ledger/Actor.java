package ru.sphere.stock.ledger;

/**
 * Кто совершает действие. У каждой записи журнала есть автор (ТЗ 6.1): человек под своей учёткой,
 * система (автосписание) или внешняя система по API-ключу.
 */
public record Actor(Kind kind, Long userId, Long apiKeyId, String role, String name) {

    public enum Kind {
        USER,
        SYSTEM,
        API
    }

    public static final Actor SYSTEM = new Actor(Kind.SYSTEM, null, null, "SYSTEM", "Система");

    public static Actor user(long id, String role, String name) {
        return new Actor(Kind.USER, id, null, role, name);
    }

    public static Actor api(long keyId, String name) {
        return new Actor(Kind.API, null, keyId, "API", name);
    }

    public boolean isUser() {
        return kind == Kind.USER;
    }

    public boolean hasRole(String... roles) {
        for (String r : roles) {
            if (r.equals(role)) {
                return true;
            }
        }
        return false;
    }
}
