-- ═══════════════════════════════════════════════════════════════════════════
--  Склад ресторана: схема (ТЗ, раздел 9).
--  Количества — целые числа в базовых единицах (г, мл, шт), деньги — копейки.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Точки и люди ──────────────────────────────────────────────────────────

CREATE TABLE locations (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    open_time   TIME NOT NULL DEFAULT '10:00',
    close_time  TIME NOT NULL DEFAULT '23:00',
    timezone    TEXT NOT NULL DEFAULT 'Europe/Moscow',
    public_key  TEXT NOT NULL UNIQUE          -- для виджета на сайте ресторана
);

CREATE TABLE users (
    id            BIGSERIAL PRIMARY KEY,
    login         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('COOK', 'CASHIER', 'STOREKEEPER', 'MANAGER', 'ADMIN')),
    location_id   TEXT REFERENCES locations (id),   -- NULL — все точки
    password_hash TEXT,
    pin_hash      TEXT,
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    key_prefix  TEXT NOT NULL,
    key_hash    TEXT NOT NULL UNIQUE,
    scopes      TEXT[] NOT NULL,
    location_id TEXT REFERENCES locations (id),
    revoked_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Каталог ───────────────────────────────────────────────────────────────

CREATE TABLE products (
    id                      TEXT PRIMARY KEY,
    name                    TEXT NOT NULL,
    unit                    TEXT NOT NULL CHECK (unit IN ('G', 'ML', 'PCS')),
    kind                    TEXT NOT NULL DEFAULT 'RAW' CHECK (kind IN ('RAW', 'SEMI')),
    category                TEXT,
    pack_size               BIGINT CHECK (pack_size > 0),
    after_open_minutes      INT CHECK (after_open_minutes > 0),
    loss_bp                 INT NOT NULL DEFAULT 0 CHECK (loss_bp BETWEEN 0 AND 9500),
    alert_before_minutes    INT CHECK (alert_before_minutes > 0),
    critical_before_minutes INT CHECK (critical_before_minutes > 0),
    shelf_life_minutes      INT CHECK (shelf_life_minutes > 0),
    lead_time_minutes       INT CHECK (lead_time_minutes > 0),
    expected_daily_use      BIGINT,
    last_unit_cost_kop      NUMERIC(14, 4),           -- если в поставке нет суммы (ТЗ 5.1)
    needs_review            BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE dishes (
    id          TEXT PRIMARY KEY,                     -- внешний ID клиента (у BB: b1, pz1 …)
    name        TEXT NOT NULL,
    category    TEXT NOT NULL,
    description TEXT,
    sort        INT NOT NULL DEFAULT 0
);

CREATE TABLE dish_variants (
    id            TEXT PRIMARY KEY,
    dish_id       TEXT NOT NULL REFERENCES dishes (id),
    name          TEXT NOT NULL,                      -- полное имя: «Пепперони 40 см»
    variant_label TEXT,                               -- «40 см», «с лососем»
    price_kop     BIGINT NOT NULL CHECK (price_kop >= 0),
    is_set        BOOLEAN NOT NULL DEFAULT FALSE,
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    sort          INT NOT NULL DEFAULT 0
);

CREATE TABLE set_items (
    set_variant_id TEXT NOT NULL REFERENCES dish_variants (id),
    variant_id     TEXT NOT NULL REFERENCES dish_variants (id),
    qty            INT NOT NULL CHECK (qty > 0),
    PRIMARY KEY (set_variant_id, variant_id)
);

-- Техкарты версионируются (ТЗ 6.9): владелец — вариант блюда или полуфабрикат.
CREATE TABLE recipe_versions (
    id              BIGSERIAL PRIMARY KEY,
    variant_id      TEXT REFERENCES dish_variants (id),
    semi_product_id TEXT REFERENCES products (id),
    version         INT NOT NULL,
    yield_qty       BIGINT CHECK (yield_qty > 0),     -- для заготовок: на какой выход строки
    created_by      BIGINT REFERENCES users (id),
    created_at      TIMESTAMPTZ NOT NULL,
    comment         TEXT,
    status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
    CHECK ((variant_id IS NULL) <> (semi_product_id IS NULL)),
    CHECK (semi_product_id IS NULL OR yield_qty IS NOT NULL)
);
CREATE UNIQUE INDEX recipe_active_variant ON recipe_versions (variant_id) WHERE status = 'ACTIVE' AND variant_id IS NOT NULL;
CREATE UNIQUE INDEX recipe_active_semi ON recipe_versions (semi_product_id) WHERE status = 'ACTIVE' AND semi_product_id IS NOT NULL;

CREATE TABLE recipe_lines (
    version_id BIGINT NOT NULL REFERENCES recipe_versions (id),
    product_id TEXT NOT NULL REFERENCES products (id),
    net_qty    BIGINT NOT NULL CHECK (net_qty > 0),
    loss_bp    INT CHECK (loss_bp BETWEEN 0 AND 9500),
    PRIMARY KEY (version_id, product_id)
);

-- ─── Поставки и партии ─────────────────────────────────────────────────────

CREATE TABLE deliveries (
    id            TEXT PRIMARY KEY,                   -- уникальный идентификатор из источника [ТЗ]
    location_id   TEXT NOT NULL REFERENCES locations (id),
    number        TEXT NOT NULL,                      -- номер поставки [ТЗ]
    created_at    TIMESTAMPTZ NOT NULL,               -- дата создания [ТЗ]
    supplier      TEXT,
    status        TEXT NOT NULL CHECK (status IN ('PENDING', 'ACCEPTED', 'ACCEPTED_DIFF', 'REJECTED')),
    payload_hash  TEXT NOT NULL,                      -- тот же id с другим содержимым → 409
    received_at   TIMESTAMPTZ NOT NULL,
    accepted_by   BIGINT REFERENCES users (id),
    accepted_at   TIMESTAMPTZ,
    invoice_photo TEXT
);

CREATE TABLE delivery_lines (
    id                 BIGSERIAL PRIMARY KEY,
    delivery_id        TEXT NOT NULL REFERENCES deliveries (id),
    line_no            INT NOT NULL,
    product_id         TEXT NOT NULL REFERENCES products (id),
    name               TEXT NOT NULL,
    unit               TEXT NOT NULL,
    qty_invoice        BIGINT NOT NULL CHECK (qty_invoice > 0),
    qty_actual         BIGINT CHECK (qty_actual >= 0),
    shelf_life_minutes INT CHECK (shelf_life_minutes > 0),
    expires_at         TIMESTAMPTZ,
    cost_total_kop     BIGINT CHECK (cost_total_kop >= 0),
    UNIQUE (delivery_id, line_no),
    CHECK (shelf_life_minutes IS NOT NULL OR expires_at IS NOT NULL)
);

CREATE TABLE batches (
    id               BIGSERIAL PRIMARY KEY,
    location_id      TEXT NOT NULL REFERENCES locations (id),
    product_id       TEXT NOT NULL REFERENCES products (id),
    label            TEXT NOT NULL,                   -- номер на этикетке
    source           TEXT NOT NULL CHECK (source IN ('DELIVERY', 'PRODUCTION', 'OPENING', 'SURPLUS')),
    delivery_line_id BIGINT REFERENCES delivery_lines (id),
    parent_batch_id  BIGINT REFERENCES batches (id),
    operation_id     UUID,
    qty_initial      BIGINT NOT NULL CHECK (qty_initial > 0),
    qty_left         BIGINT NOT NULL CHECK (qty_left >= 0),          -- последняя линия защиты от минуса
    held_qty         BIGINT NOT NULL DEFAULT 0 CHECK (held_qty >= 0),
    cost_total_kop   BIGINT NOT NULL DEFAULT 0 CHECK (cost_total_kop >= 0),
    base_date        TIMESTAMPTZ NOT NULL,
    expires_at       TIMESTAMPTZ NOT NULL,
    received_at      TIMESTAMPTZ NOT NULL,
    opened           BOOLEAN NOT NULL DEFAULT FALSE,
    blocked          BOOLEAN NOT NULL DEFAULT FALSE,
    block_reason     TEXT,
    CHECK (held_qty <= qty_left),
    CHECK (expires_at > base_date)
);
CREATE INDEX batches_live ON batches (location_id, product_id, expires_at) WHERE qty_left > 0;

-- Срок годности фиксируется при приёмке (ТЗ 6.6): изменить его нельзя никому.
CREATE FUNCTION batches_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.expires_at <> OLD.expires_at OR NEW.base_date <> OLD.base_date
       OR NEW.qty_initial <> OLD.qty_initial OR NEW.cost_total_kop <> OLD.cost_total_kop
       OR NEW.product_id <> OLD.product_id OR NEW.location_id <> OLD.location_id THEN
        RAISE EXCEPTION 'batch % is immutable except qty_left/held_qty/opened/blocked', OLD.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER batches_guard BEFORE UPDATE ON batches FOR EACH ROW EXECUTE FUNCTION batches_guard();
CREATE FUNCTION forbid_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER batches_no_delete BEFORE DELETE ON batches FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ─── Журнал движений: только добавление + хэш-цепочка (ТЗ 6.3, 6.4) ───────

CREATE TABLE ledger_heads (
    location_id TEXT PRIMARY KEY REFERENCES locations (id),
    seq         BIGINT NOT NULL,
    hash        TEXT NOT NULL
);

CREATE TABLE movements (
    id           BIGSERIAL PRIMARY KEY,
    location_id  TEXT NOT NULL REFERENCES locations (id),
    seq          BIGINT NOT NULL,
    type         TEXT NOT NULL,
    batch_id     BIGINT NOT NULL REFERENCES batches (id),
    qty          BIGINT NOT NULL CHECK (qty <> 0),
    cost_kop     BIGINT NOT NULL,
    actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('USER', 'SYSTEM', 'API')),
    actor_id     BIGINT REFERENCES users (id),
    api_key_id   BIGINT REFERENCES api_keys (id),
    at           TIMESTAMPTZ NOT NULL,
    reason       TEXT,
    doc_type     TEXT,
    doc_id       TEXT,
    operation_id UUID NOT NULL,
    reverses_id  BIGINT REFERENCES movements (id),
    prev_hash    TEXT NOT NULL,
    hash         TEXT NOT NULL,
    UNIQUE (location_id, seq)
);
CREATE INDEX movements_batch ON movements (batch_id);
CREATE INDEX movements_type_at ON movements (location_id, type, at);
CREATE INDEX movements_doc ON movements (doc_type, doc_id);

CREATE FUNCTION forbid_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER movements_append_only BEFORE UPDATE OR DELETE ON movements
    FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ─── Заказы ────────────────────────────────────────────────────────────────

CREATE TABLE orders (
    id            BIGSERIAL PRIMARY KEY,
    location_id   TEXT NOT NULL REFERENCES locations (id),
    external_id   TEXT NOT NULL,
    number        BIGINT NOT NULL,
    source        TEXT NOT NULL CHECK (source IN ('POS', 'SITE', 'GENERATOR', 'API')),
    status        TEXT NOT NULL CHECK (status IN ('NEW', 'ACCEPTED', 'COOKING', 'READY', 'DELIVERING', 'DONE',
                                                  'CANCELED', 'CANCELED_LATE')),
    created_at    TIMESTAMPTZ NOT NULL,
    created_by    BIGINT REFERENCES users (id),
    api_key_id    BIGINT REFERENCES api_keys (id),
    payload_hash  TEXT NOT NULL,
    total_kop     BIGINT NOT NULL,
    cost_kop      BIGINT NOT NULL,
    status_at     TIMESTAMPTZ NOT NULL,
    canceled_by   BIGINT REFERENCES users (id),
    canceled_at   TIMESTAMPTZ,
    cancel_reason TEXT,
    UNIQUE (location_id, external_id),
    UNIQUE (location_id, number)
);
CREATE INDEX orders_created ON orders (location_id, created_at);

CREATE TABLE order_lines (
    order_id          BIGINT NOT NULL REFERENCES orders (id),
    line_no           INT NOT NULL,
    variant_id        TEXT NOT NULL REFERENCES dish_variants (id),
    qty               INT NOT NULL CHECK (qty > 0),
    price_kop         BIGINT NOT NULL,
    recipe_version_id BIGINT REFERENCES recipe_versions (id),
    PRIMARY KEY (order_id, line_no)
);

-- Отказы не создают заказ, но нужны для статистики дефицита (ТЗ 5.5, 5.12).
CREATE TABLE order_refusals (
    id          BIGSERIAL PRIMARY KEY,
    location_id TEXT NOT NULL REFERENCES locations (id),
    at          TIMESTAMPTZ NOT NULL,
    external_id TEXT,
    source      TEXT NOT NULL,
    actor_id    BIGINT REFERENCES users (id),
    lines       JSONB NOT NULL,
    shortages   JSONB NOT NULL,
    lost_kop    BIGINT NOT NULL
);
CREATE INDEX refusals_at ON order_refusals (location_id, at);

-- ─── Стоп-лист ─────────────────────────────────────────────────────────────

CREATE TABLE stoplist_state (
    location_id TEXT NOT NULL REFERENCES locations (id),
    variant_id  TEXT NOT NULL REFERENCES dish_variants (id),
    portions    BIGINT NOT NULL,
    limiting    TEXT,
    since       TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (location_id, variant_id)
);

CREATE TABLE stoplist_events (
    id          BIGSERIAL PRIMARY KEY,
    location_id TEXT NOT NULL REFERENCES locations (id),
    variant_id  TEXT NOT NULL REFERENCES dish_variants (id),
    in_at       TIMESTAMPTZ NOT NULL,
    out_at      TIMESTAMPTZ,
    limiting    TEXT
);
CREATE INDEX stoplist_events_open ON stoplist_events (location_id, variant_id) WHERE out_at IS NULL;

-- ─── Антифрод ──────────────────────────────────────────────────────────────

CREATE TABLE writeoff_requests (
    id               BIGSERIAL PRIMARY KEY,
    location_id      TEXT NOT NULL REFERENCES locations (id),
    batch_id         BIGINT NOT NULL REFERENCES batches (id),
    qty              BIGINT NOT NULL CHECK (qty > 0),
    reason           TEXT NOT NULL CHECK (reason IN ('SPOILED', 'DAMAGED', 'OTHER')),
    comment          TEXT,
    photo            TEXT,
    cost_kop         BIGINT NOT NULL,
    created_by       BIGINT NOT NULL REFERENCES users (id),
    created_at       TIMESTAMPTZ NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('PENDING', 'EXECUTED', 'REJECTED')),
    decided_by       BIGINT REFERENCES users (id),
    decided_at       TIMESTAMPTZ,
    decision_comment TEXT,
    CHECK (decided_by IS NULL OR decided_by <> created_by)   -- свою заявку подписать нельзя (ТЗ 6.5)
);

CREATE TABLE inventory_counts (
    id           BIGSERIAL PRIMARY KEY,
    location_id  TEXT NOT NULL REFERENCES locations (id),
    started_at   TIMESTAMPTZ NOT NULL,
    started_by   BIGINT NOT NULL REFERENCES users (id),
    status       TEXT NOT NULL CHECK (status IN ('OPEN', 'AWAITING_APPROVAL', 'CONFIRMED', 'CANCELED')),
    confirmed_by BIGINT REFERENCES users (id),
    confirmed_at TIMESTAMPTZ,
    diff_kop     BIGINT
);

CREATE TABLE inventory_lines (
    count_id   BIGINT NOT NULL REFERENCES inventory_counts (id),
    product_id TEXT NOT NULL REFERENCES products (id),
    expected   BIGINT NOT NULL,
    actual     BIGINT NOT NULL CHECK (actual >= 0),
    PRIMARY KEY (count_id, product_id)
);

CREATE TABLE anomalies (
    id          BIGSERIAL PRIMARY KEY,
    location_id TEXT NOT NULL REFERENCES locations (id),
    rule        TEXT NOT NULL,
    dedup_key   TEXT NOT NULL,
    actor_id    BIGINT REFERENCES users (id),
    detected_at TIMESTAMPTZ NOT NULL,
    title       TEXT NOT NULL,
    evidence    JSONB NOT NULL,
    status      TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'REVIEWED', 'CONFIRMED', 'FALSE')),
    comment     TEXT,
    reviewed_by BIGINT REFERENCES users (id),
    UNIQUE (rule, dedup_key)
);

CREATE TABLE audit_log (
    id        BIGSERIAL PRIMARY KEY,
    seq       BIGINT NOT NULL UNIQUE,
    at        TIMESTAMPTZ NOT NULL,
    actor_id  BIGINT REFERENCES users (id),
    action    TEXT NOT NULL,
    details   JSONB NOT NULL,
    prev_hash TEXT NOT NULL,
    hash      TEXT NOT NULL
);
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ─── Сигналы, настройки, часы ──────────────────────────────────────────────

CREATE TABLE alerts (
    id          BIGSERIAL PRIMARY KEY,
    location_id TEXT NOT NULL REFERENCES locations (id),
    type        TEXT NOT NULL,
    severity    TEXT NOT NULL CHECK (severity IN ('INFO', 'WARN', 'CRITICAL')),
    object_type TEXT NOT NULL,
    object_id   TEXT NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT,
    created_at  TIMESTAMPTZ NOT NULL,
    ack_by      BIGINT REFERENCES users (id),
    ack_at      TIMESTAMPTZ,
    UNIQUE (location_id, type, object_type, object_id)       -- без дублей (ТЗ 5.8)
);

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE clock_state (
    id          INT PRIMARY KEY CHECK (id = 1),
    mode        TEXT NOT NULL CHECK (mode IN ('REAL', 'SIM')),
    speed       INT NOT NULL DEFAULT 1 CHECK (speed > 0),
    paused      BOOLEAN NOT NULL DEFAULT FALSE,
    sim_anchor  TIMESTAMPTZ,
    real_anchor TIMESTAMPTZ
);
INSERT INTO clock_state (id, mode) VALUES (1, 'REAL');
