package ru.sphere.stock.web;

import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import ru.sphere.stock.infra.ApiException;

/** Единый формат ошибок: {@code {"error": "...", "details": ...}}. */
@RestControllerAdvice
public class ErrorHandler {

    private static final Logger log = LoggerFactory.getLogger(ErrorHandler.class);

    @ExceptionHandler(ApiException.class)
    ResponseEntity<Map<String, Object>> api(ApiException e) {
        return body(e.status(), e.getMessage(), e.details());
    }

    @ExceptionHandler({MethodArgumentNotValidException.class, HttpMessageNotReadableException.class,
            IllegalArgumentException.class})
    ResponseEntity<Map<String, Object>> bad(Exception e) {
        return body(HttpStatus.BAD_REQUEST, e instanceof IllegalArgumentException ? e.getMessage()
                : "Некорректный запрос", null);
    }

    @ExceptionHandler(MaxUploadSizeExceededException.class)
    ResponseEntity<Map<String, Object>> tooBig(Exception e) {
        return body(HttpStatus.PAYLOAD_TOO_LARGE, "Файл больше 5 МБ", null);
    }

    /** Ограничения базы — последняя линия защиты (например, остаток партии ≥ 0). */
    @ExceptionHandler(DataIntegrityViolationException.class)
    ResponseEntity<Map<String, Object>> integrity(DataIntegrityViolationException e) {
        log.warn("integrity violation: {}", e.getMostSpecificCause().getMessage());
        return body(HttpStatus.CONFLICT, "Операция нарушает правила склада и отклонена базой данных",
                e.getMostSpecificCause().getMessage());
    }

    private static ResponseEntity<Map<String, Object>> body(HttpStatus status, String message, Object details) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("error", message);
        if (details != null) {
            m.put("details", details);
        }
        return ResponseEntity.status(status).body(m);
    }
}
