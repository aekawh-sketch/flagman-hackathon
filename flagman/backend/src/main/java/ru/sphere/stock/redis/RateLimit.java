package ru.sphere.stock.redis;

import jakarta.servlet.DispatcherType;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import ru.sphere.stock.ledger.Actor;
import ru.sphere.stock.security.StockPrincipal;

/**
 * Ограничение частоты запросов к API: защита от зациклившейся программы и перебора. Счётчик на минуту — в Redis
 * ({@code rate:user:7}, INCR со сроком жизни 60 с), поэтому лимит общий для всех серверов склада. Сотрудник
 * считается по учётке, внешняя система — по API-ключу, запрос без входа — по IP. Превышение — 429 и
 * {@code Retry-After}: через сколько секунд окно откроется.
 */
@Configuration
public class RateLimit implements WebMvcConfigurer, HandlerInterceptor {

    /**
     * Запросов в минуту; 0 — без ограничения. Пороги с запасом: живые обновления интерфейса при ускоренных
     * демо-часах дают до ~20 запросов в секунду, а ключ сайта — это все гости ресторана сразу.
     */
    @ConfigurationProperties("stock.rate-limit")
    public record Limits(int userPerMinute, int keyPerMinute, int ipPerMinute) {
    }

    private static final Duration WINDOW = Duration.ofMinutes(1);

    private final SharedStore shared;
    private final Limits limits;

    public RateLimit(SharedStore shared, Limits limits) {
        this.shared = shared;
        this.limits = limits;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(this).addPathPatterns("/api/**", "/public/**");
    }

    @Override
    public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler) throws IOException {
        if (req.getDispatcherType() != DispatcherType.REQUEST) {
            return true;                                    // повторный проход того же запроса (SSE, ошибка) — уже посчитан
        }
        String who;
        int limit;
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth != null && auth.getPrincipal() instanceof StockPrincipal p) {
            boolean api = p.kind() == Actor.Kind.API;
            who = (api ? "key:" : "user:") + p.id();
            limit = api ? limits.keyPerMinute() : limits.userPerMinute();
        } else {
            who = "ip:" + req.getRemoteAddr();
            limit = limits.ipPerMinute();
        }
        if (limit <= 0) {
            return true;
        }
        SharedStore.Hit hit = shared.hit("rate:" + who, WINDOW);
        res.setHeader("X-RateLimit-Limit", Integer.toString(limit));
        res.setHeader("X-RateLimit-Remaining", Long.toString(Math.max(0, limit - hit.count())));
        if (hit.count() <= limit) {
            return true;
        }
        long seconds = Math.max(1, (hit.resetIn().toMillis() + 999) / 1000);
        res.setStatus(429);
        res.setHeader("Retry-After", Long.toString(seconds));
        res.setContentType("application/json;charset=UTF-8");
        res.getWriter().write("{\"error\":\"Слишком много запросов. Повторите через " + seconds + " с\"}");
        return false;
    }
}
