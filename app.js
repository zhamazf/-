/**
 * app.js — Main controller (v2)
 * Auth: Firebase Authentication (Email + Password)
 * Database: Firebase Realtime Database
 *
 * Fixes applied:
 * 1. XSS: eliminated all innerHTML usage → textContent + DOM APIs
 * 2. Firebase errors: startMsgListener wrapped with try/catch + error toast
 * 3. UID-based groups compatibility (works with groups(1).js)
 * 4. Smart back navigation with managed history stack
 * 5. Typing indicator stops immediately on empty input
 * 6. Chat customization reapplies without full reload
 * 7. Loading screen waits for Firebase + basic data (synced with index(1).html)
 * 8. Lazy stories loading (deferred listener)
 * 9. Single message listener guard (prevents duplicates on rapid switching)
 * 10. Delivery / read receipt icons (✓ ✓✓)
 * 11. Auto-retry for failed messages with optimistic → confirmed flow
 * 12. Pagination-ready message area (hooked for future chat.js limit)
 * 13. deleteAccount loading state + confirmation
 */
(async function NabdaApp() {

  /* ── Firebase init with error handling ───────────────────── */
  try {
    await FB.init();
  } catch (err) {
    const errBox = document.getElementById('loading-error');
    const errMsg = document.getElementById('loading-error-msg');
    const spinner = document.getElementById('ls-spinner');
    if (spinner) spinner.style.display = 'none';
    if (errMsg) errMsg.textContent = 'تعذّر الاتصال: ' + (err.message || 'خطأ غير معروف');
    if (errBox) errBox.classList.add('show');
    return; // stop boot
  }

  if ('serviceWorker' in navigator)
    navigator.serviceWorker.register('service-worker.js').catch(() => {});

  /* ═══════════════════════════════════════════════════════════
     STATE
  ═══════════════════════════════════════════════════════════ */
  const S = {
    me:           Auth.getUser(),      // username (display)
    meUid:        null,                // Firebase UID (groups, security)
    screen:       null,
    activeId:     null,
    tab:          'chats',
    users:        {},                  // uid-keyed from DB
    usersByName:  {},                  // username → {uid,...}
    groups:       {},
    dmChats:      {},
    stories:      {},
    presence:     {},
    friendReqs:   {},                  // uid-keyed
    notifs:       {},                  // notifications/{me}
    unreadNotifs: 0,
    typingMap:    {},
    msgs:         [],
    panel:        false,
    groupEdit:    false,
    groupNewName: '',
    groupNewPhoto: null,
    storyPreview: null,
    viewImg:      null,
    dark:         UI.isDark(),
    prefs:        {},                  // تفضيلات المحادثات (تثبيت/كتم/أرشفة/إخفاء) — خاصة
    blocked:      {},                  // uids التي حظرتها
    showArchive:  false,
    groupMsgsCache: {},  // v2: { [gid]: rawMsgs } for unread counting
    _pinnedMsg:   null,  // v2: current pinned message
  };

  const _unsubs = [];
  const addU    = fn => _unsubs.push(fn);
  let _msgUnsub = null, _prevLen = 0, _lastSend = 0;
  const SPAM    = 1200;
  const _seenMsgIds = new Set();
  const _pendingMsgs = new Map(); // tempId → {payload, type, retries}
  const APP     = document.getElementById('app');

  // v2: حالة الرد والبحث والرسالة المثبّتة
  let _replyTo      = null;   // { id, text, sender, type } | null
  let _searchMode   = false;
  let _searchQuery  = '';
  let _pinnedUnsub  = null;   // unsub للـ pinned listener
  let _typingUnsub  = null;   // unsub لمؤشر الكتابة (للمحادثة المفتوحة فقط)
  let _showReplyBar = () => {}; // يُعاد تعريفها في buildChatInput

  /* ── Resolve UID helpers ─────────────────────────────────── */
  const _uidByName = name => S.usersByName[name]?.uid || null;
  const _nameByUid = uid  => S.users[uid]?.username || uid;
  const _userData  = name => S.usersByName[name] || null;

  // الخصوصية: تفضيلات المستخدم الحالي + من يُسمح له بمراسلتي (تطبيق على جهة العميل فقط)
  const _isFriendUid = uid => !!((S.users[S.meUid]?.friends||{})[uid] || (S.users[uid]?.friends||{})[S.meUid]);
  Chat.setPrivacyProviders(
    () => (S.users[S.meUid]?.prefs || {}),
    uid => {
      if (!uid || uid === S.meUid) return true;
      const wm = S.users[uid]?.prefs?.whoMessage;
      return wm !== 'friends' || _isFriendUid(uid);
    }
  );

  /* ═══════════════════════════════════════════════════════════
     COMPUTED
  ═══════════════════════════════════════════════════════════ */
  const myFriends   = () => {
    // friends node is keyed by uid in the new structure
    const meData = S.users[S.meUid] || S.usersByName[S.me] || {};
    const friends = meData.friends || {};
    return Object.keys(friends).map(uid => _nameByUid(uid)).filter(Boolean);
  };
  const pendingReqs = () => {
    if (!S.meUid || !S.friendReqs) return [];
    return Object.keys(S.friendReqs[S.meUid] || {});
  };
  const unread      = () => Chat.computeUnread(S.me, S.usersByName, S.dmChats);
  const unreadGrps  = () => Chat.computeUnreadGroups(myGroups(), S.groupMsgsCache || {}, S.meUid);
  const totalNotifs = () => pendingReqs().length + Object.values(unread()).reduce((a,b)=>a+b,0) + Object.values(unreadGrps()).reduce((a,b)=>a+b,0);
  const myGroups    = () => Groups.myGroups(S.groups, S.meUid);
  const th          = () => UI.getTheme();
  const chatId      = () => S.screen==='dm' ? Chat.dmKey(S.meUid, _uidByName(S.activeId)||S.activeId) : S.activeId;
  const ag          = () => S.screen==='group' ? S.groups[S.activeId] : null;
  // fws: يُرجع uids الأصدقاء الذين لديهم قصص (S.stories مفاتيحه uid)
  const fwsUids = () => {
    const friendUids = Object.keys(S.users[S.meUid]?.friends || {});
    return friendUids.filter(uid => S.stories[uid] && Object.keys(S.stories[uid]).length > 0);
  };
  const fws = () => fwsUids(); // للتوافق

  /* ═══════════════════════════════════════════════════════════
     NAVIGATION  (managed history stack)
  ═══════════════════════════════════════════════════════════ */
  const _historyStack = [];

  function go(screen, id=null) {
    if (S.screen==='dm'||S.screen==='group') Chat.clearTyping(S.me, chatId(), S.screen);
    stopMsgListener();
    _seenMsgIds.clear();
    _replyTo = null; // v2: reset reply state on navigation
    _searchMode = false;
    _searchQuery = '';

    // Push current to history before leaving
    if (S.screen && S.screen !== 'auth') {
      _historyStack.push({screen: S.screen, id: S.activeId});
      if (_historyStack.length > 30) _historyStack.shift();
    }

    S.screen=screen; S.activeId=id; S.panel=false; S.groupEdit=false; S.msgs=[];
    if (screen==='dm'&&id&&S.meUid) { const _t=_uidByName(id)||id; Chat.markRead(Chat.dmKey(S.meUid,_t), S.meUid); }
    if (screen==='group'&&id&&S.meUid) Chat.markGroupRead(id, S.meUid); // v2
    window.history.pushState({screen, id}, '', '');
    renderScreen();
    if (screen==='dm'&&id)    startMsgListener('dm',id);
    if (screen==='group'&&id) startMsgListener('group',id);
  }

  let _lastBackAt = 0;
  function goBack() {
    _lastBackAt = Date.now();
    const prev = _historyStack.pop();
    if (prev && prev.screen && prev.screen !== 'auth') {
      // Replay without pushing new history state
      const {screen, id} = prev;
      if (S.screen==='dm'||S.screen==='group') Chat.clearTyping(S.me, chatId(), S.screen);
      stopMsgListener();
      _seenMsgIds.clear();
      S.screen=screen; S.activeId=id; S.panel=false; S.groupEdit=false; S.msgs=[];
      renderScreen();
      if (screen==='dm'&&id)    startMsgListener('dm',id);
      if (screen==='group'&&id) startMsgListener('group',id);
    } else {
      go('home');
    }
  }

  window.addEventListener('popstate', () => {
    if (S.screen !== 'home' && S.screen !== 'auth') {
      goBack();
    }
  });

  function stopMsgListener() {
    if (_msgUnsub) { _msgUnsub(); _msgUnsub=null; _prevLen=0; }
    if (_pinnedUnsub) { _pinnedUnsub(); _pinnedUnsub=null; } // v2
    if (_typingUnsub) { _typingUnsub(); _typingUnsub=null; }
    S.typingMap = {};
  }

  /* ═══════════════════════════════════════════════════════════
     MESSAGE LISTENER — append only, error-safe, single listener
  ═══════════════════════════════════════════════════════════ */
  function startMsgListener(type, id) {
    stopMsgListener();
    _prevLen=0; _seenMsgIds.clear();
    const _msgSnap = new Map(); // id → JSON snapshot، لاكتشاف تغيّر رسالة موجودة (تفاعل/تعديل/حذف)
    const _tUid = _uidByName(id) || id;
    const path = type==='dm' ? `dmMsgs/${Chat.dmKey(S.meUid, _tUid)}` : `groupMsgs/${id}`;

    const cb = msgs => {
      try {
        const _hAt = (_pref(type,id).hiddenAt)||0;
        if (_hAt && msgs) msgs = msgs.filter(m => (m.ts||0) > _hAt);
        if (!msgs || !msgs.length) { S.msgs=[]; _msgSnap.clear(); renderMsgs(); return; }
        const isFirst = _prevLen===0;
        if (isFirst) {
          S.msgs=msgs;
          msgs.forEach(m=>{_seenMsgIds.add(m.id); _msgSnap.set(m.id, JSON.stringify(m));});
          _prevLen=msgs.length; renderMsgs();
        } else {
          msgs.forEach(m=>{
            const snap = JSON.stringify(m);
            if (!_seenMsgIds.has(m.id)) {
              // رسالة جديدة تماماً
              _seenMsgIds.add(m.id); _msgSnap.set(m.id, snap);
              if (m.sender!==S.meUid && m.sender!==S.me) {
                if(!_pref(type,id).muted){ UI.playSound('recv');
                UI.showNotif(type==='dm'?`رسالة من ${_nameByUid(m.sender)||m.sender}`:`رسالة في مجموعة`, m.type==='text'?m.text:'🖼 وسائط', ()=>window.focus()); }
                appendMsg(m);
              } else {
                replaceOptimistic(m);
              }
            } else if (_msgSnap.get(m.id) !== snap) {
              // رسالة موجودة اتغيّر محتواها (تفاعل/تعديل/حذف/تثبيت) — حدّث فقاعتها فقط
              _msgSnap.set(m.id, snap);
              _patchBubble(m);
            }
          });
          _prevLen=msgs.length; S.msgs=msgs;
        }
        if (type==='dm') {
          const _t=_uidByName(id)||id, _k=Chat.dmKey(S.meUid,_t);
          // المحادثة مفتوحة وظاهرة = قُرئت؛ وإلا وصلت فقط (تظهر ✓✓ عند المرسل)
          if (document.visibilityState==='visible') Chat.markMsgsRead(_k, msgs, S.meUid);
          else { Chat.markDelivered(_k, msgs, S.meUid); Chat.markRead(_k, S.meUid); }
        }
      } catch (err) {
        console.error('[startMsgListener] error:', err);
        UI.toast('خطأ في تحديث الرسائل','error');
      }
    };

    try {
      const _tUid2=_uidByName(id)||id; _msgUnsub = type==='dm' ? Chat.listenDM(S.meUid,_tUid2,cb) : Chat.listenGroup(id,cb);
      // v2: استمع للرسالة المثبّتة
      const _chatPath = type==='dm' ? `dmMsgs/${Chat.dmKey(S.meUid,_tUid2)}` : `groupMsgs/${id}`;
      _pinnedUnsub = Chat.listenPinned(_chatPath, pinned => {
        S._pinnedMsg = pinned || null;
        _refreshPinnedBar();
      });
      // مؤشر الكتابة: نستمع لمسار المحادثة المفتوحة فقط (بدل شجرة typing كاملة لكل المحادثات)
      const _tKey  = type==='dm' ? Chat.dmKey(S.meUid, _uidByName(id)||id) : id;
      const _tPath = type==='dm' ? `typing/dm/${_tKey}` : `typing/group/${id}`;
      _typingUnsub = FB.on(_tPath, v => {
        S.typingMap = type==='dm' ? { dm: { [_tKey]: v || {} } } : { group: { [_tKey]: v || {} } };
        refreshTyping(); refreshTopSub();
      });
    } catch (err) {
      console.error('[startMsgListener] setup error:', err);
      UI.toast('تعذّر فتح المحادثة','error');
    }
  }

  function replaceOptimistic(serverMsg) {
    if (!serverMsg._tempId) return;
    const c = document.getElementById('msg-container'); if (!c) return;
    const opt = c.querySelector(`[data-temp-id="${serverMsg._tempId}"]`);
    if (opt) {
      const bubble = buildBubble(serverMsg);
      c.replaceChild(bubble, opt);
      _pendingMsgs.delete(serverMsg._tempId);
    }
  }

  // v6: تحديث فقاعة رسالة واحدة فقط (تفاعل/تعديل/حذف/تثبيت) بدون rebuild كامل للمحادثة
  function _patchBubble(m) {
    const c = document.getElementById('msg-container'); if (!c) return;
    const old = c.querySelector(`[data-row-id="${m.id}"]`);
    if (!old) return; // مش ظاهرة حالياً (مثلاً قبل pagination) — تجاهل بأمان
    const fresh = buildBubble(m);
    c.replaceChild(fresh, old);
  }

  /* ═══════════════════════════════════════════════════════════
     GLOBAL DATA LISTENERS  (core first, stories deferred)
  ═══════════════════════════════════════════════════════════ */
  let _storiesTimer = null;

  function startDataListeners() {
    // مراقبة حالة الاتصال
    addU(FB.onConnectionChange(isOnline => UI.setConnectionStatus(isOnline)));
    addU(FB.on(`users/${S.meUid}`, v=>{
      // تنظيف مرة واحدة: إزالة الإيميل القديم من البروفايل العام (كان مقروءاً لكل المستخدمين)
      if (v && v.email !== undefined && !S._emailPurged) { S._emailPurged = true; try { FB.del(`users/${S.meUid}/email`).catch(()=>{}); } catch(e){} }
      S.users[S.meUid]=v||{}; rebuildUserMaps(); refreshDyn();
      _startDmListeners(); _startFriendReqListener(); _startNotifListener(); _startStoryListeners();
      _startGroupListeners(); _startFriendProfileListeners(); _pruneFriendListeners();
    }));
    // groups: لا نقرأ /groups كاملاً — بدلاً نستمع per-group في _startGroupListeners()
    // يُستدعى من rebuildUserMaps بعد تحميل users
    addU(FB.on(`userData/${S.meUid}/chatPrefs`, v=>{S.prefs=v||{}; refreshDyn();}));
    addU(FB.on(`blockedUsers/${S.meUid}`, v=>{
      const was=JSON.stringify(Object.keys(S.blocked||{}).sort());
      S.blocked=v||{};
      if(S.screen==='dm'&&was!==JSON.stringify(Object.keys(S.blocked).sort())&&_dmReady)_rerenderChat();
      else refreshDyn();
    }));
    // presence: لكل مستخدم نحتاجه فقط (أصدقاء/أعضاء مجموعات/طلبات) + أنا — بدل تحميل كل المستخدمين
    _ensurePresenceListener(S.meUid);
    // Periodic expired-story cleanup every 5 minutes
    if (!_storiesTimer) _storiesTimer = setInterval(()=>Stories.cleanExpired(S.stories, S.meUid), 300000);
  }

  // ── Profile listeners — بس لمين محتاجينه فعلاً (أصدقاء/أعضاء مجموعات/طلبات) ──
  const _profileUnsubs = {};
  const _presenceUnsubs = {};
  function _ensurePresenceListener(uid) {
    if (!uid || _presenceUnsubs[uid]) return;
    _presenceUnsubs[uid] = FB.on(`presence/${uid}`, v => {
      if (v) S.presence[uid] = v; else delete S.presence[uid];
      refreshPresence();
    }, () => { delete _presenceUnsubs[uid]; });
    addU(() => { if (_presenceUnsubs[uid]) { _presenceUnsubs[uid](); delete _presenceUnsubs[uid]; } });
  }
  function _ensureProfileListener(uid) {
    if (!uid || uid === S.meUid) return;
    _ensurePresenceListener(uid);
    if (_profileUnsubs[uid]) return;
    _profileUnsubs[uid] = FB.on(`users/${uid}`, v => {
      if (v) S.users[uid] = v; else delete S.users[uid];
      rebuildUserMaps(); refreshDyn();
    }, () => { delete _profileUnsubs[uid]; });
    addU(() => { if (_profileUnsubs[uid]) { _profileUnsubs[uid](); delete _profileUnsubs[uid]; } });
  }
  function _startFriendProfileListeners() {
    Object.keys(S.users[S.meUid]?.friends || {}).forEach(_ensureProfileListener);
  }
  // بحث/تحقق يوزر واحد بدون تحميل الداتابيز كلها (للدردشة الجديدة/البحث)
  async function _resolveUserByUsername(username) {
    if (!username) return null;
    if (S.usersByName[username]) return S.usersByName[username];
    const uid = await Auth.uidFromUsername(username);
    if (!uid) return null;
    const profile = await FB.get(`users/${uid}`);
    if (!profile) return null;
    S.users[uid] = profile; rebuildUserMaps(); _ensureProfileListener(uid);
    return S.usersByName[username];
  }

  // ── DM listeners — واحد لكل صديق (Rules: $dmKey.contains(auth.uid)) ──
  const _dmUnsubs = {};
  const _dmRaw = {}, _dmSeq = {};
  // يفك تشفير آخر رسائل المحادثة (للمعاينة وعدّاد غير المقروء) بترتيب آمن ضد التأخّر
  function _applyDmChat(key) {
    const my = (_dmSeq[key] = (_dmSeq[key] || 0) + 1);
    const raw = _dmRaw[key];
    const done = out => {
      if (my !== _dmSeq[key]) return;
      if (out) S.dmChats[key] = out; else delete S.dmChats[key];
      refreshDyn();
    };
    if (!raw || !window.E2E) return done(raw);
    E2E.decryptMap(key, raw).then(done).catch(() => done(raw));
  }
  function _dmRedecryptAll() { Object.keys(_dmRaw).forEach(_applyDmChat); }
  function _startDmListeners() {
    if (!S.meUid) return;
    const friendUids = Object.keys(S.users[S.meUid]?.friends || {});
    friendUids.forEach(fUid => {
      const key = [S.meUid, fUid].sort().join('_');
      if (_dmUnsubs[key]) return;
      _dmUnsubs[key] = FB.onLimit(`dmMsgs/${key}`, 40, v => { _dmRaw[key] = v || null; _applyDmChat(key); });
      // آخر قراءة محفوظة بالسيرفر (وإلا يرجع عدّاد غير المقروء بعد كل إعادة فتح)
      const rKey = '_rr_' + key;
      if (!_dmUnsubs[rKey]) {
        _dmUnsubs[rKey] = FB.on(`readReceipts/${key}/${S.meUid}`, ts => {
          Chat.updateReadCache(key, ts || 0); refreshBadges(); refreshDyn();
        });
        addU(() => { if (_dmUnsubs[rKey]) { _dmUnsubs[rKey](); delete _dmUnsubs[rKey]; } });
      }
      addU(() => { if (_dmUnsubs[key]) { _dmUnsubs[key](); delete _dmUnsubs[key]; } });
    });
  }

  // ── friendRequests listener — uid فقط (Rules: $targetUid === auth.uid) ──
  let _friendReqUnsub = null;
  /* ═══════════════════════════════════════════════════════════
     الإشعارات داخل التطبيق: شارة على الجرس + لوحة (DOM فقط، بلا innerHTML)
     البيانات: notifications/{me}/{nid} = { type, ts, read, fromUid|byUid, gid?, gname? }
  ═══════════════════════════════════════════════════════════ */
  let _notifUnsub = null, _notifPanel = null, _notifDocHandler = null;
  function _startNotifListener() {
    if (!S.meUid || _notifUnsub) return;
    _notifUnsub = FB.on(`notifications/${S.meUid}`, v => {
      S.notifs = v || {};
      S.unreadNotifs = Object.values(S.notifs).filter(n => n && !n.read).length;
      _updateNotifBadge();
      if (_notifPanel) _fillNotifPanel();
    });
    addU(() => { if (_notifUnsub) { _notifUnsub(); _notifUnsub = null; } S.notifs = {}; S.unreadNotifs = 0; _closeNotifPanel(); });
  }
  function _updateNotifBadge(el) {
    const btn = el || document.getElementById('notif-bell'); if (!btn) return;
    let b = btn.querySelector('.notif-badge'); const n = S.unreadNotifs || 0;
    if (n <= 0) { if (b) b.remove(); return; }
    if (!b) {
      b = UI.el('span', 'position:absolute;top:-2px;right:-2px;min-width:16px;height:16px;padding:0 3px;background:#ef4444;color:#fff;border-radius:8px;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;pointer-events:none');
      b.className = 'notif-badge'; btn.appendChild(b);
    }
    b.textContent = n > 99 ? '99+' : String(n);
  }
  function _notifText(n) {
    const nm = uid => (S.users[uid] && S.users[uid].username) || 'مستخدم';
    if (n.type === 'friend_request') return `📨 طلب صداقة من ${nm(n.fromUid)}`;
    if (n.type === 'friend_accept')  return `✅ قَبِل ${nm(n.fromUid)} طلب صداقتك`;
    if (n.type === 'group_add')      return `👥 أضافك ${nm(n.byUid)} إلى «${n.gname || 'مجموعة'}»`;
    return '🔔 إشعار';
  }
  function _notifAgo(ts) {
    const d = Date.now() - (ts || 0);
    if (d < 60000) return 'الآن';
    if (d < 3600000) return `قبل ${Math.floor(d / 60000)} د`;
    if (d < 86400000) return `قبل ${Math.floor(d / 3600000)} س`;
    return new Date(ts).toLocaleDateString('ar');
  }
  function _markNotifsRead(ids) {
    const u = {}; ids.forEach(id => { u[`notifications/${S.meUid}/${id}/read`] = true; });
    if (Object.keys(u).length) FB.upd('/', u).catch(() => {});
  }
  function _closeNotifPanel() {
    if (_notifPanel) { _notifPanel.remove(); _notifPanel = null; }
    if (_notifDocHandler) { document.removeEventListener('click', _notifDocHandler); _notifDocHandler = null; }
  }
  function _fillNotifPanel() {
    if (!_notifPanel) return;
    const t = th(); _notifPanel.textContent = '';
    const hdr = UI.el('div', `display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid ${t.border};font-weight:700;font-size:13px;color:${t.text}`);
    const title = UI.el('span', ''); title.textContent = 'الإشعارات';
    const all = UI.el('button', 'border:none;background:transparent;color:var(--accent);font-size:12px;font-weight:700;cursor:pointer;font-family:inherit');
    all.textContent = 'تعليم الكل كمقروء';
    all.addEventListener('click', () => _markNotifsRead(Object.keys(S.notifs).filter(k => S.notifs[k] && !S.notifs[k].read)));
    hdr.appendChild(title); hdr.appendChild(all); _notifPanel.appendChild(hdr);
    const list = UI.el('div', 'padding:6px 8px');
    const items = Object.entries(S.notifs).filter(([, n]) => n).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
    if (!items.length) { const e = UI.el('div', `padding:24px;text-align:center;color:${t.text3};font-size:13px`); e.textContent = 'لا إشعارات حالياً'; list.appendChild(e); }
    items.forEach(([nid, n]) => {
      const row = UI.el('div', `display:flex;align-items:center;gap:10px;padding:9px 8px;border-radius:10px;margin-bottom:4px;background:${n.read ? 'transparent' : 'rgba(59,158,240,.1)'}`);
      const body = UI.el('div', 'flex:1;min-width:0;cursor:pointer');
      const tx = UI.el('div', `font-size:13px;color:${t.text};line-height:1.5`); tx.textContent = _notifText(n);
      const tm = UI.el('div', `font-size:11px;color:${t.text3};margin-top:2px`); tm.textContent = _notifAgo(n.ts);
      body.appendChild(tx); body.appendChild(tm);
      body.addEventListener('click', () => { if (!n.read) _markNotifsRead([nid]); });
      const del = UI.el('button', `border:none;background:transparent;color:${t.text3};font-size:15px;cursor:pointer;padding:2px 6px;flex-shrink:0;font-family:inherit`);
      del.textContent = '✕'; del.setAttribute('aria-label', 'حذف');
      del.addEventListener('click', () => { FB.del(`notifications/${S.meUid}/${nid}`).catch(() => {}); });
      row.appendChild(body); row.appendChild(del); list.appendChild(row);
    });
    _notifPanel.appendChild(list);
  }
  function _toggleNotifPanel() {
    if (_notifPanel) { _closeNotifPanel(); return; }
    const t = th();
    _notifPanel = UI.el('div', `position:fixed;top:56px;inset-inline-end:10px;width:min(320px,calc(100vw - 20px));max-height:70vh;overflow-y:auto;background:${t.card};border:1px solid ${t.border};border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.25);z-index:9999;direction:rtl`);
    _fillNotifPanel(); document.body.appendChild(_notifPanel);
    _notifDocHandler = e => { if (_notifPanel && !_notifPanel.contains(e.target) && !e.target.closest('#notif-bell')) _closeNotifPanel(); };
    setTimeout(() => { if (_notifDocHandler) document.addEventListener('click', _notifDocHandler); }, 0);
  }

  function _startFriendReqListener() {
    if (!S.meUid || _friendReqUnsub) return;
    _friendReqUnsub = FB.on(`friendRequests/${S.meUid}`, v => {
      S.friendReqs = { [S.meUid]: v || {} };
      Object.keys(v || {}).forEach(_ensureProfileListener);
      refreshDyn();
    });
    addU(() => { if (_friendReqUnsub) { _friendReqUnsub(); _friendReqUnsub = null; } });
  }

  // ── Stories listeners — واحد لكل uid (نفسك + أصدقائك) ──
  const _storyUnsubs = {};
  function _startStoryListeners() {
    if (!S.meUid) return;
    const uids = [S.meUid, ...Object.keys(S.users[S.meUid]?.friends || {})];
    uids.forEach(uid => {
      if (_storyUnsubs[uid]) return;
      _storyUnsubs[uid] = FB.on(`stories/${uid}`, v => {
        if (v) S.stories[uid] = v; else delete S.stories[uid];
        refreshDyn();
      });
      addU(() => { if (_storyUnsubs[uid]) { _storyUnsubs[uid](); delete _storyUnsubs[uid]; } });
    });
  }

  // عند إزالة صديق: ألغِ مستمعي محادثته وقصصه (كانت تبقى شغّالة طوال الجلسة)
  function _pruneFriendListeners() {
    const fr = Object.keys(S.users[S.meUid]?.friends || {});
    Object.keys(_dmUnsubs).forEach(k => {
      const base = k.startsWith('_rr_') ? k.slice(4) : k;
      if (fr.some(f => base.includes(f))) return;
      try { _dmUnsubs[k](); } catch (e) {}
      delete _dmUnsubs[k]; delete _dmRaw[base];
    });
    Object.keys(_storyUnsubs).forEach(uid => {
      if (uid === S.meUid || fr.includes(uid)) return;
      try { _storyUnsubs[uid](); } catch (e) {}
      delete _storyUnsubs[uid]; delete S.stories[uid];
    });
  }

  // ── Groups listeners — استمع لـ users/{meUid}/groups ثم لكل مجموعة ──
  const _groupUnsubs = {};
  let _groupIndexUnsub = null;

  function _openGroupListener(gid) {
    if (!gid || _groupUnsubs[gid]) return;
    _groupUnsubs[gid] = FB.on(`groups/${gid}`, v => {
      if (v) { S.groups[gid] = v; Object.keys(v.members || {}).forEach(_ensureProfileListener); }
      else delete S.groups[gid];
      refreshDyn();
    });
    addU(() => { if (_groupUnsubs[gid]) { _groupUnsubs[gid](); delete _groupUnsubs[gid]; } });

    const _gRrKey = `_grr_${gid}`;
    if (!_groupUnsubs[_gRrKey] && S.meUid) {
      _groupUnsubs[_gRrKey] = FB.on(`readReceipts/group_${gid}/${S.meUid}`, ts => {
        Chat.updateGroupReadCache(gid, ts || 0); refreshBadges(); refreshDyn();
      });
      addU(() => { if (_groupUnsubs[_gRrKey]) { _groupUnsubs[_gRrKey](); delete _groupUnsubs[_gRrKey]; } });
    }

    // v2: استمع لآخر 60 رسالة للمجموعة لحساب الغير مقروء
    const _gMsgKey = `_gmsg_${gid}`;
    if (!_groupUnsubs[_gMsgKey]) {
      _groupUnsubs[_gMsgKey] = FB.onLimit(`groupMsgs/${gid}`, 60, v => {
        if (v) S.groupMsgsCache[gid] = v; else delete S.groupMsgsCache[gid];
        refreshBadges();
      });
      addU(() => { if (_groupUnsubs[_gMsgKey]) { _groupUnsubs[_gMsgKey](); delete _groupUnsubs[_gMsgKey]; } });
    }
  }

  function _startGroupListeners() {
    if (!S.meUid || _groupIndexUnsub) return;
    // استمع لقائمة مجموعات المستخدم في users/{meUid}/groups
    _groupIndexUnsub = FB.on(`users/${S.meUid}/groups`, v => {
      const gids = Object.keys(v || {});
      gids.forEach(gid => _openGroupListener(gid));
      // احذف المجموعات التي خرج منها
      Object.keys(_groupUnsubs).forEach(k => {
        if (k.startsWith('_')) return;            // مفاتيح مساعدة (_gmsg_/_grr_) تُنظَّف مع مجموعتها
        if (!v || !v[k]) {
          [k, `_gmsg_${k}`, `_grr_${k}`].forEach(kk => {
            if (_groupUnsubs[kk]) { _groupUnsubs[kk](); delete _groupUnsubs[kk]; }
          });
          delete S.groups[k]; delete S.groupMsgsCache[k];
        }
      });
      refreshDyn();
    });
    addU(() => { if (_groupIndexUnsub) { _groupIndexUnsub(); _groupIndexUnsub = null; } });
  }

  function rebuildUserMaps() {
    S.usersByName = {};
    Object.entries(S.users || {}).forEach(([uid, data]) => {
      if (data && data.username) S.usersByName[data.username] = { uid, ...data };
    });
    // Sync S.meUid from Firebase Auth or user map
    if (!S.meUid) {
      S.meUid = FB.authCurrentUser()?.uid || null;
    }
    if (S.me && !S.meUid) {
      S.meUid = S.usersByName[S.me]?.uid || null;
    }
  }

  /* ═══════════════════════════════════════════════════════════
     PARTIAL REFRESH
  ═══════════════════════════════════════════════════════════ */
  function refreshDyn() {
    if (S.screen==='home') { refreshChatList(); refreshStoryRow(); refreshBadges(); }
    else refreshTopSub();
  }
  function refreshPresence() {
    document.querySelectorAll('[data-ou]').forEach(d=>{
      const name = d.dataset.ou;
      const uid  = _uidByName(name);
      const online = uid ? Chat.isOnline(S.presence, uid) : false;
      d.style.background = online ? '#22c55e' : 'transparent';
    });
    if (S.screen==='dm'&&S.activeId) refreshTopSub();
  }
  function refreshTyping() {
    const tu=Chat.getTypingUsers(S.typingMap,S.me,chatId(),S.screen);
    const box=document.getElementById('typing-row'); if(!box) return;
    if (tu.length>0) {
      box.style.display='flex'; box.innerHTML='';
      tu.slice(0,2).forEach(u=>{
        const name = _nameByUid(u) || u;
        const data = S.users[u] || S.usersByName[name];
        box.appendChild(UI.makeAvatar(data,22));
      });
      const bub=UI.el('div',`background:${th().bubble};border-radius:12px 12px 12px 4px;padding:8px 12px`);
      const dots=UI.el('div','display:flex;align-items:center;gap:2px'); dots.className='typing';
      [0,1,2].forEach(()=>{const s=document.createElement('span');s.style.background=th().text2;dots.appendChild(s);});
      bub.appendChild(dots); box.appendChild(bub);
    } else box.style.display='none';
  }
  function refreshTopSub() {
    const sub=document.getElementById('topbar-sub'); if(!sub||!S.activeId) return;
    const tu=Chat.getTypingUsers(S.typingMap,S.me,chatId(),S.screen);
    if (S.screen==='dm') {
      const targetUid = _uidByName(S.activeId);
      sub.textContent = tu.includes(targetUid)||tu.includes(S.activeId) ? '✍️ يكتب...' : Chat.lastSeenText(S.presence, targetUid || S.activeId);
      sub.style.color = Chat.isOnline(S.presence, targetUid || S.activeId) ? '#22c55e' : th().text3;
    }
    else if (S.screen==='group') {
      const g=ag(); if(!g) return;
      const memCount = Groups.getMembers(g).length;
      sub.textContent = `${memCount} عضو${tu.length>0?' · ✍️ يكتب...':''}`;
    }
  }
  function refreshBadges() {
    const b=document.getElementById('topbar-badge'); if(b){const n=totalNotifs();b.textContent=n;b.style.display=n>0?'flex':'none';}
    const e=document.getElementById('tab-unread-extra'); if(e){const n=(Object.values(unread()).reduce((a,b)=>a+b,0)+Object.values(unreadGrps()).reduce((a,b)=>a+b,0));e.textContent=n>0?` (${n})`:'';}
  }
  function refreshChatList(){const c=document.getElementById('home-content');if(c&&S.screen==='home')renderTabContent(c);}
  function refreshStoryRow(){const r=document.getElementById('story-inner');if(r)buildStoryInner(r);}

  /* ═══════════════════════════════════════════════════════════
     RENDER ROUTER
  ═══════════════════════════════════════════════════════════ */
  function renderScreen() {
    UI.applyTheme();
    let th2=document.getElementById('toast-host');
    APP.innerHTML='';
    if(!th2){th2=document.createElement('div');th2.id='toast-host';}
    APP.appendChild(th2);
    APP.style.cssText=`height:100vh;display:flex;flex-direction:column;background:${th().bg};color:${th().text};direction:rtl;overflow:hidden`;
    try { _renderSwitch(); }
    catch (err) {
      console.error('[render]', S.screen, err);
      APP.innerHTML='';
      const box=UI.el('div',`flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center;color:${th().text2}`);
      const t=UI.el('div','font-size:15px;font-weight:700');t.textContent='حدث خطأ أثناء عرض الصفحة';
      const b=UI.el('button','padding:10px 20px;border:none;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-family:inherit;font-weight:700;cursor:pointer');b.textContent='العودة للرئيسية';
      b.addEventListener('click',()=>go(S.me?'home':'auth'));
      box.appendChild(t);box.appendChild(b);APP.appendChild(box);
    }
  }

  function _renderSwitch(){
    switch(S.screen){
      case 'auth':        return renderAuth();
      case 'home':        return renderHome();
      case 'dm':          return renderDM();
      case 'group':       return renderGroup();
      case 'profile':     return renderProfile();
      case 'userProfile': return renderUserProfile();
      case 'friends':     return renderFriends();
      case 'newGroup':    return renderNewGroup();
      case 'join':        return renderJoin();
      default:            return renderAuth();
    }
  }

  /* ═══════════════════════════════════════════════════════════
     AUTH SCREEN — Email + Password + Username  (no innerHTML)
  ═══════════════════════════════════════════════════════════ */
  function renderAuth() {
    APP.style.cssText=`min-height:100vh;display:flex;align-items:center;justify-content:center;background:${UI.isDark()?'linear-gradient(160deg,#0a0a14,#0d0d1a)':'linear-gradient(160deg,#f0f4ff,#e8eeff)'};padding:20px;direction:rtl`;
    const card=UI.el('div',`background:${th().card};border:1px solid ${th().border};border-radius:24px;padding:40px 28px;width:100%;max-width:360px;box-shadow:0 20px 60px rgba(0,0,0,.15)`);

    // Logo (DOM-safe)
    const logo=UI.el('div','text-align:center;margin-bottom:28px');
    const logoIcon=UI.el('div','width:72px;height:72px;background:linear-gradient(135deg,var(--accent),var(--accent2));border-radius:20px;margin:0 auto 14px;display:flex;align-items:center;justify-content:center;font-size:36px;box-shadow:0 8px 24px rgba(59,158,240,.4)');
    logoIcon.textContent='💬';
    const logoTitle=UI.el('h1','font-size:26px;font-weight:800;letter-spacing:-1px');
    logoTitle.style.color=th().text; logoTitle.textContent='نبضة';
    const logoSub=UI.el('p','font-size:13px;margin-top:4px');
    logoSub.style.color=th().text2; logoSub.textContent='تواصل مع أصدقائك بسهولة';
    logo.appendChild(logoIcon); logo.appendChild(logoTitle); logo.appendChild(logoSub);
    card.appendChild(logo);

    // Mode tabs
    let mode='login';
    const tabRow=UI.el('div',`display:flex;gap:6px;margin-bottom:22px;background:${th().bg};border-radius:14px;padding:4px`);
    const updTabs=()=>tabRow.querySelectorAll('.mt').forEach(b=>{b.style.background=mode===b.dataset.m?'linear-gradient(135deg,var(--accent),var(--accent2))':'transparent';b.style.color=mode===b.dataset.m?'#fff':th().text2;});
    ['login','register'].forEach(m=>{
      const b=UI.el('button','flex:1;padding:10px;border:none;border-radius:11px;cursor:pointer;font-family:inherit;font-weight:700;font-size:13px;transition:all .2s');
      b.className='mt'; b.dataset.m=m; b.textContent=m==='login'?'دخول':'حساب جديد';
      b.addEventListener('click',()=>{
        mode=m; errBox.style.display='none'; updTabs();
        submitBtn.textContent=mode==='login'?'دخول ←':'إنشاء الحساب ←';
        unameRow.style.display=mode==='register'?'block':'none';
        consentRow.style.display=mode==='register'?'flex':'none';
        resetRow.style.display=mode==='login'?'flex':'none';
      });
      tabRow.appendChild(b);
    });
    updTabs(); card.appendChild(tabRow);

    // Input style
    const iCss=`width:100%;padding:11px 14px;border-radius:12px;border:1.5px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:14px;font-family:inherit;direction:rtl;box-sizing:border-box;margin-bottom:12px`;

    // Username (register only)
    const unameRow=UI.el('div','display:none');
    const unameInp=UI.el('input',iCss); unameInp.placeholder='اسم المستخدم (بدون مسافات)'; unameInp.autocomplete='username';
    unameRow.appendChild(unameInp); card.appendChild(unameRow);

    // Consent (register only) — required checkbox linking to Terms & Privacy
    const consentRow=UI.el('div','display:none;align-items:flex-start;gap:8px;margin-bottom:14px');
    const consentCheck=document.createElement('input'); consentCheck.type='checkbox'; consentCheck.id='consent-chk';
    consentCheck.style.cssText='margin-top:2px;flex-shrink:0;cursor:pointer;width:16px;height:16px';
    const consentLabel=document.createElement('label'); consentLabel.htmlFor='consent-chk';
    consentLabel.style.cssText=`cursor:pointer;line-height:1.5;font-size:12px;color:${th().text2}`;
    consentLabel.appendChild(document.createTextNode('أوافق على '));
    const termsLink=document.createElement('a'); termsLink.href='terms.html'; termsLink.target='_blank'; termsLink.rel='noopener noreferrer'; termsLink.textContent='الشروط والأحكام'; termsLink.style.color='var(--accent)'; termsLink.style.fontWeight='700';
    consentLabel.appendChild(termsLink);
    consentLabel.appendChild(document.createTextNode(' و'));
    const privLink=document.createElement('a'); privLink.href='privacy.html'; privLink.target='_blank'; privLink.rel='noopener noreferrer'; privLink.textContent='سياسة الخصوصية'; privLink.style.color='var(--accent)'; privLink.style.fontWeight='700';
    consentLabel.appendChild(privLink);
    consentRow.appendChild(consentCheck); consentRow.appendChild(consentLabel);
    card.appendChild(consentRow);

    // Email
    const emailInp=UI.el('input',iCss); emailInp.placeholder='البريد الإلكتروني'; emailInp.type='email'; emailInp.autocomplete='email';
    card.appendChild(emailInp);

    // Password
    const passInp=UI.el('input',iCss); passInp.placeholder='كلمة المرور'; passInp.type='password'; passInp.autocomplete='current-password';
    card.appendChild(passInp);

    // Error box
    const errBox=UI.el('div','padding:9px 14px;background:#fee2e2;border-radius:10px;color:#ef4444;font-size:13px;text-align:center;font-weight:600;margin-bottom:12px;display:none');
    card.appendChild(errBox);

    // Submit button
    let loading=false;
    const submitBtn=UI.el('button','width:100%;padding:13px;border:none;border-radius:14px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-size:15px;font-weight:700;font-family:inherit;box-shadow:0 4px 14px rgba(59,158,240,.4);cursor:pointer');
    submitBtn.textContent='دخول ←';

    async function doSubmit() {
      if (loading) return;
      if (mode==='register' && !consentCheck.checked) {
        errBox.textContent='يجب الموافقة على الشروط وسياسة الخصوصية للمتابعة';
        errBox.style.display='block';
        return;
      }
      loading=true; submitBtn.innerHTML=''; submitBtn.appendChild(UI.spinner(18));
      let res;
      if (mode==='login') {
        res = await Auth.login(emailInp.value, passInp.value);
      } else {
        res = await Auth.register(unameInp.value, emailInp.value, passInp.value);
      }
      loading=false; submitBtn.textContent=mode==='login'?'دخول ←':'إنشاء الحساب ←';
      if (res.error) { errBox.textContent=res.error; errBox.style.display='block'; return; }
      errBox.style.display='none';
      S.me=res.username;
      S.meUid=res.uid || FB.authCurrentUser()?.uid || null;
      Chat.goOnline(S.meUid); UI.requestNotifPerm(); startDataListeners(); go('home');
      _handleDeepLink();
    }

    submitBtn.addEventListener('click', doSubmit);
    [unameInp,emailInp,passInp].forEach(i=>i.addEventListener('keydown',e=>{if(e.key==='Enter')doSubmit();}));
    card.appendChild(submitBtn);

    // Forgot password row (login only)
    const resetRow=UI.el('div','display:flex;justify-content:center;margin-top:12px');
    const resetBtn=UI.el('button',`background:none;border:none;cursor:pointer;color:var(--accent);font-size:13px;font-family:inherit;text-decoration:underline`);
    resetBtn.textContent='نسيت كلمة المرور؟';
    resetBtn.addEventListener('click', async()=>{
      const email=emailInp.value.trim();
      if (!email) { errBox.textContent='أدخل بريدك الإلكتروني أولاً'; errBox.style.display='block'; return; }
      const res=await Auth.resetPassword(email);
      if (res.error) { errBox.textContent=res.error; errBox.style.display='block'; }
      else { errBox.style.cssText='padding:9px 14px;background:#f0fdf4;border-radius:10px;color:#22c55e;font-size:13px;text-align:center;font-weight:600;margin-bottom:12px;display:block'; errBox.textContent='✅ تم إرسال رابط إعادة التعيين إلى بريدك'; }
    });
    resetRow.appendChild(resetBtn); card.appendChild(resetRow);
    APP.appendChild(card);
  }

  /* ═══════════════════════════════════════════════════════════
     HOME
  ═══════════════════════════════════════════════════════════ */
  let _storyWrap=null;
  function renderHome(){
    const stWrap=UI.el('div',`padding:10px 14px 8px;border-bottom:1px solid ${th().border};flex-shrink:0;background:${th().topbar}`);
    const stInner=UI.el('div','display:flex;gap:12px;overflow-x:auto;padding-bottom:2px;scrollbar-width:none');
    stWrap.id='nb-stories';
    stInner.id='story-inner'; buildStoryInner(stInner); stWrap.appendChild(stInner); _storyWrap=stWrap;
    APP.appendChild(buildHomeTabs());
    const content=UI.el('div','flex:1;overflow-y:auto;padding:12px;-webkit-overflow-scrolling:touch');
    content.id='home-content'; APP.appendChild(content); renderTabContent(content);
  }

  function buildHomeTopbar(){
    const bar=UI.el('div',`display:flex;align-items:center;gap:10px;padding:10px 14px;background:${th().topbar};border-bottom:1px solid ${th().border};flex-shrink:0;box-shadow:0 1px 6px rgba(0,0,0,.06)`);
    const avWrap=UI.el('div','position:relative;cursor:pointer');
    avWrap.appendChild(UI.makeAvatar(_userData(S.me),36,{online:true}));
    const badge=UI.el('div','position:absolute;top:-4px;left:-4px;background:#ef4444;color:#fff;font-size:9px;font-weight:700;border-radius:50%;min-width:16px;height:16px;display:none;align-items:center;justify-content:center;padding:0 2px');
    badge.id='topbar-badge'; const n=totalNotifs(); badge.textContent=n; badge.style.display=n>0?'flex':'none';
    avWrap.appendChild(badge); avWrap.addEventListener('click',()=>go('profile')); bar.appendChild(avWrap);
    const title=UI.el('div','flex:1;min-width:0');
    const titleSpan=UI.el('span','font-weight:800;font-size:17px;letter-spacing:-0.5px');
    titleSpan.style.color=UI.isDark()?'var(--accent)':'var(--accent)'; titleSpan.textContent='نبضة';
    const meSpan=UI.el('span','font-size:11px;margin-right:6px');
    meSpan.style.color=th().text3; meSpan.textContent=`● ${S.me}`;
    title.appendChild(titleSpan); title.appendChild(meSpan);
    bar.appendChild(title);
    const fBtn=UI.el('button','background:none;border:none;cursor:pointer;font-size:20px;padding:4px;position:relative'); fBtn.textContent='👥'; fBtn.setAttribute('aria-label','الأصدقاء');
    const pr=pendingReqs(); if(pr.length){const d=UI.el('div','position:absolute;top:0;right:0;background:#ef4444;color:#fff;font-size:8px;font-weight:700;border-radius:50%;width:14px;height:14px;display:flex;align-items:center;justify-content:center');d.textContent=pr.length;fBtn.appendChild(d);}
    fBtn.addEventListener('click',()=>go('friends')); bar.appendChild(fBtn);
    const dBtn=UI.el('button','background:none;border:none;cursor:pointer;font-size:20px;padding:4px');
    dBtn.textContent=UI.isDark()?'☀️':'🌙'; dBtn.setAttribute('aria-label',UI.isDark()?'تفعيل الوضع الفاتح':'تفعيل الوضع الداكن'); dBtn.addEventListener('click',()=>{UI.toggleDark();S.dark=UI.isDark();renderScreen();}); bar.appendChild(dBtn);
    return bar;
  }

  function buildStoryInner(container){
    container.innerHTML='';
    const addW=UI.el('div','display:flex;flex-direction:column;align-items:center;gap:3px;flex-shrink:0;cursor:pointer');
    const addC=UI.el('div',`width:52px;height:52px;border-radius:50%;background:${th().card2};border:2px dashed var(--accent);display:flex;align-items:center;justify-content:center;font-size:22px`); addC.textContent='+';
    const stIn=document.createElement('input'); stIn.type='file'; stIn.accept='image/*'; stIn.style.display='none';
    stIn.addEventListener('change',async e=>{
  const f=e.target.files[0];if(!f)return;
  try{S.storyPreview=await UI.fileToBase64(f);e.target.value='';showStoryPreview();}
  catch(err){UI.toast(err.message||'خطأ في الملف','error');e.target.value='';}
});
    const addL=UI.el('span',`font-size:10px;color:${th().text3}`); addL.textContent='قصتي';
    addW.appendChild(addC); addW.appendChild(addL); addW.appendChild(stIn); addW.addEventListener('click',()=>stIn.click()); container.appendChild(addW);
    const myS=Stories.getUserStories(S.meUid,S.stories);
    if(myS.length){const w=UI.el('div','display:flex;flex-direction:column;align-items:center;gap:3px;flex-shrink:0');const ring=UI.el('div','padding:2px;border-radius:50%;border:2.5px solid #22c55e;display:inline-flex;cursor:pointer');ring.appendChild(UI.makeAvatar(_userData(S.me),46));ring.addEventListener('click',()=>openStoryViewer(S.meUid));const lbl=UI.el('span','font-size:10px;color:#22c55e');lbl.textContent='قصتي';w.appendChild(ring);w.appendChild(lbl);container.appendChild(w);}
    fwsUids().forEach(u=>{
      const uName=_nameByUid(u)||u;
      const seen=Stories.isSeen(u,S.stories);
      const w=UI.el('div','display:flex;flex-direction:column;align-items:center;gap:3px;flex-shrink:0');
      const ring=UI.el('div',`padding:2px;border-radius:50%;border:2.5px solid ${seen?'#aaa':'var(--accent)'};display:inline-flex;cursor:pointer`);
      const uid = _uidByName(u);
      ring.appendChild(UI.makeAvatar(_userData(u),46,{online:Chat.isOnline(S.presence, uid || u)}));
      ring.addEventListener('click',()=>{Stories.markSeen(u);openStoryViewer(u);});
      const lbl=UI.el('span',`font-size:10px;color:${seen?th().text3:'var(--accent)'};max-width:52px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`); lbl.textContent=u;
      w.appendChild(ring); w.appendChild(lbl); container.appendChild(w);
    });
  }

  const _NB_ICONS={
    chats:'<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    groups:'<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    user:'<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    settings:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
  };
  function buildHomeTabs(){
    if(S.tab==='unread') S.tab='chats';
    const tabs=UI.el('div','');
    tabs.id='home-tabs';
    const items=[['groups','المجموعات'],['chats','الخاصة'],['settings','الإعدادات'],['user','الملف']];
    items.forEach(([k,l])=>{
      const b=UI.el('button'); b.className='tab'+(S.tab===k?' active':''); b.setAttribute('aria-label',l);
      b.innerHTML=_NB_ICONS[k];
      b.addEventListener('click',()=>{
        if(k==='settings'){_openSettingsSheet();return;}
        if(k==='user'){go('profile');return;}
        S.tab=k;
        tabs.querySelectorAll('.tab').forEach((x,i)=>x.classList.toggle('active',S.tab===items[i][0]));
        const c=document.getElementById('home-content');if(c)renderTabContent(c);
      });
      tabs.appendChild(b);
    });
    return tabs;
  }

  /* نافذة الإعدادات من الشريط السفلي */
  function _openSettingsSheet(view){
    const close=()=>ov.remove();
    const ov=UI.el('div','position:fixed;inset:0;z-index:990;display:flex;align-items:flex-end;justify-content:center');
    const bg=UI.el('div','position:absolute;inset:0;background:rgba(0,0,0,.5)'); bg.addEventListener('click',close);
    const sh=UI.el('div',`position:relative;width:100%;max-width:500px;max-height:88vh;overflow-y:auto;background:${th().card};color:${th().text};border-radius:20px 20px 0 0;padding:10px 16px 28px;box-sizing:border-box;animation:slideUp .25s ease`);
    const head=UI.el('div','display:flex;align-items:center;gap:10px;margin-bottom:14px');
    const ttl=UI.el('div','flex:1;font-size:17px;font-weight:800');
    const body=UI.el('div','');
    const btn=(t,fn,danger)=>{const r=UI.el('button',`display:block;width:100%;text-align:right;padding:13px 14px;margin-bottom:8px;border:1px solid ${th().border};border-radius:14px;background:${th().card2};color:${danger?'#ef4444':th().text};font-size:14px;font-family:inherit;cursor:pointer`);r.textContent=t;r.addEventListener('click',fn);return r;};
    const label=t=>{const l=UI.el('div',`font-size:11px;font-weight:700;color:${th().text3};letter-spacing:1px;margin:14px 4px 6px`);l.textContent=t;return l;};
    const goProfile=()=>{close();go('profile');};

    const showBlocked=async()=>{
      body.innerHTML=''; ttl.textContent='المحظورون';
      const blocked=await Auth.getBlockedUsers(S.meUid);
      const ids=Object.keys(blocked||{});
      if(!ids.length){const e=UI.el('div',`color:${th().text3};text-align:center;padding:30px 10px;font-size:14px`);e.textContent='لا يوجد مستخدمون محظورون';body.appendChild(e);return;}
      ids.forEach(uid=>{
        const row=UI.el('div',`display:flex;align-items:center;gap:10px;padding:10px 12px;margin-bottom:8px;border:1px solid ${th().border};border-radius:14px;background:${th().card2}`);
        const nm=UI.el('div','flex:1;font-size:14px;font-weight:700');nm.textContent=_nameByUid(uid)||uid;
        const ub=UI.el('button',`padding:7px 12px;border:none;border-radius:10px;background:var(--accent);color:#fff;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer`);ub.textContent='إلغاء الحظر';
        ub.addEventListener('click',async()=>{const r=await Auth.unblockUser(S.meUid,uid);if(r&&r.error){UI.toast(r.error,'error');return;}UI.toast('تم إلغاء الحظر','success');showBlocked();});
        row.appendChild(nm);row.appendChild(ub);body.appendChild(row);
      });
    };

    const PREF_DEFAULTS={visibility:'public',whoMessage:'everyone',lastSeen:true,readReceipts:true,typing:true,hideEmail:false,hidePhone:false};
    const getPrefs=()=>({...PREF_DEFAULTS,...((S.users[S.meUid]||{}).prefs||{})});
    const savePref=async(k,v)=>{
      try{
        await FB.upd(`users/${S.meUid}/prefs`,{[k]:v});
        S.users[S.meUid]=S.users[S.meUid]||{};
        S.users[S.meUid].prefs={...getPrefs(),[k]:v};
        if(k==='hideEmail'||k==='hidePhone') await _syncContact();
        UI.toast('تم الحفظ','success');
      }catch(e){UI.toast('تعذّر الحفظ، حاول مرة ثانية','error');}
      showPrivacy();
    };
    const choiceRow=(title,key,opts)=>{
      const cur=getPrefs()[key];
      const wrap=UI.el('div',`margin-bottom:12px;padding:12px;border:1px solid ${th().border};border-radius:14px;background:${th().card2}`);
      const t=UI.el('div','font-size:14px;font-weight:700;margin-bottom:8px');t.textContent=title;wrap.appendChild(t);
      const row=UI.el('div','display:flex;gap:8px');
      opts.forEach(([v,l])=>{const on=cur===v;const b=UI.el('button',`flex:1;padding:9px 6px;border-radius:10px;border:1px solid ${on?'var(--accent)':th().border};background:${on?'var(--acc22)':'transparent'};color:${on?'var(--accent)':th().text2};font-family:inherit;font-size:13px;font-weight:700;cursor:pointer`);b.textContent=l;b.addEventListener('click',()=>{if(!on)savePref(key,v);});row.appendChild(b);});
      wrap.appendChild(row);return wrap;
    };
    const toggleRow=(title,key,note)=>{
      const on=!!getPrefs()[key];
      const wrap=UI.el('div',`display:flex;align-items:center;gap:10px;margin-bottom:12px;padding:12px;border:1px solid ${th().border};border-radius:14px;background:${th().card2};cursor:pointer`);
      const txt=UI.el('div','flex:1;min-width:0');
      const t=UI.el('div','font-size:14px;font-weight:700');t.textContent=title;txt.appendChild(t);
      if(note){const n=UI.el('div',`font-size:11px;color:${th().text3};margin-top:3px`);n.textContent=note;txt.appendChild(n);}
      const sw=UI.el('div',`width:44px;height:26px;border-radius:13px;background:${on?'var(--accent)':th().border};position:relative;flex-shrink:0;transition:background .2s`);
      const kn=UI.el('div',`position:absolute;top:3px;${on?'left:21px':'left:3px'};width:20px;height:20px;border-radius:50%;background:#fff;transition:left .2s`);
      sw.appendChild(kn);wrap.appendChild(txt);wrap.appendChild(sw);
      wrap.addEventListener('click',()=>savePref(key,!on));
      return wrap;
    };
    const usernameBlock=()=>{
      const wrap=UI.el('div',`margin-bottom:12px;padding:12px;border:1px solid ${th().border};border-radius:14px;background:${th().card2}`);
      const me=S.users[S.meUid]||{};
      const cur=S.me||me.username||'';
      const t=UI.el('div','font-size:14px;font-weight:700;margin-bottom:4px');t.textContent='اليوزر نيم';wrap.appendChild(t);
      const n=UI.el('div',`font-size:12px;color:${th().text3};margin-bottom:8px;direction:ltr;text-align:right`);n.textContent='@'+cur;wrap.appendChild(n);
      const lockUntil=(me.usernameChangedAt||0)+30*864e5;
      const locked=Date.now()<lockUntil;
      const info=UI.el('div',`font-size:11px;color:${th().text3};margin-bottom:8px;line-height:1.6`);
      info.textContent=locked?`يمكن التغيير بعد ${new Date(lockUntil).toLocaleDateString('ar')}`:'يُغيَّر مرة واحدة كل 30 يوماً، ولا يُقبل اسم مستخدم موجود مسبقاً.';
      wrap.appendChild(info);
      const inp=field('اليوزر نيم الجديد');inp.disabled=locked;wrap.appendChild(inp);
      const b=saveRow('حفظ اليوزر نيم',async()=>{
        const r=await Auth.changeUsername(S.meUid,cur,inp.value);
        if(r.error){UI.toast(r.error,'error');return;}
        S.me=r.username;
        S.users[S.meUid]={...(S.users[S.meUid]||{}),username:r.username,usernameChangedAt:Date.now()};
        rebuildUserMaps();
        UI.toast('تم تغيير اليوزر نيم ✓','success');showPrivacy();
      });
      if(locked){b.disabled=true;b.style.opacity='.5';}
      wrap.appendChild(b);
      return wrap;
    };
    const showPrivacy=()=>{
      body.innerHTML=''; ttl.textContent='إعدادات الخصوصية'; back.style.display='';
      body.appendChild(label('الحساب والهوية'));
      body.appendChild(usernameBlock());
      body.appendChild(label('من يرى حسابي'));
      body.appendChild(choiceRow('حالة الحساب','visibility',[['public','عام'],['private','خاص']]));
      body.appendChild(choiceRow('من يقدر يراسلني','whoMessage',[['everyone','الجميع'],['friends','الأصدقاء فقط']]));
      body.appendChild(label('الإيميل والرقم'));
      body.appendChild(toggleRow('إخفاء الإيميل','hideEmail','لا يظهر إيميلك في ملفك الشخصي للآخرين'));
      body.appendChild(toggleRow('إخفاء الرقم','hidePhone','لا يظهر رقمك في ملفك الشخصي للآخرين'));
      body.appendChild(label('الظهور والمحادثات'));
      body.appendChild(toggleRow('إظهار آخر ظهور','lastSeen','عند إيقافه لا يظهر وقت آخر ظهور لك'));
      body.appendChild(toggleRow('إيصالات القراءة (✓✓)','readReceipts','عند إيقافه لا يعرف الطرف الآخر أنك قرأت الرسالة'));
      body.appendChild(toggleRow('مؤشر الكتابة','typing','عند إيقافه لا يظهر لغيرك أنك تكتب'));
      const note=UI.el('div',`font-size:11px;color:${th().text3};line-height:1.6;margin-top:10px;padding:0 4px`);
      note.textContent='ملاحظة: هذه الإعدادات تُحفظ الآن على حسابك. تطبيقها الكامل على الآخرين يحتاج تحديث قواعد Firebase، وسيتم لاحقاً.';
      body.appendChild(note);
    };

    const field=(ph,tp)=>{const i=UI.el('input',`width:100%;padding:12px 14px;border-radius:12px;border:1px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:14px;font-family:inherit;direction:rtl;box-sizing:border-box;margin-bottom:10px`);i.type=tp||'text';i.placeholder=ph;return i;};
    const saveRow=(t,fn)=>{const x=UI.el('button',`width:100%;padding:13px;border:none;border-radius:14px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-family:inherit;font-size:15px;font-weight:700;cursor:pointer`);x.textContent=t;x.addEventListener('click',fn);return x;};
    const showPassword=()=>{
      body.innerHTML=''; ttl.textContent='تغيير كلمة المرور'; back.style.display='';
      const a1=field('كلمة المرور الحالية','password'), a2=field('كلمة المرور الجديدة','password'), a3=field('تأكيد كلمة المرور الجديدة','password');
      body.appendChild(a1); body.appendChild(a2); body.appendChild(a3);
      body.appendChild(saveRow('حفظ',async()=>{
        const res=await Auth.changePassword(a1.value,a2.value,a3.value);
        if(res.error){UI.toast(res.error,'error');return;}
        UI.toast('تم تغيير كلمة المرور','success'); showMain();
      }));
    };
    const showEmail=()=>{
      body.innerHTML=''; ttl.textContent='تغيير البريد الإلكتروني'; back.style.display='';
      const em=field('البريد الإلكتروني الجديد','email'), pw=field('كلمة المرور الحالية','password');
      body.appendChild(em); body.appendChild(pw);
      body.appendChild(saveRow('حفظ',async()=>{
        const res=await Auth.updateEmail(pw.value,em.value);
        if(res.error){UI.toast(res.error,'error');return;}
        UI.toast('تم تغيير البريد ✓','success'); showMain();
      }));
    };
    const showMain=()=>{
      body.innerHTML=''; ttl.textContent='الإعدادات';
      body.appendChild(label('الحساب'));
      body.appendChild(btn('👥  أصدقائي',()=>{close();go('friends');}));
      body.appendChild(btn('👤  تعديل الملف الشخصي',goProfile));
      body.appendChild(btn('✉️  تغيير البريد الإلكتروني',()=>showEmail()));
      body.appendChild(btn('🔑  تغيير كلمة المرور',()=>showPassword()));
      body.appendChild(btn('📱  تغيير رقم الهاتف',()=>UI.toast('غير متاح: الحسابات مبنية على البريد الإلكتروني','info')));
      body.appendChild(label('المظهر والإشعارات'));
      body.appendChild(btn(UI.isDark()?'☀️  الوضع الفاتح':'🌙  الوضع الداكن',()=>{UI.toggleDark();S.dark=UI.isDark();close();renderScreen();}));
      body.appendChild(btn('🔔  الإشعارات',()=>{close();_toggleNotifPanel();}));
      body.appendChild(label('الخصوصية والأمان'));
      body.appendChild(btn('🛡  إعدادات الخصوصية',()=>{showPrivacy();}));
      body.appendChild(btn('🚫  المحظورون',()=>{showBlocked();}));
      body.appendChild(btn('🔐  التشفير والنسخة الاحتياطية',()=>{close();_openE2EManage();}));
      body.appendChild(btn('📄  سياسة الخصوصية',()=>window.open('privacy.html','_blank','noopener')));
      body.appendChild(btn('📜  الشروط والأحكام',()=>window.open('terms.html','_blank','noopener')));
      body.appendChild(label('منطقة الخطر'));
      body.appendChild(btn('🚪  تسجيل الخروج',async()=>{
        if(!await UI.confirmDialog('هل تريد تسجيل الخروج؟',{confirmText:'خروج',danger:true}))return;
        Chat.goOffline(S.meUid);try{E2E.reset();}catch(e){}await Auth.logout();S.me=null;S.meUid=null;S.usersByName={};location.reload();
      },true));
      body.appendChild(btn('🗑  حذف الحساب',()=>{close();_deleteAccountFlow();},true));
    };

    const back=UI.el('button',`background:none;border:none;color:var(--accent);font-size:20px;cursor:pointer;padding:0 6px;display:none`);back.textContent='›';
    back.addEventListener('click',()=>{showMain();back.style.display='none';});
    const x=UI.el('button',`background:none;border:none;color:${th().text2};font-size:18px;cursor:pointer;padding:0 6px`);x.textContent='✕';x.addEventListener('click',close);
    head.appendChild(back);head.appendChild(ttl);head.appendChild(x);
    const hd=UI.el('div','width:40px;height:4px;background:'+th().border+';border-radius:2px;margin:4px auto 12px');
    sh.appendChild(hd);sh.appendChild(head);sh.appendChild(body);
    ov.appendChild(bg);ov.appendChild(sh);document.body.appendChild(ov);
    UI.attachSheetGestures(ov,sh,close);
    if(view==='blocked'){back.style.display='';showBlocked();} else showMain();
  }

  /* رأس القائمة: بحث + إعدادات بجانبه */
  function buildListHead(){
    const row=UI.el('div','');
    row.id='nb-head';
    const inp=UI.el('input',`flex:1;min-width:0;padding:14px 18px;border-radius:999px;border:1px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:14px;font-family:inherit;box-sizing:border-box;direction:rtl;outline:none`);
    inp.placeholder='بحث';
    inp.addEventListener('input',()=>{const q=inp.value.trim();document.querySelectorAll('#home-content .nb-row').forEach(r=>{r.style.display=(!q||r.textContent.includes(q))?'':'none';});});
    const nBtn=UI.el('button',`flex-shrink:0;width:46px;height:46px;border-radius:50%;border:1px solid ${th().inpBorder};background:${th().card};color:${th().text};display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;position:relative;font-size:20px`);
    nBtn.id='notif-bell'; nBtn.textContent='🔔'; nBtn.setAttribute('aria-label','الإشعارات');
    nBtn.addEventListener('click',_toggleNotifPanel); _updateNotifBadge(nBtn);
    row.appendChild(inp); row.appendChild(nBtn);
    return row;
  }

  function _buildArchiveRow(n){
    const open=S.showArchive;
    const row=UI.el('div',`display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:14px;cursor:pointer;background:${th().card2};border:1px solid ${th().border};margin-bottom:8px;color:${th().text2};font-size:13px;font-weight:700`);
    const ic=UI.el('span','font-size:18px');ic.textContent=open?'⬅️':'🗄';
    const t=UI.el('span','flex:1');t.textContent=open?'رجوع إلى المحادثات':`الأرشيف (${n})`;
    row.appendChild(ic);row.appendChild(t);
    row.addEventListener('click',()=>{S.showArchive=!S.showArchive;const c=document.getElementById('home-content');if(c)renderTabContent(c);});
    return row;
  }

  function renderTabContent(container){
    container.innerHTML='';
    if(container.id==='home-content'){ container.appendChild(buildListHead()); if(_storyWrap) container.appendChild(_storyWrap); }
    if(S.tab==='chats'){
      const hdr=UI.el('div','display:flex;align-items:center;justify-content:space-between;margin-bottom:10px');
      const lbl=UI.el('span',`font-size:11px;font-weight:700;color:${th().text3};letter-spacing:1px`); lbl.textContent='الرسائل الأخيرة';
      const plusBtn=UI.el('button','background:none;border:none;cursor:pointer;color:var(--accent);font-size:22px;line-height:1;padding:0'); plusBtn.textContent='+';
      hdr.appendChild(lbl); hdr.appendChild(plusBtn); container.appendChild(hdr);
      let showNdm=false;
      const ndmRow=UI.el('div','display:flex;gap:6px;margin-bottom:10px'); ndmRow.style.display='none';
      const ndmInp=UI.el('input',`flex:1;padding:9px 12px;border-radius:12px;border:1.5px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:13px;direction:rtl`); ndmInp.placeholder='اسم المستخدم...';
      const ndmBtn=UI.el('button','padding:9px 14px;border:none;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-weight:700;font-family:inherit;cursor:pointer'); ndmBtn.textContent='→';
      const doNdm=async()=>{
        const u=ndmInp.value.trim(); if(!u||u===S.me) return;
        const user=await _resolveUserByUsername(u);
        if(!user){UI.toast('المستخدم غير موجود','error');return;}
        go('dm',u);
      };
      ndmBtn.addEventListener('click',doNdm); ndmInp.addEventListener('keydown',e=>{if(e.key==='Enter')doNdm();});
      ndmRow.appendChild(ndmInp); ndmRow.appendChild(ndmBtn); container.appendChild(ndmRow);
      plusBtn.addEventListener('click',()=>{showNdm=!showNdm;ndmRow.style.display=showNdm?'flex':'none';if(showNdm)ndmInp.focus();});
      const all=Object.keys(S.usersByName).filter(u=>u!==S.me&&Chat.getDMMessages(S.meUid,_uidByName(u)||u,S.dmChats).length>0)
        .map(u=>{const last=Chat.getLastDMMsg(S.meUid,_uidByName(u)||u,S.dmChats);const ts=last?last.ts:0;return {u,ts,pin:_pref('dm',u).pinned||0,bucket:_chatBucket('dm',u,ts)};});
      const others=all.filter(x=>x.bucket==='main').sort(_sortChats);
      const arch=all.filter(x=>x.bucket==='archived').sort(_sortChats);
      if(!arch.length)S.showArchive=false;
      if(arch.length)container.appendChild(_buildArchiveRow(arch.length));
      if(S.showArchive&&arch.length){arch.forEach(x=>container.appendChild(buildChatItem(x.u)));return;}
      if(!others.length){const emp=UI.el('div',`color:${th().text3};font-size:13px;padding:16px 0;text-align:center`);emp.textContent=arch.length?'كل محادثاتك في الأرشيف':'اضغط + لبدء محادثة جديدة';container.appendChild(emp);}
      others.forEach(x=>container.appendChild(buildChatItem(x.u)));
    } else if(S.tab==='groups'){
      const btnRow=UI.el('div','display:flex;gap:8px;margin-bottom:14px');
      const ngBtn=UI.el('button','flex:1;padding:10px 16px;border:none;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-weight:700;font-size:13px;font-family:inherit;cursor:pointer'); ngBtn.textContent='+ مجموعة جديدة'; ngBtn.addEventListener('click',()=>go('newGroup')); btnRow.appendChild(ngBtn);
      const jnBtn=UI.el('button',`flex:1;padding:10px 16px;border:1px solid ${th().border};border-radius:12px;background:${th().card2};color:${UI.isDark()?'var(--accent)':'var(--accent)'};font-weight:700;font-size:13px;font-family:inherit;cursor:pointer`); jnBtn.textContent='🔗 انضمام'; jnBtn.addEventListener('click',()=>go('join')); btnRow.appendChild(jnBtn); container.appendChild(btnRow);
      const allG=myGroups().map(g=>{const ts=_groupLastTs(g);return {g,ts,pin:_pref('group',g.id).pinned||0,bucket:_chatBucket('group',g.id,ts)};});
      const grps=allG.filter(x=>x.bucket==='main').sort(_sortChats).map(x=>x.g);
      const archG=allG.filter(x=>x.bucket==='archived').sort(_sortChats).map(x=>x.g);
      if(!archG.length)S.showArchive=false;
      if(archG.length)container.appendChild(_buildArchiveRow(archG.length));
      if(S.showArchive&&archG.length){archG.forEach(g=>container.appendChild(buildGroupItem(g)));return;}
      if(!grps.length&&archG.length){const emp=UI.el('div',`color:${th().text3};text-align:center;padding:30px 20px;font-size:14px`);emp.textContent='كل مجموعاتك في الأرشيف';container.appendChild(emp);return;}
      if(!grps.length){const emp=UI.el('div',`color:${th().text3};text-align:center;padding:40px 20px;font-size:14px`);emp.textContent='لا توجد مجموعات بعد';container.appendChild(emp);setTimeout(()=>{const c2=document.getElementById('home-content');if(c2&&S.screen==='home'&&S.tab==='groups'&&!S._grpRetried){S._grpRetried=true;renderTabContent(c2);}},2000);return;}
      grps.forEach(g=>container.appendChild(buildGroupItem(g)));
    } else if(S.tab==='unread'){
      const hdr=UI.el('div',`font-size:11px;font-weight:700;color:${th().text3};letter-spacing:1px;margin-bottom:12px`); hdr.textContent='غير المقروء'; container.appendChild(hdr);
      const ur=unread();
      if(!Object.keys(ur).length){const emp=UI.el('div',`color:${th().text3};font-size:13px;text-align:center;margin-top:20px`);emp.textContent='✅ لا توجد رسائل غير مقروءة';container.appendChild(emp);return;}
      Object.entries(ur).forEach(([u,cnt])=>container.appendChild(buildChatItem(u,cnt)));
    }
  }

  function buildChatItem(u,forcedUnread=0){
    const _fUid=_uidByName(u)||u; const ur=forcedUnread||unread()[u]||0; const last=Chat.getLastDMMsg(S.meUid,_fUid,S.dmChats);
    const _fUid2=_uidByName(u)||u; const hasSt=fwsUids().includes(_fUid2); const seenSt=Stories.isSeen(_fUid2,S.stories);
    const item=UI.el('div',`display:flex;align-items:center;gap:10px;padding:11px 12px;border-radius:14px;cursor:pointer;background:${ur?'var(--acc11)':th().card};border:1px solid ${ur?'var(--acc33)':th().border};margin-bottom:6px;transition:opacity .12s`);
    item.className='nb-row';
    item.addEventListener('click',()=>go('dm',u));
    _bindLongPress(item,()=>_openChatSheet('dm',u));
    const uid = _uidByName(u);
    item.appendChild(UI.makeAvatar(_userData(u),44,{online:Chat.isOnline(S.presence, uid || u),ring:hasSt,seen:seenSt,onClick:hasSt?e=>{e.stopPropagation();Stories.markSeen(_fUid2);openStoryViewer(_fUid2);}:null}));
    const info=UI.el('div','flex:1;min-width:0');
    const _pp=_pref('dm',u);
    const nm=UI.el('div',`font-weight:${ur?700:600};font-size:14px;color:${th().text};display:flex;align-items:center;gap:5px`);
    const nmT=UI.el('span','overflow:hidden;text-overflow:ellipsis;white-space:nowrap');nmT.textContent=u;nm.appendChild(nmT);
    if(_pp.pinned){const pi=UI.el('span','font-size:11px');pi.textContent='📌';nm.appendChild(pi);}
    if(_pp.muted){const mi=UI.el('span','font-size:11px;opacity:.7');mi.textContent='🔕';nm.appendChild(mi);}
    if(_isBlockedName(u)){const bi=UI.el('span','font-size:11px');bi.textContent='🚫';nm.appendChild(bi);}
    info.appendChild(nm);
    if(last){const prev=UI.el('div',`font-size:12px;color:${ur?'var(--accent)':th().text3};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:${ur?600:400}`);prev.textContent=(last.sender===S.me?'أنت: ':'')+UI.preview(last);info.appendChild(prev);}
    item.appendChild(info);
    const meta=UI.el('div','display:flex;flex-direction:column;align-items:flex-end;gap:3px');
    if(last){const ts=UI.el('span',`font-size:10px;color:${th().text3}`);ts.textContent=UI.fmtFull(last.ts);meta.appendChild(ts);}
    if(ur>0){const b=UI.el('div',`background:${_pp.muted?'#9ca3af':'#ef4444'};color:#fff;font-size:10px;font-weight:700;border-radius:10px;min-width:18px;height:18px;display:flex;align-items:center;justify-content:center;padding:0 5px`);b.textContent=ur;meta.appendChild(b);}
    item.appendChild(meta); return item;
  }

  function buildGroupItem(g){
    const pc=Groups.canManage(g,S.meUid)&&g.pending?Object.keys(g.pending).length:0;
    const ug=unreadGrps()[g.id]||0; // v2: unread count for this group
    const item=UI.el('div',`display:flex;align-items:center;gap:10px;padding:11px 12px;border-radius:14px;cursor:pointer;background:${ug?'var(--acc11)':th().card};border:1px solid ${ug?'var(--acc33)':th().border};margin-bottom:6px`);
    item.className='nb-row';
    item.addEventListener('click',()=>go('group',g.id));
    _bindLongPress(item,()=>_openChatSheet('group',g.id));
    if(g.photo){const img=document.createElement('img');img.src=g.photo;img.alt=`صورة مجموعة ${g.name||''}`;img.loading='lazy';img.style.cssText='width:44px;height:44px;border-radius:12px;object-fit:cover;flex-shrink:0';item.appendChild(img);}
    else{const c=UI.userColor(g.name);const ic=UI.el('div',`width:44px;height:44px;border-radius:12px;flex-shrink:0;background:linear-gradient(135deg,${c},${UI.userColor(g.name+'1')});display:flex;align-items:center;justify-content:center;font-weight:800;font-size:19px;color:#fff`);ic.textContent=g.name[0];item.appendChild(ic);}
    const info=UI.el('div','flex:1;min-width:0'); const nr=UI.el('div','display:flex;align-items:center;gap:6px');
    const nm=UI.el('span',`font-weight:${ug?700:600};font-size:14px;color:${th().text}`); nm.textContent=g.name; nr.appendChild(nm);
    {const _gp=_pref('group',g.id);if(_gp.pinned){const pi=UI.el('span','font-size:11px');pi.textContent='📌';nr.appendChild(pi);}if(_gp.muted){const mi=UI.el('span','font-size:11px;opacity:.7');mi.textContent='🔕';nr.appendChild(mi);}}
    if(pc>0){const b=UI.el('span','background:#fee2e2;color:#ef4444;font-size:10px;font-weight:700;padding:1px 6px;border-radius:6px');b.textContent=`${pc} طلب`;nr.appendChild(b);}
    info.appendChild(nr);
    const sub=UI.el('div',`font-size:11px;color:${th().text3}`); sub.textContent=`${Groups.getMembers(g).length} عضو`; info.appendChild(sub);
    item.appendChild(info);
    // v2: unread badge
    if(ug>0){const ub=UI.el('div','background:#ef4444;color:#fff;font-size:10px;font-weight:700;border-radius:10px;min-width:18px;height:18px;display:flex;align-items:center;justify-content:center;padding:0 5px');ub.textContent=ug;item.appendChild(ub);}
    return item;
  }

  /* ═══════════════════════════════════════════════════════════
     SHARED TOPBARS
  ═══════════════════════════════════════════════════════════ */
  function buildChatTopbar(type){
    const g=ag();
    const bar=UI.el('div',`display:flex;align-items:center;gap:10px;padding:10px 14px;background:${th().topbar};border-bottom:1px solid ${th().border};flex-shrink:0;box-shadow:0 1px 6px rgba(0,0,0,.06)`);
    const back=UI.el('button','background:none;border:none;cursor:pointer;font-size:22px;padding:2px;line-height:1'); back.textContent='←'; back.setAttribute('aria-label','رجوع'); back.style.color=th().text2; back.addEventListener('click',()=>goBack()); bar.appendChild(back);
    if(type==='dm'){
      const avBtn=UI.el('button','background:none;border:none;cursor:pointer;padding:0');
      const targetUid = _uidByName(S.activeId);
      avBtn.appendChild(UI.makeAvatar(_userData(S.activeId),34,{online:Chat.isOnline(S.presence, targetUid || S.activeId)}));
      avBtn.addEventListener('click',()=>go('userProfile',S.activeId)); bar.appendChild(avBtn);
    }
    else if(g){if(g.photo){const img=document.createElement('img');img.src=g.photo;img.alt=`صورة مجموعة ${g.name||''}`;img.loading='lazy';img.style.cssText='width:34px;height:34px;border-radius:10px;object-fit:cover;flex-shrink:0';bar.appendChild(img);}else{const c=UI.userColor(g.name);const ic=UI.el('div',`width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,${c},${UI.userColor(g.name+'1')});display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;color:#fff;flex-shrink:0`);ic.textContent=g.name[0];bar.appendChild(ic);}}
    const info=UI.el('div','flex:1;min-width:0;cursor:pointer'); const titleEl=UI.el('div',`font-weight:700;font-size:15px;color:${th().text}`); const subEl=UI.el('div','font-size:11px'); subEl.id='topbar-sub';
    if(type==='dm'){titleEl.textContent=S.activeId;
      const targetUid = _uidByName(S.activeId);
      subEl.textContent=Chat.lastSeenText(S.presence, targetUid || S.activeId);
      subEl.style.color=Chat.isOnline(S.presence, targetUid || S.activeId)?'#22c55e':th().text3;
      info.addEventListener('click',()=>go('userProfile',S.activeId));
    }
    else if(g){titleEl.textContent=g.name;subEl.textContent=`${Groups.getMembers(g).length} عضو`;subEl.style.color=th().text3;}
    info.appendChild(titleEl); info.appendChild(subEl); bar.appendChild(info);
    if(type==='dm'){const lk=UI.el('button','background:none;border:none;cursor:pointer;font-size:16px;padding:4px;display:none');lk.id='e2e-lock';lk.setAttribute('aria-label','التشفير');lk.addEventListener('click',()=>_openSafety(S.activeId));bar.appendChild(lk);setTimeout(_e2eRefreshLock,0);}
    const custBtn=UI.el('button','background:none;border:none;cursor:pointer;font-size:18px;padding:4px'); custBtn.textContent='🎨'; custBtn.style.color=th().text2; custBtn.addEventListener('click',showCustomizeSheet); bar.appendChild(custBtn);
    const moreBtn=UI.el('button','background:none;border:none;cursor:pointer;font-size:22px;padding:2px 6px;line-height:1;font-weight:800'); moreBtn.textContent='⋮'; moreBtn.style.color=th().text2; moreBtn.setAttribute('aria-label','خيارات المحادثة'); moreBtn.addEventListener('click',()=>_openChatSheet(type,S.activeId)); bar.appendChild(moreBtn);
    if(type==='group'&&g){
      const pBtn=UI.el('button',`padding:7px 11px;border:1px solid ${th().border};border-radius:12px;background:${S.panel?'var(--acc22)':th().card2};color:${UI.isDark()?'var(--accent)':'var(--accent)'};font-family:inherit;font-size:12px;font-weight:700;cursor:pointer`); pBtn.textContent=Groups.canManage(g,S.meUid)?'👑':'👥';
      pBtn.id='group-panel-btn';pBtn.addEventListener('click',()=>{S.panel=!S.panel;pBtn.style.background=S.panel?'var(--acc22)':th().card2;const body=document.getElementById('group-body');const ex=document.getElementById('group-panel');if(S.panel&&body)buildGroupPanel(body);else if(ex)ex.remove();});
      bar.appendChild(pBtn);
    }
    return bar;
  }

  function buildSimpleTopbar(title){
    const bar=UI.el('div',`display:flex;align-items:center;gap:10px;padding:10px 14px;background:${th().topbar};border-bottom:1px solid ${th().border};flex-shrink:0;box-shadow:0 1px 6px rgba(0,0,0,.06)`);
    const back=UI.el('button','background:none;border:none;cursor:pointer;font-size:22px;padding:2px;line-height:1'); back.textContent='←'; back.setAttribute('aria-label','رجوع'); back.style.color=th().text2; back.addEventListener('click',()=>goBack()); bar.appendChild(back);
    const t2=UI.el('span',`font-weight:700;font-size:16px;color:${th().text}`); t2.textContent=title; bar.appendChild(t2); return bar;
  }

  /* ═══════════════════════════════════════════════════════════
     DM / GROUP
  ═══════════════════════════════════════════════════════════ */
  function renderDM(){APP.appendChild(buildChatTopbar('dm'));APP.appendChild(buildMsgsArea());APP.appendChild(_isBlockedName(S.activeId)?buildBlockedBar(S.activeId):buildChatInput('dm'));_dmReady=true;}

  function renderGroup(){
    // تأكد من وجود بيانات المجموعة
    if(S.activeId && !S.groups[S.activeId]) {
      _openGroupListener(S.activeId);
      const loadDiv=UI.el('div',`height:100vh;display:flex;align-items:center;justify-content:center;background:${th().bg};flex-direction:column;gap:12px`);
      loadDiv.appendChild(UI.spinner(32));
      const t=UI.el('div','font-size:14px');t.style.color=th().text2;t.textContent='جار تحميل المجموعة...';
      loadDiv.appendChild(t); APP.appendChild(loadDiv);
      setTimeout(()=>{if(S.screen==='group'){if(S.groups[S.activeId])renderScreen();else{UI.toast('تعذّر تحميل المجموعة','error');go('home');}}},3000);
      return;
    }
    APP.appendChild(buildChatTopbar('group'));
    const body=UI.el('div','flex:1;display:flex;overflow:hidden'); body.id='group-body';
    const main=UI.el('div','flex:1;display:flex;flex-direction:column;overflow:hidden');
    main.appendChild(buildMsgsArea()); main.appendChild(buildChatInput('group'));
    // الضغط على الدردشة أثناء فتح لوحة الإدارة → يغلق اللوحة ويرجع للدردشة
    main.addEventListener('click',()=>{
      if(!S.panel)return;
      S.panel=false;S.groupEdit=false;
      const pn=document.getElementById('group-panel');if(pn)pn.remove();
      const pb=document.getElementById('group-panel-btn');if(pb)pb.style.background=th().card2;
    },true);
    body.appendChild(main); APP.appendChild(body); if(S.panel)buildGroupPanel(body);
  }

  /* ═══════════════════════════════════════════════════════════
     MESSAGES
  ═══════════════════════════════════════════════════════════ */
  function buildMsgsArea(){
    const bg=UI.getChatBgs()[chatId()]||th().bg;

    // v2: wrapper div to hold pinned bar + scroll area
    const wrapper=UI.el('div','flex:1;display:flex;flex-direction:column;overflow:hidden');

    // ── Pinned bar (v2) ──────────────────────────────────
    const pinnedBar=UI.el('div',`display:none;align-items:center;gap:8px;padding:6px 14px;background:${th().card};border-bottom:1px solid ${th().border};cursor:pointer;flex-shrink:0`);
    pinnedBar.id='pinned-bar';
    const pinIco=UI.el('span','font-size:14px');pinIco.textContent='📌';
    const pinTxt=UI.el('div','flex:1;min-width:0');
    const pinLbl=UI.el('div',`font-size:10px;color:var(--accent);font-weight:700`);pinLbl.textContent='رسالة مثبّتة';
    const pinPrev=UI.el('div',`font-size:12px;color:${th().text2};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`);
    pinTxt.appendChild(pinLbl);pinTxt.appendChild(pinPrev);
    const pinClose=UI.el('button','background:none;border:none;cursor:pointer;color:var(--accent);font-size:16px;padding:2px 4px');pinClose.textContent='✕';
    pinClose.addEventListener('click',async e=>{e.stopPropagation();const cP=Chat.msgPath(S.screen,S.screen==='dm'?Chat.dmKey(S.meUid,_uidByName(S.activeId)||S.activeId):S.activeId);await Chat.unpinMsg(cP);});
    pinnedBar.appendChild(pinIco);pinnedBar.appendChild(pinTxt);pinnedBar.appendChild(pinClose);
    pinnedBar.addEventListener('click',()=>{
      if(S._pinnedMsg){const orig=document.querySelector(`[data-msg-id="${S._pinnedMsg.msgId}"]`);if(orig){orig.scrollIntoView({behavior:'smooth',block:'center'});orig.style.outline='2px solid var(--accent)';setTimeout(()=>orig.style.outline='',1200);}}
    });
    wrapper.appendChild(pinnedBar);

    const scroll=UI.el('div',`flex:1;overflow-y:auto;padding:10px 10px 4px;background:${bg};background-size:cover;background-position:center;-webkit-overflow-scrolling:touch`); scroll.id='msg-scroll';

    // v2: زر "تحميل رسائل أقدم"
    const loadMoreBtn=UI.el('button',`display:none;margin:6px auto;padding:6px 18px;border:1px solid ${th().border};border-radius:20px;background:${th().card2};color:${th().text2};font-size:12px;font-family:inherit;cursor:pointer`);
    loadMoreBtn.id='load-more-btn'; loadMoreBtn.textContent='⬆ رسائل أقدم';
    loadMoreBtn.addEventListener('click',async()=>{
      if(!S.msgs.length)return;
      loadMoreBtn.textContent='جار التحميل...'; loadMoreBtn.disabled=true;
      const cPath=Chat.msgPath(S.screen,S.screen==='dm'?Chat.dmKey(S.meUid,_uidByName(S.activeId)||S.activeId):S.activeId);
      const older=await Chat.loadMoreMsgs(cPath, S.msgs[0].id);
      if(older.length){
        S.msgs=[...older,...S.msgs];
        const c=document.getElementById('msg-container');
        const firstEl=c.firstChild;
        older.forEach(m=>c.insertBefore(buildBubble(m),c.firstChild));
        if(firstEl)firstEl.scrollIntoView({behavior:'auto'});
        loadMoreBtn.textContent='⬆ رسائل أقدم';
      } else {
        loadMoreBtn.textContent='لا توجد رسائل أقدم'; loadMoreBtn.style.opacity='.5';
      }
      loadMoreBtn.disabled=false;
    });
    scroll.appendChild(loadMoreBtn);

    // v2: show load-more on upward scroll
    scroll.addEventListener('scroll',()=>{
      const btn=document.getElementById('load-more-btn');
      if(btn&&scroll.scrollTop<80&&S.msgs.length>=60){btn.style.display='block';}
    });

    let tsy=0; scroll.addEventListener('touchstart',e=>{if(scroll.scrollTop===0)tsy=e.touches[0].clientY;});
    scroll.addEventListener('touchend',e=>{if(e.changedTouches[0].clientY-tsy>60&&scroll.scrollTop===0)UI.toast('تم التحديث ✓','success');});
    const msgC=UI.el('div',''); msgC.id='msg-container'; scroll.appendChild(msgC);
    const typRow=UI.el('div','display:none;align-items:center;gap:8px;padding:4px 0'); typRow.id='typing-row'; scroll.appendChild(typRow);
    const anchor=document.createElement('div'); anchor.id='msg-anchor'; scroll.appendChild(anchor);
    wrapper.appendChild(scroll);
    renderMsgs(); return wrapper;
  }

  // v2: تحديث الـ pinned bar بدون re-render
  function _refreshPinnedBar() {
    const bar=document.getElementById('pinned-bar'); if(!bar) return;
    if(S._pinnedMsg){
      bar.style.display='flex';
      const prev=bar.querySelector('div > div:last-child');
      if(prev) prev.textContent=S._pinnedMsg.text||`[${S._pinnedMsg.type}]`;
    } else {
      bar.style.display='none';
    }
  }

  function renderMsgs(){const c=document.getElementById('msg-container');if(!c)return;c.innerHTML='';if(!S.msgs.length)c.appendChild(buildEmptyChat());else S.msgs.forEach(m=>c.appendChild(buildBubble(m)));scrollBot();}
  function appendMsg(m){if(_searchMode&&_searchQuery)return; /* أثناء البحث لا نخلط رسالة جديدة بالنتائج المفلترة (تظهر عند إغلاق البحث) */const c=document.getElementById('msg-container');if(!c)return;const emp=c.querySelector('.empty-chat');if(emp)emp.remove();c.appendChild(buildBubble(m, !!m._isOpt));scrollBot();}
  function scrollBot(smooth=true){const a=document.getElementById('msg-anchor');if(a)a.scrollIntoView({behavior:smooth?'smooth':'auto'});}

  function buildEmptyChat(){
    const g=ag();
    const d=UI.el('div','text-align:center;margin-top:50px');
    d.className='empty-chat'; d.style.color=th().text3;
    if(S.screen==='dm'){
      const wave=UI.el('div','font-size:44px'); wave.textContent='👋';
      const txt=UI.el('div','font-size:14px;margin-top:8px');
      const bold=document.createElement('b'); bold.textContent=S.activeId;
      txt.appendChild(document.createTextNode('ابدأ المحادثة مع '));
      txt.appendChild(bold);
      d.appendChild(wave); d.appendChild(txt);
    } else if(g){
      const wave=UI.el('div','font-size:44px'); wave.textContent='💬';
      const txt=UI.el('div','font-size:14px;margin-top:8px'); txt.textContent='لا توجد رسائل بعد';
      d.appendChild(wave); d.appendChild(txt);
      if(Groups.canManage(g,S.meUid)){
        const inv=UI.el('div',`margin-top:14px;padding:14px;background:${th().card};border-radius:14px;border:1px solid ${th().border};display:inline-block`);
        const invLbl=UI.el('div','color:var(--accent);font-size:12px;font-weight:700;margin-bottom:4px'); invLbl.textContent='🔗 رمز الدعوة';
        const invCode=UI.el('div','font-family:monospace;color:#22c55e;font-size:15px;letter-spacing:2px;font-weight:700'); invCode.textContent=g.inviteCode;
        inv.appendChild(invLbl); inv.appendChild(invCode);
        d.appendChild(inv);
      }
    }
    return d;
  }

  /* ── Status helpers ──────────────────────────────────────── */
  function _statusText(m) {
    if (m.sender !== S.meUid && m.sender !== S.me) return '';
    if (m._pending) return '⏳';      // pending / retrying
    return Chat.statusText(m);        // ✓ مرسلة / ✓✓ وصلت / ✓✓🔵 قُرئت (حقل status)
  }

  /* ═══════════════════════════════════════════════════════════
     تفضيلات المحادثات: تثبيت / كتم / أرشفة / إخفاء — محفوظة لحسابك فقط
     userData/{uid}/chatPrefs/{dmKey | g_gid} = { pinned, muted, archived, hiddenAt }
  ═══════════════════════════════════════════════════════════ */
  let _dmReady = false; // بعد أول عرض للمحادثة (لتفادي إعادة رسم مبكرة)
  const _prefKey = (type,id) => type==='dm' ? Chat.dmKey(S.meUid,_uidByName(id)||id) : 'g_'+id;
  const _pref    = (type,id) => (S.prefs && S.prefs[_prefKey(type,id)]) || {};
  const _isBlockedName = name => { const u=_uidByName(name); return !!(u && S.blocked && S.blocked[u]); };

  async function _setPref(type,id,patch){
    if(!S.meUid) return;
    const key=_prefKey(type,id);
    const cur=Object.assign({},S.prefs[key]||{});
    const upd={};
    Object.keys(patch).forEach(k=>{
      const v=patch[k];
      if(v===null||v===false){ upd[k]=null; delete cur[k]; } else { upd[k]=v; cur[k]=v; }
    });
    S.prefs[key]=cur; refreshDyn();
    try{ await FB.upd(`userData/${S.meUid}/chatPrefs/${key}`, upd); }
    catch(e){ UI.toast('تعذّر حفظ الإعداد','error'); }
  }

  // أين تُعرض المحادثة؟ 'main' | 'archived' | 'hidden'
  function _chatBucket(type,id,lastTs){
    const p=_pref(type,id); lastTs=lastTs||0;
    if(p.hiddenAt && lastTs<=p.hiddenAt) return 'hidden';
    if(p.archived && (lastTs<=p.archived || p.muted)) return 'archived';
    return 'main';
  }
  const _sortChats = (a,b) => ((b.pin||0)-(a.pin||0)) || ((b.ts||0)-(a.ts||0));
  function _groupLastTs(g){
    const raw=S.groupMsgsCache&&S.groupMsgsCache[g.id]; let t=g.createdAt||0;
    if(raw) Object.values(raw).forEach(m=>{ if(m&&m.ts>t)t=m.ts; });
    return t;
  }

  // ضغط مطوّل (لمس أو كليك يمين) على عنصر
  function _bindLongPress(el,fn){
    let t=null,sx=0,sy=0,fired=false;
    el.style.webkitTouchCallout='none'; el.style.userSelect='none'; el.style.webkitUserSelect='none';
    el.addEventListener('touchstart',e=>{
      fired=false; const p=e.touches[0]; sx=p.clientX; sy=p.clientY;
      clearTimeout(t); t=setTimeout(()=>{fired=true;try{navigator.vibrate&&navigator.vibrate(15);}catch(_){}fn();},520);
    },{passive:true});
    el.addEventListener('touchmove',e=>{const p=e.touches[0];if(Math.abs(p.clientX-sx)>10||Math.abs(p.clientY-sy)>10)clearTimeout(t);},{passive:true});
    ['touchend','touchcancel'].forEach(ev=>el.addEventListener(ev,()=>clearTimeout(t),{passive:true}));
    el.addEventListener('contextmenu',e=>{e.preventDefault();clearTimeout(t);fired=true;fn();});
    el.addEventListener('click',e=>{if(fired){e.stopImmediatePropagation();e.preventDefault();fired=false;}},true);
  }

  function _rerenderChat(){
    if(S.screen!=='dm'&&S.screen!=='group')return;
    const t=S.screen, id=S.activeId; renderScreen(); startMsgListener(t,id);
  }

  /* ورقة إجراءات المحادثة (من الضغط المطوّل أو زر ⋮) */
  function _openChatSheet(type,id){
    const ex=document.getElementById('chat-sheet');if(ex)ex.remove();
    const p=_pref(type,id);
    const isDm=type==='dm';
    const targetUid=isDm?_uidByName(id):null;
    const g=!isDm?S.groups[id]:null;
    const blocked=isDm&&_isBlockedName(id);
    const title=isDm?id:(g&&g.name)||'مجموعة';
    const inChat=(S.screen===type&&S.activeId===id);
    const close=()=>{const e=document.getElementById('chat-sheet');if(e)e.remove();};

    const ov=UI.el('div','position:fixed;inset:0;z-index:990;display:flex;align-items:flex-end;justify-content:center');ov.id='chat-sheet';
    const bg=UI.el('div','position:absolute;inset:0;background:rgba(0,0,0,.5);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px)');bg.addEventListener('click',close);ov.appendChild(bg);
    const sheet=UI.el('div',`background:${th().card};width:100%;max-width:500px;border-radius:24px 24px 0 0;padding:10px 12px 18px;position:relative;z-index:1;max-height:82vh;overflow-y:auto;animation:slideUp .22s ease`);
    sheet.appendChild(Object.assign(UI.el('div',`width:40px;height:4px;background:${th().border};border-radius:2px;margin:4px auto 12px`),{}));
    const hd=UI.el('div','display:flex;align-items:center;gap:10px;padding:2px 8px 12px');
    if(isDm)hd.appendChild(UI.makeAvatar(_userData(id)||{username:id},40));
    else{const gi=UI.el('div',`width:40px;height:40px;border-radius:12px;background:${th().card2};display:flex;align-items:center;justify-content:center;overflow:hidden`);
      if(g&&g.photo){const im=document.createElement('img');im.src=g.photo;im.alt='';im.style.cssText='width:100%;height:100%;object-fit:cover';gi.appendChild(im);}else gi.textContent='👥';hd.appendChild(gi);}
    const ht=UI.el('div',`font-weight:800;font-size:16px;color:${th().text};flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`);ht.textContent=title;hd.appendChild(ht);
    sheet.appendChild(hd);

    const item=(ico,lbl,fn,{danger=false,sub=''}={})=>{
      const b=UI.el('button',`width:100%;display:flex;align-items:center;gap:14px;padding:13px 12px;border:none;background:none;cursor:pointer;border-radius:14px;font-family:inherit;text-align:right;color:${danger?'#ef4444':th().text}`);
      const ic=UI.el('span',`width:36px;height:36px;border-radius:12px;background:${danger?'#ef444418':th().card2};display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0`);ic.textContent=ico;
      const col=UI.el('div','flex:1;min-width:0');const l=UI.el('div','font-size:14px;font-weight:600');l.textContent=lbl;col.appendChild(l);
      if(sub){const sb=UI.el('div',`font-size:11px;color:${th().text3};margin-top:2px`);sb.textContent=sub;col.appendChild(sb);}
      b.appendChild(ic);b.appendChild(col);
      b.addEventListener('click',async()=>{close();await fn();});
      sheet.appendChild(b);
    };

    item('📌',p.pinned?'إلغاء التثبيت':'تثبيت في الأعلى',()=>_setPref(type,id,{pinned:p.pinned?null:Date.now()}));
    item(p.muted?'🔔':'🔕',p.muted?'إلغاء الكتم':'كتم الإشعارات',()=>_setPref(type,id,{muted:p.muted?null:true}),{sub:p.muted?'':'لن تسمع صوت الرسائل الجديدة'});
    item('🗄',p.archived?'إلغاء الأرشفة':'أرشفة',async()=>{
      await _setPref(type,id,{archived:p.archived?null:Date.now()});
      UI.toast(p.archived?'أُعيدت المحادثة للقائمة':'نُقلت إلى الأرشيف','success');
      if(inChat&&!p.archived)go('home');
    },{sub:p.archived?'':'تعود تلقائياً عند وصول رسالة جديدة (إلا إذا كانت مكتومة)'});
    item('🙈','إخفاء المحادثة ومسحها من عندي',async()=>{
      if(!await UI.confirmDialog('إخفاء المحادثة ومسح رسائلها من عندك فقط؟ لن تتأثر عند الطرف الآخر.',{confirmText:'إخفاء',danger:true}))return;
      await _setPref(type,id,{hiddenAt:Date.now(),pinned:null,archived:null});
      if(isDm&&targetUid)Chat.markRead(Chat.dmKey(S.meUid,targetUid),S.meUid);
      if(!isDm)Chat.markGroupRead(id,S.meUid);
      UI.toast('تم الإخفاء','success');
      if(inChat)go('home');
    });
    if(isDm){
      item('👤','عرض الملف الشخصي',()=>go('userProfile',id));
      item(blocked?'✅':'🚫',blocked?'إلغاء الحظر':'حظر',async()=>{
        if(!targetUid)return UI.toast('المستخدم غير موجود','error');
        if(blocked){const r=await Auth.unblockUser(S.meUid,targetUid);if(r.error)UI.toast(r.error,'error');else UI.toast('تم إلغاء الحظر','success');return;}
        if(!await UI.confirmDialog(`حظر ${id}؟ لن يستطيع مراسلتك أو إرسال طلب صداقة لك.`,{confirmText:'حظر',danger:true}))return;
        const r=await Auth.blockUser(S.meUid,targetUid);
        if(r.error)UI.toast(r.error,'error');else UI.toast('تم الحظر','success');
      },{danger:!blocked});
      item('⚠️','إبلاغ',()=>_openReportSheet(id),{danger:true});
    }else if(g){
      item('ℹ️','معلومات وإدارة المجموعة',()=>{if(!inChat)go('group',id);setTimeout(()=>{S.panel=true;const body=document.getElementById('group-body');if(body&&!document.getElementById('group-panel'))buildGroupPanel(body);},60);});
      item('🚪','مغادرة المجموعة',async()=>{
        if(!await UI.confirmDialog('هل تريد مغادرة المجموعة؟',{confirmText:'مغادرة',danger:true}))return;
        const r=await Groups.leaveGroup(id);
        if(r&&r.error)UI.toast(r.error,'error');else{UI.toast('غادرت المجموعة','info');go('home');}
      },{danger:true});
    }
    ov.appendChild(sheet);UI.attachSheetGestures(ov,sheet,()=>ov.remove());APP.appendChild(ov);
  }

  function _openReportSheet(name){
    const targetUid=_uidByName(name);if(!targetUid)return;
    const ex=document.getElementById('report-sheet');if(ex)ex.remove();
    const ov=UI.el('div','position:fixed;inset:0;z-index:991;display:flex;align-items:flex-end;justify-content:center');ov.id='report-sheet';
    const bg=UI.el('div','position:absolute;inset:0;background:rgba(0,0,0,.55)');bg.addEventListener('click',()=>ov.remove());ov.appendChild(bg);
    const sheet=UI.el('div',`background:${th().card};width:100%;max-width:500px;border-radius:24px 24px 0 0;padding:10px 12px 20px;position:relative;z-index:1;animation:slideUp .22s ease`);sheet.appendChild(UI.el('div',`width:40px;height:4px;background:${th().border};border-radius:2px;margin:4px auto 12px`));
    const h=UI.el('div',`font-weight:800;font-size:15px;color:${th().text};padding:0 8px 8px`);h.textContent='سبب الإبلاغ عن '+name;sheet.appendChild(h);
    (Auth.REPORT_REASONS||[]).forEach(r=>{
      const b=UI.el('button',`width:100%;text-align:right;padding:13px 12px;border:none;background:none;cursor:pointer;border-radius:12px;font-family:inherit;font-size:14px;color:${th().text}`);b.textContent=r;
      b.addEventListener('click',async()=>{ov.remove();const res=await Auth.reportUser(S.meUid,targetUid,r);if(res.error)UI.toast(res.error,'error');else UI.toast('تم إرسال البلاغ، شكراً لك','success');});
      sheet.appendChild(b);
    });
    ov.appendChild(sheet);UI.attachSheetGestures(ov,sheet,()=>ov.remove());APP.appendChild(ov);
  }

  function buildBlockedBar(name){
    const bar=UI.el('div',`background:${th().topbar};border-top:1px solid ${th().border};flex-shrink:0;padding:12px 16px;display:flex;align-items:center;gap:10px`);
    bar.id='chat-input-wrap';
    const t=UI.el('div',`flex:1;font-size:13px;color:${th().text2}`);t.textContent='🚫 قمت بحظر هذا المستخدم';
    const b=UI.el('button','padding:8px 14px;border:none;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer');b.textContent='إلغاء الحظر';
    b.addEventListener('click',async()=>{const u=_uidByName(name);if(!u)return;const r=await Auth.unblockUser(S.meUid,u);if(r.error)UI.toast(r.error,'error');});
    bar.appendChild(t);bar.appendChild(b);return bar;
  }

  /* ── تحويل رسالة إلى محادثة أخرى ───────────────────────── */
  const _FWD_STRIP=['id','sender','ts','status','replyTo','reactions','edited','editedAt','deleted','readBy','delivered','_pending','_tempId','pinned','forwarded'];
  function _openForwardPicker(m){
    if(!m||m.deleted||m.type==='poll')return;
    const ex=document.getElementById('fwd-ov');if(ex)ex.remove();
    const ov=UI.el('div','position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:990;display:flex;align-items:flex-end;justify-content:center');ov.id='fwd-ov';
    const sheet=UI.el('div',`width:100%;max-width:480px;max-height:75vh;display:flex;flex-direction:column;background:${th().card};border-radius:20px 20px 0 0;padding:14px;box-sizing:border-box`);
    const hd=UI.el('div',`display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;color:${th().text};font-weight:800;font-size:15px`);
    const ht=UI.el('span','');ht.textContent='↪️ تحويل إلى...';
    const cl=UI.el('button',`background:none;border:none;font-size:20px;cursor:pointer;color:${th().text3}`);cl.textContent='✕';cl.addEventListener('click',()=>ov.remove());
    hd.appendChild(ht);hd.appendChild(cl);sheet.appendChild(hd);
    const q=UI.el('input',`width:100%;padding:10px 12px;border-radius:12px;border:1.5px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:13px;direction:rtl;box-sizing:border-box;margin-bottom:10px;font-family:inherit`);q.placeholder='بحث...';sheet.appendChild(q);
    const list=UI.el('div','overflow-y:auto;-webkit-overflow-scrolling:touch;flex:1');sheet.appendChild(list);
    const targets=[
      ...myFriends().map(n=>({kind:'dm',name:n,user:_userData(n)})),
      ...myGroups().map(g=>({kind:'group',name:g.name||g.id,id:g.id,photo:g.photo}))
    ];
    let busy=false;
    const send=async t=>{
      if(busy)return;busy=true;
      const payload={};
      Object.keys(m).forEach(k=>{if(!_FWD_STRIP.includes(k)&&k[0]!=='_'&&m[k]!==undefined)payload[k]=m[k];});
      payload.forwarded=true;
      try{
        if(t.kind==='dm'){const tu=_uidByName(t.name);if(!tu)throw new Error('x');await Chat.sendDM(S.meUid,tu,payload);}
        else{
          if(m._enc&&!await UI.confirmDialog('هذه رسالة مشفّرة 🔒 — تحويلها إلى مجموعة سيجعلها غير مشفّرة. متابعة؟',{confirmText:'تحويل'})){busy=false;return;}
          await Chat.sendGroup(t.id,S.meUid,payload);
        }
        ov.remove();UI.toast('تم التحويل ✓','success');
      }catch(e){busy=false;UI.toast('تعذّر التحويل','error');}
    };
    const draw=()=>{
      list.innerHTML='';const f=q.value.trim().toLowerCase();
      const items=targets.filter(t=>!f||String(t.name).toLowerCase().includes(f));
      if(!items.length){const em=UI.el('div',`text-align:center;padding:20px;color:${th().text3};font-size:13px`);em.textContent='لا نتائج';list.appendChild(em);return;}
      items.forEach(t=>{
        const r=UI.el('div',`display:flex;align-items:center;gap:10px;padding:9px 6px;border-bottom:1px solid ${th().border};cursor:pointer`);
        if(t.kind==='dm')r.appendChild(UI.makeAvatar(t.user||{username:t.name},36));
        else{const gi=UI.el('div',`width:36px;height:36px;border-radius:10px;background:${th().card2};display:flex;align-items:center;justify-content:center;overflow:hidden;font-size:18px`);
          if(t.photo){const im=document.createElement('img');im.src=t.photo;im.alt='';im.style.cssText='width:100%;height:100%;object-fit:cover';gi.appendChild(im);}else gi.textContent='👥';r.appendChild(gi);}
        const nm=UI.el('div',`flex:1;font-weight:600;font-size:14px;color:${th().text}`);nm.textContent=t.name;r.appendChild(nm);
        const tag=UI.el('span',`font-size:11px;color:${th().text3}`);tag.textContent=t.kind==='dm'?'خاص':'مجموعة';r.appendChild(tag);
        r.addEventListener('click',()=>send(t));list.appendChild(r);
      });
    };
    q.addEventListener('input',draw);draw();
    ov.addEventListener('click',e=>{if(e.target===ov)ov.remove();});
    ov.appendChild(sheet);APP.appendChild(ov);
  }

  function buildBubble(m, isOpt=false){
    const mine=m.sender===S.meUid||m.sender===S.me;
    const bc=UI.getBubbleColors()[chatId()]||'linear-gradient(135deg,var(--accent),var(--accent2))';
    const isM=['image','video','voice'].includes(m.type);
    const row=UI.el('div','display:flex;align-items:flex-end;gap:6px;margin-bottom:3px;padding:0 2px;animation:fadeUp .2s ease');
    row.setAttribute('data-row-id', m.id);
    row.style.flexDirection=mine?'row-reverse':'row';
    if(isOpt) row.setAttribute('data-temp-id', m._tempId || m.id);

    if(m.deleted){
      const col2=UI.el('div','max-width:78%');
      const del=UI.el('div',`font-size:12px;color:${th().text3};font-style:italic;padding:7px 12px;border-radius:14px;background:${th().bubble};opacity:.7`);
      del.textContent='🚫 تم حذف هذه الرسالة';
      const metaDel=UI.el('div',`font-size:10px;color:${th().text3};margin-top:2px;text-align:${mine?'left':'right'}`);
      metaDel.textContent=UI.fmt(m.ts);
      col2.appendChild(del); col2.appendChild(metaDel); row.appendChild(col2); return row;
    }

    if(!mine){const senderData=_userData(m.sender)||{username:m.sender};row.appendChild(UI.makeAvatar(senderData,28,{onClick:()=>go('userProfile',m.sender)}));}
    const col=UI.el('div','max-width:78%');
    if(!mine&&S.screen==='group'){const sn=UI.el('div',`font-size:10px;color:${UI.userColor(m.sender)};font-weight:700;margin-bottom:2px;padding-right:4px`);sn.textContent=m.sender;col.appendChild(sn);}

    if(m.forwarded){const fl=UI.el('div',`font-size:10px;color:${th().text3};margin-bottom:2px;padding:0 4px`);fl.textContent='↪️ محوّلة';col.appendChild(fl);}
    if(m.replyTo){
      const rp=UI.el('div',`background:${mine?'rgba(255,255,255,.18)':'rgba(59,158,240,.1)'};border-right:3px solid ${mine?'rgba(255,255,255,.7)':'var(--accent)'};border-radius:8px 8px 0 0;padding:5px 9px;font-size:11px;cursor:pointer`);
      const rs=UI.el('div',`font-weight:700;color:${mine?'rgba(255,255,255,.85)':'var(--accent)'};margin-bottom:2px`);
      rs.textContent=m.replyTo.sender===S.me||m.replyTo.sender===S.meUid?'أنت':(_nameByUid(m.replyTo.sender)||m.replyTo.sender);
      const rt=UI.el('div',`color:${mine?'rgba(255,255,255,.7)':th().text2};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px`);
      rt.textContent=m.replyTo.type==='text'?(m.replyTo.text||'').slice(0,60):`[${m.replyTo.type||'وسائط'}]`;
      rp.appendChild(rs); rp.appendChild(rt);
      rp.addEventListener('click',()=>{const orig=document.querySelector(`[data-msg-id="${m.replyTo.id}"]`);if(orig){orig.scrollIntoView({behavior:'smooth',block:'center'});orig.style.outline='2px solid var(--accent)';setTimeout(()=>orig.style.outline='',1200);}});
      col.appendChild(rp);
    }

    const bubRadius=m.replyTo?(mine?'0 18px 4px 18px':'18px 0 18px 18px'):(mine?'18px 18px 4px 18px':'18px 18px 18px 4px');
    const bub=UI.el('div','');
    bub.className='bubble '+(mine?'mine':'theirs');
    bub.style.cssText=`padding:${isM?'5px':'9px 13px'};border-radius:${bubRadius};background:${mine?bc:th().bubble};color:${mine?'#06140b':th().text};font-size:14px;line-height:1.5;box-shadow:${mine?'0 2px 8px rgba(59,158,240,.25)':'0 1px 4px rgba(0,0,0,.08)'}`;
    bub.setAttribute('data-msg-id', m.id);

    if(m.type==='text'){const span=document.createElement('span');span.style.cssText='word-break:break-word;white-space:pre-wrap;line-height:1.55';span.textContent=m.text;bub.appendChild(span);}
    else if(m.type==='image'){const _src=m.url||m.data;const img=document.createElement('img');img.src=_src;img.alt='صورة مرسلة في المحادثة';img.loading='lazy';img.style.cssText='max-width:100%;max-height:220px;border-radius:10px;display:block;cursor:pointer';img.addEventListener('click',()=>{S.viewImg=_src;showImgViewer();});bub.appendChild(img);}
    else if(m.type==='video'){const v=document.createElement('video');v.src=m.url||m.data;v.controls=true;v.playsInline=true;v.style.cssText='max-width:100%;max-height:220px;border-radius:10px;display:block';bub.appendChild(v);}
    else if(m.type==='voice'){const wrap=UI.el('div','display:flex;align-items:center;gap:10px;min-width:160px');const audio=document.createElement('audio');audio.src=m.url||m.data;let playing=false;const pb=UI.el('button','width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;background:rgba(255,255,255,.2);color:#fff;font-size:18px;display:flex;align-items:center;justify-content:center;flex-shrink:0');pb.setAttribute('aria-label','تشغيل الرسالة الصوتية');pb.textContent='▶';pb.addEventListener('click',()=>{if(playing){audio.pause();pb.textContent='▶';playing=false;}else{audio.play().catch(()=>{});pb.textContent='⏸';playing=true;}});audio.addEventListener('ended',()=>{pb.textContent='▶';playing=false;});const info=UI.el('div','flex:1');const lbl=UI.el('div','font-size:12px;opacity:.8');lbl.textContent='رسالة صوتية';const dur=UI.el('div','font-size:10px;opacity:.5');if(m.duration>0)dur.textContent=`${m.duration}ث`;info.appendChild(lbl);info.appendChild(dur);wrap.appendChild(audio);wrap.appendChild(pb);wrap.appendChild(info);const ico=document.createElement('span');ico.textContent='🎙';ico.style.fontSize='20px';wrap.appendChild(ico);bub.appendChild(wrap);}
    else if(m.type==='poll'){const pq=UI.el('div','font-weight:700;font-size:13px;margin-bottom:8px');pq.textContent='📊 '+m.text;bub.appendChild(pq);if(m.pollId){const pvBtn=UI.el('button',`width:100%;padding:6px;border:1px solid ${mine?'rgba(255,255,255,.3)':th().border};border-radius:8px;background:${mine?'rgba(255,255,255,.15)':th().card2};color:${mine?'#06140b':th().text};font-family:inherit;font-size:12px;cursor:pointer`);pvBtn.textContent='عرض الاستطلاع / التصويت';pvBtn.addEventListener('click',()=>showPollOverlay(m.pollId));bub.appendChild(pvBtn);}}

    const metaRow=UI.el('div',`display:flex;align-items:center;gap:4px;justify-content:${mine?'flex-start':'flex-end'};margin-top:3px`);
    if(m.edited){const eb=UI.el('span',`font-size:9px;color:${mine?'rgba(255,255,255,.6)':th().text3};font-style:italic`);eb.textContent='معدّل';metaRow.appendChild(eb);}
    const tsEl=UI.el('span',`font-size:10px;color:${th().text3}`);tsEl.textContent=UI.fmt(m.ts);metaRow.appendChild(tsEl);
    if(mine){const stEl=UI.el('span','font-size:10px');stEl.textContent=' '+_statusText(m);metaRow.appendChild(stEl);}
    col.appendChild(bub); col.appendChild(metaRow);

    if(m.reactions&&Object.keys(m.reactions).length){
      const rxBar=UI.el('div',`display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;justify-content:${mine?'flex-end':'flex-start'}`);
      Chat.parseReactions(m.reactions,S.meUid).forEach(r=>{
        const rb=UI.el('button',`padding:2px 7px;border-radius:12px;border:1px solid ${r.mine?'var(--accent)':th().border};background:${r.mine?'var(--acc22)':th().card2};font-size:13px;cursor:pointer;display:flex;align-items:center;gap:3px`);
        rb.title=r.uids.map(u=>_nameByUid(u)||u).join('، ');
        const em=document.createElement('span');em.textContent=r.emoji;
        const cnt=UI.el('span',`font-size:10px;font-weight:700;color:${r.mine?'var(--accent)':th().text2}`);cnt.textContent=r.count;
        rb.appendChild(em);rb.appendChild(cnt);
        rb.addEventListener('click',()=>{const cP=Chat.msgPath(S.screen,S.screen==='dm'?Chat.dmKey(S.meUid,_uidByName(S.activeId)||S.activeId):S.activeId);if(r.mine)Chat.removeReaction(cP,m.id,S.meUid,r.emoji);else Chat.addReaction(cP,m.id,S.meUid,r.emoji);});
        rxBar.appendChild(rb);
      });
      col.appendChild(rxBar);
    }

    row.appendChild(col);

    let _pressTimer=null;
    const _showCtx=e=>{e.preventDefault();e.stopPropagation();_openContextMenu(m,mine,col);};
    bub.addEventListener('contextmenu',_showCtx);
    bub.addEventListener('touchstart',()=>{_pressTimer=setTimeout(()=>_showCtx({preventDefault:()=>{},stopPropagation:()=>{}}),500);},{passive:true});
    bub.addEventListener('touchend',()=>clearTimeout(_pressTimer));
    bub.addEventListener('touchmove',()=>clearTimeout(_pressTimer));

    // ── نقر مزدوج = تفاعل ❤️ سريع ──
    if(!isOpt && m.id){
      bub.style.touchAction='manipulation';
      const interactive=t=>!!(t&&t.closest&&t.closest('img,video,audio,button,a,input,textarea,[data-no-dbl]'));
      let _lt=0,_lx=0,_ly=0,_mv=false,_sx0=0,_sy0=0,_qr=0;
      bub.addEventListener('touchstart',e=>{const t=e.touches[0];_sx0=t.clientX;_sy0=t.clientY;_mv=false;},{passive:true});
      bub.addEventListener('touchmove',e=>{const t=e.touches[0];if(Math.abs(t.clientX-_sx0)>10||Math.abs(t.clientY-_sy0)>10)_mv=true;},{passive:true});
      bub.addEventListener('touchend',e=>{
        if(_mv||interactive(e.target))return;
        const t=e.changedTouches[0],now=Date.now();
        if(now-_lt<320&&Math.abs(t.clientX-_lx)<30&&Math.abs(t.clientY-_ly)<30){_lt=0;_qr=now;_quickReact(m,bub);}
        else{_lt=now;_lx=t.clientX;_ly=t.clientY;}
      });
      bub.addEventListener('dblclick',e=>{if(interactive(e.target)||Date.now()-_qr<900)return;e.preventDefault();_quickReact(m,bub);});
    }

    // ── إيماءات الرسالة: سحب لليمين = رد، سحب لليسار = تحويل ──
    if(!isOpt && m.id){
      row.style.position='relative'; row.style.touchAction='pan-y';
      const hint=UI.el('div',`position:absolute;top:50%;transform:translateY(-50%) scale(.6);font-size:20px;opacity:0;pointer-events:none;transition:opacity .1s`);
      row.appendChild(hint);
      let sx=0,sy=0,dx=0,mode=null,fired=false;
      const THRESH=64;
      row.addEventListener('touchstart',e=>{
        if(e.touches.length!==1){mode='no';return;}
        sx=e.touches[0].clientX; sy=e.touches[0].clientY; dx=0; mode=null; fired=false;
        if(sx<28||sx>window.innerWidth-28)mode='no'; // حافة الشاشة = رجوع
      },{passive:true});
      row.addEventListener('touchmove',e=>{
        if(mode==='no')return;
        const t=e.touches[0]; const ddx=t.clientX-sx, ddy=t.clientY-sy;
        if(mode===null){
          if(Math.abs(ddy)>12&&Math.abs(ddy)>Math.abs(ddx)){mode='no';return;}
          if(Math.abs(ddx)>12&&Math.abs(ddx)>Math.abs(ddy)*1.5){mode='swipe';col.style.transition='none';}
          else return;
        }
        clearTimeout(_pressTimer);
        dx=Math.max(-90,Math.min(90,ddx));
        col.style.transform=`translateX(${dx*.7}px)`;
        const right=dx>0;
        hint.textContent=right?'↩️':'↪️';
        hint.style.left=right?'8px':'auto'; hint.style.right=right?'auto':'8px';
        const p=Math.min(1,Math.abs(dx)/THRESH);
        hint.style.opacity=String(p); hint.style.transform=`translateY(-50%) scale(${.6+.4*p})`;
        if(Math.abs(dx)>=THRESH&&!fired){fired=true;try{navigator.vibrate&&navigator.vibrate(12);}catch(_){}}
        if(Math.abs(dx)<THRESH)fired=false;
      },{passive:true});
      const endSwipe=()=>{
        if(mode==='swipe'){
          const d=dx;
          col.style.transition='transform .18s ease'; col.style.transform='';
          hint.style.opacity='0';
          if(d>=THRESH){_replyTo={id:m.id,text:m.text,sender:m.sender,type:m.type};_showReplyBar();}
          else if(d<=-THRESH){_openForwardPicker(m);}
        }
        mode=null; dx=0;
      };
      row.addEventListener('touchend',endSwipe);
      row.addEventListener('touchcancel',()=>{col.style.transition='transform .18s ease';col.style.transform='';hint.style.opacity='0';mode=null;dx=0;});
    }

    return row;
  }

  function _closeCtx(){
    ['ctx-menu','rx-picker','ctx-backdrop'].forEach(id=>{const e=document.getElementById(id);if(e)e.remove();});
  }

  function _openContextMenu(m,mine,anchorEl){
    _closeCtx();
    const cPath=Chat.msgPath(S.screen,S.screen==='dm'?Chat.dmKey(S.meUid,_uidByName(S.activeId)||S.activeId):S.activeId);
    const W=window.innerWidth,H=window.innerHeight;
    const backdrop=UI.el('div','position:fixed;inset:0;z-index:979;background:rgba(0,0,0,.32);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);animation:fadeUp .12s ease');
    backdrop.id='ctx-backdrop';backdrop.addEventListener('click',_closeCtx);
    backdrop.addEventListener('touchmove',e=>e.preventDefault(),{passive:false});
    document.body.appendChild(backdrop);

    /* شريط التفاعل: يطفو فوق الرسالة */
    const bar=UI.el('div',`position:fixed;z-index:981;background:${th().card};border:1px solid ${th().border};border-radius:50px;padding:6px 8px;display:flex;gap:2px;box-shadow:0 8px 30px rgba(0,0,0,.28);max-width:${W-16}px`);
    bar.id='rx-picker';
    Chat.ALLOWED_REACTIONS.forEach((emoji,idx)=>{
      const has=!!(m.reactions&&m.reactions[emoji]&&m.reactions[emoji][S.meUid]);
      const b=UI.el('button',`font-size:26px;line-height:1;background:${has?'rgba(59,158,240,.18)':'none'};border:none;cursor:pointer;border-radius:50%;width:42px;height:42px;display:flex;align-items:center;justify-content:center;transition:transform .15s`);
      b.textContent=emoji;b.setAttribute('aria-label','تفاعل '+emoji);
      b.addEventListener('click',()=>{_closeCtx();has?Chat.removeReaction(cPath,m.id,S.meUid,emoji):Chat.addReaction(cPath,m.id,S.meUid,emoji);});
      try{b.animate([{transform:'scale(.3)',opacity:0},{transform:'scale(1.15)',opacity:1},{transform:'scale(1)'}],{duration:240,delay:idx*28,fill:'backwards',easing:'ease-out'});}catch(_){}
      bar.appendChild(b);
    });

    /* قائمة الإجراءات */
    const menu=UI.el('div',`position:fixed;z-index:981;background:${th().card};border:1px solid ${th().border};border-radius:18px;padding:6px;box-shadow:0 10px 36px rgba(0,0,0,.3);min-width:190px`);
    menu.id='ctx-menu';
    [{ico:'↩️',lbl:'رد',fn:()=>{_replyTo={id:m.id,text:m.text,sender:m.sender,type:m.type};_showReplyBar();}},
     {ico:'↪️',lbl:'تحويل',fn:()=>_openForwardPicker(m),show:!m.deleted&&m.type!=='poll'},
     {ico:'📋',lbl:'نسخ',fn:()=>{try{navigator.clipboard.writeText(m.text||'');}catch{}UI.toast('تم النسخ','success');},show:m.type==='text'},
     {ico:'📌',lbl:'تثبيت',fn:async()=>{const res=await Chat.pinMsg(cPath,m,S.meUid);if(res.error)UI.toast(res.error,'error');else UI.toast('تم التثبيت 📌','success');}},
     {ico:'✏️',lbl:'تعديل',fn:()=>{menu.remove();_startEdit(m,cPath);},show:mine&&m.type==='text'&&!m.deleted},
     {ico:'🗑',lbl:'حذف',fn:async()=>{menu.remove();if(!await UI.confirmDialog('حذف هذه الرسالة؟',{confirmText:'حذف',danger:true}))return;const res=await Chat.deleteMsg(cPath,m.id,S.meUid);if(res.error)UI.toast(res.error,'error');},show:mine&&!m.deleted,danger:true},
    ].filter(i=>i.show!==false).forEach(({ico,lbl,fn,danger})=>{
      const btn=UI.el('button',`width:100%;display:flex;align-items:center;gap:12px;padding:11px 14px;border:none;background:none;cursor:pointer;border-radius:12px;font-family:inherit;font-size:14px;color:${danger?'#ef4444':th().text};text-align:right`);
      const ic=document.createElement('span');ic.textContent=ico;ic.style.fontSize='18px';
      const lb=document.createElement('span');lb.textContent=lbl;
      btn.appendChild(ic);btn.appendChild(lb);
      btn.addEventListener('click',()=>{_closeCtx();fn();});
      menu.appendChild(btn);
    });
    document.body.appendChild(bar);document.body.appendChild(menu);
    try{menu.animate([{opacity:0,transform:'scale(.92)'},{opacity:1,transform:'scale(1)'}],{duration:150,easing:'ease-out'});}catch(_){}

    /* التموضع: الشريط فوق الرسالة، والقائمة تحتها (داخل حدود الشاشة) */
    const rect=anchorEl.getBoundingClientRect();
    const vTop=Math.max(rect.top,84),vBot=Math.min(rect.bottom,H-84);
    const bw=bar.offsetWidth,bh=bar.offsetHeight,mw=menu.offsetWidth,mh=menu.offsetHeight;
    const cx=rect.left+rect.width/2;
    bar.style.left=Math.max(8,Math.min(W-bw-8,cx-bw/2))+'px';
    bar.style.top=Math.max(64,vTop-bh-8)+'px';
    let mTop=vBot+8; if(mTop+mh>H-8)mTop=Math.max(64,H-mh-8);
    if(mTop<parseFloat(bar.style.top)+bh+4)mTop=Math.min(H-mh-8,parseFloat(bar.style.top)+bh+8);
    menu.style.top=mTop+'px';
    menu.style.left=Math.max(8,Math.min(W-mw-8,mine?rect.right-mw:rect.left))+'px';
  }

  /* تفاعل سريع ❤️ بالنقر المزدوج على الرسالة */
  function _quickReact(m,bub){
    if(!m||!m.id||m.deleted)return;
    const cPath=Chat.msgPath(S.screen,S.screen==='dm'?Chat.dmKey(S.meUid,_uidByName(S.activeId)||S.activeId):S.activeId);
    const has=!!(m.reactions&&m.reactions['❤️']&&m.reactions['❤️'][S.meUid]);
    has?Chat.removeReaction(cPath,m.id,S.meUid,'❤️'):Chat.addReaction(cPath,m.id,S.meUid,'❤️');
    if(!has){
      const r=bub.getBoundingClientRect();
      const h=UI.el('div',`position:fixed;z-index:985;left:${r.left+r.width/2-20}px;top:${r.top+r.height/2-20}px;font-size:40px;line-height:1;pointer-events:none`);
      h.textContent='❤️';document.body.appendChild(h);
      try{const a=h.animate([{transform:'scale(.2)',opacity:0},{transform:'scale(1.25)',opacity:1,offset:.35},{transform:'translateY(-40px) scale(1)',opacity:0}],{duration:750,easing:'ease-out'});a.onfinish=()=>h.remove();}catch(_){h.remove();}
      setTimeout(()=>h.remove(),1000);
    }
    try{navigator.vibrate&&navigator.vibrate(10);}catch(_){}
  }

  function _startEdit(m,cPath){
    const bubble=document.querySelector(`[data-msg-id="${m.id}"]`);if(!bubble)return;
    const oldSpan=bubble.querySelector('span');
    const editInp=document.createElement('textarea');
    editInp.value=m.text||'';
    editInp.style.cssText='width:100%;background:transparent;border:none;outline:none;color:inherit;font-size:14px;font-family:inherit;resize:none;line-height:1.55;min-height:24px';
    editInp.rows=Math.min(5,Math.ceil((m.text||'').length/35)||1);
    if(oldSpan)bubble.replaceChild(editInp,oldSpan);
    editInp.focus();editInp.select();
    const _save=async()=>{
      const newText=editInp.value.trim();
      if(newText===m.text){if(oldSpan)bubble.replaceChild(oldSpan,editInp);return;}
      const res=await Chat.editMsg(cPath,m.id,S.meUid,newText);
      if(res.error){UI.toast(res.error,'error');if(oldSpan)bubble.replaceChild(oldSpan,editInp);}
      else UI.toast('تم التعديل ✓','success');
    };
    editInp.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();_save();}if(e.key==='Escape'){if(oldSpan)bubble.replaceChild(oldSpan,editInp);}});
    editInp.addEventListener('blur',_save);
  }

  /* ═══════════════════════════════════════════════════════════
     CHAT INPUT — keyboard stays open + instant typing stop
  ═══════════════════════════════════════════════════════════ */
  function buildChatInput(type){
    const wrap=UI.el('div',`background:${th().topbar};border-top:1px solid ${th().border};flex-shrink:0`); wrap.id='chat-input-wrap';
    const cdBar=UI.el('div',`height:2px;background:${th().border};overflow:hidden;display:none`); cdBar.id='cd-bar'; const cdFill=UI.el('div','height:100%;background:var(--accent)'); cdFill.id='cd-fill'; cdBar.appendChild(cdFill); wrap.appendChild(cdBar);

    // v2: reply preview bar
    const replyBar=UI.el('div',`display:none;align-items:center;gap:8px;padding:6px 12px;background:${th().card2};border-bottom:1px solid ${th().border}`);
    replyBar.id='reply-bar';
    const replyIco=UI.el('span','font-size:14px');replyIco.textContent='↩️';
    const replyInfo=UI.el('div','flex:1;min-width:0');
    const replyName=UI.el('div',`font-size:11px;font-weight:700;color:var(--accent)`);
    const replyPrev=UI.el('div',`font-size:12px;color:${th().text2};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`);
    replyInfo.appendChild(replyName);replyInfo.appendChild(replyPrev);
    const replyClose=UI.el('button','background:none;border:none;cursor:pointer;color:#ef4444;font-size:18px;padding:2px');replyClose.textContent='✕';
    replyClose.addEventListener('click',()=>{_replyTo=null;replyBar.style.display='none';});
    replyBar.appendChild(replyIco);replyBar.appendChild(replyInfo);replyBar.appendChild(replyClose);
    wrap.appendChild(replyBar);
    // expose _showReplyBar so context menu can use it
    _showReplyBar = () => {
      if(!_replyTo){replyBar.style.display='none';return;}
      replyName.textContent=_replyTo.sender===S.me||_replyTo.sender===S.meUid?'أنت':(_nameByUid(_replyTo.sender)||_replyTo.sender);
      replyPrev.textContent=_replyTo.type==='text'?(_replyTo.text||'').slice(0,60):`[${_replyTo.type}]`;
      replyBar.style.display='flex';
      document.querySelector('#chat-input-wrap textarea')?.focus();
    };

    // v2: search bar
    const searchBar=UI.el('div',`display:none;align-items:center;gap:8px;padding:6px 12px;background:${th().card2};border-bottom:1px solid ${th().border}`);
    searchBar.id='search-bar';
    const searchInp=UI.el('input',`flex:1;padding:6px 12px;border-radius:20px;border:1.5px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:13px;direction:rtl`);
    searchInp.placeholder='ابحث في الرسائل...';
    searchInp.addEventListener('input',()=>{
      _searchQuery=searchInp.value;
      const results=Chat.searchMessages(S.msgs,_searchQuery);
      const c=document.getElementById('msg-container');if(!c)return;
      c.innerHTML='';
      if(!_searchQuery.trim()){S.msgs.forEach(m=>c.appendChild(buildBubble(m)));return;}
      if(!results.length){const emp=UI.el('div',`color:${th().text3};text-align:center;padding:20px;font-size:13px`);emp.textContent='لا توجد نتائج';c.appendChild(emp);return;}
      results.forEach(m=>{const b=buildBubble(m);b.style.background='rgba(59,158,240,.08)';b.style.borderRadius='10px';c.appendChild(b);});
    });
    const searchClose=UI.el('button','background:none;border:none;cursor:pointer;color:#ef4444;font-size:18px;padding:2px');searchClose.textContent='✕';
    searchClose.addEventListener('click',()=>{_searchMode=false;_searchQuery='';searchBar.style.display='none';searchInp.value='';const c=document.getElementById('msg-container');if(c){c.innerHTML='';S.msgs.forEach(m=>c.appendChild(buildBubble(m)));}});
    searchBar.appendChild(searchInp);searchBar.appendChild(searchClose);
    wrap.appendChild(searchBar);

    const mediaTray=UI.el('div','display:none;padding:10px 12px 0;gap:8px'); mediaTray.id='media-tray';
    const voiceTray=UI.el('div','display:none;padding:14px'); voiceTray.id='voice-tray';
    wrap.appendChild(mediaTray); wrap.appendChild(voiceTray);
    const bar=UI.el('div','display:flex;gap:7px;align-items:center;padding:8px 10px');
    const plusBtn=UI.el('button',`width:40px;height:40px;border:1px solid ${th().inpBorder};border-radius:12px;font-size:20px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;background:${th().card2};color:${th().text3}`); plusBtn.textContent='+';

    // v2: زر البحث
    const srchBtn=UI.el('button',`width:34px;height:34px;border:1px solid ${th().inpBorder};border-radius:10px;font-size:16px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;background:${th().card2};color:${th().text3}`);srchBtn.textContent='🔍';
    srchBtn.addEventListener('click',()=>{_searchMode=!_searchMode;searchBar.style.display=_searchMode?'flex':'none';if(_searchMode)searchInp.focus();});

    const inputEl=document.createElement('textarea');
    inputEl.style.cssText=`flex:1;padding:10px 14px;border-radius:22px;border:1.5px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:14px;direction:rtl;resize:none;overflow:hidden;min-height:40px;max-height:120px;line-height:1.4;font-family:inherit;box-sizing:border-box`;
    inputEl.placeholder=type==='dm'?`رسالة إلى ${S.activeId}...`:`رسالة في ${ag()?.name||''}...`; inputEl.rows=1;
    inputEl.addEventListener('input',()=>{inputEl.style.height='auto';inputEl.style.height=Math.min(inputEl.scrollHeight,120)+'px';});
    const sendBtn=UI.el('button','width:40px;height:40px;border:none;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-size:18px;display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 2px 8px rgba(59,158,240,.4);cursor:pointer'); sendBtn.textContent='←';
    let typTimer=null;

    inputEl.addEventListener('input',()=>{
      const text = inputEl.value;
      if (!text || !text.trim()) {
        clearTimeout(typTimer);
        Chat.setTyping(S.me,chatId(),S.screen,false);
        return;
      }
      Chat.setTyping(S.me,chatId(),S.screen,true);
      clearTimeout(typTimer);
      typTimer=setTimeout(()=>Chat.setTyping(S.me,chatId(),S.screen,false),2500);
    });

    const doSend=()=>{
      const text=inputEl.value.trim(); if(!text)return;
      const now=Date.now(); if(now-_lastSend<SPAM){UI.toast('لا تُرسل بسرعة كبيرة ⏳','warn');return;} _lastSend=now;
      cdBar.style.display='block'; cdFill.style.animation='none'; cdFill.offsetHeight; cdFill.style.animation=`cooldown ${SPAM}ms linear forwards`; setTimeout(()=>cdBar.style.display='none',SPAM);
      inputEl.value=''; inputEl.style.height='40px'; inputEl.focus();
      Chat.setTyping(S.me,chatId(),S.screen,false); clearTimeout(typTimer);
      const tempId='tmp_'+Date.now()+'_'+Math.random().toString(36).slice(2,7);
      // v2: أضف replyTo للـ payload إن وُجد
      const payload={type:'text',text,_tempId:tempId};
      if(_replyTo) payload.replyTo=_replyTo;
      const tempMsg={sender:S.meUid||S.me,ts:Date.now(),id:tempId,...payload,_pending:true};
      // v2: أخفِ reply bar بعد الإرسال
      _replyTo=null; replyBar.style.display='none';
      _seenMsgIds.add(tempId);
      appendMsg({...tempMsg,_isOpt:true});
      _pendingMsgs.set(tempId, {payload, type, retries: 0});

      const sendFn = type==='dm'
        ? () => Chat.sendDM(S.meUid, _uidByName(S.activeId)||S.activeId, payload)
        : () => Chat.sendGroup(S.activeId, S.meUid, payload);

      _trySend(tempId, sendFn);
      UI.playSound('send');
    };

    sendBtn.addEventListener('click',()=>{doSend();inputEl.focus();});
    inputEl.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();doSend();}});
    let trayMode='text';
    plusBtn.addEventListener('click',()=>{
      if(trayMode==='text'){trayMode='media';plusBtn.textContent='✕';plusBtn.style.background='var(--acc22)';plusBtn.style.color='var(--accent)';plusBtn.style.border='1px solid var(--accent)';buildMediaTray(mediaTray,type);mediaTray.style.display='flex';voiceTray.style.display='none';}
      else{trayMode='text';plusBtn.textContent='+';plusBtn.style.background=th().card2;plusBtn.style.color=th().text3;plusBtn.style.border=`1px solid ${th().inpBorder}`;mediaTray.style.display='none';voiceTray.style.display='none';}
    });
    bar.appendChild(plusBtn); bar.appendChild(srchBtn); bar.appendChild(inputEl); bar.appendChild(sendBtn); wrap.appendChild(bar); return wrap;
  }

  /* ── Retry mechanism ─────────────────────────────────────── */
  async function _trySend(tempId, sendFn, maxRetries=3) {
    try {
      await sendFn();
      // If we reach here, message is on the server. The listener will replace optimistic.
    } catch (err) {
      const pending = _pendingMsgs.get(tempId);
      if (!pending) return;
      // رفض صلاحيات (مثلاً الطرف الآخر حظرك): لا فائدة من إعادة المحاولة
      if (err && err.code === 'NOT_ALLOWED') {
        _pendingMsgs.delete(tempId);
        const el = document.querySelector(`[data-temp-id="${tempId}"]`); if (el) el.remove();
        UI.toast('هذا المستخدم يستقبل الرسائل من الأصدقاء فقط', 'error');
        return;
      }
      if (err && (err.code === 'PERMISSION_DENIED' || /permission[_ ]denied/i.test(err.message || ''))) {
        _pendingMsgs.delete(tempId);
        const el = document.querySelector(`[data-temp-id="${tempId}"]`); if (el) el.remove();
        UI.toast('تعذّر الإرسال: لا يمكنك مراسلة هذه المحادثة (قد يكون الطرف الآخر حظرك)', 'error');
        return;
      }
      if (err && err.code === 'E2E_NOT_READY') {
        _pendingMsgs.delete(tempId);
        const el = document.querySelector(`[data-temp-id="${tempId}"]`); if (el) el.remove();
        UI.toast('🔒 التشفير غير جاهز على هذا الجهاز — لم تُرسل الرسالة', 'error');
        return;
      }
      pending.retries++;
      if (pending.retries <= maxRetries) {
        const delay = Math.min(2000 * pending.retries, 10000);
        UI.toast(`إعادة إرسال… (محاولة ${pending.retries})`, 'warn');
        setTimeout(() => _trySend(tempId, sendFn, maxRetries), delay);
      } else {
        UI.toast('فشل إرسال الرسالة','error');
        _pendingMsgs.delete(tempId);
        // Mark bubble as failed
        const opt = document.querySelector(`[data-opt="${S.me}"]`);
        if (opt) {
          const meta = opt.querySelector('.bubble-meta');
          if (meta) meta.textContent = '⚠️ فشل';
        }
      }
    }
  }

  function buildMediaTray(tray,type){
    tray.innerHTML=''; const mkBtn=(ico,lbl,cb)=>{const b=UI.el('button',`flex:1;padding:12px 8px;border:1px solid ${th().border};border-radius:14px;background:${th().card2};color:${th().text};cursor:pointer;font-family:inherit;display:flex;flex-direction:column;align-items:center;gap:3px;font-size:12px`);const ic=document.createElement('span');ic.style.fontSize='26px';ic.textContent=ico;b.appendChild(ic);b.appendChild(document.createTextNode(lbl));b.addEventListener('click',cb);return b;};
    const imgIn=document.createElement('input');imgIn.type='file';imgIn.accept='image/*';imgIn.style.display='none';imgIn.addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;try{const d=await UI.fileToBase64(f);e.target.value='';sendMedia({type:'image',data:d},type);closeTray();}catch(err){UI.toast(err.message||'خطأ في الصورة','error');e.target.value='';}});
    tray.appendChild(mkBtn('🖼','صورة',()=>imgIn.click())); tray.appendChild(imgIn);
    const vidIn=document.createElement('input');vidIn.type='file';vidIn.accept='video/*';vidIn.style.display='none';vidIn.addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;try{const d=await UI.fileToBase64(f,20*1024*1024);e.target.value='';sendMedia({type:'video',data:d},type);closeTray();}catch(err){UI.toast(err.message||'خطأ في الفيديو','error');e.target.value='';}});
    tray.appendChild(mkBtn('🎥','فيديو',()=>vidIn.click())); tray.appendChild(vidIn);
    const vt=document.getElementById('voice-tray'); tray.appendChild(mkBtn('🎙','صوتية',()=>{buildVoiceTray(vt,type);vt.style.display='block';tray.style.display='none';}));
  }

  function closeTray(){const mt=document.getElementById('media-tray');const vt=document.getElementById('voice-tray');if(mt)mt.style.display='none';if(vt)vt.style.display='none';const w=document.getElementById('chat-input-wrap');if(!w)return;const p=w.querySelector('button');if(p){p.textContent='+';p.style.background=th().card2;p.style.color=th().text3;p.style.border=`1px solid ${th().inpBorder}`;}}

  function buildVoiceTray(tray,type){
    tray.innerHTML=''; let recording=false,rec=null,secs=0,rd=null,timer=null;
    const hint=UI.el('p',`color:${th().text2};font-size:13px;margin-bottom:10px;text-align:center`);hint.textContent='اضغط للتسجيل';tray.appendChild(hint);
    const secLbl=UI.el('div','color:#ef4444;font-size:14px;font-weight:600;margin-bottom:10px;text-align:center;display:none');tray.appendChild(secLbl);
    const startBtn=UI.el('button','width:68px;height:68px;border-radius:50%;border:none;cursor:pointer;font-size:28px;color:#fff;display:block;margin:0 auto 10px;box-shadow:0 4px 20px rgba(239,68,68,.4);background:linear-gradient(135deg,#ef4444,#dc2626)');startBtn.textContent='🎙';tray.appendChild(startBtn);
    const btnRow=UI.el('div','display:none;justify-content:center;gap:12px'); const stopBtn=UI.el('button','padding:10px 22px;border:none;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-weight:700;font-family:inherit;cursor:pointer');stopBtn.textContent='⏹ إيقاف';const cancelBtn=UI.el('button',`padding:10px 18px;border:1px solid ${th().border};border-radius:12px;background:${th().card2};color:#ef4444;font-weight:700;font-family:inherit;cursor:pointer`);cancelBtn.textContent='✕';btnRow.appendChild(stopBtn);btnRow.appendChild(cancelBtn);tray.appendChild(btnRow);
    const doneRow=UI.el('div','text-align:center;display:none');const doneLbl=UI.el('div','color:#22c55e;font-size:13px;margin-bottom:10px');doneRow.appendChild(doneLbl);const sendVBtn=UI.el('button','padding:10px 24px;border:none;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-weight:700;font-family:inherit;cursor:pointer;margin-left:8px');sendVBtn.textContent='إرسال ←';const cancelVBtn=UI.el('button',`padding:10px 18px;border:1px solid ${th().border};border-radius:12px;background:${th().card2};color:#ef4444;font-weight:700;font-family:inherit;cursor:pointer`);cancelVBtn.textContent='إلغاء';doneRow.appendChild(sendVBtn);doneRow.appendChild(cancelVBtn);tray.appendChild(doneRow);
    startBtn.addEventListener('click',async()=>{try{const stream=await navigator.mediaDevices.getUserMedia({audio:true});rec=new MediaRecorder(stream);const chunks=[];rec.ondataavailable=e=>chunks.push(e.data);rec.onstop=()=>{stream.getTracks().forEach(x=>x.stop());const b=new Blob(chunks,{type:'audio/webm'});const r=new FileReader();r.onload=()=>{rd={data:r.result,duration:secs};doneLbl.textContent=`✅ ${secs}ث — هل تريد إرسالها؟`;doneRow.style.display='block';};r.readAsDataURL(b);};rec.start();recording=true;secs=0;secLbl.style.display='block';secLbl.textContent='🔴 0ث';startBtn.style.display='none';btnRow.style.display='flex';hint.style.display='none';timer=setInterval(()=>{secs++;secLbl.textContent=`🔴 ${secs}ث`;},1000);}catch{UI.toast('تعذّر الوصول للميكروفون','error');}});
    stopBtn.addEventListener('click',()=>{if(!rec||rec.state==='inactive')return;rec.stop();clearInterval(timer);recording=false;secLbl.style.display='none';btnRow.style.display='none';});
    cancelBtn.addEventListener('click',()=>{if(rec&&rec.state!=='inactive')rec.stop();clearInterval(timer);closeTray();});
    sendVBtn.addEventListener('click',()=>{if(!rd)return;sendMedia({type:'voice',data:rd.data,duration:rd.duration},type);closeTray();});
    cancelVBtn.addEventListener('click',()=>closeTray());
  }

  // v6: يرفع الميديا على Firebase Storage أولاً، بعدين يبعت الرسالة بـ url بدل data الكامل
  async function _dmMode(uid){
    const E=window.E2E; if(!E) return 'plain';
    let pk=null; try{pk=await E.getPeerKey(uid,true);}catch(e){}
    if(!pk) return 'plain';
    return E.isReady()?'enc':'blocked';
  }
  async function sendMedia(payload,type){
    let loaderHide = null;
    try {
      const _t = type==='dm' ? (_uidByName(S.activeId)||S.activeId) : null;
      const mode = type==='dm' ? await _dmMode(_t) : 'plain';
      if (mode==='blocked') { UI.toast('🔒 التشفير غير جاهز على هذا الجهاز — لم يُرسل الملف','error');  return; }
      loaderHide = UI.showOverlayLoader('جار رفع الملف...');
      let finalPayload;
      if (mode==='enc') {
        // محادثة مشفّرة: الملف يُدمج داخل الرسالة المشفّرة (لا يُرفع نصاً صريحاً إلى Storage)
        let data = payload.data;
        if (payload.type==='image') {
          data = await UI.compressDataUrl(data, 1280, 0.8);
          if (data.length > 1500000) data = await UI.compressDataUrl(data, 900, 0.6);
          if (data.length > 1500000) throw new Error('الصورة كبيرة جداً للمحادثات المشفّرة');
        } else if (data.length > 5500000) {
          throw new Error('الملف كبير جداً للمحادثات المشفّرة (الحد الأقصى ≈ 4MB)');
        }
        finalPayload = { type: payload.type, url: data };
      } else {
        const ext = payload.type==='image' ? 'jpg' : payload.type==='video' ? 'mp4' : 'webm';
        const path = FB.storagePath(payload.type+'s', S.meUid, ext);
        try {
          const { url } = await FB.uploadFile(path, payload.data);
          finalPayload = { type: payload.type, url, storagePath: path };
        } catch (upErr) {
          // Storage غير متاح/بطيء: نرسل الملف مضمّناً بالرسالة (بحدود حجم آمنة)
          let data = payload.data;
          if (payload.type==='image') { data = await UI.compressDataUrl(data, 1280, 0.8); if (data.length > 1500000) data = await UI.compressDataUrl(data, 900, 0.6); }
          const lim = payload.type==='video' ? 5500000 : 1500000;
          if (data.length > lim) throw new Error('تعذّر رفع الملف (التخزين غير متاح) والملف كبير للإرسال المباشر');
          finalPayload = { type: payload.type, url: data };
        }
      }
      if (payload.duration) finalPayload.duration = payload.duration;
      if(type==='dm'){await Chat.sendDM(S.meUid,_t,finalPayload);}
      else{await Chat.sendGroup(S.activeId,S.meUid,finalPayload);}
      UI.playSound('send');
    } catch (err) {
      if (err && err.code==='E2E_NOT_READY') { UI.toast('🔒 التشفير غير جاهز — لم يُرسل الملف','error');  }
      else UI.toast('فشل رفع الملف: '+(err.message||'تحقق من الاتصال'),'error');
    } finally {
      if (loaderHide) loaderHide();
    }
  }

  /* ═══════════════════════════════════════════════════════════
     GROUP PANEL  (uid-based, uses groups(1).js)
  ═══════════════════════════════════════════════════════════ */
  function buildGroupPanel(parentEl){
    const ex=document.getElementById('group-panel');if(ex)ex.remove();
    const g=ag()||S.groups[S.activeId];
    if(!g){UI.toast('تعذّر تحميل بيانات المجموعة','error');return;}
    const panel=UI.el('div',`width:230px;flex-shrink:0;overflow-y:auto;background:${th().topbar};border-right:1px solid ${th().border};-webkit-overflow-scrolling:touch`);panel.id='group-panel';
    const hdr=UI.el('div',`padding:12px 14px;font-weight:700;font-size:11px;color:${th().text3};border-bottom:1px solid ${th().border};letter-spacing:1px`);hdr.textContent=Groups.isAdmin(g,S.meUid)?'👑 الإدارة':Groups.isMod(g,S.meUid)?'🛡 المشرف المساعد':'👥 الأعضاء';panel.appendChild(hdr);
    if(Groups.canManage(g,S.meUid)){
      const ctrl=UI.el('div',`padding:10px 14px;border-bottom:1px solid ${th().border}`);
      if(Groups.isAdmin(g,S.meUid)){
        if(!S.groupEdit){const editBtn=UI.el('button',`width:100%;padding:8px;border:1px solid ${th().border};border-radius:10px;background:${th().card2};color:${th().text};font-family:inherit;font-size:12px;cursor:pointer;margin-bottom:8px`);editBtn.textContent='✏️ تعديل المجموعة';editBtn.addEventListener('click',()=>{S.groupEdit=true;S.groupNewName=g.name;buildGroupPanel(parentEl);});ctrl.appendChild(editBtn);
          const isPub=g.privacy==='public';
          const prBtn=UI.el('button',`width:100%;padding:8px;border:1px solid ${th().border};border-radius:10px;background:${th().card2};color:${th().text};font-family:inherit;font-size:12px;cursor:pointer;margin-bottom:8px`);
          prBtn.textContent=isPub?'🌍 عامة — اضغط لجعلها خاصة':'🔒 خاصة — اضغط لجعلها عامة';
          prBtn.addEventListener('click',async()=>{
            const toPub=!isPub;
            if(toPub&&!await UI.confirmDialog('جعل المجموعة عامة؟ أي شخص يملك معرّفها سينضم بدون موافقة.',{confirmText:'جعلها عامة'}))return;
            const r=await Groups.setPrivacy(g.id||S.activeId,toPub?'public':'private');
            if(r.error)UI.toast(r.error,'error');else UI.toast(toPub?'أصبحت المجموعة عامة':'أصبحت المجموعة خاصة','success');
          });
          ctrl.appendChild(prBtn);}
        else{const nameInp=UI.el('input',`width:100%;padding:7px 10px;border:1.5px solid ${th().inpBorder};border-radius:10px;background:${th().inp};color:${th().text};font-size:12px;direction:rtl;box-sizing:border-box;margin-bottom:6px`);nameInp.placeholder='اسم جديد...';nameInp.value=S.groupNewName;nameInp.maxLength=40;nameInp.addEventListener('input',e=>S.groupNewName=e.target.value);ctrl.appendChild(nameInp);const photoRow=UI.el('div','display:flex;gap:4px;margin-bottom:6px;align-items:center');const gPhIn=document.createElement('input');gPhIn.type='file';gPhIn.accept='image/*';gPhIn.style.display='none';gPhIn.addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;try{S.groupNewPhoto=await UI.imageToThumb(f,320);}catch(err){UI.toast(err.message||'تعذّر تحميل الصورة','error');e.target.value='';return;}e.target.value='';buildGroupPanel(parentEl);});const gPhBtn=UI.el('button',`flex:1;padding:6px;border:1px solid ${th().border};border-radius:8px;background:${th().card2};color:${th().text};font-family:inherit;font-size:11px;cursor:pointer`);gPhBtn.textContent='📷 صورة';gPhBtn.setAttribute('aria-label','إضافة صورة للمجموعة');gPhBtn.addEventListener('click',()=>gPhIn.click());photoRow.appendChild(gPhBtn);photoRow.appendChild(gPhIn);if(S.groupNewPhoto){const pv=document.createElement('img');pv.src=S.groupNewPhoto;pv.alt='معاينة صورة المجموعة الجديدة';pv.loading='lazy';pv.style.cssText='width:32px;height:32px;border-radius:6px;object-fit:cover';photoRow.appendChild(pv);}ctrl.appendChild(photoRow);const saveRow=UI.el('div','display:flex;gap:4px');const saveBtn=UI.el('button','flex:1;padding:7px;border:none;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-family:inherit;font-size:11px;cursor:pointer');saveBtn.textContent='حفظ';saveBtn.addEventListener('click',async()=>{await Groups.saveEdit(g.id,S.groupNewName,S.groupNewPhoto);S.groupEdit=false;S.groupNewPhoto=null;UI.toast('تم التعديل ✓','success');buildGroupPanel(parentEl);});const cancelEdit=UI.el('button',`flex:1;padding:7px;border:1px solid ${th().border};border-radius:10px;background:${th().card2};color:${th().text};font-family:inherit;font-size:11px;cursor:pointer`);cancelEdit.textContent='إلغاء';cancelEdit.addEventListener('click',()=>{S.groupEdit=false;S.groupNewPhoto=null;buildGroupPanel(parentEl);});saveRow.appendChild(saveBtn);saveRow.appendChild(cancelEdit);ctrl.appendChild(saveRow);}
        const invT=UI.el('div',`font-size:10px;color:${th().text3};font-weight:700;margin:8px 0 4px;letter-spacing:1px`);invT.textContent='رمز الدعوة';const invC=UI.el('div',`font-family:monospace;font-size:11px;padding:7px 10px;background:${th().card2};border-radius:8px;color:${g.inviteActive?'#22c55e':th().text3};word-break:break-all;margin-bottom:6px;border:1px solid ${th().border}`);invC.textContent=g.inviteActive?g.inviteCode:'🔒 مغلق';const idEl=UI.el('div',`font-size:10px;color:${th().text3};margin-bottom:8px`);idEl.textContent='ID: '; const idSpan=UI.el('span','color:var(--accent);font-family:monospace');idSpan.textContent=g.id;idEl.appendChild(idSpan);const invBtnRow=UI.el('div','display:flex;gap:5px');if(g.inviteActive){const copyBtn=UI.el('button',`flex:1;padding:6px;border:1px solid ${th().border};border-radius:8px;background:${th().card2};color:${th().text2};font-family:inherit;font-size:11px;cursor:pointer`);copyBtn.textContent='نسخ';copyBtn.addEventListener('click',()=>{try{navigator.clipboard.writeText(g.inviteCode);}catch{}copyBtn.textContent='✓ تم';copyBtn.style.background='#f0fdf4';copyBtn.style.color='#22c55e';setTimeout(()=>{copyBtn.textContent='نسخ';copyBtn.style.background=th().card2;copyBtn.style.color=th().text2;},2000);UI.toast('تم نسخ الرمز ✓','success');});invBtnRow.appendChild(copyBtn);}const togBtn=UI.el('button',`flex:1;padding:6px;border:1px solid ${th().border};border-radius:8px;background:${th().card2};color:${g.inviteActive?'#ef4444':'#22c55e'};font-family:inherit;font-size:11px;cursor:pointer`);togBtn.textContent=g.inviteActive?'إغلاق':'فتح';togBtn.addEventListener('click',()=>Groups.toggleInvite(g.id,g.inviteActive));invBtnRow.appendChild(togBtn);const delGBtn=UI.el('button',`width:100%;margin-top:8px;padding:7px;border:1px solid #fecaca;border-radius:10px;background:${UI.isDark()?'#1e1e2e':'#fff'};color:#ef4444;font-family:inherit;font-size:11px;cursor:pointer`);delGBtn.textContent='🗑 حذف المجموعة';delGBtn.addEventListener('click',async()=>{if(!await UI.confirmDialog('هل تريد حذف المجموعة نهائياً؟ لا يمكن التراجع!',{confirmText:'حذف نهائياً',danger:true}))return;const res=await Groups.deleteGroup(g.id);if(res.error)UI.toast(res.error,'error');else{UI.toast('تم حذف المجموعة','info');go('home');}});

        // زر نقل الملكية
        const transferBtn=UI.el('button',`width:100%;margin-top:6px;padding:7px;border:1px solid ${th().border};border-radius:10px;background:${th().card2};color:${th().text2};font-family:inherit;font-size:11px;cursor:pointer`);
        transferBtn.textContent='👑 نقل الملكية';
        transferBtn.addEventListener('click',async()=>{
          const newAdminName=prompt('أدخل اسم المستخدم الذي ستنقل إليه الملكية:');
          if(!newAdminName)return;
          const newAdminUid=_uidByName(newAdminName.trim());
          if(!newAdminUid)return UI.toast('المستخدم غير موجود','error');
          if(!await UI.confirmDialog(`نقل الملكية إلى ${newAdminName}؟`,{confirmText:'نقل',danger:true}))return;
          const res=await Groups.transferAdmin(g.id,newAdminUid);
          if(res.error)UI.toast(res.error,'error');
          else{UI.toast('تم نقل الملكية ✓','success');buildGroupPanel(parentEl);}
        });
        ctrl.appendChild(transferBtn);

        // زر تجديد رمز الدعوة
        const resetInvBtn=UI.el('button',`width:100%;margin-top:6px;padding:7px;border:1px solid ${th().border};border-radius:10px;background:${th().card2};color:#f59e0b;font-family:inherit;font-size:11px;cursor:pointer`);
        resetInvBtn.textContent='🔄 تجديد رمز الدعوة';
        resetInvBtn.addEventListener('click',async()=>{
          if(!await UI.confirmDialog('تجديد الرمز سيُبطل الرمز القديم',{confirmText:'تجديد'}))return;
          const res=await Groups.resetInviteCode(g.id);
          if(res.error)UI.toast(res.error,'error');
          else{UI.toast(`رمز جديد: ${res.newCode}`,'success',5000);buildGroupPanel(parentEl);}
        });
        ctrl.appendChild(resetInvBtn);ctrl.appendChild(invT);ctrl.appendChild(invC);ctrl.appendChild(idEl);ctrl.appendChild(invBtnRow);ctrl.appendChild(delGBtn);
      }
      // Add member by username (groups(1).js converts to uid internally)
      const addRow=UI.el('div','display:flex;gap:5px;margin-top:10px');const addInp=UI.el('input',`flex:1;padding:7px 10px;border:1.5px solid ${th().inpBorder};border-radius:10px;background:${th().inp};color:${th().text};font-size:12px;direction:rtl`);addInp.placeholder='+ إضافة عضو...';const addBtn=UI.el('button','padding:7px 10px;border:none;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-family:inherit;font-size:12px;cursor:pointer');addBtn.textContent='+';const doAdd=async()=>{const res=await Groups.addMember(g.id,addInp.value);if(res.error)UI.toast(res.error,'error');else{UI.toast('تمت الإضافة ✓','success');addInp.value='';UI.playSound('notif');}};addBtn.addEventListener('click',doAdd);addInp.addEventListener('keydown',e=>{if(e.key==='Enter')doAdd();});addRow.appendChild(addInp);addRow.appendChild(addBtn);ctrl.appendChild(addRow);panel.appendChild(ctrl);
    }
    // Pending list (uids → names for display)
    const agP=Groups.getPending(g);if(Groups.canManage(g,S.meUid)&&agP.length>0){const sec=UI.el('div',`padding:8px 14px;border-bottom:1px solid ${th().border}`);const lbl=UI.el('div','font-size:10px;color:#ef4444;font-weight:700;margin-bottom:6px');lbl.textContent=`طلبات (${agP.length})`;sec.appendChild(lbl);agP.forEach(uid=>{const name=_nameByUid(uid)||uid;const row=UI.el('div','display:flex;align-items:center;gap:5px;margin-bottom:6px');row.appendChild(UI.makeAvatar(S.users[uid]||S.usersByName[name],24));const nm=UI.el('span',`flex:1;font-size:12px;color:${th().text};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`);nm.textContent=name;const aBtn=UI.el('button','background:#f0fdf4;border:none;border-radius:6px;padding:4px 7px;cursor:pointer;color:#22c55e;font-size:13px');aBtn.textContent='✓';aBtn.addEventListener('click',async()=>{const res=await Groups.approve(g.id,uid);if(res.error)UI.toast(res.error,'error');else UI.playSound('notif');});const rBtn=UI.el('button','background:#fef2f2;border:none;border-radius:6px;padding:4px 7px;cursor:pointer;color:#ef4444;font-size:13px');rBtn.textContent='✗';rBtn.addEventListener('click',async()=>{const res=await Groups.reject(g.id,uid);if(res.error)UI.toast(res.error,'error');});row.appendChild(nm);row.appendChild(aBtn);row.appendChild(rBtn);sec.appendChild(row);});panel.appendChild(sec);}
    // Members list (uids → names for display)
    const agM=Groups.getMembers(g);const memSec=UI.el('div','padding:8px 14px');const memHdr=UI.el('div',`font-size:10px;color:${th().text3};font-weight:700;margin-bottom:8px;letter-spacing:1px`);memHdr.textContent=`الأعضاء (${agM.length})`;memSec.appendChild(memHdr);
    agM.forEach(uid=>{
      const name=_nameByUid(uid)||uid;
      const isMod=Groups.isMod(g,uid); const isAdm=Groups.isAdmin(g,uid);
      const row=UI.el('div','display:flex;align-items:center;gap:8px;margin-bottom:10px');
      const avBtn=UI.el('button','background:none;border:none;cursor:pointer;padding:0');
      avBtn.appendChild(UI.makeAvatar(S.users[uid]||S.usersByName[name],34,{online:Chat.isOnline(S.presence,uid)}));
      avBtn.addEventListener('click',()=>go('userProfile',name));
      const info=UI.el('div','flex:1;min-width:0');
      const nmBtn=UI.el('button','background:none;border:none;cursor:pointer;padding:0;text-align:right;width:100%');
      const nmEl=UI.el('div',`font-size:12px;font-weight:${isAdm||isMod?700:400};color:${th().text};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`);
      nmEl.textContent=name;
      const roleEl=UI.el('div',`font-size:9px;color:${isAdm?'#f59e0b':isMod?'var(--accent)':Chat.isOnline(S.presence,uid)?'#22c55e':th().text3}`);
      roleEl.textContent=isAdm?'👑 مشرف رئيسي':isMod?'🛡 مشرف مساعد':Chat.isOnline(S.presence,uid)?'متصل':Chat.lastSeenText(S.presence,uid);
      nmBtn.appendChild(nmEl); nmBtn.addEventListener('click',()=>go('userProfile',name)); info.appendChild(nmBtn); info.appendChild(roleEl);
      row.appendChild(avBtn); row.appendChild(info);
      if(Groups.isAdmin(g,S.meUid)&&uid!==S.meUid){
        const acts=UI.el('div','display:flex;gap:3px');
        const modBtn=UI.el('button','background:none;border:none;cursor:pointer;font-size:14px;padding:2px 4px');modBtn.textContent='🛡';modBtn.title=isMod?'إزالة المشرف':'ترقية لمشرف';modBtn.style.color=isMod?'var(--accent)':th().text3;modBtn.addEventListener('click',()=>{Groups.toggleMod(g.id,uid,!!isMod);UI.toast(isMod?'تمت إزالة المشرف':'أصبح مشرفاً مساعداً ✓','success');});
        const kickBtn=UI.el('button','background:none;border:none;cursor:pointer;font-size:14px;padding:2px 4px');kickBtn.textContent='🚫';kickBtn.style.color=th().text3;kickBtn.addEventListener('click',()=>Groups.kick(g.id,uid));
        acts.appendChild(modBtn); acts.appendChild(kickBtn); row.appendChild(acts);
      } else if(Groups.isMod(g,S.meUid)&&!isAdm&&!isMod&&uid!==S.meUid){
        const kickBtn=UI.el('button','background:none;border:none;cursor:pointer;font-size:14px;padding:2px 4px');kickBtn.textContent='🚫';kickBtn.style.color=th().text3;kickBtn.addEventListener('click',()=>Groups.kick(g.id,uid)); row.appendChild(kickBtn);
      }
      memSec.appendChild(row);
    });
    panel.appendChild(memSec);
    // زر المغادرة للأعضاء غير الأدمن
    if(!Groups.isAdmin(g,S.meUid)){
      const lvWrap=UI.el('div',`padding:12px 14px;border-top:1px solid ${th().border}`);
      const lvBtn=UI.el('button','width:100%;padding:9px;border:1px solid #fecaca;border-radius:10px;background:transparent;color:#ef4444;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer');
      lvBtn.textContent='🚪 مغادرة المجموعة';
      lvBtn.addEventListener('click',async()=>{
        if(!await UI.confirmDialog('هل تريد مغادرة المجموعة؟',{confirmText:'مغادرة',danger:true}))return;
        const res=await Groups.leaveGroup(g.id);
        if(res.error){
          if(res.code==='admin_must_transfer'){
            UI.toast('أنت الأدمن — انقل الملكية أولاً أو احذف المجموعة','warn',4000);
          } else { UI.toast(res.error,'error'); }
        } else {UI.toast('غادرت المجموعة','info');go('home');}
      });
      lvWrap.appendChild(lvBtn); panel.appendChild(lvWrap);
    }
    parentEl.appendChild(panel);
  }

  /* ═══════════════════════════════════════════════════════════
     PROFILE
  ═══════════════════════════════════════════════════════════ */
  /* ═══════════════════════════════════════════════
     المنشورات: صور ومقاطع قصيرة على الصفحة الخاصة
     البيانات: userPosts/{uid}/{pid} = { type, url, ts }
     الملفات: Storage (posts/{uid}/...)
  ═══════════════════════════════════════════════ */
  /* ═══════════════════════════════════════════════
     المنشورات: صور (متعددة مع تعديل) أو فيديو واحد
     البيانات: userPosts/{uid}/{pid} = { type, items:[{kind,url}], ts }
     الملفات: Storage (posts/{uid}/...)
  ═══════════════════════════════════════════════ */
  const POST_VIDEO_MAX_SEC = 15;
  const POST_VIDEO_MAX_BYTES = 10 * 1024 * 1024;
  const POST_IMAGE_MAX_BYTES = 12 * 1024 * 1024;
  const POST_MAX_IMAGES = 10;

  function _normPostItems(p){
    if (Array.isArray(p.items) && p.items.length) return p.items;
    return p.url ? [{ kind: p.type === 'video' ? 'video' : 'image', url: p.url }] : [];
  }

  function _postImgLoad(file){
    return new Promise((res, rej) => {
      if (file.size > POST_IMAGE_MAX_BYTES) return rej(new Error('الصورة كبيرة، الحد الأقصى 12MB'));
      const url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => res({ img: im, url });
      im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('تعذّر فتح الصورة، جرّب صورة ثانية')); };
      im.src = url;
    });
  }

  /* يرسم الصورة بعد التدوير والقلب والقص (من المنتصف) */
  function _postDraw(img, o, maxSide){
    const sw = img.naturalWidth, sh = img.naturalHeight;
    const rot = ((o.rot || 0) % 360 + 360) % 360;
    const side = rot === 90 || rot === 270;
    const w = side ? sh : sw, h = side ? sw : sh;
    let cw = w, ch = h;
    if (o.aspect && o.aspect !== 'orig') {
      const [a, b] = o.aspect.split(':').map(Number);
      const t = a / b;
      if (w / h > t) cw = Math.round(h * t); else ch = Math.round(w / t);
    }
    const sc = Math.min(1, maxSide / Math.max(cw, ch));
    const ow = Math.max(1, Math.round(cw * sc)), oh = Math.max(1, Math.round(ch * sc));
    const c = document.createElement('canvas');
    c.width = ow; c.height = oh;
    const x = c.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, ow, oh);
    x.translate(ow / 2, oh / 2);
    x.rotate(rot * Math.PI / 180);
    if (o.flip) x.scale(-1, 1);
    const k = ow / cw;
    x.scale(k, k);
    x.drawImage(img, -sw / 2, -sh / 2, sw, sh);
    return c;
  }

  /* عارض السحب الأفقي (مثل الإنستغرام): صور متعددة مع نقاط وعداد */
  function _buildCarousel(slides, opts = {}){
    const wrap = UI.el('div', `position:relative;width:100%;max-width:${opts.maxW || 480}px;height:${opts.h || '60vh'};background:#000;overflow:hidden;border-radius:${opts.radius || 0}px;direction:ltr`);
    const track = UI.el('div', 'display:flex;flex-direction:row;width:100%;height:100%;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none;direction:ltr');
    slides.forEach(sl => {
      const slide = UI.el('div', 'flex:0 0 100%;width:100%;height:100%;scroll-snap-align:start;display:flex;align-items:center;justify-content:center');
      const m = document.createElement(sl.kind === 'video' ? 'video' : 'img');
      m.src = sl.url;
      m.style.cssText = 'max-width:100%;max-height:100%;display:block;object-fit:contain';
      if (sl.kind === 'video') { m.controls = true; m.playsInline = true; m.preload = 'metadata'; }
      else m.alt = '';
      slide.appendChild(m);
      track.appendChild(slide);
    });
    wrap.appendChild(track);
    if (slides.length > 1) {
      const cnt = UI.el('div', 'position:absolute;top:10px;left:10px;background:rgba(0,0,0,.55);color:#fff;font-size:12px;padding:2px 9px;border-radius:10px;pointer-events:none');
      const dots = UI.el('div', 'position:absolute;bottom:10px;left:0;right:0;display:flex;justify-content:center;gap:5px;pointer-events:none');
      const dotEls = slides.map(() => { const d = UI.el('div', 'width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.45);transition:background .2s'); dots.appendChild(d); return d; });
      const upd = () => {
        const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
        cnt.textContent = `${i + 1}/${slides.length}`;
        dotEls.forEach((d, j) => d.style.background = j === i ? '#fff' : 'rgba(255,255,255,.45)');
      };
      track.addEventListener('scroll', upd, { passive: true });
      upd();
      wrap.appendChild(cnt); wrap.appendChild(dots);
    }
    return wrap;
  }

  /* معاينة قبل النشر — زر نشر يطلب تأكيد */
  function _openPostPreview(slides, onDone){
    const isVid = slides.length === 1 && slides[0].kind === 'video';
    const ov = UI.el('div', 'position:fixed;inset:0;z-index:997;background:#000;display:flex;flex-direction:column;direction:rtl');
    const top = UI.el('div', 'display:flex;align-items:center;justify-content:space-between;padding:12px 14px;color:#fff;font-weight:700;font-size:15px');
    const back = UI.el('button', 'background:none;border:none;color:#fff;font-size:15px;cursor:pointer;font-family:inherit');
    back.textContent = 'رجوع';
    const t = UI.el('span', ''); t.textContent = 'معاينة المنشور';
    const pub = UI.el('button', 'background:none;border:none;color:var(--accent);font-size:15px;font-weight:700;cursor:pointer;font-family:inherit');
    pub.textContent = 'نشر';
    top.appendChild(back); top.appendChild(t); top.appendChild(pub);
    const stage = UI.el('div', 'flex:1;display:flex;align-items:center;justify-content:center;min-height:0;padding:10px;box-sizing:border-box');
    stage.appendChild(_buildCarousel(slides, { h: '72vh' }));
    ov.appendChild(top); ov.appendChild(stage);
    document.body.appendChild(ov);
    const close = () => ov.remove();
    back.addEventListener('click', close);
    pub.addEventListener('click', async () => {
      const what = isVid ? 'المقطع' : (slides.length > 1 ? slides.length + ' صور' : 'الصورة');
      if (!await UI.confirmDialog(`تأكيد نشر ${what} على صفحتك؟`, { confirmText: 'نشر' })) return;
      pub.disabled = true;
      try {
        await _publishPost(slides, (i, n) => { pub.textContent = `${i}/${n}`; });
        UI.toast('تم النشر ✓', 'success');
        close();
        if (onDone) onDone();
      } catch (err) {
        UI.toast(err.message || 'تعذّر النشر، حاول مرة ثانية', 'error');
        pub.disabled = false; pub.textContent = 'نشر';
      }
    });
  }

  async function _publishPost(slides, onProgress){
    const uid = S.meUid;
    if (!uid) throw new Error('سجّل دخولك أولاً');
    const out = [];
    for (let i = 0; i < slides.length; i++) {
      const sl = slides[i];
      if (onProgress) onProgress(i + 1, slides.length);
      const ext = sl.kind === 'video'
        ? (((sl.data.type || 'video/mp4').split('/')[1] || 'mp4').split(';')[0])
        : 'jpg';
      const { url } = await FB.uploadFile(FB.storagePath('posts', uid, ext), sl.data);
      out.push({ kind: sl.kind, url });
    }
    const pid = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const type = out.length > 1 ? 'carousel' : out[0].kind;
    await FB.upd(`userPosts/${uid}`, { [pid]: { type, items: out, ts: Date.now() } });
    return pid;
  }

  /* محرر الصور: قص 1:1 / 4:5 / أصلي، تدوير، قلب، حذف، إضافة (حتى 10) */
  function _openPostEditor(initialFiles, onDone){
    const items = [];
    let cur = 0;
    const ov = UI.el('div', 'position:fixed;inset:0;z-index:996;background:#000;display:flex;flex-direction:column;direction:rtl');
    const top = UI.el('div', 'display:flex;align-items:center;justify-content:space-between;padding:12px 14px;color:#fff;font-weight:700;font-size:15px');
    const cancelB = UI.el('button', 'background:none;border:none;color:#fff;font-size:15px;cursor:pointer;font-family:inherit'); cancelB.textContent = 'إلغاء';
    const ttl = UI.el('span', ''); ttl.textContent = 'تعديل الصور';
    const nextB = UI.el('button', 'background:none;border:none;color:var(--accent);font-size:15px;font-weight:700;cursor:pointer;font-family:inherit'); nextB.textContent = 'التالي';
    top.appendChild(cancelB); top.appendChild(ttl); top.appendChild(nextB);
    const stage = UI.el('div', 'flex:1;display:flex;align-items:center;justify-content:center;min-height:0;padding:8px;box-sizing:border-box');
    const cv = document.createElement('canvas'); cv.style.cssText = 'max-width:100%;max-height:100%;border-radius:8px';
    stage.appendChild(cv);
    const tools = UI.el('div', 'display:flex;gap:8px;overflow-x:auto;padding:10px 12px;justify-content:center');
    const thumbs = UI.el('div', 'display:flex;gap:6px;overflow-x:auto;padding:8px 12px 14px');
    ov.appendChild(top); ov.appendChild(stage); ov.appendChild(tools); ov.appendChild(thumbs);

    const close = () => { items.forEach(it => URL.revokeObjectURL(it.url)); ov.remove(); };
    cancelB.addEventListener('click', close);

    const btn = (label, fn) => {
      const b = UI.el('button', 'flex-shrink:0;padding:8px 12px;border-radius:12px;border:1px solid #333;background:#1a1a1a;color:#fff;font-size:13px;font-family:inherit;cursor:pointer');
      b.textContent = label; b.addEventListener('click', fn); return b;
    };
    const redraw = () => {
      if (!items.length) { cv.width = 1; cv.height = 1; thumbs.innerHTML = ''; return; }
      const c = _postDraw(items[cur].img, items[cur].o, 900);
      cv.width = c.width; cv.height = c.height;
      cv.getContext('2d').drawImage(c, 0, 0);
      paintThumbs();
    };
    const paintThumbs = () => {
      thumbs.innerHTML = '';
      items.forEach((it, i) => {
        const im = document.createElement('img');
        im.src = it.url;
        im.style.cssText = `width:54px;height:54px;object-fit:cover;border-radius:8px;flex-shrink:0;cursor:pointer;border:2px solid ${i === cur ? 'var(--accent)' : 'transparent'}`;
        im.addEventListener('click', () => { cur = i; redraw(); });
        thumbs.appendChild(im);
      });
      if (items.length < POST_MAX_IMAGES) {
        const add = UI.el('button', 'width:54px;height:54px;flex-shrink:0;border-radius:8px;border:1px dashed #555;background:transparent;color:#aaa;font-size:22px;cursor:pointer');
        add.textContent = '+';
        add.addEventListener('click', () => addInp.click());
        thumbs.appendChild(add);
      }
    };
    const loadFiles = async (fl) => {
      for (const f of fl) {
        if (items.length >= POST_MAX_IMAGES) { UI.toast(`الحد الأقصى ${POST_MAX_IMAGES} صور`, 'info'); break; }
        try {
          const { img, url } = await _postImgLoad(f);
          items.push({ img, url, o: { rot: 0, flip: false, aspect: 'orig' } });
        } catch (err) { UI.toast(err.message, 'error'); }
      }
      if (items.length) { cur = Math.min(cur, items.length - 1); redraw(); }
      else close();
    };
    const addInp = document.createElement('input');
    addInp.type = 'file'; addInp.accept = 'image/*'; addInp.multiple = true; addInp.style.display = 'none';
    addInp.addEventListener('change', e => { const fl = [...e.target.files]; e.target.value = ''; if (fl.length) loadFiles(fl); });
    ov.appendChild(addInp);

    const setAsp = a => { if (!items.length) return; items[cur].o.aspect = a; redraw(); };
    const rot = d => { if (!items.length) return; items[cur].o.rot = (items[cur].o.rot + d + 360) % 360; redraw(); };
    const flip = () => { if (!items.length) return; items[cur].o.flip = !items[cur].o.flip; redraw(); };
    const del = () => {
      if (!items.length) return;
      URL.revokeObjectURL(items[cur].url); items.splice(cur, 1);
      if (!items.length) { close(); return; }
      cur = Math.max(0, cur - 1); redraw();
    };
    tools.append(btn('أصلي', () => setAsp('orig')), btn('1:1', () => setAsp('1:1')), btn('4:5', () => setAsp('4:5')),
                 btn('↺', () => rot(-90)), btn('↻', () => rot(90)), btn('⇋ قلب', flip), btn('🗑 حذف', del));

    nextB.addEventListener('click', () => {
      if (!items.length) { UI.toast('اختر صورة واحدة على الأقل', 'info'); return; }
      try {
        const urls = items.map(it => _postDraw(it.img, it.o, 1080).toDataURL('image/jpeg', 0.85));
        _openPostPreview(urls.map(u => ({ kind: 'image', url: u, data: u })), () => { close(); if (onDone) onDone(); });
      } catch (err) { UI.toast('تعذّر تجهيز الصور، جرّب صور ثانية', 'error'); }
    });

    document.body.appendChild(ov);
    if (initialFiles && initialFiles.length) loadFiles(initialFiles);
  }

  /* فيديو واحد — بدون تعديل، فقط معاينة ونشر */
  async function _startVideoPost(file, onDone){
    if (file.size > POST_VIDEO_MAX_BYTES) throw new Error('الفيديو كبير، الحد الأقصى 10MB');
    const url = URL.createObjectURL(file);
    try {
      const dur = await new Promise((res, rej) => {
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.onloadedmetadata = () => res(v.duration);
        v.onerror = () => rej(new Error('تعذّر قراءة الفيديو، جرّب مقطع ثاني'));
        v.src = url;
      });
      if (!(dur <= POST_VIDEO_MAX_SEC + 0.5)) throw new Error('المقطع أطول من 15 ثانية');
    } catch (err) { URL.revokeObjectURL(url); throw err; }
    _openPostPreview([{ kind: 'video', url, data: file }], () => { URL.revokeObjectURL(url); if (onDone) onDone(); });
  }

  function _openPostViewer(p){
    const slides = _normPostItems(p);
    if (!slides.length) return;
    const ov = UI.el('div', 'position:fixed;inset:0;z-index:995;background:rgba(0,0,0,.94);display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box');
    ov.appendChild(_buildCarousel(slides, { h: '80vh', maxW: 480 }));
    ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
    document.body.appendChild(ov);
  }

  function _buildPostsGrid(posts){
    const grid = UI.el('div', 'display:grid;grid-template-columns:repeat(3,1fr);gap:3px');
    Object.entries(posts || {})
      .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0))
      .forEach(([, p]) => {
        const items = _normPostItems(p);
        if (!items.length) return;
        const first = items[0];
        const cell = UI.el('div', `position:relative;aspect-ratio:1/1;overflow:hidden;border-radius:8px;background:${th().card2};cursor:pointer`);
        const m = document.createElement(first.kind === 'video' ? 'video' : 'img');
        m.src = first.url;
        if (first.kind === 'video') { m.muted = true; m.playsInline = true; m.preload = 'metadata'; }
        else m.alt = '';
        m.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';
        cell.appendChild(m);
        if (items.length > 1) {
          const b = UI.el('div', 'position:absolute;top:5px;right:5px;font-size:12px;color:#fff;background:rgba(0,0,0,.55);border-radius:6px;padding:0 5px');
          b.textContent = '⧉';
          cell.appendChild(b);
        }
        if (first.kind === 'video') {
          const b = UI.el('div', 'position:absolute;bottom:5px;left:5px;font-size:11px;color:#fff;background:rgba(0,0,0,.55);border-radius:6px;padding:1px 6px');
          b.textContent = '▶';
          cell.appendChild(b);
        }
        cell.addEventListener('click', () => _openPostViewer(p));
        grid.appendChild(cell);
      });
    return grid;
  }

  /* حذف الحساب — من الإعدادات فقط */
  async function _deleteAccountFlow(){
    if (!await UI.confirmDialog('هل تريد حذف حسابك نهائياً؟', { confirmText: 'حذف الحساب', cancelText: 'إلغاء', danger: true })) return;
    let pwd = '';
    if (Auth.hasPassword()) { pwd = prompt('أدخل كلمة مرورك للتأكيد:'); if (!pwd) return; }
    const dmPartners = Object.keys(S.usersByName)
      .filter(u => u !== S.me)
      .map(u => _uidByName(u))
      .filter(Boolean);
    const res = await Auth.deleteAccount(S.me, pwd, S.groups, dmPartners);
    if (res.error) UI.toast(res.error, 'error');
    else { S.me = null; S.meUid = null; S.usersByName = {}; go('auth'); }
  }

  /* مزامنة الإيميل والرقم العامّين: يُكتبان في users/{uid}/contact فقط إذا لم يُخفيا */
  async function _syncContact(){
    const uid = S.meUid; if (!uid) return;
    const p = { hideEmail:false, hidePhone:false, ...((S.users[uid]||{}).prefs||{}) };
    const contact = {};
    const email = FB.authCurrentUser()?.email;
    if (email && !p.hideEmail) contact.email = email;
    let phone = null;
    try { phone = await FB.get(`userData/${uid}/phone`); } catch {}
    if (phone && !p.hidePhone) contact.phone = phone;
    const val = Object.keys(contact).length ? contact : null;
    await FB.set(`users/${uid}/contact`, val);
    S.users[uid] = { ...(S.users[uid]||{}), contact: val };
    rebuildUserMaps();
  }

  function renderProfile(){
    const meData = S.users[S.meUid] || S.usersByName[S.me] || {};
    APP.appendChild(buildSimpleTopbar('ملفي الشخصي'));
    const scroll=UI.el('div','flex:1;overflow-y:auto;padding:20px;-webkit-overflow-scrolling:touch'); const inner=UI.el('div','max-width:400px;margin:0 auto');
    let ePhoto=meData.photo||null,eEmoji=meData.emoji||'',eBio=meData.bio||'';
    const avSec=UI.el('div','text-align:center;margin-bottom:24px'); const avWrap=UI.el('div','position:relative;display:inline-block'); const avEl=UI.el('div','');
    const rebuildAv=()=>{avEl.innerHTML='';avEl.appendChild(UI.makeAvatar({...meData,photo:ePhoto,emoji:''},96,{online:true}));};rebuildAv();
    const phIn=document.createElement('input');phIn.type='file';phIn.accept='image/*';phIn.style.display='none';phIn.addEventListener('change',async e=>{
  const f=e.target.files[0];if(!f)return;
  try{ePhoto=await UI.fileToBase64(f,3*1024*1024);e.target.value='';rebuildAv();}
  catch(err){UI.toast(err.message||'خطأ في الملف','error');e.target.value='';}
});
    const camBtn=UI.el('button',`position:absolute;bottom:0;left:0;width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));border:2px solid ${th().bg};cursor:pointer;color:#fff;font-size:14px;display:flex;align-items:center;justify-content:center`);camBtn.textContent='📷';camBtn.addEventListener('click',()=>phIn.click());
    avWrap.appendChild(avEl);avWrap.appendChild(camBtn);avWrap.appendChild(phIn);
    const nmEl=UI.el('div',`font-weight:800;font-size:22px;margin-top:12px;color:${th().text}`);nmEl.textContent=S.me;
    const emailEl=UI.el('div',`font-size:12px;color:${th().text3};margin-top:2px`);emailEl.textContent=FB.authCurrentUser()?.email||'';
    const dtEl=UI.el('div',`font-size:12px;color:${th().text3}`);dtEl.textContent=meData.createdAt?`عضو منذ ${new Date(meData.createdAt).toLocaleDateString('ar')}`:'';
    avSec.appendChild(avWrap);avSec.appendChild(nmEl);avSec.appendChild(emailEl);avSec.appendChild(dtEl);inner.appendChild(avSec);
    // معلومات الملف
    const fv={displayName:meData.displayName||'',title:meData.title||'',study:meData.study||'',city:meData.city||''};
    const infoSec=UI.el('div','margin-bottom:16px');
    const mkLbl=t=>{const l=UI.el('label',`font-size:12px;color:${th().text2};font-weight:700;display:block;margin:10px 0 6px`);l.textContent=t;return l;};
    const mkIn=(ph,val,tp)=>{const i=UI.el('input',`width:100%;padding:11px 14px;border-radius:12px;border:1.5px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:14px;direction:rtl;box-sizing:border-box;font-family:inherit`);i.placeholder=ph;i.value=val;i.type=tp||'text';return i;};
    const iName=mkIn('الاسم الذي يظهر للآخرين',fv.displayName); iName.maxLength=40;
    const iTitle=mkIn('مثل: طالب، مختبري، مهتم بالذكاء الاصطناعي',fv.title); iTitle.maxLength=60;
    const iStudy=mkIn('مثل: بكالوريوس تقنيات المختبرات',fv.study); iStudy.maxLength=60;
    const iCity=mkIn('المدينة',fv.city); iCity.maxLength=40;
    const iPhone=mkIn('مثل: 07xxxxxxxxx','','tel'); iPhone.maxLength=20;
    const gSel=document.createElement('select');
    gSel.style.cssText=`width:100%;padding:11px 14px;border-radius:12px;border:1.5px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:14px;direction:rtl;box-sizing:border-box;font-family:inherit`;
    [['','غير محدد'],['male','ذكر'],['female','أنثى']].forEach(([v,l])=>{const o=document.createElement('option');o.value=v;o.textContent=l;if((meData.gender||'')===v)o.selected=true;gSel.appendChild(o);});
    infoSec.appendChild(mkLbl('الاسم')); infoSec.appendChild(iName);
    infoSec.appendChild(mkLbl('العنوان')); infoSec.appendChild(iTitle);
    infoSec.appendChild(mkLbl('الدراسة')); infoSec.appendChild(iStudy);
    infoSec.appendChild(mkLbl('الجنس')); infoSec.appendChild(gSel);
    infoSec.appendChild(mkLbl('المدينة')); infoSec.appendChild(iCity);
    infoSec.appendChild(mkLbl('الرقم (مخفي عن الآخرين إذا فعّلت ذلك من الخصوصية)')); infoSec.appendChild(iPhone);
    FB.get(`userData/${S.meUid}/phone`).then(v=>{ if(v && iPhone.isConnected) iPhone.value=v; }).catch(()=>{});
    inner.appendChild(infoSec);
    // Bio
    const bioSec=UI.el('div','margin-bottom:16px');const bioLbl=UI.el('label',`font-size:12px;color:${th().text2};font-weight:700;display:block;margin-bottom:6px`);bioLbl.textContent='النبذة الشخصية';bioSec.appendChild(bioLbl);const bioInp=UI.el('textarea',`width:100%;padding:11px 14px;border-radius:12px;border:1.5px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:14px;direction:rtl;resize:none;line-height:1.6;box-sizing:border-box`);bioInp.placeholder='اكتب شيئاً عن نفسك...';bioInp.maxLength=120;bioInp.value=eBio;bioInp.rows=2;const bioCnt=UI.el('div',`font-size:10px;color:${th().text3};text-align:left;margin-top:2px`);bioCnt.textContent=`${eBio.length}/120`;bioInp.addEventListener('input',e=>{eBio=e.target.value;bioCnt.textContent=`${eBio.length}/120`;});bioSec.appendChild(bioInp);bioSec.appendChild(bioCnt);inner.appendChild(bioSec);
    // Save
    const saveBtn=UI.el('button',`width:100%;padding:13px;border:none;border-radius:14px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-size:15px;font-weight:700;font-family:inherit;margin-bottom:10px;cursor:pointer;box-shadow:0 4px 14px rgba(59,158,240,.4)`);saveBtn.textContent='حفظ التغييرات ✓';saveBtn.addEventListener('click',async()=>{try{await FB.upd(`users/${S.meUid}`,{bio:eBio.trim(),photo:ePhoto||null,displayName:iName.value.trim()||null,title:iTitle.value.trim()||null,study:iStudy.value.trim()||null,city:iCity.value.trim()||null,gender:gSel.value||null});await FB.set(`userData/${S.meUid}/phone`,iPhone.value.trim()||null);await _syncContact();UI.toast('تم حفظ التغييرات ✓','success');go('home');}catch(e){UI.toast('تعذّر الحفظ، حاول مرة ثانية','error');}});inner.appendChild(saveBtn);
    // المنشورات
    const postsSec=UI.el('div','margin-top:8px;margin-bottom:16px');
    const pHead=UI.el('div','display:flex;align-items:center;justify-content:space-between;margin-bottom:10px');
    const pTitle=UI.el('div',`font-size:12px;color:${th().text2};font-weight:700`); pTitle.textContent='منشوراتي';
    const pBtns=UI.el('div','display:flex;gap:6px');
    const mkPBtn=t=>{const x=UI.el('button',`padding:7px 12px;border:none;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer`);x.textContent=t;return x;};
    const bImg=mkPBtn('+ صور'), bVid=mkPBtn('+ فيديو');
    const iImg=document.createElement('input'); iImg.type='file'; iImg.accept='image/*'; iImg.multiple=true; iImg.style.display='none';
    const iVid=document.createElement('input'); iVid.type='file'; iVid.accept='video/*'; iVid.style.display='none';
    bImg.addEventListener('click',()=>iImg.click());
    bVid.addEventListener('click',()=>iVid.click());
    iImg.addEventListener('change',e=>{const fl=[...e.target.files];e.target.value='';if(fl.length)_openPostEditor(fl,()=>drawPosts());});
    iVid.addEventListener('change',async e=>{const f=e.target.files[0];e.target.value='';if(!f)return;try{await _startVideoPost(f,()=>drawPosts());}catch(err){UI.toast(err.message||'تعذّر تجهيز المقطع','error');}});
    pBtns.appendChild(bImg); pBtns.appendChild(bVid);
    pHead.appendChild(pTitle); pHead.appendChild(pBtns);
    const pGrid=UI.el('div','');
    const drawPosts=async()=>{
      pGrid.innerHTML='';
      let posts={};
      try{ posts=(await FB.get(`userPosts/${S.meUid}`))||{}; }catch(e){}
      if(!Object.keys(posts).length){
        const em=UI.el('div',`text-align:center;color:${th().text3};font-size:13px;padding:26px 10px;border:1px dashed ${th().border};border-radius:14px`);
        em.textContent='لا توجد منشورات بعد، اضغط + صور أو + فيديو';
        pGrid.appendChild(em); return;
      }
      pGrid.appendChild(_buildPostsGrid(posts));
    };
    postsSec.appendChild(pHead); postsSec.appendChild(iImg); postsSec.appendChild(iVid); postsSec.appendChild(pGrid);
    inner.appendChild(postsSec);
    drawPosts();
    scroll.appendChild(inner);APP.appendChild(scroll);
  }

  /* ═══════════════════════════════════════════════════════════
     USER PROFILE
  ═══════════════════════════════════════════════════════════ */
  function renderUserProfile(){
    const u=S.activeId;const userData=_userData(u);
    if(!userData){
      // الملف غير محمّل بعد (أو الاسم غير موجود) → حمّله بدل شاشة فارغة
      APP.appendChild(buildSimpleTopbar(u));
      const ph=UI.el('div',`flex:1;display:flex;align-items:center;justify-content:center;color:${th().text3};font-size:14px;padding:24px;text-align:center`);
      ph.appendChild(UI.spinner(24));
      APP.appendChild(ph);
      _resolveUserByUsername(u).then(r=>{
        if(S.screen!=='userProfile'||S.activeId!==u)return;
        if(r){renderScreen();}
        else{ph.textContent='المستخدم غير موجود';}
      }).catch(()=>{if(S.screen==='userProfile'&&S.activeId===u)ph.textContent='تعذّر تحميل الملف';});
      return;
    }
    APP.appendChild(buildSimpleTopbar(u));
    const scroll=UI.el('div','flex:1;overflow-y:auto;padding:20px;-webkit-overflow-scrolling:touch;text-align:center');const inner=UI.el('div','max-width:400px;margin:0 auto;text-align:center');
    const avWrap=UI.el('div','margin-bottom:14px;display:inline-block;cursor:pointer');
    const uid = _uidByName(u);
    const _uUid = uid || u;
    avWrap.appendChild(UI.makeAvatar(userData,100,{online:Chat.isOnline(S.presence, uid || u),ring:fwsUids().includes(_uUid),seen:Stories.isSeen(_uUid,S.stories)}));
    if(userData.photo)avWrap.addEventListener('click',()=>{S.viewImg=userData.photo;showImgViewer();});inner.appendChild(avWrap);
    const nm=UI.el('div',`font-weight:800;font-size:22px;color:${th().text};margin-bottom:2px`);
    nm.textContent=userData.displayName||u;
    inner.appendChild(nm);
    if(userData.displayName){const un=UI.el('div',`font-size:13px;color:${th().text3};margin-bottom:4px;direction:ltr`);un.textContent='@'+u;inner.appendChild(un);}
    const status=UI.el('div','font-size:13px;margin-bottom:8px');status.textContent=Chat.lastSeenText(S.presence, uid || u);status.style.color=Chat.isOnline(S.presence, uid || u)?'#22c55e':th().text3;inner.appendChild(status);
    if(userData.bio){const bio=UI.el('div',`color:${th().text2};font-size:14px;padding:0 20px;line-height:1.6;margin-bottom:16px`);bio.textContent=userData.bio;inner.appendChild(bio);}
    const dets=[['العنوان',userData.title],['الدراسة',userData.study],['الجنس',({male:'ذكر',female:'أنثى'})[userData.gender]],['المدينة',userData.city]].filter(x=>x[1]);
    const ctc=userData.contact||{};
    if(dets.length||ctc.email||ctc.phone){const dv=UI.el('div',`font-size:13px;color:${th().text2};line-height:1.9;margin-bottom:12px`);dets.forEach(([k,v])=>{const r=UI.el('div','');r.textContent=`${k}: ${v}`;dv.appendChild(r);});if(ctc.email){const r=UI.el('div','direction:ltr');r.textContent=ctc.email;dv.appendChild(r);}if(ctc.phone){const r=UI.el('div','direction:ltr');r.textContent=ctc.phone;dv.appendChild(r);}inner.appendChild(dv);}
    const mf=myFriends();
    if(S.stories[_uUid]&&Object.keys(S.stories[_uUid]).length>0){const stSec=UI.el('div',`margin-bottom:16px;padding:12px;background:${th().card};border-radius:14px;border:1px solid ${th().border}`);const stHdr=UI.el('div',`font-size:12px;color:${th().text2};font-weight:700;margin-bottom:10px`);stHdr.textContent='القصص';stSec.appendChild(stHdr);const stRow=UI.el('div','display:flex;gap:8px;overflow-x:auto;justify-content:center;scrollbar-width:none');Stories.getUserStories(_uUid,S.stories).forEach(s=>{const img=document.createElement('img');img.src=s.url||s.data;img.alt='قصة';img.loading='lazy';img.style.cssText='width:60px;height:80px;object-fit:cover;border-radius:8px;cursor:pointer;border:2px solid var(--accent);flex-shrink:0';img.addEventListener('click',()=>{Stories.markSeen(_uUid);openStoryViewer(_uUid);});stRow.appendChild(img);});stSec.appendChild(stRow);inner.appendChild(stSec);}
    else if(!mf.includes(u)&&u!==S.me&&S.stories[u]&&Object.keys(S.stories[u]).length>0){const locked=UI.el('div',`padding:8px 14px;background:${th().card2};border-radius:10px;color:${th().text3};font-size:12px;border:1px solid ${th().border};margin-bottom:12px`);locked.textContent='🔒 القصص متاحة للأصدقاء فقط';inner.appendChild(locked);}
    const btnRow=UI.el('div','display:flex;gap:8px;margin-top:16px');const msgBtn=UI.el('button','flex:1;padding:10px 16px;border:none;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-weight:700;font-size:14px;font-family:inherit;cursor:pointer');msgBtn.textContent='💬 رسالة';msgBtn.addEventListener('click',()=>go('dm',u));btnRow.appendChild(msgBtn);
    if(!mf.includes(u)&&u!==S.me){const addBtn=UI.el('button',`flex:1;padding:10px 16px;border:1px solid ${th().border};border-radius:12px;background:${th().card2};color:${UI.isDark()?'var(--accent)':'var(--accent)'};font-weight:700;font-size:14px;font-family:inherit;cursor:pointer`);addBtn.textContent='+ صديق';addBtn.addEventListener('click',async()=>{const targetUid2=_uidByName(u);if(!targetUid2)return UI.toast('المستخدم غير موجود','error');const myFriendUids=Object.keys(S.users[S.meUid]?.friends||{});const res=await Friends.sendRequest(S.meUid,targetUid2,S.users,myFriendUids);if(res.error)UI.toast(res.error,'error');else{UI.toast(`تم إرسال طلب صداقة إلى ${u} ✓`,'success');UI.playSound('notif');}});btnRow.appendChild(addBtn);}
    else if(mf.includes(u)){const fr=UI.el('div','flex:1;text-align:center;padding:10px;color:#22c55e;font-size:13px;font-weight:700');fr.textContent='✓ صديق';btnRow.appendChild(fr);}
    inner.appendChild(btnRow);
    // منشورات المستخدم — الحساب الخاص يظهر للأصدقاء فقط
    const isOwnP = u === S.me;
    const pUid = uid || (isOwnP ? S.meUid : null);
    const hiddenP = (userData.prefs||{}).visibility === 'private' && !isOwnP && !mf.includes(u);
    const pSec = UI.el('div','margin-top:18px;text-align:center');
    const pTitle = UI.el('div',`font-size:12px;color:${th().text2};font-weight:700;margin-bottom:10px;text-align:right`);
    pTitle.textContent = 'المنشورات';
    pSec.appendChild(pTitle);
    if (hiddenP) {
      const lk = UI.el('div',`padding:14px;text-align:center;background:${th().card2};border-radius:12px;color:${th().text3};font-size:12px;border:1px solid ${th().border}`);
      lk.textContent = '🔒 الحساب خاص — المنشورات تظهر للأصدقاء فقط';
      pSec.appendChild(lk);
    } else if (!pUid) {
      const em = UI.el('div',`color:${th().text3};font-size:13px;padding:16px 0`);
      em.textContent = 'لا توجد منشورات';
      pSec.appendChild(em);
    } else {
      const pg = UI.el('div','');
      pg.textContent = '';
      const sp = UI.spinner(20); sp.style.margin = '10px auto'; pg.appendChild(sp);
      pSec.appendChild(pg);
      FB.get(`userPosts/${pUid}`).then(posts => {
        if (!pg.isConnected) return;
        pg.innerHTML = '';
        if (!posts || !Object.keys(posts).length) {
          const em = UI.el('div',`color:${th().text3};font-size:13px;padding:16px 0`);
          em.textContent = 'لا توجد منشورات بعد';
          pg.appendChild(em); return;
        }
        pg.appendChild(_buildPostsGrid(posts));
      }).catch(() => {
        if (!pg.isConnected) return;
        pg.innerHTML = '';
        const em = UI.el('div',`color:${th().text3};font-size:13px;padding:16px 0`);
        em.textContent = 'تعذّر تحميل المنشورات';
        pg.appendChild(em);
      });
    }
    inner.appendChild(pSec);
    scroll.appendChild(inner);APP.appendChild(scroll);
  }

  /* ═══════════════════════════════════════════════════════════
     FRIENDS
  ═══════════════════════════════════════════════════════════ */
  function renderFriends(){
    const mf=myFriends();const pr=pendingReqs(); APP.appendChild(buildSimpleTopbar(`الأصدقاء (${mf.length})`));
    const scroll=UI.el('div','flex:1;overflow-y:auto;padding:16px;-webkit-overflow-scrolling:touch');
    if(pr.length){const sec=UI.el('div','margin-bottom:16px');const hdr=UI.el('div','font-size:12px;font-weight:700;color:#ef4444;margin-bottom:8px');hdr.textContent=`طلبات الصداقة الواردة (${pr.length})`;sec.appendChild(hdr);pr.forEach(from=>{const fromName=_nameByUid(from)||from;const row=UI.el('div',`display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:14px;background:${UI.isDark()?'#1e1e2e':'#fff7f7'};border:1px solid #fee2e2;margin-bottom:6px`);row.appendChild(UI.makeAvatar(S.users[from]||S.usersByName[fromName],40));const nm=UI.el('div','flex:1;font-weight:600;font-size:14px');nm.style.color=th().text;nm.textContent=fromName;row.appendChild(nm);const rBtn=UI.el('button',`padding:7px 10px;border:1px solid ${th().border};border-radius:10px;background:${th().card2};color:${th().text2};font-family:inherit;font-size:12px;cursor:pointer;margin-left:4px`);rBtn.textContent='رفض';rBtn.addEventListener('click',async()=>{await Friends.rejectRequest(S.meUid,from);UI.toast('تم رفض الطلب','info');});const aBtn=UI.el('button','padding:7px 12px;border:none;border-radius:10px;background:#22c55e;color:#fff;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer');aBtn.textContent='قبول';aBtn.addEventListener('click',async()=>{await Friends.acceptRequest(S.meUid,from);UI.toast(`أصبحت وصديق ${fromName} ✓`,'success');UI.playSound('notif');});row.appendChild(rBtn);row.appendChild(aBtn);sec.appendChild(row);});scroll.appendChild(sec);}
    const sRow=UI.el('div','display:flex;gap:6px;margin-bottom:14px');const sInp=UI.el('input',`flex:1;padding:11px 14px;border-radius:12px;border:1.5px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:13px;direction:rtl;box-sizing:border-box`);sInp.placeholder='ابحث عن مستخدم لإضافته...';const sBtn=UI.el('button','padding:10px 14px;border:none;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-weight:700;font-family:inherit;font-size:13px;cursor:pointer');sBtn.textContent='+ إضافة';
    const doSearch=async()=>{
      const target=sInp.value.trim();if(!target)return;
      const sugg=await Friends.suggestUsernames(target,S.meUid,8);
      const exact=sugg.find(u=>u.username.toLowerCase()===target.toLowerCase());
      if(!exact&&sugg.length){ // لا يوجد تطابق كامل → اعرض الاقتراحات فقط
        renderSugg(sugg);return UI.toast('اختر اسماً من الاقتراحات','info');
      }
      const exactName=exact?.username||target;
      const rUser=await _resolveUserByUsername(exactName);
      const targetUid=rUser?.uid||null;
      if(!targetUid)return UI.toast('المستخدم غير موجود','error');
      const myFriendUids=Object.keys(S.users[S.meUid]?.friends||{});
      const res=await Friends.sendRequest(S.meUid,targetUid,S.users,myFriendUids);
      if(res.error)UI.toast(res.error,'error');
      else{UI.toast(`تم إرسال طلب صداقة إلى ${exactName} ✓`,'success');UI.playSound('notif');sInp.value='';renderSugg([]);}
    };
    sBtn.addEventListener('click',doSearch);sInp.addEventListener('keydown',e=>{if(e.key==='Enter')doSearch();});
    const sugBox=UI.el('div',`margin-bottom:12px;display:none;background:${th().card};border:1px solid ${th().border};border-radius:12px;overflow:hidden`);sugBox.id='search-result';
    const _friendSet=new Set(Object.keys(S.users[S.meUid]?.friends||{}));
    function renderSugg(list){
      sugBox.innerHTML='';
      if(!list.length){sugBox.style.display='none';return;}
      sugBox.style.display='block';
      list.forEach(it=>{
        const row=UI.el('div',`display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid ${th().border};cursor:pointer`);
        const known=S.users[it.uid]||{username:it.username};
        row.appendChild(UI.makeAvatar({...known,username:it.username},36));
        const nn=UI.el('div',`flex:1;font-weight:600;font-size:14px;color:${th().text};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`);nn.textContent=it.username;row.appendChild(nn);
        if(_friendSet.has(it.uid)){const f=UI.el('span','font-size:12px;color:#22c55e;font-weight:700');f.textContent='✓ صديق';row.appendChild(f);}
        else{const b=UI.el('button','padding:6px 12px;border:none;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer');b.textContent='+ إضافة';
          b.addEventListener('click',e=>{e.stopPropagation();sInp.value=it.username;doSearch();});row.appendChild(b);}
        row.addEventListener('click',()=>{sInp.value=it.username;sInp.focus();});
        sugBox.appendChild(row);
      });
    }
    let _sugTimer=null,_sugSeq=0;
    sInp.addEventListener('input',()=>{
      clearTimeout(_sugTimer);
      const v=sInp.value.trim();
      if(!v){_sugSeq++;renderSugg([]);return;}
      _sugTimer=setTimeout(async()=>{
        const my=++_sugSeq;
        let list=[];try{list=await Friends.suggestUsernames(v,S.meUid,8);}catch(e){}
        if(my!==_sugSeq||!sInp.isConnected)return;
        renderSugg(list);
      },250);
    });

    sRow.appendChild(sInp);sRow.appendChild(sBtn);scroll.appendChild(sRow);scroll.appendChild(sugBox);
    const fHdr=UI.el('div',`font-size:12px;font-weight:700;color:${th().text3};margin-bottom:8px`);fHdr.textContent=`أصدقائي (${mf.length})`;scroll.appendChild(fHdr);
    if(!mf.length){const emp=UI.el('div',`color:${th().text3};font-size:13px;text-align:center;padding:16px 0`);emp.textContent='لم تضف أصدقاء بعد';scroll.appendChild(emp);}
    mf.forEach(fr=>{const frUid=_uidByName(fr);const row=UI.el('div',`display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:14px;cursor:pointer;background:${th().card};border:1px solid ${th().border};margin-bottom:6px`);row.appendChild(UI.makeAvatar(_userData(fr),40,{online:Chat.isOnline(S.presence,frUid||fr)}));const info=UI.el('div','flex:1;min-width:0');const nm=UI.el('div',`font-weight:600;color:${th().text};font-size:14px`);nm.textContent=fr;const st=UI.el('div',`font-size:11px;color:${Chat.isOnline(S.presence,frUid||fr)?'#22c55e':th().text3}`);st.textContent=Chat.lastSeenText(S.presence,frUid||fr);info.appendChild(nm);info.appendChild(st);row.appendChild(info);const msgBtn=UI.el('button','padding:7px 12px;border:none;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer');msgBtn.textContent='رسالة';msgBtn.addEventListener('click',()=>go('dm',fr));row.appendChild(msgBtn);const viewBtn=UI.el('button',`padding:7px 10px;border:1px solid ${th().border};border-radius:10px;background:${th().card2};color:${th().text2};font-family:inherit;font-size:12px;cursor:pointer`);viewBtn.textContent='عرض';viewBtn.addEventListener('click',()=>go('userProfile',fr));row.appendChild(viewBtn);const remBtn=UI.el('button','background:none;border:none;cursor:pointer;font-size:18px;padding:4px 6px');remBtn.textContent='✕';remBtn.style.color=th().text3;remBtn.addEventListener('click',async()=>{if(!await UI.confirmDialog(`هل تريد إزالة ${fr} من الأصدقاء؟`,{confirmText:'إزالة',danger:true}))return;if(!frUid)return UI.toast('خطأ: المستخدم غير موجود','error');const res=await Friends.removeFriend(S.meUid,frUid);if(res.error)UI.toast(res.error,'error');else UI.toast('تمت الإزالة','info');});row.appendChild(remBtn);scroll.appendChild(row);});
    APP.appendChild(scroll);
  }

  /* ═══════════════════════════════════════════════════════════
     NEW GROUP / JOIN  (DOM-safe, no innerHTML)
  ═══════════════════════════════════════════════════════════ */
  function renderNewGroup(){
    APP.appendChild(buildSimpleTopbar('مجموعة جديدة'));
    const cnt=UI.el('div','flex:1;overflow-y:auto;padding:20px 24px;-webkit-overflow-scrolling:touch');
    const inner=UI.el('div','width:100%;max-width:380px;margin:0 auto;text-align:center');
    const st={photo:null,privacy:'private'};

    // صورة المجموعة
    const phWrap=UI.el('div','display:inline-block;position:relative;margin-bottom:6px;cursor:pointer');
    const phCircle=UI.el('div',`width:96px;height:96px;border-radius:28px;background:${th().card2};border:2px dashed ${th().border};display:flex;align-items:center;justify-content:center;font-size:38px;overflow:hidden`);
    phCircle.textContent='👥';
    const phBadge=UI.el('div','position:absolute;bottom:-4px;left:-4px;width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;display:flex;align-items:center;justify-content:center;font-size:15px;box-shadow:0 2px 8px rgba(0,0,0,.25)');
    phBadge.textContent='📷';
    phWrap.appendChild(phCircle);phWrap.appendChild(phBadge);
    const phIn=document.createElement('input');phIn.type='file';phIn.accept='image/*';phIn.style.display='none';
    phIn.addEventListener('change',async e=>{
      const f=e.target.files[0];if(!f)return;
      try{
        st.photo=await UI.imageToThumb(f,320);
        phCircle.textContent='';phCircle.style.border='2px solid transparent';
        const im=document.createElement('img');im.src=st.photo;im.alt='صورة المجموعة';im.style.cssText='width:100%;height:100%;object-fit:cover';phCircle.appendChild(im);
        rmPh.style.display='inline-block';
      }catch(err){UI.toast(err.message||'تعذّر تحميل الصورة','error');}
      e.target.value='';
    });
    phWrap.addEventListener('click',()=>phIn.click());
    inner.appendChild(phWrap);inner.appendChild(phIn);
    const rmPh=UI.el('button',`display:none;background:none;border:none;color:#ef4444;font-family:inherit;font-size:12px;cursor:pointer;margin:0 0 6px`);rmPh.textContent='إزالة الصورة';
    rmPh.addEventListener('click',()=>{st.photo=null;phCircle.textContent='👥';phCircle.style.border=`2px dashed ${th().border}`;rmPh.style.display='none';});
    const phWrap2=UI.el('div','margin-bottom:14px');phWrap2.appendChild(rmPh);inner.appendChild(phWrap2);

    const inpCss=`width:100%;padding:11px 14px;border-radius:12px;border:1.5px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:14px;direction:rtl;box-sizing:border-box;margin-bottom:12px;font-family:inherit`;
    const inp=UI.el('input',inpCss);inp.placeholder='اسم المجموعة...';inp.maxLength=40;
    const desc=UI.el('textarea',inpCss+';resize:none;height:76px');desc.placeholder='وصف المجموعة (اختياري)';desc.maxLength=200;
    inner.appendChild(inp);inner.appendChild(desc);

    // نوع المجموعة
    const pLbl=UI.el('div',`font-size:12px;font-weight:700;color:${th().text3};text-align:right;margin-bottom:8px`);pLbl.textContent='نوع المجموعة';inner.appendChild(pLbl);
    const opts=UI.el('div','display:flex;gap:8px;margin-bottom:8px');
    const mkOpt=(val,icon,title,sub)=>{
      const b=UI.el('button','');b.type='button';
      b.appendChild(Object.assign(UI.el('div','font-size:24px;margin-bottom:4px'),{textContent:icon}));
      b.appendChild(Object.assign(UI.el('div','font-weight:700;font-size:13px;margin-bottom:2px'),{textContent:title}));
      b.appendChild(Object.assign(UI.el('div','font-size:11px;line-height:1.5;opacity:.8'),{textContent:sub}));
      b.dataset.val=val;opts.appendChild(b);return b;
    };
    const oPriv=mkOpt('private','🔒','خاصة','الانضمام بطلب موافقة أو برمز الدعوة');
    const oPub=mkOpt('public','🌍','عامة','أي شخص ينضم مباشرة عبر معرّف المجموعة');
    const paint=()=>{[oPriv,oPub].forEach(b=>{const on=b.dataset.val===st.privacy;
      b.style.cssText=`flex:1;padding:12px 8px;border-radius:14px;cursor:pointer;font-family:inherit;text-align:center;color:${on?'#fff':th().text};background:${on?'linear-gradient(135deg,var(--accent),var(--accent2))':th().card2};border:1.5px solid ${on?'transparent':th().border}`;});
      note.textContent=st.privacy==='public'?'⚠️ المجموعة العامة: كل من يملك المعرّف يدخلها دون موافقة.':'';};
    const note=UI.el('div','font-size:11px;color:#f59e0b;text-align:right;min-height:16px;margin-bottom:12px');
    [oPriv,oPub].forEach(b=>b.addEventListener('click',()=>{st.privacy=b.dataset.val;paint();}));
    inner.appendChild(opts);inner.appendChild(note);paint();

    const btn2=UI.el('button','width:100%;padding:13px;border:none;border-radius:14px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer');btn2.textContent='إنشاء ←';
    const hint=UI.el('p','font-size:12px;margin-top:12px');hint.style.color=th().text3;hint.textContent='ستكون المشرف الرئيسي تلقائياً — ويمكنك تغيير كل هذه الإعدادات لاحقاً';
    let _creating=false;
    const doCreate=async()=>{
      if(_creating)return;
      if(!inp.value.trim()){UI.toast('أدخل اسم المجموعة','error');inp.focus();return;}
      _creating=true;
      const restore=UI.btnLoading(btn2,'جار الإنشاء...');
      const res=await Groups.create(S.me,inp.value,{description:desc.value,photo:st.photo,privacy:st.privacy});
      _creating=false; restore();
      if(res.error)UI.toast(res.error,'error');
      else{UI.toast('تم إنشاء المجموعة ✓','success');
      if (res.gid) _openGroupListener(res.gid);
      S.tab='groups'; go('home');}};
    btn2.addEventListener('click',doCreate);inp.addEventListener('keydown',e=>{if(e.key==='Enter')doCreate();});
    inner.appendChild(btn2);inner.appendChild(hint);cnt.appendChild(inner);APP.appendChild(cnt);setTimeout(()=>inp.focus(),100);
  }

  function renderJoin(){
    APP.appendChild(buildSimpleTopbar('الانضمام لمجموعة'));
    const cnt=UI.el('div','flex:1;display:flex;align-items:center;justify-content:center;padding:24px');const inner=UI.el('div','width:100%;max-width:360px;text-align:center');
    const icon=UI.el('div','font-size:52px;margin-bottom:14px'); icon.textContent='🔗';
    const title=UI.el('h2','font-weight:800;font-size:20px;margin-bottom:8px');title.style.color=th().text; title.textContent='الانضمام لمجموعة';
    const sub=UI.el('p','font-size:13px;margin-bottom:20px');sub.style.color=th().text3; sub.textContent='أدخل رمز الدعوة أو معرّف المجموعة';
    inner.appendChild(icon); inner.appendChild(title); inner.appendChild(sub);
    const inp=UI.el('input',`width:100%;padding:11px 14px;border-radius:12px;border:1.5px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:14px;direction:rtl;box-sizing:border-box;margin-bottom:12px`);inp.placeholder='ادخل الرمز...';
    const errBox=UI.el('div','padding:9px 14px;border-radius:10px;font-size:13px;font-weight:600;margin-bottom:12px;display:none');
    const showErr=(msg,ok=false)=>{errBox.textContent=msg;errBox.style.display='block';errBox.style.background=ok?'#f0fdf4':'#fef2f2';errBox.style.color=ok?'#22c55e':'#ef4444';};
    let _joining=false;
    const btnRow=UI.el('div','display:flex;gap:8px');const invBtn=UI.el('button','flex:1;padding:10px 16px;border:none;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-weight:700;font-size:13px;font-family:inherit;cursor:pointer');invBtn.textContent='انضمام برمز';invBtn.addEventListener('click',async()=>{if(_joining)return;_joining=true;const restore=UI.btnLoading(invBtn,'...');const res=await Groups.joinByInvite(S.me,inp.value);_joining=false;restore();if(res.error)showErr(res.error);else{if(res.gid)_openGroupListener(res.gid);go('group',res.gid);}});
    const reqBtn=UI.el('button',`flex:1;padding:10px 16px;border:1px solid ${th().border};border-radius:12px;background:${th().card2};color:${UI.isDark()?'var(--accent)':'var(--accent)'};font-weight:700;font-size:13px;font-family:inherit;cursor:pointer`);reqBtn.textContent='انضمام بالمعرّف';reqBtn.addEventListener('click',async()=>{if(_joining)return;_joining=true;const restore=UI.btnLoading(reqBtn,'...');const pj=await Groups.joinPublic(S.me,inp.value);if(pj.ok){_joining=false;restore();_openGroupListener(pj.gid);go('group',pj.gid);return;}const res=await Groups.requestJoin(S.me,inp.value);_joining=false;restore();if(res.error)showErr(res.error);else showErr('✅ تم إرسال الطلب!',true);});
    btnRow.appendChild(invBtn);btnRow.appendChild(reqBtn);inner.appendChild(inp);inner.appendChild(errBox);inner.appendChild(btnRow);cnt.appendChild(inner);APP.appendChild(cnt);setTimeout(()=>inp.focus(),100);
  }

  /* ═══════════════════════════════════════════════════════════
     OVERLAYS
  ═══════════════════════════════════════════════════════════ */
  /* ── Poll Overlay (v2) ───────────────────────────────────── */
  function showPollOverlay(pollId){
    const gid=S.activeId; if(!gid||!pollId) return;
    const ex=document.getElementById('poll-ov');if(ex)ex.remove();
    const ov=UI.el('div','position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:992;display:flex;align-items:flex-end;justify-content:center');
    ov.id='poll-ov';
    const sheet=UI.el('div',`background:${th().card};width:100%;max-width:500px;border-radius:20px 20px 0 0;padding:24px;max-height:80vh;overflow-y:auto`);
    const handle=UI.el('div',`width:40px;height:4px;background:${th().border};border-radius:2px;margin:0 auto 16px`);sheet.appendChild(handle);
    const title=UI.el('div',`font-weight:800;font-size:16px;margin-bottom:16px;color:${th().text}`);title.textContent='📊 الاستطلاع';sheet.appendChild(title);
    const loading=UI.el('div',`color:${th().text2};font-size:13px`);loading.textContent='جار التحميل...';sheet.appendChild(loading);
    ov.addEventListener('click',e=>{if(e.target===ov)ov.remove();});
    ov.appendChild(sheet);UI.attachSheetGestures(ov,sheet,()=>ov.remove());APP.appendChild(ov);
    Groups.getPoll(gid,pollId).then(poll=>{
      loading.remove();
      if(!poll){const err=UI.el('div',`color:#ef4444`);err.textContent='الاستطلاع غير موجود';sheet.appendChild(err);return;}
      const q=UI.el('div',`font-weight:700;font-size:15px;color:${th().text};margin-bottom:16px`);q.textContent=poll.question;sheet.appendChild(q);
      const totalVotes=Object.keys(poll.votes||{}).length;
      const myVote=poll.votes?.[S.meUid];
      const results=Groups.parsePollResults(poll);
      results.forEach(opt=>{
        const row=UI.el('div',`margin-bottom:10px`);
        const optBtn=UI.el('button',`width:100%;text-align:right;padding:10px 14px;border-radius:12px;border:2px solid ${myVote===opt.index?'var(--accent)':th().border};background:${myVote===opt.index?'var(--acc22)':th().card2};color:${th().text};font-family:inherit;font-size:14px;cursor:pointer;position:relative;overflow:hidden`);
        const fillBar=UI.el('div',`position:absolute;top:0;right:0;height:100%;background:var(--acc11);border-radius:10px;transition:width .4s`);fillBar.style.width=`${opt.percent}%`;
        const optTxt=UI.el('span','position:relative;z-index:1');optTxt.textContent=opt.text;
        const optPct=UI.el('span',`position:absolute;left:12px;top:50%;transform:translateY(-50%);font-size:11px;font-weight:700;color:var(--accent);z-index:1`);optPct.textContent=`${opt.percent}%`;
        optBtn.appendChild(fillBar);optBtn.appendChild(optTxt);optBtn.appendChild(optPct);
        if(!poll.closed){optBtn.addEventListener('click',async()=>{await Groups.vote(gid,pollId,S.meUid,opt.index);ov.remove();showPollOverlay(pollId);});}
        row.appendChild(optBtn);sheet.appendChild(row);
      });
      const meta=UI.el('div',`font-size:11px;color:${th().text3};margin-top:12px`);meta.textContent=`${totalVotes} صوت${poll.closed?' · مغلق':''}`;sheet.appendChild(meta);
      if(poll.createdBy===S.meUid&&!poll.closed){const closeBtn=UI.el('button',`margin-top:10px;padding:8px 16px;border:1px solid #fecaca;border-radius:10px;background:transparent;color:#ef4444;font-family:inherit;font-size:12px;cursor:pointer`);closeBtn.textContent='إغلاق الاستطلاع';closeBtn.addEventListener('click',async()=>{await Groups.closePoll(gid,pollId);ov.remove();UI.toast('تم إغلاق الاستطلاع','info');});sheet.appendChild(closeBtn);}
    });
  }

  function showImgViewer(){const ex=document.getElementById('img-viewer');if(ex)ex.remove();const ov=UI.el('div','position:fixed;inset:0;background:rgba(0,0,0,.94);z-index:1000;display:flex;align-items:center;justify-content:center');ov.id='img-viewer';const img=document.createElement('img');img.src=S.viewImg;img.alt='عرض الصورة بالحجم الكامل';img.style.cssText='max-width:96vw;max-height:88vh;object-fit:contain;border-radius:10px';img.addEventListener('click',e=>e.stopPropagation());const closeBtn=UI.el('button','position:absolute;top:14px;right:14px;background:rgba(255,255,255,.15);border:none;color:#fff;font-size:22px;cursor:pointer;border-radius:50%;width:40px;height:40px;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)');closeBtn.textContent='✕';closeBtn.setAttribute('aria-label','إغلاق');closeBtn.addEventListener('click',()=>ov.remove());ov.addEventListener('click',()=>ov.remove());ov.appendChild(img);ov.appendChild(closeBtn);APP.appendChild(ov);}

  function showStoryPreview(){const ex=document.getElementById('story-preview-ov');if(ex)ex.remove();const ov=UI.el('div','position:fixed;inset:0;background:rgba(0,0,0,.96);z-index:998;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px');ov.id='story-preview-ov';const img=document.createElement('img');img.src=S.storyPreview;img.alt='معاينة القصة قبل النشر';img.style.cssText='max-width:90vw;max-height:65vh;object-fit:contain;border-radius:14px';ov.appendChild(img);const btnRow=UI.el('div','display:flex;gap:10px');const postBtn=UI.el('button','padding:11px 24px;border:none;border-radius:14px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-weight:700;font-size:15px;font-family:inherit;cursor:pointer');postBtn.textContent='نشر القصة 📢';postBtn.addEventListener('click',async()=>{
  if(!S.meUid){UI.toast('يجب تسجيل الدخول أولاً','error');return;}
  postBtn.disabled=true; postBtn.textContent='جار النشر...';
  let _pr;try{_pr=await Stories.post(S.meUid,S.storyPreview);}catch(e){_pr={error:'فشل نشر القصة: '+(e&&e.message||'')};}
  if(_pr&&_pr.error){UI.toast(_pr.error,'error');postBtn.disabled=false;postBtn.textContent='نشر القصة 📢';return;}
  S.storyPreview=null;ov.remove();UI.toast('تم نشر القصة ✓','success');
});const cancelBtn=UI.el('button',`padding:11px 20px;border:1px solid rgba(255,255,255,.2);border-radius:14px;background:transparent;color:#fff;font-family:inherit;font-size:15px;cursor:pointer`);cancelBtn.textContent='إلغاء';cancelBtn.addEventListener('click',()=>{S.storyPreview=null;ov.remove();});btnRow.appendChild(postBtn);btnRow.appendChild(cancelBtn);ov.appendChild(btnRow);APP.appendChild(ov);}

  function openStoryViewer(initialUser){
    const ex=document.getElementById('story-viewer-ov');if(ex)ex.remove();
    const allUsers=[...(S.stories[S.meUid]&&Object.keys(S.stories[S.meUid]).length?[S.meUid]:[]),...fwsUids()];
    if(!allUsers.length)return;
    let uIdx=Math.max(0,allUsers.indexOf(initialUser)),sIdx=0,progress=0,timer=null;
    const ov=UI.el('div','position:fixed;inset:0;background:#000;z-index:999;display:flex;flex-direction:column');ov.id='story-viewer-ov';
    const renderSV=()=>{
      ov.innerHTML='';const curUser=allUsers[uIdx];const stArr=Stories.getUserStories(curUser,S.stories);if(!stArr.length){ov.remove();return;}const curStory=stArr[Math.min(sIdx,stArr.length-1)];
      const prog=UI.el('div','position:absolute;top:0;left:0;right:0;z-index:2;display:flex;gap:3px;padding:10px 12px 6px');
      stArr.forEach((_,i)=>{const bar=UI.el('div','flex:1;height:3px;background:rgba(255,255,255,.3);border-radius:2px;overflow:hidden');const fill=UI.el('div','height:100%;background:#fff;border-radius:2px');fill.id=`prog-fill-${i}`;fill.style.width=i<sIdx?'100%':i===sIdx?`${progress}%`:'0%';bar.appendChild(fill);prog.appendChild(bar);});ov.appendChild(prog);
      const hdr=UI.el('div','position:absolute;top:22px;left:0;right:0;z-index:2;padding:0 12px;display:flex;align-items:center;gap:8px');const _curName=curUser===S.meUid?S.me:(_nameByUid(curUser)||curUser); hdr.appendChild(UI.makeAvatar(_userData(_curName),36,{online:Chat.isOnline(S.presence,curUser)}));const info=UI.el('div','flex:1');const nm=UI.el('div','color:#fff;font-weight:700;font-size:14px');nm.textContent=curUser===S.meUid?S.me:(_nameByUid(curUser)||curUser);const ts=UI.el('div','color:#aaa;font-size:11px');ts.textContent=UI.fmtFull(curStory.ts);info.appendChild(nm);info.appendChild(ts);hdr.appendChild(info);
      if(curUser===S.me||curUser===S.meUid){const delBtn=UI.el('button','background:rgba(239,68,68,.25);border:none;color:#ef4444;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:12px;font-family:inherit');delBtn.textContent='🗑 حذف';delBtn.addEventListener('click',async()=>{await Stories.deleteStory(S.meUid||S.me,curStory.sid);UI.toast('تم حذف القصة','info');ov.remove();});hdr.appendChild(delBtn);}
      const closeBtn=UI.el('button','background:rgba(255,255,255,.1);border:none;color:#fff;border-radius:50%;width:32px;height:32px;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center');closeBtn.textContent='✕';closeBtn.addEventListener('click',()=>{clearInterval(timer);ov.remove();});hdr.appendChild(closeBtn);ov.appendChild(hdr);
      const img=document.createElement('img');img.src=curStory.url||curStory.data;img.alt='قصة';img.style.cssText='width:100%;height:100%;object-fit:contain';ov.appendChild(img);
      const zones=UI.el('div','position:absolute;inset:0;display:flex');const prevZ=UI.el('div','flex:1');const nextZ=UI.el('div','flex:1');
      prevZ.addEventListener('click',()=>{clearInterval(timer);progress=0;if(sIdx>0)sIdx--;else if(uIdx>0){uIdx--;sIdx=0;}renderSV();startTimer();});
      nextZ.addEventListener('click',()=>{clearInterval(timer);progress=0;const arr=Stories.getUserStories(allUsers[uIdx],S.stories);if(sIdx<arr.length-1)sIdx++;else if(uIdx<allUsers.length-1){uIdx++;sIdx=0;}else{ov.remove();return;}renderSV();startTimer();});
      zones.appendChild(prevZ);zones.appendChild(nextZ);ov.appendChild(zones);
    };
    const startTimer=()=>{clearInterval(timer);progress=0;const step=100/(5000/50);timer=setInterval(()=>{progress+=step;const fill=ov.querySelector(`#prog-fill-${sIdx}`);if(fill)fill.style.width=`${Math.min(progress,100)}%`;if(progress>=100){clearInterval(timer);const arr=Stories.getUserStories(allUsers[uIdx],S.stories);if(sIdx<arr.length-1)sIdx++;else if(uIdx<allUsers.length-1){uIdx++;sIdx=0;}else{ov.remove();return;}renderSV();startTimer();}},50);};
    renderSV();startTimer();APP.appendChild(ov);
  }

  /* ═══════════════════════════════════════════════════════════
     CUSTOMIZE SHEET — instant apply without full reload
  ═══════════════════════════════════════════════════════════ */
  function showCustomizeSheet(){
    const ex=document.getElementById('customize-sheet');if(ex){ex.remove();return;}const cid=chatId();
    const ov=UI.el('div','position:fixed;inset:0;z-index:990;display:flex;align-items:flex-end;justify-content:center');ov.id='customize-sheet';const bg=UI.el('div','position:absolute;inset:0;background:rgba(0,0,0,.6)');bg.addEventListener('click',()=>ov.remove());ov.appendChild(bg);
    const sheet=UI.el('div',`background:${th().card};width:100%;max-width:500px;border-radius:20px 20px 0 0;padding:24px;position:relative;z-index:1;animation:slideUp .25s ease`);const handle=UI.el('div',`width:40px;height:4px;background:${th().border};border-radius:2px;margin:0 auto 16px`);sheet.appendChild(handle);const title=UI.el('div',`font-weight:800;font-size:16px;margin-bottom:16px;color:${th().text}`);title.textContent='🎨 تخصيص الدردشة';sheet.appendChild(title);
    const bcLbl=UI.el('div',`font-size:12px;color:${th().text2};font-weight:700;margin-bottom:8px`);bcLbl.textContent='لون فقاعات رسائلك';sheet.appendChild(bcLbl);const bcRow=UI.el('div','display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px');const curBC=UI.getBubbleColors()[cid]||'';
    ['linear-gradient(135deg,var(--accent),var(--accent2))','linear-gradient(135deg,#ec4899,#f43f5e)','linear-gradient(135deg,#f59e0b,#f97316)','linear-gradient(135deg,#10b981,#059669)','linear-gradient(135deg,#3b82f6,#2563eb)','linear-gradient(135deg,var(--accent2),#7c3aed)','linear-gradient(135deg,#000,#374151)','linear-gradient(135deg,#ef4444,#dc2626)'].forEach(c=>{const sw=UI.el('div','width:36px;height:36px;border-radius:10px;cursor:pointer;transition:transform .15s');sw.style.background=c;sw.style.border=curBC===c?'3px solid #fff':'3px solid transparent';sw.style.boxShadow='0 2px 8px rgba(0,0,0,.2)';if(curBC===c)sw.style.transform='scale(1.1)';sw.addEventListener('click',()=>{UI.saveBubbleColor(cid,c);UI.toast('تم الحفظ','success');_reapplyChatStyles();ov.remove();});bcRow.appendChild(sw);});sheet.appendChild(bcRow);
    const bgLbl=UI.el('div',`font-size:12px;color:${th().text2};font-weight:700;margin-bottom:8px`);bgLbl.textContent='خلفية المحادثة';sheet.appendChild(bgLbl);const bgRow=UI.el('div','display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px');const curBG=UI.getChatBgs()[cid]||'';
    [null,'#f0fdf4','#fdf2f8','#eff6ff','#fefce8','#f0f4ff','#fef9f0'].forEach(c=>{const sw=UI.el('div','width:36px;height:36px;border-radius:10px;cursor:pointer');sw.style.background=c||th().bg;sw.style.border=`3px solid ${(curBG||(c||''))===(c||'')?'var(--accent)':th().border}`;sw.style.boxShadow='0 1px 4px rgba(0,0,0,.1)';if(!c){const ic=UI.el('span','display:flex;align-items:center;justify-content:center;height:100%;font-size:16px');ic.textContent='🚫';sw.appendChild(ic);}sw.addEventListener('click',()=>{UI.saveChatBg(cid,c||'');UI.toast('تم الحفظ','success');_reapplyChatStyles();ov.remove();});bgRow.appendChild(sw);});
    const bgUpload=document.createElement('input');bgUpload.type='file';bgUpload.accept='image/*';bgUpload.style.display='none';bgUpload.addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;try{const d=await UI.fileToBase64(f);if(UI.saveChatBg(cid,d)===false){UI.toast('الصورة كبيرة، اختر صورة أصغر','error');e.target.value='';return;}UI.toast('تم الحفظ','success');_reapplyChatStyles();ov.remove();e.target.value='';}catch(err){UI.toast(err.message||'خطأ في الصورة','error');e.target.value='';}});
    const bgPhBtn=UI.el('button',`width:36px;height:36px;border-radius:10px;background:${th().card2};border:1px dashed ${th().border};cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center`);bgPhBtn.textContent='📷';bgPhBtn.addEventListener('click',()=>bgUpload.click());bgRow.appendChild(bgPhBtn);bgRow.appendChild(bgUpload);sheet.appendChild(bgRow);ov.appendChild(sheet);UI.attachSheetGestures(ov,sheet,()=>ov.remove());APP.appendChild(ov);
  }

  // ✅ Re-apply chat styles without full renderScreen()
  function _reapplyChatStyles() {
    const scroll = document.getElementById('msg-scroll');
    if (scroll) {
      const bg = UI.getChatBgs()[chatId()] || th().bg;
      scroll.style.background = bg;
    }
    const bubbles = document.querySelectorAll('.bubble');
    const bc = UI.getBubbleColors()[chatId()] || 'linear-gradient(135deg,var(--accent),var(--accent2))';
    bubbles.forEach(b => {
      if (b.parentElement && b.parentElement.parentElement && b.parentElement.parentElement.style.flexDirection === 'row-reverse') {
        b.style.background = bc;
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════
     BOOT
  ═══════════════════════════════════════════════════════════ */
  /* ── Deep links: ?join=CODE (دعوة مجموعة) و ?tab=chats|groups|unread ── */
  let _deepLink = null;
  try {
    const qp = new URLSearchParams(location.search);
    const j  = (qp.get('join') || '').trim();
    const t  = qp.get('tab');
    const validTab  = ['chats', 'groups', 'unread'].includes(t) ? t : '';
    const validJoin = /^[A-Za-z0-9_-]{1,64}$/.test(j) ? j : '';
    if (validTab) S.tab = validTab;
    if (validJoin) _deepLink = { join: validJoin };
    if (qp.has('join') || qp.has('tab')) history.replaceState(null, '', location.pathname);
  } catch (e) {}

  async function _handleDeepLink() {
    const d = _deepLink;
    if (!d || !d.join || !S.me || !S.meUid) return;
    _deepLink = null; // مرة واحدة فقط
    if (!await UI.confirmDialog('الانضمام للمجموعة عبر رابط الدعوة؟', { confirmText: 'انضمام' })) return;
    const res = await Groups.joinByInvite(S.me, d.join);
    if (res.error) { UI.toast(res.error, 'error'); return; }
    if (res.gid) { _openGroupListener(res.gid); go('group', res.gid); }
  }


  /* ═══════════════════════════════════════════════════════════
     التشفير طرف-لطرف — الواجهة (المنطق في e2e.js)
  ═══════════════════════════════════════════════════════════ */
  const _EF = 'nbd_e2e_';
  const _lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const _lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

  function _e2eBoot() {
    if (!window.E2E || !S.meUid) return;
    E2E.onReady(() => { _dmRedecryptAll(); _e2eRefreshLock(); });
    E2E.init(S.meUid).then(st => {
      _e2eRefreshLock();
      if (st === 'unsupported') {
        if (!_lsGet(_EF + 'unsup')) { _lsSet(_EF + 'unsup', '1'); UI.toast('متصفحك لا يدعم التشفير (يتطلب اتصالاً آمناً HTTPS)', 'warn'); }
      } else if (st === 'error') {
        setTimeout(() => UI.toast('🔒 تعذّر تجهيز التشفير: ' + _e2eErr(E2E.lastError()), 'error'), 2500);
      }
    }).catch(() => {});
  }

  function _e2eSheet(title, build) {
    const ex = document.getElementById('e2e-sheet'); if (ex) ex.remove();
    const close = () => { const e = document.getElementById('e2e-sheet'); if (e) e.remove(); };
    const ov = UI.el('div', 'position:fixed;inset:0;z-index:995;display:flex;align-items:flex-end;justify-content:center;direction:rtl'); ov.id = 'e2e-sheet';
    const bg = UI.el('div', 'position:absolute;inset:0;background:rgba(0,0,0,.55)'); bg.addEventListener('click', close); ov.appendChild(bg);
    const sheet = UI.el('div', `background:${th().card};width:100%;max-width:500px;border-radius:24px 24px 0 0;padding:14px 16px 22px;position:relative;z-index:1;max-height:88vh;overflow-y:auto;box-sizing:border-box;animation:slideUp .22s ease`);
    sheet.appendChild(UI.el('div', `width:40px;height:4px;background:${th().border};border-radius:2px;margin:2px auto 12px`));
    const h = UI.el('div', `font-weight:800;font-size:16px;color:${th().text};margin-bottom:8px`); h.textContent = title; sheet.appendChild(h);
    build(sheet, close);
    ov.appendChild(sheet); UI.attachSheetGestures(ov,sheet,close);document.body.appendChild(ov);
  }
  const _e2eP = (sheet, text, color) => { const p = UI.el('div', `font-size:13px;line-height:1.7;color:${color || th().text2};margin-bottom:10px`); p.textContent = text; sheet.appendChild(p); return p; };
  const _e2eBtn = (sheet, label, kind, fn) => {
    const css = kind === 'primary' ? 'background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border:none'
      : kind === 'danger' ? `background:${th().card2};color:#ef4444;border:1px solid #fecaca` : `background:${th().card2};color:${th().text};border:1px solid ${th().border}`;
    const b = UI.el('button', `width:100%;padding:12px;border-radius:12px;${css};font-family:inherit;font-size:14px;font-weight:700;cursor:pointer;margin-bottom:8px`);
    b.textContent = label;
    b.addEventListener('click', async () => { if (b.disabled) return; b.disabled = true; const old = b.textContent; b.textContent = '⏳ لحظة...'; try { await fn(); } finally { b.disabled = false; b.textContent = old; } });
    sheet.appendChild(b); return b;
  };
  const _e2eErr = e => {
    const m = (e && e.message) || '';
    if (/permission|PERMISSION/.test(m + (e && e.code || ''))) return 'قواعد Firebase غير محدّثة — الصق ملف القواعد الجديد في Firebase Console ثم Publish';
    if (m === 'storage_unavailable') return 'المتصفح يمنع التخزين المحلي — افتح التطبيق من Chrome مباشرة';
    return 'حدث خطأ: ' + (m || (e && e.code) || 'غير معروف');
  };

  // معلومات التشفير (من الملف الشخصي) — لا يحتاج المستخدم لأي إعداد
  function _openE2EManage() {
    if (!window.E2E) return;
    _e2eSheet('🔐 التشفير', (sheet, close) => {
      const st = E2E.status();
      if (st === 'unsupported') { _e2eP(sheet, 'هذا المتصفح لا يدعم التشفير. افتح التطبيق عبر متصفح حديث وباتصال آمن (HTTPS).'); _e2eBtn(sheet, 'إغلاق', 'plain', async () => close()); return; }
      if (st !== 'ready') { _e2eP(sheet, '⚠️ تعذّر تجهيز التشفير: ' + _e2eErr(E2E.lastError()), '#f59e0b'); _e2eBtn(sheet, 'إغلاق', 'plain', async () => close()); return; }
      _e2eP(sheet, '✅ رسائلك الخاصة (بين شخصين) مشفّرة طرف-لطرف تلقائياً، مثل واتساب: لا أحد يقرؤها غيرك أنت والطرف الآخر، حتى إدارة التطبيق وقاعدة البيانات. لا تحتاج أي إعداد أو نسخة احتياطية.', '#22c55e');
      _e2eP(sheet, 'ملاحظة: مفتاحك محفوظ على هذا الجهاز. إذا مسحت بيانات المتصفح/التطبيق أو انتقلت لجهاز جديد، تبدأ فيه المحادثات برسائل جديدة (الرسائل القديمة المشفّرة لا تظهر على الجهاز الجديد). المجموعات غير مشفّرة طرف-لطرف.');
      const cnt = _e2eP(sheet, 'الأجهزة المرتبطة بحسابك: ...');
      E2E.myDevices().then(d => { cnt.textContent = 'الأجهزة المرتبطة بحسابك: ' + d.length; }).catch(() => { cnt.textContent = ''; });
      _e2eBtn(sheet, '🗑 إزالة الأجهزة الأخرى (إن ضاع جهاز)', 'danger', async () => {
        if (!await UI.confirmDialog('ستُزال كل أجهزتك الأخرى من التشفير، ولن تصلها رسائل جديدة. متابعة؟', { confirmText: 'إزالة', danger: true })) return;
        try { const n = await E2E.removeOtherDevices(); UI.toast(n ? `أُزيل ${n} جهاز` : 'لا توجد أجهزة أخرى', 'success'); cnt.textContent = 'الأجهزة المرتبطة بحسابك: 1'; }
        catch (e) { UI.toast(_e2eErr(e), 'error'); }
      });
      _e2eBtn(sheet, 'إغلاق', 'plain', async () => close());
    });
  }

  // رقم الأمان: قارنه مع صديقك (وجهاً لوجه أو مكالمة) للتأكد من عدم وجود وسيط
  async function _openSafety(name) {
    const uid = _uidByName(name) || name;
    let pk = null; try { pk = window.E2E ? await E2E.getPeerKey(uid) : null; } catch (e) {}
    _e2eSheet('🔒 تشفير المحادثة', async (sheet, close) => {
      if (!window.E2E || !pk) {
        _e2eP(sheet, `🔓 هذه المحادثة غير مشفّرة طرف-لطرف لأن ${name} لم يفتح التطبيق بعد بنسخة تدعم التشفير. ستتشفّر تلقائياً بمجرد فتحه للتطبيق.`);
        _e2eBtn(sheet, 'إغلاق', 'plain', async () => close()); return;
      }
      if (!E2E.isReady()) {
        _e2eP(sheet, '⚠️ التشفير غير جاهز على هذا الجهاز — لن تُرسل رسائل لهذه المحادثة حتى يجهز. ' + _e2eErr(E2E.lastError()), '#f59e0b');
        _e2eBtn(sheet, 'إغلاق', 'plain', async () => close()); return;
      }
      _e2eP(sheet, `✅ رسائلك مع ${name} مشفّرة طرف-لطرف. للتأكد من أنك تكلّم الشخص الصحيح، قارن هذا الرقم مع الرقم الظاهر عنده — يجب أن يتطابقا تماماً:`, '#22c55e');
      const num = UI.el('div', `font-family:monospace;font-size:20px;font-weight:800;letter-spacing:2px;text-align:center;direction:ltr;padding:16px 10px;border-radius:14px;background:${th().card2};border:1px solid ${th().border};color:${th().text};margin-bottom:12px;line-height:1.8`);
      num.textContent = '...'; sheet.appendChild(num);
      try { num.textContent = (await E2E.safetyNumber(uid)) || '—'; } catch (e) { num.textContent = '—'; }
      _e2eP(sheet, 'ملاحظة: الرقم يتغيّر إذا أضاف أحدكما جهازاً جديداً.');
      _e2eBtn(sheet, '📋 نسخ الرقم', 'plain', async () => { try { await navigator.clipboard.writeText(num.textContent); UI.toast('تم النسخ ✓', 'success'); } catch (e) { UI.toast('تعذّر النسخ', 'error'); } });
      _e2eBtn(sheet, 'إغلاق', 'plain', async () => close());
    });
  }

  // أيقونة القفل في شريط المحادثة
  async function _e2eRefreshLock() {
    const lk = document.getElementById('e2e-lock'); if (!lk || S.screen !== 'dm' || !window.E2E) return;
    const uid = _uidByName(S.activeId) || S.activeId;
    let pk = null; try { pk = await E2E.getPeerKey(uid); } catch (e) {}
    const lk2 = document.getElementById('e2e-lock'); if (!lk2) return;
    lk2.style.display = 'inline-block';
    if (!pk) { lk2.textContent = '🔓'; lk2.style.opacity = '.55'; lk2.title = 'غير مشفّرة'; return; }
    lk2.style.opacity = '1';
    if (E2E.isReady()) { lk2.textContent = '🔒'; lk2.title = 'مشفّرة طرف-لطرف'; }
    else { lk2.textContent = '⚠️'; lk2.title = 'التشفير غير جاهز'; }
  }

  UI.applyTheme();

  // بدء الجلسة بعد التأكد من وجود مستخدم Firebase
  let _sessionLive = false;
  function _startSession() {
    if (_sessionLive) return; _sessionLive = true;
    S.meUid = FB.authCurrentUser()?.uid || null;
    Chat.goOnline(S.meUid);
    UI.requestNotifPerm();
    startDataListeners();
    _e2eBoot();
    // انتهاء الجلسة لاحقاً (حذف الحساب/إلغاء الصلاحية) → ارجع لشاشة الدخول
    FB.authOnChange(u => {
      if (!u && _sessionLive && S.me && S.screen !== 'auth') {
        Auth.clearSession(); S.me = null; S.meUid = null;
        location.reload();
      }
    });
    // Hide loading screen only after basic data is loaded (max 8s)
    const checkStart = Date.now();
    const checkData = () => {
      if (Object.keys(S.users).length > 0 || Object.keys(S.groups || {}).length > 0 || Date.now() - checkStart > 8000) {
        UI.showApp();
        go('home');
        _handleDeepLink();
      } else {
        setTimeout(checkData, 300);
      }
    };
    setTimeout(checkData, 200);
  }

  if (S.me && !FB.authCurrentUser() && FB.authResolved()) {
    // Firebase حسم: لا يوجد مستخدم (جلسة منتهية فعلاً) → ارجع لشاشة الدخول
    try { localStorage.setItem('nbu_why', 'auth-null@' + Date.now()); } catch (e) {}
    Auth.clearSession(); S.me = null;
  }

  if (S.me && FB.authCurrentUser()) {
    _startSession();
  } else if (S.me) {
    // الشبكة بطيئة: Firebase لم يحسم الجلسة بعد → انتظر بدل تسجيل الخروج (حتى 40 ثانية)
    let settled = false;
    FB.authOnChange(u => {
      if (settled) return; settled = true;
      if (u) _startSession();
      else { Auth.clearSession(); S.me = null; UI.showApp(); go('auth'); }
    });
    setTimeout(() => {
      if (settled) return; settled = true;
      UI.showApp(); go('auth'); // لا نمسح الجلسة المحلية: المحاولة التالية قد تنجح
      UI.toast('تعذّر التحقق من الجلسة بسبب بطء الشبكة، حاول مجدداً', 'error');
    }, 40000);
  } else {
    UI.showApp();
    go('auth');
  }

  /* ── إيماءات عامة: السحب من حافة الشاشة = رجوع، والسحب بين تبويبات الرئيسية ── */
  (function _globalGestures(){
    let gx=0,gy=0,gEdge=null,gOn=false,gT=0;
    const blockedTarget=el=>!!(el&&el.closest&&el.closest('input,textarea,select,[data-no-swipe],#img-viewer,#fwd-ov,#story-viewer-ov,#story-preview-ov,#story-inner'));
    document.addEventListener('touchstart',e=>{
      gOn=false;
      if(e.touches.length!==1||!S.me)return;
      const t=e.touches[0];gx=t.clientX;gy=t.clientY;gT=Date.now();
      const W=window.innerWidth;
      gEdge=gx<=26?'left':(gx>=W-26?'right':null);
      gOn=true;
    },{passive:true});
    document.addEventListener('touchend',e=>{
      if(!gOn)return;gOn=false;
      const t=e.changedTouches[0];const dx=t.clientX-gx,dy=t.clientY-gy;
      if(Math.abs(dy)>70||Math.abs(dx)<70||Date.now()-gT>700)return;
      if(blockedTarget(e.target))return;
      if(S.screen&&S.screen!=='home'&&S.screen!=='auth'){
        // من الحافة اليسرى لليمين، أو من الحافة اليمنى لليسار (للداخل)
        if((gEdge==='left'&&dx>0)||(gEdge==='right'&&dx<0)){
          if(Date.now()-_lastBackAt<700)return;
          const fo=document.getElementById('fwd-ov');if(fo){fo.remove();return;}
          goBack();
        }
      }else if(S.screen==='home'&&!gEdge){
        const tabs=['chats','groups','unread'];const i=tabs.indexOf(S.tab);
        const ni=dx>0?i+1:i-1; // واجهة RTL: السحب لليمين = التبويب التالي
        const btns=document.querySelectorAll('.tab');
        if(ni>=0&&ni<tabs.length&&btns[ni])btns[ni].click();
      }
    },{passive:true});
  })();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.me) Chat.goOnline(S.meUid);
  });

})();
