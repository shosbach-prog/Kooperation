'use strict';
/**
 * Datenschutz: Impressum/Datenschutzhinweise (öffentlich lesbar), automatische Löschfristen,
 * Auskunft über die eigenen Daten (Art. 15 DSGVO).
 */
const fs = require('fs');
const path = require('path');

const MUSTER_DATENSCHUTZ = `MUSTER – vor Inbetriebnahme mit der bzw. dem Datenschutzbeauftragten abstimmen und unter Einstellungen ersetzen.

Verantwortliche Stelle
{klinik}, Anschrift und Kontakt siehe Impressum. Kontakt der bzw. des Datenschutzbeauftragten: [bitte ergänzen].

Zweck der Verarbeitung
Planung und Dokumentation der Dienste, Abwesenheiten und Arbeitszeiten der Beschäftigten sowie Berechnung von Zeitzuschlägen nach TVöD.

Rechtsgrundlage
§ 26 BDSG bzw. die entsprechende landesrechtliche Regelung (Beschäftigtendatenschutz), Art. 6 Abs. 1 lit. b und c DSGVO, für Gesundheitsdaten (Arbeitsunfähigkeit) Art. 9 Abs. 2 lit. b DSGVO; Dienstvereinbarung mit dem Personalrat [bitte ergänzen].

Verarbeitete Daten
Name, Benutzername, Qualifikation, Stammbereich, Arbeitszeitvorgaben, geplante und tatsächliche Dienstzeiten, Dienstwünsche, Abwesenheiten (bei Krankheit nur Zeitraum und AU-Bescheinigung, keine Diagnose), freiwillig ein Profilfoto, Protokoll der Änderungen, technisch notwendige Sitzungsdaten.

Empfänger
Einsatzplanung und Stationsleitungen im jeweiligen Verwaltungsbereich; die Entgeltabrechnung erhält monatliche Summen. Hosting: [Dienstleister, Auftragsverarbeitungsvertrag nach Art. 28 DSGVO].

Speicherdauer
AU-Bescheinigungen werden {au} Monate nach Ende der Abwesenheit gelöscht, Protokolleinträge nach {log} Monaten, Mitteilungen nach {msg} Tagen. Weitere Daten werden gelöscht, sobald sie für das Beschäftigungsverhältnis nicht mehr erforderlich sind und keine Aufbewahrungspflicht besteht.

Cookies
Es wird ausschließlich ein technisch notwendiges Sitzungs-Cookie gesetzt. Es findet kein Tracking statt, es werden keine Inhalte von Drittanbietern geladen.

Ihre Rechte
Auskunft (unter „Mein Profil → Meine Daten herunterladen“), Berichtigung, Löschung, Einschränkung, Widerspruch sowie Beschwerde bei der Aufsichtsbehörde (Landesbeauftragte für Datenschutz und Informationsfreiheit NRW).`;

module.exports = (app, ctx) => {
  const { db, T, auth, managerFull, wrap, audit, getSettings, uploadDir, nowLocalMs, publicUser } = ctx;

  app.get('/api/legal', wrap(() => {
    const s = getSettings();
    const muster = !String(s.datenschutz_text || '').trim();
    const ds = muster
      ? MUSTER_DATENSCHUTZ.replace('{klinik}', s.klinik_name).replace('{au}', s.loeschfrist_au_monate || '–')
        .replace('{log}', s.loeschfrist_protokoll_monate || '–').replace('{msg}', s.loeschfrist_mitteilungen_tage || '–')
      : s.datenschutz_text;
    return { klinik_name: s.klinik_name, impressum: s.impressum_text || '', datenschutz: ds, datenschutz_muster: muster };
  }));

  /** Daten nach Ablauf der Fristen löschen; liefert die Anzahl je Art */
  const cleanup = () => {
    const s = getSettings();
    const today = T.isoDate(nowLocalMs());
    const monthsAgo = (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 10); };
    const out = { au: 0, protokoll: 0, mitteilungen: 0, sitzungen: 0 };
    const au = Number(s.loeschfrist_au_monate) || 0;
    if (au > 0) {
      const files = db.prepare(`SELECT f.id, f.stored_name FROM attachments f JOIN absences a ON a.id = f.absence_id WHERE a.to_date < ?`).all(monthsAgo(au));
      for (const f of files) {
        fs.rmSync(path.join(uploadDir, f.stored_name), { force: true });
        db.prepare('DELETE FROM attachments WHERE id = ?').run(f.id);
      }
      out.au = files.length;
    }
    const log = Number(s.loeschfrist_protokoll_monate) || 0;
    if (log > 0) out.protokoll = Number(db.prepare('DELETE FROM audit_log WHERE at < ?').run(`${monthsAgo(log)} 00:00:00`).changes);
    const msg = Number(s.loeschfrist_mitteilungen_tage) || 0;
    if (msg > 0) out.mitteilungen = Number(db.prepare("DELETE FROM notifications WHERE created_at < datetime('now', ?)").run(`-${msg} days`).changes);
    out.sitzungen = Number(db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()).changes);
    db.prepare("DELETE FROM reminders_sent WHERE at < datetime('now', '-400 days')").run();
    if (out.au || out.protokoll || out.mitteilungen) audit(null, 'datenschutz.loeschung', out);
    return out;
  };
  ctx.cleanup = cleanup;

  app.post('/api/admin/cleanup', auth, managerFull, wrap((req) => {
    const r = cleanup();
    audit(req.user.id, 'datenschutz.loeschlauf', r);
    return r;
  }));

  // Auskunft über die eigenen Daten (maschinenlesbar)
  app.get('/api/me/export', auth, wrap((req, res) => {
    const id = req.user.id;
    const q = (sql) => db.prepare(sql).all(id);
    const data = {
      erstellt: new Date().toISOString(),
      person: publicUser(req.user),
      dienste: q(`SELECT s.date, s.start_time, s.end_time, s.break_min, st.name AS dienst, un.name AS station, a.ist_start, a.ist_end, a.ist_pause, a.ist_note, a.einsatz_std
        FROM assignments a JOIN shifts s ON s.id = a.shift_id JOIN shift_types st ON st.id = s.shift_type_id JOIN units un ON un.id = s.unit_id WHERE a.user_id = ? ORDER BY s.date`),
      abwesenheiten: q('SELECT type, from_date, to_date, status, note, created_at FROM absences WHERE user_id = ? ORDER BY from_date'),
      au_dateien: q('SELECT f.filename, f.uploaded_at FROM attachments f JOIN absences a ON a.id = f.absence_id WHERE a.user_id = ?'),
      wuensche: q('SELECT date, art, note FROM wishes WHERE user_id = ? ORDER BY date'),
      mitteilungen: q('SELECT titel, text, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY id'),
      protokoll_eigene_aktionen: q('SELECT at, action, details FROM audit_log WHERE actor_id = ? ORDER BY id'),
    };
    audit(id, 'datenschutz.auskunft', {});
    res.setHeader('Content-Disposition', `attachment; filename="meine-daten-${T.isoDate(nowLocalMs())}.json"`);
    res.json(data);
  }));

  if (ctx.timers) {
    setTimeout(() => { try { cleanup(); } catch (e) { console.error('Löschlauf', e); } }, 5000).unref();
    setInterval(() => { try { cleanup(); } catch (e) { console.error('Löschlauf', e); } }, 24 * 3600e3).unref();
  }
};
