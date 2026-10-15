-- ═══════════════════════════════════════════════════════════════════════════
--  Несколько фото (ТЗ 16.8): у заявки на списание, возврата поставщику и накладной — список фото.
--  Старая колонка остаётся первым фото (обратная совместимость); всё, что уже загружено, переносится.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE writeoff_requests ADD COLUMN photos TEXT[] NOT NULL DEFAULT '{}';
UPDATE writeoff_requests SET photos = ARRAY[photo] WHERE photo IS NOT NULL;

ALTER TABLE supplier_returns ADD COLUMN photos TEXT[] NOT NULL DEFAULT '{}';
UPDATE supplier_returns SET photos = ARRAY[photo];

ALTER TABLE deliveries ADD COLUMN invoice_photos TEXT[] NOT NULL DEFAULT '{}';
UPDATE deliveries SET invoice_photos = ARRAY[invoice_photo] WHERE invoice_photo IS NOT NULL;
