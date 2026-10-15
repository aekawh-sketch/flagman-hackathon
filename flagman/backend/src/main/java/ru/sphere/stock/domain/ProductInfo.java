package ru.sphere.stock.domain;

import java.time.Duration;
import java.util.Objects;

/**
 * Карточка продукта — всё, что нужно алгоритмам.
 *
 * @param packSize       размер упаковки в базовых единицах; {@code null} — весовой товар
 * @param afterOpen      срок хранения после вскрытия; {@code null} — вскрытие срок не меняет
 * @param lossBp         потери при обработке в базисных пунктах (2500 = 25%), для брутто/нетто
 * @param alertBefore    окно «скоро истекает»; {@code null} — правило по умолчанию (ТЗ 5.2)
 * @param criticalBefore окно «критично»; {@code null} — ¼ окна «скоро»
 * @param shelfLife      типичный срок хранения: для заготовок, излишков и расчёта закупок
 * @param leadTime       срок доставки от поставщика; {@code null} — 1 день (ТЗ 4.4)
 */
public record ProductInfo(
        String id,
        String name,
        Unit unit,
        ProductKind kind,
        Long packSize,
        Duration afterOpen,
        int lossBp,
        Duration alertBefore,
        Duration criticalBefore,
        Duration shelfLife,
        Duration leadTime) {

    public ProductInfo {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(unit, "unit");
        Objects.requireNonNull(kind, "kind");
        if (lossBp < 0 || lossBp > 9500) {
            throw new IllegalArgumentException("lossBp must be in 0..9500: " + lossBp);
        }
        if (packSize != null && packSize <= 0) {
            throw new IllegalArgumentException("packSize must be positive");
        }
    }

    public String format(long qty) {
        return unit.format(qty);
    }

    public static Builder builder(String id, String name, Unit unit) {
        return new Builder(id, name, unit);
    }

    public static final class Builder {
        private final String id;
        private final String name;
        private final Unit unit;
        private ProductKind kind = ProductKind.RAW;
        private Long packSize;
        private Duration afterOpen;
        private int lossBp;
        private Duration alertBefore;
        private Duration criticalBefore;
        private Duration shelfLife;
        private Duration leadTime;

        private Builder(String id, String name, Unit unit) {
            this.id = id;
            this.name = name;
            this.unit = unit;
        }

        public Builder semi() { this.kind = ProductKind.SEMI; return this; }
        public Builder pack(long size) { this.packSize = size; return this; }
        public Builder afterOpen(Duration d) { this.afterOpen = d; return this; }
        public Builder lossBp(int bp) { this.lossBp = bp; return this; }
        public Builder alertBefore(Duration d) { this.alertBefore = d; return this; }
        public Builder criticalBefore(Duration d) { this.criticalBefore = d; return this; }
        public Builder shelfLife(Duration d) { this.shelfLife = d; return this; }
        public Builder leadTime(Duration d) { this.leadTime = d; return this; }

        public ProductInfo build() {
            return new ProductInfo(id, name, unit, kind, packSize, afterOpen, lossBp,
                    alertBefore, criticalBefore, shelfLife, leadTime);
        }
    }
}
