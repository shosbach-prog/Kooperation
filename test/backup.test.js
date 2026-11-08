'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { unpack } = require('../scripts/restore');

const ROOT = path.join(__dirname, '..');
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pep-bak-'));
  const dbFile = path.join(dir, 'personaleinsatz.db');
  openDb(dbFile).close();
  fs.mkdirSync(path.join(dir, 'uploads', 'fotos'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'uploads', 'au-1.pdf'), '%PDF-1.4 AU');
  fs.writeFileSync(path.join(dir, 'uploads', 'fotos', '7.jpg'), 'JPEGDATA');
  return { dir, dbFile, env: { ...process.env, DB_FILE: dbFile, UPLOAD_DIR: path.join(dir, 'uploads') } };
}
const run = (env, ...args) => execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'backup.js'), ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('Sicherung verschlüsselt, prüfbar und wiederherstellbar', () => {
  const { dir, env } = setup();
  const pw = 'ein-sehr-langes-passwort';
  run({ ...env, BACKUP_PASSWORT: pw });
  const bdir = path.join(dir, 'backups');
  const file = fs.readdirSync(bdir).find((f) => f.endsWith('.pep'));
  assert.ok(file);
  const raw = fs.readFileSync(path.join(bdir, file));
  assert.equal(raw.subarray(0, 8).toString(), 'PEPBAK1\n');
  assert.ok(!raw.includes(Buffer.from('SQLite format')), 'Datenbank darf nicht im Klartext enthalten sein');
  assert.ok(!raw.includes(Buffer.from('%PDF')));
  const status = JSON.parse(fs.readFileSync(path.join(bdir, 'letzte-sicherung.json'), 'utf8'));
  assert.equal(status.ok, true);
  assert.equal(status.verschluesselt, true);
  assert.equal(status.dateien, 3);

  const { files } = unpack(path.join(bdir, file), pw);
  const names = files.map((f) => f.name).sort();
  assert.deepEqual(names, ['personaleinsatz.db', 'uploads/au-1.pdf', 'uploads/fotos/7.jpg']);
  // falsches Passwort / manipulierte Datei
  assert.throws(() => unpack(path.join(bdir, file), 'falsches-passwort-123'), /falsches Passwort/);
  const bad = Buffer.from(raw); bad[bad.length - 5] ^= 1;
  fs.writeFileSync(path.join(dir, 'bad.pep'), bad);
  assert.throws(() => unpack(path.join(dir, 'bad.pep'), pw), /beschädigt/);

  // Wiederherstellen per Kommandozeile und Datenbank öffnen
  const ziel = path.join(dir, 'wieder');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'restore.js'), path.join(bdir, file), ziel], { env: { ...process.env, BACKUP_PASSWORT: pw }, stdio: 'ignore' });
  const db = new DatabaseSync(path.join(ziel, 'personaleinsatz.db'));
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'manager'").get().n === 1);
  db.close();
  assert.equal(fs.readFileSync(path.join(ziel, 'uploads', 'fotos', '7.jpg'), 'utf8'), 'JPEGDATA');
});

test('Sicherung: zu kurzes Passwort wird abgelehnt und als Fehler vermerkt', () => {
  const { dir, env } = setup();
  assert.throws(() => run({ ...env, BACKUP_PASSWORT: 'kurz' }));
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'backups', 'letzte-sicherung.json'), 'utf8'));
  assert.equal(status.ok, false);
  assert.match(status.fehler, /12 Zeichen/);
});

test('Überwachung: /api/health mit Sicherungsstatus', async () => {
  const { dir, env } = setup();
  const backupDir = path.join(dir, 'backups');
  const server = createApp(openDb(':memory:'), { uploadDir: path.join(dir, 'uploads'), backupDir, timers: false, basePath: '/lwl' }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/lwl/api/health`;
  try {
    let r = await fetch(url);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.status, 'ok');
    assert.equal(j.datenbank, 'ok');
    assert.equal(JSON.stringify(j).includes('manager'), false);
    r = await fetch(`${url}?backup=1`);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).sicherung, 'keine');
    run({ ...env, BACKUP_PASSWORT: 'ein-sehr-langes-passwort' });
    r = await fetch(`${url}?backup=1`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).sicherung, 'ok');
    // veraltete Sicherung
    const sf = path.join(backupDir, 'letzte-sicherung.json');
    fs.writeFileSync(sf, JSON.stringify({ ok: true, zeit: new Date(Date.now() - 50 * 3600e3).toISOString() }));
    r = await fetch(`${url}?backup=1`);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).sicherung, 'zu alt');
  } finally { server.close(); }
});
