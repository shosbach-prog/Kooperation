'use strict';
/**
 * Kalender-Abo: Jede Person erhält einen geheimen Link (iCalendar/ICS), über den ihr Handy-
 * oder PC-Kalender die eigenen Dienste und Abwesenheiten automatisch abruft.
 */
const crypto = require('crypto');

const VTIMEZONE = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:MESZ', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:MEZ', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

const esc = (t) => String(t ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
/** Zeilen nach RFC 5545 auf 75 Bytes falten */
const fold = (line) => {
  const out = [];
  let buf = Buffer.from(line, 'utf8');
  while (buf.length > 75) {
    let cut = 75;
    while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--; // keine UTF-8-Zeichen zerschneiden
    out.push(buf.subarray(0, cut).toString('utf8'));
    buf = Buffer.concat([Buffer.from(' '), buf.subarray(cut)]);
  }
  out.push(buf.toString('utf8'));
  return out.join('\r\n');
};
const dt = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 15); // lokale Wandzeit (intern UTC gerechnet)
const dateOnly = (iso) => iso.replace(/-/g, '');

module.exports = (app, ctx) => {
  const { db, T, HttpError, auth, wrap, audit, getSettings } = ctx;
  const newToken = () => crypto.randomBytes(24).toString('base64url');

  const tokenFor = (userId, renew = false) => {
    const u = db.prepare('SELECT ical_token FROM users WHERE id = ?').get(userId);
    if (u.ical_token && !renew) return u.ical_token;
    const t = newToken();
    db.prepare('UPDATE users SET ical_token = ? WHERE id = ?').run(t, userId);
    return t;
  };

  app.get('/api/me/ical', auth, wrap((req) => ({ token: tokenFor(req.user.id) })));
  app.post('/api/me/ical/renew', auth, wrap((req) => {
    const token = tokenFor(req.user.id, true);
    audit(req.user.id, 'ical.renew', { user_id: req.user.id });
    return { token };
  }));

  // Abruf durch die Kalender-App (ohne Anmeldung, nur mit geheimem Link)
  app.get('/api/ical/:token.ics', (req, res, next) => {
    try {
      const token = String(req.params.token || '');
      if (token.length < 20) throw new HttpError(404, 'Unbekannter Kalender.');
      const u = db.prepare("SELECT * FROM users WHERE ical_token = ? AND active = 1 AND (austritt = '' OR austritt >= date('now'))").get(token);
      if (!u) throw new HttpError(404, 'Unbekannter Kalender.');
      const st = getSettings();
      const today = Date.now();
      const from = T.isoDate(today - 30 * T.DAY), to = T.isoDate(today + 400 * T.DAY);
      const shifts = db.prepare(`SELECT s.*, st.name AS type_name, st.code, un.name AS unit_name, b.name AS building_name
        FROM assignments a JOIN shifts s ON s.id = a.shift_id JOIN shift_types st ON st.id = s.shift_type_id
        JOIN units un ON un.id = s.unit_id LEFT JOIN buildings b ON b.id = un.building_id
        WHERE a.user_id = ? AND s.date BETWEEN ? AND ? ORDER BY s.date, s.start_time`).all(u.id, from, to);
      const abs = db.prepare(`SELECT * FROM absences WHERE user_id = ? AND status IN ('genehmigt','gemeldet','beantragt')
        AND to_date >= ? AND from_date <= ?`).all(u.id, from, to);
      const LABEL = { urlaub: 'Urlaub', zusatzurlaub: 'Zusatzurlaub', sonderurlaub: 'Sonderurlaub', krank: 'krank', fortbildung: 'Fortbildung',
        kind_krank: 'Kind krank', elternzeit: 'Elternzeit' };
      const stamp = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
      const host = req.hostname || 'dienstplan';
      const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Personaleinsatzplanung//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
        `X-WR-CALNAME:${esc(`Dienstplan ${st.klinik_name}`)}`, 'X-WR-TIMEZONE:Europe/Berlin', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
        'X-PUBLISHED-TTL:PT1H', ...VTIMEZONE];
      for (const s of shifts) {
        const iv = T.shiftInterval(s.date, s.start_time, s.end_time);
        lines.push('BEGIN:VEVENT', `UID:dienst-${s.id}-${u.id}@${host}`, `DTSTAMP:${stamp}`,
          `DTSTART;TZID=Europe/Berlin:${dt(iv.start)}`, `DTEND;TZID=Europe/Berlin:${dt(iv.end)}`,
          `SUMMARY:${esc(`${s.code} ${s.type_name} · ${s.unit_name}`)}`,
          `LOCATION:${esc([s.unit_name, s.building_name, st.klinik_name].filter(Boolean).join(', '))}`,
          `DESCRIPTION:${esc(`${s.type_name} ${s.start_time}–${s.end_time} (Pause ${s.break_min} Min.)${s.note ? `\n${s.note}` : ''}`)}`,
          'TRANSP:OPAQUE', 'END:VEVENT');
      }
      for (const a of abs) {
        lines.push('BEGIN:VEVENT', `UID:abwesenheit-${a.id}@${host}`, `DTSTAMP:${stamp}`,
          `DTSTART;VALUE=DATE:${dateOnly(a.from_date)}`, `DTEND;VALUE=DATE:${dateOnly(T.isoDate(T.parseDate(a.to_date) + T.DAY))}`,
          `SUMMARY:${esc(`${LABEL[a.type] || a.type}${a.status === 'beantragt' ? ' (beantragt)' : ''}`)}`, 'TRANSP:TRANSPARENT', 'END:VEVENT');
      }
      lines.push('END:VCALENDAR');
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Disposition', 'inline; filename="dienstplan.ics"');
      res.send(lines.map(fold).join('\r\n') + '\r\n');
    } catch (e) { next(e); }
  });
};
