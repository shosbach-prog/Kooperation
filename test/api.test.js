'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const TOTP = require('../src/totp');
const T = require('../src/tvoed');

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
  const uploadDir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'pep-uploads-'));
  server = createApp(db, { uploadDir }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

function client() {
  let cookie = '';
  const c = async (method, url, body) => {
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
  c.cookie = () => cookie;
  return c;
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
  // Dieser Ablauf prüft einzelne Stationen ohne Verbund (Verbünde: eigener Test)
  for (const v of (await mgr('GET', '/api/verbuende')).data) await mgr('DELETE', `/api/verbuende/${v.id}`);

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
  assert.equal(r.data.code, 'BEGRUENDUNG'); // Begründung ist Pflicht
  r = await anna('DELETE', `/api/shifts/${früh.id}/assign`, { reason: 'Arzttermin' });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'MINIMUM');

  // Wenn Minimum auf 0 gesetzt wird, darf sie sich austragen
  await mgr('PUT', `/api/shifts/${früh.id}`, { min_staff: 0, max_staff: 1 });
  // Mindestbesetzung nach Qualifikation: Anna ist die einzige Pflegefachkraft
  assert.equal(früh.qual_missing.length, 1);
  r = await anna('DELETE', `/api/shifts/${früh.id}/assign`, { reason: 'Arzttermin' });
  assert.equal(r.data.code, 'QUALIFIKATION');
  const rules = (await mgr('GET', '/api/qual-rules')).data;
  await mgr('DELETE', `/api/qual-rules/${rules[0].id}`);
  r = await anna('DELETE', `/api/shifts/${früh.id}/assign`, { reason: 'Arzttermin' });
  assert.equal(r.status, 200);
  // Begründung steht im Protokoll
  const log = (await mgr('GET', '/api/log')).data;
  assert.equal(log[0].action, 'assignment.remove');
  assert.equal(log[0].reason, 'Arzttermin');
  assert.equal(log[0].person, 'Anna Becker');

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
  assert.equal(r.data.rows.length, 8); // 6 Stammkräfte + Flexpool + extern
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
  // Seite neu geladen (z. B. nach Wechsel in die Authenticator-App): gleicher Schlüssel
  assert.equal((await kevin('POST', '/api/2fa/setup')).data.secret, s.data.secret);
  assert.match(s.data.uri, /^otpauth:\/\/totp\//);
  assert.match(s.data.qr, /^data:image\/png;base64,/);
  const secret = new URL(s.data.uri.replace('otpauth://', 'http://')).searchParams.get('secret');
  assert.equal((await kevin('POST', '/api/2fa/enable', { code: '000000' === TOTP.totp(secret) ? '111111' : '000000' })).status, 400);
  const usedCode = TOTP.totp(secret);
  r = await kevin('POST', '/api/2fa/enable', { code: usedCode });
  assert.equal(r.status, 200);
  assert.equal(r.data.recovery_codes.length, 10);
  const codes = r.data.recovery_codes;
  assert.equal((await kevin('GET', '/api/my-shifts')).status, 200);

  // Neue Anmeldung: zweiter Schritt nötig
  const k2 = client();
  r = await k2('POST', '/api/login', { username: 'kschulz', password: 'demo123' });
  assert.equal(r.data.stage, '2fa');
  assert.equal((await k2('GET', '/api/my-shifts')).data.code, 'STAGE_2FA');
  // Wiederverwendung desselben Codes wird abgelehnt (genau derselbe Code, auch wenn inzwischen ein neues 30-s-Fenster begonnen hat)
  r = await k2('POST', '/api/login/2fa', { code: usedCode });
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

test('Urlaub beantragen, genehmigen, Urlaubskonto und Anrechnung', async () => {
  const mgr = client();
  const tobias = client();
  await login(mgr, 'manager', 'manager123');
  await login(tobias, 'twagner', 'demo123');

  // Mo–Fr in 5 Wochen: 5 Arbeitstage (sofern kein Feiertag)
  const d = new Date(Date.now() + 35 * 86400000);
  const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
  const friday = new Date(Date.parse(monday) + 4 * 86400000).toISOString().slice(0, 10);
  await mgr('POST', '/api/shifts/generate', { from: monday, to: friday });
  const plan = (await tobias('GET', `/api/plan?from=${monday}&to=${friday}`)).data.shifts;
  const tueSpät = plan.find((s) => s.type_code === 'S' && s.date > monday);
  assert.equal((await tobias('POST', `/api/shifts/${tueSpät.id}/assign`)).status, 200);

  let r = await tobias('POST', '/api/absences', { type: 'urlaub', from: monday, to: friday, note: 'Familienurlaub' });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'beantragt');
  assert.equal(r.data.konflikte, 1);
  const id = r.data.id;
  // überschneidender Antrag nicht möglich
  assert.equal((await tobias('POST', '/api/absences', { type: 'urlaub', from: friday, to: friday })).status, 409);
  // während beantragtem Urlaub kein Eintragen
  const wedFrüh = plan.find((s) => s.type_code === 'F' && s.date === new Date(Date.parse(monday) + 2 * 86400000).toISOString().slice(0, 10));
  assert.equal((await tobias('POST', `/api/shifts/${wedFrüh.id}/assign`)).data.code, 'ABWESEND');

  r = await tobias('GET', '/api/absences');
  const tage = T.arbeitstage(monday, friday);
  assert.equal(r.data.urlaub.beantragt, tage);
  assert.equal(r.data.urlaub.rest, 30 - tage);

  // Mitarbeitende dürfen nicht selbst genehmigen
  assert.equal((await tobias('PUT', `/api/absences/${id}/decision`, { status: 'genehmigt' })).status, 403);
  // Ablehnung braucht Begründung
  assert.equal((await mgr('PUT', `/api/absences/${id}/decision`, { status: 'abgelehnt' })).data.code, 'BEGRUENDUNG');
  r = await mgr('PUT', `/api/absences/${id}/decision`, { status: 'genehmigt' });
  assert.equal(r.data.status, 'genehmigt');
  assert.equal(r.data.removed, 1); // Spätdienst wurde automatisch ausgetragen
  assert.equal((await tobias('GET', '/api/my-shifts')).data.length, 0);
  // genehmigter Urlaub kann nicht mehr selbst zurückgezogen werden
  assert.equal((await tobias('DELETE', `/api/absences/${id}`)).status, 403);

  r = await tobias('GET', `/api/report?month=${monday.slice(0, 7)}`);
  const row = r.data.rows[0];
  const tageImMonat = T.arbeitstage(monday, friday.slice(0, 7) === monday.slice(0, 7) ? friday : `${monday.slice(0, 7)}-31`);
  assert.equal(row.urlaub_tage, tageImMonat);
  assert.ok(Math.abs(row.urlaub_std - tageImMonat * 7.7) < 0.01);
});

test('Krankmeldung mit AU-Bescheinigung ab Tag x', async () => {
  const mgr = client();
  const lena = client();
  const other = client();
  await login(mgr, 'manager', 'manager123');
  await login(lena, 'lhoffmann', 'demo123');
  await login(other, 'myilmaz', 'demo123');
  const today = new Date().toISOString().slice(0, 10);
  const plus = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  // 2 Tage krank: keine AU nötig (Standard ab Tag 4)
  let r = await lena('POST', '/api/absences', { type: 'krank', from: today, to: plus(1) });
  assert.equal(r.data.status, 'gemeldet');
  assert.equal(r.data.au_erforderlich, false);
  const id = r.data.id;

  // Verlängerung auf 5 Tage → AU erforderlich und fehlt
  r = await lena('PUT', `/api/absences/${id}`, { to: plus(4) });
  assert.equal(r.data.au_erforderlich, true);
  assert.equal(r.data.au_fehlt, true);
  assert.equal(r.data.au_faellig_ab, plus(3));

  // Ungültige Datei wird abgelehnt
  const upload = (c, body, name) => fetch(`${base}/api/absences/${id}/attachments`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(name), Cookie: c.cookie() }, body,
  });
  let res = await upload(lena, Buffer.from('<script>alert(1)</script>'), 'x.html');
  assert.equal(res.status, 400);
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
  res = await upload(lena, pdf, 'AU Bescheinigung.pdf');
  assert.equal(res.status, 200);
  const att = (await res.json());
  assert.equal(att.au_fehlt, false);
  assert.equal(att.attachments[0].filename, 'AU Bescheinigung.pdf');

  // Kolleg/innen dürfen die Bescheinigung nicht sehen, Manager schon
  const fileId = att.attachments[0].id;
  assert.equal((await other('GET', `/api/attachments/${fileId}`)).status, 404);
  assert.equal((await other('GET', '/api/absences')).data.absences.length, 0);
  r = await mgr('GET', `/api/attachments/${fileId}`);
  assert.equal(r.status, 200);
  assert.match(r.data, /^%PDF/);

  // Einstellbar: AU schon ab Tag 1
  await mgr('PUT', '/api/settings', { au_ab_tag: 1 });
  r = await lena('POST', '/api/absences', { type: 'krank', from: plus(20), to: plus(20) });
  assert.equal(r.data.au_erforderlich, true);
  await mgr('PUT', '/api/settings', { au_ab_tag: 4 });

  // Krankmeldung kann von Mitarbeitenden nicht gelöscht werden
  assert.equal((await lena('DELETE', `/api/absences/${id}`)).status, 403);
});

test('Einstellungen: Qualifikationsliste und Begründungspflicht', async () => {
  const mgr = client();
  await login(mgr, 'manager', 'manager123');
  const r = await mgr('PUT', '/api/settings', { qualifikationen: ['Pflegefachkraft', ' MFA ', '', 'MFA'], begruendung_eintragen: true });
  assert.deepEqual(r.data.qualifikationen, ['Pflegefachkraft', 'MFA']);
  assert.equal(r.data.begruendung_eintragen, true);
  assert.equal((await mgr('PUT', '/api/settings', { qualifikationen: 'x' })).status, 400);
  await mgr('PUT', '/api/settings', { begruendung_eintragen: false });
});

test('Zusatzurlaub bei Schwerbehinderung (§ 208 SGB IX) und Sonderurlaub', async () => {
  const mgr = client();
  const julia = client();
  await login(mgr, 'manager', 'manager123');
  await login(julia, 'jschmitz', 'demo123');
  const year = new Date().getUTCFullYear() + 1; // nächstes Jahr: keine Überschneidung mit anderen Tests
  const mon = (() => { for (let d = 10; ; d++) { const x = `${year}-03-${String(d).padStart(2, '0')}`; if (new Date(x).getUTCDay() === 1) return x; } })();
  const fri = new Date(Date.parse(mon) + 4 * 86400000).toISOString().slice(0, 10);

  // ohne hinterlegte Schwerbehinderung kein Zusatzurlaub
  let r = await julia('POST', '/api/absences', { type: 'zusatzurlaub', from: mon, to: mon });
  assert.equal(r.status, 400);

  const juliaId = (await mgr('GET', '/api/users')).data.find((u) => u.username === 'jschmitz').id;
  r = await mgr('PUT', `/api/users/${juliaId}`, { schwerbehindert: true });
  assert.equal(r.data.schwerbehindert, true);
  assert.equal(r.data.zusatzurlaub_tage, 5); // Standard nach § 208 SGB IX

  r = await julia('GET', `/api/absences?year=${year}`);
  assert.equal(r.data.zusatzurlaub.anspruch, 5);
  assert.equal(r.data.urlaub.anspruch, 30);

  // 5 Tage Zusatzurlaub gehen, ein 6. Tag nicht (Kontingent)
  r = await julia('POST', '/api/absences', { type: 'zusatzurlaub', from: mon, to: fri });
  assert.equal(r.status, 200);
  assert.equal(r.data.arbeitstage, 5);
  const nextMon = new Date(Date.parse(mon) + 7 * 86400000).toISOString().slice(0, 10);
  r = await julia('POST', '/api/absences', { type: 'zusatzurlaub', from: nextMon, to: nextMon });
  assert.equal(r.data.code, 'KONTINGENT');
  // Erholungsurlaub ist davon unabhängig
  r = await julia('GET', `/api/absences?year=${year}`);
  assert.equal(r.data.zusatzurlaub.rest, 0);
  // Resturlaub des laufenden Jahres (30 Tage, nichts genommen) wird ins Folgejahr übertragen
  assert.equal(r.data.urlaub.uebertrag, 30);
  assert.equal(r.data.urlaub.uebertrag_quelle, 'automatisch');
  assert.equal(r.data.urlaub.rest, 60);

  // Sonderurlaub braucht einen Anlass
  r = await julia('POST', '/api/absences', { type: 'sonderurlaub', from: nextMon, to: nextMon });
  assert.equal(r.data.code, 'BEGRUENDUNG');
  r = await julia('POST', '/api/absences', { type: 'sonderurlaub', from: nextMon, to: nextMon, note: 'Umzug' });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'beantragt');
  const sonderId = r.data.id;

  // Manager genehmigt, Zeitkonto rechnet Sonderurlaub separat an
  r = await mgr('PUT', `/api/absences/${sonderId}/decision`, { status: 'genehmigt' });
  assert.equal(r.data.status, 'genehmigt');
  r = await julia('GET', `/api/report?month=${nextMon.slice(0, 7)}`);
  assert.equal(r.data.rows[0].sonder_tage, 1);
  assert.ok(Math.abs(r.data.rows[0].sonder_std - 30 / 5) < 0.01); // Julia: 30 Wochenstunden

  // Schwerbehinderung zurücknehmen setzt Zusatzurlaub auf 0
  r = await mgr('PUT', `/api/users/${juliaId}`, { schwerbehindert: false });
  assert.equal(r.data.zusatzurlaub_tage, 0);
});

test('Stationsverbund: gemeinsame Mindestbesetzung und gleitendes Umsetzen', async () => {
  const mgr = client();
  await login(mgr, 'manager', 'manager123');
  const units = (await mgr('GET', '/api/units')).data;
  const s1 = units.find((u) => u.name === 'Station 1'), s2 = units.find((u) => u.name === 'Station 2');
  let r = await mgr('POST', '/api/verbuende', { name: 'Verbund Akut', unit_ids: [s1.id, s2.id] });
  assert.equal(r.status, 200);
  assert.equal(r.data.stationen, 2);
  const vid = r.data.id;

  // Nachtdienst in 20 Tagen: je Station min 1, max 2; Qualifikationsregel entfernen, damit nur die Kopfzahl zählt
  for (const q of (await mgr('GET', '/api/qual-rules')).data) await mgr('DELETE', `/api/qual-rules/${q.id}`);
  const d = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  await mgr('POST', '/api/shifts/generate', { from: d, to: d });
  const plan = (await mgr('GET', `/api/plan?from=${d}&to=${d}`)).data.shifts;
  const n1 = plan.find((x) => x.type_code === 'N' && x.unit_id === s1.id);
  const n2 = plan.find((x) => x.type_code === 'N' && x.unit_id === s2.id);
  assert.ok(n1.verbund && n1.verbund.gemeinsam);
  const users = (await mgr('GET', '/api/users')).data;
  const id = (u) => users.find((x) => x.username === u).id;

  // Station 2 hat 2 Personen, Station 1 keine → Station 1 im Verbund ausgeglichen
  await mgr('POST', `/api/shifts/${n2.id}/assign`, { user_id: id('twagner') });
  await mgr('POST', `/api/shifts/${n2.id}/assign`, { user_id: id('jschmitz') });
  r = await mgr('GET', `/api/plan?from=${d}&to=${d}`);
  let a = r.data.shifts.find((x) => x.id === n1.id);
  assert.equal(a.assigned.length, 0);
  assert.equal(a.verbund.besetzt, 2);
  assert.equal(a.verbund.min, 2);
  assert.equal(a.ausgeglichen, true);
  assert.equal(a.unterbesetzt, false);
  // Auswertung zählt ausgeglichene Schichten nicht als unterbesetzt
  r = await mgr('GET', `/api/report?month=${d.slice(0, 7)}`);
  assert.ok(!r.data.understaffed.some((x) => x.id === n1.id));

  // Gleitendes Umsetzen: Verwaltung setzt eine Person von Station 2 auf Station 1 um
  r = await mgr('POST', `/api/shifts/${n2.id}/move`, { user_id: id('jschmitz'), to_shift_id: n1.id, reason: 'Aufnahme auf Station 1' });
  assert.equal(r.status, 200);
  a = r.data.find((x) => x.id === n1.id);
  assert.equal(a.assigned.length, 1);
  assert.equal(a.ausgeglichen, false); // jetzt selbst gedeckt
  // nur innerhalb des Verbunds und derselben Dienstart
  const f1 = plan.find((x) => x.type_code === 'F' && x.unit_id === s1.id);
  assert.equal((await mgr('POST', `/api/shifts/${n1.id}/move`, { user_id: id('jschmitz'), to_shift_id: f1.id })).data.code, 'KEIN_VERBUND');
  // Protokoll
  const log = (await mgr('GET', '/api/log')).data;
  assert.equal(log[0].action, 'assignment.move');
  assert.match(log[0].reason, /Aufnahme/);

  // Mitarbeiterin wechselt selbst die Station im Verbund
  const tobias = client();
  await login(tobias, 'twagner', 'demo123');
  r = await tobias('POST', `/api/shifts/${n2.id}/move`, { to_shift_id: n1.id });
  assert.equal(r.status, 200);
  // Austragen: gemeinsame Mindestbesetzung (2) bleibt nur mit beiden erfüllt
  r = await tobias('DELETE', `/api/shifts/${n1.id}/assign`, { reason: 'Arzttermin' });
  assert.equal(r.data.code, 'MINIMUM');
  assert.match(r.data.error, /Verbund Akut/);

  // Verbund ohne gemeinsame Mindestbesetzung: jede Station zählt einzeln
  await mgr('PUT', `/api/verbuende/${vid}`, { gemeinsam: false });
  await mgr('POST', `/api/shifts/${n1.id}/move`, { user_id: id('twagner'), to_shift_id: n2.id }); // zurück auf Station 2
  r = await mgr('GET', `/api/plan?from=${d}&to=${d}`);
  a = r.data.shifts.find((x) => x.id === n1.id);
  assert.equal(a.verbund.gemeinsam, false);
  assert.equal(a.unterbesetzt, false); // Julia ist auf Station 1
  // Station 2 hat jetzt nur Tobias (min 1) → Wechsel von Tobias würde Station 2 leeren → gesperrt
  r = await tobias('POST', `/api/shifts/${n2.id}/move`, { to_shift_id: n1.id });
  assert.equal(r.data.code, 'MINIMUM');

  // Verbund auflösen
  await mgr('DELETE', `/api/verbuende/${vid}`);
  assert.equal((await mgr('GET', '/api/units')).data.find((u) => u.id === s1.id).verbund_id, null);
});
