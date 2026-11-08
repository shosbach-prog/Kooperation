'use strict';
/* Tests für die Erweiterungen (Kalender, Tauschbörse, Benachrichtigungen, …) */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const TOTP = require('../src/totp');

let server, base, mgr;
const users = {};
test.before(async () => {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pep-feat-'));
  server = createApp(openDb(':memory:'), { uploadDir }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  mgr = client();
  await login(mgr, 'manager', 'manager123');
  for (const u of (await mgr('GET', '/api/users')).data) users[u.username] = u.id;
});
test.after(() => server.close());

function client() {
  let cookie = '';
  const c = async (method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, data: ct.includes('json') ? await res.json() : await res.text() };
  };
  return c;
}
const sessions = new Map();
/** Anmeldung inkl. 2FA-Einrichtung; je Benutzer nur einmal pro Testlauf */
async function login(c, username, password) {
  const r = await c('POST', '/api/login', { username, password });
  if (r.data.stage !== 'setup') throw new Error(`${username}: erwartet 2FA-Einrichtung`);
  const s = await c('POST', '/api/2fa/setup');
  const secret = new URL(s.data.uri.replace('otpauth://', 'http://')).searchParams.get('secret');
  sessions.set(username, c);
  return c('POST', '/api/2fa/enable', { code: TOTP.totp(secret) });
}
async function as(username) {
  if (sessions.has(username)) return sessions.get(username);
  const c = client();
  await login(c, username, username === 'manager' ? 'manager123' : 'demo123');
  return c;
}
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
async function shiftOn(date, code, unitName = 'Station 1') {
  await mgr('POST', '/api/shifts/generate', { from: date, to: date });
  const plan = (await mgr('GET', `/api/plan?from=${date}&to=${date}`)).data.shifts;
  return plan.find((s) => s.type_code === code && s.unit_name === unitName);
}

test('Kalender-Abo (iCal)', async () => {
  const anna = await as('abecker');
  const n = await shiftOn(day(12), 'N');
  await mgr('POST', `/api/shifts/${n.id}/assign`, { user_id: users.abecker });
  const { token } = (await anna('GET', '/api/me/ical')).data;
  assert.ok(token.length >= 20);
  assert.equal((await anna('GET', '/api/me/ical')).data.token, token); // bleibt gleich
  const r = await fetch(`${base}/api/ical/${token}.ics`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/calendar/);
  const ics = await r.text();
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
  assert.match(ics, /SUMMARY:N Nachtdienst · Station 1/);
  // Nachtdienst endet am Folgetag 06:30
  const next = day(13).replace(/-/g, '');
  assert.ok(ics.includes(`DTEND;TZID=Europe/Berlin:${next}T063000`));
  assert.ok(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75));
  // anderer Link → unbekannt; erneuerter Link macht alten ungültig
  assert.equal((await fetch(`${base}/api/ical/falsch-falsch-falsch-falsch.ics`)).status, 404);
  const renewed = (await anna('POST', '/api/me/ical/renew')).data.token;
  assert.notEqual(renewed, token);
  assert.equal((await fetch(`${base}/api/ical/${token}.ics`)).status, 404);
  assert.equal((await fetch(`${base}/api/ical/${renewed}.ics`)).status, 200);
});

test('Tauschbörse: anbieten, übernehmen, bestätigen, Regeln', async () => {
  const anna = await as('abecker');     // Pflegefachkraft
  const murat = await as('myilmaz');    // Pflegefachkraft
  const kevin = await as('kschulz');    // Pflegehilfskraft
  // Verbund aus den Demo-Daten auflösen, damit nur die Station zählt
  for (const v of (await mgr('GET', '/api/verbuende')).data) await mgr('DELETE', `/api/verbuende/${v.id}`);
  const f = await shiftOn(day(15), 'F');
  await mgr('POST', `/api/shifts/${f.id}/assign`, { user_id: users.abecker });

  // nur eigene Dienste anbieten
  assert.equal((await murat('POST', '/api/swaps', { shift_id: f.id })).status, 400);
  let r = await anna('POST', '/api/swaps', { shift_id: f.id, note: 'Familienfeier' });
  assert.equal(r.status, 200);
  const offerId = r.data.id;
  assert.equal((await anna('POST', '/api/swaps', { shift_id: f.id })).status, 409); // doppelt
  // im Plan markiert
  const p = (await murat('GET', `/api/plan?from=${day(15)}&to=${day(15)}`)).data.shifts.find((s) => s.id === f.id);
  assert.equal(p.angebote[0].user_id, users.abecker);
  // Kolleg/innen sehen das Angebot
  assert.ok((await kevin('GET', '/api/swaps')).data.angebote.some((o) => o.id === offerId));
  // eigenes Angebot nicht übernehmbar
  assert.equal((await anna('POST', `/api/swaps/${offerId}/take`)).status, 400);
  // Pflegehilfskraft darf die einzige Pflegefachkraft nicht ersetzen (Qualifikationsregel)
  r = await kevin('POST', `/api/swaps/${offerId}/take`);
  assert.equal(r.data.code, 'QUALIFIKATION');
  // Murat übernimmt sofort (ohne Bestätigungspflicht)
  r = await murat('POST', `/api/swaps/${offerId}/take`);
  assert.equal(r.status, 200);
  assert.equal(r.data.wartet, false);
  assert.equal(r.data.status, 'erledigt');
  const after = (await mgr('GET', `/api/plan?from=${day(15)}&to=${day(15)}`)).data.shifts.find((s) => s.id === f.id);
  assert.deepEqual(after.assigned.map((a) => a.user_id), [users.myilmaz]);
  assert.equal((await murat('POST', `/api/swaps/${offerId}/take`)).status, 404); // nicht mehr verfügbar

  // Ruhezeit: Julia hat den Spätdienst am Vortag → Frühdienst nur 8 h später nicht übernehmbar
  const julia = await as('jschmitz');
  const spaet = await shiftOn(day(14), 'S');
  assert.equal((await mgr('POST', `/api/shifts/${spaet.id}/assign`, { user_id: users.jschmitz })).status, 200);
  const f2 = await shiftOn(day(15), 'F', 'Station 2');
  await mgr('POST', `/api/shifts/${f2.id}/assign`, { user_id: users.twagner });
  const tobias = await as('twagner');
  const o2 = (await tobias('POST', '/api/swaps', { shift_id: f2.id })).data;
  r = await julia('POST', `/api/swaps/${o2.id}/take`);
  assert.equal(r.data.code, 'RUHEZEIT');
  // Murat hat an dem Tag schon den Frühdienst auf Station 1 → Überschneidung
  assert.equal((await murat('POST', `/api/swaps/${o2.id}/take`)).data.code, 'UEBERSCHNEIDUNG'); // Spätdienst bis 22:00, Frühdienst ab 06:00 = 8 Std.

  // Mit Bestätigungspflicht: Anfrage → Verwaltung bestätigt bzw. lehnt ab
  await mgr('PUT', '/api/settings', { tausch_bestaetigung: true });
  r = await anna('POST', `/api/swaps/${o2.id}/take`);
  assert.equal(r.data.wartet, true);
  assert.equal(r.data.status, 'angenommen');
  // noch nicht getauscht
  let plan2 = (await mgr('GET', `/api/plan?from=${day(15)}&to=${day(15)}`)).data.shifts.find((s) => s.id === f2.id);
  assert.deepEqual(plan2.assigned.map((a) => a.user_id), [users.twagner]);
  // Mitarbeitende dürfen nicht entscheiden; Ablehnen braucht keine Pflicht-Begründung, setzt aber zurück auf offen
  assert.equal((await anna('POST', `/api/swaps/${o2.id}/decide`, { status: 'bestaetigt' })).status, 403);
  r = await mgr('POST', `/api/swaps/${o2.id}/decide`, { status: 'abgelehnt', note: 'Bitte vorher absprechen' });
  assert.equal(r.data.status, 'offen');
  await anna('POST', `/api/swaps/${o2.id}/take`);
  r = await mgr('POST', `/api/swaps/${o2.id}/decide`, { status: 'bestaetigt' });
  assert.equal(r.data.status, 'erledigt');
  plan2 = (await mgr('GET', `/api/plan?from=${day(15)}&to=${day(15)}`)).data.shifts.find((s) => s.id === f2.id);
  assert.deepEqual(plan2.assigned.map((a) => a.user_id), [users.abecker]);
  await mgr('PUT', '/api/settings', { tausch_bestaetigung: false });

  // Zurückziehen
  const f3 = await shiftOn(day(16), 'F');
  await mgr('POST', `/api/shifts/${f3.id}/assign`, { user_id: users.abecker });
  const o3 = (await anna('POST', '/api/swaps', { shift_id: f3.id })).data;
  assert.equal((await murat('DELETE', `/api/swaps/${o3.id}`)).status, 403);
  assert.equal((await anna('DELETE', `/api/swaps/${o3.id}`)).status, 200);
  // Protokoll
  const log = (await mgr('GET', '/api/log')).data;
  assert.ok(log.some((l) => l.action === 'swap.done'));
});
