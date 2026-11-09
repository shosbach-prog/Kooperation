'use strict';
/* Personaleinsatzplanung – Oberfläche (ohne Build-Schritt, reines JavaScript)
   Aufgeteilt in mehrere Skripte, die in fester Reihenfolge geladen werden (siehe index.html).
   Grundfunktionen: DOM-Helfer, API, Meldungen, Zustand, Tabellen */

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
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // kein Netz (Funkloch, Flugmodus): als „offline“ kennzeichnen
    const e = new Error('Keine Verbindung zum Server.');
    e.offline = true;
    throw e;
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    const e = new Error('Server gerade nicht erreichbar.');
    e.offline = true;
    throw e;
  }
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const authUrl = url.startsWith('api/login') || url.startsWith('api/2fa') || url.startsWith('api/passkeys/login') || url === 'api/me';
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
/** Verwaltung ohne Beschränkung auf einzelne Stationen */
const isFullMgr = () => isMgr() && !(state.me.admin_units || []).length;
/** darf die Verwaltung diese Station bearbeiten? */
const canManageUnit = (unitId) => isMgr() && (isFullMgr() || (state.me.admin_units || []).includes(Number(unitId)));
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
      [...tr.children].forEach((td, i) => {
        if (!heads[i]) return;
        td.dataset.label = heads[i];
        // Eingabefelder in Tabellenzellen bekommen die Spaltenüberschrift als Namen (Screenreader)
        for (const el of td.querySelectorAll('input, select, textarea')) {
          if (!el.hasAttribute('aria-label') && !el.closest('label') && !el.id) el.setAttribute('aria-label', heads[i]);
        }
      });
    }
  }
  // Scrollbare Bereiche per Tastatur erreichbar machen
  for (const sc of root.querySelectorAll('.table-wrap, .plan-scroll')) {
    if (sc.hasAttribute('tabindex')) continue;
    sc.setAttribute('tabindex', '0');
    sc.setAttribute('role', 'region');
    const head = sc.querySelector('h3, caption') || sc.closest('.card')?.querySelector('h2');
    sc.setAttribute('aria-label', head ? head.textContent.trim().slice(0, 60) : 'Tabelle');
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
    if (W < 760 || single || (W < 1280 && tooWide)) table.classList.add('as-cards');
    if (single && W >= 760) table.classList.add('single');
  }
}
let fitTimer;
window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(() => fitTables(), 150); });
