/**
 * js/stories.js
 * Stories: post, delete, seen tracking, auto-cleanup
 * Privacy: only friends see others' stories
 * Depends on: firebase.js (window.FB)
 * Exposes:    window.Stories
 */
window.Stories = (function () {

  const LS_SEEN = 'ns';
  function _lsGet(k, fb) { try { const v = localStorage.getItem(k); return v != null ? JSON.parse(v) : fb; } catch { return fb; } }
  function _lsSet(k, v)  { try { localStorage.setItem(k, JSON.stringify(v)); }  catch {} }

  async function post(me, dataUrl) {
    if (!dataUrl) return;
    await FB.push(`stories/${me}`, { data: dataUrl, ts: Date.now(), type: 'image' });
    return { ok: true };
  }

  async function deleteStory(me, sid) {
    if (!sid) return { error: 'معرّف القصة غير موجود' };
    await FB.del(`stories/${me}/${sid}`);
    return { ok: true };
  }

  function markSeen(user) {
    const s = _lsGet(LS_SEEN, {});
    s[user] = Date.now();
    _lsSet(LS_SEEN, s);
  }

  function isSeen(user, stories) {
    try {
      const s    = _lsGet(LS_SEEN, {});
      const last = s[user] || 0;
      const us   = stories[user];
      if (!us || !Object.keys(us).length) return true;
      const newest = Math.max(...Object.values(us).map(x => x.ts));
      return last > newest;
    } catch { return false; }
  }

  function cleanExpired(stories) {
    const now = Date.now();
    Object.entries(stories || {}).forEach(([user, userStories]) => {
      if (!userStories) return;
      Object.entries(userStories).forEach(([sid, s]) => {
        if (now - s.ts > 86400000) FB.del(`stories/${user}/${sid}`);
      });
    });
  }

  function getUserStories(user, stories) {
    const us = stories[user];
    if (!us) return [];
    return Object.entries(us)
      .map(([sid, s]) => ({ sid, ...s }))
      .sort((a, b) => b.ts - a.ts);
  }

  function usersWithStories(stories, me) {
    return Object.keys(stories || {}).filter(u =>
      u !== me && stories[u] && Object.keys(stories[u]).length > 0
    );
  }

  function friendsWithStories(stories, me, myFriends) {
    return usersWithStories(stories, me).filter(u => myFriends.includes(u));
  }

  return {
    post, deleteStory,
    markSeen, isSeen,
    cleanExpired,
    getUserStories, usersWithStories, friendsWithStories
  };

})();
