/* Service Worker: speichert nur die Programmdateien (App-Hülle), damit die App schnell startet.
   Dienstplan- und Personaldaten (/api/...) werden NIE zwischengespeichert. */
const CACHE = 'pep-v9';
const SHELL = ['./', 'index.html', 'style.css', 'icon.svg', 'manifest.webmanifest',
  'js/core.js', 'js/auth-login.js', 'js/nav.js', 'js/plan.js', 'js/dialogs.js', 'js/mitarbeiter.js', 'js/fotos.js', 'js/campus.js', 'js/personal.js', 'js/verwaltung.js', 'js/abwesenheit.js', 'js/kalender.js', 'js/tausch.js', 'js/konto.js'];
const API = new URL('api/', self.registration.scope).pathname;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
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
