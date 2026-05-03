/**
 * js/ui.js
 * UI utilities: theme, sound, notifications, toast,
 * avatar builder, DOM helpers, formatters, loading indicators
 * Exposes: window.UI
 */
window.UI = (function () {

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
     TOAST
  ═══════════════════════════════════════════════ */
  const TOAST_COLORS = {
    info:    '#6366f1',
    success: '#22c55e',
    error:   '#ef4444',
    warn:    '#f59e0b'
  };

  function toast(msg, type = 'info', dur = 2800) {
    let host = document.getElementById('toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toast-host';
      document.body.appendChild(host);
    }
    const el2 = document.createElement('div');
    el2.className        = 'toast-item';
    el2.style.background = TOAST_COLORS[type] || TOAST_COLORS.info;
    el2.textContent      = msg; // ✅ textContent — XSS safe
    host.appendChild(el2);
    setTimeout(() => {
      el2.classList.add('out');
      setTimeout(() => el2.remove(), 300);
    }, dur);
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

  function fileToBase64(file) {
    return new Promise((res, rej) => {
      const r   = new FileReader();
      r.onload  = () => res(r.result);
      r.onerror = rej;
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
    if (m.type === 'text')  return m.text.length > 40 ? m.text.slice(0, 40) + '…' : m.text;
    if (m.type === 'image') return '🖼 صورة';
    if (m.type === 'video') return '🎥 فيديو';
    return '🎙 رسالة صوتية';
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

    // Toast
    toast,

    // Loading indicators ✅ new
    btnLoading,
    showOverlayLoader,

    // Avatar
    makeAvatar,

    // DOM helpers
    el,
    spinner,
    fileToBase64,
    setChildren,    // ✅ new — safe child replacement

    // Formatters
    fmt, fmtFull, preview,

    // Chat customization
    getChatBgs, getBubbleColors, saveChatBg, saveBubbleColor,
  };

})();
