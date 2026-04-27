/**
 * js/firebase.js
 * Firebase init — Realtime Database + Authentication
 * Exposes: window.FB
 *
 * ─── SECURITY RULES (ضعها في Firebase Console → Realtime Database → Rules) ───
 *
 * {
 *   "rules": {
 *     ".read":  false,
 *     ".write": false,
 *     "users": {
 *       "$uid": {
 *         ".read":  "$uid === auth.uid",
 *         ".write": "$uid === auth.uid"
 *       }
 *     },
 *     "messages": {
 *       ".read":  "auth !== null",
 *       ".write": "auth !== null"
 *     },
 *     "rooms": {
 *       ".read":  "auth !== null",
 *       ".write": "auth !== null"
 *     }
 *   }
 * }
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️  مفاتيح Firebase مكشوفة هنا — هذا طبيعي للـ client-side apps،
 *     لكن أمانك الحقيقي يعتمد على Security Rules أعلاه.
 *     لا ترفع هذا الملف لـ GitHub public repo بدون تفكير.
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
  const SDK_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const SDK_TIMEOUT_MS = 10000; // 10 ثواني قبل اعتبار التحميل فاشلاً

  let _db      = null;
  let _auth    = null;
  let _sdk     = null;
  let _authSdk = null;

  /* ── Init ─────────────────────────────────────────────────── */
  function init() {
    return new Promise((resolve, reject) => {

      // Timeout — إذا لم يتحمل SDK خلال 10 ثواني (لا إنترنت مثلاً)
      const timeoutId = setTimeout(() => {
        reject(new Error('Firebase SDK load timeout — تأكد من اتصال الإنترنت'));
      }, SDK_TIMEOUT_MS);

      const s = document.createElement('script');
      s.type = 'module';

      // معالجة خطأ تحميل الـ script نفسه
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

      // الاستماع لنجاح أو فشل التحميل
      window.addEventListener('nabdaFBReady', () => {
        clearTimeout(timeoutId);
        _db      = window.__nabda_db;
        _auth    = window.__nabda_auth;
        _sdk     = window.__nabda_sdk;
        _authSdk = window.__nabda_authSdk;
        resolve();
      }, { once: true });

      window.addEventListener('nabdaFBError', (e) => {
        clearTimeout(timeoutId);
        reject(new Error('Firebase init error: ' + (e.detail || 'unknown')));
      }, { once: true });

      document.head.appendChild(s);
    });
  }

  /* ── Realtime Database helpers ───────────────────────────── */
  const r    = path       => _sdk.ref(_db, path);
  const set  = (path, v)  => _sdk.set(r(path), v);
  const upd  = (path, v)  => _sdk.update(r(path), v);
  const push = (path, v)  => _sdk.push(r(path), v);
  const del  = path       => _sdk.remove(r(path));
  const get  = async path => {
    try {
      const s = await _sdk.get(r(path));
      return s.exists() ? s.val() : null;
    } catch (err) {
      console.error('[FB.get] error:', err.message);
      return null;
    }
  };
  const on = (path, cb) => {
    const ref = r(path);
    // modular SDK v10: onValue() returns an unsubscribe function directly
    const unsub = _sdk.onValue(ref, s => cb(s.val()));
    return unsub;
  };

  // limitToLast listener — used by chat.js for message pagination
  const onLimit = (path, limit, cb) => {
    const ref = _sdk.query(r(path), _sdk.limitToLast(limit));
    const unsub = _sdk.onValue(ref, s => cb(s.val()));
    return unsub;
  };
  const onDisconn = (path, v) => _sdk.onDisconnect(r(path)).set(v);

  /* ── Firebase Auth helpers ───────────────────────────────── */

  function authRegister(email, password) {
    return _authSdk.createUserWithEmailAndPassword(_auth, email, password);
  }

  function authLogin(email, password) {
    return _authSdk.signInWithEmailAndPassword(_auth, email, password);
  }

  function authSignOut() {
    return _authSdk.signOut(_auth);
  }

  function authCurrentUser() {
    return _auth ? _auth.currentUser : null;
  }

  function authOnChange(cb) {
    return _authSdk.onAuthStateChanged(_auth, cb);
  }

  function authResetPassword(email) {
    return _authSdk.sendPasswordResetEmail(_auth, email);
  }

  function authUpdatePassword(newPassword) {
    const user = _auth ? _auth.currentUser : null;
    if (!user) return Promise.reject(new Error('no_user'));
    return _authSdk.updatePassword(user, newPassword);
  }

  function authReauth(email, password) {
    const user = _auth ? _auth.currentUser : null;
    if (!user) return Promise.reject(new Error('no_user'));
    const cred = _authSdk.EmailAuthProvider.credential(email, password);
    return _authSdk.reauthenticateWithCredential(user, cred);
  }

  function authDeleteUser() {
    const user = _auth ? _auth.currentUser : null;
    if (!user) return Promise.reject(new Error('no_user'));
    return user.delete();
  }

  return {
    init,
    // DB
    set, upd, push, del, get, on, onLimit, onDisconn,
    // Auth
    authRegister, authLogin, authSignOut,
    authCurrentUser, authOnChange, authResetPassword,
    authUpdatePassword, authReauth, authDeleteUser
  };

})();
