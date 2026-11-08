'use strict';
/**
 * Passkeys (WebAuthn): Anmeldung mit Fingerabdruck, Gesichtserkennung oder Geräte-PIN.
 * Ein Passkey mit Benutzerverifikation ersetzt Passwort + Authenticator-Code (Besitz + Biometrie/PIN).
 * Einrichtung nur aus einer voll angemeldeten Sitzung heraus (also nach Passwort + 2FA).
 */
const crypto = require('crypto');
const {
  generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

module.exports = (app, ctx) => {
  const { db, HttpError, auth, wrap, audit, getSettings, publicUser, todayIso } = ctx;

  // Herausforderungen nur kurz im Speicher halten (5 Min.)
  const challenges = new Map();
  const remember = (key, challenge) => {
    const now = Date.now();
    for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k);
    if (challenges.size > 5000) challenges.clear();
    challenges.set(key, { challenge, exp: now + 5 * 60e3 });
  };
  const take = (key) => {
    const c = challenges.get(key);
    challenges.delete(key);
    if (!c || c.exp < Date.now()) throw new HttpError(400, 'Die Anfrage ist abgelaufen. Bitte erneut versuchen.', 'ABGELAUFEN');
    return c.challenge;
  };

  /** Relying Party aus der Anfrage (hinter Caddy: Host und X-Forwarded-Proto) oder APP_URL */
  const rp = (req) => {
    if (process.env.APP_URL) {
      const u = new URL(process.env.APP_URL);
      return { rpID: u.hostname, origin: u.origin };
    }
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const proto = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
    const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return { rpID: hostname, origin: `${proto}://${host}` };
  };

  app.get('/api/passkeys', auth, wrap((req) => db.prepare('SELECT id, name, created_at, last_used FROM passkeys WHERE user_id = ? ORDER BY id').all(req.user.id)));

  app.post('/api/passkeys/register/options', auth, wrap(async (req) => {
    const { rpID } = rp(req);
    const existing = db.prepare('SELECT credential_id, transports FROM passkeys WHERE user_id = ?').all(req.user.id);
    if (existing.length >= 10) throw new HttpError(400, 'Höchstens 10 Passkeys je Person.');
    const options = await generateRegistrationOptions({
      rpName: getSettings().klinik_name || 'Personaleinsatzplanung',
      rpID,
      userName: req.user.username,
      userDisplayName: req.user.name,
      userID: new TextEncoder().encode(`pep-${req.user.id}`),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: JSON.parse(c.transports) })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    remember(`reg:${req.user.id}`, options.challenge);
    return options;
  }));

  app.post('/api/passkeys/register/verify', auth, wrap(async (req) => {
    const { rpID, origin } = rp(req);
    const expectedChallenge = take(`reg:${req.user.id}`);
    let v;
    try {
      v = await verifyRegistrationResponse({ response: req.body?.response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
    } catch (e) {
      throw new HttpError(400, `Passkey konnte nicht geprüft werden: ${e.message}`);
    }
    if (!v.verified || !v.registrationInfo) throw new HttpError(400, 'Passkey konnte nicht bestätigt werden.');
    const { credential } = v.registrationInfo;
    const name = String(req.body?.name || '').trim().slice(0, 60) || 'Passkey';
    try {
      db.prepare('INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, name) VALUES (?, ?, ?, ?, ?, ?)')
        .run(req.user.id, credential.id, Buffer.from(credential.publicKey), credential.counter || 0, JSON.stringify(credential.transports || req.body?.response?.response?.transports || []), name);
    } catch {
      throw new HttpError(409, 'Dieser Passkey ist bereits eingerichtet.');
    }
    audit(req.user.id, 'passkey.angelegt', { name });
    ctx.hooks.notify?.([req.user.id], { titel: 'Neuer Passkey eingerichtet', text: `„${name}“ kann jetzt zur Anmeldung verwendet werden. Waren Sie das nicht? Bitte sofort die Einsatzplanung informieren.`, link: 'account', art: 'sicherheit' });
    return { ok: true };
  }));

  app.patch('/api/passkeys/:id', auth, wrap((req) => {
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!name) throw new HttpError(400, 'Name fehlt.');
    const r = db.prepare('UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?').run(name, Number(req.params.id), req.user.id);
    if (!r.changes) throw new HttpError(404, 'Nicht gefunden.');
    return { ok: true };
  }));

  app.delete('/api/passkeys/:id', auth, wrap((req) => {
    const r = db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
    if (!r.changes) throw new HttpError(404, 'Nicht gefunden.');
    audit(req.user.id, 'passkey.entfernt', { id: Number(req.params.id) });
    return { ok: true };
  }));

  // ---------- Anmeldung ----------
  app.post('/api/passkeys/login/options', wrap(async (req) => {
    const { rpID } = rp(req);
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: [] });
    const id = crypto.randomBytes(16).toString('hex');
    remember(`login:${id}`, options.challenge);
    return { id, options };
  }));

  app.post('/api/passkeys/login/verify', wrap(async (req, res) => {
    const { rpID, origin } = rp(req);
    const expectedChallenge = take(`login:${String(req.body?.id || '')}`);
    const response = req.body?.response;
    const pk = response?.id ? db.prepare('SELECT * FROM passkeys WHERE credential_id = ?').get(String(response.id)) : null;
    if (!pk) throw new HttpError(401, 'Dieser Passkey ist nicht (mehr) eingerichtet. Bitte mit Passwort anmelden.', 'UNBEKANNT');
    const u = db.prepare("SELECT * FROM users WHERE id = ? AND active = 1 AND (austritt = '' OR austritt >= ?)").get(pk.user_id, todayIso());
    if (!u) throw new HttpError(401, 'Zugang nicht aktiv.');
    ctx.checkLock(u);
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: pk.credential_id, publicKey: new Uint8Array(pk.public_key), counter: pk.counter, transports: JSON.parse(pk.transports) },
      });
    } catch {
      ctx.registerFail(u);
      throw new HttpError(401, 'Anmeldung mit Passkey fehlgeschlagen.');
    }
    if (!v.verified) { ctx.registerFail(u); throw new HttpError(401, 'Anmeldung mit Passkey fehlgeschlagen.'); }
    db.prepare("UPDATE passkeys SET counter = ?, last_used = datetime('now') WHERE id = ?").run(v.authenticationInfo.newCounter, pk.id);
    ctx.resetFails(u.id);
    if (req.token) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
    ctx.startSession(res, u.id, 'full');
    audit(u.id, 'login.passkey', { passkey: pk.name });
    return { stage: 'full', user: publicUser(u) };
  }));
};
