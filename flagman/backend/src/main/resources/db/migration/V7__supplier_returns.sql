-- ═══════════════════════════════════════════════════════════════════════════
--  Возврат поставщику (ТЗ 16.7). Кладовщик подаёт заявку по принятой поставке: какие позиции и сколько
--  вернуть, причина и фото. Пока заявка ждёт, это количество не продаётся. Подтверждает управляющий или
--  админ — не автор; тогда партии уменьшаются движением «Возврат поставщику». Это не потери ресторана:
--  деньги возвращает поставщик, поэтому в аналитику списаний и правила A1–A4 возврат не попадает.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE supplier_returns (
    id               BIGSERIAL PRIMARY KEY,
    tenant_id        BIGINT NOT NULL REFERENCES tenants (id),
    location_id      TEXT NOT NULL,
    delivery_id      TEXT NOT NULL,
    reason           TEXT NOT NULL CHECK (reason IN ('DEFECT', 'WRONG_ITEM', 'SHORT_LIFE', 'DAMAGED_PACK', 'QUALITY', 'OTHER')),
    comment          TEXT,
    photo            TEXT NOT NULL,                        -- фото товара или накладной обязательно
    cost_kop         BIGINT NOT NULL CHECK (cost_kop >= 0),
    created_by       BIGINT NOT NULL REFERENCES users (id),
    created_at       TIMESTAMPTZ NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('PENDING', 'EXECUTED', 'REJECTED')),
    decided_by       BIGINT REFERENCES users (id),
    decided_at       TIMESTAMPTZ,
    decision_comment TEXT,
    FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
    FOREIGN KEY (tenant_id, delivery_id) REFERENCES deliveries (tenant_id, id),
    UNIQUE (tenant_id, id),
    CHECK (decided_by IS NULL OR decided_by <> created_by)   -- свою заявку не подтвердить (как у списаний)
);
CREATE INDEX supplier_returns_status ON supplier_returns (location_id, status, created_at);
CREATE INDEX supplier_returns_delivery ON supplier_returns (tenant_id, delivery_id);
CREATE TRIGGER supplier_returns_tenant BEFORE INSERT ON supplier_returns
    FOR EACH ROW EXECUTE FUNCTION tenant_from_location();

CREATE TABLE supplier_return_lines (
    tenant_id BIGINT NOT NULL,
    return_id BIGINT NOT NULL,
    batch_id  BIGINT NOT NULL REFERENCES batches (id),
    qty       BIGINT NOT NULL CHECK (qty > 0),
    cost_kop  BIGINT NOT NULL CHECK (cost_kop >= 0),
    PRIMARY KEY (return_id, batch_id),
    FOREIGN KEY (tenant_id, return_id) REFERENCES supplier_returns (tenant_id, id)
);
