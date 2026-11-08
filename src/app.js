'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { hashPassword, verifyPassword, DEFAULT_SETTINGS } = require('./db');
const QRCode = require('qrcode');
const T = require('./tvoed');
const TOTP = require('./totp');

const SESSION_HOURS = 12;

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function createApp(db, opts = {}) {
  const uploadDir = opts.uploadDir || path.join(process.cwd(), 'data', 'uploads');
  // Optional: Betrieb in einem Unterordner, z. B. BASE_PATH=/LWL → https://domain.de/LWL/
  const base = String(opts.basePath ?? process.env.BASE_PATH ?? '').trim().replace(/\/+$/, '').replace(/^(?!\/)(.)/, '/$1');
  const cookiePath = base ? `${base}/` : '/';
  const app = express.Router();
  app.use(express.json({ limit: '1mb' }));
  // ---------- Erscheinungsbild (öffentlich, schon vor der Anmeldung sichtbar) ----------
  const LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg' };
  const logoFile = () => {
    const mime = getSettings().logo_mime;
    return LOGO_TYPES[mime] ? { mime, file: path.join(uploadDir, `logo.${LOGO_TYPES[mime]}`) } : null;
  };
  const branding = () => {
    const st = getSettings();
    return { klinik_name: st.klinik_name, untertitel: st.untertitel, akzentfarbe: st.akzentfarbe, logo: !!logoFile(), logo_version: st.logo_version || 0 };
  };
  app.get('/api/branding', (_req, res) => res.json(branding()));
  app.get('/api/branding/logo', (req, res, next) => {
    const l = logoFile();
    if (!l || !fs.existsSync(l.file)) return next(new HttpError(404, 'Kein Logo hinterlegt.'));
    res.setHeader('Content-Type', l.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.sendFile(l.file);
  });
  // App-Manifest mit Klinikname (für „Zum Home-Bildschirm“)
  app.get('/manifest.webmanifest', (_req, res) => {
    const b = branding();
    res.type('application/manifest+json').send(JSON.stringify({
      name: `${b.untertitel} – ${b.klinik_name}`,
      short_name: b.klinik_name.length <= 14 ? b.klinik_name : 'Dienstplan',
      description: `${b.untertitel} der ${b.klinik_name}: Dienstplan, Urlaub und Krankmeldung`,
      lang: 'de', start_url: './', scope: './', display: 'standalone',
      background_color: '#f4f6f9', theme_color: b.akzentfarbe,
      icons: [
        { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    }, null, 2));
  });
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---------- Hilfsfunktionen ----------
  const getSettings = () => {
    const out = { ...DEFAULT_SETTINGS };
    for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = JSON.parse(row.value);
    return out;
  };

  // Benachrichtigungen: wird vom Modul src/routes/30-benachrichtigungen.js gesetzt
  const hooks = { notify: () => {} };
  const shiftLabel = (shiftId) => {
    const x = db.prepare(`SELECT s.date, s.start_time, s.end_time, st.name AS type_name, u.name AS unit_name FROM shifts s
      JOIN shift_types st ON st.id = s.shift_type_id JOIN units u ON u.id = s.unit_id WHERE s.id = ?`).get(shiftId);
    return x ? `${x.type_name} am ${x.date.split('-').reverse().join('.')} (${x.start_time}–${x.end_time}, ${x.unit_name})` : 'Dienst';
  };
  const managerIds = () => db.prepare("SELECT id FROM users WHERE active = 1 AND (role = 'manager' OR admin_rechte = 'voll' OR (admin_rechte = 'vertretung' AND admin_bis >= date('now')))").all().map((u) => u.id);
  const audit = (actorId, action, details) =>
    db.prepare('INSERT INTO audit_log (actor_id, action, details) VALUES (?, ?, ?)').run(actorId, action, JSON.stringify(details));

  const isoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
  const nowLocalMs = () => {
    // aktuelle Wandzeit (Europe/Berlin) im selben Format wie tvoed.shiftInterval
    const parts = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date());
    const [d, t] = parts.split(' ');
    return T.parseDate(d) + T.toMinutes(t) * 60000;
  };

  const parseCookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';')
    .map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));

  const wrap = (fn) => (req, res, next) => {
    try {
      const out = fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) { next(e); }
  };

  // ---------- Authentifizierung (Passwort + Zwei-Faktor) ----------
  const MAX_FAILS = 5;
  const LOCK_MIN = 15;
  const PENDING_MIN = 20;

  app.use((req, _res, next) => {
    const token = parseCookies(req).sid;
    if (token) {
      const row = db.prepare(`SELECT u.*, s.stage AS session_stage FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND s.expires > ? AND u.active = 1 AND (u.austritt = '' OR u.austritt >= ?)`).get(token, Date.now(), todayIso());
      if (row) {
        req.token = token;
        if (row.session_stage === 'full') req.user = row;
        else req.pending = row;
      }
    }
    next();
  });

  const auth = (req, _res, next) => {
    if (req.user) return next();
    if (req.pending) {
      return next(new HttpError(401, 'Bitte die Anmeldung mit dem zweiten Faktor abschließen.',
        req.pending.session_stage === 'setup' ? 'STAGE_SETUP' : 'STAGE_2FA'));
    }
    return next(new HttpError(401, 'Bitte anmelden.'));
  };
  /** Hauptverwaltung: Rolle „manager“. Weitere Verwalter/innen: Mitarbeitende mit Verwaltungsrechten
   *  (dauerhaft oder als befristete Vertretung). */
  const todayIso = () => T.isoDate(nowLocalMs());
  const isHaupt = (u) => !!u && u.role === 'manager';
  const hasMgr = (u) => !!u && (u.role === 'manager' || u.admin_rechte === 'voll'
    || (u.admin_rechte === 'vertretung' && !!u.admin_bis && todayIso() <= u.admin_bis));
  const manager = (req, _res, next) => (hasMgr(req.user) ? next() : next(new HttpError(403, 'Nur für die Verwaltung / Einsatzplanung.')));

  /**
   * Verwaltungsbereich: Verwalter/innen und Vertretungen können auf bestimmte Stationen beschränkt sein
   * (users.admin_units = JSON-Liste von Stations-IDs). Lesen dürfen sie alles, ändern nur in ihrem Bereich.
   * Die Hauptverwaltung ist nie beschränkt.
   */
  const scopeOf = (u) => {
    if (!u || isHaupt(u) || !u.admin_units) return null;
    try { const a = JSON.parse(u.admin_units); return Array.isArray(a) && a.length ? new Set(a.map(Number)) : null; } catch { return null; }
  };
  const inScope = (u, unitId) => { const sc = scopeOf(u); return !sc || sc.has(Number(unitId)); };
  const userInScope = (actor, targetId) => {
    const sc = scopeOf(actor);
    if (!sc || Number(targetId) === actor.id) return true;
    const t = db.prepare('SELECT stammbereich_id FROM users WHERE id = ?').get(Number(targetId));
    return !!t && sc.has(Number(t.stammbereich_id));
  };
  const requireUnit = (req, unitId) => {
    if (!inScope(req.user, unitId)) throw new HttpError(403, 'Diese Station gehört nicht zu Ihrem Verwaltungsbereich.', 'BEREICH');
  };
  const requireUser = (req, targetId) => {
    if (!userInScope(req.user, targetId)) throw new HttpError(403, 'Diese Person gehört nicht zu Ihrem Verwaltungsbereich (Stammbereich).', 'BEREICH');
  };
  /** nur Verwaltung ohne Beschränkung (Campus, Dienstzeiten, Einstellungen …) */
  const managerFull = (req, _res, next) => (hasMgr(req.user) && !scopeOf(req.user) ? next()
    : next(new HttpError(403, hasMgr(req.user) ? 'Nur für die Verwaltung des ganzen Campus.' : 'Nur für die Verwaltung / Einsatzplanung.', 'BEREICH')));

  const publicUser = (u) => ({
    id: u.id, name: u.name, username: u.username, role: u.role, qualification: u.qualification,
    weekly_hours: u.weekly_hours, min_hours_month: u.min_hours_month, stundenentgelt: u.stundenentgelt, active: !!u.active,
    urlaubstage_jahr: u.urlaubstage_jahr, schwerbehindert: !!u.schwerbehindert, zusatzurlaub_tage: u.zusatzurlaub_tage,
    personalnummer: u.personalnummer, email: u.email, telefon: u.telefon, eintritt: u.eintritt, austritt: u.austritt,
    befristet_bis: u.befristet_bis, entgeltgruppe: u.entgeltgruppe, stufe: u.stufe, stammbereich_id: u.stammbereich_id,
    bemerkung: u.bemerkung, foto_version: u.foto_version || 0, admin_rechte: u.admin_rechte || 'keine', admin_bis: u.admin_bis,
    is_manager: hasMgr(u), is_haupt: isHaupt(u), admin_units: scopeOf(u) ? [...scopeOf(u)] : [],
    totp_enabled: !!u.totp_enabled, locked: u.locked_until > Date.now(), recovery_left: JSON.parse(u.recovery_codes || '[]').length,
  });

  const startSession = (res, userId, stage) => {
    const token = crypto.randomBytes(32).toString('hex');
    const ttl = stage === 'full' ? SESSION_HOURS * 3600e3 : PENDING_MIN * 60e3;
    db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    db.prepare('INSERT INTO sessions (token, user_id, expires, stage) VALUES (?, ?, ?, ?)').run(token, userId, Date.now() + ttl, stage);
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=${Math.round(ttl / 1000)}${secureFlag}`);
    return token;
  };
  const secureFlag = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';

  const checkLock = (u) => {
    if (u.locked_until > Date.now()) {
      const min = Math.ceil((u.locked_until - Date.now()) / 60000);
      throw new HttpError(429, `Zu viele Fehlversuche. Das Konto ist für ${min} Min. gesperrt.`, 'GESPERRT');
    }
  };
  const registerFail = (u) => {
    const fails = u.failed_logins + 1;
    if (fails >= MAX_FAILS) {
      db.prepare('UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?').run(Date.now() + LOCK_MIN * 60e3, u.id);
      audit(null, 'login.locked', { user_id: u.id });
    } else {
      db.prepare('UPDATE users SET failed_logins = ? WHERE id = ?').run(fails, u.id);
    }
  };
  const resetFails = (id) => db.prepare('UPDATE users SET failed_logins = 0, locked_until = 0 WHERE id = ?').run(id);

  app.post('/api/login', wrap((req, res) => {
    const { username, password } = req.body || {};
    const u = db.prepare("SELECT * FROM users WHERE username = ? AND active = 1 AND (austritt = '' OR austritt >= ?)")
      .get(String(username || '').trim().toLowerCase(), todayIso());
    if (u) checkLock(u);
    if (!u || !verifyPassword(password, u.password_hash)) {
      if (u) registerFail(u);
      throw new HttpError(401, 'Benutzername oder Passwort falsch.');
    }
    if (req.token) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
    const stage = u.totp_enabled ? '2fa' : (getSettings().zwei_faktor_pflicht ? 'setup' : 'full');
    if (stage === 'full') resetFails(u.id);
    startSession(res, u.id, stage);
    return stage === 'full' ? { stage, user: publicUser(u) } : { stage, name: u.name };
  }));

  /** Zweiter Schritt: Code aus der Authenticator-App oder Wiederherstellungscode */
  app.post('/api/login/2fa', wrap((req, res) => {
    const u = req.pending;
    if (!u || u.session_stage !== '2fa') throw new HttpError(401, 'Die Anmeldung ist abgelaufen. Bitte erneut anmelden.');
    checkLock(u);
    const code = String(req.body?.code || '').trim();
    let ok = false, usedRecovery = false;
    const counter = TOTP.verify(u.totp_secret, code, u.totp_last_counter);
    if (counter !== null) {
      db.prepare('UPDATE users SET totp_last_counter = ? WHERE id = ?').run(counter, u.id);
      ok = true;
    } else if (/^[0-9a-f]{5}-?[0-9a-f]{5}$/i.test(code)) {
      const norm = code.includes('-') ? code : `${code.slice(0, 5)}-${code.slice(5)}`;
      const hashes = JSON.parse(u.recovery_codes || '[]');
      const idx = hashes.indexOf(TOTP.hashRecovery(norm));
      if (idx >= 0) {
        hashes.splice(idx, 1);
        db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ?').run(JSON.stringify(hashes), u.id);
        ok = true; usedRecovery = true;
        audit(u.id, 'login.recovery_code', { left: hashes.length });
      }
    }
    if (!ok) {
      registerFail(u);
      throw new HttpError(401, 'Der Code ist ungültig oder abgelaufen.', 'CODE');
    }
    resetFails(u.id);
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
    startSession(res, u.id, 'full');
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
    return { stage: 'full', user: publicUser(fresh), used_recovery: usedRecovery };
  }));

  /** Einrichtung: neues Geheimnis erzeugen und als QR-Code liefern */
  app.post('/api/2fa/setup', async (req, res, next) => {
    try {
      const u = req.user || (req.pending?.session_stage === 'setup' ? req.pending : null);
      if (!u) throw new HttpError(401, 'Bitte anmelden.');
      // Noch nicht bestätigten Schlüssel wiederverwenden: Wechselt man auf dem Handy in die
      // Authenticator-App und zurück, lädt der Browser die Seite oft neu – der Schlüssel muss gleich bleiben.
      const secret = (!req.body?.neu && u.totp_pending) || TOTP.generateSecret();
      db.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').run(secret, u.id);
      const uri = TOTP.otpauthUri(secret, u.username, getSettings().klinik_name || 'Personaleinsatzplanung');
      const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
      res.json({ secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri, qr });
    } catch (e) { next(e); }
  });

  /** Einrichtung abschließen: ersten Code prüfen, Wiederherstellungscodes ausgeben */
  app.post('/api/2fa/enable', wrap((req, res) => {
    const u = req.user || (req.pending?.session_stage === 'setup' ? req.pending : null);
    if (!u) throw new HttpError(401, 'Bitte anmelden.');
    if (!u.totp_pending) throw new HttpError(400, 'Bitte die Einrichtung neu starten.');
    const counter = TOTP.verify(u.totp_pending, req.body?.code);
    if (counter === null) throw new HttpError(400, 'Der Code stimmt nicht. Bitte die Uhrzeit des Handys prüfen und den aktuellen Code eingeben.', 'CODE');
    const codes = TOTP.recoveryCodes();
    db.prepare(`UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled = 1, totp_last_counter = ?,
      recovery_codes = ? WHERE id = ?`).run(counter, JSON.stringify(codes.map(TOTP.hashRecovery)), u.id);
    audit(u.id, '2fa.enable', {});
    if (!req.user) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
      resetFails(u.id);
      startSession(res, u.id, 'full');
    }
    return { recovery_codes: codes, user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) };
  }));

  app.post('/api/2fa/recovery-codes', auth, wrap((req) => {
    const counter = TOTP.verify(req.user.totp_secret, req.body?.code, req.user.totp_last_counter);
    if (!req.user.totp_enabled || counter === null) throw new HttpError(400, 'Der Code ist ungültig.', 'CODE');
    const codes = TOTP.recoveryCodes();
    db.prepare('UPDATE users SET recovery_codes = ?, totp_last_counter = ? WHERE id = ?').run(JSON.stringify(codes.map(TOTP.hashRecovery)), counter, req.user.id);
    audit(req.user.id, '2fa.recovery_regenerated', {});
    return { recovery_codes: codes };
  }));

  app.post('/api/2fa/disable', auth, wrap((req) => {
    if (getSettings().zwei_faktor_pflicht) throw new HttpError(400, 'Die Zwei-Faktor-Anmeldung ist in dieser Einrichtung Pflicht.');
    const counter = TOTP.verify(req.user.totp_secret, req.body?.code, req.user.totp_last_counter);
    if (!req.user.totp_enabled || counter === null) throw new HttpError(400, 'Der Code ist ungültig.', 'CODE');
    db.prepare("UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled = 0, recovery_codes = '[]' WHERE id = ?").run(req.user.id);
    audit(req.user.id, '2fa.disable', {});
    return { ok: true };
  }));

  app.post('/api/logout', wrap((req, res) => {
    if (req.token) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
    res.setHeader('Set-Cookie', `sid=; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=0`);
    return { ok: true };
  }));

  app.get('/api/me', auth, wrap((req) => ({ user: publicUser(req.user), settings: getSettings() })));

  app.post('/api/me/password', auth, wrap((req) => {
    const { old_password, new_password } = req.body || {};
    if (!verifyPassword(old_password, req.user.password_hash)) throw new HttpError(400, 'Altes Passwort ist falsch.');
    if (!new_password || String(new_password).length < 8) throw new HttpError(400, 'Das neue Passwort muss mindestens 8 Zeichen haben.');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(new_password), req.user.id);
    return { ok: true };
  }));

  // ---------- Einstellungen ----------
  app.get('/api/settings', auth, wrap(() => getSettings()));
  app.put('/api/settings', auth, managerFull, wrap((req) => {
    const upd = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
      if (!(k in (req.body || {}))) continue;
      let v = req.body[k];
      if (typeof def === 'number') { v = Number(v); if (!Number.isFinite(v) || v < 0) throw new HttpError(400, `Ungültiger Wert für ${k}.`); }
      if (typeof def === 'boolean') v = !!v;
      if (Array.isArray(def)) {
        if (!Array.isArray(v)) throw new HttpError(400, `Ungültige Liste für ${k}.`);
        v = [...new Set(v.map((x) => String(x).trim()).filter(Boolean))].slice(0, 100);
      }
      if (k === 'akzentfarbe' && !/^#[0-9a-f]{6}$/i.test(String(v))) throw new HttpError(400, 'Farbe bitte als #RRGGBB angeben.');
      if (k === 'klinik_name' && !String(v).trim()) throw new HttpError(400, 'Name der Einrichtung fehlt.');
      if (k === 'urlaub_uebertrag_bis' && !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(String(v))) throw new HttpError(400, 'Übertrag bis: Format MM-TT, z. B. 03-31.');
      if (typeof def === 'string' && !Array.isArray(def)) { v = String(v).trim().slice(0, 120); if (k.startsWith('nacht_') && !isTime(v)) throw new HttpError(400, `Ungültige Uhrzeit für ${k}.`); }
      upd.run(k, JSON.stringify(v));
    }
    audit(req.user.id, 'settings.update', req.body);
    return getSettings();
  }));

  // ---------- Personalverwaltung ----------
  app.get('/api/users', auth, manager, wrap(() => db.prepare('SELECT * FROM users ORDER BY active DESC, role, name').all().map(publicUser)));

  const isDateOrEmpty = (v) => v === '' || isoDate(v);
  const userFields = (b, partial) => {
    const out = {};
    if (!partial || 'name' in b) { if (!String(b.name || '').trim()) throw new HttpError(400, 'Name fehlt.'); out.name = String(b.name).trim().slice(0, 120); }
    if (!partial || 'username' in b) {
      const un = String(b.username || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,}$/.test(un)) throw new HttpError(400, 'Benutzername: mind. 3 Zeichen (a–z, 0–9, . _ -).');
      out.username = un;
    }
    if ('role' in b || !partial) { out.role = b.role === 'manager' ? 'manager' : 'staff'; }
    for (const k of ['qualification', 'personalnummer', 'telefon', 'entgeltgruppe']) if (k in b) out[k] = String(b[k] ?? '').trim().slice(0, 60);
    if ('bemerkung' in b) out.bemerkung = String(b.bemerkung ?? '').trim().slice(0, 2000);
    if ('email' in b) {
      const e = String(b.email ?? '').trim();
      if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new HttpError(400, 'E-Mail-Adresse ungültig.');
      out.email = e;
    }
    for (const k of ['eintritt', 'austritt', 'befristet_bis', 'admin_bis']) {
      if (k in b) { const v = String(b[k] ?? '').trim(); if (!isDateOrEmpty(v)) throw new HttpError(400, `Datum ungültig: ${k}`); out[k] = v; }
    }
    if ('stufe' in b) {
      const v = b.stufe === '' || b.stufe === null || b.stufe === undefined ? null : Number(b.stufe);
      if (v !== null && (!Number.isInteger(v) || v < 1 || v > 6)) throw new HttpError(400, 'Stufe muss zwischen 1 und 6 liegen.');
      out.stufe = v;
    }
    if ('stammbereich_id' in b) {
      const v = b.stammbereich_id ? Number(b.stammbereich_id) : null;
      if (v !== null && !db.prepare('SELECT 1 FROM units WHERE id = ?').get(v)) throw new HttpError(400, 'Bereich nicht gefunden.');
      out.stammbereich_id = v;
    }
    if ('admin_units' in b) {
      const list = Array.isArray(b.admin_units) ? [...new Set(b.admin_units.map(Number).filter(Number.isInteger))] : [];
      for (const id of list) if (!db.prepare('SELECT 1 FROM units WHERE id = ?').get(id)) throw new HttpError(400, 'Station im Verwaltungsbereich nicht gefunden.');
      out.admin_units = list.length ? JSON.stringify(list) : '';
    }
    if ('admin_rechte' in b) {
      if (!['keine', 'voll', 'vertretung'].includes(b.admin_rechte)) throw new HttpError(400, 'Verwaltungsrechte ungültig.');
      out.admin_rechte = b.admin_rechte;
      if (b.admin_rechte === 'vertretung' && !isoDate(String(b.admin_bis || ''))) throw new HttpError(400, 'Bitte angeben, bis wann die Vertretung gilt.');
      if (b.admin_rechte !== 'vertretung') out.admin_bis = '';
    }
    for (const k of ['weekly_hours', 'min_hours_month', 'stundenentgelt', 'urlaubstage_jahr', 'zusatzurlaub_tage']) {
      if (k in b) { const v = Number(b[k]); if (!Number.isFinite(v) || v < 0) throw new HttpError(400, `Ungültiger Wert: ${k}`); out[k] = v; }
    }
    if ('active' in b) out.active = b.active ? 1 : 0;
    if ('schwerbehindert' in b) out.schwerbehindert = b.schwerbehindert ? 1 : 0;
    // § 208 SGB IX: 5 Arbeitstage Zusatzurlaub bei 5-Tage-Woche, falls nichts anderes angegeben
    if (out.schwerbehindert === 1 && !('zusatzurlaub_tage' in out)) out.zusatzurlaub_tage = 5;
    if (out.schwerbehindert === 0) out.zusatzurlaub_tage = 0;
    return out;
  };

  /** Nur die Hauptverwaltung darf Rechte vergeben und andere Verwalter/innen bearbeiten. */
  const RECHTE_FELDER = ['role', 'admin_rechte', 'admin_bis', 'admin_units'];
  const isPrivileged = (u) => isHaupt(u) || (u.admin_rechte || 'keine') !== 'keine';
  const otherActiveHaupt = (id) => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'manager' AND active = 1 AND id <> ?").get(id).n;

  const applyUserUpdate = (id, f) => {
    const keys = Object.keys(f);
    if (keys.length) db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => f[k]), id);
    return keys;
  };

  app.post('/api/users', auth, manager, wrap((req) => {
    const f = userFields(req.body || {}, false);
    if (!isHaupt(req.user) && (f.role === 'manager' || (f.admin_rechte && f.admin_rechte !== 'keine'))) {
      throw new HttpError(403, 'Verwaltungsrechte kann nur die Hauptverwaltung vergeben.');
    }
    if (scopeOf(req.user)) {
      if (!f.stammbereich_id) throw new HttpError(400, 'Bitte einen Stammbereich aus Ihrem Verwaltungsbereich wählen.', 'BEREICH');
      requireUnit(req, f.stammbereich_id);
    }
    const pw = req.body.password;
    if (!pw || String(pw).length < 6) throw new HttpError(400, 'Startpasswort: mind. 6 Zeichen.');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(f.username)) throw new HttpError(409, 'Benutzername ist bereits vergeben.');
    const st = getSettings();
    const id = db.prepare('INSERT INTO users (name, username, password_hash, role, weekly_hours, urlaubstage_jahr) VALUES (?, ?, ?, ?, ?, ?)')
      .run(f.name, f.username, hashPassword(pw), f.role, st.wochenstunden_standard, st.urlaubstage_standard).lastInsertRowid;
    const { name, username, role, ...rest } = f; // eslint-disable-line no-unused-vars
    applyUserUpdate(id, rest);
    audit(req.user.id, 'user.create', { id, user_id: id, username: f.username });
    return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  }));

  app.put('/api/users/:id', auth, manager, wrap((req) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!existing) throw new HttpError(404, 'Nicht gefunden.');
    const f = userFields(req.body || {}, true);
    // unveränderte Rechte-Felder nicht als Änderung werten (das Formular schickt alles mit)
    for (const k of RECHTE_FELDER) if (k in f && String(f[k]) === String(existing[k] ?? '')) delete f[k];
    if (!isHaupt(req.user)) {
      if (RECHTE_FELDER.some((k) => k in f)) throw new HttpError(403, 'Verwaltungsrechte kann nur die Hauptverwaltung vergeben.');
      if (id !== req.user.id && isPrivileged(existing)) throw new HttpError(403, 'Andere Verwalter/innen kann nur die Hauptverwaltung bearbeiten.');
    }
    requireUser(req, id);
    if (scopeOf(req.user) && 'stammbereich_id' in f && id !== req.user.id) {
      if (!f.stammbereich_id) throw new HttpError(400, 'Bitte einen Stammbereich aus Ihrem Verwaltungsbereich wählen.', 'BEREICH');
      requireUnit(req, f.stammbereich_id);
    }
    if (f.username && db.prepare('SELECT 1 FROM users WHERE username = ? AND id <> ?').get(f.username, id)) throw new HttpError(409, 'Benutzername ist bereits vergeben.');
    if (id === req.user.id && (f.active === 0 || RECHTE_FELDER.some((k) => k in f))) {
      throw new HttpError(400, 'Sie können Ihre eigenen Rechte nicht ändern oder sich selbst deaktivieren.');
    }
    if (isHaupt(existing) && (f.role === 'staff' || f.active === 0) && otherActiveHaupt(id) === 0) {
      throw new HttpError(400, 'Es muss mindestens eine aktive Hauptverwaltung geben.');
    }
    const keys = applyUserUpdate(id, f);
    if (req.body.password) {
      if (String(req.body.password).length < 6) throw new HttpError(400, 'Passwort: mind. 6 Zeichen.');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    if (f.active === 0) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    if (req.body.reset_2fa) {
      db.prepare(`UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled = 0, totp_last_counter = -1,
        recovery_codes = '[]', failed_logins = 0, locked_until = 0 WHERE id = ?`).run(id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    if (req.body.unlock) db.prepare('UPDATE users SET failed_logins = 0, locked_until = 0 WHERE id = ?').run(id);
    const rightsChanged = keys.some((k) => RECHTE_FELDER.includes(k));
    audit(req.user.id, rightsChanged ? 'user.rights' : 'user.update', {
      id, user_id: id, fields: keys, rechte: f.admin_rechte, bis: f.admin_bis, role: f.role,
      password: !!req.body.password, reset_2fa: !!req.body.reset_2fa,
    });
    return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  }));

  /** Dienste einer Person (Personalakte) */
  app.get('/api/users/:id/shifts', auth, manager, wrap((req) => {
    const from = isoDate(req.query.from) ? req.query.from : todayIso();
    const to = isoDate(req.query.to) ? req.query.to : T.isoDate(T.parseDate(from) + 60 * T.DAY);
    return loadShifts('s.date BETWEEN ? AND ? AND s.id IN (SELECT shift_id FROM assignments WHERE user_id = ?)', [from, to, Number(req.params.id)]);
  }));

  /** Personalliste als CSV (Excel) */
  app.get('/api/users.csv', auth, manager, wrap((req, res) => {
    const units = new Map(db.prepare('SELECT id, name FROM units').all().map((u) => [u.id, u.name]));
    const head = ['Personalnr.', 'Name', 'Benutzer', 'Qualifikation', 'Stammbereich', 'Entgeltgruppe', 'Stufe', 'Wochenstd.',
      'Urlaubstage', 'Eintritt', 'befristet bis', 'Austritt', 'E-Mail', 'Telefon', 'Verwaltungsrechte', 'Status'];
    const rechte = (u) => (u.role === 'manager' ? 'Hauptverwaltung' : u.admin_rechte === 'voll' ? 'Verwalter/in'
      : u.admin_rechte === 'vertretung' ? `Vertretung bis ${u.admin_bis}` : '');
    const rows = db.prepare('SELECT * FROM users ORDER BY active DESC, name').all().map((u) => [u.personalnummer, u.name, u.username,
      u.qualification, units.get(u.stammbereich_id) || '', u.entgeltgruppe, u.stufe ?? '', String(u.weekly_hours).replace('.', ','),
      String(u.urlaubstage_jahr).replace('.', ','), u.eintritt, u.befristet_bis, u.austritt, u.email, u.telefon, rechte(u), u.active ? 'aktiv' : 'inaktiv']);
    const csv = '﻿' + [head, ...rows].map((l) => l.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
    audit(req.user.id, 'users.export', { count: rows.length });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="personalliste.csv"');
    res.send(csv);
  }));

  // ---------- Bereiche / Stationen ----------
  const loadUnits = () => db.prepare(`SELECT un.*, l.name AS leitung_name, b.name AS building_name, b.kuerzel AS building_kuerzel,
      vb.name AS verbund_name, vb.gemeinsam AS verbund_gemeinsam,
      (SELECT COUNT(*) FROM users x WHERE x.stammbereich_id = un.id AND x.active = 1) AS personal
    FROM units un LEFT JOIN users l ON l.id = un.leitung_id LEFT JOIN buildings b ON b.id = un.building_id
    LEFT JOIN verbuende vb ON vb.id = un.verbund_id AND vb.active = 1
    ORDER BY un.active DESC, COALESCE(b.sort, 9999), b.name, COALESCE(vb.name, un.name), un.name`).all();
  const unitFields = (b, cur = {}) => {
    const v = { ...cur, ...b };
    const name = String(v.name ?? '').trim().slice(0, 80);
    if (!name) throw new HttpError(400, 'Bitte einen Namen für die Station angeben.');
    const dup = db.prepare('SELECT id FROM units WHERE lower(name) = lower(?) AND id <> ?').get(name, cur.id || 0);
    if (dup) throw new HttpError(409, 'Eine Station mit diesem Namen gibt es schon.');
    const leitung = v.leitung_id ? Number(v.leitung_id) : null;
    const building = v.building_id ? Number(v.building_id) : null;
    if (building !== null && !db.prepare('SELECT 1 FROM buildings WHERE id = ?').get(building)) throw new HttpError(400, 'Gebäude nicht gefunden.');
    if (leitung !== null && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(leitung)) throw new HttpError(400, 'Stationsleitung nicht gefunden.');
    return {
      name, kuerzel: String(v.kuerzel ?? '').trim().slice(0, 10), telefon: String(v.telefon ?? '').trim().slice(0, 40),
      leitung_id: leitung, building_id: building, active: v.active === undefined ? 1 : (v.active ? 1 : 0),
    };
  };
  app.get('/api/units', auth, wrap(() => loadUnits()));
  app.post('/api/units', auth, managerFull, wrap((req) => {
    const f = unitFields(req.body || {});
    const id = db.prepare('INSERT INTO units (name, kuerzel, telefon, leitung_id, building_id, active) VALUES (?, ?, ?, ?, ?, ?)')
      .run(f.name, f.kuerzel, f.telefon, f.leitung_id, f.building_id, f.active).lastInsertRowid;
    // Mindestbesetzung von einer bestehenden Station übernehmen
    let kopiert = 0;
    if (req.body.copy_from) {
      kopiert = Number(db.prepare(`INSERT INTO requirements (unit_id, shift_type_id, weekday, min_staff, max_staff)
        SELECT ?, shift_type_id, weekday, min_staff, max_staff FROM requirements WHERE unit_id = ?`).run(id, Number(req.body.copy_from)).changes);
      db.prepare(`INSERT INTO qual_rules (unit_id, shift_type_id, qualification, min_count)
        SELECT ?, shift_type_id, qualification, min_count FROM qual_rules WHERE unit_id = ?`).run(id, Number(req.body.copy_from));
    }
    audit(req.user.id, 'unit.create', { id, ...f, kopiert });
    return { ...loadUnits().find((u) => u.id === id), kopiert };
  }));
  app.put('/api/units/:id', auth, managerFull, wrap((req) => {
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM units WHERE id = ?').get(id);
    if (!cur) throw new HttpError(404, 'Station nicht gefunden.');
    const f = unitFields(req.body || {}, cur);
    db.prepare('UPDATE units SET name = ?, kuerzel = ?, telefon = ?, leitung_id = ?, building_id = ?, active = ? WHERE id = ?')
      .run(f.name, f.kuerzel, f.telefon, f.leitung_id, f.building_id, f.active, id);
    audit(req.user.id, 'unit.update', { id, ...f, alt: cur.name });
    return loadUnits().find((u) => u.id === id);
  }));
  app.delete('/api/units/:id', auth, managerFull, wrap((req) => {
    const id = Number(req.params.id);
    const n = db.prepare('SELECT COUNT(*) AS n FROM shifts WHERE unit_id = ?').get(id).n;
    if (n > 0) throw new HttpError(409, `Für diese Station gibt es ${n} Schichten. Bitte stattdessen deaktivieren.`, 'HAS_SHIFTS');
    db.prepare('UPDATE users SET stammbereich_id = NULL WHERE stammbereich_id = ?').run(id);
    db.prepare('DELETE FROM units WHERE id = ?').run(id);
    audit(req.user.id, 'unit.delete', { id });
    return { ok: true };
  }));

  // ---------- Stationsverbünde ----------
  const loadVerbuende = () => db.prepare(`SELECT v.*,
      (SELECT COUNT(*) FROM units u WHERE u.verbund_id = v.id AND u.active = 1) AS stationen,
      (SELECT group_concat(u.name, ', ') FROM units u WHERE u.verbund_id = v.id AND u.active = 1) AS stationsnamen
    FROM verbuende v ORDER BY v.active DESC, v.name`).all();
  const verbundFields = (b, cur = {}) => {
    const v = { ...cur, ...b };
    const name = String(v.name ?? '').trim().slice(0, 80);
    if (!name) throw new HttpError(400, 'Bitte einen Namen für den Verbund angeben.');
    if (db.prepare('SELECT 1 FROM verbuende WHERE lower(name) = lower(?) AND id <> ?').get(name, cur.id || 0)) throw new HttpError(409, 'Einen Verbund mit diesem Namen gibt es schon.');
    return { name, beschreibung: String(v.beschreibung ?? '').trim().slice(0, 300), gemeinsam: v.gemeinsam === undefined ? 1 : (v.gemeinsam ? 1 : 0),
      active: v.active === undefined ? 1 : (v.active ? 1 : 0) };
  };
  const setVerbundUnits = (id, unitIds) => {
    if (!Array.isArray(unitIds)) return;
    db.prepare('UPDATE units SET verbund_id = NULL WHERE verbund_id = ?').run(id);
    const upd = db.prepare('UPDATE units SET verbund_id = ? WHERE id = ?');
    for (const u of unitIds) upd.run(id, Number(u));
  };
  app.get('/api/verbuende', auth, wrap(() => loadVerbuende()));
  app.post('/api/verbuende', auth, managerFull, wrap((req) => {
    const f = verbundFields(req.body || {});
    const id = db.prepare('INSERT INTO verbuende (name, beschreibung, gemeinsam, active) VALUES (?, ?, ?, ?)').run(f.name, f.beschreibung, f.gemeinsam, f.active).lastInsertRowid;
    setVerbundUnits(id, req.body.unit_ids);
    audit(req.user.id, 'verbund.create', { id, ...f, unit_ids: req.body.unit_ids });
    return loadVerbuende().find((v) => v.id === id);
  }));
  app.put('/api/verbuende/:id', auth, managerFull, wrap((req) => {
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM verbuende WHERE id = ?').get(id);
    if (!cur) throw new HttpError(404, 'Verbund nicht gefunden.');
    const f = verbundFields(req.body || {}, cur);
    db.prepare('UPDATE verbuende SET name = ?, beschreibung = ?, gemeinsam = ?, active = ? WHERE id = ?').run(f.name, f.beschreibung, f.gemeinsam, f.active, id);
    setVerbundUnits(id, req.body.unit_ids);
    audit(req.user.id, 'verbund.update', { id, ...f, unit_ids: req.body.unit_ids });
    return loadVerbuende().find((v) => v.id === id);
  }));
  app.delete('/api/verbuende/:id', auth, managerFull, wrap((req) => {
    const id = Number(req.params.id);
    db.prepare('UPDATE units SET verbund_id = NULL WHERE verbund_id = ?').run(id);
    db.prepare('DELETE FROM verbuende WHERE id = ?').run(id);
    audit(req.user.id, 'verbund.delete', { id });
    return { ok: true };
  }));

  // ---------- Campus: Gebäude / Häuser ----------
  const loadBuildings = () => db.prepare(`SELECT b.*,
      (SELECT COUNT(*) FROM units u WHERE u.building_id = b.id AND u.active = 1) AS stationen,
      (SELECT COUNT(*) FROM users x JOIN units u ON u.id = x.stammbereich_id WHERE u.building_id = b.id AND x.active = 1) AS personal
    FROM buildings b ORDER BY b.active DESC, b.sort, b.name`).all();
  const buildingFields = (b, cur = {}) => {
    const v = { ...cur, ...b };
    const name = String(v.name ?? '').trim().slice(0, 80);
    if (!name) throw new HttpError(400, 'Bitte einen Namen für das Gebäude angeben.');
    if (db.prepare('SELECT 1 FROM buildings WHERE lower(name) = lower(?) AND id <> ?').get(name, cur.id || 0)) {
      throw new HttpError(409, 'Ein Gebäude mit diesem Namen gibt es schon.');
    }
    const sort = Number(v.sort ?? 0);
    return {
      name, kuerzel: String(v.kuerzel ?? '').trim().slice(0, 10), beschreibung: String(v.beschreibung ?? '').trim().slice(0, 300),
      sort: Number.isFinite(sort) ? Math.round(sort) : 0, active: v.active === undefined ? 1 : (v.active ? 1 : 0),
    };
  };
  app.get('/api/buildings', auth, wrap(() => loadBuildings()));
  app.post('/api/buildings', auth, managerFull, wrap((req) => {
    const f = buildingFields(req.body || {});
    if (!('sort' in (req.body || {}))) f.sort = (db.prepare('SELECT MAX(sort) AS m FROM buildings').get().m || 0) + 1;
    const id = db.prepare('INSERT INTO buildings (name, kuerzel, beschreibung, sort, active) VALUES (?, ?, ?, ?, ?)')
      .run(f.name, f.kuerzel, f.beschreibung, f.sort, f.active).lastInsertRowid;
    audit(req.user.id, 'building.create', { id, ...f });
    return loadBuildings().find((b) => b.id === id);
  }));
  app.put('/api/buildings/:id', auth, managerFull, wrap((req) => {
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM buildings WHERE id = ?').get(id);
    if (!cur) throw new HttpError(404, 'Gebäude nicht gefunden.');
    const f = buildingFields(req.body || {}, cur);
    db.prepare('UPDATE buildings SET name = ?, kuerzel = ?, beschreibung = ?, sort = ?, active = ? WHERE id = ?')
      .run(f.name, f.kuerzel, f.beschreibung, f.sort, f.active, id);
    audit(req.user.id, 'building.update', { id, ...f, alt: cur.name });
    return loadBuildings().find((b) => b.id === id);
  }));
  app.delete('/api/buildings/:id', auth, managerFull, wrap((req) => {
    const id = Number(req.params.id);
    // Stationen bleiben erhalten und sind danach keinem Gebäude zugeordnet
    const n = Number(db.prepare('UPDATE units SET building_id = NULL WHERE building_id = ?').run(id).changes);
    db.prepare('DELETE FROM buildings WHERE id = ?').run(id);
    audit(req.user.id, 'building.delete', { id, stationen: n });
    return { ok: true, stationen: n };
  }));

  // ---------- Profilfotos ----------
  const FOTO_DIR = () => path.join(uploadDir, 'fotos');
  const fotoPath = (id) => path.join(FOTO_DIR(), `${Number(id)}.img`);
  const saveFoto = (req, userId) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const mime = sniffMime(buf);
    if (mime !== 'image/jpeg' && mime !== 'image/png') throw new HttpError(400, 'Bitte ein Foto als JPG oder PNG hochladen.');
    fs.mkdirSync(FOTO_DIR(), { recursive: true });
    fs.writeFileSync(fotoPath(userId), buf, { mode: 0o600 });
    db.prepare('UPDATE users SET foto_version = ? WHERE id = ?').run(Date.now(), userId);
    audit(req.user.id, 'foto.upload', { user_id: userId, size: buf.length });
    return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
  };
  const deleteFoto = (req, userId) => {
    fs.rmSync(fotoPath(userId), { force: true });
    db.prepare('UPDATE users SET foto_version = 0 WHERE id = ?').run(userId);
    audit(req.user.id, 'foto.delete', { user_id: userId });
    return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
  };
  const rawFoto = express.raw({ type: () => true, limit: 5 * 1024 * 1024 });
  app.post('/api/me/foto', auth, rawFoto, wrap((req) => saveFoto(req, req.user.id)));
  app.delete('/api/me/foto', auth, wrap((req) => deleteFoto(req, req.user.id)));
  const fotoTarget = (req) => {
    const t = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!t) throw new HttpError(404, 'Nicht gefunden.');
    if (!isHaupt(req.user) && t.id !== req.user.id && isPrivileged(t)) throw new HttpError(403, 'Andere Verwalter/innen kann nur die Hauptverwaltung bearbeiten.');
    requireUser(req, t.id);
    return t;
  };
  app.post('/api/users/:id/foto', auth, manager, rawFoto, wrap((req) => saveFoto(req, fotoTarget(req).id)));
  app.delete('/api/users/:id/foto', auth, manager, wrap((req) => deleteFoto(req, fotoTarget(req).id)));
  // Fotos sehen nur angemeldete Kolleginnen und Kollegen (z. B. im Dienstplan)
  app.get('/api/users/:id/foto', auth, (req, res, next) => {
    const file = fotoPath(req.params.id);
    if (!fs.existsSync(file)) return next(new HttpError(404, 'Kein Foto.'));
    const head = fs.readFileSync(file).subarray(0, 8);
    res.setHeader('Content-Type', head[0] === 0x89 ? 'image/png' : 'image/jpeg');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.sendFile(file);
  });

  // ---------- Schichtarten (Dienstzeiten) ----------
  app.get('/api/shift-types', auth, wrap(() => db.prepare('SELECT * FROM shift_types ORDER BY active DESC, start_time').all()));

  const shiftTypeFields = (b, cur = {}) => {
    const v = { ...cur, ...b };
    if (!String(v.name || '').trim()) throw new HttpError(400, 'Name fehlt.');
    if (!String(v.code || '').trim()) throw new HttpError(400, 'Kürzel fehlt.');
    if (!isTime(v.start_time) || !isTime(v.end_time)) throw new HttpError(400, 'Beginn/Ende im Format HH:MM angeben.');
    const br = Number(v.break_min);
    if (!Number.isInteger(br) || br < 0) throw new HttpError(400, 'Pause in ganzen Minuten angeben.');
    const { start, end } = T.shiftInterval('2000-01-01', v.start_time, v.end_time);
    if (br >= (end - start) / 60000) throw new HttpError(400, 'Pause ist länger als die Schicht.');
    return {
      name: String(v.name).trim(), code: String(v.code).trim().slice(0, 4), start_time: v.start_time, end_time: v.end_time,
      break_min: br, color: /^#[0-9a-f]{6}$/i.test(v.color || '') ? v.color : '#4f7cac', active: v.active === undefined ? 1 : (v.active ? 1 : 0),
    };
  };

  app.post('/api/shift-types', auth, managerFull, wrap((req) => {
    const f = shiftTypeFields(req.body || {});
    const id = db.prepare('INSERT INTO shift_types (name, code, start_time, end_time, break_min, color, active) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(f.name, f.code, f.start_time, f.end_time, f.break_min, f.color, f.active).lastInsertRowid;
    audit(req.user.id, 'shift_type.create', { id, ...f });
    return db.prepare('SELECT * FROM shift_types WHERE id = ?').get(id);
  }));

  app.put('/api/shift-types/:id', auth, managerFull, wrap((req) => {
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM shift_types WHERE id = ?').get(id);
    if (!cur) throw new HttpError(404, 'Nicht gefunden.');
    const f = shiftTypeFields(req.body || {}, cur);
    db.prepare('UPDATE shift_types SET name=?, code=?, start_time=?, end_time=?, break_min=?, color=?, active=? WHERE id=?')
      .run(f.name, f.code, f.start_time, f.end_time, f.break_min, f.color, f.active, id);
    // Optional: Zeiten in bereits erzeugte, zukünftige Schichten übernehmen
    let updated = 0;
    if (req.body.apply_future) {
      const today = T.isoDate(nowLocalMs());
      updated = Number(db.prepare('UPDATE shifts SET start_time=?, end_time=?, break_min=? WHERE shift_type_id=? AND date > ?')
        .run(f.start_time, f.end_time, f.break_min, id, today).changes);
    }
    audit(req.user.id, 'shift_type.update', { id, ...f, updated });
    return { ...db.prepare('SELECT * FROM shift_types WHERE id = ?').get(id), updated_shifts: updated };
  }));

  // ---------- Mindestbesetzung (Vorlage je Wochentag) ----------
  app.get('/api/requirements', auth, manager, wrap(() => db.prepare('SELECT * FROM requirements').all()));
  app.put('/api/requirements', auth, manager, wrap((req) => {
    const rows = Array.isArray(req.body) ? req.body : [];
    const up = db.prepare(`INSERT INTO requirements (unit_id, shift_type_id, weekday, min_staff, max_staff) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(unit_id, shift_type_id, weekday) DO UPDATE SET min_staff = excluded.min_staff, max_staff = excluded.max_staff`);
    db.exec('BEGIN');
    try {
      for (const r of rows) {
        requireUnit(req, r.unit_id);
        const min = Number(r.min_staff) || 0;
        const max = r.max_staff === null || r.max_staff === '' || r.max_staff === undefined ? null : Number(r.max_staff);
        if (min < 0 || (max !== null && (max < min || !Number.isInteger(max)))) throw new HttpError(400, 'Maximum muss ≥ Minimum sein.');
        up.run(Number(r.unit_id), Number(r.shift_type_id), Number(r.weekday), min, max);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    audit(req.user.id, 'requirements.update', { count: rows.length });
    return db.prepare('SELECT * FROM requirements').all();
  }));

  // ---------- Schichten / Dienstplan ----------
  app.post('/api/shifts/generate', auth, manager, wrap((req) => {
    const { from, to } = req.body || {};
    if (!isoDate(from) || !isoDate(to) || from > to) throw new HttpError(400, 'Zeitraum ungültig.');
    if ((T.parseDate(to) - T.parseDate(from)) / T.DAY > 366) throw new HttpError(400, 'Maximal ein Jahr auf einmal.');
    const unitIds = Array.isArray(req.body.unit_ids) && req.body.unit_ids.length
      ? req.body.unit_ids.map(Number)
      : db.prepare('SELECT id FROM units WHERE active = 1').all().map((u) => u.id).filter((id) => inScope(req.user, id));
    for (const id of unitIds) requireUnit(req, id);
    const reqs = db.prepare(`SELECT r.*, st.start_time, st.end_time, st.break_min FROM requirements r
      JOIN shift_types st ON st.id = r.shift_type_id WHERE st.active = 1 AND (r.min_staff > 0 OR r.max_staff > 0)`).all()
      .filter((r) => unitIds.includes(r.unit_id));
    const ins = db.prepare(`INSERT OR IGNORE INTO shifts (date, unit_id, shift_type_id, start_time, end_time, break_min, min_staff, max_staff)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    let created = 0;
    db.exec('BEGIN');
    try {
      for (let t = T.parseDate(from); t <= T.parseDate(to); t += T.DAY) {
        const date = T.isoDate(t);
        const wd = new Date(t).getUTCDay();
        for (const r of reqs.filter((x) => x.weekday === wd)) {
          created += Number(ins.run(date, r.unit_id, r.shift_type_id, r.start_time, r.end_time, r.break_min, r.min_staff, r.max_staff).changes);
        }
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    audit(req.user.id, 'shifts.generate', { from, to, unitIds, created });
    return { created };
  }));

  // ---------- Logo hochladen / entfernen (Manager) ----------
  const setSetting = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(k, JSON.stringify(v));
  app.post('/api/branding/logo', auth, managerFull, express.raw({ type: () => true, limit: 2 * 1024 * 1024 }), wrap((req) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const mime = sniffMime(buf);
    if (!LOGO_TYPES[mime]) throw new HttpError(400, 'Logo bitte als PNG oder JPG (max. 2 MB) hochladen.');
    const old = logoFile();
    if (old) fs.rmSync(old.file, { force: true });
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.writeFileSync(path.join(uploadDir, `logo.${LOGO_TYPES[mime]}`), buf, { mode: 0o644 });
    setSetting('logo_mime', mime);
    setSetting('logo_version', Date.now());
    audit(req.user.id, 'branding.logo', { mime, size: buf.length });
    return branding();
  }));
  app.delete('/api/branding/logo', auth, managerFull, wrap((req) => {
    const old = logoFile();
    if (old) fs.rmSync(old.file, { force: true });
    setSetting('logo_mime', '');
    audit(req.user.id, 'branding.logo_delete', {});
    return branding();
  }));

  // ---------- Mindestbesetzung nach Qualifikation ----------
  const loadRules = () => db.prepare(`SELECT r.*, u.name AS unit_name, st.name AS type_name FROM qual_rules r
    LEFT JOIN units u ON u.id = r.unit_id LEFT JOIN shift_types st ON st.id = r.shift_type_id ORDER BY r.qualification`).all();

  /** Fehlende Qualifikationen einer Schicht; optional ohne eine bestimmte Person (für Austragen) */
  const qualMissing = (shift, assigned, rules, withoutUserId = null) => {
    const people = assigned.filter((a) => a.user_id !== withoutUserId);
    return rules
      .filter((r) => (r.unit_id === null || r.unit_id === shift.unit_id) && (r.shift_type_id === null || r.shift_type_id === shift.shift_type_id))
      .map((r) => ({ qualification: r.qualification, need: r.min_count, have: people.filter((p) => p.qualification === r.qualification).length }))
      .filter((x) => x.have < x.need);
  };

  app.get('/api/qual-rules', auth, manager, wrap(() => loadRules()));
  app.post('/api/qual-rules', auth, managerFull, wrap((req) => {
    const b = req.body || {};
    const qualification = String(b.qualification || '').trim();
    const min = Number(b.min_count);
    if (!qualification) throw new HttpError(400, 'Qualifikation fehlt.');
    if (!Number.isInteger(min) || min < 1) throw new HttpError(400, 'Anzahl muss mindestens 1 sein.');
    const unitId = b.unit_id ? Number(b.unit_id) : null;
    const typeId = b.shift_type_id ? Number(b.shift_type_id) : null;
    const id = db.prepare('INSERT INTO qual_rules (unit_id, shift_type_id, qualification, min_count) VALUES (?, ?, ?, ?)')
      .run(unitId, typeId, qualification, min).lastInsertRowid;
    audit(req.user.id, 'qual_rule.create', { id, unitId, typeId, qualification, min });
    return loadRules();
  }));
  app.delete('/api/qual-rules/:id', auth, managerFull, wrap((req) => {
    db.prepare('DELETE FROM qual_rules WHERE id = ?').run(Number(req.params.id));
    audit(req.user.id, 'qual_rule.delete', { id: Number(req.params.id) });
    return loadRules();
  }));

  // ---------- Dienstplan ----------
  const assignedFor = (ids) => {
    const byShift = new Map(ids.map((id) => [id, []]));
    if (!ids.length) return byShift;
    const rows = db.prepare(`SELECT a.shift_id, us.id AS user_id, us.name, us.qualification, us.foto_version FROM assignments a
      JOIN users us ON us.id = a.user_id WHERE a.shift_id IN (${ids.map(() => '?').join(',')}) ORDER BY us.name`).all(...ids);
    for (const a of rows) byShift.get(a.shift_id).push({ user_id: a.user_id, name: a.name, qualification: a.qualification, foto_version: a.foto_version });
    return byShift;
  };

  /** Benötigte Qualifikationen einer Schicht (je Qualifikation die höchste Mindestzahl) */
  const qualNeeds = (shift, rules) => {
    const needs = new Map();
    for (const r of rules) {
      if ((r.unit_id === null || r.unit_id === shift.unit_id) && (r.shift_type_id === null || r.shift_type_id === shift.shift_type_id)) {
        needs.set(r.qualification, Math.max(needs.get(r.qualification) || 0, r.min_count));
      }
    }
    return needs;
  };

  /**
   * Stationsverbund: Schichten derselben Dienstart am selben Tag in verbundenen Stationen werden gemeinsam betrachtet.
   * Bei „gemeinsamer Mindestbesetzung“ gilt eine Schicht als gedeckt, wenn der Verbund insgesamt gedeckt ist.
   */
  const verbundGroup = (date, typeId, verbundId, rules, withoutUserId = null) => {
    const members = db.prepare(`SELECT s.*, u.name AS unit_name FROM shifts s JOIN units u ON u.id = s.unit_id
      WHERE u.verbund_id = ? AND s.date = ? AND s.shift_type_id = ? AND u.active = 1 ORDER BY u.name`).all(verbundId, date, typeId);
    const asg = assignedFor(members.map((m) => m.id));
    const needs = new Map();
    let besetzt = 0, min = 0;
    const people = [];
    for (const m of members) {
      const list = asg.get(m.id).filter((p) => p.user_id !== withoutUserId);
      besetzt += list.length;
      min += m.min_staff;
      people.push(...list);
      for (const [q, n] of qualNeeds(m, rules)) needs.set(q, (needs.get(q) || 0) + n);
    }
    const qual_missing = [...needs].map(([qualification, need]) => ({ qualification, need, have: people.filter((p) => p.qualification === qualification).length }))
      .filter((x) => x.have < x.need);
    return {
      besetzt, min, qual_missing, gedeckt: besetzt >= min && qual_missing.length === 0,
      stationen: members.map((m) => ({
        shift_id: m.id, unit_id: m.unit_id, unit_name: m.unit_name, besetzt: asg.get(m.id).length, min_staff: m.min_staff, max_staff: m.max_staff,
      })),
    };
  };

  const loadShifts = (where, params) => {
    const shifts = db.prepare(`SELECT s.*, st.name AS type_name, st.code AS type_code, st.color AS type_color, u.name AS unit_name,
        CASE WHEN v.id IS NULL THEN NULL ELSE u.verbund_id END AS verbund_id, v.name AS verbund_name, v.gemeinsam AS verbund_gemeinsam
      FROM shifts s JOIN shift_types st ON st.id = s.shift_type_id JOIN units u ON u.id = s.unit_id
      LEFT JOIN verbuende v ON v.id = u.verbund_id AND v.active = 1
      WHERE ${where} ORDER BY s.date, s.start_time, u.name`).all(...params);
    if (!shifts.length) return [];
    const byShift = assignedFor(shifts.map((s) => s.id));
    const rules = loadRules();
    const groups = new Map();
    const offers = new Map();
    for (const o of db.prepare(`SELECT id, shift_id, user_id, status FROM swap_offers WHERE status IN ('offen','angenommen')
      AND shift_id IN (${shifts.map(() => '?').join(',')})`).all(...shifts.map((x) => x.id))) {
      if (!offers.has(o.shift_id)) offers.set(o.shift_id, []);
      offers.get(o.shift_id).push({ id: o.id, user_id: o.user_id, status: o.status });
    }
    return shifts.map((s) => {
      const list = byShift.get(s.id);
      const out = { ...s, hours: T.shiftHours(s), holiday: T.holidayName(s.date), assigned: list, qual_missing: qualMissing(s, list, rules), verbund: null,
        angebote: offers.get(s.id) || [] };
      if (s.verbund_id) {
        const key = `${s.date}|${s.shift_type_id}|${s.verbund_id}`;
        if (!groups.has(key)) groups.set(key, verbundGroup(s.date, s.shift_type_id, s.verbund_id, rules));
        const g = groups.get(key);
        out.verbund = {
          id: s.verbund_id, name: s.verbund_name, gemeinsam: !!s.verbund_gemeinsam, besetzt: g.besetzt, min: g.min,
          qual_missing: g.qual_missing, gedeckt: g.gedeckt, partner: g.stationen.filter((x) => x.shift_id !== s.id),
        };
      }
      const eigenOk = list.length >= s.min_staff && out.qual_missing.length === 0;
      out.ausgeglichen = !eigenOk && !!(out.verbund && out.verbund.gemeinsam && out.verbund.gedeckt);
      out.unterbesetzt = !eigenOk && !out.ausgeglichen;
      return out;
    });
  };


  /** Abwesenheiten (Urlaub beantragt/genehmigt, Krankheit), die ein Datum abdecken */
  const absenceOn = (userId, date) => db.prepare(`SELECT * FROM absences WHERE user_id = ? AND ? BETWEEN from_date AND to_date
    AND status IN ('beantragt','genehmigt','gemeldet') LIMIT 1`).get(userId, date);

  app.get('/api/plan', auth, wrap((req) => {
    const { from, to } = req.query;
    if (!isoDate(from) || !isoDate(to)) throw new HttpError(400, 'Zeitraum ungültig.');
    const holidays = {};
    for (let t = T.parseDate(from); t <= T.parseDate(to); t += T.DAY) {
      const h = T.holidayName(T.isoDate(t));
      if (h) holidays[T.isoDate(t)] = h;
    }
    const isMgr = hasMgr(req.user);
    const absences = db.prepare(`SELECT a.id, a.user_id, a.type, a.from_date, a.to_date, a.status, u.name FROM absences a
      JOIN users u ON u.id = a.user_id WHERE a.status IN ('beantragt','genehmigt','gemeldet') AND a.from_date <= ? AND a.to_date >= ?
      ${isMgr ? '' : 'AND a.user_id = ?'}`).all(...(isMgr ? [to, from] : [to, from, req.user.id]));
    // Dienstwünsche: Verwaltung sieht alle, Mitarbeitende nur die eigenen
    const wishes = ctx.wishesBetween ? ctx.wishesBetween(from, to).filter((w) => isMgr || w.user_id === req.user.id) : [];
    return { shifts: loadShifts('s.date BETWEEN ? AND ?', [from, to]), holidays, absences, wishes };
  }));

  app.get('/api/my-shifts', auth, wrap((req) => {
    const from = isoDate(req.query.from) ? req.query.from : T.isoDate(nowLocalMs());
    const to = isoDate(req.query.to) ? req.query.to : T.isoDate(T.parseDate(from) + 90 * T.DAY);
    return loadShifts('s.date BETWEEN ? AND ? AND s.id IN (SELECT shift_id FROM assignments WHERE user_id = ?)', [from, to, req.user.id]);
  }));

  app.put('/api/shifts/:id', auth, manager, wrap((req) => {
    const id = Number(req.params.id);
    const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
    if (!s) throw new HttpError(404, 'Schicht nicht gefunden.');
    requireUnit(req, s.unit_id);
    const b = req.body || {};
    const min = 'min_staff' in b ? Number(b.min_staff) : s.min_staff;
    const max = 'max_staff' in b ? (b.max_staff === null || b.max_staff === '' ? null : Number(b.max_staff)) : s.max_staff;
    if (!Number.isInteger(min) || min < 0 || (max !== null && (!Number.isInteger(max) || max < min))) throw new HttpError(400, 'Mindest-/Höchstbesetzung ungültig.');
    const note = 'note' in b ? String(b.note || '').slice(0, 500) : s.note;
    db.prepare('UPDATE shifts SET min_staff = ?, max_staff = ?, note = ? WHERE id = ?').run(min, max, note, id);
    audit(req.user.id, 'shift.update', { id, min, max, note });
    return loadShifts('s.id = ?', [id])[0];
  }));

  app.delete('/api/shifts/:id', auth, manager, wrap((req) => {
    const id = Number(req.params.id);
    const sh = db.prepare('SELECT unit_id FROM shifts WHERE id = ?').get(id);
    if (sh) requireUnit(req, sh.unit_id);
    const n = db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE shift_id = ?').get(id).n;
    if (n > 0 && !req.query.force) throw new HttpError(409, `In dieser Schicht sind ${n} Person(en) eingetragen.`, 'HAS_ASSIGNMENTS');
    db.prepare('DELETE FROM shifts WHERE id = ?').run(id);
    audit(req.user.id, 'shift.delete', { id, assignments: n });
    return { ok: true };
  }));

  /** Prüft Überschneidungen und Ruhezeit (ArbZG § 5 / TVöD) */
  const checkConflicts = (shift, userId, settings) => {
    const iv = T.shiftInterval(shift.date, shift.start_time, shift.end_time);
    const lo = T.isoDate(T.parseDate(shift.date) - 2 * T.DAY);
    const hi = T.isoDate(T.parseDate(shift.date) + 2 * T.DAY);
    const others = db.prepare(`SELECT s.*, u.name AS unit_name, st.code FROM shifts s JOIN assignments a ON a.shift_id = s.id
      JOIN units u ON u.id = s.unit_id JOIN shift_types st ON st.id = s.shift_type_id
      WHERE a.user_id = ? AND s.id <> ? AND s.date BETWEEN ? AND ?`).all(userId, shift.id, lo, hi);
    const restMs = (Number(settings.ruhezeit_std) || 0) * 3600e3;
    for (const o of others) {
      const oi = T.shiftInterval(o.date, o.start_time, o.end_time);
      const label = `${o.code} am ${o.date.split('-').reverse().join('.')} (${o.unit_name})`;
      if (iv.start < oi.end && oi.start < iv.end) return { code: 'UEBERSCHNEIDUNG', message: `Überschneidung mit ${label}.` };
      const gap = iv.start >= oi.end ? iv.start - oi.end : oi.start - iv.end;
      if (gap < restMs) {
        return { code: 'RUHEZEIT', message: `Ruhezeit zu ${label} nur ${(gap / 3600e3).toFixed(1).replace('.', ',')} Std. (mind. ${settings.ruhezeit_std} Std.).` };
      }
    }
    return null;
  };

  /**
   * Arbeitszeitregeln (ArbZG § 3, § 6; Hausregeln): Tages- und Wochenhöchstarbeitszeit,
   * Nachtdienste und Arbeitstage in Folge. Liefert eine Liste von Verstößen (leer = in Ordnung).
   */
  const arbzgCheck = (shift, userId, settings, extraShifts = []) => {
    const out = [];
    const lo = T.isoDate(T.parseDate(shift.date) - 31 * T.DAY), hi = T.isoDate(T.parseDate(shift.date) + 31 * T.DAY);
    const own = db.prepare(`SELECT s.* FROM shifts s JOIN assignments a ON a.shift_id = s.id
      WHERE a.user_id = ? AND s.id <> ? AND s.date BETWEEN ? AND ?`).all(userId, shift.id, lo, hi)
      .concat(extraShifts.filter((x) => x.id !== shift.id));
    const all = [...own, shift];
    const hours = (x) => T.shiftHours(x);
    const fmtH = (x) => String(Math.round(x * 10) / 10).replace('.', ',');
    const maxTag = Number(settings.max_std_tag) || 0;
    if (maxTag) {
      const sum = all.filter((x) => x.date === shift.date).reduce((a, x) => a + hours(x), 0);
      if (sum > maxTag + 1e-9) out.push({ code: 'TAG', message: `Mehr als ${maxTag} Std. Arbeitszeit am ${shift.date.split('-').reverse().join('.')} (${fmtH(sum)} Std.).` });
    }
    const maxWoche = Number(settings.max_std_woche) || 0;
    if (maxWoche) {
      const t0 = T.parseDate(shift.date);
      const mon = T.isoDate(t0 - ((new Date(t0).getUTCDay() + 6) % 7) * T.DAY), sun = T.isoDate(T.parseDate(mon) + 6 * T.DAY);
      const sum = all.filter((x) => x.date >= mon && x.date <= sun).reduce((a, x) => a + hours(x), 0);
      if (sum > maxWoche + 1e-9) out.push({ code: 'WOCHE', message: `Mehr als ${maxWoche} Std. in der Woche ab ${mon.split('-').reverse().join('.')} (${fmtH(sum)} Std.).` });
    }
    const run = (pred) => {
      // längste Folge aufeinanderfolgender Tage (mit pred), die das Datum der neuen Schicht enthält
      const days = new Set(all.filter(pred).map((x) => x.date));
      if (!days.has(shift.date)) return 0;
      let n = 1;
      for (let t = T.parseDate(shift.date) - T.DAY; days.has(T.isoDate(t)); t -= T.DAY) n++;
      for (let t = T.parseDate(shift.date) + T.DAY; days.has(T.isoDate(t)); t += T.DAY) n++;
      return n;
    };
    const maxN = Number(settings.max_naechte_folge) || 0;
    if (maxN) {
      const n = run((x) => T.breakdown(x, settings).nachtschicht);
      if (n > maxN) out.push({ code: 'NAECHTE', message: `${n} Nachtdienste in Folge (höchstens ${maxN}).` });
    }
    const maxT = Number(settings.max_tage_folge) || 0;
    if (maxT) {
      const n = run(() => true);
      if (n > maxT) out.push({ code: 'TAGE', message: `${n} Arbeitstage in Folge (höchstens ${maxT}).` });
    }
    return out;
  };

  const readReason = (req, required) => {
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    if (required && reason.length < 3) throw new HttpError(400, 'Bitte geben Sie eine Begründung an.', 'BEGRUENDUNG');
    return reason;
  };

  app.post('/api/shifts/:id/assign', auth, wrap((req) => {
    const settings = getSettings();
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(Number(req.params.id));
    if (!shift) throw new HttpError(404, 'Schicht nicht gefunden.');
    const isMgr = hasMgr(req.user) && inScope(req.user, shift.unit_id);
    if (hasMgr(req.user) && !isMgr && req.body?.user_id && Number(req.body.user_id) !== req.user.id) requireUnit(req, shift.unit_id);
    const userId = isMgr && req.body?.user_id ? Number(req.body.user_id) : req.user.id;
    const target = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(userId);
    if (!target) throw new HttpError(404, 'Mitarbeiter/in nicht gefunden.');
    if (db.prepare('SELECT 1 FROM assignments WHERE shift_id = ? AND user_id = ?').get(shift.id, userId)) throw new HttpError(409, 'Bereits eingetragen.');
    const reason = readReason(req, !isMgr && settings.begruendung_eintragen);

    const force = isMgr && !!req.body?.force;
    if (!isMgr && T.shiftInterval(shift.date, shift.start_time, shift.end_time).start <= nowLocalMs()) {
      throw new HttpError(400, 'Diese Schicht hat bereits begonnen.');
    }
    const abs = absenceOn(userId, shift.date);
    if (abs) {
      const what = GEMELDET.includes(abs.type) ? (abs.type === 'krank' ? 'krankgemeldet' : 'wegen Kind krank gemeldet') : abs.status === 'beantragt' ? 'mit beantragtem Urlaub eingetragen' : 'im Urlaub / freigestellt';
      throw new HttpError(409, `${isMgr ? target.name + ' ist' : 'Sie sind'} an diesem Tag ${what}.`, 'ABWESEND');
    }
    const count = db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE shift_id = ?').get(shift.id).n;
    if (shift.max_staff !== null && count >= shift.max_staff && !force) {
      throw new HttpError(409, 'Die Schicht ist bereits voll besetzt.', 'VOLL');
    }
    const conflict = checkConflicts(shift, userId, settings);
    if (conflict && (conflict.code === 'UEBERSCHNEIDUNG' || !force)) throw new HttpError(409, conflict.message, conflict.code);
    const regeln = arbzgCheck(shift, userId, settings);
    if (regeln.length && !force) throw new HttpError(409, `Arbeitszeitregel: ${regeln.map((x) => x.message).join(' ')}`, 'ARBZG');

    db.prepare('INSERT INTO assignments (shift_id, user_id, created_by) VALUES (?, ?, ?)').run(shift.id, userId, req.user.id);
    audit(req.user.id, 'assignment.add', { shift_id: shift.id, user_id: userId, force, reason });
    if (userId !== req.user.id) hooks.notify([userId], { titel: 'Neuer Dienst', text: `Sie wurden eingetragen: ${shiftLabel(shift.id)}.`, link: '#mine', art: 'dienst' });
    return loadShifts('s.id = ?', [shift.id])[0];
  }));

  app.delete('/api/shifts/:id/assign', auth, wrap((req) => {
    const settings = getSettings();
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(Number(req.params.id));
    if (!shift) throw new HttpError(404, 'Schicht nicht gefunden.');
    const isMgr = hasMgr(req.user) && inScope(req.user, shift.unit_id);
    if (hasMgr(req.user) && !isMgr && req.query.user_id && Number(req.query.user_id) !== req.user.id) requireUnit(req, shift.unit_id);
    const userId = isMgr && req.query.user_id ? Number(req.query.user_id) : req.user.id;
    if (!db.prepare('SELECT 1 FROM assignments WHERE shift_id = ? AND user_id = ?').get(shift.id, userId)) throw new HttpError(404, 'Nicht eingetragen.');
    const reason = readReason(req, !isMgr && settings.begruendung_austragen);

    if (!isMgr) {
      const start = T.shiftInterval(shift.date, shift.start_time, shift.end_time).start;
      const hoursLeft = (start - nowLocalMs()) / 3600e3;
      if (hoursLeft < Number(settings.austrag_frist_std)) {
        throw new HttpError(400, `Austragen ist nur bis ${settings.austrag_frist_std} Std. vor Dienstbeginn möglich. Bitte wenden Sie sich an die Einsatzplanung.`, 'FRIST');
      }
      const current = loadShifts('s.id = ?', [shift.id])[0];
      if (!settings.austrag_unter_minimum && current.verbund?.gemeinsam) {
        // im Verbund zählt die gemeinsame Besetzung aller verbundenen Stationen
        const g = verbundGroup(shift.date, shift.shift_type_id, current.verbund.id, loadRules(), userId);
        if (g.besetzt < g.min) {
          throw new HttpError(400, `Austragen nicht möglich: Die gemeinsame Mindestbesetzung im ${current.verbund.name} (${g.min}) würde unterschritten. Bitte Ersatz finden oder die Einsatzplanung kontaktieren.`, 'MINIMUM');
        }
        if (g.qual_missing.length > current.verbund.qual_missing.length) {
          const q = g.qual_missing[0];
          throw new HttpError(400, `Austragen nicht möglich: Im ${current.verbund.name} werden mindestens ${q.need}× ${q.qualification} benötigt.`, 'QUALIFIKATION');
        }
      } else if (!settings.austrag_unter_minimum) {
        if (current.assigned.length - 1 < shift.min_staff) {
          throw new HttpError(400, `Austragen nicht möglich: Die Mindestbesetzung (${shift.min_staff}) würde unterschritten. Bitte Ersatz finden oder die Einsatzplanung kontaktieren.`, 'MINIMUM');
        }
        const before = current.qual_missing.length;
        const after = qualMissing(shift, current.assigned, loadRules(), userId);
        if (after.length > before) {
          throw new HttpError(400, `Austragen nicht möglich: Es wird mindestens ${after[0].need}× ${after[0].qualification} benötigt. Bitte Ersatz finden oder die Einsatzplanung kontaktieren.`, 'QUALIFIKATION');
        }
      }
    }
    db.prepare('DELETE FROM assignments WHERE shift_id = ? AND user_id = ?').run(shift.id, userId);
    audit(req.user.id, 'assignment.remove', { shift_id: shift.id, user_id: userId, reason });
    if (userId !== req.user.id) hooks.notify([userId], { titel: 'Dienst gestrichen', text: `Sie wurden ausgetragen: ${shiftLabel(shift.id)}${reason ? ` – ${reason}` : ''}.`, link: '#mine', art: 'dienst' });
    return loadShifts('s.id = ?', [shift.id])[0];
  }));

  /**
   * Umsetzen innerhalb eines Stationsverbunds (gleitendes Aufstocken):
   * Person wechselt in denselben Dienst am selben Tag auf einer verbundenen Station.
   */
  app.post('/api/shifts/:id/move', auth, wrap((req) => {
    const settings = getSettings();
    const from = db.prepare(`SELECT s.*, u.verbund_id, u.name AS unit_name FROM shifts s JOIN units u ON u.id = s.unit_id WHERE s.id = ?`).get(Number(req.params.id));
    const to = db.prepare(`SELECT s.*, u.verbund_id, u.name AS unit_name FROM shifts s JOIN units u ON u.id = s.unit_id WHERE s.id = ?`).get(Number(req.body?.to_shift_id));
    if (!from || !to) throw new HttpError(404, 'Schicht nicht gefunden.');
    const verbund = from.verbund_id ? db.prepare('SELECT * FROM verbuende WHERE id = ? AND active = 1').get(from.verbund_id) : null;
    if (!verbund || to.verbund_id !== from.verbund_id || to.id === from.id || to.date !== from.date || to.shift_type_id !== from.shift_type_id) {
      throw new HttpError(400, 'Umsetzen ist nur in denselben Dienst einer verbundenen Station möglich.', 'KEIN_VERBUND');
    }
    const isMgr = hasMgr(req.user) && inScope(req.user, from.unit_id) && inScope(req.user, to.unit_id);
    if (hasMgr(req.user) && !isMgr && req.body?.user_id && Number(req.body.user_id) !== req.user.id) requireUnit(req, inScope(req.user, from.unit_id) ? to.unit_id : from.unit_id);
    const userId = isMgr && req.body?.user_id ? Number(req.body.user_id) : req.user.id;
    if (!db.prepare('SELECT 1 FROM assignments WHERE shift_id = ? AND user_id = ?').get(from.id, userId)) throw new HttpError(404, 'Person ist in diesem Dienst nicht eingetragen.');
    if (db.prepare('SELECT 1 FROM assignments WHERE shift_id = ? AND user_id = ?').get(to.id, userId)) throw new HttpError(409, 'Bereits auf der anderen Station eingetragen.');
    const force = isMgr && !!req.body?.force;
    if (!isMgr && T.shiftInterval(from.date, from.start_time, from.end_time).start <= nowLocalMs()) throw new HttpError(400, 'Der Dienst hat bereits begonnen.');
    const nTo = db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE shift_id = ?').get(to.id).n;
    if (to.max_staff !== null && nTo >= to.max_staff && !force) throw new HttpError(409, `${to.unit_name} ist in diesem Dienst bereits voll besetzt.`, 'VOLL');
    // ohne gemeinsame Mindestbesetzung darf die abgebende Station nicht unter ihr Minimum fallen (außer Verwaltung)
    if (!verbund.gemeinsam && !isMgr && !settings.austrag_unter_minimum) {
      const nFrom = db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE shift_id = ?').get(from.id).n;
      if (nFrom - 1 < from.min_staff) throw new HttpError(400, `Wechsel nicht möglich: ${from.unit_name} würde unter die Mindestbesetzung fallen.`, 'MINIMUM');
    }
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM assignments WHERE shift_id = ? AND user_id = ?').run(from.id, userId);
      db.prepare('INSERT INTO assignments (shift_id, user_id, created_by) VALUES (?, ?, ?)').run(to.id, userId, req.user.id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    audit(req.user.id, 'assignment.move', { shift_id: to.id, from_shift_id: from.id, user_id: userId, von: from.unit_name, nach: to.unit_name, reason, force });
    if (userId !== req.user.id) hooks.notify([userId], { titel: 'Station gewechselt', text: `Ihr Dienst wurde umgesetzt: ${from.unit_name} → ${to.unit_name}, ${shiftLabel(to.id)}.`, link: '#mine', art: 'dienst' });
    return loadShifts('s.id IN (?, ?)', [from.id, to.id]);
  }));

  /** Protokoll der Ein- und Austragungen mit Begründung */
  app.get('/api/log', auth, manager, wrap((req) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const rows = db.prepare(`SELECT * FROM audit_log WHERE action IN ('assignment.add','assignment.remove','assignment.move','swap.offer','swap.take','swap.done','swap.decide','swap.withdraw','absence.create','absence.decide',
      'absence.update','absence.delete','attachment.upload','user.rights','user.create','unit.create','unit.update','unit.delete','building.create','building.update','building.delete','verbund.create','verbund.update','verbund.delete') ORDER BY id DESC LIMIT ?`).all(limit);
    const userName = new Map(db.prepare('SELECT id, name FROM users').all().map((u) => [u.id, u.name]));
    const shiftInfo = db.prepare(`SELECT s.date, st.code, u.name AS unit_name FROM shifts s JOIN shift_types st ON st.id = s.shift_type_id
      JOIN units u ON u.id = s.unit_id WHERE s.id = ?`);
    return rows.map((r) => {
      const d = JSON.parse(r.details || '{}');
      const shift = d.shift_id ? shiftInfo.get(d.shift_id) : null;
      return {
        id: r.id, at: r.at, action: r.action, actor: userName.get(r.actor_id) || '–',
        person: userName.get(d.user_id) || null, shift, reason: d.reason || d.note || (d.von ? `${d.von} → ${d.nach}` : ''), details: d,
      };
    });
  }));

  // ---------- Urlaub und Krankheit ----------
  const ABS_TYPES = ['urlaub', 'zusatzurlaub', 'sonderurlaub', 'fortbildung', 'elternzeit', 'krank', 'kind_krank'];
  const ABS_LABEL = { urlaub: 'Erholungsurlaub', zusatzurlaub: 'Zusatzurlaub (Schwerbehinderung)', sonderurlaub: 'Sonderurlaub', fortbildung: 'Fortbildung',
    elternzeit: 'Elternzeit', krank: 'Krankheit', kind_krank: 'Kind krank' };
  /** gemeldet statt beantragt (Krankheit des eigenen Kindes wie Krankheit) */
  const GEMELDET = ['krank', 'kind_krank'];
  /** Anrechnung im Zeitkonto: als Arbeitszeit (Entgeltfortzahlung) bzw. Soll-mindernd (unbezahlt) */
  const ANRECHNUNG = { urlaub: 'arbeit', zusatzurlaub: 'arbeit', sonderurlaub: 'arbeit', fortbildung: 'arbeit', krank: 'arbeit', kind_krank: 'neutral', elternzeit: 'neutral' };
  const absenceDays = (a) => (T.parseDate(a.to_date) - T.parseDate(a.from_date)) / T.DAY + 1;
  const auRequired = (a, settings) => a.type === 'krank' && absenceDays(a) >= Number(settings.au_ab_tag || 1);

  const decorateAbsence = (a, settings) => {
    const atts = db.prepare('SELECT id, filename, mime, size, uploaded_at FROM attachments WHERE absence_id = ? ORDER BY id').all(a.id);
    const conflicts = db.prepare(`SELECT COUNT(*) AS n FROM assignments x JOIN shifts s ON s.id = x.shift_id
      WHERE x.user_id = ? AND s.date BETWEEN ? AND ?`).get(a.user_id, a.from_date, a.to_date).n;
    const required = auRequired(a, settings);
    const today = T.isoDate(nowLocalMs());
    // fällig ab dem x-ten Krankheitstag
    const dueDate = T.isoDate(T.parseDate(a.from_date) + (Number(settings.au_ab_tag || 1) - 1) * T.DAY);
    return {
      ...a, kalendertage: absenceDays(a), arbeitstage: T.arbeitstage(a.from_date, a.to_date), attachments: atts,
      au_erforderlich: required, au_faellig_ab: required ? dueDate : null,
      au_fehlt: required && atts.length === 0, au_ueberfaellig: required && atts.length === 0 && today >= dueDate,
      konflikte: conflicts,
    };
  };

  /** Trägt eine Person aus allen Diensten im Zeitraum aus (bei Krankheit / genehmigtem Urlaub) */
  const removeAssignmentsInRange = (userId, from, to, actorId, reason) => {
    const rows = db.prepare(`SELECT x.shift_id FROM assignments x JOIN shifts s ON s.id = x.shift_id
      WHERE x.user_id = ? AND s.date BETWEEN ? AND ?`).all(userId, from, to);
    for (const r of rows) {
      db.prepare('DELETE FROM assignments WHERE shift_id = ? AND user_id = ?').run(r.shift_id, userId);
      audit(actorId, 'assignment.remove', { shift_id: r.shift_id, user_id: userId, reason, automatisch: true });
    }
    return rows.length;
  };

  const urlaubKonto = (u, year, type = 'urlaub', excludeId = 0) => {
    const sum = (status) => db.prepare(`SELECT from_date, to_date FROM absences WHERE user_id = ? AND type = ? AND status = ?
      AND id <> ? AND from_date <= ? AND to_date >= ?`).all(u.id, type, status, excludeId, `${year}-12-31`, `${year}-01-01`)
      .reduce((acc, a) => acc + T.arbeitstage(a.from_date < `${year}-01-01` ? `${year}-01-01` : a.from_date, a.to_date > `${year}-12-31` ? `${year}-12-31` : a.to_date), 0);
    const genehmigt = sum('genehmigt');
    const beantragt = sum('beantragt');
    const anspruch = type === 'zusatzurlaub' ? (u.schwerbehindert ? u.zusatzurlaub_tage : 0) : u.urlaubstage_jahr;
    // Resturlaub aus dem Vorjahr (TVöD § 26 Abs. 2): manuell erfasst oder ab urlaub_auto_ab_jahr automatisch
    const st = getSettings();
    let uebertrag = 0, quelle = '';
    if (type === 'urlaub') {
      const manuell = db.prepare('SELECT tage FROM urlaub_uebertrag WHERE user_id = ? AND jahr = ?').get(u.id, year);
      if (manuell) { uebertrag = manuell.tage; quelle = 'manuell'; } else if (year - 1 >= Number(st.urlaub_auto_ab_jahr || 9999) && !excludeId) {
        const vj = urlaubKonto(u, year - 1, type, -1);
        uebertrag = Math.max(0, vj.anspruch + vj.uebertrag - vj.verfallen - vj.genehmigt);
        quelle = 'automatisch';
      }
    }
    const stichtag = `${year}-${st.urlaub_uebertrag_bis || '03-31'}`;
    let verfallen = 0, genutzt = 0;
    if (uebertrag > 0) {
      // bis zum Stichtag genommener (genehmigter) Urlaub verbraucht zuerst den Übertrag
      genutzt = db.prepare(`SELECT from_date, to_date FROM absences WHERE user_id = ? AND type = ? AND status = 'genehmigt'
        AND from_date <= ? AND to_date >= ?`).all(u.id, type, stichtag, `${year}-01-01`)
        .reduce((acc, a) => acc + T.arbeitstage(a.from_date < `${year}-01-01` ? `${year}-01-01` : a.from_date, a.to_date > stichtag ? stichtag : a.to_date), 0);
      if (T.isoDate(nowLocalMs()) > stichtag) verfallen = Math.max(0, uebertrag - genutzt);
    }
    return {
      jahr: year, anspruch, uebertrag, uebertrag_quelle: quelle, uebertrag_bis: stichtag, verfallen,
      uebertrag_offen: Math.max(0, uebertrag - genutzt - verfallen),
      genehmigt, beantragt, rest: anspruch + uebertrag - verfallen - genehmigt - beantragt,
    };
  };

  /** Übertrag aus dem Vorjahr manuell setzen (z. B. im Einführungsjahr oder bei verlängerter Frist) */
  app.put('/api/users/:id/uebertrag', auth, manager, wrap((req) => {
    const id = Number(req.params.id);
    requireUser(req, id);
    const jahr = Number(req.body?.jahr);
    if (!Number.isInteger(jahr) || jahr < 2000 || jahr > 2100) throw new HttpError(400, 'Jahr ungültig.');
    if (req.body.tage === null || req.body.tage === '') {
      db.prepare('DELETE FROM urlaub_uebertrag WHERE user_id = ? AND jahr = ?').run(id, jahr);
    } else {
      const tage = Number(req.body.tage);
      if (!Number.isFinite(tage) || tage < 0 || tage > 100) throw new HttpError(400, 'Tage ungültig.');
      db.prepare(`INSERT INTO urlaub_uebertrag (user_id, jahr, tage) VALUES (?, ?, ?)
        ON CONFLICT(user_id, jahr) DO UPDATE SET tage = excluded.tage`).run(id, jahr, tage);
    }
    audit(req.user.id, 'urlaub.uebertrag', { user_id: id, jahr, tage: req.body.tage });
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return urlaubKonto(u, jahr);
  }));

  const loadAbsence = (req) => {
    const a = db.prepare('SELECT * FROM absences WHERE id = ?').get(Number(req.params.id));
    if (!a || (!hasMgr(req.user) && a.user_id !== req.user.id)) throw new HttpError(404, 'Eintrag nicht gefunden.');
    return a;
  };

  app.get('/api/absences', auth, wrap((req) => {
    const settings = getSettings();
    // „mine“: eigene Ansicht, auch für Verwalter/innen, die selbst im Dienst arbeiten
    const isMgr = hasMgr(req.user) && !req.query.mine;
    const cond = [];
    const params = [];
    let kontoUser = null;
    if (!isMgr) {
      cond.push('a.user_id = ?'); params.push(req.user.id); kontoUser = req.user;
    } else if (req.query.user_id) {
      cond.push('a.user_id = ?'); params.push(Number(req.query.user_id));
      kontoUser = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.query.user_id)) || null;
    }
    if (isoDate(req.query.from)) { cond.push('a.to_date >= ?'); params.push(req.query.from); }
    if (isoDate(req.query.to)) { cond.push('a.from_date <= ?'); params.push(req.query.to); }
    if (req.query.status) { cond.push('a.status = ?'); params.push(String(req.query.status)); }
    const rows = db.prepare(`SELECT a.*, u.name, u.qualification FROM absences a JOIN users u ON u.id = a.user_id
      ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY a.from_date DESC, a.id DESC LIMIT 500`).all(...params);
    const year = Number(req.query.year) || Number(T.isoDate(nowLocalMs()).slice(0, 4));
    return {
      absences: rows.map((a) => decorateAbsence(a, settings)),
      urlaub: kontoUser ? urlaubKonto(kontoUser, year) : null,
      zusatzurlaub: kontoUser && kontoUser.schwerbehindert ? urlaubKonto(kontoUser, year, 'zusatzurlaub') : null,
      au_ab_tag: settings.au_ab_tag,
    };
  }));

  app.post('/api/absences', auth, wrap((req) => {
    const settings = getSettings();
    const b = req.body || {};
    const isMgr = hasMgr(req.user);
    const userId = isMgr && b.user_id ? Number(b.user_id) : req.user.id;
    if (userId !== req.user.id) requireUser(req, userId);
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(userId);
    if (!u) throw new HttpError(404, 'Mitarbeiter/in nicht gefunden.');
    if (!ABS_TYPES.includes(b.type)) throw new HttpError(400, 'Unbekannte Art der Abwesenheit.');
    if (b.type === 'zusatzurlaub' && !u.schwerbehindert) {
      throw new HttpError(400, 'Zusatzurlaub nach § 208 SGB IX ist nur bei hinterlegter Schwerbehinderung möglich. Bitte wenden Sie sich an die Einsatzplanung.');
    }
    if (!isoDate(b.from) || !isoDate(b.to) || b.from > b.to) throw new HttpError(400, 'Zeitraum ungültig.');
    if ((T.parseDate(b.to) - T.parseDate(b.from)) / T.DAY > 366) throw new HttpError(400, 'Zeitraum zu lang.');
    const today = T.isoDate(nowLocalMs());
    if (!isMgr) {
      if (!GEMELDET.includes(b.type) && b.from < today) throw new HttpError(400, 'Urlaub kann nicht rückwirkend beantragt werden.');
      if (GEMELDET.includes(b.type) && T.parseDate(today) - T.parseDate(b.from) > 14 * T.DAY) throw new HttpError(400, 'Krankmeldungen bitte innerhalb von 14 Tagen eintragen, sonst über die Einsatzplanung.');
    }
    const overlap = db.prepare(`SELECT * FROM absences WHERE user_id = ? AND status IN ('beantragt','genehmigt','gemeldet')
      AND from_date <= ? AND to_date >= ?`).get(userId, b.to, b.from);
    if (overlap) throw new HttpError(409, `Im Zeitraum gibt es bereits einen Eintrag (${ABS_LABEL[overlap.type]} ${overlap.from_date} – ${overlap.to_date}).`, 'UEBERSCHNEIDUNG');
    const note = String(b.note || '').trim().slice(0, 500);
    if (!GEMELDET.includes(b.type)) {
      const tage = T.arbeitstage(b.from, b.to);
      if (tage === 0) throw new HttpError(400, 'Im gewählten Zeitraum liegen keine Arbeitstage.');
      if (b.type === 'sonderurlaub' && note.length < 3) throw new HttpError(400, 'Bitte den Anlass des Sonderurlaubs angeben (z. B. Umzug, Hochzeit).', 'BEGRUENDUNG');
      if (b.type === 'fortbildung' && note.length < 3) throw new HttpError(400, 'Bitte Thema bzw. Veranstaltung der Fortbildung angeben.', 'BEGRUENDUNG');
      if (!isMgr && (b.type === 'urlaub' || b.type === 'zusatzurlaub')) {
        if (b.from.slice(0, 4) !== b.to.slice(0, 4)) throw new HttpError(400, 'Bitte Urlaub über den Jahreswechsel in zwei Anträgen stellen.');
        const konto = urlaubKonto(u, Number(b.from.slice(0, 4)), b.type);
        if (tage > konto.rest) {
          throw new HttpError(400, `Nicht genügend ${ABS_LABEL[b.type]}: beantragt ${tage} Tage, verfügbar ${konto.rest} Tage.`, 'KONTINGENT');
        }
      }
    }
    // Eigene Anträge von Verwalter/innen werden ebenfalls beantragt (Vier-Augen-Prinzip)
    const status = GEMELDET.includes(b.type) ? 'gemeldet' : (isMgr && userId !== req.user.id ? 'genehmigt' : 'beantragt');
    const id = db.prepare(`INSERT INTO absences (user_id, type, from_date, to_date, status, note, created_by, decided_by, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, b.type, b.from, b.to, status, note, req.user.id,
      status === 'genehmigt' ? req.user.id : null, status === 'genehmigt' ? new Date().toISOString() : null).lastInsertRowid;
    let removed = 0;
    if (status !== 'beantragt') {
      removed = removeAssignmentsInRange(userId, b.from, b.to, req.user.id, GEMELDET.includes(b.type) ? ABS_LABEL[b.type] : `${ABS_LABEL[b.type]} genehmigt`);
    }
    audit(req.user.id, 'absence.create', { id, user_id: userId, type: b.type, from: b.from, to: b.to, status, note, removed });
    {
      const zeitraum = `${b.from.split('-').reverse().join('.')} – ${b.to.split('-').reverse().join('.')}`;
      if (userId === req.user.id) {
        const was = GEMELDET.includes(b.type) ? (b.type === 'krank' ? 'Krankmeldung' : 'Kind krank') : `Antrag: ${ABS_LABEL[b.type]}`;
        hooks.notify(managerIds().filter((x) => x !== userId), { titel: was, text: `${u.name}: ${zeitraum}${removed ? ` (${removed} Dienst(e) ausgetragen)` : ''}`, link: '#abwesenheiten', art: 'abwesenheit' });
      } else {
        hooks.notify([userId], { titel: `${ABS_LABEL[b.type]} eingetragen`, text: `Die Verwaltung hat für Sie eingetragen: ${zeitraum}.`, link: '#abwesenheit', art: 'abwesenheit' });
      }
    }
    const a = db.prepare('SELECT a.*, u.name FROM absences a JOIN users u ON u.id = a.user_id WHERE a.id = ?').get(id);
    return { ...decorateAbsence(a, settings), removed };
  }));

  /** Genehmigen / Ablehnen eines Urlaubsantrags */
  app.put('/api/absences/:id/decision', auth, manager, wrap((req) => {
    const settings = getSettings();
    const a = loadAbsence(req);
    if (GEMELDET.includes(a.type)) throw new HttpError(400, 'Krankmeldungen werden nicht genehmigt.');
    requireUser(req, a.user_id);
    if (a.user_id === req.user.id) throw new HttpError(403, 'Eigene Anträge muss eine andere Verwaltung genehmigen.');
    const status = req.body?.status;
    if (!['genehmigt', 'abgelehnt'].includes(status)) throw new HttpError(400, 'Status ungültig.');
    const note = String(req.body?.note || '').trim().slice(0, 500);
    if (status === 'abgelehnt' && note.length < 3) throw new HttpError(400, 'Bitte eine Begründung für die Ablehnung angeben.', 'BEGRUENDUNG');
    db.prepare('UPDATE absences SET status = ?, decision_note = ?, decided_by = ?, decided_at = ? WHERE id = ?')
      .run(status, note, req.user.id, new Date().toISOString(), a.id);
    const removed = status === 'genehmigt' ? removeAssignmentsInRange(a.user_id, a.from_date, a.to_date, req.user.id, `${ABS_LABEL[a.type]} genehmigt`) : 0;
    audit(req.user.id, 'absence.decide', { id: a.id, user_id: a.user_id, status, note, removed });
    hooks.notify([a.user_id], { titel: `${ABS_LABEL[a.type]} ${status}`, art: 'abwesenheit', link: '#abwesenheit',
      text: `${a.from_date.split('-').reverse().join('.')} – ${a.to_date.split('-').reverse().join('.')}${note ? `: ${note}` : ''}${removed ? ` · ${removed} Dienst(e) ausgetragen` : ''}` });
    const fresh = db.prepare('SELECT a.*, u.name FROM absences a JOIN users u ON u.id = a.user_id WHERE a.id = ?').get(a.id);
    return { ...decorateAbsence(fresh, settings), removed };
  }));

  /** Krankmeldung verlängern / verkürzen (Mitarbeitende: nur eigene Krankmeldung) */
  app.put('/api/absences/:id', auth, wrap((req) => {
    const settings = getSettings();
    const a = loadAbsence(req);
    const isMgr = hasMgr(req.user) && userInScope(req.user, a.user_id);
    if (!isMgr && a.user_id !== req.user.id) throw new HttpError(403, 'Diese Person gehört nicht zu Ihrem Verwaltungsbereich.', 'BEREICH');
    if (!isMgr && !GEMELDET.includes(a.type)) throw new HttpError(403, 'Urlaubsanträge können nur zurückgezogen werden.');
    const to = req.body?.to;
    const from = isMgr && isoDate(req.body?.from) ? req.body.from : a.from_date;
    if (!isoDate(to) || to < from) throw new HttpError(400, 'Enddatum ungültig.');
    const overlap = db.prepare(`SELECT 1 FROM absences WHERE user_id = ? AND id <> ? AND status IN ('beantragt','genehmigt','gemeldet')
      AND from_date <= ? AND to_date >= ?`).get(a.user_id, a.id, to, from);
    if (overlap) throw new HttpError(409, 'Der neue Zeitraum überschneidet sich mit einem anderen Eintrag.');
    db.prepare('UPDATE absences SET from_date = ?, to_date = ? WHERE id = ?').run(from, to, a.id);
    let removed = 0;
    if (a.status !== 'beantragt' && a.status !== 'abgelehnt') {
      removed = removeAssignmentsInRange(a.user_id, from, to, req.user.id, GEMELDET.includes(a.type) ? `${ABS_LABEL[a.type]} verlängert` : 'Urlaub geändert');
    }
    audit(req.user.id, 'absence.update', { id: a.id, user_id: a.user_id, from, to, removed });
    const fresh = db.prepare('SELECT a.*, u.name FROM absences a JOIN users u ON u.id = a.user_id WHERE a.id = ?').get(a.id);
    return { ...decorateAbsence(fresh, settings), removed };
  }));

  app.delete('/api/absences/:id', auth, wrap((req) => {
    const a = loadAbsence(req);
    const isMgr = hasMgr(req.user) && userInScope(req.user, a.user_id);
    if (!isMgr && a.user_id !== req.user.id) throw new HttpError(403, 'Diese Person gehört nicht zu Ihrem Verwaltungsbereich.', 'BEREICH');
    if (!isMgr && !(!GEMELDET.includes(a.type) && a.status === 'beantragt')) {
      throw new HttpError(403, 'Nur noch nicht entschiedene Urlaubsanträge können zurückgezogen werden. Bitte wenden Sie sich an die Einsatzplanung.');
    }
    for (const f of db.prepare('SELECT stored_name FROM attachments WHERE absence_id = ?').all(a.id)) {
      fs.rmSync(path.join(uploadDir, f.stored_name), { force: true });
    }
    db.prepare('DELETE FROM absences WHERE id = ?').run(a.id);
    audit(req.user.id, 'absence.delete', { id: a.id, user_id: a.user_id, type: a.type, from: a.from_date, to: a.to_date });
    return { ok: true };
  }));

  // ---------- Arbeitsunfähigkeitsbescheinigung (Upload) ----------
  const MAX_UPLOAD = 10 * 1024 * 1024;
  const sniffMime = (buf) => {
    if (buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    return null;
  };

  app.post('/api/absences/:id/attachments', auth, express.raw({ type: () => true, limit: MAX_UPLOAD }), wrap((req) => {
    const a = loadAbsence(req);
    if (!GEMELDET.includes(a.type)) throw new HttpError(400, 'Bescheinigungen können nur zu Krankmeldungen hochgeladen werden.');
    if (a.user_id !== req.user.id) requireUser(req, a.user_id);
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buf.length) throw new HttpError(400, 'Keine Datei empfangen.');
    const mime = sniffMime(buf);
    if (!mime) throw new HttpError(400, 'Erlaubt sind PDF, JPG und PNG.');
    if (db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE absence_id = ?').get(a.id).n >= 10) throw new HttpError(400, 'Maximal 10 Dateien je Krankmeldung.');
    let filename = '';
    try { filename = decodeURIComponent(String(req.headers['x-filename'] || '')); } catch { filename = ''; }
    filename = filename.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120) || `bescheinigung.${mime.split('/')[1]}`;
    const stored = `${crypto.randomUUID()}.${mime === 'application/pdf' ? 'pdf' : mime.split('/')[1]}`;
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.writeFileSync(path.join(uploadDir, stored), buf, { mode: 0o600 });
    const id = db.prepare('INSERT INTO attachments (absence_id, filename, stored_name, mime, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(a.id, filename, stored, mime, buf.length, req.user.id).lastInsertRowid;
    audit(req.user.id, 'attachment.upload', { id, absence_id: a.id, user_id: a.user_id, filename });
    const fresh = db.prepare('SELECT a.*, u.name FROM absences a JOIN users u ON u.id = a.user_id WHERE a.id = ?').get(a.id);
    return decorateAbsence(fresh, getSettings());
  }));

  const loadAttachment = (req) => {
    const f = db.prepare('SELECT f.*, a.user_id FROM attachments f JOIN absences a ON a.id = f.absence_id WHERE f.id = ?').get(Number(req.params.id));
    if (!f || (!hasMgr(req.user) && f.user_id !== req.user.id)) throw new HttpError(404, 'Datei nicht gefunden.');
    return f;
  };

  app.get('/api/attachments/:id', auth, (req, res, next) => {
    try {
      const f = loadAttachment(req);
      res.setHeader('Content-Type', f.mime);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Disposition', `${req.query.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
      res.sendFile(path.join(uploadDir, f.stored_name), (err) => { if (err && !res.headersSent) next(new HttpError(404, 'Datei fehlt.')); });
    } catch (e) { next(e); }
  });

  app.delete('/api/attachments/:id', auth, wrap((req) => {
    const f = loadAttachment(req);
    if (!hasMgr(req.user) && f.uploaded_by !== req.user.id) throw new HttpError(403, 'Nicht erlaubt.');
    if (f.user_id !== req.user.id) requireUser(req, f.user_id);
    fs.rmSync(path.join(uploadDir, f.stored_name), { force: true });
    db.prepare('DELETE FROM attachments WHERE id = ?').run(f.id);
    audit(req.user.id, 'attachment.delete', { id: f.id, absence_id: f.absence_id });
    return { ok: true };
  }));

  // ---------- Auswertung / Zeitkonto nach TVöD ----------
  const report = (month, userFilter) => {
    if (!/^\d{4}-\d{2}$/.test(month || '')) throw new HttpError(400, 'Monat im Format JJJJ-MM angeben.');
    const settings = getSettings();
    const [y, m] = month.split('-').map(Number);
    const from = `${month}-01`;
    const to = T.isoDate(Date.UTC(y, m, 0));
    const users = userFilter
      ? db.prepare('SELECT * FROM users WHERE id = ?').all(userFilter)
      : db.prepare("SELECT * FROM users WHERE role = 'staff' AND active = 1 ORDER BY name").all();
    const r2 = (x) => Math.round(x * 100) / 100;
    const rows = users.map((u) => {
      const shifts = db.prepare(`SELECT s.* FROM shifts s JOIN assignments a ON a.shift_id = s.id
        WHERE a.user_id = ? AND s.date BETWEEN ? AND ?`).all(u.id, from, to);
      const sum = { stunden: 0, nacht: 0, samstag: 0, sonntag: 0, feiertag: 0, vorfest: 0 };
      let nachtschichten = 0, euro = 0;
      const beginne = new Set();
      for (const s of shifts) {
        beginne.add(s.start_time);
        const b = T.breakdown(s, settings);
        for (const k of Object.keys(sum)) sum[k] += b[k];
        if (b.nachtschicht) nachtschichten++;
        euro += T.zuschlagEuro(b, settings, u.stundenentgelt);
      }
      // Urlaub (genehmigt) und Krankheit: je Arbeitstag 1/5 der Wochenarbeitszeit (§ 6 Abs. 3, § 21 TVöD, vereinfacht)
      const abs = db.prepare(`SELECT * FROM absences WHERE user_id = ? AND status IN ('genehmigt','gemeldet')
        AND from_date <= ? AND to_date >= ?`).all(u.id, to, from);
      let urlaubTage = 0, sonderTage = 0, krankTage = 0, fortbildungTage = 0, neutralTage = 0, auFehlt = 0;
      for (const a of abs) {
        const tage = T.arbeitstage(a.from_date < from ? from : a.from_date, a.to_date > to ? to : a.to_date);
        if (ANRECHNUNG[a.type] === 'neutral') neutralTage += tage; // Kind krank, Elternzeit: unbezahlt, Soll sinkt
        else if (a.type === 'krank') krankTage += tage;
        else if (a.type === 'sonderurlaub') sonderTage += tage;
        else if (a.type === 'fortbildung') fortbildungTage += tage;
        else urlaubTage += tage; // Erholungs- und Zusatzurlaub
        if (auRequired(a, settings) && !db.prepare('SELECT 1 FROM attachments WHERE absence_id = ?').get(a.id)) auFehlt++;
      }
      const perDay = (Number(u.weekly_hours) || 0) / 5;
      const urlaubStd = urlaubTage * perDay;
      const krankStd = krankTage * perDay;
      const sonderStd = sonderTage * perDay;
      const fortbildungStd = fortbildungTage * perDay;
      const ist = sum.stunden + urlaubStd + krankStd + sonderStd + fortbildungStd;
      const soll = Math.max(0, T.sollStunden(y, m, u.weekly_hours) - neutralTage * perDay);
      // Zulagen nach TVöD § 8 Abs. 5/6 (vereinfacht): Wechselschicht = mind. x Nachtschichten im Monat und wechselnde Dienste;
      // Schichtarbeit = Dienste mit unterschiedlichen Anfangszeiten
      let zulage = '', zulageEur = 0;
      if (nachtschichten >= Number(settings.wechselschicht_min_naechte || 2) && beginne.size >= 2) {
        zulage = 'Wechselschicht'; zulageEur = Number(settings.zulage_wechselschicht_eur) || 0;
      } else if (beginne.size >= 2) {
        zulage = 'Schicht'; zulageEur = Number(settings.zulage_schicht_eur) || 0;
      }
      return {
        zulage, zulage_eur: zulageEur,
        user_id: u.id, name: u.name, qualification: u.qualification, weekly_hours: u.weekly_hours,
        min_hours_month: u.min_hours_month, dienste: shifts.length, nachtschichten,
        gearbeitet: r2(sum.stunden), urlaub_tage: urlaubTage, urlaub_std: r2(urlaubStd), krank_tage: krankTage, krank_std: r2(krankStd),
        sonder_tage: sonderTage, sonder_std: r2(sonderStd), fortbildung_tage: fortbildungTage, fortbildung_std: r2(fortbildungStd),
        unbezahlt_tage: neutralTage, au_fehlt: auFehlt, soll: r2(soll), ist: r2(ist), saldo: r2(ist - soll),
        nacht: r2(sum.nacht), samstag: r2(sum.samstag), sonntag: r2(sum.sonntag), feiertag: r2(sum.feiertag), vorfest: r2(sum.vorfest),
        zuschlag_eur: r2(euro), min_erfuellt: ist + 1e-9 >= (u.min_hours_month || 0),
      };
    });
    const understaffed = userFilter ? [] : loadShifts('s.date BETWEEN ? AND ?', [from, to])
      .filter((s) => s.unterbesetzt)
      .map((s) => ({
        id: s.id, date: s.date, unit_name: s.unit_name, code: s.type_code, besetzt: s.assigned.length, min_staff: s.min_staff,
        fehlt: s.qual_missing.map((q) => `${q.need - q.have}× ${q.qualification}`).join(', '),
      }));
    return { month, from, to, rows, understaffed };
  };

  app.get('/api/report', auth, wrap((req) => {
    const isMgr = hasMgr(req.user);
    return report(req.query.month, isMgr ? (req.query.user_id ? Number(req.query.user_id) : null) : req.user.id);
  }));

  app.get('/api/report.csv', auth, manager, wrap((req, res) => {
    const r = report(req.query.month, null);
    const num = (x) => String(x).replace('.', ',');
    const head = ['Name', 'Qualifikation', 'Wochenstd.', 'Soll', 'Gearbeitet', 'Urlaubstage', 'Urlaub Std.', 'Krankheitstage', 'Krank Std.',
      'Sonderurlaub Tage', 'Sonderurlaub Std.', 'Ist gesamt', 'Saldo', 'Mindeststd.', 'Mindeststd. erfüllt', 'Dienste', 'Nachtschichten', 'Nacht-Std.', 'Samstag-Std.',
      'Sonntag-Std.', 'Feiertag-Std.', 'Vorfest-Std.', 'Zuschläge EUR', 'Zulage', 'Zulage EUR', 'AU fehlt'];
    const lines = [head, ...r.rows.map((x) => [x.name, x.qualification, num(x.weekly_hours), num(x.soll), num(x.gearbeitet),
      x.urlaub_tage, num(x.urlaub_std), x.krank_tage, num(x.krank_std), x.sonder_tage, num(x.sonder_std), num(x.ist), num(x.saldo),
      num(x.min_hours_month), x.min_erfuellt ? 'ja' : 'nein', x.dienste, x.nachtschichten, num(x.nacht), num(x.samstag),
      num(x.sonntag), num(x.feiertag), num(x.vorfest), num(x.zuschlag_eur), x.zulage, num(x.zulage_eur), x.au_fehlt])];
    const csv = '﻿' + lines.map((l) => l.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="zeitkonto-${r.month}.csv"`);
    res.send(csv);
  }));

  // ---------- Erweiterungen in eigenen Dateien (src/routes/*.js) ----------
  // Jedes Modul erhält den App-Router und gemeinsame Hilfsfunktionen.
  const ctx = {
    db, T, TOTP, HttpError, auth, manager, wrap, audit, getSettings, isoDate, isTime, nowLocalMs, todayIso,
    hasMgr, isHaupt, publicUser, loadShifts, loadRules, qualMissing, verbundGroup, checkConflicts, absenceOn, uploadDir, express,
    hooks, shiftLabel, managerIds, decorateAbsence, timers: opts.timers !== false,
    scopeOf, inScope, userInScope, requireUnit, requireUser, managerFull, arbzgCheck,
  };
  for (const name of fs.readdirSync(path.join(__dirname, 'routes')).filter((f) => f.endsWith('.js')).sort()) {
    require(path.join(__dirname, 'routes', name))(app, ctx);
  }

  // ---------- Fehlerbehandlung ----------
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Unbekannter Endpunkt.')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Interner Fehler.' : err.message, code: err.code });
  });

  const root = express();
  root.disable('x-powered-by');
  if (base) {
    // /LWL → /LWL/ (damit relative Pfade stimmen); Startseite der Domain → Dienstplan
    root.use((req, res, next) => {
      if (req.path === base || req.path === '/') return res.redirect(302, `${base}/`);
      // andere Schreibweise (z. B. /LWL statt /lwl) auf die eingerichtete umleiten,
      // sonst passt das Anmelde-Cookie nicht
      const lower = req.path.toLowerCase();
      const b = base.toLowerCase();
      if ((lower === b || lower.startsWith(`${b}/`)) && !req.path.startsWith(base)) {
        const rest = req.originalUrl.slice(base.length);
        return res.redirect(301, `${base}${rest === '' ? '/' : rest}`);
      }
      next();
    });
    root.use(base, app);
  } else {
    root.use(app);
  }
  return root;
}

module.exports = { createApp };
