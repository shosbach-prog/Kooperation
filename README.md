# Personaleinsatzplanung – Prototyp für die LWL-Klinik Dortmund

Webanwendung zur Dienst- und Einsatzplanung im Mehrschichtbetrieb. Die
Arbeitszeit wird angelehnt an den **TVöD (BT-K)** angerechnet.

## Funktionen

**Einsatzplanung (Manager)**
- **Dienstzeiten** festlegen (z. B. Früh-, Spät- und Nachtdienst) mit Beginn, Ende und Pause, auch über Mitternacht
- **Bereiche/Stationen** verwalten
- **Mindestbesetzung** (und optionale Höchstbesetzung) je Station, Dienst und Wochentag festlegen
- **Plan erzeugen:** Schichten für einen Zeitraum automatisch aus der Mindestbesetzung anlegen
- Dienstplan als **Wochenraster**, farbig markiert: unterbesetzt / Minimum erreicht / voll
- Personen ein- und austragen; Ausnahmen bei Ruhezeit oder Vollbesetzung nur nach Bestätigung
- Besetzung und Notiz einzelner Schichten ändern
- **Mitarbeitende** verwalten: Qualifikation, Wochenstunden, **Mindestverfügbarkeit (Std./Monat)**, Stundenentgelt
- **Auswertung TVöD** je Monat: Soll, Ist, Saldo, Nacht-, Sonntags-, Feiertags- und Vorfeststunden, Zuschläge in Euro, Liste der unterbesetzten Schichten, **CSV-Export** für Excel
- **Einstellungen:** Zuschlagssätze, Nachtzeitraum, Ruhezeit, Austragsfrist

**Mitarbeitende**
- Melden sich **selbst für Dienste an** und tragen sich **selbst wieder aus**
- Austragen ist nur bis zur eingestellten Frist möglich (Standard: 72 Std. vor Dienstbeginn) und nur, wenn die Mindestbesetzung nicht unterschritten wird
- **Meine Dienste:** Übersicht der kommenden Dienste
- **Stundenkonto:** Soll/Ist, Fortschritt zur Mindestverfügbarkeit, Zuschläge

**Anmeldung mit Zwei-Faktor-Authentifizierung (2FA)**
- Anmeldung mit Passwort **und** einem 6-stelligen Code aus einer Authenticator-App (TOTP nach RFC 6238), z. B. Microsoft Authenticator, Google Authenticator oder FreeOTP
- Bei der ersten Anmeldung wird die App per **QR-Code** eingerichtet; als Ersatz gibt es einen Schlüssel zum Abtippen
- 10 **Wiederherstellungscodes**, falls das Handy verloren geht; jeder Code gilt nur einmal
- 2FA ist standardmäßig **Pflicht für alle** (abschaltbar unter Einstellungen)
- **Sperre** für 15 Minuten nach 5 Fehlversuchen (Passwort oder Code)
- Ein bereits benutzter Code wird kein zweites Mal angenommen
- Die Einsatzplanung kann bei Handyverlust die **2FA zurücksetzen** und gesperrte Konten **entsperren**
- Unter **Sicherheit**: Passwort ändern, neues Handy einrichten, neue Wiederherstellungscodes erzeugen

**Automatische Prüfungen**
- Keine Überschneidung von Diensten
- Mindestruhezeit zwischen zwei Diensten (Standard 11 Std., § 5 ArbZG)
- Höchstbesetzung je Schicht

## Berechnung nach TVöD

| Regel | Umsetzung (Standardwerte, einstellbar) |
|---|---|
| Soll-Arbeitszeit (§ 6) | Wochenstunden ÷ 5 je Werktag (Mo–Fr); Feiertage und der 24./31.12. an Werktagen verringern das Soll |
| Nachtarbeit (§ 7 Abs. 5) | 21–6 Uhr, Zuschlag 20 % |
| Nachtschicht (§ 7 Abs. 1) | Schicht mit mindestens 2 Std. Nachtarbeit |
| Sonntagsarbeit | 25 % |
| Feiertagsarbeit | 35 % (mit Freizeitausgleich; ohne Freizeitausgleich 135 %) |
| 24.12./31.12. ab 6 Uhr | 35 % |
| Samstag 13–21 Uhr | 20 %, im Schichtdienst standardmäßig **aus** |
| Zusammentreffen (§ 8 Abs. 1 S. 3) | Bei Feiertag, Vorfesttag, Sonntag und Samstag zählt nur der höchste Zuschlag; der Nachtzuschlag kommt zusätzlich hinzu |
| Feiertage | gesetzliche Feiertage NRW, automatisch berechnet |
| Euro-Betrag | Stunden × Prozentsatz × hinterlegtes Stundenentgelt (Stufe 3 der Entgeltgruppe) |

Die Pause wird nicht als Arbeitszeit angerechnet und anteilig von den
Zuschlagsstunden abgezogen.

> **Wichtig:** Die Prozentsätze sind Vorgabewerte und müssen mit dem aktuell
> gültigen Tarifstand bzw. den Regelungen im Haus abgeglichen werden.
> Der Prototyp ersetzt keine Entgeltabrechnung.

## Starten

Voraussetzung: **Node.js ≥ 22.13**. Die Datenbank (SQLite) ist bereits in Node.js enthalten.

```bash
npm install
npm start
```

Danach im Browser **http://localhost:3000** öffnen.

### Zugänge für die Demo

| Rolle | Benutzer | Passwort |
|---|---|---|
| Einsatzplanung (Manager) | `manager` | `manager123` |
| Mitarbeiter/in | `abecker`, `myilmaz`, `jschmitz`, `twagner`, `lhoffmann`, `kschulz` | `demo123` |

Bei der ersten Anmeldung jedes Kontos wird die Einrichtung der 2FA verlangt.
Halten Sie dafür ein Handy mit Authenticator-App bereit.

Die Passwörter bitte **vor jedem echten Einsatz ändern**.

### Betrieb im Kliniknetz

- Die Anwendung **nur über HTTPS** bereitstellen, z. B. hinter dem vorhandenen Reverse-Proxy, und dann `COOKIE_SECURE=1` setzen.
- Die Uhrzeit des Servers muss stimmen (NTP), sonst werden die 2FA-Codes abgelehnt.
- Die Datenbankdatei (`data/`) enthält Personaldaten. Sie gehört in die Datensicherung und muss vor fremdem Zugriff geschützt werden.
- Vor dem Echtbetrieb Datenschutzbeauftragte/n und Personalrat einbinden (Dienstplanung ist mitbestimmungspflichtig).

### Konfiguration (Umgebungsvariablen)

| Variable | Bedeutung | Standard |
|---|---|---|
| `PORT` | HTTP-Port | `3000` |
| `DB_FILE` | Pfad der SQLite-Datenbank | `data/personaleinsatz.db` |
| `MANAGER_PASSWORD` | Startpasswort des Managers bei der ersten Einrichtung | `manager123` |
| `COOKIE_SECURE` | `1` = Anmelde-Cookie nur über HTTPS senden (im Echtbetrieb setzen) | `0` |
| `SEED_DEMO` | `0` = ohne Demo-Stationen, Demo-Dienste und Demo-Personal starten | `1` |

### Tests

```bash
npm test
```

## Erste Schritte (Manager)

1. Unter **Dienstzeiten** die Dienste und Stationen der Klinik eintragen
2. Unter **Mindestbesetzung** festlegen, wie viele Personen je Dienst und Wochentag mindestens (und höchstens) nötig sind
3. Unter **Mitarbeitende** das Personal anlegen, mit Wochenstunden und Mindestverfügbarkeit
4. Unter **Plan erzeugen** die Schichten für z. B. die nächsten 4 Wochen anlegen
5. Die Mitarbeitenden tragen sich selbst ein; im **Dienstplan** und in der **Auswertung** sehen Sie die Lücken

## Aufbau

```
server.js          Startpunkt
src/app.js         REST-API (Express), Berechtigungen, Planungsregeln
src/db.js          SQLite-Schema, Startdaten, Passwort-Hashing (scrypt)
src/totp.js        Einmalcodes für die Zwei-Faktor-Anmeldung (RFC 6238)
src/tvoed.js       Feiertage NRW, Soll-Stunden, Zuschlagsberechnung
public/            Oberfläche (HTML/CSS/JavaScript, ohne Build-Schritt)
test/              Tests (node:test)
```

## Mögliche nächste Schritte

- Mindestbesetzung je **Qualifikation** (z. B. mindestens 1 Pflegefachkraft im Nachtdienst)
- Urlaub, Krankheit und Abwesenheiten mit Anrechnung auf das Soll
- Wunschdienste und Tauschbörse unter Kolleginnen und Kollegen
- Benachrichtigung per E-Mail bei offenen Schichten
- Wechselschicht- und Schichtzulage (§ 8 Abs. 5/6), Bereitschaftsdienst, Rufbereitschaft
- Anbindung an das Zeiterfassungs- oder Lohnsystem (z. B. als Export)
- Anmeldung über das Klinik-Verzeichnis (Single Sign-on, z. B. Active Directory / Entra ID)
