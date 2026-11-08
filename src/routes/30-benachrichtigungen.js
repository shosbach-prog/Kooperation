'use strict';
/**
 * Benachrichtigungen: in der App (Glocke), als Push-Nachricht aufs Handy (installierte App, Web Push)
 * und optional per E-Mail (wenn SMTP_HOST gesetzt ist).
 */
const webpush = require('web-push');
const nodemailer = require('nodemailer');

module.exports = (app, ctx) => {
  const { db, HttpError, auth, manager, wrap, audit, getSettings, loadShifts, absenceOn, checkConflicts, hooks } = ctx;

  // --- Push-Schlüssel (VAPID) einmalig erzeugen und sicher ablegen ---
  const secret = (k) => db.prepare('SELECT value FROM secrets WHERE key = ?').get(k)?.value;
  if (!secret('vapid_public')) {
    const keys = webpush.generateVAPIDKeys();
    db.prepare('INSERT INTO secrets (key, value) VALUES (?, ?), (?, ?)').run('vapid_public', keys.publicKey, 'vapid_private', keys.privateKey);
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:dienstplan@localhost', secret('vapid_public'), secret('vapid_private'));

  // --- E-Mail (optional) ---
  const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT) || 587, secure: process.env.SMTP_SECURE === '1',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  }) : null;
  const appUrl = process.env.APP_URL || '';

  ctx.sentPush = []; // für Tests: zuletzt versendete Push-Nachrichten
  ctx.sentMail = [];

  /** Zentrale Funktion: legt Mitteilungen an und verschickt Push/E-Mail im Hintergrund */
  hooks.notify = (userIds, { titel, text = '', link = '', art = '' }) => {
    const ids = [...new Set((userIds || []).filter(Boolean).map(Number))];
    if (!ids.length) return;
    const ins = db.prepare('INSERT INTO notifications (user_id, titel, text, link, art) VALUES (?, ?, ?, ?, ?)');
    for (const id of ids) ins.run(id, titel, text, link, art);
    const klinik = getSettings().klinik_name;
    for (const id of ids) {
      for (const sub of db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(id)) {
        const payload = JSON.stringify({ titel, text, link, tag: art || 'info', klinik });
        ctx.sentPush.push({ user_id: id, titel });
        webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 24 * 3600 })
          .catch((e) => { if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id); });
      }
      const u = db.prepare('SELECT email, notify_email, name FROM users WHERE id = ? AND active = 1').get(id);
      if (mailer && u?.email && u.notify_email) {
        ctx.sentMail.push({ to: u.email, titel });
        mailer.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER, to: u.email, subject: `${titel} – ${klinik}`,
          text: `Hallo ${u.name},\n\n${text}\n\n${appUrl ? `Zum Dienstplan: ${appUrl}${link}\n\n` : ''}Diese Nachricht wurde automatisch versendet. `
            + 'E-Mail-Benachrichtigungen können Sie im Dienstplan unter „Mein Profil“ abschalten.',
        }).catch((e) => console.error('E-Mail fehlgeschlagen:', e.message));
      }
    }
  };

  app.get('/api/notifications', auth, wrap((req) => ({
    items: db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id),
    unread: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id).n,
  })));
  app.post('/api/notifications/read', auth, wrap((req) => {
    if (Array.isArray(req.body?.ids)) {
      const upd = db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND user_id = ? AND read_at IS NULL");
      for (const id of req.body.ids) upd.run(Number(id), req.user.id);
    } else {
      db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").run(req.user.id);
    }
    return { ok: true };
  }));

  app.get('/api/push/key', auth, wrap(() => ({ key: secret('vapid_public') })));
  app.post('/api/push/subscribe', auth, wrap((req) => {
    const sub = req.body?.subscription;
    if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new HttpError(400, 'Ungültiges Abonnement.');
    db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
      .run(req.user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
    return { ok: true, geraete: db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(req.user.id).n };
  }));
  app.delete('/api/push/subscribe', auth, wrap((req) => {
    if (req.body?.endpoint) db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(req.user.id, String(req.body.endpoint));
    else db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(req.user.id);
    return { ok: true };
  }));
  app.get('/api/me/notify-prefs', auth, wrap((req) => ({
    email: !!req.user.notify_email, email_verfuegbar: !!mailer, hat_email: !!req.user.email,
    geraete: db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(req.user.id).n,
  })));
  app.put('/api/me/notify-prefs', auth, wrap((req) => {
    if ('email' in (req.body || {})) db.prepare('UPDATE users SET notify_email = ? WHERE id = ?').run(req.body.email ? 1 : 0, req.user.id);
    return { ok: true };
  }));
  app.post('/api/me/notify-test', auth, wrap((req) => {
    hooks.notify([req.user.id], { titel: 'Test-Benachrichtigung', text: 'So sehen Benachrichtigungen aus.', link: '#account', art: 'test' });
    return { ok: true };
  }));

  /**
   * Rundruf: Für einen unterbesetzten Dienst alle Mitarbeitenden benachrichtigen, die ihn übernehmen könnten
   * (nicht abwesend, keine Überschneidung oder Ruhezeitverletzung, nicht schon eingetragen).
   */
  app.post('/api/shifts/:id/rundruf', auth, manager, wrap((req) => {
    const s = loadShifts('s.id = ?', [Number(req.params.id)])[0];
    if (!s) throw new HttpError(404, 'Schicht nicht gefunden.');
    ctx.requireUnit(req, s.unit_id);
    const settings = getSettings();
    const qual = String(req.body?.qualification || '');
    const kandidaten = db.prepare("SELECT * FROM users WHERE active = 1 AND role = 'staff' AND (austritt = '' OR austritt >= ?)").all(s.date)
      .filter((u) => !s.assigned.some((a) => a.user_id === u.id))
      .filter((u) => !qual || u.qualification === qual)
      .filter((u) => !absenceOn(u.id, s.date))
      .filter((u) => !checkConflicts(s, u.id, settings));
    const note = String(req.body?.note || '').trim().slice(0, 300);
    hooks.notify(kandidaten.map((u) => u.id), {
      titel: 'Dienst unbesetzt – wer kann?', link: '#plan', art: 'rundruf',
      text: `${ctx.shiftLabel(s.id)}${qual ? ` · gesucht: ${qual}` : ''}${note ? ` – ${note}` : ''}. Bitte im Dienstplan eintragen.`,
    });
    audit(req.user.id, 'rundruf', { shift_id: s.id, empfaenger: kandidaten.length, qualification: qual, reason: note });
    return { empfaenger: kandidaten.length };
  }));

  // --- tägliche Erinnerung: fehlende AU-Bescheinigungen ---
  const once = (key) => {
    try { db.prepare('INSERT INTO reminders_sent (key) VALUES (?)').run(key); return true; } catch { return false; }
  };
  ctx.remindAU = () => {
    const settings = getSettings();
    const rows = db.prepare("SELECT a.*, u.name FROM absences a JOIN users u ON u.id = a.user_id WHERE a.type = 'krank' AND a.status = 'gemeldet' AND a.to_date >= date('now', '-30 day')").all();
    let n = 0;
    for (const a of rows) {
      const d = ctx.decorateAbsence(a, settings);
      if (!d.au_ueberfaellig || !once(`au-${a.id}`)) continue;
      n++;
      hooks.notify([a.user_id], { titel: 'AU-Bescheinigung fehlt', text: `Bitte laden Sie die Arbeitsunfähigkeitsbescheinigung für Ihre Krankmeldung ab ${a.from_date.split('-').reverse().join('.')} hoch.`, link: '#abwesenheit', art: 'au' });
      hooks.notify(ctx.managerIds(), { titel: 'AU fehlt', text: `${a.name}: Krankmeldung ab ${a.from_date.split('-').reverse().join('.')} – Bescheinigung noch nicht hochgeladen.`, link: '#abwesenheiten', art: 'au' });
    }
    return n;
  };
  if (ctx.timers) setInterval(() => { try { ctx.remindAU(); } catch (e) { console.error(e); } }, 3600e3).unref();
  app.post('/api/admin/run-reminders', auth, ctx.managerFull, wrap(() => ({ au: ctx.remindAU() })));
};
