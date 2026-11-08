'use strict';
/* Personaleinsatzplanung – Oberfläche (ohne Build-Schritt, reines JavaScript) */

const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const WD_ORDER = [1, 2, 3, 4, 5, 6, 0];
const state = { me: null, settings: null, view: null, weekStart: null, unitFilter: '', month: null, badges: {} };

// ---------- Hilfsfunktionen ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const authUrl = url.startsWith('/api/login') || url.startsWith('/api/2fa') || url === '/api/me';
    if (res.status === 401 && !authUrl) { state.me = null; renderLogin(); }
    const e = new Error((data && data.error) || res.statusText);
    e.code = data && data.code; e.status = res.status;
    throw e;
  }
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, isErr ? 6000 : 2500);
}

const fmtNum = (x, d = 2) => Number(x || 0).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtDate = (iso) => iso.split('-').reverse().join('.');
const parseIso = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const toIso = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (iso, n) => toIso(parseIso(iso) + n * 86400000);
const weekday = (iso) => new Date(parseIso(iso)).getUTCDay();
const todayIso = () => { const d = new Date(); return toIso(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); };
const mondayOf = (iso) => addDays(iso, -((weekday(iso) + 6) % 7));
const isMgr = () => state.me && state.me.role === 'manager';
const main = () => document.getElementById('main');

function setMain(...nodes) { main().replaceChildren(...nodes.flat(Infinity).filter(Boolean)); }

// ---------- Anmeldung ----------
function renderLogin() {
  document.getElementById('topbar').hidden = true;
  const node = document.getElementById('login-tpl').content.cloneNode(true);
  setMain(node);
  const form = document.getElementById('login-form');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    try {
      const r = await api('POST', '/api/login', { username: fd.get('username'), password: fd.get('password') });
      if (r.stage === '2fa') renderCodeStep();
      else if (r.stage === 'setup') renderSetup(false);
      else await boot();
    } catch (e) { document.getElementById('login-error').textContent = e.message; }
  });
}

// ---------- Navigation ----------
const VIEWS = {
  plan: { label: 'Dienstplan', render: renderPlan },
  mine: { label: 'Meine Dienste', render: renderMine, staff: true },
  abwesenheit: { label: 'Urlaub & Krank', render: renderMyAbsences, staff: true },
  abwesenheiten: { label: 'Abwesenheiten', render: renderAbsencesMgr, mgr: true, badge: 'abwesenheiten' },
  konto: { label: 'Stundenkonto', render: renderKonto, staff: true },
  generate: { label: 'Plan erzeugen', render: renderGenerate, mgr: true },
  staff: { label: 'Mitarbeitende', render: renderStaff, mgr: true },
  types: { label: 'Dienstzeiten', render: renderShiftTypes, mgr: true },
  req: { label: 'Mindestbesetzung', render: renderRequirements, mgr: true },
  report: { label: 'Auswertung TVöD', render: renderReport, mgr: true },
  log: { label: 'Protokoll', render: renderLog, mgr: true },
  settings: { label: 'Einstellungen', render: renderSettings, mgr: true },
  account: { label: 'Sicherheit', render: renderAccount },
};

function renderTabs() {
  const nav = document.getElementById('tabs');
  nav.replaceChildren(...Object.entries(VIEWS)
    .filter(([, v]) => (v.mgr ? isMgr() : v.staff ? !isMgr() : true))
    .map(([key, v]) => h('button', { class: state.view === key ? 'active' : '', onclick: () => go(key) }, v.label,
      v.badge && state.badges[v.badge] ? h('span', { class: 'tab-badge', title: 'offen' }, state.badges[v.badge]) : null)));
}

/** Zähler für offene Urlaubsanträge und fehlende AU-Bescheinigungen (Manager) */
async function refreshBadges() {
  if (!isMgr()) return;
  try {
    const r = await api('GET', '/api/absences');
    state.badges.abwesenheiten = r.absences.filter((a) => a.status === 'beantragt' || a.au_ueberfaellig).length;
  } catch { /* ignorieren */ }
  renderTabs();
}

async function go(view) {
  state.view = view;
  location.hash = view;
  renderTabs();
  setMain(h('p', { class: 'muted' }, 'Lädt …'));
  try { await VIEWS[view].render(); } catch (e) { if (e.status !== 401) setMain(h('p', { class: 'error' }, e.message)); }
}

async function boot() {
  try {
    const { user, settings } = await api('GET', '/api/me');
    state.me = user; state.settings = settings;
  } catch (e) {
    if (e.code === 'STAGE_2FA') renderCodeStep();
    else if (e.code === 'STAGE_SETUP') renderSetup(false);
    else renderLogin();
    return;
  }
  document.getElementById('topbar').hidden = false;
  document.getElementById('clinic-name').textContent = state.settings.klinik_name;
  document.title = `Personaleinsatzplanung – ${state.settings.klinik_name}`;
  document.getElementById('who').textContent = `${state.me.name} (${isMgr() ? 'Einsatzplanung' : 'Mitarbeiter/in'})`;
  state.weekStart = state.weekStart || mondayOf(todayIso());
  state.month = state.month || todayIso().slice(0, 7);
  const fromHash = location.hash.slice(1);
  const allowed = (k) => VIEWS[k] && !(VIEWS[k].mgr && !isMgr()) && !(VIEWS[k].staff && isMgr());
  go(allowed(fromHash) ? fromHash : 'plan');
  refreshBadges();
}

document.getElementById('logout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  state.me = null; location.hash = ''; renderLogin();
});

// ---------- Dienstplan (Wochenansicht) ----------
async function renderPlan() {
  const from = state.weekStart, to = addDays(from, 6);
  const [units, types, plan, users] = await Promise.all([
    api('GET', '/api/units'), api('GET', '/api/shift-types'),
    api('GET', `/api/plan?from=${from}&to=${to}`),
    isMgr() ? api('GET', '/api/users') : Promise.resolve([]),
  ]);
  const days = [...Array(7)].map((_, i) => addDays(from, i));
  const byKey = new Map(plan.shifts.map((s) => [`${s.date}|${s.unit_id}|${s.shift_type_id}`, s]));
  state.planAbsences = plan.absences || [];
  const staffUsers = users.filter((u) => u.active && u.role === 'staff');
  const activeUnits = units.filter((u) => u.active && (!state.unitFilter || String(u.id) === state.unitFilter));
  const usedTypeIds = new Set(plan.shifts.map((s) => s.shift_type_id));
  const shownTypes = types.filter((t) => t.active || usedTypeIds.has(t.id));

  const unitSelect = h('select', { onchange: (e) => { state.unitFilter = e.target.value; renderPlan(); } },
    h('option', { value: '' }, 'Alle Bereiche'),
    units.filter((u) => u.active).map((u) => h('option', { value: u.id, selected: String(u.id) === state.unitFilter }, u.name)));

  const kw = isoWeek(from);
  const toolbar = h('div', { class: 'toolbar' },
    h('button', { class: 'ghost', onclick: () => { state.weekStart = addDays(from, -7); renderPlan(); } }, '‹ Vorwoche'),
    h('button', { class: 'ghost', onclick: () => { state.weekStart = mondayOf(todayIso()); renderPlan(); } }, 'Heute'),
    h('button', { class: 'ghost', onclick: () => { state.weekStart = addDays(from, 7); renderPlan(); } }, 'Nächste Woche ›'),
    h('strong', {}, `KW ${kw} · ${fmtDate(from)} – ${fmtDate(to)}`),
    h('span', { class: 'spacer' }),
    unitSelect,
    h('button', { class: 'ghost', onclick: () => window.print() }, 'Drucken'));

  const legend = h('div', { class: 'legend' },
    h('span', { class: 'l-bad' }, 'unter Mindestbesetzung'), h('span', { class: 'l-ok' }, 'Mindestbesetzung erreicht'), h('span', { class: 'l-full' }, 'voll besetzt'));

  const thead = h('tr', {}, h('th', {}, 'Dienst'), days.map((d) => {
    const wd = weekday(d); const hol = plan.holidays[d];
    const abs = absentOn(d);
    const mineAbs = abs.find((a) => a.user_id === state.me.id);
    return h('th', { class: `day${wd === 0 || wd === 6 ? ' weekend' : ''}${hol ? ' holiday' : ''}`, title: hol || '' },
      `${WD[wd]} ${fmtDate(d).slice(0, 6)}`, hol ? h('div', { class: 'small' }, hol) : null,
      isMgr() && abs.length ? h('div', { class: 'small absent-info', title: abs.map((a) => `${a.name}: ${absLabel(a)}`).join('\n') }, `${abs.length} abwesend`) : null,
      !isMgr() && mineAbs ? h('div', { class: 'small absent-info' }, absLabel(mineAbs)) : null);
  }));

  const tbody = [];
  for (const unit of activeUnits) {
    tbody.push(h('tr', { class: 'unit-row' }, h('td', { colspan: 8 }, unit.name)));
    for (const t of shownTypes) {
      const rowShifts = days.map((d) => byKey.get(`${d}|${unit.id}|${t.id}`));
      if (!t.active && !rowShifts.some(Boolean)) continue;
      tbody.push(h('tr', {},
        h('td', { class: 'rowhead' }, h('span', { class: 'chip', style: { background: t.color } }, t.code), t.name,
          h('div', { class: 'time' }, `${t.start_time}–${t.end_time}`)),
        rowShifts.map((s, i) => h('td', { class: [0, 6].includes(weekday(days[i])) ? 'weekend' : '' }, renderCell(s, staffUsers)))));
    }
  }

  const empty = plan.shifts.length === 0
    ? h('div', { class: 'card' }, h('p', {}, 'Für diese Woche sind noch keine Schichten angelegt.'),
      isMgr() ? h('p', {}, 'Unter ', h('a', { href: '#generate', onclick: (e) => { e.preventDefault(); go('generate'); } }, 'Plan erzeugen'),
        ' können Sie Schichten aus der Mindestbesetzung anlegen.') : h('p', { class: 'muted' }, 'Die Einsatzplanung hat den Plan noch nicht freigegeben.'))
    : null;

  setMain(h('div', { class: 'card' }, toolbar, legend, empty,
    h('div', { class: 'table-wrap' }, h('table', { class: 'plan' }, h('thead', {}, thead), h('tbody', {}, tbody)))));
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
  return a.type === 'krank' ? 'krank' : a.status === 'beantragt' ? 'Urlaub beantragt' : 'Urlaub';
}

function renderCell(s, staffUsers) {
  if (!s) return h('div', { class: 'cell none' }, '–');
  const n = s.assigned.length;
  const full = s.max_staff !== null && n >= s.max_staff;
  const cls = n < s.min_staff || s.qual_missing.length ? 'bad' : full ? 'full' : 'ok';
  const absentIds = new Map(absentOn(s.date).map((a) => [a.user_id, a]));
  const mine = s.assigned.some((a) => a.user_id === state.me.id);

  const list = h('ul', {}, s.assigned.map((a) => h('li', { class: a.user_id === state.me.id ? 'me' : '', title: a.qualification },
    a.name,
    isMgr() ? h('button', { class: 'tiny danger', title: 'Austragen', onclick: () => unassign(s, a.user_id, a.name) }, '×') : null)));

  const count = h('div', { class: 'count' },
    h('span', {}, `${n}/${s.max_staff ?? '∞'} · min ${s.min_staff}`),
    isMgr() ? h('button', { class: 'tiny ghost', title: 'Besetzung/Notiz ändern', onclick: () => editShift(s) }, '✎') : null);

  let action = null;
  if (isMgr()) {
    const free = staffUsers.filter((u) => !s.assigned.some((a) => a.user_id === u.id));
    if (free.length) {
      action = h('select', { onchange: (e) => { if (e.target.value) assign(s, Number(e.target.value)); } },
        h('option', { value: '' }, '+ Person eintragen'), free.map((u) => {
          const ab = absentIds.get(u.id);
          return h('option', { value: u.id, disabled: !!ab }, `${u.name}${u.qualification ? ' – ' + u.qualification : ''}${ab ? ` (${absLabel(ab)})` : ''}`);
        }));
    }
  } else if (mine) {
    action = h('button', { class: 'tiny ghost', onclick: () => unassign(s, state.me.id) }, 'Austragen');
  } else if (absentIds.has(state.me.id)) {
    action = null;
  } else if (!full) {
    action = h('button', { class: 'tiny', onclick: () => assign(s) }, 'Eintragen');
  }
  const missing = s.qual_missing.length
    ? h('div', { class: 'missing' }, 'fehlt: ', s.qual_missing.map((q) => `${q.need - q.have}× ${q.qualification}`).join(', ')) : null;
  return h('div', { class: `cell ${cls}` }, count, list, missing, s.note ? h('div', { class: 'note' }, s.note) : null, action);
}

/** Fragt eine Begründung ab; null = abgebrochen */
function askReason(text, required) {
  while (true) {
    const r = prompt(`${text}${required ? '' : '\n(optional)'}`);
    if (r === null) return null;
    if (!required || r.trim().length >= 3) return r.trim();
    alert('Bitte eine Begründung mit mindestens 3 Zeichen angeben.');
  }
}

async function assign(s, userId, force = false) {
  let body = userId ? { user_id: userId, force } : {};
  if (!userId) {
    const required = !!state.settings.begruendung_eintragen;
    if (required) {
      const reason = askReason(`Begründung für das Eintragen in ${s.type_name} am ${fmtDate(s.date)}:`, true);
      if (reason === null) return;
      body = { reason };
    }
  }
  try {
    await api('POST', `/api/shifts/${s.id}/assign`, body);
    toast('Eingetragen.');
  } catch (e) {
    if (isMgr() && !force && (e.code === 'RUHEZEIT' || e.code === 'VOLL')
      && confirm(`${e.message}\n\nTrotzdem eintragen (Ausnahme durch Einsatzplanung)?`)) {
      return assign(s, userId, true);
    }
    toast(e.message, true);
  }
  refresh();
}

async function unassign(s, userId, name) {
  const who = name ? `${name} aus` : 'Sich aus';
  const required = !isMgr() && !!state.settings.begruendung_austragen;
  const reason = askReason(`${who} ${s.type_name} am ${fmtDate(s.date)} (${s.unit_name}) austragen?\n\nBegründung:`, required);
  if (reason === null) return;
  try {
    await api('DELETE', `/api/shifts/${s.id}/assign${isMgr() ? `?user_id=${userId}` : ''}`, { reason });
    toast('Ausgetragen.');
  } catch (e) { toast(e.message, true); }
  refresh();
}

async function editShift(s) {
  const min = prompt(`Mindestbesetzung für ${s.type_name} am ${fmtDate(s.date)}:`, s.min_staff);
  if (min === null) return;
  const max = prompt('Höchstbesetzung (leer = unbegrenzt):', s.max_staff ?? '');
  if (max === null) return;
  const note = prompt('Notiz (optional):', s.note || '');
  if (note === null) return;
  try {
    await api('PUT', `/api/shifts/${s.id}`, { min_staff: Number(min), max_staff: max === '' ? null : Number(max), note });
    toast('Gespeichert.');
  } catch (e) { toast(e.message, true); }
  refresh();
}

function refresh() { VIEWS[state.view].render(); refreshBadges(); }

// ---------- Meine Dienste (Mitarbeitende) ----------
async function renderMine() {
  const from = todayIso();
  const shifts = await api('GET', `/api/my-shifts?from=${from}&to=${addDays(from, 120)}`);
  const s = state.settings;
  setMain(h('div', { class: 'card' },
    h('h2', {}, 'Meine kommenden Dienste'),
    h('p', { class: 'muted small' }, `Austragen ist bis ${s.austrag_frist_std} Std. vor Dienstbeginn möglich`,
      s.austrag_unter_minimum ? '.' : ', sofern die Mindestbesetzung nicht unterschritten wird.'),
    shifts.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Datum', 'Dienst', 'Bereich', 'Zeit', 'Std.', 'Besetzung', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, shifts.map((x) => h('tr', {},
        h('td', {}, `${WD[weekday(x.date)]} ${fmtDate(x.date)}`, x.holiday ? h('div', { class: 'small muted' }, x.holiday) : null),
        h('td', {}, h('span', { class: 'chip', style: { background: x.type_color } }, x.type_code), x.type_name),
        h('td', {}, x.unit_name),
        h('td', {}, `${x.start_time}–${x.end_time}`),
        h('td', { class: 'num' }, fmtNum(x.hours)),
        h('td', {}, `${x.assigned.length} / min ${x.min_staff}`),
        h('td', {}, h('button', { class: 'tiny ghost', onclick: () => unassign(x, state.me.id) }, 'Austragen'))))))) :
      h('p', {}, 'Sie sind noch für keine Dienste eingetragen. Im ', h('a', { href: '#plan', onclick: (e) => { e.preventDefault(); go('plan'); } }, 'Dienstplan'), ' können Sie sich eintragen.')));
}

// ---------- Stundenkonto (Mitarbeitende) ----------
async function renderKonto() {
  const r = await api('GET', `/api/report?month=${state.month}`);
  const x = r.rows[0];
  const pct = x.min_hours_month ? Math.min(100, (x.ist / x.min_hours_month) * 100) : 100;
  setMain(h('div', { class: 'card' },
    monthToolbar(renderKonto),
    h('div', { class: 'grid-2' },
      h('div', { class: 'card' }, h('div', { class: 'muted' }, 'Ist-Stunden (Dienste + Urlaub + Krank)'), h('div', { class: 'stat' }, fmtNum(x.ist)),
        h('div', { class: 'small muted' }, `Soll nach TVöD: ${fmtNum(x.soll)} Std. · Saldo: ${fmtNum(x.saldo)} Std.`)),
      h('div', { class: 'card' }, h('div', { class: 'muted' }, 'Mindestverfügbarkeit'),
        h('div', { class: 'stat' }, `${fmtNum(x.ist, 1)} / ${fmtNum(x.min_hours_month, 1)} Std.`),
        h('div', { class: 'progress' }, h('div', { style: { width: pct + '%' } })),
        h('div', { class: 'small' }, x.min_erfuellt ? h('span', { class: 'badge ok' }, 'erfüllt') : h('span', { class: 'badge bad' }, `es fehlen ${fmtNum(x.min_hours_month - x.ist, 1)} Std.`)))),
    zuschlagTable([x], false)));
}

function monthToolbar(rerender) {
  return h('div', { class: 'toolbar' },
    h('label', {}, 'Monat', h('input', { type: 'month', value: state.month, onchange: (e) => { state.month = e.target.value; rerender(); } })));
}

function zuschlagTable(rows, withName) {
  const cols = [
    ...(withName ? [['name', 'Name', false], ['qualification', 'Qualifikation', false]] : []),
    ['soll', 'Soll', true], ['gearbeitet', 'Gearbeitet', true], ['urlaub_std', 'Urlaub', true], ['krank_std', 'Krank', true],
    ['ist', 'Ist gesamt', true], ['saldo', 'Saldo', true],
    ...(withName ? [['min_hours_month', 'Mindest-Std.', true]] : []),
    ['dienste', 'Dienste', true, 0], ['nachtschichten', 'Nachtschichten', true, 0],
    ['nacht', 'Nacht', true], ['samstag', 'Samstag', true], ['sonntag', 'Sonntag', true], ['feiertag', 'Feiertag', true], ['vorfest', '24./31.12.', true],
    ['zuschlag_eur', 'Zuschläge €', true],
  ];
  return h('div', { class: 'table-wrap' }, h('h3', {}, 'Stunden und Zeitzuschläge'),
    h('table', {},
      h('thead', {}, h('tr', {}, cols.map(([, l, n]) => h('th', { class: n ? 'num' : '' }, l)), withName ? h('th', {}, 'Mindestverf.') : null)),
      h('tbody', {}, rows.map((r) => h('tr', {},
        cols.map(([k, , n, d]) => h('td', { class: n ? 'num' : '' }, n ? fmtNum(r[k], d ?? 2) : r[k])),
        withName ? h('td', {}, r.min_erfuellt ? h('span', { class: 'badge ok' }, 'erfüllt') : h('span', { class: 'badge bad' }, 'nicht erfüllt'),
          r.au_fehlt ? h('div', {}, h('span', { class: 'badge warn' }, `AU fehlt (${r.au_fehlt})`)) : null) : null)))),
    h('p', { class: 'small muted' }, 'Stundenangaben in Std. (bezahlte Zeit nach Abzug der Pause). Urlaub und Krankheit werden je Arbeitstag mit 1/5 der Wochenarbeitszeit angerechnet. ',
      'Zuschläge € nur, wenn ein Stundenentgelt hinterlegt ist. ',
      'Berechnung angelehnt an TVöD § 6–8; die Prozentsätze werden von der Einsatzplanung gepflegt. Maßgeblich bleibt die Entgeltabrechnung.'));
}

// ---------- Auswertung (Manager) ----------
async function renderReport() {
  const r = await api('GET', `/api/report?month=${state.month}`);
  setMain(h('div', { class: 'card' },
    h('div', { class: 'toolbar' },
      h('label', {}, 'Monat', h('input', { type: 'month', value: state.month, onchange: (e) => { state.month = e.target.value; renderReport(); } })),
      h('span', { class: 'spacer' }),
      h('a', { href: `/api/report.csv?month=${state.month}` }, h('button', { class: 'ghost' }, 'CSV-Export (Excel)'))),
    zuschlagTable(r.rows, true),
    h('h3', {}, `Unterbesetzte Schichten (${r.understaffed.length})`),
    r.understaffed.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Datum', 'Bereich', 'Dienst', 'Besetzt', 'Minimum', 'Qualifikation fehlt'].map((x) => h('th', {}, x)))),
      h('tbody', {}, r.understaffed.map((x) => h('tr', {},
        h('td', {}, h('a', { href: '#plan', onclick: (e) => { e.preventDefault(); state.weekStart = mondayOf(x.date); go('plan'); } }, `${WD[weekday(x.date)]} ${fmtDate(x.date)}`)),
        h('td', {}, x.unit_name), h('td', {}, x.code), h('td', {}, x.besetzt), h('td', {}, x.min_staff), h('td', {}, x.fehlt || '–'))))))
      : h('p', { class: 'muted' }, 'Alle Schichten dieses Monats erreichen die Mindestbesetzung.')));
}

// ---------- Plan erzeugen (Manager) ----------
async function renderGenerate() {
  const units = (await api('GET', '/api/units')).filter((u) => u.active);
  const start = addDays(mondayOf(todayIso()), 7);
  const fromI = h('input', { type: 'date', value: start });
  const toI = h('input', { type: 'date', value: addDays(start, 27) });
  const checks = units.map((u) => h('label', { style: { display: 'flex', gap: '.4rem', alignItems: 'center' } },
    h('input', { type: 'checkbox', checked: true, value: u.id }), u.name));
  setMain(h('div', { class: 'card' },
    h('h2', {}, 'Schichten für einen Zeitraum anlegen'),
    h('p', { class: 'muted' }, 'Die Schichten werden aus den Dienstzeiten und der Mindestbesetzung je Wochentag erzeugt. ',
      'Bereits vorhandene Schichten bleiben unverändert, mehrfaches Erzeugen ist also gefahrlos. Danach können sich die Mitarbeitenden selbst eintragen.'),
    h('div', { class: 'row' }, h('label', {}, 'Von', fromI), h('label', {}, 'Bis', toI)),
    h('h3', {}, 'Bereiche'), checks,
    h('p', {}, h('button', {
      onclick: async () => {
        try {
          const ids = checks.map((c) => c.querySelector('input')).filter((c) => c.checked).map((c) => Number(c.value));
          if (!ids.length) return toast('Bitte mindestens einen Bereich wählen.', true);
          const r = await api('POST', '/api/shifts/generate', { from: fromI.value, to: toI.value, unit_ids: ids });
          toast(`${r.created} Schichten angelegt.`);
          state.weekStart = mondayOf(fromI.value);
        } catch (e) { toast(e.message, true); }
      },
    }, 'Schichten erzeugen'))));
}

// ---------- Mitarbeitende (Manager) ----------
async function renderStaff() {
  const users = await api('GET', '/api/users');
  const form = staffForm(null);
  setMain(
    h('div', { class: 'card' }, h('h2', {}, 'Mitarbeitende'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Name', 'Benutzer', 'Rolle', 'Qualifikation', 'Wochenstd.', 'Mindest-Std./Monat', 'Stundenentgelt €', 'Status', '2FA', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, users.map((u) => h('tr', { class: u.active ? '' : 'inactive' },
          h('td', {}, u.name), h('td', {}, u.username), h('td', {}, u.role === 'manager' ? 'Einsatzplanung' : 'Mitarbeiter/in'),
          h('td', {}, u.qualification), h('td', { class: 'num' }, fmtNum(u.weekly_hours)), h('td', { class: 'num' }, fmtNum(u.min_hours_month, 1)),
          h('td', { class: 'num' }, fmtNum(u.stundenentgelt)), h('td', {}, u.active ? 'aktiv' : 'inaktiv',
            u.locked ? h('div', {}, h('span', { class: 'badge bad' }, 'gesperrt')) : null),
          h('td', {}, u.totp_enabled ? h('span', { class: 'badge ok' }, 'eingerichtet') : h('span', { class: 'badge warn' }, 'offen')),
          h('td', { class: 'actions' },
            h('button', { class: 'tiny ghost', onclick: () => main().querySelector('#staff-form').replaceWith(staffForm(u)) }, 'Bearbeiten'),
            u.totp_enabled ? h('button', { class: 'tiny danger', title: 'z. B. bei Verlust des Handys', onclick: () => userAction(u, { reset_2fa: true },
              `2FA von ${u.name} zurücksetzen? Die Person muss den zweiten Faktor bei der nächsten Anmeldung neu einrichten.`) }, '2FA zurücksetzen') : null,
            u.locked ? h('button', { class: 'tiny ghost', onclick: () => userAction(u, { unlock: true }) }, 'Entsperren') : null))))))),
    form);
}

async function userAction(u, body, question) {
  if (question && !confirm(question)) return;
  try { await api('PUT', `/api/users/${u.id}`, body); toast('Erledigt.'); renderStaff(); } catch (e) { toast(e.message, true); }
}

function staffForm(u) {
  const f = (name, label, attrs = {}) => h('label', {}, label, h('input', { name, ...attrs }));
  const form = h('form', { class: 'card', id: 'staff-form' },
    h('h2', {}, u ? `Bearbeiten: ${u.name}` : 'Neue/n Mitarbeiter/in anlegen'),
    h('div', { class: 'row' },
      f('name', 'Name', { required: true, value: u?.name || '' }),
      f('username', 'Benutzername', { required: true, value: u?.username || '' }),
      f('password', u ? 'Neues Passwort (optional)' : 'Startpasswort', { type: 'password', required: !u, minlength: 6, autocomplete: 'new-password' }),
      h('label', {}, 'Rolle', h('select', { name: 'role' },
        h('option', { value: 'staff', selected: u?.role !== 'manager' }, 'Mitarbeiter/in'),
        h('option', { value: 'manager', selected: u?.role === 'manager' }, 'Einsatzplanung (Manager)'))),
      h('label', {}, 'Qualifikation', h('select', { name: 'qualification' }, h('option', { value: '' }, '– keine –'),
        [...new Set([...(state.settings.qualifikationen || []), ...(u?.qualification ? [u.qualification] : [])])]
          .map((q) => h('option', { value: q, selected: u?.qualification === q }, q)))),
      f('weekly_hours', 'Wochenstunden', { type: 'number', step: '0.25', min: 0, value: u?.weekly_hours ?? state.settings.wochenstunden_standard }),
      f('min_hours_month', 'Mindestverfügbarkeit (Std./Monat)', { type: 'number', step: '0.5', min: 0, value: u?.min_hours_month ?? 0 }),
      f('stundenentgelt', 'Stundenentgelt € (für Zuschläge)', { type: 'number', step: '0.01', min: 0, value: u?.stundenentgelt ?? 0 }),
      f('urlaubstage_jahr', 'Urlaubstage pro Jahr', { type: 'number', step: '0.5', min: 0, value: u?.urlaubstage_jahr ?? state.settings.urlaubstage_standard }),
      u ? h('label', {}, 'Status', h('select', { name: 'active' }, h('option', { value: '1', selected: u.active }, 'aktiv'), h('option', { value: '0', selected: !u.active }, 'inaktiv'))) : null),

    h('p', { class: 'small muted' }, 'Stundenentgelt: Stundenentgelt der Stufe 3 der jeweiligen Entgeltgruppe (Bemessungsgrundlage der Zeitzuschläge nach § 8 TVöD).'),
    h('div', { class: 'toolbar' }, h('button', { type: 'submit' }, u ? 'Speichern' : 'Anlegen'),
      u ? h('button', { type: 'button', class: 'ghost', onclick: () => renderStaff() }, 'Abbrechen') : null));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (u && !data.password) delete data.password;
    if ('active' in data) data.active = data.active === '1';
    try {
      await api(u ? 'PUT' : 'POST', u ? `/api/users/${u.id}` : '/api/users', data);
      toast('Gespeichert.');
      renderStaff();
    } catch (e) { toast(e.message, true); }
  });
  return form;
}

// ---------- Dienstzeiten / Schichtarten (Manager) ----------
async function renderShiftTypes() {
  const [types, units] = await Promise.all([api('GET', '/api/shift-types'), api('GET', '/api/units')]);
  const typeRow = (t) => {
    const inp = (k, attrs) => h('input', { value: t?.[k] ?? '', ...attrs });
    const r = {
      name: inp('name', { placeholder: 'z. B. Frühdienst' }), code: inp('code', { size: 3, maxlength: 4, placeholder: 'F' }),
      start_time: inp('start_time', { type: 'time' }), end_time: inp('end_time', { type: 'time' }),
      break_min: inp('break_min', { type: 'number', min: 0, step: 5 }), color: h('input', { type: 'color', value: t?.color || '#4f7cac' }),
      active: h('input', { type: 'checkbox', checked: t ? !!t.active : true }),
    };
    if (!t) r.break_min.value = 30;
    const save = async () => {
      const body = Object.fromEntries(Object.entries(r).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));
      body.break_min = Number(body.break_min);
      if (t && (body.start_time !== t.start_time || body.end_time !== t.end_time || body.break_min !== t.break_min)) {
        body.apply_future = confirm('Geänderte Zeiten auch für bereits erzeugte, zukünftige Schichten übernehmen?');
      }
      try {
        const res = await api(t ? 'PUT' : 'POST', t ? `/api/shift-types/${t.id}` : '/api/shift-types', body);
        toast(res.updated_shifts ? `Gespeichert, ${res.updated_shifts} Schichten angepasst.` : 'Gespeichert.');
        renderShiftTypes();
      } catch (e) { toast(e.message, true); }
    };
    return h('tr', { class: t && !t.active ? 'inactive' : '' }, Object.values(r).map((el) => h('td', {}, el)),
      h('td', { class: 'num' }, t ? fmtNum(hoursOf(t)) : ''), h('td', {}, h('button', { class: 'tiny', onclick: save }, t ? 'Speichern' : 'Hinzufügen')));
  };

  const unitRow = (u) => {
    const name = h('input', { value: u?.name || '', placeholder: 'z. B. Station 3' });
    const active = h('input', { type: 'checkbox', checked: u ? !!u.active : true });
    return h('tr', { class: u && !u.active ? 'inactive' : '' }, h('td', {}, name), h('td', {}, active),
      h('td', {}, h('button', {
        class: 'tiny', onclick: async () => {
          try { await api(u ? 'PUT' : 'POST', u ? `/api/units/${u.id}` : '/api/units', { name: name.value, active: active.checked }); toast('Gespeichert.'); renderShiftTypes(); } catch (e) { toast(e.message, true); }
        },
      }, u ? 'Speichern' : 'Hinzufügen')));
  };

  setMain(
    h('div', { class: 'card' }, h('h2', {}, 'Dienstzeiten (Schichtarten)'),
      h('p', { class: 'muted small' }, 'Endet ein Dienst vor seinem Beginn (z. B. 21:30–06:30), geht er über Mitternacht. Die Pause wird nicht als Arbeitszeit angerechnet.'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Bezeichnung', 'Kürzel', 'Beginn', 'Ende', 'Pause (Min.)', 'Farbe', 'Aktiv', 'Std.', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, types.map(typeRow), typeRow(null))))),
    h('div', { class: 'card' }, h('h2', {}, 'Bereiche / Stationen'),
      h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Aktiv', ''].map((x) => h('th', {}, x)))), h('tbody', {}, units.map(unitRow), unitRow(null)))));
}

function hoursOf(t) {
  const m = (x) => { const [a, b] = x.split(':').map(Number); return a * 60 + b; };
  let d = m(t.end_time) - m(t.start_time);
  if (d <= 0) d += 1440;
  return (d - t.break_min) / 60;
}

// ---------- Mindestbesetzung (Manager) ----------
async function qualRulesCard(units, types) {
  const rules = await api('GET', '/api/qual-rules');
  const unitSel = h('select', {}, h('option', { value: '' }, 'alle Bereiche'), units.map((u) => h('option', { value: u.id }, u.name)));
  const typeSel = h('select', {}, h('option', { value: '' }, 'alle Dienste'), types.map((t) => h('option', { value: t.id }, t.name)));
  const qualSel = h('select', {}, (state.settings.qualifikationen || []).map((q) => h('option', { value: q }, q)));
  const count = h('input', { type: 'number', min: 1, step: 1, value: 1 });
  return h('div', { class: 'card' }, h('h2', {}, 'Mindestbesetzung nach Qualifikation'),
    h('p', { class: 'muted' }, 'Zusätzliche Regeln je Dienst, z. B. „In jedem Nachtdienst mindestens 1 Pflegefachkraft“. ',
      'Schichten, die eine Regel nicht erfüllen, werden rot markiert; Mitarbeitende können sich dann nicht austragen, wenn dadurch die Regel verletzt würde.'),
    rules.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Bereich', 'Dienst', 'Qualifikation', 'mindestens', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, rules.map((r) => h('tr', {}, h('td', {}, r.unit_name || 'alle'), h('td', {}, r.type_name || 'alle'), h('td', {}, r.qualification),
        h('td', {}, r.min_count), h('td', {}, h('button', { class: 'tiny danger', onclick: async () => {
          await api('DELETE', `/api/qual-rules/${r.id}`); toast('Regel gelöscht.'); renderRequirements();
        } }, 'Löschen'))))))
      : h('p', { class: 'muted' }, 'Noch keine Regeln.'),
    h('h3', {}, 'Neue Regel'),
    h('div', { class: 'row' }, h('label', {}, 'Bereich', unitSel), h('label', {}, 'Dienst', typeSel), h('label', {}, 'Qualifikation', qualSel),
      h('label', {}, 'mindestens', count),
      h('button', { onclick: async () => {
        try {
          await api('POST', '/api/qual-rules', { unit_id: unitSel.value || null, shift_type_id: typeSel.value || null, qualification: qualSel.value, min_count: Number(count.value) });
          toast('Regel hinzugefügt.'); renderRequirements();
        } catch (e) { toast(e.message, true); }
      } }, 'Hinzufügen')),
    h('p', { class: 'small muted' }, 'Die Liste der Qualifikationen pflegen Sie unter Einstellungen.'));
}

async function renderRequirements() {
  const [units, types, reqs] = await Promise.all([api('GET', '/api/units'), api('GET', '/api/shift-types'), api('GET', '/api/requirements')]);
  const activeTypes = types.filter((t) => t.active);
  const get = (u, t, wd) => reqs.find((r) => r.unit_id === u && r.shift_type_id === t && r.weekday === wd);
  const inputs = [];
  const cards = units.filter((u) => u.active).map((u) => h('div', { class: 'card' }, h('h3', {}, u.name),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Dienst'), WD_ORDER.map((wd) => h('th', {}, WD[wd])))),
      h('tbody', {}, activeTypes.map((t) => h('tr', {},
        h('td', {}, h('span', { class: 'chip', style: { background: t.color } }, t.code), t.name),
        WD_ORDER.map((wd) => {
          const r = get(u.id, t.id, wd);
          const min = h('input', { type: 'number', min: 0, step: 1, value: r?.min_staff ?? 0, title: 'Minimum', style: { width: '3.6em' } });
          const max = h('input', { type: 'number', min: 0, step: 1, value: r?.max_staff ?? '', placeholder: '∞', title: 'Maximum', style: { width: '3.6em' } });
          inputs.push({ unit_id: u.id, shift_type_id: t.id, weekday: wd, min, max });
          return h('td', {}, min, ' – ', max);
        }))))))));

  setMain(h('div', { class: 'card' }, h('h2', {}, 'Mindestbesetzung je Wochentag'),
    h('p', { class: 'muted' }, 'Je Feld: Minimum – Maximum an Personen pro Dienst. Ein Dienst mit Minimum 0 und leerem Maximum wird nicht angelegt. ',
      'Änderungen gelten für neu erzeugte Schichten; einzelne Schichten passen Sie im Dienstplan über ✎ an.'),
    h('p', {}, h('button', {
      onclick: async () => {
        try {
          await api('PUT', '/api/requirements', inputs.map((i) => ({
            unit_id: i.unit_id, shift_type_id: i.shift_type_id, weekday: i.weekday,
            min_staff: Number(i.min.value || 0), max_staff: i.max.value === '' ? null : Number(i.max.value),
          })));
          toast('Mindestbesetzung gespeichert.');
        } catch (e) { toast(e.message, true); }
      },
    }, 'Speichern'))), cards, await qualRulesCard(units.filter((u) => u.active), activeTypes));
}

// ---------- Einstellungen (Manager) ----------
async function renderSettings() {
  const s = await api('GET', '/api/settings');
  const fields = [
    ['klinik_name', 'Name der Einrichtung', 'text'],
    ['zwei_faktor_pflicht', 'Zwei-Faktor-Anmeldung für alle verpflichtend', 'checkbox', 'Empfohlen. Ohne eingerichteten zweiten Faktor ist dann keine Anmeldung möglich.'],
    ['wochenstunden_standard', 'Regelmäßige Wochenarbeitszeit (Std.)', 'number', 'TVöD-K: 38,5 Std.'],
    ['austrag_frist_std', 'Austragen möglich bis … Std. vor Dienstbeginn', 'number'],
    ['austrag_unter_minimum', 'Austragen auch unter Mindestbesetzung erlauben', 'checkbox'],
    ['begruendung_austragen', 'Begründung beim Austragen verlangen', 'checkbox'],
    ['begruendung_eintragen', 'Begründung beim Eintragen verlangen', 'checkbox'],
    ['urlaubstage_standard', 'Urlaubstage pro Jahr (Standard für neue Mitarbeitende)', 'number', 'TVöD § 26: 30 Arbeitstage bei 5-Tage-Woche'],
    ['au_ab_tag', 'AU-Bescheinigung erforderlich ab Krankheitstag', 'number', 'EFZG § 5: ab dem 4. Kalendertag; 1 = ab dem ersten Tag'],
    ['qualifikationen', 'Qualifikationen (eine pro Zeile)', 'list'],
    ['ruhezeit_std', 'Mindestruhezeit zwischen zwei Diensten (Std.)', 'number', '§ 5 ArbZG: 11 Std.; in Krankenhäusern unter Bedingungen 10 Std.'],
    ['nacht_von', 'Nachtarbeit von', 'time'], ['nacht_bis', 'Nachtarbeit bis', 'time', 'TVöD § 7 Abs. 5: 21–6 Uhr'],
    ['zuschlag_nacht', 'Zuschlag Nachtarbeit (%)', 'number'],
    ['zuschlag_sonntag', 'Zuschlag Sonntagsarbeit (%)', 'number'],
    ['zuschlag_feiertag', 'Zuschlag Feiertagsarbeit (%)', 'number', 'TVöD: 35 % mit Freizeitausgleich, 135 % ohne'],
    ['zuschlag_vorfest', 'Zuschlag 24.12./31.12. ab 6 Uhr (%)', 'number'],
    ['zuschlag_samstag', 'Zuschlag Samstag 13–21 Uhr (%)', 'number'],
    ['samstag_bei_schichtarbeit', 'Samstagszuschlag auch im Schichtdienst anrechnen', 'checkbox', 'Nach TVöD entfällt er bei Wechselschicht-/Schichtarbeit.'],
  ];
  const els = {};
  const form = h('form', { class: 'card' }, h('h2', {}, 'Einstellungen'),
    h('div', { class: 'grid-2' }, fields.map(([k, label, type, hint]) => {
      const el = type === 'list'
        ? h('textarea', { rows: 6, value: (s[k] || []).join('\n') })
        : h('input', type === 'checkbox' ? { type, checked: !!s[k] } : { type, value: s[k], step: type === 'number' ? 'any' : undefined, style: type === 'text' ? { width: '100%' } : undefined });
      el.dataset.kind = type;
      els[k] = el;
      return h('label', {}, label, el, hint ? h('span', { class: 'small muted' }, hint) : null);
    })),
    h('p', { class: 'small muted' }, 'Hinweis: Die Prozentsätze sind Vorgabewerte und müssen mit dem aktuell gültigen Tarifvertrag bzw. den Haustarif-Regelungen abgeglichen werden.'),
    h('button', { type: 'submit' }, 'Speichern'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = Object.fromEntries(Object.entries(els).map(([k, el]) => [k,
      el.dataset.kind === 'list' ? el.value.split('\n') : el.type === 'checkbox' ? el.checked : el.value]));
    try {
      state.settings = await api('PUT', '/api/settings', body);
      document.getElementById('clinic-name').textContent = state.settings.klinik_name;
      toast('Einstellungen gespeichert.');
    } catch (e) { toast(e.message, true); }
  });
  setMain(form);
}

// ---------- Urlaub & Krankheit ----------
const STATUS = {
  beantragt: ['warn', 'beantragt'], genehmigt: ['ok', 'genehmigt'], abgelehnt: ['bad', 'abgelehnt'], gemeldet: ['warn', 'krankgemeldet'],
};
const statusBadge = (a) => h('span', { class: `badge ${STATUS[a.status][0]}` }, STATUS[a.status][1]);
const typeLabel = (a) => (a.type === 'krank' ? 'Krankheit' : 'Urlaub');
const range = (a) => (a.from_date === a.to_date ? fmtDate(a.from_date) : `${fmtDate(a.from_date)} – ${fmtDate(a.to_date)}`);
const fmtSize = (b) => (b > 1024 * 1024 ? `${fmtNum(b / 1024 / 1024, 1)} MB` : `${Math.ceil(b / 1024)} KB`);

function auStatus(a) {
  if (a.type !== 'krank') return null;
  if (!a.au_erforderlich) return h('span', { class: 'small muted' }, `AU erst ab ${state.settings.au_ab_tag}. Tag nötig`);
  if (!a.au_fehlt) return h('span', { class: 'badge ok' }, 'AU liegt vor');
  return h('span', { class: `badge ${a.au_ueberfaellig ? 'bad' : 'warn'}` }, a.au_ueberfaellig ? 'AU fehlt' : `AU fällig ab ${fmtDate(a.au_faellig_ab)}`);
}

function attachmentList(a, canDelete) {
  if (!a.attachments.length) return null;
  return h('ul', { class: 'files' }, a.attachments.map((f) => h('li', {},
    h('a', { href: `/api/attachments/${f.id}?inline=1`, target: '_blank', rel: 'noopener' }, f.filename),
    h('span', { class: 'small muted' }, ` (${fmtSize(f.size)})`),
    canDelete ? h('button', { class: 'tiny danger', title: 'Datei löschen', onclick: async () => {
      if (!confirm(`${f.filename} löschen?`)) return;
      try { await api('DELETE', `/api/attachments/${f.id}`); toast('Gelöscht.'); refresh(); } catch (e) { toast(e.message, true); }
    } }, '×') : null)));
}

function uploadButton(a) {
  const input = h('input', { type: 'file', accept: 'application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png', hidden: true });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return toast('Die Datei ist größer als 10 MB.', true);
    try {
      const res = await fetch(`/api/absences/${a.id}/attachments`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) }, body: file,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast('Bescheinigung hochgeladen.');
      refresh();
    } catch (e) { toast(e.message, true); }
  });
  return h('span', {}, input, h('button', { class: 'tiny', onclick: () => input.click() }, 'AU hochladen'));
}

async function extendSickness(a) {
  const to = prompt(`Krankmeldung ${range(a)} – neues Enddatum (TT.MM.JJJJ):`, fmtDate(a.to_date));
  if (!to) return;
  const m = to.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return toast('Bitte Datum als TT.MM.JJJJ angeben.', true);
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  try {
    const r = await api('PUT', `/api/absences/${a.id}`, { to: iso });
    toast(r.removed ? `Gespeichert. ${r.removed} Dienst(e) wurden ausgetragen.` : 'Gespeichert.');
    if (r.au_fehlt) alert(`Ab dem ${state.settings.au_ab_tag}. Krankheitstag ist eine Arbeitsunfähigkeitsbescheinigung erforderlich. Bitte laden Sie sie hoch.`);
  } catch (e) { toast(e.message, true); }
  refresh();
}

function absenceForm(type, onSaved, users) {
  const today = todayIso();
  const userSel = users ? h('select', { required: true }, h('option', { value: '' }, '– Person wählen –'),
    users.map((u) => h('option', { value: u.id }, u.name))) : null;
  const typeSel = users ? h('select', {}, h('option', { value: 'urlaub' }, 'Urlaub (genehmigt)'), h('option', { value: 'krank' }, 'Krankheit')) : null;
  const from = h('input', { type: 'date', required: true, value: type === 'krank' ? today : '' });
  const to = h('input', { type: 'date', required: true, value: type === 'krank' ? today : '' });
  from.addEventListener('change', () => { if (!to.value || to.value < from.value) to.value = from.value; });
  const note = h('input', { placeholder: type === 'krank' ? 'optional' : 'optional, z. B. Familienurlaub', maxlength: 500 });
  const form = h('form', { class: 'row' },
    userSel ? h('label', {}, 'Mitarbeiter/in', userSel) : null, typeSel ? h('label', {}, 'Art', typeSel) : null,
    h('label', {}, type === 'krank' ? 'krank seit' : 'von', from),
    h('label', {}, type === 'krank' ? 'voraussichtlich bis' : 'bis', to),
    h('label', {}, 'Bemerkung', note),
    h('button', { type: 'submit' }, users ? 'Eintragen' : type === 'krank' ? 'Krank melden' : 'Urlaub beantragen'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const t = typeSel ? typeSel.value : type;
    try {
      const r = await api('POST', '/api/absences', { type: t, from: from.value, to: to.value, note: note.value, user_id: userSel?.value || undefined });
      let msg = t === 'krank' ? 'Krankmeldung gespeichert.' : users ? 'Urlaub eingetragen.' : `Urlaubsantrag über ${r.arbeitstage} Arbeitstage gestellt.`;
      if (r.removed) msg += ` ${r.removed} Dienst(e) wurden ausgetragen.`;
      toast(msg);
      if (t === 'krank' && r.au_erforderlich && !users) {
        alert(`Ihre Krankmeldung umfasst ${r.kalendertage} Tage. Ab dem ${state.settings.au_ab_tag}. Tag ist eine Arbeitsunfähigkeitsbescheinigung nötig – bitte laden Sie sie unten hoch.`);
      }
      onSaved();
    } catch (e) { toast(e.message, true); }
  });
  return form;
}

async function renderMyAbsences() {
  const year = Number(todayIso().slice(0, 4));
  const r = await api('GET', `/api/absences?year=${year}`);
  const u = r.urlaub;
  const pct = u.anspruch ? Math.min(100, ((u.genehmigt + u.beantragt) / u.anspruch) * 100) : 0;
  setMain(
    h('div', { class: 'grid-2' },
      h('div', { class: 'card' }, h('h2', {}, `Urlaubskonto ${u.jahr}`),
        h('div', { class: 'stat' }, `${fmtNum(u.rest, 1)} Tage übrig`),
        h('div', { class: 'progress' }, h('div', { style: { width: pct + '%' } })),
        h('p', { class: 'small muted' }, `Anspruch ${fmtNum(u.anspruch, 1)} · genehmigt ${u.genehmigt} · beantragt ${u.beantragt} (Arbeitstage)`)),
      h('div', { class: 'card' }, h('h2', {}, 'Krankmeldung'),
        h('p', { class: 'small muted' }, `Bitte melden Sie sich zusätzlich telefonisch auf der Station ab. Ab dem ${r.au_ab_tag}. Krankheitstag ist eine `,
          'Arbeitsunfähigkeitsbescheinigung (AU) hochzuladen (PDF oder Foto). Bereits eingetragene Dienste im Zeitraum werden automatisch ausgetragen.'),
        absenceForm('krank', renderMyAbsences))),
    h('div', { class: 'card' }, h('h2', {}, 'Urlaub beantragen'),
      h('p', { class: 'small muted' }, 'Der Antrag geht an die Einsatzplanung. Gezählt werden Arbeitstage (Mo–Fr ohne Feiertage). Nach der Genehmigung werden Dienste im Zeitraum ausgetragen.'),
      absenceForm('urlaub', renderMyAbsences)),
    h('div', { class: 'card' }, h('h2', {}, 'Meine Einträge'),
      r.absences.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Art', 'Zeitraum', 'Tage', 'Status', 'Bemerkung', 'Bescheinigung', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, r.absences.map((a) => h('tr', {},
          h('td', {}, typeLabel(a)), h('td', {}, range(a)),
          h('td', { class: 'num' }, a.type === 'urlaub' ? `${a.arbeitstage} AT` : `${a.kalendertage} KT`),
          h('td', {}, statusBadge(a)),
          h('td', {}, a.note, a.decision_note ? h('div', { class: 'small muted' }, `Einsatzplanung: ${a.decision_note}`) : null),
          h('td', {}, auStatus(a), attachmentList(a, true)),
          h('td', { class: 'actions' },
            a.type === 'krank' ? uploadButton(a) : null,
            a.type === 'krank' ? h('button', { class: 'tiny ghost', onclick: () => extendSickness(a) }, 'Verlängern') : null,
            a.type === 'urlaub' && a.status === 'beantragt' ? h('button', { class: 'tiny danger', onclick: async () => {
              if (!confirm('Urlaubsantrag zurückziehen?')) return;
              try { await api('DELETE', `/api/absences/${a.id}`); toast('Zurückgezogen.'); renderMyAbsences(); } catch (e) { toast(e.message, true); }
            } }, 'Zurückziehen') : null))))))
        : h('p', { class: 'muted' }, 'Keine Einträge.')),
    h('p', { class: 'small muted' }, 'Hinweis: Bei gesetzlich Versicherten ruft der Arbeitgeber die AU zusätzlich elektronisch ab (eAU). ',
      'Die hochgeladenen Bescheinigungen sehen nur Sie und die Einsatzplanung.'));
}

async function renderAbsencesMgr() {
  const from = `${state.month}-01`;
  const [y, m] = state.month.split('-').map(Number);
  const to = toIso(Date.UTC(y, m, 0));
  const [open, inMonth, users] = await Promise.all([
    api('GET', '/api/absences?status=beantragt'),
    api('GET', `/api/absences?from=${from}&to=${to}`),
    api('GET', '/api/users'),
  ]);
  const decide = async (a, status) => {
    let note = '';
    if (status === 'abgelehnt') {
      note = askReason(`Urlaubsantrag von ${a.name} (${range(a)}) ablehnen.\n\nBegründung:`, true);
      if (note === null) return;
    } else {
      const extra = a.konflikte ? `\n\nAchtung: ${a.name} ist in ${a.konflikte} Dienst(en) eingetragen. Diese werden ausgetragen.` : '';
      if (!confirm(`Urlaub von ${a.name} (${range(a)}, ${a.arbeitstage} Arbeitstage) genehmigen?${extra}`)) return;
    }
    try {
      const r = await api('PUT', `/api/absences/${a.id}/decision`, { status, note });
      toast(status === 'genehmigt' ? `Genehmigt.${r.removed ? ` ${r.removed} Dienst(e) ausgetragen.` : ''}` : 'Abgelehnt.');
    } catch (e) { toast(e.message, true); }
    refresh();
  };
  const sick = inMonth.absences.filter((a) => a.type === 'krank');
  const vac = inMonth.absences.filter((a) => a.type === 'urlaub' && a.status !== 'beantragt');
  const auMissing = (await api('GET', '/api/absences')).absences.filter((a) => a.au_ueberfaellig);
  setMain(
    h('div', { class: 'card' }, h('h2', {}, `Offene Urlaubsanträge (${open.absences.length})`),
      open.absences.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Mitarbeiter/in', 'Zeitraum', 'Arbeitstage', 'Bemerkung', 'eingetragen in', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, open.absences.map((a) => h('tr', {},
          h('td', {}, a.name, h('div', { class: 'small muted' }, a.qualification)), h('td', {}, range(a)), h('td', { class: 'num' }, a.arbeitstage),
          h('td', {}, a.note), h('td', {}, a.konflikte ? h('span', { class: 'badge warn' }, `${a.konflikte} Dienst(en)`) : '–'),
          h('td', { class: 'actions' },
            h('button', { class: 'tiny', onclick: () => decide(a, 'genehmigt') }, 'Genehmigen'),
            h('button', { class: 'tiny danger', onclick: () => decide(a, 'abgelehnt') }, 'Ablehnen'),
            h('button', { class: 'tiny ghost', onclick: () => { state.weekStart = mondayOf(a.from_date); go('plan'); } }, 'Plan ansehen')))))))
        : h('p', { class: 'muted' }, 'Keine offenen Anträge.')),
    auMissing.length ? h('div', { class: 'card warn-card' }, h('h2', {}, `Fehlende AU-Bescheinigungen (${auMissing.length})`),
      h('ul', {}, auMissing.map((a) => h('li', {}, `${a.name}: krank ${range(a)} – fällig seit ${fmtDate(a.au_faellig_ab)}`)))) : null,
    h('div', { class: 'card' },
      h('div', { class: 'toolbar' }, h('h2', { style: { margin: 0 } }, 'Abwesenheiten im Monat'), h('span', { class: 'spacer' }),
        h('label', {}, 'Monat', h('input', { type: 'month', value: state.month, onchange: (e) => { state.month = e.target.value; renderAbsencesMgr(); } }))),
      h('h3', {}, `Krankheit (${sick.length})`),
      sick.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Mitarbeiter/in', 'Zeitraum', 'Kalendertage', 'AU', 'Dateien', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, sick.map((a) => h('tr', {},
          h('td', {}, a.name), h('td', {}, range(a)), h('td', { class: 'num' }, a.kalendertage), h('td', {}, auStatus(a)),
          h('td', {}, attachmentList(a, true) || '–'),
          h('td', { class: 'actions' }, uploadButton(a), h('button', { class: 'tiny ghost', onclick: () => extendSickness(a) }, 'Ende ändern'),
            h('button', { class: 'tiny danger', onclick: async () => {
              if (!confirm(`Krankmeldung von ${a.name} (${range(a)}) löschen? Hochgeladene Bescheinigungen werden ebenfalls gelöscht.`)) return;
              try { await api('DELETE', `/api/absences/${a.id}`); toast('Gelöscht.'); refresh(); } catch (e) { toast(e.message, true); }
            } }, 'Löschen')))))))
        : h('p', { class: 'muted' }, 'Keine.'),
      h('h3', {}, `Urlaub (${vac.length})`),
      vac.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Mitarbeiter/in', 'Zeitraum', 'Arbeitstage', 'Status', 'Bemerkung', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, vac.map((a) => h('tr', {},
          h('td', {}, a.name), h('td', {}, range(a)), h('td', { class: 'num' }, a.arbeitstage), h('td', {}, statusBadge(a)),
          h('td', {}, a.note, a.decision_note ? h('div', { class: 'small muted' }, a.decision_note) : null),
          h('td', {}, h('button', { class: 'tiny danger', onclick: async () => {
            if (!confirm(`Urlaubseintrag von ${a.name} (${range(a)}) löschen?`)) return;
            try { await api('DELETE', `/api/absences/${a.id}`); toast('Gelöscht.'); refresh(); } catch (e) { toast(e.message, true); }
          } }, 'Löschen')))))))
        : h('p', { class: 'muted' }, 'Keiner.')),
    h('div', { class: 'card' }, h('h2', {}, 'Abwesenheit direkt eintragen'),
      h('p', { class: 'small muted' }, 'Z. B. bei telefonischer Krankmeldung. Dienste im Zeitraum werden automatisch ausgetragen.'),
      absenceForm('urlaub', renderAbsencesMgr, users.filter((u) => u.active && u.role === 'staff'))));
}

// ---------- Protokoll (Manager) ----------
const LOG_LABEL = {
  'assignment.add': 'eingetragen', 'assignment.remove': 'ausgetragen', 'absence.create': 'Abwesenheit angelegt',
  'absence.decide': 'Urlaub entschieden', 'absence.update': 'Abwesenheit geändert', 'absence.delete': 'Abwesenheit gelöscht',
  'attachment.upload': 'AU hochgeladen',
};
async function renderLog() {
  const rows = await api('GET', '/api/log?limit=300');
  setMain(h('div', { class: 'card' }, h('h2', {}, 'Protokoll: Ein- und Austragungen, Abwesenheiten'),
    h('p', { class: 'small muted' }, 'Die letzten 300 Einträge, neueste zuerst.'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Zeitpunkt', 'Aktion', 'Mitarbeiter/in', 'Dienst', 'durch', 'Begründung / Bemerkung'].map((x) => h('th', {}, x)))),
      h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', { class: 'small' }, new Date(r.at.replace(' ', 'T') + 'Z').toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })),
        h('td', {}, LOG_LABEL[r.action] || r.action, r.details.automatisch ? h('div', { class: 'small muted' }, 'automatisch') : null,
          r.details.status ? h('div', { class: 'small muted' }, r.details.status) : null),
        h('td', {}, r.person || '–'),
        h('td', {}, r.shift ? `${r.shift.code} ${fmtDate(r.shift.date)} · ${r.shift.unit_name}`
          : r.details.from ? `${r.details.type === 'krank' ? 'Krank' : r.details.type === 'urlaub' ? 'Urlaub' : ''} ${fmtDate(r.details.from)} – ${fmtDate(r.details.to)}` : '–'),
        h('td', {}, r.actor),
        h('td', {}, r.reason || (r.details.filename ? r.details.filename : '–')))))))));
}

// ---------- Zwei-Faktor-Anmeldung ----------
function authShell(...children) {
  document.getElementById('topbar').hidden = true;
  setMain(h('section', { class: 'login card' }, children));
}

async function cancelLogin() {
  await api('POST', '/api/logout').catch(() => {});
  renderLogin();
}

function renderCodeStep() {
  const input = h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', required: true, autofocus: true,
    placeholder: '123456', maxlength: 11, class: 'code-input' });
  const err = h('p', { class: 'error' });
  const form = h('form', {},
    h('label', {}, 'Code aus der Authenticator-App', input),
    h('button', { type: 'submit' }, 'Bestätigen'), err);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const r = await api('POST', '/api/login/2fa', { code: input.value });
      if (r.used_recovery) {
        alert(`Sie haben sich mit einem Wiederherstellungscode angemeldet. Noch ${r.user.recovery_left} Codes übrig.\n\n`
          + 'Bitte richten Sie unter „Sicherheit“ neue Codes ein oder lassen Sie die 2FA von der Einsatzplanung zurücksetzen.');
      }
      await boot();
    } catch (e) {
      err.textContent = e.message;
      input.select();
      if (e.status === 401 && e.code !== 'CODE') setTimeout(renderLogin, 1500);
    }
  });
  authShell(h('h1', {}, 'Zwei-Faktor-Anmeldung'),
    h('p', { class: 'muted' }, 'Öffnen Sie Ihre Authenticator-App und geben Sie den 6-stelligen Code ein.'),
    form,
    h('details', {}, h('summary', { class: 'small' }, 'Kein Zugriff auf das Handy?'),
      h('p', { class: 'small muted' }, 'Geben Sie oben einen Ihrer Wiederherstellungscodes ein (Format xxxxx-xxxxx). ',
        'Jeder Code funktioniert nur einmal. Ohne Codes kann die Einsatzplanung Ihre 2FA zurücksetzen.')),
    h('p', {}, h('button', { class: 'ghost', type: 'button', onclick: cancelLogin }, 'Abbrechen')));
  input.focus();
}

/** Einrichtung des zweiten Faktors – bei der ersten Anmeldung (inApp=false) oder unter „Sicherheit“ */
async function renderSetup(inApp) {
  let data;
  try { data = await api('POST', '/api/2fa/setup'); } catch (e) { if (!inApp) renderLogin(); else toast(e.message, true); return; }
  const input = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', required: true, placeholder: '123456', maxlength: 6, class: 'code-input' });
  const err = h('p', { class: 'error' });
  const form = h('form', {}, h('label', {}, '3. Angezeigten Code eingeben', input), h('button', { type: 'submit' }, 'Aktivieren'), err);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const r = await api('POST', '/api/2fa/enable', { code: input.value });
      showRecoveryCodes(r.recovery_codes, inApp ? () => go('account') : boot);
    } catch (e) { err.textContent = e.message; input.select(); }
  });
  const content = [
    h('h1', {}, 'Zwei-Faktor-Anmeldung einrichten'),
    !inApp ? h('p', { class: 'muted' }, 'Zum Schutz der Dienstplan- und Personaldaten ist ein zweiter Faktor vorgeschrieben. Die Einrichtung dauert etwa eine Minute.') : null,
    h('ol', { class: 'steps' },
      h('li', {}, 'Installieren Sie eine Authenticator-App auf Ihrem Handy, z. B. ', h('strong', {}, 'Microsoft Authenticator'), ', ',
        h('strong', {}, 'Google Authenticator'), ' oder ', h('strong', {}, 'FreeOTP'), '.'),
      h('li', {}, 'Scannen Sie in der App diesen QR-Code:',
        h('div', { class: 'qr' }, h('img', { src: data.qr, alt: 'QR-Code für die Authenticator-App', width: 220, height: 220 })),
        h('details', {}, h('summary', { class: 'small' }, 'QR-Code lässt sich nicht scannen?'),
          h('p', { class: 'small' }, 'Schlüssel manuell eingeben (zeitbasiert, 6 Stellen):'), h('code', { class: 'secret' }, data.secret)))),
    form,
    h('p', {}, h('button', { class: 'ghost', type: 'button', onclick: inApp ? () => go('account') : cancelLogin }, 'Abbrechen')),
  ];
  if (inApp) setMain(h('section', { class: 'card', style: { maxWidth: '480px' } }, content));
  else authShell(content);
  input.focus();
}

function showRecoveryCodes(codes, onDone) {
  const confirmBox = h('input', { type: 'checkbox' });
  const done = h('button', { disabled: true, onclick: onDone }, 'Weiter');
  confirmBox.addEventListener('change', () => { done.disabled = !confirmBox.checked; });
  const text = codes.join('\n');
  const content = [
    h('h1', {}, 'Wiederherstellungscodes'),
    h('p', {}, 'Falls Sie Ihr Handy verlieren, können Sie sich mit einem dieser Codes anmelden. ',
      h('strong', {}, 'Jeder Code gilt nur einmal und wird nur jetzt angezeigt.')),
    h('pre', { class: 'codes' }, text),
    h('div', { class: 'toolbar' },
      h('button', { class: 'ghost', type: 'button', onclick: () => navigator.clipboard.writeText(text).then(() => toast('Kopiert.'), () => toast('Kopieren nicht möglich.', true)) }, 'Kopieren'),
      h('button', { class: 'ghost', type: 'button', onclick: () => window.print() }, 'Drucken')),
    h('label', { class: 'check' }, confirmBox, 'Ich habe die Codes sicher aufbewahrt (nicht auf dem Handy mit der App).'),
    h('p', {}, done),
  ];
  if (state.me) setMain(h('section', { class: 'card', style: { maxWidth: '480px' } }, content));
  else authShell(content);
}

// ---------- Sicherheit: Passwort und 2FA ----------
async function renderAccount() {
  const { user, settings } = await api('GET', '/api/me');
  state.me = user; state.settings = settings;
  const form = h('form', { class: 'card', style: { maxWidth: '480px' } }, h('h2', {}, 'Passwort ändern'),
    h('label', {}, 'Aktuelles Passwort', h('input', { name: 'old_password', type: 'password', required: true, autocomplete: 'current-password' })),
    h('label', {}, 'Neues Passwort (mind. 8 Zeichen)', h('input', { name: 'new_password', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' })),
    h('p', {}, h('button', { type: 'submit' }, 'Ändern')));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try { await api('POST', '/api/me/password', Object.fromEntries(new FormData(form))); toast('Passwort geändert.'); form.reset(); } catch (e) { toast(e.message, true); }
  });

  const askCode = (question) => {
    const c = prompt(`${question}\n\nBitte den aktuellen Code aus der Authenticator-App eingeben:`);
    return c ? c.trim() : null;
  };
  const twofa = h('div', { class: 'card', style: { maxWidth: '480px' } }, h('h2', {}, 'Zwei-Faktor-Anmeldung'),
    user.totp_enabled
      ? [h('p', {}, h('span', { class: 'badge ok' }, 'eingerichtet'), ` · ${user.recovery_left} Wiederherstellungscodes übrig`),
        h('div', { class: 'toolbar' },
          h('button', { class: 'ghost', onclick: async () => {
            const code = askCode('Neue Wiederherstellungscodes erzeugen? Die alten werden ungültig.');
            if (!code) return;
            try { const r = await api('POST', '/api/2fa/recovery-codes', { code }); showRecoveryCodes(r.recovery_codes, () => go('account')); } catch (e) { toast(e.message, true); }
          } }, 'Neue Wiederherstellungscodes'),
          h('button', { class: 'ghost', onclick: () => {
            if (confirm('Neues Handy einrichten? Danach gilt nur noch der neue QR-Code.')) renderSetup(true);
          } }, 'Neues Handy einrichten'),
          !settings.zwei_faktor_pflicht ? h('button', { class: 'danger', onclick: async () => {
            const code = askCode('Zwei-Faktor-Anmeldung deaktivieren?');
            if (!code) return;
            try { await api('POST', '/api/2fa/disable', { code }); toast('Deaktiviert.'); renderAccount(); } catch (e) { toast(e.message, true); }
          } }, 'Deaktivieren') : null)]
      : [h('p', {}, h('span', { class: 'badge warn' }, 'nicht eingerichtet')),
        h('p', {}, h('button', { onclick: () => renderSetup(true) }, 'Jetzt einrichten'))]);
  setMain(form, twofa);
}

boot();
