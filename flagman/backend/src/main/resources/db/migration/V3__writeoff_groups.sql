-- Групповая заявка на списание (ТЗ 6.5): напиток или блюдо по техкарте, либо продукт, раскладка по партиям FEFO.
-- Каждая строка — обычная заявка на одну партию (журнал, потери, правила A1–A4 работают как прежде),
-- общий group_id — одна подпись или один отказ на всю группу.
ALTER TABLE writeoff_requests ADD COLUMN group_id        UUID;
ALTER TABLE writeoff_requests ADD COLUMN dish_variant_id TEXT REFERENCES dish_variants (id);
ALTER TABLE writeoff_requests ADD COLUMN dish_qty        INT CHECK (dish_qty > 0);
CREATE INDEX writeoff_requests_group ON writeoff_requests (group_id) WHERE group_id IS NOT NULL;
