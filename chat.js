/**
 * js/chat.js
 * Messages, typing, unread, presence
 * ✅ Fix: prevent duplicate messages using seenIds Set
 * Depends on: firebase.js (window.FB)
 * Exposes:    window.Chat
 */
window.Chat = (function () {

  /* ── Helpers ─────────────────────────────────────────────── */
  const dmKey = (a, b) => [a, b].sort().join('_');

  const LS_READ = 'nabda_read';
  function lsGet(k, fb)  { try { const v = localStorage.getItem(k); return v != null ? JSON.parse(v) : fb; } catch { return fb; } }
  function lsSet(k, v)   { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

  /* ── Parse raw Firebase snapshot → sorted array ─────────── */
  function parseMessages(raw) {
    if (!raw) return [];
    return Object.entries(raw)
      .map(([id, m]) => ({ ...m, id }))
      .sort((a, b) => a.ts - b.ts);
  }

  /* ═══════════════════════════════════════════════════════════
     SEND
  ═══════════════════════════════════════════════════════════ */
  function sendDM(me, target, payload) {
    return FB.push(`dmMsgs/${dmKey(me, target)}`, {
      sender: me,
      ts:     Date.now(),
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
     LISTEN  (returns unsub fn)
  ═══════════════════════════════════════════════════════════ */
  function listenDM(me, target, cb) {
    return FB.on(`dmMsgs/${dmKey(me, target)}`, raw => cb(parseMessages(raw)));
  }

  function listenGroup(groupId, cb) {
    return FB.on(`groupMsgs/${groupId}`, raw => cb(parseMessages(raw)));
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
      clearTimeout(_typingTimer);
      FB.del(path);
    }
  }

  function clearTyping(me, activeId, screen) {
    if (!me || !activeId) return;
    const path = screen === 'dm'
      ? `typing/dm/${dmKey(me, activeId)}/${me}`
      : `typing/group/${activeId}/${me}`;
    FB.del(path);
  }

  function getTypingUsers(typingMap, me, activeId, screen) {
    if (!activeId || !me) return [];
    const key = screen === 'dm' ? dmKey(me, activeId) : activeId;
    const obj  = screen === 'dm'
      ? (typingMap?.dm?.[key]    || {})
      : (typingMap?.group?.[activeId] || {});
    return Object.keys(obj).filter(u => u !== me);
  }

  /* ═══════════════════════════════════════════════════════════
     UNREAD
  ═══════════════════════════════════════════════════════════ */
  function markRead(chatKey) {
    const store = lsGet(LS_READ, {});
    store[chatKey] = Date.now();
    lsSet(LS_READ, store);
  }

  function getLastRead(chatKey) {
    return lsGet(LS_READ, {})[chatKey] || 0;
  }

  function computeUnread(me, users, dmChats) {
    const counts = {};
    if (!me || !dmChats) return counts;
    Object.keys(users).filter(u => u !== me).forEach(u => {
      const key  = dmKey(me, u);
      const msgs = dmChats[key]
        ? Object.values(dmChats[key]).sort((a, b) => a.ts - b.ts)
        : [];
      const lr = getLastRead(key);
      const n  = msgs.filter(m => m.sender !== me && m.ts > lr).length;
      if (n > 0) counts[u] = n;
    });
    return counts;
  }

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
     ✅ FIX: Deduplication helpers
     Used by app.js to prevent showing optimistic + real duplicates
  ═══════════════════════════════════════════════════════════ */

  /**
   * Returns only messages NOT already rendered
   * @param {Array} msgs - full message array from Firebase
   * @param {Set}   seenIds - IDs already rendered
   * @returns {Array} new messages to append
   */
  function getNewMessages(msgs, seenIds) {
    return msgs.filter(m => !seenIds.has(m.id));
  }

  /* ═══════════════════════════════════════════════════════════
     PRESENCE
  ═══════════════════════════════════════════════════════════ */
  function goOnline(user) {
    if (!user) return;
    FB.set(`presence/${user}`, { online: true, last: Date.now() });
    FB.onDisconn(`presence/${user}`, { online: false, last: Date.now() });
  }

  function goOffline(user) {
    if (!user) return;
    FB.set(`presence/${user}`, { online: false, last: Date.now() });
  }

  function isOnline(presence, user)   { return presence[user]?.online === true; }

  function lastSeenText(presence, user) {
    const p = presence[user];
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

  return {
    dmKey,
    parseMessages,
    sendDM,
    sendGroup,
    listenDM,
    listenGroup,
    setTyping,
    clearTyping,
    getTypingUsers,
    markRead,
    getLastRead,
    computeUnread,
    getDMMessages,
    getLastDMMsg,
    getNewMessages,     // ✅ new
    goOnline,
    goOffline,
    isOnline,
    lastSeenText
  };

})();
