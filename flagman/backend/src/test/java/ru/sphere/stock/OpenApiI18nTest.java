package ru.sphere.stock;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;

/**
 * Документация API на двух языках: в английской версии не должно остаться ни одной русской буквы,
 * а русская версия не должна пострадать от перевода. Падает, если в коде появилась строка без перевода —
 * её нужно добавить в {@code backend/src/main/resources/openapi/en.json}.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class OpenApiI18nTest {

    private static final Pattern CYRILLIC = Pattern.compile("[А-Яа-яЁё]");

    @Value("${local.server.port}")
    int port;

    private String docs(String lang) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/v3/api-docs"));
        if (lang != null) {
            b.header("Accept-Language", lang);
        }
        return HttpClient.newHttpClient().send(b.build(), HttpResponse.BodyHandlers.ofString()).body();
    }

    @Test
    void englishHasNoRussianLeftAndRussianStaysIntact() throws Exception {
        String en = docs("en-US,en;q=0.9");
        var m = CYRILLIC.matcher(en);
        String leftover = m.find() ? en.substring(Math.max(0, m.start() - 60), Math.min(en.length(), m.start() + 60)) : null;
        assertThat(leftover).as("непереведённый фрагмент").isNull();
        assertThat(en).contains("\"Orders\"", "Create an all-or-nothing order");

        String ru = docs("ru-RU,ru;q=0.9");
        assertThat(ru).contains("\"Заказы\"", "Создать заказ «всё или ничего»").doesNotContain("Create an all-or-nothing order");
        assertThat(docs(null)).as("без заголовка — русский").contains("\"Заказы\"");
    }
}
