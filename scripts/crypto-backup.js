'use strict';
/**
 * Verschlüsselung der Sicherungen: AES-256-GCM, Schlüssel per scrypt (N=2^15) aus dem Passwort.
 * Dateiformat: "PEPBAK1\n" | Salt (16) | IV (12) | Auth-Tag (16) | Chiffretext
 */
const crypto = require('crypto');

const MAGIC = Buffer.from('PEPBAK1\n');
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function key(passwort, salt) {
  if (!passwort || String(passwort).length < 12) throw new Error('BACKUP_PASSWORT muss mindestens 12 Zeichen haben.');
  return crypto.scryptSync(String(passwort), salt, 32, SCRYPT);
}

function encrypt(plain, passwort) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(passwort, salt), iv);
  c.setAAD(MAGIC);
  const enc = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), enc]);
}

function decrypt(buf, passwort) {
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Keine Sicherungsdatei der Personaleinsatzplanung.');
  let o = MAGIC.length;
  const salt = buf.subarray(o, o += 16);
  const iv = buf.subarray(o, o += 12);
  const tag = buf.subarray(o, o += 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key(passwort, salt), iv);
  d.setAAD(MAGIC);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(buf.subarray(o)), d.final()]);
  } catch {
    throw new Error('Entschlüsselung fehlgeschlagen – falsches Passwort oder Datei beschädigt.');
  }
}

module.exports = { encrypt, decrypt };
