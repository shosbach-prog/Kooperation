'use strict';
/**
 * Stempeluhr fürs Handy: Kommen – Pause / Raucherpause – Weiter – Gehen, sekundengenau gespeichert.
 * Beim Gehen werden die Ist-Zeiten des zugehörigen Dienstes automatisch gesetzt:
 *  - Arbeitsbeginn = erstes Kommen, Arbeitsende = letztes Gehen (auf die Minute gerundet)
 *  - Pausenabzug = alle Pausen (+ Raucherpausen, sofern eingestellt) + Unterbrechungen zwischen zwei Stempelungen
 *  - fehlt die gesetzliche Mindestpause (§ 4 ArbZG: nur Blöcke ab 15 Min. zählen), wird sie ergänzt (einstellbar)
 * Bei Rufbereitschaft zählen die gestempelten Zeiten als Einsatzstunden.
 */
module.exports = (app, ctx) => {
  const { db, T, HttpError, auth, wrap, audit, getSettings, isTime } = ctx;
  const now = () => ctx.clock();

  // ---------- Zeit-Hilfen (Wandzeit Europe/Berlin) ----------
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const wall = (ms) => {
    const [date, time] = fmt.format(new Date(ms)).split(' ');
    return { date, hm: time.slice(0, 5), hms: time, wms: T.parseDate(date) + T.toMinutes(time.slice(0, 5)) * 60000 + Number(time.slice(6, 8)) * 1000 };
  };
  const hmRound = (ms) => wall(ms + 30000).hm; // auf die Minute gerundet
  const MIN = 60000;

  /**
   * Zeitpunkt einer Stempelung. Offline erfasste Stempelungen werden später übertragen:
   * offline_at = Handyuhr beim Stempeln, gesendet_at = Handyuhr beim Senden → Abweichung der Handyuhr wird herausgerechnet.
   * Höchstens 24 Std. zurück; doppelt gesendete (gleiche offline_id) werden ignoriert.
   */
  const zeitpunkt = (req, nichtVor = 0) => {
    const b = req.body || {};
    if (b.offline_at === undefined) return { t: now(), offline: false };
    const at = Number(b.offline_at), sent = Number(b.gesendet_at);
    if (!Number.isFinite(at) || !Number.isFinite(sent) || at > sent + 1000) throw new HttpError(400, 'Ungültige Offline-Zeit.');
    const t = now() - (sent - at);
    if (now() - t > 24 * 3600e3) throw new HttpError(400, 'Offline-Stempelungen können nur bis 24 Std. nachträglich übertragen werden.', 'ZU_ALT');
    return { t: Math.max(t, nichtVor), offline: true };
  };
  const schonGesehen = (req) => {
    const id = req.body?.offline_id;
    if (!id) return false;
    if (!/^[\w-]{8,64}$/.test(String(id))) throw new HttpError(400, 'Ungültige Offline-Kennung.');
    const r = db.prepare('INSERT OR IGNORE INTO stempel_offline_ids (id, user_id) VALUES (?, ?)').run(String(id), req.user.id);
    return !r.changes;
  };
  const letzteZeit = (o) => Math.max(o.kommen_at, ...pausenVon(o.id).flatMap((p) => [p.start_at, p.ende_at || 0]));

  const pausenVon = (id) => db.prepare('SELECT * FROM stempel_pausen WHERE stempel_id = ? ORDER BY start_at').all(id);
  const offen = (userId) => db.prepare('SELECT * FROM stempel WHERE user_id = ? AND gehen_at IS NULL ORDER BY id DESC LIMIT 1').get(userId);

  /** Zusammenfassung mehrerer Stempelungen (eines Dienstes) */
  const summary = (list, settings = getSettings(), bis = now()) => {
    if (!list.length) return null;
    const kommen = Math.min(...list.map((s) => s.kommen_at));
    const gehen = Math.max(...list.map((s) => s.gehen_at ?? bis));
    let pause = 0, raucher = 0, gesetzlich = 0, luecken = 0;
    const sorted = [...list].sort((a, b) => a.kommen_at - b.kommen_at);
    sorted.forEach((s, i) => {
      for (const p of pausenVon(s.id)) {
        const d = (p.ende_at ?? s.gehen_at ?? bis) - p.start_at;
        if (p.art === 'raucher') raucher += d; else pause += d;
        if (d >= 15 * MIN) gesetzlich += d;
      }
      const next = sorted[i + 1];
      if (next && s.gehen_at) { const g = Math.max(0, next.kommen_at - s.gehen_at); luecken += g; if (g >= 15 * MIN) gesetzlich += g; }
    });
    const brutto = gehen - kommen;
    const abzugRaucher = settings.raucherpause_abziehen === false ? 0 : raucher;
    const netto0 = brutto - pause - luecken - abzugRaucher;
    const pflicht = netto0 > 9 * 3600e3 ? 45 * MIN : netto0 > 6 * 3600e3 ? 30 * MIN : 0;
    const ergaenzt = settings.mindestpause_ergaenzen === false ? 0 : Math.max(0, pflicht - gesetzlich);
    const r = (x) => Math.round(x / MIN);
    return {
      kommen_at: kommen, gehen_at: gehen, brutto_min: r(brutto), pause_min: r(pause + luecken), raucher_min: r(raucher),
      ergaenzt_min: r(ergaenzt), abzug_min: r(pause + luecken + abzugRaucher + ergaenzt), netto_min: r(netto0 - ergaenzt),
    };
  };

  /** Passenden geplanten Dienst zum Zeitpunkt finden (4 Std. vor Beginn bis 4 Std. nach Ende) */
  const findShift = (userId, ms) => {
    const w = wall(ms);
    const lo = T.isoDate(T.parseDate(w.date) - T.DAY);
    const rows = db.prepare(`SELECT s.*, st.name AS type_name, st.code AS type_code, st.color AS type_color, st.art, un.name AS unit_name
      FROM assignments a JOIN shifts s ON s.id = a.shift_id JOIN shift_types st ON st.id = s.shift_type_id JOIN units un ON un.id = s.unit_id
      WHERE a.user_id = ? AND s.date BETWEEN ? AND ?`).all(userId, lo, w.date);
    let best = null, bestD = Infinity;
    for (const s of rows) {
      const iv = T.shiftInterval(s.date, s.start_time, s.end_time);
      if (w.wms < iv.start - 4 * 3600e3 || w.wms > iv.end + 4 * 3600e3) continue;
      const d = w.wms < iv.start ? iv.start - w.wms : w.wms > iv.end ? w.wms - iv.end : 0;
      if (d < bestD) { best = s; bestD = d; }
    }
    return best;
  };
  /** Nur Demo-Bereich: gerade laufender Dienst, in den man zum Ausprobieren einspringen kann */
  const laufenderDienst = (userId, ms) => {
    if (!ctx.demo) return null;
    const w = wall(ms);
    const u = db.prepare('SELECT stammbereich_id FROM users WHERE id = ?').get(userId);
    const rows = db.prepare(`SELECT s.*, st.name AS type_name, st.code AS type_code, st.color AS type_color, st.art, un.name AS unit_name,
        (SELECT COUNT(*) FROM assignments a WHERE a.shift_id = s.id) AS besetzt
      FROM shifts s JOIN shift_types st ON st.id = s.shift_type_id JOIN units un ON un.id = s.unit_id
      WHERE s.date BETWEEN ? AND ? AND st.art <> 'ruf'`).all(T.isoDate(T.parseDate(w.date) - T.DAY), w.date)
      .filter((s) => { const iv = T.shiftInterval(s.date, s.start_time, s.end_time); return w.wms >= iv.start - 3600e3 && w.wms < iv.end - 1800e3; })
      .sort((a, b) => (b.unit_id === u?.stammbereich_id) - (a.unit_id === u?.stammbereich_id) || a.besetzt - b.besetzt);
    return rows[0] || null;
  };
  const shiftInfo = (s) => (s ? { shift_id: s.id, date: s.date, start_time: s.start_time, end_time: s.end_time, break_min: s.break_min,
    type_name: s.type_name, type_code: s.type_code, type_color: s.type_color, unit_name: s.unit_name, art: s.art } : null);
  const loadShift = (id) => (id ? db.prepare(`SELECT s.*, st.name AS type_name, st.code AS type_code, st.color AS type_color, st.art, un.name AS unit_name
    FROM shifts s JOIN shift_types st ON st.id = s.shift_type_id JOIN units un ON un.id = s.unit_id WHERE s.id = ?`).get(id) : null);

  /** Ist-Zeiten des Dienstes aus allen abgeschlossenen Stempelungen neu berechnen */
  const uebernehmen = (userId, shiftId, byId) => {
    const s = loadShift(shiftId);
    if (!s) return null;
    const list = db.prepare('SELECT * FROM stempel WHERE user_id = ? AND shift_id = ? AND gehen_at IS NOT NULL ORDER BY kommen_at').all(userId, shiftId);
    const sum = summary(list);
    if (!sum) return null;
    if (s.art === 'ruf') {
      db.prepare("UPDATE assignments SET einsatz_std = ?, ist_quelle = 'stempel', ist_by = ?, ist_at = datetime('now') WHERE shift_id = ? AND user_id = ?")
        .run(Math.round((sum.netto_min / 60) * 100) / 100, byId, shiftId, userId);
    } else {
      db.prepare(`UPDATE assignments SET ist_start = ?, ist_end = ?, ist_pause = ?, ist_raucher_min = ?, ist_quelle = 'stempel', ist_by = ?, ist_at = datetime('now')
        WHERE shift_id = ? AND user_id = ?`).run(hmRound(sum.kommen_at), hmRound(sum.gehen_at), sum.abzug_min, sum.raucher_min, byId, shiftId, userId);
    }
    return sum;
  };

  const statusFor = (userId) => {
    const t = now();
    const o = offen(userId);
    const settings = getSettings();
    let laufend = null;
    if (o) {
      const pausen = pausenVon(o.id);
      const shift = loadShift(o.shift_id);
      const alle = o.shift_id ? db.prepare('SELECT * FROM stempel WHERE user_id = ? AND shift_id = ? ORDER BY kommen_at').all(userId, o.shift_id) : [o];
      laufend = {
        id: o.id, kommen_at: o.kommen_at, kommen: wall(o.kommen_at).hms, dienst: shiftInfo(shift),
        pausen: pausen.map((p) => ({ art: p.art, start_at: p.start_at, ende_at: p.ende_at })),
        pause_offen: pausen.find((p) => !p.ende_at) || null,
        bisher: summary(alle, settings, t),
        vergessen: t - o.kommen_at > 16 * 3600e3,
      };
    }
    let vorschlag = o ? null : shiftInfo(findShift(userId, t));
    if (!o && !vorschlag) { const l = laufenderDienst(userId, t); if (l) vorschlag = { ...shiftInfo(l), einspringen: true }; }
    const heute = wall(t).date;
    const erledigt = db.prepare(`SELECT DISTINCT shift_id FROM stempel WHERE user_id = ? AND gehen_at IS NOT NULL AND kommen_at > ?`).all(userId, t - 36 * 3600e3)
      .map((r) => r.shift_id).filter(Boolean)
      .map((sid) => {
        const s = loadShift(sid);
        const list = db.prepare('SELECT * FROM stempel WHERE user_id = ? AND shift_id = ? ORDER BY kommen_at').all(userId, sid);
        return { dienst: shiftInfo(s), ...summary(list, settings, t), offen: list.some((x) => !x.gehen_at) };
      }).filter((x) => !x.offen);
    return { server_now: t, heute, laufend, vorschlag, erledigt, einstellungen: { mindestpause_ergaenzen: settings.mindestpause_ergaenzen !== false, raucherpause_abziehen: settings.raucherpause_abziehen !== false } };
  };

  app.get('/api/stempel', auth, wrap((req) => statusFor(req.user.id)));

  app.post('/api/stempel/kommen', auth, wrap((req) => {
    if (schonGesehen(req)) return statusFor(req.user.id);
    const { t, offline } = zeitpunkt(req);
    const o = offen(req.user.id);
    if (o) throw new HttpError(409, o && now() - o.kommen_at > 16 * 3600e3
      ? 'Sie sind seit über 16 Std. eingestempelt – bitte zuerst „Gehen“ mit der tatsächlichen Uhrzeit nachtragen.'
      : 'Sie sind bereits eingestempelt.', 'OFFEN');
    const s = req.body?.shift_id ? db.prepare('SELECT s.* FROM shifts s JOIN assignments a ON a.shift_id = s.id WHERE s.id = ? AND a.user_id = ?').get(Number(req.body.shift_id), req.user.id) : findShift(req.user.id, t);
    let sh = s;
    if (!sh && ctx.demo) {
      // Demo: automatisch in den laufenden Dienst einspringen (wird im Dienstplan eingetragen)
      sh = laufenderDienst(req.user.id, t);
      if (sh) db.prepare('INSERT OR IGNORE INTO assignments (shift_id, user_id, created_by) VALUES (?, ?, ?)').run(sh.id, req.user.id, req.user.id);
    }
    if (!sh) throw new HttpError(400, 'Für jetzt ist kein Dienst für Sie geplant. Bitte tragen Sie sich zuerst im Dienstplan ein (z. B. beim Einspringen).', 'KEIN_DIENST');
    db.prepare('INSERT INTO stempel (user_id, shift_id, kommen_at, offline) VALUES (?, ?, ?, ?)').run(req.user.id, sh.id, t, offline ? 1 : 0);
    audit(req.user.id, 'stempel.kommen', { shift_id: sh.id, zeit: wall(t).hms });
    return statusFor(req.user.id);
  }));

  const needOffen = (userId) => {
    const o = offen(userId);
    if (!o) throw new HttpError(400, 'Sie sind nicht eingestempelt.', 'NICHT_EINGESTEMPELT');
    return o;
  };

  app.post('/api/stempel/pause', auth, wrap((req) => {
    if (schonGesehen(req)) return statusFor(req.user.id);
    const o = needOffen(req.user.id);
    const { t, offline } = zeitpunkt(req, letzteZeit(o));
    if (offline) db.prepare('UPDATE stempel SET offline = 1 WHERE id = ?').run(o.id);
    const art = req.body?.art === 'raucher' ? 'raucher' : 'pause';
    if (db.prepare('SELECT 1 FROM stempel_pausen WHERE stempel_id = ? AND ende_at IS NULL').get(o.id)) throw new HttpError(409, 'Es läuft bereits eine Pause.', 'PAUSE_LAEUFT');
    db.prepare('INSERT INTO stempel_pausen (stempel_id, art, start_at) VALUES (?, ?, ?)').run(o.id, art, t);
    audit(req.user.id, art === 'raucher' ? 'stempel.raucherpause' : 'stempel.pause', {});
    return statusFor(req.user.id);
  }));

  app.post('/api/stempel/weiter', auth, wrap((req) => {
    if (schonGesehen(req)) return statusFor(req.user.id);
    const o = needOffen(req.user.id);
    const { t, offline } = zeitpunkt(req, letzteZeit(o));
    if (offline) db.prepare('UPDATE stempel SET offline = 1 WHERE id = ?').run(o.id);
    const r = db.prepare('UPDATE stempel_pausen SET ende_at = ? WHERE stempel_id = ? AND ende_at IS NULL').run(t, o.id);
    if (!r.changes) throw new HttpError(400, 'Es läuft keine Pause.');
    return statusFor(req.user.id);
  }));

  app.post('/api/stempel/gehen', auth, wrap((req) => {
    if (schonGesehen(req)) return statusFor(req.user.id);
    const o = needOffen(req.user.id);
    const zp = zeitpunkt(req, letzteZeit(o));
    let t = zp.t;
    let korrigiert = 0;
    if (zp.offline) db.prepare('UPDATE stempel SET offline = 1 WHERE id = ?').run(o.id);
    // vergessenes Ausstempeln: Uhrzeit nachtragen (nur wenn seit über 12 Std. eingestempelt)
    if (req.body?.zeit) {
      if (t - o.kommen_at < 12 * 3600e3) throw new HttpError(400, 'Eine Uhrzeit kann nur nachgetragen werden, wenn das Ausstempeln vergessen wurde.');
      if (!isTime(req.body.zeit)) throw new HttpError(400, 'Uhrzeit als HH:MM angeben.');
      const k = wall(o.kommen_at);
      let ziel = T.parseDate(k.date) + T.toMinutes(req.body.zeit) * MIN;
      if (ziel <= k.wms) ziel += T.DAY;
      t = o.kommen_at + (ziel - k.wms);
      if (t > now() || t - o.kommen_at > 16 * 3600e3) throw new HttpError(400, 'Die Uhrzeit liegt nicht plausibel nach dem Kommen (höchstens 16 Std.).');
      korrigiert = 1;
    }
    db.prepare('UPDATE stempel_pausen SET ende_at = ? WHERE stempel_id = ? AND ende_at IS NULL').run(t, o.id);
    db.prepare('UPDATE stempel SET gehen_at = ?, korrigiert = ?, note = ? WHERE id = ?').run(t, korrigiert, String(req.body?.note || '').slice(0, 300), o.id);
    const sum = uebernehmen(req.user.id, o.shift_id, req.user.id);
    audit(req.user.id, 'stempel.gehen', { shift_id: o.shift_id, zeit: wall(t).hms, nachgetragen: !!korrigiert, netto_min: sum?.netto_min });
    return { ...statusFor(req.user.id), ergebnis: sum };
  }));

  // Versehentlich eingestempelt: innerhalb von 10 Minuten zurücknehmen
  app.delete('/api/stempel/offen', auth, wrap((req) => {
    const o = needOffen(req.user.id);
    if (now() - o.kommen_at > 10 * MIN) throw new HttpError(400, 'Zurücknehmen ist nur in den ersten 10 Minuten möglich – bitte stattdessen „Gehen“.');
    db.prepare('DELETE FROM stempel WHERE id = ?').run(o.id);
    audit(req.user.id, 'stempel.zurueckgenommen', {});
    return statusFor(req.user.id);
  }));

  /** Einzelheiten für die Zeiterfassung (Verwaltung und eigene Ansicht) */
  ctx.stempelDetails = (userId, shiftId) => db.prepare('SELECT * FROM stempel WHERE user_id = ? AND shift_id = ? ORDER BY kommen_at').all(userId, shiftId)
    .map((s) => ({
      kommen: wall(s.kommen_at).hms, gehen: s.gehen_at ? wall(s.gehen_at).hms : null, nachgetragen: !!s.korrigiert, offline: !!s.offline,
      pausen: pausenVon(s.id).map((p) => ({ art: p.art, von: wall(p.start_at).hms, bis: p.ende_at ? wall(p.ende_at).hms : null, min: p.ende_at ? Math.round((p.ende_at - p.start_at) / MIN) : null })),
    }));
  ctx.stempelSummary = summary;
};
