/**
 * js/app.js — Main controller
 * ✅ Fixes applied:
 *   1. Loading screen hidden by app.js after FB.init() (not timeout)
 *   2. Duplicate messages prevented with seenIds Set
 *   3. Progress bars in story viewer work correctly
 *   4. Dark mode applied to loading screen instantly
 *   5. Service worker update detection
 *   6. addMember / removeFriend validation already in modules
 *   7. textarea.focus() after send → keyboard stays open
 */
(async function NabdaApp() {

  /* ══════════════════════════════════════════
     BOOT — init Firebase THEN show app
  ══════════════════════════════════════════ */
  await FB.init();

  // ✅ Fix 1: Hide loading screen HERE (after Firebase ready), not in a timeout
  function showApp() {
    const ls  = document.getElementById('loading-screen');
    const app = document.getElementById('app');
    if (ls)  { ls.classList.add('hide'); setTimeout(() => ls.style.display='none', 300); }
    if (app) app.style.display = '';
  }

  // Register service worker + check for updates
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').then(reg => {
      // Detect new service worker waiting to activate
      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
        newSW.addEventListener('statechange', () => {
          if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
            // New version available — show toast
            setTimeout(() => {
              UI.toast('🔄 تحديث متاح — أعد تحميل الصفحة للتحديث', 'info', 6000);
            }, 2000);
          }
        });
      });
    }).catch(() => {});
  }

  /* ══════════════════════════════════════════
     STATE
  ══════════════════════════════════════════ */
  const S = {
    me:           Auth.getUser(),
    screen:       null,
    activeId:     null,
    tab:          'chats',
    users:        {},
    groups:       {},
    dmChats:      {},
    stories:      {},
    presence:     {},
    friendReqs:   {},
    typingMap:    {},
    msgs:         [],
    panel:        false,
    groupEdit:    false,
    groupNewName: '',
    groupNewPhoto: null,
    storyPreview: null,
    viewImg:      null,
  };

  const _unsubs = [];
  const addU = fn => _unsubs.push(fn);

  let _msgUnsub   = null;
  let _prevLen    = 0;
  let _lastSend   = 0;
  const SPAM      = 1200;

  // ✅ Fix 2: Track rendered message IDs to prevent duplicates
  const _seenMsgIds = new Set();

  const APP = document.getElementById('app');

  /* ══════════════════════════════════════════
     COMPUTED
  ══════════════════════════════════════════ */
  const myFriends   = () => Friends.getFriendList(S.users, S.me);
  const pendingReqs = () => Friends.getPendingRequests(S.friendReqs, S.me);
  const unread      = () => Chat.computeUnread(S.me, S.users, S.dmChats);
  const totalNotifs = () => pendingReqs().length + Object.values(unread()).reduce((a,b)=>a+b,0);
  const myGroups    = () => Groups.myGroups(S.groups, S.me);
  const th          = () => UI.getTheme();
  const chatId      = () => S.screen==='dm' ? Chat.dmKey(S.me, S.activeId) : S.activeId;
  const ag          = () => S.screen==='group' ? S.groups[S.activeId] : null;
  const fws         = () => Stories.friendsWithStories(S.stories, S.me, myFriends());

  /* ══════════════════════════════════════════
     NAVIGATION
  ══════════════════════════════════════════ */
  function go(screen, id=null) {
    if (S.screen==='dm' || S.screen==='group')
      Chat.clearTyping(S.me, S.activeId, S.screen);
    if (_msgUnsub) { _msgUnsub(); _msgUnsub=null; _prevLen=0; }
    _seenMsgIds.clear();   // ✅ clear seen IDs on navigation

    S.screen=screen; S.activeId=id; S.panel=false; S.groupEdit=false; S.msgs=[];
    if (screen==='dm' && id && S.me) Chat.markRead(Chat.dmKey(S.me, id));
    window.history.pushState({}, '', '');
    renderScreen();
    if (screen==='dm'    && id) startMsgListener('dm',    id);
    if (screen==='group' && id) startMsgListener('group', id);
  }

  window.addEventListener('popstate', () => {
    if (S.screen !== 'home' && S.screen !== 'auth') go('home');
  });

  /* ══════════════════════════════════════════
     MESSAGE LISTENER
     ✅ Fix 2: use _seenMsgIds to prevent duplicates
  ══════════════════════════════════════════ */
  function startMsgListener(type, id) {
    if (_msgUnsub) { _msgUnsub(); _msgUnsub=null; }
    _prevLen = 0;
    _seenMsgIds.clear();

    const cb = msgs => {
      if (!msgs.length) { S.msgs=[]; renderMsgs(); return; }

      const isFirstLoad = _prevLen === 0;

      if (isFirstLoad) {
        // Initial load: render all, mark all as seen
        S.msgs = msgs;
        msgs.forEach(m => _seenMsgIds.add(m.id));
        _prevLen = msgs.length;
        renderMsgs();
      } else {
        // ✅ Only process messages NOT already seen (prevents duplicates)
        const newMsgs = msgs.filter(m => !_seenMsgIds.has(m.id));
        newMsgs.forEach(m => {
          _seenMsgIds.add(m.id);
          if (m.sender !== S.me) {
            UI.playSound('recv');
            UI.showNotif(
              type==='dm' ? `رسالة من ${m.sender}` : `رسالة في مجموعة`,
              m.type==='text' ? m.text : '🖼 وسائط',
              () => window.focus()
            );
            appendMsg(m);
          } else {
            // Our own message confirmed by server: update optimistic if needed
            replaceOptimisticMsg(m);
          }
        });
        _prevLen = msgs.length;
        S.msgs = msgs;
      }

      if (type==='dm') Chat.markRead(Chat.dmKey(S.me, id));
    };

    _msgUnsub = type==='dm'
      ? Chat.listenDM(S.me, id, cb)
      : Chat.listenGroup(id, cb);
  }

  /* Replace optimistic (temp) bubble with confirmed server message */
  function replaceOptimisticMsg(serverMsg) {
    const c = document.getElementById('msg-container');
    if (!c) return;
    // Find optimistic bubble by _opt_ prefix
    const optEls = c.querySelectorAll('[data-opt]');
    if (optEls.length) {
      // Replace the oldest optimistic with confirmed
      const first = optEls[0];
      const confirmed = buildBubble(serverMsg);
      c.replaceChild(confirmed, first);
    }
  }

  /* ══════════════════════════════════════════
     GLOBAL DATA LISTENERS
  ══════════════════════════════════════════ */
  function startDataListeners() {
    addU(FB.on('users',          v => { S.users     =v||{}; refreshDyn(); }));
    addU(FB.on('groups',         v => { S.groups    =v||{}; refreshDyn(); }));
    addU(FB.on('dmMsgs',         v => { S.dmChats   =v||{}; refreshDyn(); }));
    addU(FB.on('stories',        v => { S.stories   =v||{}; Stories.cleanExpired(v||{}); refreshDyn(); }));
    addU(FB.on('presence',       v => { S.presence  =v||{}; refreshPresence(); }));
    addU(FB.on('friendRequests', v => { S.friendReqs=v||{}; refreshDyn(); }));
    addU(FB.on('typing',         v => { S.typingMap =v||{}; refreshTyping(); }));
  }

  /* ══════════════════════════════════════════
     PARTIAL REFRESH (no full re-render)
  ══════════════════════════════════════════ */
  function refreshDyn() {
    if (S.screen==='home') {
      refreshChatList(); refreshStoryRow(); refreshBadges();
    } else {
      refreshTopSub();
    }
  }

  function refreshPresence() {
    document.querySelectorAll('[data-ou]').forEach(d => {
      d.style.background = Chat.isOnline(S.presence, d.dataset.ou) ? '#22c55e' : 'transparent';
    });
    if (S.screen==='dm' && S.activeId) refreshTopSub();
  }

  function refreshTyping() {
    const tu  = Chat.getTypingUsers(S.typingMap, S.me, S.activeId, S.screen);
    const box = document.getElementById('typing-row');
    if (!box) return;
    if (tu.length > 0) {
      box.style.display = 'flex'; box.innerHTML = '';
      tu.slice(0,2).forEach(u => box.appendChild(UI.makeAvatar(S.users[u], 22)));
      const bub  = UI.el('div', `background:${th().bubble};border-radius:12px 12px 12px 4px;padding:8px 12px`);
      const dots = UI.el('div', 'display:flex;align-items:center;gap:2px');
      dots.className = 'typing';
      [0,1,2].forEach(() => { const s=document.createElement('span'); s.style.background=th().text2; dots.appendChild(s); });
      bub.appendChild(dots); box.appendChild(bub);
    } else { box.style.display='none'; }
  }

  function refreshTopSub() {
    const sub = document.getElementById('topbar-sub');
    if (!sub || !S.activeId) return;
    const tu = Chat.getTypingUsers(S.typingMap, S.me, S.activeId, S.screen);
    if (S.screen==='dm') {
      sub.textContent = tu.includes(S.activeId) ? '✍️ يكتب...' : Chat.lastSeenText(S.presence, S.activeId);
      sub.style.color = Chat.isOnline(S.presence, S.activeId) ? '#22c55e' : th().text3;
    } else if (S.screen==='group') {
      const g=ag(); if(!g) return;
      sub.textContent = `${Groups.getMembers(g).length} عضو${tu.length>0?' · ✍️ يكتب...':''}`;
    }
  }

  function refreshBadges() {
    const b = document.getElementById('topbar-badge');
    if (b) { const n=totalNotifs(); b.textContent=n; b.style.display=n>0?'flex':'none'; }
    const e = document.getElementById('tab-unread-extra');
    if (e) { const n=Object.values(unread()).reduce((a,b)=>a+b,0); e.textContent=n>0?` (${n})`:''; }
  }

  function refreshChatList() { const c=document.getElementById('home-content'); if(c&&S.screen==='home') renderTabContent(c); }
  function refreshStoryRow() { const r=document.getElementById('story-inner'); if(r) buildStoryInner(r); }

  /* ══════════════════════════════════════════
     RENDER ROUTER
  ══════════════════════════════════════════ */
  function renderScreen() {
    UI.applyTheme();
    let toastHost = document.getElementById('toast-host');
    APP.innerHTML = '';
    if (!toastHost) { toastHost=document.createElement('div'); toastHost.id='toast-host'; }
    APP.appendChild(toastHost);
    APP.style.cssText = `height:100vh;display:flex;flex-direction:column;background:${th().bg};color:${th().text};direction:rtl;overflow:hidden`;
    switch(S.screen) {
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

  /* ══════════════════════════════════════════
     AUTH
  ══════════════════════════════════════════ */
  function renderAuth() {
    APP.style.cssText=`min-height:100vh;display:flex;align-items:center;justify-content:center;background:${UI.isDark()?'linear-gradient(160deg,#0a0a14,#0d0d1a)':'linear-gradient(160deg,#f0f4ff,#e8eeff)'};padding:20px;direction:rtl`;
    const card=UI.el('div',`background:${th().card};border:1px solid ${th().border};border-radius:24px;padding:40px 28px;width:100%;max-width:360px;box-shadow:0 20px 60px rgba(0,0,0,.15)`);
    const logo=UI.el('div','text-align:center;margin-bottom:28px');
    logo.innerHTML=`<div style="width:72px;height:72px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border-radius:20px;margin:0 auto 14px;display:flex;align-items:center;justify-content:center;font-size:36px;box-shadow:0 8px 24px rgba(99,102,241,.4)">💬</div><h1 style="color:${th().text};font-size:26px;font-weight:800;letter-spacing:-1px">نبضة</h1><p style="color:${th().text2};font-size:13px;margin-top:4px">تواصل مع أصدقائك بسهولة</p>`;
    card.appendChild(logo);
    let mode='login';
    const tabRow=UI.el('div',`display:flex;gap:6px;margin-bottom:22px;background:${th().bg};border-radius:14px;padding:4px`);
    const updTabs=()=>tabRow.querySelectorAll('.mt').forEach(b=>{b.style.background=mode===b.dataset.m?'linear-gradient(135deg,#6366f1,#8b5cf6)':'transparent';b.style.color=mode===b.dataset.m?'#fff':th().text2;});
    ['login','register'].forEach(m=>{
      const b=UI.el('button','flex:1;padding:10px;border:none;border-radius:11px;cursor:pointer;font-family:inherit;font-weight:700;font-size:13px;transition:all .2s');
      b.className='mt';b.dataset.m=m;b.textContent=m==='login'?'دخول':'حساب جديد';
      b.addEventListener('click',()=>{mode=m;errBox.style.display='none';updTabs();submitBtn.textContent=mode==='login'?'دخول ←':'إنشاء الحساب ←';});
      tabRow.appendChild(b);
    });
    updTabs();card.appendChild(tabRow);
    const iCss=`width:100%;padding:11px 14px;border-radius:12px;border:1.5px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:14px;font-family:inherit;direction:rtl;box-sizing:border-box;margin-bottom:12px`;
    const uInp=UI.el('input',iCss);uInp.placeholder='اسم المستخدم';uInp.autocomplete='username';
    const pInp=UI.el('input',iCss);pInp.placeholder='كلمة المرور';pInp.type='password';pInp.autocomplete='current-password';
    card.appendChild(uInp);card.appendChild(pInp);
    const errBox=UI.el('div','padding:9px 14px;background:#fee2e2;border-radius:10px;color:#ef4444;font-size:13px;text-align:center;font-weight:600;margin-bottom:12px;display:none');
    card.appendChild(errBox);
    let loading=false;
    const submitBtn=UI.el('button','width:100%;padding:13px;border:none;border-radius:14px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-size:15px;font-weight:700;font-family:inherit;box-shadow:0 4px 14px rgba(99,102,241,.4);cursor:pointer');
    submitBtn.textContent='دخول ←';
    async function doSubmit(){
      if(loading)return;
      const u=uInp.value,p=pInp.value;
      loading=true;submitBtn.innerHTML='';submitBtn.appendChild(UI.spinner(18));
      const res=mode==='login'?await Auth.login(u,p):await Auth.register(u,p);
      loading=false;submitBtn.textContent=mode==='login'?'دخول ←':'إنشاء الحساب ←';
      if(res.error){errBox.textContent=res.error;errBox.style.display='block';return;}
      errBox.style.display='none';
      Auth.saveUser(u.trim());S.me=u.trim();
      Chat.goOnline(S.me);UI.requestNotifPerm();startDataListeners();go('home');
    }
    submitBtn.addEventListener('click',doSubmit);
    [uInp,pInp].forEach(i=>i.addEventListener('keydown',e=>{if(e.key==='Enter')doSubmit();}));
    card.appendChild(submitBtn);APP.appendChild(card);
  }

  /* ══════════════════════════════════════════
     HOME
  ══════════════════════════════════════════ */
  function renderHome(){
    APP.appendChild(buildHomeTopbar());
    const stWrap=UI.el('div',`padding:10px 14px 8px;border-bottom:1px solid ${th().border};flex-shrink:0;background:${th().topbar}`);
    const stInner=UI.el('div','display:flex;gap:12px;overflow-x:auto;padding-bottom:2px;scrollbar-width:none');
    stInner.id='story-inner';buildStoryInner(stInner);stWrap.appendChild(stInner);APP.appendChild(stWrap);
    APP.appendChild(buildHomeTabs());
    const content=UI.el('div','flex:1;overflow-y:auto;padding:12px;-webkit-overflow-scrolling:touch');
    content.id='home-content';APP.appendChild(content);renderTabContent(content);
  }

  function buildHomeTopbar(){
    const bar=UI.el('div',`display:flex;align-items:center;gap:10px;padding:10px 14px;background:${th().topbar};border-bottom:1px solid ${th().border};flex-shrink:0;box-shadow:0 1px 6px rgba(0,0,0,.06)`);
    const avWrap=UI.el('div','position:relative;cursor:pointer');
    avWrap.appendChild(UI.makeAvatar(S.users[S.me],36,{online:true}));
    const badge=UI.el('div','position:absolute;top:-4px;left:-4px;background:#ef4444;color:#fff;font-size:9px;font-weight:700;border-radius:50%;min-width:16px;height:16px;display:none;align-items:center;justify-content:center;padding:0 2px');
    badge.id='topbar-badge';const n=totalNotifs();badge.textContent=n;badge.style.display=n>0?'flex':'none';
    avWrap.appendChild(badge);avWrap.addEventListener('click',()=>go('profile'));bar.appendChild(avWrap);
    const title=UI.el('div','flex:1;min-width:0');
    title.innerHTML=`<span style="font-weight:800;font-size:17px;color:${UI.isDark()?'#a5b4fc':'#6366f1'};letter-spacing:-0.5px">نبضة</span><span style="font-size:11px;color:${th().text3};margin-right:6px">● ${S.me}</span>`;
    bar.appendChild(title);
    const fBtn=UI.el('button','background:none;border:none;cursor:pointer;font-size:20px;padding:4px;position:relative');fBtn.textContent='👥';
    const pr=pendingReqs();if(pr.length){const d=UI.el('div','position:absolute;top:0;right:0;background:#ef4444;color:#fff;font-size:8px;font-weight:700;border-radius:50%;width:14px;height:14px;display:flex;align-items:center;justify-content:center');d.textContent=pr.length;fBtn.appendChild(d);}
    fBtn.addEventListener('click',()=>go('friends'));bar.appendChild(fBtn);
    const dBtn=UI.el('button','background:none;border:none;cursor:pointer;font-size:20px;padding:4px');
    dBtn.textContent=UI.isDark()?'☀️':'🌙';dBtn.addEventListener('click',()=>{UI.toggleDark();S.dark=UI.isDark();renderScreen();});bar.appendChild(dBtn);
    return bar;
  }

  function buildStoryInner(container){
    container.innerHTML='';
    const addW=UI.el('div','display:flex;flex-direction:column;align-items:center;gap:3px;flex-shrink:0;cursor:pointer');
    const addC=UI.el('div',`width:52px;height:52px;border-radius:50%;background:${th().card2};border:2px dashed #6366f1;display:flex;align-items:center;justify-content:center;font-size:22px`);addC.textContent='+';
    const stIn=document.createElement('input');stIn.type='file';stIn.accept='image/*';stIn.style.display='none';
    stIn.addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;if(f.size>5*1024*1024)return UI.toast('الحجم الأقصى 5 ميغابايت','error');S.storyPreview=await UI.fileToBase64(f);e.target.value='';showStoryPreview();});
    const addL=UI.el('span',`font-size:10px;color:${th().text3}`);addL.textContent='قصتي';
    addW.appendChild(addC);addW.appendChild(addL);addW.appendChild(stIn);addW.addEventListener('click',()=>stIn.click());container.appendChild(addW);
    const myS=Stories.getUserStories(S.me,S.stories);
    if(myS.length){const w=UI.el('div','display:flex;flex-direction:column;align-items:center;gap:3px;flex-shrink:0');const ring=UI.el('div','padding:2px;border-radius:50%;border:2.5px solid #22c55e;display:inline-flex;cursor:pointer');ring.appendChild(UI.makeAvatar(S.users[S.me],46));ring.addEventListener('click',()=>openStoryViewer(S.me));const lbl=UI.el('span','font-size:10px;color:#22c55e');lbl.textContent='قصتي';w.appendChild(ring);w.appendChild(lbl);container.appendChild(w);}
    fws().forEach(u=>{
      const seen=Stories.isSeen(u,S.stories);
      const w=UI.el('div','display:flex;flex-direction:column;align-items:center;gap:3px;flex-shrink:0');
      const ring=UI.el('div',`padding:2px;border-radius:50%;border:2.5px solid ${seen?'#aaa':'#6366f1'};display:inline-flex;cursor:pointer`);
      ring.appendChild(UI.makeAvatar(S.users[u],46,{online:Chat.isOnline(S.presence,u)}));
      ring.addEventListener('click',()=>{Stories.markSeen(u);openStoryViewer(u);});
      const lbl=UI.el('span',`font-size:10px;color:${seen?th().text3:'#6366f1'};max-width:52px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`);lbl.textContent=u;
      w.appendChild(ring);w.appendChild(lbl);container.appendChild(w);
    });
  }

  function buildHomeTabs(){
    const tabs=UI.el('div',`display:flex;background:${th().tabs};border-bottom:1px solid ${th().border};flex-shrink:0`);
    [['chats','💬 الخاصة'],['groups','👥 مجموعات'],['unread','🔔']].forEach(([k,l])=>{
      const b=UI.el('button');b.className='tab';b.style.color=S.tab===k?(UI.isDark()?'#a5b4fc':'#6366f1'):th().text3;b.style.borderBottomColor=S.tab===k?'#6366f1':'transparent';
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
      const lbl=UI.el('span',`font-size:11px;font-weight:700;color:${th().text3};letter-spacing:1px`);lbl.textContent='المحادثات الخاصة';
      const plusBtn=UI.el('button','background:none;border:none;cursor:pointer;color:#6366f1;font-size:22px;line-height:1;padding:0');plusBtn.textContent='+';
      hdr.appendChild(lbl);hdr.appendChild(plusBtn);container.appendChild(hdr);
      let showNdm=false;
      const ndmRow=UI.el('div','display:flex;gap:6px;margin-bottom:10px');ndmRow.style.display='none';
      const ndmInp=UI.el('input',`flex:1;padding:9px 12px;border-radius:12px;border:1.5px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:13px;direction:rtl`);ndmInp.placeholder='اسم المستخدم...';
      const ndmBtn=UI.el('button','padding:9px 14px;border:none;border-radius:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-weight:700;font-family:inherit;cursor:pointer');ndmBtn.textContent='→';
      const doNdm=()=>{const u=ndmInp.value.trim();if(u&&S.users[u]&&u!==S.me)go('dm',u);};
      ndmBtn.addEventListener('click',doNdm);ndmInp.addEventListener('keydown',e=>{if(e.key==='Enter')doNdm();});
      ndmRow.appendChild(ndmInp);ndmRow.appendChild(ndmBtn);container.appendChild(ndmRow);
      plusBtn.addEventListener('click',()=>{showNdm=!showNdm;ndmRow.style.display=showNdm?'flex':'none';if(showNdm)ndmInp.focus();});
      const others=Object.keys(S.users).filter(u=>u!==S.me&&Chat.getDMMessages(S.me,u,S.dmChats).length>0);
      if(!others.length){const emp=UI.el('div',`color:${th().text3};font-size:13px;padding:16px 0;text-align:center`);emp.textContent='اضغط + لبدء محادثة جديدة';container.appendChild(emp);}
      others.forEach(u=>container.appendChild(buildChatItem(u)));
    } else if(S.tab==='groups'){
      const btnRow=UI.el('div','display:flex;gap:8px;margin-bottom:14px');
      const ngBtn=UI.el('button','flex:1;padding:10px 16px;border:none;border-radius:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-weight:700;font-size:13px;font-family:inherit;cursor:pointer');ngBtn.textContent='+ مجموعة جديدة';ngBtn.addEventListener('click',()=>go('newGroup'));btnRow.appendChild(ngBtn);
      const jnBtn=UI.el('button',`flex:1;padding:10px 16px;border:1px solid ${th().border};border-radius:12px;background:${th().card2};color:${UI.isDark()?'#a5b4fc':'#6366f1'};font-weight:700;font-size:13px;font-family:inherit;cursor:pointer`);jnBtn.textContent='🔗 انضمام';jnBtn.addEventListener('click',()=>go('join'));btnRow.appendChild(jnBtn);container.appendChild(btnRow);
      const grps=myGroups();
      if(!grps.length){const emp=UI.el('div',`color:${th().text3};font-size:13px;text-align:center;padding:16px 0`);emp.textContent='لا توجد مجموعات بعد';container.appendChild(emp);}
      grps.forEach(g=>container.appendChild(buildGroupItem(g)));
    } else if(S.tab==='unread'){
      const hdr=UI.el('div',`font-size:11px;font-weight:700;color:${th().text3};letter-spacing:1px;margin-bottom:12px`);hdr.textContent='غير المقروء';container.appendChild(hdr);
      const ur=unread();
      if(!Object.keys(ur).length){const emp=UI.el('div',`color:${th().text3};font-size:13px;text-align:center;margin-top:20px`);emp.textContent='✅ لا توجد رسائل غير مقروءة';container.appendChild(emp);return;}
      Object.entries(ur).forEach(([u,cnt])=>container.appendChild(buildChatItem(u,cnt)));
    }
  }

  function buildChatItem(u,forcedUnread=0){
    const ur=forcedUnread||unread()[u]||0;const last=Chat.getLastDMMsg(S.me,u,S.dmChats);
    const hasSt=fws().includes(u);const seenSt=Stories.isSeen(u,S.stories);
    const item=UI.el('div',`display:flex;align-items:center;gap:10px;padding:11px 12px;border-radius:14px;cursor:pointer;background:${ur?'#6366f111':th().card};border:1px solid ${ur?'#6366f133':th().border};margin-bottom:6px;transition:opacity .12s`);
    item.addEventListener('click',()=>go('dm',u));
    item.appendChild(UI.makeAvatar(S.users[u],44,{online:Chat.isOnline(S.presence,u),ring:hasSt,seen:seenSt,onClick:hasSt?e=>{e.stopPropagation();Stories.markSeen(u);openStoryViewer(u);}:null}));
    const info=UI.el('div','flex:1;min-width:0');
    const nm=UI.el('div',`font-weight:${ur?700:600};font-size:14px;color:${th().text}`);nm.textContent=u;info.appendChild(nm);
    if(last){const prev=UI.el('div',`font-size:12px;color:${ur?'#6366f1':th().text3};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:${ur?600:400}`);prev.textContent=(last.sender===S.me?'أنت: ':'')+UI.preview(last);info.appendChild(prev);}
    item.appendChild(info);
    const meta=UI.el('div','display:flex;flex-direction:column;align-items:flex-end;gap:3px');
    if(last){const ts=UI.el('span',`font-size:10px;color:${th().text3}`);ts.textContent=UI.fmtFull(last.ts);meta.appendChild(ts);}
    if(ur>0){const b=UI.el('div','background:#6366f1;color:#fff;font-size:10px;font-weight:700;border-radius:10px;min-width:18px;height:18px;display:flex;align-items:center;justify-content:center;padding:0 5px');b.textContent=ur;meta.appendChild(b);}
    item.appendChild(meta);return item;
  }

  function buildGroupItem(g){
    const pc=Groups.canManage(g,S.me)&&g.pending?Object.keys(g.pending).length:0;
    const item=UI.el('div',`display:flex;align-items:center;gap:10px;padding:11px 12px;border-radius:14px;cursor:pointer;background:${th().card};border:1px solid ${th().border};margin-bottom:6px`);
    item.addEventListener('click',()=>go('group',g.id));
    if(g.photo){const img=document.createElement('img');img.src=g.photo;img.loading='lazy';img.style.cssText='width:44px;height:44px;border-radius:12px;object-fit:cover;flex-shrink:0';item.appendChild(img);}
    else{const c=UI.userColor(g.name);const ic=UI.el('div',`width:44px;height:44px;border-radius:12px;flex-shrink:0;background:linear-gradient(135deg,${c},${UI.userColor(g.name+'1')});display:flex;align-items:center;justify-content:center;font-weight:800;font-size:19px;color:#fff`);ic.textContent=g.name[0];item.appendChild(ic);}
    const info=UI.el('div','flex:1;min-width:0');const nr=UI.el('div','display:flex;align-items:center;gap:6px');const nm=UI.el('span',`font-weight:700;font-size:14px;color:${th().text}`);nm.textContent=g.name;nr.appendChild(nm);
    if(pc>0){const b=UI.el('span','background:#fee2e2;color:#ef4444;font-size:10px;font-weight:700;padding:1px 6px;border-radius:6px');b.textContent=`${pc} طلب`;nr.appendChild(b);}
    info.appendChild(nr);const sub=UI.el('div',`font-size:11px;color:${th().text3}`);sub.textContent=`${Groups.getMembers(g).length} عضو`;info.appendChild(sub);item.appendChild(info);return item;
  }

  /* ══════════════════════════════════════════
     SHARED TOPBARS
  ══════════════════════════════════════════ */
  function buildChatTopbar(type){
    const g=ag();
    const bar=UI.el('div',`display:flex;align-items:center;gap:10px;padding:10px 14px;background:${th().topbar};border-bottom:1px solid ${th().border};flex-shrink:0;box-shadow:0 1px 6px rgba(0,0,0,.06)`);
    const back=UI.el('button','background:none;border:none;cursor:pointer;font-size:22px;padding:2px;line-height:1');back.textContent='←';back.style.color=th().text2;back.addEventListener('click',()=>go('home'));bar.appendChild(back);
    if(type==='dm'){const avBtn=UI.el('button','background:none;border:none;cursor:pointer;padding:0');avBtn.appendChild(UI.makeAvatar(S.users[S.activeId],34,{online:Chat.isOnline(S.presence,S.activeId)}));avBtn.addEventListener('click',()=>go('userProfile',S.activeId));bar.appendChild(avBtn);}
    else if(g){if(g.photo){const img=document.createElement('img');img.src=g.photo;img.loading='lazy';img.style.cssText='width:34px;height:34px;border-radius:10px;object-fit:cover;flex-shrink:0';bar.appendChild(img);}else{const c=UI.userColor(g.name);const ic=UI.el('div',`width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,${c},${UI.userColor(g.name+'1')});display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;color:#fff;flex-shrink:0`);ic.textContent=g.name[0];bar.appendChild(ic);}}
    const info=UI.el('div','flex:1;min-width:0;cursor:pointer');const titleEl=UI.el('div',`font-weight:700;font-size:15px;color:${th().text}`);const subEl=UI.el('div','font-size:11px');subEl.id='topbar-sub';
    if(type==='dm'){titleEl.textContent=S.activeId;subEl.textContent=Chat.lastSeenText(S.presence,S.activeId);subEl.style.color=Chat.isOnline(S.presence,S.activeId)?'#22c55e':th().text3;info.addEventListener('click',()=>go('userProfile',S.activeId));}
    else if(g){titleEl.textContent=g.name;subEl.textContent=`${Groups.getMembers(g).length} عضو`;subEl.style.color=th().text3;}
    info.appendChild(titleEl);info.appendChild(subEl);bar.appendChild(info);
    const custBtn=UI.el('button','background:none;border:none;cursor:pointer;font-size:18px;padding:4px');custBtn.textContent='🎨';custBtn.style.color=th().text2;custBtn.addEventListener('click',showCustomizeSheet);bar.appendChild(custBtn);
    if(type==='group'&&g){
      const pBtn=UI.el('button',`padding:7px 11px;border:1px solid ${th().border};border-radius:12px;background:${S.panel?'#6366f122':th().card2};color:${UI.isDark()?'#a5b4fc':'#6366f1'};font-family:inherit;font-size:12px;font-weight:700;cursor:pointer`);pBtn.textContent=Groups.canManage(g,S.me)?'👑':'👥';
      pBtn.addEventListener('click',()=>{S.panel=!S.panel;pBtn.style.background=S.panel?'#6366f122':th().card2;const body=document.getElementById('group-body');const ex=document.getElementById('group-panel');if(S.panel&&body)buildGroupPanel(body);else if(ex)ex.remove();});bar.appendChild(pBtn);
    }
    return bar;
  }

  function buildSimpleTopbar(title){
    const bar=UI.el('div',`display:flex;align-items:center;gap:10px;padding:10px 14px;background:${th().topbar};border-bottom:1px solid ${th().border};flex-shrink:0;box-shadow:0 1px 6px rgba(0,0,0,.06)`);
    const back=UI.el('button','background:none;border:none;cursor:pointer;font-size:22px;padding:2px;line-height:1');back.textContent='←';back.style.color=th().text2;back.addEventListener('click',()=>go('home'));bar.appendChild(back);
    const t2=UI.el('span',`font-weight:700;font-size:16px;color:${th().text}`);t2.textContent=title;bar.appendChild(t2);return bar;
  }

  /* ══════════════════════════════════════════
     DM / GROUP SCREENS
  ══════════════════════════════════════════ */
  function renderDM(){APP.appendChild(buildChatTopbar('dm'));APP.appendChild(buildMsgsArea());APP.appendChild(buildChatInput('dm'));}

  function renderGroup(){
    APP.appendChild(buildChatTopbar('group'));
    const body=UI.el('div','flex:1;display:flex;overflow:hidden');body.id='group-body';
    const main=UI.el('div','flex:1;display:flex;flex-direction:column;overflow:hidden');
    main.appendChild(buildMsgsArea());main.appendChild(buildChatInput('group'));
    body.appendChild(main);APP.appendChild(body);if(S.panel)buildGroupPanel(body);
  }

  /* ══════════════════════════════════════════
     MESSAGES AREA
  ══════════════════════════════════════════ */
  function buildMsgsArea(){
    const bg=UI.getChatBgs()[chatId()]||th().bg;
    const scroll=UI.el('div',`flex:1;overflow-y:auto;padding:10px 10px 4px;background:${bg};background-size:cover;background-position:center;-webkit-overflow-scrolling:touch`);scroll.id='msg-scroll';
    let tsy=0;scroll.addEventListener('touchstart',e=>{if(scroll.scrollTop===0)tsy=e.touches[0].clientY;});
    scroll.addEventListener('touchend',e=>{if(e.changedTouches[0].clientY-tsy>60&&scroll.scrollTop===0)UI.toast('تم التحديث ✓','success');});
    const msgC=UI.el('div','');msgC.id='msg-container';scroll.appendChild(msgC);
    const typRow=UI.el('div','display:none;align-items:center;gap:8px;padding:4px 0');typRow.id='typing-row';scroll.appendChild(typRow);
    const anchor=document.createElement('div');anchor.id='msg-anchor';scroll.appendChild(anchor);
    renderMsgs();return scroll;
  }

  function renderMsgs(){
    const c=document.getElementById('msg-container');if(!c)return;c.innerHTML='';
    if(!S.msgs.length)c.appendChild(buildEmptyChat());
    else S.msgs.forEach(m=>c.appendChild(buildBubble(m)));
    scrollBot();
  }

  /* ✅ Append only — keyboard stays open */
  function appendMsg(m){
    const c=document.getElementById('msg-container');if(!c)return;
    const emp=c.querySelector('.empty-chat');if(emp)emp.remove();
    c.appendChild(buildBubble(m));scrollBot();
  }

  function scrollBot(smooth=true){const a=document.getElementById('msg-anchor');if(a)a.scrollIntoView({behavior:smooth?'smooth':'auto'});}

  function buildEmptyChat(){
    const g=ag();const d=UI.el('div','text-align:center;margin-top:50px');d.className='empty-chat';d.style.color=th().text3;
    if(S.screen==='dm')d.innerHTML=`<div style="font-size:44px">👋</div><div style="font-size:14px;margin-top:8px">ابدأ المحادثة مع <b>${S.activeId}</b></div>`;
    else if(g){d.innerHTML=`<div style="font-size:44px">💬</div><div style="font-size:14px;margin-top:8px">لا توجد رسائل بعد</div>`;
      if(Groups.canManage(g,S.me)){const inv=UI.el('div',`margin-top:14px;padding:14px;background:${th().card};border-radius:14px;border:1px solid ${th().border};display:inline-block`);inv.innerHTML=`<div style="color:#6366f1;font-size:12px;font-weight:700;margin-bottom:4px">🔗 رمز الدعوة</div><div style="font-family:monospace;color:#22c55e;font-size:15px;letter-spacing:2px;font-weight:700">${g.inviteCode}</div>`;d.appendChild(inv);}}
    return d;
  }

  function buildBubble(m, isOptimistic=false){
    const mine=m.sender===S.me;const bc=UI.getBubbleColors()[chatId()]||'linear-gradient(135deg,#6366f1,#8b5cf6)';const isM=['image','video','voice'].includes(m.type);
    const row=UI.el('div','display:flex;align-items:flex-end;gap:6px;margin-bottom:3px;padding:0 2px;animation:fadeUp .2s ease');
    row.style.flexDirection=mine?'row-reverse':'row';
    if(isOptimistic) row.setAttribute('data-opt','1');   // ✅ mark optimistic
    if(!mine){const sender=S.users[m.sender]||{username:m.sender};row.appendChild(UI.makeAvatar(sender,28,{onClick:()=>go('userProfile',m.sender)}));}
    const col=UI.el('div','max-width:78%');
    if(!mine&&S.screen==='group'){const sn=UI.el('div',`font-size:10px;color:${UI.userColor(m.sender)};font-weight:700;margin-bottom:2px;padding-right:4px`);sn.textContent=m.sender;col.appendChild(sn);}
    const bub=UI.el('div','');bub.style.cssText=`padding:${isM?'5px':'9px 13px'};border-radius:${mine?'18px 18px 4px 18px':'18px 18px 18px 4px'};background:${mine?bc:th().bubble};color:${mine?'#fff':th().text};font-size:14px;line-height:1.5;box-shadow:${mine?'0 2px 8px rgba(99,102,241,.25)':'0 1px 4px rgba(0,0,0,.08)'}`;
    if(m.type==='text'){const span=document.createElement('span');span.style.cssText='word-break:break-word;white-space:pre-wrap;line-height:1.55';span.textContent=m.text;bub.appendChild(span);}
    else if(m.type==='image'){const img=document.createElement('img');img.src=m.data;img.loading='lazy';img.style.cssText='max-width:100%;max-height:220px;border-radius:10px;display:block;cursor:pointer';img.addEventListener('click',()=>{S.viewImg=m.data;showImgViewer();});bub.appendChild(img);}
    else if(m.type==='video'){const v=document.createElement('video');v.src=m.data;v.controls=true;v.playsInline=true;v.style.cssText='max-width:100%;max-height:220px;border-radius:10px;display:block';bub.appendChild(v);}
    else if(m.type==='voice')bub.appendChild(buildVoicePlayer(m));
    const meta=UI.el('div',`font-size:10px;color:${th().text3};margin-top:2px;text-align:${mine?'left':'right'};padding-right:2px`);
    meta.textContent=UI.fmt(m.ts)+(mine?' ✓✓':'');col.appendChild(bub);col.appendChild(meta);row.appendChild(col);return row;
  }

  function buildVoicePlayer(m){
    const wrap=UI.el('div','display:flex;align-items:center;gap:10px;min-width:160px');const audio=document.createElement('audio');audio.src=m.data;let playing=false;
    const playBtn=UI.el('button','width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;background:rgba(255,255,255,.2);color:#fff;font-size:18px;display:flex;align-items:center;justify-content:center;flex-shrink:0');playBtn.textContent='▶';
    playBtn.addEventListener('click',()=>{if(playing){audio.pause();playBtn.textContent='▶';playing=false;}else{audio.play().catch(()=>{});playBtn.textContent='⏸';playing=true;}});
    audio.addEventListener('ended',()=>{playBtn.textContent='▶';playing=false;});
    const info=UI.el('div','flex:1');const lbl=UI.el('div','font-size:12px;opacity:.8');lbl.textContent='رسالة صوتية';const dur=UI.el('div','font-size:10px;opacity:.5');if(m.duration>0)dur.textContent=`${m.duration}ث`;
    info.appendChild(lbl);info.appendChild(dur);wrap.appendChild(audio);wrap.appendChild(playBtn);wrap.appendChild(info);
    const ico=document.createElement('span');ico.textContent='🎙';ico.style.fontSize='20px';wrap.appendChild(ico);return wrap;
  }

  /* ══════════════════════════════════════════
     CHAT INPUT — ✅ keyboard stays open
  ══════════════════════════════════════════ */
  function buildChatInput(type){
    const wrap=UI.el('div',`background:${th().topbar};border-top:1px solid ${th().border};flex-shrink:0`);wrap.id='chat-input-wrap';
    const cdBar=UI.el('div',`height:2px;background:${th().border};overflow:hidden;display:none`);cdBar.id='cd-bar';
    const cdFill=UI.el('div','height:100%;background:#6366f1');cdFill.id='cd-fill';cdBar.appendChild(cdFill);wrap.appendChild(cdBar);
    const mediaTray=UI.el('div','display:none;padding:10px 12px 0;gap:8px');mediaTray.id='media-tray';
    const voiceTray=UI.el('div','display:none;padding:14px');voiceTray.id='voice-tray';
    wrap.appendChild(mediaTray);wrap.appendChild(voiceTray);
    const bar=UI.el('div','display:flex;gap:7px;align-items:center;padding:8px 10px');
    const plusBtn=UI.el('button',`width:40px;height:40px;border:1px solid ${th().inpBorder};border-radius:12px;font-size:20px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;background:${th().card2};color:${th().text3}`);plusBtn.textContent='+';
    const inputEl=document.createElement('textarea');
    inputEl.style.cssText=`flex:1;padding:10px 14px;border-radius:22px;border:1.5px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:14px;direction:rtl;resize:none;overflow:hidden;min-height:40px;max-height:120px;line-height:1.4;font-family:inherit;box-sizing:border-box`;
    inputEl.placeholder=type==='dm'?`رسالة إلى ${S.activeId}...`:`رسالة في ${ag()?.name||''}...`;inputEl.rows=1;
    inputEl.addEventListener('input',()=>{inputEl.style.height='auto';inputEl.style.height=Math.min(inputEl.scrollHeight,120)+'px';});
    const sendBtn=UI.el('button','width:40px;height:40px;border:none;border-radius:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-size:18px;display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 2px 8px rgba(99,102,241,.4);cursor:pointer');sendBtn.textContent='←';
    let typTimer=null;
    inputEl.addEventListener('input',()=>{Chat.setTyping(S.me,S.activeId,S.screen,true);clearTimeout(typTimer);typTimer=setTimeout(()=>Chat.setTyping(S.me,S.activeId,S.screen,false),2500);});

    /* ✅ SEND: clear + focus = keyboard stays open + no duplicates */
    const doSend=()=>{
      const text=inputEl.value.trim();if(!text)return;
      const now=Date.now();if(now-_lastSend<SPAM){UI.toast('لا تُرسل بسرعة كبيرة ⏳','warn');return;}_lastSend=now;
      cdBar.style.display='block';cdFill.style.animation='none';cdFill.offsetHeight;
      cdFill.style.animation=`cooldown ${SPAM}ms linear forwards`;
      setTimeout(()=>cdBar.style.display='none',SPAM);

      // ✅ Clear + restore focus immediately (keyboard stays open)
      inputEl.value='';inputEl.style.height='40px';inputEl.focus();
      Chat.setTyping(S.me,S.activeId,S.screen,false);clearTimeout(typTimer);

      const payload={type:'text',text};
      const tempId='_opt_'+Date.now()+'_'+Math.random().toString(36).slice(2);
      const tempMsg={sender:S.me,ts:Date.now(),id:tempId,...payload};

      // ✅ Add optimistic bubble (marked with data-opt) — will be replaced by server confirmation
      _seenMsgIds.add(tempId);   // prevent listener from re-adding
      appendMsg(tempMsg);        // shows immediately

      if(type==='dm') Chat.sendDM(S.me,S.activeId,payload);
      else            Chat.sendGroup(S.activeId,S.me,payload);
      UI.playSound('send');
    };
    sendBtn.addEventListener('click',()=>{doSend();inputEl.focus();});
    inputEl.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();doSend();}});

    let trayMode='text';
    plusBtn.addEventListener('click',()=>{
      if(trayMode==='text'){trayMode='media';plusBtn.textContent='✕';plusBtn.style.background='#6366f122';plusBtn.style.color='#6366f1';plusBtn.style.border='1px solid #6366f1';buildMediaTray(mediaTray,type);mediaTray.style.display='flex';voiceTray.style.display='none';}
      else{trayMode='text';plusBtn.textContent='+';plusBtn.style.background=th().card2;plusBtn.style.color=th().text3;plusBtn.style.border=`1px solid ${th().inpBorder}`;mediaTray.style.display='none';voiceTray.style.display='none';}
    });
    bar.appendChild(plusBtn);bar.appendChild(inputEl);bar.appendChild(sendBtn);wrap.appendChild(bar);return wrap;
  }

  function buildMediaTray(tray,type){
    tray.innerHTML='';
    const mkBtn=(ico,lbl,cb)=>{const b=UI.el('button',`flex:1;padding:12px 8px;border:1px solid ${th().border};border-radius:14px;background:${th().card2};color:${th().text};cursor:pointer;font-family:inherit;display:flex;flex-direction:column;align-items:center;gap:3px;font-size:12px`);const ic=document.createElement('span');ic.style.fontSize='26px';ic.textContent=ico;b.appendChild(ic);b.appendChild(document.createTextNode(lbl));b.addEventListener('click',cb);return b;};
    const imgIn=document.createElement('input');imgIn.type='file';imgIn.accept='image/*';imgIn.style.display='none';
    imgIn.addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;if(f.size>5*1024*1024)return UI.toast('الحجم الأقصى 5 ميغابايت','error');const d=await UI.fileToBase64(f);e.target.value='';sendMedia({type:'image',data:d},type);closeTray();});
    tray.appendChild(mkBtn('🖼','صورة',()=>imgIn.click()));tray.appendChild(imgIn);
    const vidIn=document.createElement('input');vidIn.type='file';vidIn.accept='video/*';vidIn.style.display='none';
    vidIn.addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;if(f.size>20*1024*1024)return UI.toast('الحجم الأقصى 20 ميغابايت','error');const d=await UI.fileToBase64(f);e.target.value='';sendMedia({type:'video',data:d},type);closeTray();});
    tray.appendChild(mkBtn('🎥','فيديو',()=>vidIn.click()));tray.appendChild(vidIn);
    const vt=document.getElementById('voice-tray');
    tray.appendChild(mkBtn('🎙','صوتية',()=>{buildVoiceTray(vt,type);vt.style.display='block';tray.style.display='none';}));
  }

  function closeTray(){
    const mt=document.getElementById('media-tray');const vt=document.getElementById('voice-tray');if(mt)mt.style.display='none';if(vt)vt.style.display='none';
    const w=document.getElementById('chat-input-wrap');if(!w)return;const p=w.querySelector('button');if(p){p.textContent='+';p.style.background=th().card2;p.style.color=th().text3;p.style.border=`1px solid ${th().inpBorder}`;}
  }

  function buildVoiceTray(tray,type){
    tray.innerHTML='';let recording=false,rec=null,secs=0,rd=null,timer=null;
    const hint=UI.el('p',`color:${th().text2};font-size:13px;margin-bottom:10px;text-align:center`);hint.textContent='اضغط للتسجيل';tray.appendChild(hint);
    const secLbl=UI.el('div','color:#ef4444;font-size:14px;font-weight:600;margin-bottom:10px;text-align:center;display:none');tray.appendChild(secLbl);
    const startBtn=UI.el('button','width:68px;height:68px;border-radius:50%;border:none;cursor:pointer;font-size:28px;color:#fff;display:block;margin:0 auto 10px;box-shadow:0 4px 20px rgba(239,68,68,.4);background:linear-gradient(135deg,#ef4444,#dc2626)');startBtn.textContent='🎙';tray.appendChild(startBtn);
    const btnRow=UI.el('div','display:none;justify-content:center;gap:12px');
    const stopBtn=UI.el('button','padding:10px 22px;border:none;border-radius:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-weight:700;font-family:inherit;cursor:pointer');stopBtn.textContent='⏹ إيقاف';
    const cancelBtn=UI.el('button',`padding:10px 18px;border:1px solid ${th().border};border-radius:12px;background:${th().card2};color:#ef4444;font-weight:700;font-family:inherit;cursor:pointer`);cancelBtn.textContent='✕';
    btnRow.appendChild(stopBtn);btnRow.appendChild(cancelBtn);tray.appendChild(btnRow);
    const doneRow=UI.el('div','text-align:center;display:none');const doneLbl=UI.el('div','color:#22c55e;font-size:13px;margin-bottom:10px');doneRow.appendChild(doneLbl);
    const sendVBtn=UI.el('button','padding:10px 24px;border:none;border-radius:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-weight:700;font-family:inherit;cursor:pointer;margin-left:8px');sendVBtn.textContent='إرسال ←';
    const cancelVBtn=UI.el('button',`padding:10px 18px;border:1px solid ${th().border};border-radius:12px;background:${th().card2};color:#ef4444;font-weight:700;font-family:inherit;cursor:pointer`);cancelVBtn.textContent='إلغاء';
    doneRow.appendChild(sendVBtn);doneRow.appendChild(cancelVBtn);tray.appendChild(doneRow);
    startBtn.addEventListener('click',async()=>{try{const stream=await navigator.mediaDevices.getUserMedia({audio:true});rec=new MediaRecorder(stream);const chunks=[];rec.ondataavailable=e=>chunks.push(e.data);rec.onstop=()=>{stream.getTracks().forEach(x=>x.stop());const b=new Blob(chunks,{type:'audio/webm'});const r=new FileReader();r.onload=()=>{rd={data:r.result,duration:secs};doneLbl.textContent=`✅ ${secs}ث — هل تريد إرسالها؟`;doneRow.style.display='block';};r.readAsDataURL(b);};rec.start();recording=true;secs=0;secLbl.style.display='block';secLbl.textContent='🔴 0ث';startBtn.style.display='none';btnRow.style.display='flex';hint.style.display='none';timer=setInterval(()=>{secs++;secLbl.textContent=`🔴 ${secs}ث`;},1000);}catch{UI.toast('تعذّر الوصول للميكروفون','error');}});
    stopBtn.addEventListener('click',()=>{if(!rec||rec.state==='inactive')return;rec.stop();clearInterval(timer);recording=false;secLbl.style.display='none';btnRow.style.display='none';});
    cancelBtn.addEventListener('click',()=>{if(rec&&rec.state!=='inactive')rec.stop();clearInterval(timer);closeTray();});
    sendVBtn.addEventListener('click',()=>{if(!rd)return;sendMedia({type:'voice',data:rd.data,duration:rd.duration},type);closeTray();});
    cancelVBtn.addEventListener('click',()=>closeTray());
  }

  function sendMedia(payload,type){if(type==='dm')Chat.sendDM(S.me,S.activeId,payload);else Chat.sendGroup(S.activeId,S.me,payload);UI.playSound('send');}

  /* ══════════════════════════════════════════
     GROUP PANEL
  ══════════════════════════════════════════ */
  function buildGroupPanel(parentEl){
    const ex=document.getElementById('group-panel');if(ex)ex.remove();
    const g=ag();if(!g)return;
    const panel=UI.el('div',`width:230px;flex-shrink:0;overflow-y:auto;background:${th().topbar};border-right:1px solid ${th().border};-webkit-overflow-scrolling:touch`);panel.id='group-panel';
    const hdr=UI.el('div',`padding:12px 14px;font-weight:700;font-size:11px;color:${th().text3};border-bottom:1px solid ${th().border};letter-spacing:1px`);hdr.textContent=Groups.isAdmin(g,S.me)?'👑 الإدارة':Groups.isMod(g,S.me)?'🛡 المشرف المساعد':'👥 الأعضاء';panel.appendChild(hdr);
    if(Groups.canManage(g,S.me)){
      const ctrl=UI.el('div',`padding:10px 14px;border-bottom:1px solid ${th().border}`);
      if(Groups.isAdmin(g,S.me)){
        if(!S.groupEdit){const editBtn=UI.el('button',`width:100%;padding:8px;border:1px solid ${th().border};border-radius:10px;background:${th().card2};color:${th().text};font-family:inherit;font-size:12px;cursor:pointer;margin-bottom:8px`);editBtn.textContent='✏️ تعديل المجموعة';editBtn.addEventListener('click',()=>{S.groupEdit=true;S.groupNewName=g.name;buildGroupPanel(parentEl);});ctrl.appendChild(editBtn);}
        else{const nameInp=UI.el('input',`width:100%;padding:7px 10px;border:1.5px solid ${th().inpBorder};border-radius:10px;background:${th().inp};color:${th().text};font-size:12px;direction:rtl;box-sizing:border-box;margin-bottom:6px`);nameInp.placeholder='اسم جديد...';nameInp.value=S.groupNewName;nameInp.maxLength=40;nameInp.addEventListener('input',e=>S.groupNewName=e.target.value);ctrl.appendChild(nameInp);
          const photoRow=UI.el('div','display:flex;gap:4px;margin-bottom:6px;align-items:center');const gPhIn=document.createElement('input');gPhIn.type='file';gPhIn.accept='image/*';gPhIn.style.display='none';gPhIn.addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;S.groupNewPhoto=await UI.fileToBase64(f);e.target.value='';buildGroupPanel(parentEl);});const gPhBtn=UI.el('button',`flex:1;padding:6px;border:1px solid ${th().border};border-radius:8px;background:${th().card2};color:${th().text};font-family:inherit;font-size:11px;cursor:pointer`);gPhBtn.textContent='📷 صورة';gPhBtn.addEventListener('click',()=>gPhIn.click());photoRow.appendChild(gPhBtn);photoRow.appendChild(gPhIn);if(S.groupNewPhoto){const pv=document.createElement('img');pv.src=S.groupNewPhoto;pv.loading='lazy';pv.style.cssText='width:32px;height:32px;border-radius:6px;object-fit:cover';photoRow.appendChild(pv);}ctrl.appendChild(photoRow);
          const saveRow=UI.el('div','display:flex;gap:4px');const saveBtn=UI.el('button','flex:1;padding:7px;border:none;border-radius:10px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-family:inherit;font-size:11px;cursor:pointer');saveBtn.textContent='حفظ';saveBtn.addEventListener('click',async()=>{await Groups.saveEdit(g.id,S.groupNewName,S.groupNewPhoto);S.groupEdit=false;S.groupNewPhoto=null;UI.toast('تم التعديل ✓','success');buildGroupPanel(parentEl);});const cancelEdit=UI.el('button',`flex:1;padding:7px;border:1px solid ${th().border};border-radius:10px;background:${th().card2};color:${th().text};font-family:inherit;font-size:11px;cursor:pointer`);cancelEdit.textContent='إلغاء';cancelEdit.addEventListener('click',()=>{S.groupEdit=false;buildGroupPanel(parentEl);});saveRow.appendChild(saveBtn);saveRow.appendChild(cancelEdit);ctrl.appendChild(saveRow);}
        const invT=UI.el('div',`font-size:10px;color:${th().text3};font-weight:700;margin:8px 0 4px;letter-spacing:1px`);invT.textContent='رمز الدعوة';
        const invC=UI.el('div',`font-family:monospace;font-size:11px;padding:7px 10px;background:${th().card2};border-radius:8px;color:${g.inviteActive?'#22c55e':th().text3};word-break:break-all;margin-bottom:6px;border:1px solid ${th().border}`);invC.textContent=g.inviteActive?g.inviteCode:'🔒 مغلق';
        const idEl=UI.el('div',`font-size:10px;color:${th().text3};margin-bottom:8px`);idEl.innerHTML=`ID: <span style="color:#6366f1;font-family:monospace">${g.id}</span>`;
        const invBtnRow=UI.el('div','display:flex;gap:5px');if(g.inviteActive){const copyBtn=UI.el('button',`flex:1;padding:6px;border:1px solid ${th().border};border-radius:8px;background:${th().card2};color:${th().text2};font-family:inherit;font-size:11px;cursor:pointer`);copyBtn.textContent='نسخ';copyBtn.addEventListener('click',()=>{try{navigator.clipboard.writeText(g.inviteCode);}catch{}copyBtn.textContent='✓ تم';copyBtn.style.background='#f0fdf4';copyBtn.style.color='#22c55e';setTimeout(()=>{copyBtn.textContent='نسخ';copyBtn.style.background=th().card2;copyBtn.style.color=th().text2;},2000);UI.toast('تم نسخ الرمز ✓','success');});invBtnRow.appendChild(copyBtn);}
        const togBtn=UI.el('button',`flex:1;padding:6px;border:1px solid ${th().border};border-radius:8px;background:${th().card2};color:${g.inviteActive?'#ef4444':'#22c55e'};font-family:inherit;font-size:11px;cursor:pointer`);togBtn.textContent=g.inviteActive?'إغلاق':'فتح';togBtn.addEventListener('click',()=>Groups.toggleInvite(g.id,g.inviteActive));invBtnRow.appendChild(togBtn);
        const delGBtn=UI.el('button',`width:100%;margin-top:8px;padding:7px;border:1px solid #fecaca;border-radius:10px;background:${UI.isDark()?'#1e1e2e':'#fff'};color:#ef4444;font-family:inherit;font-size:11px;cursor:pointer`);delGBtn.textContent='🗑 حذف المجموعة';delGBtn.addEventListener('click',async()=>{if(!confirm('هل تريد حذف المجموعة نهائياً؟'))return;await Groups.deleteGroup(g.id);UI.toast('تم الحذف','info');go('home');});
        ctrl.appendChild(invT);ctrl.appendChild(invC);ctrl.appendChild(idEl);ctrl.appendChild(invBtnRow);ctrl.appendChild(delGBtn);
      }
      const addRow=UI.el('div','display:flex;gap:5px;margin-top:10px');const addInp=UI.el('input',`flex:1;padding:7px 10px;border:1.5px solid ${th().inpBorder};border-radius:10px;background:${th().inp};color:${th().text};font-size:12px;direction:rtl`);addInp.placeholder='+ إضافة عضو...';
      const addBtn=UI.el('button','padding:7px 10px;border:none;border-radius:10px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-family:inherit;font-size:12px;cursor:pointer');addBtn.textContent='+';
      const doAdd=async()=>{const res=await Groups.addMember(g.id,addInp.value,S.users);if(res.error)UI.toast(res.error,'error');else{UI.toast('تمت الإضافة ✓','success');addInp.value='';UI.playSound('notif');}};
      addBtn.addEventListener('click',doAdd);addInp.addEventListener('keydown',e=>{if(e.key==='Enter')doAdd();});addRow.appendChild(addInp);addRow.appendChild(addBtn);ctrl.appendChild(addRow);panel.appendChild(ctrl);
    }
    const agP=Groups.getPending(g);
    if(Groups.canManage(g,S.me)&&agP.length>0){const sec=UI.el('div',`padding:8px 14px;border-bottom:1px solid ${th().border}`);const lbl=UI.el('div','font-size:10px;color:#ef4444;font-weight:700;margin-bottom:6px');lbl.textContent=`طلبات (${agP.length})`;sec.appendChild(lbl);
      agP.forEach(u=>{const row=UI.el('div','display:flex;align-items:center;gap:5px;margin-bottom:6px');row.appendChild(UI.makeAvatar(S.users[u],24));const nm=UI.el('span',`flex:1;font-size:12px;color:${th().text};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`);nm.textContent=u;const aBtn=UI.el('button','background:#f0fdf4;border:none;border-radius:6px;padding:4px 7px;cursor:pointer;color:#22c55e;font-size:13px');aBtn.textContent='✓';aBtn.addEventListener('click',()=>{Groups.approve(g.id,u);UI.playSound('notif');});const rBtn=UI.el('button','background:#fef2f2;border:none;border-radius:6px;padding:4px 7px;cursor:pointer;color:#ef4444;font-size:13px');rBtn.textContent='✗';rBtn.addEventListener('click',()=>Groups.reject(g.id,u));row.appendChild(nm);row.appendChild(aBtn);row.appendChild(rBtn);sec.appendChild(row);});panel.appendChild(sec);}
    const agM=Groups.getMembers(g);const memSec=UI.el('div','padding:8px 14px');const memHdr=UI.el('div',`font-size:10px;color:${th().text3};font-weight:700;margin-bottom:8px;letter-spacing:1px`);memHdr.textContent=`الأعضاء (${agM.length})`;memSec.appendChild(memHdr);
    agM.forEach(u=>{const isMod=g.mods&&g.mods[u];const isAdm=g.admin===u;const row=UI.el('div','display:flex;align-items:center;gap:8px;margin-bottom:10px');const avBtn=UI.el('button','background:none;border:none;cursor:pointer;padding:0');avBtn.appendChild(UI.makeAvatar(S.users[u],34,{online:Chat.isOnline(S.presence,u)}));avBtn.addEventListener('click',()=>go('userProfile',u));
      const info=UI.el('div','flex:1;min-width:0');const nmBtn=UI.el('button','background:none;border:none;cursor:pointer;padding:0;text-align:right;width:100%');const nmEl=UI.el('div',`font-size:12px;font-weight:${isAdm||isMod?700:400};color:${th().text};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`);nmEl.textContent=u;const roleEl=UI.el('div',`font-size:9px;color:${isAdm?'#f59e0b':isMod?'#6366f1':Chat.isOnline(S.presence,u)?'#22c55e':th().text3}`);roleEl.textContent=isAdm?'👑 مشرف رئيسي':isMod?'🛡 مشرف مساعد':Chat.isOnline(S.presence,u)?'متصل':Chat.lastSeenText(S.presence,u);
      nmBtn.appendChild(nmEl);nmBtn.addEventListener('click',()=>go('userProfile',u));info.appendChild(nmBtn);info.appendChild(roleEl);row.appendChild(avBtn);row.appendChild(info);
      if(Groups.isAdmin(g,S.me)&&u!==S.me){const acts=UI.el('div','display:flex;gap:3px');const modBtn=UI.el('button','background:none;border:none;cursor:pointer;font-size:14px;padding:2px 4px');modBtn.textContent='🛡';modBtn.title=isMod?'إزالة المشرف':'ترقية لمشرف';modBtn.style.color=isMod?'#6366f1':th().text3;modBtn.addEventListener('click',()=>{Groups.toggleMod(g.id,u,!!isMod);UI.toast(isMod?'تمت إزالة المشرف':'أصبح مشرفاً مساعداً ✓','success');});const kickBtn=UI.el('button','background:none;border:none;cursor:pointer;font-size:14px;padding:2px 4px');kickBtn.textContent='🚫';kickBtn.style.color=th().text3;kickBtn.addEventListener('click',()=>Groups.kick(g.id,u));acts.appendChild(modBtn);acts.appendChild(kickBtn);row.appendChild(acts);}
      else if(Groups.isMod(g,S.me)&&!isAdm&&!isMod&&u!==S.me){const kickBtn=UI.el('button','background:none;border:none;cursor:pointer;font-size:14px;padding:2px 4px');kickBtn.textContent='🚫';kickBtn.style.color=th().text3;kickBtn.addEventListener('click',()=>Groups.kick(g.id,u));row.appendChild(kickBtn);}
      memSec.appendChild(row);});panel.appendChild(memSec);parentEl.appendChild(panel);
  }

  /* ══════════════════════════════════════════
     PROFILE
  ══════════════════════════════════════════ */
  function renderProfile(){
    const md=S.users[S.me]||{};APP.appendChild(buildSimpleTopbar('ملفي الشخصي'));
    const scroll=UI.el('div','flex:1;overflow-y:auto;padding:20px;-webkit-overflow-scrolling:touch');const inner=UI.el('div','max-width:400px;margin:0 auto');
    let ePhoto=md.photo||null,eEmoji=md.emoji||'',eBio=md.bio||'';
    const avSec=UI.el('div','text-align:center;margin-bottom:24px');const avWrap=UI.el('div','position:relative;display:inline-block');const avEl=UI.el('div','');
    const rebuildAv=()=>{avEl.innerHTML='';avEl.appendChild(UI.makeAvatar({...md,photo:ePhoto,emoji:eEmoji},96,{online:true}));};rebuildAv();
    const phIn=document.createElement('input');phIn.type='file';phIn.accept='image/*';phIn.style.display='none';phIn.addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;if(f.size>3*1024*1024)return UI.toast('الحجم الأقصى 3 ميغابايت','error');ePhoto=await UI.fileToBase64(f);e.target.value='';rebuildAv();});
    const camBtn=UI.el('button',`position:absolute;bottom:0;left:0;width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);border:2px solid ${th().bg};cursor:pointer;color:#fff;font-size:14px;display:flex;align-items:center;justify-content:center`);camBtn.textContent='📷';camBtn.addEventListener('click',()=>phIn.click());
    avWrap.appendChild(avEl);avWrap.appendChild(camBtn);avWrap.appendChild(phIn);const nmEl=UI.el('div',`font-weight:800;font-size:22px;margin-top:12px;color:${th().text}`);nmEl.textContent=S.me;const dtEl=UI.el('div',`font-size:12px;color:${th().text3}`);dtEl.textContent=md.createdAt?`عضو منذ ${new Date(md.createdAt).toLocaleDateString('ar')}`:'';
    avSec.appendChild(avWrap);avSec.appendChild(nmEl);avSec.appendChild(dtEl);inner.appendChild(avSec);
    const emoSec=UI.el('div','margin-bottom:16px');const emoLbl=UI.el('label',`font-size:12px;color:${th().text2};font-weight:700;display:block;margin-bottom:6px`);emoLbl.textContent='رمز تعبيري';emoSec.appendChild(emoLbl);const emoGrid=UI.el('div','display:flex;flex-wrap:wrap;gap:6px');
    const emojis=['','😀','😎','🥷','👻','🐱','🦊','🐼','🤖','👽','🦁','🌟','🔥','💎','🎮','🚀','⚡','🎸','🧠','💫','🌙','🦋','🎯','🌈'];
    emojis.forEach(e=>{const b=UI.el('button',`width:36px;height:36px;font-size:18px;border-radius:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:border-color .15s`);b.style.border=`2px solid ${eEmoji===e?'#6366f1':th().border}`;b.style.background=eEmoji===e?'#6366f115':th().card2;if(e)b.textContent=e;else{const sp=UI.el('span',`font-size:11px;color:${th().text3}`);sp.textContent='لا';b.appendChild(sp);}b.addEventListener('click',()=>{eEmoji=e;rebuildAv();emoGrid.querySelectorAll('button').forEach((x,i)=>{x.style.border=`2px solid ${emojis[i]===eEmoji?'#6366f1':th().border}`;x.style.background=emojis[i]===eEmoji?'#6366f115':th().card2;});});emoGrid.appendChild(b);});emoSec.appendChild(emoGrid);inner.appendChild(emoSec);
    const bioSec=UI.el('div','margin-bottom:16px');const bioLbl=UI.el('label',`font-size:12px;color:${th().text2};font-weight:700;display:block;margin-bottom:6px`);bioLbl.textContent='النبذة الشخصية';bioSec.appendChild(bioLbl);const bioInp=UI.el('textarea',`width:100%;padding:11px 14px;border-radius:12px;border:1.5px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:14px;direction:rtl;resize:none;line-height:1.6;box-sizing:border-box`);bioInp.placeholder='اكتب شيئاً عن نفسك...';bioInp.maxLength=120;bioInp.value=eBio;bioInp.rows=2;const bioCnt=UI.el('div',`font-size:10px;color:${th().text3};text-align:left;margin-top:2px`);bioCnt.textContent=`${eBio.length}/120`;bioInp.addEventListener('input',e=>{eBio=e.target.value;bioCnt.textContent=`${eBio.length}/120`;});bioSec.appendChild(bioInp);bioSec.appendChild(bioCnt);inner.appendChild(bioSec);
    const saveBtn=UI.el('button',`width:100%;padding:13px;border:none;border-radius:14px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-size:15px;font-weight:700;font-family:inherit;margin-bottom:10px;cursor:pointer;box-shadow:0 4px 14px rgba(99,102,241,.4)`);saveBtn.textContent='حفظ التغييرات ✓';saveBtn.addEventListener('click',async()=>{await FB.upd(`users/${S.me}`,{emoji:eEmoji,bio:eBio.trim(),photo:ePhoto||null});UI.toast('تم حفظ التغييرات ✓','success');go('home');});inner.appendChild(saveBtn);
    let showPwd=false;const pwdToggle=UI.el('button',`width:100%;padding:11px;border:1px solid ${th().border};border-radius:12px;background:${th().card2};color:${th().text};font-family:inherit;font-size:14px;cursor:pointer;margin-bottom:10px`);pwdToggle.textContent='🔑 تغيير كلمة المرور';const pwdForm=UI.el('div',`margin-bottom:10px;background:${th().card2};border:1px solid ${th().border};border-radius:14px;padding:16px;display:none`);
    const mkPwd=(ph,ac)=>{const i=UI.el('input',`width:100%;padding:11px 14px;border-radius:12px;border:1.5px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:13px;direction:rtl;box-sizing:border-box;margin-bottom:8px`);i.type='password';i.placeholder=ph;i.autocomplete=ac;return i;};
    const pwdOld=mkPwd('كلمة المرور الحالية','current-password');const pwdNew=mkPwd('كلمة المرور الجديدة','new-password');const pwdNew2=mkPwd('تأكيد كلمة المرور الجديدة','new-password');
    const pwdSubmit=UI.el('button','width:100%;padding:11px;border:none;border-radius:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer');pwdSubmit.textContent='تأكيد التغيير 🔐';
    pwdSubmit.addEventListener('click',async()=>{const res=await Auth.changePassword(S.me,pwdOld.value,pwdNew.value,pwdNew2.value);if(res.error)UI.toast(res.error,'error');else{UI.toast('تم تغيير كلمة المرور 🔐','success');pwdOld.value=pwdNew.value=pwdNew2.value='';showPwd=false;pwdForm.style.display='none';pwdToggle.textContent='🔑 تغيير كلمة المرور';}});
    pwdForm.appendChild(pwdOld);pwdForm.appendChild(pwdNew);pwdForm.appendChild(pwdNew2);pwdForm.appendChild(pwdSubmit);pwdToggle.addEventListener('click',()=>{showPwd=!showPwd;pwdForm.style.display=showPwd?'block':'none';pwdToggle.textContent=showPwd?'🔑 إخفاء':'🔑 تغيير كلمة المرور';});inner.appendChild(pwdToggle);inner.appendChild(pwdForm);
    const thBtn=UI.el('button',`width:100%;padding:11px;border:1px solid ${th().border};border-radius:12px;background:${th().card2};color:${th().text};font-family:inherit;font-size:14px;cursor:pointer;margin-bottom:10px`);thBtn.textContent=UI.isDark()?'☀️ وضع فاتح':'🌙 وضع داكن';thBtn.addEventListener('click',()=>{UI.toggleDark();S.dark=UI.isDark();renderScreen();});inner.appendChild(thBtn);
    const logBtn=UI.el('button',`width:100%;padding:11px;border:1px solid #fecaca;border-radius:12px;background:${UI.isDark()?'#1e1e2e':'#fff'};color:#ef4444;font-family:inherit;font-size:14px;cursor:pointer;margin-bottom:10px`);logBtn.textContent='⏻ تسجيل الخروج';logBtn.addEventListener('click',()=>{Chat.goOffline(S.me);Auth.clearUser();S.me=null;go('auth');});inner.appendChild(logBtn);
    const delBtn=UI.el('button',`width:100%;padding:11px;border:1px solid #fca5a5;border-radius:12px;background:${UI.isDark()?'#1e1e2e':'#fff'};color:#dc2626;font-family:inherit;font-size:13px;cursor:pointer`);delBtn.textContent='🗑 حذف الحساب نهائياً';delBtn.addEventListener('click',async()=>{if(!confirm('هل تريد حذف حسابك نهائياً؟ لا يمكن التراجع!'))return;await Auth.deleteAccount(S.me,S.groups);Auth.clearUser();S.me=null;go('auth');});inner.appendChild(delBtn);
    scroll.appendChild(inner);APP.appendChild(scroll);
  }

  /* ══════════════════════════════════════════
     USER PROFILE
  ══════════════════════════════════════════ */
  function renderUserProfile(){
    const u=S.activeId;const userData=S.users[u];if(!userData)return;
    APP.appendChild(buildSimpleTopbar(u));
    const scroll=UI.el('div','flex:1;overflow-y:auto;padding:20px;-webkit-overflow-scrolling:touch;text-align:center');const inner=UI.el('div','max-width:400px;margin:0 auto;text-align:center');
    const avWrap=UI.el('div','margin-bottom:14px;display:inline-block;cursor:pointer');avWrap.appendChild(UI.makeAvatar(userData,100,{online:Chat.isOnline(S.presence,u),ring:fws().includes(u),seen:Stories.isSeen(u,S.stories)}));if(userData.photo)avWrap.addEventListener('click',()=>{S.viewImg=userData.photo;showImgViewer();});inner.appendChild(avWrap);
    const nm=UI.el('div',`font-weight:800;font-size:22px;color:${th().text};margin-bottom:4px`);if(userData.emoji)nm.innerHTML=`<span style="margin-left:6px">${userData.emoji}</span>${u}`;else nm.textContent=u;inner.appendChild(nm);
    const status=UI.el('div','font-size:13px;margin-bottom:8px');status.textContent=Chat.lastSeenText(S.presence,u);status.style.color=Chat.isOnline(S.presence,u)?'#22c55e':th().text3;inner.appendChild(status);
    if(userData.bio){const bio=UI.el('div',`color:${th().text2};font-size:14px;padding:0 20px;line-height:1.6;margin-bottom:16px`);bio.textContent=userData.bio;inner.appendChild(bio);}
    const mf=myFriends();
    if(mf.includes(u)&&S.stories[u]&&Object.keys(S.stories[u]).length>0){const stSec=UI.el('div',`margin-bottom:16px;padding:12px;background:${th().card};border-radius:14px;border:1px solid ${th().border}`);const stHdr=UI.el('div',`font-size:12px;color:${th().text2};font-weight:700;margin-bottom:10px`);stHdr.textContent='القصص';stSec.appendChild(stHdr);const stRow=UI.el('div','display:flex;gap:8px;overflow-x:auto;justify-content:center;scrollbar-width:none');Stories.getUserStories(u,S.stories).forEach(({sid,data})=>{const img=document.createElement('img');img.src=data;img.loading='lazy';img.style.cssText='width:60px;height:80px;object-fit:cover;border-radius:8px;cursor:pointer;border:2px solid #6366f1;flex-shrink:0';img.addEventListener('click',()=>{Stories.markSeen(u);openStoryViewer(u);});stRow.appendChild(img);});stSec.appendChild(stRow);inner.appendChild(stSec);}
    else if(!mf.includes(u)&&u!==S.me&&S.stories[u]&&Object.keys(S.stories[u]).length>0){const locked=UI.el('div',`padding:8px 14px;background:${th().card2};border-radius:10px;color:${th().text3};font-size:12px;border:1px solid ${th().border};margin-bottom:12px`);locked.textContent='🔒 القصص متاحة للأصدقاء فقط';inner.appendChild(locked);}
    const btnRow=UI.el('div','display:flex;gap:8px;margin-top:16px');const msgBtn=UI.el('button','flex:1;padding:10px 16px;border:none;border-radius:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-weight:700;font-size:14px;font-family:inherit;cursor:pointer');msgBtn.textContent='💬 رسالة';msgBtn.addEventListener('click',()=>go('dm',u));btnRow.appendChild(msgBtn);
    if(!mf.includes(u)&&u!==S.me){const addBtn=UI.el('button',`flex:1;padding:10px 16px;border:1px solid ${th().border};border-radius:12px;background:${th().card2};color:${UI.isDark()?'#a5b4fc':'#6366f1'};font-weight:700;font-size:14px;font-family:inherit;cursor:pointer`);addBtn.textContent='+ صديق';addBtn.addEventListener('click',async()=>{const res=await Friends.sendRequest(S.me,u,S.users,mf);if(res.error)UI.toast(res.error,'error');else{UI.toast(`تم إرسال طلب صداقة إلى ${u} ✓`,'success');UI.playSound('notif');}});btnRow.appendChild(addBtn);}
    else if(mf.includes(u)){const fr=UI.el('div','flex:1;text-align:center;padding:10px;color:#22c55e;font-size:13px;font-weight:700');fr.textContent='✓ صديق';btnRow.appendChild(fr);}
    inner.appendChild(btnRow);scroll.appendChild(inner);APP.appendChild(scroll);
  }

  /* ══════════════════════════════════════════
     FRIENDS
  ══════════════════════════════════════════ */
  function renderFriends(){
    const mf=myFriends();const pr=pendingReqs();APP.appendChild(buildSimpleTopbar(`الأصدقاء (${mf.length})`));
    const scroll=UI.el('div','flex:1;overflow-y:auto;padding:16px;-webkit-overflow-scrolling:touch');
    if(pr.length){const sec=UI.el('div','margin-bottom:16px');const hdr=UI.el('div','font-size:12px;font-weight:700;color:#ef4444;margin-bottom:8px');hdr.textContent=`طلبات الصداقة الواردة (${pr.length})`;sec.appendChild(hdr);
      pr.forEach(from=>{const row=UI.el('div',`display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:14px;background:${UI.isDark()?'#1e1e2e':'#fff7f7'};border:1px solid #fee2e2;margin-bottom:6px`);row.appendChild(UI.makeAvatar(S.users[from],40));const nm=UI.el('div','flex:1;font-weight:600;font-size:14px');nm.style.color=th().text;nm.textContent=from;row.appendChild(nm);const rBtn=UI.el('button',`padding:7px 10px;border:1px solid ${th().border};border-radius:10px;background:${th().card2};color:${th().text2};font-family:inherit;font-size:12px;cursor:pointer;margin-left:4px`);rBtn.textContent='رفض';rBtn.addEventListener('click',async()=>{await Friends.rejectRequest(S.me,from);UI.toast('تم رفض الطلب','info');});const aBtn=UI.el('button','padding:7px 12px;border:none;border-radius:10px;background:#22c55e;color:#fff;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer');aBtn.textContent='قبول';aBtn.addEventListener('click',async()=>{await Friends.acceptRequest(S.me,from);UI.toast(`أصبحت وصديق ${from} ✓`,'success');UI.playSound('notif');});row.appendChild(rBtn);row.appendChild(aBtn);sec.appendChild(row);});scroll.appendChild(sec);}
    const sRow=UI.el('div','display:flex;gap:6px;margin-bottom:14px');const sInp=UI.el('input',`flex:1;padding:11px 14px;border-radius:12px;border:1.5px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:13px;direction:rtl;box-sizing:border-box`);sInp.placeholder='ابحث عن مستخدم لإضافته...';const sBtn=UI.el('button','padding:10px 14px;border:none;border-radius:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-weight:700;font-family:inherit;font-size:13px;cursor:pointer');sBtn.textContent='+ إضافة';
    const doSearch=async()=>{const target=sInp.value.trim();if(!target)return;const res=await Friends.sendRequest(S.me,target,S.users,mf);if(res.error)UI.toast(res.error,'error');else{UI.toast(`تم إرسال طلب صداقة إلى ${target} ✓`,'success');UI.playSound('notif');}};
    sBtn.addEventListener('click',doSearch);sInp.addEventListener('keydown',e=>{if(e.key==='Enter')doSearch();});
    sInp.addEventListener('input',()=>{const v=sInp.value.trim();const ex=document.getElementById('search-result');if(ex)ex.remove();if(v&&S.users[v]&&v!==S.me){const res=UI.el('div',`background:${th().card2};border:1px solid ${th().border};border-radius:12px;padding:12px;margin-bottom:12px`);res.id='search-result';const rRow=UI.el('div','display:flex;align-items:center;gap:10px');rRow.appendChild(UI.makeAvatar(S.users[v],40,{online:Chat.isOnline(S.presence,v)}));const ni=UI.el('div','flex:1');const nn=UI.el('div',`font-weight:600;color:${th().text}`);nn.textContent=v;const ns=UI.el('div',`font-size:11px;color:${Chat.isOnline(S.presence,v)?'#22c55e':th().text3}`);ns.textContent=Chat.lastSeenText(S.presence,v);ni.appendChild(nn);ni.appendChild(ns);rRow.appendChild(ni);const vBtn=UI.el('button',`padding:6px 10px;border:1px solid ${th().border};border-radius:10px;background:${th().card2};color:${th().text2};font-family:inherit;font-size:12px;cursor:pointer`);vBtn.textContent='عرض';vBtn.addEventListener('click',()=>go('userProfile',v));rRow.appendChild(vBtn);res.appendChild(rRow);sRow.after(res);}});
    sRow.appendChild(sInp);sRow.appendChild(sBtn);scroll.appendChild(sRow);
    const fHdr=UI.el('div',`font-size:12px;font-weight:700;color:${th().text3};margin-bottom:8px`);fHdr.textContent=`أصدقائي (${mf.length})`;scroll.appendChild(fHdr);
    if(!mf.length){const emp=UI.el('div',`color:${th().text3};font-size:13px;text-align:center;padding:16px 0`);emp.textContent='لم تضف أصدقاء بعد';scroll.appendChild(emp);}
    mf.forEach(fr=>{const row=UI.el('div',`display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:14px;cursor:pointer;background:${th().card};border:1px solid ${th().border};margin-bottom:6px`);row.appendChild(UI.makeAvatar(S.users[fr],40,{online:Chat.isOnline(S.presence,fr)}));const info=UI.el('div','flex:1;min-width:0');const nm=UI.el('div',`font-weight:600;color:${th().text};font-size:14px`);nm.textContent=fr;const st=UI.el('div',`font-size:11px;color:${Chat.isOnline(S.presence,fr)?'#22c55e':th().text3}`);st.textContent=Chat.lastSeenText(S.presence,fr);info.appendChild(nm);info.appendChild(st);row.appendChild(info);const msgBtn=UI.el('button','padding:7px 12px;border:none;border-radius:10px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer');msgBtn.textContent='رسالة';msgBtn.addEventListener('click',()=>go('dm',fr));row.appendChild(msgBtn);const viewBtn=UI.el('button',`padding:7px 10px;border:1px solid ${th().border};border-radius:10px;background:${th().card2};color:${th().text2};font-family:inherit;font-size:12px;cursor:pointer`);viewBtn.textContent='عرض';viewBtn.addEventListener('click',()=>go('userProfile',fr));row.appendChild(viewBtn);const remBtn=UI.el('button','background:none;border:none;cursor:pointer;font-size:18px;padding:4px 6px');remBtn.textContent='✕';remBtn.style.color=th().text3;remBtn.addEventListener('click',async()=>{if(!confirm(`هل تريد إزالة ${fr}؟`))return;const res=await Friends.removeFriend(S.me,fr);if(res.error)UI.toast(res.error,'error');else UI.toast('تمت الإزالة','info');});row.appendChild(remBtn);scroll.appendChild(row);});
    APP.appendChild(scroll);
  }

  /* ══════════════════════════════════════════
     NEW GROUP / JOIN
  ══════════════════════════════════════════ */
  function renderNewGroup(){
    APP.appendChild(buildSimpleTopbar('مجموعة جديدة'));
    const cnt=UI.el('div','flex:1;display:flex;align-items:center;justify-content:center;padding:24px');const inner=UI.el('div','width:100%;max-width:360px;text-align:center');
    inner.innerHTML=`<div style="font-size:52px;margin-bottom:14px">👥</div><h2 style="font-weight:800;font-size:20px;margin-bottom:8px;color:${th().text}">مجموعة جديدة</h2><p style="color:${th().text3};font-size:13px;margin-bottom:20px">ستكون المشرف الرئيسي تلقائياً</p>`;
    const inp=UI.el('input',`width:100%;padding:11px 14px;border-radius:12px;border:1.5px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:14px;direction:rtl;box-sizing:border-box;margin-bottom:14px`);inp.placeholder='اسم المجموعة...';inp.maxLength=40;
    const btn2=UI.el('button','width:100%;padding:13px;border:none;border-radius:14px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer');btn2.textContent='إنشاء ←';
    const doCreate=async()=>{const res=await Groups.create(S.me,inp.value);if(res.error)UI.toast(res.error,'error');else{UI.toast('تم إنشاء المجموعة ✓','success');go('group',res.gid);}};
    btn2.addEventListener('click',doCreate);inp.addEventListener('keydown',e=>{if(e.key==='Enter')doCreate();});inner.appendChild(inp);inner.appendChild(btn2);cnt.appendChild(inner);APP.appendChild(cnt);setTimeout(()=>inp.focus(),100);
  }

  function renderJoin(){
    APP.appendChild(buildSimpleTopbar('الانضمام لمجموعة'));
    const cnt=UI.el('div','flex:1;display:flex;align-items:center;justify-content:center;padding:24px');const inner=UI.el('div','width:100%;max-width:360px;text-align:center');
    inner.innerHTML=`<div style="font-size:52px;margin-bottom:14px">🔗</div><h2 style="font-weight:800;font-size:20px;margin-bottom:8px;color:${th().text}">الانضمام لمجموعة</h2><p style="color:${th().text3};font-size:13px;margin-bottom:20px">أدخل رمز الدعوة أو معرّف المجموعة</p>`;
    const inp=UI.el('input',`width:100%;padding:11px 14px;border-radius:12px;border:1.5px solid ${th().inpBorder};background:${th().inp};color:${th().text};font-size:14px;direction:rtl;box-sizing:border-box;margin-bottom:12px`);inp.placeholder='ادخل الرمز...';
    const errBox=UI.el('div','padding:9px 14px;border-radius:10px;font-size:13px;font-weight:600;margin-bottom:12px;display:none');const showErr=(msg,ok=false)=>{errBox.textContent=msg;errBox.style.display='block';errBox.style.background=ok?'#f0fdf4':'#fef2f2';errBox.style.color=ok?'#22c55e':'#ef4444';};
    const btnRow=UI.el('div','display:flex;gap:8px');const invBtn=UI.el('button','flex:1;padding:10px 16px;border:none;border-radius:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-weight:700;font-size:13px;font-family:inherit;cursor:pointer');invBtn.textContent='انضمام برمز';invBtn.addEventListener('click',async()=>{const res=await Groups.joinByInvite(S.me,inp.value);if(res.error)showErr(res.error);else go('group',res.gid);});
    const reqBtn=UI.el('button',`flex:1;padding:10px 16px;border:1px solid ${th().border};border-radius:12px;background:${th().card2};color:${UI.isDark()?'#a5b4fc':'#6366f1'};font-weight:700;font-size:13px;font-family:inherit;cursor:pointer`);reqBtn.textContent='إرسال طلب';reqBtn.addEventListener('click',async()=>{const res=await Groups.requestJoin(S.me,inp.value);if(res.error)showErr(res.error);else showErr('✅ تم إرسال الطلب!',true);});
    btnRow.appendChild(invBtn);btnRow.appendChild(reqBtn);inner.appendChild(inp);inner.appendChild(errBox);inner.appendChild(btnRow);cnt.appendChild(inner);APP.appendChild(cnt);setTimeout(()=>inp.focus(),100);
  }

  /* ══════════════════════════════════════════
     OVERLAYS
  ══════════════════════════════════════════ */
  function showImgViewer(){
    const ex=document.getElementById('img-viewer');if(ex)ex.remove();
    const ov=UI.el('div','position:fixed;inset:0;background:rgba(0,0,0,.94);z-index:1000;display:flex;align-items:center;justify-content:center');ov.id='img-viewer';
    const img=document.createElement('img');img.src=S.viewImg;img.style.cssText='max-width:96vw;max-height:88vh;object-fit:contain;border-radius:10px';img.addEventListener('click',e=>e.stopPropagation());
    const closeBtn=UI.el('button','position:absolute;top:14px;right:14px;background:rgba(255,255,255,.15);border:none;color:#fff;font-size:22px;cursor:pointer;border-radius:50%;width:40px;height:40px;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)');closeBtn.textContent='✕';closeBtn.addEventListener('click',()=>ov.remove());ov.addEventListener('click',()=>ov.remove());ov.appendChild(img);ov.appendChild(closeBtn);APP.appendChild(ov);
  }

  function showStoryPreview(){
    const ex=document.getElementById('story-preview-ov');if(ex)ex.remove();
    const ov=UI.el('div','position:fixed;inset:0;background:rgba(0,0,0,.96);z-index:998;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px');ov.id='story-preview-ov';
    const img=document.createElement('img');img.src=S.storyPreview;img.style.cssText='max-width:90vw;max-height:65vh;object-fit:contain;border-radius:14px';ov.appendChild(img);
    const btnRow=UI.el('div','display:flex;gap:10px');
    const postBtn=UI.el('button','padding:11px 24px;border:none;border-radius:14px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-weight:700;font-size:15px;font-family:inherit;cursor:pointer');postBtn.textContent='نشر القصة 📢';postBtn.addEventListener('click',async()=>{await Stories.post(S.me,S.storyPreview);S.storyPreview=null;ov.remove();UI.toast('تم نشر القصة ✓','success');});
    const cancelBtn=UI.el('button',`padding:11px 20px;border:1px solid rgba(255,255,255,.2);border-radius:14px;background:transparent;color:#fff;font-family:inherit;font-size:15px;cursor:pointer`);cancelBtn.textContent='إلغاء';cancelBtn.addEventListener('click',()=>{S.storyPreview=null;ov.remove();});
    btnRow.appendChild(postBtn);btnRow.appendChild(cancelBtn);ov.appendChild(btnRow);APP.appendChild(ov);
  }

  /* ✅ Fix 3: Story viewer with correct progress bar class */
  function openStoryViewer(initialUser){
    const ex=document.getElementById('story-viewer-ov');if(ex)ex.remove();
    const allUsers=[...(S.stories[S.me]&&Object.keys(S.stories[S.me]).length?[S.me]:[]),...fws()];
    if(!allUsers.length)return;
    let uIdx=Math.max(0,allUsers.indexOf(initialUser)),sIdx=0,progress=0,timer=null;
    const ov=UI.el('div','position:fixed;inset:0;background:#000;z-index:999;display:flex;flex-direction:column');ov.id='story-viewer-ov';

    const renderSV=()=>{
      ov.innerHTML='';
      const curUser=allUsers[uIdx];
      const stArr=Stories.getUserStories(curUser,S.stories);
      if(!stArr.length){ov.remove();return;}
      const curStory=stArr[Math.min(sIdx,stArr.length-1)];

      // ✅ Fix 3: Progress bars with correct IDs
      const prog=UI.el('div','position:absolute;top:0;left:0;right:0;z-index:2;display:flex;gap:3px;padding:10px 12px 6px');
      stArr.forEach((_,i)=>{
        const bar=UI.el('div','flex:1;height:3px;background:rgba(255,255,255,.3);border-radius:2px;overflow:hidden');
        const fill=UI.el('div','height:100%;background:#fff;border-radius:2px');
        fill.id=`prog-fill-${i}`;     // ✅ correct ID per bar
        fill.style.width=i<sIdx?'100%':i===sIdx?`${progress}%`:'0%';
        bar.appendChild(fill);prog.appendChild(bar);
      });
      ov.appendChild(prog);

      const hdr=UI.el('div','position:absolute;top:22px;left:0;right:0;z-index:2;padding:0 12px;display:flex;align-items:center;gap:8px');
      hdr.appendChild(UI.makeAvatar(S.users[curUser],36,{online:Chat.isOnline(S.presence,curUser)}));
      const info=UI.el('div','flex:1');const nm=UI.el('div','color:#fff;font-weight:700;font-size:14px');nm.textContent=curUser;const ts=UI.el('div','color:#aaa;font-size:11px');ts.textContent=UI.fmtFull(curStory.ts);info.appendChild(nm);info.appendChild(ts);hdr.appendChild(info);
      if(curUser===S.me){const delBtn=UI.el('button','background:rgba(239,68,68,.25);border:none;color:#ef4444;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:12px;font-family:inherit');delBtn.textContent='🗑 حذف';delBtn.addEventListener('click',async()=>{await Stories.deleteStory(S.me,curStory.sid);UI.toast('تم حذف القصة','info');ov.remove();});hdr.appendChild(delBtn);}
      const closeBtn=UI.el('button','background:rgba(255,255,255,.1);border:none;color:#fff;border-radius:50%;width:32px;height:32px;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center');closeBtn.textContent='✕';closeBtn.addEventListener('click',()=>{clearInterval(timer);ov.remove();});hdr.appendChild(closeBtn);ov.appendChild(hdr);
      const img=document.createElement('img');img.src=curStory.data;img.style.cssText='width:100%;height:100%;object-fit:contain';ov.appendChild(img);
      const zones=UI.el('div','position:absolute;inset:0;display:flex');
      const prevZ=UI.el('div','flex:1');const nextZ=UI.el('div','flex:1');
      prevZ.addEventListener('click',()=>{clearInterval(timer);progress=0;if(sIdx>0)sIdx--;else if(uIdx>0){uIdx--;sIdx=0;}renderSV();startTimer();});
      nextZ.addEventListener('click',()=>{clearInterval(timer);progress=0;const arr=Stories.getUserStories(allUsers[uIdx],S.stories);if(sIdx<arr.length-1)sIdx++;else if(uIdx<allUsers.length-1){uIdx++;sIdx=0;}else{ov.remove();return;}renderSV();startTimer();});
      zones.appendChild(prevZ);zones.appendChild(nextZ);ov.appendChild(zones);
    };

    const startTimer=()=>{
      clearInterval(timer);progress=0;const step=100/(5000/50);
      timer=setInterval(()=>{
        progress+=step;
        // ✅ Fix 3: use correct ID to find fill bar
        const fill=ov.querySelector(`#prog-fill-${sIdx}`);
        if(fill) fill.style.width=`${Math.min(progress,100)}%`;
        if(progress>=100){
          clearInterval(timer);const arr=Stories.getUserStories(allUsers[uIdx],S.stories);
          if(sIdx<arr.length-1)sIdx++;else if(uIdx<allUsers.length-1){uIdx++;sIdx=0;}else{ov.remove();return;}
          renderSV();startTimer();
        }
      },50);
    };
    renderSV();startTimer();APP.appendChild(ov);
  }

  function showCustomizeSheet(){
    const ex=document.getElementById('customize-sheet');if(ex){ex.remove();return;}
    const cid=chatId();
    const ov=UI.el('div','position:fixed;inset:0;z-index:990;display:flex;align-items:flex-end;justify-content:center');ov.id='customize-sheet';
    const bg=UI.el('div','position:absolute;inset:0;background:rgba(0,0,0,.6)');bg.addEventListener('click',()=>ov.remove());ov.appendChild(bg);
    const sheet=UI.el('div',`background:${th().card};width:100%;max-width:500px;border-radius:20px 20px 0 0;padding:24px;position:relative;z-index:1;animation:slideUp .25s ease`);
    const handle=UI.el('div',`width:40px;height:4px;background:${th().border};border-radius:2px;margin:0 auto 16px`);sheet.appendChild(handle);
    const title=UI.el('div',`font-weight:800;font-size:16px;margin-bottom:16px;color:${th().text}`);title.textContent='🎨 تخصيص الدردشة';sheet.appendChild(title);
    const bcLbl=UI.el('div',`font-size:12px;color:${th().text2};font-weight:700;margin-bottom:8px`);bcLbl.textContent='لون فقاعات رسائلك';sheet.appendChild(bcLbl);
    const bcRow=UI.el('div','display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px');const curBC=UI.getBubbleColors()[cid]||'';
    ['linear-gradient(135deg,#6366f1,#8b5cf6)','linear-gradient(135deg,#ec4899,#f43f5e)','linear-gradient(135deg,#f59e0b,#f97316)','linear-gradient(135deg,#10b981,#059669)','linear-gradient(135deg,#3b82f6,#2563eb)','linear-gradient(135deg,#8b5cf6,#7c3aed)','linear-gradient(135deg,#000,#374151)','linear-gradient(135deg,#ef4444,#dc2626)'].forEach(c=>{const sw=UI.el('div','width:36px;height:36px;border-radius:10px;cursor:pointer;transition:transform .15s');sw.style.background=c;sw.style.border=curBC===c?'3px solid #fff':'3px solid transparent';sw.style.boxShadow='0 2px 8px rgba(0,0,0,.2)';if(curBC===c)sw.style.transform='scale(1.1)';sw.addEventListener('click',()=>{UI.saveBubbleColor(cid,c);UI.toast('تم الحفظ','success');ov.remove();});bcRow.appendChild(sw);});sheet.appendChild(bcRow);
    const bgLbl=UI.el('div',`font-size:12px;color:${th().text2};font-weight:700;margin-bottom:8px`);bgLbl.textContent='خلفية المحادثة';sheet.appendChild(bgLbl);
    const bgRow=UI.el('div','display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px');const curBG=UI.getChatBgs()[cid]||'';
    [null,'#f0fdf4','#fdf2f8','#eff6ff','#fefce8','#f0f4ff','#fef9f0'].forEach(c=>{const sw=UI.el('div','width:36px;height:36px;border-radius:10px;cursor:pointer');sw.style.background=c||th().bg;sw.style.border=`3px solid ${(curBG||(c||''))===(c||'')?'#6366f1':th().border}`;sw.style.boxShadow='0 1px 4px rgba(0,0,0,.1)';if(!c){const ic=UI.el('span','display:flex;align-items:center;justify-content:center;height:100%;font-size:16px');ic.textContent='🚫';sw.appendChild(ic);}sw.addEventListener('click',()=>{UI.saveChatBg(cid,c||'');UI.toast('تم الحفظ','success');ov.remove();});bgRow.appendChild(sw);});
    const bgUpload=document.createElement('input');bgUpload.type='file';bgUpload.accept='image/*';bgUpload.style.display='none';bgUpload.addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;const d=await UI.fileToBase64(f);UI.saveChatBg(cid,d);UI.toast('تم الحفظ','success');ov.remove();e.target.value='';});
    const bgPhBtn=UI.el('button',`width:36px;height:36px;border-radius:10px;background:${th().card2};border:1px dashed ${th().border};cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center`);bgPhBtn.textContent='📷';bgPhBtn.addEventListener('click',()=>bgUpload.click());bgRow.appendChild(bgPhBtn);bgRow.appendChild(bgUpload);sheet.appendChild(bgRow);ov.appendChild(sheet);APP.appendChild(ov);
  }

  /* ══════════════════════════════════════════
     BOOT
  ══════════════════════════════════════════ */
  UI.applyTheme();

  // ✅ Fix 1: show app NOW (Firebase already initialized above)
  showApp();

  if (S.me) {
    Chat.goOnline(S.me);
    UI.requestNotifPerm();
    startDataListeners();
    go('home');
  } else {
    go('auth');
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.me) Chat.goOnline(S.me);
  });

})();
