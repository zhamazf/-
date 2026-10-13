const targaryen = require('targaryen');
const path = require('path');
const which = path.join(__dirname,'..','database.rules.json');
const rules = require(which);

const U = n => n + 'x'.repeat(28 - n.length);          // uid شبيه بالحقيقي: 28 حرف بدون _
const alice=U('alice'), bob=U('bob'), carol=U('carol'), mal=U('mallory'), dave=U('dave');
const dm = (a,b)=>[a,b].sort().join('_');

const data = {
  users: { [alice]:{uid:alice,username:'ali',email:'a@x.com',friends:{[bob]:true}, groups:{g1:true}},
           [bob]:{uid:bob,username:'bob',friends:{[alice]:true}, groups:{g1:true,g2:true}},
           [mal]:{uid:mal,username:'mal'} , [carol]:{uid:carol,username:'carol',groups:{g1:true}} },
  usernames: { ali: alice, bob: bob, mal: mal },
  groups: {
    g1: { id:'g1', admin:alice, name:'G1', members:{[alice]:true,[carol]:true,[bob]:true}, mods:{[carol]:true},
          pending:{}, inviteCode:'CODE1', inviteActive:true },
    g9: { id:'g9', admin:bob, name:'G9', privacy:'public', members:{[bob]:true}, mods:{}, inviteCode:'CODE3', inviteActive:false },
    g2: { id:'g2', admin:bob, name:'G2', members:{[bob]:true}, mods:{}, inviteCode:'CODE2', inviteActive:false }
  },
  inviteCodes: { CODE1:'g1', CODE2:'g2' },
  groupMsgs: { g1:{ m1:{sender:'ali',text:'hi',ts:1} }, g2:{ m1:{sender:'bob',text:'secret',ts:1} } },
  groupPolls: { g1:{ p1:{question:'q'} } },
  dmMsgs: { [dm(alice,bob)]:{ m1:{sender:'ali',text:'hi',ts:1} } },
  friendRequests: { [alice]:{ [dave]:{from:dave,ts:1} } },
  blockedUsers: { },
};
const mk = (extra) => targaryen.database(rules, Object.assign({}, data, extra||{}));
let pass=0, fail=0; const failures=[];
function t(name, res, expectAllowed){
  const ok = res.allowed === expectAllowed;
  ok ? pass++ : (fail++, failures.push(`${name}  (توقعت ${expectAllowed?'مسموح':'مرفوض'} وطلع ${res.allowed?'مسموح':'مرفوض'})`));
}
const as = (db,u)=> db.as(u===null?null:{uid:u});
const db = mk();

/* ── مجموعات عامة/خاصة ── */
t('عامة: mallory تنضم مباشرة', as(db,mal).write('/groups/g9/members/'+mal, true), true);
t('[هجوم] عامة: mallory تضيف شخصاً آخر', as(db,mal).write('/groups/g9/members/'+carol, true), false);
t('[هجوم] عامة: قيمة غير true', as(db,mal).write('/groups/g9/members/'+mal, 'x'), false);
t('[هجوم] خاصة g1: mallory تنضم مباشرة', as(db,mal).write('/groups/g1/members/'+mal, true), false);
t('[هجوم] g2 (خاصة بلا privacy): mallory تنضم', as(db,mal).write('/groups/g2/members/'+mal, true), false);
t('[هجوم] mallory تحوّل g1 إلى عامة', as(db,mal).write('/groups/g1/privacy', 'public'), false);
t('[هجوم] carol (مود) تحوّل g1 إلى عامة', as(db,carol).write('/groups/g1/privacy', 'public'), false);
t('admin يحوّل g1 إلى عامة', as(db,alice).write('/groups/g1/privacy', 'public'), true);
t('admin قيمة privacy غير صالحة', as(db,alice).write('/groups/g1/privacy', 'bad'), false);
t('إنشاء مجموعة عامة', as(db,mal).write('/groups/gNew', {id:'gNew',admin:mal,name:'n',privacy:'public',members:{[mal]:true}}), true);
t('[هجوم] إنشاء مجموعة privacy غير صالحة', as(db,mal).write('/groups/gNew', {id:'gNew',admin:mal,name:'n',privacy:'zzz',members:{[mal]:true}}), false);

/* ── تفضيلات المحادثات الخاصة ── */
t('userData: أكتب تفضيلاتي', as(db,alice).write('/userData/'+alice+'/chatPrefs/k1', {pinned:1,muted:true,archived:2,hiddenAt:3}), true);
t('[هجوم] userData: أكتب لغيري', as(db,mal).write('/userData/'+alice+'/chatPrefs/k1', {pinned:1}), false);
t('[خصوصية] userData: أقرأ تفضيلات غيري', as(db,mal).read('/userData/'+alice), false);
t('userData: أقرأ تفضيلاتي', as(db,alice).read('/userData/'+alice), true);
t('userData: حقل غير معروف مرفوض', as(db,alice).write('/userData/'+alice+'/chatPrefs/k1', {pinned:1,evil:'x'}), false);
t('userData: نوع خاطئ مرفوض', as(db,alice).write('/userData/'+alice+'/chatPrefs/k1', {muted:'yes'}), false);
t('userData: بدون تسجيل', as(db,null).write('/userData/'+alice+'/chatPrefs/k1', {pinned:1}), false);

/* ── اسماء المستخدمين ── */
t('[هجوم] mallory تكتب فوق usernames/ali', as(db,mal).write('/usernames/ali', mal), false);
t('mallory تحجز اسم جديد لنفسها', as(db,mal).write('/usernames/zed', mal), true);
t('[هجوم] mallory تحجز اسم جديد وتربطه بغيرها', as(db,mal).write('/usernames/zed2', alice), false);
t('alice تحذف اسمها', as(db,alice).write('/usernames/ali', null), true);
t('[هجوم] mallory تحذف اسم alice', as(db,mal).write('/usernames/ali', null), false);
t('قراءة اسم واحد (تسجيل/بحث)', as(db,alice).read('/usernames/bob'), true);
t('[خصوصية] سحب قائمة كل الأسماء', as(db,mal).read('/usernames'), false);
const q=(o)=>({query:Object.assign({orderByKey:true,startAt:'al',endAt:'al\uf8ff',limitToFirst:8},o||{})});
t('اقتراحات: بحث بادئة مقيّد', as(db,alice).read('/usernames',q()), true);
t('اقتراحات: بدون تسجيل', as(db,null).read('/usernames',q()), false);
t('[خصوصية] اقتراحات: limit كبير', as(db,mal).read('/usernames',q({limitToFirst:500})), false);
t('[خصوصية] اقتراحات: بدون limit', as(db,mal).read('/usernames',{query:{orderByKey:true,startAt:'a'}}), false);
t('[خصوصية] اقتراحات: بادئة فارغة', as(db,mal).read('/usernames',q({startAt:''})), false);
t('[خصوصية] اقتراحات: ترتيب بالقيمة', as(db,mal).read('/usernames',{query:{orderByValue:true,startAt:'a',limitToFirst:8}}), false);

/* ── الملفات الشخصية ── */
t('قراءة بروفايل شخص', as(db,alice).read('/users/'+bob), true);
t('[خصوصية] سحب كل المستخدمين', as(db,mal).read('/users'), false);
t('بدون تسجيل: قراءة بروفايل', as(db,null).read('/users/'+alice), false);
t('alice تعدل بروفايلها', as(db,alice).write(`/users/${alice}/bio`, 'x'), true);
t('[هجوم] mallory تعدل بروفايل alice', as(db,mal).write(`/users/${alice}/bio`, 'x'), false);
t('[هجوم] mallory تضيف نفسها صديقة لـalice بدون طلب', as(db,mal).write(`/users/${alice}/friends/${mal}`, true), false);
t('قبول طلب الصداقة (alice تقبل dave) — update ذري', as(db,alice).update('/', {
  [`users/${alice}/friends/${dave}`]:true, [`users/${dave}/friends/${alice}`]:true, [`friendRequests/${alice}/${dave}`]:null }), true);
t('حذف صديق (alice تحذف bob) ذري', as(db,alice).update('/', {
  [`users/${alice}/friends/${bob}`]:null, [`users/${bob}/friends/${alice}`]:null,
  [`friendRequests/${alice}/${bob}`]:null, [`friendRequests/${bob}/${alice}`]:null }), true);

/* ── طلبات الصداقة ── */
t('إرسال طلب (mallory→alice)', as(db,mal).write(`/friendRequests/${alice}/${mal}`, {from:mal,ts:1}), true);
t('[هجوم] طلب مزوّر باسم bob', as(db,mal).write(`/friendRequests/${alice}/${bob}`, {from:bob,ts:1}), false);
t('[هجوم] طلب فيه from مزوّر', as(db,mal).write(`/friendRequests/${alice}/${mal}`, {from:alice,ts:1}), false);
t('[هجوم] alice تنشئ طلباً وهمياً من bob لنفسها', as(db,alice).write(`/friendRequests/${alice}/${bob}`, {from:bob,ts:1}), false);
t('alice ترفض الطلب (تحذفه)', as(db,alice).write(`/friendRequests/${alice}/${dave}`, null), true);
t('القراءة: طلبات alice لـalice', as(db,alice).read(`/friendRequests/${alice}`), true);
t('[خصوصية] mallory تقرأ كل طلبات alice', as(db,mal).read(`/friendRequests/${alice}`), false);
t('mallory تقرأ طلبها هي (فحص "أُرسل مسبقاً")', as(db,mal).read(`/friendRequests/${alice}/${mal}`), true);
t('[هجوم] إضافة صداقة بطلب غير موجود: mallory→dave', as(db,mal).write(`/users/${dave}/friends/${mal}`, true), false);

/* ── الحظر ── */
const dbB = mk({ blockedUsers:{ [alice]:{ [mal]:{blockedAt:1} } } });
t('alice تحظر mallory', as(db,alice).write(`/blockedUsers/${alice}/${mal}`, {blockedAt:1}), true);
t('mallory تفحص هل محظورة (قراءة القيد الخاص بها)', as(dbB,mal).read(`/blockedUsers/${alice}/${mal}`), true);
t('[خصوصية] mallory تقرأ قائمة حظر alice كاملة', as(dbB,mal).read(`/blockedUsers/${alice}`), false);
t('[هجوم] mallory تعدل قائمة حظر alice', as(db,mal).write(`/blockedUsers/${alice}/${bob}`, {blockedAt:1}), false);
t('[فرض الحظر] طلب صداقة من محظورة', as(dbB,mal).write(`/friendRequests/${alice}/${mal}`, {from:mal,ts:1}), false);
t('[فرض الحظر] رسالة خاصة من محظورة', as(dbB,mal).write(`/dmMsgs/${dm(alice,mal)}/m9`, {sender:'mal',text:'x'}), false);
t('رسالة خاصة من غير محظورة', as(db,mal).write(`/dmMsgs/${dm(alice,mal)}/m9`, {sender:mal,text:'x',ts:2}), true);
t('alice (الحاظرة) ما زالت تكتب لمحادثتها', as(dbB,alice).write(`/dmMsgs/${dm(alice,mal)}/m8`, {sender:alice,text:'x',ts:2}), true);

/* ── الرسائل الخاصة ── */
t('alice تقرأ محادثتها مع bob', as(db,alice).read('/dmMsgs/'+dm(alice,bob)), true);
t('[خصوصية] mallory تقرأ محادثة alice/bob', as(db,mal).read('/dmMsgs/'+dm(alice,bob)), false);
t('[هجوم] mallory تكتب في محادثة alice/bob', as(db,mal).write(`/dmMsgs/${dm(alice,bob)}/m2`, {text:'x'}), false);
t('تحديث حالة الرسالة (delivered/read) ذري', as(db,bob).update('/', {[`dmMsgs/${dm(alice,bob)}/m1/status`]:'read'}), true);

/* ── المجموعات: الانضمام ── */
t('الانضمام بالرمز الصحيح', as(db,mal).write('/groups/g1/members/'+mal, 'CODE1'), true);
t('[هجوم] انضمام بقيمة true بدون رمز', as(db,mal).write('/groups/g1/members/'+mal, true), false);
t('[هجوم] انضمام برمز خاطئ', as(db,mal).write('/groups/g1/members/'+mal, 'GUESS'), false);
t('[هجوم] انضمام لمجموعة دعوتها معطّلة برمزها', as(db,mal).write('/groups/g2/members/'+mal, 'CODE2'), false);
t('[هجوم] إضافة شخص آخر برمز صحيح', as(db,mal).write('/groups/g1/members/'+dave, 'CODE1'), false);
t('[خصوصية] mallory تقرأ المجموعة قبل الانضمام', as(db,mal).read('/groups/g1'), false);
t('[خصوصية] mallory تقرأ رسائل مجموعة', as(db,mal).read('/groupMsgs/g1'), false);
t('العضو يقرأ رسائل مجموعته', as(db,bob).read('/groupMsgs/g1'), true);
t('العضو يقرأ المجموعة', as(db,bob).read('/groups/g1'), true);
t('[هجوم] mallory تكتب في groupMsgs', as(db,mal).write('/groupMsgs/g1/mX', {text:'x'}), false);
t('طلب انضمام (pending) لمجموعة موجودة', as(db,mal).write('/groups/g1/pending/'+mal, true), true);
t('[هجوم] طلب انضمام لمجموعة غير موجودة', as(db,mal).write('/groups/ghost/pending/'+mal, true), false);
t('[هجوم] mallory تضع طلب باسم غيرها', as(db,mal).write('/groups/g1/pending/'+dave, true), false);
t('الانضمام بالرمز + مسح pending ذاتياً', as(db,mal).write('/groups/g1/pending/'+mal, null), true);
t('index المجموعة عند المستخدم (ذاتي)', as(db,mal).write(`/users/${mal}/groups/g1`, true), true);
t('[هجوم] كتابة index عند شخص آخر', as(db,mal).write(`/users/${alice}/groups/g1`, true), false);

/* ── المجموعات: الإدارة ── */
t('[هجوم] mallory تطرد bob', as(db,mal).write('/groups/g1/members/'+bob, null), false);
t('[هجوم] mallory تضيف نفسها true', as(db,mal).write('/groups/g1/members/'+mal, true), false);
t('المود يضيف عضواً', as(db,carol).write('/groups/g1/members/'+dave, true), true);
t('المود يقبل طلباً (members + pending ذري)', as(db,carol).update('/', {['groups/g1/members/'+dave]:true, ['groups/g1/pending/'+dave]:null}), true);
t('المود يطرد عضواً عادياً (members+mods ذري)', as(db,carol).update('/', {['groups/g1/members/'+bob]:null, ['groups/g1/mods/'+bob]:null}), true);
t('[هجوم] المود يطرد الأدمن', as(db,carol).write('/groups/g1/members/'+alice, null), false);
t('[هجوم] المود يغيّر الأدمن لنفسه', as(db,carol).write('/groups/g1/admin', carol), false);
t('[هجوم] المود يغيّر رمز الدعوة', as(db,carol).write('/groups/g1/inviteCode', 'EVIL'), false);
t('[هجوم] المود يحذف المجموعة', as(db,carol).write('/groups/g1', null), false);
t('المود يعدل اسم/صورة المجموعة (update)', as(db,carol).update('/groups/g1', {name:'N', photo:'p'}), true);
t('الأدمن يعدل رمز الدعوة (تفعيل/تعطيل)', as(db,alice).update('/groups/g1', {inviteActive:false}), true);
t('الأدمن يعيّن مود', as(db,alice).write('/groups/g1/mods/'+bob, true), true);
t('الأدمن ينقل الملكية (ذري)', as(db,alice).update('/', {'groups/g1/admin':bob, ['groups/g1/mods/'+alice]:null, ['groups/g1/mods/'+bob]:null}), true);
t('العضو يغادر (members+mods ذري)', as(db,bob).update('/', {['groups/g1/members/'+bob]:null, ['groups/g1/mods/'+bob]:null}), true);
t('إنشاء مجموعة (الأدمن = أنا)', as(db,alice).write('/groups/g3', {id:'g3',admin:alice,members:{[alice]:true}}), true);
t('[هجوم] إنشاء مجموعة بأدمن شخص آخر', as(db,mal).write('/groups/g4', {id:'g4',admin:alice,members:{[mal]:true}}), false);
t('[هجوم] الكتابة فوق مجموعة موجودة', as(db,mal).write('/groups/g1', {id:'g1',admin:mal}), false);
t('حذف المجموعة (ترتيب الكود الجديد: index أولاً)', as(db,alice).write(`/users/${bob}/groups/g1`, null), true);
t('حذف المجموعة ذري (group+msgs+typing+invite)', as(db,alice).update('/', {'groups/g1':null,'groupMsgs/g1':null,'typing/group/g1':null,'inviteCodes/CODE1':null}), true);

/* ── رموز الدعوة ── */
t('قراءة رمز واحد', as(db,mal).read('/inviteCodes/CODE1'), true);
t('[خصوصية] سحب كل الرموز', as(db,mal).read('/inviteCodes'), false);
t('الأدمن ينشئ رمزاً لمجموعته', as(db,alice).write('/inviteCodes/NEW1', 'g1'), true);
t('[هجوم] غير الأدمن ينشئ رمزاً لمجموعة غيره', as(db,mal).write('/inviteCodes/NEW2', 'g1'), false);
t('[هجوم] الكتابة فوق رمز موجود وتحويله', as(db,mal).write('/inviteCodes/CODE1', 'g2'), false);
t('[هجوم] حذف رمز غيره', as(db,mal).write('/inviteCodes/CODE1', null), false);
t('تجديد الرمز (ذري)', as(db,alice).update('/', {'inviteCodes/CODE1':null,'inviteCodes/NEWC':'g1','groups/g1/inviteCode':'NEWC','groups/g1/inviteActive':true}), true);

/* ── ميزات أخرى كانت مرفوضة تلقائياً ── */
t('تثبيت رسالة DM', as(db,alice).write('/pinnedMsgs/dmMsgs_'+dm(alice,bob), {msgId:'m1'}), true);
t('[هجوم] تثبيت في DM غيرك', as(db,mal).write('/pinnedMsgs/dmMsgs_'+dm(alice,bob), {msgId:'m1'}), false);
t('تثبيت في مجموعة (عضو)', as(db,bob).write('/pinnedMsgs/groupMsgs_g1', {msgId:'m1'}), true);
t('[هجوم] تثبيت في مجموعة (غير عضو)', as(db,mal).write('/pinnedMsgs/groupMsgs_g1', {msgId:'m1'}), false);
t('تصويت (عضو)', as(db,bob).write(`/groupPolls/g1/p1/votes/${bob}`, 1), true);
t('[هجوم] تصويت (غير عضو)', as(db,mal).write(`/groupPolls/g1/p1/votes/${mal}`, 1), false);
t('إشعار: إرسال لشخص (fromUid=أنا)', as(db,mal).write(`/notifications/${alice}/n1`, {type:'friend_request',fromUid:mal,ts:1}), true);
t('إشعار مجموعة (byUid=أنا)', as(db,alice).write(`/notifications/${bob}/n2`, {type:'added',byUid:alice,ts:1}), true);
t('[هجوم] إشعار مزوّر', as(db,mal).write(`/notifications/${alice}/n3`, {type:'x',fromUid:bob}), false);
t('قراءة إشعاراتي', as(db,alice).read(`/notifications/${alice}`), true);
t('[خصوصية] قراءة إشعارات غيري', as(db,mal).read(`/notifications/${alice}`), false);
t('بلاغ', as(db,mal).write('/reports/r1', {reporterUid:mal,targetUid:alice,reason:'x'}), true);
t('[هجوم] بلاغ باسم غيري', as(db,mal).write('/reports/r2', {reporterUid:alice,targetUid:bob}), false);
t('[خصوصية] قراءة البلاغات', as(db,alice).read('/reports'), false);
t('تسجيل مشاهدة قصة (أنا)', as(db,mal).write(`/storyViews/${alice}/s1/${mal}`, {ts:1}), true);
t('[هجوم] مشاهدة مزوّرة باسم غيري', as(db,mal).write(`/storyViews/${alice}/s1/${bob}`, {ts:1}), false);
t('صاحب القصة يقرأ المشاهدين', as(db,alice).read(`/storyViews/${alice}/s1`), true);
t('[خصوصية] غير صاحبها يقرأ المشاهدين', as(db,mal).read(`/storyViews/${alice}/s1`), false);

/* ── بدون تسجيل دخول ── */
t('[بدون دخول] قراءة مجموعة', as(db,null).read('/groups/g1'), false);
t('[بدون دخول] كتابة اسم مستخدم', as(db,null).write('/usernames/hack', 'x'), false);
t('[بدون دخول] قراءة رمز دعوة', as(db,null).read('/inviteCodes/CODE1'), false);

/* ── ما كان يشتغل ويجب أن يبقى ── */
t('presence: كتابة حالتي', as(db,alice).write(`/presence/${alice}`, {online:true}), true);
t('[هجوم] presence: كتابة حالة غيري', as(db,mal).write(`/presence/${alice}`, {online:false}), false);
t('presence: قراءة الكل (الكود يقرأ presence كاملاً)', as(db,alice).read('/presence'), true);
t('typing: كتابة', as(db,alice).write('/typing/dm/k/ali', true), true);
t('typing: قراءة الكل', as(db,alice).read('/typing'), true);
t('readReceipts: كتابة طابعي', as(db,alice).write(`/readReceipts/k/${alice}`, 5), true);
t('[هجوم] readReceipts: طابع غيري', as(db,mal).write(`/readReceipts/k/${alice}`, 5), false);
t('stories: قراءة الكل', as(db,alice).read('/stories'), true);
t('stories: كتابة قصتي', as(db,alice).write(`/stories/${alice}/s1`, {ts:1}), true);
t('[هجوم] stories: قصة باسم غيري', as(db,mal).write(`/stories/${alice}/s1`, {ts:1}), false);


/* ── حذف الحساب (مسار auth.deleteAccount كامل) ── */
t('حذف الحساب: friendRequests/{uid} كاملاً', as(db,alice).write(`/friendRequests/${alice}`, null), true);
t('[هجوم] حذف طلبات شخص آخر كاملةً', as(db,mal).write(`/friendRequests/${alice}`, null), false);
t('[هجوم] إنشاء طلبات عبر الأب', as(db,alice).write(`/friendRequests/${alice}`, {[bob]:{from:bob,ts:1}}), false);
t('حذف الحساب: users/{uid}', as(db,alice).write(`/users/${alice}`, null), true);
t('حذف الحساب: usernames/{name}', as(db,alice).write('/usernames/ali', null), true);
t('حذف الحساب: presence/{uid}', as(db,alice).write(`/presence/${alice}`, null), true);
t('حذف الحساب: stories/{uid}', as(db,alice).write(`/stories/${alice}`, null), true);
t('حذف الحساب: DM كامل', as(db,alice).write('/dmMsgs/'+dm(alice,bob), null), true);
t('حذف الحساب: إزالتي من قائمة صديق', as(db,alice).write(`/users/${bob}/friends/${alice}`, null), true);
t('حذف الحساب: مغادرة مجموعة كعضو (members+mods)', as(db,bob).update('/', {['groups/g1/members/'+bob]:null,['groups/g1/mods/'+bob]:null}), true);

/* ── E2EE ── */
const kpub='{"crv":"P-256","kty":"EC","x":"'+'a'.repeat(43)+'","y":"'+'b'.repeat(43)+'"}';
const kk={pub:kpub,kid:'a'.repeat(32),v:1,ts:1};
t('userKeys: أنشر مفتاحي', as(db,alice).write(`/userKeys/${alice}`, kk), true);
t('[هجوم] userKeys: استبدال مفتاح غيري', as(db,mal).write(`/userKeys/${alice}`, kk), false);
t('userKeys: قراءة مفتاح الغير', as(db,alice).read(`/userKeys/${bob}`), true);
t('[بدون دخول] userKeys قراءة', as(db,null).read(`/userKeys/${bob}`), false);
t('userKeys: حقل زائد مرفوض', as(db,alice).write(`/userKeys/${alice}`, {...kk,evil:1}), false);
t('userKeys: kid بطول خاطئ', as(db,alice).write(`/userKeys/${alice}`, {...kk,kid:'x'}), false);
t('userKeys: حذف مفتاحي', as(db,alice).write(`/userKeys/${alice}`, null), true);
const bk={v:1,salt:'AAAA',iv:'BBBB',ct:'CCCC',iter:250000,ts:1};
t('e2eBackup: أحفظ نسختي', as(db,alice).write(`/userData/${alice}/e2eBackup`, bk), true);
t('[هجوم] e2eBackup: قراءة نسخة غيري', as(db,mal).read(`/userData/${alice}/e2eBackup`), false);
t('[هجوم] e2eBackup: كتابة نسخة غيري', as(db,mal).write(`/userData/${alice}/e2eBackup`, bk), false);
t('e2eBackup: iter صغير مرفوض', as(db,alice).write(`/userData/${alice}/e2eBackup`, {...bk,iter:10}), false);
t('e2eBackup: حقل ناقص مرفوض', as(db,alice).write(`/userData/${alice}/e2eBackup`, {v:1,salt:'A'}), false);
t('DM مشفّر: كتابة رسالة e2e', as(db,alice).write('/dmMsgs/'+dm(alice,bob)+'/m1', {sender:alice,ts:1,type:'text',status:'sent',e2e:{v:1,iv:'A',ct:'B',skid:'k',rkid:'k',spk:'p',rpk:'p'}}), true);

/* ── أجهزة التشفير ── */
const dv={pub:kpub,kid:'a'.repeat(32),v:1,ts:1};
t('userDevices: أنشر جهازي', as(db,alice).write(`/userDevices/${alice}/dev1abcdef01`, dv), true);
t('[هجوم] userDevices: تسجيل جهاز باسم غيري', as(db,mal).write(`/userDevices/${alice}/dev1abcdef01`, dv), false);
t('userDevices: قراءة أجهزة الغير', as(db,alice).read(`/userDevices/${bob}`), true);
t('[بدون دخول] userDevices قراءة', as(db,null).read(`/userDevices/${bob}`), false);
t('userDevices: حقل زائد مرفوض', as(db,alice).write(`/userDevices/${alice}/dev1abcdef01`, {...dv,evil:1}), false);
t('userDevices: معرّف جهاز قصير مرفوض', as(db,alice).write(`/userDevices/${alice}/d1`, dv), false);
t('userDevices: kid بطول خاطئ', as(db,alice).write(`/userDevices/${alice}/dev1abcdef01`, {...dv,kid:'x'}), false);
t('userDevices: حذف جهازي', as(db,alice).write(`/userDevices/${alice}/dev1abcdef01`, null), true);
t('userDevices: حذف كل أجهزتي (حذف الحساب)', as(db,alice).write(`/userDevices/${alice}`, null), true);
t('[هجوم] userDevices: حذف أجهزة غيري', as(db,mal).write(`/userDevices/${alice}`, null), false);

t('typing: كتابة باسمي الحقيقي', as(db,alice).write('/typing/dm/k/ali', true), true);
t('[هجوم] typing: كتابة باسم شخص آخر', as(db,mal).write('/typing/dm/k/ali', true), false);
t('typing: حذف مؤشري', as(db,alice).write('/typing/dm/k/ali', null), true);
t('typing: مجموعة باسمي', as(db,alice).write('/typing/group/g1/ali', true), true);

/* ── تشديد: حجم/بنية الرسائل، الإشعارات، readReceipts ── */
const DMK=dm(alice,bob);
t('رسالة DM عادية', as(db,alice).write('/dmMsgs/'+DMK+'/n1', {sender:alice,ts:1,type:'text',text:'مرحبا',status:'sent'}), true);
t('[هجوم] DM: انتحال المرسل عند الإنشاء', as(db,alice).write('/dmMsgs/'+DMK+'/n2', {sender:bob,ts:1,type:'text',text:'x'}), false);
t('[هجوم] DM: نص ضخم', as(db,alice).write('/dmMsgs/'+DMK+'/n3', {sender:alice,ts:1,type:'text',text:'x'.repeat(6000)}), false);
t('DM: صورة مضمّنة كبيرة مسموحة', as(db,alice).write('/dmMsgs/'+DMK+'/n4', {sender:alice,ts:1,type:'image',url:'d'.repeat(3000000)}), true);
t('[هجوم] DM: url ضخم جداً', as(db,alice).write('/dmMsgs/'+DMK+'/n5', {sender:alice,ts:1,type:'image',url:'d'.repeat(9500000)}), false);
t('[هجوم] DM: بلا sender/ts', as(db,alice).write('/dmMsgs/'+DMK+'/n6', {type:'text',text:'x'}), false);
t('DM مشفّر: e2e بحجم معقول', as(db,alice).write('/dmMsgs/'+DMK+'/n7', {sender:alice,ts:1,type:'text',e2e:{v:1,iv:'A',ct:'B'.repeat(2000000),skid:'k',spk:'p',w:{kk:{iv:'A',ct:'B'}}}}), true);
t('[هجوم] DM مشفّر: ct ضخم', as(db,alice).write('/dmMsgs/'+DMK+'/n8', {sender:alice,ts:1,type:'text',e2e:{v:1,iv:'A',ct:'B'.repeat(13000000),skid:'k',spk:'p',w:{}}}), false);
t('تفاعل على رسالة موجودة (الطرف الآخر)', as(db,bob).write('/dmMsgs/'+DMK+'/m1/reactions/%E2%9D%A4/'+bob, true), true);
t('تعديل رسالتي', as(db,alice).update('/dmMsgs/'+DMK+'/m1', {text:'معدل',edited:true,editedAt:2}), true);
t('حذف رسالتي (placeholder)', as(db,alice).write('/dmMsgs/'+DMK+'/m1', {id:'m1',sender:'ali',ts:1,deleted:true,deletedAt:3}), true);
t('رسالة مجموعة عادية', as(db,alice).write('/groupMsgs/g1/q1', {sender:alice,ts:1,type:'text',text:'hi'}), true);
t('[هجوم] مجموعة: انتحال مرسل', as(db,alice).write('/groupMsgs/g1/q2', {sender:bob,ts:1,type:'text',text:'x'}), false);
t('[هجوم] مجموعة: غير عضو', as(db,mal).write('/groupMsgs/g1/q3', {sender:mal,ts:1,type:'text',text:'x'}), false);
t('إشعار سليم', as(db,alice).write('/notifications/'+bob+'/x1', {type:'friend_request',fromUid:alice,ts:1,read:false}), true);
t('[هجوم] إشعار نص ضخم', as(db,alice).write('/notifications/'+bob+'/x2', {type:'t',fromUid:alice,ts:1,pad:'x'.repeat(600)}), false);
t('[هجوم] إشعار بلا type', as(db,alice).write('/notifications/'+bob+'/x3', {fromUid:alice,ts:1}), false);
t('readReceipts: قراءة طرف المحادثة', as(db,alice).read('/readReceipts/'+DMK+'/'+bob), true);
t('[خصوصية] readReceipts: غير طرف', as(db,mal).read('/readReceipts/'+DMK+'/'+bob), false);
t('readReceipts: عضو مجموعة يقرأ', as(db,bob).read('/readReceipts/group_g1/'+alice), true);
t('[خصوصية] readReceipts: غير عضو مجموعة', as(db,mal).read('/readReceipts/group_g1/'+alice), false);

console.log(`\nالملف: ${which.split('/').pop()}  —  نجح ${pass} / فشل ${fail}`);
failures.forEach(f=>console.log('  ✗', f));
process.exit(fail?1:0);
