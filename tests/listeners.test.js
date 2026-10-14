// حراسة أداء/خصوصية: ممنوع الاستماع لأشجرة كاملة (presence/typing) أو لكل رسائل مجموعة بلا حد
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
let bad = 0;
const must = (name, cond) => { if (!cond) { console.log('  ✗', name); bad++; } };
must("لا استماع لـ 'presence' كاملة", !/FB\.on\(\s*['"`]presence['"`]/.test(src));
must("لا استماع لـ 'typing' كاملة", !/FB\.on\(\s*['"`]typing['"`]/.test(src));
must('رسائل المجموعة للعدّاد بحد limitToLast', /FB\.onLimit\(`groupMsgs\/\$\{gid\}`,\s*\d+/.test(src));
must('presence لكل مستخدم', /FB\.on\(`presence\/\$\{uid\}`/.test(src));
must('typing للمحادثة المفتوحة', /FB\.on\(_tPath/.test(src) && /_typingUnsub\(\)/.test(src));
console.log(`مستمعات الأداء — ${bad ? 'فشل' : 'سليم'}`);
process.exit(bad ? 1 : 0);
