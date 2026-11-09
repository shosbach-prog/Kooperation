'use strict';
/* Monatsabschluss je Station (in der Auswertung) */

async function abschlussCard() {
  let d;
  try { d = await api('GET', `api/monatsabschluss?month=${state.month}`); } catch { return null; }
  if (!d.stationen.length) return null;
  const offen = d.stationen.filter((s) => !s.abgeschlossen);
  const auswahl = new Set(offen.map((s) => s.unit_id));
  const hinweise = (p) => [
    p.zeiten_offen ? `${p.zeiten_offen} Zeiten nicht bestätigt` : null,
    p.unterbesetzt ? `${p.unterbesetzt} unterbesetzte Dienste` : null,
    p.antraege_offen ? `${p.antraege_offen} offene Anträge` : null,
    p.au_fehlt ? `${p.au_fehlt} AU fehlt` : null,
    p.stempel_laufend ? `${p.stempel_laufend} Stempelung läuft noch` : null,
  ].filter(Boolean);
  const monatName = new Date(`${state.month}-01T00:00:00Z`).toLocaleDateString('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const rows = d.stationen.map((s) => {
    const hw = s.pruefung ? hinweise(s.pruefung) : [];
    return h('tr', {},
      h('td', {}, s.abgeschlossen || !d.abschliessbar ? null : h('input', { type: 'checkbox', checked: true, 'aria-label': `${s.name} auswählen`,
        onchange: (e) => { if (e.target.checked) auswahl.add(s.unit_id); else auswahl.delete(s.unit_id); } })),
      h('td', {}, s.name, s.building_name ? h('div', { class: 'small muted' }, s.building_name) : null),
      h('td', {}, s.abgeschlossen
        ? [h('span', { class: 'badge ok' }, '🔒 abgeschlossen'), h('div', { class: 'small muted' }, `${fmtDate(s.abgeschlossen.am.slice(0, 10))}${s.abgeschlossen.von ? ` · ${s.abgeschlossen.von}` : ''}`)]
        : hw.length ? hw.map((x) => h('div', {}, h('span', { class: 'badge warn' }, x))) : h('span', { class: 'badge ok' }, 'alles erledigt')),
      h('td', { class: 'actions' }, s.abgeschlossen && isFullMgr() ? h('button', { class: 'tiny ghost', onclick: async () => {
        const grund = await uiPrompt({ title: `${s.name}: ${monatName} wieder öffnen`, label: 'Grund (wird protokolliert)', required: true, minLength: 5, multiline: true, okText: 'Wieder öffnen' });
        if (!grund) return;
        try { await api('DELETE', `api/monatsabschluss?month=${state.month}&unit_id=${s.unit_id}`, { grund }); toast('Monat wieder geöffnet.'); renderReport(); } catch (e) { toast(e.message, true); }
      } }, 'Wieder öffnen') : null));
  });
  return h('div', { class: 'card' }, h('h2', {}, `Monatsabschluss ${monatName}`),
    h('p', { class: 'small muted' }, 'Nach dem Abschluss sind Dienste, Ist-Zeiten und Abwesenheiten dieses Monats für die Station gesperrt; Lohn-Export ist dann endgültig. ',
      'Wieder öffnen kann nur die Hauptverwaltung (mit Begründung, protokolliert).'),
    h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['', 'Station', 'Prüfung', ''].map((x) => h('th', {}, x)))), h('tbody', {}, rows))),
    !d.abschliessbar ? h('p', { class: 'small' }, h('span', { class: 'badge' }, 'Hinweis'), ' Ein Monat kann erst nach seinem letzten Tag abgeschlossen werden.')
      : offen.length ? h('button', { onclick: async () => {
        const ids = [...auswahl];
        if (!ids.length) { toast('Bitte mindestens eine Station wählen.', true); return; }
        const warn = offen.filter((s) => ids.includes(s.unit_id) && hinweise(s.pruefung).length);
        if (!await uiConfirm(`${ids.length} Station(en) für ${monatName} abschließen?${warn.length ? ` Achtung: bei ${warn.map((s) => s.name).join(', ')} gibt es noch offene Punkte.` : ''}`,
          { title: 'Monat abschließen', okText: 'Abschließen' })) return;
        try { await api('POST', 'api/monatsabschluss', { month: state.month, unit_ids: ids }); toast('Monat abgeschlossen.'); renderReport(); } catch (e) { toast(e.message, true); }
      } }, 'Ausgewählte Stationen abschließen') : null);
}
