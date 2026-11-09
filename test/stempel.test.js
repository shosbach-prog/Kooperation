'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const TOTP = require('../src/totp');

const MIN = 60000;
let offset = 0;
const T0 = Math.floor(Date.now() / MIN) * MIN - 6 * 3600e3; // vor 6 Std., volle Minute
const clock = () => T0 + offset;
const at = (min) => { offset = min * MIN; };
const wall = (ms) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms)).split(' ');

let server, base;
test.before(async () => {
  server = createApp(openDb(':memory:'), { uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pep-st-')), timers: false, clock }).listen(0);
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

test('Stempeluhr: Kommen, Pause, Raucherpausen, Gehen → genaue Ist-Zeiten', async () => {
  const mgr = await login('manager', 'manager123');
  const uid = (await mgr('POST', '/api/users', { username: 'stempler', name: 'Stefan Stempel', password: 'demo12345', role: 'staff', weekly_hours: 38.5 })).data.id;
  const [datum, beginn] = wall(T0);
  const ende = wall(T0 + 510 * MIN)[1];
  const unit = (await mgr('GET', '/api/units')).data[0].id;
  const typ = (await mgr('POST', '/api/shift-types', { name: 'Testdienst', code: 'TD', start_time: beginn, end_time: ende, break_min: 30 })).data;
  await mgr('PUT', '/api/requirements', [0, 1, 2, 3, 4, 5, 6].map((w) => ({ unit_id: unit, shift_type_id: typ.id, weekday: w, min_staff: 1 })));
  await mgr('POST', '/api/shifts/generate', { from: datum, to: datum });
  const shift = (await mgr('GET', `/api/plan?from=${datum}&to=${datum}`)).data.shifts.find((s) => s.shift_type_id === typ.id);
  assert.equal((await mgr('POST', `/api/shifts/${shift.id}/assign`, { user_id: uid, force: true })).status, 200);

  const st = await login('stempler', 'demo12345');
  at(-10);
  let r = await st('GET', '/api/stempel');
  assert.equal(r.data.laufend, null);
  assert.equal(r.data.vorschlag.shift_id, shift.id);

  // versehentlich eingestempelt → zurücknehmen
  r = await st('POST', '/api/stempel/kommen');
  assert.equal(r.status, 200);
  assert.equal((await st('DELETE', '/api/stempel/offen')).status, 200);

  at(2);
  r = await st('POST', '/api/stempel/kommen');
  assert.equal(r.data.laufend.dienst.shift_id, shift.id);
  assert.equal((await st('POST', '/api/stempel/kommen')).data.code, 'OFFEN');
  at(180); await st('POST', '/api/stempel/pause', { art: 'pause' });
  assert.equal((await st('POST', '/api/stempel/pause', { art: 'raucher' })).data.code, 'PAUSE_LAEUFT');
  at(200); await st('POST', '/api/stempel/weiter');
  at(300); await st('POST', '/api/stempel/pause', { art: 'raucher' });
  at(307); r = await st('POST', '/api/stempel/weiter');
  assert.equal(r.data.laufend.bisher.raucher_min, 7);
  at(360); await st('POST', '/api/stempel/pause', { art: 'raucher' });
  at(366); await st('POST', '/api/stempel/weiter');
  at(512); r = await st('POST', '/api/stempel/gehen');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = r.data.ergebnis;
  assert.equal(e.brutto_min, 510);
  assert.equal(e.pause_min, 20);
  assert.equal(e.raucher_min, 13);
  assert.equal(e.ergaenzt_min, 10); // nur 20 Min. zählen als Ruhepause → auf 30 Min. ergänzt
  assert.equal(e.abzug_min, 43);
  assert.equal(e.netto_min, 467);

  // Ist-Zeiten im Dienst gesetzt
  const z = (await st('GET', '/api/zeiten?mine=1&from=' + datum + '&to=' + datum)).data.zeiten.find((x) => x.shift_id === shift.id);
  assert.equal(z.ist_start, wall(T0 + 2 * MIN)[1]);
  assert.equal(z.ist_end, wall(T0 + 512 * MIN)[1]);
  assert.equal(z.ist_pause, 43);
  assert.equal(z.ist_raucher_min, 13);
  assert.equal(z.ist_quelle, 'stempel');
  assert.equal(z.stempel.length, 1);
  assert.equal(z.stempel[0].pausen.filter((p) => p.art === 'raucher').length, 2);
  assert.ok(Math.abs(z.ist_std - 467 / 60) < 0.02);
  // Überschreiben nur mit Begründung
  assert.equal((await st('PUT', `/api/zeiten/${shift.id}`, { ist_start: beginn, ist_end: ende })).data.code, 'BEGRUENDUNG');

  // Raucherpausen als Arbeitszeit werten (Einstellung)
  await mgr('PUT', '/api/settings', { raucherpause_abziehen: false });
  assert.equal((await st('GET', '/api/stempel')).data.einstellungen.raucherpause_abziehen, false);
  await mgr('PUT', '/api/settings', { raucherpause_abziehen: true });

  // nochmal zurück (z. B. Übergabe vergessen) und Ausstempeln vergessen → Uhrzeit nachtragen
  at(520); await st('POST', '/api/stempel/kommen');
  at(520 + 13 * 60);
  r = await st('GET', '/api/stempel');
  assert.equal(r.data.laufend.vergessen, false);
  assert.equal((await st('POST', '/api/stempel/gehen', { zeit: '25:00' })).status, 400);
  r = await st('POST', '/api/stempel/gehen', { zeit: wall(T0 + 540 * MIN)[1], note: 'vergessen' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // beide Stempelungen zusammen: 8 Min. Unterbrechung zählen als Pause
  assert.equal(r.data.ergebnis.brutto_min, 538);
  assert.equal(r.data.ergebnis.pause_min, 28);
  assert.equal(r.data.ergebnis.abzug_min, 51);
  const z2 = (await st('GET', '/api/zeiten?mine=1&from=' + datum + '&to=' + datum)).data.zeiten.find((x) => x.shift_id === shift.id);
  assert.equal(z2.ist_end, wall(T0 + 540 * MIN)[1]);
  assert.equal(z2.stempel.length, 2);
  assert.equal(z2.stempel[1].nachgetragen, true);

  // Offline erfasst: Handyuhr geht 5 Min. vor; gestempelt um 590/600, übertragen um 620
  const handy = (min) => T0 + (min + 5) * MIN;
  at(620);
  r = await st('POST', '/api/stempel/kommen', { offline_at: handy(590), gesendet_at: handy(620), offline_id: 'off-kommen-1' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.laufend.kommen_at, T0 + 590 * MIN);
  // doppelt gesendet → ignoriert
  assert.equal((await st('POST', '/api/stempel/kommen', { offline_at: handy(590), gesendet_at: handy(621), offline_id: 'off-kommen-1' })).status, 200);
  r = await st('POST', '/api/stempel/gehen', { offline_at: handy(600), gesendet_at: handy(620), offline_id: 'off-gehen-1' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const z3 = (await st('GET', '/api/zeiten?mine=1&from=' + datum + '&to=' + datum)).data.zeiten.find((x) => x.shift_id === shift.id);
  const off = z3.stempel.find((x) => x.offline);
  assert.ok(off, 'offline erfasste Stempelung gekennzeichnet');
  assert.equal(off.gehen, wall(T0 + 600 * MIN)[1] + ':00');
  // zu alt
  at(620 + 25 * 60);
  assert.equal((await st('POST', '/api/stempel/kommen', { offline_at: handy(620), gesendet_at: handy(620 + 25 * 60), offline_id: 'off-alt-1' })).data.code, 'ZU_ALT');

  // ohne geplanten Dienst kein Einstempeln
  at(3 * 24 * 60);
  assert.equal((await st('POST', '/api/stempel/kommen')).data.code, 'KEIN_DIENST');
});

