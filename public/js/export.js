'use strict';
/* Exporte: Dienstplan-Aushang (A4 quer) und Lohn-Übergabe */

/** Dialog: Station und Zeitraum wählen, Aushang in neuem Tab öffnen */
async function aushangDialog(preset = {}) {
  const units = (await api('GET', 'api/units')).filter((u) => u.active && canManageUnit(u.id));
  if (!units.length) { toast('Keine Station in Ihrem Verwaltungsbereich.', true); return; }
  const unitPre = String(preset.unit || '').replace(/^u:/, '');
  const month = state.month || todayIso().slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const r = await uiForm({
    title: 'Dienstplan-Aushang',
    message: 'Druckfertige Monats- oder Wochenübersicht einer Station (A4 quer). Abwesenheiten werden aus Datenschutzgründen nicht angezeigt.',
    okText: 'Aushang öffnen',
    fields: [
      { name: 'unit_id', label: 'Station', type: 'select', value: units.some((u) => String(u.id) === unitPre) ? unitPre : units[0].id, options: units.map((u) => [u.id, u.name]) },
      { name: 'from', label: 'von', type: 'date', required: true, value: preset.from || `${month}-01` },
      { name: 'to', label: 'bis (höchstens 35 Tage)', type: 'date', required: true, value: preset.to || last },
    ],
  });
  if (!r) return;
  window.open(`api/export/aushang?unit_id=${r.unit_id}&from=${r.from}&to=${r.to}`, '_blank', 'noopener');
}

/** Karte in der Auswertung */
async function exportCard() {
  const items = [h('button', { class: 'ghost', onclick: () => aushangDialog() }, 'Dienstplan-Aushang (A4)')];
  let hint = null;
  if (isFullMgr()) {
    const l = await api('GET', `api/export/lohn?month=${state.month}`).catch(() => null);
    items.push(h('a', { href: `api/export/lohn.csv?month=${state.month}` }, h('button', { class: 'ghost' }, 'Lohn-Übergabe (CSV)')));
    if (l) {
      hint = h('div', {},
        h('p', { class: 'small muted' }, `${l.lines.length} Buchungszeilen je Personalnummer und Lohnart. Die Lohnart-Nummern stellen Sie unter Einstellungen ein (mit der Entgeltabrechnung abstimmen).`),
        l.fehlend.length ? h('p', { class: 'small' }, h('span', { class: 'badge warn' }, 'Personalnummer fehlt'), ' ', l.fehlend.join(', ')) : null);
    }
  }
  return h('div', { class: 'card' }, h('h2', {}, 'Exporte'), h('div', { class: 'toolbar' }, items), hint);
}
