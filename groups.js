/**
 * js/groups.js
 * Depends on: firebase.js (window.FB)
 * Exposes:    window.Groups
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
  const genId = () => Math.random().toString(36).slice(2, 10);

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
  async function create(me, name) {
    if (!name || !name.trim()) return { error: 'أدخل اسم المجموعة' };
    const uid = _myUid();
    if (!uid) return { error: 'يجب تسجيل الدخول أولاً' };

    const gid = genId();
    const inv = genId();

    await FB.set(`groups/${gid}`, {
      id: gid, name: name.trim(), admin: uid,
      adminUsername: me,              // للعرض فقط
      members:  { [uid]: true },
      mods:     {},
      pending:  {},
      inviteCode:   inv,
      inviteActive: true,
      photo:    null,
      createdAt: Date.now()
    });

    // ── index رمز الدعوة → gid (للبحث السريع) ──
    await FB.set(`inviteCodes/${inv}`, gid);

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
    const gid = await FB.get(`inviteCodes/${code}`);
    if (!gid) return { error: 'رمز الدعوة غير صالح أو منتهي' };

    const g = await _getGroup(gid);
    if (!g)                return { error: 'المجموعة غير موجودة' };
    if (!g.inviteActive)   return { error: 'رمز الدعوة منتهي' };
    if (g.members?.[uid])  return { ok: true, gid: g.id, already: true };

    // ✅ multi-path atomic update
    const updates = {};
    updates[`groups/${gid}/members/${uid}`]  = true;
    if (g.pending?.[uid])
      updates[`groups/${gid}/pending/${uid}`] = null; // حذف من pending

    await FB.upd('/', updates);
    return { ok: true, gid };
  }

  /* ── Request join ────────────────────────────────────────────── */
  async function requestJoin(me, gid) {
    gid = (gid || '').trim();
    if (!gid) return { error: 'أدخل معرّف المجموعة' };

    const uid = _myUid();
    if (!uid) return { error: 'يجب تسجيل الدخول أولاً' };

    const g = await _getGroup(gid);
    if (!g)               return { error: 'المعرّف غير موجود' };
    if (g.members?.[uid]) return { error: 'أنت بالفعل عضو في هذه المجموعة' };
    if (g.pending?.[uid]) return { error: 'طلبك قيد الانتظار' };

    await FB.upd(`groups/${gid}/pending`, { [uid]: true });
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
    return { ok: true };
  }

  /* ── Edit group name / photo ─────────────────────────────────── */
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

  /* ── Leave group ─────────────────────────────────────────────── */
  async function leaveGroup(gid) {
    const uid = _myUid();
    if (!uid) return { error: 'غير مصرح' };

    const g = await _getGroup(gid);
    if (!g) return { error: 'المجموعة غير موجودة' };

    if (isAdmin(g, uid)) return { error: 'الأدمن لا يمكنه المغادرة — احذف المجموعة أو انقل الملكية أولاً' };

    const updates = {};
    updates[`groups/${gid}/members/${uid}`] = null;
    updates[`groups/${gid}/mods/${uid}`]    = null;
    await FB.upd('/', updates);
    return { ok: true };
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
    create, joinByInvite, requestJoin,
    approve, reject, kick, toggleInvite,
    addMember, saveEdit, deleteGroup, toggleMod,
    leaveGroup,
    isAdmin, isMod, canManage,
    getMembers, getPending, getMods, myGroups
  };

})();
