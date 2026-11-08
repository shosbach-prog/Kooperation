'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { hashPassword, verifyPassword, DEFAULT_SETTINGS } = require('./db');
const T = require('./tvoed');

const SESSION_HOURS = 12;

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---------- Hilfsfunktionen ----------
  const getSettings = () => {
    const out = { ...DEFAULT_SETTINGS };
    for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = JSON.parse(row.value);
    return out;
  };

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

  // ---------- Authentifizierung ----------
  app.use((req, _res, next) => {
    const token = parseCookies(req).sid;
    if (token) {
      const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND s.expires > ? AND u.active = 1`).get(token, Date.now());
      if (row) { req.user = row; req.token = token; }
    }
    next();
  });

  const auth = (req, _res, next) => (req.user ? next() : next(new HttpError(401, 'Bitte anmelden.')));
  const manager = (req, _res, next) => (req.user?.role === 'manager' ? next() : next(new HttpError(403, 'Nur für die Einsatzplanung (Manager).')));

  const publicUser = (u) => ({
    id: u.id, name: u.name, username: u.username, role: u.role, qualification: u.qualification,
    weekly_hours: u.weekly_hours, min_hours_month: u.min_hours_month, stundenentgelt: u.stundenentgelt, active: !!u.active,
  });

  app.post('/api/login', wrap((req, res) => {
    const { username, password } = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username || '').trim().toLowerCase());
    if (!u || !verifyPassword(password, u.password_hash)) throw new HttpError(401, 'Benutzername oder Passwort falsch.');
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    db.prepare('INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)').run(token, u.id, Date.now() + SESSION_HOURS * 3600e3);
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`);
    return { user: publicUser(u) };
  }));

  app.post('/api/logout', wrap((req, res) => {
    if (req.token) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
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
  app.put('/api/settings', auth, manager, wrap((req) => {
    const upd = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
      if (!(k in (req.body || {}))) continue;
      let v = req.body[k];
      if (typeof def === 'number') { v = Number(v); if (!Number.isFinite(v) || v < 0) throw new HttpError(400, `Ungültiger Wert für ${k}.`); }
      if (typeof def === 'boolean') v = !!v;
      if (typeof def === 'string') { v = String(v); if (k.startsWith('nacht_') && !isTime(v)) throw new HttpError(400, `Ungültige Uhrzeit für ${k}.`); }
      upd.run(k, JSON.stringify(v));
    }
    audit(req.user.id, 'settings.update', req.body);
    return getSettings();
  }));

  // ---------- Mitarbeitende ----------
  app.get('/api/users', auth, manager, wrap(() => db.prepare('SELECT * FROM users ORDER BY active DESC, role, name').all().map(publicUser)));

  const userFields = (b, partial) => {
    const out = {};
    if (!partial || 'name' in b) { if (!String(b.name || '').trim()) throw new HttpError(400, 'Name fehlt.'); out.name = String(b.name).trim(); }
    if (!partial || 'username' in b) {
      const un = String(b.username || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,}$/.test(un)) throw new HttpError(400, 'Benutzername: mind. 3 Zeichen (a–z, 0–9, . _ -).');
      out.username = un;
    }
    if ('role' in b || !partial) { out.role = b.role === 'manager' ? 'manager' : 'staff'; }
    for (const k of ['qualification']) if (k in b) out[k] = String(b[k] || '');
    for (const k of ['weekly_hours', 'min_hours_month', 'stundenentgelt']) {
      if (k in b) { const v = Number(b[k]); if (!Number.isFinite(v) || v < 0) throw new HttpError(400, `Ungültiger Wert: ${k}`); out[k] = v; }
    }
    if ('active' in b) out.active = b.active ? 1 : 0;
    return out;
  };

  app.post('/api/users', auth, manager, wrap((req) => {
    const f = userFields(req.body || {}, false);
    const pw = req.body.password;
    if (!pw || String(pw).length < 6) throw new HttpError(400, 'Startpasswort: mind. 6 Zeichen.');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(f.username)) throw new HttpError(409, 'Benutzername ist bereits vergeben.');
    const id = db.prepare(`INSERT INTO users (name, username, password_hash, role, qualification, weekly_hours, min_hours_month, stundenentgelt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(f.name, f.username, hashPassword(pw), f.role, f.qualification || '',
      f.weekly_hours ?? getSettings().wochenstunden_standard, f.min_hours_month ?? 0, f.stundenentgelt ?? 0).lastInsertRowid;
    audit(req.user.id, 'user.create', { id, username: f.username });
    return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  }));

  app.put('/api/users/:id', auth, manager, wrap((req) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!existing) throw new HttpError(404, 'Nicht gefunden.');
    const f = userFields(req.body || {}, true);
    if (f.username && db.prepare('SELECT 1 FROM users WHERE username = ? AND id <> ?').get(f.username, id)) throw new HttpError(409, 'Benutzername ist bereits vergeben.');
    if (id === req.user.id && (f.active === 0 || f.role === 'staff')) throw new HttpError(400, 'Sie können sich nicht selbst deaktivieren oder herabstufen.');
    const keys = Object.keys(f);
    if (keys.length) db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => f[k]), id);
    if (req.body.password) {
      if (String(req.body.password).length < 6) throw new HttpError(400, 'Passwort: mind. 6 Zeichen.');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    if (f.active === 0) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    audit(req.user.id, 'user.update', { id, fields: keys, password: !!req.body.password });
    return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  }));

  // ---------- Bereiche / Stationen ----------
  app.get('/api/units', auth, wrap(() => db.prepare('SELECT * FROM units ORDER BY active DESC, name').all()));
  app.post('/api/units', auth, manager, wrap((req) => {
    const name = String(req.body?.name || '').trim();
    if (!name) throw new HttpError(400, 'Name fehlt.');
    const id = db.prepare('INSERT INTO units (name) VALUES (?)').run(name).lastInsertRowid;
    return db.prepare('SELECT * FROM units WHERE id = ?').get(id);
  }));
  app.put('/api/units/:id', auth, manager, wrap((req) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT * FROM units WHERE id = ?').get(id);
    if (!u) throw new HttpError(404, 'Nicht gefunden.');
    const name = 'name' in req.body ? String(req.body.name).trim() : u.name;
    if (!name) throw new HttpError(400, 'Name fehlt.');
    const active = 'active' in req.body ? (req.body.active ? 1 : 0) : u.active;
    db.prepare('UPDATE units SET name = ?, active = ? WHERE id = ?').run(name, active, id);
    return db.prepare('SELECT * FROM units WHERE id = ?').get(id);
  }));

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

  app.post('/api/shift-types', auth, manager, wrap((req) => {
    const f = shiftTypeFields(req.body || {});
    const id = db.prepare('INSERT INTO shift_types (name, code, start_time, end_time, break_min, color, active) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(f.name, f.code, f.start_time, f.end_time, f.break_min, f.color, f.active).lastInsertRowid;
    audit(req.user.id, 'shift_type.create', { id, ...f });
    return db.prepare('SELECT * FROM shift_types WHERE id = ?').get(id);
  }));

  app.put('/api/shift-types/:id', auth, manager, wrap((req) => {
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
      : db.prepare('SELECT id FROM units WHERE active = 1').all().map((u) => u.id);
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

  const loadShifts = (where, params) => {
    const shifts = db.prepare(`SELECT s.*, st.name AS type_name, st.code AS type_code, st.color AS type_color, u.name AS unit_name
      FROM shifts s JOIN shift_types st ON st.id = s.shift_type_id JOIN units u ON u.id = s.unit_id
      WHERE ${where} ORDER BY s.date, s.start_time, u.name`).all(...params);
    if (!shifts.length) return [];
    const ids = shifts.map((s) => s.id);
    const assigned = db.prepare(`SELECT a.shift_id, us.id AS user_id, us.name, us.qualification FROM assignments a
      JOIN users us ON us.id = a.user_id WHERE a.shift_id IN (${ids.map(() => '?').join(',')}) ORDER BY us.name`).all(...ids);
    const byShift = new Map(ids.map((id) => [id, []]));
    for (const a of assigned) byShift.get(a.shift_id).push({ user_id: a.user_id, name: a.name, qualification: a.qualification });
    return shifts.map((s) => ({ ...s, hours: T.shiftHours(s), holiday: T.holidayName(s.date), assigned: byShift.get(s.id) }));
  };

  app.get('/api/plan', auth, wrap((req) => {
    const { from, to } = req.query;
    if (!isoDate(from) || !isoDate(to)) throw new HttpError(400, 'Zeitraum ungültig.');
    const holidays = {};
    for (let t = T.parseDate(from); t <= T.parseDate(to); t += T.DAY) {
      const h = T.holidayName(T.isoDate(t));
      if (h) holidays[T.isoDate(t)] = h;
    }
    return { shifts: loadShifts('s.date BETWEEN ? AND ?', [from, to]), holidays };
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

  app.post('/api/shifts/:id/assign', auth, wrap((req) => {
    const settings = getSettings();
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(Number(req.params.id));
    if (!shift) throw new HttpError(404, 'Schicht nicht gefunden.');
    const isMgr = req.user.role === 'manager';
    const userId = isMgr && req.body?.user_id ? Number(req.body.user_id) : req.user.id;
    const target = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(userId);
    if (!target) throw new HttpError(404, 'Mitarbeiter/in nicht gefunden.');
    if (db.prepare('SELECT 1 FROM assignments WHERE shift_id = ? AND user_id = ?').get(shift.id, userId)) throw new HttpError(409, 'Bereits eingetragen.');

    const force = isMgr && !!req.body?.force;
    if (!isMgr && T.shiftInterval(shift.date, shift.start_time, shift.end_time).start <= nowLocalMs()) {
      throw new HttpError(400, 'Diese Schicht hat bereits begonnen.');
    }
    const count = db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE shift_id = ?').get(shift.id).n;
    if (shift.max_staff !== null && count >= shift.max_staff && !force) {
      throw new HttpError(409, 'Die Schicht ist bereits voll besetzt.', 'VOLL');
    }
    const conflict = checkConflicts(shift, userId, settings);
    if (conflict && (conflict.code === 'UEBERSCHNEIDUNG' || !force)) throw new HttpError(409, conflict.message, conflict.code);

    db.prepare('INSERT INTO assignments (shift_id, user_id, created_by) VALUES (?, ?, ?)').run(shift.id, userId, req.user.id);
    audit(req.user.id, 'assignment.add', { shift_id: shift.id, user_id: userId, force });
    return loadShifts('s.id = ?', [shift.id])[0];
  }));

  app.delete('/api/shifts/:id/assign', auth, wrap((req) => {
    const settings = getSettings();
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(Number(req.params.id));
    if (!shift) throw new HttpError(404, 'Schicht nicht gefunden.');
    const isMgr = req.user.role === 'manager';
    const userId = isMgr && req.query.user_id ? Number(req.query.user_id) : req.user.id;
    if (!db.prepare('SELECT 1 FROM assignments WHERE shift_id = ? AND user_id = ?').get(shift.id, userId)) throw new HttpError(404, 'Nicht eingetragen.');

    if (!isMgr) {
      const start = T.shiftInterval(shift.date, shift.start_time, shift.end_time).start;
      const hoursLeft = (start - nowLocalMs()) / 3600e3;
      if (hoursLeft < Number(settings.austrag_frist_std)) {
        throw new HttpError(400, `Austragen ist nur bis ${settings.austrag_frist_std} Std. vor Dienstbeginn möglich. Bitte wenden Sie sich an die Einsatzplanung.`, 'FRIST');
      }
      const count = db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE shift_id = ?').get(shift.id).n;
      if (!settings.austrag_unter_minimum && count - 1 < shift.min_staff) {
        throw new HttpError(400, `Austragen nicht möglich: Die Mindestbesetzung (${shift.min_staff}) würde unterschritten. Bitte Ersatz finden oder die Einsatzplanung kontaktieren.`, 'MINIMUM');
      }
    }
    db.prepare('DELETE FROM assignments WHERE shift_id = ? AND user_id = ?').run(shift.id, userId);
    audit(req.user.id, 'assignment.remove', { shift_id: shift.id, user_id: userId });
    return loadShifts('s.id = ?', [shift.id])[0];
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
    const rows = users.map((u) => {
      const shifts = db.prepare(`SELECT s.* FROM shifts s JOIN assignments a ON a.shift_id = s.id
        WHERE a.user_id = ? AND s.date BETWEEN ? AND ?`).all(u.id, from, to);
      const sum = { stunden: 0, nacht: 0, samstag: 0, sonntag: 0, feiertag: 0, vorfest: 0 };
      let nachtschichten = 0, euro = 0;
      for (const s of shifts) {
        const b = T.breakdown(s, settings);
        for (const k of Object.keys(sum)) sum[k] += b[k];
        if (b.nachtschicht) nachtschichten++;
        euro += T.zuschlagEuro(b, settings, u.stundenentgelt);
      }
      const soll = T.sollStunden(y, m, u.weekly_hours);
      const r2 = (x) => Math.round(x * 100) / 100;
      return {
        user_id: u.id, name: u.name, qualification: u.qualification, weekly_hours: u.weekly_hours,
        min_hours_month: u.min_hours_month, dienste: shifts.length, nachtschichten,
        soll: r2(soll), ist: r2(sum.stunden), saldo: r2(sum.stunden - soll),
        nacht: r2(sum.nacht), samstag: r2(sum.samstag), sonntag: r2(sum.sonntag), feiertag: r2(sum.feiertag), vorfest: r2(sum.vorfest),
        zuschlag_eur: r2(euro), min_erfuellt: sum.stunden + 1e-9 >= (u.min_hours_month || 0),
      };
    });
    const understaffed = db.prepare(`SELECT s.id, s.date, s.min_staff, u.name AS unit_name, st.code,
      (SELECT COUNT(*) FROM assignments a WHERE a.shift_id = s.id) AS besetzt
      FROM shifts s JOIN units u ON u.id = s.unit_id JOIN shift_types st ON st.id = s.shift_type_id
      WHERE s.date BETWEEN ? AND ? AND besetzt < s.min_staff ORDER BY s.date, s.start_time`).all(from, to);
    return { month, from, to, rows, understaffed: userFilter ? [] : understaffed };
  };

  app.get('/api/report', auth, wrap((req) => {
    const isMgr = req.user.role === 'manager';
    return report(req.query.month, isMgr ? (req.query.user_id ? Number(req.query.user_id) : null) : req.user.id);
  }));

  app.get('/api/report.csv', auth, manager, wrap((req, res) => {
    const r = report(req.query.month, null);
    const num = (x) => String(x).replace('.', ',');
    const head = ['Name', 'Qualifikation', 'Wochenstd.', 'Soll', 'Ist', 'Saldo', 'Mindeststd.', 'Mindeststd. erfüllt', 'Dienste',
      'Nachtschichten', 'Nacht-Std.', 'Samstag-Std.', 'Sonntag-Std.', 'Feiertag-Std.', 'Vorfest-Std.', 'Zuschläge EUR'];
    const lines = [head, ...r.rows.map((x) => [x.name, x.qualification, num(x.weekly_hours), num(x.soll), num(x.ist), num(x.saldo),
      num(x.min_hours_month), x.min_erfuellt ? 'ja' : 'nein', x.dienste, x.nachtschichten, num(x.nacht), num(x.samstag),
      num(x.sonntag), num(x.feiertag), num(x.vorfest), num(x.zuschlag_eur)])];
    const csv = '﻿' + lines.map((l) => l.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="zeitkonto-${r.month}.csv"`);
    res.send(csv);
  }));

  // ---------- Fehlerbehandlung ----------
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Unbekannter Endpunkt.')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Interner Fehler.' : err.message, code: err.code });
  });

  return app;
}

module.exports = { createApp };
