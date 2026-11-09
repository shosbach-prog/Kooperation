# Sicherung, Wiederherstellung und Überwachung

## 1. Tägliche verschlüsselte Sicherung

`install.sh` richtet einen Cron-Job ein, der jede Nacht um 3 Uhr `deploy/backup-cron.sh` ausführt. Dabei passiert Folgendes:

- Die Datenbank wird im laufenden Betrieb konsistent kopiert, zusammen mit den AU-Bescheinigungen, dem Logo und den Profilfotos.
- Alles wird zu **einer Datei** `data/backups/sicherung-JJJJ-MM-TT-HH-MM.pep` verpackt und mit **AES-256-GCM** verschlüsselt.
- Sicherungen, die älter als 14 Tage sind, werden gelöscht (`BACKUP_TAGE` in `.env`).
- `data/backups/letzte-sicherung.json` hält fest, wann die letzte Sicherung lief und ob sie erfolgreich war.

Das Passwort steht als `BACKUP_PASSWORT` in `deploy/.env`. `install.sh` erzeugt es beim ersten Lauf und zeigt es einmal an.
**Bewahren Sie es zusätzlich außerhalb des Servers auf**, zum Beispiel im Passwort-Safe der IT. Ohne dieses Passwort lässt sich keine Sicherung wiederherstellen.

Eine Sicherung sofort erstellen:

```bash
/opt/dienstplan/deploy/backup-cron.sh
```

Das Protokoll der Sicherungen steht in `/var/log/dienstplan-backup.log`.

## 2. Kopie auf einen zweiten Rechner (dringend empfohlen)

Eine Sicherung auf demselben Server hilft nicht, wenn der Server ausfällt. Tragen Sie deshalb in `deploy/.env` ein Ziel ein:

```
BACKUP_KOPIE_ZIEL=sicherung@nas.example.de:/sicherungen/dienstplan
```

Danach einmalig einen SSH-Schlüssel hinterlegen:

```bash
ssh-keygen -t ed25519 -N "" -f /root/.ssh/id_ed25519
ssh-copy-id sicherung@nas.example.de
```

Ab dann überträgt der Cron-Job jede Nacht die verschlüsselten `.pep`-Dateien per `rsync`. Weil die Dateien verschlüsselt sind, darf das Ziel auch ein einfacher Speicher sein, etwa ein NAS oder ein Storage-Box-Tarif des Hosters.

Alternativ holen Sie die Sicherungen von Ihrem PC aus ab:

```bash
scp root@IHRE-IP:/opt/dienstplan/deploy/data/backups/*.pep ./dienstplan-sicherung/
```

## 3. Wiederherstellen

```bash
cd /opt/dienstplan/deploy
# 1. Sicherung prüfen (fragt nach dem Passwort, schreibt nichts)
docker compose exec -u node app node scripts/restore.js /data/backups/sicherung-2026-11-08-03-00.pep --pruefen
# 2. Entpacken
docker compose exec -u node app node scripts/restore.js /data/backups/sicherung-2026-11-08-03-00.pep /data/wiederherstellung
# 3. Dienst anhalten, Daten austauschen, wieder starten
docker compose stop app
mv data/personaleinsatz.db data/personaleinsatz.db.alt
mv data/uploads data/uploads.alt
cp data/wiederherstellung/personaleinsatz.db data/
cp -r data/wiederherstellung/uploads data/
rm -f data/personaleinsatz.db-wal data/personaleinsatz.db-shm
docker compose start app
```

**Testen Sie eine Wiederherstellung mindestens einmal im Quartal**, zum Beispiel mit `--pruefen`. Eine Sicherung, die nie zurückgespielt wurde, ist keine.

## 4. Überwachung (Erreichbarkeit und Sicherung)

Die Anwendung meldet ihren Zustand unter:

| Adresse | Bedeutung |
|---|---|
| `https://roboticstarter.de/lwl/api/health` | 200 = läuft, Datenbank lesbar, genug Speicherplatz; sonst 503 |
| `https://roboticstarter.de/lwl/api/health?backup=1` | zusätzlich 503, wenn die letzte Sicherung fehlgeschlagen oder älter als 26 Std. ist |

Die Antwort enthält keine personenbezogenen Daten.

Ein kostenloser Überwachungsdienst kann diese Adresse alle 5 Minuten aufrufen und Sie per E-Mail oder App benachrichtigen, zum Beispiel:

- **UptimeRobot** (uptimerobot.com, kostenloser Tarif): Monitor-Typ „HTTP(s)“ oder „Keyword“ mit dem Wort `"status":"ok"` und dem Intervall 5 Minuten. Legen Sie einen zweiten Monitor mit `?backup=1` und dem Intervall 1 Stunde an.
- **Uptime Kuma**: selbst gehostet, zum Beispiel auf einem anderen Server oder NAS. Der Monitor-Typ ist „HTTP(s) – Keyword“.
- **Healthchecks.io**: Alternativ kann sich der Cron-Job selbst melden. Hängen Sie dazu `&& curl -fsS https://hc-ping.com/IHRE-ID` an die Zeile in `/etc/cron.d/dienstplan-backup` an. Bleibt die Meldung aus, kommt eine Warnung.

Docker prüft den Zustand zusätzlich selbst (`HEALTHCHECK`). `docker compose ps` zeigt `healthy` oder `unhealthy`.

## 5. Automatische Updates

`install.sh` richtet auf Wunsch (Standard: an) ein nächtliches Update um 4:30 Uhr ein (`deploy/auto-update.sh`):
neue Version holen → **Sicherung** → einspielen → **Funktion prüfen** → bei einem Fehler **automatisch zurück** zur vorherigen Version.
Eine fehlgeschlagene Version wird nicht jede Nacht erneut versucht. Protokoll: `/var/log/dienstplan-update.log`.
Ein-/Ausschalten: `AUTO_UPDATE=1` bzw. `0` in `deploy/.env`, danach `install.sh`. Sofort auslösen: `/opt/dienstplan/deploy/auto-update.sh`.

## 6. Weitere Empfehlungen für den Echtbetrieb

- Automatische Sicherheitsupdates des Servers aktivieren: `apt install unattended-upgrades`.
- Das Server-Protokoll gelegentlich prüfen: `docker compose logs --since 24h app`.
- Updates der Anwendung einspielen: `bash /opt/dienstplan/deploy/install.sh` und dabei die Konfiguration behalten (`J`).
