'use strict';
/* Anwesenheit: Übersicht über das gesamte Personal – wer ist da, wer ist krank, im Urlaub oder frei (Verwaltung) */

const ANW_STATUS = {
  anwesend: { label: 'Anwesend', hint: 'eingestempelt', cls: 'ok' },
  im_dienst: { label: 'Im Dienst', hint: 'laut Dienstplan', cls: 'ok' },
  krank: { label: 'Krank', cls: 'bad' },
  urlaub: { label: 'Urlaub', cls: 'info' },
  abwesend: { label: 'Sonstige Abwesenheit', hint: 'Fortbildung, Elternzeit', cls: 'info' },
  geplant: { label: 'Dienst später', cls: 'neutral' },
  ruf: { label: 'Rufbereitschaft', cls: 'neutral' },
  dienst_beendet: { label: 'Dienst beendet', cls: 'neutral' },
  frei: { label: 'Frei', cls: 'neutral' },
};
/** Kacheln oben: fassen Status zusammen und dienen als Filter */
const ANW_KACHELN = [
  { key: 'da', label: 'Anwesend', status: ['anwesend', 'im_dienst'], cls: 'ok' },
  { key: 'krank', label: 'Krank', status: ['krank'], cls: 'bad' },
  { key: 'urlaub', label: 'Urlaub', status: ['urlaub'], cls: 'info' },
  { key: 'abwesend', label: 'Sonst. abwesend', status: ['abwesend'], cls: 'info' },
  { key: 'spaeter', label: 'Dienst später', status: ['geplant'], cls: 'neutral' },
  { key: 'frei', label: 'Frei / Dienst beendet', status: ['frei', 'dienst_beendet', 'ruf'], cls: 'neutral' },
];

let anwTimer = null;

async function renderAnwesenheit() {
  clearInterval(anwTimer);
  state.anw = state.anw || { datum: todayIso(), kachel: '', q: '' };
  const f = state.anw;
  const [d, units] = await Promise.all([api('GET', `api/anwesenheit?datum=${f.datum}`), api('GET', 'api/units')]);
  const unitById = new Map(units.map((u) => [u.id, u]));
  if (state.view !== 'anwesenheit') return;

  const inBereich = (p) => {
    const uf = String(state.unitFilter || '');
    if (!uf) return true;
    const passt = (unitId) => {
      if (unitId == null) return uf === 'b:none';
      if (uf.startsWith('b:')) return String(unitById.get(unitId)?.building_id ?? 'none') === uf.slice(2);
      return String(unitId) === uf.replace(/^u:/, '');
    };
    // Stammbereich oder Station des heutigen Dienstes (Flexpool, Aushilfe)
    return passt(p.stammbereich_id) || p.dienste.some((s) => passt(s.unit_id));
  };
  const suche = (p) => !f.q || [p.name, p.qualification, p.firma].some((x) => String(x || '').toLowerCase().includes(f.q));

  // ---------- Kopf: Tag wählen, Bereich, Suche ----------
  const datumIn = h('input', { type: 'date', value: f.datum, 'aria-label': 'Tag', onchange: (e) => { if (e.target.value) { f.datum = e.target.value; renderAnwesenheit(); } } });
  const tag = (n) => () => { f.datum = addDays(f.datum, n); renderAnwesenheit(); };
  const titel = d.heute ? `Heute, ${WD[weekday(d.datum)]} ${fmtDate(d.datum)}` : `${WD[weekday(d.datum)]} ${fmtDate(d.datum)}`;
  const search = h('input', { type: 'search', placeholder: 'Name, Qualifikation …', value: f.q, 'aria-label': 'Suchen',
    oninput: (e) => { f.q = e.target.value.trim().toLowerCase(); draw(); } });
  const unitSel = unitFilterSelect(units, String(state.unitFilter || ''), (v) => { state.unitFilter = v; draw(); }, 'Ganzer Campus');
  const toolbar = h('div', { class: 'toolbar anw-toolbar' },
    h('div', { class: 'anw-tag' },
      h('button', { type: 'button', class: 'ghost', 'aria-label': 'Vorheriger Tag', onclick: tag(-1) }, '‹'),
      datumIn,
      h('button', { type: 'button', class: 'ghost', 'aria-label': 'Nächster Tag', onclick: tag(1) }, '›'),
      d.heute ? null : h('button', { type: 'button', class: 'ghost', onclick: () => { f.datum = todayIso(); renderAnwesenheit(); } }, 'Heute')),
    unitSel, search);

  const kachelBox = h('div', { class: 'anw-kacheln', role: 'group', 'aria-label': 'Nach Status filtern' });
  const liste = h('div', { class: 'anw-liste' });
  const stand = h('p', { class: 'small muted' });

  const draw = () => {
    const alle = d.personen.filter(inBereich).filter(suche);
    const zahl = (k) => alle.filter((p) => k.status.includes(p.status)).length;
    kachelBox.replaceChildren(...ANW_KACHELN.map((k) => h('button', {
      type: 'button', class: `anw-kachel ${k.cls}${f.kachel === k.key ? ' aktiv' : ''}`, 'aria-pressed': String(f.kachel === k.key),
      onclick: () => { f.kachel = f.kachel === k.key ? '' : k.key; draw(); },
    }, h('span', { class: 'anw-zahl' }, zahl(k)), h('span', { class: 'anw-klabel' }, k.key === 'spaeter' && !d.heute ? 'Im Dienst geplant' : k.label))));

    const kachel = ANW_KACHELN.find((k) => k.key === f.kachel);
    const reihenfolge = kachel ? kachel.status : Object.keys(ANW_STATUS);
    const gruppen = reihenfolge.map((s) => [s, alle.filter((p) => p.status === s)]).filter(([, l]) => l.length);
    liste.replaceChildren(...(gruppen.length ? gruppen.map(([s, l]) => anwGruppe(s, l, d, unitById))
      : [h('p', { class: 'muted' }, 'Keine Personen für diese Auswahl.')]));
    stand.textContent = `${alle.length} Personen${d.heute ? ` · Stand ${d.jetzt} Uhr, aktualisiert sich jede Minute` : ''}`;
  };

  setMain(h('h1', {}, 'Anwesenheit'), h('p', { class: 'muted anw-titel' }, titel), toolbar, kachelBox, stand, liste);
  draw();

  // heute: jede Minute neu laden (nur solange die Ansicht offen ist)
  if (d.heute) {
    anwTimer = setInterval(() => {
      if (state.view !== 'anwesenheit' || document.querySelector('dialog[open]')) { if (state.view !== 'anwesenheit') clearInterval(anwTimer); return; }
      if (document.activeElement === search || document.activeElement === datumIn) return;
      renderAnwesenheit().catch(() => {});
    }, 60000);
  }
}

function anwGruppe(status, personen, d, unitById) {
  const s = ANW_STATUS[status];
  const label = status === 'geplant' && !d.heute ? 'Im Dienst geplant' : s.label;
  return h('section', { class: 'card anw-gruppe' },
    h('h2', {}, h('span', { class: `anw-punkt ${s.cls}`, 'aria-hidden': 'true' }), `${label} `, h('span', { class: 'muted anw-anzahl' }, `(${personen.length})`)),
    h('ul', { class: 'anw-personen' }, personen.map((p) => anwPerson(p, d, unitById))));
}

function anwPerson(p, d, unitById) {
  const stamm = unitById.get(p.stammbereich_id);
  const zeile2 = [];
  if (p.abwesenheit) {
    const a = p.abwesenheit;
    const art = ABS_LABEL[a.type] || a.type;
    zeile2.push(a.from_date === a.to_date ? `${art} am ${fmtDate(a.from_date)}` : `${art} ${fmtDate(a.from_date)} – ${fmtDate(a.to_date)}`);
  }
  if (p.stempel) zeile2.push(`eingestempelt ${p.stempel.kommen} Uhr${p.stempel.pause ? ` · ${p.stempel.pause === 'raucher' ? 'Raucherpause' : 'Pause'}` : ''}`);
  const dienste = p.abwesenheit ? [] : p.dienste;
  return h('li', { class: 'anw-person' },
    avatar(p, 36),
    h('div', { class: 'anw-info' },
      h('div', { class: 'anw-name' }, p.name, beschTag(p),
        p.hinweis ? h('span', { class: `badge ${p.hinweis === 'Urlaub beantragt' ? 'warn' : 'bad'}` }, p.hinweis) : null),
      h('div', { class: 'small muted' }, [p.qualification, stamm ? `Stamm: ${stamm.name}` : ''].filter(Boolean).join(' · ')),
      zeile2.length ? h('div', { class: 'small' }, zeile2.join(' · ')) : null),
    dienste.length ? h('div', { class: 'anw-dienste' }, dienste.map((s) => h('span', { class: 'anw-dienst', title: `${s.type_name}, ${s.unit_name}` },
      h('span', { class: 'chip', style: { background: s.type_color } }, s.type_code),
      `${s.start_time}–${s.end_time}`, h('span', { class: 'muted' }, ` ${s.unit_name}`), s.vom_vortag ? h('span', { class: 'muted' }, ' (ab Vortag)') : null))) : null);
}
