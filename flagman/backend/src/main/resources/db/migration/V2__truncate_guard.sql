-- TRUNCATE не вызывает построчные триггеры — закрываем и эту лазейку для журнала (ТЗ 6.3).
CREATE FUNCTION forbid_truncate() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% is append-only: TRUNCATE is not allowed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER movements_no_truncate BEFORE TRUNCATE ON movements
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();
CREATE TRIGGER batches_no_truncate BEFORE TRUNCATE ON batches
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();
