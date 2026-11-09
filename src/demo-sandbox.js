'use strict';
/**
 * Demo-Bereich: eine zweite, vollständig getrennte Instanz mit Beispieldaten unter <BASE_PATH>/demo/.
 * Anmeldung per Rollenauswahl ohne Passwort und Code. Die echten Daten sind von dort aus nicht erreichbar
 * (eigene Datenbank, eigener Upload-Ordner, eigenes Anmelde-Cookie).
 * Die Beispieldaten werden beim Start und jede Nacht neu aufgebaut, inkl. eines gefüllten Dienstplans.
 */
const fs = require('fs');
const path = require('path');
const { openDb } = require('./db');
const { createApp } = require('./app');

const iso = (t) => new Date(t).toISOString().slice(0, 10);

function createDemoSandbox({ dir, base, liveLink, feedbackSink }) {
  let current = null; // { db, handler }

  const build = () => {
    fs.rmSync(dir, { recursive: true, force: true });
    const db = openDb(path.join(dir, 'demo.db'), { demo: true });
    const handler = createApp(db, {
      basePath: base, demo: true, cookieName: 'sid_demo', liveLink, feedbackSink,
      uploadDir: path.join(dir, 'uploads'), timers: false,
    });
    return { db, handler };
  };

  /** Dienstplan mit der echten Logik füllen (Schichten erzeugen, Planvorschlag übernehmen) */
  const populate = async (origin) => {
    let cookie = '';
    const call = async (method, url, body) => {
      const r = await fetch(`${origin}${base}/${url}`, {
        method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
      });
      const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      return r.json().catch(() => null);
    };
    await call('POST', 'api/demo/login', { username: 'manager' });
    const now = Date.now();
    const monday = now - ((new Date(now).getUTCDay() + 6) % 7) * 864e5;
    await call('POST', 'api/shifts/generate', { from: iso(monday - 7 * 864e5), to: iso(monday + 34 * 864e5) });
    // vergangene Tage dieser und letzter Woche sowie die nächsten Wochen besetzen (bewusst mit ein paar Lücken)
    const v = await call('POST', 'api/planvorschlag', { from: iso(monday - 7 * 864e5), to: iso(monday + 34 * 864e5) });
    const items = (v?.vorschlaege || []).filter((_, i) => i % 9 !== 4).map((x) => ({ shift_id: x.shift_id, user_id: x.user_id }));
    if (items.length) await call('POST', 'api/planvorschlag/uebernehmen', { items });
    await call('POST', 'api/logout');
  };

  const reset = async (origin) => {
    const old = current;
    current = build();
    try { old?.db.close(); } catch { /* bereits geschlossen */ }
    if (origin) await populate(origin).catch((e) => console.error('Demo-Daten:', e.message));
  };

  current = build();
  return {
    handler: (req, res, next) => current.handler(req, res, next),
    matches: (p) => p === base || p.startsWith(`${base}/`) || p.toLowerCase() === base.toLowerCase() || p.toLowerCase().startsWith(`${base.toLowerCase()}/`),
    reset,
    populate: (origin) => populate(origin).catch((e) => console.error('Demo-Daten:', e.message)),
  };
}

module.exports = { createDemoSandbox };
