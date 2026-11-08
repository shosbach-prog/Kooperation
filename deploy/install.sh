#!/usr/bin/env bash
# =============================================================================
#  Personaleinsatzplanung – Einrichtung auf einem frischen Linux-Server
#  für: Ubuntu 22.04/24.04, Debian 12 (z. B. IONOS VPS, netcup VPS / Root-Server)
#
#  Aufruf auf dem Server (als root):
#    curl -fsSL https://raw.githubusercontent.com/shosbach-prog/kooperation/main/deploy/install.sh -o install.sh
#    bash install.sh
#
#  Das Skript kann gefahrlos erneut ausgeführt werden (z. B. für Updates).
# =============================================================================
set -euo pipefail

REPO_URL="https://github.com/shosbach-prog/kooperation.git"
INSTALL_DIR="/opt/dienstplan"
DEPLOY_DIR="$INSTALL_DIR/deploy"

blau() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
gelb() { printf '\033[1;33m%s\033[0m\n' "$*"; }
rot()  { printf '\033[1;31m%s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  rot "Bitte als root ausführen:  sudo bash install.sh"
  exit 1
fi
if ! grep -qiE 'ubuntu|debian' /etc/os-release; then
  rot "Dieses Skript ist für Ubuntu oder Debian gedacht."
  exit 1
fi

# --- Öffentliche IP-Adresse des Servers ermitteln --------------------------
SERVER_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") print $(i+1)}' | head -n1)"

# --- Angaben abfragen -------------------------------------------------------
KEEP_ENV="n"
if [ -f "$DEPLOY_DIR/.env" ]; then
  gelb "Es gibt bereits eine Konfiguration ($DEPLOY_DIR/.env)."
  read -r -p "Bestehende Konfiguration behalten und nur aktualisieren? [J/n] " KEEP_ENV
  KEEP_ENV="${KEEP_ENV:-j}"
fi

if [[ ! "$KEEP_ENV" =~ ^[JjYy] ]]; then
  echo
  echo "Unter welcher Adresse soll der Dienstplan erreichbar sein?"
  echo "Beispiele: dienstplan.meine-domain.de  oder  lwl-dienstplan.duckdns.org"
  echo "Die Adresse muss bereits auf die IP dieses Servers zeigen: ${SERVER_IP:-unbekannt}"
  while true; do
    read -r -p "Adresse (ohne https://): " DOMAIN
    DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN%%/*}"
    if [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]]; then break; fi
    rot "Das sieht nicht nach einer gültigen Adresse aus."
  done

  echo
  echo "Soll der Dienstplan in einem Unterordner laufen? Beispiel: /LWL  → https://$DOMAIN/LWL"
  echo "Leer lassen, wenn er direkt unter https://$DOMAIN erreichbar sein soll."
  while true; do
    read -r -p "Unterordner (z. B. /LWL, sonst Enter): " BASE_PATH
    BASE_PATH="${BASE_PATH%/}"
    if [ -z "$BASE_PATH" ]; then break; fi
    [[ "$BASE_PATH" == /* ]] || BASE_PATH="/$BASE_PATH"
    if [[ "$BASE_PATH" =~ ^(/[A-Za-z0-9_-]+)+$ ]]; then break; fi
    rot "Bitte nur Buchstaben, Ziffern, - und _ verwenden, z. B. /LWL"
  done

  echo
  echo "Startpasswort für den Benutzer \"manager\" (mind. 10 Zeichen;"
  echo "nicht erlaubt: Leerzeichen, Anführungszeichen, \$, \\ und \`)."
  while true; do
    read -r -s -p "Passwort: " PW1; echo
    read -r -s -p "Passwort wiederholen: " PW2; echo
    if [ "$PW1" != "$PW2" ]; then rot "Die Passwörter stimmen nicht überein."; continue; fi
    if [ "${#PW1}" -lt 10 ]; then rot "Bitte mindestens 10 Zeichen."; continue; fi
    if [[ "$PW1" =~ [[:space:]\"\'\$\\\`] ]]; then rot "Das Passwort enthält ein nicht erlaubtes Zeichen."; continue; fi
    break
  done

  echo
  read -r -p "Demo-Daten anlegen (Beispiel-Stationen und Test-Personal mit Passwort demo123)? [j/N] " DEMO
  if [[ "${DEMO:-n}" =~ ^[JjYy] ]]; then SEED_DEMO=1; else SEED_DEMO=0; fi
fi

# --- System aktualisieren und Grundschutz -----------------------------------
blau "System wird aktualisiert (das kann einige Minuten dauern) …"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get -y -q upgrade
apt-get -y -q install ca-certificates curl git ufw fail2ban unattended-upgrades

blau "Automatische Sicherheitsupdates werden aktiviert …"
echo 'unattended-upgrades unattended-upgrades/enable_auto_updates boolean true' | debconf-set-selections
dpkg-reconfigure -f noninteractive unattended-upgrades

blau "Firewall: nur SSH (22), HTTP (80) und HTTPS (443) werden zugelassen …"
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
systemctl enable --now fail2ban >/dev/null 2>&1 || true

# --- Docker -----------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  blau "Docker wird installiert …"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null

# --- Programm holen ---------------------------------------------------------
if [ -d "$INSTALL_DIR/.git" ]; then
  blau "Programm wird aktualisiert …"
  git -C "$INSTALL_DIR" pull --ff-only
else
  blau "Programm wird heruntergeladen …"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

if [[ ! "$KEEP_ENV" =~ ^[JjYy] ]]; then
  umask 077
  cat > "$DEPLOY_DIR/.env" <<EOF
DOMAIN=$DOMAIN
BASE_PATH=$BASE_PATH
MANAGER_PASSWORD=$PW1
SEED_DEMO=$SEED_DEMO
EOF
  chmod 600 "$DEPLOY_DIR/.env"
  umask 022
fi
# Demo-Modus (Anmeldung per Rollenauswahl ohne Passwort/Code) – nur für Vorführungen ohne echte Daten
if ! grep -q '^DEMO_MODUS=' "$DEPLOY_DIR/.env"; then
  echo
  echo "Demo-Modus: Auf der Startseite wählt man eine Rolle (Pflegedienstleitung, Stationsleitung, Pflegekraft)"
  echo "und ist sofort angemeldet – ohne Passwort und ohne Authenticator-Code. NUR für Vorführungen ohne echte Daten!"
  if grep -q '^SEED_DEMO=1' "$DEPLOY_DIR/.env"; then
    read -r -p "Demo-Modus einschalten? [J/n] " DM; DM="${DM:-j}"
  else
    read -r -p "Demo-Modus einschalten? [j/N] " DM; DM="${DM:-n}"
  fi
  if [[ "$DM" =~ ^[JjYy] ]]; then DM=1; else DM=0; fi
  printf '\n# Demo-Modus: 1 = Rollenauswahl ohne Passwort/2FA (nur ohne echte Daten!), 0 = normaler Betrieb\nDEMO_MODUS=%s\n' "$DM" >> "$DEPLOY_DIR/.env"
fi
# Sicherungs-Passwort (verschlüsselte Sicherungen) – wird einmalig erzeugt, falls noch nicht vorhanden
NEW_BACKUP_PW=""
if ! grep -q '^BACKUP_PASSWORT=' "$DEPLOY_DIR/.env"; then
  NEW_BACKUP_PW="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 28)"
  printf '\n# Passwort für die verschlüsselten Sicherungen – zusätzlich sicher aufbewahren (z. B. Passwort-Safe)!\nBACKUP_PASSWORT=%s\n# Optional: Sicherungen per rsync/SSH auf einen zweiten Rechner kopieren, z. B. benutzer@nas:/sicherungen\nBACKUP_KOPIE_ZIEL=\n' "$NEW_BACKUP_PW" >> "$DEPLOY_DIR/.env"
  chmod 600 "$DEPLOY_DIR/.env"
fi
DOMAIN="$(grep '^DOMAIN=' "$DEPLOY_DIR/.env" | cut -d= -f2-)"
BASE_PATH="$(grep '^BASE_PATH=' "$DEPLOY_DIR/.env" | cut -d= -f2- || true)"
URL="https://$DOMAIN$BASE_PATH/"
mkdir -p "$DEPLOY_DIR/data"
chmod 700 "$DEPLOY_DIR/data"

# --- Prüfen, ob die Adresse auf diesen Server zeigt --------------------------
DNS_IP="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}')"
if [ -z "$DNS_IP" ]; then
  gelb "Achtung: $DOMAIN ist (noch) nicht auflösbar. Das HTTPS-Zertifikat kann erst ausgestellt werden,"
  gelb "wenn die Adresse auf $SERVER_IP zeigt. Der Server versucht es danach automatisch erneut."
elif [ -n "$SERVER_IP" ] && [ "$DNS_IP" != "$SERVER_IP" ]; then
  gelb "Achtung: $DOMAIN zeigt auf $DNS_IP, dieser Server hat aber $SERVER_IP."
  gelb "Bitte den DNS-Eintrag (A-Record) korrigieren."
fi

# --- Starten ----------------------------------------------------------------
blau "Programm wird gebaut und gestartet …"
cd "$DEPLOY_DIR"
docker compose up -d --build

# --- Tägliche Sicherung -----------------------------------------------------
command -v rsync >/dev/null || apt-get install -y -qq rsync >/dev/null 2>&1 || true
chmod +x "$DEPLOY_DIR/backup-cron.sh"
cat > /etc/cron.d/dienstplan-backup <<EOF
# Tägliche verschlüsselte Datensicherung der Personaleinsatzplanung (14 Tage aufbewahrt)
0 3 * * * root $DEPLOY_DIR/backup-cron.sh >> /var/log/dienstplan-backup.log 2>&1
EOF
chmod 644 /etc/cron.d/dienstplan-backup

# --- Warten, bis die Seite antwortet -----------------------------------------
blau "Warte auf das Programm und das HTTPS-Zertifikat …"
OK=0
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null --max-time 5 "$URL"; then OK=1; break; fi
  sleep 5
done

echo
if [ "$OK" = 1 ]; then
  printf '\033[1;32m%s\033[0m\n' "Fertig! Der Dienstplan ist erreichbar unter:  $URL"
else
  gelb "Das Programm läuft, die Adresse $URL antwortet aber noch nicht."
  gelb "Meist fehlt der DNS-Eintrag oder er ist noch nicht verbreitet (bis zu 1 Stunde)."
  gelb "Status prüfen mit:  cd $DEPLOY_DIR && docker compose logs caddy"
fi
cat <<EOF

$(grep -q '^DEMO_MODUS=1' "$DEPLOY_DIR/.env" && echo "DEMO-MODUS IST AN: Startseite zeigt die Rollenauswahl. Ausschalten: in $DEPLOY_DIR/.env DEMO_MODUS=0 setzen und install.sh erneut ausführen.")

Nächste Schritte:
  1. $URL öffnen und mit Benutzer "manager" anmelden.
  2. Zwei-Faktor-Anmeldung mit der Authenticator-App einrichten.
  3. Unter "Sicherheit" das Passwort ändern.

Nützliche Befehle (auf dem Server):
  Update einspielen:   bash $DEPLOY_DIR/install.sh   (Konfiguration behalten)
  Protokoll ansehen:   cd $DEPLOY_DIR && docker compose logs -f app
  Sicherungen:         $DEPLOY_DIR/data/backups/   (verschlüsselt, *.pep)
  Sicherung sofort:    $DEPLOY_DIR/backup-cron.sh
  Überwachung:         ${URL}api/health?backup=1   (siehe deploy/UEBERWACHUNG.md)
EOF
if [ -n "$NEW_BACKUP_PW" ]; then
  echo
  gelb "WICHTIG – Passwort für die verschlüsselten Sicherungen (bitte jetzt notieren, z. B. im Passwort-Safe):"
  printf '\n    \033[1m%s\033[0m\n\n' "$NEW_BACKUP_PW"
  gelb "Ohne dieses Passwort lassen sich Sicherungen NICHT wiederherstellen. Es steht auch in $DEPLOY_DIR/.env."
fi
