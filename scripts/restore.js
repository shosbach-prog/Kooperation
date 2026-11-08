'use strict';
/**
 * Verschlüsselte Sicherung entpacken (prüft dabei die Unversehrtheit).
 * Aufruf:  BACKUP_PASSWORT=… node scripts/restore.js sicherung-….pep <zielordner>
 *          (ohne Variable wird das Passwort abgefragt)
 *          node scripts/restore.js sicherung-….pep --pruefen     → nur prüfen, nichts schreiben
 * Danach enthält <zielordner> personaleinsatz.db und uploads/. Zum Zurückspielen den Dienst stoppen
 * und beides in den Datenordner kopieren (siehe deploy/UEBERWACHUNG.md).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { decrypt } = require('./crypto-backup');

function unpack(file, passwort) {
  const plain = zlib.gunzipSync(decrypt(fs.readFileSync(file), passwort));
  const len = plain.readUInt32BE(0);
  const index = JSON.parse(plain.subarray(4, 4 + len).toString('utf8'));
  let o = 4 + len;
  const files = index.dateien.map((f) => {
    const data = plain.subarray(o, o + f.groesse);
    o += f.groesse;
    return { name: f.name, data };
  });
  return { index, files };
}

function safeJoin(dir, name) {
  const p = path.resolve(dir, name);
  if (!p.startsWith(path.resolve(dir) + path.sep)) throw new Error(`Ungültiger Dateiname in der Sicherung: ${name}`);
  return p;
}

async function askPassword() {
  if (process.env.BACKUP_PASSWORT) return process.env.BACKUP_PASSWORT;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const pw = await new Promise((r) => rl.question('Sicherungs-Passwort: ', r));
  rl.close();
  return pw;
}

async function cli() {
  const [file, ziel] = process.argv.slice(2);
  if (!file || !ziel) {
    console.log('Aufruf: node scripts/restore.js <sicherung.pep> <zielordner | --pruefen>');
    process.exit(2);
  }
  const { index, files } = unpack(file, await askPassword());
  console.log(`Sicherung vom ${index.erstellt}: ${files.length} Dateien, unversehrt.`);
  if (ziel === '--pruefen') return;
  fs.mkdirSync(ziel, { recursive: true, mode: 0o700 });
  for (const f of files) {
    const p = safeJoin(ziel, f.name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.data, { mode: 0o600 });
  }
  console.log(`Entpackt nach ${path.resolve(ziel)}`);
}

if (require.main === module) cli().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { unpack };
