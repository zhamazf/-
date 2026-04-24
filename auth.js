/**
 * js/auth.js
 * Authentication, session, password management
 * ✅ Fix: SHA-256 hashing for passwords
 * Depends on: firebase.js (window.FB)
 * Exposes:    window.Auth
 */
window.Auth = (function () {

  const SESSION_KEY = 'nbu';

  /* ── Session ─────────────────────────────────────────────── */
  function getUser()    { try { return localStorage.getItem(SESSION_KEY) || null; }  catch { return null; } }
  function saveUser(u)  { try { localStorage.setItem(SESSION_KEY, u); }              catch {} }
  function clearUser()  { try { localStorage.removeItem(SESSION_KEY); }              catch {} }

  /* ── SHA-256 hash (Web Crypto API — available in all modern browsers) ── */
  async function hashPassword(password) {
    try {
      const encoder = new TextEncoder();
      const data    = encoder.encode(password + 'nabda_salt_2024');
      const hashBuf = await crypto.subtle.digest('SHA-256', data);
      const hashArr = Array.from(new Uint8Array(hashBuf));
      return hashArr.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {
      // Fallback: if crypto not available (very old browser), return as-is
      return password;
    }
  }

  /* ── Login ───────────────────────────────────────────────── */
  async function login(username, password) {
    username = username.trim();
    password = password.trim();
    if (!username || !password)  return { error: 'أدخل الاسم وكلمة المرور' };
    if (username.includes(' '))  return { error: 'اسم المستخدم لا يحتوي على مسافات' };

    const data = await FB.get(`users/${username}`);
    if (!data) return { error: 'المستخدم غير موجود' };

    const hashed = await hashPassword(password);

    // Support both hashed passwords (new) and plain text (migration)
    const match = data.password === hashed || data.password === password;
    if (!match) return { error: 'كلمة المرور خاطئة' };

    // Auto-migrate plain text to hashed on successful login
    if (data.password === password && data.password !== hashed) {
      await FB.upd(`users/${username}`, { password: hashed });
    }

    return { ok: true };
  }

  /* ── Register ────────────────────────────────────────────── */
  async function register(username, password) {
    username = username.trim();
    password = password.trim();
    if (!username || !password)   return { error: 'أدخل الاسم وكلمة المرور' };
    if (username.includes(' '))   return { error: 'اسم المستخدم لا يحتوي على مسافات' };
    if (username.length < 2)      return { error: 'الاسم قصير جداً (حرفان على الأقل)' };
    if (username.length > 20)     return { error: 'الاسم طويل جداً (20 حرفاً كحد أقصى)' };
    if (password.length < 4)      return { error: 'كلمة المرور قصيرة (4 أحرف على الأقل)' };

    const exists = await FB.get(`users/${username}`);
    if (exists) return { error: 'اسم المستخدم محجوز، اختر اسماً آخر' };

    const hashed = await hashPassword(password);
    await FB.set(`users/${username}`, {
      username,
      password: hashed,     // ✅ store hash, not plain text
      emoji:      '',
      bio:        '',
      photo:      null,
      createdAt:  Date.now()
    });
    return { ok: true };
  }

  /* ── Change password ─────────────────────────────────────── */
  async function changePassword(username, oldPwd, newPwd, confirmPwd) {
    oldPwd     = oldPwd.trim();
    newPwd     = newPwd.trim();
    confirmPwd = confirmPwd.trim();

    if (!oldPwd || !newPwd || !confirmPwd) return { error: 'يرجى تعبئة جميع الحقول' };
    if (newPwd.length < 4)      return { error: 'كلمة المرور الجديدة قصيرة (4 أحرف على الأقل)' };
    if (newPwd !== confirmPwd)  return { error: 'كلمتا المرور غير متطابقتين' };
    if (newPwd === oldPwd)      return { error: 'كلمة المرور الجديدة مطابقة للقديمة' };

    const data = await FB.get(`users/${username}`);
    if (!data) return { error: 'المستخدم غير موجود' };

    const oldHashed = await hashPassword(oldPwd);
    // Accept both hashed and plain (for migration)
    const match = data.password === oldHashed || data.password === oldPwd;
    if (!match) return { error: 'كلمة المرور الحالية غير صحيحة' };

    const newHashed = await hashPassword(newPwd);
    await FB.upd(`users/${username}`, { password: newHashed });
    return { ok: true };
  }

  /* ── Delete account ──────────────────────────────────────── */
  async function deleteAccount(username, allGroups) {
    await FB.del(`users/${username}`);
    await FB.del(`presence/${username}`);
    await FB.del(`friendRequests/${username}`);
    Object.values(allGroups || {}).forEach(g => {
      if (g.members && g.members[username]) FB.del(`groups/${g.id}/members/${username}`);
      if (g.mods    && g.mods[username])    FB.del(`groups/${g.id}/mods/${username}`);
    });
  }

  return { getUser, saveUser, clearUser, login, register, changePassword, deleteAccount, hashPassword };

})();
