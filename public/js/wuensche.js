'use strict';
/* Dienstwünsche: Monatskalender mit „Wunsch frei“ und Wunschdienst */

state.wunschMonat = state.wunschMonat || null;

async function renderWuensche() {
  if (!state.wunschMonat) state.wunschMonat = addDays(todayIso(), 21).slice(0, 7);
  const [y, m] = state.wunschMonat.split('-').map(Number);
  const first = `${state.wunschMonat}-01`;
  const last = toIso(Date.UTC(y, m, 0));
  const [r, types, abs] = await Promise.all([
    api('GET', `api/wishes?from=${first}&to=${last}&mine=1`), api('GET', 'api/shift-types'),
    api('GET', `api/absences?from=${first}&to=${last}&mine=1`),
  ]);
  const byDate = new Map(r.wuensche.map((w) => [w.date, w]));
  const freiCount = r.wuensche.filter((w) => w.art === 'frei').length;
  const activeTypes = types.filter((t) => t.active);
  const absOn = (d) => abs.absences.find((a) => ['genehmigt', 'gemeldet', 'beantragt'].includes(a.status) && a.from_date <= d && a.to_date >= d);

  const edit = async (d) => {
    const w = byDate.get(d);
    const res = await uiForm({
      title: `Wunsch für ${WD[weekday(d)]} ${fmtDate(d)}`, okText: 'Speichern',
      fields: [
        { name: 'wahl', label: 'Wunsch', type: 'select', value: w ? (w.art === 'frei' ? 'frei' : `d${w.shift_type_id}`) : 'frei',
          options: [['frei', 'Wunsch frei'], ...activeTypes.map((t) => [`d${t.id}`, `Wunschdienst: ${t.name} (${t.start_time}–${t.end_time})`]), ...(w ? [['loeschen', '– Wunsch löschen –']] : [])] },
        { name: 'note', label: 'Hinweis (optional)', value: w?.note || '', maxlength: 200, placeholder: 'z. B. Geburtstag, Kinderbetreuung' },
      ],
    });
    if (!res) return;
    try {
      if (res.wahl === 'loeschen') await api('DELETE', `api/wishes/${d}`);
      else await api('PUT', 'api/wishes', { date: d, art: res.wahl === 'frei' ? 'frei' : 'dienst', shift_type_id: res.wahl === 'frei' ? null : Number(res.wahl.slice(1)), note: res.note });
      toast('Gespeichert.');
    } catch (e) { toast(e.message, true); }
    renderWuensche();
  };

  const offset = (weekday(first) + 6) % 7;
  const cells = [...Array(offset)].map(() => h('div', { class: 'wish-day empty', 'aria-hidden': 'true' }));
  for (let t = parseIso(first); t <= parseIso(last); t += 86400000) {
    const d = toIso(t);
    const w = byDate.get(d);
    const a = absOn(d);
    const gesperrt = d < r.erster_tag;
    const wd = weekday(d);
    cells.push(h('button', {
      type: 'button', class: `wish-day${w ? ` wish-${w.art}` : ''}${wd === 0 || wd === 6 ? ' weekend' : ''}${gesperrt ? ' locked' : ''}`,
      disabled: gesperrt, 'aria-label': `${WD[wd]} ${fmtDate(d)}${w ? `: ${w.art === 'frei' ? 'Wunsch frei' : `Wunschdienst ${w.type_name}`}` : ''}${a ? `, ${absLabel(a)}` : ''}`,
      onclick: () => edit(d),
    }, h('span', { class: 'wd-num' }, String(Number(d.slice(8)))),
    w ? h('span', { class: 'wish-tag' }, w.art === 'frei' ? 'frei' : w.type_code) : null,
    a ? h('span', { class: 'wish-abs' }, absLabel(a)) : null));
  }
  const monthName = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  setMain(h('div', { class: 'card' },
    h('div', { class: 'phone-nav' },
      h('button', { class: 'ghost', 'aria-label': 'Vormonat', onclick: () => { state.wunschMonat = toIso(Date.UTC(y, m - 2, 1)).slice(0, 7); renderWuensche(); } }, '‹'),
      h('strong', {}, monthName),
      h('button', { class: 'ghost', 'aria-label': 'Nächster Monat', onclick: () => { state.wunschMonat = toIso(Date.UTC(y, m, 1)).slice(0, 7); renderWuensche(); } }, '›')),
    h('p', { class: 'small muted' }, `Tag antippen, um einen Wunsch einzutragen. Wünsche sind ab ${fmtDate(r.erster_tag)} möglich`,
      Number(r.frei_max_monat) > 0 ? ` · Frei-Wünsche in diesem Monat: ${freiCount} von ${r.frei_max_monat}` : '', '. Die Einsatzplanung berücksichtigt sie nach Möglichkeit.'),
    h('div', { class: 'wish-grid' }, ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((x) => h('div', { class: 'wish-head' }, x)), cells),
    h('div', { class: 'legend', style: { marginTop: '.75rem' } }, h('span', { class: 'l-ok' }, 'Wunsch frei'), h('span', { class: 'l-wish' }, 'Wunschdienst'))));
}

/** Wunsch einer Person an einem Tag (für den Dienstplan der Verwaltung) */
function wishOf(userId, date) {
  return (state.planWishes || []).find((w) => w.user_id === userId && w.date === date);
}
