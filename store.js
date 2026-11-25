// 資料儲存層：Firebase Auth（Email 登入）+ Firestore。
// 公開看板：任何人不用登入就能看，只有 EDITOR_UIDS 裡的帳號能改（由 firestore.rules 把關）。
// 冒險者清單：adventurers/{uid}   { masked, joinedAt }（只存去識別化的 email）
// 資料結構：boards/main            { templates, overrides }（所有魔王共用）
//           boards/main/bosses/{id} { level, name, note, by }
//           boards/main/events/{id} { boss, at, status, note, loggedAt, by }
//           boards/main/leaves/{id} { boss, date, kind, type, note, start?, end?, loggedAt, by }
// at = 發生時間；loggedAt = 按下記錄的時間（修改時保留最初的值）
// reporter = 情報提供者（新增的人，之後不會換）；by = 最後寫入者
// 刪除只做標記 deleted / deletedAt（畫面預設不顯示），資料庫保留完整紀錄；安全規則禁止真的刪除
// 快取裡保留已隱藏的資料，由畫面決定要不要顯示
// history = 修改歷史：每次修改或隱藏，附加一筆「修改前的內容」＋誰（by）、何時（t）；安全規則強制只能附加、不能竄改
// by = 最後寫入者的 uid（多人編輯時可追查是誰記的）
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut, connectAuthEmulator,
} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache, connectFirestoreEmulator,
  collection, doc, setDoc, getDoc, getDocs, onSnapshot, writeBatch, deleteField, runTransaction,
  query, orderBy, limit, serverTimestamp as fsServerTime,
} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js';
import {
  getDatabase, ref, push, set, remove, onValue, onDisconnect, serverTimestamp, connectDatabaseEmulator,
} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-database.js';
import { firebaseConfig, EDITOR_UIDS } from './firebase-config.js';
import { DEFAULT_TEMPLATES, STATUSES, LEAVE_KINDS, maskEmail } from './rules.js';

// 測試用：本機網址加上 ?emulator 時改連 Firebase 模擬器（npm run test:e2e）
const EMULATOR = ['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('emulator');

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, {
  localCache: EMULATOR ? memoryLocalCache() : persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
const rtdb = getDatabase(app); // Realtime Database 只用來算在線人數
if (EMULATOR) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectDatabaseEmulator(rtdb, '127.0.0.1', 9000);
}

const LEGACY_KEYS = ['maou-log:v1', 'boss-attendance:v1']; // 接雲端前存在瀏覽器的資料
const CAL_KEY = (y) => `maou-log:calendar:${y}`;

// ---------- 資料驗證（匯入與上傳舊存檔共用）----------

const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isHHMM = (v) => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v);
// 長度上限以 UTF-16 單位計算（與 Firestore 規則的 size()、輸入框 maxlength 一致），
// 但只在完整字元之間截斷，不會把 emoji 切成半個
function str(v, max = 100) {
  if (typeof v !== 'string') return '';
  let out = '';
  for (const ch of v) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

// 只留格式正確的資料，其餘丟掉（存檔可能被改過）
const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v);
// 記錄時間是選填（舊資料沒有）
const logged = (x) => (Number.isFinite(x.loggedAt) ? { loggedAt: x.loggedAt } : {});
// 存檔裡的修改歷史：只留格式正確的
const HIST_ACTIONS = ['edit', 'hide'];
// 每種資料的歷史快照必須有的欄位
const HIST_FIELDS = {
  events: (e) => Number.isFinite(e.at) && typeof e.status === 'string' && typeof e.note === 'string',
  leaves: (e) => isDate(e.date) && typeof e.kind === 'string' && typeof e.type === 'string' && typeof e.note === 'string',
};
const keepHistory = (x, name) => {
  const h = (Array.isArray(x.history) ? x.history : [])
    .filter((e) => e && HIST_ACTIONS.includes(e.action) && typeof e.by === 'string' && Number.isFinite(e.t) && HIST_FIELDS[name](e))
    .slice(-50);
  return h.length ? { history: h } : {};
};
// 情報提供者：沒有 reporter 的舊資料以 by 當作提供者
const keepReporter = (x) => {
  const r = typeof x.reporter === 'string' ? x.reporter : typeof x.by === 'string' ? x.by : '';
  return r && r.length <= 128 ? { reporter: r } : {};
};
const isLevel = (v) => Number.isInteger(v) && v >= 1 && v <= 999;

// fallbackBoss：沒有魔王欄位的舊資料要歸給哪一隻魔王
function sanitize(d, fallbackBoss = null) {
  const bosses = (Array.isArray(d.bosses) ? d.bosses : [])
    .filter((b) => b && isId(b.id) && isLevel(b.level))
    .map((b) => ({ id: b.id, level: b.level, name: str(b.name, 20) || '魔王', note: str(b.note, 200) }));
  const ids = new Set(bosses.map((b) => b.id));
  if (fallbackBoss) ids.add(fallbackBoss);
  const owner = (x) => (x.boss === undefined ? fallbackBoss : x.boss);
  const events = (Array.isArray(d.events) ? d.events : [])
    .filter((e) => e && ids.has(owner(e)) && Object.hasOwn(STATUSES, e.status) && Number.isFinite(e.at)
      && !(STATUSES[e.status].rumor && !str(e.note).trim())) // 傳聞必須有旁白（規則也會擋）
    .map((e) => ({ boss: owner(e), at: e.at, status: e.status, note: str(e.note), ...logged(e), ...keepReporter(e), ...keepHistory(e, 'events') }));
  const leaves = (Array.isArray(d.leaves) ? d.leaves : [])
    .filter((l) => l && ids.has(owner(l)) && isDate(l.date) && Object.hasOwn(LEAVE_KINDS, l.kind)
      && (l.kind !== 'custom' || (isHHMM(l.start) && isHHMM(l.end) && l.start < l.end)))
    .map((l) => ({
      boss: owner(l), date: l.date, kind: l.kind, type: str(l.type, 30) || '❓ 其他', note: str(l.note), ...logged(l), ...keepReporter(l), ...keepHistory(l, 'leaves'),
      ...(l.kind === 'custom' ? { start: l.start, end: l.end } : {}),
    }));
  const src = d.settings || {};
  const templates = {};
  for (const k of Object.keys(DEFAULT_TEMPLATES)) if (typeof src.templates?.[k] === 'string') templates[k] = str(src.templates[k], 1000);
  const overrides = {};
  for (const [k, v] of Object.entries(src.overrides || {})) if (isDate(k) && (v === 'holiday' || v === 'workday')) overrides[k] = v;
  const total = (d.bosses?.length || 0) + (d.events?.length || 0) + (d.leaves?.length || 0);
  return { bosses, events, leaves, settings: { templates, overrides }, skipped: total - bosses.length - events.length - leaves.length };
}

// ---------- 快取（畫面讀這份，Firestore 更新時就地改寫）----------

const cache = { adventurers: [], bosses: [], events: [], leaves: [], settings: { templates: { ...DEFAULT_TEMPLATES }, overrides: {}, signupOpen: false, siteOpen: true, closedNote: '' } };
const changeListeners = new Set();
const errorListeners = new Set();
const notify = () => changeListeners.forEach((f) => f());
// kind：'read'（同步失敗）或 'write'（存檔失敗）
const fail = (err, kind = 'write') => errorListeners.forEach((f) => f(err, kind));

const BOARD = 'main';
const me = () => auth.currentUser?.uid || '';
const userDoc = () => doc(db, 'boards', BOARD);
const col = (name) => collection(db, 'boards', BOARD, name);

// 寫入不等伺服器回應：先改快取讓畫面立即更新，離線時 Firestore 會排隊，連上線再送出
function write(promise) {
  promise.catch(fail);
}

// 魔王、日誌、閉關：網站開放、或 GM 登入時才讀（暫時關閉時規則也只讓 GM 讀）
let boardLoaded = false;
let dataSubs = null; // 正在監聽時是取消監聽的函式
let dataFirst = null; // 等第一批資料到齊的回呼（停止、重試、放棄時都會呼叫，開站才不會卡住）
let deniedRetries = 0;
let dataGen = 0; // 每次建立監聽加一；同一批監聽被拒只處理一次
const flushFirst = () => { const f = dataFirst; dataFirst = null; f?.(); };
// 加入等待者：已有人在等就串起來，不覆蓋
const addFirst = (fn) => { const prev = dataFirst; dataFirst = prev ? () => { prev(); fn(); } : fn; };
const once = (fn) => { let done = false; return () => { if (!done) { done = true; fn(); } }; };
const canReadData = () => cache.settings.siteOpen || isEditorUid(auth.currentUser?.uid);
function stopData() {
  flushFirst();
  deniedRetries = 0;
  if (!dataSubs) return;
  dataSubs.forEach((u) => u());
  dataSubs = null;
  cache.bosses = []; cache.events = []; cache.leaves = []; // 關閉後畫面上不留資料
  notify();
}
// 依「網站是否開放、是不是 GM」開始或停止監聽；第一批資料到齊（或不需要讀）時呼叫 onFirst
function syncData(onFirst = () => {}) {
  if (!boardLoaded) return;
  if (!canReadData()) { stopData(); onFirst(); return; }
  if (dataSubs) { if (dataFirst) addFirst(onFirst); else onFirst(); return; }
  addFirst(onFirst);
  const gen = ++dataGen;
  let pending = 3;
  const first = () => { if (--pending === 0) flushFirst(); };
  const [a, b, z] = [once(first), once(first), once(first)];
  const denied = (done) => (err) => {
    done();
    if (err.code !== 'permission-denied') { fail(err, 'read'); return; }
    if (gen !== dataGen || !dataSubs) return; // 這批監聽已經處理過（另外兩個也會被拒）
    if (!canReadData()) { stopData(); return; } // 剛被關閉：安靜停止
    // 應該讀得到卻被拒（GM 剛登入、憑證還沒換好；或看板設定還沒更新）：拆掉監聽、先讓開站繼續，稍後重試；連續失敗才報錯
    dataSubs.forEach((u) => u());
    dataSubs = null;
    flushFirst();
    if (++deniedRetries > 3) { fail(err, 'read'); return; }
    setTimeout(() => syncData(), 1500 * deniedRetries);
  };
  dataSubs = [
    onSnapshot(col('bosses'), (snap) => {
      cache.bosses = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((x, y) => x.level - y.level || x.name.localeCompare(y.name));
      deniedRetries = 0;
      z(); notify();
    }, denied(z)),
    onSnapshot(col('events'), (snap) => {
      cache.events = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      a(); notify();
    }, denied(a)),
    onSnapshot(col('leaves'), (snap) => {
      cache.leaves = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      b(); notify();
    }, denied(b)),
  ];
}

function subscribe() {
  return new Promise((resolve) => {
    const c = once(resolve);
    let cachedBoard = null;
    function applyBoard(snap) {
      cachedBoard = null;
      const s = snap.data() || {};
      const opened = !cache.settings.signupOpen && s.signupOpen === true;
      cache.settings = {
        templates: { ...DEFAULT_TEMPLATES, ...(s.templates || {}) },
        overrides: { ...(s.overrides || {}) },
        signupOpen: s.signupOpen === true, // 預設關閉
        siteOpen: s.siteOpen !== false, // 預設開放
        closedNote: str(s.closedNote, 60),
      };
      // 第一次：先知道網站開不開，再決定要不要讀資料；資料第一批到齊（或不需要讀）時才算開站完成
      const first = !boardLoaded;
      boardLoaded = true;
      // 第一次要等登入狀態還原：否則 GM 重新整理時會先被當成觀戰者，閃一下關閉畫面
      if (first) authReady.then(() => syncData(c));
      else syncData();
      // 剛開放註冊（或快取的舊設定被伺服器更新）：已登入但還沒登記的帳號補登記
      if (opened && auth.currentUser) registerAdventurer(auth.currentUser).catch((err) => fail(err));
      notify();
    }
    // 冒險者清單不擋開站
    onSnapshot(collection(db, 'adventurers'), (snap) => {
      cache.adventurers = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
      notify();
    }, (err) => fail(err, 'read'));
    onSnapshot(userDoc(), (snap) => {
      if (!boardLoaded && snap.metadata.fromCache) { // 本機快取可能過期：先等伺服器，離線時 4 秒後才用快取
        cachedBoard = snap;
        setTimeout(() => { if (!boardLoaded && cachedBoard) applyBoard(cachedBoard); }, 4000);
        return;
      }
      applyBoard(snap);
    }, (err) => { boardLoaded = true; authReady.then(() => syncData(c)); fail(err, 'read'); }); // 讀不到看板設定：當作開放照常讀資料（若其實關閉，規則會拒絕）
  });
}

// 批次寫入要等伺服器確認，離線時會一直等不到，所以先擋下
function requireOnline() {
  if (!navigator.onLine) throw new Error('目前離線，請連上網路再試');
}

// 依序分批寫入（Firestore 一批最多 500 筆）
async function commitInChunks(ops) {
  requireOnline();
  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(db);
    ops.slice(i, i + 400).forEach((op) => op(batch));
    await batch.commit();
  }
}

async function listAllDocs() {
  const all = [];
  for (const name of ['events', 'leaves', 'bosses']) {
    const snap = await getDocs(col(name));
    snap.docs.filter((d) => !d.data().deleted).forEach((d) => all.push({ name, id: d.id, ref: d.ref, data: d.data() }));
  }
  return all;
}

const hideMark = () => ({ deleted: true, deletedAt: Date.now(), by: me() });

const HISTORY_MAX = 50; // 一般修改的上限（與 firestore.rules 一致）；隱藏不受限

// 修改前的內容（只取會被修改的欄位）
function snapshotOf(name, x) {
  if (name === 'events') return { at: x.at, status: x.status, note: x.note || '' };
  if (name === 'bosses') return { level: x.level, name: x.name, note: x.note || '' };
  return {
    date: x.date, kind: x.kind, type: x.type, note: x.note || '',
    ...(x.start !== undefined ? { start: x.start } : {}),
    ...(x.end !== undefined ? { end: x.end } : {}),
  };
}
function appendHistory(name, x, action) {
  return [...(x.history || []), { ...snapshotOf(name, x), action, by: me(), t: Date.now() }];
}

// 隱藏一筆日誌或閉關：用交易讀最新內容再附加「隱藏」歷史
async function hideOne(name, id) {
  requireOnline();
  await waitPending(id); // 剛新增的紀錄先等它寫到雲端（例如記錄後馬上按「復原」）
  await runTransaction(db, async (tx) => {
    const ref = doc(col(name), id);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('這筆紀錄還沒同步到雲端，請稍後再試');
    if (snap.data().deleted) return;
    const cur = snap.data();
    tx.set(ref, {
      ...hideMark(),
      ...(name === 'bosses' ? {} : keepReporter(cur)),
      history: appendHistory(name, cur, 'hide'),
    }, { merge: true });
  });
}

// 新增時送出、還沒到雲端的寫入（id → promise），之後修改或隱藏同一筆要先等它
const pending = new Map();
// 最多等 10 秒；斷網卡住時明確告訴使用者，不要一直沒反應
const failed = new Map(); // 新增被拒絕的紀錄（id → 錯誤），之後修改或隱藏時直接說明，不叫人重試
async function waitPending(id) {
  const p = pending.get(id);
  if (p) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('這筆紀錄尚未同步到雲端，請確認網路後再試')), 10_000); });
    try { await Promise.race([p.catch(() => {}), timeout]); } finally { clearTimeout(timer); }
  }
  if (failed.has(id)) throw new Error(`這筆紀錄沒有存到雲端（${failed.get(id).code || failed.get(id).message}），請重新記錄`);
}
function track(id, promise) {
  pending.set(id, promise);
  promise.catch((err) => failed.set(id, err)).finally(() => pending.delete(id));
  write(promise);
}

// 「刪除」＝標記為隱藏（資料保留）
async function hideDocs(list) {
  await commitInChunks(list.map((d) => (b) => b.set(d.ref, {
    ...hideMark(),
    ...(d.name === 'bosses' ? {} : keepReporter(d.data)),
    history: appendHistory(d.name, d.data, 'hide'),
  }, { merge: true })));
}

// settings：'replace' 取代、'skip' 不動（上傳舊存檔時不覆蓋目前的範本與休戰日）
const sameBoss = (cur, b) => cur.level === b.level && cur.name === b.name && (cur.note || '') === b.note;

// existingBosses：雲端已存在的魔王（id → 資料，含已隱藏的）；同 id 的改成附加修改歷史後更新，並恢復顯示
async function writeData(clean, { settings, existingBosses = new Map() }) {
  const ops = [];
  clean.bosses.forEach(({ id, ...saved }) => {
    const cur = existingBosses.get(id);
    const b = cur ? { ...saved, level: Math.max(cur.level, saved.level) } : saved; // 等級只能提升：存檔較低時保留雲端的等級
    const ref = doc(col('bosses'), id);
    if (cur && sameBoss(cur, b) && !cur.deleted) return; // 內容沒變：不寫、不消耗修改次數
    if (cur) ops.push((x) => x.set(ref, { ...b, deleted: false, by: me(), history: appendHistory('bosses', cur, 'edit') }, { merge: true }));
    else ops.push((x) => x.set(ref, { ...b, by: me() }));
  });
  // 保留存檔裡原本的情報提供者；沒有的才算是讀取存檔的人
  clean.events.forEach((e) => ops.push((b) => b.set(doc(col('events')), { reporter: me(), ...e, by: me() })));
  clean.leaves.forEach((l) => ops.push((b) => b.set(doc(col('leaves')), { reporter: me(), ...l, by: me() })));
  const { signupOpen, siteOpen, closedNote } = cache.settings; // 註冊開關、網站開關維持原狀
  if (settings === 'replace') ops.push((b) => b.set(userDoc(), { ...clean.settings, signupOpen, siteOpen, closedNote }));
  await commitInChunks(ops);
}

// ---------- 對外介面 ----------

// 登入後把自己登記到冒險者清單（只存去識別化的 email；第一次登入時間保留）
// 同一個帳號同時只登記一次（登入與「註冊剛打開」可能同時觸發）
const registering = new Map();
function registerAdventurer(user) {
  if (!registering.has(user.uid)) {
    registering.set(user.uid, doRegister(user).finally(() => registering.delete(user.uid)));
  }
  return registering.get(user.uid);
}
async function doRegister(user) {
  await ready; // 等註冊開關等設定載入（開站時登入狀態可能比設定先回來）
  const ref = doc(db, 'adventurers', user.uid);
  const masked = maskEmail(user.email);
  const snap = await getDoc(ref);
  if (snap.exists() && snap.data().masked === masked) return;
  // 關閉註冊時，還沒登記的帳號不登記（規則也會擋），只能觀戰
  if (!snap.exists() && !cache.settings.signupOpen && !isEditorUid(user.uid)) return;
  await setDoc(ref, { masked, joinedAt: snap.exists() ? snap.data().joinedAt : Date.now() });
}

export const isEditorUid = (uid) => EDITOR_UIDS.includes(uid);

// 登入狀態還原完成（沒登入也算）；失敗或超過 4 秒照樣繼續，開站不會卡住
const authReady = Promise.race([auth.authStateReady().catch(() => {}), new Promise((r) => setTimeout(r, 4000))]);
// 開站就開始同步看板（公開可讀），第一批資料到齊時完成
const ready = subscribe();

export const account = {
  // 登入狀態改變時呼叫 cb(user, canEdit)
  onUser(cb) {
    onAuthStateChanged(auth, (user) => {
      if (user) registerAdventurer(user).catch((err) => fail(err));
      refreshPresence();
      cb(user, !!user && isEditorUid(user.uid));
      syncData(); // GM 登入／登出時，暫時關閉的網站要開始或停止讀資料（畫面身分先更新）
    });
  },
  login: (email, password) => signInWithEmailAndPassword(auth, email, password),
  signup: async (email, password) => {
    if (!cache.settings.signupOpen) throw Object.assign(new Error('目前沒有開放註冊'), { code: 'auth/admin-restricted-operation' });
    return createUserWithEmailAndPassword(auth, email, password);
  },
  resetPassword: (email) => sendPasswordResetEmail(auth, email),
  logout: () => signOut(auth),
  get email() { return auth.currentUser?.email || ''; },
};

export const store = {
  // 開站就開始同步看板（公開可讀），第一批資料到齊時完成
  ready,
  async getAll() { return cache; },
  onChange(fn) { changeListeners.add(fn); },
  onError(fn) { errorListeners.add(fn); },

  async addEvent({ boss, at, status, note = '' }) {
    const ref = doc(col('events'));
    const ev = { boss, at, status, note, loggedAt: Date.now(), reporter: me(), by: me() };
    cache.events.push({ id: ref.id, ...ev });
    track(ref.id, setDoc(ref, ev));
    return { id: ref.id, ...ev };
  },
  async updateEvent(id, patch) {
    requireOnline();
    await waitPending(id);
    await runTransaction(db, async (tx) => {
      const ref = doc(col('events'), id);
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('找不到這筆紀錄');
      const cur = snap.data();
      if ((cur.history || []).length >= HISTORY_MAX) throw new Error(`這筆紀錄已修改 ${HISTORY_MAX} 次，不能再修改；需要的話請 GM 刪除後重新記錄`);
      const next = { ...cur, ...patch };
      tx.set(ref, {
        boss: cur.boss, at: next.at, status: next.status, note: next.note || '', ...logged(cur),
        // 情報提供者不換人；舊資料沒有 reporter 時，補上原本的記錄者
        ...keepReporter(cur), by: me(), history: appendHistory('events', cur, 'edit'),
      });
    });
  },
  async deleteEvent(id) {
    await hideOne('events', id);
  },

  async addLeave(leave) {
    const ref = doc(col('leaves'));
    const lv = { boss: leave.boss, date: leave.date, kind: leave.kind, type: leave.type, note: leave.note || '', loggedAt: Date.now(), reporter: me(), by: me() };
    if (leave.kind === 'custom') Object.assign(lv, { start: leave.start, end: leave.end });
    cache.leaves.push({ id: ref.id, ...lv });
    track(ref.id, setDoc(ref, lv));
    return { id: ref.id, ...lv };
  },
  // 修改閉關：和日誌一樣用交易附加修改歷史；不能換魔王、記錄時間與情報提供者不變
  async updateLeave(id, patch) {
    requireOnline();
    await waitPending(id);
    await runTransaction(db, async (tx) => {
      const ref = doc(col('leaves'), id);
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('找不到這筆閉關');
      const cur = snap.data();
      if ((cur.history || []).length >= HISTORY_MAX) throw new Error(`這筆閉關已修改 ${HISTORY_MAX} 次，不能再修改`);
      const next = { ...cur, ...patch };
      tx.set(ref, {
        boss: cur.boss, date: next.date, kind: next.kind, type: next.type, note: next.note || '',
        ...(next.kind === 'custom' ? { start: next.start, end: next.end } : {}),
        ...logged(cur), ...keepReporter(cur), by: me(), history: appendHistory('leaves', cur, 'edit'),
      });
    });
  },
  async deleteLeave(id) {
    await hideOne('leaves', id);
  },

  // 魔王：等級、名稱、屬性備註
  async addBoss({ level, name, note = '' }) {
    const ref = doc(col('bosses'));
    const b = { level, name, note, by: me() };
    cache.bosses.push({ id: ref.id, ...b });
    track(ref.id, setDoc(ref, b));
    return { id: ref.id, ...b };
  },
  // 修改魔王：用交易附加修改歷史（誰把等級、名稱、備註從什麼改成什麼）
  async updateBoss(id, { level, name, note }) {
    requireOnline();
    await waitPending(id);
    await runTransaction(db, async (tx) => {
      const ref = doc(col('bosses'), id);
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('找不到這隻魔王');
      const cur = snap.data();
      if ((cur.history || []).length >= HISTORY_MAX) throw new Error(`這隻魔王已修改 ${HISTORY_MAX} 次，不能再修改`);
      if (level < cur.level) throw new Error(`等級只能提升，不能低於 Lv.${cur.level}（可能有人剛改過）`); // 規則也會擋
      tx.set(ref, { level, name, note, by: me(), history: appendHistory('bosses', cur, 'edit') }, { merge: true });
    });
  },
  // 刪除魔王＝把魔王標記為隱藏（牠的日誌與閉關跟著不顯示，資料都保留）
  async deleteBoss(id) {
    await hideOne('bosses', id);
  },

  async setTemplate(key, text) {
    cache.settings.templates[key] = text;
    write(setDoc(userDoc(), { templates: { [key]: text } }, { merge: true }));
  },
  async resetTemplate(key) {
    cache.settings.templates[key] = DEFAULT_TEMPLATES[key];
    write(setDoc(userDoc(), { templates: { [key]: deleteField() } }, { merge: true }));
  },
  // GM：開放／關閉冒險者註冊
  async setSignupOpen(open) {
    cache.settings.signupOpen = open;
    write(setDoc(userDoc(), { signupOpen: open }, { merge: true }));
  },
  // 暫時關閉網站（只有 GM 看得到內容）；note 是給觀戰者看的一句說明
  async setSiteOpen(open, note = cache.settings.closedNote) {
    const closedNote = str(note, 60);
    cache.settings.siteOpen = open;
    cache.settings.closedNote = closedNote;
    write(setDoc(userDoc(), { siteOpen: open, closedNote }, { merge: true }));
  },
  async setOverride(date, value) {
    if (value) cache.settings.overrides[date] = value;
    else delete cache.settings.overrides[date];
    write(setDoc(userDoc(), { overrides: { [date]: value || deleteField() } }, { merge: true }));
  },

  async exportJSON() {
    const alive = (list) => list.filter((x) => !x.deleted); // 存檔只含目前看得到的資料
    const bosses = alive(cache.bosses);
    const ids = new Set(bosses.map((b) => b.id)); // 被隱藏的魔王，牠的紀錄也不放進存檔
    const [events, leaves] = [cache.events, cache.leaves].map((list) => alive(list).filter((x) => ids.has(x.boss)));
    const { settings } = cache;
    return JSON.stringify({ app: 'maou-log', version: 2, exportedAt: new Date().toISOString(), bosses, events, leaves, settings }, null, 2);
  },
  // 讀取存檔：取代雲端上的全部資料
  // 讀取存檔：先寫入新資料，成功後才刪除舊資料（中途失敗時舊資料仍在）
  async importJSON(text) {
    const d = JSON.parse(text);
    if (!Array.isArray(d.events) || !Array.isArray(d.leaves)) throw new Error('檔案格式不正確');
    if (!Array.isArray(d.bosses)) throw new Error('這是舊版存檔（沒有魔王資料），請改用「上傳舊存檔」');
    const clean = sanitize(d);
    if (!clean.bosses.length) throw new Error('存檔裡沒有魔王，已取消');
    requireOnline();
    const old = await listAllDocs();
    const existingBosses = new Map((await getDocs(col('bosses'))).docs.map((d) => [d.id, d.data()]));
    const full = clean.bosses.find((b) => {
      const cur = existingBosses.get(b.id);
      return cur && !(sameBoss(cur, { ...b, level: Math.max(cur.level, b.level) }) && !cur.deleted) && (cur.history || []).length >= HISTORY_MAX;
    });
    if (full) throw new Error(`魔王「${full.name}」已修改 ${HISTORY_MAX} 次，無法用存檔更新；請先改用新的魔王`);
    await writeData(clean, { settings: 'replace', existingBosses });
    const kept = new Set(clean.bosses.map((b) => b.id)); // 同 id 的魔王已被覆寫，不能隱藏
    await hideDocs(old.filter((o) => !(o.name === 'bosses' && kept.has(o.id))));
    return { skipped: clean.skipped };
  },
  // 刪除存檔＝全部標記為隱藏，並把範本、休戰日設定恢復預設（資料庫仍保留完整紀錄）
  async clearAll() {
    requireOnline();
    await hideDocs(await listAllDocs());
    const { signupOpen, siteOpen, closedNote } = cache.settings; // 註冊開關、網站開關維持原狀
    await setDoc(userDoc(), { templates: {}, overrides: {}, signupOpen, siteOpen, closedNote });
  },

  // 接雲端前留在這台裝置瀏覽器裡的舊存檔
  legacyCount() {
    for (const k of LEGACY_KEYS) {
      try {
        const d = JSON.parse(localStorage.getItem(k));
        const n = (d?.events?.length || 0) + (d?.leaves?.length || 0);
        if (n) return n;
      } catch { /* 壞掉的舊存檔當作沒有 */ }
    }
    return 0;
  },
  // 上傳舊存檔：歸給指定的魔王，加到雲端現有資料之後，成功才刪除本機舊存檔
  async uploadLegacy(bossId) {
    let uploaded = 0;
    for (const k of LEGACY_KEYS) {
      let d;
      try { d = JSON.parse(localStorage.getItem(k)); } catch { d = null; }
      if (!d) continue;
      const clean = sanitize(d, bossId);
      await writeData(clean, { settings: 'skip' });
      uploaded += clean.events.length + clean.leaves.length;
      try { localStorage.removeItem(k); } catch { /* 刪不掉也不影響已上傳的資料 */ }
    }
    return uploaded;
  },
};

// ---------- 同時在線（含沒登入的觀戰者）----------
// 每個分頁連線時在 presence/ 登記一筆，斷線由伺服器自動刪除；
// 每 5 分鐘更新時間，超過 15 分鐘沒更新的不算（避免殘留或被灌假資料）
const HEARTBEAT = 5 * 60_000;
const STALE = 15 * 60_000;

let refreshPresence = () => {};

// ---------- 造訪紀錄（只有 GM 看得到）----------
// 只留最後一次：登入的人每個帳號一筆（u_<uid>，登出後也還在），未登入的每台裝置一筆
// 內容：{ uid（未登入為空字串）, ip（4 碼雜湊代號）, at（伺服器時間）}
// IP 由第三方服務 ipify 查詢，在瀏覽器裡就轉成代號；完整 IP 不會寫進資料庫。
// 代號只取雜湊的前 4 碼：同一個 IP 永遠是同一個代號；每個代號對應約 6.5 萬個 IP，無法直接還原成某一個 IP
// （但拿已知 IP 比對是否同一來源很容易，所以只給 GM 看）
const VISIT_EVERY = 30 * 60_000; // 同一個身分 30 分鐘內不重複寫（登入狀態改變時立刻寫），避免整天開著的分頁吃掉免費寫入額度
const IP_TTL = 60 * 60_000; // IP 代號每小時重查一次（換網路後會更新）

function deviceId() {
  const ok = (v) => /^[A-Za-z0-9]{20}$/.test(v || '');
  try {
    let id = localStorage.getItem('maou-log:device');
    if (!ok(id)) { id = randomId(); localStorage.setItem('maou-log:device', id); }
    return id;
  } catch {
    return (deviceId.memo ||= randomId()); // 無痕模式等不能存：本次開啟用同一個
  }
}
function randomId() {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(20)), (n) => abc[n % abc.length]).join('');
}

let ipCodeP = null;
let ipCodeAt = 0;
function ipCode() {
  if (Date.now() - ipCodeAt > IP_TTL) ipCodeP = null;
  if (!ipCodeP) ipCodeAt = Date.now();
  ipCodeP ||= fetch('https://api.ipify.org?format=json', { cache: 'no-store', signal: AbortSignal.timeout(5000) }) // 卡住時 5 秒放棄
    .then((r) => r.json())
    .then(async ({ ip }) => {
      if (typeof ip !== 'string' || !ip) return '';
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`maou-log:${ip}`));
      return Array.from(new Uint8Array(hash).slice(0, 2), (n) => n.toString(16).padStart(2, '0')).join('');
    })
    .catch(() => { ipCodeP = null; return ''; }); // 被擋或離線：這次不記代號，下次心跳再查
  return ipCodeP;
}

let lastVisit = { uid: null, t: 0 };
async function recordVisit() {
  const uid = auth.currentUser?.uid || '';
  if (lastVisit.uid === uid && Date.now() - lastVisit.t < VISIT_EVERY) return;
  lastVisit = { uid, t: Date.now() };
  const ip = await ipCode();
  await setDoc(doc(db, 'visits', uid ? `u_${uid}` : deviceId()), { uid, ip, at: fsServerTime() }).catch(() => {});
}

// GM 用：uids 每個帳號的最後一次（直接讀 u_<uid>，不會被大量未登入紀錄擠掉）＋最近的未登入紀錄（新的在前）
export async function loadVisits(uids = []) {
  const row = (d) => ({ id: d.id, uid: d.data().uid || '', ip: d.data().ip || '', at: d.data().at?.toMillis?.() || 0 });
  const [snap, mine] = await Promise.all([
    getDocs(query(collection(db, 'visits'), orderBy('at', 'desc'), limit(200))),
    Promise.all(uids.map((uid) => getDoc(doc(db, 'visits', `u_${uid}`)))),
  ]);
  return {
    byUid: new Map(mine.filter((d) => d.exists()).map((d) => [d.data().uid, row(d)])),
    anon: snap.docs.map(row).filter((v) => !v.uid),
  };
}

// cb(在線人數, 在線的冒險者 uid 集合, 未登入的人數)
export function watchOnline(cb) {
  let mine = null;
  let connected = false;
  let offset = 0; // 伺服器時間 - 本機時間
  // 離線時不送心跳：否則排隊的寫入會在重連後把已清掉的舊紀錄寫回來（沒有 onDisconnect，會一直殘留）
  // 登入時一併帶上 uid，冒險者清單才知道誰在線
  const beat = () => {
    if (!connected || !mine) return;
    const uid = auth.currentUser?.uid;
    set(mine, uid ? { t: serverTimestamp(), uid } : { t: serverTimestamp() }).catch(() => {});
    recordVisit();
  };
  // 登入／登出時立刻更新；RTDB 可能還沒拿到新的登入憑證，稍後再補送兩次
  refreshPresence = () => { beat(); setTimeout(beat, 1500); setTimeout(beat, 5000); };
  onValue(ref(rtdb, '.info/serverTimeOffset'), (s) => { offset = s.val() || 0; });
  onValue(ref(rtdb, '.info/connected'), async (s) => {
    connected = !!s.val();
    if (!connected) return;
    if (mine) remove(mine).catch(() => {}); // 保險：舊的一筆若還在就刪掉
    mine = push(ref(rtdb, 'presence')); // 每次重新連線用新的一筆
    try {
      await onDisconnect(mine).remove();
      await beat();
    } catch { /* 在線人數失敗不影響主要功能 */ }
  });
  setInterval(beat, HEARTBEAT);
  onValue(ref(rtdb, 'presence'), (snap) => {
    const now = Date.now() + offset;
    let n = 0;
    let anon = 0;
    const uids = new Set();
    snap.forEach((c) => {
      const v = c.val() || {};
      if (typeof v.t !== 'number' || now - v.t >= STALE) return;
      n++;
      if (typeof v.uid === 'string') uids.add(v.uid); else anon++;
    });
    cb(n, uids, anon);
  }, () => cb(null, new Set(), 0));
}

// 台灣政府行事曆（含補假、補班），來源：政府資料開放平台整理版 ruyut/TaiwanCalendar
// 快取 7 天後重抓（政府可能事後調整補假）；重抓失敗就沿用舊快取
const CAL_TTL = 7 * 24 * 3600_000;

export async function loadCalendar(year, { force = false } = {}) {
  let cached = null;
  try {
    const c = JSON.parse(localStorage.getItem(CAL_KEY(year)));
    if (c?.data && Number.isFinite(c.savedAt)) cached = c;
  } catch { /* 快取壞掉就重抓 */ }
  if (!force && cached && Date.now() - cached.savedAt < CAL_TTL) return { ok: true, data: cached.data, cached: true };
  try {
    const res = await fetch(`https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${year}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = await res.json();
    const data = {};
    for (const x of list) {
      const k = `${x.date.slice(0, 4)}-${x.date.slice(4, 6)}-${x.date.slice(6, 8)}`;
      data[k] = { isHoliday: x.isHoliday, description: x.description };
    }
    try { localStorage.setItem(CAL_KEY(year), JSON.stringify({ savedAt: Date.now(), data })); } catch { /* 存不了快取也照樣使用 */ }
    return { ok: true, data, cached: false };
  } catch (err) {
    if (cached) return { ok: true, data: cached.data, cached: true };
    return { ok: false, data: {}, error: String(err.message || err) };
  }
}
