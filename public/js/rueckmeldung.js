'use strict';
/* Rückmeldung (Pilotbetrieb): Fehler, Ideen, Lob, Fragen */

const RM_ART = { fehler: '🐞 Fehler', idee: '💡 Idee', lob: '👍 Lob', frage: '❓ Frage' };
const RM_STATUS = { neu: ['neu', 'warn'], in_arbeit: ['in Arbeit', ''], erledigt: ['erledigt', 'ok'] };

async function renderRueckmeldung() {
  const haupt = !!state.me.is_haupt && !isDemo();
  const [meine, alle] = await Promise.all([
    isDemo() ? Promise.resolve([]) : api('GET', 'api/rueckmeldungen'),
    haupt ? api('GET', 'api/rueckmeldungen?alle=1') : Promise.resolve(null),
  ]);
  const form = h('form', { class: 'card rm-form' }, h('h2', {}, 'Rückmeldung geben'),
    h('p', { class: 'small muted' }, 'Etwas funktioniert nicht, ist umständlich oder Sie haben eine Idee? Schreiben Sie es kurz auf – die Rückmeldung geht an die Einsatzplanung.',
      isDemo() ? ' Auch aus dem Demo-Bereich kommen Rückmeldungen bei der Verwaltung an.' : ''),
    h('fieldset', { class: 'rm-arten' }, h('legend', {}, 'Art'),
      Object.entries(RM_ART).map(([v, l], i) => h('label', { class: 'rm-art' }, h('input', { type: 'radio', name: 'art', value: v, checked: i === 1 }), l))),
    h('label', {}, 'Ihre Nachricht', h('textarea', { name: 'text', rows: 5, required: true, minlength: 5, maxlength: 2000, placeholder: 'z. B. „Beim Tausch sehe ich nicht, wer übernommen hat …“' })),
    h('button', { type: 'submit' }, 'Absenden'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    try {
      await api('POST', 'api/rueckmeldung', { ...fd, ansicht: state.vorherigeAnsicht || '' });
      toast('Danke! Ihre Rückmeldung ist angekommen.');
      renderRueckmeldung();
    } catch (err) { toast(err.message, true); }
  });
  const eintrag = (r, verwaltung) => h('li', { class: 'rm-eintrag' },
    h('div', { class: 'rm-kopf' }, h('strong', {}, RM_ART[r.art]), h('span', { class: `badge ${RM_STATUS[r.status][1]}` }, RM_STATUS[r.status][0]),
      h('span', { class: 'small muted' }, `${fmtDate(r.created_at.slice(0, 10))}${verwaltung ? ` · ${r.name || 'unbekannt'}${r.quelle === 'demo' ? ' · Demo' : ''}${r.geraet ? ` · ${r.geraet}` : ''}${r.ansicht ? ` · Ansicht „${r.ansicht}“` : ''}` : ''}`)),
    h('p', { class: 'rm-text' }, r.text),
    r.antwort ? h('p', { class: 'rm-antwort' }, h('strong', {}, 'Antwort: '), r.antwort, r.beantwortet_von_name ? h('span', { class: 'small muted' }, ` – ${r.beantwortet_von_name}`) : null) : null,
    verwaltung ? h('div', { class: 'toolbar' },
      h('select', { 'aria-label': 'Status', onchange: async (e) => { try { await api('PUT', `api/rueckmeldungen/${r.id}`, { status: e.target.value }); renderRueckmeldung(); } catch (err) { toast(err.message, true); } } },
        Object.entries(RM_STATUS).map(([v, [l]]) => h('option', { value: v, selected: v === r.status }, l))),
      h('button', { class: 'tiny ghost', onclick: async () => {
        const antwort = await uiPrompt({ title: 'Antworten', message: r.user_id ? 'Die Antwort erscheint bei der Person als Mitteilung.' : 'Rückmeldung aus dem Demo-Bereich – die Antwort wird nur hier gespeichert.', label: 'Antwort', value: r.antwort, multiline: true, required: true });
        if (antwort === null) return;
        try { await api('PUT', `api/rueckmeldungen/${r.id}`, { antwort, status: r.status === 'neu' ? 'in_arbeit' : r.status }); renderRueckmeldung(); } catch (err) { toast(err.message, true); }
      } }, r.antwort ? 'Antwort ändern' : 'Antworten')) : null);
  const zaehl = (st) => (alle || []).filter((r) => r.status === st).length;
  setMain(form,
    meine.length ? h('div', { class: 'card' }, h('h2', {}, 'Meine Rückmeldungen'), h('ul', { class: 'rm-liste' }, meine.map((r) => eintrag(r, false)))) : null,
    alle ? h('div', { class: 'card' }, h('h2', {}, `Alle Rückmeldungen (${zaehl('neu')} neu, ${zaehl('in_arbeit')} in Arbeit)`),
      alle.length ? h('ul', { class: 'rm-liste' }, alle.map((r) => eintrag(r, true))) : h('p', { class: 'muted' }, 'Noch keine Rückmeldungen.')) : null);
}
