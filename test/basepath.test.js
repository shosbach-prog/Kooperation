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
    r = await fetch(`${base}/LWL/`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<title>/);
    assert.equal((await fetch(`${base}/LWL/app.js`)).status, 200);
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
