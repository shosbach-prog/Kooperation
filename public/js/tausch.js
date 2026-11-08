'use strict';
/* Diensttausch-Börse */

const SWAP_STATUS = {
  offen: ['warn', 'offen'], angenommen: ['warn', 'wartet auf Bestätigung'], erledigt: ['ok', 'getauscht'],
  zurueckgezogen: ['bad', 'zurückgezogen'],
};

/** Eigenen Dienst in der Tauschbörse anbieten */
async function offerShift(s, userId) {
  const r = await uiForm({
    title: 'In der Tauschbörse anbieten',
    message: `${s.type_name} · ${WD[weekday(s.date)]} ${fmtDate(s.date)} · ${s.start_time}–${s.end_time} · ${s.unit_name}`,
    okText: 'Anbieten',
    fields: [{ name: 'note', label: 'Hinweis für Kolleginnen und Kollegen (optional)', type: 'textarea', rows: 2, maxlength: 300,
      placeholder: 'z. B. Tausche gern gegen einen Frühdienst' }],
  });
  if (!r) return false;
  try {
    await api('POST', 'api/swaps', { shift_id: s.id, note: r.note, user_id: userId && userId !== state.me.id ? userId : undefined });
    toast('Dienst angeboten. Ihre Kolleginnen und Kollegen werden benachrichtigt.');
    refreshBadges();
    return true;
  } catch (e) { toast(e.message, true); return false; }
}

async function renderTausch() {
  const [{ angebote, bestaetigung }, meine] = await Promise.all([
    api('GET', 'api/swaps'),
    isStaffRole() ? api('GET', `api/my-shifts?from=${todayIso()}&to=${addDays(todayIso(), 60)}`) : Promise.resolve([]),
  ]);
  const me = state.me.id;
  const offen = angebote.filter((o) => o.status === 'offen' && o.user_id !== me);
  const eigene = angebote.filter((o) => o.user_id === me && ['offen', 'angenommen'].includes(o.status));
  const warten = angebote.filter((o) => o.status === 'angenommen');
  const verlauf = angebote.filter((o) => ['erledigt', 'zurueckgezogen'].includes(o.status) && (o.user_id === me || o.taker_id === me));
  const angeboteneIds = new Set(eigene.map((o) => o.shift_id));

  const dienst = (o) => h('div', {}, h('span', { class: 'chip', style: { background: o.type_color } }, o.type_code),
    h('strong', {}, `${WD[weekday(o.date)]} ${fmtDate(o.date)}`), ` · ${o.start_time}–${o.end_time}`,
    h('div', { class: 'small muted' }, `${o.type_name} · ${o.unit_name}`));
  const table = (rows, cols) => h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, cols.map(([l]) => h('th', {}, l)))),
    h('tbody', {}, rows.map((o) => h('tr', {}, cols.map(([, f]) => f(o)))))));
  const act = (fn) => async () => { try { await fn(); } catch (e) { toast(e.message, true); } renderTausch(); refreshBadges(); };

  setMain(
    h('div', { class: 'card' }, h('h2', {}, 'Tauschbörse'),
      h('p', { class: 'muted', style: { margin: 0 } }, 'Dienste, die Kolleginnen und Kollegen abgeben möchten. Beim Übernehmen prüft das Programm Ruhezeit, Abwesenheit und Qualifikation. ',
        bestaetigung ? 'Ein Tausch wird erst nach Bestätigung durch die Verwaltung wirksam.' : 'Die Übernahme ist sofort wirksam.')),
    h('div', { class: 'card' }, h('h3', { style: { marginTop: 0 } }, `Angebote (${offen.length})`),
      offen.length ? table(offen, [
        ['Dienst', dienst], ['Von', (o) => h('td', {}, o.user_name, o.user_qualification ? h('div', { class: 'small muted' }, o.user_qualification) : null)],
        ['Hinweis', (o) => h('td', {}, o.note || '–')],
        ['', (o) => h('td', { class: 'actions' }, isStaffRole() ? h('button', { onclick: act(async () => {
          if (!await uiConfirm(`${o.type_name} am ${fmtDate(o.date)} (${o.unit_name}) von ${o.user_name} übernehmen?`, { title: 'Dienst übernehmen?', okText: 'Übernehmen' })) return;
          const r = await api('POST', `api/swaps/${o.id}/take`);
          toast(r.wartet ? 'Übernahme angefragt – die Verwaltung bestätigt.' : 'Dienst übernommen.');
        }) }, 'Übernehmen') : null,
        isMgr() ? h('button', { class: 'ghost', onclick: act(async () => {
          if (!await uiConfirm('Das Angebot wird entfernt.', { title: 'Angebot entfernen?', okText: 'Entfernen', danger: true })) return;
          await api('DELETE', `api/swaps/${o.id}`);
        }) }, 'Entfernen') : null)],
      ].map(([l, f]) => [l, (o) => { const c = f(o); return c.tagName === 'TD' ? c : h('td', {}, c); }]))
        : h('p', { class: 'muted' }, 'Zurzeit bietet niemand einen Dienst an.')),
    isMgr() && warten.length ? h('div', { class: 'card warn-card' }, h('h3', { style: { marginTop: 0 } }, `Zu bestätigen (${warten.length})`),
      table(warten, [
        ['Dienst', (o) => h('td', {}, dienst(o))], ['Von → an', (o) => h('td', {}, `${o.user_name} → ${o.taker_name}`)],
        ['', (o) => h('td', { class: 'actions' },
          h('button', { onclick: act(async () => { await api('POST', `api/swaps/${o.id}/decide`, { status: 'bestaetigt' }); toast('Tausch bestätigt.'); }) }, 'Bestätigen'),
          h('button', { class: 'danger', onclick: act(async () => {
            const note = await askReason(`Tausch von ${o.user_name} an ${o.taker_name} ablehnen.`, true, { title: 'Tausch ablehnen', okText: 'Ablehnen' });
            if (note === null) return;
            await api('POST', `api/swaps/${o.id}/decide`, { status: 'abgelehnt', note }); toast('Abgelehnt – das Angebot ist wieder offen.');
          }) }, 'Ablehnen'))],
      ])) : null,
    isStaffRole() ? h('div', { class: 'card' }, h('h3', { style: { marginTop: 0 } }, 'Meine Angebote'),
      eigene.length ? table(eigene, [
        ['Dienst', (o) => h('td', {}, dienst(o))],
        ['Status', (o) => h('td', {}, h('span', { class: `badge ${SWAP_STATUS[o.status][0]}` }, SWAP_STATUS[o.status][1]), o.taker_name ? h('div', { class: 'small muted' }, `an ${o.taker_name}`) : null)],
        ['', (o) => h('td', {}, h('button', { class: 'ghost', onclick: act(async () => { await api('DELETE', `api/swaps/${o.id}`); toast('Zurückgezogen.'); }) }, 'Zurückziehen'))],
      ]) : h('p', { class: 'muted' }, 'Sie bieten zurzeit keinen Dienst an.'),
      h('h3', {}, 'Einen meiner Dienste anbieten'),
      meine.filter((s) => !angeboteneIds.has(s.id)).length
        ? table(meine.filter((s) => !angeboteneIds.has(s.id)).slice(0, 20), [
          ['Dienst', (s) => h('td', {}, dienst({ ...s, type_code: s.type_code }))],
          ['', (s) => h('td', {}, h('button', { class: 'ghost', onclick: async () => { if (await offerShift(s)) renderTausch(); } }, 'Anbieten'))],
        ]) : h('p', { class: 'muted' }, 'Keine kommenden Dienste.')) : null,
    verlauf.length ? h('div', { class: 'card' }, h('h3', { style: { marginTop: 0 } }, 'Verlauf'),
      table(verlauf, [
        ['Dienst', (o) => h('td', {}, dienst(o))],
        ['', (o) => h('td', {}, h('span', { class: `badge ${SWAP_STATUS[o.status][0]}` }, SWAP_STATUS[o.status][1]),
          o.status === 'erledigt' ? h('div', { class: 'small muted' }, `${o.user_name} → ${o.taker_name}`) : null)],
      ])) : null);
}
