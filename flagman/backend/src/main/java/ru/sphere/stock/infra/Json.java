package ru.sphere.stock.infra;

import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

/** Сериализация для JSONB-колонок. */
@Component
public class Json {

    private final JsonMapper mapper;

    public Json(JsonMapper mapper) {
        this.mapper = mapper;
    }

    public String write(Object value) {
        return mapper.writeValueAsString(value);
    }

    public <T> T read(String s, Class<T> type) {
        return mapper.readValue(s, type);
    }
}
