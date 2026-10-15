-- ═══════════════════════════════════════════════════════════════════════════
--  Платформа (ТЗ 16.9): пользователи регистрируются сами и поначалу без предприятия, потом их приглашают или они
--  создают своё. Создание — сразу или через заявку, которую одобряет администратор платформы; режим переключается.
--  Администратор платформы — отдельная роль над всеми предприятиями, не связанная с ролями внутри них.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE users ADD COLUMN platform_admin BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE platform_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT INTO platform_settings (key, value) VALUES
    ('tenant_creation', 'APPROVAL'),      -- INSTANT — создаётся сразу, APPROVAL — заявка администратору платформы
    ('registration_open', 'true');        -- открытая регистрация без приглашения

CREATE TABLE tenant_requests (
    id               BIGSERIAL PRIMARY KEY,
    user_id          BIGINT NOT NULL REFERENCES users (id),
    name             TEXT NOT NULL,
    location_name    TEXT,
    comment          TEXT,
    status           TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELED')),
    created_at       TIMESTAMPTZ NOT NULL,
    decided_by       BIGINT REFERENCES users (id),   -- NULL при решении из внешней системы (CRM) по ключу платформы
    decided_via      TEXT CHECK (decided_via IN ('CONSOLE', 'API')),
    decided_at       TIMESTAMPTZ,
    decision_comment TEXT,
    tenant_id        BIGINT REFERENCES tenants (id)
);
-- Одна ждущая заявка на человека: повторная — только после решения по первой.
CREATE UNIQUE INDEX tenant_requests_one_pending ON tenant_requests (user_id) WHERE status = 'PENDING';
CREATE INDEX tenant_requests_status ON tenant_requests (status, created_at);

-- Демо: администратор платформы — отдельная учётка без предприятий (вход «Администратор платформы» — только в демо).
INSERT INTO users (login, name, platform_admin) VALUES ('demo-platform', 'Администратор платформы', TRUE)
ON CONFLICT (login) DO UPDATE SET platform_admin = TRUE;
