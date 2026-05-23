/**
 * auth.js
 * ─────────────────────────────────────────────────────────────────
 * Authentication via Firebase Auth (Email + Password + Google)
 * Profile data stored in Realtime Database keyed by UID
 *
 * ── هيكل قاعدة البيانات ──────────────────────────────────────────
 *
 *  users/{uid}/  → uid, username, email, emoji, bio, photo, createdAt
 *  usernames/{username} → uid
 *  blockedUsers/{uid}/{blockedUid} → { blockedAt, reason }
 *  reports/{reportId} → { reporterUid, targetUid, reason, ts }
 *
 * v2 additions:
 * 1. loginWithGoogle()  → تسجيل الدخول بـ Google (Popup)
 * 2. updateEmail()      → تعديل الإيميل مع إعادة مصادقة
 * 3. blockUser()        → حظر مستخدم
 * 4. unblockUser()      → إلغاء الحظر
 * 5. getBlockedUsers()  → قائمة المحظورين
 * 6. isBlocked()        → فحص ما إذا كان مستخدم محظوراً
 * 7. reportUser()       → الإبلاغ عن مستخدم
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
    try {
      localStorage.setItem(SESSION_KEY, username);
      localStorage.setItem(SESSION_KEY + '_ts', Date.now().toString());
    } catch {}
  }
  function clearSession() {
    try {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(SESSION_KEY + '_ts');
    } catch {}
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

    // كلمات محظورة في أسماء المستخدمين
    const _banned = ['admin','administrator','support','system','nabda','root','moderator','mod','owner','staff','official'];
    if (_banned.includes(username.toLowerCase()))
      return { error: 'هذا الاسم محجوز، اختر اسماً آخر' };
    if (!email)                return { error: 'أدخل بريدك الإلكتروني' };
    if (!password)             return { error: 'أدخل كلمة المرور' };
    if (password.length < 8)   return { error: 'كلمة المرور قصيرة (8 أحرف على الأقل)' };
    if (!/[A-Za-z]/.test(password) && !/[\u0600-\u06FF]/.test(password))
                               return { error: 'كلمة المرور يجب أن تحتوي على حروف' };

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

  /* ── Brute force protection ─────────────────────────────────── */
  const _loginAttempts = new Map(); // email → {count, lockedUntil}
  const MAX_LOGIN_ATTEMPTS = 5;
  const LOCKOUT_MS = 5 * 60 * 1000; // 5 دقائق

  function _checkLoginThrottle(email) {
    const now  = Date.now();
    const info = _loginAttempts.get(email) || { count: 0, lockedUntil: 0 };
    if (now < info.lockedUntil) {
      const mins = Math.ceil((info.lockedUntil - now) / 60000);
      return { locked: true, error: `كثرة المحاولات — انتظر ${mins} دقيقة` };
    }
    return { locked: false, info };
  }

  function _recordFailedLogin(email) {
    const now  = Date.now();
    const info = _loginAttempts.get(email) || { count: 0, lockedUntil: 0 };
    info.count++;
    if (info.count >= MAX_LOGIN_ATTEMPTS) {
      info.lockedUntil = now + LOCKOUT_MS;
      info.count = 0;
    }
    _loginAttempts.set(email, info);
  }

  function _clearLoginAttempts(email) {
    _loginAttempts.delete(email);
  }

  /* ── Login ───────────────────────────────────────────────────── */
  async function login(email, password) {
    email    = email.trim().toLowerCase();
    password = password.trim();

    if (!email)    return { error: 'أدخل بريدك الإلكتروني' };
    if (!password) return { error: 'أدخل كلمة المرور' };

    // فحص brute force
    const throttle = _checkLoginThrottle(email);
    if (throttle.locked) return { error: throttle.error };

    try {
      const cred = await FB.authLogin(email, password);
      const uid  = cred.user.uid;

      // جلب البروفايل من users/{uid}
      const profile = await FB.get(`users/${uid}`);
      if (!profile) return { error: 'لم يُعثر على ملفك الشخصي، تواصل مع الدعم' };

      _clearLoginAttempts(email);
      saveSession(profile.username);
      return { ok: true, username: profile.username, uid };

    } catch (e) {
      _recordFailedLogin(email);
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
      // المسار الصحيح: dmMsgs/{uid1_uid2} (مرتب أبجدياً بالـ uid)
      dmPartners.forEach(partnerUid => {
        const dmKey = [uid, partnerUid].sort().join('_');
        deletes.push(FB.del(`dmMsgs/${dmKey}`));
        // حذف الصداقة في الاتجاهين
        deletes.push(FB.del(`users/${uid}/friends/${partnerUid}`));
        deletes.push(FB.del(`users/${partnerUid}/friends/${uid}`));
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

      // ── 4. حذف القصص ──
      deletes.push(FB.del(`stories/${uid}`));

      // ── 5. حذف group index من users/{uid}/groups ──
      deletes.push(FB.del(`users/${uid}/groups`));

      // ── 6. حذف readReceipts و typing ──
      deletes.push(FB.del(`typing/${uid}`));

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

  /* ═══════════════════════════════════════════════════════════════
     LOGIN WITH GOOGLE (v2)
     يستخدم Firebase Google Auth Provider عبر Popup
     إذا كان المستخدم جديداً يطلب منه اختيار username بعد ذلك
  ═══════════════════════════════════════════════════════════════ */
  async function loginWithGoogle() {
    try {
      // FB.authGoogleLogin يجب أن يكون مُعرَّفاً في firebase.js
      if (typeof FB.authGoogleLogin !== 'function') {
        return { error: 'تسجيل الدخول بـ Google غير مفعّل في هذه النسخة' };
      }
      const cred = await FB.authGoogleLogin();
      const user = cred.user;
      const uid  = user.uid;

      // هل المستخدم موجود مسبقاً؟
      const existing = await FB.get(`users/${uid}`);
      if (existing) {
        saveSession(existing.username);
        return { ok: true, username: existing.username, uid, isNew: false };
      }

      // مستخدم جديد — نُنشئ username من الـ displayName أو email
      let baseUsername = (user.displayName || user.email?.split('@')[0] || 'user')
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9_\u0600-\u06FF]/g, '')
        .slice(0, 20);
      if (!baseUsername || baseUsername.length < 2) baseUsername = 'user' + Date.now().toString().slice(-4);

      // تفادي التكرار بإضافة رقم
      let finalUsername = baseUsername;
      let attempt = 0;
      while (await FB.get(`usernames/${finalUsername}`)) {
        attempt++;
        finalUsername = `${baseUsername}${attempt}`;
      }

      await FB.set(`users/${uid}`, {
        uid,
        username:  finalUsername,
        email:     user.email || '',
        emoji:     '',
        bio:       '',
        photo:     user.photoURL || null,
        createdAt: Date.now(),
        provider:  'google',
      });
      await FB.set(`usernames/${finalUsername}`, uid);

      saveSession(finalUsername);
      return { ok: true, username: finalUsername, uid, isNew: true };

    } catch (e) {
      return { error: friendlyError(e.code) };
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     UPDATE EMAIL (v2)
     يحتاج إعادة مصادقة أولاً
  ═══════════════════════════════════════════════════════════════ */
  async function updateEmail(currentPassword, newEmail) {
    newEmail = (newEmail || '').trim().toLowerCase();
    if (!newEmail) return { error: 'أدخل البريد الإلكتروني الجديد' };
    if (!currentPassword) return { error: 'أدخل كلمة المرور الحالية للتأكيد' };

    const currentEmail = FB.authCurrentUser()?.email;
    if (!currentEmail) return { error: 'يرجى تسجيل الخروج والدخول مجدداً' };
    if (newEmail === currentEmail) return { error: 'البريد الجديد مطابق للقديم' };

    try {
      // إعادة مصادقة
      await FB.authReauth(currentEmail, currentPassword);
      // تحديث الإيميل في Firebase Auth
      await FB.authUpdateEmail(newEmail);
      // تحديث في قاعدة البيانات
      const uid = FB.authCurrentUser()?.uid;
      if (uid) await FB.upd(`users/${uid}`, { email: newEmail });
      return { ok: true };
    } catch (e) {
      return { error: friendlyError(e.code) };
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     BLOCK / UNBLOCK USER (v2)
     Path: blockedUsers/{myUid}/{targetUid} → { blockedAt, reason }
     يمنع الطرف المحظور من إرسال رسائل أو طلبات صداقة (يُطبَّق في app.js)
  ═══════════════════════════════════════════════════════════════ */
  async function blockUser(myUid, targetUid, reason = '') {
    if (!myUid || !targetUid)       return { error: 'missing_args' };
    if (myUid === targetUid)        return { error: 'لا يمكنك حظر نفسك' };
    try {
      await FB.set(`blockedUsers/${myUid}/${targetUid}`, {
        blockedAt: Date.now(),
        reason:    reason.slice(0, 100),
      });
      return { ok: true };
    } catch (e) { return { error: e.message }; }
  }

  async function unblockUser(myUid, targetUid) {
    if (!myUid || !targetUid) return { error: 'missing_args' };
    try {
      await FB.del(`blockedUsers/${myUid}/${targetUid}`);
      return { ok: true };
    } catch (e) { return { error: e.message }; }
  }

  async function getBlockedUsers(myUid) {
    if (!myUid) return {};
    try {
      return (await FB.get(`blockedUsers/${myUid}`)) || {};
    } catch { return {}; }
  }

  // يُستخدم في app.js قبل إرسال رسالة أو قبول طلب صداقة
  async function isBlocked(myUid, targetUid) {
    if (!myUid || !targetUid) return false;
    try {
      const val = await FB.get(`blockedUsers/${myUid}/${targetUid}`);
      return !!val;
    } catch { return false; }
  }

  /* ═══════════════════════════════════════════════════════════════
     REPORT USER (v2)
     Path: reports/{reportId} → { reporterUid, targetUid, reason, ts }
     يُنشئ تقرير في Firebase تقرأه الإدارة لاحقاً
  ═══════════════════════════════════════════════════════════════ */
  const REPORT_REASONS = [
    'محتوى مسيء',
    'تحرش أو تنمر',
    'محتوى جنسي',
    'انتحال شخصية',
    'بريد مزعج (Spam)',
    'أخرى',
  ];

  async function reportUser(reporterUid, targetUid, reason) {
    if (!reporterUid || !targetUid) return { error: 'missing_args' };
    if (reporterUid === targetUid)  return { error: 'لا يمكنك الإبلاغ عن نفسك' };
    if (!reason?.trim())            return { error: 'اختر سبب البلاغ' };

    try {
      await FB.push('reports', {
        reporterUid,
        targetUid,
        reason:  reason.trim().slice(0, 200),
        ts:      Date.now(),
        status:  'pending', // للمراجعة من الإدارة
      });
      return { ok: true };
    } catch (e) { return { error: e.message }; }
  }

  return {
    getUser,
    saveSession,
    clearSession,
    register,
    login,
    loginWithGoogle,    // v2
    logout,
    changePassword,
    updateEmail,        // v2
    resetPassword,
    deleteAccount,
    getProfile,
    uidFromUsername,
    blockUser,          // v2
    unblockUser,        // v2
    getBlockedUsers,    // v2
    isBlocked,          // v2
    reportUser,         // v2
    REPORT_REASONS,     // v2
    friendlyError,
  };

})();
