#!/bin/sh
# Деплой на VPS: склад (backend + frontend), сайт ИСТОК с панелью ресторана (кассой) и портал поставщика.
#   sh deploy/deploy.sh              — собрать и выкатить
#   SKIP_BUILD=1 sh deploy/deploy.sh — выкатить уже собранное (backend/target, frontend/dist)
# Данные на сервере (базы, фото, выгрузки заказов) живут в томах Docker и переживают деплой.
set -eu

HOST=root@31.76.28.248
DIR=/opt/flagman
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ISTOK=$(cd "$ROOT/../istok" && pwd)
SUPPLIER=$(cd "$ROOT/../supplier" && pwd)

if [ -z "${SKIP_BUILD:-}" ]; then
  (cd "$ROOT/backend" && ./mvnw -q -DskipTests package)
  (cd "$ROOT/frontend" && npm run build)
fi
JAR=$(ls "$ROOT"/backend/target/stock-*.jar | grep -v '\.original$' | head -1)

STAGE=$(mktemp -d)
trap 'rm -rf "${STAGE:?}"' EXIT
cp "$ROOT/deploy/Dockerfile" "$ROOT/deploy/Dockerfile.istok" "$ROOT/deploy/Dockerfile.supplier" \
   "$ROOT/deploy/docker-compose.yml" "$STAGE/"
cp "$JAR" "$STAGE/stock.jar"
cp -R "$ROOT/frontend/dist" "$STAGE/web"
# Сайт ИСТОК — только код и статика: без .env и скрытых файлов (ключи этого компьютера), без выгрузок заказов
mkdir -p "$STAGE/istok/seed"
rsync -a --exclude node_modules --exclude orders --exclude '.*' "$ISTOK/server/" "$STAGE/istok/server/"
rsync -a --exclude tools --exclude '.*' "$ISTOK/site/" "$STAGE/istok/site/"
cp "$ISTOK/seed/menu.json" "$STAGE/istok/seed/"
cp "$ROOT/deploy/istok-init-db.js" "$STAGE/istok/server/init-db.js"
# Портал поставщика — так же: без .env (его ключ — от этого компьютера), без README
rsync -a --exclude node_modules --exclude README.md --exclude '.*' "$SUPPLIER/" "$STAGE/supplier/"

# Секреты создаются один раз на сервере и никуда не уходят: пароль базы, ключ сайта к складу, служебный пароль панели,
# пароль Redis
ssh "$HOST" sh -s "$DIR" <<'REMOTE'
set -eu
mkdir -p "$1" && cd "$1" && umask 077 && touch .env
for k in DB_PASSWORD SITE_API_KEY SUPPLIER_API_KEY ADMIN_TOKEN REDIS_PASSWORD; do
  grep -q "^$k=" .env && continue
  v=$(openssl rand -hex 24)
  [ "$k" = SITE_API_KEY ] && v="sk_istok_$v"
  [ "$k" = SUPPLIER_API_KEY ] && v="sk_supplier_$v"
  printf '%s=%s\n' "$k" "$v" >> .env
done
REMOTE
rsync -az --delete --exclude .env "$STAGE/" "$HOST:$DIR/"
ssh "$HOST" "cd $DIR && docker compose up -d --build && docker image prune -f >/dev/null"

echo "Ждём, пока склад, сайт и портал ответят ..."
for i in $(seq 1 60); do
  if curl -fs -m 3 http://31.76.28.248:8085/actuator/health >/dev/null && curl -fs -m 3 -o /dev/null http://31.76.28.248:8086/ \
     && curl -fs -m 3 -o /dev/null http://31.76.28.248:8087/; then
    echo "Готово: склад http://31.76.28.248:8085 · сайт и касса http://31.76.28.248:8086 · поставщик http://31.76.28.248:8087"
    exit 0
  fi
  sleep 3
done
echo "Не ответили за 3 минуты — журнал: ssh $HOST 'cd $DIR && docker compose logs --tail 80'" >&2
exit 1
