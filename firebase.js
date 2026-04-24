/**
 * js/firebase.js
 * Firebase Realtime Database — init + CRUD helpers
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

  let _db = null, _sdk = null;

  function init() {
    return new Promise(resolve => {
      const s = document.createElement('script');
      s.type  = 'module';
      s.textContent = `
        import { initializeApp }  from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
        import * as rtdb           from "https://www.gstatic.com/firebasejs/10.7.0/firebase-database.js";
        const app = initializeApp(${JSON.stringify(CFG)});
        const db  = rtdb.getDatabase(app);
        window.__nabda_db  = db;
        window.__nabda_sdk = rtdb;
        window.dispatchEvent(new Event('nabdaFBReady'));
      `;
      document.head.appendChild(s);
      window.addEventListener('nabdaFBReady', () => {
        _db  = window.__nabda_db;
        _sdk = window.__nabda_sdk;
        resolve();
      }, { once: true });
    });
  }

  const r   = path       => _sdk.ref(_db, path);
  const set = (path, v)  => _sdk.set(r(path), v);
  const upd = (path, v)  => _sdk.update(r(path), v);
  const push= (path, v)  => _sdk.push(r(path), v);
  const del = path       => _sdk.remove(r(path));
  const get = async path => {
    try { const s = await _sdk.get(r(path)); return s.exists() ? s.val() : null; }
    catch { return null; }
  };
  const on  = (path, cb) => {
    const ref = r(path);
    _sdk.onValue(ref, s => cb(s.val()));
    return () => _sdk.off(ref);
  };
  const onDisconn = (path, v) => _sdk.onDisconnect(r(path)).set(v);

  return { init, set, upd, push, del, get, on, onDisconn };

})();
