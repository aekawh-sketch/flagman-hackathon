-- Владелец предприятия — его админ, а не тот, кто нажал «создать». Сам создал или заявку одобрили — владелец он.
-- Создала платформа (для клиента) — владельца нет, пока по ссылке с ролью «Админ» не придёт первый админ.
ALTER TABLE tenants ADD COLUMN owner_id BIGINT REFERENCES users (id);

UPDATE tenants t SET owner_id = t.created_by
WHERE EXISTS (SELECT 1 FROM memberships m
              WHERE m.tenant_id = t.id AND m.user_id = t.created_by AND m.role = 'ADMIN' AND m.active);
