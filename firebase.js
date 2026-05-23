/**
 * firebase.js v5 — Firebase Compat SDK
 * يعمل على جميع المتصفحات بما فيها Chrome Mobile القديم
 * لا يستخدم type="module" أو dynamic import
 *
 * v5 additions (مطلوبة من auth.js v2 و chat.js v2):
 * 1. authGoogleLogin()   → Google Popup sign-in
 * 2. authUpdateEmail()   → تعديل الإيميل (يحتاج recent login)
 * 3. getPage()           → pagination: orderByKey().endBefore(id).limitToLast(N)
 * 4. onLimitQuery()      → listener مع orderByChild (للترتيب)
 * 5. transaction()       → atomic update (للـ reactions مثلاً)
 * 6. serverTimestamp()   → Firebase server timestamp
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

  const BASE = 'https://www.gstatic.com/firebasejs/10.7.0';
  let _db   = null;
  let _auth = null;
  let _isOnline  = true;
  let _onlineCbs = [];

  /* ── تحميل script عادي (ليس module) ─────────────────────── */
  function _loadScript(src) {
    return new Promise((resolve, reject) => {
      const s   = document.createElement('script');
      s.src     = src;
      s.onload  = resolve;
      s.onerror = () => reject(new Error('Failed to load: ' + src));
      document.head.appendChild(s);
    });
  }

  /* ── Init ────────────────────────────────────────────────── */
  async function init() {
    // تحميل Firebase Compat SDK بالترتيب
    await _loadScript(`${BASE}/firebase-app-compat.js`);
    await _loadScript(`${BASE}/firebase-database-compat.js`);
    await _loadScript(`${BASE}/firebase-auth-compat.js`);

    // تهيئة Firebase
    if (!window.firebase.apps.length) {
      window.firebase.initializeApp(CFG);
    }

    _db   = window.firebase.database();
    _auth = window.firebase.auth();

    // مراقبة الاتصال
    _db.ref('.info/connected').on('value', snap => {
      const connected = snap.val() === true;
      if (connected !== _isOnline) {
        _isOnline = connected;
        _onlineCbs.forEach(cb => cb(connected));
      }
    });
  }

  /* ── Connection ──────────────────────────────────────────── */
  function onConnectionChange(cb) {
    _onlineCbs.push(cb);
    return () => { _onlineCbs = _onlineCbs.filter(f => f !== cb); };
  }
  function isConnected() { return _isOnline; }

  /* ── DB helpers ──────────────────────────────────────────── */
  const r = path => _db.ref(path);

  const set  = (path, v) => r(path).set(v);
  const upd  = (path, v) => r(path).update(v);
  const push = (path, v) => r(path).push(v);
  const del  = path      => r(path).remove();

  const get = async path => {
    try {
      const snap = await r(path).once('value');
      return snap.exists() ? snap.val() : null;
    } catch(e) {
      console.error('[FB.get] error:', e.message);
      return null;
    }
  };

  function on(path, cb, onError) {
    const ref = r(path);
    ref.on('value',
      snap => cb(snap.val()),
      err  => {
        const isPermission = err?.code === 'PERMISSION_DENIED' ||
                             err?.message?.includes('Permission denied');
        if (!isPermission) console.error('[FB.on]', path, err.message);
        if (onError) onError(err);
      }
    );
    return () => ref.off('value');
  }

  function onLimit(path, limit, cb) {
    const ref = r(path).limitToLast(limit);
    ref.on('value', snap => cb(snap.val()));
    return () => ref.off('value');
  }

  /* ── getPage — pagination (v5) ───────────────────────────────
     يجلب N رسالة قبل oldestId (للـ "تحميل رسائل أقدم")
     يستخدم orderByKey().endBefore(oldestId).limitToLast(N)
  ─────────────────────────────────────────────────────────── */
  async function getPage(path, endBeforeKey, limit = 40) {
    try {
      const snap = await r(path)
        .orderByKey()
        .endBefore(endBeforeKey)
        .limitToLast(limit)
        .once('value');
      return snap.exists() ? snap.val() : null;
    } catch (e) {
      console.error('[FB.getPage] error:', e.message);
      return null;
    }
  }

  /* ── onLimitQuery — listener مع orderByChild (v5) ───────────── */
  function onLimitQuery(path, orderByChild, limit, cb) {
    const ref = r(path).orderByChild(orderByChild).limitToLast(limit);
    ref.on('value', snap => cb(snap.val()));
    return () => ref.off('value');
  }

  /* ── transaction — atomic update (v5) ───────────────────────── */
  async function transaction(path, updateFn) {
    try {
      const result = await r(path).transaction(updateFn);
      return { ok: true, value: result.snapshot.val() };
    } catch (e) {
      return { error: e.message };
    }
  }

  /* ── serverTimestamp (v5) ────────────────────────────────────── */
  function serverTimestamp() {
    return window.firebase.database.ServerValue.TIMESTAMP;
  }

  const onDisconn = (path, v) => r(path).onDisconnect().set(v);

  /* ── Auth helpers ────────────────────────────────────────── */
  const authRegister      = (e, p) => _auth.createUserWithEmailAndPassword(e, p);
  const authLogin         = (e, p) => _auth.signInWithEmailAndPassword(e, p);
  const authSignOut       = ()     => _auth.signOut();
  const authCurrentUser   = ()     => _auth?.currentUser || null;
  const authOnChange      = cb     => _auth.onAuthStateChanged(cb);
  const authResetPassword = email  => _auth.sendPasswordResetEmail(email);
  const authUpdatePassword = pw    => {
    const u = _auth?.currentUser;
    if (!u) return Promise.reject(new Error('no_user'));
    return u.updatePassword(pw);
  };
  const authReauth = (email, pw) => {
    const u = _auth?.currentUser;
    if (!u) return Promise.reject(new Error('no_user'));
    const cred = window.firebase.auth.EmailAuthProvider.credential(email, pw);
    return u.reauthenticateWithCredential(cred);
  };
  const authDeleteUser = () => {
    const u = _auth?.currentUser;
    if (!u) return Promise.reject(new Error('no_user'));
    return u.delete();
  };

  /* ── authUpdateEmail (v5) ────────────────────────────────────── */
  const authUpdateEmail = newEmail => {
    const u = _auth?.currentUser;
    if (!u) return Promise.reject(new Error('no_user'));
    return u.updateEmail(newEmail);
  };

  /* ── authGoogleLogin (v5) ────────────────────────────────────── */
  async function authGoogleLogin() {
    if (!window.firebase?.auth?.GoogleAuthProvider) {
      throw new Error('auth/google-provider-not-loaded');
    }
    const provider = new window.firebase.auth.GoogleAuthProvider();
    provider.addScope('email');
    provider.addScope('profile');
    return _auth.signInWithPopup(provider);
  }

  return {
    init,
    onConnectionChange, isConnected,

    // DB
    set, upd, push, del, get, on, onLimit, onDisconn,

    // DB v5
    getPage,
    onLimitQuery,
    transaction,
    serverTimestamp,

    // Auth (original)
    authRegister, authLogin, authSignOut,
    authCurrentUser, authOnChange, authResetPassword,
    authUpdatePassword, authReauth, authDeleteUser,

    // Auth v5
    authUpdateEmail,
    authGoogleLogin,
  };

})();
