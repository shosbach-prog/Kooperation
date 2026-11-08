'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const TOTP = require('../src/totp');

test('TOTP nach RFC 6238 (SHA1-Testvektoren, 6 Stellen)', () => {
  const secret = TOTP.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(TOTP.totp(secret, 59 * 1000), '287082');
  assert.equal(TOTP.totp(secret, 1111111109 * 1000), '081804');
  assert.equal(TOTP.totp(secret, 1234567890 * 1000), '005924');
  assert.equal(TOTP.totp(secret, 2000000000 * 1000), '279037');
});

test('Base32 hin und zurück', () => {
  const buf = Buffer.from('Dienstplan-LWL');
  assert.deepEqual(TOTP.base32Decode(TOTP.base32Encode(buf)), buf);
});

test('Prüfung mit Zeittoleranz und Schutz gegen Wiederverwendung', () => {
  const s = TOTP.generateSecret();
  const now = Date.now();
  const prev = TOTP.totp(s, now - 30000);
  const n = TOTP.verify(s, prev, -1, now);
  assert.equal(n, TOTP.counterAt(now) - 1);
  assert.equal(TOTP.verify(s, prev, n, now), null); // schon benutzt
  assert.equal(TOTP.verify(s, TOTP.totp(s, now - 120000), -1, now), null); // zu alt
  assert.equal(TOTP.verify(s, 'abc'), null);
});
