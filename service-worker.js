/**
 * service-worker.js — نبضة Chat (v2)
 *
 * v1 features:
 * 1. Auto-versioned cache
 * 2. Stale-while-revalidate for HTML
 * 3. Cache-first for JS/CSS/images
 * 4. Basic Push Notifications
 * 5. SW_UPDATED message to tabs
 *
 * v2 additions:
 * 6. Background Sync — يُعيد إرسال الرسائل الفاشلة عند عودة الإنترنت
 * 7. Push notification تفتح المحادثة المحددة عند الضغط (deep link)
 * 8. Push notification action buttons (رد / تجاهل)
 * 9. notificationclick → يفتح DM أو مجموعة محددة
 * 10. STORE_PENDING_MSG / GET_PENDING_MSGS من app.js
 */

/* ── Cache version ─────────────────────────────────────────
   At build/deploy time, replace __BUILD_HASH__ with a hash.
   Falls back to timestamp for automatic cache busting.
─────────────────────────────────────────────────────────── */
const _BUILD = 'v8-' + Date.now();

const CACHE_STATIC   = `nabda-static-${_BUILD}`;
const CACHE_DYNAMIC  = `nabda-dynamic-${_BUILD}`;
const DYNAMIC_LIMIT  = 30;

/* ═══════════════════════════════════════════════════════════
   INDEXEDDB — تخزين الرسائل المعلّقة في SW (v2)
   Background Sync يحتاج تخزيناً مستمراً — لا يمكن استخدام
   localStorage في SW، لذا نستخدم IndexedDB مباشرة
═══════════════════════════════════════════════════════════ */
const IDB_NAME    = 'nabda_sw_v1';
const IDB_STORE   = 'pending_msgs';

function _openSwIDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore(IDB_STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

async function _swIdbAdd(msg) {
  const db = await _openSwIDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const req = tx.objectStore(IDB_STORE).add(msg);
    req.onsuccess = () => res(req.result);
    req.onerror   = e => rej(e.target.error);
  });
}

async function _swIdbGetAll() {
  const db = await _openSwIDB();
  return new Promise((res, rej) => {
    const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror   = e => rej(e.target.error);
  });
}

async function _swIdbDelete(id) {
  const db = await _openSwIDB();
  return new Promise((res, rej) => {
    const req = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).delete(id);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  });
}

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

/* ── Trim dynamic cache to max size ────────────────────── */
async function _trimCache(cacheName, maxItems) {
  const cache = await caches.open(cacheName);
  const keys  = await cache.keys();
  if (keys.length > maxItems) {
    // احذف القديم (FIFO)
    await Promise.all(keys.slice(0, keys.length - maxItems).map(k => cache.delete(k)));
  }
}

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
      await cache.put(request, res.clone());
      _trimCache(CACHE_DYNAMIC, DYNAMIC_LIMIT); // لا نتوقف عليها
    }
    return res;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    // صفحة offline جميلة للـ HTML
    if (request.headers.get('accept')?.includes('text/html')) {
      return caches.match('/offline.html') ||
             new Response(_offlinePage(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    return new Response('Offline', { status: 503 });
  }
}

/* ── Offline page HTML ──────────────────────────────────── */
function _offlinePage() {
  return `<!DOCTYPE html><html dir="rtl" lang="ar"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>نبضة — غير متصل</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{min-height:100vh;display:flex;flex-direction:column;align-items:center;
         justify-content:center;background:#0d0d1a;color:#fff;font-family:system-ui,sans-serif;
         padding:20px;text-align:center}
    .icon{font-size:64px;margin-bottom:20px}
    h1{font-size:22px;font-weight:800;margin-bottom:10px}
    p{font-size:14px;color:#a0aec0;margin-bottom:24px;line-height:1.6}
    button{padding:12px 28px;border:none;border-radius:12px;
           background:linear-gradient(135deg,#6366f1,#8b5cf6);
           color:#fff;font-size:15px;font-weight:700;cursor:pointer}
  </style></head><body>
  <div class="icon">📡</div>
  <h1>لا يوجد اتصال</h1>
  <p>تحقق من اتصالك بالإنترنت<br>وحاول مجدداً</p>
  <button onclick="location.reload()">إعادة المحاولة</button>
  </body></html>`;
}

/* ═══════════════════════════════════════════════════════════
   PUSH NOTIFICATIONS (v2)
   يدعم:
   - action buttons: رد سريع / تجاهل
   - deep link: chatType + chatId للفتح المباشر
   - badge + icon مخصص
   Payload JSON المتوقع من الـ server:
   {
     title:    'اسم المُرسل',
     body:     'نص الرسالة',
     tag:      'dm_uid1_uid2' | 'group_gid',
     chatType: 'dm' | 'group',
     chatId:   'uid أو gid',
     senderUid: '...',
     icon:     'icon.png'  (اختياري)
   }
═══════════════════════════════════════════════════════════ */
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}

  const options = {
    body:    data.body    || 'رسالة جديدة',
    icon:    data.icon    || 'icon.png',
    badge:   'icon.png',
    tag:     data.tag     || 'nabda-msg',
    // v2: action buttons
    actions: [
      { action: 'reply',  title: '↩️ رد'   },
      { action: 'dismiss', title: '✕ تجاهل' },
    ],
    // v2: بيانات للـ notificationclick
    data: {
      chatType:  data.chatType  || 'dm',
      chatId:    data.chatId    || '',
      senderUid: data.senderUid || '',
      url:       self.location.origin + '/',
    },
    requireInteraction: false,
    vibrate: [100, 50, 100],
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'نبضة 💬', options)
  );
});

/* ═══════════════════════════════════════════════════════════
   NOTIFICATION CLICK (v2)
   - زر "رد"    → يفتح التطبيق على المحادثة
   - زر "تجاهل" → يُغلق الإشعار فقط
   - ضغط عادي   → يفتح التطبيق على المحادثة (deep link)
═══════════════════════════════════════════════════════════ */
self.addEventListener('notificationclick', event => {
  const n        = event.notification;
  const action   = event.action;
  const nData    = n.data || {};
  n.close();

  // تجاهل — لا تفعل شيئاً
  if (action === 'dismiss') return;

  // بناء رابط المحادثة
  const targetUrl = nData.chatId
    ? `${nData.url}?screen=${nData.chatType}&id=${encodeURIComponent(nData.chatId)}`
    : (nData.url || '/');

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        // هل التطبيق مفتوح؟ → ركّز عليه وأرسل له رسالة للانتقال للمحادثة
        for (const client of clientList) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            client.postMessage({
              type:     'OPEN_CHAT',
              chatType: nData.chatType,
              chatId:   nData.chatId,
            });
            return client.focus();
          }
        }
        // التطبيق مغلق → افتح نافذة جديدة مباشرة على المحادثة
        return clients.openWindow(targetUrl);
      })
  );
});

/* ═══════════════════════════════════════════════════════════
   BACKGROUND SYNC (v2)
   يُعيد إرسال الرسائل الفاشلة عند عودة الإنترنت
   app.js يُسجّل sync tag = 'nabda-send-msg' ويخزن الرسالة في IDB
   هنا نقرأها ونرسلها لـ Firebase REST API
═══════════════════════════════════════════════════════════ */
self.addEventListener('sync', event => {
  if (event.tag === 'nabda-send-msg') {
    event.waitUntil(_processPendingMessages());
  }
});

async function _processPendingMessages() {
  let pending = [];
  try { pending = await _swIdbGetAll(); } catch { return; }
  if (!pending.length) return;

  // لكل رسالة معلّقة: حاول إرسالها عبر Firebase REST
  for (const item of pending) {
    try {
      const { fbUrl, payload } = item;
      if (!fbUrl || !payload) { await _swIdbDelete(item.id); continue; }

      const res = await fetch(fbUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });

      if (res.ok) {
        await _swIdbDelete(item.id);
        // أبلغ الـ app أن الرسالة أُرسلت
        const clients2 = await self.clients.matchAll({ type: 'window' });
        clients2.forEach(c => c.postMessage({
          type:   'MSG_SYNCED',
          tempId: item.tempId,
        }));
      }
      // إذا فشل (غير ok) نتركه ليُحاول مجدداً في الـ sync التالي
    } catch {
      // خطأ شبكة — نتركه ليُحاول مجدداً
    }
  }
}

/* ═══════════════════════════════════════════════════════════
   MESSAGE — from app.js
   Supported:
   - SKIP_WAITING       → force activate new SW
   - GET_VERSION        → return current cache version
   - CLEAR_CACHE        → delete all caches
   - STORE_PENDING_MSG  → حفظ رسالة معلّقة في IDB (v2)
   - GET_PENDING_MSGS   → إرجاع الرسائل المعلّقة (v2)
   - DELETE_PENDING_MSG → حذف رسالة من IDB بعد إرسالها (v2)
═══════════════════════════════════════════════════════════ */
self.addEventListener('message', event => {
  if (!event.data) return;

  // Force activate new SW
  if (event.data === 'SKIP_WAITING' || event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  // Return current cache version
  if (event.data?.type === 'GET_VERSION') {
    event.source?.postMessage({ type: 'VERSION', version: _BUILD });
    return;
  }

  // Clear all caches
  if (event.data?.type === 'CLEAR_CACHE') {
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => event.source?.postMessage({ type: 'CACHE_CLEARED' }));
    return;
  }

  // v2: حفظ رسالة معلّقة في IDB للـ Background Sync
  // app.js يُرسل: { type: 'STORE_PENDING_MSG', fbUrl, payload, tempId }
  if (event.data?.type === 'STORE_PENDING_MSG') {
    _swIdbAdd({
      fbUrl:   event.data.fbUrl,
      payload: event.data.payload,
      tempId:  event.data.tempId,
      ts:      Date.now(),
    }).then(id => {
      event.source?.postMessage({ type: 'MSG_STORED', id, tempId: event.data.tempId });
    }).catch(() => {});
    return;
  }

  // v2: إرجاع قائمة الرسائل المعلّقة
  if (event.data?.type === 'GET_PENDING_MSGS') {
    _swIdbGetAll()
      .then(msgs => event.source?.postMessage({ type: 'PENDING_MSGS', msgs }))
      .catch(() => event.source?.postMessage({ type: 'PENDING_MSGS', msgs: [] }));
    return;
  }

  // v2: حذف رسالة من IDB بعد إرسالها بنجاح
  if (event.data?.type === 'DELETE_PENDING_MSG') {
    _swIdbDelete(event.data.id).catch(() => {});
    return;
  }
});
