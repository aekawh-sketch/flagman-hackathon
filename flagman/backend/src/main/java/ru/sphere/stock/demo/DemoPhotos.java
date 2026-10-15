package ru.sphere.stock.demo;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import org.springframework.stereotype.Component;
import ru.sphere.stock.config.StockProperties;

/** Фото-заглушка для заявок, которые создаёт генератор (у настоящих заявок — настоящее фото). */
@Component
public class DemoPhotos {

    /** PNG 1×1. */
    private static final byte[] PNG = Base64.getDecoder().decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");
    private static final String NAME = "demo-photo.png";

    private final Path dir;

    public DemoPhotos(StockProperties props) {
        this.dir = Path.of(props.uploadsDir()).toAbsolutePath().normalize();
    }

    public String placeholder() {
        try {
            Files.createDirectories(dir);
            Path p = dir.resolve(NAME);
            if (!Files.exists(p)) {
                Files.write(p, PNG);
            }
            return NAME;
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }
}
