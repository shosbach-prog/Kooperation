'use strict';
/* Dialoge (ersetzen prompt/confirm/alert) */

// ---------- Dialoge (ersetzen prompt/confirm/alert; auf dem Handy als Einblendung von unten) ----------
function openDialog(build) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'ui-dialog' });
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(null); }); // Klick neben das Fenster
    dlg.append(build(close));
    document.body.append(dlg);
    dlg.showModal();
    const first = dlg.querySelector('input, textarea, select');
    if (first && !isPhone()) first.focus();
    else if (first && first.type !== 'date') setTimeout(() => first.focus(), 50);
  });
}

function dialogShell(title, message, body, buttons) {
  return h('form', { method: 'dialog', class: 'ui-dialog-body', novalidate: true },
    title ? h('h2', {}, title) : null,
    message ? h('p', { class: 'ui-dialog-msg' }, message) : null,
    body,
    h('div', { class: 'ui-dialog-actions' }, buttons));
}

function uiConfirm(message, { title = 'Bitte bestätigen', okText = 'OK', cancelText = 'Abbrechen', danger = false } = {}) {
  return openDialog((close) => dialogShell(title, message, null, [
    h('button', { type: 'button', class: 'ghost', onclick: () => close(false) }, cancelText),
    h('button', { type: 'button', class: danger ? 'danger-solid' : '', onclick: () => close(true) }, okText),
  ])).then((v) => v === true);
}

function uiAlert(message, { title = 'Hinweis', okText = 'Verstanden' } = {}) {
  return openDialog((close) => dialogShell(title, message, null, [
    h('button', { type: 'button', onclick: () => close(true) }, okText),
  ]));
}

/** Formular-Dialog; fields: [{ name, label, type, value, placeholder, required, minLength, min, max, step, inputmode, rows, hint }] */
function uiForm({ title, message, fields, okText = 'Speichern', cancelText = 'Abbrechen' }) {
  return openDialog((close) => {
    const inputs = {};
    const err = h('p', { class: 'error' });
    const rows = fields.map((f) => {
      const attrs = {
        name: f.name, value: f.value ?? '', placeholder: f.placeholder, required: !!f.required, min: f.min, max: f.max,
        step: f.step, inputmode: f.inputmode, autocomplete: f.autocomplete || 'off', maxlength: f.maxlength,
      };
      const el = f.type === 'textarea' ? h('textarea', { ...attrs, rows: f.rows || 3 })
        : f.type === 'select' ? h('select', { name: f.name }, (f.options || []).map(([v, l]) => h('option', { value: v, selected: String(v) === String(f.value ?? '') }, l)))
          : h('input', { ...attrs, type: f.type || 'text' });
      inputs[f.name] = el;
      return h('label', {}, f.label, el, f.hint ? h('span', { class: 'small muted' }, f.hint) : null);
    });
    const submit = () => {
      for (const f of fields) {
        const v = inputs[f.name].value.trim();
        if (f.required && !v) { err.textContent = `Bitte „${f.label}“ ausfüllen.`; inputs[f.name].focus(); return; }
        if (f.minLength && v && v.length < f.minLength) {
          err.textContent = `„${f.label}“: bitte mindestens ${f.minLength} Zeichen.`; inputs[f.name].focus(); return;
        }
      }
      close(Object.fromEntries(fields.map((f) => [f.name, inputs[f.name].value.trim()])));
    };
    const form = dialogShell(title, message, h('div', { class: 'ui-dialog-fields' }, rows, err), [
      h('button', { type: 'button', class: 'ghost', onclick: () => close(null) }, cancelText),
      h('button', { type: 'submit' }, okText),
    ]);
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    return form;
  });
}

/** Ein Eingabefeld; liefert den Text oder null bei Abbruch */
async function uiPrompt({ title, message, label, value = '', type = 'text', required = false, minLength, placeholder, multiline = false, inputmode, okText = 'OK', hint, autocomplete }) {
  const r = await uiForm({
    title, message, okText,
    fields: [{ name: 'v', label: label || '', value, type: multiline ? 'textarea' : type, required, minLength, placeholder, inputmode, hint, autocomplete }],
  });
  return r ? r.v : null;
}

/** Fragt eine Begründung ab; null = abgebrochen */
function askReason(text, required, { title = 'Begründung', okText = 'Bestätigen' } = {}) {
  return uiPrompt({
    title, message: text, label: required ? 'Begründung' : 'Begründung (optional)', required, minLength: required ? 3 : undefined,
    multiline: true, placeholder: 'z. B. Arzttermin, Tausch mit Kollegin …', okText,
  });
}

async function assign(s, userId, force = false) {
  let body = userId ? { user_id: userId, force } : {};
  if (!userId) {
    const required = !!state.settings.begruendung_eintragen;
    if (required) {
      const reason = await askReason(`Begründung für das Eintragen in ${s.type_name} am ${fmtDate(s.date)}:`, true);
      if (reason === null) return;
      body = { reason };
    }
  }
  try {
    await api('POST', `api/shifts/${s.id}/assign`, body);
    toast('Eingetragen.');
  } catch (e) {
    if (isMgr() && !force && (e.code === 'RUHEZEIT' || e.code === 'VOLL')
      && await uiConfirm(`${e.message} Trotzdem eintragen (Ausnahme durch die Einsatzplanung)?`, { title: 'Ausnahme', okText: 'Trotzdem eintragen' })) {
      return assign(s, userId, true);
    }
    toast(e.message, true);
  }
  refresh();
}

async function unassign(s, userId, name) {
  const who = name ? `${name} aus` : 'Sich aus';
  const required = !isMgr() && !!state.settings.begruendung_austragen;
  const reason = await askReason(`${who} ${s.type_name} am ${fmtDate(s.date)} (${s.unit_name}) austragen?`, required, { title: 'Austragen', okText: 'Austragen' });
  if (reason === null) return;
  try {
    await api('DELETE', `api/shifts/${s.id}/assign${isMgr() ? `?user_id=${userId}` : ''}`, { reason });
    toast('Ausgetragen.');
  } catch (e) { toast(e.message, true); }
  refresh();
}

async function editShift(s) {
  const r = await uiForm({
    title: `${s.type_name} · ${WD[weekday(s.date)]} ${fmtDate(s.date)}`, message: s.unit_name,
    fields: [
      { name: 'min', label: 'Mindestbesetzung', type: 'number', min: 0, step: 1, inputmode: 'numeric', value: s.min_staff, required: true },
      { name: 'max', label: 'Höchstbesetzung', type: 'number', min: 0, step: 1, inputmode: 'numeric', value: s.max_staff ?? '', hint: 'leer = unbegrenzt' },
      { name: 'note', label: 'Notiz (optional)', type: 'textarea', rows: 2, value: s.note || '', maxlength: 500 },
    ],
  });
  if (!r) return;
  try {
    await api('PUT', `api/shifts/${s.id}`, { min_staff: Number(r.min), max_staff: r.max === '' ? null : Number(r.max), note: r.note });
    toast('Gespeichert.');
  } catch (e) { toast(e.message, true); }
  refresh();
}

function refresh() { VIEWS[state.view].render(); refreshBadges(); }
