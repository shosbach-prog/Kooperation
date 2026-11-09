'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const TOTP = require('../src/totp');

test('Spracherkennung auf dem Server: Aufnahme annehmen, prüfen, abschaltbar', async () => {
  let empfangen = null;
  const server = createApp(openDb(':memory:'), {
    uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pep-sp-')), timers: false,
    sprache: async (pcm) => { empfangen = pcm; return 'Belegung 18. Zwei Zugänge.'; },
  }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let ck = '';
  const c = async (m, u, b, raw) => {
    const r = await fetch(base + u, { method: m, headers: { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', Cookie: ck }, body: raw || (b ? JSON.stringify(b) : undefined) });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  try {
    assert.equal((await c('POST', '/api/sprache/erkennen', null, Buffer.alloc(32000))).status, 401);
    await c('POST', '/api/login', { username: 'manager', password: 'manager123' });
    const s = await c('POST', '/api/2fa/setup');
    await c('POST', '/api/2fa/enable', { code: TOTP.totp(new URL(s.data.uri.replace('otpauth://', 'http://')).searchParams.get('secret')) });
    assert.equal((await c('GET', '/api/sprache/status')).data.verfuegbar, true);
    // 1 Sekunde 16-kHz-PCM (Sinus) → Text
    const pcm = Buffer.alloc(32000);
    for (let i = 0; i < 16000; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), i * 2);
    const r = await c('POST', '/api/sprache/erkennen', null, pcm);
    assert.equal(r.status, 200);
    assert.equal(r.data.text, 'Belegung 18. Zwei Zugänge.');
    assert.equal(empfangen.length, 16000);
    assert.ok(Math.abs(empfangen[1] - Math.sin(0.1) * 8000 / 32768) < 1e-3);
    assert.equal((await c('POST', '/api/sprache/erkennen', null, Buffer.alloc(100))).data.code, 'ZU_KURZ');
    await c('PUT', '/api/settings', { sprache_server: false });
    assert.equal((await c('GET', '/api/sprache/status')).data.verfuegbar, false);
    assert.equal((await c('POST', '/api/sprache/erkennen', null, pcm)).data.code, 'AUS');
  } finally { server.close(); }
});
