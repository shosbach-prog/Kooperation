# Installation auf einem IONOS-Server

Zeitaufwand: etwa 20–30 Minuten. Die eigentliche Einrichtung übernimmt ein Skript.

> **Passt mein IONOS-Produkt?** Nötig ist ein **VPS**, **Cloud Server** oder **Dedicated Server**
> mit Linux. Ein **Webhosting**-Paket („Hosting“, „WordPress“) reicht **nicht**.

---

## Schritt 1: Server vorbereiten

1. Auf **https://my.ionos.de** anmelden → **Server & Cloud** → Ihren Server anklicken (Cloud Panel).
2. **Betriebssystem:** Steht dort nicht **Ubuntu 24.04** (oder 22.04 bzw. Debian 12), dann über
   **Aktionen → Neu installieren** Ubuntu 24.04 wählen. *Dabei werden alle Daten auf dem Server gelöscht.*
3. Auf der Übersichtsseite notieren:
   - **IP-Adresse** (IPv4), z. B. `82.165.12.34`
   - **Benutzer** (meist `root`) und **Initial-Passwort** (über „Passwort anzeigen“)

## Schritt 2: Firewall prüfen

Im Cloud Panel links **Netzwerk → Firewall-Richtlinien** → die Richtlinie Ihres Servers öffnen.
Diese eingehenden Regeln müssen vorhanden sein (sonst mit **„Regel hinzufügen“** ergänzen):

| Protokoll | Port | Quelle |
|---|---|---|
| TCP | 22 | alle |
| TCP | 80 | alle |
| TCP | 443 | alle |

## Schritt 3: Internetadresse auf den Server zeigen lassen

**Variante A: Domain bei IONOS**
1. In my.ionos.de → **Domains & SSL** → bei Ihrer Domain auf das Zahnrad → **DNS**.
2. **Datensatz hinzufügen** → Typ **A**, Hostname `dienstplan`, Zeigt auf = **IP-Adresse des Servers**.
3. Speichern. Die Adresse lautet dann `dienstplan.ihre-domain.de`.
   Es kann bis zu einer Stunde dauern, bis der Eintrag überall bekannt ist.

**Variante B: ohne eigene Domain (kostenlos)**
Auf **https://www.duckdns.org** einen Namen anlegen und die **IP-Adresse des Servers** eintragen.
Die Adresse lautet dann z. B. `lwl-dienstplan.duckdns.org`.

## Schritt 4: Mit dem Server verbinden

**Windows:** Startmenü → „PowerShell“ öffnen. **Mac:** „Terminal“ öffnen.

```bash
ssh root@IHRE-IP-ADRESSE
```

Die Frage nach dem „fingerprint“ mit `yes` bestätigen und das Initial-Passwort eingeben.
Beim Tippen ist es nicht sichtbar, das ist normal.

## Schritt 5: Installationsskript ausführen

```bash
curl -fsSL https://raw.githubusercontent.com/shosbach-prog/kooperation/main/deploy/install.sh -o install.sh
```

```bash
bash install.sh
```

Das Skript fragt nach der **Adresse** aus Schritt 3, einem **Startpasswort** für `manager` und ob
**Demo-Daten** angelegt werden sollen (zum Testen „j“).
Danach richtet es Updates, Firewall, Docker, HTTPS-Zertifikat und die tägliche Sicherung selbst ein.
Am Ende steht: **„Fertig! Der Dienstplan ist erreichbar unter: https://…“**

## Schritt 6: Testen

- Adresse im Browser öffnen, als `manager` anmelden und die Zwei-Faktor-Anmeldung einrichten.
- Mit Demo-Daten: Mitarbeiter-Zugänge `abecker`, `myilmaz` … mit Passwort `demo123`.
- **Auf dem Handy:** Adresse öffnen und als App installieren
  (iPhone: Teilen → „Zum Home-Bildschirm“, Android: Menü → „App installieren“).
- Test-Drehbuch: [TESTEN.md](../TESTEN.md), Abschnitt „Test-Drehbuch“.

Updates, Sicherungen und Hilfe bei Problemen: siehe Tabellen in [NETCUP.md](NETCUP.md#später).
Die Befehle sind auf IONOS identisch.

**Zusätzlich empfohlen:** Im Cloud Panel unter **Snapshots** gelegentlich einen Snapshot anlegen.

## Datenschutz (vor dem Echtbetrieb)

- Mit IONOS einen **Vertrag zur Auftragsverarbeitung (AVV)** abschließen
  (my.ionos.de → Vertrag und Rechnung bzw. Datenschutz-Center).
  Beim Server ein Rechenzentrum in **Deutschland** wählen.
- **Datenschutzbeauftragte/n, IT und Personalrat der LWL-Klinik einbinden.** Bis dahin nur mit Testdaten arbeiten.
