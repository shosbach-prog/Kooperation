'use strict';
/**
 * Anwesenheitsübersicht für die Verwaltung: Wer ist heute (bzw. an einem Tag) da, wer ist krank, im Urlaub, frei?
 * Quellen: Abwesenheiten (Krankmeldung, Urlaub …), Dienstplan (Einträge) und Stempeluhr (eingestempelt / Pause).
 * Nur Lesen; sichtbar für alle mit Verwaltungsrechten (Verwalter/innen mit Stationsbeschränkung dürfen ohnehin alles lesen).
 */
module.exports = (app, ctx) => {
  const { db, T, HttpError, auth, manager, wrap, isoDate, getSettings, decorateAbsence } = ctx;

  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  /** Wandzeit (Europe/Berlin) im selben Format wie T.shiftInterval */
  const wall = (ms) => {
    const [date, hm] = fmt.format(new Date(ms)).split(' ');
    return { date, hm, wms: T.parseDate(date) + T.toMinutes(hm) * 60000 };
  };

  const KRANK = ['krank', 'kind_krank'];
  const URLAUB = ['urlaub', 'zusatzurlaub', 'sonderurlaub'];
  const KULANZ_MIN = 15; // so lange nach Dienstbeginn gilt „noch nicht eingestempelt“ nicht als auffällig

  app.get('/api/anwesenheit', auth, manager, wrap((req) => {
    const t = ctx.clock();
    const jetzt = wall(t);
    const datum = req.query.datum || jetzt.date;
    if (!isoDate(datum)) throw new HttpError(400, 'Datum ungültig.');
    const heute = datum === jetzt.date;
    const vortag = T.isoDate(T.parseDate(datum) - T.DAY);
    const settings = getSettings();

    const users = db.prepare(`SELECT id, name, qualification, stammbereich_id, beschaeftigung, firma, foto_version, telefon, eintritt, austritt
      FROM users WHERE active = 1 AND (eintritt = '' OR eintritt <= ?) AND (austritt = '' OR austritt >= ?) ORDER BY name COLLATE NOCASE`).all(datum, datum);

    // Abwesenheiten am Tag (Krankmeldung zählt vor Urlaub)
    const absences = db.prepare(`SELECT * FROM absences WHERE ? BETWEEN from_date AND to_date AND status IN ('genehmigt','gemeldet','beantragt')`).all(datum);
    const absByUser = new Map();
    const rang = (a) => (KRANK.includes(a.type) ? 0 : a.status === 'beantragt' ? 2 : 1);
    for (const a of absences) {
      const cur = absByUser.get(a.user_id);
      if (!cur || rang(a) < rang(cur)) absByUser.set(a.user_id, a);
    }

    // Dienste am Tag (+ Nachtdienste vom Vortag, die in den Tag hineinreichen)
    const shifts = db.prepare(`SELECT a.user_id, s.id AS shift_id, s.date, s.unit_id, s.start_time, s.end_time, st.code AS type_code, st.name AS type_name,
        st.color AS type_color, st.art, un.name AS unit_name
      FROM assignments a JOIN shifts s ON s.id = a.shift_id JOIN shift_types st ON st.id = s.shift_type_id JOIN units un ON un.id = s.unit_id
      WHERE s.date BETWEEN ? AND ? ORDER BY s.date, s.start_time`).all(vortag, datum);
    const shiftsByUser = new Map();
    for (const s of shifts) {
      const iv = T.shiftInterval(s.date, s.start_time, s.end_time);
      if (s.date === vortag && iv.end <= T.parseDate(datum)) continue; // endete schon am Vortag
      const d = { ...s, start_ms: iv.start, end_ms: iv.end, vom_vortag: s.date === vortag };
      if (!shiftsByUser.has(s.user_id)) shiftsByUser.set(s.user_id, []);
      shiftsByUser.get(s.user_id).push(d);
    }

    // Stempeluhr (nur für heute aussagekräftig)
    const offen = new Map();
    const gestempelt = new Set();
    if (heute) {
      for (const o of db.prepare('SELECT id, user_id, kommen_at, shift_id FROM stempel WHERE gehen_at IS NULL').all()) {
        if (t - o.kommen_at > 16 * 3600e3) continue; // vergessen auszustempeln
        const p = db.prepare('SELECT art FROM stempel_pausen WHERE stempel_id = ? AND ende_at IS NULL LIMIT 1').get(o.id);
        offen.set(o.user_id, { kommen: wall(o.kommen_at).hm, kommen_at: o.kommen_at, pause: p ? p.art : null });
      }
      for (const r of db.prepare('SELECT DISTINCT user_id FROM stempel WHERE kommen_at > ?').all(t - 20 * 3600e3)) gestempelt.add(r.user_id);
    }

    const personen = users.map((u) => {
      const abs = absByUser.get(u.id);
      const dienste = (shiftsByUser.get(u.id) || []).map((s) => ({
        shift_id: s.shift_id, date: s.date, unit_id: s.unit_id, unit_name: s.unit_name, start_time: s.start_time, end_time: s.end_time,
        type_code: s.type_code, type_name: s.type_name, type_color: s.type_color, art: s.art, vom_vortag: s.vom_vortag,
        _start: s.start_ms, _end: s.end_ms,
      }));
      const st = offen.get(u.id) || null;
      let status = 'frei', detail = '', hinweis = null;
      if (abs && abs.status !== 'beantragt') {
        status = KRANK.includes(abs.type) ? 'krank' : URLAUB.includes(abs.type) ? 'urlaub' : 'abwesend';
        const d = decorateAbsence(abs, settings);
        detail = abs.type;
        if (d.au_ueberfaellig) hinweis = 'AU fehlt';
      } else if (st) {
        status = 'anwesend';
        detail = st.pause ? (st.pause === 'raucher' ? 'Raucherpause' : 'Pause') : '';
      } else {
        const dienst = dienste.filter((d) => d.art !== 'ruf');
        const ruf = dienste.filter((d) => d.art === 'ruf');
        if (heute) {
          const laufend = dienst.find((d) => jetzt.wms >= d._start && jetzt.wms < d._end);
          const spaeter = dienst.find((d) => jetzt.wms < d._start);
          if (laufend) {
            status = 'im_dienst';
            if (!gestempelt.has(u.id) && jetzt.wms >= laufend._start + KULANZ_MIN * 60000) hinweis = 'nicht eingestempelt';
          } else if (spaeter) status = 'geplant';
          else if (dienst.length) status = 'dienst_beendet';
          else if (ruf.some((d) => jetzt.wms >= d._start && jetzt.wms < d._end)) status = 'ruf';
        } else if (dienst.length) status = 'geplant';
        else if (ruf.length) status = 'ruf';
        if (abs && abs.status === 'beantragt') hinweis = 'Urlaub beantragt';
      }
      return {
        id: u.id, name: u.name, qualification: u.qualification, stammbereich_id: u.stammbereich_id, beschaeftigung: u.beschaeftigung,
        firma: u.firma, foto_version: u.foto_version, telefon: u.telefon,
        status, detail, hinweis, stempel: st,
        abwesenheit: abs && abs.status !== 'beantragt' ? { id: abs.id, type: abs.type, from_date: abs.from_date, to_date: abs.to_date, status: abs.status } : null,
        dienste: dienste.map(({ _start, _end, ...d }) => d),
      };
    });

    const zaehler = {};
    for (const p of personen) zaehler[p.status] = (zaehler[p.status] || 0) + 1;
    return { datum, heute, jetzt: heute ? jetzt.hm : null, personen, zaehler };
  }));
};
