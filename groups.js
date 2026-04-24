/**
 * js/groups.js
 * ✅ Fix: addMember checks existing membership
 * Depends on: firebase.js (window.FB)
 * Exposes:    window.Groups
 */
window.Groups = (function () {

  const uid = () => Math.random().toString(36).slice(2, 10);

  async function create(me, name) {
    if (!name || !name.trim()) return { error: 'أدخل اسم المجموعة' };
    const gid = uid(), inv = uid();
    await FB.set(`groups/${gid}`, {
      id: gid, name: name.trim(), admin: me,
      members: { [me]: true }, mods: {}, pending: {},
      inviteCode: inv, inviteActive: true, photo: null, createdAt: Date.now()
    });
    return { ok: true, gid };
  }

  async function joinByInvite(me, code) {
    code = (code || '').trim();
    if (!code) return { error: 'أدخل رمز الدعوة' };
    const all = await FB.get('groups');
    if (!all) return { error: 'لا توجد مجموعات' };
    const g = Object.values(all).find(g => g.inviteCode === code && g.inviteActive);
    if (!g) return { error: 'رمز الدعوة غير صالح أو منتهي' };
    if (g.members && g.members[me]) return { ok: true, gid: g.id, already: true };
    await FB.upd(`groups/${g.id}/members`, { [me]: true });
    if (g.pending && g.pending[me]) await FB.del(`groups/${g.id}/pending/${me}`);
    return { ok: true, gid: g.id };
  }

  async function requestJoin(me, gid) {
    gid = (gid || '').trim();
    if (!gid) return { error: 'أدخل معرّف المجموعة' };
    const g = await FB.get(`groups/${gid}`);
    if (!g)                         return { error: 'المعرّف غير موجود' };
    if (g.members && g.members[me]) return { error: 'أنت بالفعل عضو في هذه المجموعة' };
    if (g.pending && g.pending[me]) return { error: 'طلبك قيد الانتظار' };
    await FB.upd(`groups/${gid}/pending`, { [me]: true });
    return { ok: true };
  }

  function approve(gid, user) {
    FB.upd(`groups/${gid}/members`, { [user]: true });
    FB.del(`groups/${gid}/pending/${user}`);
  }

  function reject(gid, user)  { FB.del(`groups/${gid}/pending/${user}`); }

  function kick(gid, user) {
    FB.del(`groups/${gid}/members/${user}`);
    FB.del(`groups/${gid}/mods/${user}`);
  }

  function toggleInvite(gid, current) { FB.upd(`groups/${gid}`, { inviteActive: !current }); }

  async function addMember(gid, username, users) {
    if (!username || !username.trim()) return { error: 'أدخل اسم المستخدم' };
    username = username.trim();
    if (!users[username]) return { error: 'المستخدم غير موجود' };
    const group = await FB.get(`groups/${gid}`);
    if (!group) return { error: 'المجموعة غير موجودة' };
    if (group.members && group.members[username]) return { error: `${username} عضو في المجموعة بالفعل` };
    await FB.upd(`groups/${gid}/members`, { [username]: true });
    if (group.pending && group.pending[username]) await FB.del(`groups/${gid}/pending/${username}`);
    return { ok: true };
  }

  async function saveEdit(gid, newName, newPhoto) {
    const upd = {};
    if (newName && newName.trim()) upd.name  = newName.trim();
    if (newPhoto)                  upd.photo = newPhoto;
    if (Object.keys(upd).length)  await FB.upd(`groups/${gid}`, upd);
    return { ok: true };
  }

  async function deleteGroup(gid) {
    await FB.del(`groups/${gid}`);
    await FB.del(`groupMsgs/${gid}`);
    await FB.del(`typing/group/${gid}`);
    return { ok: true };
  }

  function toggleMod(gid, user, isMod) {
    if (isMod) FB.del(`groups/${gid}/mods/${user}`);
    else       FB.upd(`groups/${gid}/mods`, { [user]: true });
  }

  const isAdmin   = (g, me) => g?.admin === me;
  const isMod     = (g, me) => !!(g?.mods && g.mods[me]);
  const canManage = (g, me) => isAdmin(g, me) || isMod(g, me);
  const getMembers= g => g?.members ? Object.keys(g.members) : [];
  const getPending= g => g?.pending ? Object.keys(g.pending) : [];
  const getMods   = g => g?.mods    ? Object.keys(g.mods)    : [];
  function myGroups(groups, me) { return Object.values(groups||{}).filter(g=>g.members&&g.members[me]); }

  return {
    create, joinByInvite, requestJoin,
    approve, reject, kick, toggleInvite,
    addMember, saveEdit, deleteGroup, toggleMod,
    isAdmin, isMod, canManage,
    getMembers, getPending, getMods, myGroups
  };

})();
