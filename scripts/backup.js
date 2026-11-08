'use strict';
/**
 * Sicherung im laufenden Betrieb: konsistente Kopie der Datenbank (VACUUM INTO) plus AU-Bescheinigungen,
 * Logo und Profilfotos.
 *
 * Mit BACKUP_PASSWORT (empfohlen) entsteht EINE verschlüsselte Datei  sicherung-JJJJ-MM-TT-HH-MM.pep
 * (AES-256-GCM, Schlüssel per scrypt aus dem Passwort). Ohne Passwort wird – wie bisher – ein Ordner angelegt.
 * Wiederherstellen: node scripts/restore.js <datei.pep> <zielordner>
 *
 * Aufruf: node scripts/backup.js [Zielordner]   (Standard: <Datenordner>/backups)
 * BACKUP_TAGE (Standard 14): ältere Sicherungen werden gelöscht.
 * Nach jeder Sicherung wird <Zielordner>/letzte-sicherung.json geschrieben (für /api/health?backup=1).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');
const { encrypt } = require('./crypto-backup');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'personaleinsatz.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(path.dirname(DB_FILE), 'uploads');
const target = process.argv[2] || process.env.BACKUP_DIR || path.join(path.dirname(DB_FILE), 'backups');
const keepDays = Number(process.env.BACKUP_TAGE) || 14;
const passwort = process.env.BACKUP_PASSWORT || '';

function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [path.relative(base, p)];
  });
}

function main() {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.chmodSync(target, 0o700);

  // 1) konsistente Datenbankkopie in einen privaten Arbeitsordner
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pep-backup-'));
  const dbCopy = path.join(tmp, 'personaleinsatz.db');
  const db = new DatabaseSync(DB_FILE);
  db.exec(`VACUUM INTO '${dbCopy.replace(/'/g, "''")}'`);
  db.close();

  let ergebnis;
  try {
    if (passwort) {
      // 2a) alles in ein Paket: JSON-Inhaltsverzeichnis + Dateien, gzip, verschlüsselt
      const files = [{ name: 'personaleinsatz.db', data: fs.readFileSync(dbCopy) },
        ...walk(UPLOAD_DIR).map((rel) => ({ name: `uploads/${rel.split(path.sep).join('/')}`, data: fs.readFileSync(path.join(UPLOAD_DIR, rel)) }))];
      const index = Buffer.from(JSON.stringify({ format: 1, erstellt: new Date().toISOString(), dateien: files.map((f) => ({ name: f.name, groesse: f.data.length })) }));
      const head = Buffer.alloc(4); head.writeUInt32BE(index.length);
      const plain = zlib.gzipSync(Buffer.concat([head, index, ...files.map((f) => f.data)]), { level: 6 });
      const file = path.join(target, `sicherung-${stamp}.pep`);
      fs.writeFileSync(file, encrypt(plain, passwort), { mode: 0o600 });
      ergebnis = { datei: path.basename(file), groesse: fs.statSync(file).size, verschluesselt: true, dateien: files.length };
    } else {
      // 2b) unverschlüsselter Ordner (nur bei Datenträgerverschlüsselung des Servers vertretbar)
      const dir = path.join(target, stamp);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.copyFileSync(dbCopy, path.join(dir, 'personaleinsatz.db'));
      if (fs.existsSync(UPLOAD_DIR)) fs.cpSync(UPLOAD_DIR, path.join(dir, 'uploads'), { recursive: true });
      ergebnis = { datei: stamp, groesse: fs.statSync(path.join(dir, 'personaleinsatz.db')).size, verschluesselt: false };
      console.warn('Hinweis: BACKUP_PASSWORT ist nicht gesetzt – die Sicherung ist NICHT verschlüsselt.');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 3) alte Sicherungen entfernen
  for (const name of fs.readdirSync(target)) {
    if (name === 'letzte-sicherung.json') continue;
    const p = path.join(target, name);
    if (fs.statSync(p).mtimeMs < Date.now() - keepDays * 86400e3) fs.rmSync(p, { recursive: true, force: true });
  }

  const status = { ok: true, zeit: new Date().toISOString(), ...ergebnis };
  fs.writeFileSync(path.join(target, 'letzte-sicherung.json'), JSON.stringify(status, null, 2), { mode: 0o600 });
  console.log(`Sicherung erstellt: ${path.join(target, ergebnis.datei)} (${Math.round(ergebnis.groesse / 1024)} KB${ergebnis.verschluesselt ? ', verschlüsselt' : ''})`);
  return status;
}

if (require.main === module) {
  try { main(); } catch (e) {
    console.error('Sicherung fehlgeschlagen:', e.message);
    try {
      fs.mkdirSync(target, { recursive: true });
      const prev = (() => { try { return JSON.parse(fs.readFileSync(path.join(target, 'letzte-sicherung.json'), 'utf8')); } catch { return {}; } })();
      fs.writeFileSync(path.join(target, 'letzte-sicherung.json'), JSON.stringify({ ...prev, ok: false, fehler: e.message, fehler_zeit: new Date().toISOString() }, null, 2));
    } catch { /* ignorieren */ }
    process.exit(1);
  }
}
module.exports = { main };
