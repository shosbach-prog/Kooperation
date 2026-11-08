'use strict';
/* Symbole und Navigation */

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
  plan: { label: 'Dienstplan', icon: 'plan', group: 'mein', render: () => renderPlan() },
  mine: { label: 'Meine Dienste', short: 'Meine', icon: 'mine', group: 'mein', render: () => renderMine(), staff: true },
  abwesenheit: { label: 'Urlaub & Krank', short: 'Urlaub', icon: 'urlaub', group: 'mein', render: () => renderMyAbsences(), staff: true },
  konto: { label: 'Stundenkonto', short: 'Stunden', icon: 'konto', group: 'mein', render: () => renderKonto(), staff: true },
  account: { label: 'Mein Profil', short: 'Profil', icon: 'user', group: 'mein', render: () => renderAccount() },
  abwesenheiten: { label: 'Abwesenheiten', short: 'Anträge', icon: 'inbox', group: 'verw', render: () => renderAbsencesMgr(), mgr: true, badge: 'abwesenheiten' },
  staff: { label: 'Personal', icon: 'users', group: 'verw', render: () => renderStaff(), mgr: true },
  stationen: { label: 'Campus & Stationen', short: 'Campus', icon: 'campus', group: 'verw', render: () => renderStations(), mgr: true },
  generate: { label: 'Plan erzeugen', icon: 'wand', group: 'verw', render: () => renderGenerate(), mgr: true },
  types: { label: 'Dienstzeiten', icon: 'clock', group: 'verw', render: () => renderShiftTypes(), mgr: true },
  req: { label: 'Mindestbesetzung', icon: 'sliders', group: 'verw', render: () => renderRequirements(), mgr: true },
  report: { label: 'Auswertung TVöD', short: 'Auswertung', icon: 'chart', group: 'verw', render: () => renderReport(), mgr: true },
  log: { label: 'Protokoll', icon: 'log', group: 'verw', render: () => renderLog(), mgr: true },
  settings: { label: 'Einstellungen', icon: 'settings', group: 'verw', render: () => renderSettings(), mgr: true },
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
