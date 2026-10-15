#!/bin/sh
# Залить проект хакатона в закрытый репозиторий GitHub: flagman + istok + supplier — одной папкой, рядом друг с другом
# (как на диске: deploy.sh и desktop/build.mjs ищут ../istok и ../supplier).
#   sh flagman/tools/publish-github.sh "что изменилось"
# Репозиторий — отдельная чистая копия ($REPO): в неё попадают только код и документы. Не попадают: ключи и .env,
# дамп базы и фото, выгрузки заказов, сборки и скачанные Java/PostgreSQL, ключ подписи Android.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
REPO="$ROOT/flagman-hackathon"
MSG="${1:-Обновление проекта}"

# Общие исключения для всех трёх папок; дальше у каждой — свои
sync_dir() {
  src=$1
  dst=$2
  shift 2
  rsync -a --delete --exclude='.git' --exclude='node_modules' --exclude='.DS_Store' --exclude='*.log' \
    --exclude='.env' --exclude='~$*' "$@" "$src/" "$dst/"
}

mkdir -p "$REPO"
sync_dir "$ROOT/flagman" "$REPO/flagman" \
  --exclude='/backend/config/' --exclude='/backend/target/' --exclude='/backend/data/' \
  --exclude='/frontend/dist/' --exclude='/frontend/tsconfig.tsbuildinfo' \
  --exclude='/desktop/.cache/' --exclude='/desktop/stage/' --exclude='/desktop/out/' \
  --exclude='/android/.gradle/' --exclude='/android/build/' --exclude='/android/app/build/' \
  --exclude='/android/keystore/' --exclude='/android/Flagman.apk' --exclude='/android/local.properties'
sync_dir "$ROOT/istok" "$REPO/istok" --exclude='/server/orders/'
sync_dir "$ROOT/supplier" "$REPO/supplier"
# Готовые приложения — на виду, в apps/ в корне: Android-приложение (1–2 МБ) лежит прямо в репозитории.
# Программа для Windows (~300 МБ) в репозиторий не помещается (лимит GitHub — 100 МБ) — она в Releases.
mkdir -p "$REPO/apps"
[ -f "$ROOT/flagman/android/Flagman.apk" ] && cp "$ROOT/flagman/android/Flagman.apk" "$REPO/apps/Flagman.apk"

# Последний рубеж: ни ключей, ни дампов, ни файлов .env
cd "$REPO"
leaks=$(grep -rIlE "sk_(istok|supplier)_[0-9a-f]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY" --exclude-dir=.git . || true)
files=$(find . -path ./.git -prune -o \( -name .env -o -name "*.dump" -o -name "*.jks" -o -name "*.keystore" \) -print)
if [ -n "$leaks$files" ]; then
  echo "Стоп: похоже на секреты — ничего не отправлено:" >&2
  printf '%s\n%s\n' "$leaks" "$files" >&2
  exit 1
fi

git add -A
if git diff --cached --quiet; then
  echo "Изменений нет"
  exit 0
fi
git commit -q -m "$MSG"
git push -q
echo "Отправлено: $(git log -1 --format='%h %s')"
