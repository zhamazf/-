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
 *
 * v2 additions:
 * 8.  sendDM / sendGroup → يدعم replyTo (الرد على رسالة)
 * 9.  deleteMsg()        → حذف رسالة (DM أو مجموعة)
 * 10. editMsg()          → تعديل نص رسالة + سجل التعديل
 * 11. addReaction() / removeReaction() → تفاعلات emoji
 * 12. pinMsg() / unpinMsg() / getPinnedMsg() → تثبيت رسالة
 * 13. loadMoreMsgs()     → تحميل رسائل أقدم (pagination)
 * 14. searchMessages()   → بحث نصي في الرسائل
 * 15. computeUnreadGroups() → عدد غير المقروء للمجموعات
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
  const MAX_MSG_LEN = 2000; // حد أقصى لطول الرسالة النصية

  function sendDM(me, target, payload) {
    if (!me || !target) return Promise.reject(new Error('missing_args'));
    if (payload?.type === 'text') {
      if (!payload.text?.trim()) return Promise.reject(new Error('empty_message'));
      if (payload.text.length > MAX_MSG_LEN) return Promise.reject(new Error('message_too_long'));
    }
    // replyTo: { id, text, sender, type } — اختياري
    const base = { sender: me, ts: Date.now(), status: 'sent' };
    if (payload?.replyTo) base.replyTo = payload.replyTo;
    return FB.push(`dmMsgs/${dmKey(me, target)}`, { ...base, ...payload });
  }

  function sendGroup(groupId, me, payload) {
    if (!me || !groupId) return Promise.reject(new Error('missing_args'));
    if (payload?.type === 'text') {
      if (!payload.text?.trim()) return Promise.reject(new Error('empty_message'));
      if (payload.text.length > MAX_MSG_LEN) return Promise.reject(new Error('message_too_long'));
    }
    const base = { sender: me, ts: Date.now() };
    if (payload?.replyTo) base.replyTo = payload.replyTo;
    return FB.push(`groupMsgs/${groupId}`, { ...base, ...payload });
  }

  /* ═══════════════════════════════════════════════════════════
     DELETE MESSAGE
     - DM:    يحذف من dmMsgs/{chatKey}/{msgId}
     - Group: يحذف من groupMsgs/{groupId}/{msgId}
     - فقط المُرسل يحذف رسالته (أو الأدمن في المجموعة — يُعالج في app.js)
     - بعد الحذف يضع placeholder { deleted: true } بدل الحذف الكامل
       حتى لا تختفي فجوات في المحادثة
  ═══════════════════════════════════════════════════════════ */
  async function deleteMsg(chatPath, msgId, myUid) {
    if (!chatPath || !msgId || !myUid) return { error: 'missing_args' };
    try {
      // نتحقق أن الرسالة للمُرسل نفسه
      const msg = await FB.get(`${chatPath}/${msgId}`);
      if (!msg) return { error: 'الرسالة غير موجودة' };
      if (msg.sender !== myUid) return { error: 'لا يمكنك حذف رسالة شخص آخر' };

      // نستبدل بـ placeholder بدل الحذف الكلي
      await FB.set(`${chatPath}/${msgId}`, {
        id:        msgId,
        sender:    myUid,
        ts:        msg.ts,
        deleted:   true,
        deletedAt: Date.now(),
      });
      return { ok: true };
    } catch (err) {
      return { error: err.message || 'خطأ في الحذف' };
    }
  }

  // دالة مساعدة: مسار الرسالة حسب النوع
  function msgPath(type, chatKeyOrGroupId) {
    return type === 'dm' ? `dmMsgs/${chatKeyOrGroupId}` : `groupMsgs/${chatKeyOrGroupId}`;
  }

  /* ═══════════════════════════════════════════════════════════
     EDIT MESSAGE
     - نصوص فقط (لا يمكن تعديل صور أو صوت)
     - يُضاف حقل edited: true + editedAt + originalText للسجل
  ═══════════════════════════════════════════════════════════ */
  async function editMsg(chatPath, msgId, myUid, newText) {
    if (!chatPath || !msgId || !myUid) return { error: 'missing_args' };
    newText = (newText || '').trim();
    if (!newText) return { error: 'النص فارغ' };
    if (newText.length > MAX_MSG_LEN) return { error: 'النص طويل جداً' };

    try {
      const msg = await FB.get(`${chatPath}/${msgId}`);
      if (!msg)              return { error: 'الرسالة غير موجودة' };
      if (msg.sender !== myUid) return { error: 'لا يمكنك تعديل رسالة شخص آخر' };
      if (msg.type !== 'text')  return { error: 'يمكن تعديل النصوص فقط' };
      if (msg.deleted)          return { error: 'الرسالة محذوفة' };

      await FB.upd(`${chatPath}/${msgId}`, {
        text:         newText,
        edited:       true,
        editedAt:     Date.now(),
        originalText: msg.originalText || msg.text, // نحفظ النص الأصلي مرة واحدة
      });
      return { ok: true };
    } catch (err) {
      return { error: err.message || 'خطأ في التعديل' };
    }
  }

  /* ═══════════════════════════════════════════════════════════
     REACTIONS
     Path: {chatPath}/{msgId}/reactions/{emoji}/{uid} → true
     مثال: dmMsgs/abc_xyz/msg1/reactions/❤️/uid123 → true
  ═══════════════════════════════════════════════════════════ */
  const ALLOWED_REACTIONS = ['❤️','😂','😮','😢','👍','🔥'];

  async function addReaction(chatPath, msgId, myUid, emoji) {
    if (!chatPath || !msgId || !myUid || !emoji) return { error: 'missing_args' };
    if (!ALLOWED_REACTIONS.includes(emoji)) return { error: 'تفاعل غير مدعوم' };
    try {
      await FB.set(`${chatPath}/${msgId}/reactions/${emoji}/${myUid}`, true);
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  }

  async function removeReaction(chatPath, msgId, myUid, emoji) {
    if (!chatPath || !msgId || !myUid || !emoji) return { error: 'missing_args' };
    try {
      await FB.del(`${chatPath}/${msgId}/reactions/${emoji}/${myUid}`);
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  }

  // تحويل كائن reactions الخام من Firebase إلى مصفوفة مناسبة للعرض
  // مثال: { ❤️: { uid1: true, uid2: true } } → [{ emoji: '❤️', count: 2, mine: true }]
  function parseReactions(rawReactions, myUid) {
    if (!rawReactions) return [];
    return Object.entries(rawReactions)
      .map(([emoji, users]) => ({
        emoji,
        count: Object.keys(users || {}).length,
        mine:  !!(users?.[myUid]),
        uids:  Object.keys(users || {}),
      }))
      .filter(r => r.count > 0)
      .sort((a, b) => b.count - a.count);
  }

  /* ═══════════════════════════════════════════════════════════
     PIN MESSAGE
     Path: pinnedMsgs/{chatKey} → { msgId, text, sender, ts, pinnedAt, pinnedBy }
     واحدة فقط مثبّتة في كل محادثة (مثل واتساب)
  ═══════════════════════════════════════════════════════════ */
  async function pinMsg(chatPath, msg, pinnedByUid) {
    if (!chatPath || !msg?.id || !pinnedByUid) return { error: 'missing_args' };
    try {
      // نحوّل chatPath → مفتاح آمن للـ DB (نستبدل / بـ _)
      const pinKey = chatPath.replace(/\//g, '_');
      await FB.set(`pinnedMsgs/${pinKey}`, {
        msgId:    msg.id,
        sender:   msg.sender,
        type:     msg.type || 'text',
        text:     msg.type === 'text' ? (msg.text || '').slice(0, 120) : `[${msg.type}]`,
        ts:       msg.ts,
        pinnedAt: Date.now(),
        pinnedBy: pinnedByUid,
      });
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  }

  async function unpinMsg(chatPath) {
    if (!chatPath) return { error: 'missing_args' };
    try {
      const pinKey = chatPath.replace(/\//g, '_');
      await FB.del(`pinnedMsgs/${pinKey}`);
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  }

  async function getPinnedMsg(chatPath) {
    if (!chatPath) return null;
    try {
      const pinKey = chatPath.replace(/\//g, '_');
      return await FB.get(`pinnedMsgs/${pinKey}`);
    } catch { return null; }
  }

  function listenPinned(chatPath, cb) {
    const pinKey = chatPath.replace(/\//g, '_');
    return FB.on(`pinnedMsgs/${pinKey}`, data => cb(data || null));
  }

  /* ═══════════════════════════════════════════════════════════
     PAGINATION — تحميل رسائل أقدم
     يستخدم orderByKey().endBefore(oldestId).limitToLast(N)
     يعمل فقط إذا FB.getPage() متاح في firebase.js
     وإلا يرجع [] بهدوء (graceful fallback)
  ═══════════════════════════════════════════════════════════ */
  const PAGE_SIZE = 40;

  async function loadMoreMsgs(path, oldestMsgId) {
    if (!path || !oldestMsgId) return [];
    try {
      if (typeof FB.getPage !== 'function') return []; // firebase.js لا يدعم بعد
      const raw = await FB.getPage(path, oldestMsgId, PAGE_SIZE);
      return parseMessages(raw);
    } catch { return []; }
  }

  /* ═══════════════════════════════════════════════════════════
     SEARCH MESSAGES — بحث نصي في الرسائل المحلية
     يبحث في S.msgs (المحمّلة في الذاكرة) — لا يستدعي Firebase
     للبحث في الرسائل القديمة (ما لم تُحمَّل) يحتاج Firebase Functions
  ═══════════════════════════════════════════════════════════ */
  function searchMessages(msgs, query) {
    if (!msgs?.length || !query?.trim()) return [];
    const q = query.trim().toLowerCase();
    return msgs
      .filter(m =>
        !m.deleted &&
        m.type === 'text' &&
        m.text?.toLowerCase().includes(q)
      )
      .map(m => ({ ...m })); // نسخة لتفادي التعديل المباشر
  }

  /* ═══════════════════════════════════════════════════════════
     UNREAD — للمجموعات
     نفس منطق computeUnread لكن للمجموعات
     groupMsgs محمّلة في S.groupMsgsCache (تُملأ من app.js)
  ═══════════════════════════════════════════════════════════ */
  const _groupReadCache = new Map(); // groupId → timestamp

  function updateGroupReadCache(groupId, ts) {
    _groupReadCache.set(groupId, ts || 0);
  }

  async function markGroupRead(groupId, myUid) {
    if (!groupId || !myUid) return;
    const now = Date.now();
    try {
      await FB.set(`readReceipts/group_${groupId}/${myUid}`, now);
      _groupReadCache.set(groupId, now);
    } catch {}
  }

  function computeUnreadGroups(myGroups, groupMsgsMap, myUid) {
    // myGroups: مصفوفة كائنات المجموعات { id, ... }
    // groupMsgsMap: { [groupId]: { [msgId]: msg } }
    const counts = {};
    if (!myGroups?.length || !myUid) return counts;
    myGroups.forEach(g => {
      const raw  = groupMsgsMap?.[g.id];
      const msgs = raw ? Object.values(raw).sort((a, b) => a.ts - b.ts) : [];
      const lr   = _groupReadCache.get(g.id) || 0;
      const n    = msgs.filter(m => m.sender !== myUid && m.ts > lr && !m.deleted).length;
      if (n > 0) counts[g.id] = n;
    });
    return counts;
  }

  /* ═══════════════════════════════════════════════════════════
     LISTEN — limitToLast(60) prevents loading all messages
  ═══════════════════════════════════════════════════════════ */
  const MSG_LIMIT = 60;

  function _listen(path, cb) {
    // Serve cache first — instant render while Firebase loads
    _idbGet('msgs', path).then(cached => { if (cached?.length) cb(cached); });

    // Use FB.onLimit if available (limitToLast), else fall back to FB.on
    if (typeof FB.onLimit === 'function') {
      return FB.onLimit(path, MSG_LIMIT, raw => {
        const msgs = parseMessages(raw);
        _idbSet('msgs', path, msgs);
        cb(msgs);
      });
    } else {
      return FB.on(path, raw => {
        const msgs = parseMessages(raw);
        _idbSet('msgs', path, msgs);
        cb(msgs);
      });
    }
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
      _readCache.set(chatKey, now);
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

  // ── computeUnread: يعتمد على readReceipts في Firebase ──────
  // _readCache: chatKey → timestamp (يُملأ من readReceipts listener)
  const _readCache = new Map();

  function updateReadCache(chatKey, ts) {
    _readCache.set(chatKey, ts || 0);
  }

  function computeUnread(me, usersByName, dmChats) {
    const counts = {};
    if (!me || !dmChats) return counts;
    const meUid = usersByName[me]?.uid;
    if (!meUid) return counts;
    Object.entries(usersByName).filter(([uname]) => uname !== me).forEach(([uname, udata]) => {
      const friendUid = udata?.uid;
      if (!friendUid) return;
      const key  = dmKey(meUid, friendUid);
      const msgs = dmChats[key]
        ? Object.values(dmChats[key]).sort((a, b) => a.ts - b.ts)
        : [];
      // أولاً readReceipts cache، ثم fallback لـ localStorage القديم
      const lr = _readCache.get(key) || 0;
      const n  = msgs.filter(m => m.sender !== meUid && m.ts > lr).length;
      if (n > 0) counts[uname] = n;
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

  // تنظيف typing عند إغلاق الصفحة
  let _activeTypingPath = null;
  window.addEventListener('beforeunload', () => {
    if (_activeTypingPath) FB.del(_activeTypingPath);
  });

  function setTyping(me, activeId, screen, isTyping) {
    if (!activeId || !me) return;
    const path = screen === 'dm'
      ? `typing/dm/${dmKey(me, activeId)}/${me}`
      : `typing/group/${activeId}/${me}`;

    if (isTyping) {
      FB.set(path, true);
      _activeTypingPath = path;
      clearTimeout(_typingTimer);
      _typingTimer = setTimeout(() => { FB.del(path); _activeTypingPath = null; }, 3000);
    } else {
      clearTimeout(_typingTimer);
      FB.del(path);
      _activeTypingPath = null;
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
    if (!p.last)  return 'غير متصل';
    const d = Date.now() - p.last;
    if (d < 30000)    return 'آخر ظهور: للتو';
    if (d < 60000)    return 'آخر ظهور: منذ لحظة';
    if (d < 3600000)  return `آخر ظهور: منذ ${Math.floor(d / 60000)} دقيقة`;
    if (d < 7200000)  return 'آخر ظهور: منذ ساعة';
    if (d < 86400000) return `آخر ظهور: ${_fmt(p.last)}`;
    if (d < 172800000) return 'آخر ظهور: أمس';
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

    // Send (v2: يدعم replyTo)
    sendDM,
    sendGroup,

    // Delete & Edit (v2)
    deleteMsg,
    editMsg,
    msgPath,

    // Reactions (v2)
    addReaction,
    removeReaction,
    parseReactions,
    ALLOWED_REACTIONS,

    // Pin (v2)
    pinMsg,
    unpinMsg,
    getPinnedMsg,
    listenPinned,

    // Pagination (v2)
    loadMoreMsgs,
    PAGE_SIZE,

    // Search (v2)
    searchMessages,

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

    // Unread DM
    computeUnread,
    updateReadCache,
    getDMMessages,
    getLastDMMsg,

    // Unread Groups (v2)
    computeUnreadGroups,
    updateGroupReadCache,
    markGroupRead,

    // Presence
    goOnline,
    goOffline,
    isOnline,
    lastSeenText,
  };

})();
