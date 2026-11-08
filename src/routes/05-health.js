'use strict';
/**
 * Überwachung: GET /api/health  → 200 {"status":"ok"} oder 503 (z. B. Datenbank nicht lesbar).
 * Mit ?backup=1 zusätzlich: 503, wenn die letzte erfolgreiche Sicherung älter als BACKUP_MAX_STD (Standard 26) Stunden ist
 * oder die letzte Sicherung fehlgeschlagen ist. Gibt keine personenbezogenen Daten aus.
 */
const fs = require('fs');
const path = require('path');
const { version } = require('../../package.json');

module.exports = (app, ctx) => {
  const started = Date.now();
  app.get('/api/health', (req, res) => {
    const out = { status: 'ok', version, laufzeit_std: Math.round((Date.now() - started) / 360e3) / 10 };
    let ok = true;
    try { ctx.db.prepare('SELECT COUNT(*) AS n FROM settings').get(); out.datenbank = 'ok'; } catch { out.datenbank = 'fehler'; ok = false; }
    try {
      const st = fs.statfsSync(path.dirname(ctx.uploadDir));
      out.speicher_frei_mb = Math.round((st.bavail * st.bsize) / 1048576);
      if (out.speicher_frei_mb < 200) { out.speicher = 'knapp'; ok = false; }
    } catch { /* nicht verfügbar */ }
    if (req.query.backup && ctx.backupDir) {
      const maxStd = Number(process.env.BACKUP_MAX_STD) || 26;
      let s = null;
      try { s = JSON.parse(fs.readFileSync(path.join(ctx.backupDir, 'letzte-sicherung.json'), 'utf8')); } catch { /* keine */ }
      if (!s?.zeit) { out.sicherung = 'keine'; ok = false; } else {
        out.sicherung_alter_std = Math.round((Date.now() - Date.parse(s.zeit)) / 360e3) / 10;
        out.sicherung_verschluesselt = !!s.verschluesselt;
        out.sicherung = s.ok === false ? 'fehlgeschlagen' : out.sicherung_alter_std > maxStd ? 'zu alt' : 'ok';
        if (out.sicherung !== 'ok') ok = false;
      }
    }
    if (!ok) out.status = 'fehler';
    res.setHeader('Cache-Control', 'no-store');
    res.status(ok ? 200 : 503).json(out);
  });
};
