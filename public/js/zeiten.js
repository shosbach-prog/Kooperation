'use strict';
/* Zeiterfassung: Ist-Zeiten je Einsatz, Einsatzstunden bei Rufbereitschaft */

const ART_LABEL = { dienst: 'Dienst', bereitschaft: 'Bereitschaftsdienst', ruf: 'Rufbereitschaft' };

/** Dialog zum Erfassen/Ändern; liefert true, wenn gespeichert */
async function editZeit(z) {
  const ruf = z.art === 'ruf';
  const r = await uiForm({
    title: ruf ? 'Einsätze in der Rufbereitschaft' : 'Tatsächliche Arbeitszeit',
    message: `${z.name} · ${WD[weekday(z.date)]} ${fmtDate(z.date)} · ${z.type_name} (geplant ${z.start_time}–${z.end_time}, Pause ${z.break_min} Min.)`,
    fields: ruf ? [
      { name: 'einsatz_std', label: 'Einsatzstunden (inkl. Wegezeit)', type: 'number', min: 0, max: 24, step: 0.25, value: z.einsatz_std ?? 0, inputmode: 'decimal' },
      { name: 'ist_note', label: 'Bemerkung', value: z.ist_note || '', maxlength: 300 },
    ] : [
      { name: 'ist_start', label: 'Kommen', type: 'time', required: true, value: z.ist_start || z.start_time },
      { name: 'ist_end', label: 'Gehen', type: 'time', required: true, value: z.ist_end || z.end_time },
      { name: 'ist_pause', label: 'Pause (Min.)', type: 'number', min: 0, step: 5, value: z.ist_pause ?? z.break_min, inputmode: 'numeric' },
      { name: 'ist_note', label: z.ist_quelle === 'stempel' && !isMgr() ? 'Begründung der Änderung (Pflicht – Zeiten stammen von der Stempeluhr)' : 'Bemerkung (z. B. Grund für Überstunden)', value: z.ist_note || '', maxlength: 300, required: z.ist_quelle === 'stempel' && !isMgr() },
    ],
  });
  if (!r) return false;
  const body = { ...r, user_id: z.user_id };
  if (!ruf) body.ist_pause = r.ist_pause === '' ? '' : Number(r.ist_pause);
  try { await api('PUT', `api/zeiten/${z.shift_id}`, body); toast('Zeit gespeichert.'); return true; } catch (e) { toast(e.message, true); return false; }
}

async function zeitWieGeplant(z) {
  try {
    await api('PUT', `api/zeiten/${z.shift_id}`, z.art === 'ruf' ? { user_id: z.user_id, einsatz_std: 0 }
      : { user_id: z.user_id, ist_start: z.start_time, ist_end: z.end_time, ist_pause: z.break_min });
    toast('Bestätigt.'); return true;
  } catch (e) { toast(e.message, true); return false; }
}

function zeitIst(z) {
  if (z.art === 'ruf') return z.einsatz_std === null || z.einsatz_std === undefined ? null : `${fmtNum(z.einsatz_std)} Std. Einsatz`;
  return z.ist_start ? `${z.ist_start}–${z.ist_end} (${z.ist_pause ?? z.break_min} Min.)` : null;
}

function zeitDiff(z) {
  if (z.diff_std === null || z.diff_std === undefined) return '';
  if (Math.abs(z.diff_std) < 0.01) return h('span', { class: 'badge ok' }, '± 0');
  return h('span', { class: `badge ${z.diff_std > 0 ? 'warn' : ''}` }, `${z.diff_std > 0 ? '+' : ''}${fmtNum(z.diff_std)} Std.`);
}

function zeitenTable(list, { withName, rerender }) {
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, [...(withName ? ['Name'] : []), 'Datum', 'Dienst', 'Plan', 'Ist', 'Differenz', ''].map((x) => h('th', {}, x)))),
    h('tbody', {}, list.map((z) => h('tr', {},
      withName ? h('td', {}, z.name) : null,
      h('td', {}, `${WD[weekday(z.date)]} ${fmtDate(z.date)}`),
      h('td', {}, h('span', { class: 'chip', style: { background: z.type_color } }, z.type_code), z.type_name, z.art !== 'dienst' ? h('div', { class: 'small muted' }, ART_LABEL[z.art]) : null,
        h('div', { class: 'small muted' }, z.unit_name)),
      h('td', {}, `${z.start_time}–${z.end_time}`, h('div', { class: 'small muted' }, `${fmtNum(z.plan_std)} Std.`)),
      h('td', {}, zeitIst(z) || h('span', { class: 'muted' }, 'offen'),
        z.ist_quelle === 'stempel' ? h('div', {}, h('span', { class: 'badge ok' }, '⏱ Stempeluhr')) : z.ist_quelle === 'manuell' && z.stempel?.length ? h('div', {}, h('span', { class: 'badge warn' }, 'Stempelzeit geändert')) : null,
        z.ist_raucher_min ? h('div', { class: 'small muted' }, `davon Raucherpausen ${z.ist_raucher_min} Min.`) : null,
        z.stempel?.length ? h('ul', { class: 'zeit-stempel' }, z.stempel.map((st) => h('li', {},
          `Kommen ${st.kommen} – Gehen ${st.gehen || 'läuft'}${st.nachgetragen ? ' (nachgetragen)' : ''}${st.offline ? ' · offline erfasst' : ''}`,
          st.pausen.map((p) => h('div', {}, `${p.art === 'raucher' ? 'Raucherpause' : 'Pause'} ${p.von}–${p.bis || '…'}${p.min !== null ? ` (${p.min} Min.)` : ''}`))))) : null,
        z.ist_note ? h('div', { class: 'small muted' }, z.ist_note) : null,
        z.ist_by_name && z.ist_by_name !== z.name ? h('div', { class: 'small muted' }, `erfasst von ${z.ist_by_name}`) : null),
      h('td', {}, zeitDiff(z)),
      z.gesperrt ? h('td', { class: 'actions' }, h('span', { class: 'badge', title: 'Monat abgeschlossen' }, '🔒 abgeschlossen')) : h('td', { class: 'actions' },
        !zeitIst(z) ? h('button', { class: 'tiny', onclick: async () => { if (await zeitWieGeplant(z)) rerender(); } }, '✓ wie geplant') : null,
        h('button', { class: 'tiny ghost', onclick: async () => { if (await editZeit(z)) rerender(); } }, zeitIst(z) ? 'Ändern' : 'Abweichend'),
        zeitIst(z) && withName ? h('button', { class: 'tiny ghost', onclick: async () => {
          if (!await uiConfirm('Erfasste Zeit zurücksetzen? Dann gilt wieder die Planzeit.', { okText: 'Zurücksetzen' })) return;
          try { await api('DELETE', `api/zeiten/${z.shift_id}?user_id=${z.user_id}`); rerender(); } catch (e) { toast(e.message, true); }
        } }, 'Zurücksetzen') : null))))));
}

/** Karte „Zeiten erfassen“ in „Meine Dienste“ */
async function zeitenCard(rerender) {
  const r = await api('GET', 'api/zeiten?mine=1');
  const list = r.zeiten.filter((z) => z.date <= todayIso());
  const offen = list.filter((z) => !zeitIst(z)).length;
  return h('div', { class: 'card' },
    h('h2', {}, 'Zeiten erfassen', offen ? h('span', { class: 'badge warn', style: { marginLeft: '.5rem' } }, `${offen} offen`) : null),
    h('p', { class: 'muted small' }, `Bestätigen Sie Ihre Dienste der letzten ${r.frist_tage} Tage oder tragen Sie abweichende Zeiten ein (z. B. Überstunden). `,
      'Ohne Erfassung wird die Planzeit angerechnet. Bei Rufbereitschaft tragen Sie die Stunden der tatsächlichen Einsätze ein.'),
    list.length ? zeitenTable(list, { withName: false, rerender }) : h('p', { class: 'muted' }, 'Keine Dienste in diesem Zeitraum.'));
}

// ---------- Zeiterfassung (Verwaltung) ----------
async function renderZeiten() {
  state.zeitenVon ||= addDays(todayIso(), -14);
  state.zeitenBis ||= todayIso();
  const [r, units] = await Promise.all([api('GET', `api/zeiten?from=${state.zeitenVon}&to=${state.zeitenBis}`), api('GET', 'api/units')]);
  const filter = state.zeitenFilter || 'alle';
  const lf = listenFilter('zeiten', units, renderZeiten);
  let list = r.zeiten.filter((z) => z.date <= todayIso() && lf.passt(z.name, z.unit_id));
  if (filter === 'offen') list = list.filter((z) => !zeitIst(z));
  if (filter === 'abweichung') list = list.filter((z) => z.diff_std || (z.art === 'ruf' && z.einsatz_std > 0));
  const sum = (k) => list.reduce((a, z) => a + (Number(z[k]) || 0), 0);
  setMain(h('div', { class: 'card' },
    h('h2', {}, 'Zeiterfassung'),
    h('div', { class: 'toolbar' },
      h('label', {}, 'von', h('input', { type: 'date', value: state.zeitenVon, onchange: (e) => { state.zeitenVon = e.target.value; renderZeiten(); } })),
      h('label', {}, 'bis', h('input', { type: 'date', value: state.zeitenBis, onchange: (e) => { state.zeitenBis = e.target.value; renderZeiten(); } })),
      h('label', {}, 'Anzeigen', h('select', { onchange: (e) => { state.zeitenFilter = e.target.value; renderZeiten(); } },
        [['alle', 'alle Einsätze'], ['offen', 'noch nicht erfasst'], ['abweichung', 'mit Abweichung']].map(([v, l]) => h('option', { value: v, selected: v === filter }, l)))),
      ...lf.leiste),
    h('p', { class: 'muted small' }, `${list.length} Einsätze · Überstunden/Minderzeit gesamt: ${fmtNum(sum('diff_std'))} Std. · Ruf-Einsätze: ${fmtNum(sum('einsatz_std'))} Std. `,
      `Mitarbeitende können ihre Zeiten bis ${r.frist_tage} Tage nach dem Dienst selbst erfassen; die Verwaltung jederzeit.`),
    list.length ? zeitenTable(list, { withName: true, rerender: renderZeiten }) : h('p', { class: 'muted' }, 'Keine Einsätze.')));
}
