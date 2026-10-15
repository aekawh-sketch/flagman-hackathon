package ru.sphere.stock.config;

import java.io.IOException;
import java.nio.file.Path;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.ViewControllerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import org.springframework.web.servlet.resource.PathResourceResolver;

/**
 * Коробочная версия (одна программа на компьютере, {@code ../desktop}): сервер сам отдаёт собранный интерфейс
 * и живёт, пока жива оболочка. В разработке обе настройки пусты — интерфейс отдаёт Vite.
 *
 * <ul>
 *   <li>{@code stock.web-dir} — папка собранного интерфейса ({@code frontend/dist}). Пути вида {@code /kush/stock} —
 *       страницы React, а не файлы: на них отдаётся index.html. API, Swagger и actuator разбираются раньше.</li>
 *   <li>{@code stock.exit-on-stdin-close} — оболочка держит stdin сервера открытым; закрыла (вышла или упала) —
 *       сервер штатно останавливается и не держит порт до перезагрузки компьютера.</li>
 * </ul>
 */
@Configuration
public class DesktopConfig implements WebMvcConfigurer {

    private static final Logger log = LoggerFactory.getLogger(DesktopConfig.class);

    private final String webDir;

    DesktopConfig(@Value("${stock.web-dir:}") String webDir) {
        this.webDir = webDir;
    }

    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        if (webDir.isBlank()) {
            return;
        }
        String dir = Path.of(webDir).toAbsolutePath().normalize().toUri().toString();
        registry.addResourceHandler("/**")
                .addResourceLocations(dir.endsWith("/") ? dir : dir + "/")
                .setCacheControl(CacheControl.noCache())     // новая сборка видна сразу; на localhost это бесплатно
                .resourceChain(false)
                .addResolver(new PathResourceResolver() {
                    @Override
                    protected Resource getResource(String path, Resource location) throws IOException {
                        Resource file = super.getResource(path, location);
                        // Не файл: страница React → index.html; опечатка в пути к API или к файлу — честный 404
                        if (file != null || path.startsWith("api/") || path.contains(".")) {
                            return file;
                        }
                        return super.getResource("index.html", location);
                    }
                });
        log.info("Интерфейс — из {}", dir);
    }

    /** Корень: пустой путь обработчик файлов отбрасывает до {@code getResource} — главная отдаётся явно. */
    @Override
    public void addViewControllers(ViewControllerRegistry registry) {
        if (!webDir.isBlank()) {
            registry.addViewController("/").setViewName("forward:/index.html");
        }
    }

    @Bean
    @ConditionalOnProperty("stock.exit-on-stdin-close")
    ApplicationRunner exitOnStdinClose(ConfigurableApplicationContext ctx) {
        return args -> Thread.ofPlatform().daemon().name("stdin-watch").start(() -> {
            try {
                while (System.in.read() != -1) {
                    // оболочка ничего не пишет — ждём только закрытия
                }
            } catch (IOException ignored) {
                // поток оборвался — то же, что закрылся
            }
            log.info("Оболочка закрылась — останавливаем сервер");
            System.exit(SpringApplication.exit(ctx));
        });
    }
}
