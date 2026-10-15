package ru.sphere.stock.web;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;
import ru.sphere.stock.config.StockProperties;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.infra.Hashing;

/**
 * Фото заявок, возвратов и накладных (ТЗ 6.5, 6.13, 16.8): jpeg, png или webp, до {@link #MAX_PHOTOS} штук за раз,
 * без лимита «5 МБ» (потолок 100 МБ на файл — в application.yml). Хранятся вне публичной папки.
 */
@Service
public class UploadService {

    private static final Set<String> TYPES = Set.of("image/jpeg", "image/png", "image/webp");
    public static final int MAX_PHOTOS = 10;

    private final Path dir;
    private final Map<String, List<String>> stagedInvoices = new ConcurrentHashMap<>();

    public UploadService(StockProperties props) throws IOException {
        this.dir = Path.of(props.uploadsDir()).toAbsolutePath().normalize();
        Files.createDirectories(dir);
    }

    public String save(MultipartFile file) {
        if (file == null || file.isEmpty()) {
            throw ApiException.badRequest("Нужно фото");
        }
        if (!TYPES.contains(file.getContentType())) {
            throw ApiException.badRequest("Фото — jpeg, png или webp");
        }
        String ext = switch (file.getContentType()) {
            case "image/png" -> ".png";
            case "image/webp" -> ".webp";
            default -> ".jpg";
        };
        String name = Hashing.randomToken(16) + ext;
        try {
            file.transferTo(dir.resolve(name));
        } catch (IOException e) {
            throw new IllegalStateException("Не удалось сохранить фото", e);
        }
        return name;
    }

    /** Несколько фото за раз: хотя бы одно, не больше {@link #MAX_PHOTOS}. */
    public List<String> saveAll(List<MultipartFile> files) {
        List<MultipartFile> real = files == null ? List.of() : files.stream().filter(f -> f != null && !f.isEmpty()).toList();
        if (real.isEmpty()) {
            throw ApiException.badRequest("Нужно фото");
        }
        if (real.size() > MAX_PHOTOS) {
            throw ApiException.badRequest("Не больше " + MAX_PHOTOS + " фото за раз");
        }
        return real.stream().map(this::save).toList();
    }

    public Path resolve(String name) {
        Path p = dir.resolve(name).normalize();
        if (!p.startsWith(dir) || !Files.exists(p)) {
            throw ApiException.notFound("Фото");
        }
        return p;
    }

    /** Убрать файл фото — например, вместе с удалённым предприятием. Только внутри папки загрузок. */
    public void delete(String name) {
        Path p = dir.resolve(name).normalize();
        if (!p.startsWith(dir) || p.equals(dir)) {
            return;
        }
        try {
            Files.deleteIfExists(p);
        } catch (IOException e) {
            // файл не удалился — останется сиротой в папке загрузок, на данные это не влияет
        }
    }

    public void stageInvoice(String deliveryId, List<MultipartFile> files) {
        stagedInvoices.put(deliveryId, saveAll(files));
    }

    public List<String> pendingInvoice(String deliveryId) {
        return stagedInvoices.remove(deliveryId);
    }
}
