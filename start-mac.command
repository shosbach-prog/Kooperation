#!/bin/bash
# Personaleinsatzplanung lokal testen (macOS / Linux)
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js ist nicht installiert. Bitte die LTS-Version von https://nodejs.org/de installieren."
  open "https://nodejs.org/de" 2>/dev/null
  read -r -p "Enter zum Schließen"; exit 1
fi
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"; then
  echo "Node.js ist zu alt (mindestens 22.13 nötig). Bitte die aktuelle LTS-Version installieren."
  open "https://nodejs.org/de" 2>/dev/null
  read -r -p "Enter zum Schließen"; exit 1
fi
[ -d node_modules ] || { echo "Erster Start: benötigte Pakete werden geladen …"; npm install --omit=dev; }
echo
echo "Der Dienstplan startet unter http://localhost:3000 – zum Beenden dieses Fenster schließen."
(sleep 2; open "http://localhost:3000" 2>/dev/null || xdg-open "http://localhost:3000" 2>/dev/null) &
node server.js
