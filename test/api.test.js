'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const TOTP = require('../src/totp');

const secrets = new Map(); // Benutzer → TOTP-Geheimnis
const recovery = new Map(); // Benutzer → Wiederherstellungscodes

/** Vollständige Anmeldung inkl. Einrichtung bzw. Eingabe des zweiten Faktors */
async function login(c, username, password) {
  let r = await c('POST', '/api/login', { username, password });
  if (r.status !== 200) return r;
  if (r.data.stage === 'setup') {
    const s = await c('POST', '/api/2fa/setup');
    const secret = new URL(s.data.uri.replace('otpauth://', 'http://')).searchParams.get('secret');
    secrets.set(username, secret);
    r = await c('POST', '/api/2fa/enable', { code: TOTP.totp(secret) });
    recovery.set(username, r.data.recovery_codes);
  } else if (r.data.stage === '2fa') {
    // Code dieses Zeitfensters wurde evtl. schon benutzt → Wiederherstellungscode
    r = await c('POST', '/api/login/2fa', { code: recovery.get(username).pop() });
  }
  return r;
}

let server, base;

test.before(async () => {
  const db = openDb(':memory:');
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
}

const future = (days) => {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
};

test('Ablauf: Plan erzeugen, eintragen, Regeln, Auswertung', async () => {
  const mgr = client();
  const anna = client();
  const murat = client();

  assert.equal((await mgr('GET', '/api/users')).status, 401);
  assert.equal((await mgr('POST', '/api/login', { username: 'manager', password: 'falsch' })).status, 401);
  assert.equal((await login(mgr, 'manager', 'manager123')).status, 200);
  assert.equal((await login(anna, 'abecker', 'demo123')).status, 200);
  assert.equal((await login(murat, 'myilmaz', 'demo123')).status, 200);

  // Mitarbeitende dürfen nichts verwalten
  assert.equal((await anna('POST', '/api/shifts/generate', { from: future(10), to: future(12) })).status, 403);
  assert.equal((await anna('GET', '/api/users')).status, 403);

  const from = future(10), to = future(12);
  const gen = await mgr('POST', '/api/shifts/generate', { from, to });
  assert.equal(gen.status, 200);
  assert.equal(gen.data.created, 3 * 2 * 3); // 3 Tage × 2 Stationen × 3 Dienste
  assert.equal((await mgr('POST', '/api/shifts/generate', { from, to })).data.created, 0); // idempotent

  const plan = (await anna('GET', `/api/plan?from=${from}&to=${to}`)).data.shifts;
  const früh = plan.find((s) => s.date === from && s.type_code === 'F' && s.unit_name === 'Station 1');
  const spät = plan.find((s) => s.date === from && s.type_code === 'S' && s.unit_name === 'Station 1');
  const nachtVortag = plan.find((s) => s.date === from && s.type_code === 'N' && s.unit_name === 'Station 2');
  const frühFolgetag = plan.find((s) => s.date === future(11) && s.type_code === 'F' && s.unit_name === 'Station 2');

  // Selbst eintragen
  let r = await anna('POST', `/api/shifts/${früh.id}/assign`);
  assert.equal(r.status, 200);
  assert.equal(r.data.assigned.length, 1);
  assert.equal((await anna('POST', `/api/shifts/${früh.id}/assign`)).status, 409);

  // Überschneidung Früh/Spät am selben Tag
  r = await anna('POST', `/api/shifts/${spät.id}/assign`);
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'UEBERSCHNEIDUNG');

  // Ruhezeit: Nacht (bis 06:30) → Früh am Folgetag (ab 06:00) ist eine Überschneidung,
  // Spät (bis 22:00) → Früh Folgetag (06:00) = 8 Std. Ruhe < 11
  r = await murat('POST', `/api/shifts/${spät.id}/assign`);
  assert.equal(r.status, 200);
  r = await murat('POST', `/api/shifts/${frühFolgetag.id}/assign`);
  assert.equal(r.data.code, 'RUHEZEIT');

  // Manager kann Ruhezeit-Ausnahme mit force setzen
  const users = (await mgr('GET', '/api/users')).data;
  const muratId = users.find((u) => u.username === 'myilmaz').id;
  r = await mgr('POST', `/api/shifts/${frühFolgetag.id}/assign`, { user_id: muratId });
  assert.equal(r.data.code, 'RUHEZEIT');
  r = await mgr('POST', `/api/shifts/${frühFolgetag.id}/assign`, { user_id: muratId, force: true });
  assert.equal(r.status, 200);

  // Austragen unter Mindestbesetzung ist gesperrt (Minimum 2–3, nur 1 eingetragen)
  r = await anna('DELETE', `/api/shifts/${früh.id}/assign`);
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'MINIMUM');

  // Wenn Minimum auf 0 gesetzt wird, darf sie sich austragen
  await mgr('PUT', `/api/shifts/${früh.id}`, { min_staff: 0, max_staff: 1 });
  r = await anna('DELETE', `/api/shifts/${früh.id}/assign`);
  assert.equal(r.status, 200);

  // Maximalbesetzung
  await anna('POST', `/api/shifts/${früh.id}/assign`);
  const julia = client();
  await login(julia, 'jschmitz', 'demo123');
  r = await julia('POST', `/api/shifts/${früh.id}/assign`);
  assert.equal(r.data.code, 'VOLL');

  // Nachtdienst eintragen und Auswertung prüfen
  r = await julia('POST', `/api/shifts/${nachtVortag.id}/assign`);
  assert.equal(r.status, 200);
  const month = from.slice(0, 7);
  r = await julia('GET', `/api/report?month=${month}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.rows.length, 1);
  assert.equal(r.data.rows[0].nachtschichten, 1);
  assert.ok(r.data.rows[0].nacht > 7);

  r = await mgr('GET', `/api/report?month=${month}`);
  assert.equal(r.data.rows.length, 6);
  assert.ok(r.data.understaffed.length > 0);

  r = await mgr('GET', `/api/report.csv?month=${month}`);
  assert.equal(r.status, 200);
  assert.match(r.data, /Nachtschichten/);
});

test('Dienstzeiten ändern und auf zukünftige Schichten übertragen', async () => {
  const mgr = client();
  assert.equal((await login(mgr, 'manager', 'manager123')).status, 200);
  const types = (await mgr('GET', '/api/shift-types')).data;
  const f = types.find((t) => t.code === 'F');
  const r = await mgr('PUT', `/api/shift-types/${f.id}`, { start_time: '06:15', end_time: '14:45', apply_future: true });
  assert.equal(r.status, 200);
  assert.ok(r.data.updated_shifts > 0);
  assert.equal((await mgr('PUT', `/api/shift-types/${f.id}`, { break_min: 600 })).status, 400);
});

test('Zwei-Faktor-Anmeldung: Pflicht, falscher Code, Sperre, Zurücksetzen', async () => {
  const kevin = client();
  // Nach dem Passwort ist ohne 2FA-Einrichtung kein Zugriff möglich
  let r = await kevin('POST', '/api/login', { username: 'kschulz', password: 'demo123' });
  assert.equal(r.data.stage, 'setup');
  r = await kevin('GET', '/api/plan?from=2026-01-01&to=2026-01-07');
  assert.equal(r.status, 401);
  assert.equal(r.data.code, 'STAGE_SETUP');

  const s = await kevin('POST', '/api/2fa/setup');
  assert.match(s.data.qr, /^data:image\/png;base64,/);
  const secret = new URL(s.data.uri.replace('otpauth://', 'http://')).searchParams.get('secret');
  assert.equal((await kevin('POST', '/api/2fa/enable', { code: '000000' === TOTP.totp(secret) ? '111111' : '000000' })).status, 400);
  r = await kevin('POST', '/api/2fa/enable', { code: TOTP.totp(secret) });
  assert.equal(r.status, 200);
  assert.equal(r.data.recovery_codes.length, 10);
  const codes = r.data.recovery_codes;
  assert.equal((await kevin('GET', '/api/my-shifts')).status, 200);

  // Neue Anmeldung: zweiter Schritt nötig
  const k2 = client();
  r = await k2('POST', '/api/login', { username: 'kschulz', password: 'demo123' });
  assert.equal(r.data.stage, '2fa');
  assert.equal((await k2('GET', '/api/my-shifts')).data.code, 'STAGE_2FA');
  // Wiederverwendung desselben Codes wird abgelehnt
  r = await k2('POST', '/api/login/2fa', { code: TOTP.totp(secret) });
  assert.equal(r.status, 401);
  // Wiederherstellungscode funktioniert genau einmal
  r = await k2('POST', '/api/login/2fa', { code: codes[0] });
  assert.equal(r.status, 200);
  assert.equal(r.data.used_recovery, true);
  assert.equal(r.data.user.recovery_left, 9);
  const k3 = client();
  await k3('POST', '/api/login', { username: 'kschulz', password: 'demo123' });
  assert.equal((await k3('POST', '/api/login/2fa', { code: codes[0] })).status, 401);

  // Nach 5 Fehlversuchen wird das Konto gesperrt (1 Fehlversuch oben schon gezählt)
  for (let i = 0; i < 3; i++) await k3('POST', '/api/login/2fa', { code: '12345-abcde' });
  r = await k3('POST', '/api/login/2fa', { code: '12345-abcde' });
  assert.equal(r.status, 401);
  r = await client()('POST', '/api/login', { username: 'kschulz', password: 'demo123' });
  assert.equal(r.status, 429);
  assert.equal(r.data.code, 'GESPERRT');

  // Manager entsperrt und setzt 2FA zurück (z. B. Handy verloren)
  const mgr = client();
  await login(mgr, 'manager', 'manager123');
  const kevinId = (await mgr('GET', '/api/users')).data.find((u) => u.username === 'kschulz');
  assert.equal(kevinId.locked, true);
  assert.equal(kevinId.totp_enabled, true);
  r = await mgr('PUT', `/api/users/${kevinId.id}`, { reset_2fa: true });
  assert.equal(r.data.totp_enabled, false);
  assert.equal(r.data.locked, false);
  assert.equal((await kevin('GET', '/api/my-shifts')).status, 401); // alte Sitzung beendet
  r = await client()('POST', '/api/login', { username: 'kschulz', password: 'demo123' });
  assert.equal(r.data.stage, 'setup');

  // Mitarbeitende dürfen 2FA nicht abschalten, solange sie Pflicht ist
  const anna = client();
  await login(anna, 'abecker', 'demo123');
  assert.equal((await anna('POST', '/api/2fa/disable', { code: '123456' })).status, 400);
});
