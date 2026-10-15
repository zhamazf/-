/**
 * e2e.js — تشفير طرف-لطرف للمحادثات الخاصة (DM)
 *
 * التقنية (WebCrypto فقط، بدون مكتبات) — مثل واتساب: لا يحتاج المستخدم لأي إعداد أو نسخة احتياطية:
 *  - كل جهاز يولّد مفتاحه تلقائياً (ECDH P-256) وينشر العام في userDevices/{uid}/{deviceId}.
 *  - الرسالة تُشفَّر بمفتاح عشوائي AES-256-GCM (مربوط AAD بالمحادثة والمرسل)،
 *    ويُغلَّف هذا المفتاح لكل جهاز عند الطرفين عبر ECDH+HKDF.
 *  - جهاز جديد يستلم الرسائل الجديدة فقط.
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
        // localStorage فقط إن فشل IndexedDB (المفتاح الخاص لا يُنسخ لـ localStorage عادةً)
        try { await tx('readwrite', s => s.put(v, k)); ls.del(k); return; } catch (e) {}
        try { ls.set(k, v); } catch (e) { throw new Error('storage_unavailable'); }
      },
      del: async k => { try { await tx('readwrite', s => s.delete(k)); } catch (e) {} ls.del(k); },
    };
  }

  /* ═══════════════════════════════════════════════════════════
     المصنع: create({ FB, store })  — يسمح بالاختبار بمخزن/FB وهميين

     النموذج (مثل واتساب متعدد الأجهزة، بدون أي إعداد من المستخدم):
       - كل جهاز يولّد هويته (زوج مفاتيح ECDH) تلقائياً وينشر المفتاح العام في
         userDevices/{uid}/{deviceId}. المفتاح الخاص لا يغادر الجهاز.
       - الرسالة تُشفَّر مرة واحدة بمفتاح عشوائي (AES-GCM)، ثم يُغلَّف هذا المفتاح
         لكل جهاز عند الطرفين (أجهزة المرسل أيضاً) عبر ECDH+HKDF.
       - جهاز جديد يبدأ برسائل جديدة فقط (الرسائل القديمة لا تُفتح عليه).
  ═══════════════════════════════════════════════════════════ */
  const MAX_DEVICES = 8;

  function create(deps) {
    const FB = deps.FB;
    const store = deps.store;

    let _uid = null;
    let _dev = null;           // { id, kid, pub, priv:CryptoKey, created }
    let _ready = false;
    let _status = 'idle';      // idle | ready | unsupported | error
    let _lastError = null;
    const _readyCbs = [];
    const _devCache = new Map();   // uid → { t, v:[{id,pub,kid}] }
    const _kekCache = new Map();   // `${myKid}|${theirKid}|${dmKey}` → CryptoKey
    const _msgCache = new Map();

    function _setStatus(s) {
      _status = s;
      _ready = (s === 'ready');
      if (_ready) _readyCbs.slice().forEach(cb => { try { cb(); } catch (e) {} });
    }
    const _rand = n => crypto.getRandomValues(new Uint8Array(n));
    const _importPub = canon => subtle.importKey('jwk', Object.assign(JSON.parse(canon), { ext: true }), { name: 'ECDH', namedCurve: 'P-256' }, false, []);

    async function _genDevice() {
      const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const pub = canonPub(await subtle.exportKey('jwk', kp.publicKey));
      return { id: hex(_rand(10)), kid: await kidOf(pub), pub, priv: kp.privateKey, created: Date.now() };
    }
    async function _saveDev() {
      await store.set('dev_' + _uid, { id: _dev.id, kid: _dev.kid, pub: _dev.pub, created: _dev.created, jwk: await subtle.exportKey('jwk', _dev.priv) });
    }
    async function _loadDev() {
      const r = await store.get('dev_' + _uid);
      if (!r || !r.jwk || !r.id) return null;
      try {
        const priv = await subtle.importKey('jwk', r.jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        if (await kidOf(r.pub) !== r.kid) return null;
        return { id: r.id, kid: r.kid, pub: r.pub, priv, created: r.created };
      } catch (e) { return null; }
    }

    async function _fetchDevices(uid) {
      const raw = await FB.get(`userDevices/${uid}`);
      const out = [];
      for (const id of Object.keys(raw || {})) {
        const r = raw[id];
        if (!r || typeof r.pub !== 'string' || r.pub.length > 400) continue;
        try {
          const kid = await kidOf(r.pub);
          if (r.kid && r.kid !== kid) continue;      // غير متسق → تجاهل
          await _importPub(r.pub);                    // يتأكد أنه مفتاح صالح
          out.push({ id, pub: r.pub, kid, ts: r.ts || 0 });
        } catch (e) {}
      }
      return out;
    }
    async function getDevices(uid, fresh) {
      const c = _devCache.get(uid);
      if (c && !fresh && Date.now() - c.t < 10000) return c.v;
      let v;
      // fresh (مسارات التشفير): فشل الجلب يُرفع كخطأ — ممنوع اعتباره «لا أجهزة» وإلا يُرسل النص بلا تشفير
      try { v = await _fetchDevices(uid); } catch (e) { if (fresh) throw e; v = c ? c.v : []; }
      _devCache.set(uid, { t: Date.now(), v });
      return v;
    }

    /** يهيّئ هوية هذا الجهاز وينشرها تلقائياً. */
    async function init(uid) {
      _uid = uid; _ready = false; _dev = null; _kekCache.clear(); _msgCache.clear(); _devCache.clear();
      if (!subtle) { _status = 'unsupported'; return _status; }
      try {
        _dev = await _loadDev();
        if (!_dev) { _dev = await _genDevice(); await _saveDev(); }
        await FB.set(`userDevices/${uid}/${_dev.id}`, { pub: _dev.pub, kid: _dev.kid, v: VERSION, ts: _dev.created });
        // تنظيف: المفتاح القديم (نسخة سابقة) + إبقاء أحدث MAX_DEVICES فقط
        try { if (FB.del) await FB.del(`userKeys/${uid}`); } catch (e) {}
        try {
          const all = (await _fetchDevices(uid)).sort((a, b) => b.ts - a.ts);
          const extra = all.filter(d => d.id !== _dev.id).slice(MAX_DEVICES - 1);
          if (FB.del) for (const d of extra) await FB.del(`userDevices/${uid}/${d.id}`);
        } catch (e) {}
        _setStatus('ready');
        return _status;
      } catch (e) {
        _status = 'error'; _ready = false; _lastError = e; return _status;
      }
    }

    /** أجهزتي المسجّلة (للعرض) */
    async function myDevices() {
      if (!_uid) return [];
      return (await getDevices(_uid, true)).map(d => ({ id: d.id, current: !!_dev && d.id === _dev.id, ts: d.ts }));
    }
    /** إزالة كل أجهزتي الأخرى (إن ضاع جهاز) */
    async function removeOtherDevices() {
      if (!_uid || !_dev || !FB.del) return 0;
      const all = await _fetchDevices(_uid); let n = 0;
      for (const d of all) if (d.id !== _dev.id) { await FB.del(`userDevices/${_uid}/${d.id}`); n++; }
      _devCache.delete(_uid);
      return n;
    }

    /** أجهزة الطرف الآخر (truthy إن كان يدعم التشفير) */
    async function getPeerKey(peerUid, fresh) {
      const d = await getDevices(peerUid, fresh);
      return d.length ? { devices: d } : null;
    }
    async function canEncryptTo(peerUid) {
      if (!_ready) return false;
      return !!(await getPeerKey(peerUid));
    }

    /* ── اشتقاق مفتاح التغليف بين جهازين ── */
    async function _kek(myRec, theirCanon, dmKey) {
      const theirKid = await kidOf(theirCanon);
      const ck = `${myRec.kid}|${theirKid}|${dmKey}`;
      if (_kekCache.has(ck)) return _kekCache.get(ck);
      const bits = await subtle.deriveBits({ name: 'ECDH', public: await _importPub(theirCanon) }, myRec.priv, 256);
      const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
      const k = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('nabda-e2e-v2-wrap|' + dmKey) },
        hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      _kekCache.set(ck, k);
      return k;
    }
    const _aad = (dmKey, senderUid) => enc.encode(`${dmKey}|${senderUid}`);
    const _wrapAad = (dmKey, senderUid, rkid) => enc.encode(`${dmKey}|${senderUid}|${rkid}`);

    const PLAIN_KEYS = ['type', 'sender', 'ts', 'status', 'forwarded', 'replyTo', 'reactions', 'edited', 'editedAt', 'deleted', 'deletedAt', 'e2e', 'id'];

    /** يبني رسالة مشفّرة (أو null إن لم يكن للطرف الآخر أجهزة). */
    async function encryptMessage(dmKey, peerUid, base, payload) {
      if (!_ready) throw new Error('not_ready');
      const [peerDevs, myDevs] = await Promise.all([getDevices(peerUid, true), getDevices(_uid, true)]);
      if (!peerDevs.length) return null;
      const recips = new Map();
      peerDevs.concat(myDevs).forEach(d => recips.set(d.kid, d));
      recips.set(_dev.kid, { id: _dev.id, kid: _dev.kid, pub: _dev.pub });     // جهازي الحالي دائماً

      const bundle = {};
      Object.keys(payload || {}).forEach(k => { if (!PLAIN_KEYS.includes(k) && payload[k] !== undefined) bundle[k] = payload[k]; });
      if (payload && payload.replyTo && payload.replyTo.text != null) bundle.rt = payload.replyTo.text;

      const rawCk = _rand(32);
      const ckKey = await subtle.importKey('raw', rawCk, 'AES-GCM', false, ['encrypt']);
      const iv = _rand(12);
      const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: _aad(dmKey, base.sender) }, ckKey, enc.encode(JSON.stringify(bundle)));
      const w = {};
      for (const d of recips.values()) {
        const kek = await _kek(_dev, d.pub, dmKey);
        const wiv = _rand(12);
        const wct = await subtle.encrypt({ name: 'AES-GCM', iv: wiv, additionalData: _wrapAad(dmKey, base.sender, d.kid) }, kek, rawCk);
        w[d.kid] = { iv: b64(wiv), ct: b64(wct) };
      }
      const msg = Object.assign({}, base, { type: payload.type || 'text' });
      if (payload.replyTo) msg.replyTo = { id: payload.replyTo.id, sender: payload.replyTo.sender, type: payload.replyTo.type };
      if (payload.forwarded) msg.forwarded = true;
      msg.e2e = { v: VERSION, iv: b64(iv), ct: b64(ct), skid: _dev.kid, spk: _dev.pub, w };
      return msg;
    }

    // يتأكد أن مفتاح الجهاز المُرسِل مسجّل فعلاً تحت حساب المرسل (لا يستطيع غيره تسجيله)
    async function _senderDeviceOk(sender, skid, spk) {
      if (sender === _uid && _dev && _dev.kid === skid && _dev.pub === spk) return true;
      let devs = await getDevices(sender);
      if (devs.some(d => d.kid === skid && d.pub === spk)) return true;
      devs = await getDevices(sender, true);
      return devs.some(d => d.kid === skid && d.pub === spk);
    }

    async function _bundleOf(dmKey, m) {
      const e = m.e2e;
      if (!e || e.v !== VERSION || typeof e.iv !== 'string' || typeof e.ct !== 'string' || typeof e.spk !== 'string' || !e.w || typeof e.skid !== 'string') throw new Error('bad_format');
      const ck = [dmKey, m.id, m.sender, e.iv, e.skid, e.spk, e.ct, JSON.stringify(e.w)].join('/');
      if (m.id && _msgCache.has(ck)) return _msgCache.get(ck);
      const mine = e.w[_dev.kid];
      if (!mine || typeof mine.iv !== 'string' || typeof mine.ct !== 'string') throw new Error('no_key');
      if (e.spk.length > 400 || (await kidOf(e.spk)) !== e.skid) throw new Error('bad_format');
      if (!(await _senderDeviceOk(m.sender, e.skid, e.spk))) throw new Error('bad_sender');
      const kek = await _kek(_dev, e.spk, dmKey);
      const rawCk = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(mine.iv), additionalData: _wrapAad(dmKey, m.sender, _dev.kid) }, kek, unb64(mine.ct));
      const ckKey = await subtle.importKey('raw', rawCk, 'AES-GCM', false, ['decrypt']);
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(e.iv), additionalData: _aad(dmKey, m.sender) }, ckKey, unb64(e.ct));
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
        out.text = _ready ? '🔒 رسالة مشفّرة — أُرسلت قبل ربط هذا الجهاز' : '🔒 رسالة مشفّرة';
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

    /** إعادة تشفير نص معدّل (تعديل رسالة) — يرجع كائن e2e الجديد */
    async function reencryptEdit(dmKey, peerUid, rawMsg, newText) {
      const old = await _bundleOf(dmKey, rawMsg);
      const bundle = Object.assign({}, old, { text: newText, originalText: old.originalText || old.text });
      const payload = Object.assign({}, bundle, { type: rawMsg.type });
      const base = { sender: rawMsg.sender, ts: rawMsg.ts, status: rawMsg.status || 'sent' };
      const e = await encryptMessage(dmKey, peerUid, base, payload);
      return e ? e.e2e : null;
    }

    /** رقم أمان (30 رقماً) يتطابق عند الطرفين: يعتمد على كل أجهزة الطرفين */
    async function safetyNumber(peerUid) {
      if (!_ready) return null;
      const [pd, md] = await Promise.all([getDevices(peerUid, true), getDevices(_uid, true)]);
      if (!pd.length) return null;
      const side = (u, ds) => u + ':' + ds.map(d => d.kid).sort().join(',');
      const parts = [side(_uid, md), side(peerUid, pd)].sort();
      const h = new Uint8Array(await subtle.digest('SHA-256', enc.encode(parts.join('|'))));
      let digits = '';
      for (let i = 0; i < 30; i++) digits += String(h[i] % 10);
      return digits.match(/.{1,5}/g).join(' ');
    }

    return {
      init, myDevices, removeOtherDevices,
      canEncryptTo, getPeerKey, encryptMessage, decryptMessage, decryptList, decryptMap, reencryptEdit,
      safetyNumber,
      isReady: () => _ready,
      status: () => _status,
      lastError: () => _lastError,
      myKid: () => _dev && _dev.kid,
      onReady: cb => { _readyCbs.push(cb); if (_ready) { try { cb(); } catch (e) {} } return () => { const i = _readyCbs.indexOf(cb); if (i >= 0) _readyCbs.splice(i, 1); }; },
      reset: () => { _uid = null; _dev = null; _ready = false; _status = 'idle'; _kekCache.clear(); _msgCache.clear(); _devCache.clear(); },
    };
  }

  /* ── المثيل الافتراضي (يُهيّأ عند أول استخدام لأن FB يُحمَّل قبلنا) ── */
  let _inst = null;
  function inst() {
    if (!_inst) _inst = create({ FB: window.FB, store: idbStore() });
    return _inst;
  }
  const api = { create, b64, unb64 };
  ['init', 'myDevices', 'removeOtherDevices', 'canEncryptTo', 'getPeerKey',
    'encryptMessage', 'decryptMessage', 'decryptList', 'decryptMap', 'reencryptEdit', 'safetyNumber',
    'isReady', 'status', 'lastError', 'myKid', 'onReady', 'reset'].forEach(k => {
    api[k] = function () { const i = inst(); return i[k].apply(i, arguments); };
  });
  return api;

})();
