/**
 * js/friends.js
 * Friend requests, acceptance, removal, block/unblock, suggestions
 * Depends on: firebase.js (window.FB)
 * Exposes:    window.Friends
 *
 * ── DB paths ────────────────────────────────────────────────
 *  friendRequests/{targetUid}/{senderUid} → { from, ts }
 *  users/{uid}/friends/{friendUid}        → true
 *  blocked/{uid}/{blockedUid}             → { ts } ✅ new
 * ────────────────────────────────────────────────────────────
 */
window.Friends = (function () {

  /* ── Helpers ─────────────────────────────────────────────── */
  // uid-based: users keyed by uid (auth.js هيكل جديد)
  function getFriendList(users, meUid) {
    if (!meUid || !users[meUid]) return [];
    return Object.keys(users[meUid]?.friends || {});
  }

  function getPendingRequests(friendReqs, meUid) {
    if (!meUid || !friendReqs[meUid]) return [];
    return Object.keys(friendReqs[meUid]);
  }

  /* ═══════════════════════════════════════════════════════════
     SEND FRIEND REQUEST
     ✅ فحص شامل: وجود المستخدم، حالة الحظر، الطلبات المعلقة
  ═══════════════════════════════════════════════════════════ */
  async function sendRequest(meUid, targetUid, users, myFriends) {
    if (!targetUid)                      return { error: 'أدخل اسم المستخدم' };
    if (!users[targetUid])               return { error: 'المستخدم غير موجود' };
    if (targetUid === meUid)             return { error: 'لا يمكنك إضافة نفسك' };
    if (myFriends.includes(targetUid))   return { error: 'أنتما أصدقاء بالفعل' };

    // ✅ فحص الحظر في الاتجاهين
    const [blockedByMe, blockedByThem] = await Promise.all([
      FB.get(`blocked/${meUid}/${targetUid}`),
      FB.get(`blocked/${targetUid}/${meUid}`),
    ]);
    if (blockedByMe)   return { error: 'لقد حظرت هذا المستخدم' };
    if (blockedByThem) return { error: 'لا يمكن إرسال طلب لهذا المستخدم' };

    // ✅ طلب موجود مسبقاً
    const existing = await FB.get(`friendRequests/${targetUid}/${meUid}`);
    if (existing) return { error: 'تم إرسال الطلب مسبقاً' };

    // ✅ الطرف الآخر أرسل طلباً بالفعل
    const reverseReq = await FB.get(`friendRequests/${meUid}/${targetUid}`);
    if (reverseReq) return { error: 'هذا المستخدم أرسل لك طلباً بالفعل، تحقق من طلباتك' };

    await FB.set(`friendRequests/${targetUid}/${meUid}`, {
      from: meUid,
      ts:   Date.now()
    });
    return { ok: true };
  }

  /* ═══════════════════════════════════════════════════════════
     ACCEPT REQUEST
     ✅ atomic multi-path update
  ═══════════════════════════════════════════════════════════ */
  async function acceptRequest(meUid, fromUid) {
    if (!fromUid) return { error: 'بيانات غير صحيحة' };

    // تحقق أن الطلب موجود فعلاً
    const req = await FB.get(`friendRequests/${meUid}/${fromUid}`);
    if (!req) return { error: 'الطلب غير موجود أو انتهت صلاحيته' };

    const updates = {};
    updates[`users/${meUid}/friends/${fromUid}`]     = true;
    updates[`users/${fromUid}/friends/${meUid}`]     = true;
    updates[`friendRequests/${meUid}/${fromUid}`]    = null; // حذف
    await FB.upd('/', updates);
    return { ok: true };
  }

  /* ═══════════════════════════════════════════════════════════
     REJECT REQUEST
  ═══════════════════════════════════════════════════════════ */
  async function rejectRequest(meUid, fromUid) {
    if (!fromUid) return { error: 'بيانات غير صحيحة' };
    await FB.del(`friendRequests/${meUid}/${fromUid}`);
    return { ok: true };
  }

  /* ═══════════════════════════════════════════════════════════
     REMOVE FRIEND
     ✅ تحقق مزدوج: من الـ DB مباشرة
     ✅ atomic multi-path update
  ═══════════════════════════════════════════════════════════ */
  async function removeFriend(meUid, friendUid) {
    if (!friendUid) return { error: 'بيانات غير صحيحة' };

    // ✅ تحقق أن العلاقة موجودة في الاتجاهين
    const [myList, theirList] = await Promise.all([
      FB.get(`users/${meUid}/friends/${friendUid}`),
      FB.get(`users/${friendUid}/friends/${meUid}`),
    ]);

    if (!myList && !theirList)
      return { error: 'هذا المستخدم ليس في قائمة أصدقائك' };

    // ✅ atomic: يحذف الطرفين في عملية واحدة
    const updates = {};
    updates[`users/${meUid}/friends/${friendUid}`]   = null;
    updates[`users/${friendUid}/friends/${meUid}`]   = null;
    await FB.upd('/', updates);
    return { ok: true };
  }

  /* ═══════════════════════════════════════════════════════════
     BLOCK / UNBLOCK ✅ new
     مسار: blocked/{uid}/{blockedUid} → { ts }
  ═══════════════════════════════════════════════════════════ */
  async function blockUser(meUid, targetUid) {
    if (!targetUid || targetUid === meUid) return { error: 'بيانات غير صحيحة' };

    // إذا كانوا أصدقاء → احذف الصداقة أولاً
    const updates = {};
    updates[`blocked/${meUid}/${targetUid}`]          = { ts: Date.now() };
    updates[`users/${meUid}/friends/${targetUid}`]    = null;
    updates[`users/${targetUid}/friends/${meUid}`]    = null;
    updates[`friendRequests/${meUid}/${targetUid}`]   = null;
    updates[`friendRequests/${targetUid}/${meUid}`]   = null;
    await FB.upd('/', updates);
    return { ok: true };
  }

  async function unblockUser(meUid, targetUid) {
    if (!targetUid) return { error: 'بيانات غير صحيحة' };
    // تحقق أن الحظر موجود
    const blocked = await FB.get(`blocked/${meUid}/${targetUid}`);
    if (!blocked) return { error: 'هذا المستخدم غير محظور' };
    await FB.del(`blocked/${meUid}/${targetUid}`);
    return { ok: true };
  }

  async function isBlocked(meUid, targetUid) {
    if (!meUid || !targetUid) return false;
    const [a, b] = await Promise.all([
      FB.get(`blocked/${meUid}/${targetUid}`),
      FB.get(`blocked/${targetUid}/${meUid}`),
    ]);
    return !!(a || b);
  }

  async function getBlockedList(meUid) {
    if (!meUid) return [];
    const data = await FB.get(`blocked/${meUid}`);
    return data ? Object.keys(data) : [];
  }

  /* ═══════════════════════════════════════════════════════════
     FRIEND SUGGESTIONS ✅ new
     منطق بسيط: "أصدقاء أصدقائك" الذين لست صديقاً لهم بعد
     يُعيد قائمة uid مرتبة بعدد الأصدقاء المشتركين (تنازلياً)
  ═══════════════════════════════════════════════════════════ */
  async function getSuggestions(meUid, users, myFriendUids, limit = 8) {
    if (!meUid || !myFriendUids.length) return [];

    const meSet      = new Set([meUid, ...myFriendUids]);
    const mutualCount = {};  // uid → عدد الأصدقاء المشتركين

    // لكل صديق → اجلب أصدقاءه
    await Promise.all(
      myFriendUids.map(async fUid => {
        const theirFriends = await FB.get(`users/${fUid}/friends`);
        if (!theirFriends) return;
        Object.keys(theirFriends).forEach(uid => {
          if (meSet.has(uid)) return;          // تجاهل نفسك وأصدقائك
          if (!users[uid]) return;             // تجاهل مستخدمين محذوفين
          mutualCount[uid] = (mutualCount[uid] || 0) + 1;
        });
      })
    );

    // فلترة المحظورين
    const blockedList = await getBlockedList(meUid);
    const blockedSet  = new Set(blockedList);

    return Object.entries(mutualCount)
      .filter(([uid]) => !blockedSet.has(uid))
      .sort((a, b) => b[1] - a[1])   // ترتيب تنازلي بعدد الأصدقاء المشتركين
      .slice(0, limit)
      .map(([uid, mutual]) => ({ uid, mutual, user: users[uid] }));
  }

  /**
   * بحث سريع عن مستخدم بالاسم
   * يُعيد قائمة من users تحتوي على النص المُدخل
   * @param {string}  query
   * @param {object}  users   — S.users (uid-keyed)
   * @param {string}  meUid
   * @param {number}  limit
   */
  function searchUsers(query, users, meUid, limit = 10) {
    if (!query || !query.trim()) return [];
    const q = query.trim().toLowerCase();
    return Object.entries(users)
      .filter(([uid, u]) =>
        uid !== meUid &&
        u?.username?.toLowerCase().includes(q)
      )
      .slice(0, limit)
      .map(([uid, u]) => ({ uid, ...u }));
  }

  /* ── Public API ──────────────────────────────────────────── */
  return {
    // Core
    getFriendList,
    getPendingRequests,
    sendRequest,
    acceptRequest,
    rejectRequest,
    removeFriend,

    // Block / unblock ✅ new
    blockUser,
    unblockUser,
    isBlocked,
    getBlockedList,

    // Discovery ✅ new
    getSuggestions,
    searchUsers,
  };

})();
