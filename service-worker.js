/**
 * service-worker.js — نبضة Chat
 *
 * Fixes:
 * 1. Auto-versioned cache — BUILD_HASH injected at deploy time,
 *    falls back to a timestamp so every new SW install gets a fresh cache.
 * 2. File paths corrected: all JS files are in root (no js/ prefix).
 * 3. No localStorage usage (not supported in SW context).
 * 4. Stale-while-revalidate for HTML — shows cached page instantly,
 *    updates in background.
 * 5. Cache-first for JS/CSS/images — fast loads offline.
 * 6. Logs kept minimal (only warnings/errors in production).
 */

/* ── Cache version ─────────────────────────────────────────
   At build/deploy time, replace __BUILD_HASH__ with a hash
   (e.g. git rev, timestamp, or content hash).
   If not replaced, falls back to deploy timestamp so every
   fresh SW registration busts the old cache automatically.
─────────────────────────────────────────────────────────── */
const _BUILD = 'v7-5-' + Date.now();

const CACHE_STATIC  = `nabda-static-${_BUILD}`;
const CACHE_DYNAMIC = `nabda-dynamic-${_BUILD}`;

/* ── Static files to pre-cache ────────────────────────────
   ✅ Paths match actual file locations (all in root, no js/ prefix)
─────────────────────────────────────────────────────────── */
const STATIC_FILES = [
  '/',
  'index.html',
  'style.css',
  'manifest.json',
  'icon.png',
  'firebase.js',
  'auth.js',
  'chat.js',
  'friends.js',
  'groups.js',
  'stories.js',
  'ui.js',
  'app.js',
];

/* ── Hosts to never cache (Firebase / CDN) ──────────────── */
const BYPASS_HOSTS = [
  'firebaseio.com',
  'googleapis.com',
  'gstatic.com',
  'firebaseapp.com',
  'identitytoolkit',
  'securetoken',
];

function _shouldBypass(url) {
  return BYPASS_HOSTS.some(h => url.includes(h));
}

/* ═══════════════════════════════════════════════════════════
   INSTALL — pre-cache static assets
═══════════════════════════════════════════════════════════ */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_STATIC)
      .then(cache => {
        // addAll fails if ANY file 404s — use individual puts to be resilient
        return Promise.allSettled(
          STATIC_FILES.map(path =>
            cache.add(path).catch(err =>
              console.warn('[SW] Could not pre-cache:', path, err.message)
            )
          )
        );
      })
      .then(() => self.skipWaiting()) // activate new SW immediately
  );
});

/* ═══════════════════════════════════════════════════════════
   ACTIVATE — delete all caches from previous versions
═══════════════════════════════════════════════════════════ */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE_STATIC && k !== CACHE_DYNAMIC)
          .map(k => {
            console.info('[SW] Removing old cache:', k);
            return caches.delete(k);
          })
      ))
      .then(() => self.clients.claim()) // take control of all open tabs
      // ✅ Notify all tabs that a new version is active
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(clients => clients.forEach(c => c.postMessage({ type: 'SW_UPDATED' })))
  );
});

/* ═══════════════════════════════════════════════════════════
   FETCH — tiered caching strategy
   • Firebase / CDN → bypass (never cache)
   • HTML            → stale-while-revalidate
   • JS / CSS / IMG  → cache-first
   • Everything else → network-first with dynamic cache fallback
═══════════════════════════════════════════════════════════ */
self.addEventListener('fetch', event => {
  // Only handle GET
  if (event.request.method !== 'GET') return;

  const url = event.request.url;

  // ── Firebase / external CDN — bypass entirely ──
  if (_shouldBypass(url)) return;

  // ── HTML — stale-while-revalidate ──────────────
  if (event.request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(_staleWhileRevalidate(event.request));
    return;
  }

  // ── JS / CSS / images — cache-first ───────────
  if (/\.(js|css|png|jpg|jpeg|webp|svg|woff2?|ico)(\?.*)?$/.test(url)) {
    event.respondWith(_cacheFirst(event.request));
    return;
  }

  // ── Everything else — network-first ───────────
  event.respondWith(_networkFirst(event.request));
});

/* ── Strategy: stale-while-revalidate ──────────────────── */
async function _staleWhileRevalidate(request) {
  const cache    = await caches.open(CACHE_STATIC);
  const cached   = await cache.match(request);
  const fetchProm = fetch(request)
    .then(res => {
      if (res && res.status === 200) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || await fetchProm;
}

/* ── Strategy: cache-first ──────────────────────────────── */
async function _cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res && res.status === 200) {
      const cache = await caches.open(CACHE_STATIC);
      cache.put(request, res.clone());
    }
    return res;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

/* ── Strategy: network-first with dynamic cache fallback ── */
async function _networkFirst(request) {
  try {
    const res = await fetch(request);
    if (res && res.status === 200) {
      const cache = await caches.open(CACHE_DYNAMIC);
      cache.put(request, res.clone());
    }
    return res;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503 });
  }
}

/* ═══════════════════════════════════════════════════════════
   PUSH NOTIFICATIONS
═══════════════════════════════════════════════════════════ */
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'نبضة', {
      body:  data.body  || 'رسالة جديدة',
      icon:  'icon.png',
      badge: 'icon.png',
      tag:   data.tag   || 'nabda-msg',
      data,
    })
  );
});

/* ═══════════════════════════════════════════════════════════
   NOTIFICATION CLICK
═══════════════════════════════════════════════════════════ */
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

/* ═══════════════════════════════════════════════════════════
   MESSAGE — from app.js
   Supported: SKIP_WAITING, GET_VERSION
═══════════════════════════════════════════════════════════ */
self.addEventListener('message', event => {
  if (!event.data) return;

  // Force activate new SW (called from app.js update prompt)
  if (event.data === 'SKIP_WAITING' || event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  // Return current cache version (for debugging / update detection)
  if (event.data?.type === 'GET_VERSION') {
    event.source?.postMessage({ type: 'VERSION', version: _BUILD });
  }
});
