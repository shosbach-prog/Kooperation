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
  const r2 = await mgr('POST', `/api/shifts/${n2.id}/rundruf`, { qualification: 'Pflegehilfskraft' });
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
