'use strict';
/**
 * Zeitbasierte Einmalpasswörter (TOTP, RFC 6238) für die Zwei-Faktor-Anmeldung.
 * Kompatibel mit Microsoft Authenticator, Google Authenticator, FreeOTP u. a.
 */
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;
const DIGITS = 6;

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(code).padStart(DIGITS, '0');
}

const counterAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP);

function totp(secret, ms = Date.now()) {
  return hotp(secret, counterAt(ms));
}

/**
 * Prüft einen Code mit ±1 Zeitfenster Toleranz (Uhrabweichung).
 * Gibt den verwendeten Zähler zurück (für Schutz gegen Wiederverwendung) oder null.
 */
function verify(secret, code, lastCounter = -1, ms = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = counterAt(ms);
  for (const n of [now, now - 1, now + 1]) {
    if (n <= lastCounter) continue;
    const ref = Buffer.from(hotp(secret, n));
    if (crypto.timingSafeEqual(ref, Buffer.from(c))) return n;
  }
  return null;
}

function otpauthUri(secret, account, issuer) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
}

/** 10 Wiederherstellungscodes im Format xxxx-xxxx */
function recoveryCodes(n = 10) {
  return Array.from({ length: n }, () => {
    const s = crypto.randomBytes(5).toString('hex');
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

const hashRecovery = (code) => crypto.createHash('sha256').update(String(code).trim().toLowerCase()).digest('hex');

module.exports = { base32Encode, base32Decode, generateSecret, hotp, totp, verify, otpauthUri, recoveryCodes, hashRecovery, counterAt };
