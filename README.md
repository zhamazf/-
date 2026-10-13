# نبضة (Nabda) — تطبيق دردشة PWA

HTML + JavaScript عادي (بدون bundler) + Firebase (Auth / Realtime Database / Storage). النشر: Netlify من فرع `main`.

## الملفات
- `index.html` يحمّل السكربتات بالترتيب: firebase → auth → e2e → chat → friends → groups → stories → ui → app
- `e2e.js` تشفير الرسائل الخاصة طرف-لطرف (ECDH P-256 + AES-256-GCM، مفتاح لكل جهاز، بدون إعداد من المستخدم)
- `database.rules.json` قواعد Realtime Database — **تُلصق يدوياً** في Firebase Console ← Realtime Database ← Rules ← Publish
- `service-worker.js` كاش + عمل أوفلاين (عند إضافة ملف جديد أضفه إلى `STATIC_FILES` وغيّر `_BUILD`)

## الاختبارات
```
npm install
npm test
```
- `tests/files.test.js` كل ملف مذكور موجود
- `tests/rules.test.js` اختبار القواعد (targaryen)
- `tests/e2e.test.js` اختبار التشفير (Node + WebCrypto)

## ملاحظات أمنية
- المجموعات غير مشفّرة طرف-لطرف. التفاعلات وحالة القراءة غير مشفّرة.
- جهاز جديد لا يقرأ الرسائل المشفّرة القديمة (مثل واتساب بدون نسخة احتياطية).
- مفاتيح Firebase في الكود عامة بطبيعتها؛ الحماية هي القواعد (يُنصح بتفعيل App Check).
