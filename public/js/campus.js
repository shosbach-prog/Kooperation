'use strict';
/* Campus: Gebäude, Stationen, Verbünde */

// ---------- Campus & Stationen (Verwaltung) ----------
async function renderStations() {
  const [units, buildings, users, types, verbuende] = await Promise.all([
    api('GET', 'api/units'), api('GET', 'api/buildings'), api('GET', 'api/users'), api('GET', 'api/shift-types'), api('GET', 'api/verbuende'),
  ]);
  const people = users.filter((u) => u.active).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const leitungSelect = (cur) => h('select', {}, h('option', { value: '' }, '– keine –'),
    people.map((p) => h('option', { value: p.id, selected: p.id === cur }, `${p.name}${p.qualification ? ` (${p.qualification})` : ''}`)));
  const buildingSelect = (cur) => h('select', {}, h('option', { value: '' }, '– ohne Gebäude –'),
    buildings.filter((b) => b.active || b.id === cur).map((b) => h('option', { value: b.id, selected: b.id === cur }, b.name)));
  const save = async (fn, msg) => { try { await fn(); toast(msg); renderStations(); } catch (e) { toast(e.message, true); } };

  // --- Station (Karte mit aufklappbarer Bearbeitung) ---
  const stationCard = (u) => {
    const name = h('input', { value: u.name, maxlength: 80, required: true });
    const kuerzel = h('input', { value: u.kuerzel || '', maxlength: 10, placeholder: 'z. B. 1A' });
    const telefon = h('input', { type: 'tel', value: u.telefon || '', maxlength: 40, placeholder: 'Durchwahl' });
    const leitung = leitungSelect(u.leitung_id);
    const gebaeude = buildingSelect(u.building_id);
    const active = h('input', { type: 'checkbox', checked: !!u.active });
    return h('div', { class: `card station${u.active ? '' : ' inactive'}` },
      h('div', { class: 'station-head' }, h('h3', {}, u.kuerzel ? `${u.name} (${u.kuerzel})` : u.name), !u.active ? h('span', { class: 'badge bad' }, 'inaktiv') : null),
      h('div', { class: 'station-meta' },
        h('span', {}, `👥 ${u.personal} Person(en)`),
        u.leitung_name ? h('span', {}, `Leitung: ${u.leitung_name}`) : null,
        u.verbund_name ? h('span', { class: 'verbund-tag', style: { marginLeft: 0 } }, `⇄ ${u.verbund_name}`) : null,
        u.telefon ? h('a', { href: `tel:${u.telefon.replace(/[^\d+]/g, '')}` }, `☎ ${u.telefon}`) : null),
      h('details', { class: 'edit' }, h('summary', {}, 'Bearbeiten'),
        h('div', { class: 'row' }, h('label', {}, 'Name', name), h('label', {}, 'Kürzel', kuerzel), h('label', {}, 'Telefon', telefon),
          h('label', {}, 'Gebäude', gebaeude), h('label', {}, 'Stationsleitung', leitung), h('label', { class: 'check' }, active, 'aktiv')),
        h('div', { class: 'toolbar', style: { marginTop: '.75rem', marginBottom: 0 } },
          h('button', { onclick: () => save(() => api('PUT', `api/units/${u.id}`, {
            name: name.value, kuerzel: kuerzel.value, telefon: telefon.value, leitung_id: leitung.value || null,
            building_id: gebaeude.value || null, active: active.checked,
          }), 'Station gespeichert.') }, 'Speichern'),
          h('button', { class: 'ghost', onclick: () => go('req') }, 'Mindestbesetzung'),
          h('button', { class: 'danger', onclick: async () => {
            if (!await uiConfirm(`Station „${u.name}“ wird gelöscht. Das geht nur, solange es dort noch keine Schichten gibt – sonst bitte deaktivieren.`,
              { title: 'Station löschen?', okText: 'Löschen', danger: true })) return;
            save(() => api('DELETE', `api/units/${u.id}`), 'Station gelöscht.');
          } }, 'Löschen'))));
  };

  // --- Neue Station (Dialog), optional schon einem Gebäude zugeordnet ---
  const newStation = async (buildingId) => {
    const r = await uiForm({
      title: 'Neue Station',
      message: buildingId ? `Gebäude: ${buildings.find((b) => b.id === buildingId)?.name}` : '',
      okText: 'Anlegen',
      fields: [
        { name: 'name', label: 'Name', required: true, placeholder: 'z. B. Station 3 – Allgemeinpsychiatrie', maxlength: 80 },
        { name: 'kuerzel', label: 'Kürzel (optional)', placeholder: 'z. B. A3', maxlength: 10 },
        { name: 'telefon', label: 'Telefon (optional)', type: 'tel', maxlength: 40 },
        { name: 'copy_from', label: 'Mindestbesetzung übernehmen von', type: 'select', value: '',
          options: [['', 'keiner – später festlegen'], ...units.filter((u) => u.active).map((u) => [u.id, u.name])],
          hint: 'Personen je Dienst und Wochentag; lässt sich danach anpassen.' },
      ],
    });
    if (!r) return;
    const copyFrom = r.copy_from ? Number(r.copy_from) : null;
    save(() => api('POST', 'api/units', { ...r, building_id: buildingId || null, copy_from: copyFrom }),
      copyFrom ? 'Station angelegt, Mindestbesetzung übernommen.' : 'Station angelegt. Bitte noch die Mindestbesetzung festlegen.');
  };

  // --- Gebäude ---
  const buildingForm = async (b) => {
    const r = await uiForm({
      title: b ? 'Gebäude bearbeiten' : 'Neues Gebäude', okText: b ? 'Speichern' : 'Anlegen',
      fields: [
        { name: 'name', label: 'Name', required: true, value: b?.name || '', placeholder: 'z. B. Haus C – Tagesklinik', maxlength: 80 },
        { name: 'kuerzel', label: 'Kürzel (optional)', value: b?.kuerzel || '', placeholder: 'z. B. C', maxlength: 10 },
        { name: 'beschreibung', label: 'Beschreibung / Lage (optional)', type: 'textarea', rows: 2, value: b?.beschreibung || '', maxlength: 300,
          placeholder: 'z. B. Eingang Marsbruchstraße, 2. OG' },
        { name: 'sort', label: 'Reihenfolge', type: 'number', min: 0, step: 1, value: b?.sort ?? '', inputmode: 'numeric', hint: 'kleinere Zahl = weiter oben' },
      ],
    });
    if (!r) return;
    const body = { ...r, sort: r.sort === '' ? undefined : Number(r.sort) };
    save(() => api(b ? 'PUT' : 'POST', b ? `api/buildings/${b.id}` : 'api/buildings', body), b ? 'Gebäude gespeichert.' : 'Gebäude angelegt.');
  };

  // --- Stationsverbünde ---
  const verbundForm = (v) => openDialog((close) => {
    const name = h('input', { value: v?.name || '', maxlength: 80, required: true, placeholder: 'z. B. Verbund Akut 1 + 2' });
    const beschreibung = h('input', { value: v?.beschreibung || '', maxlength: 300, placeholder: 'z. B. gemeinsamer Flur, Durchgang im 1. OG' });
    const gemeinsam = h('input', { type: 'checkbox', checked: v ? !!v.gemeinsam : true });
    const err = h('p', { class: 'error' });
    const boxes = units.filter((u) => u.active).map((u) => {
      const cb = h('input', { type: 'checkbox', value: u.id, checked: v ? u.verbund_id === v.id : false });
      const other = u.verbund_id && (!v || u.verbund_id !== v.id) ? ` (bisher ${u.verbund_name || 'anderer Verbund'})` : '';
      return h('label', { class: 'check' }, cb, `${u.name}${u.building_name ? ` · ${u.building_name}` : ''}${other}`);
    });
    const form = dialogShell(v ? 'Verbund bearbeiten' : 'Neuer Stationsverbund',
      'Stationen, die direkt zusammenhängen und sich gegenseitig mit Personal aushelfen.',
      h('div', { class: 'ui-dialog-fields' },
        h('label', {}, 'Name', name), h('label', {}, 'Beschreibung (optional)', beschreibung),
        h('fieldset', {}, h('legend', {}, 'Stationen im Verbund'), h('div', { class: 'check-list' }, boxes)),
        h('label', { class: 'check' }, gemeinsam, h('span', {}, h('strong', {}, 'Gemeinsame Mindestbesetzung'),
          h('span', { class: 'small muted', style: { display: 'block' } },
            'Fehlt auf einer Station Personal, gilt der Dienst als gedeckt, wenn der Verbund insgesamt genug Personal hat. ',
            'Ohne Haken lässt sich nur umsetzen; jede Station muss ihr Minimum selbst erreichen.'))),
        err),
      [h('button', { type: 'button', class: 'ghost', onclick: () => close(null) }, 'Abbrechen'), h('button', { type: 'submit' }, v ? 'Speichern' : 'Anlegen')]);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const unitIds = boxes.map((l) => l.querySelector('input')).filter((c) => c.checked).map((c) => Number(c.value));
      if (!name.value.trim()) { err.textContent = 'Bitte einen Namen angeben.'; return; }
      if (unitIds.length < 2) { err.textContent = 'Bitte mindestens zwei Stationen auswählen.'; return; }
      try {
        await api(v ? 'PUT' : 'POST', v ? `api/verbuende/${v.id}` : 'api/verbuende',
          { name: name.value, beschreibung: beschreibung.value, gemeinsam: gemeinsam.checked, unit_ids: unitIds });
        close(true);
      } catch (ex) { err.textContent = ex.message; }
    });
    return form;
  }).then((ok) => { if (ok) { toast('Verbund gespeichert.'); renderStations(); } });

  const verbundCard = h('section', { class: 'card' },
    h('div', { class: 'campus-head' },
      h('div', {}, h('h2', {}, 'Stationsverbünde'),
        h('p', { class: 'small muted', style: { margin: '.2rem 0 0' } },
          'Zusammenhängende Stationen gleichen Personal gleitend aus: Personen lassen sich im Dienstplan mit ⇄ umsetzen, ',
          'und bei gemeinsamer Mindestbesetzung zählt die Besetzung des ganzen Verbunds.')),
      h('div', { class: 'toolbar', style: { margin: 0 } }, h('button', { onclick: () => verbundForm(null) }, '+ Verbund'))),
    verbuende.length ? h('div', { class: 'campus-stations' }, verbuende.map((v) => h('div', { class: `card station${v.active ? '' : ' inactive'}` },
      h('div', { class: 'station-head' }, h('h3', {}, `⇄ ${v.name}`),
        h('span', { class: `badge ${v.gemeinsam ? 'ok' : 'warn'}` }, v.gemeinsam ? 'gemeinsame Mindestbesetzung' : 'nur Umsetzen')),
      h('div', { class: 'station-meta' }, h('span', {}, v.stationsnamen || 'keine Stationen'), v.beschreibung ? h('span', {}, v.beschreibung) : null),
      h('div', { class: 'toolbar', style: { margin: 0 } },
        h('button', { class: 'ghost', onclick: () => verbundForm(v) }, 'Bearbeiten'),
        h('button', { class: 'danger', onclick: async () => {
          if (!await uiConfirm(`„${v.name}“ wird aufgelöst. Die Stationen bleiben erhalten und zählen wieder einzeln.`, { title: 'Verbund auflösen?', okText: 'Auflösen', danger: true })) return;
          save(() => api('DELETE', `api/verbuende/${v.id}`), 'Verbund aufgelöst.');
        } }, 'Auflösen')))))
      : h('p', { class: 'muted' }, 'Noch keine Verbünde. Beispiel: Station 1 und 2 liegen auf einem Flur und helfen sich gegenseitig aus.'));

  const buildingSection = (b, list) => h('section', { class: `card campus-building${b && !b.active ? ' inactive' : ''}` },
    h('div', { class: 'campus-head' },
      h('div', {}, h('h2', {}, b ? (b.kuerzel ? `${b.name} (${b.kuerzel})` : b.name) : 'Ohne Gebäude'),
        h('div', { class: 'station-meta', style: { margin: '.2rem 0 0' } },
          h('span', {}, `${list.filter((u) => u.active).length} Station(en)`),
          b ? h('span', {}, `👥 ${b.personal} Person(en)`) : null,
          b?.beschreibung ? h('span', {}, b.beschreibung) : null,
          b && !b.active ? h('span', { class: 'badge bad' }, 'inaktiv') : null)),
      h('div', { class: 'toolbar', style: { margin: 0 } },
        h('button', { onclick: () => newStation(b?.id) }, '+ Station'),
        b ? h('button', { class: 'ghost', onclick: () => buildingForm(b) }, 'Bearbeiten') : null,
        b ? h('button', { class: 'ghost', onclick: () => save(() => api('PUT', `api/buildings/${b.id}`, { active: !b.active }), b.active ? 'Gebäude deaktiviert.' : 'Gebäude aktiviert.') },
          b.active ? 'Deaktivieren' : 'Aktivieren') : null,
        b ? h('button', { class: 'danger', onclick: async () => {
          if (!await uiConfirm(`„${b.name}“ wird gelöscht. Die ${list.length} Station(en) bleiben erhalten und sind danach keinem Gebäude zugeordnet.`,
            { title: 'Gebäude löschen?', okText: 'Löschen', danger: true })) return;
          save(() => api('DELETE', `api/buildings/${b.id}`), 'Gebäude gelöscht.');
        } }, 'Löschen') : null)),
    list.length ? h('div', { class: 'campus-stations' }, list.map(stationCard))
      : h('p', { class: 'muted' }, 'Noch keine Stationen in diesem Gebäude.'));

  const ohne = units.filter((u) => !u.building_id);
  setMain(
    h('div', { class: 'card' },
      h('div', { class: 'toolbar', style: { marginBottom: '.25rem' } },
        h('h2', { style: { margin: 0 } }, 'Campus & Stationen'), h('span', { class: 'spacer' }),
        h('button', { onclick: () => buildingForm(null) }, '+ Gebäude'),
        h('button', { class: 'ghost', onclick: () => newStation(null) }, '+ Station')),
      h('p', { class: 'small muted', style: { margin: 0 } },
        `${buildings.filter((b) => b.active).length} Gebäude · ${units.filter((u) => u.active).length} aktive Stationen · `,
        'Gebäude und Stationen erscheinen im Dienstplan (Auswahl „Gebäude – alle Stationen“), in der Personalakte und in den Auswertungen. ',
        types.length ? '' : 'Tipp: Legen Sie unter „Dienstzeiten“ auch die Dienste an.')),
    buildings.map((b) => buildingSection(b, units.filter((u) => u.building_id === b.id))),
    verbundCard,
    ohne.length || !buildings.length ? buildingSection(null, ohne) : null);
}
