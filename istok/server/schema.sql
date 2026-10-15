-- ================================================================
--  ИСТОК — заказы ресторана (по базе на точку: istok_kush, istok_kan)
--  Запуск: createdb istok_kush && psql -d istok_kush -f schema.sql
--  Скрипт можно запускать повторно: он только дополняет схему.
--  Склад (партии, сроки, стоп-лист) — не здесь, а во «Флагмане».
-- ================================================================

CREATE SEQUENCE IF NOT EXISTS bb_order_number_seq START 1001;

CREATE TABLE IF NOT EXISTS bb_orders (
  id                  SERIAL        PRIMARY KEY,
  iiko_id             VARCHAR(100)  NOT NULL UNIQUE,     -- внешний номер; он же externalId заказа во Флагмане
  order_number        INTEGER       NOT NULL UNIQUE DEFAULT nextval('bb_order_number_seq'),
  customer            VARCHAR(255)  NOT NULL,
  phone               VARCHAR(50)   NOT NULL,
  address             TEXT          NOT NULL DEFAULT 'Самовывоз',
  type                VARCHAR(20)   NOT NULL CHECK (type IN ('delivery', 'pickup')),
  comment             TEXT          NOT NULL DEFAULT '',
  items               JSONB         NOT NULL,
  total_items         INTEGER       NOT NULL,
  delivery_cost       INTEGER       NOT NULL DEFAULT 0,
  grand_total         INTEGER       NOT NULL,
  status              VARCHAR(50)   NOT NULL DEFAULT 'Новый',
  confirmed_by_client BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Новое в ИСТОК: оплата, источник, связь со складом
ALTER TABLE bb_orders ADD COLUMN IF NOT EXISTS payment          VARCHAR(10)  NOT NULL DEFAULT 'cash';
ALTER TABLE bb_orders ADD COLUMN IF NOT EXISTS source           VARCHAR(20)  NOT NULL DEFAULT 'site';  -- site | kassir | simulator
ALTER TABLE bb_orders ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW();
ALTER TABLE bb_orders ADD COLUMN IF NOT EXISTS flagman_order_id BIGINT;
-- ok — склад списал продукты; pending — склад был недоступен, отправим позже; failed — склад отказал позже
ALTER TABLE bb_orders ADD COLUMN IF NOT EXISTS stock_sync       VARCHAR(10)  NOT NULL DEFAULT 'ok';
ALTER TABLE bb_orders ADD COLUMN IF NOT EXISTS stock_note       TEXT;
-- Строки заказа в терминах склада: [{ variantId, qty }]
ALTER TABLE bb_orders ADD COLUMN IF NOT EXISTS stock_lines      JSONB;

CREATE INDEX IF NOT EXISTS idx_bb_orders_status       ON bb_orders (status);
CREATE INDEX IF NOT EXISTS idx_bb_orders_created_at   ON bb_orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bb_orders_order_number ON bb_orders (order_number DESC);
CREATE INDEX IF NOT EXISTS idx_bb_orders_date_msk     ON bb_orders (DATE(created_at AT TIME ZONE 'Europe/Moscow'));
CREATE INDEX IF NOT EXISTS idx_bb_orders_flagman      ON bb_orders (flagman_order_id);
CREATE INDEX IF NOT EXISTS idx_bb_orders_stock_sync   ON bb_orders (stock_sync) WHERE stock_sync <> 'ok';

DROP VIEW IF EXISTS bb_orders_view;
CREATE VIEW bb_orders_view AS
SELECT
  id, order_number, iiko_id, customer, phone, address, type, comment,
  items, total_items, delivery_cost, grand_total, status, confirmed_by_client,
  payment, source, updated_at, flagman_order_id, stock_sync, stock_note,
  to_char(created_at AT TIME ZONE 'Europe/Moscow', 'DD.MM.YYYY HH24:MI') AS created_fmt,
  created_at
FROM bb_orders
ORDER BY created_at DESC;
