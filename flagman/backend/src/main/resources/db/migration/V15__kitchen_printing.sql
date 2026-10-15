-- Чек на кухню (ТЗ 16.15): кассир пробил заказ — на кухне печатается чек с блюдами.
-- Принтер у каждой точки свой: экран кухни (по умолчанию), сетевой термопринтер ESC/POS или выключен.
CREATE TABLE kitchen_printers (
    tenant_id   BIGINT NOT NULL REFERENCES tenants (id),
    location_id TEXT NOT NULL,
    mode        TEXT NOT NULL CHECK (mode IN ('OFF', 'SCREEN', 'NETWORK')),
    host        TEXT,                                    -- адрес в сети ресторана: 192.168.1.50
    port        INT NOT NULL DEFAULT 9100 CHECK (port BETWEEN 1 AND 65535),
    paper_mm    INT NOT NULL DEFAULT 80 CHECK (paper_mm IN (58, 80)),
    copies      INT NOT NULL DEFAULT 1 CHECK (copies BETWEEN 1 AND 3),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (location_id),
    FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
    CHECK (mode <> 'NETWORK' OR host IS NOT NULL)
);
CREATE TRIGGER kitchen_printers_tenant BEFORE INSERT ON kitchen_printers
    FOR EACH ROW EXECUTE FUNCTION tenant_from_location();

-- Один чек на заказ: что пробили и куда ушла печать. Строки — снимок на момент заказа (как на бумаге).
CREATE TABLE kitchen_tickets (
    id           BIGSERIAL PRIMARY KEY,
    tenant_id    BIGINT NOT NULL REFERENCES tenants (id),
    location_id  TEXT NOT NULL,
    order_id     BIGINT NOT NULL UNIQUE REFERENCES orders (id),
    order_number BIGINT NOT NULL,
    source       TEXT,
    created_at   TIMESTAMPTZ NOT NULL,
    lines        JSONB NOT NULL,                          -- [{ "name": "Ролл", "qty": 2, "items": [...] }]
    status       TEXT NOT NULL CHECK (status IN ('QUEUED', 'PRINTED', 'SHOWN', 'FAILED')),
    printer      TEXT,                                    -- «экран кухни» или 192.168.1.50:9100
    attempts     INT NOT NULL DEFAULT 0,
    printed_at   TIMESTAMPTZ,
    error        TEXT,
    FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);
CREATE INDEX kitchen_tickets_recent ON kitchen_tickets (location_id, created_at DESC);
CREATE TRIGGER kitchen_tickets_tenant BEFORE INSERT ON kitchen_tickets
    FOR EACH ROW EXECUTE FUNCTION tenant_from_location();
