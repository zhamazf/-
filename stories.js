/**
 * js/stories.js
 * Stories: post, delete, seen tracking, auto-cleanup
 * Privacy: only friends see others' stories
 * Depends on: firebase.js (window.FB)
 * Exposes:    window.Stories
 */
window.Stories = (function () {

  /* ── Constants ───────────────────────────────────────────── */
  const STORY_TTL      = 24 * 60 * 60 * 1000;  // 24 ساعة
  const MAX_STORIES    = 10;                     // حد أقصى لكل مستخدم
  const CLEANUP_EVERY  = 5 * 60 * 1000;         // تنظيف كل 5 دقائق
  const LS_SEEN        = 'ns';
  const MAX_IMG_SIZE   = 800;   // px — الحد الأقصى للعرض/الارتفاع بعد الضغط
  const IMG_QUALITY    = 0.75;  // جودة JPEG بعد الضغط
  const MAX_DATA_SIZE  = 400 * 1024; // 400KB — حد أقصى لحجم base64

  /* ── localStorage helpers ────────────────────────────────── */
  function _lsGet(k, fb) {
    try { const v = localStorage.getItem(k); return v != null ? JSON.parse(v) : fb; }
    catch { return fb; }
  }
  function _lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
  }

  /* ══════════════════════════════════════════════════════════
     IMAGE COMPRESSION — ضغط الصورة قبل الرفع
  ══════════════════════════════════════════════════════════ */
  function _compressImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        // تصغير إذا كانت الأبعاد أكبر من الحد
        if (width > MAX_IMG_SIZE || height > MAX_IMG_SIZE) {
          const ratio = Math.min(MAX_IMG_SIZE / width, MAX_IMG_SIZE / height);
          width  = Math.round(width  * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width  = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', IMG_QUALITY));
      };
      img.onerror = () => reject(new Error('invalid_image'));
      img.src = dataUrl;
    });
  }

  function _validateImage(dataUrl) {
    if (!dataUrl) return 'لا توجد صورة';
    if (!dataUrl.startsWith('data:image/'))
      return 'الملف ليس صورة — يُقبل فقط JPG, PNG, WebP';
    return null;
  }

  /* ═══════════════════════════════════════════════════════════
     POST — مع ضغط الصورة والتحقق
  ═══════════════════════════════════════════════════════════ */
  async function post(me, dataUrl) {
    // التحقق من نوع الملف
    const imgError = _validateImage(dataUrl);
    if (imgError) return { error: imgError };

    // ضغط الصورة
    let compressed;
    try {
      compressed = await _compressImage(dataUrl);
    } catch {
      return { error: 'تعذّر معالجة الصورة' };
    }

    // فحص الحجم بعد الضغط
    if (compressed.length > MAX_DATA_SIZE * 1.37) // base64 أكبر بـ 37% من binary
      return { error: 'الصورة كبيرة جداً حتى بعد الضغط — جرّب صورة أصغر' };

    // فحص عدد القصص الحالية
    const current = await FB.get(`stories/${me}`);
    const count   = current ? Object.keys(current).length : 0;
    if (count >= MAX_STORIES)
      return { error: `الحد الأقصى ${MAX_STORIES} قصص — احذف قصة قديمة أولاً` };

    await FB.push(`stories/${me}`, {
      data: compressed,
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
      // تجاهل القصص المنتهية
      const active = Object.values(us).filter(x => Date.now() - x.ts <= STORY_TTL);
      if (!active.length) return true;
      const newest = Math.max(...active.map(x => x.ts));
      return last > newest;
    } catch { return false; }
  }

  /* ═══════════════════════════════════════════════════════════
     CLEAN EXPIRED
     ✅ يمكن استدعاؤها يدوياً + setInterval من startAutoCleanup()
     يحذف فقط القصص التي تجاوزت 24 ساعة
  ═══════════════════════════════════════════════════════════ */
  function cleanExpired(stories, meUid) {
    if (!meUid) return;
    const now = Date.now();
    const myStories = (stories || {})[meUid];
    if (!myStories) return;
    const expired = Object.entries(myStories)
      .filter(([, s]) => s && now - s.ts > STORY_TTL)
      .map(([sid]) => sid);
    if (!expired.length) return;
    // حذف بالتوازي مع تجاهل الأخطاء
    Promise.allSettled(
      expired.map(sid => FB.del(`stories/${meUid}/${sid}`))
    );
  }

  /**
   * ✅ يبدأ دورة تنظيف تلقائية كل 5 دقائق
   * يُستدعى مرة واحدة من app.js بعد تحميل stories
   * يُمرَّر S.stories كمرجع حي عبر getter
   *
   * @param {Function} getStories — دالة ترجع S.stories الحالية
   * @returns {Function} stopFn — لإيقاف الدورة عند تسجيل الخروج
   */
  function startAutoCleanup(getStories, getMeUid) {
    // getMeUid: دالة ترجع S.meUid الحالي (قد يتغير بعد تسجيل الدخول)
    const id = setInterval(() => {
      cleanExpired(getStories(), getMeUid());
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
    // myFriends: قائمة usernames أو uids — نقبل الاثنين
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
