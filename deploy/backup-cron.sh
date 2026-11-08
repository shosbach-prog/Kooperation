#!/usr/bin/env bash
# Tägliche Sicherung (vom Cron-Job aufgerufen). Erstellt eine verschlüsselte Sicherung im Container
# und kopiert sie – falls BACKUP_KOPIE_ZIEL in .env gesetzt ist – auf einen zweiten Rechner.
#   BACKUP_KOPIE_ZIEL=benutzer@nas.example.de:/sicherungen/dienstplan   (per rsync über SSH-Schlüssel)
set -uo pipefail
cd "$(dirname "$0")" || exit 1
ZIEL="$(grep '^BACKUP_KOPIE_ZIEL=' .env 2>/dev/null | cut -d= -f2- || true)"

echo "=== $(date '+%F %T') Sicherung"
if ! docker compose exec -T -u node app node scripts/backup.js; then
  echo "FEHLER: Sicherung fehlgeschlagen"; exit 1
fi
if [ -n "$ZIEL" ]; then
  # nur die verschlüsselten Dateien und den Status übertragen
  if rsync -a --include='*.pep' --include='letzte-sicherung.json' --exclude='*' -e "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new" data/backups/ "$ZIEL/"; then
    echo "Kopie nach $ZIEL übertragen"
  else
    echo "FEHLER: Kopie nach $ZIEL fehlgeschlagen"; exit 1
  fi
fi
