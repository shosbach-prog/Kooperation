# Kostenlos online stellen

Diese Anleitung bringt die Personaleinsatzplanung auf einen **kostenlosen Server mit
Standort in Deutschland**: Oracle Cloud „Always Free“ in Frankfurt, dazu eine kostenlose
Internetadresse von DuckDNS und ein kostenloses HTTPS-Zertifikat. Laufende Kosten: **0 €**.

Zeitaufwand: etwa 45–60 Minuten.

> ### ⚠️ Vorher lesen: Datenschutz
> Ein privat angemieteter Server ist **für den Test mit erfundenen Daten** gedacht.
> Echte Personaldaten der LWL-Klinik, vor allem **Krankmeldungen, AU-Bescheinigungen und
> Angaben zur Schwerbehinderung** (Gesundheitsdaten nach Art. 9 DSGVO), dürfen dort erst
> gespeichert werden, wenn **Datenschutzbeauftragte/r, IT und Personalrat zugestimmt** haben.
> Dafür ist u. a. ein Vertrag zur Auftragsverarbeitung mit dem Anbieter nötig.
> Für den Echtbetrieb ist ein Server der LWL-IT der richtige Weg.

---

## Warum Oracle Cloud?

Das Programm braucht einen Server, der **Daten dauerhaft speichert** (Datenbank und
AU-Bescheinigungen). Viele „Gratis-Hoster“ (Render, Vercel, Netlify, Glitch …) löschen die
Daten bei jedem Neustart und scheiden deshalb aus.

| Anbieter | Kosten | Standort Deutschland | Dauerhafter Speicher | Geeignet |
|---|---|---|---|---|
| **Oracle Cloud Always Free** | 0 € dauerhaft | ✅ Frankfurt | ✅ | **empfohlen** |
| Eigener PC / Raspberry Pi + Cloudflare Tunnel | 0 € (Strom) | ✅ bei Ihnen | ✅ | Alternative, siehe unten |
| Google Cloud Free Tier | 0 € | ❌ nur USA | ✅ | nicht für Personaldaten |
| Render / Vercel / Netlify (gratis) | 0 € | teils | ❌ Daten gehen verloren | nein |

Oracle verlangt bei der Anmeldung eine **Kreditkarte zur Identitätsprüfung**. Kostenlose
Ressourcen („Always Free“) werden nicht berechnet.

---

## Schritt 1: Oracle-Konto anlegen

1. Auf **https://www.oracle.com/de/cloud/free/** auf „Kostenlos starten“ klicken.
2. Bei **„Home Region“ unbedingt „Germany Central (Frankfurt)“** wählen.
   *Das lässt sich später nicht mehr ändern.*
3. Anmeldung abschließen (E-Mail, Kreditkarte zur Prüfung).

## Schritt 2: Server (VM) erstellen

1. In der Oracle-Konsole: **Menü ☰ → Compute → Instances → Create instance**.
2. Name: `dienstplan`.
3. **Image:** „Change image“ → **Canonical Ubuntu 24.04**.
4. **Shape:** „Change shape“ → **Ampere → VM.Standard.A1.Flex**, 1 OCPU, 6 GB Speicher
   (mit dem Hinweis „Always Free-eligible“).
   Falls dort „Out of capacity“ erscheint: später erneut versuchen oder
   **VM.Standard.E2.1.Micro** (AMD, ebenfalls kostenlos) nehmen.
5. **SSH-Schlüssel:** „Generate a key pair for me“ → **beide Schlüssel herunterladen** und gut aufbewahren.
6. **Create** klicken. Nach ein bis zwei Minuten steht unter „Public IP address“ die
   IP-Adresse des Servers, z. B. `130.61.12.34`. Notieren.

## Schritt 3: Ports 80 und 443 öffnen

1. Auf der Seite der Instanz: **Subnet** anklicken → **Default Security List** →
   **Add Ingress Rules**.
2. Zwei Regeln anlegen:
   - Source CIDR `0.0.0.0/0`, IP Protocol TCP, Destination Port **80**
   - Source CIDR `0.0.0.0/0`, IP Protocol TCP, Destination Port **443**

## Schritt 4: Kostenlose Internetadresse (DuckDNS)

1. Auf **https://www.duckdns.org** anmelden (z. B. mit Google- oder GitHub-Konto).
2. Einen Namen eintragen, z. B. `lwl-dienstplan-test` → **add domain**.
3. Bei „current ip“ die **IP-Adresse aus Schritt 2** eintragen → **update ip**.

Ihre Adresse lautet dann: `lwl-dienstplan-test.duckdns.org`

## Schritt 5: Mit dem Server verbinden

**Windows:** PowerShell öffnen. **Mac:** Terminal öffnen.

```bash
ssh -i PFAD/ZUM/HERUNTERGELADENEN/ssh-key.key ubuntu@IHRE-IP-ADRESSE
```

(Unter Mac/Linux vorher einmal `chmod 600 PFAD/ZUM/ssh-key.key` ausführen.)

## Schritt 6: Server einrichten

Die folgenden Befehle nacheinander auf dem Server einfügen:

```bash
# Firewall des Ubuntu-Images für Web-Zugriff öffnen
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save

# Docker installieren
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
```

Danach **einmal abmelden** (`exit`) und wie in Schritt 5 neu verbinden.

## Schritt 7: Programm installieren

```bash
git clone https://github.com/shosbach-prog/kooperation.git
cd kooperation/deploy
cp .env.beispiel .env
nano .env
```

In der Datei `.env` eintragen:

```
DOMAIN=lwl-dienstplan-test.duckdns.org
MANAGER_PASSWORD=ein-langes-eigenes-passwort
SEED_DEMO=0
```

(Speichern in nano: `Strg+O`, `Enter`, `Strg+X`.)
`SEED_DEMO=1` legt zum Ausprobieren Demo-Stationen und Demo-Personal mit dem Passwort `demo123` an.
Im Internet ist das **nur kurzzeitig zum Testen** sinnvoll.

Starten:

```bash
docker compose up -d --build
```

Nach ein bis zwei Minuten ist das Programm unter **https://lwl-dienstplan-test.duckdns.org**
erreichbar. Das HTTPS-Zertifikat besorgt der Server automatisch.

## Schritt 8: Erste Anmeldung

1. Adresse im Browser öffnen, mit `manager` und dem Passwort aus `.env` anmelden.
2. Die Zwei-Faktor-Anmeldung mit der Authenticator-App einrichten und die Wiederherstellungscodes sicher aufbewahren.
3. Unter **Sicherheit** das Passwort ändern.
4. Unter **Einstellungen**, **Dienstzeiten**, **Mindestbesetzung** und **Mitarbeitende** die Klinik einrichten.
5. Den Kolleginnen und Kollegen die Adresse geben. Auf dem Handy lässt sie sich über
   „Zum Home-Bildschirm“ bzw. „App installieren“ wie eine App ablegen.

---

## Datensicherung (wichtig!)

Täglich um 3 Uhr automatisch sichern:

```bash
crontab -e
```

Unten anfügen:

```
0 3 * * * cd /home/ubuntu/kooperation/deploy && docker compose exec -T -u node app node scripts/backup.js >> /home/ubuntu/backup.log 2>&1
```

Die Sicherungen liegen in `deploy/data/backups/` (14 Tage). Holen Sie gelegentlich eine Kopie
auf einen anderen Rechner, damit sie einen Totalausfall des Servers übersteht:

```bash
scp -r -i PFAD/ZUM/ssh-key.key ubuntu@IHRE-IP-ADRESSE:kooperation/deploy/data/backups ./dienstplan-sicherung
```

## Updates einspielen

```bash
cd ~/kooperation && git pull && cd deploy && docker compose up -d --build
```

## Häufige Probleme

| Problem | Lösung |
|---|---|
| Seite nicht erreichbar | Schritt 3 (Security List) und Schritt 6 (iptables) prüfen; bei DuckDNS die richtige IP eingetragen? |
| Zertifikatsfehler | DuckDNS-Adresse muss auf die Server-IP zeigen; `docker compose logs caddy` ansehen |
| 2FA-Code wird abgelehnt | Uhrzeit auf dem Handy auf „automatisch“ stellen |
| Oracle meldet „Out of capacity“ | später erneut versuchen oder E2.1.Micro wählen |
| Server wurde von Oracle gestoppt | Oracle kann dauerhaft unbenutzte Gratis-Server zurückfordern. Das Konto auf „Pay As You Go“ umstellen verhindert das; Always-Free-Ressourcen bleiben trotzdem kostenlos. |
| Programm-Protokoll ansehen | `docker compose logs -f app` |

---

## Alternative: Eigener Rechner zu Hause / in der Klinik + Cloudflare Tunnel

Ein vorhandener PC oder ein Raspberry Pi (ab 4 GB RAM), der dauerhaft läuft, geht auch.
Die Daten bleiben dann auf diesem Gerät. Ins Internet bringt ihn **Cloudflare Tunnel**
(kostenlos, ohne Portfreigabe am Router). Dafür braucht man eine eigene Domain bei Cloudflare,
die einige Euro pro Jahr kostet. Ein reiner Test geht auch ohne Domain mit einer zufälligen Adresse:

```bash
# Programm starten (Node.js ab 22.13 nötig)
npm install && SEED_DEMO=1 npm start
# in einem zweiten Fenster: vorübergehende öffentliche HTTPS-Adresse
cloudflared tunnel --url http://localhost:3000
```

Die zufällige Adresse ändert sich bei jedem Start. Für den Dauerbetrieb ist sie deshalb nicht geeignet.
