package ru.sphere.stock.web;

import java.util.List;
import java.util.Map;
import io.swagger.v3.oas.annotations.Operation;
import ru.sphere.stock.config.OpenApiConfig;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.menu.InsightsService;
import ru.sphere.stock.menu.MenuService;

/**
 * Для виджета на сайте ресторана (п. 49): только чтение, по публичному ключу точки, без cookie.
 * Сайт по внешним ID блюд помечает «нет в наличии» и «осталось N» и показывает горячие предложения.
 */
@RestController
public class PublicController {

    public record VariantState(String id, String dishId, String name, boolean inStop, Long left) {
    }

    public record Hot(String id, String name, String reason) {
    }

    public record MenuStatus(String location, List<VariantState> variants, List<Hot> hot) {
    }

    private final JdbcClient jdbc;
    private final MenuService menu;
    private final InsightsService insights;

    public PublicController(JdbcClient jdbc, MenuService menu, InsightsService insights) {
        this.jdbc = jdbc;
        this.menu = menu;
        this.insights = insights;
    }

    @Operation(summary = "Стоп-лист и рекомендации для сайта ресторана", description = "Только чтение, по публичному ключу точки, без cookie.", tags = OpenApiConfig.T_PUBLIC)
    @GetMapping("/public/{loc}/menu-status")
    public ResponseEntity<MenuStatus> status(@PathVariable String loc, @RequestParam String key) {
        boolean ok = jdbc.sql("SELECT COUNT(*) FROM locations WHERE id = ? AND public_key = ?").params(loc, key)
                .query(Long.class).single() > 0;
        if (!ok) {
            throw ApiException.forbidden("Неверный ключ точки");
        }
        var variants = menu.menu(loc).stream()
                .map(v -> new VariantState(v.variantId(), v.dishId(), v.name(), v.inStop(),
                        v.low() ? v.portions() : null))
                .toList();
        var hot = insights.hotOffers(loc).offers().stream()
                .map(h -> new Hot(h.variantId(), h.name(), "Рекомендуем сегодня"))
                .toList();
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(new MenuStatus(loc, variants, hot));
    }

    @Operation(summary = "Проверка доступности", tags = OpenApiConfig.T_PUBLIC)
    @GetMapping("/public/health")
    public Map<String, Object> health() {
        return Map.of("ok", true);
    }
}
