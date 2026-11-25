// Firestore 安全規則測試（在模擬器上跑：npm run test:rules）
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, deleteDoc } from 'firebase/firestore';
import { EDITOR_UIDS } from '../firebase-config.js';

const EDITOR = EDITOR_UIDS[0];
const OTHER = 'someone-else';
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
    await setDoc(doc(db, 'boards/main/bosses/b30'), { level: 30, name: '魔王', note: '', by: EDITOR });
    await setDoc(doc(db, 'boards/main/events/e1'), { boss: 'b30', at: 1, status: 'work', note: '', by: EDITOR });
  });
});

const guest = () => env.unauthenticatedContext().firestore();
const editor = () => env.authenticatedContext(EDITOR).firestore();
const other = () => env.authenticatedContext(OTHER).firestore();
const event = (extra = {}) => ({ boss: 'b30', at: Date.now(), status: 'work', note: '', by: EDITOR, ...extra });
const boss = (extra = {}) => ({ level: 50, name: '魔王', note: '愛喝咖啡', by: EDITOR, ...extra });
const leave = (extra = {}) => ({ boss: 'b30', date: '2026-11-25', kind: 'full', type: '🎫 特休券', note: '', by: EDITOR, ...extra });

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

test('非編輯者登入也不能寫、不能刪', async () => {
  await assertFails(setDoc(doc(other(), 'boards/main/events/x'), event({ by: OTHER })));
  await assertFails(deleteDoc(doc(other(), 'boards/main/events/e1')));
  await assertFails(setDoc(doc(other(), 'boards/main/leaves/x'), leave({ by: OTHER })));
});

test('編輯者可以新增、修改、刪除日誌', async () => {
  await assertSucceeds(setDoc(doc(editor(), 'boards/main/events/x'), event({ note: '旁白' })));
  await assertSucceeds(setDoc(doc(editor(), 'boards/main/events/e1'), event({ status: 'off' })));
  await assertSucceeds(deleteDoc(doc(editor(), 'boards/main/events/e1')));
});

test('魔王：編輯者可新增修改刪除；等級、名稱、備註格式不對就擋下', async () => {
  await assertSucceeds(setDoc(doc(editor(), 'boards/main/bosses/b50'), boss()));
  await assertSucceeds(setDoc(doc(editor(), 'boards/main/bosses/b30'), boss({ level: 31, note: '升級了' })));
  await assertSucceeds(deleteDoc(doc(editor(), 'boards/main/bosses/b30')));
  await assertFails(setDoc(doc(editor(), 'boards/main/bosses/x'), boss({ level: 0 })));
  await assertFails(setDoc(doc(editor(), 'boards/main/bosses/x'), boss({ level: 1.5 })));
  await assertFails(setDoc(doc(editor(), 'boards/main/bosses/x'), boss({ name: '' })));
  await assertFails(setDoc(doc(editor(), 'boards/main/bosses/x'), boss({ note: 'x'.repeat(201) })));
  await assertFails(setDoc(doc(editor(), 'boards/main/bosses/x'), boss({ by: OTHER })));
  await assertFails(setDoc(doc(other(), 'boards/main/bosses/x'), boss({ by: OTHER })));
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

test('日誌：在家修煉（remote）是合法狀態', async () => {
  await assertSucceeds(setDoc(doc(editor(), 'boards/main/events/r'), event({ status: 'remote' })));
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

test('只能寫 main 看板', async () => {
  await assertFails(setDoc(doc(editor(), 'boards/other'), { templates: {} }));
  await assertFails(setDoc(doc(editor(), 'boards/other/events/x'), event()));
});
