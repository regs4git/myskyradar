// VERSÃO DA CACHE - Incrementar sempre que houver alterações
const CACHE_VERSION = 'v1.2';
const CACHE_NAME = `myskyradar-${CACHE_VERSION}`;

const ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png'
];

self.addEventListener('install', (e) => {
  console.log(`[SW] Instalando versão ${CACHE_VERSION}`);
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  console.log(`[SW] Ativando versão ${CACHE_VERSION}`);
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => {
          console.log(`[SW] A apagar cache antiga: ${key}`);
          return caches.delete(key);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Deixar passar pedidos cross-origin (ex. api.adsb.lol) sem os intercetar —
  // o SW só deve tratar dos assets da própria app.
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request).then((response) => {
      if (response) return response;
      return fetch(e.request).catch((err) => {
        if (e.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        throw err;
      });
    })
  );
});
