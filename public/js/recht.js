'use strict';
/* Impressum, Datenschutzhinweise, Auskunft über eigene Daten, Löschfristen */

/** Klartext (Absätze durch Leerzeilen) sicher als HTML-Knoten darstellen; Zeilen ohne Punkt am Ende vor einem Absatz werden Zwischenüberschriften */
function textBlocks(text) {
  return String(text || '').split(/\n\s*\n/).map((para) => {
    const lines = para.split('\n');
    if (lines.length > 1 && lines[0].length < 80 && !/[.:;,]$/.test(lines[0])) {
      return [h('h3', {}, lines[0]), h('p', {}, lines.slice(1).flatMap((l, i) => (i ? [h('br'), l] : [l])))];
    }
    return h('p', {}, lines.flatMap((l, i) => (i ? [h('br'), l] : [l])));
  });
}

async function showLegal(kind) {
  let l;
  try { l = await api('GET', 'api/legal'); } catch (e) { toast(e.message, true); return; }
  const title = kind === 'impressum' ? 'Impressum' : 'Datenschutzhinweise';
  const text = kind === 'impressum' ? (l.impressum || 'Das Impressum wurde noch nicht hinterlegt (Einstellungen → Impressum).') : l.datenschutz;
  await openDialog((close) => h('div', { class: 'ui-dialog-body legal' },
    h('h2', {}, title),
    kind !== 'impressum' && l.datenschutz_muster ? h('p', {}, h('span', { class: 'badge warn' }, 'Muster – noch nicht freigegeben')) : null,
    h('div', { class: 'legal-text' }, textBlocks(text)),
    h('div', { class: 'ui-dialog-actions' }, h('button', { type: 'button', onclick: () => close(null) }, 'Schließen'))));
}

function legalLinks() {
  const a = (kind, label) => h('a', { href: `#${kind}`, onclick: (e) => { e.preventDefault(); showLegal(kind); } }, label);
  return h('p', { class: 'small legal-links' }, a('impressum', 'Impressum'), ' · ', a('datenschutz', 'Datenschutz'));
}

/** Karte „Meine Daten“ im Profil */
function datenCard() {
  return h('div', { class: 'card', style: { maxWidth: '480px' } }, h('h2', {}, 'Meine Daten'),
    h('p', { class: 'small muted' }, 'Sie können jederzeit eine Kopie aller über Sie gespeicherten Daten herunterladen (Auskunft nach Art. 15 DSGVO).'),
    h('div', { class: 'toolbar' },
      h('a', { href: 'api/me/export', download: '' }, h('button', { class: 'ghost', type: 'button' }, 'Meine Daten herunterladen')),
      h('button', { class: 'ghost', type: 'button', onclick: () => showLegal('datenschutz') }, 'Datenschutzhinweise'),
      h('button', { class: 'ghost', type: 'button', onclick: () => showLegal('impressum') }, 'Impressum')));
}

/** Karte „Löschlauf“ in den Einstellungen */
function cleanupCard() {
  return h('div', { class: 'card' }, h('h2', {}, 'Löschfristen'),
    h('p', { class: 'small muted' }, 'Abgelaufene Daten werden täglich automatisch gelöscht (Fristen oben unter Einstellungen). Sie können den Löschlauf auch sofort starten.'),
    h('button', { class: 'ghost', onclick: async () => {
      try {
        const r = await api('POST', 'api/admin/cleanup');
        toast(`Gelöscht: ${r.au} AU-Dateien, ${r.protokoll} Protokolleinträge, ${r.mitteilungen} Mitteilungen.`);
      } catch (e) { toast(e.message, true); }
    } }, 'Löschlauf jetzt starten'));
}
