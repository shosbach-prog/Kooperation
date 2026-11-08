'use strict';
/**
 * Automatischer Planvorschlag: füllt unterbesetzte Dienste fair auf.
 * Harte Regeln: Abwesenheit, „Wunsch frei“, Überschneidung/Ruhezeit, Arbeitszeitregeln, Höchstbesetzung,
 * höchstens Soll-Stunden des Monats (+ Toleranz). Weiche Regeln (Bewertung): geringste Auslastung zuerst,
 * Stammstation/Verbund bevorzugt, Wunschdienst bevorzugt, Nacht- und Wochenenddienste gleichmäßig verteilen.
 * Gerechnet wird in einer Datenbank-Transaktion, die für die Vorschau wieder zurückgerollt wird –
 * so gelten exakt dieselben Prüfungen wie beim manuellen Eintragen.
 */
module.exports = (app, ctx) => {
  const { db, T, HttpError, auth, manager, wrap, audit, getSettings, isoDate, loadShifts, loadRules, qualMissing, checkConflicts, absenceOn, hooks } = ctx;

  const TOLERANZ_STD = 8;

  const berechnen = (req, from, to, unitIds) => {
    const settings = getSettings();
    const units = db.prepare('SELECT * FROM units WHERE active = 1').all().filter((u) => ctx.inScope(req.user, u.id) && (!unitIds.length || unitIds.includes(u.id)));
    if (!units.length) throw new HttpError(400, 'Keine Station ausgewählt (oder keine im eigenen Verwaltungsbereich).');
    const unitById = new Map(units.map((u) => [u.id, u]));
    const staff = db.prepare("SELECT * FROM users WHERE active = 1 AND role = 'staff'").all();
    const wishes = ctx.wishesBetween ? ctx.wishesBetween(from, to) : [];
    const wish = (uid, date) => wishes.find((w) => w.user_id === uid && w.date === date);
    const rules = loadRules();

    // Auslastung je Person und Monat (geplante Stunden), Nacht-/Wochenenddienste im Zeitraum
    const monthKey = (d) => d.slice(0, 7);
    const planned = new Map(); // `${uid}|${month}` → Stunden
    const nightCount = new Map(), weekendCount = new Map();
    const soll = (u, month) => {
      const [y, m] = month.split('-').map(Number);
      return T.sollStunden(y, m, u.weekly_hours);
    };
    const loadPlanned = (uid, month) => {
      const key = `${uid}|${month}`;
      if (!planned.has(key)) {
        const rows = db.prepare(`SELECT s.* FROM shifts s JOIN assignments a ON a.shift_id = s.id WHERE a.user_id = ? AND substr(s.date, 1, 7) = ?`).all(uid, month);
        planned.set(key, rows.reduce((acc, s) => acc + T.shiftHours(s), 0));
      }
      return planned.get(key);
    };
    const isNight = (s) => T.breakdown(s, settings).nachtschicht;
    const isWeekend = (d) => [0, 6].includes(new Date(T.parseDate(d)).getUTCDay());

    // Schichten mit Bedarf: Nächte und Wochenenden zuerst (schwerer zu besetzen), dann chronologisch
    const shifts = loadShifts(`s.date BETWEEN ? AND ? AND s.unit_id IN (${units.map(() => '?').join(',')})`, [from, to, ...units.map((u) => u.id)])
      .filter((s) => s.assigned.length < s.min_staff || s.qual_missing.length)
      .sort((a, b) => (isNight(b) - isNight(a)) || (isWeekend(b.date) - isWeekend(a.date)) || a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time));

    const vorschlaege = [], offen = [];
    for (const s0 of shifts) {
      let s = loadShifts('s.id = ?', [s0.id])[0];
      const month = monthKey(s.date);
      const night = isNight(s), weekend = isWeekend(s.date);
      let guard = 0;
      while ((s.assigned.length < s.min_staff || s.qual_missing.length) && guard++ < 20) {
        if (s.max_staff !== null && s.assigned.length >= s.max_staff) break;
        const brauchtQual = s.qual_missing.map((q) => q.qualification);
        const kandidaten = [];
        for (const u of staff) {
          if (s.assigned.some((a) => a.user_id === u.id)) continue;
          if (u.austritt && u.austritt < s.date) continue;
          if (u.eintritt && u.eintritt > s.date) continue;
          if (brauchtQual.length && !brauchtQual.includes(u.qualification) && s.assigned.length >= s.min_staff) continue;
          if (absenceOn(u.id, s.date)) continue;
          const w = wish(u.id, s.date);
          if (w && w.art === 'frei') continue;
          if (checkConflicts(s, u.id, settings)) continue;
          if (ctx.arbzgCheck(s, u.id, settings).length) continue;
          const sollM = soll(u, month);
          const hat = loadPlanned(u.id, month);
          if (sollM > 0 && hat + T.shiftHours(s) > sollM + TOLERANZ_STD) continue;
          // Bewertung: kleiner = besser
          let score = sollM > 0 ? hat / sollM : 1;
          const gruende = [`${Math.round(hat)} von ${Math.round(sollM)} Std. geplant`];
          const home = u.stammbereich_id === s.unit_id;
          const sameVerbund = !home && u.stammbereich_id && unitById.get(u.stammbereich_id)?.verbund_id && unitById.get(u.stammbereich_id).verbund_id === unitById.get(s.unit_id)?.verbund_id;
          if (home) gruende.push('Stammstation');
          else if (sameVerbund) { score += 0.08; gruende.push('Verbund'); } else score += 0.2;
          if (brauchtQual.includes(u.qualification)) { score -= 0.5; gruende.push(`fehlende Qualifikation (${u.qualification})`); }
          if (w && w.art === 'dienst') {
            if (w.shift_type_id === s.shift_type_id) { score -= 0.3; gruende.push('Wunschdienst'); } else score += 0.15;
          }
          if (night) score += 0.06 * (nightCount.get(u.id) || 0);
          if (weekend) score += 0.06 * (weekendCount.get(u.id) || 0);
          kandidaten.push({ u, score, gruende });
        }
        if (!kandidaten.length) break;
        kandidaten.sort((a, b) => a.score - b.score || a.u.name.localeCompare(b.u.name, 'de'));
        const best = kandidaten[0];
        db.prepare('INSERT INTO assignments (shift_id, user_id, created_by) VALUES (?, ?, ?)').run(s.id, best.u.id, req.user.id);
        planned.set(`${best.u.id}|${month}`, loadPlanned(best.u.id, month) + T.shiftHours(s));
        if (night) nightCount.set(best.u.id, (nightCount.get(best.u.id) || 0) + 1);
        if (weekend) weekendCount.set(best.u.id, (weekendCount.get(best.u.id) || 0) + 1);
        vorschlaege.push({
          shift_id: s.id, date: s.date, unit_name: s.unit_name, type_code: s.type_code, type_name: s.type_name, type_color: s.type_color,
          start_time: s.start_time, end_time: s.end_time, user_id: best.u.id, name: best.u.name, qualification: best.u.qualification, grund: best.gruende.join(' · '),
        });
        s = loadShifts('s.id = ?', [s.id])[0];
      }
      if (s.assigned.length < s.min_staff || s.qual_missing.length) {
        offen.push({ shift_id: s.id, date: s.date, unit_name: s.unit_name, type_code: s.type_code, type_name: s.type_name,
          fehlt: [s.assigned.length < s.min_staff ? `${s.min_staff - s.assigned.length} Person(en)` : null, ...s.qual_missing.map((q) => `${q.need - q.have}× ${q.qualification}`)].filter(Boolean).join(', ') });
      }
    }
    vorschlaege.sort((a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time) || a.unit_name.localeCompare(b.unit_name));
    offen.sort((a, b) => a.date.localeCompare(b.date));
    return { vorschlaege, offen };
  };

  /** Vorschau: berechnet und rollt zurück */
  app.post('/api/planvorschlag', auth, manager, wrap((req) => {
    const { from, to } = req.body || {};
    if (!isoDate(from) || !isoDate(to) || from > to) throw new HttpError(400, 'Zeitraum ungültig.');
    if ((T.parseDate(to) - T.parseDate(from)) / T.DAY > 92) throw new HttpError(400, 'Höchstens drei Monate auf einmal.');
    const unitIds = Array.isArray(req.body.unit_ids) ? req.body.unit_ids.map(Number) : [];
    db.exec('BEGIN');
    try { return berechnen(req, from, to, unitIds); } finally { db.exec('ROLLBACK'); }
  }));

  /** Übernehmen: ausgewählte Vorschläge erneut prüfen und eintragen */
  app.post('/api/planvorschlag/uebernehmen', auth, manager, wrap((req) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const settings = getSettings();
    const ok = [], fehler = [];
    db.exec('BEGIN');
    try {
      for (const it of items) {
        const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(Number(it.shift_id));
        const uid = Number(it.user_id);
        const grund = !s ? 'Schicht fehlt' : !ctx.inScope(req.user, s.unit_id) ? 'außerhalb Ihres Bereichs'
          : db.prepare('SELECT 1 FROM assignments WHERE shift_id = ? AND user_id = ?').get(s.id, uid) ? 'bereits eingetragen'
            : absenceOn(uid, s.date) ? 'abwesend'
              : (checkConflicts(s, uid, settings)?.message) || (ctx.arbzgCheck(s, uid, settings)[0]?.message)
                || (s.max_staff !== null && db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE shift_id = ?').get(s.id).n >= s.max_staff ? 'voll besetzt' : '');
        if (grund) { fehler.push({ ...it, grund }); continue; }
        db.prepare('INSERT INTO assignments (shift_id, user_id, created_by) VALUES (?, ?, ?)').run(s.id, uid, req.user.id);
        ok.push({ shift_id: s.id, user_id: uid });
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    audit(req.user.id, 'planvorschlag.uebernommen', { anzahl: ok.length, abgelehnt: fehler.length });
    // je Person eine zusammengefasste Benachrichtigung
    const perUser = new Map();
    for (const x of ok) { if (!perUser.has(x.user_id)) perUser.set(x.user_id, []); perUser.get(x.user_id).push(x.shift_id); }
    for (const [uid, ids] of perUser) {
      hooks.notify([uid], { titel: 'Neue Dienste eingeplant', link: '#mine', art: 'dienst',
        text: ids.length === 1 ? ctx.shiftLabel(ids[0]) : `${ids.length} Dienste, z. B. ${ctx.shiftLabel(ids[0])}. Details unter „Meine Dienste“.` });
    }
    return { eingetragen: ok.length, fehler };
  }));
};
