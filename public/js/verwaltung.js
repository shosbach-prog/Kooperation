'use strict';
/* Dienstzeiten, Mindestbesetzung, Einstellungen */

// ---------- Dienstzeiten / Schichtarten (Manager) ----------
async function renderShiftTypes() {
  const [types, units] = await Promise.all([api('GET', 'api/shift-types'), api('GET', 'api/units')]);
  const typeRow = (t) => {
    const inp = (k, attrs) => h('input', { value: t?.[k] ?? '', ...attrs });
    const r = {
      name: inp('name', { placeholder: 'z. B. Frühdienst' }), code: inp('code', { size: 3, maxlength: 4, placeholder: 'F' }),
      start_time: inp('start_time', { type: 'time' }), end_time: inp('end_time', { type: 'time' }),
      break_min: inp('break_min', { type: 'number', min: 0, step: 5 }), color: h('input', { type: 'color', value: t?.color || '#4f7cac' }),
      active: h('input', { type: 'checkbox', checked: t ? !!t.active : true }),
    };
    if (!t) r.break_min.value = 30;
    const save = async () => {
      const body = Object.fromEntries(Object.entries(r).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));
      body.break_min = Number(body.break_min);
      if (t && (body.start_time !== t.start_time || body.end_time !== t.end_time || body.break_min !== t.break_min)) {
        body.apply_future = await uiConfirm('Sollen die geänderten Zeiten auch für bereits erzeugte, zukünftige Schichten gelten?',
          { title: 'Zeiten übernehmen?', okText: 'Ja, übernehmen', cancelText: 'Nur für neue' });
      }
      try {
        const res = await api(t ? 'PUT' : 'POST', t ? `api/shift-types/${t.id}` : 'api/shift-types', body);
        toast(res.updated_shifts ? `Gespeichert, ${res.updated_shifts} Schichten angepasst.` : 'Gespeichert.');
        renderShiftTypes();
      } catch (e) { toast(e.message, true); }
    };
    return h('tr', { class: t && !t.active ? 'inactive' : '' }, Object.values(r).map((el) => h('td', {}, el)),
      h('td', { class: 'num' }, t ? fmtNum(hoursOf(t)) : ''), h('td', {}, h('button', { class: 'tiny', onclick: save }, t ? 'Speichern' : 'Hinzufügen')));
  };

  setMain(
    h('div', { class: 'card' }, h('h2', {}, 'Dienstzeiten (Schichtarten)'),
      h('p', { class: 'muted small' }, 'Endet ein Dienst vor seinem Beginn (z. B. 21:30–06:30), geht er über Mitternacht. Die Pause wird nicht als Arbeitszeit angerechnet.'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Bezeichnung', 'Kürzel', 'Beginn', 'Ende', 'Pause (Min.)', 'Farbe', 'Aktiv', 'Std.', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, types.map(typeRow), typeRow(null))))),
    h('p', { class: 'small muted' }, 'Stationen legen Sie unter ', h('a', { href: '#stationen', onclick: (e) => { e.preventDefault(); go('stationen'); } }, 'Stationen'), ' an.'));
}

function hoursOf(t) {
  const m = (x) => { const [a, b] = x.split(':').map(Number); return a * 60 + b; };
  let d = m(t.end_time) - m(t.start_time);
  if (d <= 0) d += 1440;
  return (d - t.break_min) / 60;
}

// ---------- Mindestbesetzung (Manager) ----------
async function qualRulesCard(units, types) {
  const rules = await api('GET', 'api/qual-rules');
  const unitSel = h('select', {}, h('option', { value: '' }, 'alle Bereiche'), units.map((u) => h('option', { value: u.id }, u.name)));
  const typeSel = h('select', {}, h('option', { value: '' }, 'alle Dienste'), types.map((t) => h('option', { value: t.id }, t.name)));
  const qualSel = h('select', {}, (state.settings.qualifikationen || []).map((q) => h('option', { value: q }, q)));
  const count = h('input', { type: 'number', min: 1, step: 1, value: 1 });
  return h('div', { class: 'card' }, h('h2', {}, 'Mindestbesetzung nach Qualifikation'),
    h('p', { class: 'muted' }, 'Zusätzliche Regeln je Dienst, z. B. „In jedem Nachtdienst mindestens 1 Pflegefachkraft“. ',
      'Schichten, die eine Regel nicht erfüllen, werden rot markiert; Mitarbeitende können sich dann nicht austragen, wenn dadurch die Regel verletzt würde.'),
    rules.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Bereich', 'Dienst', 'Qualifikation', 'mindestens', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, rules.map((r) => h('tr', {}, h('td', {}, r.unit_name || 'alle'), h('td', {}, r.type_name || 'alle'), h('td', {}, r.qualification),
        h('td', {}, r.min_count), h('td', {}, h('button', { class: 'tiny danger', onclick: async () => {
          await api('DELETE', `api/qual-rules/${r.id}`); toast('Regel gelöscht.'); renderRequirements();
        } }, 'Löschen'))))))
      : h('p', { class: 'muted' }, 'Noch keine Regeln.'),
    h('h3', {}, 'Neue Regel'),
    h('div', { class: 'row' }, h('label', {}, 'Bereich', unitSel), h('label', {}, 'Dienst', typeSel), h('label', {}, 'Qualifikation', qualSel),
      h('label', {}, 'mindestens', count),
      h('button', { onclick: async () => {
        try {
          await api('POST', 'api/qual-rules', { unit_id: unitSel.value || null, shift_type_id: typeSel.value || null, qualification: qualSel.value, min_count: Number(count.value) });
          toast('Regel hinzugefügt.'); renderRequirements();
        } catch (e) { toast(e.message, true); }
      } }, 'Hinzufügen')),
    h('p', { class: 'small muted' }, 'Die Liste der Qualifikationen pflegen Sie unter Einstellungen.'));
}

async function renderRequirements() {
  const [units, types, reqs] = await Promise.all([api('GET', 'api/units'), api('GET', 'api/shift-types'), api('GET', 'api/requirements')]);
  const activeTypes = types.filter((t) => t.active);
  const get = (u, t, wd) => reqs.find((r) => r.unit_id === u && r.shift_type_id === t && r.weekday === wd);
  const inputs = [];
  const cards = units.filter((u) => u.active).map((u) => h('div', { class: 'card' }, h('h3', {}, u.name),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Dienst'), WD_ORDER.map((wd) => h('th', {}, WD[wd])))),
      h('tbody', {}, activeTypes.map((t) => h('tr', {},
        h('td', {}, h('span', { class: 'chip', style: { background: t.color } }, t.code), t.name),
        WD_ORDER.map((wd) => {
          const r = get(u.id, t.id, wd);
          const min = h('input', { type: 'number', min: 0, step: 1, value: r?.min_staff ?? 0, title: 'Minimum', style: { width: '3.6em' } });
          const max = h('input', { type: 'number', min: 0, step: 1, value: r?.max_staff ?? '', placeholder: '∞', title: 'Maximum', style: { width: '3.6em' } });
          inputs.push({ unit_id: u.id, shift_type_id: t.id, weekday: wd, min, max });
          return h('td', {}, min, ' – ', max);
        }))))))));

  setMain(h('div', { class: 'card' }, h('h2', {}, 'Mindestbesetzung je Wochentag'),
    h('p', { class: 'muted' }, 'Je Feld: Minimum – Maximum an Personen pro Dienst. Ein Dienst mit Minimum 0 und leerem Maximum wird nicht angelegt. ',
      'Änderungen gelten für neu erzeugte Schichten; einzelne Schichten passen Sie im Dienstplan über ✎ an.'),
    h('p', {}, h('button', {
      onclick: async () => {
        try {
          await api('PUT', 'api/requirements', inputs.map((i) => ({
            unit_id: i.unit_id, shift_type_id: i.shift_type_id, weekday: i.weekday,
            min_staff: Number(i.min.value || 0), max_staff: i.max.value === '' ? null : Number(i.max.value),
          })));
          toast('Mindestbesetzung gespeichert.');
        } catch (e) { toast(e.message, true); }
      },
    }, 'Speichern'))), cards,
    h('div', { class: 'card save-bar' }, h('button', {
      onclick: async () => {
        try {
          await api('PUT', 'api/requirements', inputs.map((i) => ({
            unit_id: i.unit_id, shift_type_id: i.shift_type_id, weekday: i.weekday,
            min_staff: Number(i.min.value || 0), max_staff: i.max.value === '' ? null : Number(i.max.value),
          })));
          toast('Mindestbesetzung gespeichert.');
        } catch (e) { toast(e.message, true); }
      },
    }, 'Speichern')),
    await qualRulesCard(units.filter((u) => u.active), activeTypes));
}

// ---------- Einstellungen (Manager) ----------
async function renderSettings() {
  const s = await api('GET', 'api/settings');
  const fields = [
    ['klinik_name', 'Name der Einrichtung', 'text', 'Erscheint groß auf der Anmeldeseite, in der Kopfzeile und als Name der Handy-App.'],
    ['untertitel', 'Bezeichnung der Anwendung', 'text', 'z. B. „Personaleinsatzplanung“ oder „Dienstplan Pflege“'],
    ['akzentfarbe', 'Hausfarbe (Schaltflächen, Kopfzeile)', 'color'],
    ['zwei_faktor_pflicht', 'Zwei-Faktor-Anmeldung für alle verpflichtend', 'checkbox', 'Empfohlen. Ohne eingerichteten zweiten Faktor ist dann keine Anmeldung möglich.'],
    ['wochenstunden_standard', 'Regelmäßige Wochenarbeitszeit (Std.)', 'number', 'TVöD-K: 38,5 Std.'],
    ['austrag_frist_std', 'Austragen möglich bis … Std. vor Dienstbeginn', 'number'],
    ['austrag_unter_minimum', 'Austragen auch unter Mindestbesetzung erlauben', 'checkbox'],
    ['begruendung_austragen', 'Begründung beim Austragen verlangen', 'checkbox'],
    ['begruendung_eintragen', 'Begründung beim Eintragen verlangen', 'checkbox'],
    ['tausch_bestaetigung', 'Diensttausch muss von der Verwaltung bestätigt werden', 'checkbox', 'Ohne Haken ist eine Übernahme aus der Tauschbörse sofort wirksam.'],
    ['urlaubstage_standard', 'Urlaubstage pro Jahr (Standard für neue Mitarbeitende)', 'number', 'TVöD § 26: 30 Arbeitstage bei 5-Tage-Woche'],
    ['au_ab_tag', 'AU-Bescheinigung erforderlich ab Krankheitstag', 'number', 'EFZG § 5: ab dem 4. Kalendertag; 1 = ab dem ersten Tag'],
    ['qualifikationen', 'Qualifikationen (eine pro Zeile)', 'list'],
    ['ruhezeit_std', 'Mindestruhezeit zwischen zwei Diensten (Std.)', 'number', '§ 5 ArbZG: 11 Std.; in Krankenhäusern unter Bedingungen 10 Std.'],
    ['nacht_von', 'Nachtarbeit von', 'time'], ['nacht_bis', 'Nachtarbeit bis', 'time', 'TVöD § 7 Abs. 5: 21–6 Uhr'],
    ['zuschlag_nacht', 'Zuschlag Nachtarbeit (%)', 'number'],
    ['zuschlag_sonntag', 'Zuschlag Sonntagsarbeit (%)', 'number'],
    ['zuschlag_feiertag', 'Zuschlag Feiertagsarbeit (%)', 'number', 'TVöD: 35 % mit Freizeitausgleich, 135 % ohne'],
    ['zuschlag_vorfest', 'Zuschlag 24.12./31.12. ab 6 Uhr (%)', 'number'],
    ['zuschlag_samstag', 'Zuschlag Samstag 13–21 Uhr (%)', 'number'],
    ['samstag_bei_schichtarbeit', 'Samstagszuschlag auch im Schichtdienst anrechnen', 'checkbox', 'Nach TVöD entfällt er bei Wechselschicht-/Schichtarbeit.'],
  ];
  const els = {};
  const form = h('form', { class: 'card' }, h('h2', {}, 'Einstellungen'),
    h('div', { class: 'grid-2' }, fields.map(([k, label, type, hint]) => {
      const el = type === 'list'
        ? h('textarea', { rows: 6, value: (s[k] || []).join('\n') })
        : h('input', type === 'checkbox' ? { type, checked: !!s[k] } : { type, value: s[k], step: type === 'number' ? 'any' : undefined, style: type === 'text' ? { width: '100%' } : undefined });
      el.dataset.kind = type;
      els[k] = el;
      return h('label', {}, label, el, hint ? h('span', { class: 'small muted' }, hint) : null);
    })),
    h('p', { class: 'small muted' }, 'Hinweis: Die Prozentsätze sind Vorgabewerte und müssen mit dem aktuell gültigen Tarifvertrag bzw. den Haustarif-Regelungen abgeglichen werden.'),
    h('button', { type: 'submit' }, 'Speichern'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = Object.fromEntries(Object.entries(els).map(([k, el]) => [k,
      el.dataset.kind === 'list' ? el.value.split('\n') : el.type === 'checkbox' ? el.checked : el.value]));
    try {
      state.settings = await api('PUT', 'api/settings', body);
      await loadBranding();
      toast('Einstellungen gespeichert.');
    } catch (e) { toast(e.message, true); }
  });
  setMain(form, logoCard());
}

function logoCard() {
  const b = state.branding || {};
  const input = h('input', { type: 'file', accept: 'image/png,image/jpeg', hidden: true });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return toast('Das Logo ist größer als 2 MB.', true);
    try {
      const res = await fetch('api/branding/logo', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast('Logo gespeichert.');
      await loadBranding(); renderSettings();
    } catch (e) { toast(e.message, true); }
  });
  return h('div', { class: 'card' }, h('h2', {}, 'Logo'),
    h('p', { class: 'small muted' }, 'PNG oder JPG, max. 2 MB, am besten quer und mit transparentem Hintergrund. ',
      'Erscheint auf der Anmeldeseite und in der Kopfzeile. Bitte nur ein Logo verwenden, dessen Nutzung die Einrichtung freigegeben hat.'),
    b.logo ? h('div', { class: 'logo-preview' }, logoImg('login-logo-img')) : h('p', { class: 'muted' }, 'Kein Logo hinterlegt.'),
    h('div', { class: 'toolbar' }, input,
      h('button', { onclick: () => input.click() }, b.logo ? 'Anderes Logo hochladen' : 'Logo hochladen'),
      b.logo ? h('button', { class: 'danger', onclick: async () => {
        if (!await uiConfirm('Das Logo wird entfernt.', { title: 'Logo entfernen?', okText: 'Entfernen', danger: true })) return;
        try { await api('DELETE', 'api/branding/logo'); await loadBranding(); renderSettings(); } catch (e) { toast(e.message, true); }
      } }, 'Entfernen') : null));
}
