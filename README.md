# نبضة Chat 💬

تطبيق دردشة فوري مبني بـ Vanilla JS + Firebase Realtime Database

---

## 🗂️ هيكل المشروع

```
nabda/
├── index.html          ← نقطة الدخول
├── style.css           ← جميع الأنماط
├── manifest.json       ← PWA
├── service-worker.js   ← كاش + تحديثات
├── icon.png            ← أيقونة التطبيق
├── js/
│   ├── firebase.js     ← window.FB  (إعداد + CRUD)
│   ├── auth.js         ← window.Auth (تسجيل + SHA-256)
│   ├── chat.js         ← window.Chat (رسائل + typing + unread)
│   ├── friends.js      ← window.Friends
│   ├── groups.js       ← window.Groups
│   ├── stories.js      ← window.Stories
│   ├── ui.js           ← window.UI (ثيم + صوت + toast + avatar)
│   └── app.js          ← المتحكم الرئيسي
└── README.md
```

---

## ✅ الإصلاحات في v5

| المشكلة | الحل |
|---------|------|
| شاشة التحميل تظهر بعد timeout ثابت | تُخفى بعد `FB.init()` مباشرة |
| تكرار الرسائل | `_seenMsgIds` Set يمنع التكرار |
| progress bar القصص لا تعمل | كل شريط له `id="prog-fill-N"` |
| شاشة التحميل لا تدعم الوضع الداكن | تقرأ الثيم من localStorage فوراً |
| كلمات المرور نص صريح | SHA-256 عبر Web Crypto API |
| Service Worker لا يتحدث | `nabda-v5` + network-first strategy |
| addMember بدون تحقق | يتحقق من وجود العضو مسبقاً |
| removeFriend بدون تحقق | يتحقق من وجود الصداقة |

---

## 🚀 الرفع على GitHub

### الخطوة 1 — إنشاء Repository

1. اذهب إلى [github.com/new](https://github.com/new)
2. اسم المستودع: `nabda` (أو أي اسم تريد)
3. اجعله **Public**
4. اضغط **Create repository**

### الخطوة 2 — رفع الملفات من الهاتف

**الطريقة الأسهل (بدون Git):**

1. افتح المستودع على GitHub
2. اضغط **Add file** ← **Upload files**
3. ارفع جميع الملفات دفعة واحدة:
   - `index.html`
   - `style.css`
   - `manifest.json`
   - `service-worker.js`
   - `icon.png`
   - `README.md`
   - مجلد `js/` (ارفع كل ملفاته)
4. اكتب في حقل Commit: `🚀 nabda chat v5`
5. اضغط **Commit changes**

**أو عبر Git (إذا لديك حاسوب):**

```bash
git init
git add .
git commit -m "🚀 nabda chat v5 - production ready"
git branch -M main
git remote add origin https://github.com/اسمك/nabda.git
git push -u origin main
```

---

## 🌐 تفعيل GitHub Pages

1. افتح المستودع على GitHub
2. اضغط **Settings**
3. من القائمة الجانبية: **Pages**
4. في **Source**: اختر `Deploy from a branch`
5. Branch: **main** / folder: **/ (root)**
6. اضغط **Save**

بعد دقيقة سيكون التطبيق على:
```
https://اسمك.github.io/nabda/
```

---

## ⚙️ الميزات

- ✅ دردشة خاصة (DM)
- ✅ مجموعات مع إدارة كاملة
- ✅ نظام أصدقاء (إرسال/قبول/رفض)
- ✅ القصص (تنتهي بعد 24 ساعة)
- ✅ حالة الاتصال (متصل/آخر ظهور)
- ✅ مؤشر "يكتب..."
- ✅ رسائل صوتية + صور + فيديو
- ✅ إشعارات المتصفح
- ✅ وضع داكن/فاتح
- ✅ تخصيص لون الفقاعات والخلفية
- ✅ PWA (يعمل بدون إنترنت)
- ✅ كلمات مرور مشفرة SHA-256

---

## 📌 ملاحظات

- لا يحتاج npm أو Node.js
- يعمل مباشرة من المتصفح
- Firebase مجاني للاستخدام الشخصي
