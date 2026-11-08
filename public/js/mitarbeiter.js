'use strict';
/* Meine Dienste, Stundenkonto, Auswertung, Plan erzeugen */

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
