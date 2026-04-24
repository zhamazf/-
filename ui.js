/**
 * js/ui.js
 * UI utilities: theme, sound, notifications, toast,
 * avatar builder, DOM helpers, formatters
 * ✅ Fix: showApp() / hideLoadingScreen() for app.js control
 * Exposes: window.UI
 */
window.UI = (function () {

  /* ═══════════════════════════════════════════════
     LOADING SCREEN CONTROL
     Called by app.js after FB.init() completes
  ═══════════════════════════════════════════════ */
  function showApp() {
    const ls  = document.getElementById('loading-screen');
    const app = document.getElementById('app');
    if (ls) {
      ls.classList.add('hide');
      setTimeout(() => { ls.style.display = 'none'; }, 350);
    }
    if (app) app.style.display = '';
  }

  /* ═══════════════════════════════════════════════
     THEME
  ═══════════════════════════════════════════════ */
  function _lsGet(k, fb) { try { const v = localStorage.getItem(k); return v != null ? JSON.parse(v) : fb; } catch { return fb; } }
  function _lsSet(k, v)  { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

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

    // Update loading screen title color to match theme
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
  ═══════════════════════════════════════════════ */
  let _ac = null;
  function _getAC() {
    if (!_ac) _ac = new (window.AudioContext || window.webkitAudioContext)();
    return _ac;
  }

  function playSound(type) {
    try {
      const c = _getAC();
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
  ═══════════════════════════════════════════════ */
  async function requestNotifPerm() {
    if ('Notification' in window && Notification.permission === 'default')
      await Notification.requestPermission();
  }

  function showNotif(title, body, onClick) {
    if ('Notification' in window &&
        Notification.permission === 'granted' &&
        document.visibilityState === 'hidden') {
      const n = new Notification(title, { body, icon: 'icon.png', badge: 'icon.png', tag: title });
      if (onClick) n.onclick = () => { window.focus(); n.close(); onClick(); };
    }
  }

  /* ═══════════════════════════════════════════════
     TOAST
  ═══════════════════════════════════════════════ */
  const TOAST_COLORS = { info: '#6366f1', success: '#22c55e', error: '#ef4444', warn: '#f59e0b' };

  function toast(msg, type = 'info', dur = 2800) {
    let host = document.getElementById('toast-host');
    if (!host) { host = document.createElement('div'); host.id = 'toast-host'; document.body.appendChild(host); }
    const el = document.createElement('div');
    el.className  = 'toast-item';
    el.style.background = TOAST_COLORS[type] || TOAST_COLORS.info;
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, dur);
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
      inner.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;display:block`;
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
    wrap.style.cssText = `position:relative;display:inline-flex;flex-shrink:0;${onClick ? 'cursor:pointer' : ''}`;
    if (onClick) wrap.addEventListener('click', onClick);
    wrap.appendChild(content);

    if (online) {
      const dot = document.createElement('div');
      const s   = Math.max(8, Math.round(size * 0.22));
      dot.dataset.ou      = user?.username || '';   // for presence refresh
      dot.style.cssText   =
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
    d.className   = 'spin';
    d.style.cssText =
      `width:${size}px;height:${size}px;` +
      `border:2px solid ${color};border-top-color:transparent;` +
      `border-radius:50%;margin:0 auto`;
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
  function saveChatBg(id, bg)    { const n={...getChatBgs(),[id]:bg};       _lsSet('chatBgs', n); }
  function saveBubbleColor(id,c) { const n={...getBubbleColors(),[id]:c};   _lsSet('bubbleColors', n); }

  return {
    showApp,
    isDark, setDark, toggleDark, getTheme, applyTheme,
    userColor,
    playSound, requestNotifPerm, showNotif,
    toast,
    makeAvatar,
    el, spinner, fileToBase64,
    fmt, fmtFull, preview,
    getChatBgs, getBubbleColors, saveChatBg, saveBubbleColor
  };

})();
