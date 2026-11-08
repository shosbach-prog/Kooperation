'use strict';
/* Benachrichtigungen: Glocke, Mitteilungsliste, Push-Nachrichten, Rundruf */

state.notif = { unread: 0 };

function bellButton() {
  let btn = document.getElementById('bell');
  if (!btn) {
    btn = h('button', { id: 'bell', class: 'ghost bell', type: 'button', 'aria-label': 'Mitteilungen', onclick: () => openNotifications() });
    const who = document.querySelector('.who');
    who.insertBefore(btn, who.firstChild);
  }
  const n = state.notif.unread;
  btn.replaceChildren(...[icon('bell'), n ? h('span', { class: 'tab-badge' }, n > 99 ? '99+' : String(n)) : null].filter(Boolean));
  btn.setAttribute('aria-label', n ? `Mitteilungen, ${n} ungelesen` : 'Mitteilungen');
  return btn;
}

async function refreshNotifications() {
  if (!state.me) return;
  try {
    const r = await api('GET', 'api/notifications');
    state.notif = r;
    bellButton();
  } catch { /* ignorieren */ }
}

const timeAgo = (iso) => {
  const d = new Date(`${iso.replace(' ', 'T')}Z`);
  const min = Math.round((Date.now() - d) / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  if (min < 24 * 60) return `vor ${Math.round(min / 60)} Std.`;
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

async function openNotifications() {
  await refreshNotifications();
  const items = state.notif.items || [];
  await openDialog((close) => dialogShell('Mitteilungen', items.length ? null : 'Keine Mitteilungen.',
    h('ul', { class: 'notif-list' }, items.map((n) => h('li', { class: n.read_at ? '' : 'unread' },
      h('button', { type: 'button', class: 'notif-item', onclick: () => close(n) },
        h('strong', {}, n.titel), h('span', {}, n.text), h('span', { class: 'small muted' }, timeAgo(n.created_at)))))),
    [h('button', { type: 'button', class: 'ghost', onclick: () => close('alle') }, 'Alle als gelesen markieren'),
      h('button', { type: 'button', onclick: () => close(null) }, 'Schließen')])).then(async (r) => {
    if (r === 'alle') await api('POST', 'api/notifications/read', {});
    else if (r && r.id) {
      await api('POST', 'api/notifications/read', { ids: [r.id] });
      const key = (r.link || '').replace(/^#/, '');
      if (VIEWS[key] && viewAllowed(VIEWS[key])) go(key);
    }
    refreshNotifications();
  });
}

// alle 60 Sekunden aktualisieren, solange die Seite sichtbar ist
setInterval(() => { if (document.visibilityState === 'visible') refreshNotifications(); }, 60000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshNotifications(); });

// --- Push-Nachrichten ---
const b64ToBytes = (b64) => {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function enablePush() {
  if (!pushSupported()) throw new Error('Dieser Browser unterstützt keine Push-Nachrichten. Auf dem iPhone: App zuerst über „Zum Home-Bildschirm“ installieren und von dort öffnen.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Benachrichtigungen wurden nicht erlaubt. Sie können das in den Einstellungen des Browsers bzw. Handys ändern.');
  const reg = await navigator.serviceWorker.ready;
  const { key } = await api('GET', 'api/push/key');
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
  await api('POST', 'api/push/subscribe', { subscription: sub.toJSON() });
}
async function disablePush() {
  if (pushSupported()) {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub) { await api('DELETE', 'api/push/subscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); return; }
  }
  await api('DELETE', 'api/push/subscribe', {});
}

async function notifyCard() {
  const p = await api('GET', 'api/me/notify-prefs');
  let aktiv = false;
  if (pushSupported()) {
    try { const reg = await navigator.serviceWorker.getRegistration(); aktiv = !!(reg && await reg.pushManager.getSubscription()); } catch { /* */ }
  }
  const email = h('input', { type: 'checkbox', checked: p.email, disabled: !p.email_verfuegbar || !p.hat_email });
  email.addEventListener('change', async () => { await api('PUT', 'api/me/notify-prefs', { email: email.checked }); toast('Gespeichert.'); });
  return h('div', { class: 'card', style: { maxWidth: '640px' } }, h('h2', {}, 'Benachrichtigungen'),
    h('p', { class: 'muted' }, 'Sie werden informiert, wenn sich an Ihren Diensten etwas ändert, Urlaub entschieden wird, ein Tauschangebot eingeht oder ein Dienst dringend besetzt werden muss.'),
    h('div', { class: 'toolbar' },
      aktiv ? h('span', { class: 'badge ok' }, 'Push auf diesem Gerät aktiv') : h('span', { class: 'badge warn' }, 'Push auf diesem Gerät aus'),
      h('button', { type: 'button', class: aktiv ? 'ghost' : '', onclick: async () => {
        try { if (aktiv) await disablePush(); else await enablePush(); toast(aktiv ? 'Push ausgeschaltet.' : 'Push eingeschaltet.'); renderAccount(); } catch (e) { toast(e.message, true); }
      } }, aktiv ? 'Push ausschalten' : 'Push einschalten'),
      h('button', { type: 'button', class: 'ghost', onclick: async () => { await api('POST', 'api/me/notify-test'); toast('Test gesendet.'); refreshNotifications(); } }, 'Test senden')),
    h('label', { class: 'check' }, email, h('span', {}, 'Zusätzlich per E-Mail',
      h('span', { class: 'small muted', style: { display: 'block' } },
        !p.email_verfuegbar ? 'Der Server ist (noch) nicht für E-Mail eingerichtet.' : !p.hat_email ? 'In Ihrer Personalakte ist keine E-Mail-Adresse hinterlegt.' : 'an Ihre dienstliche E-Mail-Adresse'))),
    h('p', { class: 'small muted' }, 'Push funktioniert auf Android (Chrome) und am PC direkt, auf dem iPhone ab iOS 16.4, wenn die App über „Zum Home-Bildschirm“ installiert ist.'));
}

/** Rundruf für einen unterbesetzten Dienst */
async function rundruf(s) {
  const quals = (s.verbund?.gemeinsam ? s.verbund.qual_missing : s.qual_missing).map((q) => q.qualification);
  const r = await uiForm({
    title: 'Rundruf: Dienst unbesetzt', message: `${s.type_name} · ${WD[weekday(s.date)]} ${fmtDate(s.date)} · ${s.unit_name}`, okText: 'Benachrichtigen',
    fields: [
      { name: 'qualification', label: 'Nur Personen mit Qualifikation', type: 'select', value: quals[0] || '',
        options: [['', 'alle'], ...(state.settings.qualifikationen || []).map((q) => [q, q])] },
      { name: 'note', label: 'Nachricht (optional)', type: 'textarea', rows: 2, maxlength: 300, placeholder: 'z. B. Krankheitsausfall, dringend' },
    ],
  });
  if (!r) return;
  try {
    const res = await api('POST', `api/shifts/${s.id}/rundruf`, r);
    toast(res.empfaenger ? `${res.empfaenger} Person(en) benachrichtigt.` : 'Niemand verfügbar (Abwesenheit, Ruhezeit oder Qualifikation).', !res.empfaenger);
  } catch (e) { toast(e.message, true); }
}
