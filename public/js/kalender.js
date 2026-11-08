'use strict';
/* Kalender-Abo: eigene Dienste im Handy-/PC-Kalender */

async function kalenderCard() {
  let token;
  try { ({ token } = await api('GET', 'api/me/ical')); } catch (e) { return h('div', { class: 'card' }, h('p', { class: 'error' }, e.message)); }
  const https = new URL(`api/ical/${token}.ics`, location.href).href;
  const webcal = https.replace(/^https?:/, 'webcal:');
  const copy = () => navigator.clipboard.writeText(https).then(() => toast('Link kopiert.'), () => toast('Kopieren nicht möglich – bitte Link markieren.', true));
  return h('div', { class: 'card', style: { maxWidth: '640px' } }, h('h2', {}, 'Dienste im Kalender'),
    h('p', { class: 'muted' }, 'Ihre Dienste und Abwesenheiten erscheinen automatisch im Kalender Ihres Handys oder PCs und aktualisieren sich selbst (je nach Kalender alle 1–24 Stunden).'),
    h('div', { class: 'toolbar' },
      h('a', { class: 'button-link', href: webcal, style: { display: 'inline-block', margin: 0 } }, '📅 Kalender abonnieren'),
      h('button', { type: 'button', class: 'ghost', onclick: copy }, 'Link kopieren')),
    h('details', {}, h('summary', {}, 'Anleitung für iPhone, Android, Outlook'),
      h('ul', { class: 'small' },
        h('li', {}, h('strong', {}, 'iPhone/iPad: '), '„Kalender abonnieren“ antippen → „Abonnieren“ bestätigen.'),
        h('li', {}, h('strong', {}, 'Android (Google Kalender): '), '„Link kopieren“, dann am PC unter calendar.google.com → „Weitere Kalender +“ → „Per URL“ einfügen. Er erscheint danach auch auf dem Handy.'),
        h('li', {}, h('strong', {}, 'Outlook: '), 'Kalender hinzufügen → „Aus dem Internet“ bzw. „Aus dem Web abonnieren“ → Link einfügen.'))),
    h('p', { class: 'small muted' }, 'Der Link ist persönlich: Wer ihn kennt, sieht Ihre Dienstzeiten. Geben Sie ihn nicht weiter. Falls doch, erzeugen Sie hier einen neuen – der alte funktioniert dann nicht mehr.'),
    h('button', { type: 'button', class: 'ghost', onclick: async () => {
      if (!await uiConfirm('Bisherige Kalender-Abos funktionieren danach nicht mehr und müssen neu eingerichtet werden.', { title: 'Neuen Link erzeugen?', okText: 'Neuen Link erzeugen', danger: true })) return;
      try { await api('POST', 'api/me/ical/renew'); toast('Neuer Link erzeugt.'); renderAccount(); } catch (e) { toast(e.message, true); }
    } }, 'Neuen Link erzeugen'));
}
