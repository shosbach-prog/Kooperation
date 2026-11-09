'use strict';
/**
 * Rückmeldungen (Pilotbetrieb): Fehler, Ideen, Lob, Fragen direkt aus der App.
 * Die Hauptverwaltung sieht alle, setzt den Status und antwortet (Antwort erscheint als Mitteilung).
 * Im Demo-Bereich werden Rückmeldungen in die Hauptdatenbank weitergereicht (opts.feedbackSink), damit sie nicht
 * mit den nächtlich erneuerten Demodaten verloren gehen.
 */
module.exports = (app, ctx) => {
  const { db, HttpError, auth, managerFull, wrap, audit, hooks } = ctx;
  const ARTEN = ['fehler', 'idee', 'lob', 'frage'];
  const STATUS = ['neu', 'in_arbeit', 'erledigt'];

  const geraet = (ua = '') => (/iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'anderes')
    + (/Edg\//.test(ua) ? ' · Edge' : /Chrome\//.test(ua) ? ' · Chrome' : /Firefox\//.test(ua) ? ' · Firefox' : /Safari\//.test(ua) ? ' · Safari' : '');

  /** Rückmeldung speichern (auch vom Demo-Bereich aus aufgerufen) */
  const speichern = (r) => {
    const heute = db.prepare(`SELECT COUNT(*) AS n FROM rueckmeldungen WHERE created_at > datetime('now', '-1 day') AND ${r.user_id ? 'user_id = ?' : 'quelle = ?'}`)
      .get(r.user_id || r.quelle).n;
    if (heute >= (r.user_id ? 20 : 200)) throw new HttpError(429, 'Heute wurden schon sehr viele Rückmeldungen gesendet. Bitte morgen weiter.');
    const id = db.prepare('INSERT INTO rueckmeldungen (user_id, name, quelle, art, text, ansicht, geraet) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(r.user_id || null, r.name, r.quelle, r.art, r.text, r.ansicht, r.geraet).lastInsertRowid;
    const haupt = db.prepare("SELECT id FROM users WHERE active = 1 AND (role = 'manager' OR (admin_rechte = 'voll' AND admin_units = ''))").all().map((x) => x.id);
    hooks.notify(haupt, { titel: `Neue Rückmeldung: ${{ fehler: 'Fehler', idee: 'Idee', lob: 'Lob', frage: 'Frage' }[r.art]}`, text: `${r.name}: ${r.text.slice(0, 120)}`, link: 'rueckmeldung', art: 'rueckmeldung' });
    return id;
  };
  ctx.rueckmeldungSpeichern = speichern;

  app.post('/api/rueckmeldung', auth, wrap((req) => {
    const b = req.body || {};
    const text = String(b.text || '').trim().slice(0, 2000);
    if (text.length < 5) throw new HttpError(400, 'Bitte beschreiben Sie Ihr Anliegen in ein paar Worten.');
    const r = {
      user_id: req.user.id, name: req.user.name, quelle: 'app', art: ARTEN.includes(b.art) ? b.art : 'idee', text,
      ansicht: String(b.ansicht || '').slice(0, 40), geraet: geraet(req.headers['user-agent']),
    };
    if (ctx.feedbackSink) {
      ctx.feedbackSink({ ...r, user_id: null, name: `${req.user.name} (Demo)`, quelle: 'demo' });
      return { ok: true, demo: true };
    }
    return { ok: true, id: speichern(r) };
  }));

  app.get('/api/rueckmeldungen', auth, wrap((req) => {
    const alle = ctx.isHaupt(req.user) && req.query.alle;
    return db.prepare(`SELECT r.*, b.name AS beantwortet_von_name FROM rueckmeldungen r LEFT JOIN users b ON b.id = r.beantwortet_von
      ${alle ? '' : 'WHERE r.user_id = ?'} ORDER BY CASE r.status WHEN 'neu' THEN 0 WHEN 'in_arbeit' THEN 1 ELSE 2 END, r.id DESC LIMIT 500`)
      .all(...(alle ? [] : [req.user.id]));
  }));

  app.put('/api/rueckmeldungen/:id', auth, managerFull, wrap((req) => {
    const r = db.prepare('SELECT * FROM rueckmeldungen WHERE id = ?').get(Number(req.params.id));
    if (!r) throw new HttpError(404, 'Nicht gefunden.');
    const status = STATUS.includes(req.body?.status) ? req.body.status : r.status;
    const antwort = req.body?.antwort === undefined ? r.antwort : String(req.body.antwort).trim().slice(0, 2000);
    db.prepare("UPDATE rueckmeldungen SET status = ?, antwort = ?, beantwortet_von = ?, beantwortet_am = datetime('now') WHERE id = ?").run(status, antwort, req.user.id, r.id);
    if (r.user_id && antwort && antwort !== r.antwort) {
      hooks.notify([r.user_id], { titel: 'Antwort auf Ihre Rückmeldung', text: antwort.slice(0, 200), link: 'rueckmeldung', art: 'rueckmeldung' });
    }
    audit(req.user.id, 'rueckmeldung.bearbeitet', { id: r.id, status });
    return { ok: true };
  }));
};
