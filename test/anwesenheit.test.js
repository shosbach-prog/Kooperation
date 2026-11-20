'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const TOTP = require('../src/totp');

// Mittwoch, 18.11.2026, Uhrzeit in Europe/Berlin (MEZ = UTC+1)
const DATUM = '2026-11-18';
let now = Date.parse('2026-11-18T05:00:00Z'); // 06:00 Uhr
const clock = () => now;
const um = (hm) => { const [h, m] = hm.split(':').map(Number); now = Date.parse(`${DATUM}T00:00:00Z`) + ((h - 1) * 60 + m) * 60000; };

let server, base;
test.before(async () => {
  server = createApp(openDb(':memory:'), { uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pep-anw-')), timers: false, clock }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const client = () => {
  let cookie = '';
  return async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => null) };
  };
};
async function login(u, p) {
  const c = client();
  await c('POST', '/api/login', { username: u, password: p });
  const s = await c('POST', '/api/2fa/setup');
  await c('POST', '/api/2fa/enable', { code: TOTP.totp(new URL(s.data.uri.replace('otpauth://', 'http://')).searchParams.get('secret')) });
  return c;
}

test('Anwesenheit: anwesend, im Dienst, krank, Urlaub, später, frei – nur für die Verwaltung', async () => {
  const mgr = await login('manager', 'manager123');
  const unit = (await mgr('GET', '/api/units')).data[0].id;
  const neu = async (username, name) => (await mgr('POST', '/api/users', { username, name, password: 'demo12345', role: 'staff', weekly_hours: 38.5, stammbereich_id: unit })).data.id;
  const ids = {};
  for (const n of ['anna', 'bernd', 'clara', 'dora', 'emil', 'fritz', 'gina']) ids[n] = await neu(`anw_${n}`, `Anw ${n}`);

  const typ = async (name, code, start_time, end_time) => (await mgr('POST', '/api/shift-types', { name, code, start_time, end_time, break_min: 30 })).data.id;
  const frueh = await typ('Anw Früh', 'AF', '06:00', '14:00');
  const spaet = await typ('Anw Spät', 'AS', '14:00', '22:00');
  const nacht = await typ('Anw Nacht', 'AN', '21:00', '06:00');
  await mgr('PUT', '/api/requirements', [frueh, spaet, nacht].flatMap((t) => [0, 1, 2, 3, 4, 5, 6].map((w) => ({ unit_id: unit, shift_type_id: t, weekday: w, min_staff: 1 }))));
  await mgr('POST', '/api/shifts/generate', { from: '2026-11-17', to: DATUM });
  const shifts = (await mgr('GET', `/api/plan?from=2026-11-17&to=${DATUM}`)).data.shifts;
  const sh = (t, d = DATUM) => shifts.find((s) => s.shift_type_id === t && s.date === d && s.unit_id === unit).id;
  const eintragen = async (shiftId, uid) => assert.equal((await mgr('POST', `/api/shifts/${shiftId}/assign`, { user_id: uid, force: true })).status, 200);
  await eintragen(sh(frueh), ids.anna);
  await eintragen(sh(frueh), ids.bernd);
  await eintragen(sh(spaet), ids.fritz);
  await eintragen(sh(nacht, '2026-11-17'), ids.gina);

  let r = await mgr('POST', '/api/absences', { user_id: ids.clara, type: 'krank', from: '2026-11-17', to: '2026-11-20' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await mgr('POST', '/api/absences', { user_id: ids.dora, type: 'urlaub', from: '2026-11-16', to: '2026-11-20' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  if (r.data.status === 'beantragt') await mgr('POST', `/api/absences/${r.data.id}/decide`, { status: 'genehmigt' });

  // Anna stempelt um 05:58 ein
  um('05:58');
  const anna = await login('anw_anna', 'demo12345');
  assert.equal((await anna('POST', '/api/stempel/kommen')).status, 200);

  um('10:00');
  r = await mgr('GET', '/api/anwesenheit');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.datum, DATUM);
  assert.equal(r.data.heute, true);
  assert.equal(r.data.jetzt, '10:00');
  const p = (n) => r.data.personen.find((x) => x.id === ids[n]);
  assert.equal(p('anna').status, 'anwesend');
  assert.equal(p('anna').stempel.kommen, '05:58');
  assert.equal(p('bernd').status, 'im_dienst');
  assert.equal(p('bernd').hinweis, 'nicht eingestempelt');
  assert.equal(p('clara').status, 'krank');
  assert.equal(p('clara').abwesenheit.from_date, '2026-11-17');
  assert.equal(p('dora').status, 'urlaub', JSON.stringify(p('dora')));
  assert.equal(p('emil').status, 'frei');
  assert.equal(p('fritz').status, 'geplant');
  assert.equal(p('fritz').dienste[0].start_time, '14:00');
  assert.equal(p('gina').status, 'dienst_beendet');
  assert.equal(p('gina').dienste[0].vom_vortag, true);
  assert.ok(r.data.zaehler.krank >= 1);

  // anderer Tag: kein Stempelstatus, Dienste gelten als geplant
  r = await mgr('GET', '/api/anwesenheit?datum=2026-11-17');
  assert.equal(r.data.heute, false);
  assert.equal(r.data.personen.find((x) => x.id === ids.gina).status, 'geplant');
  assert.equal(r.data.personen.find((x) => x.id === ids.clara).status, 'krank');

  // Mitarbeitende sehen die Übersicht nicht; ungültiges Datum
  assert.equal((await anna('GET', '/api/anwesenheit')).status, 403);
  assert.equal((await mgr('GET', '/api/anwesenheit?datum=gestern')).status, 400);
});
