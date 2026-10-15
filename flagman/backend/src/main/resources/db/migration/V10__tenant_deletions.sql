-- Удалённые предприятия (ТЗ 16.9). Вместе с предприятием уходит и его аудит, поэтому след удаления —
-- здесь, на уровне платформы: что за предприятие, кто удалил (или внешняя система по ключу), когда и сколько данных.
CREATE TABLE tenant_deletions (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   BIGINT      NOT NULL,
    name        TEXT        NOT NULL,
    owner       TEXT,
    reason      TEXT,
    stats       JSONB       NOT NULL,
    deleted_by  BIGINT REFERENCES users (id),
    deleted_via TEXT        NOT NULL CHECK (deleted_via IN ('CONSOLE', 'API')),
    deleted_at  TIMESTAMPTZ NOT NULL
);
