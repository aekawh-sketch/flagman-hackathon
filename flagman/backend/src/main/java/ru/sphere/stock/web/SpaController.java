package ru.sphere.stock.web;

import io.swagger.v3.oas.annotations.Hidden;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

/**
 * Одна ссылка для жюри: Spring Boot отдаёт и API, и собранный интерфейс. Маршруты интерфейса
 * (/center/dashboard, /login …) отдают index.html — дальше работает роутер в браузере.
 */
@Hidden
@Controller
public class SpaController {

    @GetMapping({"/login", "/{loc:(?!api|public|swagger-ui|v3|actuator|assets|docs)[a-z0-9-]+}",
            "/{loc:(?!api|public|swagger-ui|v3|actuator|assets|docs)[a-z0-9-]+}/**"})
    public String spa() {
        return "forward:/index.html";
    }

    /** Короткая ссылка на документацию API (стандартный Swagger UI с выбором языка). */
    @GetMapping("/docs")
    public String docs() {
        return "redirect:/swagger-ui/index.html";
    }
}
