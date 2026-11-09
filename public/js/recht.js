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
    h('div', { class: 'legal-text', tabindex: '0', role: 'region', 'aria-label': title }, textBlocks(text)),
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
      h('button', { class: 'ghost', type: 'button', onclick: () => showLegal('impressum') }, 'Impressum')),
    androidAppHinweis());
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

/** Karte „Beispieldaten entfernen“ in den Einstellungen (nur wenn welche vorhanden sind) */
async function beispieldatenCard() {
  let d;
  try { d = await api('GET', 'api/admin/beispieldaten'); } catch { return null; }
  if (!d.personen.length) return null;
  return h('div', { class: 'card warn-card' }, h('h2', {}, `Beispieldaten entfernen (${d.personen.length} Personen)`),
    h('p', { class: 'small' }, 'Diese Personen stammen aus den Beispieldaten der Ersteinrichtung (Passwort „demo123“) oder sind Demo-Gäste. ',
      'Vor dem Echtbetrieb sollten sie entfernt werden – zusammen mit ihren Diensten, Abwesenheiten, Wünschen und Stempelzeiten.'),
    h('p', { class: 'small muted' }, d.personen.map((p) => `${p.name}${p.dienste ? ` (${p.dienste} Dienste)` : ''}`).join(', ')),
    h('button', { class: 'danger', onclick: async () => {
      if (!await uiConfirm(`${d.personen.length} Beispielpersonen und alle ihre Einträge endgültig löschen? Das kann nicht rückgängig gemacht werden (außer über eine Sicherung).`,
        { title: 'Beispieldaten entfernen?', okText: 'Endgültig entfernen', danger: true })) return;
      try { const r = await api('POST', 'api/admin/beispieldaten/entfernen', { ids: d.personen.map((p) => p.id) }); toast(`${r.entfernt} Beispielpersonen entfernt.`); renderSettings(); } catch (e) { toast(e.message, true); }
    } }, 'Beispielpersonen entfernen'),
    h('p', { class: 'small muted' }, 'Beispiel-Stationen und -Dienstzeiten können Sie unter „Campus & Stationen“ bzw. „Dienstzeiten“ umbenennen oder deaktivieren.'));
}

// ---------- Android-App ----------
const inAndroidApp = (() => {
  try {
    const q = new URLSearchParams(location.search);
    // Ab App-Version 3 übergibt die APK ihre Versionsnummer (?app=3); ältere Versionen erkennt man am Aufrufer
    if (q.has('app')) {
      localStorage.setItem('pep.appVersion', String(Number(q.get('app')) || 0));
      sessionStorage.setItem('pep.inApp', '1');
      q.delete('app');
      history.replaceState(null, '', location.pathname + (q.toString() ? `?${q}` : '') + location.hash);
    } else if (document.referrer.startsWith('android-app://')) {
      sessionStorage.setItem('pep.inApp', '1');
      if (!localStorage.getItem('pep.appVersion')) localStorage.setItem('pep.appVersion', '2');
    }
    return sessionStorage.getItem('pep.inApp') === '1';
  } catch { return false; }
})();

/** In der Android-App: Hinweis, wenn eine neuere APK bereitsteht (wird automatisch gebaut, siehe .github/workflows) */
async function appUpdateHinweis() {
  if (!inAndroidApp) return;
  try {
    if (sessionStorage.getItem('pep.appUpdateZu') === '1') return;
    const installiert = Number(localStorage.getItem('pep.appVersion')) || 0;
    const neu = await fetch('app-version.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null));
    if (!neu || !installiert || neu.versionCode <= installiert) return;
    const leiste = h('div', { class: 'app-update', role: 'status' },
      h('span', {}, `Neue App-Version ${neu.versionName} verfügbar.`),
      h('a', { href: 'dienstplan.apk', download: `Dienstplan-${neu.versionName}.apk`, class: 'button' }, 'Herunterladen'),
      h('button', { type: 'button', class: 'ghost tiny', 'aria-label': 'Hinweis schließen', onclick: () => { try { sessionStorage.setItem('pep.appUpdateZu', '1'); } catch { /* egal */ } leiste.remove(); } }, '✕'));
    document.body.append(leiste);
  } catch { /* ohne Netz: nichts anzeigen */ }
}
appUpdateHinweis();
/** Hinweis „Android-App herunterladen“ – nur auf Android-Geräten im Browser, nicht in der App selbst */
function androidAppHinweis() {
  if (inAndroidApp || !/Android/i.test(navigator.userAgent)) return null;
  return h('p', { class: 'small android-app' }, h('a', { href: 'dienstplan.apk', download: 'Dienstplan.apk' }, '📱 Android-App herunterladen'),
    h('span', { class: 'muted' }, ' – Installation: Datei öffnen und „Installieren“ tippen (ggf. „Unbekannte Apps installieren“ für den Browser erlauben).'));
}
