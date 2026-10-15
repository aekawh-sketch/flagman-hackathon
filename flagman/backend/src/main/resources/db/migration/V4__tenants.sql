-- ═══════════════════════════════════════════════════════════════════════════
--  Предприятия (ТЗ 16.4): у каждой строки данных — tenant_id, ссылка на предприятие.
--  Каталог адресуется парой (tenant_id, id): у двух предприятий может быть свой «milk».
--  Строки с точкой получают tenant_id от точки, а составной ключ (tenant_id, location_id)
--  не даёт им разойтись. Все текущие данные переезжают в демо-предприятие № 1.
--  ADD COLUMN … DEFAULT не переписывает строки, поэтому журнал «только на добавление» не трогаем.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE tenants (
    id         BIGSERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by BIGINT REFERENCES users (id)
);
INSERT INTO tenants (id, name)
VALUES (1, COALESCE((SELECT value FROM settings WHERE key = 'restaurant_name'), 'Демо-ресторан'));
SELECT setval('tenants_id_seq', 1);

-- ─── Точки ─────────────────────────────────────────────────────────────────

ALTER TABLE locations ADD COLUMN tenant_id BIGINT NOT NULL DEFAULT 1 REFERENCES tenants (id);
ALTER TABLE locations ALTER COLUMN tenant_id DROP DEFAULT;
ALTER TABLE locations ADD CONSTRAINT locations_tenant_id_key UNIQUE (tenant_id, id);

-- tenant_id строки = предприятие её точки (если код не указал явно).
CREATE FUNCTION tenant_from_location() RETURNS trigger AS $$
BEGIN
    IF NEW.tenant_id IS NULL AND NEW.location_id IS NOT NULL THEN
        SELECT tenant_id INTO NEW.tenant_id FROM locations WHERE id = NEW.location_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Все таблицы с точкой: колонка, ссылка на предприятие, связка (tenant_id, location_id), триггер.
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['deliveries', 'batches', 'ledger_heads', 'movements', 'orders', 'order_refusals',
                             'stoplist_state', 'stoplist_events', 'writeoff_requests', 'inventory_counts',
                             'anomalies', 'alerts', 'api_keys']
    LOOP
        EXECUTE format('ALTER TABLE %I ADD COLUMN tenant_id BIGINT NOT NULL DEFAULT 1 REFERENCES tenants (id)', t);
        EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id DROP DEFAULT', t);
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_location_id_fkey');
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id, location_id) '
                       'REFERENCES locations (tenant_id, id)', t, t || '_tenant_location_fkey');
        EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION tenant_from_location()',
                       t || '_tenant', t);
    END LOOP;
END;
$$;

-- ─── Каталог: ключи (tenant_id, id) ────────────────────────────────────────

-- Сначала снимаем все ссылки на старые одиночные ключи.
ALTER TABLE recipe_versions   DROP CONSTRAINT recipe_versions_semi_product_id_fkey;
ALTER TABLE recipe_versions   DROP CONSTRAINT recipe_versions_variant_id_fkey;
ALTER TABLE recipe_lines      DROP CONSTRAINT recipe_lines_product_id_fkey;
ALTER TABLE recipe_lines      DROP CONSTRAINT recipe_lines_version_id_fkey;
ALTER TABLE delivery_lines    DROP CONSTRAINT delivery_lines_product_id_fkey;
ALTER TABLE delivery_lines    DROP CONSTRAINT delivery_lines_delivery_id_fkey;
ALTER TABLE batches           DROP CONSTRAINT batches_product_id_fkey;
ALTER TABLE inventory_lines   DROP CONSTRAINT inventory_lines_product_id_fkey;
ALTER TABLE inventory_lines   DROP CONSTRAINT inventory_lines_count_id_fkey;
ALTER TABLE dish_variants     DROP CONSTRAINT dish_variants_dish_id_fkey;
ALTER TABLE set_items         DROP CONSTRAINT set_items_set_variant_id_fkey;
ALTER TABLE set_items         DROP CONSTRAINT set_items_variant_id_fkey;
ALTER TABLE order_lines       DROP CONSTRAINT order_lines_variant_id_fkey;
ALTER TABLE order_lines       DROP CONSTRAINT order_lines_order_id_fkey;
ALTER TABLE stoplist_state    DROP CONSTRAINT stoplist_state_variant_id_fkey;
ALTER TABLE stoplist_events   DROP CONSTRAINT stoplist_events_variant_id_fkey;
ALTER TABLE writeoff_requests DROP CONSTRAINT writeoff_requests_dish_variant_id_fkey;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['products', 'dishes', 'dish_variants', 'set_items', 'recipe_versions', 'recipe_lines',
                             'delivery_lines', 'order_lines', 'inventory_lines']
    LOOP
        EXECUTE format('ALTER TABLE %I ADD COLUMN tenant_id BIGINT NOT NULL DEFAULT 1 REFERENCES tenants (id)', t);
        EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id DROP DEFAULT', t);
    END LOOP;
END;
$$;

ALTER TABLE products      DROP CONSTRAINT products_pkey,      ADD PRIMARY KEY (tenant_id, id);
ALTER TABLE dishes        DROP CONSTRAINT dishes_pkey,        ADD PRIMARY KEY (tenant_id, id);
ALTER TABLE dish_variants DROP CONSTRAINT dish_variants_pkey, ADD PRIMARY KEY (tenant_id, id);
ALTER TABLE set_items     DROP CONSTRAINT set_items_pkey,     ADD PRIMARY KEY (tenant_id, set_variant_id, variant_id);
ALTER TABLE deliveries    DROP CONSTRAINT deliveries_pkey,    ADD PRIMARY KEY (tenant_id, id);
ALTER TABLE delivery_lines DROP CONSTRAINT delivery_lines_delivery_id_line_no_key,
                           ADD CONSTRAINT delivery_lines_tenant_delivery_line_key UNIQUE (tenant_id, delivery_id, line_no);
-- Родители, на которые дети ссылаются вместе с предприятием.
ALTER TABLE recipe_versions  ADD CONSTRAINT recipe_versions_tenant_id_key  UNIQUE (tenant_id, id);
ALTER TABLE orders           ADD CONSTRAINT orders_tenant_id_key           UNIQUE (tenant_id, id);
ALTER TABLE inventory_counts ADD CONSTRAINT inventory_counts_tenant_id_key UNIQUE (tenant_id, id);
ALTER TABLE batches          ADD CONSTRAINT batches_tenant_id_key          UNIQUE (tenant_id, id);

ALTER TABLE dish_variants ADD FOREIGN KEY (tenant_id, dish_id) REFERENCES dishes (tenant_id, id);
ALTER TABLE set_items     ADD FOREIGN KEY (tenant_id, set_variant_id) REFERENCES dish_variants (tenant_id, id),
                          ADD FOREIGN KEY (tenant_id, variant_id) REFERENCES dish_variants (tenant_id, id);
ALTER TABLE recipe_versions ADD FOREIGN KEY (tenant_id, variant_id) REFERENCES dish_variants (tenant_id, id),
                            ADD FOREIGN KEY (tenant_id, semi_product_id) REFERENCES products (tenant_id, id);
ALTER TABLE recipe_lines  ADD FOREIGN KEY (tenant_id, version_id) REFERENCES recipe_versions (tenant_id, id),
                          ADD FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id);
ALTER TABLE delivery_lines ADD FOREIGN KEY (tenant_id, delivery_id) REFERENCES deliveries (tenant_id, id),
                           ADD FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id);
ALTER TABLE batches       ADD FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id);
ALTER TABLE movements     ADD FOREIGN KEY (tenant_id, batch_id) REFERENCES batches (tenant_id, id);
ALTER TABLE inventory_lines ADD FOREIGN KEY (tenant_id, count_id) REFERENCES inventory_counts (tenant_id, id),
                            ADD FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id);
ALTER TABLE order_lines   ADD FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id),
                          ADD FOREIGN KEY (tenant_id, variant_id) REFERENCES dish_variants (tenant_id, id);
ALTER TABLE stoplist_state  ADD FOREIGN KEY (tenant_id, variant_id) REFERENCES dish_variants (tenant_id, id);
ALTER TABLE stoplist_events ADD FOREIGN KEY (tenant_id, variant_id) REFERENCES dish_variants (tenant_id, id);
ALTER TABLE writeoff_requests ADD FOREIGN KEY (tenant_id, dish_variant_id) REFERENCES dish_variants (tenant_id, id);

DROP INDEX recipe_active_variant;
DROP INDEX recipe_active_semi;
CREATE UNIQUE INDEX recipe_active_variant ON recipe_versions (tenant_id, variant_id)
    WHERE status = 'ACTIVE' AND variant_id IS NOT NULL;
CREATE UNIQUE INDEX recipe_active_semi ON recipe_versions (tenant_id, semi_product_id)
    WHERE status = 'ACTIVE' AND semi_product_id IS NOT NULL;
CREATE INDEX products_tenant ON products (tenant_id);

-- Строки документов наследуют предприятие родителя, если код его не указал.
CREATE FUNCTION tenant_from_parent() RETURNS trigger AS $$
BEGIN
    IF NEW.tenant_id IS NULL THEN
        CASE TG_TABLE_NAME
            WHEN 'order_lines' THEN SELECT tenant_id INTO NEW.tenant_id FROM orders WHERE id = NEW.order_id;
            WHEN 'inventory_lines' THEN SELECT tenant_id INTO NEW.tenant_id FROM inventory_counts WHERE id = NEW.count_id;
            WHEN 'recipe_lines' THEN SELECT tenant_id INTO NEW.tenant_id FROM recipe_versions WHERE id = NEW.version_id;
        END CASE;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER order_lines_tenant BEFORE INSERT ON order_lines FOR EACH ROW EXECUTE FUNCTION tenant_from_parent();
CREATE TRIGGER inventory_lines_tenant BEFORE INSERT ON inventory_lines FOR EACH ROW EXECUTE FUNCTION tenant_from_parent();
CREATE TRIGGER recipe_lines_tenant BEFORE INSERT ON recipe_lines FOR EACH ROW EXECUTE FUNCTION tenant_from_parent();

-- Правила аномалий различают предприятия: у двух может совпасть ID блюда в ключе.
ALTER TABLE anomalies DROP CONSTRAINT anomalies_rule_dedup_key_key,
                      ADD CONSTRAINT anomalies_tenant_rule_dedup_key UNIQUE (tenant_id, rule, dedup_key);

-- ─── Настройки и аудит — у каждого предприятия свои ────────────────────────

ALTER TABLE settings ADD COLUMN tenant_id BIGINT NOT NULL DEFAULT 1 REFERENCES tenants (id);
ALTER TABLE settings ALTER COLUMN tenant_id DROP DEFAULT;
ALTER TABLE settings DROP CONSTRAINT settings_pkey, ADD PRIMARY KEY (tenant_id, key);

-- NULL — действие над всей системой (демо-часы, полный сброс). Старые записи — демо-предприятия:
-- значение по умолчанию не переписывает строки, поэтому запрет UPDATE на аудите не мешает.
ALTER TABLE audit_log ADD COLUMN tenant_id BIGINT DEFAULT 1 REFERENCES tenants (id);
ALTER TABLE audit_log ALTER COLUMN tenant_id DROP DEFAULT;
-- Своя хэш-цепочка аудита у каждого предприятия (и одна — у общесистемных действий):
-- очистка логов одного предприятия не рвёт цепочку другого.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_seq_key;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_tenant_seq_key UNIQUE NULLS NOT DISTINCT (tenant_id, seq);

-- ─── Люди: учётка одна на систему, роль и точка — у членства ───────────────

CREATE TABLE memberships (
    user_id     BIGINT NOT NULL REFERENCES users (id),
    tenant_id   BIGINT NOT NULL REFERENCES tenants (id),
    role        TEXT NOT NULL CHECK (role IN ('COOK', 'CASHIER', 'STOREKEEPER', 'MANAGER', 'ADMIN')),
    location_id TEXT,                                   -- NULL — все точки предприятия
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, tenant_id),
    FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);
CREATE INDEX memberships_tenant ON memberships (tenant_id);
INSERT INTO memberships (user_id, tenant_id, role, location_id, active, created_at)
SELECT id, 1, role, location_id, active, created_at FROM users;
ALTER TABLE users DROP COLUMN role, DROP COLUMN location_id;
ALTER TABLE users ADD COLUMN last_tenant_id BIGINT REFERENCES tenants (id);

-- Приглашение: одноразовая ссылка с ролью и точкой; в базе — только хэш токена.
CREATE TABLE invitations (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants (id),
    token_hash  TEXT NOT NULL UNIQUE,
    role        TEXT NOT NULL CHECK (role IN ('COOK', 'CASHIER', 'STOREKEEPER', 'MANAGER', 'ADMIN')),
    location_id TEXT,
    note        TEXT,
    created_by  BIGINT NOT NULL REFERENCES users (id),
    created_at  TIMESTAMPTZ NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    accepted_by BIGINT REFERENCES users (id),
    accepted_at TIMESTAMPTZ,
    revoked_at  TIMESTAMPTZ,
    FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id)
);
CREATE INDEX invitations_tenant ON invitations (tenant_id);
