-- Предприятия создаёт только администратор платформы (ТЗ 16.14): режима «сразу» больше нет — только заявки ему.
UPDATE platform_settings SET value = 'APPROVAL' WHERE key = 'tenant_creation';
