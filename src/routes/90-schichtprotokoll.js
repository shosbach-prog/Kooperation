'use strict';
/**
 * Schichtprotokoll je Dienst – Stationsbetrieb, ausdrücklich OHNE Patientenbezug:
 * Belegung, Zugänge/Entlassungen/Verlegungen (Anzahlen), besondere Vorkommnisse (Art, Anzahl, Uhrzeit, kurze Notiz),
 * Übergabe-Notiz. Freitexte werden auf typische Patientendaten geprüft (Namen mit Anrede, Geburtsdaten, Fallnummern).
 * Lesen/Schreiben: eingeteiltes Personal der Schicht, Stammpersonal der Station, Verwaltung im eigenen Bereich.
 * Nach dem Abzeichnen nur noch mit Änderungsgrund; nach dem Monatsabschluss gesperrt (Trigger in db.js).
 */
const { patientendaten } = require('../../public/js/sprachparser');

module.exports = (app, ctx) => {
  const { db, T, HttpError, auth, manager, wrap, audit, getSettings, hasMgr, inScope, nowLocalMs, isTime } = ctx;

  const shiftMitInfo = (id) => db.prepare(`SELECT s.*, st.code AS type_code, st.name AS type_name, st.color AS type_color, st.art,
      u.name AS unit_name, b.name AS building_name
    FROM shifts s JOIN shift_types st ON st.id = s.shift_type_id JOIN units u ON u.id = s.unit_id LEFT JOIN buildings b ON b.id = u.building_id WHERE s.id = ?`).get(Number(id));
  const eingeteilt = (shiftId, userId) => !!db.prepare('SELECT 1 FROM assignments WHERE shift_id = ? AND user_id = ?').get(shiftId, userId);
  const darf = (user, s) => (hasMgr(user) && inScope(user, s.unit_id)) || eingeteilt(s.id, user.id) || user.stammbereich_id === s.unit_id;
  const laden = (shiftId) => {
    const p = db.prepare(`SELECT p.*, e.name AS erstellt_von_name, g.name AS geaendert_von_name, a.name AS abgezeichnet_von_name
      FROM schichtprotokolle p LEFT JOIN users e ON e.id = p.erstellt_von LEFT JOIN users g ON g.id = p.geaendert_von LEFT JOIN users a ON a.id = p.abgezeichnet_von
      WHERE p.shift_id = ?`).get(shiftId);
    if (!p) return null;
    return { ...p, vorkommnisse: db.prepare('SELECT art, anzahl, uhrzeit, notiz FROM schichtprotokoll_vorkommnisse WHERE protokoll_id = ? ORDER BY uhrzeit, id').all(p.id) };
  };

  /** Übersicht: vergangene und laufende Dienste mit Protokollstatus */
  app.get('/api/schichtprotokolle', auth, wrap((req) => {
    const heute = T.isoDate(nowLocalMs());
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') && req.query.to < heute ? req.query.to : heute;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : T.isoDate(T.parseDate(to) - 6 * T.DAY);
    if ((T.parseDate(to) - T.parseDate(from)) / T.DAY > 62) throw new HttpError(400, 'Höchstens zwei Monate auf einmal.');
    const shifts = ctx.loadShifts('s.date BETWEEN ? AND ?', [from, to]).filter((s) => s.art !== 'ruf' && darf(req.user, s));
    const prot = new Map(db.prepare(`SELECT p.shift_id, p.abgezeichnet_am, (SELECT COALESCE(SUM(anzahl), 0) FROM schichtprotokoll_vorkommnisse v WHERE v.protokoll_id = p.id) AS vk
      FROM schichtprotokolle p JOIN shifts s ON s.id = p.shift_id WHERE s.date BETWEEN ? AND ?`).all(from, to).map((p) => [p.shift_id, p]));
    return {
      from, to,
      dienste: shifts.map((s) => ({
        shift_id: s.id, date: s.date, start_time: s.start_time, end_time: s.end_time, unit_id: s.unit_id, unit_name: s.unit_name,
        type_code: s.type_code, type_name: s.type_name, type_color: s.type_color, besetzt: s.assigned.length, min_staff: s.min_staff,
        unterbesetzt: s.unterbesetzt, gesperrt: !!s.gesperrt, mein: s.assigned.some((a) => a.user_id === req.user.id),
        status: !prot.has(s.id) ? 'fehlt' : prot.get(s.id).abgezeichnet_am ? 'abgezeichnet' : 'entwurf', vorkommnisse: prot.get(s.id)?.vk || 0,
      })).sort((a, b) => b.date.localeCompare(a.date) || b.start_time.localeCompare(a.start_time) || a.unit_name.localeCompare(b.unit_name, 'de')),
    };
  }));

  app.get('/api/schichtprotokolle/:shiftId', auth, wrap((req) => {
    const s = shiftMitInfo(req.params.shiftId);
    if (!s || !darf(req.user, s)) throw new HttpError(404, 'Dienst nicht gefunden.');
    const st = getSettings();
    const full = ctx.loadShifts('s.id = ?', [s.id])[0];
    return {
      dienst: { shift_id: s.id, date: s.date, start_time: s.start_time, end_time: s.end_time, unit_id: s.unit_id, unit_name: s.unit_name, building_name: s.building_name,
        type_code: s.type_code, type_name: s.type_name, type_color: s.type_color, min_staff: s.min_staff, unterbesetzt: full?.unterbesetzt, gesperrt: !!full?.gesperrt },
      besetzung: db.prepare(`SELECT u.id, u.name, u.qualification, u.beschaeftigung, u.firma, a.ist_start, a.ist_end, a.ist_quelle FROM assignments a JOIN users u ON u.id = a.user_id
        WHERE a.shift_id = ? ORDER BY u.name`).all(s.id),
      protokoll: laden(s.id),
      arten: st.vorkommnis_arten || [],
      sprache_cloud_erlaubt: !!st.sprache_cloud_erlaubt,
      darf_schreiben: !full?.gesperrt && s.date <= T.isoDate(nowLocalMs() + T.DAY),
    };
  }));

  const intOderNull = (v, name) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 999) throw new HttpError(400, `${name}: ganze Zahl von 0 bis 999.`);
    return n;
  };

  app.put('/api/schichtprotokolle/:shiftId', auth, wrap((req) => {
    const s = shiftMitInfo(req.params.shiftId);
    if (!s || !darf(req.user, s)) throw new HttpError(404, 'Dienst nicht gefunden.');
    if (s.date > T.isoDate(nowLocalMs() + T.DAY)) throw new HttpError(400, 'Das Protokoll kann erst ab dem Diensttag geschrieben werden.');
    const b = req.body || {};
    const arten = getSettings().vorkommnis_arten || [];
    const felder = {
      belegung: intOderNull(b.belegung, 'Belegung'), betten: intOderNull(b.betten, 'Betten'), zugaenge: intOderNull(b.zugaenge, 'Zugänge'),
      entlassungen: intOderNull(b.entlassungen, 'Entlassungen'), verlegungen: intOderNull(b.verlegungen, 'Verlegungen'),
      notiz: String(b.notiz || '').trim().slice(0, 4000),
    };
    const vk = (Array.isArray(b.vorkommnisse) ? b.vorkommnisse : []).slice(0, 50).map((v) => {
      if (!arten.includes(v.art)) throw new HttpError(400, `Unbekannte Art des Vorkommnisses: ${v.art}`);
      const uhrzeit = String(v.uhrzeit || '');
      if (uhrzeit && !isTime(uhrzeit)) throw new HttpError(400, 'Uhrzeit als HH:MM angeben.');
      return { art: v.art, anzahl: Math.max(1, intOderNull(v.anzahl, 'Anzahl') ?? 1), uhrzeit, notiz: String(v.notiz || '').trim().slice(0, 300) };
    });
    // Schutz vor Patientendaten in Freitexten
    const funde = [felder.notiz, ...vk.map((v) => v.notiz)].flatMap((t) => patientendaten(t));
    if (funde.length && !b.patientendaten_bestaetigt) {
      const e = new HttpError(400, 'Der Text enthält möglicherweise Patientendaten. Bitte keine Namen, Geburtsdaten oder Fallnummern eintragen.', 'PATIENTENDATEN');
      e.funde = funde;
      throw e;
    }
    const alt = laden(s.id);
    if (alt?.abgezeichnet_am && String(b.aenderungsgrund || '').trim().length < 5) {
      throw new HttpError(400, 'Das Protokoll ist bereits abgezeichnet. Bitte den Grund der Änderung angeben.', 'BEGRUENDUNG');
    }
    db.exec('BEGIN');
    try {
      let id;
      if (alt) {
        // erst das Protokoll ändern (Monatsabschluss-Sperre greift hier), dann die Vorkommnisse ersetzen
        db.prepare(`UPDATE schichtprotokolle SET belegung = ?, betten = ?, zugaenge = ?, entlassungen = ?, verlegungen = ?, notiz = ?,
          geaendert_von = ?, geaendert_am = datetime('now'), per_sprache = MAX(per_sprache, ?) WHERE id = ?`)
          .run(felder.belegung, felder.betten, felder.zugaenge, felder.entlassungen, felder.verlegungen, felder.notiz, req.user.id, b.per_sprache ? 1 : 0, alt.id);
        id = alt.id;
        db.prepare('DELETE FROM schichtprotokoll_vorkommnisse WHERE protokoll_id = ?').run(id);
      } else {
        id = db.prepare(`INSERT INTO schichtprotokolle (shift_id, belegung, betten, zugaenge, entlassungen, verlegungen, notiz, erstellt_von, per_sprache)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(s.id, felder.belegung, felder.betten, felder.zugaenge, felder.entlassungen, felder.verlegungen, felder.notiz, req.user.id, b.per_sprache ? 1 : 0).lastInsertRowid;
      }
      const ins = db.prepare('INSERT INTO schichtprotokoll_vorkommnisse (protokoll_id, art, anzahl, uhrzeit, notiz) VALUES (?, ?, ?, ?, ?)');
      for (const v of vk) ins.run(id, v.art, v.anzahl, v.uhrzeit, v.notiz);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    audit(req.user.id, alt ? 'schichtprotokoll.geaendert' : 'schichtprotokoll.angelegt', {
      shift_id: s.id, unit_id: s.unit_id, datum: s.date, vorkommnisse: vk.length, per_sprache: !!b.per_sprache,
      ...(alt?.abgezeichnet_am ? { reason: String(b.aenderungsgrund).trim(), nach_abzeichnung: true } : {}),
    });
    return laden(s.id);
  }));

  app.post('/api/schichtprotokolle/:shiftId/abzeichnen', auth, wrap((req) => {
    const s = shiftMitInfo(req.params.shiftId);
    if (!s || !darf(req.user, s)) throw new HttpError(404, 'Dienst nicht gefunden.');
    const p = laden(s.id);
    if (!p) throw new HttpError(400, 'Bitte das Protokoll zuerst speichern.');
    db.prepare("UPDATE schichtprotokolle SET abgezeichnet_von = ?, abgezeichnet_am = datetime('now') WHERE id = ?").run(req.user.id, p.id);
    audit(req.user.id, 'schichtprotokoll.abgezeichnet', { shift_id: s.id, unit_id: s.unit_id, datum: s.date });
    return laden(s.id);
  }));

  // ---------- Auswertung ----------
  const auswertung = (req) => {
    const m = String(req.query.month || '');
    if (!/^\d{4}-\d{2}$/.test(m)) throw new HttpError(400, 'Monat im Format JJJJ-MM angeben.');
    const shifts = ctx.loadShifts("substr(s.date, 1, 7) = ?", [m]).filter((s) => s.art !== 'ruf' && inScope(req.user, s.unit_id) && s.date <= T.isoDate(nowLocalMs()));
    const prot = new Map(db.prepare(`SELECT p.* FROM schichtprotokolle p JOIN shifts s ON s.id = p.shift_id WHERE substr(s.date, 1, 7) = ?`).all(m).map((p) => [p.shift_id, p]));
    const vks = db.prepare(`SELECT v.*, p.shift_id FROM schichtprotokoll_vorkommnisse v JOIN schichtprotokolle p ON p.id = v.protokoll_id
      JOIN shifts s ON s.id = p.shift_id WHERE substr(s.date, 1, 7) = ?`).all(m);
    const byUnit = new Map();
    for (const s of shifts) {
      if (!byUnit.has(s.unit_id)) byUnit.set(s.unit_id, { unit_id: s.unit_id, unit_name: s.unit_name, dienste: 0, protokolle: 0, abgezeichnet: 0, belegung_summe: 0, belegung_n: 0,
        zugaenge: 0, entlassungen: 0, verlegungen: 0, vorkommnisse: {}, vk_gesamt: 0, vk_unterbesetzt: 0, dienste_unterbesetzt: 0 });
      const u = byUnit.get(s.unit_id);
      u.dienste++;
      if (s.unterbesetzt) u.dienste_unterbesetzt++;
      const p = prot.get(s.id);
      if (!p) continue;
      u.protokolle++;
      if (p.abgezeichnet_am) u.abgezeichnet++;
      if (p.belegung !== null) { u.belegung_summe += p.belegung; u.belegung_n++; }
      u.zugaenge += p.zugaenge || 0; u.entlassungen += p.entlassungen || 0; u.verlegungen += p.verlegungen || 0;
      for (const v of vks.filter((x) => x.shift_id === s.id)) {
        u.vorkommnisse[v.art] = (u.vorkommnisse[v.art] || 0) + v.anzahl;
        u.vk_gesamt += v.anzahl;
        if (s.unterbesetzt) u.vk_unterbesetzt += v.anzahl;
      }
    }
    return {
      month: m, arten: getSettings().vorkommnis_arten || [],
      stationen: [...byUnit.values()].map(({ belegung_summe, belegung_n, ...u }) => ({ ...u, belegung_schnitt: belegung_n ? Math.round((belegung_summe / belegung_n) * 10) / 10 : null }))
        .sort((a, b) => a.unit_name.localeCompare(b.unit_name, 'de')),
    };
  };
  app.get('/api/schichtprotokolle-auswertung', auth, manager, wrap(auswertung));
  app.get('/api/schichtprotokolle.csv', auth, manager, wrap((req, res) => {
    const m = String(req.query.month || '');
    if (!/^\d{4}-\d{2}$/.test(m)) throw new HttpError(400, 'Monat im Format JJJJ-MM angeben.');
    const rows = db.prepare(`SELECT s.date, st.code, u.name AS station, s.unit_id, p.belegung, p.zugaenge, p.entlassungen, p.verlegungen, p.abgezeichnet_am, p.notiz, p.id
      FROM schichtprotokolle p JOIN shifts s ON s.id = p.shift_id JOIN shift_types st ON st.id = s.shift_type_id JOIN units u ON u.id = s.unit_id
      WHERE substr(s.date, 1, 7) = ? ORDER BY s.date, s.start_time, u.name`).all(m).filter((r) => inScope(req.user, r.unit_id));
    const vk = db.prepare('SELECT art, anzahl, uhrzeit, notiz FROM schichtprotokoll_vorkommnisse WHERE protokoll_id = ? ORDER BY uhrzeit');
    const lines = [['Datum', 'Dienst', 'Station', 'Belegung', 'Zugänge', 'Entlassungen', 'Verlegungen', 'Vorkommnisse', 'Übergabe-Notiz', 'abgezeichnet'],
      ...rows.map((r) => [r.date.split('-').reverse().join('.'), r.code, r.station, r.belegung ?? '', r.zugaenge ?? '', r.entlassungen ?? '', r.verlegungen ?? '',
        vk.all(r.id).map((v) => `${v.anzahl > 1 ? `${v.anzahl}× ` : ''}${v.art}${v.uhrzeit ? ` ${v.uhrzeit}` : ''}${v.notiz ? ` (${v.notiz})` : ''}`).join('; '), r.notiz, r.abgezeichnet_am ? 'ja' : 'nein'])];
    audit(req.user.id, 'export.schichtprotokolle', { month: m, zeilen: rows.length });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="schichtprotokolle-${m}.csv"`);
    res.send('﻿' + lines.map((l) => l.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n'));
  }));

  // Löschfrist (zentraler Löschlauf in 80-datenschutz.js)
  (ctx.cleanupExtras ||= []).push((monthsAgo) => {
    const n = Number(getSettings().loeschfrist_schichtprotokoll_monate) || 0;
    if (!n) return { schichtprotokolle: 0 };
    const r = db.prepare('DELETE FROM schichtprotokolle WHERE shift_id IN (SELECT id FROM shifts WHERE date < ?)').run(monthsAgo(n));
    return { schichtprotokolle: Number(r.changes) };
  });
};
