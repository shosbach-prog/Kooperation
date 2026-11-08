'use strict';
/* Dienstplan: Wochen- und Tagesansicht, Zellen, Ein-/Austragen, Umsetzen */

// ---------- Dienstplan (Wochenansicht) ----------
async function renderPlan() {
  const from = state.weekStart, to = addDays(from, 6);
  const [units, types, plan, users] = await Promise.all([
    api('GET', 'api/units'), api('GET', 'api/shift-types'),
    api('GET', `api/plan?from=${from}&to=${to}`),
    isMgr() ? api('GET', 'api/users') : Promise.resolve([]),
  ]);
  const days = [...Array(7)].map((_, i) => addDays(from, i));
  const byKey = new Map(plan.shifts.map((s) => [`${s.date}|${s.unit_id}|${s.shift_type_id}`, s]));
  state.planAbsences = plan.absences || [];
  state.planWishes = plan.wishes || [];
  const staffUsers = users.filter((u) => u.active && u.role === 'staff');
  const f = String(state.unitFilter || '');
  const activeUnits = units.filter((u) => u.active && (!f
    || (f.startsWith('b:') ? String(u.building_id ?? 'x') === f.slice(2) || (f === 'b:none' && !u.building_id)
      : String(u.id) === f.replace(/^u:/, ''))));
  const usedTypeIds = new Set(plan.shifts.map((s) => s.shift_type_id));
  const shownTypes = types.filter((t) => t.active || usedTypeIds.has(t.id));

  const unitSelect = unitFilterSelect(units, f, (v) => { state.unitFilter = v; renderPlan(); });

  const kw = isoWeek(from);
  const today = todayIso();
  const toolbar = h('div', { class: 'toolbar' },
    h('button', { class: 'ghost', onclick: () => { state.weekStart = addDays(from, -7); renderPlan(); } }, '‹ Vorwoche'),
    h('button', { class: 'ghost', onclick: () => { state.weekStart = mondayOf(todayIso()); renderPlan(); } }, 'Heute'),
    h('button', { class: 'ghost', onclick: () => { state.weekStart = addDays(from, 7); renderPlan(); } }, 'Nächste Woche ›'),
    h('strong', {}, `KW ${kw} · ${fmtDate(from)} – ${fmtDate(to)}`),
    h('span', { class: 'spacer' }),
    unitSelect,
    h('button', { class: 'ghost', onclick: () => window.print() }, 'Drucken'));

  const legend = h('div', { class: 'legend' },
    h('span', { class: 'l-bad' }, 'unter Mindestbesetzung'), h('span', { class: 'l-covered' }, 'im Verbund ausgeglichen'),
    h('span', { class: 'l-ok' }, 'Mindestbesetzung erreicht'), h('span', { class: 'l-full' }, 'voll besetzt'));

  const thead = h('tr', {}, h('th', {}, 'Dienst'), days.map((d) => {
    const wd = weekday(d); const hol = plan.holidays[d];
    const abs = absentOn(d);
    const mineAbs = abs.find((a) => a.user_id === state.me.id);
    return h('th', { class: `day${wd === 0 || wd === 6 ? ' weekend' : ''}${hol ? ' holiday' : ''}${d === today ? ' today' : ''}`, title: hol || '' },
      `${WD[wd]} ${fmtDate(d).slice(0, 6)}`, hol ? h('div', { class: 'small' }, hol) : null,
      isMgr() && abs.length ? h('div', { class: 'small absent-info', title: abs.map((a) => `${a.name}: ${absLabel(a)}`).join('\n') }, `${abs.length} abwesend`) : null,
      isMgr() && (state.planWishes || []).some((w) => w.date === d) ? (() => {
        const ws = state.planWishes.filter((w) => w.date === d);
        return h('div', { class: 'small wish-info', title: ws.map((w) => `${w.name}: ${w.art === 'frei' ? 'möchte frei' : `Wunsch ${w.type_name}`}${w.note ? ` (${w.note})` : ''}`).join('\n') },
          `★ ${ws.length} Wunsch${ws.length > 1 ? 'e' : ''}`);
      })() : null,
      !isMgr() && mineAbs ? h('div', { class: 'small absent-info' }, absLabel(mineAbs)) : null);
  }));

  const tbody = [];
  let lastBuilding;
  const multiBuildings = new Set(activeUnits.map((u) => u.building_id ?? 0)).size > 1;
  for (const unit of activeUnits) {
    if (multiBuildings && unit.building_id !== lastBuilding) {
      lastBuilding = unit.building_id;
      tbody.push(h('tr', { class: 'building-row' }, h('td', { colspan: 8 }, unit.building_name || 'Ohne Gebäude')));
    }
    tbody.push(h('tr', { class: 'unit-row' }, h('td', { colspan: 8 }, unit.name,
      unit.verbund_name ? h('span', { class: 'verbund-tag', title: unit.verbund_gemeinsam ? 'gemeinsame Mindestbesetzung' : 'Umsetzen möglich' }, `⇄ ${unit.verbund_name}`) : null)));
    for (const t of shownTypes) {
      const rowShifts = days.map((d) => byKey.get(`${d}|${unit.id}|${t.id}`));
      if (!t.active && !rowShifts.some(Boolean)) continue;
      tbody.push(h('tr', {},
        h('td', { class: 'rowhead' }, h('span', { class: 'chip', style: { background: t.color } }, t.code), t.name,
          h('div', { class: 'time' }, `${t.start_time}–${t.end_time}`)),
        rowShifts.map((s, i) => h('td', { class: [0, 6].includes(weekday(days[i])) ? 'weekend' : '' }, renderCell(s, staffUsers, true)))));
    }
  }

  const empty = plan.shifts.length === 0
    ? h('div', { class: 'card' }, h('p', {}, 'Für diese Woche sind noch keine Schichten angelegt.'),
      isMgr() ? h('p', {}, 'Unter ', h('a', { href: '#generate', onclick: (e) => { e.preventDefault(); go('generate'); } }, 'Plan erzeugen'),
        ' können Sie Schichten aus der Mindestbesetzung anlegen.') : h('p', { class: 'muted' }, 'Die Einsatzplanung hat den Plan noch nicht freigegeben.'))
    : null;

  if (dayViewQuery.matches) {
    renderPlanPhone({ from, to, days, plan, byKey, staffUsers, activeUnits, shownTypes, unitSelect, kw, empty });
    return;
  }
  setMain(h('div', { class: 'card' }, toolbar, legend, empty,
    h('div', { class: 'plan-scroll' }, h('table', { class: 'plan' }, h('thead', {}, thead), h('tbody', {}, tbody)))));
}

/** Auswahl „Alle / Gebäude / Station“ für Dienstplan und Personal */
function unitFilterSelect(units, value, onChange, allLabel = 'Ganzer Campus') {
  const active = units.filter((u) => u.active);
  const byBuilding = new Map();
  for (const u of active) {
    const key = u.building_id ?? 'none';
    if (!byBuilding.has(key)) byBuilding.set(key, { name: u.building_name || 'Ohne Gebäude', units: [] });
    byBuilding.get(key).units.push(u);
  }
  const opts = [h('option', { value: '' }, allLabel)];
  if (byBuilding.size > 1 || (byBuilding.size === 1 && !byBuilding.has('none'))) {
    for (const [key, b] of byBuilding) {
      opts.push(h('optgroup', { label: b.name },
        h('option', { value: `b:${key}`, selected: value === `b:${key}` }, `${b.name} – alle Stationen`),
        b.units.map((u) => h('option', { value: `u:${u.id}`, selected: value === `u:${u.id}` || value === String(u.id) }, u.name))));
    }
  } else {
    opts.push(...active.map((u) => h('option', { value: `u:${u.id}`, selected: value === `u:${u.id}` || value === String(u.id) }, u.name)));
  }
  return h('select', { 'aria-label': 'Bereich wählen', onchange: (e) => onChange(e.target.value) }, opts);
}

// ---------- Handyansicht: ein Tag, Dienste untereinander ----------
const phoneQuery = window.matchMedia('(max-width: 759.98px)');
const dayViewQuery = window.matchMedia('(max-width: 899.98px)');
const isPhone = () => phoneQuery.matches;
dayViewQuery.addEventListener('change', () => { if (state.view === 'plan' && state.me) renderPlan(); });

function renderPlanPhone({ from, days, plan, byKey, staffUsers, activeUnits, shownTypes, unitSelect, kw, empty }) {
  if (!state.day || !days.includes(state.day)) state.day = days.includes(todayIso()) ? todayIso() : from;
  const day = state.day;
  const nav = h('div', { class: 'phone-nav' },
    h('button', { class: 'ghost', 'aria-label': 'Vorwoche', onclick: () => { state.weekStart = addDays(from, -7); state.day = addDays(day, -7); renderPlan(); } }, '‹'),
    h('strong', {}, `KW ${kw}`),
    h('button', { class: 'ghost', onclick: () => { state.weekStart = mondayOf(todayIso()); state.day = todayIso(); renderPlan(); } }, 'Heute'),
    h('button', { class: 'ghost', 'aria-label': 'Nächste Woche', onclick: () => { state.weekStart = addDays(from, 7); state.day = addDays(day, 7); renderPlan(); } }, '›'));
  const chips = h('div', { class: 'day-chips' }, days.map((d) => {
    const isToday = d === todayIso();
    const mineHere = plan.shifts.some((s) => s.date === d && s.assigned.some((a) => a.user_id === state.me.id));
    const gap = plan.shifts.some((s) => s.date === d && s.unterbesetzt);
    return h('button', {
      class: `day-chip${d === day ? ' active' : ''}${plan.holidays[d] ? ' holiday' : ''}${isToday ? ' today' : ''}`, 'aria-pressed': String(d === day),
      onclick: () => { state.day = d; renderPlan(); },
    }, h('span', { class: 'wd' }, WD[weekday(d)]), h('span', { class: 'dn' }, d.slice(8)),
      mineHere ? h('span', { class: 'dot mine', title: 'eigener Dienst' }) : gap ? h('span', { class: 'dot gap', title: 'unterbesetzt' }) : null);
  }));
  const abs = absentOn(day);
  const mineAbs = abs.find((a) => a.user_id === state.me.id);
  const head = h('div', { class: 'phone-day' },
    h('h2', {}, `${['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'][weekday(day)]}, ${fmtDate(day)}`),
    plan.holidays[day] ? h('div', { class: 'small holiday-text' }, plan.holidays[day]) : null,
    mineAbs ? h('div', { class: 'absent-info' }, `Sie sind ${absLabel(mineAbs)}.`) : null,
    isMgr() && abs.length ? h('div', { class: 'small absent-info' }, `Abwesend: ${abs.map((a) => `${a.name} (${absLabel(a)})`).join(', ')}`) : null);
  const blocks = activeUnits.map((unit) => {
    const cards = shownTypes.map((t) => {
      const s = byKey.get(`${day}|${unit.id}|${t.id}`);
      if (!s) return null;
      return h('div', { class: 'phone-shift' },
        h('div', { class: 'phone-shift-head' }, h('span', { class: 'chip', style: { background: t.color } }, t.code),
          h('strong', {}, t.name), h('span', { class: 'muted small' }, `${s.start_time}–${s.end_time}`)),
        renderCell(s, staffUsers));
    }).filter(Boolean);
    return cards.length ? h('section', {}, h('h3', {}, unit.name, unit.building_name ? h('span', { class: 'muted' }, unit.building_name) : null,
      unit.verbund_name ? h('span', { class: 'verbund-tag' }, `⇄ ${unit.verbund_name}`) : null), cards) : null;
  });
  setMain(h('div', { class: 'card phone-plan' }, nav, unitSelect, chips, empty, head,
    blocks.some(Boolean) ? blocks : (empty ? null : h('p', { class: 'muted' }, 'An diesem Tag sind keine Dienste angelegt.'))));
}

function isoWeek(iso) {
  const t = parseIso(iso); const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7;
  const thursday = t + (3 - day) * 86400000;
  const yearStart = Date.UTC(new Date(thursday).getUTCFullYear(), 0, 1);
  return 1 + Math.floor((thursday - yearStart) / (7 * 86400000));
}

function absentOn(date) {
  return (state.planAbsences || []).filter((a) => a.from_date <= date && a.to_date >= date);
}
function absLabel(a) {
  if (a.type === 'krank') return 'krank';
  if (a.type === 'kind_krank') return 'Kind krank';
  const t = { sonderurlaub: 'Sonderurlaub', fortbildung: 'Fortbildung', elternzeit: 'Elternzeit' }[a.type] || 'Urlaub';
  return a.status === 'beantragt' ? `${t} beantragt` : t;
}

function renderCell(s, staffUsers, compact = false) {
  if (!s) return h('div', { class: 'cell none' }, '–');
  const n = s.assigned.length;
  const full = s.max_staff !== null && n >= s.max_staff;
  const cls = s.unterbesetzt ? 'bad' : s.ausgeglichen ? 'covered' : full ? 'full' : 'ok';
  const partner = s.verbund ? s.verbund.partner : [];
  const absentIds = new Map(absentOn(s.date).map((a) => [a.user_id, a]));
  const mine = s.assigned.some((a) => a.user_id === state.me.id);

  const canAct = (a) => canManageUnit(s.unit_id) || a.user_id === state.me.id;
  const angebot = (a) => (s.angebote || []).find((o) => o.user_id === a.user_id);
  const swapMark = (a) => (angebot(a) ? h('span', { class: 'swap-mark', title: angebot(a).status === 'angenommen' ? 'Tausch wartet auf Bestätigung' : 'in der Tauschbörse angeboten' }, '⇆') : null);
  const list = h('ul', {}, s.assigned.map((a) => compact
    // Wochenraster: Name anklicken öffnet die Aktionen (spart Platz in schmalen Zellen)
    ? h('li', { class: a.user_id === state.me.id ? 'me' : '', title: `${a.name}${a.qualification ? ` – ${a.qualification}` : ''}` },
      canAct(a) ? h('button', { class: 'person-btn', onclick: () => personActions(s, a) }, avatar(a, 20), h('span', {}, a.name), swapMark(a))
        : h('span', { class: 'person' }, avatar(a, 20), h('span', {}, a.name), swapMark(a)))
    : h('li', { class: a.user_id === state.me.id ? 'me' : '', title: a.qualification },
    h('span', { class: 'person' }, avatar(a, 20), a.name, swapMark(a)),
    h('span', { class: 'li-actions' },
      a.user_id === state.me.id && isStaffRole() && !angebot(a)
        ? h('button', { class: 'tiny ghost', title: 'In der Tauschbörse anbieten', 'aria-label': 'Dienst in der Tauschbörse anbieten', onclick: async () => { if (await offerShift(s)) refresh(); } }, '⇆') : null,
      partner.length && (canManageUnit(s.unit_id) || a.user_id === state.me.id)
        ? h('button', { class: 'tiny ghost', title: 'Auf verbundene Station umsetzen', 'aria-label': `${a.name} umsetzen`, onclick: () => moveShift(s, a) }, '⇄') : null,
      canManageUnit(s.unit_id) ? h('button', { class: 'tiny danger', title: 'Austragen', 'aria-label': `${a.name} austragen`, onclick: () => unassign(s, a.user_id, a.name) }, '×') : null))));

  const count = h('div', { class: 'count' },
    h('span', {}, `${n}/${s.max_staff ?? '∞'} · min ${s.min_staff}`),
    canManageUnit(s.unit_id) ? h('span', { class: 'li-actions' },
      s.unterbesetzt ? h('button', { class: 'tiny ghost', title: 'Rundruf: Personal benachrichtigen', 'aria-label': 'Rundruf senden', onclick: () => rundruf(s) }, '📣') : null,
      h('button', { class: 'tiny ghost', title: 'Besetzung/Notiz ändern', 'aria-label': 'Besetzung oder Notiz ändern', onclick: () => editShift(s) }, '✎')) : null);

  let action = null;
  if (canManageUnit(s.unit_id)) {
    const free = staffUsers.filter((u) => !s.assigned.some((a) => a.user_id === u.id));
    if (free.length) {
      action = h('select', { onchange: (e) => { if (e.target.value) assign(s, Number(e.target.value)); } },
        h('option', { value: '' }, compact ? '+ Person' : '+ Person eintragen'), free.map((u) => {
          const ab = absentIds.get(u.id);
          const w = wishOf(u.id, s.date);
          const wtxt = w ? (w.art === 'frei' ? ' · möchte frei' : w.shift_type_id === s.shift_type_id ? ' · ★ Wunschdienst' : ` · wünscht ${w.type_code}`) : '';
          return h('option', { value: u.id, disabled: !!ab }, `${u.name}${u.qualification ? ' – ' + u.qualification : ''}${ab ? ` (${absLabel(ab)})` : ''}${wtxt}`);
        }));
    }
  } else if (mine) {
    action = h('button', { class: 'tiny ghost', onclick: () => unassign(s, state.me.id) }, 'Austragen');
  } else if (absentIds.has(state.me.id)) {
    action = null;
  } else if (!full) {
    action = h('button', { class: 'tiny', onclick: () => assign(s) }, 'Eintragen');
  }
  const qm = s.verbund?.gemeinsam ? s.verbund.qual_missing : s.qual_missing;
  const missing = s.unterbesetzt && qm.length
    ? h('div', { class: 'missing' }, `fehlt${s.verbund?.gemeinsam ? ' im Verbund' : ''}: `, qm.map((q) => `${q.need - q.have}× ${q.qualification}`).join(', ')) : null;
  // Verbund: gemeinsame Besetzung und mögliche Aushilfe aus der Nachbarstation
  let verbundInfo = null;
  if (s.verbund) {
    const v = s.verbund;
    const helfer = partner.filter((p) => p.besetzt > p.min_staff);
    const tip = `${v.name} (${[s.unit_name, ...partner.map((p) => p.unit_name)].join(' + ')}): ${v.besetzt} von mind. ${v.min} besetzt`
      + `${s.ausgeglichen ? ' – im Verbund ausgeglichen' : ''}${helfer.length ? ` – Aushilfe möglich: ${helfer.map((p) => `${p.unit_name} (+${p.besetzt - p.min_staff})`).join(', ')}` : ''}`;
    verbundInfo = compact
      ? h('div', { class: `verbund-info${v.gemeinsam && v.gedeckt ? ' ok' : ''}`, title: tip },
        `⇄ ${v.besetzt}/${v.min}${s.ausgeglichen ? ' ausgeglichen' : ''}${s.unterbesetzt && helfer.length ? ` · Hilfe: ${helfer.map((p) => p.unit_name).join(', ')}` : ''}`)
      : h('div', { class: `verbund-info${v.gemeinsam && v.gedeckt ? ' ok' : ''}`, title: tip },
        h('span', {}, `⇄ ${v.name}: ${v.besetzt}/${v.min}`),
        s.ausgeglichen ? h('span', {}, ' · im Verbund ausgeglichen') : null,
        s.unterbesetzt && helfer.length ? h('span', {}, ` · Aushilfe möglich: ${helfer.map((p) => `${p.unit_name} (+${p.besetzt - p.min_staff})`).join(', ')}`) : null);
  }
  return h('div', { class: `cell ${cls}` }, count, list, missing, verbundInfo, s.note ? h('div', { class: 'note' }, s.note) : null, action);
}

// ---------- Dienstplan-Aktionen: eintragen, austragen, Schicht bearbeiten ----------
async function assign(s, userId, force = false) {
  let body = userId ? { user_id: userId, force } : {};
  if (!userId) {
    const required = !!state.settings.begruendung_eintragen;
    if (required) {
      const reason = await askReason(`Begründung für das Eintragen in ${s.type_name} am ${fmtDate(s.date)}:`, true);
      if (reason === null) return;
      body = { reason };
    }
  }
  try {
    await api('POST', `api/shifts/${s.id}/assign`, body);
    toast('Eingetragen.');
  } catch (e) {
    if (canManageUnit(s.unit_id) && !force && (e.code === 'RUHEZEIT' || e.code === 'VOLL' || e.code === 'ARBZG')
      && await uiConfirm(`${e.message} Trotzdem eintragen (Ausnahme durch die Einsatzplanung)?`, { title: 'Ausnahme', okText: 'Trotzdem eintragen' })) {
      return assign(s, userId, true);
    }
    toast(e.message, true);
  }
  refresh();
}

async function unassign(s, userId, name) {
  const who = name ? `${name} aus` : 'Sich aus';
  const required = !canManageUnit(s.unit_id) && !!state.settings.begruendung_austragen;
  const reason = await askReason(`${who} ${s.type_name} am ${fmtDate(s.date)} (${s.unit_name}) austragen?`, required, { title: 'Austragen', okText: 'Austragen' });
  if (reason === null) return;
  try {
    await api('DELETE', `api/shifts/${s.id}/assign${canManageUnit(s.unit_id) ? `?user_id=${userId}` : ''}`, { reason });
    toast('Ausgetragen.');
  } catch (e) { toast(e.message, true); }
  refresh();
}

async function editShift(s) {
  const r = await uiForm({
    title: `${s.type_name} · ${WD[weekday(s.date)]} ${fmtDate(s.date)}`, message: s.unit_name,
    fields: [
      { name: 'min', label: 'Mindestbesetzung', type: 'number', min: 0, step: 1, inputmode: 'numeric', value: s.min_staff, required: true },
      { name: 'max', label: 'Höchstbesetzung', type: 'number', min: 0, step: 1, inputmode: 'numeric', value: s.max_staff ?? '', hint: 'leer = unbegrenzt' },
      { name: 'note', label: 'Notiz (optional)', type: 'textarea', rows: 2, value: s.note || '', maxlength: 500 },
    ],
  });
  if (!r) return;
  try {
    await api('PUT', `api/shifts/${s.id}`, { min_staff: Number(r.min), max_staff: r.max === '' ? null : Number(r.max), note: r.note });
    toast('Gespeichert.');
  } catch (e) { toast(e.message, true); }
  refresh();
}

/** Aktionen zu einer eingetragenen Person (Wochenraster) */
function personActions(s, a) {
  const partner = s.verbund ? s.verbund.partner : [];
  const self = a.user_id === state.me.id;
  return openDialog((close) => dialogShell(a.name,
    `${s.type_name} · ${WD[weekday(s.date)]} ${fmtDate(s.date)} · ${s.unit_name}${a.qualification ? `\n${a.qualification}` : ''}`, null, [
      h('button', { type: 'button', class: 'ghost', onclick: () => close(null) }, 'Schließen'),
      canManageUnit(s.unit_id) || self ? h('button', { type: 'button', class: 'danger', onclick: () => close('out') }, 'Austragen') : null,
      self && isStaffRole() && !(s.angebote || []).some((o) => o.user_id === a.user_id)
        ? h('button', { type: 'button', class: 'ghost', onclick: () => close('offer') }, '⇆ Anbieten') : null,
      partner.length && (canManageUnit(s.unit_id) || self) ? h('button', { type: 'button', onclick: () => close('move') }, self && !canManageUnit(s.unit_id) ? '⇄ Station wechseln' : '⇄ Umsetzen') : null,
    ])).then((r) => {
    if (r === 'move') return moveShift(s, a);
    if (r === 'offer') return offerShift(s).then((ok) => ok && refresh());
    if (r === 'out') return unassign(s, a.user_id, canManageUnit(s.unit_id) && !self ? a.name : undefined);
    return null;
  });
}

/** Person innerhalb des Verbunds auf eine verbundene Station umsetzen (gleitendes Aufstocken) */
async function moveShift(s, a, force = false) {
  const partner = s.verbund.partner;
  const self = a.user_id === state.me.id && !canManageUnit(s.unit_id);
  const r = await uiForm({
    title: self ? 'Station wechseln' : `${a.name} umsetzen`,
    message: `${s.type_name} am ${WD[weekday(s.date)]} ${fmtDate(s.date)} · von ${s.unit_name}`,
    okText: 'Umsetzen',
    fields: [
      { name: 'to', label: 'auf Station', type: 'select', value: partner.find((p) => p.besetzt < p.min_staff)?.shift_id ?? partner[0].shift_id,
        options: partner.map((p) => [p.shift_id, `${p.unit_name} – ${p.besetzt}/${p.max_staff ?? '∞'}, min ${p.min_staff}${p.besetzt < p.min_staff ? ' (unterbesetzt)' : ''}`]) },
      { name: 'reason', label: 'Grund (optional)', type: 'textarea', rows: 2, placeholder: 'z. B. Aufnahme, erhöhter Betreuungsbedarf', maxlength: 500 },
    ],
  });
  if (!r) return;
  try {
    await api('POST', `api/shifts/${s.id}/move`, { to_shift_id: Number(r.to), user_id: canManageUnit(s.unit_id) ? a.user_id : undefined, reason: r.reason, force });
    toast('Umgesetzt.');
  } catch (e) {
    if (canManageUnit(s.unit_id) && !force && e.code === 'VOLL' && await uiConfirm(`${e.message} Trotzdem umsetzen?`, { title: 'Ausnahme', okText: 'Trotzdem umsetzen' })) {
      return moveShift(s, a, true);
    }
    toast(e.message, true);
  }
  refresh();
}
