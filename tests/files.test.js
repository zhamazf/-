// يتأكد أن كل ملف مذكور في index.html و service-worker.js موجود فعلاً
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8');
const loaded = [...html.matchAll(/^\s*'([\w.-]+\.js)',?\s*$/gm)].map(m => m[1]);
const swList = [...sw.matchAll(/^\s*'([\w./-]+\.(?:js|css|html|json|png))',?\s*$/gm)].map(m => m[1]);
let bad = 0;
[...new Set([...loaded, ...swList])].forEach(f => { if (!fs.existsSync(path.join(root, f))) { console.log('  ✗ ملف مفقود:', f); bad++; } });
loaded.forEach(f => { if (!swList.includes(f) && f !== 'service-worker.js') { console.log('  ✗ غير موجود في STATIC_FILES:', f); bad++; } });
console.log(`ملفات: ${loaded.length} سكربت، ${swList.length} في الكاش — ${bad ? 'فشل' : 'سليم'}`);
process.exit(bad ? 1 : 0);
