'use strict';
/**
 * Exporte: Lohn-Übergabe (CSV je Personalnummer und Lohnart) und Dienstplan-Aushang (A4 quer, druckfertig).
 * Der Aushang zeigt bewusst keine Abwesenheitsgründe (Datenschutz) – nur Dienste.
 */
module.exports = (app, ctx) => {
  const { db, T, HttpError, auth, manager, managerFull, wrap, audit, getSettings, isoDate, requireUnit } = ctx;

  const LOHNARTEN = [
    // Schlüssel, Bezeichnung, Feld im Bericht, Einheit, Betragsfeld
    ['stunden', 'Gearbeitete Stunden (Dienste, ohne Bereitschaft/Ruf)', 'dienst_std', 'Std.'],
    ['ueberstunden', 'Mehr-/Minderarbeit (Ist − Plan)', 'ueberstunden', 'Std.'],
    ['nacht', 'Zeitzuschlag Nachtarbeit', 'nacht', 'Std.'],
    ['samstag', 'Zeitzuschlag Samstag', 'samstag', 'Std.'],
    ['sonntag', 'Zeitzuschlag Sonntag', 'sonntag', 'Std.'],
    ['feiertag', 'Zeitzuschlag Feiertag', 'feiertag', 'Std.'],
    ['vorfest', 'Zeitzuschlag 24./31.12.', 'vorfest', 'Std.'],
    ['zuschlaege_eur', 'Zeitzuschläge gesamt', null, 'EUR', 'zuschlag_eur'],
    ['zulage', 'Wechselschicht-/Schichtzulage', null, 'EUR', 'zulage_eur'],
    ['bereitschaft', 'Bereitschaftsdienst (bewertet)', 'bereitschaft_std', 'Std.'],
    ['ruf_pauschale', 'Rufbereitschaft Pauschale', 'ruf_dienste', 'Anzahl', 'ruf_eur'],
    ['ruf_einsatz', 'Rufbereitschaft Einsatzstunden', 'ruf_einsatz_std', 'Std.'],
    ['urlaub_tage', 'Erholungsurlaub', 'urlaub_tage', 'Tage'],
    ['krank_tage', 'Arbeitsunfähigkeit', 'krank_tage', 'Tage'],
    ['sonder_tage', 'Sonderurlaub / Zusatzurlaub', 'sonder_tage', 'Tage'],
    ['fortbildung_tage', 'Fortbildung', 'fortbildung_tage', 'Tage'],
    ['unbezahlt_tage', 'Kind krank / Elternzeit (ohne Entgelt)', 'unbezahlt_tage', 'Tage'],
  ];
  /** Lohnart-Nummern aus den Einstellungen („nacht=1110“ je Zeile) */
  const nummern = () => Object.fromEntries((getSettings().lohnarten || []).map((l) => String(l).split('=').map((x) => x.trim())).filter((x) => x.length === 2 && x[0]));

  const lohn = (month) => {
    const r = ctx.report(month, null);
    const users = Object.fromEntries(db.prepare('SELECT id, personalnummer FROM users').all().map((u) => [u.id, u.personalnummer || '']));
    const nr = nummern();
    const lines = [];
    // Externe (Zeitarbeit/Leasing) werden über ihre Firma abgerechnet – nicht in der Lohn-Übergabe
    for (const x0 of r.rows.filter((x) => x.beschaeftigung !== 'extern')) {
      // „gearbeitet“ enthält auch bewertete Bereitschaft und Ruf-Einsätze – die stehen als eigene Lohnarten darunter
      const r2 = (v) => Math.round(v * 100) / 100;
      const x = { ...x0, dienst_std: r2((Number(x0.gearbeitet) || 0) - (Number(x0.bereitschaft_std) || 0) - (Number(x0.ruf_einsatz_std) || 0)) };
      for (const [key, label, mengeFeld, einheit, betragFeld] of LOHNARTEN) {
        const menge = mengeFeld ? Number(x[mengeFeld]) || 0 : null;
        const betrag = betragFeld ? Number(x[betragFeld]) || 0 : null;
        if (!menge && !betrag) continue;
        lines.push({ personalnummer: users[x.user_id], name: x.name, monat: month, lohnart: nr[key] || key, schluessel: key,
          bezeichnung: key === 'zulage' ? `${label} (${x.zulage})` : label, menge, einheit, betrag });
      }
    }
    const fehlend = r.rows.filter((x) => x.beschaeftigung !== 'extern' && !users[x.user_id]).map((x) => x.name);
    return { month, lines, fehlend, unterschiede: r.rows.filter((x) => !x.ist_erfasst && x.dienste).length,
      abgeschlossen: ctx.monatKomplett ? ctx.monatKomplett(month) : false };
  };

  app.get('/api/export/lohn', auth, managerFull, wrap((req) => lohn(req.query.month)));

  app.get('/api/export/lohn.csv', auth, managerFull, wrap((req, res) => {
    const l = lohn(req.query.month);
    const num = (x) => (x === null || x === undefined ? '' : String(Math.round(x * 100) / 100).replace('.', ','));
    const head = ['Personalnummer', 'Name', 'Abrechnungsmonat', 'Lohnart', 'Bezeichnung', 'Menge', 'Einheit', 'Betrag EUR'];
    const rows = [head, ...l.lines.map((x) => [x.personalnummer, x.name, x.monat, x.lohnart, x.bezeichnung, num(x.menge), x.einheit, num(x.betrag)])];
    audit(req.user.id, 'export.lohn', { month: l.month, zeilen: l.lines.length });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="lohn-${l.month}${l.abgeschlossen ? '' : '-vorlaeufig'}.csv"`);
    res.send('﻿' + rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n'));
  }));

  // ---------- Aushang ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const fmt = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.`;
  const textOn = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return '#000';
    const n = parseInt(m[1], 16); const l = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return l > 0.6 ? '#000' : '#fff';
  };

  app.get('/api/export/aushang', auth, manager, wrap((req, res) => {
    const unitId = Number(req.query.unit_id);
    const unit = db.prepare('SELECT u.*, b.name AS building_name FROM units u LEFT JOIN buildings b ON b.id = u.building_id WHERE u.id = ?').get(unitId);
    if (!unit) throw new HttpError(404, 'Station nicht gefunden.');
    requireUnit(req, unitId);
    const from = req.query.from; const to = req.query.to;
    if (!isoDate(from) || !isoDate(to) || to < from) throw new HttpError(400, 'Zeitraum ungültig.');
    const tage = (T.parseDate(to) - T.parseDate(from)) / T.DAY + 1;
    if (tage > 35) throw new HttpError(400, 'Höchstens 35 Tage je Aushang.');
    const days = Array.from({ length: tage }, (_, i) => T.isoDate(T.parseDate(from) + i * T.DAY));
    const shifts = ctx.loadShifts('s.date BETWEEN ? AND ? AND s.unit_id = ?', [from, to, unitId]);
    const people = new Map();
    for (const u of db.prepare("SELECT id, name, qualification FROM users WHERE role = 'staff' AND active = 1 AND stammbereich_id = ? ORDER BY name").all(unitId)) people.set(u.id, { ...u, cells: {} });
    for (const s of shifts) {
      for (const a of s.assigned) {
        if (!people.has(a.user_id)) people.set(a.user_id, { id: a.user_id, name: a.name, qualification: a.qualification, cells: {} });
        (people.get(a.user_id).cells[s.date] ||= []).push(s);
      }
    }
    const list = [...people.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'));
    const types = db.prepare('SELECT * FROM shift_types WHERE id IN (SELECT DISTINCT shift_type_id FROM shifts WHERE unit_id = ? AND date BETWEEN ? AND ?) ORDER BY start_time').all(unitId, from, to);
    const offen = (d) => shifts.filter((s) => s.date === d && s.assigned.length < s.min_staff).map((s) => `${s.type_code}${s.min_staff - s.assigned.length > 1 ? `×${s.min_staff - s.assigned.length}` : ''}`).join(' ');
    const st = getSettings();
    const dayClass = (d) => { const w = new Date(d).getUTCDay(); return T.holidayName(d) ? 'fei' : w === 0 || w === 6 ? 'we' : ''; };
    const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dienstplan ${esc(unit.name)} ${fmt(from)}–${fmt(to)}</title>
<style>
@page { size: A4 landscape; margin: 10mm; }
* { box-sizing: border-box; }
body { font: 10pt/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #111; margin: 16px; background: #fff; }
header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid ${esc(st.akzentfarbe)}; padding-bottom: 6px; margin-bottom: 8px; }
h1 { font-size: 16pt; margin: 0; } .sub { color: #444; }
.wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; table-layout: fixed; }
th, td { border: 1px solid #999; padding: 2px 1px; text-align: center; font-size: ${tage > 21 ? '7.5' : '9'}pt; overflow: hidden; }
th.name, td.name { text-align: left; width: ${tage > 21 ? '30' : '38'}mm; padding-left: 4px; white-space: nowrap; text-overflow: ellipsis; }
td.name small { color: #555; display: block; font-size: 7pt; }
th.we, td.we { background: #eef2f5; } th.fei, td.fei { background: #fde9d9; }
.code { display: inline-block; min-width: 1.6em; border-radius: 3px; padding: 0 2px; font-weight: 600; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
tr.offen td { color: #b00020; font-weight: 600; background: #fff; }
.legend { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 8.5pt; }
footer { margin-top: 6px; font-size: 8pt; color: #555; display: flex; justify-content: space-between; }
.noprint { margin: 0 0 10px; } .noprint button { font: inherit; padding: 8px 16px; border-radius: 6px; border: 1px solid #1f6f8b; background: #1f6f8b; color: #fff; cursor: pointer; }
@media print { .noprint { display: none; } body { margin: 0; } th.we, td.we, th.fei, td.fei { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style></head><body>
<div class="noprint"><button type="button" onclick="window.print()">Drucken / als PDF speichern</button></div>
<header><div><h1>Dienstplan ${esc(unit.name)}</h1><div class="sub">${esc(st.klinik_name)}${unit.building_name ? ` · ${esc(unit.building_name)}` : ''}</div></div>
<div class="sub">${WD[new Date(from).getUTCDay()]} ${fmt(from)}${from.slice(0, 4)} – ${WD[new Date(to).getUTCDay()]} ${fmt(to)}${to.slice(0, 4)}</div></header>
<div class="wrap"><table>
<thead><tr><th class="name" scope="col">Name</th>${days.map((d) => `<th scope="col" class="${dayClass(d)}"${T.holidayName(d) ? ` title="${esc(T.holidayName(d))}"` : ''}>${WD[new Date(d).getUTCDay()]}<br>${d.slice(8, 10)}</th>`).join('')}</tr></thead>
<tbody>
${list.map((p) => `<tr><td class="name">${esc(p.name)}${p.qualification ? `<small>${esc(p.qualification)}</small>` : ''}</td>${days.map((d) => `<td class="${dayClass(d)}">${(p.cells[d] || []).map((s) => `<span class="code" style="background:${esc(s.type_color)};color:${textOn(s.type_color)}">${esc(s.type_code)}</span>`).join(' ')}</td>`).join('')}</tr>`).join('\n')}
<tr class="offen"><td class="name">noch offen</td>${days.map((d) => `<td>${esc(offen(d))}</td>`).join('')}</tr>
</tbody></table></div>
<div class="legend">${types.map((t) => `<span><span class="code" style="background:${esc(t.color)};color:${textOn(t.color)}">${esc(t.code)}</span> ${esc(t.name)} ${esc(t.start_time)}–${esc(t.end_time)}</span>`).join('')}
${days.some((d) => T.holidayName(d)) ? `<span>Feiertage: ${days.filter((d) => T.holidayName(d)).map((d) => `${fmt(d)} ${esc(T.holidayName(d))}`).join(', ')}</span>` : ''}</div>
<footer><span>Stand: ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })} · Änderungen vorbehalten – aktuell gilt der Plan in der App.</span><span>Abwesenheiten werden aus Datenschutzgründen nicht ausgehängt.</span></footer>
</body></html>`;
    audit(req.user.id, 'export.aushang', { unit_id: unitId, from, to });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }));

  ctx.lohnExport = lohn;
};
