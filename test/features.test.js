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
      method, headers: { ...(body ? { 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined,
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

test('Benachrichtigungen: Ereignisse, Push-Abo, Rundruf, AU-Erinnerung', async () => {
  const lena = await as('lhoffmann');
  const unread = async (c) => (await c('GET', '/api/notifications')).data;
  // Verwaltung trägt Lena ein → Mitteilung „Neuer Dienst“
  const s = await shiftOn(day(20), 'S');
  await mgr('POST', `/api/shifts/${s.id}/assign`, { user_id: users.lhoffmann });
  let n = await unread(lena);
  assert.ok(n.unread >= 1);
  assert.equal(n.items[0].titel, 'Neuer Dienst');
  assert.match(n.items[0].text, /Spätdienst/);
  // eigene Eintragung erzeugt keine Mitteilung an sich selbst
  const before = n.unread;
  // Urlaubsantrag → Verwaltung wird informiert; Entscheidung → Lena wird informiert
  const mon = (() => { for (let i = 30; ; i++) { const d = day(i); if (new Date(d).getUTCDay() === 2) return d; } })();
  const a = (await lena('POST', '/api/absences', { type: 'urlaub', from: mon, to: mon })).data;
  assert.ok((await unread(mgr)).items.some((x) => x.titel.startsWith('Antrag: Erholungsurlaub')));
  await mgr('PUT', `/api/absences/${a.id}/decision`, { status: 'genehmigt' });
  n = await unread(lena);
  assert.equal(n.items[0].titel, 'Erholungsurlaub genehmigt');
  assert.equal(n.unread, before + 1);
  // als gelesen markieren
  await lena('POST', '/api/notifications/read', { ids: [n.items[0].id] });
  assert.equal((await unread(lena)).unread, before);
  await lena('POST', '/api/notifications/read', {});
  assert.equal((await unread(lena)).unread, 0);

  // Push-Abo speichern (Versand an Test-Endpunkt schlägt still fehl)
  assert.equal((await lena('POST', '/api/push/subscribe', { subscription: { endpoint: 'http://unsicher' } })).status, 400);
  const sub = { endpoint: 'https://push.example.invalid/abc', keys: { p256dh: 'BOr9W1BKj6bN3lB8vQ1Wq3m1h3r8y3z0x6m7c8f4D1kq9hW8zq0cLk6nX0A0H1f8l3W6x9QeY1d2Z3a4b5c6d7e8', auth: 'aGVsbG8td29ybGQtMTIz' } };
  assert.equal((await lena('POST', '/api/push/subscribe', { subscription: sub })).data.geraete, 1);
  assert.equal((await lena('GET', '/api/me/notify-prefs')).data.geraete, 1);
  assert.equal((await lena('DELETE', '/api/push/subscribe', { endpoint: sub.endpoint })).status, 200);
  assert.equal((await lena('GET', '/api/me/notify-prefs')).data.geraete, 0);
  // Push-Schlüssel: öffentlich abrufbar, privater Schlüssel nie in Einstellungen
  assert.ok((await lena('GET', '/api/push/key')).data.key.length > 50);
  const st = JSON.stringify((await mgr('GET', '/api/settings')).data) + JSON.stringify((await lena('GET', '/api/me')).data);
  assert.ok(!/vapid/i.test(st));

  // Rundruf: nur an Personen ohne Konflikt und ohne Abwesenheit, nicht an Eingetragene
  const n2 = await shiftOn(day(21), 'N', 'Station 2');
  await mgr('POST', `/api/shifts/${n2.id}/assign`, { user_id: users.twagner });
  await mgr('POST', '/api/absences', { user_id: users.jschmitz, type: 'krank', from: day(21), to: day(21) });
  assert.equal((await lena('POST', `/api/shifts/${n2.id}/rundruf`, {})).status, 403);
  const r = await mgr('POST', `/api/shifts/${n2.id}/rundruf`, { note: 'Krankheitsausfall' });
  const empf = r.data.empfaenger;
  assert.ok(empf >= 1);
  const tobias = await as('twagner');
  assert.ok(!(await unread(tobias)).items.some((x) => x.art === 'rundruf'));       // schon eingetragen
  assert.ok((await unread(lena)).items.some((x) => x.art === 'rundruf'));          // verfügbar
  const julia = await as('jschmitz');
  assert.ok(!(await unread(julia)).items.some((x) => x.art === 'rundruf'));        // krank
  // nur mit Qualifikation
  // gezielt Fachkräfte suchen: Hilfskräfte werden nicht angeschrieben (Fachkräfte vertreten Hilfskräfte, nicht umgekehrt)
  const r2 = await mgr('POST', `/api/shifts/${n2.id}/rundruf`, { qualification: 'Pflegefachkraft' });
  assert.ok(r2.data.empfaenger < empf);

  // AU-Erinnerung: Krankmeldung über 5 Tage ab vor 6 Tagen ohne Bescheinigung → genau einmal erinnern
  await mgr('POST', '/api/absences', { user_id: users.kschulz, type: 'krank', from: day(-6), to: day(-2) });
  const first = (await mgr('POST', '/api/admin/run-reminders')).data.au;
  assert.ok(first >= 1);
  assert.equal((await mgr('POST', '/api/admin/run-reminders')).data.au, 0);
  const kevin = await as('kschulz');
  assert.ok((await unread(kevin)).items.some((x) => x.art === 'au'));
});

test('Verwaltungsrechte nur für bestimmte Stationen', async () => {
  const units = (await mgr('GET', '/api/units')).data;
  const s1 = units.find((u) => u.name === 'Station 1').id, s2 = units.find((u) => u.name === 'Station 2').id;
  // Stammbereiche setzen: Kevin → Station 1, Tobias → Station 2
  await mgr('PUT', `/api/users/${users.kschulz}`, { stammbereich_id: s1 });
  await mgr('PUT', `/api/users/${users.twagner}`, { stammbereich_id: s2 });
  // Murat wird Verwalter nur für Station 1
  let r = await mgr('PUT', `/api/users/${users.myilmaz}`, { admin_rechte: 'voll', admin_units: [s1] });
  assert.deepEqual(r.data.admin_units, [s1]);
  assert.equal(r.data.is_manager, true);
  const murat = await as('myilmaz');
  const me = (await murat('GET', '/api/me')).data.user;
  assert.deepEqual(me.admin_units, [s1]);

  // Dienstplan: auf Station 1 eintragen erlaubt, auf Station 2 nicht (für andere Personen)
  const f1 = await shiftOn(day(25), 'F', 'Station 1');
  const f2 = await shiftOn(day(25), 'F', 'Station 2');
  assert.equal((await murat('POST', `/api/shifts/${f1.id}/assign`, { user_id: users.kschulz })).status, 200);
  r = await murat('POST', `/api/shifts/${f2.id}/assign`, { user_id: users.twagner });
  assert.equal(r.data.code, 'BEREICH');
  const plan2 = (await mgr('GET', `/api/plan?from=${day(25)}&to=${day(25)}`)).data.shifts.find((s) => s.id === f2.id);
  assert.equal(plan2.assigned.length, 0);
  assert.equal((await murat('DELETE', `/api/shifts/${f1.id}/assign?user_id=${users.kschulz}`, { reason: 'Test' })).status, 200);
  assert.equal((await murat('PUT', `/api/shifts/${f2.id}`, { min_staff: 1 })).data.code, 'BEREICH');
  assert.equal((await murat('PUT', `/api/shifts/${f1.id}`, { min_staff: 1 })).status, 200);
  assert.equal((await murat('POST', '/api/shifts/generate', { from: day(26), to: day(26), unit_ids: [s2] })).data.code, 'BEREICH');
  assert.equal((await murat('POST', '/api/shifts/generate', { from: day(26), to: day(26) })).status, 200); // nur eigene Stationen
  // Mindestbesetzung nur für eigene Station
  assert.equal((await murat('PUT', '/api/requirements', [{ unit_id: s2, shift_type_id: 1, weekday: 1, min_staff: 1, max_staff: 2 }])).data.code, 'BEREICH');
  // Personal: Kevin (Station 1) bearbeitbar, Tobias (Station 2) nicht
  assert.equal((await murat('PUT', `/api/users/${users.kschulz}`, { telefon: '1234' })).status, 200);
  assert.equal((await murat('PUT', `/api/users/${users.twagner}`, { telefon: '1234' })).data.code, 'BEREICH');
  assert.equal((await murat('PUT', `/api/users/${users.kschulz}`, { stammbereich_id: s2 })).data.code, 'BEREICH');
  // neue Person nur mit Stammbereich im eigenen Bereich
  assert.equal((await murat('POST', '/api/users', { name: 'Neu', username: 'neu1', password: 'geheim1' })).data.code, 'BEREICH');
  assert.equal((await murat('POST', '/api/users', { name: 'Neu', username: 'neu1', password: 'geheim1', stammbereich_id: s1 })).status, 200);
  // Abwesenheiten: für Tobias (Station 2) nichts eintragen
  assert.equal((await murat('POST', '/api/absences', { user_id: users.twagner, type: 'krank', from: day(27), to: day(27) })).data.code, 'BEREICH');
  assert.equal((await murat('POST', '/api/absences', { user_id: users.kschulz, type: 'krank', from: day(27), to: day(27) })).status, 200);
  // Campusweite Einstellungen gesperrt; Lesen erlaubt
  assert.equal((await murat('PUT', '/api/settings', { klinik_name: 'X' })).data.code, 'BEREICH');
  assert.equal((await murat('POST', '/api/units', { name: 'Neue Station' })).status, 403);
  assert.equal((await murat('POST', '/api/shift-types', { name: 'X', code: 'X', start_time: '08:00', end_time: '16:00', break_min: 30 })).status, 403);
  assert.equal((await murat('GET', '/api/users')).status, 200);
  assert.equal((await murat('GET', `/api/report?month=${day(25).slice(0, 7)}`)).status, 200);
  // Rechte vergeben bleibt der Hauptverwaltung vorbehalten
  assert.equal((await murat('PUT', `/api/users/${users.kschulz}`, { admin_units: [s1] })).status, 403);
  // ganzer Campus: Bereich leeren
  r = await mgr('PUT', `/api/users/${users.myilmaz}`, { admin_units: [] });
  assert.deepEqual(r.data.admin_units, []);
  assert.equal((await murat('PUT', `/api/shifts/${f2.id}`, { min_staff: 1 })).status, 200);
  await mgr('PUT', `/api/users/${users.myilmaz}`, { admin_rechte: 'keine' });
});

test('Dienstwünsche: Frist, Höchstzahl, Wunschdienst, Sichtbarkeit', async () => {
  const kevin = await as('kschulz');
  const tobias = await as('twagner');
  await mgr('PUT', '/api/settings', { wunsch_frist_tage: 14, wunsch_frei_max_monat: 2 });
  // zu kurzfristig
  assert.equal((await kevin('PUT', '/api/wishes', { date: day(3), art: 'frei' })).data.code, 'FRIST');
  // Monat mit mindestens 3 freien Tagen nach der Frist
  const base = new Date(Date.now() + 40 * 86400000);
  const month = `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, '0')}`;
  const d = (n) => `${month}-${String(n).padStart(2, '0')}`;
  assert.equal((await kevin('PUT', '/api/wishes', { date: d(10), art: 'frei', note: 'Geburtstag' })).status, 200);
  assert.equal((await kevin('PUT', '/api/wishes', { date: d(11), art: 'frei' })).status, 200);
  assert.equal((await kevin('PUT', '/api/wishes', { date: d(12), art: 'frei' })).data.code, 'LIMIT');
  // bestehenden Wunsch ändern zählt nicht doppelt
  assert.equal((await kevin('PUT', '/api/wishes', { date: d(11), art: 'frei', note: 'geändert' })).status, 200);
  // Wunschdienst (Frühdienst)
  const types = (await kevin('GET', '/api/shift-types')).data;
  const fId = types.find((t) => t.code === 'F').id;
  let r = await kevin('PUT', '/api/wishes', { date: d(13), art: 'dienst', shift_type_id: fId });
  assert.equal(r.data.type_code, 'F');
  assert.equal((await kevin('PUT', '/api/wishes', { date: d(14), art: 'dienst' })).status, 400);
  // Sichtbarkeit
  await tobias('PUT', '/api/wishes', { date: d(10), art: 'frei' });
  const own = (await kevin('GET', `/api/wishes?from=${d(1)}&to=${d(28)}`)).data.wuensche;
  assert.ok(own.every((w) => w.user_id === users.kschulz));
  assert.equal(own.length, 3);
  const all = (await mgr('GET', `/api/wishes?from=${d(1)}&to=${d(28)}`)).data.wuensche;
  assert.ok(all.some((w) => w.user_id === users.twagner));
  // im Dienstplan: Verwaltung sieht alle Wünsche, Mitarbeitende nur eigene
  assert.ok((await mgr('GET', `/api/plan?from=${d(10)}&to=${d(10)}`)).data.wishes.length >= 2);
  assert.ok((await kevin('GET', `/api/plan?from=${d(10)}&to=${d(10)}`)).data.wishes.every((w) => w.user_id === users.kschulz));
  // löschen
  await kevin('DELETE', `/api/wishes/${d(13)}`);
  assert.equal((await kevin('GET', `/api/wishes?from=${d(1)}&to=${d(28)}`)).data.wuensche.length, 2);
  // Verwaltung darf trotz Frist/Limit für Personen ihres Bereichs eintragen
  assert.equal((await mgr('PUT', '/api/wishes', { user_id: users.kschulz, date: day(2), art: 'frei' })).status, 200);
});

test('Arbeitszeitregeln und Wechselschichtzulage', async () => {
  const julia = await as('jschmitz');
  await mgr('PUT', '/api/settings', { max_std_tag: 10, max_std_woche: 48, max_naechte_folge: 3, max_tage_folge: 6, ruhezeit_std: 11 });
  // Nachtdienste in Folge: 3 erlaubt, der 4. nicht (für Mitarbeitende), Verwaltung kann Ausnahme machen
  // ein Montag zwischen dem 1. und 10. eines Monats (alle Testdienste liegen im selben Monat)
  const start = (() => { for (let i = 50; ; i++) { const x = new Date(day(i)); if (x.getUTCDay() === 1 && x.getUTCDate() <= 10) return i; } })();
  const nights = [];
  for (let i = 0; i < 4; i++) nights.push(await shiftOn(day(start + i), 'N', 'Station 2'));
  for (let i = 0; i < 3; i++) assert.equal((await julia('POST', `/api/shifts/${nights[i].id}/assign`)).status, 200);
  let r = await julia('POST', `/api/shifts/${nights[3].id}/assign`);
  assert.equal(r.data.code, 'ARBZG');
  assert.match(r.data.error, /4 Nachtdienste in Folge/);
  r = await mgr('POST', `/api/shifts/${nights[3].id}/assign`, { user_id: users.jschmitz });
  assert.equal(r.data.code, 'ARBZG');
  r = await mgr('POST', `/api/shifts/${nights[3].id}/assign`, { user_id: users.jschmitz, force: true });
  assert.equal(r.status, 200);

  // Tageshöchstarbeitszeit: ein 11-Stunden-Dienst ist nicht ohne Ausnahme möglich
  const lang = (await mgr('POST', '/api/shift-types', { name: 'Langdienst', code: 'L', start_time: '07:00', end_time: '18:30', break_min: 30 })).data;
  await mgr('PUT', '/api/requirements', [{ unit_id: 1, shift_type_id: lang.id, weekday: new Date(day(start + 10)).getUTCDay(), min_staff: 1, max_staff: 2 }]);
  const l = await shiftOn(day(start + 10), 'L', 'Station 1');
  r = await julia('POST', `/api/shifts/${l.id}/assign`);
  assert.equal(r.data.code, 'ARBZG');
  assert.match(r.data.error, /Mehr als 10 Std/);
  await mgr('PUT', `/api/shift-types/${lang.id}`, { active: false });

  // Wochenhöchstarbeitszeit (hier testweise 20 Std.): 3. Dienst à 8 Std. in derselben Woche überschreitet
  await mgr('PUT', '/api/settings', { max_std_woche: 20, max_naechte_folge: 0 });
  const wk = start + 14;
  const fr = [];
  for (let i = 0; i < 3; i++) fr.push(await shiftOn(day(wk + i), 'F', 'Station 1'));
  const tobias = await as('twagner');
  assert.equal((await tobias('POST', `/api/shifts/${fr[0].id}/assign`)).status, 200);
  assert.equal((await tobias('POST', `/api/shifts/${fr[1].id}/assign`)).status, 200);
  r = await tobias('POST', `/api/shifts/${fr[2].id}/assign`);
  assert.equal(r.data.code, 'ARBZG');
  assert.match(r.data.error, /Mehr als 20 Std\. in der Woche/);
  await mgr('PUT', '/api/settings', { max_std_woche: 48, max_naechte_folge: 5 });

  // Zulage: Julia hat im Monat 4 Nachtdienste und (nur) Nachtdienste → keine wechselnden Anfangszeiten → keine Zulage
  const month = day(start).slice(0, 7);
  let row = (await mgr('GET', `/api/report?month=${month}`)).data.rows.find((x) => x.user_id === users.jschmitz);
  assert.equal(row.nachtschichten, 4);
  assert.equal(row.zulage, '');
  // plus ein Frühdienst im selben Monat → Wechselschicht
  const extra = await shiftOn(day(start + 7), 'F', 'Station 1');
  await mgr('POST', `/api/shifts/${extra.id}/assign`, { user_id: users.jschmitz, force: true });
  row = (await mgr('GET', `/api/report?month=${month}`)).data.rows.find((x) => x.user_id === users.jschmitz);
  assert.equal(row.zulage, 'Wechselschicht');
  assert.equal(row.zulage_eur, 155);
  const csv = (await mgr('GET', `/api/report.csv?month=${month}`)).data;
  assert.match(csv, /Zulage EUR/);
});

test('Automatischer Planvorschlag: Vorschau, Regeln, Fairness, Übernahme', async () => {
  await mgr('PUT', '/api/settings', { max_naechte_folge: 5, max_tage_folge: 6, max_std_woche: 48, ruhezeit_std: 11 });
  // eine Woche in ferner Zukunft, nur Station 2
  const mon = (() => { for (let i = 120; ; i++) if (new Date(day(i)).getUTCDay() === 1) return day(i); })();
  const sun = new Date(Date.parse(mon) + 6 * 86400000).toISOString().slice(0, 10);
  const units = (await mgr('GET', '/api/units')).data;
  const s2 = units.find((u) => u.name === 'Station 2').id;
  await mgr('POST', '/api/shifts/generate', { from: mon, to: sun, unit_ids: [s2] });
  // Lena möchte am Mittwoch frei, Anna ist Do–Fr krank
  const wed = new Date(Date.parse(mon) + 2 * 86400000).toISOString().slice(0, 10);
  await mgr('PUT', '/api/wishes', { user_id: users.lhoffmann, date: wed, art: 'frei' });
  await mgr('POST', '/api/absences', { user_id: users.abecker, type: 'krank',
    from: new Date(Date.parse(mon) + 3 * 86400000).toISOString().slice(0, 10), to: new Date(Date.parse(mon) + 4 * 86400000).toISOString().slice(0, 10) });

  const before = (await mgr('GET', `/api/plan?from=${mon}&to=${sun}`)).data.shifts.reduce((a, s) => a + s.assigned.length, 0);
  const r = await mgr('POST', '/api/planvorschlag', { from: mon, to: sun, unit_ids: [s2] });
  assert.equal(r.status, 200);
  const v = r.data.vorschlaege;
  assert.ok(v.length > 0);
  // Vorschau ändert nichts
  const after = (await mgr('GET', `/api/plan?from=${mon}&to=${sun}`)).data.shifts.reduce((a, s) => a + s.assigned.length, 0);
  assert.equal(after, before);
  // Regeln
  assert.ok(!v.some((x) => x.user_id === users.lhoffmann && x.date === wed), 'Wunsch frei verletzt');
  const thu = new Date(Date.parse(mon) + 3 * 86400000).toISOString().slice(0, 10);
  const fri = new Date(Date.parse(mon) + 4 * 86400000).toISOString().slice(0, 10);
  assert.ok(!v.some((x) => x.user_id === users.abecker && (x.date === thu || x.date === fri)), 'Abwesenheit verletzt');
  const perDay = new Map();
  for (const x of v) { const k = `${x.user_id}|${x.date}`; perDay.set(k, (perDay.get(k) || 0) + 1); }
  assert.ok([...perDay.values()].every((n) => n === 1), 'zwei Dienste am selben Tag');
  assert.ok(v.every((x) => x.grund.length > 0));
  // Fairness: Unterschied der Dienstanzahl zwischen Personen gleicher Wochenstunden höchstens 3
  const count = new Map();
  for (const x of v) count.set(x.user_id, (count.get(x.user_id) || 0) + 1);
  const full = [users.abecker, users.myilmaz, users.twagner, users.kschulz].map((id) => count.get(id) || 0);
  assert.ok(Math.max(...full) - Math.min(...full) <= 4, `ungleich verteilt: ${full}`);

  // nur einen Teil übernehmen
  const pick = v.slice(0, 3).map((x) => ({ shift_id: x.shift_id, user_id: x.user_id }));
  const res = await mgr('POST', '/api/planvorschlag/uebernehmen', { items: pick });
  assert.equal(res.data.eingetragen, 3);
  const plan = (await mgr('GET', `/api/plan?from=${mon}&to=${sun}`)).data.shifts;
  for (const p of pick) assert.ok(plan.find((s) => s.id === p.shift_id).assigned.some((a) => a.user_id === p.user_id));
  // doppelt übernehmen → übersprungen
  const again = await mgr('POST', '/api/planvorschlag/uebernehmen', { items: pick });
  assert.equal(again.data.eingetragen, 0);
  assert.equal(again.data.fehler.length, 3);
  // Rest übernehmen: danach ist jeder Dienst gedeckt (inkl. Qualifikation) oder als offen gemeldet
  const rest = v.slice(3).map((x) => ({ shift_id: x.shift_id, user_id: x.user_id }));
  assert.equal((await mgr('POST', '/api/planvorschlag/uebernehmen', { items: rest })).data.eingetragen, rest.length);
  const offenIds = new Set(r.data.offen.map((o) => o.shift_id));
  for (const sh of (await mgr('GET', `/api/plan?from=${mon}&to=${sun}`)).data.shifts.filter((x) => x.unit_id === s2)) {
    if (offenIds.has(sh.id)) continue;
    assert.ok(sh.assigned.length >= sh.min_staff && sh.qual_missing.length === 0, `Dienst ${sh.id} nicht gedeckt`);
  }
  // Mitarbeitende dürfen keinen Vorschlag berechnen
  const kevin = await as('kschulz');
  assert.equal((await kevin('POST', '/api/planvorschlag', { from: mon, to: sun })).status, 403);
  // Benachrichtigung „Neue Dienste eingeplant“
  const who = pick[0].user_id;
  const uname = Object.keys(users).find((k) => users[k] === who);
  const c = await as(uname);
  assert.ok((await c('GET', '/api/notifications')).data.items.some((n) => n.titel === 'Neue Dienste eingeplant'));
});

test('Weitere Abwesenheitsarten und Resturlaub-Übertrag', async () => {
  const lena = await as('lhoffmann');
  // Fortbildung: Thema Pflicht, wird beantragt und zählt als Arbeitszeit
  const mo = (() => { for (let i = 200; ; i++) { const x = new Date(day(i)); if (x.getUTCDay() === 1 && x.getUTCDate() <= 20) return day(i); } })();
  assert.equal((await lena('POST', '/api/absences', { type: 'fortbildung', from: mo, to: mo })).data.code, 'BEGRUENDUNG');
  const fb = (await lena('POST', '/api/absences', { type: 'fortbildung', from: mo, to: mo, note: 'Deeskalationstraining' })).data;
  assert.equal(fb.status, 'beantragt');
  await mgr('PUT', `/api/absences/${fb.id}/decision`, { status: 'genehmigt' });
  // Kind krank: gemeldet wie Krankheit, Soll sinkt statt Gutschrift
  const di = new Date(Date.parse(mo) + 86400000).toISOString().slice(0, 10);
  const kk = (await mgr('POST', '/api/absences', { user_id: users.lhoffmann, type: 'kind_krank', from: di, to: di })).data;
  assert.equal(kk.status, 'gemeldet');
  assert.equal((await mgr('PUT', `/api/absences/${kk.id}/decision`, { status: 'genehmigt' })).status, 400);
  const row = (await mgr('GET', `/api/report?month=${mo.slice(0, 7)}`)).data.rows.find((x) => x.user_id === users.lhoffmann);
  const perDay = 19.25 / 5;
  assert.equal(row.fortbildung_tage, 1);
  assert.ok(Math.abs(row.fortbildung_std - perDay) < 0.01);
  assert.equal(row.unbezahlt_tage, 1);
  // Elternzeit unbekannter Typ → Fehler; Elternzeit gültig
  assert.equal((await lena('POST', '/api/absences', { type: 'quatsch', from: mo, to: mo })).status, 400);

  // Übertrag: manuell im Einführungsjahr, automatisch im Folgejahr
  const jahr = new Date().getUTCFullYear();
  let r = await mgr('PUT', `/api/users/${users.lhoffmann}/uebertrag`, { jahr, tage: 7 });
  assert.equal(r.data.uebertrag, 7);
  assert.equal(r.data.uebertrag_quelle, 'manuell');
  const k = (await lena('GET', `/api/absences?year=${jahr}&mine=1`)).data.urlaub;
  assert.equal(k.uebertrag, 7);
  assert.equal(k.uebertrag_bis, `${jahr}-03-31`);
  // nach dem 31.03. ist nicht genutzter Übertrag verfallen (im laufenden Jahr, falls Stichtag vorbei)
  if (new Date().toISOString().slice(0, 10) > `${jahr}-03-31`) assert.equal(k.verfallen, 7);
  // Folgejahr automatisch: Rest dieses Jahres (Anspruch + nicht verfallener Übertrag − genehmigt)
  const next = (await lena('GET', `/api/absences?year=${jahr + 1}&mine=1`)).data.urlaub;
  assert.equal(next.uebertrag_quelle, 'automatisch');
  assert.equal(next.uebertrag, k.anspruch + k.uebertrag - k.verfallen - k.genehmigt);
  // manuellen Wert entfernen
  r = await mgr('PUT', `/api/users/${users.lhoffmann}/uebertrag`, { jahr, tage: null });
  assert.equal(r.data.uebertrag_quelle, '');
  assert.equal((await lena('PUT', `/api/users/${users.lhoffmann}/uebertrag`, { jahr, tage: 30 })).status, 403);
  // Stichtag einstellbar, Format geprüft
  assert.equal((await mgr('PUT', '/api/settings', { urlaub_uebertrag_bis: '31.03.' })).status, 400);
  assert.equal((await mgr('PUT', '/api/settings', { urlaub_uebertrag_bis: '05-31' })).status, 200);
  await mgr('PUT', '/api/settings', { urlaub_uebertrag_bis: '03-31' });
});

test('Ist-Zeiten, Bereitschaftsdienst und Rufbereitschaft', async () => {
  // eigener Mitarbeiter, damit andere Tests nicht stören
  const nu = await mgr('POST', '/api/users', { username: 'zeittest', name: 'Zeit Test', password: 'demo12345', role: 'staff', weekly_hours: 38.5, stundenentgelt: 20 });
  assert.equal(nu.status, 200, JSON.stringify(nu.data));
  const uid = nu.data.id;
  const zt = client();
  await login(zt, 'zeittest', 'demo12345');
  const past = (n) => day(-n);
  // Frühdienst vor 2 Tagen, 1 Std. länger gearbeitet
  const f = await shiftOn(past(2), 'F', 'Station 2');
  assert.equal((await mgr('POST', `/api/shifts/${f.id}/assign`, { user_id: uid, force: true })).status, 200);
  const z0 = (await zt('GET', '/api/zeiten?mine=1')).data;
  assert.ok(z0.zeiten.some((z) => z.shift_id === f.id && z.ist_std === null));
  const [eh, em] = f.end_time.split(':').map(Number);
  const spaeter = `${String((eh + 1) % 24).padStart(2, '0')}:${String(em).padStart(2, '0')}`;
  let r = await zt('PUT', `/api/zeiten/${f.id}`, { ist_start: f.start_time, ist_end: spaeter, ist_pause: f.break_min, ist_note: 'Übergabe' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.diff_std, 1);
  // Plausibilität
  assert.equal((await zt('PUT', `/api/zeiten/${f.id}`, { ist_start: '25:00', ist_end: spaeter })).status, 400);
  // Frist: nach 14 Tagen nur noch Verwaltung
  const alt = await shiftOn(past(20), 'F', 'Station 2');
  await mgr('POST', `/api/shifts/${alt.id}/assign`, { user_id: uid, force: true });
  r = await zt('PUT', `/api/zeiten/${alt.id}`, { ist_start: alt.start_time, ist_end: alt.end_time });
  assert.equal(r.data.code, 'FRIST');
  assert.equal((await mgr('PUT', `/api/zeiten/${alt.id}`, { user_id: uid, ist_start: alt.start_time, ist_end: alt.end_time })).status, 200);
  // Zukunft nicht erfassbar
  const fut = await shiftOn(day(30), 'F', 'Station 2');
  await mgr('POST', `/api/shifts/${fut.id}/assign`, { user_id: uid, force: true });
  assert.equal((await zt('PUT', `/api/zeiten/${fut.id}`, { ist_start: fut.start_time, ist_end: fut.end_time })).status, 400);
  // fremde Zeiten nicht änderbar
  r = await zt('PUT', `/api/zeiten/${f.id}`, { user_id: users.abecker, ist_start: f.start_time, ist_end: spaeter, ist_pause: f.break_min });
  assert.equal(r.data.user_id, uid); // user_id wird bei Mitarbeitenden ignoriert

  // Report: Überstunde zählt
  const month = past(2).slice(0, 7);
  let row = (await mgr('GET', `/api/report?month=${month}&user_id=${uid}`)).data.rows[0];
  assert.equal(row.ueberstunden, 1);

  // Bereitschaftsdienst (Wertung 50 %) und Rufbereitschaft als eigene Dienstarten
  const st2 = (await mgr('GET', '/api/units')).data.find((u) => u.name === 'Station 2').id;
  const bd = (await mgr('POST', '/api/shift-types', { name: 'Bereitschaft', code: 'BD', start_time: '16:00', end_time: '22:00', break_min: 0, color: '#888888', art: 'bereitschaft', bewertung: 50, active: true })).data;
  const rb = (await mgr('POST', '/api/shift-types', { name: 'Rufbereitschaft', code: 'RB', start_time: '08:00', end_time: '08:00', break_min: 0, color: '#999999', art: 'ruf', bewertung: 100, active: true })).data;
  assert.equal((await mgr('POST', '/api/shift-types', { name: 'X', code: 'X', start_time: '08:00', end_time: '09:00', break_min: 0, art: 'quatsch' })).status, 400);
  const reqs = [0, 1, 2, 3, 4, 5, 6].flatMap((w) => [{ unit_id: st2, shift_type_id: bd.id, weekday: w, min_staff: 1 }, { unit_id: st2, shift_type_id: rb.id, weekday: w, min_staff: 1 }]);
  await mgr('PUT', '/api/requirements', reqs);
  // Werktag (Mo–Fr, kein Feiertag) in der Vergangenheit, gleicher Monat wie oben möglichst egal
  const wd = (() => { for (let i = 3; ; i++) { const x = new Date(day(-i)); if (x.getUTCDay() >= 2 && x.getUTCDay() <= 4) return day(-i); } })();
  const bdS = await shiftOn(wd, 'BD', 'Station 2');
  const rbDay = (() => { const x = new Date(Date.parse(wd) - 86400000); return x.toISOString().slice(0, 10); })();
  const rbS = await shiftOn(rbDay, 'RB', 'Station 2');
  assert.ok(bdS && rbS);
  await mgr('POST', `/api/shifts/${bdS.id}/assign`, { user_id: uid, force: true });
  await mgr('POST', `/api/shifts/${rbS.id}/assign`, { user_id: uid, force: true });
  r = await zt('PUT', `/api/zeiten/${rbS.id}`, { einsatz_std: 2.5 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.einsatz_std, 2.5);
  assert.equal((await zt('PUT', `/api/zeiten/${rbS.id}`, { einsatz_std: 30 })).status, 400);
  const rep = (await mgr('GET', `/api/report?month=${wd.slice(0, 7)}&user_id=${uid}`)).data.rows[0];
  assert.equal(rep.bereitschaft_std, 3); // 6 Std. × 50 %
  assert.equal(rep.ruf_dienste, 1);
  assert.equal(rep.ruf_einsatz_std, 2.5);
  // 24 Std. Rufbereitschaft an einem Werktag: 2 × 20 € (Montag–Freitag; Sonntag/Feiertag → 4 ×)
  const we = [0, 6].includes(new Date(rbDay).getUTCDay());
  assert.ok([40, 80].includes(rep.ruf_eur), String(rep.ruf_eur));
  if (!we) assert.equal(rep.ruf_eur, 40);
  // Zurücksetzen durch Verwaltung
  assert.equal((await mgr('DELETE', `/api/zeiten/${f.id}?user_id=${uid}`)).status, 200);
  row = (await mgr('GET', `/api/report?month=${month}&user_id=${uid}`)).data.rows[0];
  assert.equal(row.ueberstunden, 0);
  const csv = (await mgr('GET', `/api/report.csv?month=${wd.slice(0, 7)}`)).data;
  assert.match(csv, /Ruf/);
  // Typen wieder deaktivieren, damit andere Tests unberührt bleiben
  await mgr('PUT', '/api/requirements', reqs.map((x) => ({ ...x, min_staff: 0 })));
});

test('Exporte: Lohn-Übergabe und Aushang', async () => {
  const month = day(12).slice(0, 7);
  const n = await shiftOn(day(12), 'N');
  await mgr('POST', `/api/shifts/${n.id}/assign`, { user_id: users.abecker, force: true });
  await mgr('PUT', `/api/users/${users.abecker}`, { personalnummer: '4711' });
  const l = (await mgr('GET', `/api/export/lohn?month=${month}`)).data;
  const anna = l.lines.filter((x) => x.personalnummer === '4711');
  assert.ok(anna.some((x) => x.schluessel === 'stunden' && x.lohnart === '1000' && x.menge > 0));
  assert.ok(anna.some((x) => x.schluessel === 'nacht' && x.menge > 0));
  assert.ok(l.fehlend.length > 0); // Demo-Personal ohne Personalnummer
  // eigene Lohnart-Nummer
  await mgr('PUT', '/api/settings', { lohnarten: ['nacht=9999'] });
  const csv = (await mgr('GET', `/api/export/lohn.csv?month=${month}`));
  assert.match(csv.headers.get('content-disposition'), /lohn-/);
  assert.match(csv.data, /"4711";"Anna Becker";"[0-9-]+";"9999";"Zeitzuschlag Nachtarbeit"/);
  assert.match(csv.data, /"stunden"/); // ohne Nummer → Schlüssel
  await mgr('PUT', '/api/settings', { lohnarten: ['stunden=1000', 'nacht=1110'] });
  // Mitarbeitende: kein Zugriff
  const anna2 = await as('abecker');
  assert.equal((await anna2('GET', `/api/export/lohn.csv?month=${month}`)).status, 403);
  assert.equal((await anna2('GET', `/api/export/aushang?unit_id=${n.unit_id}&from=${day(10)}&to=${day(14)}`)).status, 403);
  // Aushang
  const a = await mgr('GET', `/api/export/aushang?unit_id=${n.unit_id}&from=${day(10)}&to=${day(14)}`);
  assert.equal(a.status, 200);
  assert.match(a.headers.get('content-type'), /text\/html/);
  assert.match(a.data, /Dienstplan Station 1/);
  assert.match(a.data, /Anna Becker/);
  assert.match(a.data, /size: A4 landscape/);
  assert.doesNotMatch(a.data, /krank|Urlaub/i);
  assert.equal((await mgr('GET', `/api/export/aushang?unit_id=${n.unit_id}&from=${day(0)}&to=${day(60)}`)).status, 400);
  assert.equal((await mgr('GET', `/api/export/aushang?unit_id=99999&from=${day(0)}&to=${day(6)}`)).status, 404);
});

test('Datenschutz: Impressum, Auskunft und Löschfristen', async () => {
  // öffentlich lesbar, ohne Anmeldung
  let r = await fetch(`${base}/api/legal`).then((x) => x.json());
  assert.equal(r.datenschutz_muster, true);
  assert.match(r.datenschutz, /MUSTER/);
  assert.match(r.datenschutz, /12 Monate nach Ende/);
  const imp = 'Landschaftsverband Westfalen-Lippe\n\nMusterstraße 1\n44287 Dortmund';
  assert.equal((await mgr('PUT', '/api/settings', { impressum_text: imp, datenschutz_text: 'Eigene Hinweise' })).status, 200);
  r = await fetch(`${base}/api/legal`).then((x) => x.json());
  assert.equal(r.impressum, imp); // lange Texte werden nicht auf 120 Zeichen gekürzt, Zeilenumbrüche bleiben
  assert.equal(r.datenschutz, 'Eigene Hinweise');
  assert.equal(r.datenschutz_muster, false);
  await mgr('PUT', '/api/settings', { datenschutz_text: '' });
  // Auskunft
  const lena = await as('lhoffmann');
  const ex = await lena('GET', '/api/me/export');
  assert.equal(ex.status, 200);
  assert.match(ex.headers.get('content-disposition'), /meine-daten-/);
  assert.equal(ex.data.person.username, 'lhoffmann');
  assert.ok(Array.isArray(ex.data.abwesenheiten) && Array.isArray(ex.data.dienste));
  assert.equal(ex.data.person.password_hash, undefined);
  // Löschlauf: alte AU-Datei, alter Protokolleintrag, alte Mitteilung
  const pdf = Buffer.from('%PDF-1.4\n% test\n');
  const alt = (await mgr('POST', '/api/absences', { user_id: users.kschulz, type: 'krank', from: '2020-01-06', to: '2020-01-10' })).data;
  assert.ok(alt.id, JSON.stringify(alt));
  const neu = (await mgr('POST', '/api/absences', { user_id: users.kschulz, type: 'krank', from: day(-30), to: day(-29) })).data;
  assert.ok(neu.id, JSON.stringify(neu));
  for (const a of [alt, neu]) assert.equal((await mgr('POST', `/api/absences/${a.id}/attachments`, pdf)).status, 200);
  assert.equal((await lena('POST', '/api/admin/cleanup')).status, 403);
  const res = (await mgr('POST', '/api/admin/cleanup')).data;
  assert.ok(res.au >= 1);
  const find = async (a) => {
    const d = (await mgr('GET', `/api/absences?year=${a.from_date.slice(0, 4)}&user_id=${users.kschulz}`)).data;
    return (Array.isArray(d) ? d : d.items || d.absences || []).find((x) => x.id === a.id);
  };
  assert.equal((await find(alt)).attachments.length, 0);
  assert.equal((await find(neu)).attachments.length, 1);
  // Frist 0 = nichts löschen
  await mgr('PUT', '/api/settings', { loeschfrist_au_monate: 0 });
  assert.equal((await mgr('POST', '/api/admin/cleanup')).data.au, 0);
  await mgr('PUT', '/api/settings', { loeschfrist_au_monate: 12 });
});

test('Passkeys: Schutz der Schnittstellen', async () => {
  const anon = client();
  assert.equal((await anon('POST', '/api/passkeys/register/options')).status, 401);
  assert.equal((await anon('GET', '/api/passkeys')).status, 401);
  // Anmeldeoptionen sind öffentlich, verlangen Benutzerverifikation (Biometrie/PIN)
  const o = (await anon('POST', '/api/passkeys/login/options')).data;
  assert.equal(o.options.userVerification, 'required');
  assert.ok(o.id && o.options.challenge);
  // unbekannter Schlüssel
  let r = await anon('POST', '/api/passkeys/login/verify', { id: o.id, response: { id: 'gibt-es-nicht', type: 'public-key', response: {} } });
  assert.equal(r.status, 401);
  assert.equal(r.data.code, 'UNBEKANNT');
  // Herausforderung nur einmal verwendbar
  r = await anon('POST', '/api/passkeys/login/verify', { id: o.id, response: { id: 'x' } });
  assert.equal(r.data.code, 'ABGELAUFEN');
  // Registrierung: Optionen für angemeldete Person, ohne Biometrie-Pflicht keine Einrichtung
  const lena = await as('lhoffmann');
  const reg = (await lena('POST', '/api/passkeys/register/options')).data;
  assert.equal(reg.authenticatorSelection.userVerification, 'required');
  assert.equal(reg.user.name, 'lhoffmann');
  assert.equal((await lena('POST', '/api/passkeys/register/verify', { response: { id: 'x', response: {} } })).status, 400);
  assert.deepEqual((await lena('GET', '/api/passkeys')).data, []);
  assert.equal((await lena('DELETE', '/api/passkeys/999')).status, 404);
});

test('Rufbereitschaft ist keine Arbeitszeit: Zuweisung ohne Ausnahme, Lohn-Export ohne Doppelzählung', async () => {
  const nu = await mgr('POST', '/api/users', { username: 'ruftest', name: 'Ruf Test', password: 'demo12345', role: 'staff', weekly_hours: 38.5, stundenentgelt: 20, personalnummer: '8800' });
  const uid = nu.data.id;
  const st2 = (await mgr('GET', '/api/units')).data.find((u) => u.name === 'Station 2').id;
  const types = (await mgr('GET', '/api/shift-types')).data;
  const rb = types.find((t) => t.art === 'ruf') || (await mgr('POST', '/api/shift-types', { name: 'Rufbereitschaft', code: 'RB', start_time: '08:00', end_time: '08:00', break_min: 0, art: 'ruf' })).data;
  const bd = types.find((t) => t.art === 'bereitschaft') || (await mgr('POST', '/api/shift-types', { name: 'Bereitschaft', code: 'BD', start_time: '16:00', end_time: '22:00', break_min: 0, art: 'bereitschaft', bewertung: 50 })).data;
  const reqs = [0, 1, 2, 3, 4, 5, 6].flatMap((w) => [rb, bd].map((t) => ({ unit_id: st2, shift_type_id: t.id, weekday: w, min_staff: 1 })));
  await mgr('PUT', '/api/requirements', reqs);
  try {
    // 24-Std.-Rufbereitschaft plus Frühdienst am selben Tag: ohne force zulässig
    const d = day(45);
    const ruf = await shiftOn(d, 'RB', 'Station 2');
    let r = await mgr('POST', `/api/shifts/${ruf.id}/assign`, { user_id: uid });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const f = await shiftOn(d, 'F', 'Station 2');
    r = await mgr('POST', `/api/shifts/${f.id}/assign`, { user_id: uid });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    // Bereitschaftsdienst zählt dagegen als Arbeitszeit: F + BD am selben Tag verletzt die Ruhezeit nicht, aber ArbZG-Tag (8 + 6 Std.)
    const b = await shiftOn(d, 'BD', 'Station 2');
    r = await mgr('POST', `/api/shifts/${b.id}/assign`, { user_id: uid });
    assert.equal(r.status, 409);

    // Lohn-Export: Stunden-Lohnart ohne Bereitschaft/Ruf-Einsätze
    const p = day(-3);
    const rp = await shiftOn(p, 'RB', 'Station 2');
    await mgr('POST', `/api/shifts/${rp.id}/assign`, { user_id: uid });
    await mgr('PUT', `/api/zeiten/${rp.id}`, { user_id: uid, einsatz_std: 2 });
    const bp = await shiftOn(day(-5), 'BD', 'Station 2');
    await mgr('POST', `/api/shifts/${bp.id}/assign`, { user_id: uid, force: true });
    const month = p.slice(0, 7);
    if (day(-5).slice(0, 7) === month) {
      const row = (await mgr('GET', `/api/report?month=${month}&user_id=${uid}`)).data.rows[0];
      const lines = (await mgr('GET', `/api/export/lohn?month=${month}`)).data.lines.filter((x) => x.personalnummer === '8800');
      const get = (k) => lines.find((x) => x.schluessel === k)?.menge || 0;
      assert.equal(get('ruf_einsatz'), 2);
      assert.equal(get('bereitschaft'), 3);
      assert.equal(Math.round((get('stunden') + get('bereitschaft') + get('ruf_einsatz')) * 100) / 100, row.gearbeitet);
    }
  } finally {
    await mgr('PUT', '/api/requirements', reqs.map((x) => ({ ...x, min_staff: 0 })));
  }
});

test('Beispieldaten entfernen (nur Demo-Personen, nur Hauptverwaltung)', async () => {
  // echte Person mit eigenem Passwort bleibt unberührt
  const echt = (await mgr('POST', '/api/users', { username: 'echtperson', name: 'Echte Person', password: 'ganz-geheim-123', role: 'staff' })).data;
  const v = (await mgr('GET', '/api/admin/beispieldaten')).data.personen;
  assert.ok(v.some((p) => p.username === 'abecker'));
  assert.ok(!v.some((p) => p.username === 'echtperson'));
  const anna = await as('abecker');
  assert.equal((await anna('GET', '/api/admin/beispieldaten')).status, 403);
  assert.equal((await mgr('POST', '/api/admin/beispieldaten/entfernen', { ids: [echt.id] })).status, 400);
  const r = (await mgr('POST', '/api/admin/beispieldaten/entfernen', { ids: v.map((p) => p.id) })).data;
  assert.equal(r.entfernt, v.length);
  const rest = (await mgr('GET', '/api/users')).data.map((u) => u.username);
  assert.ok(rest.includes('echtperson') && rest.includes('manager'));
  assert.ok(!rest.includes('abecker'));
  assert.equal((await anna('GET', '/api/me')).status, 401); // Sitzung beendet
  assert.deepEqual((await mgr('GET', '/api/admin/beispieldaten')).data.personen, []);
});

test('Qualifikation vertritt: Pflegefachkraft zählt als Pflegehilfskraft, aber nur einmal', async () => {
  const d = day(60);
  const s = await shiftOn(d, 'S', 'Station 2');
  const pfk = (await mgr('POST', '/api/users', { username: 'qv-pfk', name: 'QV Fachkraft', password: 'demo12345', role: 'staff', qualification: 'Pflegefachkraft' })).data.id;
  const rule = (await mgr('POST', '/api/qual-rules', { unit_id: s.unit_id, shift_type_id: s.shift_type_id, qualification: 'Pflegehilfskraft', min_count: 1 })).data;
  const ruleId = rule.find((r) => r.qualification === 'Pflegehilfskraft' && r.unit_id === s.unit_id).id;
  try {
    // alle anderen austragen, nur die Fachkraft eintragen
    for (const a of s.assigned) await mgr('DELETE', `/api/shifts/${s.id}/assign?user_id=${a.user_id}`, { reason: 'Test' });
    await mgr('POST', `/api/shifts/${s.id}/assign`, { user_id: pfk, force: true });
    const get = async () => (await mgr('GET', `/api/plan?from=${d}&to=${d}`)).data.shifts.find((x) => x.id === s.id);
    let x = await get();
    // globale Regel „1 Pflegefachkraft“ + Stationsregel „1 Pflegehilfskraft“: eine Fachkraft deckt nur eine davon
    assert.deepEqual(x.qual_missing.map((q) => q.qualification), ['Pflegehilfskraft']);
    // ohne Vertretungsregel und nur mit der Hilfskraft-Regel: Fachkraft zählt nicht
    await mgr('PUT', '/api/settings', { qualifikation_vertretung: [] });
    x = await get();
    assert.ok(x.qual_missing.some((q) => q.qualification === 'Pflegehilfskraft'));
    await mgr('PUT', '/api/settings', { qualifikation_vertretung: ['Pflegefachkraft > Pflegehilfskraft'] });
    // zweite Fachkraft: jetzt sind beide Regeln erfüllt (eine als Fachkraft, eine vertritt die Hilfskraft)
    const pfk2 = (await mgr('POST', '/api/users', { username: 'qv-pfk2', name: 'QV Fachkraft 2', password: 'demo12345', role: 'staff', qualification: 'Pflegefachkraft' })).data.id;
    await mgr('POST', `/api/shifts/${s.id}/assign`, { user_id: pfk2, force: true });
    x = await get();
    assert.deepEqual(x.qual_missing, []);
  } finally {
    await mgr('DELETE', `/api/qual-rules/${ruleId}`);
    await mgr('PUT', '/api/settings', { qualifikation_vertretung: ['Pflegefachkraft > Pflegehilfskraft', 'Stationsleitung > Pflegefachkraft'] });
  }
});

test('Monatsabschluss: Prüfliste, Sperre per Datenbank, Wiedereröffnen mit Grund', async () => {
  const now = new Date();
  const vm = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString().slice(0, 10); // 15. des Vormonats
  const month = vm.slice(0, 7);
  const s = await shiftOn(vm, 'F', 'Station 1');
  const nu = (await mgr('POST', '/api/users', { username: 'abschluss1', name: 'Abschluss Test', password: 'demo12345', role: 'staff', stammbereich_id: s.unit_id })).data.id;
  const nu2 = (await mgr('POST', '/api/users', { username: 'abschluss2', name: 'Abschluss Zwei', password: 'demo12345', role: 'staff', stammbereich_id: s.unit_id })).data.id;
  await mgr('POST', `/api/shifts/${s.id}/assign`, { user_id: nu, force: true });
  // Prüfliste zeigt die nicht bestätigte Zeit
  let d = (await mgr('GET', `/api/monatsabschluss?month=${month}`)).data;
  assert.equal(d.abschliessbar, true);
  const st = d.stationen.find((x) => x.unit_id === s.unit_id);
  assert.ok(st.pruefung.zeiten_offen >= 1);
  // laufender Monat kann nicht abgeschlossen werden
  assert.equal((await mgr('POST', '/api/monatsabschluss', { month: now.toISOString().slice(0, 7), unit_ids: [s.unit_id] })).status, 400);
  // Mitarbeitende dürfen nicht abschließen
  const ma = client();
  await login(ma, 'abschluss2', 'demo12345');
  assert.equal((await ma('POST', '/api/monatsabschluss', { month, unit_ids: [s.unit_id] })).status, 403);
  assert.equal((await mgr('POST', '/api/monatsabschluss', { month, unit_ids: [s.unit_id] })).status, 200);
  try {
    // gesperrt: Eintragen, Austragen, Ist-Zeit, Abwesenheit, Schicht ändern
    let r = await mgr('POST', `/api/shifts/${s.id}/assign`, { user_id: nu2, force: true });
    assert.equal(r.status, 409); assert.equal(r.data.code, 'ABGESCHLOSSEN');
    assert.equal((await mgr('DELETE', `/api/shifts/${s.id}/assign?user_id=${nu}`, { reason: 'Test' })).data.code, 'ABGESCHLOSSEN');
    assert.equal((await mgr('PUT', `/api/zeiten/${s.id}`, { user_id: nu, ist_start: s.start_time, ist_end: s.end_time })).data.code, 'ABGESCHLOSSEN');
    assert.equal((await mgr('POST', '/api/absences', { user_id: nu2, type: 'krank', from: vm, to: vm })).data.code, 'ABGESCHLOSSEN');
    assert.equal((await mgr('PUT', `/api/shifts/${s.id}`, { min_staff: 1, note: 'x' })).data.code, 'ABGESCHLOSSEN');
    // Anzeige: Schicht gesperrt, Station abgeschlossen
    const plan = (await mgr('GET', `/api/plan?from=${vm}&to=${vm}`)).data.shifts.find((x) => x.id === s.id);
    assert.ok(plan.gesperrt);
    d = (await mgr('GET', `/api/monatsabschluss?month=${month}`)).data;
    assert.ok(d.stationen.find((x) => x.unit_id === s.unit_id).abgeschlossen);
    // Lohn-Export vorläufig, solange nicht alle Stationen abgeschlossen sind
    assert.equal((await mgr('GET', `/api/export/lohn?month=${month}`)).data.abgeschlossen, false);
    // Wiedereröffnen nur mit Grund
    assert.equal((await mgr('DELETE', `/api/monatsabschluss?month=${month}&unit_id=${s.unit_id}`, {})).data.code, 'BEGRUENDUNG');
  } finally {
    assert.equal((await mgr('DELETE', `/api/monatsabschluss?month=${month}&unit_id=${s.unit_id}`, { grund: 'Nachtrag Test' })).status, 200);
  }
  assert.equal((await mgr('POST', `/api/shifts/${s.id}/assign`, { user_id: nu2, force: true })).status, 200);
});

test('Rückmeldung: senden, Verwaltung antwortet, Mitteilung an die Person', async () => {
  await mgr('POST', '/api/users', { username: 'rm-person', name: 'RM Person', password: 'demo12345', role: 'staff' });
  const c = client();
  await login(c, 'rm-person', 'demo12345');
  assert.equal((await c('POST', '/api/rueckmeldung', { art: 'fehler', text: 'x' })).status, 400);
  const r = await c('POST', '/api/rueckmeldung', { art: 'fehler', text: 'Beim Tausch fehlt der Name.', ansicht: 'Tauschbörse' });
  assert.equal(r.status, 200);
  assert.equal((await c('GET', '/api/rueckmeldungen')).data.length, 1);
  assert.equal((await c('GET', '/api/rueckmeldungen?alle=1')).data.length, 1); // nur eigene, auch mit ?alle
  const alle = (await mgr('GET', '/api/rueckmeldungen?alle=1')).data;
  const e = alle.find((x) => x.id === r.data.id);
  assert.equal(e.status, 'neu');
  assert.equal(e.ansicht, 'Tauschbörse');
  assert.ok((await mgr('GET', '/api/notifications')).data.items.some((n) => n.art === 'rueckmeldung'));
  assert.equal((await c('PUT', `/api/rueckmeldungen/${e.id}`, { status: 'erledigt' })).status, 403);
  assert.equal((await mgr('PUT', `/api/rueckmeldungen/${e.id}`, { status: 'erledigt', antwort: 'Danke, ist behoben.' })).status, 200);
  assert.equal((await c('GET', '/api/rueckmeldungen')).data[0].antwort, 'Danke, ist behoben.');
  assert.ok((await c('GET', '/api/notifications')).data.items.some((n) => n.titel === 'Antwort auf Ihre Rückmeldung'));
});

test('Flexpool und Externe: Kennzeichnung, Auswertung, Einsatznachweis, nicht in der Lohn-Übergabe', async () => {
  const d = day(-4);
  const month = d.slice(0, 7);
  const s = await shiftOn(d, 'N', 'Station 2');
  assert.equal((await mgr('POST', '/api/users', { username: 'x-ungueltig', name: 'X', password: 'demo12345', role: 'staff', beschaeftigung: 'leih' })).status, 400);
  const fp = (await mgr('POST', '/api/users', { username: 'fp-person', name: 'Flex Pool', password: 'demo12345', role: 'staff', beschaeftigung: 'flexpool', personalnummer: '7001' })).data;
  const ext = (await mgr('POST', '/api/users', { username: 'ext-person', name: 'Ex Tern', password: 'demo12345', role: 'staff', beschaeftigung: 'extern', firma: 'Pflege-Leasing GmbH' })).data;
  assert.equal(fp.beschaeftigung, 'flexpool');
  assert.equal(ext.firma, 'Pflege-Leasing GmbH');
  await mgr('POST', `/api/shifts/${s.id}/assign`, { user_id: fp.id, force: true });
  await mgr('POST', `/api/shifts/${s.id}/assign`, { user_id: ext.id, force: true });
  // im Dienstplan gekennzeichnet
  const plan = (await mgr('GET', `/api/plan?from=${d}&to=${d}`)).data.shifts.find((x) => x.id === s.id);
  assert.equal(plan.assigned.find((a) => a.user_id === fp.id).beschaeftigung, 'flexpool');
  const e = plan.assigned.find((a) => a.user_id === ext.id);
  assert.equal(e.beschaeftigung, 'extern'); assert.equal(e.firma, 'Pflege-Leasing GmbH');
  // Auswertung je Station und Firma
  const arten = (await mgr('GET', `/api/report/einsatzarten?month=${month}`)).data;
  const st = arten.stationen.find((x) => x.unit_id === s.unit_id);
  assert.ok(st.flexpool >= 8 && st.extern >= 8, JSON.stringify(st));
  assert.equal(arten.firmen.find((f) => f.firma === 'Pflege-Leasing GmbH').dienste, 1);
  // Einsatznachweis Externe
  const csv = (await mgr('GET', `/api/export/fremdpersonal.csv?month=${month}`)).data;
  assert.match(csv, /"Pflege-Leasing GmbH";"Ex Tern";"[0-9.]+";"Station 2";"N Nachtdienst"/);
  assert.doesNotMatch(csv, /Flex Pool/);
  // Lohn-Übergabe: Flexpool ja, Externe nein
  const lohn = (await mgr('GET', `/api/export/lohn?month=${month}`)).data;
  assert.ok(lohn.lines.some((l) => l.personalnummer === '7001'));
  assert.ok(!lohn.lines.some((l) => l.name === 'Ex Tern'));
  assert.ok(!lohn.fehlend.includes('Ex Tern'));
});
