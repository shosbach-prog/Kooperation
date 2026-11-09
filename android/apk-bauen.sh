#!/usr/bin/env bash
# APK bauen, signieren, prüfen und als Download bereitlegen (public/dienstplan.apk + public/app-version.json).
# Aufruf: DIENSTPLAN_KEYSTORE_PASSWORD=… android/apk-bauen.sh <versionCode> <versionName>
# Signaturschlüssel: android/signing/dienstplan.jks oder Pfad in DIENSTPLAN_KEYSTORE.
set -euo pipefail
cd "$(dirname "$0")"
CODE="${1:?versionCode fehlt}"; NAME="${2:?versionName fehlt}"
# erwarteter Zertifikat-Fingerabdruck (öffentlich) – schützt davor, mit einem falschen Schlüssel zu signieren
ERWARTET="46e66093661eca8422b9b3b3274537577d006b037f09d2c4656a939704e937ee"

GRADLE="${GRADLE:-gradle}"
"$GRADLE" --no-daemon -q assembleRelease -PversionCode="$CODE" -PversionName="$NAME"
APK=app/build/outputs/apk/release/app-release.apk
BT="${ANDROID_HOME:-/opt/android-sdk}/build-tools/$(ls "${ANDROID_HOME:-/opt/android-sdk}/build-tools" | sort -V | tail -1)"
"$BT/apksigner" verify "$APK"
FP=$("$BT/apksigner" verify --print-certs "$APK" | sed -n 's/.*SHA-256 digest: //p' | head -1)
if [ "$FP" != "$ERWARTET" ]; then echo "FEHLER: falscher Signaturschlüssel ($FP)"; exit 1; fi
cp "$APK" ../public/dienstplan.apk
printf '{\n  "versionCode": %s,\n  "versionName": "%s",\n  "groesse_kb": %s,\n  "gebaut": "%s"\n}\n' \
  "$CODE" "$NAME" "$(( $(stat -c %s "$APK") / 1024 ))" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ../public/app-version.json
echo "APK $NAME ($CODE) bereit: public/dienstplan.apk"
