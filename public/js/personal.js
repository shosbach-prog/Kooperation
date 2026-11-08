'use strict';
/* Personalverwaltung und Rechte */

// ---------- Personalverwaltung (Verwaltung) ----------
const RECHTE_LABEL = { keine: '', voll: 'Verwalter/in', vertretung: 'Vertretung' };
function rechteBadge(u) {
  if (u.role === 'manager') return h('span', { class: 'badge ok' }, 'Hauptverwaltung');
  if (u.admin_rechte === 'voll') return h('span', { class: 'badge ok' }, 'Verwalter/in');
  if (u.admin_rechte === 'vertretung') {
    const aktiv = u.is_manager;
    return h('span', { class: `badge ${aktiv ? 'warn' : 'bad'}` }, aktiv ? `Vertretung bis ${fmtDate(u.admin_bis)}` : `Vertretung abgelaufen (${fmtDate(u.admin_bis)})`);
  }
  return null;
}
function vertragHinweis(u) {
  const today = todayIso();
  if (u.austritt && u.austritt < today) return h('span', { class: 'badge bad' }, `ausgeschieden ${fmtDate(u.austritt)}`);
  if (u.austritt) return h('span', { class: 'badge warn' }, `Austritt ${fmtDate(u.austritt)}`);
  if (u.befristet_bis) {
    const tage = (parseIso(u.befristet_bis) - parseIso(today)) / 86400000;
    if (tage < 0) return h('span', { class: 'badge bad' }, `Befristung abgelaufen (${fmtDate(u.befristet_bis)})`);
    if (tage <= 90) return h('span', { class: 'badge warn' }, `befristet bis ${fmtDate(u.befristet_bis)}`);
  }
  return null;
}

async function renderStaff() {
  const [users, units] = await Promise.all([api('GET', 'api/users'), api('GET', 'api/units')]);
  const unitById = new Map(units.map((u) => [u.id, u]));
  const unitName = new Map(units.map((u) => [u.id, u.building_name ? `${u.name} · ${u.building_name}` : u.name]));
  state.personalFilter = state.personalFilter || { q: '', unit: '', qual: '', status: 'aktiv' };
  const f = state.personalFilter;
  const search = h('input', { type: 'search', placeholder: 'Name, Personalnr., Benutzer …', value: f.q });
  const unitSel = unitFilterSelect(units, f.unit, () => draw(), 'alle Bereiche');
  const qualSel = h('select', {}, h('option', { value: '' }, 'alle Qualifikationen'),
    (state.settings.qualifikationen || []).map((q) => h('option', { value: q, selected: q === f.qual }, q)));
  const statusSel = h('select', {}, [['aktiv', 'aktive'], ['inaktiv', 'inaktive / ausgeschiedene'], ['verwaltung', 'mit Verwaltungsrechten'], ['', 'alle']]
    .map(([v, l]) => h('option', { value: v, selected: v === f.status }, l)));
  const tbody = h('tbody');
  const count = h('span', { class: 'muted small' });
  const draw = () => {
    Object.assign(f, { q: search.value.trim().toLowerCase(), unit: unitSel.value, qual: qualSel.value, status: statusSel.value });
    const today = todayIso();
    const list = users.filter((u) => {
      const ausgeschieden = !u.active || (u.austritt && u.austritt < today);
      if (f.status === 'aktiv' && ausgeschieden) return false;
      if (f.status === 'inaktiv' && !ausgeschieden) return false;
      if (f.status === 'verwaltung' && !(u.role === 'manager' || u.admin_rechte !== 'keine')) return false;
      if (f.unit) {
        const unit = unitById.get(u.stammbereich_id);
        if (f.unit.startsWith('b:') ? String(unit?.building_id ?? 'none') !== f.unit.slice(2) || !unit && f.unit !== 'b:none'
          : String(u.stammbereich_id) !== f.unit.replace(/^u:/, '')) return false;
      }
      if (f.qual && u.qualification !== f.qual) return false;
      if (f.q && ![u.name, u.username, u.personalnummer, u.email].some((x) => String(x || '').toLowerCase().includes(f.q))) return false;
      return true;
    });
    count.textContent = `${list.length} von ${users.length} Personen`;
    tbody.replaceChildren(...list.map((u) => h('tr', { class: `clickable${u.active ? '' : ' inactive'}`, onclick: () => renderPersonalakte(u.id) },
      h('td', {}, u.personalnummer || '–'),
      h('td', {}, h('div', { class: 'person' }, avatar(u, 32), h('div', {}, h('strong', {}, u.name), h('div', { class: 'small muted' }, u.username)))),
      h('td', {}, u.qualification || '–'),
      h('td', {}, unitName.get(u.stammbereich_id) || '–'),
      h('td', { class: 'num' }, fmtNum(u.weekly_hours)),
      h('td', {}, u.eintritt ? fmtDate(u.eintritt) : '–'),
      h('td', {}, h('div', { class: 'badges' }, rechteBadge(u), vertragHinweis(u), !u.active ? h('span', { class: 'badge bad' }, 'inaktiv') : null,
        u.locked ? h('span', { class: 'badge bad' }, 'gesperrt') : null,
        u.totp_enabled ? null : h('span', { class: 'badge warn' }, '2FA offen'))))));
    stackTables(card);
  };
  for (const el of [qualSel, statusSel]) el.addEventListener('change', draw);
  search.addEventListener('input', draw);
  const card = h('div', { class: 'card' },
    h('div', { class: 'toolbar' }, h('h2', { style: { margin: 0 } }, 'Personal'), h('span', { class: 'spacer' }),
      h('a', { href: 'api/users.csv' }, h('button', { class: 'ghost' }, 'Personalliste (Excel)')),
      h('button', { onclick: () => renderPersonalakte(null) }, '+ Neue Person')),
    h('div', { class: 'row filters' }, h('label', {}, 'Suche', search), h('label', {}, 'Bereich', unitSel),
      h('label', {}, 'Qualifikation', qualSel), h('label', {}, 'Anzeigen', statusSel)),
    count,
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Pers.-Nr.', 'Name', 'Qualifikation', 'Stammbereich', 'Wochenstd.', 'Eintritt', 'Hinweise'].map((x) => h('th', {}, x)))),
      tbody)),
    h('p', { class: 'small muted' }, 'Zum Öffnen der Personalakte auf eine Zeile klicken.'));
  setMain(card);
  draw();
  if (!isPhone()) search.focus();
}

async function userAction(u, body, question) {
  if (question && !await uiConfirm(question)) return false;
  try { await api('PUT', `api/users/${u.id}`, body); toast('Erledigt.'); return true; } catch (e) { toast(e.message, true); return false; }
}

/** Personalakte: Stammdaten, Vertrag, Rechte, Urlaub, Dienste, Abwesenheiten */
async function renderPersonalakte(id) {
  const units = await api('GET', 'api/units');
  const users = id ? await api('GET', 'api/users') : [];
  const u = id ? users.find((x) => x.id === id) : null;
  if (id && !u) { toast('Person nicht gefunden.', true); return renderStaff(); }
  const back = h('button', { class: 'ghost', onclick: () => renderStaff() }, '‹ Zur Personalliste');
  const form = staffForm(u, units);
  if (!u) return setMain(h('div', { class: 'toolbar' }, back), form);

  const year = Number(todayIso().slice(0, 4));
  const [abs, shifts, report] = await Promise.all([
    api('GET', `api/absences?user_id=${u.id}&year=${year}`),
    api('GET', `api/users/${u.id}/shifts?from=${todayIso()}&to=${addDays(todayIso(), 60)}`),
    u.role === 'staff' ? api('GET', `api/report?month=${todayIso().slice(0, 7)}&user_id=${u.id}`) : Promise.resolve(null),
  ]);
  const r = report?.rows?.[0];
  const head = h('div', { class: 'card akte-head' },
    h('div', { class: 'akte-foto' }, fotoControl(u, `api/users/${u.id}/foto`, () => renderPersonalakte(u.id))),
    h('div', { class: 'akte-main' }, h('h2', { style: { margin: 0 } }, u.name),
      h('div', { class: 'muted' }, [u.qualification, units.find((x) => x.id === u.stammbereich_id)?.name, u.personalnummer && `Pers.-Nr. ${u.personalnummer}`]
        .filter(Boolean).join(' · ') || '–'),
      h('div', { class: 'badges' }, rechteBadge(u), vertragHinweis(u), !u.active ? h('span', { class: 'badge bad' }, 'inaktiv') : null,
        u.totp_enabled ? h('span', { class: 'badge ok' }, '2FA eingerichtet') : h('span', { class: 'badge warn' }, '2FA noch nicht eingerichtet'),
        u.locked ? h('span', { class: 'badge bad' }, 'gesperrt') : null)),
    h('div', { class: 'akte-contact' },
      u.telefon ? h('a', { href: `tel:${u.telefon.replace(/[^\d+]/g, '')}` }, `☎ ${u.telefon}`) : null,
      u.email ? h('a', { href: `mailto:${u.email}` }, `✉ ${u.email}`) : null));

  const kontoCard = abs.urlaub ? h('div', { class: 'card' }, h('h3', { style: { marginTop: 0 } }, `Urlaub ${year}`),
    h('div', { class: 'stat' }, `${fmtNum(abs.urlaub.rest, 1)} Tage übrig`),
    h('p', { class: 'small muted' }, `Anspruch ${fmtNum(abs.urlaub.anspruch, 1)} · genehmigt ${abs.urlaub.genehmigt} · beantragt ${abs.urlaub.beantragt}`),
    abs.zusatzurlaub ? h('p', { class: 'small' }, `Zusatzurlaub: ${fmtNum(abs.zusatzurlaub.rest, 1)} von ${fmtNum(abs.zusatzurlaub.anspruch, 1)} Tagen übrig`) : null) : null;
  const zeitCard = r ? h('div', { class: 'card' }, h('h3', { style: { marginTop: 0 } }, `Zeitkonto ${todayIso().slice(5, 7)}/${year}`),
    h('div', { class: 'stat' }, `${fmtNum(r.ist)} / ${fmtNum(r.soll)} Std.`),
    h('p', { class: 'small muted' }, `Saldo ${fmtNum(r.saldo)} Std. · ${r.dienste} Dienste · ${r.nachtschichten} Nachtschichten`),
    h('p', { class: 'small' }, r.min_erfuellt ? h('span', { class: 'badge ok' }, 'Mindestverfügbarkeit erfüllt')
      : h('span', { class: 'badge warn' }, `Mindestverfügbarkeit: ${fmtNum(r.ist, 1)} von ${fmtNum(r.min_hours_month, 1)} Std.`))) : null;

  const dienstCard = h('div', { class: 'card' }, h('h3', { style: { marginTop: 0 } }, 'Kommende Dienste (60 Tage)'),
    shifts.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Datum', 'Dienst', 'Bereich', 'Zeit'].map((x) => h('th', {}, x)))),
      h('tbody', {}, shifts.map((x) => h('tr', {},
        h('td', {}, `${WD[weekday(x.date)]} ${fmtDate(x.date)}`),
        h('td', {}, h('span', { class: 'chip', style: { background: x.type_color } }, x.type_code), x.type_name),
        h('td', {}, x.unit_name), h('td', {}, `${x.start_time}–${x.end_time}`))))))
      : h('p', { class: 'muted' }, 'Keine Dienste eingetragen.'));

  const absCard = h('div', { class: 'card' }, h('h3', { style: { marginTop: 0 } }, 'Abwesenheiten'),
    abs.absences.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Art', 'Zeitraum', 'Tage', 'Status', 'AU'].map((x) => h('th', {}, x)))),
      h('tbody', {}, abs.absences.slice(0, 30).map((a) => h('tr', {},
        h('td', {}, typeLabel(a)), h('td', {}, range(a)),
        h('td', { class: 'num' }, a.type !== 'krank' ? `${a.arbeitstage} AT` : `${a.kalendertage} KT`),
        h('td', {}, statusBadge(a)), h('td', {}, auStatus(a) || '–'))))))
      : h('p', { class: 'muted' }, 'Keine Einträge.'));

  const actions = h('div', { class: 'card' }, h('h3', { style: { marginTop: 0 } }, 'Zugang'),
    h('div', { class: 'toolbar' },
      u.totp_enabled ? h('button', { class: 'danger', onclick: async () => {
        if (await userAction(u, { reset_2fa: true }, `2FA von ${u.name} zurücksetzen (z. B. Handy verloren)? Die Person richtet sie bei der nächsten Anmeldung neu ein.`)) renderPersonalakte(u.id);
      } }, '2FA zurücksetzen') : null,
      u.locked ? h('button', { class: 'ghost', onclick: async () => { if (await userAction(u, { unlock: true })) renderPersonalakte(u.id); } }, 'Entsperren') : null,
      h('button', { class: 'ghost', onclick: async () => {
        const pw = await uiPrompt({ title: 'Passwort neu setzen', message: u.name, label: 'Neues Startpasswort', type: 'password',
          required: true, minLength: 6, autocomplete: 'new-password', okText: 'Setzen' });
        if (!pw) return;
        if (await userAction(u, { password: pw })) renderPersonalakte(u.id);
      } }, 'Passwort neu setzen')));

  setMain(h('div', { class: 'toolbar' }, back), head,
    h('div', { class: 'grid-2' }, kontoCard, zeitCard),
    form, state.me.is_haupt && u.id !== state.me.id ? rechteCard(u, units) : null,
    h('div', { class: 'grid-2' }, dienstCard, absCard), actions);
}

/** Verwaltungsrechte vergeben (nur Hauptverwaltung) */
function rechteCard(u, units) {
  const sel = h('select', {},
    h('option', { value: 'keine', selected: u.role !== 'manager' && u.admin_rechte === 'keine' }, 'keine – normale/r Mitarbeiter/in'),
    h('option', { value: 'vertretung', selected: u.admin_rechte === 'vertretung' }, 'Vertretung (befristet)'),
    h('option', { value: 'voll', selected: u.admin_rechte === 'voll' }, 'Verwalter/in (dauerhaft)'),
    h('option', { value: 'haupt', selected: u.role === 'manager' }, 'Hauptverwaltung'));
  const bis = h('input', { type: 'date', value: u.admin_bis || addDays(todayIso(), 14), min: todayIso() });
  const bisLabel = h('label', {}, 'Vertretung gilt bis einschließlich', bis);
  // Verwaltungsbereich: ganzer Campus oder ausgewählte Stationen
  const scope = new Set(u.admin_units || []);
  const boxes = units.filter((x) => x.active || scope.has(x.id)).map((x) => {
    const cb = h('input', { type: 'checkbox', value: x.id, checked: scope.has(x.id) });
    return h('label', { class: 'check' }, cb, `${x.name}${x.building_name ? ` · ${x.building_name}` : ''}${x.verbund_name ? ` · ⇄ ${x.verbund_name}` : ''}`);
  });
  const bereich = h('fieldset', {}, h('legend', {}, 'Verwaltungsbereich'),
    h('p', { class: 'small muted', style: { marginTop: 0 } }, 'Nichts angekreuzt = ganzer Campus. Mit Auswahl darf die Person nur in diesen Stationen ändern ',
      '(Dienstplan, Personal mit diesem Stammbereich, deren Urlaub und Krankmeldungen); lesen darf sie alles. Campus, Dienstzeiten und Einstellungen bleiben dann gesperrt.'),
    h('div', { class: 'check-list' }, boxes));
  const sync = () => { bisLabel.hidden = sel.value !== 'vertretung'; bereich.hidden = !['voll', 'vertretung'].includes(sel.value); };
  sel.addEventListener('change', sync);
  sync();
  return h('div', { class: 'card' }, h('h3', { style: { marginTop: 0 } }, 'Verwaltungsrechte'),
    h('p', { class: 'small muted' },
      'Verwalter/innen und Vertretungen können Dienstpläne, Personal, Urlaub und Krankmeldungen bearbeiten und arbeiten weiterhin selbst im Dienstplan mit. ',
      'Rechte vergeben, andere Verwalter/innen bearbeiten und Hauptverwaltung zuweisen kann nur die Hauptverwaltung. ',
      'Eine Vertretung endet automatisch nach dem angegebenen Tag. Alle Änderungen stehen im Protokoll.'),
    h('div', { class: 'row' }, h('label', {}, 'Rechte', sel), bisLabel), bereich,
    h('div', { class: 'toolbar' },
      h('button', { onclick: async () => {
        const v = sel.value;
        const admin_units = boxes.map((l) => l.querySelector('input')).filter((c) => c.checked).map((c) => Number(c.value));
        const body = v === 'haupt' ? { role: 'manager', admin_rechte: 'keine', admin_units: [] }
          : { role: 'staff', admin_rechte: v, admin_units: v === 'keine' ? [] : admin_units, ...(v === 'vertretung' ? { admin_bis: bis.value } : {}) };
        const text = v === 'haupt' ? `${u.name} zur Hauptverwaltung machen? Hauptverwalter/innen werden nicht mehr im Dienstplan eingeplant.`
          : v === 'vertretung' ? `${u.name} als Vertretung bis ${fmtDate(bis.value)} einsetzen?`
            : v === 'voll' ? `${u.name} dauerhaft Verwaltungsrechte geben?` : `Verwaltungsrechte von ${u.name} entfernen?`;
        if (await userAction(u, body, text)) renderPersonalakte(u.id);
      } }, 'Rechte speichern')));
}

function staffForm(u, units) {
  const f = (name, label, attrs = {}) => h('label', {}, label, h('input', { name, ...attrs }));
  const section = (title, ...fields) => h('fieldset', {}, h('legend', {}, title), h('div', { class: 'row' }, fields));
  const form = h('form', { class: 'card', id: 'staff-form' },
    h('h2', {}, u ? 'Stammdaten' : 'Neue Person anlegen'),
    section('Person und Zugang',
      f('name', 'Name', { required: true, value: u?.name || '' }),
      f('personalnummer', 'Personalnummer', { value: u?.personalnummer || '' }),
      f('username', 'Benutzername', { required: true, value: u?.username || '', autocomplete: 'off' }),
      !u ? f('password', 'Startpasswort', { type: 'password', required: true, minlength: 6, autocomplete: 'new-password' }) : null,
      f('email', 'E-Mail (dienstlich)', { type: 'email', value: u?.email || '' }),
      f('telefon', 'Telefon', { type: 'tel', value: u?.telefon || '' })),
    section('Einsatz',
      h('label', {}, 'Qualifikation', h('select', { name: 'qualification' }, h('option', { value: '' }, '– keine –'),
        [...new Set([...(state.settings.qualifikationen || []), ...(u?.qualification ? [u.qualification] : [])])]
          .map((q) => h('option', { value: q, selected: u?.qualification === q }, q)))),
      h('label', {}, 'Stammbereich', h('select', { name: 'stammbereich_id' }, h('option', { value: '' }, '– keiner –'),
        units.filter((x) => (x.active || x.id === u?.stammbereich_id) && (canManageUnit(x.id) || x.id === u?.stammbereich_id))
          .map((x) => h('option', { value: x.id, selected: u?.stammbereich_id === x.id }, x.name)))),
      f('weekly_hours', 'Wochenstunden', { type: 'number', step: '0.25', min: 0, value: u?.weekly_hours ?? state.settings.wochenstunden_standard }),
      f('min_hours_month', 'Mindestverfügbarkeit (Std./Monat)', { type: 'number', step: '0.5', min: 0, value: u?.min_hours_month ?? 0 })),
    section('Vertrag (TVöD)',
      f('eintritt', 'Eintritt', { type: 'date', value: u?.eintritt || '' }),
      f('befristet_bis', 'befristet bis', { type: 'date', value: u?.befristet_bis || '' }),
      f('austritt', 'Austritt', { type: 'date', value: u?.austritt || '' }),
      f('entgeltgruppe', 'Entgeltgruppe', { value: u?.entgeltgruppe || '', placeholder: 'z. B. P8, E9a', list: 'eg-list' }),
      f('stufe', 'Stufe', { type: 'number', min: 1, max: 6, step: 1, value: u?.stufe ?? '' }),
      f('stundenentgelt', 'Stundenentgelt € (für Zuschläge)', { type: 'number', step: '0.01', min: 0, value: u?.stundenentgelt ?? 0 })),
    h('datalist', { id: 'eg-list' }, ['P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11', 'P12', 'P13', 'P14', 'P15', 'P16', 'E5', 'E6', 'E8', 'E9a', 'E9b', 'E10', 'E11', 'E12', 'E13', 'E14', 'E15', 'Ä1', 'Ä2', 'Ä3', 'Ä4']
      .map((x) => h('option', { value: x }))),
    section('Urlaub',
      f('urlaubstage_jahr', 'Urlaubstage pro Jahr', { type: 'number', step: '0.5', min: 0, value: u?.urlaubstage_jahr ?? state.settings.urlaubstage_standard }),
      h('label', { class: 'check', style: { alignSelf: 'center' } }, h('input', { type: 'checkbox', name: 'schwerbehindert', checked: !!u?.schwerbehindert }),
        'Schwerbehinderung (GdB ≥ 50)'),
      f('zusatzurlaub_tage', 'Zusatzurlaub (Tage/Jahr)', { type: 'number', step: '0.5', min: 0, value: u?.schwerbehindert ? u.zusatzurlaub_tage : 5 })),
    h('fieldset', {}, h('legend', {}, 'Bemerkung (nur für die Verwaltung sichtbar)'),
      h('textarea', { name: 'bemerkung', rows: 3, maxlength: 2000, value: u?.bemerkung || '' })),
    u ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: !!u.active }), 'Zugang aktiv') : null,
    h('p', { class: 'small muted' }, 'Zusatzurlaub nach § 208 SGB IX: 5 Arbeitstage bei 5-Tage-Woche; im Jahr der Feststellung anteilig. ',
      'Angaben zur Schwerbehinderung sind vertraulich. Nach dem Austrittsdatum ist keine Anmeldung mehr möglich.'),
    h('div', { class: 'toolbar' }, h('button', { type: 'submit' }, u ? 'Stammdaten speichern' : 'Anlegen')));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    data.schwerbehindert = form.querySelector('[name=schwerbehindert]').checked;
    if (!data.schwerbehindert) delete data.zusatzurlaub_tage;
    if (u) data.active = form.querySelector('[name=active]').checked;
    try {
      const saved = await api(u ? 'PUT' : 'POST', u ? `api/users/${u.id}` : 'api/users', data);
      toast('Gespeichert.');
      renderPersonalakte(saved.id);
    } catch (e) { toast(e.message, true); }
  });
  return form;
}
