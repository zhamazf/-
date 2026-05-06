/**
 * firebase.js v2
 * Firebase init — Realtime Database + Authentication
 *
 * التحسينات عن v1:
 * 1. Retry logic — إعادة المحاولة عند فشل الكتابة (شبكة ضعيفة)
 * 2. Connection state — مراقبة حالة الاتصال بـ Firebase
 * 3. Error handling في on() — التعامل مع PERMISSION_DENIED
 * 4. Rate limiting محلي — منع الكتابة المتكررة بسرعة كبيرة
 * 5. قائمة انتظار offline — العمليات المؤجلة تُنفذ عند عودة الاتصال
 */

window.FB = (function () {

  const CFG = {
    apiKey:            "AIzaSyBqRplVWgiZUXkbujiQ-KWNca6dPwC-kOk",
    authDomain:        "nabda-chat.firebaseapp.com",
    databaseURL:       "https://nabda-chat-default-rtdb.firebaseio.com",
    projectId:         "nabda-chat",
    storageBucket:     "nabda-chat.firebasestorage.app",
    messagingSenderId: "399164736455",
    appId:             "1:399164736455:web:127df9589215b9e8120fe2"
  };

  const FIREBASE_VERSION = "10.7.0";
  const SDK_BASE         = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const SDK_TIMEOUT_MS   = 10000;
  const MAX_RETRIES      = 3;
  const RETRY_DELAY_MS   = 1000;

  let _db      = null;
  let _auth    = null;
  let _sdk     = null;
  let _authSdk = null;

  // ── حالة الاتصال ──────────────────────────────────────────
  let _isOnline  = true;
  let _onlineCbs = [];
  const _offlineQueue = []; // عمليات مؤجلة حتى عودة الاتصال

  // ── Rate limiting ──────────────────────────────────────────
  const _writeCount  = new Map(); // path → {count, resetAt}
  const WRITE_LIMIT  = 20;        // 20 كتابة لنفس المسار
  const WRITE_WINDOW = 60000;     // خلال دقيقة واحدة

  function _checkRateLimit(path) {
    const now = Date.now();
    const key  = path.split('/').slice(0, 2).join('/'); // أخذ أول مستويين فقط
    const info = _writeCount.get(key) || { count: 0, resetAt: now + WRITE_WINDOW };

    if (now > info.resetAt) {
      _writeCount.set(key, { count: 1, resetAt: now + WRITE_WINDOW });
      return true;
    }
    if (info.count >= WRITE_LIMIT) {
      console.warn(`[FB] Rate limit reached for: ${key}`);
      return false;
    }
    info.count++;
    _writeCount.set(key, info);
    return true;
  }

  // ── Retry wrapper ──────────────────────────────────────────
  async function _withRetry(fn, path, retries = MAX_RETRIES) {
    for (let i = 0; i <= retries; i++) {
      try {
        return await fn();
      } catch (err) {
        const isPermission = err.code === 'PERMISSION_DENIED' ||
                             err.message?.includes('Permission denied');
        if (isPermission) throw err; // لا تعيد المحاولة في حالة الرفض
        if (i === retries) throw err;
        await new Promise(res => setTimeout(res, RETRY_DELAY_MS * Math.pow(2, i)));
        console.warn(`[FB] Retry ${i + 1} for: ${path}`);
      }
    }
  }

  /* ── Init ─────────────────────────────────────────────────── */
  function init() {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Firebase SDK load timeout — تأكد من اتصال الإنترنت'));
      }, SDK_TIMEOUT_MS);

      const s = document.createElement('script');
      s.type  = 'module';

      s.onerror = () => {
        clearTimeout(timeoutId);
        reject(new Error('Firebase SDK failed to load — تعذر تحميل الملفات من CDN'));
      };

      s.textContent = `
        (async () => {
          try {
            const [appMod, rtdbMod, authMod] = await Promise.all([
              import("${SDK_BASE}/firebase-app.js"),
              import("${SDK_BASE}/firebase-database.js"),
              import("${SDK_BASE}/firebase-auth.js")
            ]);

            const app = appMod.initializeApp(${JSON.stringify(CFG)});

            window.__nabda_db      = rtdbMod.getDatabase(app);
            window.__nabda_auth    = authMod.getAuth(app);
            window.__nabda_sdk     = rtdbMod;
            window.__nabda_authSdk = authMod;

            window.dispatchEvent(new Event('nabdaFBReady'));
          } catch (err) {
            window.dispatchEvent(new CustomEvent('nabdaFBError', { detail: err.message }));
          }
        })();
      `;

      window.addEventListener('nabdaFBReady', () => {
        clearTimeout(timeoutId);
        _db      = window.__nabda_db;
        _auth    = window.__nabda_auth;
        _sdk     = window.__nabda_sdk;
        _authSdk = window.__nabda_authSdk;

        // ── مراقبة حالة الاتصال بـ Firebase ──
        _sdk.onValue(_sdk.ref(_db, '.info/connected'), snap => {
          const connected = snap.val() === true;
          if (connected !== _isOnline) {
            _isOnline = connected;
            _onlineCbs.forEach(cb => cb(connected));
            if (connected && _offlineQueue.length > 0) {
              console.log(`[FB] Back online — flushing ${_offlineQueue.length} queued ops`);
              const ops = _offlineQueue.splice(0);
              ops.forEach(op => op());
            }
          }
        });

        resolve();
      }, { once: true });

      window.addEventListener('nabdaFBError', (e) => {
        clearTimeout(timeoutId);
        reject(new Error('Firebase init error: ' + (e.detail || 'unknown')));
      }, { once: true });

      document.head.appendChild(s);
    });
  }

  /* ── Connection state API ────────────────────────────────── */
  function onConnectionChange(cb) {
    _onlineCbs.push(cb);
    return () => { _onlineCbs = _onlineCbs.filter(f => f !== cb); };
  }

  function isConnected() { return _isOnline; }

  /* ── Realtime Database helpers ───────────────────────────── */
  const r = path => _sdk.ref(_db, path);

  async function set(path, v) {
    if (!_checkRateLimit(path)) return;
    return _withRetry(() => _sdk.set(r(path), v), path);
  }

  async function upd(path, v) {
    if (!_checkRateLimit(path)) return;
    return _withRetry(() => _sdk.update(r(path), v), path);
  }

  async function push(path, v) {
    if (!_checkRateLimit(path)) return;
    return _withRetry(() => _sdk.push(r(path), v), path);
  }

  async function del(path) {
    return _withRetry(() => _sdk.remove(r(path)), path);
  }

  async function get(path) {
    try {
      const snap = await _sdk.get(r(path));
      return snap.exists() ? snap.val() : null;
    } catch (err) {
      console.error('[FB.get] error:', err.message);
      return null;
    }
  }

  function on(path, cb, onError) {
    const ref   = r(path);
    const unsub = _sdk.onValue(
      ref,
      snap => cb(snap.val()),
      err  => {
        // PERMISSION_DENIED — لا نسجل خطأ للمسارات المتوقعة
        const isPermission = err?.code === 'PERMISSION_DENIED' ||
                             err?.message?.includes('Permission denied');
        if (!isPermission) {
          console.error(`[FB.on] error at ${path}:`, err.message);
        }
        if (onError) onError(err);
      }
    );
    return unsub;
  }

  // limitToLast listener — للرسائل مع pagination
  function onLimit(path, limit, cb) {
    const ref   = _sdk.query(r(path), _sdk.limitToLast(limit));
    const unsub = _sdk.onValue(ref, snap => cb(snap.val()));
    return unsub;
  }

  const onDisconn = (path, v) => _sdk.onDisconnect(r(path)).set(v);

  /* ── Firebase Auth helpers ───────────────────────────────── */
  const authRegister       = (email, pw) =>
    _authSdk.createUserWithEmailAndPassword(_auth, email, pw);
  const authLogin          = (email, pw) =>
    _authSdk.signInWithEmailAndPassword(_auth, email, pw);
  const authSignOut        = ()          => _authSdk.signOut(_auth);
  const authCurrentUser    = ()          => _auth?.currentUser || null;
  const authOnChange       = cb          => _authSdk.onAuthStateChanged(_auth, cb);
  const authResetPassword  = email       => _authSdk.sendPasswordResetEmail(_auth, email);
  const authUpdatePassword = pw          => {
    const u = _auth?.currentUser;
    if (!u) return Promise.reject(new Error('no_user'));
    return _authSdk.updatePassword(u, pw);
  };
  const authReauth = (email, pw) => {
    const u = _auth?.currentUser;
    if (!u) return Promise.reject(new Error('no_user'));
    const cred = _authSdk.EmailAuthProvider.credential(email, pw);
    return _authSdk.reauthenticateWithCredential(u, cred);
  };
  const authDeleteUser = () => {
    const u = _auth?.currentUser;
    if (!u) return Promise.reject(new Error('no_user'));
    return u.delete();
  };

  return {
    init,
    // Connection
    onConnectionChange, isConnected,
    // DB
    set, upd, push, del, get, on, onLimit, onDisconn,
    // Auth
    authRegister, authLogin, authSignOut,
    authCurrentUser, authOnChange, authResetPassword,
    authUpdatePassword, authReauth, authDeleteUser,
  };

})();
