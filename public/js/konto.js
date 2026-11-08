'use strict';
/* Zwei-Faktor-Anmeldung, Mein Profil, Start der App */

// ---------- Zwei-Faktor-Anmeldung ----------
function authShell(...children) {
  hideAppChrome();
  setMain(h('section', { class: 'login card' }, children));
}

async function cancelLogin() {
  await api('POST', 'api/logout').catch(() => {});
  renderLogin();
}

function renderCodeStep() {
  const input = h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', required: true, autofocus: true,
    placeholder: '123456', maxlength: 11, class: 'code-input' });
  const err = h('p', { class: 'error' });
  const form = h('form', {},
    h('label', {}, 'Code aus der Authenticator-App', input),
    h('button', { type: 'submit' }, 'Bestätigen'), err);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const r = await api('POST', 'api/login/2fa', { code: input.value });
      if (r.used_recovery) {
        await uiAlert(`Sie haben sich mit einem Wiederherstellungscode angemeldet. Noch ${r.user.recovery_left} Codes übrig.\n\n`
          + 'Bitte richten Sie unter „Sicherheit“ neue Codes ein oder lassen Sie die 2FA von der Einsatzplanung zurücksetzen.');
      }
      await boot();
    } catch (e) {
      err.textContent = e.message;
      input.select();
      if (e.status === 401 && e.code !== 'CODE') setTimeout(renderLogin, 1500);
    }
  });
  authShell(h('h1', {}, 'Zwei-Faktor-Anmeldung'),
    h('p', { class: 'muted' }, 'Öffnen Sie Ihre Authenticator-App und geben Sie den 6-stelligen Code ein.'),
    form,
    h('details', {}, h('summary', { class: 'small' }, 'Kein Zugriff auf das Handy?'),
      h('p', { class: 'small muted' }, 'Geben Sie oben einen Ihrer Wiederherstellungscodes ein (Format xxxxx-xxxxx). ',
        'Jeder Code funktioniert nur einmal. Ohne Codes kann die Einsatzplanung Ihre 2FA zurücksetzen.')),
    h('p', {}, h('button', { class: 'ghost', type: 'button', onclick: cancelLogin }, 'Abbrechen')));
  input.focus();
}

/** Einrichtung des zweiten Faktors – bei der ersten Anmeldung (inApp=false) oder unter „Sicherheit“ */
async function renderSetup(inApp, neu = false) {
  let data;
  try { data = await api('POST', 'api/2fa/setup', neu ? { neu: true } : undefined); } catch (e) { if (!inApp) renderLogin(); else toast(e.message, true); return; }
  const input = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', required: true, placeholder: '123456', maxlength: 6, class: 'code-input' });
  const err = h('p', { class: 'error' });
  const form = h('form', {}, h('label', {}, '3. Angezeigten Code eingeben', input), h('button', { type: 'submit' }, 'Aktivieren'), err);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const r = await api('POST', 'api/2fa/enable', { code: input.value });
      showRecoveryCodes(r.recovery_codes, inApp ? () => go('account') : boot);
    } catch (e) { err.textContent = e.message; input.select(); }
  });
  const rawSecret = data.secret.replace(/\s/g, '');
  const copyKey = () => navigator.clipboard.writeText(rawSecret)
    .then(() => toast('Schlüssel kopiert. In der Authenticator-App „Schlüssel eingeben“ wählen und einfügen.'))
    .catch(() => toast('Kopieren nicht möglich – bitte den Schlüssel abtippen.', true));
  const onThisPhone = isPhone() || window.matchMedia('(pointer: coarse)').matches;
  const phoneWay = h('div', { class: 'setup-phone' },
    h('a', { class: 'button-link', href: data.uri }, '📲 In Authenticator-App öffnen'),
    h('p', { class: 'small muted' }, 'Die App öffnet sich und fragt, ob das Konto hinzugefügt werden soll. Bestätigen, dann hierher ',
      'zurückwechseln und den 6-stelligen Code eingeben.'),
    h('details', {}, h('summary', { class: 'small' }, 'App öffnet sich nicht? Schlüssel von Hand eingeben'),
      h('p', { class: 'small' }, 'In der App „Konto hinzufügen“ → „Schlüssel eingeben“ (bzw. „Einrichtungsschlüssel“) wählen:'),
      h('div', { class: 'key-row' }, h('code', { class: 'secret' }, data.secret), h('button', { type: 'button', class: 'tiny', onclick: copyKey }, 'Kopieren')),
      h('p', { class: 'small muted' }, `Kontoname: ${state.branding?.klinik_name || 'Dienstplan'} · Typ: zeitbasiert · 6 Stellen`)));
  const qrWay = h('div', {},
    h('div', { class: 'qr' }, h('img', { src: data.qr, alt: 'QR-Code für die Authenticator-App', width: 220, height: 220 })),
    h('details', {}, h('summary', { class: 'small' }, 'QR-Code lässt sich nicht scannen?'),
      h('p', { class: 'small' }, 'Schlüssel manuell eingeben (zeitbasiert, 6 Stellen):'),
      h('div', { class: 'key-row' }, h('code', { class: 'secret' }, data.secret), h('button', { type: 'button', class: 'tiny', onclick: copyKey }, 'Kopieren'))));
  const content = [
    h('h1', {}, 'Zwei-Faktor-Anmeldung einrichten'),
    !inApp ? h('p', { class: 'muted' }, 'Zum Schutz der Dienstplan- und Personaldaten ist ein zweiter Faktor vorgeschrieben. Die Einrichtung dauert etwa eine Minute.') : null,
    h('ol', { class: 'steps' },
      h('li', {}, 'Installieren Sie eine Authenticator-App auf Ihrem Handy, z. B. ', h('strong', {}, 'Google Authenticator'), ', ',
        h('strong', {}, 'Microsoft Authenticator'), ', ', h('strong', {}, '2FAS'), ' oder ', h('strong', {}, 'FreeOTP'), ' (kostenlos im App Store / Play Store).'),
      onThisPhone
        ? h('li', {}, 'Konto in die App übernehmen:', phoneWay,
          h('details', {}, h('summary', { class: 'small' }, 'Einrichtung lieber mit QR-Code (z. B. am PC)?'), qrWay))
        : h('li', {}, 'Scannen Sie in der App diesen QR-Code:', qrWay,
          h('p', { class: 'small muted' }, 'Sie sind schon am Handy mit der App? Dann ', h('a', { href: data.uri }, 'hier tippen'), ', um das Konto direkt zu übernehmen.'))),
    form,
    h('p', {}, h('button', { class: 'ghost', type: 'button', onclick: inApp ? () => go('account') : cancelLogin }, 'Abbrechen')),
  ];
  if (inApp) setMain(h('section', { class: 'card', style: { maxWidth: '480px' } }, content));
  else authShell(content);
  input.focus();
}

function showRecoveryCodes(codes, onDone) {
  const confirmBox = h('input', { type: 'checkbox' });
  const done = h('button', { disabled: true, onclick: onDone }, 'Weiter');
  confirmBox.addEventListener('change', () => { done.disabled = !confirmBox.checked; });
  const text = codes.join('\n');
  const content = [
    h('h1', {}, 'Wiederherstellungscodes'),
    h('p', {}, 'Falls Sie Ihr Handy verlieren, können Sie sich mit einem dieser Codes anmelden. ',
      h('strong', {}, 'Jeder Code gilt nur einmal und wird nur jetzt angezeigt.')),
    h('pre', { class: 'codes' }, text),
    h('div', { class: 'toolbar' },
      h('button', { class: 'ghost', type: 'button', onclick: () => navigator.clipboard.writeText(text).then(() => toast('Kopiert.'), () => toast('Kopieren nicht möglich.', true)) }, 'Kopieren'),
      h('button', { class: 'ghost', type: 'button', onclick: () => window.print() }, 'Drucken')),
    h('label', { class: 'check' }, confirmBox, 'Ich habe die Codes sicher aufbewahrt (nicht auf dem Handy mit der App).'),
    h('p', {}, done),
  ];
  if (state.me) setMain(h('section', { class: 'card', style: { maxWidth: '480px' } }, content));
  else authShell(content);
}

// ---------- Sicherheit: Passwort und 2FA ----------
async function refreshMe() {
  const { user } = await api('GET', 'api/me');
  state.me = user;
  renderWho();
}
function renderWho() {
  const rolle = state.me.is_haupt ? 'Hauptverwaltung' : state.me.admin_rechte === 'vertretung' && isMgr() ? `Vertretung bis ${fmtDate(state.me.admin_bis)}`
    : isMgr() ? 'Verwaltung' : 'Mitarbeiter/in';
  document.getElementById('who').replaceChildren(h('span', { class: 'person', title: `${state.me.name} (${rolle})` }, avatar(state.me, 28),
    h('span', { class: 'who-name' }, `${state.me.name} (${rolle})`)), demoWho());
}

async function renderAccount() {
  const { user, settings } = await api('GET', 'api/me');
  state.me = user; state.settings = settings;
  const form = h('form', { class: 'card', style: { maxWidth: '480px' } }, h('h2', {}, 'Passwort ändern'),
    h('label', {}, 'Aktuelles Passwort', h('input', { name: 'old_password', type: 'password', required: true, autocomplete: 'current-password' })),
    h('label', {}, 'Neues Passwort (mind. 8 Zeichen)', h('input', { name: 'new_password', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' })),
    h('p', {}, h('button', { type: 'submit' }, 'Ändern')));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try { await api('POST', 'api/me/password', Object.fromEntries(new FormData(form))); toast('Passwort geändert.'); form.reset(); } catch (e) { toast(e.message, true); }
  });

  const askCode = (question) => uiPrompt({ title: question, label: 'Aktueller Code aus der Authenticator-App', inputmode: 'numeric',
    placeholder: '123456', required: true, autocomplete: 'one-time-code', okText: 'Bestätigen' });
  const twofa = h('div', { class: 'card', style: { maxWidth: '480px' } }, h('h2', {}, 'Zwei-Faktor-Anmeldung'),
    user.totp_enabled
      ? [h('p', {}, h('span', { class: 'badge ok' }, 'eingerichtet'), ` · ${user.recovery_left} Wiederherstellungscodes übrig`),
        h('div', { class: 'toolbar' },
          h('button', { class: 'ghost', onclick: async () => {
            const code = await askCode('Neue Wiederherstellungscodes erzeugen? Die alten werden ungültig.');
            if (!code) return;
            try { const r = await api('POST', 'api/2fa/recovery-codes', { code }); showRecoveryCodes(r.recovery_codes, () => go('account')); } catch (e) { toast(e.message, true); }
          } }, 'Neue Wiederherstellungscodes'),
          h('button', { class: 'ghost', onclick: async () => {
            if (await uiConfirm('Danach gilt nur noch der neue Schlüssel; die App auf dem alten Handy funktioniert nicht mehr.', { title: 'Neues Handy einrichten?', okText: 'Weiter' })) renderSetup(true, true);
          } }, 'Neues Handy einrichten'),
          !settings.zwei_faktor_pflicht ? h('button', { class: 'danger', onclick: async () => {
            const code = await askCode('Zwei-Faktor-Anmeldung deaktivieren?');
            if (!code) return;
            try { await api('POST', 'api/2fa/disable', { code }); toast('Deaktiviert.'); renderAccount(); } catch (e) { toast(e.message, true); }
          } }, 'Deaktivieren') : null)]
      : [h('p', {}, h('span', { class: 'badge warn' }, 'nicht eingerichtet')),
        h('p', {}, h('button', { onclick: () => renderSetup(true) }, 'Jetzt einrichten'))]);
  const profil = h('div', { class: 'card', style: { maxWidth: '480px' } }, h('h2', {}, 'Mein Foto'),
    fotoControl(user, 'api/me/foto', async () => { await refreshMe(); renderAccount(); }));
  setMain(profil, await notifyCard(), await kalenderCard(), await passkeyCard(), form, twofa, datenCard());
}

// Als App installierbar (Startbildschirm); der Service Worker speichert nur die Programmdateien, keine Personaldaten
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

loadBranding().then(async () => { if (!await demoAutoLogin()) await boot(); });
