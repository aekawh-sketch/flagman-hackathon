package ru.sphere.stock.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.security.web.context.SecurityContextRepository;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;
import org.springframework.web.filter.OncePerRequestFilter;
import ru.sphere.stock.security.StockPrincipal;
import ru.sphere.stock.security.UserService;

/**
 * Безопасность (ТЗ 6.13): сессия в cookie HttpOnly + SameSite=strict — браузер не отправит её
 * с чужого сайта, поэтому отдельный CSRF-токен не нужен. Внешние системы — по API-ключу
 * в заголовке {@code X-Api-Key}, без сессии. CORS — только перечисленные домены, не «*».
 */
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    public static final String API_KEY_HEADER = "X-Api-Key";

    @Bean
    PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }

    /** Своя аутентификация (пароль, PIN, API-ключ) — стандартный пользователь Spring не нужен. */
    @Bean
    org.springframework.security.core.userdetails.UserDetailsService noDefaultUser() {
        return username -> {
            throw new org.springframework.security.core.userdetails.UsernameNotFoundException(username);
        };
    }

    @Bean
    SecurityContextRepository securityContextRepository() {
        return new HttpSessionSecurityContextRepository();
    }

    @Bean
    SecurityFilterChain chain(HttpSecurity http, UserService users, SecurityContextRepository repo) throws Exception {
        http.csrf(c -> c.disable())
                .cors(Customizer.withDefaults())
                .securityContext(sc -> sc.securityContextRepository(repo))
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.IF_REQUIRED))
                .authorizeHttpRequests(a -> a
                        // Платформа проверяет доступ сама: администратор платформы своим входом или ключ X-Platform-Key.
                        .requestMatchers("/api/auth/**", "/api/platform/**", "/public/**", "/v3/api-docs/**", "/swagger-ui/**",
                                "/swagger-ui.html", "/actuator/health").permitAll()
                        .requestMatchers("/api/**").authenticated()
                        .anyRequest().permitAll())
                .exceptionHandling(e -> e.authenticationEntryPoint((req, res, ex) -> {
                    res.setStatus(401);
                    res.setContentType("application/json;charset=UTF-8");
                    res.getWriter().write("{\"error\":\"Нужно войти\"}");
                }))
                .addFilterBefore(new ApiKeyFilter(users), UsernamePasswordAuthenticationFilter.class)
                .formLogin(f -> f.disable())
                .httpBasic(b -> b.disable())
                .logout(l -> l.disable());
        return http.build();
    }

    @Bean
    CorsConfigurationSource corsConfigurationSource(StockProperties props) {
        CorsConfiguration c = new CorsConfiguration();
        c.setAllowedOrigins(props.corsOrigins() == null ? List.of() : props.corsOrigins());
        c.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        c.setAllowedHeaders(List.of("Content-Type", API_KEY_HEADER, "Last-Event-ID"));
        c.setAllowCredentials(true);
        UrlBasedCorsConfigurationSource src = new UrlBasedCorsConfigurationSource();
        src.registerCorsConfiguration("/api/**", c);
        CorsConfiguration open = new CorsConfiguration();
        open.setAllowedOriginPatterns(List.of("*"));          // виджет — только чтение, без cookie
        open.setAllowedMethods(List.of("GET"));
        src.registerCorsConfiguration("/public/**", open);
        return src;
    }

    /** API-ключ из заголовка → принципал внешней системы. */
    static final class ApiKeyFilter extends OncePerRequestFilter {
        private final UserService users;

        ApiKeyFilter(UserService users) {
            this.users = users;
        }

        @Override
        protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
                throws ServletException, IOException {
            String key = req.getHeader(API_KEY_HEADER);
            if (key != null && !key.isBlank()) {
                StockPrincipal p = users.byApiKey(key.trim());
                if (p == null) {
                    res.setStatus(401);
                    res.setContentType("application/json;charset=UTF-8");
                    res.getWriter().write("{\"error\":\"Неверный или отозванный API-ключ\"}");
                    return;
                }
                var auth = new UsernamePasswordAuthenticationToken(p, null,
                        p.scopes().stream().map(s -> new SimpleGrantedAuthority("SCOPE_" + s)).toList());
                var ctx = SecurityContextHolder.createEmptyContext();
                ctx.setAuthentication(auth);
                SecurityContextHolder.setContext(ctx);
            }
            chain.doFilter(req, res);
        }
    }
}
