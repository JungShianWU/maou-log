// Firestore 安全規則測試（在模擬器上跑：npm run test:rules）
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { EDITOR_UIDS } from '../firebase-config.js';

const EDITOR = EDITOR_UIDS[0];
const OTHER = 'someone-else';
// e1 修改前的內容（beforeEach 種的資料）＋這次是誰改的
const e1Hist = (by, action = 'edit', t = 2) => [{ at: 1, status: 'work', note: '', action, by, t }];
let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'maou-log-jt2c4',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
after(() => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'boards/main'), { templates: {}, overrides: {} });
    // OTHER 是已登記的冒險者
    await setDoc(doc(db, 'adventurers/' + OTHER), { masked: 'so***@e***.com', joinedAt: 1 });
    await setDoc(doc(db, 'boards/main/bosses/b30'), { level: 30, name: '魔王', note: '', by: EDITOR });
    await setDoc(doc(db, 'boards/main/events/e1'), { boss: 'b30', at: 1, status: 'work', note: '', reporter: EDITOR, by: EDITOR });
  });
});

const guest = () => env.unauthenticatedContext().firestore();
const editor = () => env.authenticatedContext(EDITOR).firestore();
const other = () => env.authenticatedContext(OTHER).firestore();
const event = (extra = {}) => ({ boss: 'b30', at: Date.now(), status: 'work', note: '', reporter: EDITOR, by: EDITOR, ...extra });
const boss = (extra = {}) => ({ level: 50, name: '魔王', note: '愛喝咖啡', by: EDITOR, ...extra });
const leave = (extra = {}) => ({ boss: 'b30', date: '2026-11-25', kind: 'full', type: '🎫 特休券', note: '', reporter: EDITOR, by: EDITOR, ...extra });

test('觀戰：不用登入就能讀看板、魔王與日誌', async () => {
  await assertSucceeds(getDoc(doc(guest(), 'boards/main')));
  await assertSucceeds(getDoc(doc(guest(), 'boards/main/bosses/b30')));
  await assertSucceeds(getDoc(doc(guest(), 'boards/main/events/e1')));
});

test('觀戰：未登入不能寫、不能刪', async () => {
  await assertFails(setDoc(doc(guest(), 'boards/main/events/x'), event()));
  await assertFails(deleteDoc(doc(guest(), 'boards/main/events/e1')));
  await assertFails(setDoc(doc(guest(), 'boards/main'), { templates: {} }));
});

test('登入的冒險者：可以提供情報（新增、修改任何人的），不能隱藏、不能刪、不能改設定', async () => {
  const mine = { by: OTHER, reporter: OTHER };
  await assertSucceeds(setDoc(doc(other(), 'boards/main/events/x'), event(mine)));
  await assertSucceeds(setDoc(doc(other(), 'boards/main/leaves/x'), leave(mine)));
  await assertSucceeds(setDoc(doc(other(), 'boards/main/bosses/b70'), boss({ by: OTHER })));
  // 修改 GM 記的：情報提供者不變，by 換成自己
  await assertSucceeds(setDoc(doc(other(), 'boards/main/events/e1'), event({ status: 'off', by: OTHER, history: e1Hist(OTHER) })));
  // 隱藏、刪除都不行
  await assertFails(setDoc(doc(other(), 'boards/main/events/e1'), { deleted: true, deletedAt: 1, by: OTHER }, { merge: true }));
  await assertFails(setDoc(doc(other(), 'boards/main/bosses/b30'), { deleted: true, deletedAt: 1, by: OTHER }, { merge: true }));
  await assertFails(deleteDoc(doc(other(), 'boards/main/events/e1')));
  // 不能冒用別人、不能改看板設定
  await assertFails(setDoc(doc(other(), 'boards/main/events/y'), event({ by: EDITOR, reporter: OTHER })));
  await assertFails(setDoc(doc(other(), 'boards/main'), { templates: {}, overrides: {} }));
});

test('編輯者可以新增、修改日誌；刪除只能標記隱藏，不能真的刪', async () => {
  await assertSucceeds(setDoc(doc(editor(), 'boards/main/events/x'), event({ note: '旁白' })));
  await assertFails(deleteDoc(doc(editor(), 'boards/main/events/e1')));
  // 隱藏也要附加修改歷史
  await assertSucceeds(setDoc(doc(editor(), 'boards/main/events/e1'), { deleted: true, deletedAt: Date.now(), by: EDITOR, history: e1Hist(EDITOR, 'hide') }, { merge: true }));
  await assertFails(setDoc(doc(editor(), 'boards/main/events/e1'), { deleted: 'yes', by: EDITOR }, { merge: true }));
  await assertFails(deleteDoc(doc(editor(), 'boards/main')));
});

test('修改歷史：每次修改都要附加一筆真實的修改前內容，舊的不能改', async () => {
  const ref = (db) => doc(db, 'boards/main/events/e1');
  // 沒附加歷史就改 → 擋
  await assertFails(setDoc(ref(editor()), event({ status: 'off' })));
  // 附加的「修改前內容」是假的 → 擋
  await assertFails(setDoc(ref(editor()), event({ status: 'off', history: [{ at: 1, status: 'nap', note: '', action: 'edit', by: EDITOR, t: 2 }] })));
  // 冒用別人名義 → 擋
  await assertFails(setDoc(ref(other()), event({ status: 'off', by: OTHER, history: e1Hist(EDITOR) })));
  // 正確附加 → 可以
  await assertSucceeds(setDoc(ref(editor()), event({ at: 5, status: 'off', history: e1Hist(EDITOR) })));
  // 下一次修改竄改舊歷史 → 擋；正確附加 → 可以
  const second = { at: 5, status: 'off', note: '', action: 'edit', by: OTHER, t: 3 };
  await assertFails(setDoc(ref(other()), event({ at: 6, by: OTHER, history: [{ ...e1Hist(EDITOR)[0], status: 'nap' }, second] })));
  await assertSucceeds(setDoc(ref(other()), event({ at: 6, by: OTHER, history: [...e1Hist(EDITOR), second] })));
  // 新增時不能自帶歷史
  await assertFails(setDoc(doc(other(), 'boards/main/events/z'), event({ by: OTHER, reporter: OTHER, history: e1Hist(OTHER) })));
});

test('已隱藏的資料：冒險者不能還原或修改；GM 可以', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'boards/main/events/h1'), { boss: 'b30', at: 1, status: 'work', note: '', reporter: EDITOR, by: EDITOR, deleted: true, deletedAt: 1 });
    await setDoc(doc(db, 'boards/main/bosses/h2'), { level: 9, name: '魔王', note: '', by: EDITOR, deleted: true, deletedAt: 1 });
  });
  const hist = (by) => [{ at: 1, status: 'work', note: '', action: 'edit', by, t: 2 }];
  await assertFails(setDoc(doc(other(), 'boards/main/events/h1'), event({ at: 1, by: OTHER, history: hist(OTHER) })));
  await assertFails(setDoc(doc(other(), 'boards/main/bosses/h2'), boss({ level: 9, by: OTHER })));
  await assertSucceeds(setDoc(doc(editor(), 'boards/main/events/h1'), event({ at: 1, history: hist(EDITOR) })));
});

test('修改時不能換魔王、不能改記錄時間；「隱藏」歷史必須真的隱藏', async () => {
  const ref = doc(other(), 'boards/main/events/e1');
  const h = (action) => [{ at: 1, status: 'work', note: '', action, by: OTHER, t: 2 }];
  await assertFails(setDoc(ref, event({ at: 1, boss: 'b50', by: OTHER, history: h('edit') })));
  await assertFails(setDoc(ref, event({ at: 1, loggedAt: 123, by: OTHER, history: h('edit') })));
  // 冒險者假裝「隱藏」但沒隱藏 → 擋
  await assertFails(setDoc(ref, event({ at: 1, by: OTHER, history: h('hide') })));
  // GM 標「修正」卻設成隱藏 → 擋
  await assertFails(setDoc(doc(editor(), 'boards/main/events/e1'), { deleted: true, deletedAt: 1, by: EDITOR,
    history: [{ at: 1, status: 'work', note: '', action: 'edit', by: EDITOR, t: 2 }] }, { merge: true }));
  await assertSucceeds(setDoc(ref, event({ at: 1, by: OTHER, history: h('edit') })));
});

test('舊資料沒有 reporter：修改時只能補上原本的記錄者', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'boards/main/events/old'), { boss: 'b30', at: 1, status: 'work', note: '', by: EDITOR });
  });
  const h = [{ at: 1, status: 'work', note: '', action: 'edit', by: OTHER, t: 2 }];
  const { reporter: _r, ...noReporter } = event({ at: 1, by: OTHER, history: h });
  await assertFails(setDoc(doc(other(), 'boards/main/events/old'), { ...noReporter, reporter: OTHER }));
  await assertSucceeds(setDoc(doc(other(), 'boards/main/events/old'), { ...noReporter, reporter: EDITOR }));
});

test('GM 讀取存檔可保留原本的情報提供者與歷史；冒險者不行', async () => {
  const h = [{ at: 1, status: 'work', note: '', action: 'edit', by: OTHER, t: 2 }];
  await assertSucceeds(setDoc(doc(editor(), 'boards/main/events/imp'), event({ reporter: OTHER, history: h })));
  await assertFails(setDoc(doc(other(), 'boards/main/events/imp2'), event({ reporter: EDITOR, by: OTHER })));
  await assertFails(setDoc(doc(other(), 'boards/main/events/imp3'), event({ reporter: OTHER, by: OTHER, history: h })));
});

test('修改歷史上限 50 次：再修改會被擋，但 GM 仍可隱藏', async () => {
  const full = Array.from({ length: 50 }, (_, i) => ({ at: 1, status: 'work', note: '', action: 'edit', by: EDITOR, t: i }));
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'boards/main/events/f1'), { boss: 'b30', at: 1, status: 'work', note: '', reporter: EDITOR, by: EDITOR, history: full });
  });
  const next = (action) => [...full, { at: 1, status: 'work', note: '', action, by: EDITOR, t: 99 }];
  await assertFails(setDoc(doc(editor(), 'boards/main/events/f1'), event({ at: 1, history: next('edit') })));
  await assertSucceeds(setDoc(doc(editor(), 'boards/main/events/f1'), { deleted: true, deletedAt: 1, by: EDITOR, history: next('hide') }, { merge: true }));
});

test('情報提供者 reporter：新增時必須是本人，之後不能換人', async () => {
  await assertFails(setDoc(doc(other(), 'boards/main/events/r1'), event({ by: OTHER, reporter: EDITOR })));
  await assertSucceeds(setDoc(doc(editor(), 'boards/main/events/r2'), (({ reporter, ...e }) => e)(event()))); // 舊版程式不帶 reporter
  await assertFails(setDoc(doc(editor(), 'boards/main/events/e1'), event({ reporter: OTHER })));
  await assertSucceeds(setDoc(doc(editor(), 'boards/main/leaves/r3'), leave()));
  await assertFails(setDoc(doc(editor(), 'boards/main/leaves/r3'), leave({ reporter: OTHER })));
});

test('魔王：編輯者可新增修改刪除；等級、名稱、備註格式不對就擋下', async () => {
  await assertSucceeds(setDoc(doc(editor(), 'boards/main/bosses/b50'), boss()));
  // 修改魔王也要附加修改歷史（修改前的等級、名稱、備註）
  const h1 = { level: 30, name: '魔王', note: '', action: 'edit', by: EDITOR, t: 2 };
  await assertFails(setDoc(doc(editor(), 'boards/main/bosses/b30'), boss({ level: 31, note: '升級了' })));
  await assertFails(setDoc(doc(editor(), 'boards/main/bosses/b30'), boss({ level: 31, note: '升級了', history: [{ ...h1, level: 99 }] })));
  await assertSucceeds(setDoc(doc(editor(), 'boards/main/bosses/b30'), boss({ level: 31, note: '升級了', history: [h1] })));
  // 等級只能提升，不能降低
  const h1b = { level: 31, name: '魔王', note: '升級了', action: 'edit', by: EDITOR, t: 3 };
  await assertFails(setDoc(doc(editor(), 'boards/main/bosses/b30'), boss({ level: 30, note: '升級了', history: [h1, h1b] })));
  await assertFails(deleteDoc(doc(editor(), 'boards/main/bosses/b30')));
  const h2 = { level: 31, name: '魔王', note: '升級了', action: 'hide', by: EDITOR, t: 3 };
  await assertSucceeds(setDoc(doc(editor(), 'boards/main/bosses/b30'), { deleted: true, deletedAt: 1, by: EDITOR, history: [h1, h2] }, { merge: true }));
  await assertFails(setDoc(doc(editor(), 'boards/main/bosses/x'), boss({ level: 0 })));
  await assertFails(setDoc(doc(editor(), 'boards/main/bosses/x'), boss({ level: 1.5 })));
  await assertFails(setDoc(doc(editor(), 'boards/main/bosses/x'), boss({ name: '' })));
  await assertFails(setDoc(doc(editor(), 'boards/main/bosses/x'), boss({ note: 'x'.repeat(201) })));
  await assertFails(setDoc(doc(editor(), 'boards/main/bosses/x'), boss({ by: OTHER })));
  await assertFails(setDoc(doc(guest(), 'boards/main/bosses/x'), boss()));
});

test('日誌與閉關必須指定魔王', async () => {
  const { boss: _b, ...noBoss } = event();
  await assertFails(setDoc(doc(editor(), 'boards/main/events/x'), noBoss));
  const { boss: _l, ...leaveNoBoss } = leave();
  await assertFails(setDoc(doc(editor(), 'boards/main/leaves/x'), leaveNoBoss));
});

test('日誌：by 必須是寫入者本人', async () => {
  await assertFails(setDoc(doc(editor(), 'boards/main/events/x'), event({ by: OTHER })));
  const { by, ...noBy } = event();
  await assertFails(setDoc(doc(editor(), 'boards/main/events/x'), noBy));
});

test('日誌：在家修煉（remote）、發呆摸魚（slack）是合法狀態', async () => {
  await assertSucceeds(setDoc(doc(editor(), 'boards/main/events/r'), event({ status: 'remote' })));
  await assertSucceeds(setDoc(doc(editor(), 'boards/main/events/s'), event({ status: 'slack' })));
  // 傳聞：旁白必填
  await assertFails(setDoc(doc(editor(), 'boards/main/events/u1'), event({ status: 'rumor', note: '' })));
  await assertFails(setDoc(doc(editor(), 'boards/main/events/u3'), event({ status: 'rumor', note: '   ' })));
  await assertSucceeds(setDoc(doc(editor(), 'boards/main/events/u4'), event({ status: 'rumor', note: '甲說\n乙說' })));
  await assertSucceeds(setDoc(doc(editor(), 'boards/main/events/u2'), event({ status: 'rumor', note: '聽說他今天要開會' })));
});

test('記錄時間 loggedAt：選填，必須是數字', async () => {
  await assertSucceeds(setDoc(doc(editor(), 'boards/main/events/l1'), event({ loggedAt: Date.now() })));
  await assertSucceeds(setDoc(doc(editor(), 'boards/main/leaves/l2'), leave({ loggedAt: Date.now() })));
  await assertFails(setDoc(doc(editor(), 'boards/main/events/l3'), event({ loggedAt: '14:20' })));
  await assertFails(setDoc(doc(editor(), 'boards/main/leaves/l4'), leave({ loggedAt: '14:20' })));
});

test('日誌：狀態、欄位、長度不合法就擋下', async () => {
  await assertFails(setDoc(doc(editor(), 'boards/main/events/x'), event({ status: 'hack' })));
  await assertFails(setDoc(doc(editor(), 'boards/main/events/x'), event({ admin: true })));
  await assertFails(setDoc(doc(editor(), 'boards/main/events/x'), event({ note: 'x'.repeat(101) })));
  await assertFails(setDoc(doc(editor(), 'boards/main/events/x'), event({ at: '09:00' })));
});

test('閉關：合法資料可寫，日期與自訂時段格式不對就擋下', async () => {
  await assertSucceeds(setDoc(doc(editor(), 'boards/main/leaves/a'), leave()));
  await assertSucceeds(setDoc(doc(editor(), 'boards/main/leaves/b'), leave({ kind: 'custom', start: '14:00', end: '16:00' })));
  await assertFails(setDoc(doc(editor(), 'boards/main/leaves/c'), leave({ date: '2026/11/25' })));
  await assertFails(setDoc(doc(editor(), 'boards/main/leaves/d'), leave({ kind: 'custom', start: '<img>', end: '16:00' })));
  await assertFails(setDoc(doc(editor(), 'boards/main/leaves/e'), leave({ kind: 'forever' })));
  await assertFails(setDoc(doc(editor(), 'boards/main/leaves/f'), leave({ by: OTHER })));
});

test('看板設定：只能有 templates、overrides，且必須是 map', async () => {
  await assertSucceeds(setDoc(doc(editor(), 'boards/main'), { templates: { lunch: 'x' }, overrides: {} }));
  await assertFails(setDoc(doc(editor(), 'boards/main'), { templates: 'x' }));
  await assertFails(setDoc(doc(editor(), 'boards/main'), { templates: {}, editors: [OTHER] }));
});

test('冒險者清單：只能登記自己、只能存去識別化的 email，任何人可看', async () => {
  const me = (uid) => env.authenticatedContext(uid).firestore();
  await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), 'boards/main'), { signupOpen: true }); });
  await assertSucceeds(setDoc(doc(me('u1'), 'adventurers/u1'), { masked: 'jo***@g***.com', joinedAt: 1 }));
  await assertSucceeds(getDoc(doc(guest(), 'adventurers/u1')));
  await assertFails(setDoc(doc(me('u1'), 'adventurers/u2'), { masked: 'jo***@g***.com', joinedAt: 1 }));
  await assertFails(setDoc(doc(me('u1'), 'adventurers/u1'), { masked: 'john@gmail.com', joinedAt: 1 }));
  await assertFails(setDoc(doc(me('u1'), 'adventurers/u1'), { masked: 'jo***@g***.com', joinedAt: 1, email: 'john@gmail.com' }));
  await assertFails(setDoc(doc(guest(), 'adventurers/u3'), { masked: 'jo***@g***.com', joinedAt: 1 }));
});

test('註冊開關：關閉時新帳號不能登記、也不能寫；開放後可以；已登記的不受影響', async () => {
  const me = (uid) => env.authenticatedContext(uid).firestore();
  const adv = { masked: 'ne***@e***.com', joinedAt: 1 };
  // 預設關閉
  await assertFails(setDoc(doc(me('new1'), 'adventurers/new1'), adv));
  await assertFails(setDoc(doc(me('new1'), 'boards/main/events/n1'), event({ by: 'new1', reporter: 'new1' })));
  await assertSucceeds(setDoc(doc(other(), 'boards/main/events/n2'), event({ by: OTHER, reporter: OTHER })));
  // 只有 GM 能切換
  await assertFails(setDoc(doc(other(), 'boards/main'), { signupOpen: true }, { merge: true }));
  await assertFails(setDoc(doc(editor(), 'boards/main'), { signupOpen: 'yes' }, { merge: true }));
  await assertSucceeds(setDoc(doc(editor(), 'boards/main'), { signupOpen: true }, { merge: true }));
  await assertSucceeds(setDoc(doc(me('new1'), 'adventurers/new1'), adv));
  await assertSucceeds(setDoc(doc(me('new1'), 'boards/main/events/n3'), event({ by: 'new1', reporter: 'new1' })));
});

test('只能寫 main 看板', async () => {
  await assertFails(setDoc(doc(editor(), 'boards/other'), { templates: {} }));
  await assertFails(setDoc(doc(editor(), 'boards/other/events/x'), event()));
});

test('造訪紀錄：未登入寫自己的裝置、登入寫自己的帳號（只收 4 碼代號），只有 GM 看得到', async () => {
  const id = 'AbCdEfGhIjKlMnOpQrSt';
  const v = (extra = {}) => ({ uid: '', ip: 'a3f9', at: serverTimestamp(), ...extra });
  await assertSucceeds(setDoc(doc(guest(), 'visits/' + id), v()));
  await assertSucceeds(setDoc(doc(guest(), 'visits/' + id), v({ ip: '' }))); // 查不到 IP
  await assertSucceeds(setDoc(doc(other(), 'visits/u_' + OTHER), v({ uid: OTHER })));
  await assertFails(setDoc(doc(other(), 'visits/' + id), v({ uid: OTHER }))); // 帳號的紀錄只能放在 u_<uid>
  await assertFails(setDoc(doc(other(), 'visits/u_' + EDITOR), v({ uid: OTHER })));
  await assertFails(setDoc(doc(guest(), 'visits/u_' + OTHER), v())); // 未登入不能寫帳號的紀錄
  await assertFails(setDoc(doc(guest(), 'visits/' + id), v({ ip: '203.69.1.2' }))); // 不收完整 IP
  await assertFails(setDoc(doc(guest(), 'visits/' + id), v({ uid: OTHER }))); // 不能冒用別人
  await assertFails(setDoc(doc(other(), 'visits/u_' + EDITOR), v({ uid: EDITOR })));
  await assertFails(setDoc(doc(guest(), 'visits/' + id), v({ at: 1 }))); // 時間由伺服器決定
  await assertFails(setDoc(doc(guest(), 'visits/' + id), v({ extra: 1 })));
  await assertFails(setDoc(doc(guest(), 'visits/short'), v()));
  await assertFails(getDoc(doc(guest(), 'visits/' + id)));
  await assertFails(getDoc(doc(other(), 'visits/' + id)));
  await assertSucceeds(getDoc(doc(editor(), 'visits/' + id)));
  await assertFails(deleteDoc(doc(editor(), 'visits/' + id)));
});

test('暫時關閉網站：只有 GM 看得到魔王、日誌、閉關；冒險者不能提供情報；看板設定仍公開', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'boards/main'), { templates: {}, overrides: {}, siteOpen: false, closedNote: '整修中' });
  });
  await assertSucceeds(getDoc(doc(guest(), 'boards/main'))); // 要知道網站關閉了
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'boards/main/leaves/l1'), leave());
  });
  for (const p of ['boards/main/bosses/b30', 'boards/main/events/e1', 'boards/main/leaves/l1']) {
    await assertFails(getDoc(doc(guest(), p)));
    await assertFails(getDoc(doc(other(), p)));
    await assertSucceeds(getDoc(doc(editor(), p)));
  }
  await assertFails(setDoc(doc(other(), 'boards/main/events/n1'), event({ by: OTHER, reporter: OTHER })));
  await assertFails(setDoc(doc(other(), 'boards/main/bosses/nb'), boss({ by: OTHER })));
  await assertFails(setDoc(doc(other(), 'boards/main/leaves/nl'), leave({ by: OTHER, reporter: OTHER })));
  await assertSucceeds(setDoc(doc(editor(), 'boards/main/events/n2'), event()));
  // 只有 GM 能切換；格式檢查
  await assertFails(setDoc(doc(other(), 'boards/main'), { siteOpen: true }, { merge: true }));
  await assertSucceeds(setDoc(doc(editor(), 'boards/main'), { siteOpen: true, closedNote: '' }, { merge: true }));
  await assertFails(setDoc(doc(editor(), 'boards/main'), { siteOpen: 'yes' }, { merge: true }));
  await assertFails(setDoc(doc(editor(), 'boards/main'), { closedNote: 'x'.repeat(61) }, { merge: true }));
  // 重新開放後恢復
  await assertSucceeds(getDoc(doc(guest(), 'boards/main/bosses/b30')));
  await assertSucceeds(setDoc(doc(other(), 'boards/main/events/n3'), event({ by: OTHER, reporter: OTHER })));
});

test('還沒有看板設定時視為開放（任何人都能讀）', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => { await deleteDoc(doc(ctx.firestore(), 'boards/main')); });
  await assertSucceeds(getDoc(doc(guest(), 'boards/main/bosses/b30')));
  await assertSucceeds(setDoc(doc(other(), 'boards/main/events/n1'), event({ by: OTHER, reporter: OTHER })));
});

test('定時開放：時段外只有 GM 讀得到、冒險者不能寫；時段由 GM 設定且格式要對', async () => {
  // 以模擬器的現在時間（台灣時間）判斷：模擬器無法固定 request.time，所以「平日放行／週末拒絕」只會驗到今天是哪一種；
  // 星期與邊界的完整情況由 rules.test.js 的 inOpenHours 單元測試涵蓋。午夜前後執行可能偶發失敗
  const t = new Date(Date.now() + 8 * 3600_000);
  const m = t.getUTCHours() * 60 + t.getUTCMinutes();
  const weekday = t.getUTCDay() >= 1 && t.getUTCDay() <= 5;
  const set = (data) => env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'boards/main'), { templates: {}, overrides: {}, ...data });
  });
  // 時段不包含現在：關閉
  const [from, to] = m < 720 ? [m + 30, m + 60] : [0, 30];
  await set({ hoursOn: true, openFrom: from, openTo: to });
  await assertFails(getDoc(doc(guest(), 'boards/main/bosses/b30')));
  await assertFails(setDoc(doc(other(), 'boards/main/events/n1'), event({ by: OTHER, reporter: OTHER })));
  await assertSucceeds(getDoc(doc(editor(), 'boards/main/bosses/b30')));
  await assertSucceeds(getDoc(doc(guest(), 'boards/main')));
  // 時段包住現在（台灣時間）：平日開放、週末關閉；規則若用錯時區就會失敗
  if (m >= 10 && m <= 1428) {
    await set({ hoursOn: true, openFrom: m - 10, openTo: m + 10 });
    const now = getDoc(doc(guest(), 'boards/main/bosses/b30'));
    await (weekday ? assertSucceeds(now) : assertFails(now));
  }
  // 停用定時：照手動開關
  await set({ hoursOn: false, openFrom: from, openTo: to });
  await assertSucceeds(getDoc(doc(guest(), 'boards/main/bosses/b30')));
  // 整天的時段：平日開放、週末關閉
  await set({ hoursOn: true, openFrom: 0, openTo: 1439 });
  const all = getDoc(doc(guest(), 'boards/main/bosses/b30'));
  await (weekday && m < 1439 ? assertSucceeds(all) : assertFails(all));
  // 手動關閉優先
  await set({ hoursOn: true, openFrom: 0, openTo: 1439, siteOpen: false });
  await assertFails(getDoc(doc(guest(), 'boards/main/bosses/b30')));
  // 只有 GM 能設定；格式檢查
  await assertFails(setDoc(doc(other(), 'boards/main'), { hoursOn: false }, { merge: true }));
  await assertSucceeds(setDoc(doc(editor(), 'boards/main'), { hoursOn: true, openFrom: 540, openTo: 1020 }, { merge: true }));
  await assertFails(setDoc(doc(editor(), 'boards/main'), { hoursOn: 'yes' }, { merge: true }));
  await assertFails(setDoc(doc(editor(), 'boards/main'), { openFrom: 1020, openTo: 540 }, { merge: true }));
  await assertFails(setDoc(doc(editor(), 'boards/main'), { openFrom: 1020, openTo: 1020 }, { merge: true }));
  await assertFails(setDoc(doc(editor(), 'boards/main'), { openFrom: 0, openTo: 1440 }, { merge: true }));
  await assertFails(setDoc(doc(editor(), 'boards/main'), { openFrom: 9.5, openTo: 1000 }, { merge: true }));
});
