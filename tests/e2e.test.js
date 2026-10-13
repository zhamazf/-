const fs=require('fs'), vm=require('vm');
const src=fs.readFileSync(require('path').join(__dirname,'..','e2e.js'),'utf8');
const ctx={window:{},crypto:globalThis.crypto,TextEncoder,TextDecoder,btoa,atob,console,Promise,Date,Math,JSON,Uint8Array,ArrayBuffer,Object,Array,String,Map,setTimeout,clearTimeout,Error};
ctx.window=ctx; vm.createContext(ctx); vm.runInContext(src,ctx,{filename:'e2e.js'});
const E2E=ctx.E2E;
let pass=0,fail=0; const bad=[];
const eq=(n,a,b)=>{ const ok=JSON.stringify(a)===JSON.stringify(b); ok?pass++:(fail++,bad.push(`${n}: توقعت ${JSON.stringify(b)} وطلع ${JSON.stringify(a)}`)); };
const mkDB=()=>{ const db={}; return { db, FB:{ get: async p=>{ if(db[p]!==undefined) return JSON.parse(JSON.stringify(db[p])); const kids=Object.keys(db).filter(k=>k.startsWith(p+'/')&&!k.slice(p.length+1).includes('/')); if(!kids.length) return null; const o={}; kids.forEach(k=>o[k.slice(p.length+1)]=JSON.parse(JSON.stringify(db[k]))); return o; }, set: async(p,v)=>{ db[p]=JSON.parse(JSON.stringify(v)); }, del: async p=>{ delete db[p]; Object.keys(db).forEach(k=>{ if(k.startsWith(p+'/')) delete db[k]; }); } } }; };
const memStore=()=>{ const m=new Map(); return { get: async k=>m.get(k), set: async(k,v)=>{m.set(k,v);}, del: async k=>{m.delete(k);}, m }; };
const dmk=(a,b)=>[a,b].sort().join('_');
(async()=>{
  const {db,FB}=mkDB();
  const A=E2E.create({FB,store:memStore()}), B=E2E.create({FB,store:memStore()});
  eq('init A', await A.init('alice'), 'ready'); eq('init B', await B.init('bob'), 'ready');
  const aDevKeys=Object.keys(db).filter(k=>k.startsWith('userDevices/alice/'));
  eq('جهاز A نُشر تلقائياً', aDevKeys.length, 1);
  eq('المفتاح العام فقط (بدون d)', db[aDevKeys[0]].pub.includes('"d"'), false);
  const K=dmk('alice','bob'); const base=(s)=>({sender:s,ts:1000,status:'sent'});
  const m1=await A.encryptMessage(K,'bob',base('alice'),{type:'text',text:'مرحبا سر',_tempId:'t1'});
  eq('الرسالة بلا نص صريح', JSON.stringify(m1).includes('مرحبا'), false);
  eq('الحقول العلنية', [m1.sender,m1.type,m1.ts], ['alice','text',1000]);
  const d1=await B.decryptMessage(K,Object.assign({id:'m1'},m1));
  eq('B يفك رسالة A', d1.text, 'مرحبا سر'); eq('_tempId محفوظ داخل المغلّف', d1._tempId, 't1');
  const d1a=await A.decryptMessage(K,Object.assign({id:'m1'},m1)); eq('A يفك رسالته', d1a.text, 'مرحبا سر');
  // رد
  const mr=await B.encryptMessage(K,'alice',base('bob'),{type:'text',text:'رد',replyTo:{id:'m1',sender:'alice',type:'text',text:'مرحبا سر'}});
  eq('نص الرد المقتبس لا يظهر', JSON.stringify(mr).includes('مرحبا'), false);
  eq('A يرى الرد', (await A.decryptMessage(K,Object.assign({id:'mr'},mr))).replyTo.text, 'مرحبا سر');
  // وسائط كبيرة
  const big='data:image/jpeg;base64,'+'QUJD'.repeat(100000);
  const mb=await A.encryptMessage(K,'bob',base('alice'),{type:'image',url:big});
  eq('صورة كبيرة تُفك', (await B.decryptMessage(K,Object.assign({id:'mb'},mb))).url===big, true);
  // جهاز ثانٍ لـ bob (هاتف جديد): يستلم الجديد فقط
  const B2=E2E.create({FB,store:memStore()}); await B2.init('bob');
  eq('جهازان لـ bob', Object.keys(db).filter(k=>k.startsWith('userDevices/bob/')).length, 2);
  const old=await B2.decryptMessage(K,Object.assign({id:'m1'},m1));
  eq('الجهاز الجديد لا يفتح القديم', [old._undecryptable,old.text.includes('🔒')], [true,true]);
  const m2=await A.encryptMessage(K,'bob',base('alice'),{type:'text',text:'بعد الجهاز الجديد'});
  eq('الجهاز الجديد يفتح الجديد', (await B2.decryptMessage(K,Object.assign({id:'m2'},m2))).text, 'بعد الجهاز الجديد');
  eq('الجهاز القديم يفتحه أيضاً', (await B.decryptMessage(K,Object.assign({id:'m2'},m2))).text, 'بعد الجهاز الجديد');
  // أجهزة المرسل نفسه (A2) تقرأ رسائلي الجديدة
  const A2=E2E.create({FB,store:memStore()}); await A2.init('alice');
  const m3=await B.encryptMessage(K,'alice',base('bob'),{type:'text',text:'لجهازي alice'});
  eq('A2 يفتح رسالة bob الجديدة', (await A2.decryptMessage(K,Object.assign({id:'m3'},m3))).text, 'لجهازي alice');
  const m4=await A.encryptMessage(K,'bob',base('alice'),{type:'text',text:'من A إلى bob'});
  eq('A2 يقرأ رسالة أرسلها A (مزامنة أجهزتي)', (await A2.decryptMessage(K,Object.assign({id:'m4'},m4))).text, 'من A إلى bob');
  // العبث
  const tam=(f)=>{ const c=JSON.parse(JSON.stringify(m2)); f(c); return c; };
  const T1=await B.decryptMessage(K,Object.assign({id:'t1x'},tam(c=>{c.e2e.ct=c.e2e.ct.slice(0,-6)+'AAAAAA';})));
  eq('تعديل الشيفر مرفوض', T1._undecryptable, true);
  const T2=await B.decryptMessage(K,Object.assign({id:'t2x'},tam(c=>{c.sender='bob';})));
  eq('تغيير المرسل مرفوض', T2._undecryptable, true);
  const T3=await B.decryptMessage('x_y',Object.assign({id:'t3x'},JSON.parse(JSON.stringify(m2))));
  eq('نقل لمحادثة أخرى مرفوض', T3._undecryptable, true);
  const T4=await B.decryptMessage(K,Object.assign({id:'t4x'},tam(c=>{c.e2e.w[B.myKid()].ct=c.e2e.w[B.myKid()].ct.slice(0,-6)+'AAAAAA';})));
  eq('تعديل التغليف مرفوض', T4._undecryptable, true);
  // انتحال: مهاجم mallory يسجّل جهازاً ويدّعي أنه alice
  const M=E2E.create({FB,store:memStore()}); await M.init('mallory');
  const forged=await M.encryptMessage(K,'bob',{sender:'alice',ts:5,status:'sent'},{type:'text',text:'انتحال'});
  const Tf=await B.decryptMessage(K,Object.assign({id:'tf'},forged));
  eq('انتحال شخصية المرسل مرفوض', Tf._undecryptable, true);
  // طرف بلا أجهزة
  eq('طرف بلا تشفير → null', await A.encryptMessage(dmk('alice','carol'),'carol',base('alice'),{type:'text',text:'x'}), null);
  eq('canEncryptTo', [await A.canEncryptTo('bob'), await A.canEncryptTo('carol')], [true,false]);
  // قائمة مختلطة
  const plain={id:'p',sender:'bob',type:'text',text:'عادية',ts:1};
  const lst=await B.decryptList(K,[plain,Object.assign({id:'m1'},m1)]); eq('قائمة مختلطة', [lst[0].text,lst[1].text], ['عادية','مرحبا سر']);
  // تعديل
  const raw=Object.assign({id:'m1'},m1);
  const newE=await A.reencryptEdit(K,'bob',raw,'نص معدّل');
  const ed=await B.decryptMessage(K,Object.assign({},raw,{e2e:newE,edited:true}));
  eq('تعديل مشفّر', [ed.text,ed.originalText], ['نص معدّل','مرحبا سر']);
  // رقم الأمان
  const sa=await A.safetyNumber('bob'), sb=await B.safetyNumber('alice');
  eq('رقم الأمان متطابق', sa===sb && /^(\d{5} ){5}\d{5}$/.test(sa), true);
  // استمرارية الجهاز بعد إعادة الفتح
  const st=memStore(); const U1=E2E.create({FB:mkDB().FB,store:st}); await U1.init('u1'); const k1=U1.myKid();
  const U1b=E2E.create({FB:mkDB().FB,store:st}); await U1b.init('u1'); eq('نفس الجهاز بعد إعادة الفتح', U1b.myKid(), k1);
  const U2=E2E.create({FB:mkDB().FB,store:st}); await U2.init('u2'); eq('هوية منفصلة لكل حساب', U2.myKid()!==k1, true);
  // إزالة الأجهزة الأخرى
  eq('أجهزة bob قبل', (await B.myDevices()).length, 2);
  eq('إزالة الأخرى', await B.removeOtherDevices(), 1);
  eq('أجهزة bob بعد', (await B.myDevices()).length, 1);
  // حد الأجهزة
  const {db:db9,FB:FB9}=mkDB(); let last; for(let i=0;i<11;i++){ last=E2E.create({FB:FB9,store:memStore()}); await last.init('zed'); }
  eq('الحد الأقصى 8 أجهزة', Object.keys(db9).filter(k=>k.startsWith('userDevices/zed/')).length<=8, true);
  // وضع أخطاء: FB.set يفشل
  const bad2=E2E.create({FB:{get:FB.get,set:async()=>{throw new Error('PERMISSION_DENIED');},del:FB.del},store:memStore()});
  eq('فشل النشر → حالة error', await bad2.init('qq'), 'error');
  let thrown=null; try{ await bad2.encryptMessage(K,'bob',base('qq'),{type:'text',text:'x'}); }catch(e){thrown=e.message;} eq('غير جاهز → يرفض التشفير', thrown, 'not_ready');
  // تخزين تالف → هوية جديدة
  const st2=memStore(); await st2.set('dev_u9',{id:'x',kid:'bad',pub:'p',jwk:{}}); const U9=E2E.create({FB:mkDB().FB,store:st2}); eq('تخزين تالف → توليد جديد', await U9.init('u9'), 'ready');

  console.log(`\nاختبارات التشفير: نجح ${pass} / فشل ${fail}`); bad.forEach(b=>console.log('  ✗',b)); process.exit(fail?1:0);
})().catch(e=>{console.error('CRASH',e);process.exit(2);});
