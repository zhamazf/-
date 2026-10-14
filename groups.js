/**
 * js/groups.js
 * Depends on: firebase.js (window.FB)
 * Exposes:    window.Groups
 *
 * v2 additions:
 * 1. create() → يدعم description اختياري
 * 2. notifyMember() → إشعار للعضو عند الإضافة
 * 3. muteGroup() / unmuteGroup() / isGroupMuted() → كتم المجموعة
 * 4. getInviteLink() → رابط دعوة كامل قابل للمشاركة
 * 5. createPoll() / vote() / getPoll() / listenPoll() → استطلاعات
 *
 * ─── Security Rules المطلوبة في Firebase Console ────────────────
 *
 * "groups": {
 *   "$gid": {
 *     ".read": "auth !== null && (
 *       data.child('members').child(auth.uid).exists() ||
 *       data.child('admin').val() === auth.uid
 *     )",
 *     ".write": "auth !== null && (
 *       !data.exists() ||
 *       data.child('admin').val() === auth.uid ||
 *       data.child('mods').child(auth.uid).exists()
 *     )",
 *     "members": {
 *       "$uid": {
 *         ".write": "auth !== null && (
 *           $uid === auth.uid ||
 *           root.child('groups').child($gid).child('admin').val() === auth.uid ||
 *           root.child('groups').child($gid).child('mods').child(auth.uid).exists()
 *         )"
 *       }
 *     }
 *   }
 * },
 * "groupMsgs": {
 *   "$gid": {
 *     ".read": "auth !== null && root.child('groups').child($gid).child('members').child(auth.uid).exists()",
 *     ".write": "auth !== null && root.child('groups').child($gid).child('members').child(auth.uid).exists()"
 *   }
 * }
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * ── ملاحظة على addMember ────────────────────────────────────────
 * الدوال التي تعمل بـ username كمفتاح (addMember) تحتاج
 * Auth.uidFromUsername() للتحويل إلى uid عند تطبيق هيكل users/{uid}.
 * راجع التعليق داخل addMember.
 * ─────────────────────────────────────────────────────────────────
 */
window.Groups = (function () {

  /* ── ID generator ────────────────────────────────────────────── */
  // رموز الدعوة/المعرّفات: عشوائية آمنة (crypto) بدل Math.random القابل للتنبؤ
  const genId = () => {
    try {
      const a = new Uint32Array(2);
      crypto.getRandomValues(a);
      return (a[0].toString(36).padStart(7, '0') + a[1].toString(36).padStart(7, '0')).slice(0, 10);
    } catch {
      return Math.random().toString(36).slice(2, 10);
    }
  };
  const MAX_MEMBERS    = 200;  // حد أقصى لأعضاء المجموعة
  const MAX_NAME_LEN   = 40;   // حد أقصى لاسم المجموعة

  /* ── Helper: جلب المجموعة مع فحص الوجود ─────────────────────── */
  async function _getGroup(gid) {
    const g = await FB.get(`groups/${gid}`);
    return g || null;
  }

  /* ── Helper: التحقق من هوية المستخدم الحالي ─────────────────── */
  function _myUid() {
    return FB.authCurrentUser()?.uid || null;
  }

  /* ── Create ──────────────────────────────────────────────────── */
  const PRIVACY = ['public', 'private'];
  const MAX_PHOTO_LEN = 400 * 1024; // حرف dataURL (~300KB صورة)

  // opts: نص (وصف — توافق قديم) أو { description, photo, privacy }
  async function create(me, name, opts = {}) {
    if (typeof opts === 'string') opts = { description: opts };
    opts = opts || {};
    if (!name || !name.trim()) return { error: 'أدخل اسم المجموعة' };
    if (name.trim().length > MAX_NAME_LEN) return { error: `اسم المجموعة طويل جداً (${MAX_NAME_LEN} حرفاً كحد أقصى)` };
    const uid = _myUid();
    if (!uid) return { error: 'يجب تسجيل الدخول أولاً' };

    const privacy = PRIVACY.includes(opts.privacy) ? opts.privacy : 'private';
    let photo = null;
    if (opts.photo) {
      if (typeof opts.photo !== 'string' || !/^data:image\//.test(opts.photo)) return { error: 'صورة غير صالحة' };
      if (opts.photo.length > MAX_PHOTO_LEN) return { error: 'الصورة كبيرة جداً' };
      photo = opts.photo;
    }

    const gid = genId();
    const inv = genId();

    try {
      await FB.set(`groups/${gid}`, {
        id: gid, name: name.trim(), admin: uid,
        adminUsername: me,
        description:  (opts.description || '').trim().slice(0, 200),
        members:  { [uid]: true },
        mods:     {},
        pending:  {},
        inviteCode:   inv,
        inviteActive: true,
        privacy,
        photo,
        createdAt: Date.now()
      });
      await FB.set(`inviteCodes/${inv}`, gid);
      await FB.set(`users/${uid}/groups/${gid}`, true);
    } catch (e) {
      return { error: 'تعذّر إنشاء المجموعة، حاول مجدداً' };
    }

    return { ok: true, gid };
  }

  /* ── Join public group directly by ID ───────────────────────── */
  // المجموعات العامة: القواعد تسمح بالانضمام الذاتي (members/{uid} = true) إذا privacy === 'public'.
  // إن لم تكن عامة تفشل الكتابة فنرجع { needsRequest: true } ليُرسل طلب انضمام.
  async function joinPublic(me, gid) {
    gid = (gid || '').trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(gid)) return { error: 'معرّف غير صالح' };
    const uid = _myUid();
    if (!uid) return { error: 'يجب تسجيل الدخول أولاً' };
    try {
      await FB.set(`groups/${gid}/members/${uid}`, true);
    } catch (e) {
      return { needsRequest: true };
    }
    try { await FB.del(`groups/${gid}/pending/${uid}`); } catch (e) {}
    try { await FB.set(`users/${uid}/groups/${gid}`, true); } catch (e) {}
    return { ok: true, gid };
  }

  /* ── Join by invite ──────────────────────────────────────────── */
  // ✅ بدل تحميل كل المجموعات، نبحث مباشرة عبر index
  async function joinByInvite(me, code) {
    code = (code || '').trim();
    if (!code) return { error: 'أدخل رمز الدعوة' };

    const uid = _myUid();
    if (!uid) return { error: 'يجب تسجيل الدخول أولاً' };

    // ✅ بحث O(1) بدل تحميل كل المجموعات
    // رمز الدعوة نفسه هو "الإثبات": قواعد Firebase تسمح بالانضمام الذاتي فقط
    // إذا كانت القيمة المكتوبة تساوي رمز الدعوة الحالي والدعوة مفعّلة.
    // (غير الأعضاء لا يستطيعون قراءة المجموعة، لذلك لا نقرأها قبل الانضمام.)
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) return { error: 'رمز الدعوة غير صالح أو منتهي' };

    const gid = await FB.get(`inviteCodes/${code}`);
    if (!gid || typeof gid !== 'string') return { error: 'رمز الدعوة غير صالح أو منتهي' };

    try {
      await FB.set(`groups/${gid}/members/${uid}`, code);
    } catch (e) {
      // مرفوض: إما الدعوة معطّلة/مجدّدة، أو أنت عضو بالفعل برمز قديم
      const g = await _getGroup(gid); // تنجح القراءة للأعضاء فقط
      if (g?.members?.[uid]) return { ok: true, gid, already: true };
      return { error: 'رمز الدعوة غير صالح أو منتهي' };
    }

    // تنظيف طلب الانضمام المعلّق إن وُجد (اختياري — لا نفشل بسببه)
    try { await FB.del(`groups/${gid}/pending/${uid}`); } catch {}

    await FB.set(`users/${uid}/groups/${gid}`, true);
    return { ok: true, gid };
  }

  /* ── Request join ────────────────────────────────────────────── */
  async function requestJoin(me, gid) {
    gid = (gid || '').trim();
    if (!gid) return { error: 'أدخل معرّف المجموعة' };

    const uid = _myUid();
    if (!uid) return { error: 'يجب تسجيل الدخول أولاً' };

    // غير الأعضاء لا يقرؤون المجموعة (قواعد Firebase) → القراءة تنجح للأعضاء فقط
    const g = await _getGroup(gid);
    if (g?.members?.[uid]) return { error: 'أنت بالفعل عضو في هذه المجموعة' };
    if (g?.pending?.[uid]) return { error: 'طلبك قيد الانتظار' };

    // القواعد ترفض الكتابة إذا المجموعة غير موجودة
    try {
      await FB.set(`groups/${gid}/pending/${uid}`, true);
    } catch (e) {
      return { error: 'المعرّف غير موجود' };
    }
    return { ok: true };
  }

  /* ── Approve join request ────────────────────────────────────── */
  async function approve(gid, targetUid, me) {
    const uid = _myUid();
    if (!uid) return { error: 'غير مصرح' };

    const g = await _getGroup(gid);
    if (!g) return { error: 'المجموعة غير موجودة' };

    // ✅ فحص الصلاحيات: أدمن أو مود فقط
    if (!canManage(g, uid)) return { error: 'ليس لديك صلاحية قبول الطلبات' };

    // ✅ atomic update
    const updates = {};
    updates[`groups/${gid}/members/${targetUid}`] = true;
    updates[`groups/${gid}/pending/${targetUid}`] = null;
    await FB.upd('/', updates);
    await FB.set(`users/${targetUid}/groups/${gid}`, true);
    await notifyMember(targetUid, gid, g.name, uid);
    return { ok: true };
  }

  /* ── Reject join request ─────────────────────────────────────── */
  async function reject(gid, targetUid) {
    const uid = _myUid();
    if (!uid) return { error: 'غير مصرح' };

    const g = await _getGroup(gid);
    if (!g) return { error: 'المجموعة غير موجودة' };

    // ✅ فحص الصلاحيات
    if (!canManage(g, uid)) return { error: 'ليس لديك صلاحية رفض الطلبات' };

    await FB.del(`groups/${gid}/pending/${targetUid}`);
    return { ok: true };
  }

  /* ── Kick member ─────────────────────────────────────────────── */
  async function kick(gid, targetUid) {
    const uid = _myUid();
    if (!uid) return { error: 'غير مصرح' };

    const g = await _getGroup(gid);
    if (!g) return { error: 'المجموعة غير موجودة' };

    // ✅ فحص: أدمن أو مود، والمود لا يستطيع طرد الأدمن
    if (!canManage(g, uid))         return { error: 'ليس لديك صلاحية طرد الأعضاء' };
    if (isMod(g, uid) && isAdmin(g, targetUid))
                                    return { error: 'المود لا يستطيع طرد الأدمن' };
    if (targetUid === uid)          return { error: 'لا يمكنك طرد نفسك' };

    // ✅ atomic: حذف من members و mods معاً
    const updates = {};
    updates[`groups/${gid}/members/${targetUid}`] = null;
    updates[`groups/${gid}/mods/${targetUid}`]    = null;
    await FB.upd('/', updates);
    // احذف group index من المطرود
    await FB.del(`users/${targetUid}/groups/${gid}`);
    return { ok: true };
  }

  /* ── Toggle invite link ──────────────────────────────────────── */
  async function toggleInvite(gid, current) {
    const uid = _myUid();
    if (!uid) return { error: 'غير مصرح' };

    const g = await _getGroup(gid);
    if (!g) return { error: 'المجموعة غير موجودة' };

    // ✅ أدمن فقط يتحكم في رابط الدعوة
    if (!isAdmin(g, uid)) return { error: 'الأدمن فقط يمكنه تعطيل/تفعيل الدعوة' };

    await FB.upd(`groups/${gid}`, { inviteActive: !current });
    return { ok: true };
  }

  /* ── Add member by username ──────────────────────────────────── */
  // ⚠️ يستخدم Auth.uidFromUsername() للتحويل إذا كان الهيكل uid-based
  async function addMember(gid, username) {
    if (!username || !username.trim()) return { error: 'أدخل اسم المستخدم' };
    username = username.trim();

    const uid = _myUid();
    if (!uid) return { error: 'غير مصرح' };

    const g = await _getGroup(gid);
    if (!g) return { error: 'المجموعة غير موجودة' };

    // ✅ فحص الصلاحيات
    if (!canManage(g, uid)) return { error: 'ليس لديك صلاحية إضافة أعضاء' };

    // تحويل username → uid (من هيكل auth.js الجديد)
    const targetUid = await Auth.uidFromUsername(username);
    if (!targetUid) return { error: 'المستخدم غير موجود' };

    if (g.members?.[targetUid]) return { error: `${username} عضو في المجموعة بالفعل` };

    // ✅ atomic update
    const updates = {};
    updates[`groups/${gid}/members/${targetUid}`] = true;
    if (g.pending?.[targetUid])
      updates[`groups/${gid}/pending/${targetUid}`] = null;

    await FB.upd('/', updates);
    // أضف group index للعضو الجديد
    await FB.set(`users/${targetUid}/groups/${gid}`, true);
    await notifyMember(targetUid, gid, g.name, uid);
    return { ok: true };
  }

  /* ── Edit group name / photo ─────────────────────────────────── */
  async function setPrivacy(gid, privacy) {
    const uid = _myUid();
    if (!uid) return { error: 'غير مصرح' };
    if (!PRIVACY.includes(privacy)) return { error: 'قيمة غير صالحة' };
    const g = await _getGroup(gid);
    if (!g) return { error: 'المجموعة غير موجودة' };
    if (!isAdmin(g, uid)) return { error: 'الأدمن فقط يغيّر نوع المجموعة' };
    try { await FB.set(`groups/${gid}/privacy`, privacy); } catch (e) { return { error: 'تعذّر الحفظ' }; }
    return { ok: true };
  }

  async function saveEdit(gid, newName, newPhoto) {
    const uid = _myUid();
    if (!uid) return { error: 'غير مصرح' };

    const g = await _getGroup(gid);
    if (!g) return { error: 'المجموعة غير موجودة' };

    // ✅ فحص: أدمن أو مود فقط
    if (!canManage(g, uid)) return { error: 'ليس لديك صلاحية تعديل المجموعة' };

    const upd = {};
    if (newName && newName.trim()) upd.name  = newName.trim();
    if (newPhoto)                  upd.photo = newPhoto;
    if (!Object.keys(upd).length)  return { error: 'لا يوجد تغيير' };

    await FB.upd(`groups/${gid}`, upd);
    return { ok: true };
  }

  /* ── Delete group ────────────────────────────────────────────── */
  async function deleteGroup(gid) {
    const uid = _myUid();
    if (!uid) return { error: 'غير مصرح' };

    const g = await _getGroup(gid);
    if (!g) return { error: 'المجموعة غير موجودة' };

    // ✅ الأدمن فقط يحذف المجموعة
    if (!isAdmin(g, uid)) return { error: 'الأدمن فقط يمكنه حذف المجموعة' };

    // احذف group index من جميع الأعضاء أولاً: قاعدة الكتابة على users/{uid}/groups/{gid}
    // تتحقق من أن الكاتب أدمن المجموعة، وهذا يفشل بعد حذف المجموعة نفسها.
    const memberUids = Object.keys(g.members || {});
    await Promise.allSettled(
      memberUids.map(mUid => FB.del(`users/${mUid}/groups/${gid}`))
    );

    // ✅ atomic multi-path: حذف المجموعة + رسائلها + typing + inviteCode index
    const updates = {};
    updates[`groups/${gid}`]          = null;
    updates[`groupMsgs/${gid}`]       = null;
    updates[`typing/group/${gid}`]    = null;
    if (g.inviteCode)
      updates[`inviteCodes/${g.inviteCode}`] = null;

    await FB.upd('/', updates);
    return { ok: true };
  }

  /* ── Toggle mod ──────────────────────────────────────────────── */
  async function toggleMod(gid, targetUid, isMod) {
    const uid = _myUid();
    if (!uid) return { error: 'غير مصرح' };

    const g = await _getGroup(gid);
    if (!g) return { error: 'المجموعة غير موجودة' };

    // ✅ الأدمن فقط يعين/يزيل المودريتور
    if (!isAdmin(g, uid))     return { error: 'الأدمن فقط يمكنه تعيين المودريتور' };
    if (targetUid === uid)    return { error: 'لا يمكنك تعيين نفسك كمود' };

    if (isMod) await FB.del(`groups/${gid}/mods/${targetUid}`);
    else        await FB.upd(`groups/${gid}/mods`, { [targetUid]: true });
    return { ok: true };
  }

  /* ── Transfer admin ─────────────────────────────────────────────── */
  async function transferAdmin(gid, newAdminUid) {
    const uid = _myUid();
    if (!uid) return { error: 'غير مصرح' };
    const g = await _getGroup(gid);
    if (!g)                        return { error: 'المجموعة غير موجودة' };
    if (!isAdmin(g, uid))          return { error: 'الأدمن فقط يمكنه نقل الملكية' };
    if (newAdminUid === uid)        return { error: 'أنت الأدمن بالفعل' };
    if (!g.members?.[newAdminUid]) return { error: 'العضو غير موجود في المجموعة' };

    const updates = {};
    updates[`groups/${gid}/admin`]               = newAdminUid;
    updates[`groups/${gid}/mods/${uid}`]         = null;
    updates[`groups/${gid}/mods/${newAdminUid}`] = null;
    await FB.upd('/', updates);
    return { ok: true };
  }

  /* ── Reset invite code ───────────────────────────────────────── */
  async function resetInviteCode(gid) {
    const uid = _myUid();
    if (!uid) return { error: 'غير مصرح' };
    const g = await _getGroup(gid);
    if (!g)               return { error: 'المجموعة غير موجودة' };
    if (!isAdmin(g, uid)) return { error: 'الأدمن فقط يمكنه تجديد رمز الدعوة' };

    const newInv = genId();
    const updates = {};
    if (g.inviteCode) updates[`inviteCodes/${g.inviteCode}`] = null;
    updates[`inviteCodes/${newInv}`]      = gid;
    updates[`groups/${gid}/inviteCode`]   = newInv;
    updates[`groups/${gid}/inviteActive`] = true;
    await FB.upd('/', updates);
    return { ok: true, newCode: newInv };
  }

  /* ── Leave group ─────────────────────────────────────────────── */
  async function leaveGroup(gid) {
    const uid = _myUid();
    if (!uid) return { error: 'غير مصرح' };

    const g = await _getGroup(gid);
    if (!g) return { error: 'المجموعة غير موجودة' };

    if (isAdmin(g, uid)) return { error: 'الأدمن لا يمكنه المغادرة — انقل الملكية أولاً أو احذف المجموعة', code: 'admin_must_transfer' };

    const updates = {};
    updates[`groups/${gid}/members/${uid}`] = null;
    updates[`groups/${gid}/mods/${uid}`]    = null;
    await FB.upd('/', updates);
    await FB.del(`users/${uid}/groups/${gid}`);
    return { ok: true };
  }

  /* ═══════════════════════════════════════════════════════════
     NOTIFY MEMBER — إشعار العضو عند إضافته للمجموعة (v2)
     Path: notifications/{targetUid}/{notifId} → { type, gid, gname, byUid, ts }
     app.js يقرأ هذا الـ path ويعرض إشعاراً للمستخدم
  ═══════════════════════════════════════════════════════════ */
  async function notifyMember(targetUid, gid, gname, byUid) {
    if (!targetUid || !gid || !byUid) return;
    try {
      await FB.push(`notifications/${targetUid}`, {
        type:  'group_add',
        gid,
        gname: gname || '',
        byUid,
        ts:    Date.now(),
        read:  false,
      });
    } catch {}
  }

  /* ═══════════════════════════════════════════════════════════
     MUTE GROUP — كتم إشعارات المجموعة (v2)
     Path: users/{uid}/mutedGroups/{gid} → expireTs | true
     expireTs: وقت انتهاء الكتم (0 = للأبد)
  ═══════════════════════════════════════════════════════════ */
  async function muteGroup(gid, durationMs = 0) {
    // durationMs: 0 = للأبد، أو مثلاً 8*3600*1000 لـ 8 ساعات
    const uid = _myUid();
    if (!uid || !gid) return { error: 'missing_args' };
    const val = durationMs > 0 ? Date.now() + durationMs : true;
    try {
      await FB.set(`users/${uid}/mutedGroups/${gid}`, val);
      return { ok: true };
    } catch (err) { return { error: err.message }; }
  }

  async function unmuteGroup(gid) {
    const uid = _myUid();
    if (!uid || !gid) return { error: 'missing_args' };
    try {
      await FB.del(`users/${uid}/mutedGroups/${gid}`);
      return { ok: true };
    } catch (err) { return { error: err.message }; }
  }

  // يُستخدم في app.js قبل عرض الإشعار
  function isGroupMuted(mutedGroups, gid) {
    const val = mutedGroups?.[gid];
    if (!val) return false;
    if (val === true) return true;          // مكتوم للأبد
    return Date.now() < val;               // مكتوم مؤقتاً
  }

  /* ═══════════════════════════════════════════════════════════
     INVITE LINK — رابط دعوة كامل قابل للمشاركة (v2)
     مثال: https://nabda.app/join/abc12345
     يمكن تعديل BASE_URL حسب دومين التطبيق
  ═══════════════════════════════════════════════════════════ */
  const BASE_URL = window.location.origin; // تلقائي من الدومين الحالي

  function getInviteLink(g) {
    if (!g?.inviteCode || !g?.inviteActive) return null;
    return `${BASE_URL}/?join=${g.inviteCode}`;
  }

  async function shareInviteLink(g) {
    const link = getInviteLink(g);
    if (!link) return { error: 'رمز الدعوة غير نشط' };

    const shareData = {
      title: `انضم لمجموعة ${g.name}`,
      text:  `انضم إلى مجموعة "${g.name}" في تطبيق نبضة`,
      url:   link,
    };

    if (navigator.share) {
      try { await navigator.share(shareData); return { ok: true, shared: true }; }
      catch {}
    }
    // Fallback: نسخ للحافظة
    try {
      await navigator.clipboard.writeText(link);
      return { ok: true, copied: true };
    } catch {
      return { ok: true, link }; // app.js يعرضه للمستخدم يدوياً
    }
  }

  /* ═══════════════════════════════════════════════════════════
     POLLS — استطلاعات في المجموعات (v2)
     Path: groupPolls/{gid}/{pollId} → { question, options[], votes/{uid: optionIndex}, createdBy, ts, closed }
     - كل عضو يصوت مرة واحدة فقط
     - الأدمن/مود يستطيع إغلاق الاستطلاع
  ═══════════════════════════════════════════════════════════ */
  const MAX_POLL_OPTIONS = 6;
  const MAX_POLL_Q_LEN   = 200;

  async function createPoll(gid, question, options) {
    const uid = _myUid();
    if (!uid) return { error: 'يجب تسجيل الدخول أولاً' };
    if (!gid)                          return { error: 'missing gid' };
    if (!question?.trim())             return { error: 'أدخل سؤال الاستطلاع' };
    if (question.length > MAX_POLL_Q_LEN) return { error: 'السؤال طويل جداً' };
    if (!Array.isArray(options) || options.length < 2)
                                       return { error: 'أدخل خيارين على الأقل' };
    if (options.length > MAX_POLL_OPTIONS)
                                       return { error: `الحد الأقصى ${MAX_POLL_OPTIONS} خيارات` };

    const cleaned = options.map(o => (o || '').trim()).filter(Boolean);
    if (cleaned.length < 2)            return { error: 'خيارات غير صالحة' };

    // فحص: هل العضو في المجموعة؟
    const g = await _getGroup(gid);
    if (!g?.members?.[uid]) return { error: 'لست عضواً في المجموعة' };

    try {
      const ref = await FB.push(`groupPolls/${gid}`, {
        question: question.trim(),
        options:  cleaned,
        votes:    {},
        createdBy: uid,
        ts:       Date.now(),
        closed:   false,
      });

      // أرسل رسالة في المجموعة تشير للاستطلاع
      await FB.push(`groupMsgs/${gid}`, {
        sender: uid,
        ts:     Date.now(),
        type:   'poll',
        pollId: ref.key || ref.id || ref,
        text:   `📊 ${question.trim()}`,
      });

      return { ok: true, pollId: ref.key || ref.id || ref };
    } catch (err) {
      return { error: err.message };
    }
  }

  async function vote(gid, pollId, myUid, optionIndex) {
    if (!gid || !pollId || !myUid || optionIndex === undefined)
      return { error: 'missing_args' };

    try {
      const poll = await FB.get(`groupPolls/${gid}/${pollId}`);
      if (!poll)         return { error: 'الاستطلاع غير موجود' };
      if (poll.closed)   return { error: 'الاستطلاع مغلق' };
      if (optionIndex < 0 || optionIndex >= poll.options.length)
                         return { error: 'خيار غير صالح' };

      // كل مستخدم يصوت مرة واحدة (يمكنه تغيير صوته)
      await FB.set(`groupPolls/${gid}/${pollId}/votes/${myUid}`, optionIndex);
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  }

  async function closePoll(gid, pollId) {
    const uid = _myUid();
    if (!uid) return { error: 'غير مصرح' };
    const g = await _getGroup(gid);
    if (!g)                  return { error: 'المجموعة غير موجودة' };
    if (!canManage(g, uid))  return { error: 'ليس لديك صلاحية إغلاق الاستطلاع' };
    try {
      await FB.upd(`groupPolls/${gid}/${pollId}`, { closed: true, closedAt: Date.now() });
      return { ok: true };
    } catch (err) { return { error: err.message }; }
  }

  async function getPoll(gid, pollId) {
    if (!gid || !pollId) return null;
    try { return await FB.get(`groupPolls/${gid}/${pollId}`); }
    catch { return null; }
  }

  function listenPoll(gid, pollId, cb) {
    return FB.on(`groupPolls/${gid}/${pollId}`, data => cb(data || null));
  }

  // تحويل بيانات الاستطلاع إلى نتائج قابلة للعرض
  function parsePollResults(poll) {
    if (!poll?.options) return [];
    const votes = Object.values(poll.votes || {});
    return poll.options.map((opt, i) => ({
      index:   i,
      text:    opt,
      count:   votes.filter(v => v === i).length,
      percent: votes.length ? Math.round(votes.filter(v => v === i).length / votes.length * 100) : 0,
    }));
  }

  /* ── Helpers (read-only) ─────────────────────────────────────── */
  const isAdmin    = (g, uid) => g?.admin === uid;
  const isMod      = (g, uid) => !!(g?.mods?.[uid]);
  const canManage  = (g, uid) => isAdmin(g, uid) || isMod(g, uid);
  const getMembers = g => g?.members ? Object.keys(g.members) : [];
  const getPending = g => g?.pending ? Object.keys(g.pending) : [];
  const getMods    = g => g?.mods    ? Object.keys(g.mods)    : [];

  function myGroups(groups, uid) {
    return Object.values(groups || {}).filter(g => g.members?.[uid]);
  }

  return {
    // Core
    create, joinByInvite, requestJoin,
    approve, reject, kick, toggleInvite,
    addMember, saveEdit, deleteGroup, toggleMod,
    joinPublic, setPrivacy,
    leaveGroup, transferAdmin, resetInviteCode,

    // v2: Notify
    notifyMember,

    // v2: Mute
    muteGroup, unmuteGroup, isGroupMuted,

    // v2: Invite link
    getInviteLink, shareInviteLink,

    // v2: Polls
    createPoll, vote, closePoll,
    getPoll, listenPoll, parsePollResults,

    // Helpers
    isAdmin, isMod, canManage,
    getMembers, getPending, getMods, myGroups
  };

})();
