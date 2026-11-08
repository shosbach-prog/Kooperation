'use strict';
/**
 * Demo-Modus (DEMO_MODUS=1): Auf der Startseite wählt man eine Rolle – Pflegedienstleitung, Stationsleitung
 * oder Pflegekraft – und ist sofort angemeldet, ohne Passwort und ohne Authenticator-Code.
 * Zusätzlich kann man sich als neue Person anlegen und so alles selbst ausprobieren.
 * NUR für Vorführungen ohne echte Daten! Im Echtbetrieb DEMO_MODUS weglassen oder 0 setzen.
 */
const crypto = require('crypto');

module.exports = (app, ctx) => {
  if (!ctx.demo) return;
  const { db, HttpError, wrap, audit, publicUser, todayIso } = ctx;
  const MAX_GAESTE = 200;

  const randomHash = () => ctx.hashPassword(crypto.randomBytes(24).toString('hex'));
  const ersteStation = () => db.prepare('SELECT id, name FROM units WHERE active = 1 ORDER BY id LIMIT 1').get();

  // Für die Vorführung eine Stationsleitung bereitstellen, falls es noch keine gibt
  const st = ersteStation();
  if (st && !db.prepare("SELECT 1 FROM users WHERE active = 1 AND role = 'staff' AND admin_rechte = 'voll'").get()
    && !db.prepare("SELECT 1 FROM users WHERE username = 'skrueger'").get()) {
    db.prepare(`INSERT INTO users (name, username, password_hash, role, qualification, weekly_hours, min_hours_month, stundenentgelt, admin_rechte, admin_units, stammbereich_id)
      VALUES ('Sabine Krüger', 'skrueger', ?, 'staff', 'Pflegefachkraft', 38.5, 120, 24.5, 'voll', ?, ?)`).run(randomHash(), JSON.stringify([st.id]), st.id);
  }

  const units = () => Object.fromEntries(db.prepare('SELECT id, name FROM units').all().map((u) => [u.id, u.name]));
  const aktiv = "active = 1 AND (austritt = '' OR austritt >= ?)";

  app.get('/api/demo/personen', wrap(() => {
    const un = units();
    const list = db.prepare(`SELECT * FROM users WHERE ${aktiv} ORDER BY name`).all(todayIso()).map(publicUser);
    const beschreibung = (u) => {
      if (u.is_haupt) return 'Pflegedienstleitung – verwaltet den ganzen Campus';
      if (u.is_manager) return `Stationsleitung – ${u.admin_units.length ? u.admin_units.map((id) => un[id]).filter(Boolean).join(', ') : 'alle Stationen'}`;
      return [u.qualification, un[u.stammbereich_id]].filter(Boolean).join(' · ') || 'Pflege';
    };
    const pick = (u) => ({ username: u.username, name: u.name, id: u.id, foto_version: u.foto_version, beschreibung: beschreibung(u), gast: u.username.startsWith('gast-') });
    return {
      leitung: list.filter((u) => u.is_manager).sort((a, b) => Number(b.is_haupt) - Number(a.is_haupt)).map(pick),
      pflege: list.filter((u) => !u.is_manager).map(pick),
      stationen: db.prepare('SELECT id, name FROM units WHERE active = 1 ORDER BY name').all(),
      qualifikationen: ctx.getSettings().qualifikationen || [],
    };
  }));

  app.post('/api/demo/login', wrap((req, res) => {
    const u = db.prepare(`SELECT * FROM users WHERE username = ? AND ${aktiv}`).get(String(req.body?.username || ''), todayIso());
    if (!u) throw new HttpError(404, 'Diese Person gibt es nicht (mehr).');
    if (req.token) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
    ctx.startSession(res, u.id, 'full');
    audit(u.id, 'login.demo', {});
    return { stage: 'full', user: publicUser(u) };
  }));

  app.post('/api/demo/person', wrap((req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (name.length < 2) throw new HttpError(400, 'Bitte einen Namen eingeben.');
    const rolle = ['pflege', 'stationsleitung', 'pdl'].includes(b.rolle) ? b.rolle : 'pflege';
    if (db.prepare("SELECT COUNT(*) AS n FROM users WHERE username LIKE 'gast-%'").get().n >= MAX_GAESTE) {
      throw new HttpError(429, 'Die Demo ist voll. Bitte eine vorhandene Person wählen.');
    }
    const unitId = db.prepare('SELECT id FROM units WHERE id = ? AND active = 1').get(Number(b.unit_id))?.id || ersteStation()?.id || null;
    const quals = ctx.getSettings().qualifikationen || [];
    const qual = rolle === 'pdl' ? 'Leitung' : quals.includes(b.qualification) ? b.qualification : (quals[0] || 'Pflegefachkraft');
    const username = `gast-${crypto.randomBytes(3).toString('hex')}`;
    const id = db.prepare(`INSERT INTO users (name, username, password_hash, role, qualification, weekly_hours, min_hours_month, stundenentgelt, admin_rechte, admin_units, stammbereich_id)
      VALUES (?, ?, ?, ?, ?, 38.5, ?, 22.5, ?, ?, ?)`).run(
      name, username, randomHash(), rolle === 'pdl' ? 'manager' : 'staff', qual, rolle === 'pdl' ? 0 : 120,
      rolle === 'stationsleitung' ? 'voll' : 'keine', rolle === 'stationsleitung' && unitId ? JSON.stringify([unitId]) : '', rolle === 'pdl' ? null : unitId,
    ).lastInsertRowid;
    if (req.token) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
    ctx.startSession(res, Number(id), 'full');
    audit(Number(id), 'demo.person_angelegt', { name, rolle });
    return { stage: 'full', user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) };
  }));
};
