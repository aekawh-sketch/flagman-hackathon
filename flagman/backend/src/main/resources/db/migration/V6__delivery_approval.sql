-- Одобрение поставки управляющим (ТЗ 16.6): сначала управляющий решает, что из накладной берём — целиком
-- или частично, затем кладовщик принимает по факту, но не больше одобренного. Принимает не тот, кто одобрил.

ALTER TABLE deliveries DROP CONSTRAINT deliveries_status_check;
ALTER TABLE deliveries ADD CONSTRAINT deliveries_status_check
    CHECK (status IN ('PENDING', 'APPROVED', 'ACCEPTED', 'ACCEPTED_DIFF', 'PARTIAL', 'REJECTED'));
ALTER TABLE deliveries ADD COLUMN approved_by      BIGINT REFERENCES users (id);
ALTER TABLE deliveries ADD COLUMN approved_at      TIMESTAMPTZ;
ALTER TABLE deliveries ADD COLUMN approval_comment TEXT;

-- Сколько управляющий разрешил принять по строке; 0 — строку не берём. NULL — ещё не одобряли.
ALTER TABLE delivery_lines ADD COLUMN approved_qty BIGINT CHECK (approved_qty >= 0);
ALTER TABLE delivery_lines ADD COLUMN approve_note TEXT;
ALTER TABLE delivery_lines DROP CONSTRAINT delivery_lines_reject_reason_check;
ALTER TABLE delivery_lines ADD CONSTRAINT delivery_lines_reject_reason_check
    CHECK (reject_reason IN ('SHORTAGE', 'DEFECT', 'EXPIRED', 'NOT_ORDERED', 'NOT_APPROVED', 'OTHER'));

-- Поставки, которые уже ждали приёмки до появления одобрения, — как одобренные целиком: работа не встанет.
UPDATE delivery_lines l SET approved_qty = l.qty_invoice
FROM deliveries d WHERE d.tenant_id = l.tenant_id AND d.id = l.delivery_id AND d.status = 'PENDING';
UPDATE deliveries SET status = 'APPROVED', approved_at = received_at, approval_comment = 'Одобрена до введения одобрения'
WHERE status = 'PENDING';
