-- Поставки v2 (ТЗ 16.1–16.3): частичная приёмка с причиной по строке и тестовая поставка задним числом.

ALTER TABLE deliveries DROP CONSTRAINT deliveries_status_check;
ALTER TABLE deliveries ADD CONSTRAINT deliveries_status_check
    CHECK (status IN ('PENDING', 'ACCEPTED', 'ACCEPTED_DIFF', 'PARTIAL', 'REJECTED'));
-- Тестовая: разрешает принять уже просроченное, чтобы проверить «под списание → списал человек». Только демо.
ALTER TABLE deliveries ADD COLUMN mock BOOLEAN NOT NULL DEFAULT FALSE;
-- Как пришла: форма, файл, API (для отчёта и аудита).
ALTER TABLE deliveries ADD COLUMN channel TEXT NOT NULL DEFAULT 'API' CHECK (channel IN ('API', 'FORM', 'FILE'));
ALTER TABLE deliveries ADD COLUMN reject_comment TEXT;

-- Почему строку приняли не полностью.
ALTER TABLE delivery_lines ADD COLUMN reject_reason TEXT
    CHECK (reject_reason IN ('SHORTAGE', 'DEFECT', 'EXPIRED', 'NOT_ORDERED', 'OTHER'));
ALTER TABLE delivery_lines ADD COLUMN reject_comment TEXT;
