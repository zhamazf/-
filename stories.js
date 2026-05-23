/**
 * js/stories.js
 * Stories: post, delete, seen tracking, auto-cleanup
 * Privacy: only friends see others' stories
 * Depends on: firebase.js (window.FB)
 * Exposes:    window.Stories
 *
 * v2 additions:
 * 1. postVideo()      → نشر قصة فيديو (≤ 15 ثانية, ≤ 5MB)
 * 2. postText()       → قصة نصية بدون صورة (نص + لون خلفية)
 * 3. replyToStory()   → إرسال رد على قصة كـ DM
 * 4. getViewers()     → عدد من شاهدوا القصة + قائمتهم
 * 5. markSeenFirebase() → تسجيل المشاهدة في Firebase (ليس localStorage فقط)
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

  // v2: فيديو ونص
  const MAX_VIDEO_SIZE    = 5 * 1024 * 1024;    // 5MB للفيديو
  const MAX_TEXT_LEN      = 200;                 // حد النص
  const TEXT_BG_COLORS    = [
    'linear-gradient(135deg,#6366f1,#8b5cf6)',
    'linear-gradient(135deg,#ec4899,#f43f5e)',
    'linear-gradient(135deg,#f59e0b,#f97316)',
    'linear-gradient(135deg,#10b981,#059669)',
    'linear-gradient(135deg,#3b82f6,#2563eb)',
    'linear-gradient(135deg,#000,#374151)',
  ];

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
     POST VIDEO (v2)
     يقبل base64 فيديو ≤ 5MB — Firebase يخزنه مباشرة
     ملاحظة: الفيديو الكبير يُنصح برفعه على Firebase Storage
     لكن للبساطة نخزنه في Realtime DB مثل الصور (≤ 5MB)
  ═══════════════════════════════════════════════════════════ */
  async function postVideo(me, dataUrl) {
    if (!dataUrl) return { error: 'لا يوجد فيديو' };
    if (!dataUrl.startsWith('data:video/'))
      return { error: 'الملف ليس فيديو — يُقبل فقط MP4, WebM' };

    // تحقق من الحجم (base64 أكبر بـ ~37% من الحجم الأصلي)
    const approxBytes = (dataUrl.length * 3) / 4;
    if (approxBytes > MAX_VIDEO_SIZE)
      return { error: `الفيديو كبير جداً — الحد الأقصى ${Math.round(MAX_VIDEO_SIZE/1024/1024)}MB` };

    const current = await FB.get(`stories/${me}`);
    const count   = current ? Object.keys(current).length : 0;
    if (count >= MAX_STORIES)
      return { error: `الحد الأقصى ${MAX_STORIES} قصص — احذف قصة قديمة أولاً` };

    await FB.push(`stories/${me}`, {
      data: dataUrl,
      ts:   Date.now(),
      type: 'video',
    });
    return { ok: true };
  }

  /* ═══════════════════════════════════════════════════════════
     POST TEXT STORY (v2)
     قصة نصية بدون صورة (نص + لون خلفية)
     تُعرض كـ card ملوّن في واجهة القصص
  ═══════════════════════════════════════════════════════════ */
  async function postText(me, text, bgIndex = 0) {
    text = (text || '').trim();
    if (!text)               return { error: 'أدخل نصاً للقصة' };
    if (text.length > MAX_TEXT_LEN)
      return { error: `النص طويل جداً (${MAX_TEXT_LEN} حرفاً كحد أقصى)` };

    const current = await FB.get(`stories/${me}`);
    const count   = current ? Object.keys(current).length : 0;
    if (count >= MAX_STORIES)
      return { error: `الحد الأقصى ${MAX_STORIES} قصص — احذف قصة قديمة أولاً` };

    const bg = TEXT_BG_COLORS[bgIndex % TEXT_BG_COLORS.length];
    await FB.push(`stories/${me}`, {
      text,
      bg,
      ts:   Date.now(),
      type: 'text',
    });
    return { ok: true };
  }

  /* ═══════════════════════════════════════════════════════════
     REPLY TO STORY (v2)
     يُرسل رداً على قصة كـ DM للصاحب
     Path: dmMsgs/{dmKey} (نفس مسار الرسائل الخاصة)
  ═══════════════════════════════════════════════════════════ */
  async function replyToStory(myUid, storyOwnerUid, storyData, replyText) {
    if (!myUid || !storyOwnerUid) return { error: 'missing_args' };
    if (!replyText?.trim())       return { error: 'أدخل ردك على القصة' };
    if (myUid === storyOwnerUid)  return { error: 'لا يمكنك الرد على قصتك' };

    const dmKey = [myUid, storyOwnerUid].sort().join('_');
    try {
      await FB.push(`dmMsgs/${dmKey}`, {
        sender:  myUid,
        ts:      Date.now(),
        status:  'sent',
        type:    'text',
        text:    replyText.trim().slice(0, 500),
        // مرجع للقصة المردود عليها
        storyReply: {
          ownerUid: storyOwnerUid,
          type:     storyData?.type || 'image',
          preview:  storyData?.type === 'text'
            ? (storyData.text || '').slice(0, 60)
            : '📸 قصة',
        },
      });
      return { ok: true };
    } catch (e) {
      return { error: e.message };
    }
  }

  /* ═══════════════════════════════════════════════════════════
     VIEWERS (v2)
     Path: storyViews/{ownerUid}/{sid}/{viewerUid} → { ts }
     يسجل من شاهد القصة في Firebase (ليس localStorage فقط)
  ═══════════════════════════════════════════════════════════ */
  async function markSeenFirebase(viewerUid, ownerUid, sid) {
    if (!viewerUid || !ownerUid || !sid) return;
    if (viewerUid === ownerUid) return; // صاحب القصة لا يُحسب كمشاهد
    try {
      await FB.set(`storyViews/${ownerUid}/${sid}/${viewerUid}`, { ts: Date.now() });
    } catch {}
  }

  async function getViewers(ownerUid, sid) {
    if (!ownerUid || !sid) return { count: 0, viewers: [] };
    try {
      const raw = await FB.get(`storyViews/${ownerUid}/${sid}`);
      if (!raw) return { count: 0, viewers: [] };
      const viewers = Object.entries(raw).map(([uid, data]) => ({
        uid,
        ts: data?.ts || 0,
      })).sort((a, b) => b.ts - a.ts);
      return { count: viewers.length, viewers };
    } catch {
      return { count: 0, viewers: [] };
    }
  }

  /* ═══════════════════════════════════════════════════════════
     GET USER STORIES
     يُرجع قصص مستخدم واحد مرتبة من الأحدث للأقدم
     ويُسقط أي قصص منتهية الصلاحية محلياً (لا ينتظر Firebase)
     v2: يدعم type = 'image' | 'video' | 'text'
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
    // Original
    post,
    deleteStory,
    markSeen,
    isSeen,
    cleanExpired,
    startAutoCleanup,
    getUserStories,
    usersWithStories,
    friendsWithStories,
    filterForFriends,

    // v2
    postVideo,
    postText,
    replyToStory,
    markSeenFirebase,
    getViewers,

    // Constants
    MAX_STORIES,
    STORY_TTL,
    TEXT_BG_COLORS,
  };

})();
