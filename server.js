'use strict';
const path = require('path');
const express = require('express');
const { openDb } = require('./src/db');
const { createApp } = require('./src/app');
const { createDemoSandbox } = require('./src/demo-sandbox');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'personaleinsatz.db');
const BASE = String(process.env.BASE_PATH || '').trim().replace(/\/+$/, '').replace(/^(?!\/)(.)/, '/$1');
// Demo-Bereich mit getrennten Beispieldaten unter <BASE_PATH>/demo/ (abschalten mit DEMO_BEREICH=0)
const DEMO = process.env.DEMO_BEREICH !== '0';
const DEMO_BASE = `${BASE}/demo`;

// Rückmeldungen aus dem Demo-Bereich landen in der Hauptdatenbank (sonst gingen sie nachts mit den Demodaten verloren)
let liveFeedback = null;
let liveSprache = null;

const db = openDb(DB_FILE);
const live = createApp(db, {
  basePath: BASE,
  uploadDir: process.env.UPLOAD_DIR || path.join(path.dirname(DB_FILE), 'uploads'),
  backupDir: process.env.BACKUP_DIR || path.join(path.dirname(DB_FILE), 'backups'),
  demoLink: DEMO ? `${DEMO_BASE}/` : null,
  // Anmeldung ohne Passwort gibt es für die echten Daten nur auf reinen Vorführ-Servern ohne Demo-Bereich
  demo: !DEMO && process.env.DEMO_MODUS === '1',
  onCtx: (ctx) => { liveFeedback = (r) => ctx.rueckmeldungSpeichern(r); liveSprache = ctx.spracheVorladen; },
});

const sandbox = DEMO ? createDemoSandbox({ dir: path.join(path.dirname(DB_FILE), 'demo'), base: DEMO_BASE, liveLink: `${BASE}/`,
  feedbackSink: (r) => liveFeedback(r) }) : null;
const server = express();
server.disable('x-powered-by');
// Android-App (Trusted Web Activity): Bestätigung, dass die App zu dieser Domain gehört – muss an der Domain-Wurzel liegen.
// Paketname und Zertifikat-Fingerabdruck sind öffentlich (kein Geheimnis); bei eigenem Signaturschlüssel per .env überschreiben.
const ANDROID_PAKET = process.env.ANDROID_APP_PAKET || 'de.roboticstarter.dienstplan';
const ANDROID_SHA256 = (process.env.ANDROID_APP_SHA256 || '46:E6:60:93:66:1E:CA:84:22:B9:B3:B3:27:45:37:57:7D:00:6B:03:7F:09:D2:C4:65:6A:93:97:04:E9:37:EE')
  .split(',').map((x) => x.trim()).filter(Boolean);
server.get('/.well-known/assetlinks.json', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json([{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: ANDROID_PAKET, sha256_cert_fingerprints: ANDROID_SHA256 } }]);
});
server.use((req, res, next) => (sandbox && sandbox.matches(req.path) ? sandbox.handler(req, res, next) : live(req, res, next)));

server.listen(PORT, () => {
  // Sprachmodell im Hintergrund laden, damit die erste Spracheingabe nicht warten muss
  if (process.env.SPRACHE !== '0') liveSprache?.();
  console.log(`Personaleinsatzplanung läuft auf http://localhost:${PORT}${BASE}/`);
  if (!sandbox) return;
  const origin = `http://127.0.0.1:${PORT}`;
  sandbox.populate(origin).then(() => console.log(`Demo-Bereich: http://localhost:${PORT}${DEMO_BASE}/`));
  // jede Nacht gegen 3:30 Uhr frische Beispieldaten
  let last = '';
  setInterval(() => {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
    const day = now.toDateString();
    if (now.getHours() === 3 && now.getMinutes() >= 30 && last !== day) { last = day; sandbox.reset(origin); }
  }, 60e3).unref();
});
