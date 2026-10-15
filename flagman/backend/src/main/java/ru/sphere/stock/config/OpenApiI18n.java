package ru.sphere.stock.config;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.media.Schema;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.regex.Pattern;
import java.util.regex.Matcher;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springdoc.core.customizers.OpenApiLocaleCustomizer;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;
import ru.sphere.stock.infra.Json;

/**
 * Документация API на двух языках. Исходник — русский текст в коде; для {@code Accept-Language: en}
 * строки заменяются по словарю {@code openapi/en.json} (его собирает {@code tools/build_openapi_en.py}).
 * Строка без перевода остаётся русской и попадает в лог — тест {@code OpenApiI18nTest} это ловит.
 */
@Component
public class OpenApiI18n implements OpenApiLocaleCustomizer {

    private static final Logger log = LoggerFactory.getLogger(OpenApiI18n.class);

    private final Map<String, String> en;
    private final Set<String> missing = ConcurrentHashMap.newKeySet();

    @SuppressWarnings("unchecked")
    public OpenApiI18n(Json json) throws IOException {
        try (InputStream in = new ClassPathResource("openapi/en.json").getInputStream()) {
            this.en = json.read(new String(in.readAllBytes(), StandardCharsets.UTF_8), Map.class);
        }
    }

    @Override
    public void customise(OpenAPI api, Locale locale) {
        OpenApiConfig.describeParameters(api);
        if (!"en".equals(locale.getLanguage())) {
            return;
        }
        if (api.getInfo() != null) {
            tr(api.getInfo()::getTitle, api.getInfo()::setTitle);
            tr(api.getInfo()::getDescription, api.getInfo()::setDescription);
        }
        if (api.getServers() != null) {
            api.getServers().forEach(s -> tr(s::getDescription, s::setDescription));
        }
        if (api.getTags() != null) {
            api.getTags().forEach(t -> {
                tr(t::getName, t::setName);
                tr(t::getDescription, t::setDescription);
            });
        }
        if (api.getPaths() != null) {
            api.getPaths().values().forEach(path -> path.readOperations().forEach(op -> {
                tr(op::getSummary, op::setSummary);
                tr(op::getDescription, op::setDescription);
                if (op.getTags() != null) {
                    op.setTags(op.getTags().stream().map(this::t).toList());
                }
                if (op.getParameters() != null) {
                    op.getParameters().forEach(p -> {
                        tr(p::getDescription, p::setDescription);
                        if (p.getSchema() != null) {
                            schema(p.getSchema(), new IdentityHashMap<>());
                        }
                    });
                }
                if (op.getRequestBody() != null) {
                    tr(op.getRequestBody()::getDescription, op.getRequestBody()::setDescription);
                    if (op.getRequestBody().getContent() != null) {
                        op.getRequestBody().getContent().values().forEach(mt -> {
                            if (mt.getExamples() != null) {
                                mt.getExamples().values().forEach(ex -> {
                                    tr(ex::getSummary, ex::setSummary);
                                    ex.setValue(example(ex.getValue()));
                                });
                            }
                            if (mt.getExample() != null) {
                                mt.setExample(example(mt.getExample()));
                            }
                        });
                    }
                }
                if (op.getResponses() != null) {
                    op.getResponses().values().forEach(r -> tr(r::getDescription, r::setDescription));
                }
            }));
        }
        if (api.getComponents() != null) {
            if (api.getComponents().getSchemas() != null) {
                Map<Schema<?>, Boolean> seen = new IdentityHashMap<>();
                api.getComponents().getSchemas().values().forEach(s -> schema(s, seen));
            }
            if (api.getComponents().getSecuritySchemes() != null) {
                api.getComponents().getSecuritySchemes().values().forEach(s -> tr(s::getDescription, s::setDescription));
            }
        }
    }

    @SuppressWarnings({"rawtypes", "unchecked"})
    private void schema(Schema<?> s, Map<Schema<?>, Boolean> seen) {
        if (s == null || seen.put(s, Boolean.TRUE) != null) {
            return;
        }
        tr(s::getDescription, s::setDescription);
        if (s.getExample() instanceof String ex) {
            ((Schema) s).setExample(t(ex));
        }
        if (s.getProperties() != null) {
            s.getProperties().values().forEach(p -> schema(p, seen));
        }
        schema(s.getItems(), seen);
        for (List<Schema> group : List.of(nullSafe(s.getAllOf()), nullSafe(s.getOneOf()), nullSafe(s.getAnyOf()))) {
            group.forEach(x -> schema(x, seen));
        }
    }

    @SuppressWarnings("rawtypes")
    private static List<Schema> nullSafe(List<Schema> l) {
        return l == null ? List.of() : l;
    }

    /**
     * Пример запроса (поставка в JSON или XML): переводим только строки-значения — названия, поставщика, номер.
     * Структура и ID продуктов остаются как есть, чтобы английский пример тоже можно было отправить.
     */
    private Object example(Object v) {
        if (v == null || v instanceof Number || v instanceof Boolean) {
            return v;
        }
        if (v instanceof String str) {
            return exampleText(str);
        }
        if (v instanceof Map<?, ?> m) {
            Map<Object, Object> out = new LinkedHashMap<>();
            m.forEach((k, x) -> out.put(k, example(x)));
            return out;
        }
        if (v instanceof List<?> l) {
            return l.stream().map(this::example).toList();
        }
        try {   // JsonNode из swagger-core → обычные Map/List
            return example(io.swagger.v3.core.util.Json.mapper().convertValue(v, Object.class));
        } catch (IllegalArgumentException e) {
            return v;
        }
    }

    private String exampleText(String str) {
        if (en.containsKey(str)) {
            return en.get(str);
        }
        String trimmed = str.strip();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try {
                Object tree = io.swagger.v3.core.util.Json.mapper().readValue(str, Object.class);
                return io.swagger.v3.core.util.Json.pretty(example(tree));
            } catch (Exception e) {
                return t(str);
            }
        }
        if (trimmed.startsWith("<")) {
            Matcher m = XML_ATTR.matcher(str);
            StringBuilder sb = new StringBuilder();
            while (m.find()) {
                m.appendReplacement(sb, Matcher.quoteReplacement("=\"" + t(m.group(1)) + "\""));
            }
            m.appendTail(sb);
            return sb.toString();
        }
        return t(str);
    }

    private static final Pattern XML_ATTR = Pattern.compile("=\"([^\"]*)\"");

    private void tr(Supplier<String> get, Consumer<String> set) {
        String v = get.get();
        if (v != null) {
            set.accept(t(v));
        }
    }

    private String t(String ru) {
        String v = en.get(ru);
        if (v != null) {
            return v;
        }
        if (ru.chars().anyMatch(c -> Character.UnicodeBlock.of(c) == Character.UnicodeBlock.CYRILLIC)
                && missing.add(ru)) {
            log.warn("Нет английского перевода для строки документации: {}", ru);
        }
        return ru;
    }
}
