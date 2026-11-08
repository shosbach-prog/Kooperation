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

const db = openDb(DB_FILE);
const live = createApp(db, {
  basePath: BASE,
  uploadDir: process.env.UPLOAD_DIR || path.join(path.dirname(DB_FILE), 'uploads'),
  backupDir: process.env.BACKUP_DIR || path.join(path.dirname(DB_FILE), 'backups'),
  demoLink: DEMO ? `${DEMO_BASE}/` : null,
});

const sandbox = DEMO ? createDemoSandbox({ dir: path.join(path.dirname(DB_FILE), 'demo'), base: DEMO_BASE, liveLink: `${BASE}/` }) : null;
const server = express();
server.disable('x-powered-by');
server.use((req, res, next) => (sandbox && sandbox.matches(req.path) ? sandbox.handler(req, res, next) : live(req, res, next)));

server.listen(PORT, () => {
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
