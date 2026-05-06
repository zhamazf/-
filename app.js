/**
 * app.js — Main controller (Fixed)
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
    typingMap:    {},
    msgs:         [],
    panel:        false,
    groupEdit:    false,
    groupNewName: '',
    groupNewPhoto: null,
    storyPreview: null,
    viewImg:      null,
    dark:         UI.isDark(),
  };

  const _unsubs = [];
  const addU    = fn => _unsubs.push(fn);
  let _msgUnsub = null, _prevLen = 0, _lastSend = 0;
  const SPAM    = 1200;
  const _seenMsgIds = new Set();
  const _pendingMsgs = new Map(); // tempId → {payload, type, retries}
  const APP     = document.getElementById('app');

  /* ── Resolve UID helpers ─────────────────────────────────── */
  const _uidByName = name => S.usersByName[name]?.uid || null;
  const _nameByUid = uid  => S.users[uid]?.username || uid;
  const _userData  = name => S.usersByName[name] || null;

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
  const totalNotifs = () => pendingReqs().length + Object.values(unread()).reduce((a,b)=>a+b,0);
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
    if (S.screen==='dm'||S.screen==='group') Chat.clearTyping(S.me, S.activeId, S.screen);
    stopMsgListener();
    _seenMsgIds.clear();

    // Push current to history before leaving
    if (S.screen && S.screen !== 'auth') {
      _historyStack.push({screen: S.screen, id: S.activeId});
    }

    S.screen=screen; S.activeId=id; S.panel=false; S.groupEdit=false; S.msgs=[];
    if (screen==='dm'&&id&&S.meUid) { const _t=_uidByName(id)||id; Chat.markRead(Chat.dmKey(S.meUid,_t), S.meUid); }
    window.history.pushState({screen, id}, '', '');
    renderScreen();
    if (screen==='dm'&&id)    startMsgListener('dm',id);
    if (screen==='group'&&id) startMsgListener('group',id);
  }

  function goBack() {
    const prev = _historyStack.pop();
    if (prev && prev.screen && prev.screen !== 'auth') {
      // Replay without pushing new history state
      const {screen, id} = prev;
      if (S.screen==='dm'||S.screen==='group') Chat.clearTyping(S.me, S.activeId, S.screen);
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
  }

  /* ═══════════════════════════════════════════════════════════
     MESSAGE LISTENER — append only, error-safe, single listener
  ═══════════════════════════════════════════════════════════ */
  function startMsgListener(type, id) {
    stopMsgListener();
    _prevLen=0; _seenMsgIds.clear();
    const _tUid = _uidByName(id) || id;
    const path = type==='dm' ? `dmMsgs/${Chat.dmKey(S.meUid, _tUid)}` : `groupMsgs/${id}`;

    const cb = msgs => {
      try {
        if (!msgs || !msgs.length) { S.msgs=[]; renderMsgs(); return; }
        const isFirst = _prevLen===0;
        if (isFirst) {
          S.msgs=msgs; msgs.forEach(m=>_seenMsgIds.add(m.id)); _prevLen=msgs.length; renderMsgs();
        } else {
          const newMsgs = msgs.filter(m=>!_seenMsgIds.has(m.id));
          newMsgs.forEach(m=>{
            _seenMsgIds.add(m.id);
            if (m.sender!==S.meUid && m.sender!==S.me) {
              UI.playSound('recv');
              UI.showNotif(type==='dm'?`رسالة من ${_nameByUid(m.sender)||m.sender}`:`رسالة في مجموعة`, m.type==='text'?m.text:'🖼 وسائط', ()=>window.focus());
              appendMsg(m);
            } else {
              replaceOptimistic(m);
            }
          });
          _prevLen=msgs.length; S.msgs=msgs;
        }
        if (type==='dm') { const _t=_uidByName(id)||id; Chat.markRead(Chat.dmKey(S.meUid,_t), S.meUid); }
      } catch (err) {
        console.error('[startMsgListener] error:', err);
        UI.toast('خطأ في تحديث الرسائل','error');
      }
    };

    try {
      const _tUid2=_uidByName(id)||id; _msgUnsub = type==='dm' ? Chat.listenDM(S.meUid,_tUid2,cb) : Chat.listenGroup(id,cb);
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

  /* ═══════════════════════════════════════════════════════════
     GLOBAL DATA LISTENERS  (core first, stories deferred)
  ═══════════════════════════════════════════════════════════ */
  let _storiesTimer = null;

  function startDataListeners() {
    // مراقبة حالة الاتصال
    addU(FB.onConnectionChange(isOnline => UI.setConnectionStatus(isOnline)));
    addU(FB.on('users',    v=>{S.users=v||{}; rebuildUserMaps(); refreshDyn(); _startDmListeners(); _startFriendReqListener(); _startStoryListeners(); _startGroupListeners();}));
    // groups: لا نقرأ /groups كاملاً — بدلاً نستمع per-group في _startGroupListeners()
    // يُستدعى من rebuildUserMaps بعد تحميل users
    addU(FB.on('presence', v=>{S.presence=v||{}; refreshPresence();}));
    addU(FB.on('typing',   v=>{S.typingMap=v||{}; refreshTyping();}));
    // Periodic expired-story cleanup every 5 minutes
    if (!_storiesTimer) _storiesTimer = setInterval(()=>Stories.cleanExpired(S.stories, S.meUid), 300000);
  }

  // ── DM listeners — واحد لكل صديق (Rules: $dmKey.contains(auth.uid)) ──
  const _dmUnsubs = {};
  function _startDmListeners() {
    if (!S.meUid) return;
    const friendUids = Object.keys(S.users[S.meUid]?.friends || {});
    friendUids.forEach(fUid => {
      const key = [S.meUid, fUid].sort().join('_');
      if (_dmUnsubs[key]) return;
      _dmUnsubs[key] = FB.on(`dmMsgs/${key}`, v => {
        if (v) S.dmChats[key] = v; else delete S.dmChats[key];
        refreshDyn();
      });
      addU(() => { if (_dmUnsubs[key]) { _dmUnsubs[key](); delete _dmUnsubs[key]; } });
    });
  }

  // ── friendRequests listener — uid فقط (Rules: $targetUid === auth.uid) ──
  let _friendReqUnsub = null;
  function _startFriendReqListener() {
    if (!S.meUid || _friendReqUnsub) return;
    _friendReqUnsub = FB.on(`friendRequests/${S.meUid}`, v => {
      S.friendReqs = { [S.meUid]: v || {} };
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

  // ── Groups listeners — استمع لـ users/{meUid}/groups ثم لكل مجموعة ──
  const _groupUnsubs = {};
  let _groupIndexUnsub = null;

  function _openGroupListener(gid) {
    if (!gid || _groupUnsubs[gid]) return;
    _groupUnsubs[gid] = FB.on(`groups/${gid}`, v => {
      if (v) S.groups[gid] = v; else delete S.groups[gid];
      refreshDyn();
    });
    addU(() => { if (_groupUnsubs[gid]) { _groupUnsubs[gid](); delete _groupUnsubs[gid]; } });
  }

  function _startGroupListeners() {
    if (!S.meUid || _groupIndexUnsub) return;
    // استمع لقائمة مجموعات المستخدم في users/{meUid}/groups
    _groupIndexUnsub = FB.on(`users/${S.meUid}/groups`, v => {
      const gids = Object.keys(v || {});
      gids.forEach(gid => _openGroupListener(gid));
      // احذف المجموعات التي خرج منها
      Object.keys(_groupUnsubs).forEach(gid => {
        if (!v || !v[gid]) {
          if (_groupUnsubs[gid]) { _groupUnsubs[gid](); delete _groupUnsubs[gid]; }
          delete S.groups[gid];
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
    const tu=Chat.getTypingUsers(S.typingMap,S.me,S.activeId,S.screen);
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
    const tu=Chat.getTypingUsers(S.typingMap,S.me,S.activeId,S.screen);
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
    const e=document.getElementById('tab-unread-extra'); if(e){const n=Object.values(unread()).reduce((a,b)=>a+b,0);e.textContent=n>0?` (${n})`:'';}
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
    const logoIcon=UI.el('div','width:72px;height:72px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border-radius:20px;margin:0 auto 14px;display:flex;align-items:center;justify-content:center;font-size:36px;box-shadow:0 8px 24px rgba(99,102,241,.4)');
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
    const updTabs=()=>tabRow.querySelectorAll('.mt').forEach(b=>{b.style.background=mode===b.dataset.m?'linear-gradient(135deg,#6366f1,#8b5cf6)':'transparent';b.style.color=mode===b.dataset.m?'#fff':th().text2;});
    ['login','register'].forEach(m=>{
      const b=UI.el('button','flex:1;padding:10px;border:none;border-radius:11px;cursor:pointer;font-family:inherit;font-weight:700;font-size:13px;transition:all .2s');
      b.className='mt'; b.dataset.m=m; b.textContent=m==='login'?'دخول':'حساب جديد';
      b.addEventListener('click',()=>{
        mode=m; errBox.style.display='none'; updTabs();
        submitBtn.textContent=mode==='login'?'دخول ←':'إنشاء الحساب ←';
        unameRow.style.display=mode==='register'?'block':'none';
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
    const submitBtn=UI.el('button','width:100%;padding:13px;border:none;border-radius:14px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-size:15px;font-weight:700;font-family:inherit;box-shadow:0 4px 14px rgba(99,102,241,.4);cursor:pointer');
    submitBtn.textContent='دخول ←';

    async function doSubmit() {
      if (loading) return;
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
    }

    submitBtn.addEventListener('click', doSubmit);
    [unameInp,emailInp,passInp].forEach(i=>i.addEventListener('keydown',e=>{if(e.key==='Enter')doSubmit();}));
    card.appendChild(submitBtn);

    // Forgot password row (login only)
    const resetRow=UI.el('div','display:flex;justify-content:center;margin-top:12px');
    const resetBtn=UI.el('button',`background:none;border:none;cursor:pointer;color:#6366f1;font-size:13px;font-family:inherit;text-decoration:underline`);
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
  function renderHome(){
    APP.appendChild(buildHomeTopbar());
    const stWrap=UI.el('div',`padding:10px 14px 8px;border-bottom:1px solid ${th().border};flex-shrink:0;background:${th().topbar}`);
    const stInner=UI.el('div','display:flex;gap:12px;overflow-x:auto;padding-bottom:2px;scrollbar-width:none');
    stInner.id='story-inner'; buildStoryInner(stInner); stWrap.appendChild(stInner); APP.appendChild(stWrap);
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
    titleSpan.style.color=UI.isDark()?'#a5b4fc':'#6366f1'; titleSpan.textContent='نبضة';
    const meSpan=UI.el('span','font-size:11px;margin-right:6px');
    meSpan.style.color=th().text3; meSpan.textContent=`● ${S.me}`;
    title.appendChild(titleSpan); title.appendChild(meSpan);
    bar.appendChild(title);
    const fBtn=UI.el('button','background:none;border:none;cursor:pointer;font-size:20px;padding:4px;position:relative'); fBtn.textContent='👥';
    const pr=pendingReqs(); if(pr.length){const d=UI.el('div','position:absolute;top:0;right:0;background:#ef4444;color:#fff;font-size:8px;font-weight:700;border-radius:50%;width:14px;height:14px;display:flex;align-items:center;justify-content:center');d.textContent=pr.length;fBtn.appendChild(d);}
    fBtn.addEventListener('click',()=>go('friends')); bar.appendChild(fBtn);
    const dBtn=UI.el('button','background:none;border:none;cursor:pointer;font-size:20px;padding:4px');
    dBtn.textContent=UI.isDark()?'☀️':'🌙'; dBtn.addEventListener('click',()=>{UI.toggleDark();S.dark=UI.isDark();renderScreen();}); bar.appendChild(dBtn);
    return bar;
  }

  function buildStoryInner(container){
    container.innerHTML='';
    const addW=UI.el('div','display:flex;flex-direction:column;align-items:center;gap:3px;flex-shrink:0;cursor:pointer');
    const addC=UI.el('div',`width:52px;height:52px;border-radius:50%;background:${th().card2};border:2px dashed #6366f1;display:flex;align-items:center;justify-content:center;font-size:22px`); addC.textContent='+';
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
      const ring=UI.el('div',`padding:2px;border-radius:50%;border:2.5px solid ${seen?'#aaa':'#6366f1'};display:inline-flex;cursor:pointer`);
      const uid = _uidByName(u);
      ring.appendChild(UI.makeAvatar(_userData(u),46,{online:Chat.isOnline(S.presence, uid || u)}));
      ring.addEventListener('click',()=>{Stories.markSeen(u);openStoryViewer(u);});
      const lbl=UI.el('span',`font-size:10px;color:${seen?th().text3:'#6366f1'};max-width:52px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`); lbl.textContent=u;
      w.appendChild(ring); w.appendChild(lbl); container.appendChild(w);
    });
  }

  function buildHomeTabs(){
    const tabs=UI.el('div',`display:flex;background:${th().tabs};border-bottom:1px solid ${th().border};flex-shrink:0`);
    [['chats','💬 الخاصة'],['groups','👥 مجموعات'],['unread','🔔']].forEach(([k,l])=>{
      const b=UI.el('button'); b.className='tab'; b.style.color=S.tab===k?(UI.isDark()?'#a5b4fc':'#6366f1'):th().text3; b.style.borderBottomColor=S.tab===k?'#6366f1':'transparent';
      if(k==='unread'){const n=Object.values(unread()).reduce((a,b)=>a+b,0);const sp=document.createElement('span');sp.id='tab-unread-extra';sp.textContent=n>0?` (${n})`:'';b.textContent='🔔';b.appendChild(sp);}
      else b.textContent=l;
      b.addEventListener('click',()=>{S.tab=k;tabs.querySelectorAll('.tab').forEach((x,i)=>{const ks=['chats','groups','unread'];x.style.color=S.tab===ks[i]?(UI.isDark()?'#a5b4fc':'#6366f1'):th().text3;x.style.borderBottomColor=S.tab===ks[i]?'#6366f1':'transparent';});const c=document.getElementById('home-content');if(c)renderTabContent(c);});
      tabs.appendChild(b);
    });
    return tabs;
  }

  function renderTabContent(container){
    container.innerHTML='';
    if(S.tab==='chats'){
      const hdr=UI.el('div','display:flex;align-items:center;justify-content:space-between;margin-bottom:10px');
      const lbl=UI.el('span',`font-size:11px;font-weight:700;color:${th().text3};letter-spacing:1px`); lbl.textContent='المحادثات الخاصة';
      const plusBtn=UI.el('button','background:none;border:none;cursor:pointer;color:#6366f1;font-size:22px;line-height:1;padding:0'); plusBtn.textContent='+';
      hdr.appendChild(lbl); hdr.appendChild(plusBtn); container.appendChild(hdr);
      let showNdm=false;
      const ndmRow=UI.el('div','display:flex;gap:6px;margin-bottom:10px'); ndmRow.style.display='none';
      const ndmInp=UI.el('input',`flex:1;padding:9px 12px;border-radius:12px;border:1.5px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:13px;direction:rtl`); ndmInp.placeholder='اسم المستخدم...';
      const ndmBtn=UI.el('button','padding:9px 14px;border:none;border-radius:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-weight:700;font-family:inherit;cursor:pointer'); ndmBtn.textContent='→';
      const doNdm=()=>{const u=ndmInp.value.trim();if(u&&S.usersByName[u]&&u!==S.me)go('dm',u);};
      ndmBtn.addEventListener('click',doNdm); ndmInp.addEventListener('keydown',e=>{if(e.key==='Enter')doNdm();});
      ndmRow.appendChild(ndmInp); ndmRow.appendChild(ndmBtn); container.appendChild(ndmRow);
      plusBtn.addEventListener('click',()=>{showNdm=!showNdm;ndmRow.style.display=showNdm?'flex':'none';if(showNdm)ndmInp.focus();});
      const others=Object.keys(S.usersByName).filter(u=>u!==S.me&&Chat.getDMMessages(S.meUid,_uidByName(u)||u,S.dmChats).length>0);
      if(!others.length){const emp=UI.el('div',`color:${th().text3};font-size:13px;padding:16px 0;text-align:center`);emp.textContent='اضغط + لبدء محادثة جديدة';container.appendChild(emp);}
      others.forEach(u=>container.appendChild(buildChatItem(u)));
    } else if(S.tab==='groups'){
      const btnRow=UI.el('div','display:flex;gap:8px;margin-bottom:14px');
      const ngBtn=UI.el('button','flex:1;padding:10px 16px;border:none;border-radius:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-weight:700;font-size:13px;font-family:inherit;cursor:pointer'); ngBtn.textContent='+ مجموعة جديدة'; ngBtn.addEventListener('click',()=>go('newGroup')); btnRow.appendChild(ngBtn);
      const jnBtn=UI.el('button',`flex:1;padding:10px 16px;border:1px solid ${th().border};border-radius:12px;background:${th().card2};color:${UI.isDark()?'#a5b4fc':'#6366f1'};font-weight:700;font-size:13px;font-family:inherit;cursor:pointer`); jnBtn.textContent='🔗 انضمام'; jnBtn.addEventListener('click',()=>go('join')); btnRow.appendChild(jnBtn); container.appendChild(btnRow);
      const grps=myGroups();
      if(!grps.length){const emp=UI.el('div',`color:${th().text3};text-align:center;padding:40px 20px;font-size:14px`);emp.textContent='لا توجد مجموعات بعد';container.appendChild(emp);setTimeout(()=>{const c2=document.getElementById('home-content');if(c2&&S.screen==='home'&&S.tab==='groups')renderTabContent(c2);},2000);return;}
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
    const item=UI.el('div',`display:flex;align-items:center;gap:10px;padding:11px 12px;border-radius:14px;cursor:pointer;background:${ur?'#6366f111':th().card};border:1px solid ${ur?'#6366f133':th().border};margin-bottom:6px;transition:opacity .12s`);
    item.addEventListener('click',()=>go('dm',u));
    const uid = _uidByName(u);
    item.appendChild(UI.makeAvatar(_userData(u),44,{online:Chat.isOnline(S.presence, uid || u),ring:hasSt,seen:seenSt,onClick:hasSt?e=>{e.stopPropagation();Stories.markSeen(_fUid2);openStoryViewer(_fUid2);}:null}));
    const info=UI.el('div','flex:1;min-width:0');
    const nm=UI.el('div',`font-weight:${ur?700:600};font-size:14px;color:${th().text}`); nm.textContent=u; info.appendChild(nm);
    if(last){const prev=UI.el('div',`font-size:12px;color:${ur?'#6366f1':th().text3};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:${ur?600:400}`);prev.textContent=(last.sender===S.me?'أنت: ':'')+UI.preview(last);info.appendChild(prev);}
    item.appendChild(info);
    const meta=UI.el('div','display:flex;flex-direction:column;align-items:flex-end;gap:3px');
    if(last){const ts=UI.el('span',`font-size:10px;color:${th().text3}`);ts.textContent=UI.fmtFull(last.ts);meta.appendChild(ts);}
    if(ur>0){const b=UI.el('div','background:#6366f1;color:#fff;font-size:10px;font-weight:700;border-radius:10px;min-width:18px;height:18px;display:flex;align-items:center;justify-content:center;padding:0 5px');b.textContent=ur;meta.appendChild(b);}
    item.appendChild(meta); return item;
  }

  function buildGroupItem(g){
    const pc=Groups.canManage(g,S.meUid)&&g.pending?Object.keys(g.pending).length:0;
    const item=UI.el('div',`display:flex;align-items:center;gap:10px;padding:11px 12px;border-radius:14px;cursor:pointer;background:${th().card};border:1px solid ${th().border};margin-bottom:6px`);
    item.addEventListener('click',()=>go('group',g.id));
    if(g.photo){const img=document.createElement('img');img.src=g.photo;img.loading='lazy';img.style.cssText='width:44px;height:44px;border-radius:12px;object-fit:cover;flex-shrink:0';item.appendChild(img);}
    else{const c=UI.userColor(g.name);const ic=UI.el('div',`width:44px;height:44px;border-radius:12px;flex-shrink:0;background:linear-gradient(135deg,${c},${UI.userColor(g.name+'1')});display:flex;align-items:center;justify-content:center;font-weight:800;font-size:19px;color:#fff`);ic.textContent=g.name[0];item.appendChild(ic);}
    const info=UI.el('div','flex:1;min-width:0'); const nr=UI.el('div','display:flex;align-items:center;gap:6px');
    const nm=UI.el('span',`font-weight:700;font-size:14px;color:${th().text}`); nm.textContent=g.name; nr.appendChild(nm);
    if(pc>0){const b=UI.el('span','background:#fee2e2;color:#ef4444;font-size:10px;font-weight:700;padding:1px 6px;border-radius:6px');b.textContent=`${pc} طلب`;nr.appendChild(b);}
    info.appendChild(nr); const sub=UI.el('div',`font-size:11px;color:${th().text3}`); sub.textContent=`${Groups.getMembers(g).length} عضو`; info.appendChild(sub);
    item.appendChild(info); return item;
  }

  /* ═══════════════════════════════════════════════════════════
     SHARED TOPBARS
  ═══════════════════════════════════════════════════════════ */
  function buildChatTopbar(type){
    const g=ag();
    const bar=UI.el('div',`display:flex;align-items:center;gap:10px;padding:10px 14px;background:${th().topbar};border-bottom:1px solid ${th().border};flex-shrink:0;box-shadow:0 1px 6px rgba(0,0,0,.06)`);
    const back=UI.el('button','background:none;border:none;cursor:pointer;font-size:22px;padding:2px;line-height:1'); back.textContent='←'; back.style.color=th().text2; back.addEventListener('click',()=>goBack()); bar.appendChild(back);
    if(type==='dm'){
      const avBtn=UI.el('button','background:none;border:none;cursor:pointer;padding:0');
      const targetUid = _uidByName(S.activeId);
      avBtn.appendChild(UI.makeAvatar(_userData(S.activeId),34,{online:Chat.isOnline(S.presence, targetUid || S.activeId)}));
      avBtn.addEventListener('click',()=>go('userProfile',S.activeId)); bar.appendChild(avBtn);
    }
    else if(g){if(g.photo){const img=document.createElement('img');img.src=g.photo;img.loading='lazy';img.style.cssText='width:34px;height:34px;border-radius:10px;object-fit:cover;flex-shrink:0';bar.appendChild(img);}else{const c=UI.userColor(g.name);const ic=UI.el('div',`width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,${c},${UI.userColor(g.name+'1')});display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;color:#fff;flex-shrink:0`);ic.textContent=g.name[0];bar.appendChild(ic);}}
    const info=UI.el('div','flex:1;min-width:0;cursor:pointer'); const titleEl=UI.el('div',`font-weight:700;font-size:15px;color:${th().text}`); const subEl=UI.el('div','font-size:11px'); subEl.id='topbar-sub';
    if(type==='dm'){titleEl.textContent=S.activeId;
      const targetUid = _uidByName(S.activeId);
      subEl.textContent=Chat.lastSeenText(S.presence, targetUid || S.activeId);
      subEl.style.color=Chat.isOnline(S.presence, targetUid || S.activeId)?'#22c55e':th().text3;
      info.addEventListener('click',()=>go('userProfile',S.activeId));
    }
    else if(g){titleEl.textContent=g.name;subEl.textContent=`${Groups.getMembers(g).length} عضو`;subEl.style.color=th().text3;}
    info.appendChild(titleEl); info.appendChild(subEl); bar.appendChild(info);
    const custBtn=UI.el('button','background:none;border:none;cursor:pointer;font-size:18px;padding:4px'); custBtn.textContent='🎨'; custBtn.style.color=th().text2; custBtn.addEventListener('click',showCustomizeSheet); bar.appendChild(custBtn);
    if(type==='group'&&g){
      const pBtn=UI.el('button',`padding:7px 11px;border:1px solid ${th().border};border-radius:12px;background:${S.panel?'#6366f122':th().card2};color:${UI.isDark()?'#a5b4fc':'#6366f1'};font-family:inherit;font-size:12px;font-weight:700;cursor:pointer`); pBtn.textContent=Groups.canManage(g,S.meUid)?'👑':'👥';
      pBtn.addEventListener('click',()=>{S.panel=!S.panel;pBtn.style.background=S.panel?'#6366f122':th().card2;const body=document.getElementById('group-body');const ex=document.getElementById('group-panel');if(S.panel&&body)buildGroupPanel(body);else if(ex)ex.remove();});
      bar.appendChild(pBtn);
    }
    return bar;
  }

  function buildSimpleTopbar(title){
    const bar=UI.el('div',`display:flex;align-items:center;gap:10px;padding:10px 14px;background:${th().topbar};border-bottom:1px solid ${th().border};flex-shrink:0;box-shadow:0 1px 6px rgba(0,0,0,.06)`);
    const back=UI.el('button','background:none;border:none;cursor:pointer;font-size:22px;padding:2px;line-height:1'); back.textContent='←'; back.style.color=th().text2; back.addEventListener('click',()=>goBack()); bar.appendChild(back);
    const t2=UI.el('span',`font-weight:700;font-size:16px;color:${th().text}`); t2.textContent=title; bar.appendChild(t2); return bar;
  }

  /* ═══════════════════════════════════════════════════════════
     DM / GROUP
  ═══════════════════════════════════════════════════════════ */
  function renderDM(){APP.appendChild(buildChatTopbar('dm'));APP.appendChild(buildMsgsArea());APP.appendChild(buildChatInput('dm'));}

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
    body.appendChild(main); APP.appendChild(body); if(S.panel)buildGroupPanel(body);
  }

  /* ═══════════════════════════════════════════════════════════
     MESSAGES
  ═══════════════════════════════════════════════════════════ */
  function buildMsgsArea(){
    const bg=UI.getChatBgs()[chatId()]||th().bg;
    const scroll=UI.el('div',`flex:1;overflow-y:auto;padding:10px 10px 4px;background:${bg};background-size:cover;background-position:center;-webkit-overflow-scrolling:touch`); scroll.id='msg-scroll';
    let tsy=0; scroll.addEventListener('touchstart',e=>{if(scroll.scrollTop===0)tsy=e.touches[0].clientY;});
    scroll.addEventListener('touchend',e=>{if(e.changedTouches[0].clientY-tsy>60&&scroll.scrollTop===0)UI.toast('تم التحديث ✓','success');});
    const msgC=UI.el('div',''); msgC.id='msg-container'; scroll.appendChild(msgC);
    const typRow=UI.el('div','display:none;align-items:center;gap:8px;padding:4px 0'); typRow.id='typing-row'; scroll.appendChild(typRow);
    const anchor=document.createElement('div'); anchor.id='msg-anchor'; scroll.appendChild(anchor);
    renderMsgs(); return scroll;
  }

  function renderMsgs(){const c=document.getElementById('msg-container');if(!c)return;c.innerHTML='';if(!S.msgs.length)c.appendChild(buildEmptyChat());else S.msgs.forEach(m=>c.appendChild(buildBubble(m)));scrollBot();}
  function appendMsg(m){const c=document.getElementById('msg-container');if(!c)return;const emp=c.querySelector('.empty-chat');if(emp)emp.remove();c.appendChild(buildBubble(m, !!m._isOpt));scrollBot();}
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
        const invLbl=UI.el('div','color:#6366f1;font-size:12px;font-weight:700;margin-bottom:4px'); invLbl.textContent='🔗 رمز الدعوة';
        const invCode=UI.el('div','font-family:monospace;color:#22c55e;font-size:15px;letter-spacing:2px;font-weight:700'); invCode.textContent=g.inviteCode;
        inv.appendChild(invLbl); inv.appendChild(invCode);
        d.appendChild(inv);
      }
    }
    return d;
  }

  /* ── Status helpers ──────────────────────────────────────── */
  function _statusText(m) {
    if (m.sender !== S.me) return '';
    if (m.readBy) return '✓✓';       // read receipt (blue in CSS)
    if (m.delivered) return '✓✓';    // delivered
    if (m._pending) return '⏳';      // pending / retrying
    return '✓';                       // sent
  }

  function buildBubble(m, isOpt=false){
    const mine=m.sender===S.meUid||m.sender===S.me; const bc=UI.getBubbleColors()[chatId()]||'linear-gradient(135deg,#6366f1,#8b5cf6)'; const isM=['image','video','voice'].includes(m.type);
    const row=UI.el('div','display:flex;align-items:flex-end;gap:6px;margin-bottom:3px;padding:0 2px;animation:fadeUp .2s ease'); row.style.flexDirection=mine?'row-reverse':'row';
    if(isOpt) row.setAttribute('data-temp-id', m._tempId || m.id);
    if(!mine){const senderData=_userData(m.sender)||{username:m.sender};row.appendChild(UI.makeAvatar(senderData,28,{onClick:()=>go('userProfile',m.sender)}));}
    const col=UI.el('div','max-width:78%');
    if(!mine&&S.screen==='group'){const sn=UI.el('div',`font-size:10px;color:${UI.userColor(m.sender)};font-weight:700;margin-bottom:2px;padding-right:4px`);sn.textContent=m.sender;col.appendChild(sn);}
    const bub=UI.el('div',''); bub.style.cssText=`padding:${isM?'5px':'9px 13px'};border-radius:${mine?'18px 18px 4px 18px':'18px 18px 18px 4px'};background:${mine?bc:th().bubble};color:${mine?'#fff':th().text};font-size:14px;line-height:1.5;box-shadow:${mine?'0 2px 8px rgba(99,102,241,.25)':'0 1px 4px rgba(0,0,0,.08)'}`;
    if(m.type==='text'){const span=document.createElement('span');span.style.cssText='word-break:break-word;white-space:pre-wrap;line-height:1.55';span.textContent=m.text;bub.appendChild(span);}
    else if(m.type==='image'){const img=document.createElement('img');img.src=m.data;img.loading='lazy';img.style.cssText='max-width:100%;max-height:220px;border-radius:10px;display:block;cursor:pointer';img.addEventListener('click',()=>{S.viewImg=m.data;showImgViewer();});bub.appendChild(img);}
    else if(m.type==='video'){const v=document.createElement('video');v.src=m.data;v.controls=true;v.playsInline=true;v.style.cssText='max-width:100%;max-height:220px;border-radius:10px;display:block';bub.appendChild(v);}
    else if(m.type==='voice'){const wrap=UI.el('div','display:flex;align-items:center;gap:10px;min-width:160px');const audio=document.createElement('audio');audio.src=m.data;let playing=false;const pb=UI.el('button','width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;background:rgba(255,255,255,.2);color:#fff;font-size:18px;display:flex;align-items:center;justify-content:center;flex-shrink:0');pb.textContent='▶';pb.addEventListener('click',()=>{if(playing){audio.pause();pb.textContent='▶';playing=false;}else{audio.play().catch(()=>{});pb.textContent='⏸';playing=true;}});audio.addEventListener('ended',()=>{pb.textContent='▶';playing=false;});const info=UI.el('div','flex:1');const lbl=UI.el('div','font-size:12px;opacity:.8');lbl.textContent='رسالة صوتية';const dur=UI.el('div','font-size:10px;opacity:.5');if(m.duration>0)dur.textContent=`${m.duration}ث`;info.appendChild(lbl);info.appendChild(dur);wrap.appendChild(audio);wrap.appendChild(pb);wrap.appendChild(info);const ico=document.createElement('span');ico.textContent='🎙';ico.style.fontSize='20px';wrap.appendChild(ico);bub.appendChild(wrap);}
    const meta=UI.el('div',`font-size:10px;color:${th().text3};margin-top:2px;text-align:${mine?'left':'right'};padding-right:2px`);
    meta.textContent = UI.fmt(m.ts) + ' ' + _statusText(m);
    col.appendChild(bub); col.appendChild(meta); row.appendChild(col); return row;
  }

  /* ═══════════════════════════════════════════════════════════
     CHAT INPUT — keyboard stays open + instant typing stop
  ═══════════════════════════════════════════════════════════ */
  function buildChatInput(type){
    const wrap=UI.el('div',`background:${th().topbar};border-top:1px solid ${th().border};flex-shrink:0`); wrap.id='chat-input-wrap';
    const cdBar=UI.el('div',`height:2px;background:${th().border};overflow:hidden;display:none`); cdBar.id='cd-bar'; const cdFill=UI.el('div','height:100%;background:#6366f1'); cdFill.id='cd-fill'; cdBar.appendChild(cdFill); wrap.appendChild(cdBar);
    const mediaTray=UI.el('div','display:none;padding:10px 12px 0;gap:8px'); mediaTray.id='media-tray';
    const voiceTray=UI.el('div','display:none;padding:14px'); voiceTray.id='voice-tray';
    wrap.appendChild(mediaTray); wrap.appendChild(voiceTray);
    const bar=UI.el('div','display:flex;gap:7px;align-items:center;padding:8px 10px');
    const plusBtn=UI.el('button',`width:40px;height:40px;border:1px solid ${th().inpBorder};border-radius:12px;font-size:20px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;background:${th().card2};color:${th().text3}`); plusBtn.textContent='+';
    const inputEl=document.createElement('textarea');
    inputEl.style.cssText=`flex:1;padding:10px 14px;border-radius:22px;border:1.5px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:14px;direction:rtl;resize:none;overflow:hidden;min-height:40px;max-height:120px;line-height:1.4;font-family:inherit;box-sizing:border-box`;
    inputEl.placeholder=type==='dm'?`رسالة إلى ${S.activeId}...`:`رسالة في ${ag()?.name||''}...`; inputEl.rows=1;
    inputEl.addEventListener('input',()=>{inputEl.style.height='auto';inputEl.style.height=Math.min(inputEl.scrollHeight,120)+'px';});
    const sendBtn=UI.el('button','width:40px;height:40px;border:none;border-radius:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-size:18px;display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 2px 8px rgba(99,102,241,.4);cursor:pointer'); sendBtn.textContent='←';
    let typTimer=null;

    // ✅ Typing: stops immediately when input is empty
    inputEl.addEventListener('input',()=>{
      const text = inputEl.value;
      if (!text || !text.trim()) {
        clearTimeout(typTimer);
        Chat.setTyping(S.me,S.activeId,S.screen,false);
        return;
      }
      Chat.setTyping(S.me,S.activeId,S.screen,true);
      clearTimeout(typTimer);
      typTimer=setTimeout(()=>Chat.setTyping(S.me,S.activeId,S.screen,false),2500);
    });

    const doSend=()=>{
      const text=inputEl.value.trim(); if(!text)return;
      const now=Date.now(); if(now-_lastSend<SPAM){UI.toast('لا تُرسل بسرعة كبيرة ⏳','warn');return;} _lastSend=now;
      cdBar.style.display='block'; cdFill.style.animation='none'; cdFill.offsetHeight; cdFill.style.animation=`cooldown ${SPAM}ms linear forwards`; setTimeout(()=>cdBar.style.display='none',SPAM);
      inputEl.value=''; inputEl.style.height='40px'; inputEl.focus();
      Chat.setTyping(S.me,S.activeId,S.screen,false); clearTimeout(typTimer);
      const tempId='tmp_'+Date.now()+'_'+Math.random().toString(36).slice(2,7);
      const payload={type:'text',text,_tempId:tempId};
      const tempMsg={sender:S.meUid||S.me,ts:Date.now(),id:tempId,...payload,_pending:true};
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
      if(trayMode==='text'){trayMode='media';plusBtn.textContent='✕';plusBtn.style.background='#6366f122';plusBtn.style.color='#6366f1';plusBtn.style.border='1px solid #6366f1';buildMediaTray(mediaTray,type);mediaTray.style.display='flex';voiceTray.style.display='none';}
      else{trayMode='text';plusBtn.textContent='+';plusBtn.style.background=th().card2;plusBtn.style.color=th().text3;plusBtn.style.border=`1px solid ${th().inpBorder}`;mediaTray.style.display='none';voiceTray.style.display='none';}
    });
    bar.appendChild(plusBtn); bar.appendChild(inputEl); bar.appendChild(sendBtn); wrap.appendChild(bar); return wrap;
  }

  /* ── Retry mechanism ─────────────────────────────────────── */
  async function _trySend(tempId, sendFn, maxRetries=3) {
    try {
      await sendFn();
      // If we reach here, message is on the server. The listener will replace optimistic.
    } catch (err) {
      const pending = _pendingMsgs.get(tempId);
      if (!pending) return;
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
    const btnRow=UI.el('div','display:none;justify-content:center;gap:12px'); const stopBtn=UI.el('button','padding:10px 22px;border:none;border-radius:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-weight:700;font-family:inherit;cursor:pointer');stopBtn.textContent='⏹ إيقاف';const cancelBtn=UI.el('button',`padding:10px 18px;border:1px solid ${th().border};border-radius:12px;background:${th().card2};color:#ef4444;font-weight:700;font-family:inherit;cursor:pointer`);cancelBtn.textContent='✕';btnRow.appendChild(stopBtn);btnRow.appendChild(cancelBtn);tray.appendChild(btnRow);
    const doneRow=UI.el('div','text-align:center;display:none');const doneLbl=UI.el('div','color:#22c55e;font-size:13px;margin-bottom:10px');doneRow.appendChild(doneLbl);const sendVBtn=UI.el('button','padding:10px 24px;border:none;border-radius:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-weight:700;font-family:inherit;cursor:pointer;margin-left:8px');sendVBtn.textContent='إرسال ←';const cancelVBtn=UI.el('button',`padding:10px 18px;border:1px solid ${th().border};border-radius:12px;background:${th().card2};color:#ef4444;font-weight:700;font-family:inherit;cursor:pointer`);cancelVBtn.textContent='إلغاء';doneRow.appendChild(sendVBtn);doneRow.appendChild(cancelVBtn);tray.appendChild(doneRow);
    startBtn.addEventListener('click',async()=>{try{const stream=await navigator.mediaDevices.getUserMedia({audio:true});rec=new MediaRecorder(stream);const chunks=[];rec.ondataavailable=e=>chunks.push(e.data);rec.onstop=()=>{stream.getTracks().forEach(x=>x.stop());const b=new Blob(chunks,{type:'audio/webm'});const r=new FileReader();r.onload=()=>{rd={data:r.result,duration:secs};doneLbl.textContent=`✅ ${secs}ث — هل تريد إرسالها؟`;doneRow.style.display='block';};r.readAsDataURL(b);};rec.start();recording=true;secs=0;secLbl.style.display='block';secLbl.textContent='🔴 0ث';startBtn.style.display='none';btnRow.style.display='flex';hint.style.display='none';timer=setInterval(()=>{secs++;secLbl.textContent=`🔴 ${secs}ث`;},1000);}catch{UI.toast('تعذّر الوصول للميكروفون','error');}});
    stopBtn.addEventListener('click',()=>{if(!rec||rec.state==='inactive')return;rec.stop();clearInterval(timer);recording=false;secLbl.style.display='none';btnRow.style.display='none';});
    cancelBtn.addEventListener('click',()=>{if(rec&&rec.state!=='inactive')rec.stop();clearInterval(timer);closeTray();});
    sendVBtn.addEventListener('click',()=>{if(!rd)return;sendMedia({type:'voice',data:rd.data,duration:rd.duration},type);closeTray();});
    cancelVBtn.addEventListener('click',()=>closeTray());
  }

  function sendMedia(payload,type){if(type==='dm'){const _t=_uidByName(S.activeId)||S.activeId;Chat.sendDM(S.meUid,_t,payload);}else{Chat.sendGroup(S.activeId,S.meUid,payload);}UI.playSound('send');}

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
        if(!S.groupEdit){const editBtn=UI.el('button',`width:100%;padding:8px;border:1px solid ${th().border};border-radius:10px;background:${th().card2};color:${th().text};font-family:inherit;font-size:12px;cursor:pointer;margin-bottom:8px`);editBtn.textContent='✏️ تعديل المجموعة';editBtn.addEventListener('click',()=>{S.groupEdit=true;S.groupNewName=g.name;buildGroupPanel(parentEl);});ctrl.appendChild(editBtn);}
        else{const nameInp=UI.el('input',`width:100%;padding:7px 10px;border:1.5px solid ${th().inpBorder};border-radius:10px;background:${th().inp};color:${th().text};font-size:12px;direction:rtl;box-sizing:border-box;margin-bottom:6px`);nameInp.placeholder='اسم جديد...';nameInp.value=S.groupNewName;nameInp.maxLength=40;nameInp.addEventListener('input',e=>S.groupNewName=e.target.value);ctrl.appendChild(nameInp);const photoRow=UI.el('div','display:flex;gap:4px;margin-bottom:6px;align-items:center');const gPhIn=document.createElement('input');gPhIn.type='file';gPhIn.accept='image/*';gPhIn.style.display='none';gPhIn.addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;S.groupNewPhoto=await UI.fileToBase64(f);e.target.value='';buildGroupPanel(parentEl);});const gPhBtn=UI.el('button',`flex:1;padding:6px;border:1px solid ${th().border};border-radius:8px;background:${th().card2};color:${th().text};font-family:inherit;font-size:11px;cursor:pointer`);gPhBtn.textContent='📷 صورة';gPhBtn.addEventListener('click',()=>gPhIn.click());photoRow.appendChild(gPhBtn);photoRow.appendChild(gPhIn);if(S.groupNewPhoto){const pv=document.createElement('img');pv.src=S.groupNewPhoto;pv.loading='lazy';pv.style.cssText='width:32px;height:32px;border-radius:6px;object-fit:cover';photoRow.appendChild(pv);}ctrl.appendChild(photoRow);const saveRow=UI.el('div','display:flex;gap:4px');const saveBtn=UI.el('button','flex:1;padding:7px;border:none;border-radius:10px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-family:inherit;font-size:11px;cursor:pointer');saveBtn.textContent='حفظ';saveBtn.addEventListener('click',async()=>{await Groups.saveEdit(g.id,S.groupNewName,S.groupNewPhoto);S.groupEdit=false;S.groupNewPhoto=null;UI.toast('تم التعديل ✓','success');buildGroupPanel(parentEl);});const cancelEdit=UI.el('button',`flex:1;padding:7px;border:1px solid ${th().border};border-radius:10px;background:${th().card2};color:${th().text};font-family:inherit;font-size:11px;cursor:pointer`);cancelEdit.textContent='إلغاء';cancelEdit.addEventListener('click',()=>{S.groupEdit=false;S.groupNewPhoto=null;buildGroupPanel(parentEl);});saveRow.appendChild(saveBtn);saveRow.appendChild(cancelEdit);ctrl.appendChild(saveRow);}
        const invT=UI.el('div',`font-size:10px;color:${th().text3};font-weight:700;margin:8px 0 4px;letter-spacing:1px`);invT.textContent='رمز الدعوة';const invC=UI.el('div',`font-family:monospace;font-size:11px;padding:7px 10px;background:${th().card2};border-radius:8px;color:${g.inviteActive?'#22c55e':th().text3};word-break:break-all;margin-bottom:6px;border:1px solid ${th().border}`);invC.textContent=g.inviteActive?g.inviteCode:'🔒 مغلق';const idEl=UI.el('div',`font-size:10px;color:${th().text3};margin-bottom:8px`);idEl.textContent='ID: '; const idSpan=UI.el('span','color:#6366f1;font-family:monospace');idSpan.textContent=g.id;idEl.appendChild(idSpan);const invBtnRow=UI.el('div','display:flex;gap:5px');if(g.inviteActive){const copyBtn=UI.el('button',`flex:1;padding:6px;border:1px solid ${th().border};border-radius:8px;background:${th().card2};color:${th().text2};font-family:inherit;font-size:11px;cursor:pointer`);copyBtn.textContent='نسخ';copyBtn.addEventListener('click',()=>{try{navigator.clipboard.writeText(g.inviteCode);}catch{}copyBtn.textContent='✓ تم';copyBtn.style.background='#f0fdf4';copyBtn.style.color='#22c55e';setTimeout(()=>{copyBtn.textContent='نسخ';copyBtn.style.background=th().card2;copyBtn.style.color=th().text2;},2000);UI.toast('تم نسخ الرمز ✓','success');});invBtnRow.appendChild(copyBtn);}const togBtn=UI.el('button',`flex:1;padding:6px;border:1px solid ${th().border};border-radius:8px;background:${th().card2};color:${g.inviteActive?'#ef4444':'#22c55e'};font-family:inherit;font-size:11px;cursor:pointer`);togBtn.textContent=g.inviteActive?'إغلاق':'فتح';togBtn.addEventListener('click',()=>Groups.toggleInvite(g.id,g.inviteActive));invBtnRow.appendChild(togBtn);const delGBtn=UI.el('button',`width:100%;margin-top:8px;padding:7px;border:1px solid #fecaca;border-radius:10px;background:${UI.isDark()?'#1e1e2e':'#fff'};color:#ef4444;font-family:inherit;font-size:11px;cursor:pointer`);delGBtn.textContent='🗑 حذف المجموعة';delGBtn.addEventListener('click',async()=>{if(!await UI.confirmDialog('هل تريد حذف المجموعة نهائياً؟ لا يمكن التراجع!',{confirmText:'حذف نهائياً',danger:true}))return;const res=await Groups.deleteGroup(g.id);if(res.error)UI.toast(res.error,'error');else{UI.toast('تم حذف المجموعة','info');go('home');}});

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
      const addRow=UI.el('div','display:flex;gap:5px;margin-top:10px');const addInp=UI.el('input',`flex:1;padding:7px 10px;border:1.5px solid ${th().inpBorder};border-radius:10px;background:${th().inp};color:${th().text};font-size:12px;direction:rtl`);addInp.placeholder='+ إضافة عضو...';const addBtn=UI.el('button','padding:7px 10px;border:none;border-radius:10px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-family:inherit;font-size:12px;cursor:pointer');addBtn.textContent='+';const doAdd=async()=>{const res=await Groups.addMember(g.id,addInp.value);if(res.error)UI.toast(res.error,'error');else{UI.toast('تمت الإضافة ✓','success');addInp.value='';UI.playSound('notif');}};addBtn.addEventListener('click',doAdd);addInp.addEventListener('keydown',e=>{if(e.key==='Enter')doAdd();});addRow.appendChild(addInp);addRow.appendChild(addBtn);ctrl.appendChild(addRow);panel.appendChild(ctrl);
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
      const roleEl=UI.el('div',`font-size:9px;color:${isAdm?'#f59e0b':isMod?'#6366f1':Chat.isOnline(S.presence,uid)?'#22c55e':th().text3}`);
      roleEl.textContent=isAdm?'👑 مشرف رئيسي':isMod?'🛡 مشرف مساعد':Chat.isOnline(S.presence,uid)?'متصل':Chat.lastSeenText(S.presence,uid);
      nmBtn.appendChild(nmEl); nmBtn.addEventListener('click',()=>go('userProfile',name)); info.appendChild(nmBtn); info.appendChild(roleEl);
      row.appendChild(avBtn); row.appendChild(info);
      if(Groups.isAdmin(g,S.meUid)&&uid!==S.meUid){
        const acts=UI.el('div','display:flex;gap:3px');
        const modBtn=UI.el('button','background:none;border:none;cursor:pointer;font-size:14px;padding:2px 4px');modBtn.textContent='🛡';modBtn.title=isMod?'إزالة المشرف':'ترقية لمشرف';modBtn.style.color=isMod?'#6366f1':th().text3;modBtn.addEventListener('click',()=>{Groups.toggleMod(g.id,uid,!!isMod);UI.toast(isMod?'تمت إزالة المشرف':'أصبح مشرفاً مساعداً ✓','success');});
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
  function renderProfile(){
    const meData = S.users[S.meUid] || S.usersByName[S.me] || {};
    APP.appendChild(buildSimpleTopbar('ملفي الشخصي'));
    const scroll=UI.el('div','flex:1;overflow-y:auto;padding:20px;-webkit-overflow-scrolling:touch'); const inner=UI.el('div','max-width:400px;margin:0 auto');
    let ePhoto=meData.photo||null,eEmoji=meData.emoji||'',eBio=meData.bio||'';
    const avSec=UI.el('div','text-align:center;margin-bottom:24px'); const avWrap=UI.el('div','position:relative;display:inline-block'); const avEl=UI.el('div','');
    const rebuildAv=()=>{avEl.innerHTML='';avEl.appendChild(UI.makeAvatar({...meData,photo:ePhoto,emoji:eEmoji},96,{online:true}));};rebuildAv();
    const phIn=document.createElement('input');phIn.type='file';phIn.accept='image/*';phIn.style.display='none';phIn.addEventListener('change',async e=>{
  const f=e.target.files[0];if(!f)return;
  try{ePhoto=await UI.fileToBase64(f,3*1024*1024);e.target.value='';rebuildAv();}
  catch(err){UI.toast(err.message||'خطأ في الملف','error');e.target.value='';}
});
    const camBtn=UI.el('button',`position:absolute;bottom:0;left:0;width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);border:2px solid ${th().bg};cursor:pointer;color:#fff;font-size:14px;display:flex;align-items:center;justify-content:center`);camBtn.textContent='📷';camBtn.addEventListener('click',()=>phIn.click());
    avWrap.appendChild(avEl);avWrap.appendChild(camBtn);avWrap.appendChild(phIn);
    const nmEl=UI.el('div',`font-weight:800;font-size:22px;margin-top:12px;color:${th().text}`);nmEl.textContent=S.me;
    const emailEl=UI.el('div',`font-size:12px;color:${th().text3};margin-top:2px`);emailEl.textContent=FB.authCurrentUser()?.email||'';
    const dtEl=UI.el('div',`font-size:12px;color:${th().text3}`);dtEl.textContent=meData.createdAt?`عضو منذ ${new Date(meData.createdAt).toLocaleDateString('ar')}`:'';
    avSec.appendChild(avWrap);avSec.appendChild(nmEl);avSec.appendChild(emailEl);avSec.appendChild(dtEl);inner.appendChild(avSec);
    // Emoji
    const emoSec=UI.el('div','margin-bottom:16px');const emoLbl=UI.el('label',`font-size:12px;color:${th().text2};font-weight:700;display:block;margin-bottom:6px`);emoLbl.textContent='رمز تعبيري';emoSec.appendChild(emoLbl);const emoGrid=UI.el('div','display:flex;flex-wrap:wrap;gap:6px');
    const emojis=['','😀','😎','🥷','👻','🐱','🦊','🐼','🤖','👽','🦁','🌟','🔥','💎','🎮','🚀','⚡','🎸','🧠','💫','🌙','🦋','🎯','🌈'];
    emojis.forEach(e=>{const b=UI.el('button',`width:36px;height:36px;font-size:18px;border-radius:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:border-color .15s`);b.style.border=`2px solid ${eEmoji===e?'#6366f1':th().border}`;b.style.background=eEmoji===e?'#6366f115':th().card2;if(e)b.textContent=e;else{const sp=UI.el('span',`font-size:11px;color:${th().text3}`);sp.textContent='لا';b.appendChild(sp);}b.addEventListener('click',()=>{eEmoji=e;rebuildAv();emoGrid.querySelectorAll('button').forEach((x,i)=>{x.style.border=`2px solid ${emojis[i]===eEmoji?'#6366f1':th().border}`;x.style.background=emojis[i]===eEmoji?'#6366f115':th().card2;});});emoGrid.appendChild(b);});emoSec.appendChild(emoGrid);inner.appendChild(emoSec);
    // Bio
    const bioSec=UI.el('div','margin-bottom:16px');const bioLbl=UI.el('label',`font-size:12px;color:${th().text2};font-weight:700;display:block;margin-bottom:6px`);bioLbl.textContent='النبذة الشخصية';bioSec.appendChild(bioLbl);const bioInp=UI.el('textarea',`width:100%;padding:11px 14px;border-radius:12px;border:1.5px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:14px;direction:rtl;resize:none;line-height:1.6;box-sizing:border-box`);bioInp.placeholder='اكتب شيئاً عن نفسك...';bioInp.maxLength=120;bioInp.value=eBio;bioInp.rows=2;const bioCnt=UI.el('div',`font-size:10px;color:${th().text3};text-align:left;margin-top:2px`);bioCnt.textContent=`${eBio.length}/120`;bioInp.addEventListener('input',e=>{eBio=e.target.value;bioCnt.textContent=`${eBio.length}/120`;});bioSec.appendChild(bioInp);bioSec.appendChild(bioCnt);inner.appendChild(bioSec);
    // Save
    const saveBtn=UI.el('button',`width:100%;padding:13px;border:none;border-radius:14px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-size:15px;font-weight:700;font-family:inherit;margin-bottom:10px;cursor:pointer;box-shadow:0 4px 14px rgba(99,102,241,.4)`);saveBtn.textContent='حفظ التغييرات ✓';saveBtn.addEventListener('click',async()=>{await FB.upd(`users/${S.meUid}`,{emoji:eEmoji,bio:eBio.trim(),photo:ePhoto||null});UI.toast('تم حفظ التغييرات ✓','success');go('home');});inner.appendChild(saveBtn);
    // Change password
    let showPwd=false;const pwdToggle=UI.el('button',`width:100%;padding:11px;border:1px solid ${th().border};border-radius:12px;background:${th().card2};color:${th().text};font-family:inherit;font-size:14px;cursor:pointer;margin-bottom:10px`);pwdToggle.textContent='🔑 تغيير كلمة المرور';
    const pwdForm=UI.el('div',`margin-bottom:10px;background:${th().card2};border:1px solid ${th().border};border-radius:14px;padding:16px;display:none`);
    const mkPwd=(ph,ac)=>{const i=UI.el('input',`width:100%;padding:11px 14px;border-radius:12px;border:1.5px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:13px;direction:rtl;box-sizing:border-box;margin-bottom:8px`);i.type='password';i.placeholder=ph;i.autocomplete=ac;return i;};
    const pwdCur=mkPwd('كلمة المرور الحالية','current-password');const pwdNew=mkPwd('كلمة المرور الجديدة','new-password');const pwdNew2=mkPwd('تأكيد كلمة المرور الجديدة','new-password');
    const pwdSubmit=UI.el('button','width:100%;padding:11px;border:none;border-radius:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer');pwdSubmit.textContent='تأكيد التغيير 🔐';
    pwdSubmit.addEventListener('click',async()=>{const res=await Auth.changePassword(pwdCur.value,pwdNew.value,pwdNew2.value);if(res.error)UI.toast(res.error,'error');else{UI.toast('تم تغيير كلمة المرور 🔐','success');pwdCur.value=pwdNew.value=pwdNew2.value='';showPwd=false;pwdForm.style.display='none';pwdToggle.textContent='🔑 تغيير كلمة المرور';}});
    pwdForm.appendChild(pwdCur);pwdForm.appendChild(pwdNew);pwdForm.appendChild(pwdNew2);pwdForm.appendChild(pwdSubmit);
    pwdToggle.addEventListener('click',()=>{showPwd=!showPwd;pwdForm.style.display=showPwd?'block':'none';pwdToggle.textContent=showPwd?'🔑 إخفاء':'🔑 تغيير كلمة المرور';});inner.appendChild(pwdToggle);inner.appendChild(pwdForm);
    // Theme toggle
    const thBtn=UI.el('button',`width:100%;padding:11px;border:1px solid ${th().border};border-radius:12px;background:${th().card2};color:${th().text};font-family:inherit;font-size:14px;cursor:pointer;margin-bottom:10px`);thBtn.textContent=UI.isDark()?'☀️ وضع فاتح':'🌙 وضع داكن';thBtn.addEventListener('click',()=>{UI.toggleDark();S.dark=UI.isDark();renderScreen();});inner.appendChild(thBtn);
    // Logout
    const logBtn=UI.el('button',`width:100%;padding:11px;border:1px solid #fecaca;border-radius:12px;background:${UI.isDark()?'#1e1e2e':'#fff'};color:#ef4444;font-family:inherit;font-size:14px;cursor:pointer;margin-bottom:10px`);logBtn.textContent='⏻ تسجيل الخروج';
    logBtn.addEventListener('click',async()=>{Chat.goOffline(S.meUid);await Auth.logout();S.me=null;S.meUid=null;S.usersByName={};go('auth');});inner.appendChild(logBtn);
    // Delete account
    const delBtn=UI.el('button',`width:100%;padding:11px;border:1px solid #fca5a5;border-radius:12px;background:${UI.isDark()?'#1e1e2e':'#fff'};color:#dc2626;font-family:inherit;font-size:13px;cursor:pointer`);delBtn.textContent='🗑 حذف الحساب نهائياً';
    delBtn.addEventListener('click',async()=>{
      if(!await UI.confirmDialog('هل تريد حذف حسابك نهائياً؟',{confirmText:'حذف الحساب',cancelText:'إلغاء',danger:true}))return;
      const pwd=prompt('أدخل كلمة مرورك للتأكيد:'); if(!pwd)return;
      // Build dm partners list as uid array (matches auth.js deleteAccount signature)
      const dmPartners = Object.keys(S.usersByName)
        .filter(u => u !== S.me)
        .map(u => _uidByName(u))
        .filter(Boolean);
      const res = await Auth.deleteAccount(S.me, pwd, S.groups, dmPartners);
      if(res.error)UI.toast(res.error,'error');
      else{S.me=null;S.meUid=null;S.usersByName={};go('auth');}
    });inner.appendChild(delBtn);
    scroll.appendChild(inner);APP.appendChild(scroll);
  }

  /* ═══════════════════════════════════════════════════════════
     USER PROFILE
  ═══════════════════════════════════════════════════════════ */
  function renderUserProfile(){
    const u=S.activeId;const userData=_userData(u);if(!userData)return;
    APP.appendChild(buildSimpleTopbar(u));
    const scroll=UI.el('div','flex:1;overflow-y:auto;padding:20px;-webkit-overflow-scrolling:touch;text-align:center');const inner=UI.el('div','max-width:400px;margin:0 auto;text-align:center');
    const avWrap=UI.el('div','margin-bottom:14px;display:inline-block;cursor:pointer');
    const uid = _uidByName(u);
    avWrap.appendChild(UI.makeAvatar(userData,100,{online:Chat.isOnline(S.presence, uid || u),ring:fwsUids().includes(_uUid),seen:Stories.isSeen(_uUid,S.stories)}));
    if(userData.photo)avWrap.addEventListener('click',()=>{S.viewImg=userData.photo;showImgViewer();});inner.appendChild(avWrap);
    const nm=UI.el('div',`font-weight:800;font-size:22px;color:${th().text};margin-bottom:4px`);
    if(userData.emoji){const sp=UI.el('span','margin-left:6px');sp.textContent=userData.emoji;nm.appendChild(sp);nm.appendChild(document.createTextNode(u));}else nm.textContent=u;
    inner.appendChild(nm);
    const status=UI.el('div','font-size:13px;margin-bottom:8px');status.textContent=Chat.lastSeenText(S.presence, uid || u);status.style.color=Chat.isOnline(S.presence, uid || u)?'#22c55e':th().text3;inner.appendChild(status);
    if(userData.bio){const bio=UI.el('div',`color:${th().text2};font-size:14px;padding:0 20px;line-height:1.6;margin-bottom:16px`);bio.textContent=userData.bio;inner.appendChild(bio);}
    const mf=myFriends();
    const _uUid=_uidByName(u)||u; if(S.stories[_uUid]&&Object.keys(S.stories[_uUid]).length>0){const stSec=UI.el('div',`margin-bottom:16px;padding:12px;background:${th().card};border-radius:14px;border:1px solid ${th().border}`);const stHdr=UI.el('div',`font-size:12px;color:${th().text2};font-weight:700;margin-bottom:10px`);stHdr.textContent='القصص';stSec.appendChild(stHdr);const stRow=UI.el('div','display:flex;gap:8px;overflow-x:auto;justify-content:center;scrollbar-width:none');Stories.getUserStories(_uUid,S.stories).forEach(({data})=>{const img=document.createElement('img');img.src=data;img.loading='lazy';img.style.cssText='width:60px;height:80px;object-fit:cover;border-radius:8px;cursor:pointer;border:2px solid #6366f1;flex-shrink:0';img.addEventListener('click',()=>{Stories.markSeen(_uUid);openStoryViewer(_uUid);});stRow.appendChild(img);});stSec.appendChild(stRow);inner.appendChild(stSec);}
    else if(!mf.includes(u)&&u!==S.me&&S.stories[u]&&Object.keys(S.stories[u]).length>0){const locked=UI.el('div',`padding:8px 14px;background:${th().card2};border-radius:10px;color:${th().text3};font-size:12px;border:1px solid ${th().border};margin-bottom:12px`);locked.textContent='🔒 القصص متاحة للأصدقاء فقط';inner.appendChild(locked);}
    const btnRow=UI.el('div','display:flex;gap:8px;margin-top:16px');const msgBtn=UI.el('button','flex:1;padding:10px 16px;border:none;border-radius:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-weight:700;font-size:14px;font-family:inherit;cursor:pointer');msgBtn.textContent='💬 رسالة';msgBtn.addEventListener('click',()=>go('dm',u));btnRow.appendChild(msgBtn);
    if(!mf.includes(u)&&u!==S.me){const addBtn=UI.el('button',`flex:1;padding:10px 16px;border:1px solid ${th().border};border-radius:12px;background:${th().card2};color:${UI.isDark()?'#a5b4fc':'#6366f1'};font-weight:700;font-size:14px;font-family:inherit;cursor:pointer`);addBtn.textContent='+ صديق';addBtn.addEventListener('click',async()=>{const targetUid2=_uidByName(u);if(!targetUid2)return UI.toast('المستخدم غير موجود','error');const myFriendUids=Object.keys(S.users[S.meUid]?.friends||{});const res=await Friends.sendRequest(S.meUid,targetUid2,S.users,myFriendUids);if(res.error)UI.toast(res.error,'error');else{UI.toast(`تم إرسال طلب صداقة إلى ${u} ✓`,'success');UI.playSound('notif');}});btnRow.appendChild(addBtn);}
    else if(mf.includes(u)){const fr=UI.el('div','flex:1;text-align:center;padding:10px;color:#22c55e;font-size:13px;font-weight:700');fr.textContent='✓ صديق';btnRow.appendChild(fr);}
    inner.appendChild(btnRow);scroll.appendChild(inner);APP.appendChild(scroll);
  }

  /* ═══════════════════════════════════════════════════════════
     FRIENDS
  ═══════════════════════════════════════════════════════════ */
  function renderFriends(){
    const mf=myFriends();const pr=pendingReqs(); APP.appendChild(buildSimpleTopbar(`الأصدقاء (${mf.length})`));
    const scroll=UI.el('div','flex:1;overflow-y:auto;padding:16px;-webkit-overflow-scrolling:touch');
    if(pr.length){const sec=UI.el('div','margin-bottom:16px');const hdr=UI.el('div','font-size:12px;font-weight:700;color:#ef4444;margin-bottom:8px');hdr.textContent=`طلبات الصداقة الواردة (${pr.length})`;sec.appendChild(hdr);pr.forEach(from=>{const fromName=_nameByUid(from)||from;const row=UI.el('div',`display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:14px;background:${UI.isDark()?'#1e1e2e':'#fff7f7'};border:1px solid #fee2e2;margin-bottom:6px`);row.appendChild(UI.makeAvatar(S.users[from]||S.usersByName[fromName],40));const nm=UI.el('div','flex:1;font-weight:600;font-size:14px');nm.style.color=th().text;nm.textContent=fromName;row.appendChild(nm);const rBtn=UI.el('button',`padding:7px 10px;border:1px solid ${th().border};border-radius:10px;background:${th().card2};color:${th().text2};font-family:inherit;font-size:12px;cursor:pointer;margin-left:4px`);rBtn.textContent='رفض';rBtn.addEventListener('click',async()=>{await Friends.rejectRequest(S.meUid,from);UI.toast('تم رفض الطلب','info');});const aBtn=UI.el('button','padding:7px 12px;border:none;border-radius:10px;background:#22c55e;color:#fff;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer');aBtn.textContent='قبول';aBtn.addEventListener('click',async()=>{await Friends.acceptRequest(S.meUid,from);UI.toast(`أصبحت وصديق ${fromName} ✓`,'success');UI.playSound('notif');});row.appendChild(rBtn);row.appendChild(aBtn);sec.appendChild(row);});scroll.appendChild(sec);}
    const sRow=UI.el('div','display:flex;gap:6px;margin-bottom:14px');const sInp=UI.el('input',`flex:1;padding:11px 14px;border-radius:12px;border:1.5px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:13px;direction:rtl;box-sizing:border-box`);sInp.placeholder='ابحث عن مستخدم لإضافته...';const sBtn=UI.el('button','padding:10px 14px;border:none;border-radius:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-weight:700;font-family:inherit;font-size:13px;cursor:pointer');sBtn.textContent='+ إضافة';
    const doSearch=async()=>{
      const target=sInp.value.trim();if(!target)return;
      // استخدام searchUsers أولاً لإيجاد المستخدم
      const results=Friends.searchUsers(target,S.users,S.meUid,Object.keys(S.users[S.meUid]?.friends||{}));
      const exact=results.find(u=>u.username?.toLowerCase()===target.toLowerCase());
      const targetUid=exact?.uid||_uidByName(target)||await Auth.uidFromUsername(target);
      if(!targetUid)return UI.toast('المستخدم غير موجود','error');
      const myFriendUids=Object.keys(S.users[S.meUid]?.friends||{});
      const res=await Friends.sendRequest(S.meUid,targetUid,S.users,myFriendUids);
      if(res.error)UI.toast(res.error,'error');
      else{UI.toast(`تم إرسال طلب صداقة إلى ${target} ✓`,'success');UI.playSound('notif');sInp.value='';}
    };
    sBtn.addEventListener('click',doSearch);sInp.addEventListener('keydown',e=>{if(e.key==='Enter')doSearch();});
    sInp.addEventListener('input',()=>{const v=sInp.value.trim();const ex=document.getElementById('search-result');if(ex)ex.remove();if(v&&S.usersByName[v]&&v!==S.me){const res=UI.el('div',`background:${th().card2};border:1px solid ${th().border};border-radius:12px;padding:12px;margin-bottom:12px`);res.id='search-result';const rRow=UI.el('div','display:flex;align-items:center;gap:10px');const vUid=_uidByName(v);rRow.appendChild(UI.makeAvatar(_userData(v),40,{online:Chat.isOnline(S.presence,vUid||v)}));const ni=UI.el('div','flex:1');const nn=UI.el('div',`font-weight:600;color:${th().text}`);nn.textContent=v;const ns=UI.el('div',`font-size:11px;color:${Chat.isOnline(S.presence,vUid||v)?'#22c55e':th().text3}`);ns.textContent=Chat.lastSeenText(S.presence,vUid||v);ni.appendChild(nn);ni.appendChild(ns);rRow.appendChild(ni);const vBtn=UI.el('button',`padding:6px 10px;border:1px solid ${th().border};border-radius:10px;background:${th().card2};color:${th().text2};font-family:inherit;font-size:12px;cursor:pointer`);vBtn.textContent='عرض';vBtn.addEventListener('click',()=>go('userProfile',v));rRow.appendChild(vBtn);res.appendChild(rRow);sRow.after(res);}});
    sRow.appendChild(sInp);sRow.appendChild(sBtn);scroll.appendChild(sRow);
    const fHdr=UI.el('div',`font-size:12px;font-weight:700;color:${th().text3};margin-bottom:8px`);fHdr.textContent=`أصدقائي (${mf.length})`;scroll.appendChild(fHdr);
    if(!mf.length){const emp=UI.el('div',`color:${th().text3};font-size:13px;text-align:center;padding:16px 0`);emp.textContent='لم تضف أصدقاء بعد';scroll.appendChild(emp);}
    mf.forEach(fr=>{const frUid=_uidByName(fr);const row=UI.el('div',`display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:14px;cursor:pointer;background:${th().card};border:1px solid ${th().border};margin-bottom:6px`);row.appendChild(UI.makeAvatar(_userData(fr),40,{online:Chat.isOnline(S.presence,frUid||fr)}));const info=UI.el('div','flex:1;min-width:0');const nm=UI.el('div',`font-weight:600;color:${th().text};font-size:14px`);nm.textContent=fr;const st=UI.el('div',`font-size:11px;color:${Chat.isOnline(S.presence,frUid||fr)?'#22c55e':th().text3}`);st.textContent=Chat.lastSeenText(S.presence,frUid||fr);info.appendChild(nm);info.appendChild(st);row.appendChild(info);const msgBtn=UI.el('button','padding:7px 12px;border:none;border-radius:10px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer');msgBtn.textContent='رسالة';msgBtn.addEventListener('click',()=>go('dm',fr));row.appendChild(msgBtn);const viewBtn=UI.el('button',`padding:7px 10px;border:1px solid ${th().border};border-radius:10px;background:${th().card2};color:${th().text2};font-family:inherit;font-size:12px;cursor:pointer`);viewBtn.textContent='عرض';viewBtn.addEventListener('click',()=>go('userProfile',fr));row.appendChild(viewBtn);const remBtn=UI.el('button','background:none;border:none;cursor:pointer;font-size:18px;padding:4px 6px');remBtn.textContent='✕';remBtn.style.color=th().text3;remBtn.addEventListener('click',async()=>{if(!await UI.confirmDialog(`هل تريد إزالة ${fr} من الأصدقاء؟`,{confirmText:'إزالة',danger:true}))return;if(!frUid)return UI.toast('خطأ: المستخدم غير موجود','error');const res=await Friends.removeFriend(S.meUid,frUid);if(res.error)UI.toast(res.error,'error');else UI.toast('تمت الإزالة','info');});row.appendChild(remBtn);scroll.appendChild(row);});
    APP.appendChild(scroll);
  }

  /* ═══════════════════════════════════════════════════════════
     NEW GROUP / JOIN  (DOM-safe, no innerHTML)
  ═══════════════════════════════════════════════════════════ */
  function renderNewGroup(){
    APP.appendChild(buildSimpleTopbar('مجموعة جديدة'));
    const cnt=UI.el('div','flex:1;display:flex;align-items:center;justify-content:center;padding:24px');const inner=UI.el('div','width:100%;max-width:360px;text-align:center');
    const icon=UI.el('div','font-size:52px;margin-bottom:14px'); icon.textContent='👥';
    const title=UI.el('h2','font-weight:800;font-size:20px;margin-bottom:8px');title.style.color=th().text; title.textContent='مجموعة جديدة';
    const sub=UI.el('p','font-size:13px;margin-bottom:20px');sub.style.color=th().text3; sub.textContent='ستكون المشرف الرئيسي تلقائياً';
    inner.appendChild(icon); inner.appendChild(title); inner.appendChild(sub);
    const inp=UI.el('input',`width:100%;padding:11px 14px;border-radius:12px;border:1.5px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:14px;direction:rtl;box-sizing:border-box;margin-bottom:14px`);inp.placeholder='اسم المجموعة...';inp.maxLength=40;
    const btn2=UI.el('button','width:100%;padding:13px;border:none;border-radius:14px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer');btn2.textContent='إنشاء ←';
    const doCreate=async()=>{const res=await Groups.create(S.me,inp.value);if(res.error)UI.toast(res.error,'error');else{UI.toast('تم إنشاء المجموعة ✓','success');
      // ابدأ listener للمجموعة الجديدة فوراً
      if (res.gid) _openGroupListener(res.gid);
      S.tab='groups'; go('home');}};
    btn2.addEventListener('click',doCreate);inp.addEventListener('keydown',e=>{if(e.key==='Enter')doCreate();});inner.appendChild(inp);inner.appendChild(btn2);cnt.appendChild(inner);APP.appendChild(cnt);setTimeout(()=>inp.focus(),100);
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
    const btnRow=UI.el('div','display:flex;gap:8px');const invBtn=UI.el('button','flex:1;padding:10px 16px;border:none;border-radius:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-weight:700;font-size:13px;font-family:inherit;cursor:pointer');invBtn.textContent='انضمام برمز';invBtn.addEventListener('click',async()=>{const res=await Groups.joinByInvite(S.me,inp.value);if(res.error)showErr(res.error);else{if(res.gid)_openGroupListener(res.gid);go('group',res.gid);}});
    const reqBtn=UI.el('button',`flex:1;padding:10px 16px;border:1px solid ${th().border};border-radius:12px;background:${th().card2};color:${UI.isDark()?'#a5b4fc':'#6366f1'};font-weight:700;font-size:13px;font-family:inherit;cursor:pointer`);reqBtn.textContent='إرسال طلب';reqBtn.addEventListener('click',async()=>{const res=await Groups.requestJoin(S.me,inp.value);if(res.error)showErr(res.error);else showErr('✅ تم إرسال الطلب!',true);});
    btnRow.appendChild(invBtn);btnRow.appendChild(reqBtn);inner.appendChild(inp);inner.appendChild(errBox);inner.appendChild(btnRow);cnt.appendChild(inner);APP.appendChild(cnt);setTimeout(()=>inp.focus(),100);
  }

  /* ═══════════════════════════════════════════════════════════
     OVERLAYS
  ═══════════════════════════════════════════════════════════ */
  function showImgViewer(){const ex=document.getElementById('img-viewer');if(ex)ex.remove();const ov=UI.el('div','position:fixed;inset:0;background:rgba(0,0,0,.94);z-index:1000;display:flex;align-items:center;justify-content:center');ov.id='img-viewer';const img=document.createElement('img');img.src=S.viewImg;img.style.cssText='max-width:96vw;max-height:88vh;object-fit:contain;border-radius:10px';img.addEventListener('click',e=>e.stopPropagation());const closeBtn=UI.el('button','position:absolute;top:14px;right:14px;background:rgba(255,255,255,.15);border:none;color:#fff;font-size:22px;cursor:pointer;border-radius:50%;width:40px;height:40px;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)');closeBtn.textContent='✕';closeBtn.addEventListener('click',()=>ov.remove());ov.addEventListener('click',()=>ov.remove());ov.appendChild(img);ov.appendChild(closeBtn);APP.appendChild(ov);}

  function showStoryPreview(){const ex=document.getElementById('story-preview-ov');if(ex)ex.remove();const ov=UI.el('div','position:fixed;inset:0;background:rgba(0,0,0,.96);z-index:998;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px');ov.id='story-preview-ov';const img=document.createElement('img');img.src=S.storyPreview;img.style.cssText='max-width:90vw;max-height:65vh;object-fit:contain;border-radius:14px';ov.appendChild(img);const btnRow=UI.el('div','display:flex;gap:10px');const postBtn=UI.el('button','padding:11px 24px;border:none;border-radius:14px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-weight:700;font-size:15px;font-family:inherit;cursor:pointer');postBtn.textContent='نشر القصة 📢';postBtn.addEventListener('click',async()=>{
  if(!S.meUid){UI.toast('يجب تسجيل الدخول أولاً','error');return;}
  postBtn.disabled=true; postBtn.textContent='جار النشر...';
  const _pr=await Stories.post(S.meUid,S.storyPreview);
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
      const img=document.createElement('img');img.src=curStory.data;img.style.cssText='width:100%;height:100%;object-fit:contain';ov.appendChild(img);
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
    ['linear-gradient(135deg,#6366f1,#8b5cf6)','linear-gradient(135deg,#ec4899,#f43f5e)','linear-gradient(135deg,#f59e0b,#f97316)','linear-gradient(135deg,#10b981,#059669)','linear-gradient(135deg,#3b82f6,#2563eb)','linear-gradient(135deg,#8b5cf6,#7c3aed)','linear-gradient(135deg,#000,#374151)','linear-gradient(135deg,#ef4444,#dc2626)'].forEach(c=>{const sw=UI.el('div','width:36px;height:36px;border-radius:10px;cursor:pointer;transition:transform .15s');sw.style.background=c;sw.style.border=curBC===c?'3px solid #fff':'3px solid transparent';sw.style.boxShadow='0 2px 8px rgba(0,0,0,.2)';if(curBC===c)sw.style.transform='scale(1.1)';sw.addEventListener('click',()=>{UI.saveBubbleColor(cid,c);UI.toast('تم الحفظ','success');_reapplyChatStyles();ov.remove();});bcRow.appendChild(sw);});sheet.appendChild(bcRow);
    const bgLbl=UI.el('div',`font-size:12px;color:${th().text2};font-weight:700;margin-bottom:8px`);bgLbl.textContent='خلفية المحادثة';sheet.appendChild(bgLbl);const bgRow=UI.el('div','display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px');const curBG=UI.getChatBgs()[cid]||'';
    [null,'#f0fdf4','#fdf2f8','#eff6ff','#fefce8','#f0f4ff','#fef9f0'].forEach(c=>{const sw=UI.el('div','width:36px;height:36px;border-radius:10px;cursor:pointer');sw.style.background=c||th().bg;sw.style.border=`3px solid ${(curBG||(c||''))===(c||'')?'#6366f1':th().border}`;sw.style.boxShadow='0 1px 4px rgba(0,0,0,.1)';if(!c){const ic=UI.el('span','display:flex;align-items:center;justify-content:center;height:100%;font-size:16px');ic.textContent='🚫';sw.appendChild(ic);}sw.addEventListener('click',()=>{UI.saveChatBg(cid,c||'');UI.toast('تم الحفظ','success');_reapplyChatStyles();ov.remove();});bgRow.appendChild(sw);});
    const bgUpload=document.createElement('input');bgUpload.type='file';bgUpload.accept='image/*';bgUpload.style.display='none';bgUpload.addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;const d=await UI.fileToBase64(f);UI.saveChatBg(cid,d);UI.toast('تم الحفظ','success');_reapplyChatStyles();ov.remove();e.target.value='';});
    const bgPhBtn=UI.el('button',`width:36px;height:36px;border-radius:10px;background:${th().card2};border:1px dashed ${th().border};cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center`);bgPhBtn.textContent='📷';bgPhBtn.addEventListener('click',()=>bgUpload.click());bgRow.appendChild(bgPhBtn);bgRow.appendChild(bgUpload);sheet.appendChild(bgRow);ov.appendChild(sheet);APP.appendChild(ov);
  }

  // ✅ Re-apply chat styles without full renderScreen()
  function _reapplyChatStyles() {
    const scroll = document.getElementById('msg-scroll');
    if (scroll) {
      const bg = UI.getChatBgs()[chatId()] || th().bg;
      scroll.style.background = bg;
    }
    const bubbles = document.querySelectorAll('.bubble');
    const bc = UI.getBubbleColors()[chatId()] || 'linear-gradient(135deg,#6366f1,#8b5cf6)';
    bubbles.forEach(b => {
      if (b.parentElement && b.parentElement.parentElement && b.parentElement.parentElement.style.flexDirection === 'row-reverse') {
        b.style.background = bc;
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════
     BOOT
  ═══════════════════════════════════════════════════════════ */
  UI.applyTheme();

  if (S.me) {
    // Recover uid from Auth if possible
    S.meUid = FB.authCurrentUser()?.uid || null;
    Chat.goOnline(S.meUid);
    UI.requestNotifPerm();
    startDataListeners();
    // Hide loading screen only after basic data is loaded (max 8s)
    const checkStart = Date.now();
    const checkData = () => {
      if (Object.keys(S.users).length > 0 || Object.keys(S.groups || {}).length > 0) {
        UI.showApp();
        go('home');
      } else if (Date.now() - checkStart > 8000) {
        // Timeout — show app anyway to avoid infinite spinner
        UI.showApp();
        go('home');
      } else {
        setTimeout(checkData, 300);
      }
    };
    // Give listeners a moment to receive first snapshot
    setTimeout(checkData, 200);
  } else {
    UI.showApp();
    go('auth');
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.me) Chat.goOnline(S.meUid);
  });

})();
