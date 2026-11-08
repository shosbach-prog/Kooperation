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
