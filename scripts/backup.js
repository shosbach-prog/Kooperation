'use strict';
/**
 * Sicherung der Datenbank im laufenden Betrieb (konsistente Kopie per VACUUM INTO)
 * plus Kopie der hochgeladenen AU-Bescheinigungen.
 * Aufruf: node scripts/backup.js [Zielordner]   (Standard: <Datenordner>/backups)
 * Alte Sicherungen werden nach BACKUP_TAGE (Standard 14) Tagen gelöscht.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'personaleinsatz.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(path.dirname(DB_FILE), 'uploads');
const target = process.argv[2] || path.join(path.dirname(DB_FILE), 'backups');
const keepDays = Number(process.env.BACKUP_TAGE) || 14;

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const dir = path.join(target, stamp);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.chmodSync(target, 0o700);

const db = new DatabaseSync(DB_FILE);
db.exec(`VACUUM INTO '${path.join(dir, 'personaleinsatz.db').replace(/'/g, "''")}'`);
db.close();
if (fs.existsSync(UPLOAD_DIR)) fs.cpSync(UPLOAD_DIR, path.join(dir, 'uploads'), { recursive: true });

for (const name of fs.readdirSync(target)) {
  const p = path.join(target, name);
  if (fs.statSync(p).mtimeMs < Date.now() - keepDays * 86400e3) fs.rmSync(p, { recursive: true, force: true });
}
console.log(`Sicherung erstellt: ${dir}`);
