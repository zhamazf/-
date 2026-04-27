/**
 * js/chat.js
 * Messages, typing, unread, presence, read/delivery receipts
 *
 * Depends on: firebase.js (window.FB)
 * Exposes:    window.Chat
 *
 * Changes from original:
 * 1. markRead / computeUnread → Firebase readReceipts (not localStorage)
 * 2. listenDM / listenGroup   → limitToLast(60) to avoid loading all msgs
 * 3. IndexedDB cache for offline-first UX
 * 4. statusText() for ✓ / ✓✓ / ✓✓🔵 delivery display
 * 5. markDelivered / markMsgsRead → update msg.status in Firebase
 * 6. getNewMessages deduplication helper (used by app.js)
 * 7. clearTyping stops immediately (no stale timer)
 */
window.Chat = (function () {

  /* ── helpers ─────────────────────────────────────────────── */
  const dmKey = (a, b) => [a, b].sort().join('_');

  /* ── IndexedDB — offline cache ───────────────────────────── */
  let _idb = null;

  (function _openIDB() {
    try {
      const req = indexedDB.open('nabda_cache_v2', 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('msgs'))
          db.createObjectStore('msgs');
        if (!db.objectStoreNames.contains('reads'))
          db.createObjectStore('reads');
      };
      req.onsuccess = e => { _idb = e.target.result; };
      req.onerror   = () => { _idb = null; };
    } catch { _idb = null; }
  })();

  function _idbSet(store, key, val) {
    if (!_idb) return;
    try {
      _idb.transaction(store, 'readwrite').objectStore(store).put(val, key);
    } catch {}
  }

  function _idbGet(store, key) {
    return new Promise(res => {
      if (!_idb) return res(null);
      try {
        const req = _idb.transaction(store, 'readonly').objectStore(store).get(key);
        req.onsuccess = () => res(req.result ?? null);
        req.onerror   = () => res(null);
      } catch { res(null); }
    });
  }

  /* ── Parse raw Firebase snapshot → sorted array ──────────── */
  function parseMessages(raw) {
    if (!raw) return [];
    return Object.entries(raw)
      .map(([id, m]) => ({ ...m, id }))
      .sort((a, b) => a.ts - b.ts);
  }

  /* ── Deduplication (used by app.js startMsgListener) ─────── */
  function getNewMessages(msgs, seenIds) {
    return msgs.filter(m => !seenIds.has(m.id));
  }

  /* ═══════════════════════════════════════════════════════════
     SEND
  ═══════════════════════════════════════════════════════════ */
  function sendDM(me, target, payload) {
    return FB.push(`dmMsgs/${dmKey(me, target)}`, {
      sender: me,
      ts:     Date.now(),
      status: 'sent',
      ...payload
    });
  }

  function sendGroup(groupId, me, payload) {
    return FB.push(`groupMsgs/${groupId}`, {
      sender: me,
      ts:     Date.now(),
      ...payload
    });
  }

  /* ═══════════════════════════════════════════════════════════
     LISTEN — limitToLast(60) prevents loading all messages
  ═══════════════════════════════════════════════════════════ */
  const MSG_LIMIT = 60;

  function _listen(path, cb) {
    // Serve cache first — instant render while Firebase loads
    _idbGet('msgs', path).then(cached => { if (cached?.length) cb(cached); });

    // Use FB.onLimit if available (limitToLast), else fall back to FB.on
    const listenFn = typeof FB.onLimit === 'function' ? FB.onLimit : FB.on;
    return listenFn(path, MSG_LIMIT, raw => {
      const msgs = parseMessages(raw);
      _idbSet('msgs', path, msgs);
      cb(msgs);
    });
  }

  function listenDM(me, target, cb) {
    return _listen(`dmMsgs/${dmKey(me, target)}`, cb);
  }

  function listenGroup(groupId, cb) {
    return _listen(`groupMsgs/${groupId}`, cb);
  }

  /* ═══════════════════════════════════════════════════════════
     READ RECEIPTS — Firebase (syncs across all devices)
     Path: readReceipts/{chatKey}/{uid} → timestamp
  ═══════════════════════════════════════════════════════════ */

  async function markRead(chatKey, myUid) {
    if (!chatKey) return;
    // Support old single-arg call: markRead(chatKey)
    if (!myUid) {
      myUid = FB.authCurrentUser()?.uid;
      if (!myUid) return;
    }
    const now = Date.now();
    try {
      await FB.set(`readReceipts/${chatKey}/${myUid}`, now);
      _idbSet('reads', `${chatKey}/${myUid}`, now);
    } catch {}
  }

  async function getLastRead(chatKey, myUid) {
    if (!chatKey || !myUid) return 0;
    try {
      const val = await FB.get(`readReceipts/${chatKey}/${myUid}`);
      if (val) return val;
    } catch {}
    return (await _idbGet('reads', `${chatKey}/${myUid}`)) || 0;
  }

  function listenReadReceipt(chatKey, partnerUid, cb) {
    return FB.on(`readReceipts/${chatKey}/${partnerUid}`, ts => cb(ts || 0));
  }

  function computeUnreadFromMsgs(msgs, myUid, lastReadTs) {
    if (!msgs?.length) return 0;
    return msgs.filter(m => m.sender !== myUid && m.ts > (lastReadTs || 0)).length;
  }

  /* ── Legacy computeUnread (localStorage fallback) ─────────
     Still used by app.js for the chat list unread badges
     until readReceipts listener is wired up per-conversation.
  ── ─────────────────────────────────────────────────────── */
  const _LS_READ = 'nabda_read';
  function _lsGet(k, fb) {
    try { const v = localStorage.getItem(k); return v != null ? JSON.parse(v) : fb; }
    catch { return fb; }
  }

  function computeUnread(me, users, dmChats) {
    const counts = {};
    if (!me || !dmChats) return counts;
    const store = _lsGet(_LS_READ, {});
    Object.keys(users).filter(u => u !== me).forEach(u => {
      const key  = dmKey(me, u);
      const msgs = dmChats[key]
        ? Object.values(dmChats[key]).sort((a, b) => a.ts - b.ts)
        : [];
      const lr = store[key] || 0;
      const n  = msgs.filter(m => m.sender !== me && m.ts > lr).length;
      if (n > 0) counts[u] = n;
    });
    return counts;
  }

  /* ═══════════════════════════════════════════════════════════
     DELIVERY STATUS — update msg.status in Firebase
  ═══════════════════════════════════════════════════════════ */

  async function markDelivered(chatKey, msgs, myUid) {
    if (!msgs?.length || !myUid) return;
    const updates = {};
    msgs.forEach(m => {
      if (m.sender !== myUid && m.status === 'sent')
        updates[`dmMsgs/${chatKey}/${m.id}/status`] = 'delivered';
    });
    if (Object.keys(updates).length) {
      try { await FB.upd('/', updates); } catch {}
    }
  }

  async function markMsgsRead(chatKey, msgs, myUid) {
    if (!msgs?.length || !myUid) return;
    const updates = {};
    msgs.forEach(m => {
      if (m.sender !== myUid && m.status !== 'read')
        updates[`dmMsgs/${chatKey}/${m.id}/status`] = 'read';
    });
    if (Object.keys(updates).length) {
      try { await FB.upd('/', updates); } catch {}
    }
    await markRead(chatKey, myUid);
  }

  /**
   * Status icon shown in bubble meta line (app.js _statusText calls this)
   * ✓  = sent/optimistic
   * ✓✓ = delivered
   * ✓✓🔵 = read
   */
  function statusText(msg) {
    if (!msg) return '';
    switch (msg.status) {
      case 'read':      return '✓✓🔵';
      case 'delivered': return '✓✓';
      default:          return '✓';
    }
  }

  /* ═══════════════════════════════════════════════════════════
     TYPING
  ═══════════════════════════════════════════════════════════ */
  let _typingTimer = null;

  function setTyping(me, activeId, screen, isTyping) {
    if (!activeId || !me) return;
    const path = screen === 'dm'
      ? `typing/dm/${dmKey(me, activeId)}/${me}`
      : `typing/group/${activeId}/${me}`;

    if (isTyping) {
      FB.set(path, true);
      clearTimeout(_typingTimer);
      _typingTimer = setTimeout(() => FB.del(path), 3000);
    } else {
      // ✅ Immediate stop — no delay
      clearTimeout(_typingTimer);
      FB.del(path);
    }
  }

  function clearTyping(me, activeId, screen) {
    if (!me || !activeId) return;
    clearTimeout(_typingTimer);
    const path = screen === 'dm'
      ? `typing/dm/${dmKey(me, activeId)}/${me}`
      : `typing/group/${activeId}/${me}`;
    FB.del(path);
  }

  function getTypingUsers(typingMap, me, activeId, screen) {
    if (!activeId || !me) return [];
    const key = screen === 'dm' ? dmKey(me, activeId) : activeId;
    const obj  = screen === 'dm'
      ? (typingMap?.dm?.[key]         || {})
      : (typingMap?.group?.[activeId] || {});
    return Object.keys(obj).filter(u => u !== me);
  }

  /* ═══════════════════════════════════════════════════════════
     DM helpers — used by app.js chat list
  ═══════════════════════════════════════════════════════════ */
  function getDMMessages(me, target, dmChats) {
    const k = dmKey(me, target);
    return dmChats[k]
      ? Object.values(dmChats[k]).sort((a, b) => a.ts - b.ts)
      : [];
  }

  function getLastDMMsg(me, target, dmChats) {
    const msgs = getDMMessages(me, target, dmChats);
    return msgs[msgs.length - 1] || null;
  }

  /* ═══════════════════════════════════════════════════════════
     PRESENCE
  ═══════════════════════════════════════════════════════════ */
  function goOnline(uid) {
    if (!uid) return;
    FB.set(`presence/${uid}`, { online: true, last: Date.now() });
    FB.onDisconn(`presence/${uid}`, { online: false, last: Date.now() });
  }

  function goOffline(uid) {
    if (!uid) return;
    FB.set(`presence/${uid}`, { online: false, last: Date.now() });
  }

  function isOnline(presence, uid) {
    return presence?.[uid]?.online === true;
  }

  function lastSeenText(presence, uid) {
    const p = presence?.[uid];
    if (!p)       return '';
    if (p.online) return 'متصل الآن';
    const d = Date.now() - p.last;
    if (d < 60000)    return 'آخر ظهور: منذ لحظة';
    if (d < 3600000)  return `آخر ظهور: منذ ${Math.floor(d / 60000)} د`;
    if (d < 86400000) return `آخر ظهور: ${_fmt(p.last)}`;
    return `آخر ظهور: ${new Date(p.last).toLocaleDateString('ar')}`;
  }

  function _fmt(ts) {
    return new Date(ts).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
  }

  /* ── Public API ──────────────────────────────────────────── */
  return {
    dmKey,
    parseMessages,
    getNewMessages,

    // Send
    sendDM,
    sendGroup,

    // Listen
    listenDM,
    listenGroup,

    // Typing
    setTyping,
    clearTyping,
    getTypingUsers,

    // Read receipts (Firebase-based)
    markRead,
    getLastRead,
    listenReadReceipt,
    computeUnreadFromMsgs,
    markDelivered,
    markMsgsRead,
    statusText,

    // Legacy (localStorage fallback for chat list badges)
    computeUnread,
    getDMMessages,
    getLastDMMsg,

    // Presence
    goOnline,
    goOffline,
    isOnline,
    lastSeenText,
  };

})();
