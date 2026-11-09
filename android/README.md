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

## Neu bauen

Voraussetzungen: JDK 17+, Android-SDK (Plattform 34, Build-Tools 34), Gradle 8.9+.

```bash
cd android
echo "sdk.dir=/pfad/zum/android-sdk" > local.properties
DIENSTPLAN_KEYSTORE_PASSWORD=… gradle assembleRelease
# Ergebnis: app/build/outputs/apk/release/app-release.apk → nach public/dienstplan.apk kopieren
```

Für eine neue Version `versionCode` in `app/build.gradle` erhöhen.
