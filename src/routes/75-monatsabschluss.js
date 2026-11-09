'use strict';
/**
 * Monatsabschluss je Station: Prüfliste (offene Zeiten, Lücken, fehlende AU, offene Anträge, laufende Stempelungen),
 * dann abschließen. Danach sperren Datenbank-Trigger (db.js) alle Änderungen an Diensten, Ist-Zeiten und Abwesenheiten
 * dieses Monats für die Station. Wiedereröffnen nur durch die Hauptverwaltung mit Begründung.
 */
module.exports = (app, ctx) => {
  const { db, T, HttpError, auth, manager, managerFull, wrap, audit, inScope, requireUnit, getSettings, nowLocalMs } = ctx;

  const monatOk = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || '');
  const grenzen = (m) => {
    const [y, mo] = m.split('-').map(Number);
    return { from: `${m}-01`, to: T.isoDate(Date.UTC(y, mo, 0)) };
  };

  const pruefung = (m, unitId) => {
    const { from, to } = grenzen(m);
    const heute = T.isoDate(nowLocalMs());
    const q = (sql, ...p) => db.prepare(sql).get(...p).n;
    return {
      zeiten_offen: q(`SELECT COUNT(*) AS n FROM assignments a JOIN shifts s ON s.id = a.shift_id JOIN shift_types st ON st.id = s.shift_type_id
        WHERE s.unit_id = ? AND s.date BETWEEN ? AND ? AND s.date <= ? AND st.art <> 'ruf' AND (a.ist_start = '' OR a.ist_start IS NULL)`, unitId, from, to, heute),
      stempel_laufend: q(`SELECT COUNT(*) AS n FROM stempel st JOIN shifts s ON s.id = st.shift_id WHERE s.unit_id = ? AND s.date BETWEEN ? AND ? AND st.gehen_at IS NULL`, unitId, from, to),
      unterbesetzt: ctx.loadShifts('s.unit_id = ? AND s.date BETWEEN ? AND ?', [unitId, from, to]).filter((s) => s.unterbesetzt).length,
      antraege_offen: q(`SELECT COUNT(*) AS n FROM absences a JOIN users u ON u.id = a.user_id WHERE u.stammbereich_id = ? AND a.status = 'beantragt'
        AND a.from_date <= ? AND a.to_date >= ?`, unitId, to, from),
      au_fehlt: db.prepare(`SELECT a.* FROM absences a JOIN users u ON u.id = a.user_id WHERE u.stammbereich_id = ? AND a.type = 'krank'
        AND a.from_date <= ? AND a.to_date >= ?`).all(unitId, to, from).filter((a) => ctx.decorateAbsence(a, getSettings()).au_ueberfaellig).length,
    };
  };

  app.get('/api/monatsabschluss', auth, manager, wrap((req) => {
    const m = String(req.query.month || '');
    if (!monatOk(m)) throw new HttpError(400, 'Monat im Format JJJJ-MM angeben.');
    const rows = db.prepare(`SELECT u.id, u.name, b.name AS building_name, ma.abgeschlossen_am, ab.name AS abgeschlossen_von
      FROM units u LEFT JOIN buildings b ON b.id = u.building_id
      LEFT JOIN monatsabschluss ma ON ma.unit_id = u.id AND ma.monat = ? LEFT JOIN users ab ON ab.id = ma.abgeschlossen_von
      WHERE u.active = 1 ORDER BY b.sort, b.name, u.name`).all(m);
    const heute = T.isoDate(nowLocalMs());
    return {
      month: m,
      abschliessbar: grenzen(m).to < heute,
      stationen: rows.filter((r) => inScope(req.user, r.id)).map((r) => ({
        unit_id: r.id, name: r.name, building_name: r.building_name,
        abgeschlossen: r.abgeschlossen_am ? { am: r.abgeschlossen_am, von: r.abgeschlossen_von } : null,
        pruefung: r.abgeschlossen_am ? null : pruefung(m, r.id),
      })),
    };
  }));

  app.post('/api/monatsabschluss', auth, manager, wrap((req) => {
    const m = String(req.body?.month || '');
    if (!monatOk(m)) throw new HttpError(400, 'Monat im Format JJJJ-MM angeben.');
    if (grenzen(m).to >= T.isoDate(nowLocalMs())) throw new HttpError(400, 'Ein Monat kann erst nach seinem letzten Tag abgeschlossen werden.');
    const ids = (Array.isArray(req.body?.unit_ids) ? req.body.unit_ids : []).map(Number);
    if (!ids.length) throw new HttpError(400, 'Bitte mindestens eine Station wählen.');
    for (const id of ids) requireUnit(req, id);
    const laufend = ids.filter((id) => pruefung(m, id).stempel_laufend);
    if (laufend.length) throw new HttpError(400, 'Es gibt noch laufende Stempelungen in diesem Monat – bitte zuerst ausstempeln lassen bzw. nachtragen.', 'STEMPEL_LAEUFT');
    const ins = db.prepare('INSERT OR IGNORE INTO monatsabschluss (monat, unit_id, abgeschlossen_von) VALUES (?, ?, ?)');
    for (const id of ids) ins.run(m, id, req.user.id);
    audit(req.user.id, 'monat.abgeschlossen', { monat: m, unit_ids: ids });
    return { ok: true };
  }));

  app.delete('/api/monatsabschluss', auth, managerFull, wrap((req) => {
    const m = String(req.query.month || '');
    const unitId = Number(req.query.unit_id);
    const grund = String(req.body?.grund || req.query.grund || '').trim();
    if (!monatOk(m) || !unitId) throw new HttpError(400, 'Monat und Station angeben.');
    if (grund.length < 5) throw new HttpError(400, 'Bitte den Grund für die Wiedereröffnung angeben.', 'BEGRUENDUNG');
    const r = db.prepare('DELETE FROM monatsabschluss WHERE monat = ? AND unit_id = ?').run(m, unitId);
    if (!r.changes) throw new HttpError(404, 'Dieser Monat ist für die Station nicht abgeschlossen.');
    audit(req.user.id, 'monat.wiedereroeffnet', { monat: m, unit_id: unitId, reason: grund });
    return { ok: true };
  }));

  /** Für Exporte: sind alle aktiven Stationen im Monat abgeschlossen? */
  ctx.monatKomplett = (m) => db.prepare(`SELECT COUNT(*) AS n FROM units u WHERE u.active = 1
    AND NOT EXISTS (SELECT 1 FROM monatsabschluss ma WHERE ma.unit_id = u.id AND ma.monat = ?)`).get(m).n === 0;
};
