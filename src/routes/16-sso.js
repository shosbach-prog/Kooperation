'use strict';
/**
 * Single Sign-on über das Klinik-Konto (OpenID Connect, z. B. Microsoft Entra ID, Keycloak, ADFS).
 * Ablauf: Authorization Code mit PKCE, state und nonce; das ID-Token wird mit den Schlüsseln des Anbieters (JWKS) geprüft
 * (Signatur, Aussteller, Empfänger, Ablauf, nonce). Zuordnung zur Person über die hinterlegte E-Mail-Adresse
 * (Personalakte) oder den Benutzernamen. Es werden keine Konten automatisch angelegt.
 *
 * Konfiguration (.env):
 *   OIDC_ISSUER        z. B. https://login.microsoftonline.com/<Mandanten-ID>/v2.0
 *   OIDC_CLIENT_ID     Anwendungs-ID der App-Registrierung
 *   OIDC_CLIENT_SECRET geheimer Clientschlüssel
 *   OIDC_NAME          Beschriftung des Knopfs (Standard „Klinik-Konto“)
 *   OIDC_ZUORDNUNG     email (Standard) oder benutzername
 *   OIDC_2FA           1 = zusätzlich den eigenen Zwei-Faktor-Code verlangen (Standard: nein, die Klinik-Anmeldung hat eigene MFA)
 *   OIDC_REDIRECT_URI  nur nötig, wenn die automatisch ermittelte Adresse nicht passt
 */
const crypto = require('crypto');

module.exports = (app, ctx) => {
  const { db, audit, todayIso } = ctx;
  const env = process.env;
  const cfg = ctx.oidc || (env.OIDC_ISSUER && env.OIDC_CLIENT_ID ? {
    issuer: env.OIDC_ISSUER.replace(/\/+$/, ''), clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET || '',
    name: env.OIDC_NAME || 'Klinik-Konto', zuordnung: env.OIDC_ZUORDNUNG === 'benutzername' ? 'benutzername' : 'email',
    zweiFaktor: env.OIDC_2FA === '1', redirectUri: env.OIDC_REDIRECT_URI || '',
  } : null);
  ctx.ssoInfo = cfg ? { name: cfg.name } : null;
  if (!cfg) return;

  let jose;
  const joseLaden = async () => (jose ||= require('jose'));
  let discovery = null, jwks = null;
  const meta = async () => {
    if (discovery && discovery.exp > Date.now()) return discovery.doc;
    const r = await fetch(`${cfg.issuer}/.well-known/openid-configuration`);
    if (!r.ok) throw new Error(`Discovery ${r.status}`);
    const doc = await r.json();
    discovery = { doc, exp: Date.now() + 3600e3 };
    const { createRemoteJWKSet } = await joseLaden();
    jwks = createRemoteJWKSet(new URL(doc.jwks_uri));
    return doc;
  };

  const pending = new Map(); // state → { nonce, verifier, exp }
  const b64u = (buf) => buf.toString('base64url');
  const redirectUri = (req) => {
    if (cfg.redirectUri) return cfg.redirectUri;
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const proto = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
    return `${proto}://${host}${ctx.basePath || ''}/api/sso/callback`;
  };
  const zurueck = (res, fehler) => res.redirect(302, `${ctx.basePath || ''}/${fehler ? `?sso_fehler=${encodeURIComponent(fehler)}` : ''}`);

  app.get('/api/sso/start', async (req, res, next) => {
    try {
      const doc = await meta();
      const state = b64u(crypto.randomBytes(24)), nonce = b64u(crypto.randomBytes(24)), verifier = b64u(crypto.randomBytes(32));
      const now = Date.now();
      for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
      if (pending.size > 10000) pending.clear();
      pending.set(state, { nonce, verifier, exp: now + 10 * 60e3, redirect: redirectUri(req) });
      const u = new URL(doc.authorization_endpoint);
      u.search = new URLSearchParams({
        response_type: 'code', client_id: cfg.clientId, redirect_uri: redirectUri(req), scope: 'openid profile email',
        state, nonce, code_challenge: b64u(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', prompt: 'select_account',
      }).toString();
      res.redirect(302, u.toString());
    } catch (e) {
      console.error('SSO-Start:', e.message);
      zurueck(res, 'Der Anmeldedienst der Klinik ist gerade nicht erreichbar.');
    }
  });

  app.get('/api/sso/callback', async (req, res) => {
    const p = pending.get(String(req.query.state || ''));
    pending.delete(String(req.query.state || ''));
    if (req.query.error) return zurueck(res, `Anmeldung abgebrochen (${String(req.query.error).slice(0, 60)}).`);
    if (!p || p.exp < Date.now() || !req.query.code) return zurueck(res, 'Die Anmeldung ist abgelaufen. Bitte erneut versuchen.');
    try {
      const doc = await meta();
      const body = new URLSearchParams({ grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: p.redirect, code_verifier: p.verifier, client_id: cfg.clientId });
      if (cfg.clientSecret) body.set('client_secret', cfg.clientSecret);
      const tr = await fetch(doc.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      const tok = await tr.json().catch(() => ({}));
      if (!tr.ok || !tok.id_token) throw new Error(`Token: ${tr.status} ${tok.error || ''}`);
      const { jwtVerify } = await joseLaden();
      const { payload } = await jwtVerify(tok.id_token, jwks, { issuer: doc.issuer, audience: cfg.clientId, clockTolerance: 60 });
      if (payload.nonce !== p.nonce) throw new Error('nonce passt nicht');
      const kennung = String((cfg.zuordnung === 'email' ? (payload.email || payload.preferred_username || payload.upn) : (payload.preferred_username || payload.upn || payload.email)) || '').trim().toLowerCase();
      if (!kennung) return zurueck(res, 'Das Klinik-Konto liefert keine E-Mail-Adresse.');
      const lokal = kennung.split('@')[0];
      const u = db.prepare(`SELECT * FROM users WHERE active = 1 AND (austritt = '' OR austritt >= ?) AND (${cfg.zuordnung === 'email' ? 'lower(email) = ?' : 'username = ? OR username = ?'})`)
        .get(todayIso(), ...(cfg.zuordnung === 'email' ? [kennung] : [kennung, lokal]));
      if (!u) {
        audit(null, 'login.sso_unbekannt', { kennung });
        return zurueck(res, `Für ${kennung} ist kein Zugang eingerichtet. Bitte wenden Sie sich an die Einsatzplanung (E-Mail-Adresse in der Personalakte hinterlegen).`);
      }
      ctx.checkLock(u);
      if (req.token) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
      const stage = cfg.zweiFaktor && u.totp_enabled ? '2fa' : 'full';
      ctx.startSession(res, u.id, stage);
      if (stage === 'full') ctx.resetFails(u.id);
      audit(u.id, 'login.sso', { kennung });
      return zurueck(res);
    } catch (e) {
      console.error('SSO-Rückkehr:', e.message);
      return zurueck(res, 'Die Anmeldung über das Klinik-Konto ist fehlgeschlagen.');
    }
  });

};
