-- Касса — не во Флагмане, а в панели ресторана (сайт ИСТОК): кассир входит туда своим логином и паролем.
-- Адрес панели — настройка предприятия; демо-предприятию — локальная панель ИСТОК (меняется в «Админке → Настройки»).
INSERT INTO settings (tenant_id, key, value)
SELECT 1, 'pos_url', 'http://localhost:3001/panel/login.html' WHERE EXISTS (SELECT 1 FROM tenants WHERE id = 1)
ON CONFLICT DO NOTHING;
