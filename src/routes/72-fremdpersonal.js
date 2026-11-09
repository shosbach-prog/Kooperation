'use strict';
/**
 * Flexpool und externes Personal (Zeitarbeit/Leasing):
 *  - Einsatzstunden je Station nach Beschäftigungsart (Stamm / Flexpool / Extern)
 *  - Nachweis der Einsätze externer Kräfte je Firma (CSV) für die Rechnungsprüfung
 * Grundlage: Ist-Zeiten, sonst Planzeiten; Rufbereitschaft nur mit Einsatzstunden.
 */
module.exports = (app, ctx) => {
  const { db, T, HttpError, auth, manager, wrap, audit, inScope } = ctx;

  const einsaetze = (month) => {
    if (!/^\d{4}-\d{2}$/.test(month || '')) throw new HttpError(400, 'Monat im Format JJJJ-MM angeben.');
    return db.prepare(`SELECT a.*, s.date, s.start_time, s.end_time, s.break_min, s.unit_id, st.art, st.bewertung, st.code AS type_code, st.name AS type_name,
        un.name AS unit_name, u.name, u.beschaeftigung, u.firma, u.personalnummer
      FROM assignments a JOIN shifts s ON s.id = a.shift_id JOIN shift_types st ON st.id = s.shift_type_id
      JOIN units un ON un.id = s.unit_id JOIN users u ON u.id = a.user_id
      WHERE substr(s.date, 1, 7) = ? ORDER BY s.date, s.start_time, u.name`).all(month).map((e) => {
      const ist = !!(e.ist_start && e.ist_end);
      let std;
      if (e.art === 'ruf') std = Number(e.einsatz_std) || 0;
      else {
        std = T.shiftHours(ist ? { date: e.date, start_time: e.ist_start, end_time: e.ist_end, break_min: e.ist_pause ?? e.break_min } : e);
        if (e.art === 'bereitschaft') std = std * (Number(e.bewertung) || 0) / 100;
      }
      return { ...e, std: Math.round(std * 100) / 100, ist, beschaeftigung: e.beschaeftigung || 'stamm' };
    });
  };

  app.get('/api/report/einsatzarten', auth, manager, wrap((req) => {
    const list = einsaetze(String(req.query.month || '')).filter((e) => inScope(req.user, e.unit_id));
    const byUnit = new Map();
    for (const e of list) {
      if (!byUnit.has(e.unit_id)) byUnit.set(e.unit_id, { unit_id: e.unit_id, unit_name: e.unit_name, stamm: 0, flexpool: 0, extern: 0, dienste_flexpool: 0, dienste_extern: 0 });
      const u = byUnit.get(e.unit_id);
      u[e.beschaeftigung] += e.std;
      if (e.beschaeftigung !== 'stamm') u[`dienste_${e.beschaeftigung}`]++;
    }
    const firmen = new Map();
    for (const e of list.filter((x) => x.beschaeftigung === 'extern')) {
      const k = e.firma || 'ohne Firmenangabe';
      if (!firmen.has(k)) firmen.set(k, { firma: k, personen: new Set(), dienste: 0, std: 0 });
      const f = firmen.get(k); f.personen.add(e.user_id); f.dienste++; f.std += e.std;
    }
    const r2 = (x) => Math.round(x * 100) / 100;
    return {
      stationen: [...byUnit.values()].map((u) => ({ ...u, stamm: r2(u.stamm), flexpool: r2(u.flexpool), extern: r2(u.extern) }))
        .sort((a, b) => a.unit_name.localeCompare(b.unit_name, 'de')),
      firmen: [...firmen.values()].map((f) => ({ firma: f.firma, personen: f.personen.size, dienste: f.dienste, std: r2(f.std) })),
    };
  }));

  app.get('/api/export/fremdpersonal.csv', auth, manager, wrap((req, res) => {
    const month = String(req.query.month || '');
    const list = einsaetze(month).filter((e) => e.beschaeftigung === 'extern' && inScope(req.user, e.unit_id));
    const num = (x) => String(x).replace('.', ',');
    const rows = [['Firma', 'Name', 'Datum', 'Station', 'Dienst', 'Beginn', 'Ende', 'Pause (Min.)', 'Stunden', 'Grundlage'],
      ...list.map((e) => [e.firma || '', e.name, e.date.split('-').reverse().join('.'), e.unit_name, `${e.type_code} ${e.type_name}`,
        e.art === 'ruf' ? '' : (e.ist ? e.ist_start : e.start_time), e.art === 'ruf' ? '' : (e.ist ? e.ist_end : e.end_time),
        e.art === 'ruf' ? '' : (e.ist ? (e.ist_pause ?? e.break_min) : e.break_min), num(e.std),
        e.art === 'ruf' ? 'Ruf-Einsatz' : e.ist ? (e.ist_quelle === 'stempel' ? 'Stempeluhr' : 'Ist-Zeit') : 'Planzeit'])];
    audit(req.user.id, 'export.fremdpersonal', { month, zeilen: list.length });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="fremdpersonal-${month}.csv"`);
    res.send('﻿' + rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n'));
  }));
};
