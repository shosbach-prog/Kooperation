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
    const authUrl = url.startsWith('api/login') || url.startsWith('api/2fa') || url === 'api/me';
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
const isMgr = () => !!(state.me && state.me.is_manager);
const isStaffRole = () => !!(state.me && state.me.role === 'staff');
const main = () => document.getElementById('main');

function setMain(...nodes) {
  main().replaceChildren(...nodes.flat(Infinity).filter(Boolean));
  stackTables(main());
}

/** Tabellen: Spaltenüberschrift je Zelle hinterlegen und – wo nötig – als Karten darstellen */
function stackTables(root) {
  for (const table of root.querySelectorAll('table:not(.plan)')) {
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent);
    table.classList.add('stack');
    for (const tr of table.querySelectorAll('tbody tr')) {
      [...tr.children].forEach((td, i) => { if (heads[i]) td.dataset.label = heads[i]; });
    }
  }
  requestAnimationFrame(() => fitTables(root));
}

/** Entscheidet je Tabelle: normale Tabelle oder Karten (abhängig von Bildschirm- und Tabellenbreite) */
function fitTables(root = main()) {
  const W = window.innerWidth;
  for (const table of root.querySelectorAll('table.stack')) {
    const rows = table.tBodies[0]?.rows.length || 0;
    const single = rows === 1 && (table.tHead?.rows[0]?.cells.length || 0) > 6 && !table.classList.contains('keep-table');
    table.classList.remove('as-cards', 'single');
    if (table.classList.contains('keep-table') && W >= 760) continue;
    const wrap = table.parentElement;
    const tooWide = table.scrollWidth > (wrap?.clientWidth || W) + 4;
    if (W < 760 || single || (W < 1100 && tooWide)) table.classList.add('as-cards');
    if (single && W >= 760) table.classList.add('single');
  }
}
let fitTimer;
window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(() => fitTables(), 150); });

// ---------- Erscheinungsbild der Einrichtung ----------
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
async function loadBranding() {
  try { state.branding = await api('GET', 'api/branding'); } catch { state.branding = state.branding || null; }
  applyBranding();
}
function logoImg(cls) {
  const b = state.branding;
  return b && b.logo ? h('img', { src: `api/branding/logo?v=${b.logo_version}`, alt: `Logo ${b.klinik_name}`, class: cls }) : null;
}
function applyBranding() {
  const b = state.branding;
  if (!b) return;
  document.title = `${b.untertitel} – ${b.klinik_name}`;
  document.getElementById('clinic-name').textContent = b.klinik_name;
  document.getElementById('brand-sub').textContent = b.untertitel;
  document.getElementById('brand-mark').replaceChildren(logoImg('brand-logo') || h('span', { class: 'logo' }, '⊕'));
  if (darkQuery.matches) document.documentElement.style.removeProperty('--primary');
  else document.documentElement.style.setProperty('--primary', b.akzentfarbe);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', b.akzentfarbe);
  const login = main().querySelector('.login-brand');
  if (login) fillLoginBrand(login);
}
darkQuery.addEventListener('change', applyBranding);
function fillLoginBrand(el) {
  const b = state.branding || { klinik_name: '', untertitel: 'Personaleinsatzplanung' };
  el.querySelector('[data-clinic]').textContent = b.klinik_name;
  el.querySelector('[data-sub]').textContent = b.untertitel;
  el.querySelector('[data-logo]').replaceChildren(logoImg('login-logo-img') || h('span', { class: 'login-logo-icon' }, '⊕'));
}

// ---------- Anmeldung ----------
function hideAppChrome() {
  document.getElementById('topbar').hidden = true;
  document.getElementById('bottomnav').hidden = true;
  document.body.classList.remove('app', 'nav-open');
}

function renderLogin() {
  hideAppChrome();
  const node = document.getElementById('login-tpl').content.cloneNode(true);
  setMain(node);
  fillLoginBrand(main().querySelector('.login-brand'));
  const form = document.getElementById('login-form');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    try {
      const r = await api('POST', 'api/login', { username: fd.get('username'), password: fd.get('password') });
      if (r.stage === '2fa') renderCodeStep();
      else if (r.stage === 'setup') renderSetup(false);
      else await boot();
    } catch (e) { document.getElementById('login-error').textContent = e.message; }
  });
}

// ---------- Navigation ----------
// ---------- Symbole (einfache Linien-Icons) ----------
const ICON_PATHS = {
  plan: '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
  mine: '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4M8.5 15l2.3 2.3 4.7-4.6"/>',
  urlaub: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>',
  konto: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  inbox: '<path d="M3 13l2.5-8h13L21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 13h5l1.5 2.5h5L16 13h5"/>',
  wand: '<path d="M4 20l11-11M14 4l1 2.5L17.5 7.5 15 8.5 14 11l-1-2.5L10.5 7.5 13 6.5zM19 13l.6 1.4 1.4.6-1.4.6L19 17l-.6-1.4-1.4-.6 1.4-.6z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.6"/><path d="M16.5 14.6c2.6.2 4.5 1.9 5 4.9"/>',
  campus: '<path d="M3 21h18M5 21V8l7-4 7 4v13"/><path d="M9.5 21v-5h5v5M9 10.5h1.5M13.5 10.5H15"/>',
  clock: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2.5h6"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  log: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4.2 4-6.5 8-6.5s7.2 2.3 8 6.5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  logout: '<path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M15 17l5-5-5-5M20 12H9"/>',
};
function icon(name) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name] || ''}</svg>`;
  return span;
}

// ---------- Navigation ----------
const VIEWS = {
  plan: { label: 'Dienstplan', icon: 'plan', group: 'mein', render: renderPlan },
  mine: { label: 'Meine Dienste', short: 'Meine', icon: 'mine', group: 'mein', render: renderMine, staff: true },
  abwesenheit: { label: 'Urlaub & Krank', short: 'Urlaub', icon: 'urlaub', group: 'mein', render: renderMyAbsences, staff: true },
  konto: { label: 'Stundenkonto', short: 'Stunden', icon: 'konto', group: 'mein', render: renderKonto, staff: true },
  account: { label: 'Mein Profil', short: 'Profil', icon: 'user', group: 'mein', render: renderAccount },
  abwesenheiten: { label: 'Abwesenheiten', short: 'Anträge', icon: 'inbox', group: 'verw', render: renderAbsencesMgr, mgr: true, badge: 'abwesenheiten' },
  staff: { label: 'Personal', icon: 'users', group: 'verw', render: renderStaff, mgr: true },
  stationen: { label: 'Campus & Stationen', short: 'Campus', icon: 'campus', group: 'verw', render: renderStations, mgr: true },
  generate: { label: 'Plan erzeugen', icon: 'wand', group: 'verw', render: renderGenerate, mgr: true },
  types: { label: 'Dienstzeiten', icon: 'clock', group: 'verw', render: renderShiftTypes, mgr: true },
  req: { label: 'Mindestbesetzung', icon: 'sliders', group: 'verw', render: renderRequirements, mgr: true },
  report: { label: 'Auswertung TVöD', short: 'Auswertung', icon: 'chart', group: 'verw', render: renderReport, mgr: true },
  log: { label: 'Protokoll', icon: 'log', group: 'verw', render: renderLog, mgr: true },
  settings: { label: 'Einstellungen', icon: 'settings', group: 'verw', render: renderSettings, mgr: true },
};
const GROUPS = { mein: 'Mein Dienst', verw: 'Verwaltung' };
const viewAllowed = (v) => (v.mgr ? isMgr() : v.staff ? isStaffRole() : true);

/** Schnellzugriff unten (Handy/Tablet), je nach Rolle */
function bottomKeys() {
  if (isMgr() && !isStaffRole()) return ['plan', 'abwesenheiten', 'staff'];
  if (isMgr()) return ['plan', 'mine', 'abwesenheiten'];
  return ['plan', 'mine', 'abwesenheit'];
}

function setNavOpen(open) { document.body.classList.toggle('nav-open', open); }

function renderTabs() {
  const badge = (v) => (v.badge && state.badges[v.badge] ? h('span', { class: 'tab-badge', title: 'offen' }, state.badges[v.badge]) : null);
  const groups = Object.entries(GROUPS).map(([g, title]) => {
    const items = Object.entries(VIEWS).filter(([, v]) => v.group === g && viewAllowed(v));
    if (!items.length) return null;
    return h('div', { class: 'nav-group' },
      Object.keys(GROUPS).length > 1 ? h('div', { class: 'nav-group-title' }, title) : null,
      items.map(([key, v]) => h('button', {
        class: `nav-item${state.view === key ? ' active' : ''}`, 'aria-current': state.view === key ? 'page' : null,
        onclick: () => { setNavOpen(false); go(key); },
      }, icon(v.icon), h('span', { class: 'label' }, v.label), badge(v))));
  });
  document.getElementById('tabs').replaceChildren(...groups.filter(Boolean));

  const keys = bottomKeys().filter((k) => VIEWS[k] && viewAllowed(VIEWS[k]));
  const inBottom = keys.includes(state.view);
  const anyBadge = Object.entries(VIEWS).some(([k, v]) => !keys.includes(k) && v.badge && state.badges[v.badge] && viewAllowed(v));
  document.getElementById('bottomnav').replaceChildren(
    ...keys.map((k) => h('button', { class: state.view === k ? 'active' : '', onclick: () => { setNavOpen(false); go(k); } },
      icon(VIEWS[k].icon), h('span', { class: 'bn-label' }, VIEWS[k].short || VIEWS[k].label), badge(VIEWS[k]))),
    h('button', { class: !inBottom ? 'active' : '', 'aria-expanded': String(document.body.classList.contains('nav-open')),
      onclick: () => setNavOpen(!document.body.classList.contains('nav-open')) },
    icon('menu'), h('span', { class: 'bn-label' }, inBottom ? 'Menü' : (VIEWS[state.view]?.short || VIEWS[state.view]?.label || 'Menü')),
    anyBadge && !keys.some((k) => VIEWS[k].badge) ? h('span', { class: 'tab-badge' }, '!') : null));
}
document.getElementById('nav-backdrop').addEventListener('click', () => setNavOpen(false));
// Zurück-/Vor-Taste des Browsers (und Zurück-Geste auf dem Handy) wechselt zwischen den Ansichten
window.addEventListener('hashchange', () => {
  const key = location.hash.slice(1);
  if (!state.me || key === state.view) return;
  if (document.querySelector('dialog[open]')) return;
  if (VIEWS[key] && viewAllowed(VIEWS[key])) { setNavOpen(false); go(key); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setNavOpen(false); });

/** Zähler für offene Urlaubsanträge und fehlende AU-Bescheinigungen (Manager) */
async function refreshBadges() {
  if (!isMgr()) return;
  try {
    const r = await api('GET', 'api/absences');
    state.badges.abwesenheiten = r.absences.filter((a) => a.status === 'beantragt' || a.au_ueberfaellig).length;
  } catch { /* ignorieren */ }
  renderTabs();
}

async function go(view) {
  state.view = view;
  location.hash = view;
  renderTabs();
  window.scrollTo({ top: 0 });
  setMain(h('p', { class: 'muted' }, 'Lädt …'));
  try { await VIEWS[view].render(); } catch (e) { if (e.status !== 401) setMain(h('p', { class: 'error' }, e.message)); }
}

async function boot() {
  try {
    const { user, settings } = await api('GET', 'api/me');
    state.me = user; state.settings = settings;
  } catch (e) {
    if (e.code === 'STAGE_2FA') renderCodeStep();
    else if (e.code === 'STAGE_SETUP') renderSetup(false);
    else renderLogin();
    return;
  }
  document.getElementById('topbar').hidden = false;
  document.getElementById('bottomnav').hidden = false;
  document.body.classList.add('app');
  applyBranding();
  renderWho();
  state.weekStart = state.weekStart || mondayOf(todayIso());
  state.month = state.month || todayIso().slice(0, 7);
  const fromHash = location.hash.slice(1);
  const allowed = (k) => VIEWS[k] && !(VIEWS[k].mgr && !isMgr()) && !(VIEWS[k].staff && !isStaffRole());
  go(allowed(fromHash) ? fromHash : 'plan');
  refreshBadges();
}

document.getElementById('logout').replaceChildren(icon('logout'), h('span', { class: 'label' }, 'Abmelden'));
document.getElementById('logout').setAttribute('aria-label', 'Abmelden');
document.getElementById('logout').addEventListener('click', async () => {
  await api('POST', 'api/logout').catch(() => {});
  state.me = null; location.hash = ''; renderLogin();
});

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
    h('span', { class: 'l-bad' }, 'unter Mindestbesetzung'), h('span', { class: 'l-ok' }, 'Mindestbesetzung erreicht'), h('span', { class: 'l-full' }, 'voll besetzt'));

  const thead = h('tr', {}, h('th', {}, 'Dienst'), days.map((d) => {
    const wd = weekday(d); const hol = plan.holidays[d];
    const abs = absentOn(d);
    const mineAbs = abs.find((a) => a.user_id === state.me.id);
    return h('th', { class: `day${wd === 0 || wd === 6 ? ' weekend' : ''}${hol ? ' holiday' : ''}${d === today ? ' today' : ''}`, title: hol || '' },
      `${WD[wd]} ${fmtDate(d).slice(0, 6)}`, hol ? h('div', { class: 'small' }, hol) : null,
      isMgr() && abs.length ? h('div', { class: 'small absent-info', title: abs.map((a) => `${a.name}: ${absLabel(a)}`).join('\n') }, `${abs.length} abwesend`) : null,
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
    const gap = plan.shifts.some((s) => s.date === d && (s.assigned.length < s.min_staff || s.qual_missing.length));
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
    return cards.length ? h('section', {}, h('h3', {}, unit.name, unit.building_name ? h('span', { class: 'muted' }, unit.building_name) : null), cards) : null;
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
  const t = a.type === 'sonderurlaub' ? 'Sonderurlaub' : 'Urlaub';
  return a.status === 'beantragt' ? `${t} beantragt` : t;
}

function renderCell(s, staffUsers) {
  if (!s) return h('div', { class: 'cell none' }, '–');
  const n = s.assigned.length;
  const full = s.max_staff !== null && n >= s.max_staff;
  const cls = n < s.min_staff || s.qual_missing.length ? 'bad' : full ? 'full' : 'ok';
  const absentIds = new Map(absentOn(s.date).map((a) => [a.user_id, a]));
  const mine = s.assigned.some((a) => a.user_id === state.me.id);

  const list = h('ul', {}, s.assigned.map((a) => h('li', { class: a.user_id === state.me.id ? 'me' : '', title: a.qualification },
    h('span', { class: 'person' }, avatar(a, 20), a.name),
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

// ---------- Dialoge (ersetzen prompt/confirm/alert; auf dem Handy als Einblendung von unten) ----------
function openDialog(build) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'ui-dialog' });
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(null); }); // Klick neben das Fenster
    dlg.append(build(close));
    document.body.append(dlg);
    dlg.showModal();
    const first = dlg.querySelector('input, textarea, select');
    if (first && !isPhone()) first.focus();
    else if (first && first.type !== 'date') setTimeout(() => first.focus(), 50);
  });
}

function dialogShell(title, message, body, buttons) {
  return h('form', { method: 'dialog', class: 'ui-dialog-body', novalidate: true },
    title ? h('h2', {}, title) : null,
    message ? h('p', { class: 'ui-dialog-msg' }, message) : null,
    body,
    h('div', { class: 'ui-dialog-actions' }, buttons));
}

function uiConfirm(message, { title = 'Bitte bestätigen', okText = 'OK', cancelText = 'Abbrechen', danger = false } = {}) {
  return openDialog((close) => dialogShell(title, message, null, [
    h('button', { type: 'button', class: 'ghost', onclick: () => close(false) }, cancelText),
    h('button', { type: 'button', class: danger ? 'danger-solid' : '', onclick: () => close(true) }, okText),
  ])).then((v) => v === true);
}

function uiAlert(message, { title = 'Hinweis', okText = 'Verstanden' } = {}) {
  return openDialog((close) => dialogShell(title, message, null, [
    h('button', { type: 'button', onclick: () => close(true) }, okText),
  ]));
}

/** Formular-Dialog; fields: [{ name, label, type, value, placeholder, required, minLength, min, max, step, inputmode, rows, hint }] */
function uiForm({ title, message, fields, okText = 'Speichern', cancelText = 'Abbrechen' }) {
  return openDialog((close) => {
    const inputs = {};
    const err = h('p', { class: 'error' });
    const rows = fields.map((f) => {
      const attrs = {
        name: f.name, value: f.value ?? '', placeholder: f.placeholder, required: !!f.required, min: f.min, max: f.max,
        step: f.step, inputmode: f.inputmode, autocomplete: f.autocomplete || 'off', maxlength: f.maxlength,
      };
      const el = f.type === 'textarea' ? h('textarea', { ...attrs, rows: f.rows || 3 })
        : f.type === 'select' ? h('select', { name: f.name }, (f.options || []).map(([v, l]) => h('option', { value: v, selected: String(v) === String(f.value ?? '') }, l)))
          : h('input', { ...attrs, type: f.type || 'text' });
      inputs[f.name] = el;
      return h('label', {}, f.label, el, f.hint ? h('span', { class: 'small muted' }, f.hint) : null);
    });
    const submit = () => {
      for (const f of fields) {
        const v = inputs[f.name].value.trim();
        if (f.required && !v) { err.textContent = `Bitte „${f.label}“ ausfüllen.`; inputs[f.name].focus(); return; }
        if (f.minLength && v && v.length < f.minLength) {
          err.textContent = `„${f.label}“: bitte mindestens ${f.minLength} Zeichen.`; inputs[f.name].focus(); return;
        }
      }
      close(Object.fromEntries(fields.map((f) => [f.name, inputs[f.name].value.trim()])));
    };
    const form = dialogShell(title, message, h('div', { class: 'ui-dialog-fields' }, rows, err), [
      h('button', { type: 'button', class: 'ghost', onclick: () => close(null) }, cancelText),
      h('button', { type: 'submit' }, okText),
    ]);
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    return form;
  });
}

/** Ein Eingabefeld; liefert den Text oder null bei Abbruch */
async function uiPrompt({ title, message, label, value = '', type = 'text', required = false, minLength, placeholder, multiline = false, inputmode, okText = 'OK', hint, autocomplete }) {
  const r = await uiForm({
    title, message, okText,
    fields: [{ name: 'v', label: label || '', value, type: multiline ? 'textarea' : type, required, minLength, placeholder, inputmode, hint, autocomplete }],
  });
  return r ? r.v : null;
}

/** Fragt eine Begründung ab; null = abgebrochen */
function askReason(text, required, { title = 'Begründung', okText = 'Bestätigen' } = {}) {
  return uiPrompt({
    title, message: text, label: required ? 'Begründung' : 'Begründung (optional)', required, minLength: required ? 3 : undefined,
    multiline: true, placeholder: 'z. B. Arzttermin, Tausch mit Kollegin …', okText,
  });
}

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
    if (isMgr() && !force && (e.code === 'RUHEZEIT' || e.code === 'VOLL')
      && await uiConfirm(`${e.message} Trotzdem eintragen (Ausnahme durch die Einsatzplanung)?`, { title: 'Ausnahme', okText: 'Trotzdem eintragen' })) {
      return assign(s, userId, true);
    }
    toast(e.message, true);
  }
  refresh();
}

async function unassign(s, userId, name) {
  const who = name ? `${name} aus` : 'Sich aus';
  const required = !isMgr() && !!state.settings.begruendung_austragen;
  const reason = await askReason(`${who} ${s.type_name} am ${fmtDate(s.date)} (${s.unit_name}) austragen?`, required, { title: 'Austragen', okText: 'Austragen' });
  if (reason === null) return;
  try {
    await api('DELETE', `api/shifts/${s.id}/assign${isMgr() ? `?user_id=${userId}` : ''}`, { reason });
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

function refresh() { VIEWS[state.view].render(); refreshBadges(); }

// ---------- Meine Dienste (Mitarbeitende) ----------
async function renderMine() {
  const from = todayIso();
  const shifts = await api('GET', `api/my-shifts?from=${from}&to=${addDays(from, 120)}`);
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
  const r = await api('GET', `api/report?month=${state.month}&user_id=${state.me.id}`);
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
    ['soll', 'Soll', true], ['gearbeitet', 'Gearbeitet', true], ['urlaub_std', 'Urlaub', true], ['sonder_std', 'Sonderurlaub', true], ['krank_std', 'Krank', true],
    ['ist', 'Ist gesamt', true], ['saldo', 'Saldo', true],
    ...(withName ? [['min_hours_month', 'Mindest-Std.', true]] : []),
    ['dienste', 'Dienste', true, 0], ['nachtschichten', 'Nachtschichten', true, 0],
    ['nacht', 'Nacht', true], ['samstag', 'Samstag', true], ['sonntag', 'Sonntag', true], ['feiertag', 'Feiertag', true], ['vorfest', '24./31.12.', true],
    ['zuschlag_eur', 'Zuschläge €', true],
  ];
  return h('div', { class: 'table-wrap' }, h('h3', {}, 'Stunden und Zeitzuschläge'),
    h('table', { class: withName ? 'sticky-first' : '' },
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
  const r = await api('GET', `api/report?month=${state.month}`);
  setMain(h('div', { class: 'card' },
    h('div', { class: 'toolbar' },
      h('label', {}, 'Monat', h('input', { type: 'month', value: state.month, onchange: (e) => { state.month = e.target.value; renderReport(); } })),
      h('span', { class: 'spacer' }),
      h('a', { href: `api/report.csv?month=${state.month}` }, h('button', { class: 'ghost' }, 'CSV-Export (Excel)'))),
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
  const units = (await api('GET', 'api/units')).filter((u) => u.active);
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
          const r = await api('POST', 'api/shifts/generate', { from: fromI.value, to: toI.value, unit_ids: ids });
          toast(`${r.created} Schichten angelegt.`);
          state.weekStart = mondayOf(fromI.value);
        } catch (e) { toast(e.message, true); }
      },
    }, 'Schichten erzeugen'))));
}

// ---------- Profilfotos ----------
/** Rundes Foto oder Initialen */
function avatar(u, size = 32) {
  const initials = String(u?.name || '?').split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const id = u?.id ?? u?.user_id;
  const style = { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.4)}px` };
  if (u && u.foto_version) {
    return h('img', { class: 'avatar', src: `api/users/${id}/foto?v=${u.foto_version}`, alt: '', loading: 'lazy', style });
  }
  return h('span', { class: 'avatar avatar-initials', 'aria-hidden': 'true', style }, initials);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('Das Bild konnte nicht gelesen werden. Bitte JPG oder PNG verwenden.'));
    i.src = src;
  });
}

/**
 * Zuschnitt-Dialog: Bild verschieben und vergrößern, bis nur der Kopf im Kreis ist.
 * Bedienung: ziehen (Finger/Maus), zwei Finger oder Mausrad zum Zoomen, Regler, Pfeiltasten.
 * Ergebnis: quadratisches JPEG (max. 512 px) ohne Metadaten, oder null bei Abbruch.
 */
async function cropImage(src, { out = 512 } = {}) {
  const img = await loadImage(src);
  const W = img.naturalWidth, H = img.naturalHeight;
  return openDialog((close) => {
    const S = Math.round(Math.min(320, window.innerWidth - 56)); // Größe der Bühne in CSS-Pixeln
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const canvas = h('canvas', { width: Math.round(S * dpr), height: Math.round(S * dpr), style: { width: `${S}px`, height: `${S}px` } });
    const ctx = canvas.getContext('2d');
    const base = Math.max(S / W, S / H); // Bild füllt die Bühne mindestens aus
    let zoom = 1;
    let x = 0, y = 0; // Verschiebung der Bildmitte gegenüber der Bühnenmitte (CSS-Pixel)
    const MAX = 5;

    const clamp = () => {
      const sc = base * zoom;
      const mx = Math.max(0, (W * sc - S) / 2), my = Math.max(0, (H * sc - S) / 2);
      x = Math.min(mx, Math.max(-mx, x));
      y = Math.min(my, Math.max(-my, y));
    };
    const draw = () => {
      clamp();
      const sc = base * zoom * dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (S * dpr) / 2 + x * dpr - (W * sc) / 2, (S * dpr) / 2 + y * dpr - (H * sc) / 2, W * sc, H * sc);
      slider.value = String(zoom);
    };
    /** Zoomen um einen Punkt (px, py relativ zur Bühnenmitte), damit dieser Punkt stehen bleibt */
    const zoomTo = (z, px = 0, py = 0) => {
      const nz = Math.min(MAX, Math.max(1, z));
      const f = nz / zoom;
      x = px - (px - x) * f;
      y = py - (py - y) * f;
      zoom = nz;
      draw();
    };

    const slider = h('input', { type: 'range', min: 1, max: MAX, step: 0.01, value: 1, 'aria-label': 'Vergrößerung', class: 'crop-zoom',
      oninput: (e) => zoomTo(Number(e.target.value)) });
    const stage = h('div', { class: 'crop-stage', tabindex: 0, 'aria-label': 'Bildausschnitt – mit Pfeiltasten verschieben, + und − zum Zoomen',
      style: { width: `${S}px`, height: `${S}px` } }, canvas, h('div', { class: 'crop-mask' }), h('div', { class: 'crop-guide' }));

    // Ziehen und Zwei-Finger-Zoom
    const pointers = new Map();
    let pinch = null;
    const rel = (e) => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left - S / 2, e.clientY - r.top - S / 2]; };
    stage.addEventListener('pointerdown', (e) => {
      stage.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, rel(e));
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: zoom };
      }
    });
    stage.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      const cur = rel(e);
      pointers.set(e.pointerId, cur);
      if (pointers.size === 1) {
        x += cur[0] - prev[0];
        y += cur[1] - prev[1];
        draw();
      } else if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        zoomTo(pinch.z * (d / pinch.d), (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      }
    });
    const end = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    stage.addEventListener('wheel', (e) => { e.preventDefault(); const [px, py] = rel(e); zoomTo(zoom * Math.exp(-e.deltaY / 400), px, py); }, { passive: false });
    stage.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 20 : 6;
      if (e.key === 'ArrowLeft') x -= step; else if (e.key === 'ArrowRight') x += step;
      else if (e.key === 'ArrowUp') y -= step; else if (e.key === 'ArrowDown') y += step;
      else if (e.key === '+' || e.key === '=') return zoomTo(zoom * 1.1);
      else if (e.key === '-') return zoomTo(zoom / 1.1);
      else return;
      e.preventDefault();
      draw();
    });

    const save = () => {
      // so viele Original-Pixel liegen im Ausschnitt; nicht künstlich hochrechnen
      const n = Math.max(128, Math.min(out, Math.round(S / (base * zoom))));
      const o = document.createElement('canvas');
      o.width = n; o.height = n;
      const c = o.getContext('2d');
      const k = n / S; // Bühne → Ausgabe
      const sc = base * zoom * k;
      c.imageSmoothingQuality = 'high';
      c.drawImage(img, n / 2 + x * k - (W * sc) / 2, n / 2 + y * k - (H * sc) / 2, W * sc, H * sc);
      o.toBlob((b) => close(b), 'image/jpeg', 0.88);
    };

    draw();
    setTimeout(() => stage.focus(), 60);
    return h('div', { class: 'ui-dialog-body crop-dialog' },
      h('h2', {}, 'Ausschnitt wählen'),
      h('p', { class: 'ui-dialog-msg' }, 'Bild verschieben und vergrößern, bis Ihr Kopf im Kreis ist.'),
      stage,
      h('div', { class: 'crop-controls' },
        h('button', { type: 'button', class: 'ghost', 'aria-label': 'Verkleinern', onclick: () => zoomTo(zoom / 1.2) }, '−'),
        slider,
        h('button', { type: 'button', class: 'ghost', 'aria-label': 'Vergrößern', onclick: () => zoomTo(zoom * 1.2) }, '+')),
      h('div', { class: 'ui-dialog-actions' },
        h('button', { type: 'button', class: 'ghost', onclick: () => close(null) }, 'Abbrechen'),
        h('button', { type: 'button', class: 'ghost', onclick: () => { zoom = 1; x = 0; y = 0; draw(); } }, 'Zurücksetzen'),
        h('button', { type: 'button', onclick: save }, 'Übernehmen')));
  });
}

async function uploadFoto(url, blob, onDone) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  toast('Foto gespeichert.');
  onDone(data);
}

/** Foto-Bereich mit Hochladen, Zuschneiden, Entfernen; url = 'api/me/foto' oder 'api/users/<id>/foto' */
function fotoControl(u, url, onDone) {
  const input = h('input', { type: 'file', accept: 'image/*', hidden: true });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    const src = URL.createObjectURL(file);
    try {
      const blob = await cropImage(src);
      if (blob) await uploadFoto(url, blob, onDone);
    } catch (e) { toast(e.message, true); } finally { URL.revokeObjectURL(src); }
  });
  const fotoSrc = u.foto_version ? `api/users/${u.id}/foto?v=${u.foto_version}` : null;
  return h('div', { class: 'foto-control' }, avatar(u, 96),
    h('div', {}, input,
      h('button', { type: 'button', onclick: () => input.click() }, u.foto_version ? 'Neues Foto' : 'Foto hochladen'),
      fotoSrc ? h('button', { type: 'button', class: 'ghost', onclick: async () => {
        try {
          const blob = await cropImage(fotoSrc);
          if (blob) await uploadFoto(url, blob, onDone);
        } catch (e) { toast(e.message, true); }
      } }, 'Ausschnitt ändern') : null,
      u.foto_version ? h('button', { type: 'button', class: 'ghost', onclick: async () => {
        if (!await uiConfirm('Das Foto wird gelöscht.', { title: 'Foto entfernen?', okText: 'Entfernen', danger: true })) return;
        try { onDone(await api('DELETE', url)); toast('Foto entfernt.'); } catch (e) { toast(e.message, true); }
      } }, 'Entfernen') : null,
      h('p', { class: 'small muted' }, 'Freiwillig. Das Foto sehen nur angemeldete Kolleginnen und Kollegen, z. B. im Dienstplan. ',
        'Auf dem Handy können Sie direkt die Kamera nutzen.')));
}

// ---------- Campus & Stationen (Verwaltung) ----------
async function renderStations() {
  const [units, buildings, users, types] = await Promise.all([
    api('GET', 'api/units'), api('GET', 'api/buildings'), api('GET', 'api/users'), api('GET', 'api/shift-types'),
  ]);
  const people = users.filter((u) => u.active).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const leitungSelect = (cur) => h('select', {}, h('option', { value: '' }, '– keine –'),
    people.map((p) => h('option', { value: p.id, selected: p.id === cur }, `${p.name}${p.qualification ? ` (${p.qualification})` : ''}`)));
  const buildingSelect = (cur) => h('select', {}, h('option', { value: '' }, '– ohne Gebäude –'),
    buildings.filter((b) => b.active || b.id === cur).map((b) => h('option', { value: b.id, selected: b.id === cur }, b.name)));
  const save = async (fn, msg) => { try { await fn(); toast(msg); renderStations(); } catch (e) { toast(e.message, true); } };

  // --- Station (Karte mit aufklappbarer Bearbeitung) ---
  const stationCard = (u) => {
    const name = h('input', { value: u.name, maxlength: 80, required: true });
    const kuerzel = h('input', { value: u.kuerzel || '', maxlength: 10, placeholder: 'z. B. 1A' });
    const telefon = h('input', { type: 'tel', value: u.telefon || '', maxlength: 40, placeholder: 'Durchwahl' });
    const leitung = leitungSelect(u.leitung_id);
    const gebaeude = buildingSelect(u.building_id);
    const active = h('input', { type: 'checkbox', checked: !!u.active });
    return h('div', { class: `card station${u.active ? '' : ' inactive'}` },
      h('div', { class: 'station-head' }, h('h3', {}, u.kuerzel ? `${u.name} (${u.kuerzel})` : u.name), !u.active ? h('span', { class: 'badge bad' }, 'inaktiv') : null),
      h('div', { class: 'station-meta' },
        h('span', {}, `👥 ${u.personal} Person(en)`),
        u.leitung_name ? h('span', {}, `Leitung: ${u.leitung_name}`) : null,
        u.telefon ? h('a', { href: `tel:${u.telefon.replace(/[^\d+]/g, '')}` }, `☎ ${u.telefon}`) : null),
      h('details', { class: 'edit' }, h('summary', {}, 'Bearbeiten'),
        h('div', { class: 'row' }, h('label', {}, 'Name', name), h('label', {}, 'Kürzel', kuerzel), h('label', {}, 'Telefon', telefon),
          h('label', {}, 'Gebäude', gebaeude), h('label', {}, 'Stationsleitung', leitung), h('label', { class: 'check' }, active, 'aktiv')),
        h('div', { class: 'toolbar', style: { marginTop: '.75rem', marginBottom: 0 } },
          h('button', { onclick: () => save(() => api('PUT', `api/units/${u.id}`, {
            name: name.value, kuerzel: kuerzel.value, telefon: telefon.value, leitung_id: leitung.value || null,
            building_id: gebaeude.value || null, active: active.checked,
          }), 'Station gespeichert.') }, 'Speichern'),
          h('button', { class: 'ghost', onclick: () => go('req') }, 'Mindestbesetzung'),
          h('button', { class: 'danger', onclick: async () => {
            if (!await uiConfirm(`Station „${u.name}“ wird gelöscht. Das geht nur, solange es dort noch keine Schichten gibt – sonst bitte deaktivieren.`,
              { title: 'Station löschen?', okText: 'Löschen', danger: true })) return;
            save(() => api('DELETE', `api/units/${u.id}`), 'Station gelöscht.');
          } }, 'Löschen'))));
  };

  // --- Neue Station (Dialog), optional schon einem Gebäude zugeordnet ---
  const newStation = async (buildingId) => {
    const r = await uiForm({
      title: 'Neue Station',
      message: buildingId ? `Gebäude: ${buildings.find((b) => b.id === buildingId)?.name}` : '',
      okText: 'Anlegen',
      fields: [
        { name: 'name', label: 'Name', required: true, placeholder: 'z. B. Station 3 – Allgemeinpsychiatrie', maxlength: 80 },
        { name: 'kuerzel', label: 'Kürzel (optional)', placeholder: 'z. B. A3', maxlength: 10 },
        { name: 'telefon', label: 'Telefon (optional)', type: 'tel', maxlength: 40 },
        { name: 'copy_from', label: 'Mindestbesetzung übernehmen von', type: 'select', value: '',
          options: [['', 'keiner – später festlegen'], ...units.filter((u) => u.active).map((u) => [u.id, u.name])],
          hint: 'Personen je Dienst und Wochentag; lässt sich danach anpassen.' },
      ],
    });
    if (!r) return;
    const copyFrom = r.copy_from ? Number(r.copy_from) : null;
    save(() => api('POST', 'api/units', { ...r, building_id: buildingId || null, copy_from: copyFrom }),
      copyFrom ? 'Station angelegt, Mindestbesetzung übernommen.' : 'Station angelegt. Bitte noch die Mindestbesetzung festlegen.');
  };

  // --- Gebäude ---
  const buildingForm = async (b) => {
    const r = await uiForm({
      title: b ? 'Gebäude bearbeiten' : 'Neues Gebäude', okText: b ? 'Speichern' : 'Anlegen',
      fields: [
        { name: 'name', label: 'Name', required: true, value: b?.name || '', placeholder: 'z. B. Haus C – Tagesklinik', maxlength: 80 },
        { name: 'kuerzel', label: 'Kürzel (optional)', value: b?.kuerzel || '', placeholder: 'z. B. C', maxlength: 10 },
        { name: 'beschreibung', label: 'Beschreibung / Lage (optional)', type: 'textarea', rows: 2, value: b?.beschreibung || '', maxlength: 300,
          placeholder: 'z. B. Eingang Marsbruchstraße, 2. OG' },
        { name: 'sort', label: 'Reihenfolge', type: 'number', min: 0, step: 1, value: b?.sort ?? '', inputmode: 'numeric', hint: 'kleinere Zahl = weiter oben' },
      ],
    });
    if (!r) return;
    const body = { ...r, sort: r.sort === '' ? undefined : Number(r.sort) };
    save(() => api(b ? 'PUT' : 'POST', b ? `api/buildings/${b.id}` : 'api/buildings', body), b ? 'Gebäude gespeichert.' : 'Gebäude angelegt.');
  };

  const buildingSection = (b, list) => h('section', { class: `card campus-building${b && !b.active ? ' inactive' : ''}` },
    h('div', { class: 'campus-head' },
      h('div', {}, h('h2', {}, b ? (b.kuerzel ? `${b.name} (${b.kuerzel})` : b.name) : 'Ohne Gebäude'),
        h('div', { class: 'station-meta', style: { margin: '.2rem 0 0' } },
          h('span', {}, `${list.filter((u) => u.active).length} Station(en)`),
          b ? h('span', {}, `👥 ${b.personal} Person(en)`) : null,
          b?.beschreibung ? h('span', {}, b.beschreibung) : null,
          b && !b.active ? h('span', { class: 'badge bad' }, 'inaktiv') : null)),
      h('div', { class: 'toolbar', style: { margin: 0 } },
        h('button', { onclick: () => newStation(b?.id) }, '+ Station'),
        b ? h('button', { class: 'ghost', onclick: () => buildingForm(b) }, 'Bearbeiten') : null,
        b ? h('button', { class: 'ghost', onclick: () => save(() => api('PUT', `api/buildings/${b.id}`, { active: !b.active }), b.active ? 'Gebäude deaktiviert.' : 'Gebäude aktiviert.') },
          b.active ? 'Deaktivieren' : 'Aktivieren') : null,
        b ? h('button', { class: 'danger', onclick: async () => {
          if (!await uiConfirm(`„${b.name}“ wird gelöscht. Die ${list.length} Station(en) bleiben erhalten und sind danach keinem Gebäude zugeordnet.`,
            { title: 'Gebäude löschen?', okText: 'Löschen', danger: true })) return;
          save(() => api('DELETE', `api/buildings/${b.id}`), 'Gebäude gelöscht.');
        } }, 'Löschen') : null)),
    list.length ? h('div', { class: 'campus-stations' }, list.map(stationCard))
      : h('p', { class: 'muted' }, 'Noch keine Stationen in diesem Gebäude.'));

  const ohne = units.filter((u) => !u.building_id);
  setMain(
    h('div', { class: 'card' },
      h('div', { class: 'toolbar', style: { marginBottom: '.25rem' } },
        h('h2', { style: { margin: 0 } }, 'Campus & Stationen'), h('span', { class: 'spacer' }),
        h('button', { onclick: () => buildingForm(null) }, '+ Gebäude'),
        h('button', { class: 'ghost', onclick: () => newStation(null) }, '+ Station')),
      h('p', { class: 'small muted', style: { margin: 0 } },
        `${buildings.filter((b) => b.active).length} Gebäude · ${units.filter((u) => u.active).length} aktive Stationen · `,
        'Gebäude und Stationen erscheinen im Dienstplan (Auswahl „Gebäude – alle Stationen“), in der Personalakte und in den Auswertungen. ',
        types.length ? '' : 'Tipp: Legen Sie unter „Dienstzeiten“ auch die Dienste an.')),
    buildings.map((b) => buildingSection(b, units.filter((u) => u.building_id === b.id))),
    ohne.length || !buildings.length ? buildingSection(null, ohne) : null);
}

// ---------- Personalverwaltung (Verwaltung) ----------
const RECHTE_LABEL = { keine: '', voll: 'Verwalter/in', vertretung: 'Vertretung' };
function rechteBadge(u) {
  if (u.role === 'manager') return h('span', { class: 'badge ok' }, 'Hauptverwaltung');
  if (u.admin_rechte === 'voll') return h('span', { class: 'badge ok' }, 'Verwalter/in');
  if (u.admin_rechte === 'vertretung') {
    const aktiv = u.is_manager;
    return h('span', { class: `badge ${aktiv ? 'warn' : 'bad'}` }, aktiv ? `Vertretung bis ${fmtDate(u.admin_bis)}` : `Vertretung abgelaufen (${fmtDate(u.admin_bis)})`);
  }
  return null;
}
function vertragHinweis(u) {
  const today = todayIso();
  if (u.austritt && u.austritt < today) return h('span', { class: 'badge bad' }, `ausgeschieden ${fmtDate(u.austritt)}`);
  if (u.austritt) return h('span', { class: 'badge warn' }, `Austritt ${fmtDate(u.austritt)}`);
  if (u.befristet_bis) {
    const tage = (parseIso(u.befristet_bis) - parseIso(today)) / 86400000;
    if (tage < 0) return h('span', { class: 'badge bad' }, `Befristung abgelaufen (${fmtDate(u.befristet_bis)})`);
    if (tage <= 90) return h('span', { class: 'badge warn' }, `befristet bis ${fmtDate(u.befristet_bis)}`);
  }
  return null;
}

async function renderStaff() {
  const [users, units] = await Promise.all([api('GET', 'api/users'), api('GET', 'api/units')]);
  const unitById = new Map(units.map((u) => [u.id, u]));
  const unitName = new Map(units.map((u) => [u.id, u.building_name ? `${u.name} · ${u.building_name}` : u.name]));
  state.personalFilter = state.personalFilter || { q: '', unit: '', qual: '', status: 'aktiv' };
  const f = state.personalFilter;
  const search = h('input', { type: 'search', placeholder: 'Name, Personalnr., Benutzer …', value: f.q });
  const unitSel = unitFilterSelect(units, f.unit, () => draw(), 'alle Bereiche');
  const qualSel = h('select', {}, h('option', { value: '' }, 'alle Qualifikationen'),
    (state.settings.qualifikationen || []).map((q) => h('option', { value: q, selected: q === f.qual }, q)));
  const statusSel = h('select', {}, [['aktiv', 'aktive'], ['inaktiv', 'inaktive / ausgeschiedene'], ['verwaltung', 'mit Verwaltungsrechten'], ['', 'alle']]
    .map(([v, l]) => h('option', { value: v, selected: v === f.status }, l)));
  const tbody = h('tbody');
  const count = h('span', { class: 'muted small' });
  const draw = () => {
    Object.assign(f, { q: search.value.trim().toLowerCase(), unit: unitSel.value, qual: qualSel.value, status: statusSel.value });
    const today = todayIso();
    const list = users.filter((u) => {
      const ausgeschieden = !u.active || (u.austritt && u.austritt < today);
      if (f.status === 'aktiv' && ausgeschieden) return false;
      if (f.status === 'inaktiv' && !ausgeschieden) return false;
      if (f.status === 'verwaltung' && !(u.role === 'manager' || u.admin_rechte !== 'keine')) return false;
      if (f.unit) {
        const unit = unitById.get(u.stammbereich_id);
        if (f.unit.startsWith('b:') ? String(unit?.building_id ?? 'none') !== f.unit.slice(2) || !unit && f.unit !== 'b:none'
          : String(u.stammbereich_id) !== f.unit.replace(/^u:/, '')) return false;
      }
      if (f.qual && u.qualification !== f.qual) return false;
      if (f.q && ![u.name, u.username, u.personalnummer, u.email].some((x) => String(x || '').toLowerCase().includes(f.q))) return false;
      return true;
    });
    count.textContent = `${list.length} von ${users.length} Personen`;
    tbody.replaceChildren(...list.map((u) => h('tr', { class: `clickable${u.active ? '' : ' inactive'}`, onclick: () => renderPersonalakte(u.id) },
      h('td', {}, u.personalnummer || '–'),
      h('td', {}, h('div', { class: 'person' }, avatar(u, 32), h('div', {}, h('strong', {}, u.name), h('div', { class: 'small muted' }, u.username)))),
      h('td', {}, u.qualification || '–'),
      h('td', {}, unitName.get(u.stammbereich_id) || '–'),
      h('td', { class: 'num' }, fmtNum(u.weekly_hours)),
      h('td', {}, u.eintritt ? fmtDate(u.eintritt) : '–'),
      h('td', {}, h('div', { class: 'badges' }, rechteBadge(u), vertragHinweis(u), !u.active ? h('span', { class: 'badge bad' }, 'inaktiv') : null,
        u.locked ? h('span', { class: 'badge bad' }, 'gesperrt') : null,
        u.totp_enabled ? null : h('span', { class: 'badge warn' }, '2FA offen'))))));
    stackTables(card);
  };
  for (const el of [qualSel, statusSel]) el.addEventListener('change', draw);
  search.addEventListener('input', draw);
  const card = h('div', { class: 'card' },
    h('div', { class: 'toolbar' }, h('h2', { style: { margin: 0 } }, 'Personal'), h('span', { class: 'spacer' }),
      h('a', { href: 'api/users.csv' }, h('button', { class: 'ghost' }, 'Personalliste (Excel)')),
      h('button', { onclick: () => renderPersonalakte(null) }, '+ Neue Person')),
    h('div', { class: 'row filters' }, h('label', {}, 'Suche', search), h('label', {}, 'Bereich', unitSel),
      h('label', {}, 'Qualifikation', qualSel), h('label', {}, 'Anzeigen', statusSel)),
    count,
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Pers.-Nr.', 'Name', 'Qualifikation', 'Stammbereich', 'Wochenstd.', 'Eintritt', 'Hinweise'].map((x) => h('th', {}, x)))),
      tbody)),
    h('p', { class: 'small muted' }, 'Zum Öffnen der Personalakte auf eine Zeile klicken.'));
  setMain(card);
  draw();
  if (!isPhone()) search.focus();
}

async function userAction(u, body, question) {
  if (question && !await uiConfirm(question)) return false;
  try { await api('PUT', `api/users/${u.id}`, body); toast('Erledigt.'); return true; } catch (e) { toast(e.message, true); return false; }
}

/** Personalakte: Stammdaten, Vertrag, Rechte, Urlaub, Dienste, Abwesenheiten */
async function renderPersonalakte(id) {
  const units = await api('GET', 'api/units');
  const users = id ? await api('GET', 'api/users') : [];
  const u = id ? users.find((x) => x.id === id) : null;
  if (id && !u) { toast('Person nicht gefunden.', true); return renderStaff(); }
  const back = h('button', { class: 'ghost', onclick: () => renderStaff() }, '‹ Zur Personalliste');
  const form = staffForm(u, units);
  if (!u) return setMain(h('div', { class: 'toolbar' }, back), form);

  const year = Number(todayIso().slice(0, 4));
  const [abs, shifts, report] = await Promise.all([
    api('GET', `api/absences?user_id=${u.id}&year=${year}`),
    api('GET', `api/users/${u.id}/shifts?from=${todayIso()}&to=${addDays(todayIso(), 60)}`),
    u.role === 'staff' ? api('GET', `api/report?month=${todayIso().slice(0, 7)}&user_id=${u.id}`) : Promise.resolve(null),
  ]);
  const r = report?.rows?.[0];
  const head = h('div', { class: 'card akte-head' },
    h('div', { class: 'akte-foto' }, fotoControl(u, `api/users/${u.id}/foto`, () => renderPersonalakte(u.id))),
    h('div', { class: 'akte-main' }, h('h2', { style: { margin: 0 } }, u.name),
      h('div', { class: 'muted' }, [u.qualification, units.find((x) => x.id === u.stammbereich_id)?.name, u.personalnummer && `Pers.-Nr. ${u.personalnummer}`]
        .filter(Boolean).join(' · ') || '–'),
      h('div', { class: 'badges' }, rechteBadge(u), vertragHinweis(u), !u.active ? h('span', { class: 'badge bad' }, 'inaktiv') : null,
        u.totp_enabled ? h('span', { class: 'badge ok' }, '2FA eingerichtet') : h('span', { class: 'badge warn' }, '2FA noch nicht eingerichtet'),
        u.locked ? h('span', { class: 'badge bad' }, 'gesperrt') : null)),
    h('div', { class: 'akte-contact' },
      u.telefon ? h('a', { href: `tel:${u.telefon.replace(/[^\d+]/g, '')}` }, `☎ ${u.telefon}`) : null,
      u.email ? h('a', { href: `mailto:${u.email}` }, `✉ ${u.email}`) : null));

  const kontoCard = abs.urlaub ? h('div', { class: 'card' }, h('h3', { style: { marginTop: 0 } }, `Urlaub ${year}`),
    h('div', { class: 'stat' }, `${fmtNum(abs.urlaub.rest, 1)} Tage übrig`),
    h('p', { class: 'small muted' }, `Anspruch ${fmtNum(abs.urlaub.anspruch, 1)} · genehmigt ${abs.urlaub.genehmigt} · beantragt ${abs.urlaub.beantragt}`),
    abs.zusatzurlaub ? h('p', { class: 'small' }, `Zusatzurlaub: ${fmtNum(abs.zusatzurlaub.rest, 1)} von ${fmtNum(abs.zusatzurlaub.anspruch, 1)} Tagen übrig`) : null) : null;
  const zeitCard = r ? h('div', { class: 'card' }, h('h3', { style: { marginTop: 0 } }, `Zeitkonto ${todayIso().slice(5, 7)}/${year}`),
    h('div', { class: 'stat' }, `${fmtNum(r.ist)} / ${fmtNum(r.soll)} Std.`),
    h('p', { class: 'small muted' }, `Saldo ${fmtNum(r.saldo)} Std. · ${r.dienste} Dienste · ${r.nachtschichten} Nachtschichten`),
    h('p', { class: 'small' }, r.min_erfuellt ? h('span', { class: 'badge ok' }, 'Mindestverfügbarkeit erfüllt')
      : h('span', { class: 'badge warn' }, `Mindestverfügbarkeit: ${fmtNum(r.ist, 1)} von ${fmtNum(r.min_hours_month, 1)} Std.`))) : null;

  const dienstCard = h('div', { class: 'card' }, h('h3', { style: { marginTop: 0 } }, 'Kommende Dienste (60 Tage)'),
    shifts.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Datum', 'Dienst', 'Bereich', 'Zeit'].map((x) => h('th', {}, x)))),
      h('tbody', {}, shifts.map((x) => h('tr', {},
        h('td', {}, `${WD[weekday(x.date)]} ${fmtDate(x.date)}`),
        h('td', {}, h('span', { class: 'chip', style: { background: x.type_color } }, x.type_code), x.type_name),
        h('td', {}, x.unit_name), h('td', {}, `${x.start_time}–${x.end_time}`))))))
      : h('p', { class: 'muted' }, 'Keine Dienste eingetragen.'));

  const absCard = h('div', { class: 'card' }, h('h3', { style: { marginTop: 0 } }, 'Abwesenheiten'),
    abs.absences.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Art', 'Zeitraum', 'Tage', 'Status', 'AU'].map((x) => h('th', {}, x)))),
      h('tbody', {}, abs.absences.slice(0, 30).map((a) => h('tr', {},
        h('td', {}, typeLabel(a)), h('td', {}, range(a)),
        h('td', { class: 'num' }, a.type !== 'krank' ? `${a.arbeitstage} AT` : `${a.kalendertage} KT`),
        h('td', {}, statusBadge(a)), h('td', {}, auStatus(a) || '–'))))))
      : h('p', { class: 'muted' }, 'Keine Einträge.'));

  const actions = h('div', { class: 'card' }, h('h3', { style: { marginTop: 0 } }, 'Zugang'),
    h('div', { class: 'toolbar' },
      u.totp_enabled ? h('button', { class: 'danger', onclick: async () => {
        if (await userAction(u, { reset_2fa: true }, `2FA von ${u.name} zurücksetzen (z. B. Handy verloren)? Die Person richtet sie bei der nächsten Anmeldung neu ein.`)) renderPersonalakte(u.id);
      } }, '2FA zurücksetzen') : null,
      u.locked ? h('button', { class: 'ghost', onclick: async () => { if (await userAction(u, { unlock: true })) renderPersonalakte(u.id); } }, 'Entsperren') : null,
      h('button', { class: 'ghost', onclick: async () => {
        const pw = await uiPrompt({ title: 'Passwort neu setzen', message: u.name, label: 'Neues Startpasswort', type: 'password',
          required: true, minLength: 6, autocomplete: 'new-password', okText: 'Setzen' });
        if (!pw) return;
        if (await userAction(u, { password: pw })) renderPersonalakte(u.id);
      } }, 'Passwort neu setzen')));

  setMain(h('div', { class: 'toolbar' }, back), head,
    h('div', { class: 'grid-2' }, kontoCard, zeitCard),
    form, state.me.is_haupt && u.id !== state.me.id ? rechteCard(u) : null,
    h('div', { class: 'grid-2' }, dienstCard, absCard), actions);
}

/** Verwaltungsrechte vergeben (nur Hauptverwaltung) */
function rechteCard(u) {
  const sel = h('select', {},
    h('option', { value: 'keine', selected: u.role !== 'manager' && u.admin_rechte === 'keine' }, 'keine – normale/r Mitarbeiter/in'),
    h('option', { value: 'vertretung', selected: u.admin_rechte === 'vertretung' }, 'Vertretung (befristet)'),
    h('option', { value: 'voll', selected: u.admin_rechte === 'voll' }, 'Verwalter/in (dauerhaft)'),
    h('option', { value: 'haupt', selected: u.role === 'manager' }, 'Hauptverwaltung'));
  const bis = h('input', { type: 'date', value: u.admin_bis || addDays(todayIso(), 14), min: todayIso() });
  const bisLabel = h('label', {}, 'Vertretung gilt bis einschließlich', bis);
  const sync = () => { bisLabel.hidden = sel.value !== 'vertretung'; };
  sel.addEventListener('change', sync);
  sync();
  return h('div', { class: 'card' }, h('h3', { style: { marginTop: 0 } }, 'Verwaltungsrechte'),
    h('p', { class: 'small muted' },
      'Verwalter/innen und Vertretungen können Dienstpläne, Personal, Urlaub und Krankmeldungen bearbeiten und arbeiten weiterhin selbst im Dienstplan mit. ',
      'Rechte vergeben, andere Verwalter/innen bearbeiten und Hauptverwaltung zuweisen kann nur die Hauptverwaltung. ',
      'Eine Vertretung endet automatisch nach dem angegebenen Tag. Alle Änderungen stehen im Protokoll.'),
    h('div', { class: 'row' }, h('label', {}, 'Rechte', sel), bisLabel,
      h('button', { onclick: async () => {
        const v = sel.value;
        const body = v === 'haupt' ? { role: 'manager', admin_rechte: 'keine' }
          : { role: 'staff', admin_rechte: v, ...(v === 'vertretung' ? { admin_bis: bis.value } : {}) };
        const text = v === 'haupt' ? `${u.name} zur Hauptverwaltung machen? Hauptverwalter/innen werden nicht mehr im Dienstplan eingeplant.`
          : v === 'vertretung' ? `${u.name} als Vertretung bis ${fmtDate(bis.value)} einsetzen?`
            : v === 'voll' ? `${u.name} dauerhaft Verwaltungsrechte geben?` : `Verwaltungsrechte von ${u.name} entfernen?`;
        if (await userAction(u, body, text)) renderPersonalakte(u.id);
      } }, 'Rechte speichern')));
}

function staffForm(u, units) {
  const f = (name, label, attrs = {}) => h('label', {}, label, h('input', { name, ...attrs }));
  const section = (title, ...fields) => h('fieldset', {}, h('legend', {}, title), h('div', { class: 'row' }, fields));
  const form = h('form', { class: 'card', id: 'staff-form' },
    h('h2', {}, u ? 'Stammdaten' : 'Neue Person anlegen'),
    section('Person und Zugang',
      f('name', 'Name', { required: true, value: u?.name || '' }),
      f('personalnummer', 'Personalnummer', { value: u?.personalnummer || '' }),
      f('username', 'Benutzername', { required: true, value: u?.username || '', autocomplete: 'off' }),
      !u ? f('password', 'Startpasswort', { type: 'password', required: true, minlength: 6, autocomplete: 'new-password' }) : null,
      f('email', 'E-Mail (dienstlich)', { type: 'email', value: u?.email || '' }),
      f('telefon', 'Telefon', { type: 'tel', value: u?.telefon || '' })),
    section('Einsatz',
      h('label', {}, 'Qualifikation', h('select', { name: 'qualification' }, h('option', { value: '' }, '– keine –'),
        [...new Set([...(state.settings.qualifikationen || []), ...(u?.qualification ? [u.qualification] : [])])]
          .map((q) => h('option', { value: q, selected: u?.qualification === q }, q)))),
      h('label', {}, 'Stammbereich', h('select', { name: 'stammbereich_id' }, h('option', { value: '' }, '– keiner –'),
        units.filter((x) => x.active || x.id === u?.stammbereich_id).map((x) => h('option', { value: x.id, selected: u?.stammbereich_id === x.id }, x.name)))),
      f('weekly_hours', 'Wochenstunden', { type: 'number', step: '0.25', min: 0, value: u?.weekly_hours ?? state.settings.wochenstunden_standard }),
      f('min_hours_month', 'Mindestverfügbarkeit (Std./Monat)', { type: 'number', step: '0.5', min: 0, value: u?.min_hours_month ?? 0 })),
    section('Vertrag (TVöD)',
      f('eintritt', 'Eintritt', { type: 'date', value: u?.eintritt || '' }),
      f('befristet_bis', 'befristet bis', { type: 'date', value: u?.befristet_bis || '' }),
      f('austritt', 'Austritt', { type: 'date', value: u?.austritt || '' }),
      f('entgeltgruppe', 'Entgeltgruppe', { value: u?.entgeltgruppe || '', placeholder: 'z. B. P8, E9a', list: 'eg-list' }),
      f('stufe', 'Stufe', { type: 'number', min: 1, max: 6, step: 1, value: u?.stufe ?? '' }),
      f('stundenentgelt', 'Stundenentgelt € (für Zuschläge)', { type: 'number', step: '0.01', min: 0, value: u?.stundenentgelt ?? 0 })),
    h('datalist', { id: 'eg-list' }, ['P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11', 'P12', 'P13', 'P14', 'P15', 'P16', 'E5', 'E6', 'E8', 'E9a', 'E9b', 'E10', 'E11', 'E12', 'E13', 'E14', 'E15', 'Ä1', 'Ä2', 'Ä3', 'Ä4']
      .map((x) => h('option', { value: x }))),
    section('Urlaub',
      f('urlaubstage_jahr', 'Urlaubstage pro Jahr', { type: 'number', step: '0.5', min: 0, value: u?.urlaubstage_jahr ?? state.settings.urlaubstage_standard }),
      h('label', { class: 'check', style: { alignSelf: 'center' } }, h('input', { type: 'checkbox', name: 'schwerbehindert', checked: !!u?.schwerbehindert }),
        'Schwerbehinderung (GdB ≥ 50)'),
      f('zusatzurlaub_tage', 'Zusatzurlaub (Tage/Jahr)', { type: 'number', step: '0.5', min: 0, value: u?.schwerbehindert ? u.zusatzurlaub_tage : 5 })),
    h('fieldset', {}, h('legend', {}, 'Bemerkung (nur für die Verwaltung sichtbar)'),
      h('textarea', { name: 'bemerkung', rows: 3, maxlength: 2000, value: u?.bemerkung || '' })),
    u ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: !!u.active }), 'Zugang aktiv') : null,
    h('p', { class: 'small muted' }, 'Zusatzurlaub nach § 208 SGB IX: 5 Arbeitstage bei 5-Tage-Woche; im Jahr der Feststellung anteilig. ',
      'Angaben zur Schwerbehinderung sind vertraulich. Nach dem Austrittsdatum ist keine Anmeldung mehr möglich.'),
    h('div', { class: 'toolbar' }, h('button', { type: 'submit' }, u ? 'Stammdaten speichern' : 'Anlegen')));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    data.schwerbehindert = form.querySelector('[name=schwerbehindert]').checked;
    if (!data.schwerbehindert) delete data.zusatzurlaub_tage;
    if (u) data.active = form.querySelector('[name=active]').checked;
    try {
      const saved = await api(u ? 'PUT' : 'POST', u ? `api/users/${u.id}` : 'api/users', data);
      toast('Gespeichert.');
      renderPersonalakte(saved.id);
    } catch (e) { toast(e.message, true); }
  });
  return form;
}

// ---------- Dienstzeiten / Schichtarten (Manager) ----------
async function renderShiftTypes() {
  const [types, units] = await Promise.all([api('GET', 'api/shift-types'), api('GET', 'api/units')]);
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
        body.apply_future = await uiConfirm('Sollen die geänderten Zeiten auch für bereits erzeugte, zukünftige Schichten gelten?',
          { title: 'Zeiten übernehmen?', okText: 'Ja, übernehmen', cancelText: 'Nur für neue' });
      }
      try {
        const res = await api(t ? 'PUT' : 'POST', t ? `api/shift-types/${t.id}` : 'api/shift-types', body);
        toast(res.updated_shifts ? `Gespeichert, ${res.updated_shifts} Schichten angepasst.` : 'Gespeichert.');
        renderShiftTypes();
      } catch (e) { toast(e.message, true); }
    };
    return h('tr', { class: t && !t.active ? 'inactive' : '' }, Object.values(r).map((el) => h('td', {}, el)),
      h('td', { class: 'num' }, t ? fmtNum(hoursOf(t)) : ''), h('td', {}, h('button', { class: 'tiny', onclick: save }, t ? 'Speichern' : 'Hinzufügen')));
  };

  setMain(
    h('div', { class: 'card' }, h('h2', {}, 'Dienstzeiten (Schichtarten)'),
      h('p', { class: 'muted small' }, 'Endet ein Dienst vor seinem Beginn (z. B. 21:30–06:30), geht er über Mitternacht. Die Pause wird nicht als Arbeitszeit angerechnet.'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Bezeichnung', 'Kürzel', 'Beginn', 'Ende', 'Pause (Min.)', 'Farbe', 'Aktiv', 'Std.', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, types.map(typeRow), typeRow(null))))),
    h('p', { class: 'small muted' }, 'Stationen legen Sie unter ', h('a', { href: '#stationen', onclick: (e) => { e.preventDefault(); go('stationen'); } }, 'Stationen'), ' an.'));
}

function hoursOf(t) {
  const m = (x) => { const [a, b] = x.split(':').map(Number); return a * 60 + b; };
  let d = m(t.end_time) - m(t.start_time);
  if (d <= 0) d += 1440;
  return (d - t.break_min) / 60;
}

// ---------- Mindestbesetzung (Manager) ----------
async function qualRulesCard(units, types) {
  const rules = await api('GET', 'api/qual-rules');
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
          await api('DELETE', `api/qual-rules/${r.id}`); toast('Regel gelöscht.'); renderRequirements();
        } }, 'Löschen'))))))
      : h('p', { class: 'muted' }, 'Noch keine Regeln.'),
    h('h3', {}, 'Neue Regel'),
    h('div', { class: 'row' }, h('label', {}, 'Bereich', unitSel), h('label', {}, 'Dienst', typeSel), h('label', {}, 'Qualifikation', qualSel),
      h('label', {}, 'mindestens', count),
      h('button', { onclick: async () => {
        try {
          await api('POST', 'api/qual-rules', { unit_id: unitSel.value || null, shift_type_id: typeSel.value || null, qualification: qualSel.value, min_count: Number(count.value) });
          toast('Regel hinzugefügt.'); renderRequirements();
        } catch (e) { toast(e.message, true); }
      } }, 'Hinzufügen')),
    h('p', { class: 'small muted' }, 'Die Liste der Qualifikationen pflegen Sie unter Einstellungen.'));
}

async function renderRequirements() {
  const [units, types, reqs] = await Promise.all([api('GET', 'api/units'), api('GET', 'api/shift-types'), api('GET', 'api/requirements')]);
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
          await api('PUT', 'api/requirements', inputs.map((i) => ({
            unit_id: i.unit_id, shift_type_id: i.shift_type_id, weekday: i.weekday,
            min_staff: Number(i.min.value || 0), max_staff: i.max.value === '' ? null : Number(i.max.value),
          })));
          toast('Mindestbesetzung gespeichert.');
        } catch (e) { toast(e.message, true); }
      },
    }, 'Speichern'))), cards,
    h('div', { class: 'card save-bar' }, h('button', {
      onclick: async () => {
        try {
          await api('PUT', 'api/requirements', inputs.map((i) => ({
            unit_id: i.unit_id, shift_type_id: i.shift_type_id, weekday: i.weekday,
            min_staff: Number(i.min.value || 0), max_staff: i.max.value === '' ? null : Number(i.max.value),
          })));
          toast('Mindestbesetzung gespeichert.');
        } catch (e) { toast(e.message, true); }
      },
    }, 'Speichern')),
    await qualRulesCard(units.filter((u) => u.active), activeTypes));
}

// ---------- Einstellungen (Manager) ----------
async function renderSettings() {
  const s = await api('GET', 'api/settings');
  const fields = [
    ['klinik_name', 'Name der Einrichtung', 'text', 'Erscheint groß auf der Anmeldeseite, in der Kopfzeile und als Name der Handy-App.'],
    ['untertitel', 'Bezeichnung der Anwendung', 'text', 'z. B. „Personaleinsatzplanung“ oder „Dienstplan Pflege“'],
    ['akzentfarbe', 'Hausfarbe (Schaltflächen, Kopfzeile)', 'color'],
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
      state.settings = await api('PUT', 'api/settings', body);
      await loadBranding();
      toast('Einstellungen gespeichert.');
    } catch (e) { toast(e.message, true); }
  });
  setMain(form, logoCard());
}

function logoCard() {
  const b = state.branding || {};
  const input = h('input', { type: 'file', accept: 'image/png,image/jpeg', hidden: true });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return toast('Das Logo ist größer als 2 MB.', true);
    try {
      const res = await fetch('api/branding/logo', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast('Logo gespeichert.');
      await loadBranding(); renderSettings();
    } catch (e) { toast(e.message, true); }
  });
  return h('div', { class: 'card' }, h('h2', {}, 'Logo'),
    h('p', { class: 'small muted' }, 'PNG oder JPG, max. 2 MB, am besten quer und mit transparentem Hintergrund. ',
      'Erscheint auf der Anmeldeseite und in der Kopfzeile. Bitte nur ein Logo verwenden, dessen Nutzung die Einrichtung freigegeben hat.'),
    b.logo ? h('div', { class: 'logo-preview' }, logoImg('login-logo-img')) : h('p', { class: 'muted' }, 'Kein Logo hinterlegt.'),
    h('div', { class: 'toolbar' }, input,
      h('button', { onclick: () => input.click() }, b.logo ? 'Anderes Logo hochladen' : 'Logo hochladen'),
      b.logo ? h('button', { class: 'danger', onclick: async () => {
        if (!await uiConfirm('Das Logo wird entfernt.', { title: 'Logo entfernen?', okText: 'Entfernen', danger: true })) return;
        try { await api('DELETE', 'api/branding/logo'); await loadBranding(); renderSettings(); } catch (e) { toast(e.message, true); }
      } }, 'Entfernen') : null));
}

// ---------- Urlaub & Krankheit ----------
const STATUS = {
  beantragt: ['warn', 'beantragt'], genehmigt: ['ok', 'genehmigt'], abgelehnt: ['bad', 'abgelehnt'], gemeldet: ['warn', 'krankgemeldet'],
};
const statusBadge = (a) => h('span', { class: `badge ${STATUS[a.status][0]}` }, STATUS[a.status][1]);
const ABS_LABEL = { urlaub: 'Erholungsurlaub', zusatzurlaub: 'Zusatzurlaub (Schwerbehinderung)', sonderurlaub: 'Sonderurlaub', krank: 'Krankheit' };
const typeLabel = (a) => ABS_LABEL[a.type] || a.type;
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
    h('a', { href: `api/attachments/${f.id}?inline=1`, target: '_blank', rel: 'noopener' }, f.filename),
    h('span', { class: 'small muted' }, ` (${fmtSize(f.size)})`),
    canDelete ? h('button', { class: 'tiny danger', title: 'Datei löschen', onclick: async () => {
      if (!await uiConfirm(f.filename, { title: 'Datei löschen?', okText: 'Löschen', danger: true })) return;
      try { await api('DELETE', `api/attachments/${f.id}`); toast('Gelöscht.'); refresh(); } catch (e) { toast(e.message, true); }
    } }, '×') : null)));
}

function uploadButton(a) {
  const input = h('input', { type: 'file', accept: 'application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png', hidden: true });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return toast('Die Datei ist größer als 10 MB.', true);
    try {
      const res = await fetch(`api/absences/${a.id}/attachments`, {
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
  const iso = await uiPrompt({ title: 'Krankmeldung ändern', message: `Bisher: ${range(a)}`, label: 'krank bis einschließlich',
    type: 'date', value: a.to_date, required: true, okText: 'Speichern' });
  if (!iso) return;
  try {
    const r = await api('PUT', `api/absences/${a.id}`, { to: iso });
    toast(r.removed ? `Gespeichert. ${r.removed} Dienst(e) wurden ausgetragen.` : 'Gespeichert.');
    if (r.au_fehlt) await uiAlert(`Ab dem ${state.settings.au_ab_tag}. Krankheitstag ist eine Arbeitsunfähigkeitsbescheinigung erforderlich. Bitte laden Sie sie hoch.`);
  } catch (e) { toast(e.message, true); }
  refresh();
}

function absenceForm(type, onSaved, users) {
  const today = todayIso();
  const userSel = users ? h('select', { required: true }, h('option', { value: '' }, '– Person wählen –'),
    users.map((u) => h('option', { value: u.id }, u.name))) : null;
  let typeSel = null;
  if (users) {
    typeSel = h('select', {}, ['urlaub', 'zusatzurlaub', 'sonderurlaub', 'krank'].map((t) => h('option', { value: t }, ABS_LABEL[t])));
  } else if (type !== 'krank') {
    typeSel = h('select', {}, h('option', { value: 'urlaub' }, ABS_LABEL.urlaub),
      state.me.schwerbehindert ? h('option', { value: 'zusatzurlaub' }, ABS_LABEL.zusatzurlaub) : null,
      h('option', { value: 'sonderurlaub' }, 'Sonderurlaub (Arbeitsbefreiung)'));
  }
  const from = h('input', { type: 'date', required: true, value: type === 'krank' ? today : '' });
  const to = h('input', { type: 'date', required: true, value: type === 'krank' ? today : '' });
  from.addEventListener('change', () => { if (!to.value || to.value < from.value) to.value = from.value; });
  const note = h('input', { placeholder: type === 'krank' ? 'optional' : 'optional, z. B. Familienurlaub', maxlength: 500 });
  const noteLabel = h('span', {}, 'Bemerkung');
  typeSel?.addEventListener('change', () => {
    const sonder = typeSel.value === 'sonderurlaub';
    noteLabel.textContent = sonder ? 'Anlass (Pflicht)' : 'Bemerkung';
    note.placeholder = sonder ? 'z. B. Umzug, Hochzeit, Niederkunft der Partnerin' : 'optional';
    note.required = sonder;
  });
  const form = h('form', { class: 'row' },
    userSel ? h('label', {}, 'Mitarbeiter/in', userSel) : null, typeSel ? h('label', {}, 'Art', typeSel) : null,
    h('label', {}, type === 'krank' ? 'krank seit' : 'von', from),
    h('label', {}, type === 'krank' ? 'voraussichtlich bis' : 'bis', to),
    h('label', {}, noteLabel, note),
    h('button', { type: 'submit' }, users ? 'Eintragen' : type === 'krank' ? 'Krank melden' : 'Beantragen'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const t = typeSel ? typeSel.value : type;
    try {
      const r = await api('POST', 'api/absences', { type: t, from: from.value, to: to.value, note: note.value, user_id: userSel?.value || undefined });
      let msg = t === 'krank' ? 'Krankmeldung gespeichert.' : users ? `${ABS_LABEL[t]} eingetragen.` : `Antrag (${ABS_LABEL[t]}) über ${r.arbeitstage} Arbeitstage gestellt.`;
      if (r.removed) msg += ` ${r.removed} Dienst(e) wurden ausgetragen.`;
      toast(msg);
      if (t === 'krank' && r.au_erforderlich && !users) {
        await uiAlert(`Ihre Krankmeldung umfasst ${r.kalendertage} Tage. Ab dem ${state.settings.au_ab_tag}. Tag ist eine Arbeitsunfähigkeitsbescheinigung nötig – bitte laden Sie sie unten hoch.`);
      }
      onSaved();
    } catch (e) { toast(e.message, true); }
  });
  return form;
}

async function renderMyAbsences() {
  const year = Number(todayIso().slice(0, 4));
  const r = await api('GET', `api/absences?year=${year}&mine=1`);
  const kontoCard = (title, k, hint) => {
    const pct = k.anspruch ? Math.min(100, ((k.genehmigt + k.beantragt) / k.anspruch) * 100) : 0;
    return h('div', { class: 'card' }, h('h2', {}, `${title} ${k.jahr}`),
      h('div', { class: 'stat' }, `${fmtNum(k.rest, 1)} Tage übrig`),
      h('div', { class: 'progress' }, h('div', { style: { width: pct + '%' } })),
      h('p', { class: 'small muted' }, `Anspruch ${fmtNum(k.anspruch, 1)} · genehmigt ${k.genehmigt} · beantragt ${k.beantragt} (Arbeitstage)`),
      hint ? h('p', { class: 'small muted' }, hint) : null);
  };
  setMain(
    h('div', { class: 'grid-2' },
      kontoCard('Urlaubskonto', r.urlaub),
      r.zusatzurlaub ? kontoCard('Zusatzurlaub', r.zusatzurlaub, 'Zusatzurlaub für schwerbehinderte Menschen nach § 208 SGB IX.') : null,
      h('div', { class: 'card' }, h('h2', {}, 'Krankmeldung'),
        h('p', { class: 'small muted' }, `Bitte melden Sie sich zusätzlich telefonisch auf der Station ab. Ab dem ${r.au_ab_tag}. Krankheitstag ist eine `,
          'Arbeitsunfähigkeitsbescheinigung (AU) hochzuladen (PDF oder Foto). Bereits eingetragene Dienste im Zeitraum werden automatisch ausgetragen.'),
        absenceForm('krank', renderMyAbsences))),
    h('div', { class: 'card' }, h('h2', {}, 'Urlaub beantragen'),
      h('p', { class: 'small muted' }, 'Der Antrag geht an die Einsatzplanung. Gezählt werden Arbeitstage (Mo–Fr ohne Feiertage). Nach der Genehmigung werden Dienste im Zeitraum ausgetragen. ',
        'Sonderurlaub (Arbeitsbefreiung nach § 29 TVöD, z. B. bei Umzug oder Niederkunft der Ehefrau/Partnerin) bitte mit Anlass beantragen.'),
      absenceForm('urlaub', renderMyAbsences)),
    h('div', { class: 'card' }, h('h2', {}, 'Meine Einträge'),
      r.absences.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Art', 'Zeitraum', 'Tage', 'Status', 'Bemerkung', 'Bescheinigung', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, r.absences.map((a) => h('tr', {},
          h('td', {}, typeLabel(a)), h('td', {}, range(a)),
          h('td', { class: 'num' }, a.type !== 'krank' ? `${a.arbeitstage} AT` : `${a.kalendertage} KT`),
          h('td', {}, statusBadge(a)),
          h('td', {}, a.note, a.decision_note ? h('div', { class: 'small muted' }, `Einsatzplanung: ${a.decision_note}`) : null),
          h('td', {}, auStatus(a), attachmentList(a, true)),
          h('td', { class: 'actions' },
            a.type === 'krank' ? uploadButton(a) : null,
            a.type === 'krank' ? h('button', { class: 'tiny ghost', onclick: () => extendSickness(a) }, 'Verlängern') : null,
            a.type !== 'krank' && a.status === 'beantragt' ? h('button', { class: 'tiny danger', onclick: async () => {
              if (!await uiConfirm('Der Antrag wird gelöscht.', { title: 'Antrag zurückziehen?', okText: 'Zurückziehen', danger: true })) return;
              try { await api('DELETE', `api/absences/${a.id}`); toast('Zurückgezogen.'); renderMyAbsences(); } catch (e) { toast(e.message, true); }
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
    api('GET', 'api/absences?status=beantragt'),
    api('GET', `api/absences?from=${from}&to=${to}`),
    api('GET', 'api/users'),
  ]);
  const decide = async (a, status) => {
    let note = '';
    if (status === 'abgelehnt') {
      note = await askReason(`Antrag auf ${typeLabel(a)} von ${a.name} (${range(a)}) ablehnen.`, true, { title: 'Antrag ablehnen', okText: 'Ablehnen' });
      if (note === null) return;
    } else {
      const extra = a.konflikte ? ` Achtung: ${a.name} ist in ${a.konflikte} Dienst(en) eingetragen. Diese werden ausgetragen.` : '';
      if (!await uiConfirm(`${typeLabel(a)} von ${a.name}: ${range(a)}, ${a.arbeitstage} Arbeitstage.${extra}`, { title: 'Genehmigen?', okText: 'Genehmigen' })) return;
    }
    try {
      const r = await api('PUT', `api/absences/${a.id}/decision`, { status, note });
      toast(status === 'genehmigt' ? `Genehmigt.${r.removed ? ` ${r.removed} Dienst(e) ausgetragen.` : ''}` : 'Abgelehnt.');
    } catch (e) { toast(e.message, true); }
    refresh();
  };
  const sick = inMonth.absences.filter((a) => a.type === 'krank');
  const vac = inMonth.absences.filter((a) => a.type !== 'krank' && a.status !== 'beantragt');
  const auMissing = (await api('GET', 'api/absences')).absences.filter((a) => a.au_ueberfaellig);
  setMain(
    h('div', { class: 'card' }, h('h2', {}, `Offene Anträge (${open.absences.length})`),
      open.absences.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Mitarbeiter/in', 'Art', 'Zeitraum', 'Arbeitstage', 'Bemerkung / Anlass', 'eingetragen in', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, open.absences.map((a) => h('tr', {},
          h('td', {}, a.name, h('div', { class: 'small muted' }, a.qualification)), h('td', {}, typeLabel(a)), h('td', {}, range(a)), h('td', { class: 'num' }, a.arbeitstage),
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
              if (!await uiConfirm(`Krankmeldung von ${a.name} (${range(a)}). Hochgeladene Bescheinigungen werden ebenfalls gelöscht.`, { title: 'Krankmeldung löschen?', okText: 'Löschen', danger: true })) return;
              try { await api('DELETE', `api/absences/${a.id}`); toast('Gelöscht.'); refresh(); } catch (e) { toast(e.message, true); }
            } }, 'Löschen')))))))
        : h('p', { class: 'muted' }, 'Keine.'),
      h('h3', {}, `Urlaub und Sonderurlaub (${vac.length})`),
      vac.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Mitarbeiter/in', 'Art', 'Zeitraum', 'Arbeitstage', 'Status', 'Bemerkung', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, vac.map((a) => h('tr', {},
          h('td', {}, a.name), h('td', {}, typeLabel(a)), h('td', {}, range(a)), h('td', { class: 'num' }, a.arbeitstage), h('td', {}, statusBadge(a)),
          h('td', {}, a.note, a.decision_note ? h('div', { class: 'small muted' }, a.decision_note) : null),
          h('td', {}, h('button', { class: 'tiny danger', onclick: async () => {
            if (!await uiConfirm(`${typeLabel(a)} von ${a.name} (${range(a)})`, { title: 'Eintrag löschen?', okText: 'Löschen', danger: true })) return;
            try { await api('DELETE', `api/absences/${a.id}`); toast('Gelöscht.'); refresh(); } catch (e) { toast(e.message, true); }
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
  'user.rights': 'Verwaltungsrechte geändert', 'user.create': 'Person angelegt',
};
async function renderLog() {
  const rows = await api('GET', 'api/log?limit=300');
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
          : r.details.from ? `${ABS_LABEL[r.details.type] || ''} ${fmtDate(r.details.from)} – ${fmtDate(r.details.to)}` : '–'),
        h('td', {}, r.actor),
        h('td', {}, r.reason || (r.details.filename ? r.details.filename : '')
          || (r.action === 'user.rights' ? (r.details.role === 'manager' ? 'Hauptverwaltung'
            : `${RECHTE_LABEL[r.details.rechte] || (r.details.rechte === 'keine' ? 'Rechte entzogen' : 'geändert')}${r.details.bis ? ` bis ${fmtDate(r.details.bis)}` : ''}`) : '–')))))))));
}

// ---------- Zwei-Faktor-Anmeldung ----------
function authShell(...children) {
  hideAppChrome();
  setMain(h('section', { class: 'login card' }, children));
}

async function cancelLogin() {
  await api('POST', 'api/logout').catch(() => {});
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
      const r = await api('POST', 'api/login/2fa', { code: input.value });
      if (r.used_recovery) {
        await uiAlert(`Sie haben sich mit einem Wiederherstellungscode angemeldet. Noch ${r.user.recovery_left} Codes übrig.\n\n`
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
async function renderSetup(inApp, neu = false) {
  let data;
  try { data = await api('POST', 'api/2fa/setup', neu ? { neu: true } : undefined); } catch (e) { if (!inApp) renderLogin(); else toast(e.message, true); return; }
  const input = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', required: true, placeholder: '123456', maxlength: 6, class: 'code-input' });
  const err = h('p', { class: 'error' });
  const form = h('form', {}, h('label', {}, '3. Angezeigten Code eingeben', input), h('button', { type: 'submit' }, 'Aktivieren'), err);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const r = await api('POST', 'api/2fa/enable', { code: input.value });
      showRecoveryCodes(r.recovery_codes, inApp ? () => go('account') : boot);
    } catch (e) { err.textContent = e.message; input.select(); }
  });
  const rawSecret = data.secret.replace(/\s/g, '');
  const copyKey = () => navigator.clipboard.writeText(rawSecret)
    .then(() => toast('Schlüssel kopiert. In der Authenticator-App „Schlüssel eingeben“ wählen und einfügen.'))
    .catch(() => toast('Kopieren nicht möglich – bitte den Schlüssel abtippen.', true));
  const onThisPhone = isPhone() || window.matchMedia('(pointer: coarse)').matches;
  const phoneWay = h('div', { class: 'setup-phone' },
    h('a', { class: 'button-link', href: data.uri }, '📲 In Authenticator-App öffnen'),
    h('p', { class: 'small muted' }, 'Die App öffnet sich und fragt, ob das Konto hinzugefügt werden soll. Bestätigen, dann hierher ',
      'zurückwechseln und den 6-stelligen Code eingeben.'),
    h('details', {}, h('summary', { class: 'small' }, 'App öffnet sich nicht? Schlüssel von Hand eingeben'),
      h('p', { class: 'small' }, 'In der App „Konto hinzufügen“ → „Schlüssel eingeben“ (bzw. „Einrichtungsschlüssel“) wählen:'),
      h('div', { class: 'key-row' }, h('code', { class: 'secret' }, data.secret), h('button', { type: 'button', class: 'tiny', onclick: copyKey }, 'Kopieren')),
      h('p', { class: 'small muted' }, `Kontoname: ${state.branding?.klinik_name || 'Dienstplan'} · Typ: zeitbasiert · 6 Stellen`)));
  const qrWay = h('div', {},
    h('div', { class: 'qr' }, h('img', { src: data.qr, alt: 'QR-Code für die Authenticator-App', width: 220, height: 220 })),
    h('details', {}, h('summary', { class: 'small' }, 'QR-Code lässt sich nicht scannen?'),
      h('p', { class: 'small' }, 'Schlüssel manuell eingeben (zeitbasiert, 6 Stellen):'),
      h('div', { class: 'key-row' }, h('code', { class: 'secret' }, data.secret), h('button', { type: 'button', class: 'tiny', onclick: copyKey }, 'Kopieren'))));
  const content = [
    h('h1', {}, 'Zwei-Faktor-Anmeldung einrichten'),
    !inApp ? h('p', { class: 'muted' }, 'Zum Schutz der Dienstplan- und Personaldaten ist ein zweiter Faktor vorgeschrieben. Die Einrichtung dauert etwa eine Minute.') : null,
    h('ol', { class: 'steps' },
      h('li', {}, 'Installieren Sie eine Authenticator-App auf Ihrem Handy, z. B. ', h('strong', {}, 'Google Authenticator'), ', ',
        h('strong', {}, 'Microsoft Authenticator'), ', ', h('strong', {}, '2FAS'), ' oder ', h('strong', {}, 'FreeOTP'), ' (kostenlos im App Store / Play Store).'),
      onThisPhone
        ? h('li', {}, 'Konto in die App übernehmen:', phoneWay,
          h('details', {}, h('summary', { class: 'small' }, 'Einrichtung lieber mit QR-Code (z. B. am PC)?'), qrWay))
        : h('li', {}, 'Scannen Sie in der App diesen QR-Code:', qrWay,
          h('p', { class: 'small muted' }, 'Sie sind schon am Handy mit der App? Dann ', h('a', { href: data.uri }, 'hier tippen'), ', um das Konto direkt zu übernehmen.'))),
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
async function refreshMe() {
  const { user } = await api('GET', 'api/me');
  state.me = user;
  renderWho();
}
function renderWho() {
  const rolle = state.me.is_haupt ? 'Hauptverwaltung' : state.me.admin_rechte === 'vertretung' && isMgr() ? `Vertretung bis ${fmtDate(state.me.admin_bis)}`
    : isMgr() ? 'Verwaltung' : 'Mitarbeiter/in';
  document.getElementById('who').replaceChildren(h('span', { class: 'person', title: `${state.me.name} (${rolle})` }, avatar(state.me, 28),
    h('span', { class: 'who-name' }, `${state.me.name} (${rolle})`)));
}

async function renderAccount() {
  const { user, settings } = await api('GET', 'api/me');
  state.me = user; state.settings = settings;
  const form = h('form', { class: 'card', style: { maxWidth: '480px' } }, h('h2', {}, 'Passwort ändern'),
    h('label', {}, 'Aktuelles Passwort', h('input', { name: 'old_password', type: 'password', required: true, autocomplete: 'current-password' })),
    h('label', {}, 'Neues Passwort (mind. 8 Zeichen)', h('input', { name: 'new_password', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' })),
    h('p', {}, h('button', { type: 'submit' }, 'Ändern')));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try { await api('POST', 'api/me/password', Object.fromEntries(new FormData(form))); toast('Passwort geändert.'); form.reset(); } catch (e) { toast(e.message, true); }
  });

  const askCode = (question) => uiPrompt({ title: question, label: 'Aktueller Code aus der Authenticator-App', inputmode: 'numeric',
    placeholder: '123456', required: true, autocomplete: 'one-time-code', okText: 'Bestätigen' });
  const twofa = h('div', { class: 'card', style: { maxWidth: '480px' } }, h('h2', {}, 'Zwei-Faktor-Anmeldung'),
    user.totp_enabled
      ? [h('p', {}, h('span', { class: 'badge ok' }, 'eingerichtet'), ` · ${user.recovery_left} Wiederherstellungscodes übrig`),
        h('div', { class: 'toolbar' },
          h('button', { class: 'ghost', onclick: async () => {
            const code = await askCode('Neue Wiederherstellungscodes erzeugen? Die alten werden ungültig.');
            if (!code) return;
            try { const r = await api('POST', 'api/2fa/recovery-codes', { code }); showRecoveryCodes(r.recovery_codes, () => go('account')); } catch (e) { toast(e.message, true); }
          } }, 'Neue Wiederherstellungscodes'),
          h('button', { class: 'ghost', onclick: async () => {
            if (await uiConfirm('Danach gilt nur noch der neue Schlüssel; die App auf dem alten Handy funktioniert nicht mehr.', { title: 'Neues Handy einrichten?', okText: 'Weiter' })) renderSetup(true, true);
          } }, 'Neues Handy einrichten'),
          !settings.zwei_faktor_pflicht ? h('button', { class: 'danger', onclick: async () => {
            const code = await askCode('Zwei-Faktor-Anmeldung deaktivieren?');
            if (!code) return;
            try { await api('POST', 'api/2fa/disable', { code }); toast('Deaktiviert.'); renderAccount(); } catch (e) { toast(e.message, true); }
          } }, 'Deaktivieren') : null)]
      : [h('p', {}, h('span', { class: 'badge warn' }, 'nicht eingerichtet')),
        h('p', {}, h('button', { onclick: () => renderSetup(true) }, 'Jetzt einrichten'))]);
  const profil = h('div', { class: 'card', style: { maxWidth: '480px' } }, h('h2', {}, 'Mein Foto'),
    fotoControl(user, 'api/me/foto', async () => { await refreshMe(); renderAccount(); }));
  setMain(profil, form, twofa);
}

// Als App installierbar (Startbildschirm); der Service Worker speichert nur die Programmdateien, keine Personaldaten
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

loadBranding().then(boot);
