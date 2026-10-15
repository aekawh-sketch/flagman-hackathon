package ru.sphere.stock.config;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import org.springdoc.core.properties.SwaggerUiConfigProperties;
import org.springdoc.core.properties.SwaggerUiOAuthProperties;
import org.springdoc.core.providers.ObjectMapperProvider;
import org.springdoc.webmvc.ui.SwaggerIndexPageTransformer;
import org.springdoc.webmvc.ui.SwaggerIndexTransformer;
import org.springdoc.webmvc.ui.SwaggerWelcomeCommon;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.web.servlet.LocaleResolver;
import org.springframework.web.servlet.i18n.AcceptHeaderLocaleResolver;
import org.springframework.web.servlet.resource.ResourceTransformerChain;
import org.springframework.web.servlet.resource.TransformedResource;

/**
 * Язык документации API в стандартном Swagger UI (/swagger-ui/index.html).
 *
 * <ul>
 *   <li>Две версии документации — «Русский» и «English» — в штатном списке «Select a definition»
 *       (springdoc.swagger-ui.urls в application.yml).</li>
 *   <li>Язык описания выбирает сервер: параметр {@code ?lang=ru|en}, иначе заголовок Accept-Language,
 *       иначе русский (перевод — {@link OpenApiI18n}).</li>
 *   <li>Надписи самого Swagger UI («Try it out», «Execute»…) в русской версии переводит скрипт
 *       {@code swagger-ru.js}, который дописывается к штатному swagger-initializer.js.</li>
 * </ul>
 */
@Configuration
public class SwaggerLanguageConfig {

    private static final List<Locale> SUPPORTED = List.of(Locale.forLanguageTag("ru"), Locale.ENGLISH);

    @Bean
    LocaleResolver localeResolver() {
        AcceptHeaderLocaleResolver byHeader = new AcceptHeaderLocaleResolver();
        byHeader.setSupportedLocales(SUPPORTED);
        byHeader.setDefaultLocale(SUPPORTED.getFirst());
        return new LocaleResolver() {
            @Override
            public Locale resolveLocale(HttpServletRequest request) {
                String lang = request.getParameter("lang");
                if ("en".equals(lang) || "ru".equals(lang)) {
                    return Locale.forLanguageTag(lang);
                }
                return byHeader.resolveLocale(request);
            }

            @Override
            public void setLocale(HttpServletRequest request, HttpServletResponse response, Locale locale) {
                throw new UnsupportedOperationException("Язык задаётся параметром lang или заголовком Accept-Language");
            }
        };
    }

    /** Штатный трансформер springdoc + наш скрипт перевода в конце swagger-initializer.js. */
    @Bean
    SwaggerIndexTransformer indexPageTransformer(SwaggerUiConfigProperties config, SwaggerUiOAuthProperties oauth,
                                                 SwaggerWelcomeCommon welcome, ObjectMapperProvider mapper) {
        return new SwaggerIndexPageTransformer(config, oauth, welcome, mapper) {
            @Override
            public Resource transform(HttpServletRequest request, Resource resource, ResourceTransformerChain chain)
                    throws IOException {
                Resource out = super.transform(request, resource, chain);
                if (!"swagger-initializer.js".equals(resource.getFilename())) {
                    return out;
                }
                String js;
                try (InputStream in = out.getInputStream()) {
                    js = new String(in.readAllBytes(), StandardCharsets.UTF_8);
                }
                try (InputStream in = new ClassPathResource("swagger-ru.js").getInputStream()) {
                    js += "\n" + new String(in.readAllBytes(), StandardCharsets.UTF_8);
                }
                return new TransformedResource(out, js.getBytes(StandardCharsets.UTF_8));
            }
        };
    }
}
