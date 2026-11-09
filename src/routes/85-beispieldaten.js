'use strict';
/**
 * Beispieldaten aus dem Echtbetrieb entfernen: Beispielpersonen (Passwort „demo123“ aus der Ersteinrichtung,
 * Gäste aus dem Demo-Modus) samt ihrer Dienste, Abwesenheiten, Wünsche und Stempelzeiten.
 * Erst Vorschau (GET), dann Entfernen (POST) – nur Hauptverwaltung.
 */
const fs = require('fs');
const path = require('path');
const { verifyPassword } = require('../db');

module.exports = (app, ctx) => {
  const { db, HttpError, auth, managerFull, wrap, audit, uploadDir } = ctx;

  const kandidaten = () => db.prepare("SELECT id, name, username, active, password_hash FROM users WHERE role = 'staff' ORDER BY name").all()
    .filter((u) => u.username.startsWith('gast-') || verifyPassword('demo123', u.password_hash))
    .map((u) => ({
      id: u.id, name: u.name, username: u.username, active: !!u.active,
      dienste: db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE user_id = ?').get(u.id).n,
    }));

  app.get('/api/admin/beispieldaten', auth, managerFull, wrap(() => ({ personen: kandidaten() })));

  app.post('/api/admin/beispieldaten/entfernen', auth, managerFull, wrap((req) => {
    const erlaubt = new Map(kandidaten().map((k) => [k.id, k]));
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [...erlaubt.keys()]).map(Number);
    const fremd = ids.filter((id) => !erlaubt.has(id));
    if (fremd.length) throw new HttpError(400, 'Es können nur Beispielpersonen entfernt werden.');
    const dateien = db.prepare(`SELECT f.stored_name FROM attachments f JOIN absences a ON a.id = f.absence_id WHERE a.user_id IN (${ids.map(() => '?').join(',') || 'NULL'})`).all(...ids);
    db.exec('BEGIN');
    try {
      for (const id of ids) db.prepare('DELETE FROM users WHERE id = ?').run(id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    for (const f of dateien) fs.rmSync(path.join(uploadDir, f.stored_name), { force: true });
    for (const id of ids) fs.rmSync(path.join(uploadDir, 'fotos', `${id}.img`), { force: true });
    audit(req.user.id, 'beispieldaten.entfernt', { anzahl: ids.length, namen: ids.map((id) => erlaubt.get(id).name) });
    return { entfernt: ids.length };
  }));
};
