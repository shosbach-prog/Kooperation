# Android-App (APK)

Die App ist eine **Trusted Web Activity**: Sie öffnet die Webanwendung im Vollbild über Chrome bzw. den Standard-Browser. Push-Benachrichtigungen, Kamera (AU-Foto), Passkeys und die Offline-Stempeluhr funktionieren deshalb genau wie im Browser, und jede neue Version der Webanwendung ist sofort auch in der App da – die APK muss nur neu gebaut werden, wenn sich Name, Symbol oder Adresse ändern.

- Paketname: `de.roboticstarter.dienstplan`
- Adresse: `https://roboticstarter.de/lwl/` (änderbar: `-PappUrl=https://…/`)
- Download für Beschäftigte: `https://roboticstarter.de/lwl/dienstplan.apk` (Hinweis erscheint auf Android-Geräten auf der Anmeldeseite und im Profil)

## Vollbild ohne Adressleiste

Android prüft beim Start `https://roboticstarter.de/.well-known/assetlinks.json` (liefert `server.js` automatisch). Stimmen Paketname und Zertifikat-Fingerabdruck, läuft die App ohne Adressleiste; sonst zeigt sie oben eine schmale Adresszeile, funktioniert aber trotzdem. Bei einem anderen Signaturschlüssel den Fingerabdruck in `deploy/.env` eintragen:

```
ANDROID_APP_SHA256=AA:BB:…
```

## Signaturschlüssel

`signing/dienstplan.jks` und das Passwort sind **nicht im Repository** (öffentlich!). Bewahren Sie beides sicher auf: Updates der App lassen sich nur mit demselben Schlüssel installieren.

## Automatisch bauen (GitHub Actions)

Sobald sich etwas unter `android/` ändert, baut GitHub die App neu (`.github/workflows/android-app.yml`), signiert sie, prüft den Zertifikat-Fingerabdruck und legt `public/dienstplan.apk` + `public/app-version.json` ins Repository. Der Server liefert sie nach dem nächsten (nächtlichen) Update aus; wer eine ältere App hat, sieht darin „Neue App-Version verfügbar“.

Einmalig einrichten – GitHub → Repository → **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Inhalt |
|---|---|
| `DIENSTPLAN_KEYSTORE_BASE64` | Inhalt von `signaturschluessel-base64.txt` |
| `DIENSTPLAN_KEYSTORE_PASSWORD` | Passwort aus `signaturschluessel-LIESMICH.txt` |

Ohne diese Einträge wird der Bau mit einem Hinweis übersprungen. Manuell starten: GitHub → **Actions → Android-App bauen → Run workflow**.

## Neu bauen (von Hand)

Voraussetzungen: JDK 17+, Android-SDK (Plattform 34, Build-Tools 34), Gradle 8.9+.

```bash
cd android
echo "sdk.dir=/pfad/zum/android-sdk" > local.properties
DIENSTPLAN_KEYSTORE_PASSWORD=… ./apk-bauen.sh 4 1.3     # versionCode, versionName
# Ergebnis: public/dienstplan.apk und public/app-version.json
```

Jede neue Version braucht einen höheren `versionCode` als die vorige.
