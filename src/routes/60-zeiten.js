'use strict';
/**
 * Zeiterfassung: tatsächliche Zeiten (Kommen/Gehen/Pause) je Einsatz und Einsatzstunden bei Rufbereitschaft.
 * Mitarbeitende erfassen eigene Zeiten bis ist_frist_tage nach dem Dienst; die Verwaltung (im Bereich) jederzeit.
 */
module.exports = (app, ctx) => {
  const { db, T, HttpError, auth, wrap, audit, getSettings, isoDate, isTime, hasMgr, nowLocalMs } = ctx;

  const rows = (where, params) => db.prepare(`SELECT a.shift_id, a.user_id, a.ist_start, a.ist_end, a.ist_pause, a.ist_note, a.ist_at, a.einsatz_std, a.ist_raucher_min, a.ist_quelle,
      s.date, s.start_time, s.end_time, s.break_min, s.unit_id, st.code AS type_code, st.name AS type_name, st.color AS type_color, st.art, st.bewertung,
      un.name AS unit_name, u.name, ib.name AS ist_by_name,
      EXISTS (SELECT 1 FROM monatsabschluss ma WHERE ma.unit_id = s.unit_id AND ma.monat = substr(s.date, 1, 7)) AS gesperrt
    FROM assignments a JOIN shifts s ON s.id = a.shift_id JOIN shift_types st ON st.id = s.shift_type_id JOIN units un ON un.id = s.unit_id
    JOIN users u ON u.id = a.user_id LEFT JOIN users ib ON ib.id = a.ist_by
    WHERE ${where} ORDER BY s.date DESC, s.start_time, u.name`).all(...params).map((r) => {
    const plan = T.shiftHours(r);
    const ist = r.ist_start && r.ist_end ? T.shiftHours({ date: r.date, start_time: r.ist_start, end_time: r.ist_end, break_min: r.ist_pause ?? r.break_min }) : null;
    const stempel = ctx.stempelDetails ? ctx.stempelDetails(r.user_id, r.shift_id) : [];
    return { ...r, stempel, plan_std: Math.round(plan * 100) / 100, ist_std: ist === null ? null : Math.round(ist * 100) / 100,
      diff_std: ist === null || r.art !== 'dienst' ? null : Math.round((ist - plan) * 100) / 100 };
  });

  app.get('/api/zeiten', auth, wrap((req) => {
    const today = T.isoDate(nowLocalMs());
    const from = isoDate(req.query.from) ? req.query.from : T.isoDate(T.parseDate(today) - 14 * T.DAY);
    const to = isoDate(req.query.to) ? req.query.to : today;
    const mine = !hasMgr(req.user) || req.query.mine;
    const list = mine ? rows('a.user_id = ? AND s.date BETWEEN ? AND ?', [req.user.id, from, to]) : rows('s.date BETWEEN ? AND ?', [from, to]);
    return { zeiten: list, frist_tage: getSettings().ist_frist_tage };
  }));

  app.put('/api/zeiten/:shiftId', auth, wrap((req) => {
    const shiftId = Number(req.params.shiftId);
    const b = req.body || {};
    const userId = hasMgr(req.user) && b.user_id ? Number(b.user_id) : req.user.id;
    const a = db.prepare(`SELECT a.*, s.date, s.start_time, s.end_time, s.break_min, s.unit_id, st.art FROM assignments a JOIN shifts s ON s.id = a.shift_id
      JOIN shift_types st ON st.id = s.shift_type_id WHERE a.shift_id = ? AND a.user_id = ?`).get(shiftId, userId);
    if (!a) throw new HttpError(404, 'Einsatz nicht gefunden.');
    const isMgr = hasMgr(req.user) && ctx.inScope(req.user, a.unit_id);
    if (userId !== req.user.id && !isMgr) throw new HttpError(403, 'Diese Station gehört nicht zu Ihrem Verwaltungsbereich.', 'BEREICH');
    const today = T.isoDate(nowLocalMs());
    if (a.date > today) throw new HttpError(400, 'Zeiten können erst ab dem Diensttag erfasst werden.');
    const frist = Number(getSettings().ist_frist_tage) || 0;
    if (!isMgr && frist && (T.parseDate(today) - T.parseDate(a.date)) / T.DAY > frist) {
      throw new HttpError(400, `Zeiten können bis ${frist} Tage nach dem Dienst erfasst werden. Bitte wenden Sie sich an die Einsatzplanung.`, 'FRIST');
    }
    let start = '', end = '', pause = null, einsatz = null;
    if (a.art === 'ruf') {
      einsatz = b.einsatz_std === '' || b.einsatz_std === null || b.einsatz_std === undefined ? 0 : Number(b.einsatz_std);
      if (!Number.isFinite(einsatz) || einsatz < 0 || einsatz > 24) throw new HttpError(400, 'Einsatzstunden: 0–24.');
    } else {
      start = String(b.ist_start || ''); end = String(b.ist_end || '');
      if (!isTime(start) || !isTime(end)) throw new HttpError(400, 'Kommen und Gehen bitte als HH:MM angeben.');
      pause = b.ist_pause === '' || b.ist_pause === undefined || b.ist_pause === null ? a.break_min : Number(b.ist_pause);
      if (!Number.isInteger(pause) || pause < 0) throw new HttpError(400, 'Pause in ganzen Minuten angeben.');
      const iv = T.shiftInterval(a.date, start, end);
      const dauer = (iv.end - iv.start) / 60000;
      if (pause >= dauer) throw new HttpError(400, 'Die Pause ist länger als die Arbeitszeit.');
      if (dauer > 16 * 60) throw new HttpError(400, 'Mehr als 16 Stunden – bitte Zeiten prüfen.');
      // Abweichung vom Plan auf Plausibilität prüfen (höchstens 4 Std. früher/später)
      const plan = T.shiftInterval(a.date, a.start_time, a.end_time);
      if (Math.abs(iv.start - plan.start) > 4 * 3600e3) throw new HttpError(400, 'Kommen weicht mehr als 4 Std. vom Plan ab – bitte prüfen.');
    }
    const note = String(b.ist_note || '').trim().slice(0, 300);
    // Von der Stempeluhr erfasste Zeiten dürfen Mitarbeitende nur mit Begründung überschreiben
    if (!isMgr && a.ist_quelle === 'stempel' && !note) throw new HttpError(400, 'Die Zeiten stammen von der Stempeluhr. Bitte begründen Sie die Änderung.', 'BEGRUENDUNG');
    db.prepare(`UPDATE assignments SET ist_start = ?, ist_end = ?, ist_pause = ?, ist_note = ?, einsatz_std = ?, ist_by = ?, ist_at = datetime('now'), ist_quelle = 'manuell'
      WHERE shift_id = ? AND user_id = ?`).run(start, end, pause, note, einsatz, req.user.id, shiftId, userId);
    audit(req.user.id, 'zeit.erfasst', { shift_id: shiftId, user_id: userId, ist_start: start, ist_end: end, ist_pause: pause, einsatz_std: einsatz, reason: note });
    return rows('a.shift_id = ? AND a.user_id = ?', [shiftId, userId])[0];
  }));

  app.delete('/api/zeiten/:shiftId', auth, wrap((req) => {
    const shiftId = Number(req.params.shiftId);
    const userId = hasMgr(req.user) && req.query.user_id ? Number(req.query.user_id) : req.user.id;
    const a = db.prepare('SELECT a.*, s.unit_id FROM assignments a JOIN shifts s ON s.id = a.shift_id WHERE a.shift_id = ? AND a.user_id = ?').get(shiftId, userId);
    if (!a) throw new HttpError(404, 'Einsatz nicht gefunden.');
    if (userId !== req.user.id) ctx.requireUnit(req, a.unit_id);
    db.prepare("UPDATE assignments SET ist_start = '', ist_end = '', ist_pause = NULL, ist_note = '', einsatz_std = NULL, ist_by = NULL, ist_at = NULL, ist_raucher_min = NULL, ist_quelle = '' WHERE shift_id = ? AND user_id = ?").run(shiftId, userId);
    audit(req.user.id, 'zeit.zurueckgesetzt', { shift_id: shiftId, user_id: userId });
    return { ok: true };
  }));
};
