/**
 * auth.js
 * ─────────────────────────────────────────────────────────────────
 * Authentication via Firebase Auth (Email + Password)
 * Profile data stored in Realtime Database keyed by UID
 *
 * ── هيكل قاعدة البيانات الجديد ──────────────────────────────────
 *
 *  users/
 *    {uid}/
 *      uid, username, email, emoji, bio, photo, createdAt
 *
 *  usernames/
 *    {username} → uid          (للتحقق من التكرار + lookup سريع)
 *
 *  ❌ uidMap   → حُذف (مدمج في usernames الآن)
 *
 * ── ملاحظة على localStorage ──────────────────────────────────────
 *  نخزن فقط username (غير حساس) لأغراض UI.
 *  الجلسة الحقيقية يديرها Firebase Auth SDK تلقائياً في IndexedDB
 *  وهو أكثر أماناً من localStorage.
 *  لا نخزن email أو أي بيانات حساسة محلياً.
 *
 * Exposes: window.Auth
 * ─────────────────────────────────────────────────────────────────
 */
window.Auth = (function () {

  // نخزن فقط username للـ UI — الجلسة الحقيقية عند Firebase Auth SDK
  const SESSION_KEY = 'nbu';

  /* ── Session helpers ─────────────────────────────────────────── */
  function getUser()  { try { return localStorage.getItem(SESSION_KEY) || null; } catch { return null; } }

  // ❌ حُذف: getEmail() — لم نعد نخزن الإيميل محلياً لأسباب أمنية
  // الإيميل يُجلب من Firebase Auth مباشرة عند الحاجة:
  //   FB.authCurrentUser()?.email

  function saveSession(username) {
    try { localStorage.setItem(SESSION_KEY, username); } catch {}
  }
  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch {}
  }

  /* ── Firebase Auth error → Arabic ───────────────────────────── */
  function friendlyError(code) {
    const map = {
      // تسجيل
      'auth/email-already-in-use':       'البريد الإلكتروني مستخدم بالفعل',
      'auth/invalid-email':              'البريد الإلكتروني غير صحيح',
      'auth/weak-password':              'كلمة المرور قصيرة جداً (6 أحرف على الأقل)',
      'auth/operation-not-allowed':      'هذا النوع من تسجيل الدخول غير مفعّل',
      // دخول
      'auth/user-not-found':             'البريد الإلكتروني غير موجود',
      'auth/wrong-password':             'كلمة المرور خاطئة',
      'auth/invalid-credential':         'البريد أو كلمة المرور غير صحيحة',
      'auth/invalid-login-credentials':  'البريد أو كلمة المرور غير صحيحة',
      'auth/user-mismatch':              'بيانات المستخدم غير متطابقة',
      // قيود
      'auth/too-many-requests':          'محاولات كثيرة — انتظر قليلاً ثم حاول مجدداً',
      'auth/user-disabled':              'هذا الحساب موقوف، تواصل مع الدعم',
      'auth/account-exists-with-different-credential': 'البريد مرتبط بطريقة دخول مختلفة',
      // شبكة وأمان
      'auth/network-request-failed':     'تحقق من اتصالك بالإنترنت',
      'auth/requires-recent-login':      'يرجى تسجيل الخروج والدخول مجدداً قبل هذا الإجراء',
      'auth/credential-already-in-use':  'هذا البريد مرتبط بحساب آخر',
      'auth/popup-blocked':              'تم حظر النافذة المنبثقة، افتح الإعدادات وأتح النوافذ المنبثقة',
      'auth/popup-closed-by-user':       'أغلقت نافذة تسجيل الدخول قبل الاكتمال',
      'auth/timeout':                    'انتهت مدة الطلب — تحقق من الاتصال وحاول مجدداً',
      'auth/quota-exceeded':             'تجاوزت الحد المسموح، حاول لاحقاً',
      'auth/app-deleted':                'خطأ في إعداد التطبيق، تواصل مع الدعم',
      'auth/expired-action-code':        'رمز التحقق منتهي الصلاحية، اطلب رمزاً جديداً',
      'auth/invalid-action-code':        'رمز التحقق غير صالح أو مستخدم من قبل',
      'auth/missing-email':              'يرجى إدخال البريد الإلكتروني',
    };
    return map[code] || 'حدث خطأ غير متوقع، حاول مجدداً';
  }

  /* ── Register ────────────────────────────────────────────────── */
  async function register(username, email, password) {
    username = username.trim();
    email    = email.trim().toLowerCase();
    password = password.trim();

    if (!username)             return { error: 'أدخل اسم المستخدم' };
    if (username.length < 2)   return { error: 'الاسم قصير جداً (حرفان على الأقل)' };
    if (username.length > 20)  return { error: 'الاسم طويل جداً (20 حرفاً كحد أقصى)' };
    if (username.includes(' '))return { error: 'اسم المستخدم لا يحتوي على مسافات' };
    if (!/^[a-zA-Z0-9_\u0600-\u06FF]+$/.test(username))
                               return { error: 'الاسم يحتوي على رموز غير مسموحة' };
    if (!email)                return { error: 'أدخل بريدك الإلكتروني' };
    if (!password)             return { error: 'أدخل كلمة المرور' };

    // التحقق من عدم وجود username مسبقاً (keyed by username → uid)
    const existingUid = await FB.get(`usernames/${username}`);
    if (existingUid) return { error: 'اسم المستخدم محجوز، اختر اسماً آخر' };

    try {
      const cred = await FB.authRegister(email, password);
      const uid  = cred.user.uid;

      // ── البروفايل مُفتَّح بالـ uid (وليس username) ──
      await FB.set(`users/${uid}`, {
        uid,
        username,
        email,
        emoji:     '',
        bio:       '',
        photo:     null,
        createdAt: Date.now()
      });

      // ── index: username → uid (للبحث والتحقق من التكرار) ──
      await FB.set(`usernames/${username}`, uid);

      saveSession(username);
      return { ok: true, username, uid };

    } catch (e) {
      return { error: friendlyError(e.code) };
    }
  }

  /* ── Login ───────────────────────────────────────────────────── */
  async function login(email, password) {
    email    = email.trim().toLowerCase();
    password = password.trim();

    if (!email)    return { error: 'أدخل بريدك الإلكتروني' };
    if (!password) return { error: 'أدخل كلمة المرور' };

    try {
      const cred = await FB.authLogin(email, password);
      const uid  = cred.user.uid;

      // جلب البروفايل من users/{uid}
      const profile = await FB.get(`users/${uid}`);
      if (!profile) return { error: 'لم يُعثر على ملفك الشخصي، تواصل مع الدعم' };

      saveSession(profile.username);
      return { ok: true, username: profile.username, uid };

    } catch (e) {
      return { error: friendlyError(e.code) };
    }
  }

  /* ── Logout ──────────────────────────────────────────────────── */
  async function logout() {
    try { await FB.authSignOut(); } catch {}
    clearSession();
  }

  /* ── Change password ─────────────────────────────────────────── */
  async function changePassword(currentPassword, newPassword, confirmPassword) {
    if (!currentPassword || !newPassword || !confirmPassword)
      return { error: 'يرجى تعبئة جميع الحقول' };
    if (newPassword.length < 6)
      return { error: 'كلمة المرور الجديدة قصيرة (6 أحرف على الأقل)' };
    if (newPassword !== confirmPassword)
      return { error: 'كلمتا المرور غير متطابقتين' };
    if (newPassword === currentPassword)
      return { error: 'كلمة المرور الجديدة مطابقة للقديمة' };

    // نجلب الإيميل من Firebase Auth مباشرة (لا من localStorage)
    const email = FB.authCurrentUser()?.email;
    if (!email) return { error: 'يرجى تسجيل الخروج والدخول مجدداً' };

    try {
      await FB.authReauth(email, currentPassword);
      await FB.authUpdatePassword(newPassword);
      return { ok: true };
    } catch (e) {
      return { error: friendlyError(e.code) };
    }
  }

  /* ── Reset password ──────────────────────────────────────────── */
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

  /* ── Delete account ──────────────────────────────────────────── */
  /**
   * @param {string} username
   * @param {string} currentPassword  — لإعادة المصادقة
   * @param {object} allGroups        — { groupId: { id, members:{}, mods:{} } }
   * @param {Array}  dmPartners       — قائمة الـ uid الذين تحادث معهم (لحذف الرسائل الخاصة)
   */
  async function deleteAccount(username, currentPassword, allGroups, dmPartners = []) {
    const email = FB.authCurrentUser()?.email;
    if (!email) return { error: 'يرجى تسجيل الخروج والدخول مجدداً' };

    // إعادة المصادقة أولاً
    try {
      await FB.authReauth(email, currentPassword);
    } catch (e) {
      return { error: friendlyError(e.code) };
    }

    const uid = FB.authCurrentUser()?.uid;
    if (!uid) return { error: 'خطأ في التعرف على الحساب' };

    try {
      const deletes = [];

      // ── 1. البروفايل والبيانات الأساسية ──
      deletes.push(FB.del(`users/${uid}`));
      deletes.push(FB.del(`usernames/${username}`));
      deletes.push(FB.del(`presence/${uid}`));
      deletes.push(FB.del(`friendRequests/${uid}`));
      // مسارات قديمة (للتوافق إن وُجدت)
      deletes.push(FB.del(`presence/${username}`));
      deletes.push(FB.del(`friendRequests/${username}`));
      deletes.push(FB.del(`uidMap/${uid}`));

      // ── 2. الرسائل الخاصة (DM) ──
      // مسار الرسائل: messages/{dmKey} حيث dmKey = uid1_uid2 (مرتب أبجدياً)
      dmPartners.forEach(partnerUid => {
        const dmKey = [uid, partnerUid].sort().join('_');
        deletes.push(FB.del(`messages/${dmKey}`));
        // حذف إشعارات الطلبات بين الطرفين
        deletes.push(FB.del(`friends/${uid}/${partnerUid}`));
        deletes.push(FB.del(`friends/${partnerUid}/${uid}`));
      });

      // ── 3. رسائل المجموعات ──
      // نحذف رسائله فقط (لا المحادثة كلها) — نبحث في groupMsgs عن رسائله
      // ملاحظة: حذف الرسائل داخل المجموعة يحتاج Firebase Functions لدقة أكبر،
      // هنا نحذف عضويته فقط (الرسائل تبقى مجهولة المصدر للمجموعة)
      Object.values(allGroups || {}).forEach(g => {
        if (!g?.id) return;
        if (g.members?.[username]) deletes.push(FB.del(`groups/${g.id}/members/${username}`));
        if (g.mods?.[username])    deletes.push(FB.del(`groups/${g.id}/mods/${username}`));
        if (g.members?.[uid])      deletes.push(FB.del(`groups/${g.id}/members/${uid}`));
        if (g.mods?.[uid])         deletes.push(FB.del(`groups/${g.id}/mods/${uid}`));
      });

      // ننفذ كل الحذف بالتوازي
      await Promise.allSettled(deletes);

      // ── 4. حذف حساب Firebase Auth (الأخير دائماً) ──
      await FB.authDeleteUser();
      clearSession();
      return { ok: true };

    } catch (e) {
      return { error: friendlyError(e.code) };
    }
  }

  /* ── Get current user profile from DB ───────────────────────── */
  async function getProfile(uid) {
    if (!uid) uid = FB.authCurrentUser()?.uid;
    if (!uid) return null;
    return FB.get(`users/${uid}`);
  }

  /* ── Lookup uid from username ────────────────────────────────── */
  async function uidFromUsername(username) {
    return FB.get(`usernames/${username}`);
  }

  return {
    getUser,
    saveSession,
    clearSession,
    register,
    login,
    logout,
    changePassword,
    resetPassword,
    deleteAccount,
    getProfile,
    uidFromUsername,
    friendlyError   // مُصدَّر لاستخدامه في ملفات أخرى
  };

})();
