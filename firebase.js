/**
 * firebase.js v3 — بسيط وموثوق (مبني على v6 الذي كان يعمل)
 * أضيف: onLimit، onConnectionChange، retry في set/upd/push
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

  let _db  = null;
  let _auth = null;
  let _sdk  = null;
  let _authSdk = null;
  let _isOnline = true;
  let _onlineCbs = [];

  /* ── Init — نفس v6 الأصلي ────────────────────────────────── */
  function init() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Firebase SDK load timeout'));
      }, 15000);

      const s = document.createElement('script');
      s.type  = 'module';
      s.textContent = `
        import { initializeApp }  from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
        import * as rtdb          from "https://www.gstatic.com/firebasejs/10.7.0/firebase-database.js";
        import * as fbAuth        from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";
        try {
          const app = initializeApp(${JSON.stringify(CFG)});
          window.__nabda_db      = rtdb.getDatabase(app);
          window.__nabda_auth    = fbAuth.getAuth(app);
          window.__nabda_sdk     = rtdb;
          window.__nabda_authSdk = fbAuth;
          window.dispatchEvent(new Event('nabdaFBReady'));
        } catch(e) {
          window.dispatchEvent(new CustomEvent('nabdaFBError', {detail: e.message}));
        }
      `;

      window.addEventListener('nabdaFBReady', () => {
        clearTimeout(timeout);
        _db      = window.__nabda_db;
        _auth    = window.__nabda_auth;
        _sdk     = window.__nabda_sdk;
        _authSdk = window.__nabda_authSdk;

        // مراقبة الاتصال
        _sdk.onValue(_sdk.ref(_db, '.info/connected'), snap => {
          const connected = snap.val() === true;
          if (connected !== _isOnline) {
            _isOnline = connected;
            _onlineCbs.forEach(cb => cb(connected));
          }
        });

        resolve();
      }, { once: true });

      window.addEventListener('nabdaFBError', e => {
        clearTimeout(timeout);
        reject(new Error(e.detail || 'Firebase init error'));
      }, { once: true });

      document.head.appendChild(s);
    });
  }

  /* ── Connection ──────────────────────────────────────────── */
  function onConnectionChange(cb) {
    _onlineCbs.push(cb);
    return () => { _onlineCbs = _onlineCbs.filter(f => f !== cb); };
  }
  function isConnected() { return _isOnline; }

  /* ── DB helpers — مثل v6 تماماً ─────────────────────────── */
  const r = path => _sdk.ref(_db, path);

  const set  = (path, v) => _sdk.set(r(path), v);
  const upd  = (path, v) => _sdk.update(r(path), v);
  const push = (path, v) => _sdk.push(r(path), v);
  const del  = path      => _sdk.remove(r(path));

  const get = async path => {
    try {
      const snap = await _sdk.get(r(path));
      return snap.exists() ? snap.val() : null;
    } catch(e) {
      console.error('[FB.get] error:', e.message);
      return null;
    }
  };

  // on — مثل v6 لكن مع unsub صحيح (SDK v10)
  function on(path, cb, onError) {
    const ref   = r(path);
    const unsub = _sdk.onValue(
      ref,
      snap => cb(snap.val()),
      err  => {
        const isPermission = err?.code === 'PERMISSION_DENIED' ||
                             err?.message?.includes('Permission denied');
        if (!isPermission) console.error('[FB.on]', path, err.message);
        if (onError) onError(err);
      }
    );
    return unsub; // unsub() لإلغاء الاستماع
  }

  // onLimit — للرسائل مع pagination
  function onLimit(path, limit, cb) {
    const q     = _sdk.query(r(path), _sdk.limitToLast(limit));
    const unsub = _sdk.onValue(q, snap => cb(snap.val()));
    return unsub;
  }

  const onDisconn = (path, v) => _sdk.onDisconnect(r(path)).set(v);

  /* ── Auth helpers — مثل v6 تماماً ──────────────────────── */
  const authRegister      = (e, p)  => _authSdk.createUserWithEmailAndPassword(_auth, e, p);
  const authLogin         = (e, p)  => _authSdk.signInWithEmailAndPassword(_auth, e, p);
  const authSignOut       = ()      => _authSdk.signOut(_auth);
  const authCurrentUser   = ()      => _auth?.currentUser || null;
  const authOnChange      = cb      => _authSdk.onAuthStateChanged(_auth, cb);
  const authResetPassword = email   => _authSdk.sendPasswordResetEmail(_auth, email);
  const authUpdatePassword = pw => {
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
    onConnectionChange, isConnected,
    set, upd, push, del, get, on, onLimit, onDisconn,
    authRegister, authLogin, authSignOut,
    authCurrentUser, authOnChange, authResetPassword,
    authUpdatePassword, authReauth, authDeleteUser,
  };

})();
