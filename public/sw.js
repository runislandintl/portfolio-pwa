// v6 — NO CACHE. Réseau pur. Push maintenu.
const CACHE_NAME = 'portfolio-v6';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => clients.claim())
  );
});

// Tout passe par le réseau sans cache
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request, { cache: 'no-store' }));
});

// ── Push ──────────────────────────────────────────────────────────────────
self.addEventListener('push', e => {
  let data = { title: '📊 Portfolio', body: '—' };
  try { data = JSON.parse(e.data.text()); } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body, icon: '/icon.svg', badge: '/icon.svg',
      tag: 'portfolio-alert', renotify: true,
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow('/'));
});
