'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

async function startServer(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pep-sb-'));
  const port = 35000 + Math.floor(Math.random() * 5000);
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), BASE_PATH: '/lwl', DB_FILE: path.join(dir, 'p.db'), SEED_DEMO: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Start-Zeitüberschreitung: ${out}`)), 20000);
    proc.stdout.on('data', (d) => { out += d; if (out.includes('Demo-Bereich:') || (env.DEMO_BEREICH === '0' && out.includes('läuft'))) { clearTimeout(t); resolve(); } });
    proc.on('exit', (c) => reject(new Error(`beendet (${c}): ${out}`)));
  });
  return { proc, base: `http://127.0.0.1:${port}`, dir };
}

test('Startseite mit getrenntem Demo-Bereich: Rollen ohne Anmeldung, echte Daten geschützt', async () => {
  // auch wenn in .env noch der alte DEMO_MODUS=1 steht: echte Daten bleiben geschützt
  const { proc, base, dir } = await startServer({ DEMO_MODUS: '1' });
  try {
    const live = await (await fetch(`${base}/lwl/api/branding`)).json();
    assert.equal(live.demo, false);
    assert.equal(live.demo_link, '/lwl/demo/');
    const demo = await (await fetch(`${base}/lwl/demo/api/branding`)).json();
    assert.equal(demo.demo, true);
    assert.equal(demo.live_link, '/lwl/');
    // Demo: Leitung mit einem Klick
    let r = await fetch(`${base}/lwl/demo/api/demo/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'manager' }) });
    assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie');
    assert.match(cookie, /^sid_demo=.*Path=\/lwl\/demo\//);
    const c = cookie.split(';')[0];
    // Demo-Dienstplan ist mit Beispieldaten gefüllt
    const today = new Date().toISOString().slice(0, 10);
    const plan = await (await fetch(`${base}/lwl/demo/api/plan?from=${today}&to=${today}`, { headers: { Cookie: c } })).json();
    assert.ok(plan.shifts.length > 0 && plan.shifts.some((s) => s.assigned.length > 0), 'Demo-Plan sollte besetzt sein');
    // Demo-Sitzung öffnet die echten Daten nicht
    assert.equal((await fetch(`${base}/lwl/api/me`, { headers: { Cookie: c } })).status, 401);
    assert.equal((await fetch(`${base}/lwl/api/users`, { headers: { Cookie: `sid=${c.split('=')[1]}` } })).status, 401);
    // Echtbetrieb: keine Rollenauswahl, 2FA bleibt Pflicht, keine Demo-Personen
    assert.equal((await fetch(`${base}/lwl/api/demo/personen`)).status, 404);
    r = await fetch(`${base}/lwl/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'manager', password: 'manager123' }) });
    assert.equal((await r.json()).stage, 'setup');
    // Rückmeldung aus der Demo landet in der Hauptdatenbank
    r = await fetch(`${base}/lwl/demo/api/rueckmeldung`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: c }, body: JSON.stringify({ art: 'idee', text: 'Demo-Idee: Farben anpassen' }) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).demo, true);
    const { DatabaseSync } = require('node:sqlite');
    const liveDb = new DatabaseSync(path.join(dir, "p.db"));
    const rm = liveDb.prepare("SELECT * FROM rueckmeldungen WHERE quelle = 'demo'").all();
    liveDb.close();
    assert.equal(rm.length, 1);
    assert.match(rm[0].name, /\(Demo\)/);
    // getrennte Dateien
    assert.ok(fs.existsSync(path.join(dir, 'demo', 'demo.db')));
  } finally { proc.kill(); }
});

test('Demo-Bereich abschaltbar', async () => {
  const { proc, base } = await startServer({ DEMO_BEREICH: '0' });
  try {
    assert.equal((await (await fetch(`${base}/lwl/api/branding`)).json()).demo_link, null);
    assert.equal((await fetch(`${base}/lwl/demo/api/branding`)).status, 404);
  } finally { proc.kill(); }
});
