'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

test('Betrieb im Unterordner (BASE_PATH=/LWL)', async () => {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pep-base-'));
  const server = createApp(openDb(':memory:'), { uploadDir, basePath: '/LWL' }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/LWL/');
    r = await fetch(`${base}/LWL`, { redirect: 'manual' });
    assert.equal(r.headers.get('location'), '/LWL/');
    // andere Schreibweise wird auf die eingerichtete umgeleitet
    r = await fetch(`${base}/lwl`, { redirect: 'manual' });
    assert.equal(r.headers.get('location'), '/LWL/');
    r = await fetch(`${base}/lwl/app.js?v=1`, { redirect: 'manual' });
    assert.equal(r.headers.get('location'), '/LWL/app.js?v=1');
    r = await fetch(`${base}/LWL/`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<title>/);
    assert.equal((await fetch(`${base}/LWL/js/core.js`)).status, 200);
    assert.equal((await fetch(`${base}/LWL/api/me`)).status, 401);
    r = await fetch(`${base}/LWL/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'manager', password: 'manager123' }),
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie'), /Path=\/LWL\//);
    // außerhalb des Unterordners gibt es keine API
    assert.notEqual((await fetch(`${base}/api/me`, { redirect: 'manual' })).status, 401);
  } finally {
    server.close();
  }
});

test('Erscheinungsbild: Klinikname, Farbe, Logo, App-Manifest', async () => {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pep-brand-'));
  const server = createApp(openDb(':memory:'), { uploadDir }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const TOTP = require('../src/totp');
  try {
    // öffentlich, ohne Anmeldung
    let r = await (await fetch(`${base}/api/branding`)).json();
    assert.equal(r.klinik_name, 'LWL-Klinik Dortmund');
    assert.equal(r.logo, false);
    const m = await (await fetch(`${base}/manifest.webmanifest`)).json();
    assert.match(m.name, /LWL-Klinik Dortmund/);

    // Manager anmelden (inkl. 2FA-Einrichtung)
    let cookie = '';
    const call = async (method, url, body, headers = {}) => {
      const res = await fetch(base + url, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers }, body });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      return res;
    };
    const json = { 'Content-Type': 'application/json' };
    await call('POST', '/api/login', JSON.stringify({ username: 'manager', password: 'manager123' }), json);
    const setup = await (await call('POST', '/api/2fa/setup')).json();
    const secret = new URL(setup.uri.replace('otpauth://', 'http://')).searchParams.get('secret');
    await call('POST', '/api/2fa/enable', JSON.stringify({ code: TOTP.totp(secret) }), json);

    assert.equal((await call('PUT', '/api/settings', JSON.stringify({ akzentfarbe: 'rot' }), json)).status, 400);
    r = await (await call('PUT', '/api/settings', JSON.stringify({ akzentfarbe: '#00609c', untertitel: 'Dienstplan Pflege' }), json)).json();
    assert.equal(r.akzentfarbe, '#00609c');

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    assert.equal((await call('POST', '/api/branding/logo', Buffer.from('<svg/>'))).status, 400);
    assert.equal((await call('POST', '/api/branding/logo', png)).status, 200);
    r = await (await fetch(`${base}/api/branding`)).json();
    assert.equal(r.logo, true);
    assert.equal(r.untertitel, 'Dienstplan Pflege');
    const logo = await fetch(`${base}/api/branding/logo`);
    assert.equal(logo.headers.get('content-type'), 'image/png');
    // ohne Anmeldung kein Hochladen
    assert.equal((await fetch(`${base}/api/branding/logo`, { method: 'POST', body: png })).status, 401);
    assert.equal((await call('DELETE', '/api/branding/logo')).status, 200);
    assert.equal((await (await fetch(`${base}/api/branding`)).json()).logo, false);
  } finally {
    server.close();
  }
});
