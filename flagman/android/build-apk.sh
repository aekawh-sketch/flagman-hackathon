#!/bin/sh
# Сборка Android-приложения «Флагман»: sh build-apk.sh [адрес склада]  →  android/Flagman.apk
#   sh build-apk.sh                              — склад по умолчанию (VPS)
#   sh build-apk.sh http://203.0.113.10:8085     — другой сервер
# В установленном приложении адрес меняется без пересборки: долгое нажатие на иконку → «Адрес сервера».
set -eu
cd "$(dirname "$0")"

export JAVA_HOME="${JAVA_HOME_ANDROID:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
URL="${1:-http://31.76.28.248:8085}"

# Ключ подписи — один раз и только на этом компьютере. Обновление приложения ставится поверх старого,
# только если подписано тем же ключом — поэтому keystore/ не удаляйте (в git его нет).
if [ ! -f keystore/keystore.properties ]; then
  mkdir -p keystore
  PASS=$(openssl rand -hex 16)
  "$JAVA_HOME/bin/keytool" -genkeypair -keystore keystore/flagman.jks -alias flagman -keyalg RSA -keysize 2048 \
    -validity 10000 -storepass "$PASS" -keypass "$PASS" -dname "CN=Flagman, O=Sphere Digital Agency, C=RU" >/dev/null 2>&1
  (umask 077 && printf 'storeFile=flagman.jks\nstorePassword=%s\nkeyAlias=flagman\nkeyPassword=%s\n' "$PASS" "$PASS" \
    > keystore/keystore.properties)
fi

./gradlew -q assembleRelease -PserverUrl="$URL"
cp app/build/outputs/apk/release/app-release.apk Flagman.apk
echo "✓ $(pwd)/Flagman.apk — склад по умолчанию: $URL"
