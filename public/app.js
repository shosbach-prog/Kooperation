'use strict';
/* Personaleinsatzplanung – Oberfläche (ohne Build-Schritt, reines JavaScript) */

const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const WD_ORDER = [1, 2, 3, 4, 5, 6, 0];
const state = { me: null, settings: null, view: null, weekStart: null, unitFilter: '', month: null };

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
    if (res.status === 401 && url !== '/api/login') { state.me = null; renderLogin(); }
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
      await api('POST', '/api/login', { username: fd.get('username'), password: fd.get('password') });
      await boot();
    } catch (e) { document.getElementById('login-error').textContent = e.message; }
  });
}

// ---------- Navigation ----------
const VIEWS = {
  plan: { label: 'Dienstplan', render: renderPlan },
  mine: { label: 'Meine Dienste', render: renderMine, staff: true },
  konto: { label: 'Stundenkonto', render: renderKonto, staff: true },
  generate: { label: 'Plan erzeugen', render: renderGenerate, mgr: true },
  staff: { label: 'Mitarbeitende', render: renderStaff, mgr: true },
  types: { label: 'Dienstzeiten', render: renderShiftTypes, mgr: true },
  req: { label: 'Mindestbesetzung', render: renderRequirements, mgr: true },
  report: { label: 'Auswertung TVöD', render: renderReport, mgr: true },
  settings: { label: 'Einstellungen', render: renderSettings, mgr: true },
  account: { label: 'Passwort', render: renderAccount },
};

function renderTabs() {
  const nav = document.getElementById('tabs');
  nav.replaceChildren(...Object.entries(VIEWS)
    .filter(([, v]) => (v.mgr ? isMgr() : v.staff ? !isMgr() : true))
    .map(([key, v]) => h('button', { class: state.view === key ? 'active' : '', onclick: () => go(key) }, v.label)));
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
  } catch { renderLogin(); return; }
  document.getElementById('topbar').hidden = false;
  document.getElementById('clinic-name').textContent = state.settings.klinik_name;
  document.title = `Personaleinsatzplanung – ${state.settings.klinik_name}`;
  document.getElementById('who').textContent = `${state.me.name} (${isMgr() ? 'Einsatzplanung' : 'Mitarbeiter/in'})`;
  state.weekStart = state.weekStart || mondayOf(todayIso());
  state.month = state.month || todayIso().slice(0, 7);
  const fromHash = location.hash.slice(1);
  const allowed = (k) => VIEWS[k] && !(VIEWS[k].mgr && !isMgr()) && !(VIEWS[k].staff && isMgr());
  go(allowed(fromHash) ? fromHash : 'plan');
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
    return h('th', { class: `day${wd === 0 || wd === 6 ? ' weekend' : ''}${hol ? ' holiday' : ''}`, title: hol || '' },
      `${WD[wd]} ${fmtDate(d).slice(0, 6)}`, hol ? h('div', { class: 'small' }, hol) : null);
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

function renderCell(s, staffUsers) {
  if (!s) return h('div', { class: 'cell none' }, '–');
  const n = s.assigned.length;
  const full = s.max_staff !== null && n >= s.max_staff;
  const cls = n < s.min_staff ? 'bad' : full ? 'full' : 'ok';
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
        h('option', { value: '' }, '+ Person eintragen'), free.map((u) => h('option', { value: u.id }, `${u.name}${u.qualification ? ' – ' + u.qualification : ''}`)));
    }
  } else if (mine) {
    action = h('button', { class: 'tiny ghost', onclick: () => unassign(s, state.me.id) }, 'Austragen');
  } else if (!full) {
    action = h('button', { class: 'tiny', onclick: () => assign(s) }, 'Eintragen');
  }
  return h('div', { class: `cell ${cls}` }, count, list, s.note ? h('div', { class: 'note' }, s.note) : null, action);
}

async function assign(s, userId, force = false) {
  try {
    await api('POST', `/api/shifts/${s.id}/assign`, userId ? { user_id: userId, force } : {});
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
  if (!confirm(`${who} ${s.type_name} am ${fmtDate(s.date)} (${s.unit_name}) austragen?`)) return;
  try {
    await api('DELETE', `/api/shifts/${s.id}/assign${isMgr() ? `?user_id=${userId}` : ''}`);
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

function refresh() { VIEWS[state.view].render(); }

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
      h('div', { class: 'card' }, h('div', { class: 'muted' }, 'Geplante Stunden (Ist)'), h('div', { class: 'stat' }, fmtNum(x.ist)),
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
    ['soll', 'Soll', true], ['ist', 'Ist', true], ['saldo', 'Saldo', true],
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
        withName ? h('td', {}, r.min_erfuellt ? h('span', { class: 'badge ok' }, 'erfüllt') : h('span', { class: 'badge bad' }, 'nicht erfüllt')) : null)))),
    h('p', { class: 'small muted' }, 'Stundenangaben in Std. (bezahlte Zeit nach Abzug der Pause). Zuschläge € nur, wenn ein Stundenentgelt hinterlegt ist. ',
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
      h('thead', {}, h('tr', {}, ['Datum', 'Bereich', 'Dienst', 'Besetzt', 'Minimum'].map((x) => h('th', {}, x)))),
      h('tbody', {}, r.understaffed.map((x) => h('tr', {},
        h('td', {}, h('a', { href: '#plan', onclick: (e) => { e.preventDefault(); state.weekStart = mondayOf(x.date); go('plan'); } }, `${WD[weekday(x.date)]} ${fmtDate(x.date)}`)),
        h('td', {}, x.unit_name), h('td', {}, x.code), h('td', {}, x.besetzt), h('td', {}, x.min_staff))))))
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
        h('thead', {}, h('tr', {}, ['Name', 'Benutzer', 'Rolle', 'Qualifikation', 'Wochenstd.', 'Mindest-Std./Monat', 'Stundenentgelt €', 'Status', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, users.map((u) => h('tr', { class: u.active ? '' : 'inactive' },
          h('td', {}, u.name), h('td', {}, u.username), h('td', {}, u.role === 'manager' ? 'Einsatzplanung' : 'Mitarbeiter/in'),
          h('td', {}, u.qualification), h('td', { class: 'num' }, fmtNum(u.weekly_hours)), h('td', { class: 'num' }, fmtNum(u.min_hours_month, 1)),
          h('td', { class: 'num' }, fmtNum(u.stundenentgelt)), h('td', {}, u.active ? 'aktiv' : 'inaktiv'),
          h('td', {}, h('button', { class: 'tiny ghost', onclick: () => main().querySelector('#staff-form').replaceWith(staffForm(u)) }, 'Bearbeiten')))))))),
    form);
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
      f('qualification', 'Qualifikation', { value: u?.qualification || '', list: 'quals', placeholder: 'z. B. Pflegefachkraft' }),
      f('weekly_hours', 'Wochenstunden', { type: 'number', step: '0.25', min: 0, value: u?.weekly_hours ?? state.settings.wochenstunden_standard }),
      f('min_hours_month', 'Mindestverfügbarkeit (Std./Monat)', { type: 'number', step: '0.5', min: 0, value: u?.min_hours_month ?? 0 }),
      f('stundenentgelt', 'Stundenentgelt € (für Zuschläge)', { type: 'number', step: '0.01', min: 0, value: u?.stundenentgelt ?? 0 }),
      u ? h('label', {}, 'Status', h('select', { name: 'active' }, h('option', { value: '1', selected: u.active }, 'aktiv'), h('option', { value: '0', selected: !u.active }, 'inaktiv'))) : null),
    h('datalist', { id: 'quals' }, ['Pflegefachkraft', 'Pflegehilfskraft', 'Auszubildende/r', 'Stationsleitung', 'Arzt/Ärztin', 'MFA'].map((q) => h('option', { value: q }))),
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
    }, 'Speichern'))), cards);
}

// ---------- Einstellungen (Manager) ----------
async function renderSettings() {
  const s = await api('GET', '/api/settings');
  const fields = [
    ['klinik_name', 'Name der Einrichtung', 'text'],
    ['wochenstunden_standard', 'Regelmäßige Wochenarbeitszeit (Std.)', 'number', 'TVöD-K: 38,5 Std.'],
    ['austrag_frist_std', 'Austragen möglich bis … Std. vor Dienstbeginn', 'number'],
    ['austrag_unter_minimum', 'Austragen auch unter Mindestbesetzung erlauben', 'checkbox'],
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
      const el = h('input', type === 'checkbox' ? { type, checked: !!s[k] } : { type, value: s[k], step: type === 'number' ? 'any' : undefined, style: type === 'text' ? { width: '100%' } : undefined });
      els[k] = el;
      return h('label', {}, label, el, hint ? h('span', { class: 'small muted' }, hint) : null);
    })),
    h('p', { class: 'small muted' }, 'Hinweis: Die Prozentsätze sind Vorgabewerte und müssen mit dem aktuell gültigen Tarifvertrag bzw. den Haustarif-Regelungen abgeglichen werden.'),
    h('button', { type: 'submit' }, 'Speichern'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = Object.fromEntries(Object.entries(els).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));
    try {
      state.settings = await api('PUT', '/api/settings', body);
      document.getElementById('clinic-name').textContent = state.settings.klinik_name;
      toast('Einstellungen gespeichert.');
    } catch (e) { toast(e.message, true); }
  });
  setMain(form);
}

// ---------- Passwort ----------
function renderAccount() {
  const form = h('form', { class: 'card', style: { maxWidth: '420px' } }, h('h2', {}, 'Passwort ändern'),
    h('label', {}, 'Aktuelles Passwort', h('input', { name: 'old_password', type: 'password', required: true, autocomplete: 'current-password' })),
    h('label', {}, 'Neues Passwort (mind. 8 Zeichen)', h('input', { name: 'new_password', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' })),
    h('p', {}, h('button', { type: 'submit' }, 'Ändern')));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try { await api('POST', '/api/me/password', Object.fromEntries(new FormData(form))); toast('Passwort geändert.'); form.reset(); } catch (e) { toast(e.message, true); }
  });
  setMain(form);
}

boot();
