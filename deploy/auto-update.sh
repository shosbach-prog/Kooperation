#!/usr/bin/env bash
# Nächtliches automatisches Update (Cron, eingerichtet von install.sh):
#   1. neue Version auf GitHub?   2. Datensicherung   3. Update einspielen (install.sh ohne Rückfragen)
#   4. Funktion prüfen (/api/health im Container)   5. bei Fehler automatisch zurück zur vorherigen Version
# Eine fehlgeschlagene Version wird gemerkt und nicht jede Nacht erneut versucht.
# Von Hand auslösen:  /opt/dienstplan/deploy/auto-update.sh
set -uo pipefail
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_DIR="$INSTALL_DIR/deploy"
FEHLER_DATEI="$DEPLOY_DIR/.update-fehlgeschlagen"
echo "=== $(date '+%F %T') Automatisches Update"
grep -q '^AUTO_UPDATE=1' "$DEPLOY_DIR/.env" 2>/dev/null || { echo "ausgeschaltet (AUTO_UPDATE=1 in .env)"; exit 0; }
cd "$INSTALL_DIR" || exit 1

git fetch -q origin main || { echo "GitHub nicht erreichbar – nächste Nacht erneut"; exit 0; }
ALT=$(git rev-parse HEAD)
NEU=$(git rev-parse origin/main)
if [ "$ALT" = "$NEU" ]; then echo "bereits aktuell (${ALT:0:7})"; exit 0; fi
if [ -f "$FEHLER_DATEI" ] && [ "$(cat "$FEHLER_DATEI")" = "$NEU" ]; then
  echo "Version ${NEU:0:7} ist bereits einmal fehlgeschlagen – übersprungen, bis eine neuere kommt"; exit 0
fi
echo "Update ${ALT:0:7} → ${NEU:0:7}:"
git log --oneline "$ALT..$NEU" | sed 's/^/  /'

"$DEPLOY_DIR/backup-cron.sh" || { echo "FEHLER: Sicherung fehlgeschlagen – Update abgebrochen"; exit 1; }

gesund() {
  for _ in $(seq 1 40); do
    if (cd "$DEPLOY_DIR" && docker compose exec -T app node -e "fetch('http://127.0.0.1:3000'+(process.env.BASE_PATH||'')+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))") >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
  return 1
}

if AUTO=1 bash "$DEPLOY_DIR/install.sh" > /var/log/dienstplan-install-letztes.log 2>&1 && gesund; then
  rm -f "$FEHLER_DATEI"
  echo "OK – läuft jetzt mit ${NEU:0:7}"
  exit 0
fi

echo "FEHLER beim Update – kehre zu ${ALT:0:7} zurück. Letzte Zeilen der Installation:"
tail -20 /var/log/dienstplan-install-letztes.log | sed 's/^/  /'
echo "$NEU" > "$FEHLER_DATEI"
git reset -q --hard "$ALT"
(cd "$DEPLOY_DIR" && docker compose up -d --build) > /var/log/dienstplan-rollback.log 2>&1
if gesund; then
  echo "Zurück auf ${ALT:0:7} – läuft wieder."
else
  echo "ACHTUNG: Auch die vorherige Version startet nicht – bitte manuell prüfen (docker compose logs app)."
fi
exit 1
