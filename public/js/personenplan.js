'use strict';
/* Dienstplan als Personenansicht: Zeilen = Personen, Spalten = Tage (übersichtlich auch bei vielen Mitarbeitenden) */

// Anzeige-Einstellungen pro Gerät merken (nur Ansicht/Filter, keine Personaldaten)
const ansicht = {
  get(k, d) { try { return localStorage.getItem(`pep.${k}`) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`pep.${k}`, v); } catch { /* privat */ } },
};

state.planModus = ansicht.get('planModus', 'schichten');
state.planZeitraum = ansicht.get('planZeitraum', 'woche');

/** Beim ersten Öffnen: gemerkten Bereich oder (für Pflegekräfte) die eigene Station vorwählen */
function bereichVorwahl() {
  if (state.bereichGewaehlt) return;
  state.bereichGewaehlt = true;
  const gemerkt = ansicht.get('unitFilter', null);
  if (gemerkt !== null) state.unitFilter = gemerkt;
  else if (!isMgr() && state.me?.stammbereich_id) state.unitFilter = `u:${state.me.stammbereich_id}`;
}

/** Umschalter „Schichten | Personen“ für die Werkzeugleiste */
function planModusSchalter() {
  const modus = state.planModus || 'schichten';
  const b = (m, label) => h('button', { type: 'button', class: modus === m ? '' : 'ghost', 'aria-pressed': String(modus === m),
    onclick: () => { state.planModus = m; ansicht.set('planModus', m); renderPlan(); } }, label);
  return h('div', { class: 'segmented', role: 'group', 'aria-label': 'Ansicht' }, b('schichten', 'Schichten'), b('personen', 'Personen'));
}

async function renderPersonenplan() {
  const zeitraum = state.planZeitraum || 'woche';
  let from, to;
  if (zeitraum === 'monat') {
    const m = (state.planMonat ||= todayIso().slice(0, 7));
    from = `${m}-01`;
    const [y, mo] = m.split('-').map(Number);
    to = toIso(Date.UTC(y, mo, 0));
  } else {
    from = state.weekStart; to = addDays(from, 6);
  }
  const [units, types, plan, users] = await Promise.all([
    api('GET', 'api/units'), api('GET', 'api/shift-types'), api('GET', `api/plan?from=${from}&to=${to}`),
    isMgr() ? api('GET', 'api/users') : Promise.resolve([]),
  ]);
  state.planAbsences = plan.absences || [];
  state.planWishes = plan.wishes || [];
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);

  // Bereichsfilter wie in der Schichtansicht
  const f = String(state.unitFilter || '');
  const unitOk = (uid) => {
    if (!f) return true;
    const u = units.find((x) => x.id === uid);
    if (!u) return false;
    return f.startsWith('b:') ? String(u.building_id ?? 'none') === f.slice(2) : String(u.id) === f.replace(/^u:/, '');
  };
  const shifts = plan.shifts.filter((s) => unitOk(s.unit_id));

  // Personen: Stammpersonal der gewählten Bereiche + alle, die dort eingeteilt sind
  const people = new Map();
  for (const u of users.filter((x) => x.active && x.role === 'staff' && (!f || unitOk(x.stammbereich_id)))) {
    people.set(u.id, { id: u.id, name: u.name, qualification: u.qualification, foto_version: u.foto_version, stamm: u.stammbereich_id, beschaeftigung: u.beschaeftigung, firma: u.firma, std: 0, cells: {} });
  }
  for (const s of shifts) {
    for (const a of s.assigned) {
      if (!people.has(a.user_id)) people.set(a.user_id, { id: a.user_id, name: a.name, qualification: a.qualification, foto_version: a.foto_version, stamm: null, beschaeftigung: a.beschaeftigung, firma: a.firma, std: 0, cells: {} });
      const p = people.get(a.user_id);
      (p.cells[s.date] ||= []).push(s);
      p.std += s.hours || 0;
    }
  }
  if (isStaffRole() && !people.has(state.me.id)) people.set(state.me.id, { id: state.me.id, name: state.me.name, qualification: state.me.qualification, foto_version: state.me.foto_version, std: 0, cells: {} });

  // Filter: Suche, Qualifikation, nur mit Diensten
  const suche = (state.ppSuche || '').toLowerCase();
  const qual = state.ppQual || '';
  const nurDienst = !!state.ppNurDienst;
  const besch = state.ppBesch || '';
  let list = [...people.values()].filter((p) => (!suche || p.name.toLowerCase().includes(suche))
    && (!qual || p.qualification === qual) && (!nurDienst || Object.keys(p.cells).length) && (!besch || (p.beschaeftigung || 'stamm') === besch));
  const qOrder = state.settings.qualifikationen || [];
  const artRang = { stamm: 0, flexpool: 1, extern: 2 };
  // Gruppen: Stammpersonal nach Qualifikation, dann Flexpool, dann Externe
  const gruppe = (p) => (p.beschaeftigung === 'flexpool' ? 'Flexpool' : p.beschaeftigung === 'extern' ? 'Extern (Zeitarbeit/Leasing)' : p.qualification || 'ohne Qualifikation');
  list.sort((a, b) => (b.id === state.me.id) - (a.id === state.me.id)
    || (artRang[a.beschaeftigung || 'stamm'] - artRang[b.beschaeftigung || 'stamm'])
    || (qOrder.indexOf(a.qualification) + 1 || 99) - (qOrder.indexOf(b.qualification) + 1 || 99) || a.name.localeCompare(b.name, 'de'));

  const absMap = new Map();
  for (const a of state.planAbsences) for (const d of days) if (d >= a.from_date && d <= a.to_date) absMap.set(`${a.user_id}|${d}`, a);
  const wishMap = new Map((state.planWishes || []).map((w) => [`${w.user_id}|${w.date}`, w]));
  const today = todayIso();
  const wd = (d) => weekday(d);
  const dayCls = (d) => `${[0, 6].includes(wd(d)) ? ' weekend' : ''}${plan.holidays[d] ? ' holiday' : ''}${d === today ? ' today' : ''}`;
  const kurz = (a) => ({ urlaub: 'U', zusatzurlaub: 'ZU', sonderurlaub: 'SU', fortbildung: 'FB', elternzeit: 'EZ', krank: 'K', kind_krank: 'KK' }[a.type] || 'A');

  const cell = (p, d) => {
    const ss = p.cells[d] || [];
    const ab = absMap.get(`${p.id}|${d}`);
    const w = isMgr() ? wishMap.get(`${p.id}|${d}`) : null;
    const kann = isMgr() || p.id === state.me.id;
    const inhalt = [
      ...ss.map((s) => h('span', { class: 'pp-code', style: { background: s.type_color }, title: `${s.type_name} ${s.start_time}–${s.end_time} · ${s.unit_name}` },
        s.type_code, p.stamm && s.unit_id !== p.stamm ? h('sup', {}, '↗') : null)),
      ab ? h('span', { class: `pp-abs${ab.status === 'beantragt' ? ' beantragt' : ''}`, title: `${absLabel(ab)}${ab.status === 'beantragt' ? ' (beantragt)' : ''}` },
        isMgr() || p.id === state.me.id ? kurz(ab) : 'A') : null,
      !ss.length && w ? h('span', { class: 'pp-wish', title: w.art === 'frei' ? 'möchte frei' : `Wunsch: ${w.type_name}` }, w.art === 'frei' ? '♡' : `★${w.type_code || ''}`) : null,
    ].filter(Boolean);
    const label = `${p.name}, ${WD[wd(d)]} ${fmtDate(d)}: ${ss.length ? ss.map((s) => `${s.type_name} ${s.unit_name}`).join(', ') : 'frei'}${ab ? `, ${absLabel(ab)}` : ''}`;
    return h('td', { class: `pp-cell${dayCls(d)}` },
      kann ? h('button', { type: 'button', class: 'pp-btn', onclick: () => personTag(p, d, shifts) }, h('span', { class: 'sr-only' }, label),
        h('span', { class: 'pp-inhalt', 'aria-hidden': 'true' }, ...(inhalt.length ? inhalt : [h('span', { class: 'pp-leer' }, '·')])))
        : h('span', { class: 'pp-btn', title: label }, ...inhalt));
  };

  // Besetzung je Dienstart und Tag (Summe über die gewählten Stationen)
  const shownTypes = types.filter((t) => shifts.some((s) => s.shift_type_id === t.id));
  const coverRows = shownTypes.map((t) => h('tr', { class: 'pp-cover' },
    h('th', { scope: 'row' }, h('span', { class: 'chip', style: { background: t.color } }, t.code), ` ${t.name}`),
    days.map((d) => {
      const ss = shifts.filter((s) => s.date === d && s.shift_type_id === t.id);
      if (!ss.length) return h('td', { class: `pp-cell${dayCls(d)}` });
      const fehlt = ss.filter((s) => s.unterbesetzt).reduce((a, s) => a + Math.max(1, s.min_staff - s.assigned.length), 0);
      const tip = ss.map((s) => `${s.unit_name}: ${s.assigned.length}/${s.min_staff}${s.unterbesetzt ? ' – unterbesetzt' : s.ausgeglichen ? ' – im Verbund ausgeglichen' : ''}`).join('\n');
      return h('td', { class: `pp-cell${dayCls(d)} ${fehlt ? 'bad' : 'ok'}`, title: tip }, fehlt ? `−${fehlt}` : '✓');
    }), h('td', {})));

  const kopf = h('tr', {}, h('th', { class: 'pp-name', scope: 'col' }, `${list.length} Personen`),
    days.map((d) => h('th', { scope: 'col', class: `pp-day${dayCls(d)}`, title: plan.holidays[d] || '' }, h('span', {}, WD[wd(d)]), h('span', {}, d.slice(8)))),
    h('th', { scope: 'col', class: 'num', title: 'geplante Stunden im Zeitraum' }, 'Std.'));
  let lastQ = null;
  const body = [];
  for (const p of list) {
    if (p.id !== state.me.id && gruppe(p) !== lastQ && !suche) {
      lastQ = gruppe(p);
      body.push(h('tr', { class: `pp-group${p.beschaeftigung && p.beschaeftigung !== 'stamm' ? ` pp-group-${p.beschaeftigung}` : ''}` }, h('th', { colspan: days.length + 2, scope: 'colgroup' }, h('span', { class: 'pp-group-label' }, lastQ))));
    }
    body.push(h('tr', { class: `${p.id === state.me.id ? 'pp-me' : ''}${p.beschaeftigung && p.beschaeftigung !== 'stamm' ? ` pp-${p.beschaeftigung}` : ''}` },
      h('th', { scope: 'row', class: 'pp-name', title: p.beschaeftigung === 'extern' && p.firma ? `Extern – ${p.firma}` : '' }, avatar(p, 22), h('span', {}, p.name), beschTag(p)),
      days.map((d) => cell(p, d)),
      h('td', { class: 'num pp-std' }, fmtNum(p.std, 1))));
  }

  const quals = state.settings.qualifikationen || [];
  const sucheInput = h('input', { type: 'search', placeholder: 'Name suchen', 'aria-label': 'Name suchen', value: state.ppSuche || '' });
  sucheInput.addEventListener('input', () => { state.ppSuche = sucheInput.value; clearTimeout(state.ppTimer); state.ppTimer = setTimeout(() => renderPersonenplan().then(() => { const el = main().querySelector('input[type=search]'); el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); }), 250); });
  const unitSelect = unitFilterSelect(units, f, (v) => { state.unitFilter = v; ansicht.set('unitFilter', v); renderPersonenplan(); });
  const navLabel = zeitraum === 'monat'
    ? new Date(`${from}T00:00:00Z`).toLocaleDateString('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    : `KW ${isoWeek(from)} · ${fmtDate(from)} – ${fmtDate(to)}`;
  const shift = (n) => {
    if (zeitraum === 'monat') { const [y, m] = state.planMonat.split('-').map(Number); state.planMonat = toIso(Date.UTC(y, m - 1 + n, 1)).slice(0, 7); } else state.weekStart = addDays(state.weekStart, 7 * n);
    renderPersonenplan();
  };
  const aktiveFilter = [f, qual, suche, nurDienst, besch].filter(Boolean).length;
  const toolbar = h('div', { class: 'toolbar pp-toolbar' },
    planModusSchalter(),
    h('div', { class: 'pp-nav' },
      h('button', { class: 'ghost', 'aria-label': 'zurück', onclick: () => shift(-1) }, '‹'),
      h('strong', {}, navLabel),
      h('button', { class: 'ghost', 'aria-label': 'vor', onclick: () => shift(1) }, '›')),
    h('select', { 'aria-label': 'Zeitraum', onchange: (e) => { state.planZeitraum = e.target.value; ansicht.set('planZeitraum', e.target.value); renderPersonenplan(); } },
      h('option', { value: 'woche', selected: zeitraum === 'woche' }, 'Woche'), h('option', { value: 'monat', selected: zeitraum === 'monat' }, 'Monat')));
  const filterBox = h('details', { class: 'pp-filter', open: !isPhone() || state.ppFilterOffen },
    h('summary', {}, 'Filter', aktiveFilter ? h('span', { class: 'badge' }, `${aktiveFilter} aktiv`) : null),
    h('div', { class: 'toolbar' },
    unitSelect,
    h('select', { 'aria-label': 'Beschäftigungsart', onchange: (e) => { state.ppBesch = e.target.value; renderPersonenplan(); } },
      [['', 'alle Beschäftigungsarten'], ['stamm', 'Stammpersonal'], ['flexpool', 'Flexpool'], ['extern', 'Extern']].map(([v, l]) => h('option', { value: v, selected: v === besch }, l))),
    h('select', { 'aria-label': 'Qualifikation', onchange: (e) => { state.ppQual = e.target.value; renderPersonenplan(); } },
      h('option', { value: '' }, 'alle Qualifikationen'), quals.map((q) => h('option', { value: q, selected: q === qual }, q))),
    sucheInput,
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: nurDienst, onchange: (e) => { state.ppNurDienst = e.target.checked; renderPersonenplan(); } }), 'nur mit Diensten')));
  filterBox.addEventListener('toggle', () => { state.ppFilterOffen = filterBox.open; });
  const legend = h('div', { class: 'legend pp-legend' },
    h('span', {}, h('span', { class: 'pp-abs' }, 'U'), ' Urlaub'), isMgr() ? h('span', {}, h('span', { class: 'pp-abs' }, 'K'), ' krank') : h('span', {}, h('span', { class: 'pp-abs' }, 'A'), ' abwesend'),
    h('span', {}, '↗ andere Station'), h('span', {}, h('span', { class: 'btag fp' }, 'FP'), ' Flexpool'), h('span', {}, h('span', { class: 'btag ext' }, 'EXT'), ' extern'), isMgr() ? h('span', {}, '♡ möchte frei · ★ Wunschdienst') : null,
    h('span', {}, h('span', { class: 'pp-ok' }, '✓'), ' besetzt'), h('span', {}, h('span', { class: 'pp-bad' }, '−1'), ' fehlt'),
    h('span', { class: 'muted' }, 'Feld antippen zum Ein-/Austragen'));

  setMain(h('div', { class: 'card pp' }, toolbar, filterBox, isPhone() ? h('details', { class: 'pp-filter' }, h('summary', {}, 'Zeichenerklärung'), legend) : legend,
    plan.shifts.length ? null : h('p', { class: 'muted' }, 'Für diesen Zeitraum sind noch keine Schichten angelegt.'),
    h('div', { class: 'plan-scroll pp-scroll' }, h('table', { class: `plan pp-table${days.length > 7 ? ' pp-monat' : ''}` },
      h('thead', {}, kopf), h('tbody', {}, body, coverRows.length ? h('tr', { class: 'pp-group' }, h('th', { colspan: days.length + 2, scope: 'colgroup' }, h('span', { class: 'pp-group-label' }, 'Besetzung'))) : null, coverRows)))));
  // zum heutigen Tag scrollen (Monatsansicht, schmale Bildschirme)
  const sc = main().querySelector('.pp-scroll');
  const heute = sc?.querySelector('th.pp-day.today');
  const nameCol = sc?.querySelector('thead .pp-name');
  if (heute && nameCol) {
    const r = heute.getBoundingClientRect(), box = sc.getBoundingClientRect();
    if (r.right > box.right) sc.scrollLeft += r.left - nameCol.getBoundingClientRect().right - 2;
  }
}

/** Dialog für eine Person an einem Tag: eigene Dienste austragen/umsetzen, offene Dienste eintragen */
async function personTag(p, d, shifts) {
  const own = shifts.filter((s) => s.date === d && s.assigned.some((a) => a.user_id === p.id));
  const gesperrt = own.some((s) => s.gesperrt) || shifts.some((s) => s.date === d && s.gesperrt);
  const andere = shifts.filter((s) => s.date === d && !s.gesperrt && !s.assigned.some((a) => a.user_id === p.id))
    .filter((s) => isMgr() ? canManageUnit(s.unit_id) : (s.max_staff === null || s.assigned.length < s.max_staff))
    .sort((a, b) => Number(b.unterbesetzt) - Number(a.unterbesetzt) || a.start_time.localeCompare(b.start_time));
  const ab = (state.planAbsences || []).find((a) => a.user_id === p.id && d >= a.from_date && d <= a.to_date);
  const w = (state.planWishes || []).find((x) => x.user_id === p.id && x.date === d);
  const selbst = p.id === state.me.id;
  const dienstZeile = (s) => h('span', {}, h('span', { class: 'chip', style: { background: s.type_color } }, s.type_code), ` ${s.type_name} ${s.start_time}–${s.end_time} · ${s.unit_name}`);
  await openDialog((close) => h('div', { class: 'ui-dialog-body' },
    h('h2', {}, `${p.name} · ${WD[weekday(d)]} ${fmtDate(d)}`),
    ab ? h('p', {}, h('span', { class: 'badge warn' }, absLabel(ab))) : null,
    gesperrt ? h('p', { class: 'small muted' }, '🔒 Der Monat ist für diese Station abgeschlossen.') : null,
    w && isMgr() ? h('p', { class: 'small' }, w.art === 'frei' ? '♡ möchte an diesem Tag frei haben' : `★ Wunschdienst: ${w.type_name}`, w.note ? ` (${w.note})` : '') : null,
    own.length ? h('div', {}, h('h3', {}, 'Eingeteilt'), h('ul', { class: 'pp-dlg-list' }, own.map((s) => h('li', {}, dienstZeile(s),
      s.gesperrt ? h('span', { class: 'badge' }, '🔒 abgeschlossen') : h('span', { class: 'actions' },
        s.verbund?.partner?.length && (canManageUnit(s.unit_id) || selbst) ? h('button', { class: 'tiny ghost', onclick: () => { close(); moveShift(s, { user_id: p.id, name: p.name }); } }, '⇄ Umsetzen') : null,
        canManageUnit(s.unit_id) || selbst ? h('button', { class: 'tiny danger', onclick: () => { close(); unassign(s, p.id, selbst ? undefined : p.name); } }, 'Austragen') : null))))) : null,
    !ab && andere.length ? h('div', {}, h('h3', {}, own.length ? 'Zusätzlich eintragen' : 'Eintragen in'), h('ul', { class: 'pp-dlg-list' }, andere.map((s) => h('li', {}, dienstZeile(s),
      h('span', { class: `small ${s.unterbesetzt ? 'pp-bad' : 'muted'}` }, ` ${s.assigned.length}/${s.min_staff}${s.unterbesetzt ? ' fehlt' : ''}`),
      h('button', { class: 'tiny', onclick: () => { close(); assign(s, selbst && !isMgr() ? undefined : p.id); } }, 'Eintragen'))))) : null,
    !own.length && (ab || !andere.length) ? h('p', { class: 'muted' }, ab ? 'An diesem Tag abwesend.' : 'An diesem Tag gibt es keinen passenden Dienst.') : null,
    h('div', { class: 'ui-dialog-actions' }, h('button', { type: 'button', class: 'ghost', onclick: () => close(null) }, 'Schließen'))));
}

/** Such- und Stationsfilter für lange Listen (Zeiterfassung, Auswertung); liefert { leiste, passt } */
function listenFilter(key, units, rerender) {
  const st = (state.listenFilter ||= {})[key] ||= { suche: '', unit: '' };
  const suche = h('input', { type: 'search', placeholder: 'Name suchen', 'aria-label': 'Name suchen', value: st.suche });
  suche.addEventListener('input', () => { st.suche = suche.value; clearTimeout(st.t); st.t = setTimeout(() => rerender().then(() => { const el = main().querySelector(`input[data-filter="${key}"]`); el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); }), 250); });
  suche.dataset.filter = key;
  const sel = unitFilterSelect(units, st.unit, (v) => { st.unit = v; rerender(); }, 'alle Stationen');
  const unitOk = (uid) => {
    if (!st.unit) return true;
    const u = units.find((x) => x.id === uid);
    if (!u) return false;
    return st.unit.startsWith('b:') ? String(u.building_id ?? 'none') === st.unit.slice(2) : String(u.id) === st.unit.replace(/^u:/, '');
  };
  return {
    leiste: [sel, suche],
    passt: (name, unitId) => (!st.suche || String(name).toLowerCase().includes(st.suche.toLowerCase())) && unitOk(unitId),
  };
}
