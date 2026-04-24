/* service-worker.js — نبضة Chat v5 */
const CACHE_NAME = 'nabda-v5';
const STATIC_FILES = [
  '/',
  'index.html',
  'style.css',
  'manifest.json',
  'icon.png',
  'js/firebase.js',
  'js/auth.js',
  'js/chat.js',
  'js/friends.js',
  'js/groups.js',
  'js/stories.js',
  'js/ui.js',
  'js/app.js'
];

/* ── Install: cache static files ─────────────────────────── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_FILES).catch(() => {}))
      .then(() => self.skipWaiting())   // activate immediately
  );
});

/* ── Activate: delete old caches ─────────────────────────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())  // take control immediately
  );
});

/* ── Fetch: network-first for API, cache-first for assets ── */
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = event.request.url;

  // Never cache Firebase or CDN requests
  if (
    url.includes('firebase') ||
    url.includes('gstatic.com') ||
    url.includes('googleapis.com')
  ) return;

  // Network-first strategy: try network, fall back to cache
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache a clone of the fresh response
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

/* ── Push notifications ───────────────────────────────────── */
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'نبضة', {
      body:  data.body  || 'رسالة جديدة',
      icon:  'icon.png',
      badge: 'icon.png',
      tag:   data.tag   || 'nabda-msg',
      data:  data
    })
  );
});

/* ── Notification click ───────────────────────────────────── */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        for (const client of clientList) {
          if (client.url.includes(self.location.origin) && 'focus' in client)
            return client.focus();
        }
        return clients.openWindow('/');
      })
  );
});

/* ── Message: force update ────────────────────────────────── */
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
