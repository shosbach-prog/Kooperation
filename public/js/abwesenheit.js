'use strict';
/* Urlaub, Krankheit, Protokoll */

// ---------- Urlaub & Krankheit ----------
const STATUS = {
  beantragt: ['warn', 'beantragt'], genehmigt: ['ok', 'genehmigt'], abgelehnt: ['bad', 'abgelehnt'], gemeldet: ['warn', 'krankgemeldet'],
};
const statusBadge = (a) => h('span', { class: `badge ${STATUS[a.status][0]}` }, STATUS[a.status][1]);
const ABS_LABEL = { urlaub: 'Erholungsurlaub', zusatzurlaub: 'Zusatzurlaub (Schwerbehinderung)', sonderurlaub: 'Sonderurlaub', krank: 'Krankheit' };
const typeLabel = (a) => ABS_LABEL[a.type] || a.type;
const range = (a) => (a.from_date === a.to_date ? fmtDate(a.from_date) : `${fmtDate(a.from_date)} – ${fmtDate(a.to_date)}`);
const fmtSize = (b) => (b > 1024 * 1024 ? `${fmtNum(b / 1024 / 1024, 1)} MB` : `${Math.ceil(b / 1024)} KB`);

function auStatus(a) {
  if (a.type !== 'krank') return null;
  if (!a.au_erforderlich) return h('span', { class: 'small muted' }, `AU erst ab ${state.settings.au_ab_tag}. Tag nötig`);
  if (!a.au_fehlt) return h('span', { class: 'badge ok' }, 'AU liegt vor');
  return h('span', { class: `badge ${a.au_ueberfaellig ? 'bad' : 'warn'}` }, a.au_ueberfaellig ? 'AU fehlt' : `AU fällig ab ${fmtDate(a.au_faellig_ab)}`);
}

function attachmentList(a, canDelete) {
  if (!a.attachments.length) return null;
  return h('ul', { class: 'files' }, a.attachments.map((f) => h('li', {},
    h('a', { href: `api/attachments/${f.id}?inline=1`, target: '_blank', rel: 'noopener' }, f.filename),
    h('span', { class: 'small muted' }, ` (${fmtSize(f.size)})`),
    canDelete ? h('button', { class: 'tiny danger', title: 'Datei löschen', onclick: async () => {
      if (!await uiConfirm(f.filename, { title: 'Datei löschen?', okText: 'Löschen', danger: true })) return;
      try { await api('DELETE', `api/attachments/${f.id}`); toast('Gelöscht.'); refresh(); } catch (e) { toast(e.message, true); }
    } }, '×') : null)));
}

function uploadButton(a) {
  const input = h('input', { type: 'file', accept: 'application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png', hidden: true });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return toast('Die Datei ist größer als 10 MB.', true);
    try {
      const res = await fetch(`api/absences/${a.id}/attachments`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) }, body: file,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast('Bescheinigung hochgeladen.');
      refresh();
    } catch (e) { toast(e.message, true); }
  });
  return h('span', {}, input, h('button', { class: 'tiny', onclick: () => input.click() }, 'AU hochladen'));
}

async function extendSickness(a) {
  const iso = await uiPrompt({ title: 'Krankmeldung ändern', message: `Bisher: ${range(a)}`, label: 'krank bis einschließlich',
    type: 'date', value: a.to_date, required: true, okText: 'Speichern' });
  if (!iso) return;
  try {
    const r = await api('PUT', `api/absences/${a.id}`, { to: iso });
    toast(r.removed ? `Gespeichert. ${r.removed} Dienst(e) wurden ausgetragen.` : 'Gespeichert.');
    if (r.au_fehlt) await uiAlert(`Ab dem ${state.settings.au_ab_tag}. Krankheitstag ist eine Arbeitsunfähigkeitsbescheinigung erforderlich. Bitte laden Sie sie hoch.`);
  } catch (e) { toast(e.message, true); }
  refresh();
}

function absenceForm(type, onSaved, users) {
  const today = todayIso();
  const userSel = users ? h('select', { required: true }, h('option', { value: '' }, '– Person wählen –'),
    users.map((u) => h('option', { value: u.id }, u.name))) : null;
  let typeSel = null;
  if (users) {
    typeSel = h('select', {}, ['urlaub', 'zusatzurlaub', 'sonderurlaub', 'krank'].map((t) => h('option', { value: t }, ABS_LABEL[t])));
  } else if (type !== 'krank') {
    typeSel = h('select', {}, h('option', { value: 'urlaub' }, ABS_LABEL.urlaub),
      state.me.schwerbehindert ? h('option', { value: 'zusatzurlaub' }, ABS_LABEL.zusatzurlaub) : null,
      h('option', { value: 'sonderurlaub' }, 'Sonderurlaub (Arbeitsbefreiung)'));
  }
  const from = h('input', { type: 'date', required: true, value: type === 'krank' ? today : '' });
  const to = h('input', { type: 'date', required: true, value: type === 'krank' ? today : '' });
  from.addEventListener('change', () => { if (!to.value || to.value < from.value) to.value = from.value; });
  const note = h('input', { placeholder: type === 'krank' ? 'optional' : 'optional, z. B. Familienurlaub', maxlength: 500 });
  const noteLabel = h('span', {}, 'Bemerkung');
  typeSel?.addEventListener('change', () => {
    const sonder = typeSel.value === 'sonderurlaub';
    noteLabel.textContent = sonder ? 'Anlass (Pflicht)' : 'Bemerkung';
    note.placeholder = sonder ? 'z. B. Umzug, Hochzeit, Niederkunft der Partnerin' : 'optional';
    note.required = sonder;
  });
  const form = h('form', { class: 'row' },
    userSel ? h('label', {}, 'Mitarbeiter/in', userSel) : null, typeSel ? h('label', {}, 'Art', typeSel) : null,
    h('label', {}, type === 'krank' ? 'krank seit' : 'von', from),
    h('label', {}, type === 'krank' ? 'voraussichtlich bis' : 'bis', to),
    h('label', {}, noteLabel, note),
    h('button', { type: 'submit' }, users ? 'Eintragen' : type === 'krank' ? 'Krank melden' : 'Beantragen'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const t = typeSel ? typeSel.value : type;
    try {
      const r = await api('POST', 'api/absences', { type: t, from: from.value, to: to.value, note: note.value, user_id: userSel?.value || undefined });
      let msg = t === 'krank' ? 'Krankmeldung gespeichert.' : users ? `${ABS_LABEL[t]} eingetragen.` : `Antrag (${ABS_LABEL[t]}) über ${r.arbeitstage} Arbeitstage gestellt.`;
      if (r.removed) msg += ` ${r.removed} Dienst(e) wurden ausgetragen.`;
      toast(msg);
      if (t === 'krank' && r.au_erforderlich && !users) {
        await uiAlert(`Ihre Krankmeldung umfasst ${r.kalendertage} Tage. Ab dem ${state.settings.au_ab_tag}. Tag ist eine Arbeitsunfähigkeitsbescheinigung nötig – bitte laden Sie sie unten hoch.`);
      }
      onSaved();
    } catch (e) { toast(e.message, true); }
  });
  return form;
}

async function renderMyAbsences() {
  const year = Number(todayIso().slice(0, 4));
  const r = await api('GET', `api/absences?year=${year}&mine=1`);
  const kontoCard = (title, k, hint) => {
    const pct = k.anspruch ? Math.min(100, ((k.genehmigt + k.beantragt) / k.anspruch) * 100) : 0;
    return h('div', { class: 'card' }, h('h2', {}, `${title} ${k.jahr}`),
      h('div', { class: 'stat' }, `${fmtNum(k.rest, 1)} Tage übrig`),
      h('div', { class: 'progress' }, h('div', { style: { width: pct + '%' } })),
      h('p', { class: 'small muted' }, `Anspruch ${fmtNum(k.anspruch, 1)} · genehmigt ${k.genehmigt} · beantragt ${k.beantragt} (Arbeitstage)`),
      hint ? h('p', { class: 'small muted' }, hint) : null);
  };
  setMain(
    h('div', { class: 'grid-2' },
      kontoCard('Urlaubskonto', r.urlaub),
      r.zusatzurlaub ? kontoCard('Zusatzurlaub', r.zusatzurlaub, 'Zusatzurlaub für schwerbehinderte Menschen nach § 208 SGB IX.') : null,
      h('div', { class: 'card' }, h('h2', {}, 'Krankmeldung'),
        h('p', { class: 'small muted' }, `Bitte melden Sie sich zusätzlich telefonisch auf der Station ab. Ab dem ${r.au_ab_tag}. Krankheitstag ist eine `,
          'Arbeitsunfähigkeitsbescheinigung (AU) hochzuladen (PDF oder Foto). Bereits eingetragene Dienste im Zeitraum werden automatisch ausgetragen.'),
        absenceForm('krank', renderMyAbsences))),
    h('div', { class: 'card' }, h('h2', {}, 'Urlaub beantragen'),
      h('p', { class: 'small muted' }, 'Der Antrag geht an die Einsatzplanung. Gezählt werden Arbeitstage (Mo–Fr ohne Feiertage). Nach der Genehmigung werden Dienste im Zeitraum ausgetragen. ',
        'Sonderurlaub (Arbeitsbefreiung nach § 29 TVöD, z. B. bei Umzug oder Niederkunft der Ehefrau/Partnerin) bitte mit Anlass beantragen.'),
      absenceForm('urlaub', renderMyAbsences)),
    h('div', { class: 'card' }, h('h2', {}, 'Meine Einträge'),
      r.absences.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Art', 'Zeitraum', 'Tage', 'Status', 'Bemerkung', 'Bescheinigung', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, r.absences.map((a) => h('tr', {},
          h('td', {}, typeLabel(a)), h('td', {}, range(a)),
          h('td', { class: 'num' }, a.type !== 'krank' ? `${a.arbeitstage} AT` : `${a.kalendertage} KT`),
          h('td', {}, statusBadge(a)),
          h('td', {}, a.note, a.decision_note ? h('div', { class: 'small muted' }, `Einsatzplanung: ${a.decision_note}`) : null),
          h('td', {}, auStatus(a), attachmentList(a, true)),
          h('td', { class: 'actions' },
            a.type === 'krank' ? uploadButton(a) : null,
            a.type === 'krank' ? h('button', { class: 'tiny ghost', onclick: () => extendSickness(a) }, 'Verlängern') : null,
            a.type !== 'krank' && a.status === 'beantragt' ? h('button', { class: 'tiny danger', onclick: async () => {
              if (!await uiConfirm('Der Antrag wird gelöscht.', { title: 'Antrag zurückziehen?', okText: 'Zurückziehen', danger: true })) return;
              try { await api('DELETE', `api/absences/${a.id}`); toast('Zurückgezogen.'); renderMyAbsences(); } catch (e) { toast(e.message, true); }
            } }, 'Zurückziehen') : null))))))
        : h('p', { class: 'muted' }, 'Keine Einträge.')),
    h('p', { class: 'small muted' }, 'Hinweis: Bei gesetzlich Versicherten ruft der Arbeitgeber die AU zusätzlich elektronisch ab (eAU). ',
      'Die hochgeladenen Bescheinigungen sehen nur Sie und die Einsatzplanung.'));
}

async function renderAbsencesMgr() {
  const from = `${state.month}-01`;
  const [y, m] = state.month.split('-').map(Number);
  const to = toIso(Date.UTC(y, m, 0));
  const [open, inMonth, users] = await Promise.all([
    api('GET', 'api/absences?status=beantragt'),
    api('GET', `api/absences?from=${from}&to=${to}`),
    api('GET', 'api/users'),
  ]);
  const decide = async (a, status) => {
    let note = '';
    if (status === 'abgelehnt') {
      note = await askReason(`Antrag auf ${typeLabel(a)} von ${a.name} (${range(a)}) ablehnen.`, true, { title: 'Antrag ablehnen', okText: 'Ablehnen' });
      if (note === null) return;
    } else {
      const extra = a.konflikte ? ` Achtung: ${a.name} ist in ${a.konflikte} Dienst(en) eingetragen. Diese werden ausgetragen.` : '';
      if (!await uiConfirm(`${typeLabel(a)} von ${a.name}: ${range(a)}, ${a.arbeitstage} Arbeitstage.${extra}`, { title: 'Genehmigen?', okText: 'Genehmigen' })) return;
    }
    try {
      const r = await api('PUT', `api/absences/${a.id}/decision`, { status, note });
      toast(status === 'genehmigt' ? `Genehmigt.${r.removed ? ` ${r.removed} Dienst(e) ausgetragen.` : ''}` : 'Abgelehnt.');
    } catch (e) { toast(e.message, true); }
    refresh();
  };
  const sick = inMonth.absences.filter((a) => a.type === 'krank');
  const vac = inMonth.absences.filter((a) => a.type !== 'krank' && a.status !== 'beantragt');
  const auMissing = (await api('GET', 'api/absences')).absences.filter((a) => a.au_ueberfaellig);
  setMain(
    h('div', { class: 'card' }, h('h2', {}, `Offene Anträge (${open.absences.length})`),
      open.absences.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Mitarbeiter/in', 'Art', 'Zeitraum', 'Arbeitstage', 'Bemerkung / Anlass', 'eingetragen in', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, open.absences.map((a) => h('tr', {},
          h('td', {}, a.name, h('div', { class: 'small muted' }, a.qualification)), h('td', {}, typeLabel(a)), h('td', {}, range(a)), h('td', { class: 'num' }, a.arbeitstage),
          h('td', {}, a.note), h('td', {}, a.konflikte ? h('span', { class: 'badge warn' }, `${a.konflikte} Dienst(en)`) : '–'),
          h('td', { class: 'actions' },
            h('button', { class: 'tiny', onclick: () => decide(a, 'genehmigt') }, 'Genehmigen'),
            h('button', { class: 'tiny danger', onclick: () => decide(a, 'abgelehnt') }, 'Ablehnen'),
            h('button', { class: 'tiny ghost', onclick: () => { state.weekStart = mondayOf(a.from_date); go('plan'); } }, 'Plan ansehen')))))))
        : h('p', { class: 'muted' }, 'Keine offenen Anträge.')),
    auMissing.length ? h('div', { class: 'card warn-card' }, h('h2', {}, `Fehlende AU-Bescheinigungen (${auMissing.length})`),
      h('ul', {}, auMissing.map((a) => h('li', {}, `${a.name}: krank ${range(a)} – fällig seit ${fmtDate(a.au_faellig_ab)}`)))) : null,
    h('div', { class: 'card' },
      h('div', { class: 'toolbar' }, h('h2', { style: { margin: 0 } }, 'Abwesenheiten im Monat'), h('span', { class: 'spacer' }),
        h('label', {}, 'Monat', h('input', { type: 'month', value: state.month, onchange: (e) => { state.month = e.target.value; renderAbsencesMgr(); } }))),
      h('h3', {}, `Krankheit (${sick.length})`),
      sick.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Mitarbeiter/in', 'Zeitraum', 'Kalendertage', 'AU', 'Dateien', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, sick.map((a) => h('tr', {},
          h('td', {}, a.name), h('td', {}, range(a)), h('td', { class: 'num' }, a.kalendertage), h('td', {}, auStatus(a)),
          h('td', {}, attachmentList(a, true) || '–'),
          h('td', { class: 'actions' }, uploadButton(a), h('button', { class: 'tiny ghost', onclick: () => extendSickness(a) }, 'Ende ändern'),
            h('button', { class: 'tiny danger', onclick: async () => {
              if (!await uiConfirm(`Krankmeldung von ${a.name} (${range(a)}). Hochgeladene Bescheinigungen werden ebenfalls gelöscht.`, { title: 'Krankmeldung löschen?', okText: 'Löschen', danger: true })) return;
              try { await api('DELETE', `api/absences/${a.id}`); toast('Gelöscht.'); refresh(); } catch (e) { toast(e.message, true); }
            } }, 'Löschen')))))))
        : h('p', { class: 'muted' }, 'Keine.'),
      h('h3', {}, `Urlaub und Sonderurlaub (${vac.length})`),
      vac.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Mitarbeiter/in', 'Art', 'Zeitraum', 'Arbeitstage', 'Status', 'Bemerkung', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, vac.map((a) => h('tr', {},
          h('td', {}, a.name), h('td', {}, typeLabel(a)), h('td', {}, range(a)), h('td', { class: 'num' }, a.arbeitstage), h('td', {}, statusBadge(a)),
          h('td', {}, a.note, a.decision_note ? h('div', { class: 'small muted' }, a.decision_note) : null),
          h('td', {}, h('button', { class: 'tiny danger', onclick: async () => {
            if (!await uiConfirm(`${typeLabel(a)} von ${a.name} (${range(a)})`, { title: 'Eintrag löschen?', okText: 'Löschen', danger: true })) return;
            try { await api('DELETE', `api/absences/${a.id}`); toast('Gelöscht.'); refresh(); } catch (e) { toast(e.message, true); }
          } }, 'Löschen')))))))
        : h('p', { class: 'muted' }, 'Keiner.')),
    h('div', { class: 'card' }, h('h2', {}, 'Abwesenheit direkt eintragen'),
      h('p', { class: 'small muted' }, 'Z. B. bei telefonischer Krankmeldung. Dienste im Zeitraum werden automatisch ausgetragen.'),
      absenceForm('urlaub', renderAbsencesMgr, users.filter((u) => u.active && u.role === 'staff'))));
}

// ---------- Protokoll (Manager) ----------
const LOG_LABEL = {
  'assignment.add': 'eingetragen', 'assignment.remove': 'ausgetragen', 'absence.create': 'Abwesenheit angelegt',
  'absence.decide': 'Urlaub entschieden', 'absence.update': 'Abwesenheit geändert', 'absence.delete': 'Abwesenheit gelöscht',
  'attachment.upload': 'AU hochgeladen',
  'user.rights': 'Verwaltungsrechte geändert', 'user.create': 'Person angelegt', 'assignment.move': 'umgesetzt (Verbund)',
};
async function renderLog() {
  const rows = await api('GET', 'api/log?limit=300');
  setMain(h('div', { class: 'card' }, h('h2', {}, 'Protokoll: Ein- und Austragungen, Abwesenheiten'),
    h('p', { class: 'small muted' }, 'Die letzten 300 Einträge, neueste zuerst.'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Zeitpunkt', 'Aktion', 'Mitarbeiter/in', 'Dienst', 'durch', 'Begründung / Bemerkung'].map((x) => h('th', {}, x)))),
      h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', { class: 'small' }, new Date(r.at.replace(' ', 'T') + 'Z').toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })),
        h('td', {}, LOG_LABEL[r.action] || r.action, r.details.automatisch ? h('div', { class: 'small muted' }, 'automatisch') : null,
          r.details.status ? h('div', { class: 'small muted' }, r.details.status) : null),
        h('td', {}, r.person || '–'),
        h('td', {}, r.shift ? `${r.shift.code} ${fmtDate(r.shift.date)} · ${r.shift.unit_name}`
          : r.details.from ? `${ABS_LABEL[r.details.type] || ''} ${fmtDate(r.details.from)} – ${fmtDate(r.details.to)}` : '–'),
        h('td', {}, r.actor),
        h('td', {}, r.reason || (r.details.filename ? r.details.filename : '')
          || (r.action === 'user.rights' ? (r.details.role === 'manager' ? 'Hauptverwaltung'
            : `${RECHTE_LABEL[r.details.rechte] || (r.details.rechte === 'keine' ? 'Rechte entzogen' : 'geändert')}${r.details.bis ? ` bis ${fmtDate(r.details.bis)}` : ''}`) : '–')))))))));
}
