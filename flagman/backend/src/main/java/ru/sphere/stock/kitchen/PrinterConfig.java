package ru.sphere.stock.kitchen;

import io.swagger.v3.oas.annotations.media.Schema;

/** Принтер кухни точки: режим, адрес в сети ресторана, ширина ленты и число копий. */
@Schema(name = "KitchenPrinter", description = "Принтер кухни точки")
public record PrinterConfig(
        String locationId,
        @Schema(description = "OFF — не печатать; SCREEN — чек на экране кухни; NETWORK — сетевой термопринтер ESC/POS") String mode,
        @Schema(description = "Адрес принтера в сети ресторана (для NETWORK)", example = "192.168.1.50") String host,
        @Schema(description = "Порт RAW-печати — у термопринтеров обычно 9100", example = "9100") int port,
        @Schema(description = "Ширина ленты: 58 или 80 мм", example = "80") int paperMm,
        @Schema(description = "Копий чека: 1–3", example = "1") int copies) {
}
