'use strict';
/* Demo-Modus: Rolle auf der Startseite wählen – ohne Passwort und Code */

const isDemo = () => !!state.branding?.demo;

async function demoAnmelden(url, body) {
  try {
    await api('POST', url, body);
    location.hash = '';
    await boot();
  } catch (e) { toast(e.message, true); }
}

function personButton(p) {
  return h('button', { type: 'button', class: 'demo-person', onclick: () => demoAnmelden('api/demo/login', { username: p.username }) },
    avatar(p, 40),
    h('span', { class: 'demo-person-text' }, h('strong', {}, p.name), h('span', { class: 'small muted' }, p.beschreibung)));
}

/** Direktaufruf von der Startseite (demo/?als=leitung | pflege | station): Rolle sofort übernehmen,
 *  auch wenn man in der Demo gerade mit einer anderen Rolle angemeldet ist. Liefert true, wenn erledigt. */
async function demoAutoLogin() {
  const als = new URLSearchParams(location.search).get('als');
  if (!isDemo() || !als) return false;
  history.replaceState(null, '', location.pathname);
  const wer = { leitung: 'manager', station: 'skrueger', pflege: 'abecker' }[als];
  if (!wer) return false;
  try { await api('POST', 'api/demo/login', { username: wer }); } catch { return false; }
  await boot();
  return true;
}

/** Ergänzt die Anmeldeseite um die Rollenauswahl; das normale Formular wandert in „Mit Passwort anmelden“ */
async function demoLogin(section) {
  section.classList.add('demo-login');
  let d;
  try { d = await api('GET', 'api/demo/personen'); } catch { return; }
  const form = section.querySelector('#login-form');
  const pk = section.querySelector('.passkey-login');
  const details = h('details', { class: 'demo-pw' }, h('summary', {}, 'Mit Benutzername und Passwort anmelden'));
  form.before(details);
  details.append(form);
  if (pk) details.append(pk);
  form.querySelector('[autofocus]')?.removeAttribute('autofocus');
  section.querySelector('.login-foot')?.remove();

  const neu = h('form', { class: 'demo-neu' });
  const rolle = h('select', { name: 'rolle' },
    h('option', { value: 'pflege' }, 'Pflegekraft'), h('option', { value: 'stationsleitung' }, 'Stationsleitung'), h('option', { value: 'pdl' }, 'Pflegedienstleitung (ganzer Campus)'));
  const qual = h('select', { name: 'qualification' }, d.qualifikationen.map((q) => h('option', { value: q }, q)));
  const station = h('select', { name: 'unit_id' }, d.stationen.map((s) => h('option', { value: s.id }, s.name)));
  const qualLabel = h('label', {}, 'Qualifikation', qual);
  const stationLabel = h('label', {}, 'Station', station);
  rolle.addEventListener('change', () => { const pdl = rolle.value === 'pdl'; qualLabel.hidden = pdl; stationLabel.hidden = pdl; });
  neu.append(...[
    h('label', {}, 'Ihr Name', h('input', { name: 'name', required: true, minlength: 2, maxlength: 60, placeholder: 'z. B. Maria Muster', autocomplete: 'off' })),
    h('label', {}, 'Ich bin …', rolle), qualLabel, d.stationen.length ? stationLabel : null,
    h('button', { type: 'submit' }, 'Anlegen und loslegen')].filter(Boolean));
  neu.addEventListener('submit', (e) => { e.preventDefault(); demoAnmelden('api/demo/person', Object.fromEntries(new FormData(neu))); });

  details.before(...[
    h('div', { class: 'demo-hinweis' }, h('span', { class: 'badge warn' }, 'Demo-Modus'),
      h('p', { class: 'small' }, 'Wählen Sie, wer Sie sind – Sie sind sofort angemeldet, ohne Passwort und ohne Code. Bitte keine echten Personen- oder Gesundheitsdaten eingeben.')),
    h('h2', { class: 'demo-h' }, 'Leitung'),
    h('div', { class: 'demo-grid' }, d.leitung.map(personButton)),
    h('h2', { class: 'demo-h' }, 'Pflege'),
    h('div', { class: 'demo-grid' }, d.pflege.map(personButton)),
    h('details', { class: 'demo-neu-wrap' }, h('summary', {}, '＋ Als neue Person ausprobieren'), neu),
    state.branding.live_link ? h('p', { class: 'demo-live' }, h('a', { href: state.branding.live_link }, '→ Zur Anmeldung mit echten Daten')) : null].filter(Boolean));
  details.remove(); // Passwort-Anmeldung gibt es im Demo-Bereich nicht – dafür die echte Anmeldung
}

/** In der App: Hinweis „Demo“ und schneller Rollenwechsel */
function demoWho() {
  document.body.classList.toggle('demo', isDemo());
  if (!isDemo()) return null;
  return h('button', { type: 'button', class: 'ghost tiny demo-switch', title: 'Demo: andere Rolle wählen', 'aria-label': 'Demo: Rolle wechseln', onclick: async () => {
    await api('POST', 'api/logout').catch(() => {});
    state.me = null; location.hash = ''; renderLogin();
  } }, h('span', { class: 'demo-lang', 'aria-hidden': 'true' }, 'Demo · Rolle wechseln'), h('span', { class: 'demo-kurz', 'aria-hidden': 'true' }, 'Demo ⇄'));
}

/** Startseite des Echtbetriebs: Demo mit einem Klick, darunter die normale Anmeldung */
function demoTeaser(section) {
  const link = state.branding.demo_link;
  const brand = section.querySelector('.login-brand');
  const rolle = (als, titel, text, ico) => h('a', { class: 'demo-rolle', href: `${link}?als=${als}` },
    icon(ico), h('span', {}, h('strong', {}, titel), h('span', { class: 'small' }, text)));
  brand.after(
    h('div', { class: 'demo-teaser' },
      h('h2', {}, 'Ausprobieren – ohne Anmeldung'),
      h('p', { class: 'small muted' }, 'Mit Beispieldaten, getrennt von den echten Daten. Einfach eine Rolle wählen:'),
      h('div', { class: 'demo-rollen' },
        rolle('leitung', 'Als Leitung', 'Pflegedienstleitung: Plan, Personal, Anträge, Auswertung', 'users'),
        rolle('pflege', 'Als Pflegekraft', 'Eigene Dienste, Urlaub, Tausch, Wünsche', 'user')),
      h('p', { class: 'small' }, h('a', { href: link }, 'Weitere Rollen (z. B. Stationsleitung) oder neue Person anlegen'))),
    h('h2', { class: 'login-echt' }, 'Anmelden mit echten Daten'));
}
