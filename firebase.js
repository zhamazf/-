/**
 * js/firebase.js
 * Firebase init — Realtime Database + Authentication
 * Exposes: window.FB
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

  /* ── Init ─────────────────────────────────────────────────── */
  function init() {
    return new Promise(resolve => {
      const s = document.createElement('script');
      s.type  = 'module';
      s.textContent = `
        import { initializeApp }                    from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
        import * as rtdb                             from "https://www.gstatic.com/firebasejs/10.7.0/firebase-database.js";
        import * as fbAuth                           from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";
        const app  = initializeApp(${JSON.stringify(CFG)});
        window.__nabda_db      = rtdb.getDatabase(app);
        window.__nabda_auth    = fbAuth.getAuth(app);
        window.__nabda_sdk     = rtdb;
        window.__nabda_authSdk = fbAuth;
        window.dispatchEvent(new Event('nabdaFBReady'));
      `;
      document.head.appendChild(s);
      window.addEventListener('nabdaFBReady', () => {
        _db      = window.__nabda_db;
        _auth    = window.__nabda_auth;
        _sdk     = window.__nabda_sdk;
        _authSdk = window.__nabda_authSdk;
        resolve();
      }, { once: true });
    });
  }

  /* ── Realtime Database helpers ───────────────────────────── */
  const r    = path       => _sdk.ref(_db, path);
  const set  = (path, v)  => _sdk.set(r(path), v);
  const upd  = (path, v)  => _sdk.update(r(path), v);
  const push = (path, v)  => _sdk.push(r(path), v);
  const del  = path       => _sdk.remove(r(path));
  const get  = async path => {
    try { const s = await _sdk.get(r(path)); return s.exists() ? s.val() : null; }
    catch { return null; }
  };
  const on = (path, cb) => {
    const ref = r(path);
    _sdk.onValue(ref, s => cb(s.val()));
    return () => _sdk.off(ref);
  };
  const onDisconn = (path, v) => _sdk.onDisconnect(r(path)).set(v);

  /* ── Firebase Auth helpers ───────────────────────────────── */

  // Create user with email + password
  function authRegister(email, password) {
    return _authSdk.createUserWithEmailAndPassword(_auth, email, password);
  }

  // Sign in with email + password
  function authLogin(email, password) {
    return _authSdk.signInWithEmailAndPassword(_auth, email, password);
  }

  // Sign out
  function authSignOut() {
    return _authSdk.signOut(_auth);
  }

  // Get current Firebase Auth user
  function authCurrentUser() {
    return _auth.currentUser;
  }

  // Listen for auth state changes
  function authOnChange(cb) {
    return _authSdk.onAuthStateChanged(_auth, cb);
  }

  // Send password reset email
  function authResetPassword(email) {
    return _authSdk.sendPasswordResetEmail(_auth, email);
  }

  // Update password (requires recent login)
  function authUpdatePassword(newPassword) {
    const user = _auth.currentUser;
    if (!user) return Promise.reject(new Error('no_user'));
    return _authSdk.updatePassword(user, newPassword);
  }

  // Re-authenticate user (needed before sensitive operations)
  function authReauth(email, password) {
    const user = _auth.currentUser;
    if (!user) return Promise.reject(new Error('no_user'));
    const cred = _authSdk.EmailAuthProvider.credential(email, password);
    return _authSdk.reauthenticateWithCredential(user, cred);
  }

  // Delete Auth account
  function authDeleteUser() {
    const user = _auth.currentUser;
    if (!user) return Promise.reject(new Error('no_user'));
    return user.delete();
  }

  return {
    init,
    // DB
    set, upd, push, del, get, on, onDisconn,
    // Auth
    authRegister, authLogin, authSignOut,
    authCurrentUser, authOnChange, authResetPassword,
    authUpdatePassword, authReauth, authDeleteUser
  };

})();
