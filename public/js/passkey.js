'use strict';
/* Passkeys: Anmeldung mit Fingerabdruck, Gesichtserkennung oder Geräte-PIN (WebAuthn) */

const passkeySupported = () => !state.branding?.demo && !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);

const b64u = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer; },
};

function creationOptions(o) {
  if (PublicKeyCredential.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(o);
  return { ...o, challenge: b64u.dec(o.challenge), user: { ...o.user, id: b64u.dec(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64u.dec(c.id) })) };
}
function requestOptions(o) {
  if (PublicKeyCredential.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(o);
  return { ...o, challenge: b64u.dec(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: b64u.dec(c.id) })) };
}
function credJSON(c) {
  if (typeof c.toJSON === 'function') { try { return c.toJSON(); } catch { /* Fallback unten */ } }
  const r = c.response;
  const response = { clientDataJSON: b64u.enc(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = b64u.enc(r.attestationObject);
    response.transports = r.getTransports ? r.getTransports() : [];
  } else {
    response.authenticatorData = b64u.enc(r.authenticatorData);
    response.signature = b64u.enc(r.signature);
    if (r.userHandle) response.userHandle = b64u.enc(r.userHandle);
  }
  return { id: c.id, rawId: b64u.enc(c.rawId), type: c.type, response, clientExtensionResults: c.getClientExtensionResults(), authenticatorAttachment: c.authenticatorAttachment };
}
const passkeyAbbruch = (e) => e && (e.name === 'NotAllowedError' || e.name === 'AbortError');

/** Anmeldung mit Passkey (Anmeldeseite) */
async function loginWithPasskey() {
  const err = document.getElementById('login-error');
  try {
    const { id, options } = await api('POST', 'api/passkeys/login/options');
    const cred = await navigator.credentials.get({ publicKey: requestOptions(options) });
    await api('POST', 'api/passkeys/login/verify', { id, response: credJSON(cred) });
    await boot();
  } catch (e) {
    if (err) err.textContent = passkeyAbbruch(e) ? 'Anmeldung mit Passkey abgebrochen.' : e.message;
  }
}

function passkeyLoginButton() {
  if (!passkeySupported()) return null;
  return h('div', { class: 'passkey-login' },
    h('div', { class: 'oder', 'aria-hidden': 'true' }, 'oder'),
    h('button', { type: 'button', class: 'ghost', onclick: loginWithPasskey }, icon('fingerprint'), ' Mit Passkey anmelden'),
    h('p', { class: 'small muted' }, 'Fingerabdruck, Gesichtserkennung oder Geräte-PIN – einrichten unter „Mein Profil“.'));
}

function geraeteName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android-Handy';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows-PC';
  return 'Mein Gerät';
}

/** Karte „Passkeys“ im Profil */
async function passkeyCard() {
  const card = h('div', { class: 'card', style: { maxWidth: '480px' } });
  const render = async () => {
    const list = await api('GET', 'api/passkeys').catch(() => []);
    card.replaceChildren(h('h2', {}, 'Passkeys (Fingerabdruck / Face ID)'),
      h('p', { class: 'small muted' }, 'Mit einem Passkey melden Sie sich ohne Passwort und ohne Code an – per Fingerabdruck, Gesichtserkennung oder Geräte-PIN. ',
        'Der Schlüssel bleibt sicher auf Ihrem Gerät; biometrische Daten werden nicht übertragen.'),
      list.length ? h('ul', { class: 'passkey-list' }, list.map((p) => h('li', {},
        h('div', {}, h('strong', {}, p.name), h('div', { class: 'small muted' }, `eingerichtet ${fmtDate(p.created_at.slice(0, 10))}`,
          p.last_used ? ` · zuletzt genutzt ${fmtDate(p.last_used.slice(0, 10))}` : ' · noch nicht genutzt')),
        h('div', { class: 'actions' },
          h('button', { class: 'tiny ghost', 'aria-label': `${p.name} umbenennen`, onclick: async () => {
            const name = await uiPrompt({ title: 'Passkey umbenennen', label: 'Name', value: p.name, required: true });
            if (!name) return;
            try { await api('PATCH', `api/passkeys/${p.id}`, { name }); render(); } catch (e) { toast(e.message, true); }
          } }, 'Umbenennen'),
          h('button', { class: 'tiny danger', 'aria-label': `${p.name} entfernen`, onclick: async () => {
            if (!await uiConfirm(`„${p.name}“ kann danach nicht mehr zur Anmeldung verwendet werden.`, { title: 'Passkey entfernen?', okText: 'Entfernen', danger: true })) return;
            try { await api('DELETE', `api/passkeys/${p.id}`); toast('Entfernt.'); render(); } catch (e) { toast(e.message, true); }
          } }, 'Entfernen'))))) : h('p', { class: 'muted' }, 'Noch kein Passkey eingerichtet.'),
      passkeySupported()
        ? h('button', { onclick: async () => {
          const name = await uiPrompt({ title: 'Passkey einrichten', message: 'Ihr Gerät fragt gleich nach Fingerabdruck, Gesicht oder PIN.', label: 'Name für dieses Gerät', value: geraeteName(), required: true, okText: 'Weiter' });
          if (!name) return;
          try {
            const options = await api('POST', 'api/passkeys/register/options');
            const cred = await navigator.credentials.create({ publicKey: creationOptions(options) });
            await api('POST', 'api/passkeys/register/verify', { name, response: credJSON(cred) });
            toast('Passkey eingerichtet. Sie können sich ab jetzt damit anmelden.');
            render();
          } catch (e) { toast(passkeyAbbruch(e) ? 'Einrichtung abgebrochen.' : e.message, true); }
        } }, 'Passkey auf diesem Gerät einrichten')
        : h('p', { class: 'small muted' }, 'Dieser Browser unterstützt keine Passkeys (oder die Seite ist nicht über HTTPS geöffnet).'));
  };
  await render();
  return card;
}
