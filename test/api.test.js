'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

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
  assert.equal((await mgr('POST', '/api/login', { username: 'manager', password: 'manager123' })).status, 200);
  assert.equal((await anna('POST', '/api/login', { username: 'abecker', password: 'demo123' })).status, 200);
  assert.equal((await murat('POST', '/api/login', { username: 'myilmaz', password: 'demo123' })).status, 200);

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
  await julia('POST', '/api/login', { username: 'jschmitz', password: 'demo123' });
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
  await mgr('POST', '/api/login', { username: 'manager', password: 'manager123' });
  const types = (await mgr('GET', '/api/shift-types')).data;
  const f = types.find((t) => t.code === 'F');
  const r = await mgr('PUT', `/api/shift-types/${f.id}`, { start_time: '06:15', end_time: '14:45', apply_future: true });
  assert.equal(r.status, 200);
  assert.ok(r.data.updated_shifts > 0);
  assert.equal((await mgr('PUT', `/api/shift-types/${f.id}`, { break_min: 600 })).status, 400);
});
