#!/bin/sh
# Проверка стенда на VPS: склад, Redis, сессии, живые обновления, сайт ИСТОК с кассой, портал поставщика.
#   sh deploy/check.sh                  — всё, включая перезапуск склада (сессия должна его пережить)
#   SKIP_RESTART=1 sh deploy/check.sh   — без перезапуска
# Секреты не печатаются: redis-cli берёт пароль из окружения внутри контейнера. Демо-данные не меняются.
IP=31.76.28.248
H=http://$IP
S=root@$IP
T=$(mktemp -d)
trap 'rm -rf "${T:?}"' EXIT
FAIL=0
ok() { printf '  ✓ %s\n' "$1"; }
bad() { printf '  ✗ %s\n' "$1"; FAIL=$((FAIL + 1)); }
remote() { ssh -o ConnectTimeout=10 "$S" "cd /opt/flagman && $1"; }
rc() { remote "docker compose exec -T redis sh -c 'REDISCLI_AUTH=\$REDIS_PASSWORD redis-cli --no-auth-warning $1'" | tr -d '\r'; }
code() { curl -s -o /dev/null -w '%{http_code}' -m 15 "$@"; }
is200() { [ "$(code "$@")" = 200 ]; }

echo "== Контейнеры"
remote "docker compose ps --format '{{.Service}}|{{.Status}}'" > "$T/ps"
for s in db redis app istok supplier; do
  st=$(grep "^$s|" "$T/ps" | cut -d'|' -f2)
  case "$st" in Up*) ok "$s: $st" ;; *) bad "$s: ${st:-нет}" ;; esac
done
remote "docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' \$(docker compose ps -q)" | sed 's/^/    /'

echo "== Redis: закрыт снаружи и требует пароль"
# Порт проверяем с самого VPS: с компьютера за VPN/прокси «открытыми» выглядят любые порты
pub=$(remote "timeout 3 bash -c '</dev/tcp/$IP/6379' 2>/dev/null && echo open || echo closed")
[ "$pub" = closed ] && ok "порт 6379 на публичном адресе закрыт" || bad "порт 6379 открыт наружу"
remote "ss -ltn 'sport = :6379' | tail -n +2 | grep -q ." && bad "на хосте кто-то слушает 6379" \
  || ok "на хосте 6379 никто не слушает (Redis только в сети Docker)"
case "$(remote "docker compose exec -T redis redis-cli ping" 2>&1)" in *NOAUTH*) ok "без пароля: NOAUTH" ;; *) bad "Redis отвечает без пароля" ;; esac
[ "$(rc ping)" = PONG ] && ok "с паролем: PONG" || bad "с паролем не отвечает"
echo "    $(rc 'INFO server' | grep '^redis_version') · $(rc 'CONFIG GET maxmemory-policy' | tr '\n' ' ')"

echo "== Склад :8085"
curl -fs -m 10 "$H:8085/actuator/health" | grep -q UP && ok "health UP" || bad "health не UP"
curl -s -m 15 -D "$T/h" -c "$T/jar" -H 'Content-Type: application/json' -d '{"login":"demo-manager","password":"demo1234"}' \
  "$H:8085/api/auth/login" -o "$T/login"
grep -q '"login":"demo-manager"' "$T/login" && ok "вход demo-manager" || bad "вход demo-manager"
cookie=$(grep -i '^set-cookie: SESSION=' "$T/h" | tail -1 | tr -d '\r')
case "$cookie" in *HttpOnly*SameSite=Strict*) ok "cookie SESSION: HttpOnly, SameSite=Strict" ;; *) bad "cookie: $cookie" ;; esac
grep -qi '^X-RateLimit-Limit' "$T/h" && ok "лимит запросов: $(grep -i '^X-RateLimit-Limit' "$T/h" | tr -d '\r')" || bad "нет X-RateLimit-Limit"
for ep in auth/me kush/dashboard kush/menu kush/hot-offers kush/stoplist/forecast kush/batches kush/purchase-suggestions \
          kush/alerts kush/inventory; do
  c=$(code -b "$T/jar" "$H:8085/api/$ep"); [ "$c" = 200 ] && ok "GET /api/$ep → 200" || bad "GET /api/$ep → $c"
done
is200 "$H:8085/v3/api-docs" && ok "Swagger" || bad "Swagger"
curl -fs -m 10 "$H:8085/" | grep -q 'id="root"' && ok "интерфейс склада" || bad "интерфейс склада"
# «Провести» принимает факт вместе с проведением — проверяем на несуществующем пересчёте, данные не меняются
c=$(code -b "$T/jar" -H 'Content-Type: application/json' -d '{"lines":[{"productId":"rice","actual":1}]}' \
  "$H:8085/api/kush/inventory/999999999/submit")
[ "$c" = 404 ] && ok "инвентаризация: «Провести» принимает факт (404 на чужом номере, не 400)" || bad "инвентаризация submit → $c"

echo "== Ключи склада в Redis"
rc "--scan --pattern 'flagman:*'" \
  | sed -E 's/sessions:[0-9a-f-]+/sessions:<id>/; s/(menu|hot|forecast):([a-z_]+):v[0-9.]+.*/\1:\2:v<версия>…/; s/rate:(user|key|ip):.*/rate:\1:…/' \
  | sort | uniq -c | sed 's/^/    /' | tee "$T/keys"
for k in menu:kush hot:kush forecast:kush session:sessions rate:user lock:job:expiry; do
  grep -q "flagman:$k" "$T/keys" && ok "есть flagman:${k}…" || bad "нет flagman:${k}…"
done
n=$(remote "docker compose logs --since 10m app 2>&1 | grep -c 'Redis недоступен'")
[ "$n" = 0 ] && ok "в журнале склада нет «Redis недоступен»" || bad "в журнале: «Redis недоступен» × $n"

echo "== Живые обновления: Redis Pub/Sub → SSE"
curl -s -N -m 9 -b "$T/jar" "$H:8085/api/kush/events" > "$T/sse" &
sleep 3
# JSON — через stdin (redis-cli -x), чтобы кавычки дошли до Redis нетронутыми
n=$(printf '%s' '{"location":"kush","type":"ping","data":{"from":"check"}}' \
  | remote "docker compose exec -T redis sh -c 'REDISCLI_AUTH=\$REDIS_PASSWORD redis-cli --no-auth-warning -x PUBLISH flagman:events'" | tr -d '\r')
echo "    PUBLISH flagman:events → получателей: $n"
wait
grep -q 'event:ping' "$T/sse" && ok "событие из Redis дошло до браузера" || bad "событие из Redis не дошло"
grep -q 'event:clock' "$T/sse" && ok "часы склада идут через Redis (event:clock)" || bad "нет event:clock"

echo "== Защита от перебора (логин-пустышка, не демо-учётка)"
who="check-$$"
codes=""
for i in 1 2 3 4 5 6; do
  codes="$codes $(code -H 'Content-Type: application/json' -d "{\"login\":\"$who\",\"password\":\"bad\"}" "$H:8085/api/auth/login")"
done
echo "    ответы:$codes"
case "$codes" in *" 401 401 401 401 401 429") ok "5 × 401, затем 429" ;; *) bad "ожидались 5 × 401 и 429" ;; esac
ttl=$(rc "TTL flagman:auth:lock:pwd:$who")
[ "$ttl" -gt 0 ] 2>/dev/null && ok "блокировка в Redis, снимется через ${ttl} с" || bad "нет ключа блокировки ($ttl)"
rc "DEL flagman:auth:lock:pwd:$who" >/dev/null

echo "== Сессия переживает перезапуск склада"
if [ -n "${SKIP_RESTART:-}" ]; then
  echo "    (пропущено)"
else
  remote "docker compose restart app" >/dev/null 2>&1
  for i in $(seq 1 60); do curl -fs -m 3 "$H:8085/actuator/health" >/dev/null 2>&1 && break; sleep 2; done
  c=$(code -b "$T/jar" "$H:8085/api/auth/me")
  [ "$c" = 200 ] && ok "после перезапуска склада та же cookie → /api/auth/me 200" || bad "после перезапуска /api/auth/me → $c"
fi

echo "== Сайт ИСТОК и касса :8086"
is200 "$H:8086/" && ok "сайт кафе" || bad "сайт кафе"
curl -s -m 15 "$H:8086/api/kush/bb/menu" -o "$T/menu"
python3 - "$T/menu" <<'PY' && ok "меню сайта — со склада (наличие и порции)" || bad "меню сайта без склада"
import json, sys
d = json.load(open(sys.argv[1]))
items = d.get("items", [])
left = [i for i in items if i.get("portions_left") is not None]
print(f"    блюд: {len(items)}, с остатком порций со склада: {len(left)}, в стопе: {sum(1 for i in items if not i.get('available'))}")
sys.exit(0 if items and left and not d.get("stock_offline") else 1)
PY
is200 "$H:8086/panel/login.html" && ok "страница входа кассира" || bad "страница входа кассира"
curl -s -m 15 -H 'Content-Type: application/json' -d '{"login":"demo-cashier","password":"demo1234"}' "$H:8086/api/login" -o "$T/cash"
grep -q '"ok":true' "$T/cash" && ok "вход кассира demo-cashier (через склад)" || bad "вход кассира"

echo "== Портал поставщика :8087"
is200 "$H:8087/" && ok "страница портала" || bad "страница портала"
curl -s -m 15 "$H:8087/api/info" -o "$T/info"
curl -s -m 15 "$H:8087/api/catalog?location=kush" -o "$T/cat"
python3 - "$T/info" "$T/cat" <<'PY' && ok "портал видит склад: рестораны и каталог" || bad "портал не получил данные склада"
import json, sys
info = json.load(open(sys.argv[1])); cat = json.load(open(sys.argv[2]))
rest = info.get("restaurants", []) if isinstance(info, dict) else []
items = cat if isinstance(cat, list) else cat.get("items", cat.get("products", []))
print(f"    ресторанов: {len(rest)}, позиций каталога точки kush: {len(items)}")
sys.exit(0 if rest and items else 1)
PY

echo
[ "$FAIL" = 0 ] && echo "ИТОГ: всё работает" || echo "ИТОГ: ошибок — $FAIL"
[ "$FAIL" = 0 ]
