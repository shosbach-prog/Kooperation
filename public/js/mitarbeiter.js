'use strict';
/* Meine Dienste, Stundenkonto, Auswertung, Plan erzeugen */

// ---------- Meine Dienste (Mitarbeitende) ----------
async function renderMine() {
  const from = todayIso();
  const shifts = await api('GET', `api/my-shifts?from=${from}&to=${addDays(from, 120)}`);
  const s = state.settings;
  const zeiten = await zeitenCard(renderMine).catch(() => null);
  setMain(zeiten, h('div', { class: 'card' },
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
    ['soll', 'Soll', true], ['gearbeitet', 'Gearbeitet', true], ['urlaub_std', 'Urlaub', true], ['sonder_std', 'Sonderurlaub', true], ['fortbildung_std', 'Fortbildung', true], ['krank_std', 'Krank', true],
    ['unbezahlt_tage', 'unbezahlt (Tage)', true, 0],
    ['ist', 'Ist gesamt', true], ['saldo', 'Saldo', true],
    ...(withName ? [['min_hours_month', 'Mindest-Std.', true]] : []),
    ['dienste', 'Dienste', true, 0], ['nachtschichten', 'Nachtschichten', true, 0],
    ['nacht', 'Nacht', true], ['samstag', 'Samstag', true], ['sonntag', 'Sonntag', true], ['feiertag', 'Feiertag', true], ['vorfest', '24./31.12.', true],
    ['ueberstunden', 'Mehr-/Minderzeit', true], ['bereitschaft_std', 'Bereitschaft (gewertet)', true], ['ruf_dienste', 'Rufbereitschaften', true, 0], ['ruf_einsatz_std', 'Ruf-Einsatz', true], ['ruf_eur', 'Ruf-Pauschale €', true],
    ['zuschlag_eur', 'Zuschläge €', true], ['zulage', 'Zulage', false], ['zulage_eur', 'Zulage €', true],
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
  const [r, exp, units, abschluss] = await Promise.all([api('GET', `api/report?month=${state.month}`), exportCard(), api('GET', 'api/units'), abschlussCard()]);
  const lf = listenFilter('report', units, renderReport);
  const rows = r.rows.filter((x) => lf.passt(x.name, x.stammbereich_id));
  setMain(abschluss, exp, h('div', { class: 'card' },
    h('div', { class: 'toolbar' },
      h('label', {}, 'Monat', h('input', { type: 'month', value: state.month, onchange: (e) => { state.month = e.target.value; renderReport(); } })),
      ...lf.leiste,
      h('span', { class: 'spacer' }),
      h('a', { href: `api/report.csv?month=${state.month}` }, h('button', { class: 'ghost' }, 'CSV-Export (Excel)'))),
    rows.length < r.rows.length ? h('p', { class: 'small muted' }, `${rows.length} von ${r.rows.length} Personen angezeigt (Station nach Stammbereich).`) : null,
    zuschlagTable(rows, true),
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
  const units = (await api('GET', 'api/units')).filter((u) => u.active && canManageUnit(u.id));
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
    }, 'Schichten erzeugen'))),
  planvorschlagCard(fromI, toI, checks));
}

/** Automatischer Planvorschlag: Vorschau mit Begründung, Auswahl, Übernahme */
function planvorschlagCard(fromI, toI, checks) {
  const result = h('div');
  const card = h('div', { class: 'card' }, h('h2', {}, 'Planvorschlag'),
    h('p', { class: 'muted' }, 'Füllt Dienste unter der Mindestbesetzung automatisch und fair auf – mit denselben Regeln wie beim Eintragen ',
      '(Abwesenheit, „Wunsch frei“, Ruhezeit, Arbeitszeitregeln, Qualifikation, Soll-Stunden). Sie sehen zuerst eine Vorschau und entscheiden dann.'),
    h('p', {}, h('button', { onclick: async () => {
      const ids = checks.map((c) => c.querySelector('input')).filter((c) => c.checked).map((c) => Number(c.value));
      result.replaceChildren(h('p', { class: 'muted' }, 'Berechne …'));
      try {
        const r = await api('POST', 'api/planvorschlag', { from: fromI.value, to: toI.value, unit_ids: ids });
        showVorschlag(result, r);
      } catch (e) { result.replaceChildren(); toast(e.message, true); }
    } }, 'Vorschlag berechnen')),
    result);
  return card;
}

function showVorschlag(target, r) {
  const boxes = r.vorschlaege.map((v) => h('input', { type: 'checkbox', checked: true, 'aria-label': `${v.name} am ${fmtDate(v.date)} übernehmen` }));
  const all = h('input', { type: 'checkbox', checked: true, 'aria-label': 'alle auswählen', onchange: (e) => boxes.forEach((b) => { b.checked = e.target.checked; }) });
  const perPerson = new Map();
  for (const v of r.vorschlaege) perPerson.set(v.name, (perPerson.get(v.name) || 0) + 1);
  target.replaceChildren(
    h('div', { class: 'toolbar' },
      h('span', { class: 'badge ok' }, `${r.vorschlaege.length} Vorschläge`),
      r.offen.length ? h('span', { class: 'badge bad' }, `${r.offen.length} Dienste bleiben offen`) : h('span', { class: 'badge ok' }, 'alle Lücken gefüllt'),
      h('span', { class: 'small muted' }, [...perPerson].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`).join(' · '))),
    r.vorschlaege.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'keep-table' },
      h('thead', {}, h('tr', {}, h('th', {}, all), ...['Datum', 'Dienst', 'Station', 'Person', 'Begründung'].map((x) => h('th', {}, x)))),
      h('tbody', {}, r.vorschlaege.map((v, i) => h('tr', {},
        h('td', {}, boxes[i]), h('td', {}, `${WD[weekday(v.date)]} ${fmtDate(v.date)}`),
        h('td', {}, h('span', { class: 'chip', style: { background: v.type_color } }, v.type_code), v.type_name),
        h('td', {}, v.unit_name), h('td', {}, v.name, v.qualification ? h('div', { class: 'small muted' }, v.qualification) : null),
        h('td', { class: 'small' }, v.grund)))))) : null,
    r.offen.length ? h('details', {}, h('summary', {}, `Offen gebliebene Dienste (${r.offen.length})`),
      h('ul', { class: 'small' }, r.offen.map((o) => h('li', {}, `${WD[weekday(o.date)]} ${fmtDate(o.date)} · ${o.type_name} · ${o.unit_name}: fehlt ${o.fehlt}`))),
      h('p', { class: 'small muted' }, 'Tipp: Rundruf (📣) im Dienstplan nutzen oder Mindestbesetzung bzw. Wünsche prüfen.')) : null,
    r.vorschlaege.length ? h('div', { class: 'toolbar', style: { marginTop: '.75rem' } }, h('button', { onclick: async () => {
      const items = r.vorschlaege.filter((_, i) => boxes[i].checked).map((v) => ({ shift_id: v.shift_id, user_id: v.user_id }));
      if (!items.length) return toast('Nichts ausgewählt.', true);
      if (!await uiConfirm(`${items.length} Dienste eintragen? Die Personen werden benachrichtigt.`, { title: 'Vorschlag übernehmen?', okText: 'Übernehmen' })) return;
      try {
        const res = await api('POST', 'api/planvorschlag/uebernehmen', { items });
        toast(`${res.eingetragen} Dienste eingetragen${res.fehler.length ? `, ${res.fehler.length} übersprungen (inzwischen geändert)` : ''}.`);
        target.replaceChildren(h('p', {}, `✓ ${res.eingetragen} Dienste eingetragen. `, h('a', { href: '#plan' }, 'Zum Dienstplan')));
      } catch (e) { toast(e.message, true); }
    } }, 'Ausgewählte übernehmen')) : null);
  stackTables(target);
}
