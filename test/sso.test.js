'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const jose = require('jose');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const TOTP = require('../src/totp');

// ---- Test-Identitätsanbieter (wie Entra ID / Keycloak, stark vereinfacht) ----
async function startIdp({ falscherSchluessel = false } = {}) {
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
  const fremd = (await jose.generateKeyPair('RS256')).privateKey;
  const jwk = { ...(await jose.exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const idp = express();
  idp.use(express.urlencoded({ extended: false }));
  const codes = new Map();
  let base;
  const state = { email: 'anna.becker@klinik.example', letzteAnfrage: null };
  idp.get('/.well-known/openid-configuration', (_q, r) => r.json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, jwks_uri: `${base}/jwks` }));
  idp.get('/jwks', (_q, r) => r.json({ keys: [jwk] }));
  idp.get('/authorize', (q, r) => {
    state.letzteAnfrage = q.query;
    const code = crypto.randomBytes(8).toString('hex');
    codes.set(code, { nonce: q.query.nonce, challenge: q.query.code_challenge, redirect: q.query.redirect_uri, client: q.query.client_id });
    r.redirect(302, `${q.query.redirect_uri}?code=${code}&state=${encodeURIComponent(q.query.state)}`);
  });
  idp.post('/token', async (q, r) => {
    const c = codes.get(q.body.code); codes.delete(q.body.code);
    if (!c) return r.status(400).json({ error: 'invalid_grant' });
    const pkce = crypto.createHash('sha256').update(q.body.code_verifier || '').digest('base64url');
    if (pkce !== c.challenge || q.body.redirect_uri !== c.redirect || q.body.client_secret !== 'geheim') return r.status(400).json({ error: 'invalid_grant' });
    const idToken = await new jose.SignJWT({ nonce: c.nonce, email: state.email, name: 'Anna Becker' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(base).setAudience(c.client).setSubject('u-123').setIssuedAt().setExpirationTime('5m')
      .sign(falscherSchluessel ? fremd : privateKey);
    r.json({ access_token: 'x', token_type: 'Bearer', id_token: idToken });
  });
  const server = idp.listen(0);
  await new Promise((res) => server.once('listening', res));
  base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, state };
}

async function startApp(issuer) {
  const server = createApp(openDb(':memory:'), {
    uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pep-sso-')), timers: false, basePath: '/lwl',
    oidc: { issuer, clientId: 'dienstplan', clientSecret: 'geheim', name: 'Klinik-Konto', zuordnung: 'email', zweiFaktor: false },
  }).listen(0);
  await new Promise((res) => server.once('listening', res));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/** Browser-Ablauf nachspielen: Start → Anbieter → Rückkehr; liefert Cookie und Ziel */
async function ssoLogin(appBase) {
  let r = await fetch(`${appBase}/lwl/api/sso/start`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  r = await fetch(r.headers.get('location'), { redirect: 'manual' });
  r = await fetch(r.headers.get('location'), { redirect: 'manual' });
  return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], location: r.headers.get('location') };
}

test('SSO: Anmeldung mit Klinik-Konto (PKCE, nonce, Signatur, Zuordnung per E-Mail)', async () => {
  const idp = await startIdp();
  const app = await startApp(idp.base);
  try {
    // Knopf wird angeboten
    assert.deepEqual((await (await fetch(`${app.base}/lwl/api/branding`)).json()).sso, { name: 'Klinik-Konto' });
    // E-Mail in der Personalakte hinterlegen
    const m = (() => { let ck = ''; return async (method, u, b) => { const r = await fetch(app.base + u, { method, headers: { 'Content-Type': 'application/json', Cookie: ck }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0]; return r.json(); }; })();
    await m('POST', '/lwl/api/login', { username: 'manager', password: 'manager123' });
    const s = await m('POST', '/lwl/api/2fa/setup');
    await m('POST', '/lwl/api/2fa/enable', { code: TOTP.totp(new URL(s.uri.replace('otpauth://', 'http://')).searchParams.get('secret')) });
    const anna = (await m('GET', '/lwl/api/users')).find((u) => u.username === 'abecker');
    await m('PUT', `/lwl/api/users/${anna.id}`, { email: 'Anna.Becker@klinik.example' });

    // unbekannte Person → Hinweis, keine Sitzung
    idp.state.email = 'fremd@klinik.example';
    let l = await ssoLogin(app.base);
    assert.match(decodeURIComponent(l.location), /kein Zugang eingerichtet/);
    assert.equal(l.cookie, '');

    // bekannte Person → angemeldet, ohne eigenen 2FA-Schritt
    idp.state.email = 'anna.becker@klinik.example';
    l = await ssoLogin(app.base);
    assert.equal(l.location, '/lwl/');
    assert.match(l.cookie, /^sid=/);
    const me = await (await fetch(`${app.base}/lwl/api/me`, { headers: { Cookie: l.cookie } })).json();
    assert.equal(me.user.username, 'abecker');
    // PKCE und nonce wurden verwendet
    assert.equal(idp.state.letzteAnfrage.code_challenge_method, 'S256');
    assert.ok(idp.state.letzteAnfrage.nonce.length > 20);

    // Rückkehr ohne gültigen state wird abgewiesen
    const r = await fetch(`${app.base}/lwl/api/sso/callback?code=abc&state=gefaelscht`, { redirect: 'manual' });
    assert.match(decodeURIComponent(r.headers.get('location')), /abgelaufen/);
  } finally { app.server.close(); idp.server.close(); }
});

test('SSO: Token mit falscher Signatur wird abgelehnt; ohne Konfiguration kein SSO', async () => {
  const idp = await startIdp({ falscherSchluessel: true });
  const app = await startApp(idp.base);
  try {
    const l = await ssoLogin(app.base);
    assert.match(decodeURIComponent(l.location), /fehlgeschlagen/);
    assert.equal(l.cookie, '');
  } finally { app.server.close(); idp.server.close(); }
  const ohne = createApp(openDb(':memory:'), { uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pep-sso-')), timers: false }).listen(0);
  await new Promise((res) => ohne.once('listening', res));
  try {
    const b = `http://127.0.0.1:${ohne.address().port}`;
    assert.equal((await (await fetch(`${b}/api/branding`)).json()).sso, null);
    assert.equal((await fetch(`${b}/api/sso/start`, { redirect: 'manual' })).status, 404);
  } finally { ohne.close(); }
});
