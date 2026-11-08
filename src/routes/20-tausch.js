'use strict';
/**
 * Diensttausch-Börse: Mitarbeitende bieten eigene Dienste an, Kolleginnen und Kollegen übernehmen sie.
 * Optional muss die Verwaltung den Tausch bestätigen (Einstellung „tausch_bestaetigung“).
 */
module.exports = (app, ctx) => {
  const { db, T, HttpError, auth, manager, wrap, audit, getSettings, nowLocalMs, hasMgr, loadShifts, loadRules, qualMissing, checkConflicts, absenceOn } = ctx;

  const loadOffer = (id) => db.prepare(`SELECT o.*, s.date, s.start_time, s.end_time, s.unit_id, s.shift_type_id, s.min_staff, s.max_staff,
      st.name AS type_name, st.code AS type_code, st.color AS type_color, un.name AS unit_name,
      u.name AS user_name, u.qualification AS user_qualification, tk.name AS taker_name
    FROM swap_offers o JOIN shifts s ON s.id = o.shift_id JOIN shift_types st ON st.id = s.shift_type_id JOIN units un ON un.id = s.unit_id
    JOIN users u ON u.id = o.user_id LEFT JOIN users tk ON tk.id = o.taker_id WHERE o.id = ?`).get(id);

  const started = (o) => T.shiftInterval(o.date, o.start_time, o.end_time).start <= nowLocalMs();

  /** Prüft, ob takerId den Dienst übernehmen darf; wirft HttpError */
  const checkTaker = (o, takerId) => {
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(o.shift_id);
    if (!db.prepare('SELECT 1 FROM assignments WHERE shift_id = ? AND user_id = ?').get(o.shift_id, o.user_id)) {
      throw new HttpError(409, 'Der Dienst ist nicht mehr eingetragen – das Angebot ist hinfällig.', 'HINFAELLIG');
    }
    if (db.prepare('SELECT 1 FROM assignments WHERE shift_id = ? AND user_id = ?').get(o.shift_id, takerId)) throw new HttpError(409, 'Sie sind in diesem Dienst bereits eingetragen.');
    const abs = absenceOn(takerId, o.date);
    if (abs) throw new HttpError(409, 'An diesem Tag ist eine Abwesenheit eingetragen.', 'ABWESEND');
    const conflict = checkConflicts(shift, takerId, getSettings());
    if (conflict) throw new HttpError(409, conflict.message, conflict.code);
    // Qualifikation: Nach dem Tausch darf keine zusätzliche Lücke entstehen
    const current = loadShifts('s.id = ?', [o.shift_id])[0];
    const taker = db.prepare('SELECT id AS user_id, name, qualification FROM users WHERE id = ?').get(takerId);
    const after = qualMissing(shift, [...current.assigned.filter((p) => p.user_id !== o.user_id), taker], loadRules());
    if (after.length > current.qual_missing.length) {
      throw new HttpError(409, `Für diesen Dienst wird ${after[0].need}× ${after[0].qualification} benötigt – die Übernahme ist so nicht möglich.`, 'QUALIFIKATION');
    }
  };

  const execute = (o, takerId, actorId) => {
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM assignments WHERE shift_id = ? AND user_id = ?').run(o.shift_id, o.user_id);
      db.prepare('INSERT INTO assignments (shift_id, user_id, created_by) VALUES (?, ?, ?)').run(o.shift_id, takerId, actorId);
      db.prepare("UPDATE swap_offers SET status = 'erledigt', taker_id = ?, taken_at = COALESCE(taken_at, datetime('now')) WHERE id = ?").run(takerId, o.id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    audit(actorId, 'swap.done', { id: o.id, shift_id: o.shift_id, user_id: takerId, von: o.user_name, reason: `Tausch: übernommen von ${o.user_name}` });
  };

  const fmt = (o) => `${o.type_name} am ${o.date.split('-').reverse().join('.')} (${o.unit_name})`;

  app.get('/api/swaps', auth, wrap((req) => {
    const rows = db.prepare(`SELECT o.id FROM swap_offers o JOIN shifts s ON s.id = o.shift_id
      WHERE (o.status IN ('offen','angenommen') AND s.date >= ?) OR ((o.user_id = ? OR o.taker_id = ?) AND s.date >= ?)
      ORDER BY s.date, s.start_time`).all(T.isoDate(nowLocalMs()), req.user.id, req.user.id, T.isoDate(nowLocalMs() - 30 * T.DAY));
    return { bestaetigung: !!getSettings().tausch_bestaetigung, angebote: rows.map((r) => loadOffer(r.id)).filter(Boolean) };
  }));

  app.post('/api/swaps', auth, wrap((req) => {
    const shiftId = Number(req.body?.shift_id);
    const s = db.prepare('SELECT s.*, st.name AS type_name, un.name AS unit_name FROM shifts s JOIN shift_types st ON st.id = s.shift_type_id JOIN units un ON un.id = s.unit_id WHERE s.id = ?').get(shiftId);
    if (!s) throw new HttpError(404, 'Dienst nicht gefunden.');
    const userId = hasMgr(req.user) && req.body.user_id ? Number(req.body.user_id) : req.user.id;
    if (!db.prepare('SELECT 1 FROM assignments WHERE shift_id = ? AND user_id = ?').get(shiftId, userId)) throw new HttpError(400, 'Nur eigene eingetragene Dienste können angeboten werden.');
    if (T.shiftInterval(s.date, s.start_time, s.end_time).start <= nowLocalMs()) throw new HttpError(400, 'Der Dienst hat bereits begonnen.');
    if (db.prepare("SELECT 1 FROM swap_offers WHERE shift_id = ? AND user_id = ? AND status IN ('offen','angenommen')").get(shiftId, userId)) {
      throw new HttpError(409, 'Dieser Dienst ist bereits angeboten.');
    }
    const note = String(req.body?.note || '').trim().slice(0, 300);
    const id = db.prepare('INSERT INTO swap_offers (shift_id, user_id, note) VALUES (?, ?, ?)').run(shiftId, userId, note).lastInsertRowid;
    const o = loadOffer(id);
    audit(req.user.id, 'swap.offer', { id, shift_id: shiftId, user_id: userId, reason: note });
    // alle aktiven Mitarbeitenden informieren (außer dem Anbietenden)
    const empf = db.prepare("SELECT id FROM users WHERE active = 1 AND role = 'staff' AND id <> ?").all(userId).map((u) => u.id);
    ctx.hooks.notify(empf, { titel: 'Dienst in der Tauschbörse', text: `${o.user_name} gibt ab: ${fmt(o)}${note ? ` – ${note}` : ''}`, link: '#tausch', art: 'tausch' });
    return o;
  }));

  app.delete('/api/swaps/:id', auth, wrap((req) => {
    const o = loadOffer(Number(req.params.id));
    if (!o) throw new HttpError(404, 'Angebot nicht gefunden.');
    if (o.user_id !== req.user.id && !(hasMgr(req.user) && ctx.inScope(req.user, o.unit_id))) throw new HttpError(403, 'Nicht erlaubt.');
    if (!['offen', 'angenommen'].includes(o.status)) throw new HttpError(400, 'Das Angebot ist bereits abgeschlossen.');
    db.prepare("UPDATE swap_offers SET status = 'zurueckgezogen' WHERE id = ?").run(o.id);
    audit(req.user.id, 'swap.withdraw', { id: o.id, shift_id: o.shift_id, user_id: o.user_id });
    return { ok: true };
  }));

  app.post('/api/swaps/:id/take', auth, wrap((req) => {
    const o = loadOffer(Number(req.params.id));
    if (!o || o.status !== 'offen') throw new HttpError(404, 'Das Angebot ist nicht mehr verfügbar.');
    if (o.user_id === req.user.id) throw new HttpError(400, 'Das ist Ihr eigenes Angebot.');
    if (started(o)) throw new HttpError(400, 'Der Dienst hat bereits begonnen.');
    checkTaker(o, req.user.id);
    if (getSettings().tausch_bestaetigung) {
      db.prepare("UPDATE swap_offers SET status = 'angenommen', taker_id = ?, taken_at = datetime('now') WHERE id = ?").run(req.user.id, o.id);
      audit(req.user.id, 'swap.take', { id: o.id, shift_id: o.shift_id, user_id: req.user.id });
      const mgrs = db.prepare("SELECT id FROM users WHERE active = 1 AND (role = 'manager' OR admin_rechte <> 'keine')").all().map((u) => u.id);
      ctx.hooks.notify(mgrs, { titel: 'Tausch bestätigen', text: `${req.user.name} möchte ${fmt(o)} von ${o.user_name} übernehmen.`, link: '#tausch', art: 'tausch' });
      ctx.hooks.notify([o.user_id], { titel: 'Ihr Dienst wurde angenommen', text: `${req.user.name} übernimmt ${fmt(o)} – die Verwaltung muss noch bestätigen.`, link: '#tausch', art: 'tausch' });
      return { ...loadOffer(o.id), wartet: true };
    }
    execute(o, req.user.id, req.user.id);
    ctx.hooks.notify([o.user_id], { titel: 'Dienst übernommen', text: `${req.user.name} hat ${fmt(o)} übernommen. Sie sind ausgetragen.`, link: '#mine', art: 'tausch' });
    return { ...loadOffer(o.id), wartet: false };
  }));

  app.post('/api/swaps/:id/decide', auth, manager, wrap((req) => {
    const o = loadOffer(Number(req.params.id));
    if (!o || o.status !== 'angenommen') throw new HttpError(404, 'Kein Tausch zur Bestätigung.');
    ctx.requireUnit(req, o.unit_id);
    const ok = req.body?.status === 'bestaetigt';
    const note = String(req.body?.note || '').trim().slice(0, 300);
    if (ok) {
      checkTaker(o, o.taker_id);
      execute(o, o.taker_id, req.user.id);
    } else {
      db.prepare("UPDATE swap_offers SET status = 'offen', taker_id = NULL, taken_at = NULL WHERE id = ?").run(o.id);
    }
    db.prepare("UPDATE swap_offers SET decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?").run(req.user.id, note, o.id);
    audit(req.user.id, 'swap.decide', { id: o.id, shift_id: o.shift_id, user_id: o.taker_id, status: ok ? 'bestätigt' : 'abgelehnt', reason: note });
    const text = ok ? `Tausch bestätigt: ${o.taker_name} übernimmt ${fmt(o)}.` : `Tausch abgelehnt: ${fmt(o)}${note ? ` – ${note}` : ''}. Das Angebot ist wieder offen.`;
    ctx.hooks.notify([o.user_id, o.taker_id], { titel: ok ? 'Tausch bestätigt' : 'Tausch abgelehnt', text, link: '#tausch', art: 'tausch' });
    return loadOffer(o.id);
  }));
};
