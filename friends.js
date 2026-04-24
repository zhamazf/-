/**
 * js/friends.js
 * Friend requests, acceptance, removal
 * ✅ Fix: validate before removeFriend + sendRequest
 * Depends on: firebase.js (window.FB)
 * Exposes:    window.Friends
 */
window.Friends = (function () {

  function getFriendList(users, me) {
    return me && users[me] ? Object.keys(users[me]?.friends || {}) : [];
  }

  function getPendingRequests(friendReqs, me) {
    return me && friendReqs[me] ? Object.keys(friendReqs[me]) : [];
  }

  /* ── Send friend request ─────────────────────────────────── */
  async function sendRequest(me, target, users, myFriends) {
    if (!target)                   return { error: 'أدخل اسم المستخدم' };
    if (!users[target])            return { error: 'المستخدم غير موجود' };
    if (target === me)             return { error: 'لا يمكنك إضافة نفسك' };
    if (myFriends.includes(target)) return { error: 'أنتما أصدقاء بالفعل' };

    // ✅ Check if request already sent
    const existing = await FB.get(`friendRequests/${target}/${me}`);
    if (existing) return { error: 'تم إرسال الطلب مسبقاً' };

    // ✅ Check if the other person already sent us a request
    const reverseReq = await FB.get(`friendRequests/${me}/${target}`);
    if (reverseReq) return { error: `${target} أرسل لك طلباً بالفعل، تحقق من طلباتك` };

    await FB.set(`friendRequests/${target}/${me}`, { from: me, ts: Date.now() });
    return { ok: true };
  }

  /* ── Accept ──────────────────────────────────────────────── */
  async function acceptRequest(me, from) {
    if (!from) return { error: 'بيانات غير صحيحة' };
    await FB.upd(`users/${me}/friends`,   { [from]: true });
    await FB.upd(`users/${from}/friends`, { [me]: true });
    await FB.del(`friendRequests/${me}/${from}`);
    return { ok: true };
  }

  /* ── Reject ──────────────────────────────────────────────── */
  async function rejectRequest(me, from) {
    if (!from) return { error: 'بيانات غير صحيحة' };
    await FB.del(`friendRequests/${me}/${from}`);
    return { ok: true };
  }

  /* ── Remove friend ───────────────────────────────────────── */
  async function removeFriend(me, friend) {
    if (!friend) return { error: 'بيانات غير صحيحة' };

    // ✅ Validate friendship exists before deleting
    const myFriendsList = await FB.get(`users/${me}/friends`);
    if (!myFriendsList || !myFriendsList[friend]) {
      return { error: 'هذا المستخدم ليس في قائمة أصدقائك' };
    }

    await FB.del(`users/${me}/friends/${friend}`);
    await FB.del(`users/${friend}/friends/${me}`);
    return { ok: true };
  }

  return {
    getFriendList,
    getPendingRequests,
    sendRequest,
    acceptRequest,
    rejectRequest,
    removeFriend
  };

})();
