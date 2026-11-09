# Anmeldung über das Klinik-Konto (Single Sign-on)

Die App unterstützt **OpenID Connect**. Damit melden sich Beschäftigte mit ihrem gewohnten Klinik-Konto an (z. B. Microsoft Entra ID / Microsoft 365, Keycloak, ADFS) – ohne eigenes Passwort, die Mehrfaktor-Anmeldung übernimmt die Klinik-IT.

## Einrichtung bei Microsoft Entra ID (durch die IT)

1. Entra Admin Center → **App-Registrierungen** → *Neue Registrierung*
   - Name: „Personaleinsatzplanung“
   - Kontotyp: *Nur Konten in diesem Organisationsverzeichnis*
   - Umleitungs-URI (Web): `https://IHRE-ADRESSE/BASE_PATH/api/sso/callback`
     (z. B. `https://dienstplan.klinik.de/api/sso/callback`)
2. **Zertifikate & Geheimnisse** → *Neuer geheimer Clientschlüssel* → Wert notieren.
3. **API-Berechtigungen**: `openid`, `profile`, `email` (Microsoft Graph, delegiert) – Standard.
4. Optional: unter *Unternehmensanwendungen* → *Benutzer und Gruppen* nur die betroffenen Gruppen zulassen.

## Eintrag in `deploy/.env`

```
OIDC_ISSUER=https://login.microsoftonline.com/<Verzeichnis-(Mandanten-)ID>/v2.0
OIDC_CLIENT_ID=<Anwendungs-(Client-)ID>
OIDC_CLIENT_SECRET=<Wert des geheimen Clientschlüssels>
OIDC_NAME=Klinik-Konto
```

Danach `bash /opt/dienstplan/deploy/install.sh` (Konfiguration behalten).

## Zuordnung der Personen

Standardmäßig über die **E-Mail-Adresse in der Personalakte** (Groß-/Kleinschreibung egal). Ist für eine Klinik-Adresse niemand hinterlegt, erscheint ein Hinweis – Konten werden **nicht automatisch angelegt**. Alternativ `OIDC_ZUORDNUNG=benutzername` (Benutzername = Teil vor dem @).

## Sicherheit

- Authorization-Code-Verfahren mit **PKCE**, `state` und `nonce`; das ID-Token wird mit den öffentlichen Schlüsseln des Anbieters geprüft (Signatur, Aussteller, Empfänger, Ablauf).
- Die normale Anmeldung (Passwort + Code) bleibt als Ausweg erhalten, z. B. für den Hauptverwaltungs-Zugang bei Störungen der Klinik-Anmeldung.
