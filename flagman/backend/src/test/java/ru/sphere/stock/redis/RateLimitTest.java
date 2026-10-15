package ru.sphere.stock.redis;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import ru.sphere.stock.infra.Json;
import tools.jackson.databind.json.JsonMapper;

/** Ограничение частоты: та же логика, что с Redis, на хранилище в памяти — без сервера Redis. */
class RateLimitTest {

    private final RateLimit limit = new RateLimit(new LocalSharedStore(new Json(JsonMapper.builder().build())),
            new RateLimit.Limits(0, 0, 2));

    private static MockHttpServletRequest from(String ip) {
        MockHttpServletRequest req = new MockHttpServletRequest("POST", "/api/auth/login");
        req.setRemoteAddr(ip);
        return req;
    }

    @Test
    void overTheLimitTheClientGets429AndWhenToRetry() throws Exception {
        for (int i = 0; i < 2; i++) {
            assertThat(limit.preHandle(from("10.0.0.1"), new MockHttpServletResponse(), null)).isTrue();
        }
        MockHttpServletResponse res = new MockHttpServletResponse();
        assertThat(limit.preHandle(from("10.0.0.1"), res, null)).isFalse();
        assertThat(res.getStatus()).isEqualTo(429);
        assertThat(Integer.parseInt(res.getHeader("Retry-After"))).isBetween(1, 60);
        assertThat(res.getHeader("X-RateLimit-Remaining")).isEqualTo("0");
        assertThat(res.getContentAsString()).contains("Слишком много запросов");

        assertThat(limit.preHandle(from("10.0.0.2"), new MockHttpServletResponse(), null))
                .as("у другого адреса — свой счёт").isTrue();
    }
}
