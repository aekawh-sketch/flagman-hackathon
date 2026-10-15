-- Поставщик платформы (ТЗ 16.17): ключ без предприятия присылает поставки в любое предприятие платформы —
-- и в созданные позже. Заводит его только сервер (настройка stock.supplier-api-key), админ предприятия — нет.
ALTER TABLE api_keys ALTER COLUMN tenant_id DROP NOT NULL;

-- Каким ключом пришла поставка: внешняя система видит только свои поставки, а не чужие накладные с ценами.
ALTER TABLE deliveries ADD COLUMN api_key_id BIGINT REFERENCES api_keys (id);
CREATE INDEX deliveries_api_key ON deliveries (api_key_id) WHERE api_key_id IS NOT NULL;

-- Уже присланные порталом поставщика поставки — его ключу, чтобы «Наши отгрузки» не опустели.
UPDATE deliveries d SET api_key_id = k.id
FROM api_keys k
WHERE d.api_key_id IS NULL AND d.channel = 'API' AND d.supplier = 'ООО «ФрешПоставка»'
  AND k.name = 'Портал поставщика «ФрешПоставка»' AND k.revoked_at IS NULL;
