# Programm testen – ohne eigenen Server

Zum Ausprobieren gibt es zwei Wege. Beide starten mit **Demo-Daten**: zwei Stationen,
Früh-, Spät- und Nachtdienst sowie sechs Test-Mitarbeitende.

| Rolle | Benutzer | Passwort |
|---|---|---|
| Einsatzplanung (Manager) | `manager` | `manager123` |
| Mitarbeiter/in | `abecker`, `myilmaz`, `jschmitz`, `twagner`, `lhoffmann`, `kschulz` | `demo123` |

Bei der ersten Anmeldung jedes Kontos wird die **Zwei-Faktor-Anmeldung** eingerichtet. Halten Sie dafür
das Handy mit einer Authenticator-App bereit (Microsoft Authenticator, Google Authenticator oder FreeOTP).
In einer Authenticator-App können mehrere Test-Konten nebeneinander liegen.

---

## Weg 1: Im Browser ohne Installation (GitHub Codespaces)

Kostenlos mit Ihrem GitHub-Konto (derzeit bis zu 60 Stunden pro Monat).

1. https://github.com/shosbach-prog/kooperation öffnen und anmelden.
2. Grüner Knopf **„<> Code“** → Reiter **„Codespaces“** → **„Create codespace on main“**.
3. Ein bis zwei Minuten warten. Das Programm wird automatisch eingerichtet und gestartet.
   Es öffnet sich ein neuer Browser-Tab mit der Anmeldeseite.
   Öffnet sich kein Tab: unten auf den Reiter **„Ports“** klicken und bei Port 3000 auf das 🌐-Symbol.
4. **Auf dem Handy testen:** Im Reiter **„Ports“** mit der rechten Maustaste auf Port 3000 →
   **„Port Visibility“ → „Public“**. Dann die angezeigte Adresse auf dem Handy öffnen.
   (Nach dem Test wieder auf „Private“ stellen.)
5. Beenden: Den Tab schließen. Der Codespace schläft nach 30 Minuten ein und lässt sich unter
   https://github.com/codespaces wieder starten oder löschen.

## Weg 2: Auf dem eigenen PC

1. **Node.js** installieren: https://nodejs.org/de → Version „LTS“ herunterladen und installieren.
2. Auf https://github.com/shosbach-prog/kooperation → **„<> Code“** → **„Download ZIP“**,
   dann die ZIP-Datei entpacken.
3. Im entpackten Ordner doppelklicken:
   - **Windows:** `start-windows.bat`
     (Bei „Der Computer wurde durch Windows geschützt“: „Weitere Informationen“ → „Trotzdem ausführen“.)
   - **Mac:** `start-mac.command`
     (Beim ersten Mal mit rechter Maustaste → „Öffnen“ → „Öffnen“.)
4. Der Browser öffnet **http://localhost:3000**. Zum Beenden das schwarze Fenster schließen.

**Mit dem Handy im selben WLAN testen:** Statt `localhost` die IP-Adresse des PCs eingeben,
z. B. `http://192.168.178.25:3000`. Die IP findet man unter Windows mit `ipconfig`.
Die Installation als App geht so nicht, weil dafür HTTPS nötig ist.

Die Testdaten liegen im Ordner `data/`. Wer ihn löscht, startet wieder mit frischen Demo-Daten.

---

## Test-Drehbuch (ca. 20 Minuten)

Am besten mit zwei Browserfenstern: eines normal (Manager) und eines im privaten Modus
(Mitarbeiterin). Oder als Mitarbeiterin auf dem Handy.

### A. Als Manager (`manager`)
1. ☐ Anmelden und die 2FA mit dem Handy einrichten.
2. ☐ **Dienstzeiten:** Zeiten ansehen und z. B. den Frühdienst auf 06:15 ändern.
3. ☐ **Mindestbesetzung:** Werte ansehen. Unten steht die Regel „mindestens 1 Pflegefachkraft“.
4. ☐ **Plan erzeugen:** Schichten für die nächsten 4 Wochen anlegen.
5. ☐ **Dienstplan:** nächste Woche öffnen und über „+ Person eintragen“ zwei Personen einplanen.
   Rote Felder sind unterbesetzt.
6. ☐ **Mitarbeitende:** bei Anna Becker „Schwerbehinderung“ ankreuzen und speichern.

### B. Als Mitarbeiterin (`abecker`, privates Fenster oder Handy)
7. ☐ Anmelden und die 2FA einrichten.
8. ☐ **Dienstplan:** sich in einen Dienst **eintragen**.
9. ☐ Sich wieder **austragen**. Eine Begründung wird verlangt, und wenn die Mindestbesetzung
   unterschritten würde, sperrt das Programm.
10. ☐ **Urlaub & Krank:** Erholungsurlaub beantragen; das **Zusatzurlaub-Konto** ist sichtbar.
11. ☐ Sich **krank melden** für 5 Tage → Hinweis auf AU → eine PDF-Datei oder ein Foto hochladen.

### C. Wieder als Manager
12. ☐ **Abwesenheiten:** den Urlaubsantrag **genehmigen** (die rote Zahl am Menüpunkt verschwindet).
13. ☐ **Protokoll:** Ein- und Austragungen mit Begründung ansehen.
14. ☐ **Auswertung TVöD:** Soll/Ist, Urlaub, Krankheit, Zuschläge; **CSV-Export** in Excel öffnen.
15. ☐ **Einstellungen:** z. B. „AU ab Tag“ auf 1 setzen oder die Qualifikationsliste ergänzen.

Bitte notieren Sie, was fehlt, was unklar ist oder was anders sein soll. Dann wird es angepasst.
