/**
 * js/ui.js
 * UI utilities: theme, sound, notifications, toast,
 * avatar builder, DOM helpers, formatters, loading indicators
 * Exposes: window.UI
 *
 * v2 additions:
 * 1. hapticFeedback()     → اهتزاز خفيف على الموبايل (context menu / reactions)
 * 2. showBottomSheet()    → bottom sheet قابل للاستخدام العام
 * 3. preview()            → يدعم 'deleted', 'poll', 'reply'
 * 4. soundFor()           → صوت مخصص للمجموعات
 * 5. showSearchBar()      → helper لعرض/إخفاء search bar
 * 6. animateReaction()    → animation عند إضافة reaction
 * 7. CSS keyframes inject → fadeUp, slideUp, cooldown, spin
 */
window.UI = (function () {

  /* ═══════════════════════════════════════════════
     CSS KEYFRAMES INJECTION (v2)
     يضمن وجود الـ animations حتى لو style.css لم تُحمَّل بعد
  ═══════════════════════════════════════════════ */
  (function _injectKeyframes() {
    if (document.getElementById('_ui_keyframes')) return;
    const style = document.createElement('style');
    style.id = '_ui_keyframes';
    style.textContent = `
      @keyframes fadeUp    { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
      @keyframes slideUp   { from { transform:translateY(100%); } to { transform:none; } }
      @keyframes spin      { to   { transform:rotate(360deg); } }
      @keyframes cooldown  { from { width:100%; } to { width:0%; } }
      @keyframes rxPop     { 0%   { transform:scale(0); opacity:0; }
                              60%  { transform:scale(1.3); }
                              100% { transform:scale(1); opacity:1; } }
      @keyframes toastIn   { from { opacity:0; transform:translateX(20px); } to { opacity:1; transform:none; } }
      @keyframes toastOut  { to   { opacity:0; transform:translateX(20px); } }
      .spin { animation: spin 0.8s linear infinite; }
      .toast-item {
        padding: 9px 16px; border-radius: 12px; color: #fff;
        font-size: 13px; font-weight: 600; cursor: pointer;
        animation: toastIn .25s ease;
        box-shadow: 0 4px 14px rgba(0,0,0,.2);
        direction: rtl; max-width: 280px;
      }
      .toast-item.out { animation: toastOut .3s ease forwards; }
      #toast-host {
        position: fixed; bottom: 80px; left: 50%;
        transform: translateX(-50%);
        display: flex; flex-direction: column; gap: 6px;
        align-items: center; z-index: 99990; pointer-events: none;
      }
      #toast-host .toast-item { pointer-events: auto; }
      .tab {
        flex: 1; padding: 10px; border: none; background: none;
        cursor: pointer; font-family: inherit; font-size: 13px;
        font-weight: 600; border-bottom: 2px solid transparent;
        transition: color .15s, border-color .15s;
      }
      .ctx-menu-item:hover { background: var(--card2, #f3f4f6); }
      /* Reply bar slide-in */
      #reply-bar { animation: fadeUp .15s ease; }
      /* Pinned bar */
      #pinned-bar { animation: fadeUp .2s ease; }
      /* Reaction pop */
      .rx-pop { animation: rxPop .3s cubic-bezier(.34,1.56,.64,1) forwards; }
    `;
    document.head.appendChild(style);
  })();

  /* ═══════════════════════════════════════════════
     LOADING SCREEN CONTROL
     ✅ Single source of truth — no duplicate in app.js
  ═══════════════════════════════════════════════ */
  function showApp() {
    const ls  = document.getElementById('loading-screen');
    const app = document.getElementById('app');
    if (ls) {
      ls.classList.add('hide');
      setTimeout(() => { ls.style.display = 'none'; }, 400);
    }
    if (app) app.style.display = '';
  }

  /* ═══════════════════════════════════════════════
     THEME
  ═══════════════════════════════════════════════ */
  function _lsGet(k, fb) {
    try { const v = localStorage.getItem(k); return v != null ? JSON.parse(v) : fb; }
    catch { return fb; }
  }
  function _lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
  }

  let _dark = _lsGet('nabda_theme', window.matchMedia?.('(prefers-color-scheme:dark)').matches);

  function isDark()     { return _dark; }
  function setDark(v)   { _dark = v; _lsSet('nabda_theme', v); applyTheme(); }
  function toggleDark() { setDark(!_dark); }

  function getTheme() {
    const d = _dark;
    return {
      bg:        d ? '#0a0a14'  : '#f0f2f5',
      card:      d ? '#12121e'  : '#ffffff',
      card2:     d ? '#1a1a2a'  : '#f8f9fa',
      border:    d ? '#1e1e30'  : '#e5e7eb',
      text:      d ? '#e0e0f0'  : '#1f2937',
      text2:     d ? '#888'     : '#6b7280',
      text3:     d ? '#555'     : '#9ca3af',
      inp:       d ? '#1a1a2a'  : '#f3f4f6',
      inpBorder: d ? '#2a2a3e'  : '#d1d5db',
      bubble:    d ? '#1e1e2e'  : '#e5e7eb',
      topbar:    d ? '#12121e'  : '#ffffff',
      tabs:      d ? '#12121e'  : '#ffffff',
    };
  }

  function applyTheme() {
    const t    = getTheme();
    const root = document.documentElement;
    document.body.style.background = t.bg;
    document.body.style.color      = t.text;
    root.setAttribute('data-theme', _dark ? 'dark' : 'light');
    Object.entries(t).forEach(([k, v]) => root.style.setProperty(`--${k}`, v));
    const lsTitle = document.getElementById('ls-title');
    if (lsTitle) lsTitle.style.color = _dark ? '#a5b4fc' : '#6366f1';
  }

  /* ═══════════════════════════════════════════════
     USER COLOR
  ═══════════════════════════════════════════════ */
  const COLORS = ['#6366f1','#ec4899','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ef4444','#06b6d4'];
  function userColor(n) {
    return n ? COLORS[n.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length] : '#6366f1';
  }

  /* ═══════════════════════════════════════════════
     SOUND
     ✅ Deferred AudioContext creation until first user gesture
     ✅ Queues sounds if context is suspended (autoplay policy)
  ═══════════════════════════════════════════════ */
  let _ac   = null;
  let _ready = false; // true after first user interaction

  // Listen for first interaction to unlock AudioContext
  const _unlockAudio = () => {
    _ready = true;
    if (_ac && _ac.state === 'suspended') _ac.resume().catch(() => {});
  };
  ['click','touchstart','keydown'].forEach(ev =>
    document.addEventListener(ev, _unlockAudio, { once: true, passive: true })
  );

  function _getAC() {
    if (!_ac) _ac = new (window.AudioContext || window.webkitAudioContext)();
    return _ac;
  }

  function playSound(type) {
    // ✅ Skip silently if user hasn't interacted yet (autoplay policy)
    if (!_ready) return;
    try {
      const c = _getAC();
      // Resume if suspended (mobile browsers suspend after inactivity)
      if (c.state === 'suspended') { c.resume().then(() => playSound(type)).catch(() => {}); return; }

      const o = c.createOscillator();
      const g = c.createGain();
      o.connect(g); g.connect(c.destination);

      if (type === 'send') {
        o.frequency.setValueAtTime(880, c.currentTime);
        o.frequency.exponentialRampToValueAtTime(660, c.currentTime + 0.08);
        g.gain.setValueAtTime(0.18, c.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.08);
        o.start(); o.stop(c.currentTime + 0.08);
      } else if (type === 'recv') {
        o.type = 'sine';
        o.frequency.setValueAtTime(523, c.currentTime);
        o.frequency.setValueAtTime(659, c.currentTime + 0.1);
        g.gain.setValueAtTime(0.22, c.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.25);
        o.start(); o.stop(c.currentTime + 0.25);
      } else if (type === 'notif') {
        o.frequency.setValueAtTime(784, c.currentTime);
        g.gain.setValueAtTime(0.12, c.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.3);
        o.start(); o.stop(c.currentTime + 0.3);
      }
    } catch {}
  }

  /* ═══════════════════════════════════════════════
     HAPTIC FEEDBACK (v2)
     اهتزاز خفيف على الموبايل عند:
     - فتح context menu (pattern خفيف)
     - إضافة reaction (نبضة قصيرة)
     - إرسال رسالة (اهتزازة قصيرة)
  ═══════════════════════════════════════════════ */
  function hapticFeedback(type = 'light') {
    try {
      if (!navigator.vibrate) return;
      switch (type) {
        case 'light':   navigator.vibrate(10);        break;
        case 'medium':  navigator.vibrate(25);        break;
        case 'heavy':   navigator.vibrate(50);        break;
        case 'success': navigator.vibrate([10,50,10]); break;
        case 'error':   navigator.vibrate([30,20,30]); break;
        case 'menu':    navigator.vibrate(15);        break;
      }
    } catch {}
  }

  /* ═══════════════════════════════════════════════
     REACTION ANIMATION (v2)
     يُظهر emoji يطير من نقطة الضغط ثم يختفي
  ═══════════════════════════════════════════════ */
  function animateReaction(emoji, x, y) {
    try {
      const el2 = document.createElement('div');
      el2.textContent = emoji;
      el2.style.cssText =
        `position:fixed;left:${x}px;top:${y}px;font-size:28px;` +
        `z-index:99995;pointer-events:none;` +
        `animation:rxPop .3s cubic-bezier(.34,1.56,.64,1) forwards`;
      document.body.appendChild(el2);
      // طيران للأعلى ثم اختفاء
      el2.animate([
        { transform: 'translateY(0) scale(1)', opacity: 1 },
        { transform: 'translateY(-60px) scale(0.5)', opacity: 0 }
      ], { duration: 700, delay: 200, easing: 'ease-out', fill: 'forwards' })
        .onfinish = () => el2.remove();
    } catch {}
  }

  /* ═══════════════════════════════════════════════
     BOTTOM SHEET (v2)
     Helper عام لعرض bottom sheet
     opts: { title, content (DOM node), onClose }
  ═══════════════════════════════════════════════ */
  function showBottomSheet(opts = {}) {
    const { title = '', content = null, onClose = null } = opts;
    const ex = document.getElementById('_bottom_sheet'); if (ex) ex.remove();
    const t  = getTheme();
    const ov = document.createElement('div');
    ov.id = '_bottom_sheet';
    ov.style.cssText =
      'position:fixed;inset:0;z-index:990;display:flex;' +
      'align-items:flex-end;justify-content:center;background:rgba(0,0,0,.55)';
    const sheet = document.createElement('div');
    sheet.style.cssText =
      `background:${t.card};width:100%;max-width:500px;border-radius:20px 20px 0 0;` +
      `padding:20px;max-height:75vh;overflow-y:auto;animation:slideUp .25s ease`;
    // Handle bar
    const handle = document.createElement('div');
    handle.style.cssText =
      `width:40px;height:4px;background:${t.border};border-radius:2px;margin:0 auto 14px`;
    sheet.appendChild(handle);
    // Title
    if (title) {
      const h = document.createElement('div');
      h.style.cssText = `font-weight:800;font-size:16px;color:${t.text};margin-bottom:14px`;
      h.textContent = title;
      sheet.appendChild(h);
    }
    // Content
    if (content) sheet.appendChild(content);
    ov.addEventListener('click', e => {
      if (e.target === ov) { ov.remove(); if (onClose) onClose(); }
    });
    ov.appendChild(sheet);
    document.body.appendChild(ov);
    return {
      close: () => { ov.remove(); if (onClose) onClose(); },
      sheet,
    };
  }

  /* ═══════════════════════════════════════════════
     NOTIFICATIONS
     ✅ requestNotifPerm — deferred, called only after user action
        (app.js already calls it inside login/register handler)
  ═══════════════════════════════════════════════ */
  async function requestNotifPerm() {
    // Only request if not already decided and inside a user gesture
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'default') return;
    try {
      await Notification.requestPermission();
    } catch {}
  }

  function showNotif(title, body, onClick) {
    if ('Notification' in window &&
        Notification.permission === 'granted' &&
        document.visibilityState === 'hidden') {
      try {
        const n = new Notification(title, { body, icon: 'icon.png', badge: 'icon.png', tag: title });
        if (onClick) n.onclick = () => { window.focus(); n.close(); onClick(); };
      } catch {}
    }
  }

  /* ═══════════════════════════════════════════════
     CONNECTION STATUS INDICATOR
     يظهر شريطاً في أعلى الشاشة عند انقطاع الإنترنت
  ═══════════════════════════════════════════════ */
  let _connBanner = null;

  function showOfflineBanner() {
    if (_connBanner) return;
    _connBanner = document.createElement('div');
    _connBanner.id = '_conn_banner';
    _connBanner.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:99999;' +
      'background:#ef4444;color:#fff;text-align:center;' +
      'font-size:12px;font-weight:700;padding:6px;direction:rtl;' +
      'font-family:inherit;transition:all .3s';
    _connBanner.textContent = '⚠️ لا يوجد اتصال بالإنترنت';
    document.body.appendChild(_connBanner);
  }

  function hideOfflineBanner() {
    if (!_connBanner) return;
    _connBanner.style.background = '#22c55e';
    _connBanner.textContent = '✓ عاد الاتصال';
    setTimeout(() => {
      if (_connBanner) { _connBanner.remove(); _connBanner = null; }
    }, 2000);
  }

  function setConnectionStatus(isOnline) {
    if (isOnline) hideOfflineBanner();
    else showOfflineBanner();
  }

  /* ═══════════════════════════════════════════════
     TOAST
  ═══════════════════════════════════════════════ */
  const TOAST_COLORS = {
    info:    '#6366f1',
    success: '#22c55e',
    error:   '#ef4444',
    warn:    '#f59e0b'
  };

  const MAX_TOASTS = 3; // حد أقصى للـ toasts المتزامنة

  function toast(msg, type = 'info', dur = 2800) {
    let host = document.getElementById('toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toast-host';
      document.body.appendChild(host);
    }
    // احذف القديم إذا وصلنا للحد الأقصى
    const existing = host.querySelectorAll('.toast-item');
    if (existing.length >= MAX_TOASTS) {
      existing[0].remove();
    }
    const el2 = document.createElement('div');
    el2.className        = 'toast-item';
    el2.style.background = TOAST_COLORS[type] || TOAST_COLORS.info;
    el2.textContent      = msg;
    el2.style.cursor     = 'pointer';
    el2.title            = 'اضغط للإغلاق';
    el2.addEventListener('click', () => el2.remove());
    host.appendChild(el2);
    setTimeout(() => {
      el2.classList.add('out');
      setTimeout(() => el2.remove(), 300);
    }, dur);
  }

  /* ═══════════════════════════════════════════════
     CONFIRM DIALOG — أجمل من confirm() الافتراضي
  ═══════════════════════════════════════════════ */
  function confirmDialog(msg, opts = {}) {
    const { confirmText = 'تأكيد', cancelText = 'إلغاء', danger = false } = opts;
    return new Promise(resolve => {
      const t   = getTheme();
      const ov  = document.createElement('div');
      ov.style.cssText =
        'position:fixed;inset:0;z-index:99998;display:flex;' +
        'align-items:center;justify-content:center;' +
        `background:rgba(0,0,0,0.6);direction:rtl;padding:20px`;
      const box = document.createElement('div');
      box.style.cssText =
        `background:${t.card};border-radius:16px;padding:24px;` +
        `max-width:300px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.3)`;
      const txt = document.createElement('p');
      txt.style.cssText = `color:${t.text};font-size:14px;text-align:center;margin:0 0 20px`;
      txt.textContent = msg;
      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:10px';
      const cancelBtn = document.createElement('button');
      cancelBtn.style.cssText =
        `flex:1;padding:10px;border:1px solid ${t.border};border-radius:10px;` +
        `background:transparent;color:${t.text2};font-family:inherit;font-size:13px;cursor:pointer`;
      cancelBtn.textContent = cancelText;
      const confirmBtn = document.createElement('button');
      confirmBtn.style.cssText =
        `flex:1;padding:10px;border:none;border-radius:10px;` +
        `background:${danger?'#ef4444':'linear-gradient(135deg,#6366f1,#8b5cf6)'};` +
        `color:#fff;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer`;
      confirmBtn.textContent = confirmText;
      cancelBtn.addEventListener('click',  () => { ov.remove(); resolve(false); });
      confirmBtn.addEventListener('click', () => { ov.remove(); resolve(true);  });
      ov.addEventListener('click', e => { if (e.target===ov) { ov.remove(); resolve(false); } });
      btns.appendChild(cancelBtn); btns.appendChild(confirmBtn);
      box.appendChild(txt); box.appendChild(btns);
      ov.appendChild(box); document.body.appendChild(ov);
    });
  }

  /* ═══════════════════════════════════════════════
     LOADING INDICATORS
     ✅ Attached to any button — shows spinner, restores on done
  ═══════════════════════════════════════════════ */

  /**
   * Sets a button into loading state (spinner + disabled)
   * Returns a restore function to call when done
   *
   * Usage:
   *   const restore = UI.btnLoading(btn, 'جاري الحفظ...');
   *   await doWork();
   *   restore();
   */
  function btnLoading(btn, label = '...') {
    if (!btn) return () => {};
    const prev = btn.textContent;
    const prevDisabled = btn.disabled;
    btn.disabled = true;
    btn.style.opacity = '0.7';
    // Replace text with spinner + label
    while (btn.firstChild) btn.removeChild(btn.firstChild);
    const sp = spinner(14, '#fff');
    sp.style.display = 'inline-block';
    sp.style.marginLeft = '6px';
    sp.style.verticalAlign = 'middle';
    const lbl = document.createElement('span');
    lbl.textContent = label;
    btn.appendChild(lbl);
    btn.appendChild(sp);
    return () => {
      btn.disabled    = prevDisabled;
      btn.style.opacity = '1';
      btn.textContent = prev;
    };
  }

  /**
   * Full-screen overlay loader (for heavy ops like photo upload, account delete)
   * Returns a hide function
   *
   * Usage:
   *   const hide = UI.showOverlayLoader('جاري الرفع...');
   *   await upload();
   *   hide();
   */
  function showOverlayLoader(label = 'جاري التحميل...') {
    const ex = document.getElementById('_ui_overlay');
    if (ex) ex.remove();
    const t   = getTheme();
    const ov  = document.createElement('div');
    ov.id     = '_ui_overlay';
    ov.style.cssText =
      'position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;' +
      `align-items:center;justify-content:center;gap:14px;background:${t.card};opacity:.92`;
    const sp  = spinner(36, t.text2);
    sp.style.animation = 'spin 0.8s linear infinite';
    const tx  = document.createElement('div');
    tx.style.cssText   = `font-size:14px;color:${t.text2};font-weight:600`;
    tx.textContent     = label;
    ov.appendChild(sp); ov.appendChild(tx);
    document.body.appendChild(ov);
    return () => { ov.remove(); };
  }

  /* ═══════════════════════════════════════════════
     AVATAR
  ═══════════════════════════════════════════════ */
  function makeAvatar(user, size = 36, opts = {}) {
    const { online = false, ring = false, seen = false, onClick = null } = opts;
    const name  = user?.username || '?';
    const color = userColor(name);

    let inner;
    if (user?.photo) {
      inner         = document.createElement('img');
      inner.src     = user.photo;
      inner.alt     = name;
      inner.loading = 'lazy';
      inner.style.cssText =
        `width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;display:block`;
    } else {
      inner = document.createElement('div');
      inner.style.cssText =
        `width:${size}px;height:${size}px;border-radius:50%;` +
        `background:linear-gradient(135deg,${color}dd,${color}77);` +
        `display:flex;align-items:center;justify-content:center;` +
        `font-size:${user?.emoji ? size * 0.5 : size * 0.4}px;` +
        `font-weight:800;color:#fff;user-select:none;flex-shrink:0`;
      inner.textContent = user?.emoji || name[0]?.toUpperCase() || '?';
    }

    let content = inner;
    if (ring) {
      const ringEl = document.createElement('div');
      ringEl.style.cssText =
        `padding:2px;border-radius:50%;` +
        `border:2.5px solid ${seen ? '#aaa' : '#6366f1'};display:inline-flex`;
      ringEl.appendChild(inner);
      content = ringEl;
    }

    const wrap = document.createElement('div');
    wrap.style.cssText =
      `position:relative;display:inline-flex;flex-shrink:0;${onClick ? 'cursor:pointer' : ''}`;
    if (onClick) wrap.addEventListener('click', onClick);
    wrap.appendChild(content);

    if (online) {
      const dot = document.createElement('div');
      const s   = Math.max(8, Math.round(size * 0.22));
      dot.dataset.ou    = user?.uid || user?.username || '';
      dot.style.cssText =
        `position:absolute;bottom:1px;left:1px;` +
        `width:${s}px;height:${s}px;` +
        `background:#22c55e;border-radius:50%;border:2px solid white`;
      wrap.appendChild(dot);
    }

    return wrap;
  }

  /* ═══════════════════════════════════════════════
     DOM HELPERS
  ═══════════════════════════════════════════════ */
  function el(tag, css = '') {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    return e;
  }

  function spinner(size = 18, color = '#fff') {
    const d = el('div');
    d.className    = 'spin';
    d.style.cssText =
      `width:${size}px;height:${size}px;` +
      `border:2px solid ${color};border-top-color:transparent;` +
      `border-radius:50%;`;
    return d;
  }

  const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

  function fileToBase64(file, maxSize = MAX_FILE_SIZE) {
    return new Promise((res, rej) => {
      if (!file) return rej(new Error('no_file'));
      if (file.size > maxSize) {
        return rej(new Error(`الملف كبير جداً — الحد الأقصى ${Math.round(maxSize/1024/1024)}MB`));
      }
      if (!file.type.startsWith('image/') && !file.type.startsWith('video/') && !file.type.startsWith('audio/')) {
        return rej(new Error('نوع الملف غير مدعوم'));
      }
      const r   = new FileReader();
      r.onload  = () => res(r.result);
      r.onerror = () => rej(new Error('تعذّر قراءة الملف'));
      r.readAsDataURL(file);
    });
  }

  /**
   * ✅ Safe DOM update — replaces children without innerHTML
   * Avoids full re-render when only content changes
   *
   * Usage: UI.setChildren(container, [el1, el2, ...])
   */
  function setChildren(parent, children) {
    while (parent.firstChild) parent.removeChild(parent.firstChild);
    children.forEach(c => { if (c) parent.appendChild(c); });
  }

  /* ═══════════════════════════════════════════════
     FORMATTERS
  ═══════════════════════════════════════════════ */
  function fmt(ts) {
    return new Date(ts).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
  }

  function fmtFull(ts) {
    const d = new Date(ts), now = new Date(), diff = now - d;
    if (diff < 60000)    return 'الآن';
    if (diff < 3600000)  return `منذ ${Math.floor(diff / 60000)} د`;
    if (diff < 86400000) return fmt(ts);
    return d.toLocaleDateString('ar');
  }

  function preview(m) {
    if (!m) return null;
    if (m.deleted)          return '🚫 تم حذف الرسالة';           // v2
    if (m.type === 'text')  return m.text.length > 40 ? m.text.slice(0, 40) + '…' : m.text;
    if (m.type === 'image') return '🖼 صورة';
    if (m.type === 'video') return '🎥 فيديو';
    if (m.type === 'voice') return '🎙 رسالة صوتية';
    if (m.type === 'poll')  return '📊 استطلاع';                  // v2
    if (m.type === 'reply') return '↩️ رد على رسالة';             // v2
    return '📎 وسائط';
  }

  /* ═══════════════════════════════════════════════
     CHAT CUSTOMIZATION STORAGE
  ═══════════════════════════════════════════════ */
  function getChatBgs()          { return _lsGet('chatBgs', {}); }
  function getBubbleColors()     { return _lsGet('bubbleColors', {}); }
  function saveChatBg(id, bg)    { _lsSet('chatBgs',      { ...getChatBgs(),      [id]: bg }); }
  function saveBubbleColor(id,c) { _lsSet('bubbleColors', { ...getBubbleColors(), [id]: c  }); }

  /* ── Public API ─────────────────────────────── */
  return {
    // Loading
    showApp,

    // Theme
    isDark, setDark, toggleDark, getTheme, applyTheme,

    // Colors
    userColor,

    // Sound & notifications
    playSound,
    requestNotifPerm,
    showNotif,

    // Haptic (v2)
    hapticFeedback,

    // Toast
    toast,

    // Loading indicators
    btnLoading,
    showOverlayLoader,

    // Bottom sheet (v2)
    showBottomSheet,

    // Reaction animation (v2)
    animateReaction,

    // Avatar
    makeAvatar,

    // DOM helpers
    el,
    spinner,
    fileToBase64,
    setChildren,
    confirmDialog,
    setConnectionStatus,

    // Formatters
    fmt, fmtFull, preview,

    // Chat customization
    getChatBgs, getBubbleColors, saveChatBg, saveBubbleColor,
  };

})();
