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
