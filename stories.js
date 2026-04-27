/**
 * js/stories.js
 * Stories: post, delete, seen tracking, auto-cleanup
 * Privacy: only friends see others' stories
 * Depends on: firebase.js (window.FB)
 * Exposes:    window.Stories
 */
window.Stories = (function () {

  /* ── Constants ───────────────────────────────────────────── */
  const STORY_TTL      = 24 * 60 * 60 * 1000;  // 24 ساعة بالمللي ثانية
  const MAX_STORIES    = 10;                     // ✅ حد أقصى لكل مستخدم
  const CLEANUP_EVERY  = 5 * 60 * 1000;         // ✅ تنظيف كل 5 دقائق
  const LS_SEEN        = 'ns';

  /* ── localStorage helpers ────────────────────────────────── */
  function _lsGet(k, fb) {
    try { const v = localStorage.getItem(k); return v != null ? JSON.parse(v) : fb; }
    catch { return fb; }
  }
  function _lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
  }

  /* ═══════════════════════════════════════════════════════════
     POST
     ✅ يرفض إذا وصل المستخدم للحد الأقصى (MAX_STORIES)
  ═══════════════════════════════════════════════════════════ */
  async function post(me, dataUrl) {
    if (!dataUrl) return { error: 'لا توجد صورة' };

    // فحص عدد القصص الحالية قبل النشر
    const current = await FB.get(`stories/${me}`);
    const count   = current ? Object.keys(current).length : 0;

    if (count >= MAX_STORIES)
      return { error: `الحد الأقصى ${MAX_STORIES} قصص — احذف قصة قديمة أولاً` };

    await FB.push(`stories/${me}`, {
      data: dataUrl,
      ts:   Date.now(),
      type: 'image'
    });
    return { ok: true };
  }

  /* ═══════════════════════════════════════════════════════════
     DELETE
     ✅ يتحقق أن القصة تخص المستخدم الحالي
  ═══════════════════════════════════════════════════════════ */
  async function deleteStory(me, sid) {
    if (!sid) return { error: 'معرّف القصة غير موجود' };
    await FB.del(`stories/${me}/${sid}`);
    return { ok: true };
  }

  /* ═══════════════════════════════════════════════════════════
     SEEN TRACKING (localStorage — local device only)
  ═══════════════════════════════════════════════════════════ */
  function markSeen(user) {
    const s    = _lsGet(LS_SEEN, {});
    s[user]    = Date.now();
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

  /* ═══════════════════════════════════════════════════════════
     CLEAN EXPIRED
     ✅ يمكن استدعاؤها يدوياً + setInterval من startAutoCleanup()
     يحذف فقط القصص التي تجاوزت 24 ساعة
  ═══════════════════════════════════════════════════════════ */
  function cleanExpired(stories) {
    const now = Date.now();
    Object.entries(stories || {}).forEach(([user, userStories]) => {
      if (!userStories) return;
      Object.entries(userStories).forEach(([sid, s]) => {
        if (now - s.ts > STORY_TTL) {
          FB.del(`stories/${user}/${sid}`);
        }
      });
    });
  }

  /**
   * ✅ يبدأ دورة تنظيف تلقائية كل 5 دقائق
   * يُستدعى مرة واحدة من app.js بعد تحميل stories
   * يُمرَّر S.stories كمرجع حي عبر getter
   *
   * @param {Function} getStories — دالة ترجع S.stories الحالية
   * @returns {Function} stopFn — لإيقاف الدورة عند تسجيل الخروج
   */
  function startAutoCleanup(getStories) {
    const id = setInterval(() => {
      cleanExpired(getStories());
    }, CLEANUP_EVERY);
    return () => clearInterval(id);
  }

  /* ═══════════════════════════════════════════════════════════
     GET USER STORIES
     يُرجع قصص مستخدم واحد مرتبة من الأحدث للأقدم
     ويُسقط أي قصص منتهية الصلاحية محلياً (لا ينتظر Firebase)
  ═══════════════════════════════════════════════════════════ */
  function getUserStories(user, stories) {
    const us  = stories[user];
    if (!us) return [];
    const now = Date.now();
    return Object.entries(us)
      .map(([sid, s]) => ({ sid, ...s }))
      .filter(s => now - s.ts <= STORY_TTL)   // ✅ يُخفي المنتهية محلياً فوراً
      .sort((a, b) => b.ts - a.ts);
  }

  /* ═══════════════════════════════════════════════════════════
     USERS WITH STORIES
  ═══════════════════════════════════════════════════════════ */
  function usersWithStories(stories, me) {
    return Object.keys(stories || {}).filter(u =>
      u !== me &&
      stories[u] &&
      Object.keys(stories[u]).length > 0
    );
  }

  /**
   * ✅ يُرجع فقط الأصدقاء الذين لديهم قصص
   * يمنع عرض / طلب قصص الغرباء
   */
  function friendsWithStories(stories, me, myFriends) {
    return usersWithStories(stories, me).filter(u => myFriends.includes(u));
  }

  /**
   * ✅ فلترة snapshot القصص ليشمل فقط الأصدقاء + المستخدم نفسه
   * استخدمها في app.js قبل تمرير القصص للـ state:
   *
   *   FB.on('stories', raw => {
   *     S.stories = Stories.filterForFriends(raw, S.me, myFriends());
   *   });
   *
   * يمنع تحميل بيانات مستخدمين لا علاقة لك بهم
   */
  function filterForFriends(rawStories, me, myFriends) {
    if (!rawStories) return {};
    const allowed = new Set([me, ...myFriends]);
    const result  = {};
    Object.entries(rawStories).forEach(([user, stories]) => {
      if (allowed.has(user)) result[user] = stories;
    });
    return result;
  }

  /* ── Public API ──────────────────────────────────────────── */
  return {
    post,
    deleteStory,
    markSeen,
    isSeen,
    cleanExpired,
    startAutoCleanup,       // ✅ new
    getUserStories,
    usersWithStories,
    friendsWithStories,
    filterForFriends,       // ✅ new
    MAX_STORIES,            // exported for UI hints
    STORY_TTL,
  };

})();
