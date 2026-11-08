# Installation auf einem netcup-Server

Zeitaufwand: etwa 20–30 Minuten. Die eigentliche Einrichtung übernimmt ein Skript.

> **Passt mein netcup-Produkt?** Nötig ist ein **VPS**, **Root-Server** oder **ARM-Server**
> (eigener Linux-Server). Ein **Webhosting**-Paket reicht **nicht**, weil es dort weder
> Node.js noch Docker gibt.

---

## Schritt 1: Betriebssystem installieren

1. Die E-Mail von netcup mit den Zugangsdaten zum **Server Control Panel (SCP)** heraussuchen
   und auf **https://www.servercontrolpanel.de** anmelden.
2. Den Server auswählen → **Medien** → **Images**.
3. **Ubuntu 24.04** (oder Debian 12) wählen, Variante „minimal“ ist ausreichend → installieren.
   Das **root-Passwort** wird angezeigt oder per E-Mail geschickt. Notieren.
4. Unter **Netzwerk** (oder auf der Übersichtsseite) die **IPv4-Adresse** notieren,
   z. B. `152.53.12.34`.

## Schritt 2: Internetadresse auf den Server zeigen lassen

**Variante A: eigene Domain bei netcup**
1. Im **Customer Control Panel** (https://www.customercontrolpanel.de) → **Domains** →
   bei Ihrer Domain auf **DNS**.
2. Einen neuen Eintrag anlegen:
   Host `dienstplan`, Typ **A**, Ziel = **IPv4-Adresse des Servers**.
3. Speichern. Die Adresse lautet dann `dienstplan.ihre-domain.de`.
   Es kann bis zu einer Stunde dauern, bis der Eintrag überall bekannt ist.

**Variante B: ohne eigene Domain (kostenlos)**
1. Auf **https://www.duckdns.org** anmelden, einen Namen anlegen, z. B. `lwl-dienstplan`.
2. Bei „current ip“ die **IPv4-Adresse des Servers** eintragen → **update ip**.
3. Die Adresse lautet dann `lwl-dienstplan.duckdns.org`.

## Schritt 3: Mit dem Server verbinden

**Windows:** Startmenü → „PowerShell“ öffnen. **Mac:** „Terminal“ öffnen.

```bash
ssh root@IHRE-IP-ADRESSE
```

Beim ersten Mal die Frage nach dem „fingerprint“ mit `yes` bestätigen, dann das root-Passwort
eingeben. Beim Tippen ist es nicht sichtbar, das ist normal.

## Schritt 4: Installationsskript ausführen

Diese zwei Befehle nacheinander einfügen:

```bash
curl -fsSL https://raw.githubusercontent.com/shosbach-prog/kooperation/main/deploy/install.sh -o install.sh
```

```bash
bash install.sh
```

Das Skript fragt nach:
- der **Adresse** aus Schritt 2 (z. B. `dienstplan.ihre-domain.de`),
- einem **Startpasswort** für den Benutzer `manager`,
- ob **Demo-Daten** angelegt werden sollen (für den ersten Test „j“, für den Echtbetrieb „n“).

Danach richtet es alles selbst ein:
- Systemupdates und **automatische Sicherheitsupdates**,
- **Firewall** (nur SSH, HTTP, HTTPS) und **Schutz gegen Passwort-Raten** (fail2ban),
- **Docker** und das Programm,
- **HTTPS-Zertifikat** (Let's Encrypt, automatisch verlängert),
- **tägliche Datensicherung** um 3 Uhr (14 Tage aufbewahrt).

Am Ende erscheint: **„Fertig! Der Dienstplan ist erreichbar unter: https://…“**

## Schritt 5: Erste Anmeldung

1. Die Adresse im Browser öffnen und mit `manager` und dem Startpasswort anmelden.
2. Die **Zwei-Faktor-Anmeldung** mit der Authenticator-App einrichten und die
   Wiederherstellungscodes ausdrucken oder sicher speichern.
3. Unter **Sicherheit** das Passwort ändern.
4. Die Klinik einrichten: **Einstellungen**, **Dienstzeiten**, **Mindestbesetzung** und **Mitarbeitende**.

---

## Später

| Was | Befehl auf dem Server |
|---|---|
| **Update einspielen** | `bash /opt/dienstplan/deploy/install.sh` (Konfiguration behalten → „J“) |
| Programm-Protokoll | `cd /opt/dienstplan/deploy && docker compose logs -f app` |
| Neustart | `cd /opt/dienstplan/deploy && docker compose restart` |
| Sicherung sofort erstellen | `cd /opt/dienstplan/deploy && docker compose exec -u node app node scripts/backup.js` |
| Sicherungen | liegen in `/opt/dienstplan/deploy/data/backups/` |

**Sicherung auf den eigenen Rechner holen.** Ab und zu ausführen (auf Ihrem PC, nicht auf dem Server):

```bash
scp -r root@IHRE-IP-ADRESSE:/opt/dienstplan/deploy/data/backups ./dienstplan-sicherung
```

**Zusätzlich empfohlen:** Im SCP unter **Snapshots** gelegentlich einen Snapshot des ganzen Servers anlegen.

## Wenn etwas nicht klappt

| Problem | Lösung |
|---|---|
| „Adresse antwortet noch nicht“ | DNS-Eintrag prüfen (zeigt er auf die richtige IP?), bis zu 1 Std. warten, dann `bash install.sh` erneut ausführen |
| Zertifikatsfehler im Browser | `cd /opt/dienstplan/deploy && docker compose logs caddy` ansehen |
| 2FA-Code wird abgelehnt | Uhrzeit auf dem Handy auf „automatisch“ stellen |
| Manager-Passwort und 2FA verloren | Bitte melden: Es lässt sich über die Datenbank zurücksetzen |

---

## Datenschutz (vor dem Echtbetrieb)

- Mit netcup im Customer Control Panel einen **Vertrag zur Auftragsverarbeitung (AVV)** abschließen.
  netcup betreibt seine Rechenzentren in Deutschland (Nürnberg).
- **Datenschutzbeauftragte/n, IT und Personalrat der LWL-Klinik einbinden.** Das System verarbeitet
  Gesundheitsdaten (Krankmeldungen, AU-Bescheinigungen, Schwerbehinderung). Solange keine
  Zustimmung vorliegt, bitte nur mit **erfundenen Testdaten** arbeiten.
- Für mehr Sicherheit bei der Server-Anmeldung später SSH-Schlüssel statt root-Passwort
  verwenden (netcup: SCP → „SSH-Keys“).
