/**
 * auth.js
 * ─────────────────────────────────────────────
 * Authentication via Firebase Auth (Email + Password)
 * Profile data (username, bio, emoji, photo) stored in Realtime Database
 * Exposes: window.Auth
 */
window.Auth = (function () {

  const SESSION_KEY = 'nbu';       // stores username locally
  const EMAIL_KEY   = 'nbu_email'; // stores email locally

  /* ── Session helpers ─────────────────────────────────────── */
  function getUser()       { try { return localStorage.getItem(SESSION_KEY) || null; }  catch { return null; } }
  function getEmail()      { try { return localStorage.getItem(EMAIL_KEY)   || null; }  catch { return null; } }
  function saveSession(username, email) {
    try { localStorage.setItem(SESSION_KEY, username); localStorage.setItem(EMAIL_KEY, email); } catch {}
  }
  function clearSession()  {
    try { localStorage.removeItem(SESSION_KEY); localStorage.removeItem(EMAIL_KEY); } catch {}
  }

  /* ── Firebase Auth error → Arabic message ────────────────── */
  function friendlyError(code) {
    const map = {
      'auth/email-already-in-use':    'البريد الإلكتروني مستخدم بالفعل',
      'auth/invalid-email':           'البريد الإلكتروني غير صحيح',
      'auth/weak-password':           'كلمة المرور قصيرة جداً (6 أحرف على الأقل)',
      'auth/user-not-found':          'البريد الإلكتروني غير موجود',
      'auth/wrong-password':          'كلمة المرور خاطئة',
      'auth/invalid-credential':      'البريد أو كلمة المرور غير صحيحة',
      'auth/too-many-requests':       'محاولات كثيرة — انتظر قليلاً ثم حاول مجدداً',
      'auth/network-request-failed':  'تحقق من اتصالك بالإنترنت',
      'auth/requires-recent-login':   'يرجى تسجيل الخروج والدخول مجدداً قبل هذا الإجراء',
      'auth/user-disabled':           'هذا الحساب موقوف',
    };
    return map[code] || 'حدث خطأ، حاول مجدداً';
  }

  /* ── Register ────────────────────────────────────────────── */
  async function register(username, email, password) {
    username = username.trim();
    email    = email.trim().toLowerCase();
    password = password.trim();

    if (!username)           return { error: 'أدخل اسم المستخدم' };
    if (username.length < 2) return { error: 'الاسم قصير جداً (حرفان على الأقل)' };
    if (username.length > 20)return { error: 'الاسم طويل جداً (20 حرفاً كحد أقصى)' };
    if (username.includes(' ')) return { error: 'اسم المستخدم لا يحتوي على مسافات' };
    if (!email)              return { error: 'أدخل بريدك الإلكتروني' };
    if (!password)           return { error: 'أدخل كلمة المرور' };

    // Check username not already taken in DB
    const existing = await FB.get(`users/${username}`);
    if (existing)            return { error: 'اسم المستخدم محجوز، اختر اسماً آخر' };

    try {
      // Create Firebase Auth account
      const cred = await FB.authRegister(email, password);
      const uid  = cred.user.uid;

      // Save profile in Realtime Database (keyed by username)
      await FB.set(`users/${username}`, {
        username,
        email,
        uid,
        emoji:     '',
        bio:       '',
        photo:     null,
        createdAt: Date.now()
      });

      // Also map uid → username for quick lookup
      await FB.set(`uidMap/${uid}`, username);

      saveSession(username, email);
      return { ok: true, username };

    } catch (e) {
      return { error: friendlyError(e.code) };
    }
  }

  /* ── Login ───────────────────────────────────────────────── */
  async function login(email, password) {
    email    = email.trim().toLowerCase();
    password = password.trim();

    if (!email)    return { error: 'أدخل بريدك الإلكتروني' };
    if (!password) return { error: 'أدخل كلمة المرور' };

    try {
      const cred = await FB.authLogin(email, password);
      const uid  = cred.user.uid;

      // Get username from uidMap
      const username = await FB.get(`uidMap/${uid}`);
      if (!username) return { error: 'لم يُعثر على ملفك الشخصي، تواصل مع الدعم' };

      saveSession(username, email);
      return { ok: true, username };

    } catch (e) {
      return { error: friendlyError(e.code) };
    }
  }

  /* ── Logout ──────────────────────────────────────────────── */
  async function logout() {
    try { await FB.authSignOut(); } catch {}
    clearSession();
  }

  /* ── Change password ─────────────────────────────────────── */
  async function changePassword(currentPassword, newPassword, confirmPassword) {
    if (!currentPassword || !newPassword || !confirmPassword)
      return { error: 'يرجى تعبئة جميع الحقول' };
    if (newPassword.length < 6)
      return { error: 'كلمة المرور الجديدة قصيرة (6 أحرف على الأقل)' };
    if (newPassword !== confirmPassword)
      return { error: 'كلمتا المرور غير متطابقتين' };
    if (newPassword === currentPassword)
      return { error: 'كلمة المرور الجديدة مطابقة للقديمة' };

    const email = getEmail();
    if (!email) return { error: 'يرجى تسجيل الخروج والدخول مجدداً' };

    try {
      // Re-authenticate first (required by Firebase for security)
      await FB.authReauth(email, currentPassword);
      await FB.authUpdatePassword(newPassword);
      return { ok: true };
    } catch (e) {
      return { error: friendlyError(e.code) };
    }
  }

  /* ── Reset password (send email) ─────────────────────────── */
  async function resetPassword(email) {
    email = (email || '').trim().toLowerCase();
    if (!email) return { error: 'أدخل بريدك الإلكتروني' };
    try {
      await FB.authResetPassword(email);
      return { ok: true };
    } catch (e) {
      return { error: friendlyError(e.code) };
    }
  }

  /* ── Delete account ──────────────────────────────────────── */
  async function deleteAccount(username, email, currentPassword, allGroups) {
    try {
      // Re-authenticate first
      await FB.authReauth(email, currentPassword);
    } catch (e) {
      return { error: friendlyError(e.code) };
    }

    try {
      const uid = FB.authCurrentUser()?.uid;

      // Delete from Realtime Database
      await FB.del(`users/${username}`);
      await FB.del(`presence/${username}`);
      await FB.del(`friendRequests/${username}`);
      if (uid) await FB.del(`uidMap/${uid}`);

      // Remove from groups
      Object.values(allGroups || {}).forEach(g => {
        if (g.members && g.members[username]) FB.del(`groups/${g.id}/members/${username}`);
        if (g.mods    && g.mods[username])    FB.del(`groups/${g.id}/mods/${username}`);
      });

      // Delete Firebase Auth account
      await FB.authDeleteUser();
      clearSession();
      return { ok: true };
    } catch (e) {
      return { error: friendlyError(e.code) };
    }
  }

  return {
    getUser,
    getEmail,
    saveSession,
    clearSession,
    register,
    login,
    logout,
    changePassword,
    resetPassword,
    deleteAccount
  };

})();
