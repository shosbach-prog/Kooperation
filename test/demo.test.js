'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

async function start(demo) {
  const server = createApp(openDb(':memory:'), { uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pep-demo-')), timers: false, demo }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, url, body) => {
      const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      return { status: res.status, data: await res.json().catch(() => null) };
    };
  };
  return { server, client };
}

test('Demo-Modus: Rollenauswahl ohne Passwort und Code', async () => {
  const { server, client } = await start(true);
  try {
    const c = client();
    assert.equal((await c('GET', '/api/branding')).data.demo, true);
    const p = (await c('GET', '/api/demo/personen')).data;
    assert.ok(p.leitung.some((x) => x.username === 'manager' && /Pflegedienstleitung/.test(x.beschreibung)));
    assert.ok(p.leitung.some((x) => x.username === 'skrueger' && /Stationsleitung – Station 1/.test(x.beschreibung)));
    assert.ok(p.pflege.some((x) => x.username === 'abecker'));
    assert.equal(JSON.stringify(p).includes('password'), false);
    // Pflegekraft wählen → sofort voll angemeldet
    let r = await c('POST', '/api/demo/login', { username: 'abecker' });
    assert.equal(r.data.stage, 'full');
    assert.equal((await c('GET', '/api/my-shifts')).status, 200);
    assert.equal((await c('GET', '/api/users')).status, 403);
    // Stationsleitung: Verwaltung, aber nur Station 1
    const sl = client();
    await sl('POST', '/api/demo/login', { username: 'skrueger' });
    const me = (await sl('GET', '/api/me')).data.user;
    assert.equal(me.is_manager, true);
    assert.equal(me.is_haupt, false);
    assert.equal(me.admin_units.length, 1);
    // Passwort-Anmeldung ohne 2FA-Schritt
    r = await client()('POST', '/api/login', { username: 'manager', password: 'manager123' });
    assert.equal(r.data.stage, 'full');
    // neue Person anlegen
    const g = client();
    r = await g('POST', '/api/demo/person', { name: 'Maria Muster', rolle: 'stationsleitung', unit_id: 2, qualification: 'Pflegefachkraft' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.match(r.data.user.username, /^gast-/);
    assert.equal(r.data.user.is_manager, true);
    assert.deepEqual(r.data.user.admin_units, [2]);
    r = await client()('POST', '/api/demo/person', { name: 'Paul PDL', rolle: 'pdl' });
    assert.equal(r.data.user.is_haupt, true);
    assert.equal((await client()('POST', '/api/demo/person', { name: 'x' })).status, 400);
    assert.equal((await client()('POST', '/api/demo/login', { username: 'gibtsnicht' })).status, 404);
  } finally { server.close(); }
});

test('Ohne Demo-Modus: keine Rollenauswahl, 2FA bleibt Pflicht', async () => {
  const { server, client } = await start(false);
  try {
    const c = client();
    assert.equal((await c('GET', '/api/branding')).data.demo, false);
    assert.equal((await c('GET', '/api/demo/personen')).status, 404);
    assert.equal((await c('POST', '/api/demo/login', { username: 'manager' })).status, 404);
    assert.equal((await c('POST', '/api/demo/person', { name: 'Hacker', rolle: 'pdl' })).status, 404);
    assert.equal((await c('POST', '/api/login', { username: 'manager', password: 'manager123' })).data.stage, 'setup');
  } finally { server.close(); }
});
