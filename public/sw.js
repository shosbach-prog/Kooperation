/* Service Worker: speichert nur die Programmdateien (App-Hülle), damit die App schnell startet.
   Dienstplan- und Personaldaten (/api/...) werden NIE zwischengespeichert. */
const CACHE = 'pep-v13';
const SHELL = ['./', 'index.html', 'style.css', 'icon.svg', 'manifest.webmanifest',
  'js/core.js', 'js/auth-login.js', 'js/nav.js', 'js/plan.js', 'js/dialogs.js', 'js/mitarbeiter.js', 'js/fotos.js', 'js/campus.js', 'js/personal.js', 'js/verwaltung.js', 'js/abwesenheit.js', 'js/kalender.js', 'js/tausch.js', 'js/benachrichtigungen.js', 'js/wuensche.js', 'js/zeiten.js', 'js/export.js', 'js/konto.js'];
const API = new URL('api/', self.registration.scope).pathname;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Push-Nachrichten anzeigen
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { titel: 'Dienstplan', text: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.titel || 'Dienstplan', {
    body: d.text || '', tag: d.tag || 'info', icon: 'icon-192.png', badge: 'icon-192.png', data: { link: d.link || '' }, lang: 'de',
  }));
});
// Antippen öffnet die App an der passenden Stelle
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.link || '', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if (c.url.startsWith(self.registration.scope)) { c.navigate(url); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith(API)) return;
  // Netz zuerst (immer aktuelle Version), bei Funkloch die gespeicherte Hülle
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('./'))));
});
