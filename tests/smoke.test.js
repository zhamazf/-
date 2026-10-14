// اختبار تشغيل وهمي: يشغّل app.js في vm بـ stubs (بدون شبكة) ويتأكد من المستمعات التي تُفتح عند الإقلاع
const vm = require('vm'), fs = require('fs');
const path = require('path');
const appPath = path.join(__dirname, '..', 'app.js');
const calls = [];
const deep = () => { const f = function(){}; return new Proxy(f, {
  get: (t, k) => k === 'then' ? undefined : (k === Symbol.toPrimitive ? () => '' : (k === 'length' ? 0 : deep())),
  apply: () => deep(), construct: () => deep(), set: () => true }); };
const noop = () => {};
const profile = { uid:'u1', username:'ali', email:'a@x.com', friends:{f1:true}, groups:{g1:true} };
const FB = {
  init: async () => {}, authCurrentUser: () => ({ uid:'u1', email:'a@x.com' }), authResolved: () => true,
  authOnChange: noop, onConnectionChange: () => noop,
  on: (p, cb) => { calls.push('on:'+p); setTimeout(() => { try { cb(p==='users/u1' ? profile : p==='users/u1/groups' ? {g1:true} : p==='groups/g1' ? {id:'g1',name:'G',admin:'u1',members:{u1:true,m2:true}} : null); } catch(e){ calls.push('CB_ERR:'+p+':'+e.message); } }, 0); return noop; },
  onLimit: (p, n, cb) => { calls.push('onLimit:'+p+':'+n); return noop; },
  del: async (p) => { calls.push('del:'+p); }, get: async () => null, set: async () => {}, upd: async () => {},
};
const ctx = { FB, Auth: { getUser: () => 'ali', clearSession: noop }, Chat: deep(), Groups: deep(), Stories: deep(), Friends: deep(), UI: deep(),
  console: { log: noop, error: (...a)=>calls.push('console.error:'+a.join(' ')), warn: noop },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop, Date, JSON, Object, Array, Map, Set, Promise, Math, URLSearchParams, Symbol, Error, RegExp, String, Number, Boolean,
  navigator: deep(), document: deep(), history: { replaceState: noop, pushState: noop }, location: { search: '', pathname: '/' }, localStorage: { getItem: () => null, setItem: noop, removeItem: noop } };
ctx.window = Object.assign(ctx, { addEventListener: noop, innerWidth: 400, E2E: undefined });
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(appPath, 'utf8'), ctx);
setTimeout(() => {
  let bad = 0;
  const must = (name, cond) => { if (!cond) { console.log('  ✗', name); bad++; } };
  must('لا استماع لـ presence كاملة', !calls.includes('on:presence'));
  must('لا استماع لـ typing كاملة', !calls.includes('on:typing'));
  must('presence لي', calls.includes('on:presence/u1'));
  must('إشعاراتي', calls.includes('on:notifications/u1'));
  must('presence لصديق', calls.includes('on:presence/f1'));
  must('presence لعضو مجموعة', calls.includes('on:presence/m2'));
  must('رسائل المجموعة بحد 60', calls.includes('onLimit:groupMsgs/g1:60') && !calls.includes('on:groupMsgs/g1'));
  must('رسائل DM بحد 40', calls.includes('onLimit:dmMsgs/f1_u1:40'));
  must('تنظيف الإيميل القديم', calls.includes('del:users/u1/email'));
  must('لا أخطاء أثناء الإقلاع', !calls.some(c => c.startsWith('CB_ERR') || c.startsWith('console.error')));
  console.log(`اختبار الإقلاع (مستمعات Firebase) — ${bad ? 'فشل' : 'سليم'}`);
  process.exit(bad ? 1 : 0);
}, 700);
