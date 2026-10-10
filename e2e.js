/**
 * e2e.js — تشفير طرف-لطرف للمحادثات الخاصة (DM)
 *
 * التقنية (WebCrypto فقط، بدون مكتبات):
 *  - لكل حساب زوج مفاتيح ECDH P-256؛ المفتاح الخاص يبقى على جهازك (IndexedDB)
 *    والعام يُنشر في userKeys/{uid}.
 *  - مفتاح المحادثة = HKDF(ECDH(مفتاحي الخاص، مفتاح الطرف الآخر العام)).
 *  - الرسالة تُشفَّر بـ AES-256-GCM، وتُربَط (AAD) بمفتاح المحادثة ومعرّف المرسل.
 *  - نسخة احتياطية اختيارية للمفتاح الخاص مشفّرة بكلمة سر (PBKDF2) في userData/{uid}/e2eBackup (خاص بك).
 *
 * ما لا يُشفَّر: type، sender، ts، status، التفاعلات، معرّف الرد.
 * المجموعات غير مشفّرة طرف-لطرف (تحتاج إدارة مفاتيح جماعية).
 */
window.E2E = (function () {

  const VERSION = 1;
  const PBKDF2_ITER = 250000;
  const subtle = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle : null;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  /* ── base64 ───────────────────────────────────────────────── */
  function b64(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(str) {
    const s = atob(str);
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  }
  const hex = buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

  // JWK عام بصيغة ثابتة (ترتيب المفاتيح) لحساب البصمة
  function canonPub(jwk) {
    return JSON.stringify({ crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y });
  }
  async function kidOf(canon) {
    const h = await subtle.digest('SHA-256', enc.encode(canon));
    return hex(h).slice(0, 32);
  }

  /* ── مخزن المفاتيح الافتراضي: IndexedDB ───────────────────── */
  function idbStore() {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const rq = indexedDB.open('nabda_e2e', 1);
      rq.onupgradeneeded = () => { rq.result.createObjectStore('kv'); };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    }));
    const tx = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction('kv', mode);
        const r = fn(t.objectStore('kv'));
        t.oncomplete = () => res(r && r.result);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error);
      });
    };
    // احتياطي: بعض المتصفحات (وضع خاص/متصفحات داخل التطبيقات) تمنع IndexedDB → localStorage
    const LS = 'nbd_kv_';
    const ls = {
      get: k => { try { const v = localStorage.getItem(LS + k); return v === null ? null : JSON.parse(v); } catch (e) { return null; } },
      set: (k, v) => { localStorage.setItem(LS + k, JSON.stringify(v)); },
      del: k => { try { localStorage.removeItem(LS + k); } catch (e) {} },
    };
    return {
      get: async k => {
        let v = null;
        try { v = await tx('readonly', s => s.get(k)); } catch (e) { v = null; }
        return (v === null || v === undefined) ? ls.get(k) : v;
      },
      set: async (k, v) => {
        let ok = false;
        try { await tx('readwrite', s => s.put(v, k)); ok = true; } catch (e) {}
        try { ls.set(k, v); ok = true; } catch (e) {}
        if (!ok) throw new Error('storage_unavailable');
      },
      del: async k => { try { await tx('readwrite', s => s.delete(k)); } catch (e) {} ls.del(k); },
    };
  }

  /* ═══════════════════════════════════════════════════════════
     المصنع: create({ FB, store })  — يسمح بالاختبار بمخزن/FB وهميين
  ═══════════════════════════════════════════════════════════ */
  function create(deps) {
    const FB = deps.FB;
    const store = deps.store;

    let _uid = null;
    let _ring = [];            // [{ kid, priv:CryptoKey, pub:canonString, created }]
    let _curKid = null;
    let _ready = false;
    let _status = 'idle';      // idle | ready | needs-restore | conflict | unsupported | error
    let _remote = null;        // userKeys/{uid}
    const _readyCbs = [];
    const _peerCache = new Map();   // uid → { t, v:{pub,kid}|null }
    const _aesCache = new Map();    // `${myKid}|${peerKid}|${dmKey}` → CryptoKey
    const _msgCache = new Map();    // `${dmKey}/${id}/${iv}` → bundle

    function _setStatus(s) {
      _status = s;
      _ready = (s === 'ready');
      if (_ready) _readyCbs.slice().forEach(cb => { try { cb(); } catch (e) {} });
    }

    async function _genKey() {
      const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const pubJwk = await subtle.exportKey('jwk', kp.publicKey);
      const canon = canonPub(pubJwk);
      const kid = await kidOf(canon);
      return { kid, priv: kp.privateKey, pub: canon, created: Date.now() };
    }

    // نحفظ المفاتيح بصيغة JWK (قابلة للتخزين في IndexedDB وlocalStorage معاً)
    async function _saveRing() {
      const ser = [];
      for (const r of _ring) ser.push({ kid: r.kid, pub: r.pub, created: r.created, jwk: await subtle.exportKey('jwk', r.priv) });
      await store.set('ring_' + _uid, ser);
      await store.set('cur_' + _uid, _curKid);
    }

    async function _publish(rec) {
      await FB.set(`userKeys/${_uid}`, { pub: rec.pub, kid: rec.kid, v: VERSION, ts: Date.now() });
      _remote = { pub: rec.pub, kid: rec.kid };
    }

    /** يهيّئ مفاتيح المستخدم. يرجع الحالة. */
    async function init(uid) {
      _uid = uid; _ready = false; _ring = []; _curKid = null; _aesCache.clear(); _msgCache.clear(); _peerCache.clear();
      if (!subtle) { _status = 'unsupported'; return _status; }
      try {
        _ring = [];
        for (const r of ((await store.get('ring_' + uid)) || [])) {
          try {
            let priv = r.priv;
            if (!priv && r.jwk) priv = await subtle.importKey('jwk', r.jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
            if (priv) _ring.push({ kid: r.kid, pub: r.pub, created: r.created, priv });
          } catch (e) {}
        }
        _curKid = (await store.get('cur_' + uid)) || null;
        if (_curKid && !_ring.some(r => r.kid === _curKid)) _curKid = null;
        _remote = await FB.get(`userKeys/${uid}`);

        if (_curKid) {
          // لدينا مفتاح محلي
          if (!_remote) { await _publish(_ring.find(r => r.kid === _curKid)); _setStatus('ready'); return _status; }
          if (_remote.kid === _curKid) { _setStatus('ready'); return _status; }
          // المفتاح المنشور مختلف: هل هو من مفاتيحنا القديمة؟ إن كان، نجعله الحالي
          const old = _ring.find(r => r.kid === _remote.kid);
          if (old) { _curKid = old.kid; await _saveRing(); _setStatus('ready'); return _status; }
          _status = 'conflict'; _ready = false; return _status;     // جهاز آخر نشر مفتاحاً جديداً
        }
        // لا مفتاح محلي
        if (_remote && _remote.kid) { _status = 'needs-restore'; _ready = false; return _status; }
        const rec = await _genKey();
        _ring = [rec]; _curKid = rec.kid; await _saveRing(); await _publish(rec);
        _setStatus('ready');
        return _status;
      } catch (e) {
        _status = 'error'; _ready = false; _lastError = e; return _status;
      }
    }
    let _lastError = null;

    /** إنشاء مفتاح جديد لهذا الجهاز (يُبقي القديم محلياً إن وجد) وينشره. */
    async function createNewKey() {
      if (!_uid) throw new Error('not_initialized');
      const rec = await _genKey();
      _ring.push(rec); _curKid = rec.kid;
      await _saveRing(); await _publish(rec);
      _aesCache.clear();
      _setStatus('ready');
      return rec.kid;
    }

    /* ── نسخة احتياطية بكلمة سر ─────────────────────────────── */
    async function _passKey(pass, salt, iter) {
      const base = await subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
      return subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base,
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }

    async function createBackup(passphrase) {
      if (!_ready) throw new Error('not_ready');
      if (!passphrase || passphrase.length < 8) throw new Error('weak_passphrase');
      const keys = [];
      for (const r of _ring) {
        const jwk = await subtle.exportKey('jwk', r.priv);
        keys.push({ kid: r.kid, pub: r.pub, jwk, created: r.created });
      }
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const k = await _passKey(passphrase, salt, PBKDF2_ITER);
      const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('nabda-e2e-backup|' + _uid) }, k,
        enc.encode(JSON.stringify({ cur: _curKid, keys })));
      const blob = { v: VERSION, salt: b64(salt), iv: b64(iv), ct: b64(ct), iter: PBKDF2_ITER, ts: Date.now() };
      await FB.set(`userData/${_uid}/e2eBackup`, blob);
      return true;
    }

    async function hasBackup() {
      if (!_uid) return false;
      try { return !!(await FB.get(`userData/${_uid}/e2eBackup`)); } catch (e) { return false; }
    }

    async function restoreBackup(passphrase) {
      if (!_uid) throw new Error('not_initialized');
      const b = await FB.get(`userData/${_uid}/e2eBackup`);
      if (!b) throw new Error('no_backup');
      let plain;
      try {
        const k = await _passKey(passphrase || '', unb64(b.salt), b.iter);
        plain = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(b.iv), additionalData: enc.encode('nabda-e2e-backup|' + _uid) }, k, unb64(b.ct));
      } catch (e) { throw new Error('wrong_passphrase'); }
      const data = JSON.parse(dec.decode(plain));
      const ring = [];
      for (const k of data.keys) {
        const priv = await subtle.importKey('jwk', k.jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        ring.push({ kid: k.kid, priv, pub: k.pub, created: k.created });
      }
      if (!ring.length) throw new Error('empty_backup');
      _ring = ring; _curKid = ring.some(r => r.kid === data.cur) ? data.cur : ring[ring.length - 1].kid;
      await _saveRing();
      const cur = _ring.find(r => r.kid === _curKid);
      if (!_remote || _remote.kid !== _curKid) await _publish(cur);
      _aesCache.clear(); _msgCache.clear();
      _setStatus('ready');
      return true;
    }

    /* ── مفاتيح الطرف الآخر ─────────────────────────────────── */
    async function getPeerKey(peerUid, fresh) {
      const c = _peerCache.get(peerUid);
      if (c && !fresh && Date.now() - c.t < 30000) return c.v;
      let v = null;
      try {
        const r = await FB.get(`userKeys/${peerUid}`);
        if (r && typeof r.pub === 'string' && r.pub.length < 400) {
          const kid = await kidOf(r.pub);
          if (r.kid && r.kid !== kid) v = null;          // بيانات غير متسقة → اعتبرها غير موجودة
          else v = { pub: r.pub, kid };
        }
      } catch (e) { v = c ? c.v : null; }
      _peerCache.set(peerUid, { t: Date.now(), v });
      return v;
    }

    async function _importPub(canon) {
      return subtle.importKey('jwk', Object.assign(JSON.parse(canon), { ext: true }), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    }

    async function _aesFor(myRec, theirCanon, dmKey) {
      const theirKid = await kidOf(theirCanon);
      const ck = `${myRec.kid}|${theirKid}|${dmKey}`;
      if (_aesCache.has(ck)) return _aesCache.get(ck);
      const pub = await _importPub(theirCanon);
      const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, myRec.priv, 256);
      const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
      const aes = await subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('nabda-e2e-v1|' + dmKey) },
        hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      _aesCache.set(ck, aes);
      return aes;
    }

    const _aad = (dmKey, senderUid) => enc.encode(`${dmKey}|${senderUid}`);

    /** هل نستطيع تشفير رسالة لهذا الطرف الآن؟ */
    async function canEncryptTo(peerUid) {
      if (!_ready) return false;
      return !!(await getPeerKey(peerUid));
    }

    const PLAIN_KEYS = ['type', 'sender', 'ts', 'status', 'forwarded', 'replyTo', 'reactions', 'edited', 'editedAt', 'deleted', 'deletedAt', 'e2e', 'id'];

    /**
     * يبني رسالة مشفّرة. يرجع الكائن الجاهز للكتابة، أو null إن لم يكن الطرف الآخر يملك مفتاحاً.
     * base = { sender, ts, status }  و payload = المحتوى الأصلي.
     */
    async function encryptMessage(dmKey, peerUid, base, payload) {
      if (!_ready) throw new Error('not_ready');
      const peer = await getPeerKey(peerUid, true);
      if (!peer) return null;
      const my = _ring.find(r => r.kid === _curKid);
      const aes = await _aesFor(my, peer.pub, dmKey);
      const bundle = {};
      Object.keys(payload || {}).forEach(k => { if (!PLAIN_KEYS.includes(k) && payload[k] !== undefined) bundle[k] = payload[k]; });
      if (payload && payload.replyTo && payload.replyTo.text != null) bundle.rt = payload.replyTo.text;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: _aad(dmKey, base.sender) }, aes, enc.encode(JSON.stringify(bundle)));
      const msg = Object.assign({}, base, { type: payload.type || 'text' });
      if (payload.replyTo) msg.replyTo = { id: payload.replyTo.id, sender: payload.replyTo.sender, type: payload.replyTo.type };
      if (payload.forwarded) msg.forwarded = true;
      msg.e2e = { v: VERSION, iv: b64(iv), ct: b64(ct), skid: my.kid, rkid: peer.kid, spk: my.pub, rpk: peer.pub };
      return msg;
    }

    async function _bundleOf(dmKey, m) {
      const e = m.e2e;
      if (!e || e.v !== VERSION || typeof e.iv !== 'string' || typeof e.ct !== 'string') throw new Error('bad_format');
      const ck = [dmKey, m.id, m.sender, e.iv, e.skid, e.rkid, e.spk, e.rpk, e.ct].join('/');
      if (m.id && _msgCache.has(ck)) return _msgCache.get(ck);
      const mine = (m.sender === _uid);
      const myKid = mine ? e.skid : e.rkid;
      const theirCanon = mine ? e.rpk : e.spk;
      const rec = _ring.find(r => r.kid === myKid);
      if (!rec) throw new Error('no_key');
      if (typeof theirCanon !== 'string' || theirCanon.length > 400) throw new Error('bad_format');
      const aes = await _aesFor(rec, theirCanon, dmKey);
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(e.iv), additionalData: _aad(dmKey, m.sender) }, aes, unb64(e.ct));
      const bundle = JSON.parse(dec.decode(pt));
      if (m.id) _msgCache.set(ck, bundle);
      return bundle;
    }

    /** يفك تشفير رسالة واحدة (يرجع نسخة جديدة). غير المشفّرة تُرجع كما هي. */
    async function decryptMessage(dmKey, m) {
      if (!m || !m.e2e) return m;
      try {
        if (!_ready) throw new Error('not_ready');
        const b = await _bundleOf(dmKey, m);
        const out = Object.assign({}, m, b);
        delete out.e2e; delete out.rt;
        out._enc = true;
        if (m.replyTo) out.replyTo = Object.assign({}, m.replyTo, b.rt != null ? { text: b.rt } : {});
        return out;
      } catch (e) {
        const out = Object.assign({}, m);
        delete out.e2e;
        out.type = 'text';
        out.text = _ready ? '🔒 رسالة مشفّرة — لا يمكن فك تشفيرها على هذا الجهاز' : '🔒 رسالة مشفّرة';
        out._undecryptable = true; out._enc = true;
        if (m.replyTo) out.replyTo = Object.assign({}, m.replyTo, { text: '🔒' });
        return out;
      }
    }

    async function decryptList(dmKey, msgs) {
      if (!msgs || !msgs.some(m => m && m.e2e)) return msgs;
      return Promise.all(msgs.map(m => decryptMessage(dmKey, m)));
    }

    /** خريطة { id: msg } كما تأتي من Firebase */
    async function decryptMap(dmKey, map) {
      if (!map) return map;
      const ids = Object.keys(map);
      if (!ids.some(id => map[id] && map[id].e2e)) return map;
      const out = {};
      await Promise.all(ids.map(async id => { out[id] = await decryptMessage(dmKey, Object.assign({ id }, map[id])); }));
      return out;
    }

    /** إعادة تشفير نص معدّل (تعديل رسالة) */
    async function reencryptEdit(dmKey, peerUid, rawMsg, newText) {
      const old = await _bundleOf(dmKey, rawMsg);
      const bundle = Object.assign({}, old, { text: newText, originalText: old.originalText || old.text });
      const payload = Object.assign({}, bundle, { type: rawMsg.type });
      const base = { sender: rawMsg.sender, ts: rawMsg.ts, status: rawMsg.status || 'sent' };
      const e = await encryptMessage(dmKey, peerUid, base, payload);
      return e ? e.e2e : null;
    }

    /** رقم أمان من 30 رقماً يتطابق عند الطرفين */
    async function safetyNumber(peerUid) {
      const my = _ring.find(r => r.kid === _curKid);
      const peer = await getPeerKey(peerUid, true);
      if (!my || !peer) return null;
      const parts = [{ u: _uid, p: my.pub }, { u: peerUid, p: peer.pub }].sort((a, b) => a.u < b.u ? -1 : 1);
      const h = new Uint8Array(await subtle.digest('SHA-256', enc.encode(parts[0].p + '|' + parts[1].p)));
      let digits = '';
      for (let i = 0; i < 30; i++) digits += String(h[i] % 10);
      return digits.match(/.{1,5}/g).join(' ');
    }

    /** بصمة مفتاح الطرف الآخر (للتنبيه عند تغيّره) */
    async function peerFingerprint(peerUid) {
      const p = await getPeerKey(peerUid, true);
      return p ? p.kid : null;
    }

    return {
      init, createNewKey, createBackup, restoreBackup, hasBackup,
      canEncryptTo, getPeerKey, encryptMessage, decryptMessage, decryptList, decryptMap, reencryptEdit,
      safetyNumber, peerFingerprint,
      isReady: () => _ready,
      status: () => _status,
      lastError: () => _lastError,
      myKid: () => _curKid,
      onReady: cb => { _readyCbs.push(cb); if (_ready) { try { cb(); } catch (e) {} } return () => { const i = _readyCbs.indexOf(cb); if (i >= 0) _readyCbs.splice(i, 1); }; },
      reset: () => { _uid = null; _ring = []; _curKid = null; _ready = false; _status = 'idle'; _aesCache.clear(); _msgCache.clear(); _peerCache.clear(); },
    };
  }

  /* ── المثيل الافتراضي (يُهيّأ عند أول استخدام لأن FB يُحمَّل قبلنا) ── */
  let _inst = null;
  function inst() {
    if (!_inst) _inst = create({ FB: window.FB, store: idbStore() });
    return _inst;
  }
  const api = { create, b64, unb64 };
  ['init', 'createNewKey', 'createBackup', 'restoreBackup', 'hasBackup', 'canEncryptTo', 'getPeerKey',
    'encryptMessage', 'decryptMessage', 'decryptList', 'decryptMap', 'reencryptEdit', 'safetyNumber',
    'peerFingerprint', 'isReady', 'status', 'lastError', 'myKid', 'onReady', 'reset'].forEach(k => {
    api[k] = function () { const i = inst(); return i[k].apply(i, arguments); };
  });
  return api;

})();
