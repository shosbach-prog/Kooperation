'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const TOTP = require('../src/totp');

let server, base, haupt;
test.before(async () => {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pep-personal-'));
  server = createApp(openDb(':memory:'), { uploadDir }).listen(0);
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
  // Rohdaten (z. B. Bilder) mit derselben Sitzung senden
  c.raw = (method, url, body) => fetch(base + url, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/octet-stream' } : {}) }, body,
  });
  return c;
}
async function login(c, username, password) {
  const r = await c('POST', '/api/login', { username, password });
  if (r.data.stage !== 'setup') return r;
  const s = await c('POST', '/api/2fa/setup');
  const secret = new URL(s.data.uri.replace('otpauth://', 'http://')).searchParams.get('secret');
  return c('POST', '/api/2fa/enable', { code: TOTP.totp(secret) });
}
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

test('Personalakte, Verwaltungsrechte und Vertretung', async () => {
  haupt = client();
  await login(haupt, 'manager', 'manager123');
  let users = (await haupt('GET', '/api/users')).data;
  const anna = users.find((u) => u.username === 'abecker');
  const murat = users.find((u) => u.username === 'myilmaz');

  // Stammdaten der Personalakte
  let r = await haupt('PUT', `/api/users/${anna.id}`, {
    personalnummer: '100234', email: 'anna.becker@example.org', telefon: '0231 123456', eintritt: '2019-04-01',
    befristet_bis: '', entgeltgruppe: 'P8', stufe: 4, stammbereich_id: 1, bemerkung: 'Praxisanleiterin',
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.personalnummer, '100234');
  assert.equal(r.data.stufe, 4);
  assert.equal((await haupt('PUT', `/api/users/${anna.id}`, { email: 'kein-mail' })).status, 400);
  assert.equal((await haupt('PUT', `/api/users/${anna.id}`, { stufe: 9 })).status, 400);
  assert.equal((await haupt('PUT', `/api/users/${anna.id}`, { eintritt: '01.04.2019' })).status, 400);

  // Mitarbeitende haben keinen Zugriff auf die Personalverwaltung
  const annaC = client();
  await login(annaC, 'abecker', 'demo123');
  assert.equal((await annaC('GET', '/api/users')).status, 403);

  // Vertretung ohne Enddatum nicht möglich
  assert.equal((await haupt('PUT', `/api/users/${anna.id}`, { admin_rechte: 'vertretung' })).status, 400);
  // Anna wird Vertretung bis morgen
  r = await haupt('PUT', `/api/users/${anna.id}`, { admin_rechte: 'vertretung', admin_bis: day(1) });
  assert.equal(r.data.is_manager, true);
  assert.equal(r.data.role, 'staff'); // bleibt im Dienstplan

  // Anna hat jetzt Verwaltungszugriff …
  assert.equal((await annaC('GET', '/api/users')).status, 200);
  r = await annaC('GET', '/api/me');
  assert.equal(r.data.user.is_manager, true);
  assert.equal(r.data.user.is_haupt, false);
  // … darf normale Mitarbeitende bearbeiten …
  assert.equal((await annaC('PUT', `/api/users/${murat.id}`, { telefon: '0172 000' })).status, 200);
  // … aber keine Rechte vergeben, sich nicht selbst hochstufen, die Hauptverwaltung nicht bearbeiten
  assert.equal((await annaC('PUT', `/api/users/${murat.id}`, { admin_rechte: 'voll' })).status, 403);
  assert.equal((await annaC('PUT', `/api/users/${anna.id}`, { admin_rechte: 'voll' })).status, 403);
  const hauptId = users.find((u) => u.username === 'manager').id;
  assert.equal((await annaC('PUT', `/api/users/${hauptId}`, { telefon: '1' })).status, 403);
  assert.equal((await annaC('PUT', `/api/users/${hauptId}`, { reset_2fa: true })).status, 403);
  assert.equal((await annaC('POST', '/api/users', { name: 'X', username: 'xx1', password: 'geheim1', role: 'manager' })).status, 403);

  // Eigener Urlaubsantrag der Vertretung wird beantragt, nicht automatisch genehmigt
  r = await annaC('POST', '/api/absences', { type: 'urlaub', from: day(40), to: day(40) });
  if (r.status === 400 && /Arbeitstage/.test(r.data.error)) {
    r = await annaC('POST', '/api/absences', { type: 'urlaub', from: day(42), to: day(42) });
  }
  assert.equal(r.data.status, 'beantragt');
  assert.equal((await annaC('PUT', `/api/absences/${r.data.id}/decision`, { status: 'genehmigt' })).status, 403);
  assert.equal((await haupt('PUT', `/api/absences/${r.data.id}/decision`, { status: 'genehmigt' })).status, 200);
  // eigene Ansicht trotz Verwaltungsrechten
  r = await annaC('GET', '/api/absences?mine=1');
  assert.ok(r.data.urlaub);
  assert.ok(r.data.absences.every((a) => a.user_id === anna.id));
  // Vertretung erscheint weiter in der Auswertung des Personals
  r = await haupt('GET', `/api/report?month=${day(0).slice(0, 7)}`);
  assert.ok(r.data.rows.some((x) => x.user_id === anna.id));

  // Abgelaufene Vertretung → keine Verwaltungsrechte mehr
  await haupt('PUT', `/api/users/${anna.id}`, { admin_bis: day(-1) });
  assert.equal((await annaC('GET', '/api/users')).status, 403);
  r = await haupt('GET', '/api/users');
  assert.equal(r.data.find((u) => u.id === anna.id).is_manager, false);

  // Dauerhafte Rechte
  await haupt('PUT', `/api/users/${anna.id}`, { admin_rechte: 'voll' });
  assert.equal((await annaC('GET', '/api/users')).status, 200);

  // Letzte Hauptverwaltung kann nicht entfernt werden; sich selbst herabstufen geht nicht
  assert.equal((await haupt('PUT', `/api/users/${hauptId}`, { role: 'staff' })).status, 400);
  // Zweite Hauptverwaltung
  r = await haupt('PUT', `/api/users/${murat.id}`, { role: 'manager' });
  assert.equal(r.data.is_haupt, true);

  // Rechteänderungen im Protokoll (Audit)
  // Personalliste als CSV
  r = await haupt('GET', '/api/users.csv');
  assert.match(r.data, /Personalnr\./);
  assert.match(r.data, /100234/);
  assert.match(r.data, /Verwalter\/in/);
});

test('Nach dem Austrittsdatum ist keine Anmeldung möglich', async () => {
  const users = (await haupt('GET', '/api/users')).data;
  const lena = users.find((u) => u.username === 'lhoffmann');
  const lenaC = client();
  await login(lenaC, 'lhoffmann', 'demo123');
  assert.equal((await lenaC('GET', '/api/my-shifts')).status, 200);
  await haupt('PUT', `/api/users/${lena.id}`, { austritt: day(-1) });
  assert.equal((await lenaC('GET', '/api/my-shifts')).status, 401); // laufende Sitzung endet
  assert.equal((await client()('POST', '/api/login', { username: 'lhoffmann', password: 'demo123' })).status, 401);
  await haupt('PUT', `/api/users/${lena.id}`, { austritt: day(30) });
  assert.equal((await client()('POST', '/api/login', { username: 'lhoffmann', password: 'demo123' })).status, 200);
});

test('Stationen anlegen, umbenennen, Mindestbesetzung übernehmen', async () => {
  let r = await haupt('POST', '/api/units', { name: 'Station 3 – Gerontopsychiatrie', kuerzel: 'G3', telefon: '0231 4503-0', copy_from: 1 });
  assert.equal(r.status, 200);
  assert.ok(r.data.kopiert > 0); // Mindestbesetzung von Station 1 übernommen
  const id = r.data.id;
  assert.equal((await haupt('POST', '/api/units', { name: 'station 3 – gerontopsychiatrie' })).status, 409); // doppelt
  assert.equal((await haupt('POST', '/api/units', { name: '  ' })).status, 400);
  r = await haupt('PUT', `/api/units/${id}`, { name: 'Station G3', leitung_id: 2 });
  assert.equal(r.data.name, 'Station G3');
  assert.equal(r.data.kuerzel, 'G3'); // unverändert
  assert.ok(r.data.leitung_name);
  const reqs = (await haupt('GET', '/api/requirements')).data.filter((x) => x.unit_id === id);
  assert.ok(reqs.length > 0);
  // Mitarbeitende dürfen Stationen sehen, aber nicht ändern
  const c = client();
  await login(c, 'kschulz', 'demo123');
  assert.equal((await c('GET', '/api/units')).status, 200);
  assert.equal((await c('POST', '/api/units', { name: 'X' })).status, 403);
  // löschen geht ohne Schichten; mit Schichten nur deaktivieren
  assert.equal((await haupt('DELETE', `/api/units/${id}`)).status, 200);
  await haupt('POST', '/api/shifts/generate', { from: day(5), to: day(5), unit_ids: [1] });
  assert.equal((await haupt('DELETE', '/api/units/1')).data.code, 'HAS_SHIFTS');
});

test('Profilfoto hochladen, anzeigen, entfernen', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const c = client();
  await login(c, 'jschmitz', 'demo123');
  const users = (await haupt('GET', '/api/users')).data;
  const tobias = users.find((u) => u.username === 'twagner');
  let res = await haupt.raw('POST', `/api/users/${tobias.id}/foto`, Buffer.from('<html>'));
  assert.equal(res.status, 400);
  res = await haupt.raw('POST', `/api/users/${tobias.id}/foto`, png);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.foto_version > 0);
  // Kollegin sieht das Foto (angemeldet), ohne Anmeldung nicht
  res = await c.raw('GET', `/api/users/${tobias.id}/foto`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${base}/api/users/${tobias.id}/foto`)).status, 401);
  // eigenes Foto über „Mein Profil“
  res = await c.raw('POST', '/api/me/foto', png);
  assert.equal(res.status, 200);
  // Mitarbeitende können fremde Fotos nicht ändern
  res = await c.raw('POST', `/api/users/${tobias.id}/foto`, png);
  assert.equal(res.status, 403);
  // entfernen
  assert.equal((await haupt('DELETE', `/api/users/${tobias.id}/foto`)).data.foto_version, 0);
  assert.equal((await c.raw('GET', `/api/users/${tobias.id}/foto`)).status, 404);
});

test('Campus: Gebäude anlegen, Stationen zuordnen, löschen', async () => {
  let r = await haupt('GET', '/api/buildings');
  assert.ok(r.data.some((b) => b.name === 'Haus A')); // Demo-Daten
  r = await haupt('POST', '/api/buildings', { name: 'Haus C – Tagesklinik', kuerzel: 'C', beschreibung: 'Eingang Süd' });
  assert.equal(r.status, 200);
  const haus = r.data;
  assert.equal((await haupt('POST', '/api/buildings', { name: 'haus c – tagesklinik' })).status, 409);
  r = await haupt('POST', '/api/units', { name: 'Tagesklinik 1', building_id: haus.id });
  assert.equal(r.data.building_name, 'Haus C – Tagesklinik');
  const unitId = r.data.id;
  r = (await haupt('GET', '/api/buildings')).data.find((b) => b.id === haus.id);
  assert.equal(r.stationen, 1);
  assert.equal((await haupt('PUT', `/api/units/${unitId}`, { building_id: 99999 })).status, 400);
  // Mitarbeitende sehen den Campus, dürfen ihn aber nicht ändern
  const c = client();
  await login(c, 'twagner', 'demo123'); // normale Mitarbeiterin ohne Verwaltungsrechte
  assert.equal((await c('GET', '/api/buildings')).status, 200);
  assert.equal((await c('POST', '/api/buildings', { name: 'X' })).status, 403);
  // Gebäude löschen: Station bleibt, ohne Gebäude
  r = await haupt('DELETE', `/api/buildings/${haus.id}`);
  assert.equal(r.data.stationen, 1);
  const unit = (await haupt('GET', '/api/units')).data.find((u) => u.id === unitId);
  assert.equal(unit.building_id, null);
});
