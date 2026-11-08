'use strict';
/**
 * Dienstwünsche: Mitarbeitende tragen „Wunsch frei“ oder einen Wunschdienst je Tag ein.
 * Frist (wunsch_frist_tage) und Höchstzahl an Frei-Wünschen je Monat (wunsch_frei_max_monat) sind einstellbar.
 */
module.exports = (app, ctx) => {
  const { db, T, HttpError, auth, wrap, audit, getSettings, isoDate, hasMgr, nowLocalMs } = ctx;

  const list = (where, params) => db.prepare(`SELECT w.*, u.name, st.code AS type_code, st.name AS type_name
    FROM wishes w JOIN users u ON u.id = w.user_id LEFT JOIN shift_types st ON st.id = w.shift_type_id
    WHERE ${where} ORDER BY w.date, u.name`).all(...params);
  ctx.wishesBetween = (from, to) => list('w.date BETWEEN ? AND ?', [from, to]);

  app.get('/api/wishes', auth, wrap((req) => {
    const from = isoDate(req.query.from) ? req.query.from : T.isoDate(nowLocalMs());
    const to = isoDate(req.query.to) ? req.query.to : T.isoDate(T.parseDate(from) + 62 * T.DAY);
    const st = getSettings();
    const mine = !hasMgr(req.user) || req.query.mine;
    return {
      wuensche: mine ? list('w.user_id = ? AND w.date BETWEEN ? AND ?', [req.user.id, from, to]) : list('w.date BETWEEN ? AND ?', [from, to]),
      frist_tage: st.wunsch_frist_tage, frei_max_monat: st.wunsch_frei_max_monat,
      erster_tag: T.isoDate(nowLocalMs() + Number(st.wunsch_frist_tage || 0) * T.DAY),
    };
  }));

  app.put('/api/wishes', auth, wrap((req) => {
    const b = req.body || {};
    const st = getSettings();
    const isMgr = hasMgr(req.user);
    const userId = isMgr && b.user_id ? Number(b.user_id) : req.user.id;
    if (userId !== req.user.id) ctx.requireUser(req, userId);
    if (!isoDate(b.date)) throw new HttpError(400, 'Datum ungültig.');
    if (!['frei', 'dienst'].includes(b.art)) throw new HttpError(400, 'Art muss „frei“ oder „dienst“ sein.');
    const ersterTag = T.isoDate(nowLocalMs() + Number(st.wunsch_frist_tage || 0) * T.DAY);
    if (!isMgr && b.date < ersterTag) {
      throw new HttpError(400, `Wünsche sind nur bis ${st.wunsch_frist_tage} Tage im Voraus möglich (ab ${ersterTag.split('-').reverse().join('.')}).`, 'FRIST');
    }
    const typeId = b.art === 'dienst' ? Number(b.shift_type_id) : null;
    if (b.art === 'dienst' && !db.prepare('SELECT 1 FROM shift_types WHERE id = ? AND active = 1').get(typeId)) throw new HttpError(400, 'Bitte einen Dienst wählen.');
    if (b.art === 'frei' && !isMgr) {
      const month = b.date.slice(0, 7);
      const n = db.prepare("SELECT COUNT(*) AS n FROM wishes WHERE user_id = ? AND art = 'frei' AND substr(date, 1, 7) = ? AND date <> ?").get(userId, month, b.date).n;
      if (Number(st.wunsch_frei_max_monat) > 0 && n >= Number(st.wunsch_frei_max_monat)) {
        throw new HttpError(400, `Höchstens ${st.wunsch_frei_max_monat} Frei-Wünsche pro Monat.`, 'LIMIT');
      }
    }
    const note = String(b.note || '').trim().slice(0, 200);
    db.prepare(`INSERT INTO wishes (user_id, date, art, shift_type_id, note) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET art = excluded.art, shift_type_id = excluded.shift_type_id, note = excluded.note`)
      .run(userId, b.date, b.art, typeId, note);
    audit(req.user.id, 'wish.set', { user_id: userId, date: b.date, art: b.art, shift_type_id: typeId });
    return list('w.user_id = ? AND w.date = ?', [userId, b.date])[0];
  }));

  app.delete('/api/wishes/:date', auth, wrap((req) => {
    const userId = hasMgr(req.user) && req.query.user_id ? Number(req.query.user_id) : req.user.id;
    if (userId !== req.user.id) ctx.requireUser(req, userId);
    db.prepare('DELETE FROM wishes WHERE user_id = ? AND date = ?').run(userId, String(req.params.date));
    return { ok: true };
  }));
};
