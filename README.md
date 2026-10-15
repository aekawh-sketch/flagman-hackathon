# Флагман — склад ресторана

Решение кейса «Флагман» хакатона: склад ресторана с партиями и сроками годности, списанием по FEFO,
автоматическим стоп-листом, горячими предложениями и защитой от умышленных списаний. Вокруг склада — пилотный
ресторан ИСТОК (сайт для гостей и касса) и портал поставщика, подключённые по API.

## Скачать приложения

- **Android** — [apps/Flagman.apk](apps/Flagman.apk)
- **Windows** — `Flagman-win-x64.zip` в разделе **Releases** (справа на главной странице репозитория)

Как поставить — [apps/README.md](apps/README.md).

## Сайты демо-стенда

| Что | Адрес | Вход |
|---|---|---|
| **CRM — склад «Флагман»** | http://31.76.28.248:8085 | «Демо-вход» → любая роль, пароль `demo1234` |
| **Сайт клиента — кафе ИСТОК** | http://31.76.28.248:8086 | без входа |
| **Сайт кассира — панель ресторана** | http://31.76.28.248:8086/panel/login.html | `demo-cashier` / `demo1234`, точка «Истокград» |
| **Сайт поставщика — поставки по API** | http://31.76.28.248:8087 | без входа |
| Документация API (Swagger, RU/EN) | http://31.76.28.248:8085/swagger-ui/index.html | — |

Демо-учётки склада: `demo-admin`, `demo-manager`, `demo-storekeeper`, `demo-cook`, `demo-cashier`, пароль `demo1234`.
PIN для подписи списаний: админ 1111, управляющий 2222, кладовщик 3333, повар 4444, кассир 5555.

Стенд демонстрационный: изменения видят все, «Демо-панель» (вход админом) ускоряет время, запускает сценарии
и сбрасывает данные.

## Приложения

| Платформа | Как получить | Что умеет |
|---|---|---|
| Браузер / PWA | адрес склада выше | всё; ставится на телефон и ПК как приложение |
| Windows | `cd flagman/desktop && npm install && node build.mjs` → `out/Flagman-win-x64.zip` | два режима: с сервером (тот же склад, что в браузере) или без сервера — своя база PostgreSQL и Java внутри программы |
| Android | `sh flagman/android/build-apk.sh [адрес склада]` → `flagman/android/Flagman.apk` | склад в приложении, сканер QR этикеток партий, фото с камеры для списаний и приёмки |

## Как всё связано

```
 Сайт клиента и касса (istok, :8086) ─── ключ сайта ──────┐
                                                            ▼
 Портал поставщика (supplier, :8087) ─ ключ поставщика ─▶  Склад «Флагман» (flagman, :8085) ──▶ PostgreSQL 16
                                                            ▲
 CRM в браузере, Windows, Android ─── вход сотрудника ─────┘
```

У каждой внешней системы — свой API-ключ и только нужные права: ключом сайта нельзя списать товар,
ключом поставщика — принять поставку. Изменения склада приходят на экраны сразу (SSE): «осталось N», стоп-лист,
горячие предложения.

## Что в репозитории

```
flagman/            склад — основной продукт
  backend/          Java 25, Spring Boot 4.1, PostgreSQL 16 (Flyway), 79 автотестов
    src/main/java/ru/sphere/stock/domain/   ядро на чистой Java: FEFO, сроки, стоп-лист, прогнозы, горячие предложения
  frontend/         React 19, TypeScript, Chakra UI 3, TanStack Query, Recharts
  desktop/          программа для Windows (Electron)
  android/          приложение для Android (WebView + сканер QR)
  deploy/           Docker Compose и скрипт деплоя на сервер
  presentation/     скриншоты для презентации
  TZ.md             полное техзадание и сверка с кейсом
istok/              пилотный ресторан ИСТОК: сайт для гостей, касса и панель персонала (Node.js + PostgreSQL)
supplier/           портал поставщика «ФрешПоставка» (Node.js, без зависимостей)
```

## Стек

| Часть | Технологии |
|---|---|
| Сервер склада | Java 25, Spring Boot 4.1 (Web MVC, Security, JDBC, Validation, Actuator), виртуальные потоки |
| База | PostgreSQL 16, миграции Flyway; SQL через JdbcClient, без ORM |
| API | REST + OpenAPI (Swagger на русском и английском), живые обновления SSE |
| Интерфейс | React 19, TypeScript, Chakra UI 3, TanStack Query, React Router, Recharts, Vite, PWA |
| Сайт и касса, портал поставщика | Node.js 22 (Express), PostgreSQL |
| Тесты | JUnit 5 + Spring Boot Test, интеграционные — на настоящем PostgreSQL |
| Сервер | Docker Compose на VPS |

Ключевые решения: заказ «всё или ничего» в одной транзакции под блокировкой склада точки; журнал движений только
на добавление с хэш-цепочкой (подделка видна); `CHECK` в базе не даёт уйти в минус; предприятия разделены
составными ключами `(tenant_id, id)`; повтор заказа или поставки с тем же ID не задваивает склад.

## Запуск у себя

Нужны Java 25, Node 22 и PostgreSQL 16.

**Склад:**

```bash
createdb flagman && createdb flagman_test
cd flagman/backend && ./mvnw spring-boot:run        # API на :8080; пустая база — демо-данные за ~10 с
cd flagman/frontend && npm install && npm run dev   # интерфейс на :5173
```

Ключи для сайта и портала — в `flagman/backend/config/application.yml` (в репозитории его нет, создайте сами):

```yaml
stock:
  site-api-key: sk_istok_...        # то же значение — FLAGMAN_API_KEY в istok/server/.env
  supplier-api-key: sk_supplier_... # то же значение — FLAGMAN_API_KEY в supplier/.env
```

**Сайт клиента и касса** (подробно — `istok/README.md`):

```bash
createdb istok_kush && psql -d istok_kush -f istok/server/schema.sql
createdb istok_kan  && psql -d istok_kan  -f istok/server/schema.sql
cp istok/server/.env.example istok/server/.env       # заполнить: база, FLAGMAN_URL, FLAGMAN_API_KEY
cd istok/server && npm install && npm start          # сайт — :3001, касса — :3001/panel/login.html
```

**Портал поставщика** (подробно — `supplier/README.md`):

```bash
cd supplier && npm start                             # :3002; .env: PORT, FLAGMAN_URL, FLAGMAN_API_KEY, SUPPLIER_NAME
```

## Тесты

```bash
cd flagman/backend && ./mvnw test
```

79 тестов: ядро (FEFO, сроки, прогнозы, стоп-лист, горячие предложения) и интеграционные на настоящем PostgreSQL —
50 параллельных заказов на последние порции, идемпотентность, журнал и обнаружение подделки, изоляция предприятий,
частичная приёмка, печать чеков на кухню и другие.

## Деплой на сервер

```bash
sh flagman/deploy/deploy.sh
```

Собирает склад, выкладывает склад, сайт с кассой и портал поставщика в Docker Compose на сервер (`/opt/flagman`).
Секреты (пароль базы, ключи сайта и поставщика) создаются на сервере один раз и хранятся только там, в `.env`.

## Чего нет в репозитории

Ключей и `.env`, дампов базы и загруженных фото, выгрузок заказов, ключа подписи Android-приложения, собранных
программ и скачанных для Windows-сборки Java и PostgreSQL.
