// E2E：在 Firebase 模擬器上跑完整流程（npm run test:e2e）
// 帳號與資料都在模擬器裡，不會碰到正式資料
import { test, expect } from '@playwright/test';
import { EDITOR_UIDS } from '../firebase-config.js';
import { VERSION } from '../version.js';

const PROJECT = 'maou-log-jt2c4';
const AUTH = 'http://127.0.0.1:9099';
const DOCS = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`;
const GM = { uid: EDITOR_UIDS[0], email: 'gm@example.test', password: 'e2e-gm-pass' };
const OTHER = { uid: 'e2e-other', email: 'other@example.test', password: 'e2e-other-pass' };
// 2026-11-24（二）09:12：比 09:00 晚 12 分
const NOW = new Date('2026-11-24T09:12:00+08:00');
const OWNER = { Authorization: 'Bearer owner' }; // 模擬器的管理權限，跳過安全規則

// 直接在模擬器寫入資料（Firestore REST 格式）
const value = (v) => (typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'boolean' ? { booleanValue: v }
  : Array.isArray(v) ? { arrayValue: { values: v.map(value) } }
    : v && typeof v === 'object' ? { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, value(x)])) } }
      : { stringValue: v });
async function put(request, path, data) {
  const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, value(v)]));
  const res = await request.patch(`${DOCS}/${path}`, { headers: OWNER, data: { fields } });
  expect(res.ok()).toBeTruthy();
}

test.beforeEach(async ({ request }) => {
  await request.delete('http://127.0.0.1:9000/.json?ns=maou-log-jt2c4-default-rtdb', { headers: OWNER });
  await request.delete(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}/databases/(default)/documents`);
  await request.delete(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`);
  const res = await request.post(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:batchCreate`, {
    headers: OWNER,
    data: { users: [GM, OTHER].map((u) => ({ localId: u.uid, email: u.email, rawPassword: u.password })) },
  });
  expect(res.ok()).toBeTruthy();
  // 兩隻魔王：Lv.30（有屬性備註）、Lv.50
  await put(request, 'boards/main/bosses/b30', { level: 30, name: '魔王', note: '愛喝咖啡', by: GM.uid });
  await put(request, 'boards/main/bosses/b50', { level: 50, name: '魔王', note: '', by: GM.uid });
  // OTHER 是已登記的冒險者
  await put(request, `adventurers/${OTHER.uid}`, { masked: 'ot***@e***.test', joinedAt: 1 });
});

// 新手教學第一次會自動出現；一般測試先標記為已看過
async function skipTutorial(page) {
  await page.addInitScript(() => {
    localStorage.setItem('maou-log:tutorial', 'done');
    localStorage.setItem('maou-log:tutorial-gm', 'done');
  });
}

// 打開網站並選擇魔王（pick = null 表示不選）
async function open(page, pick = 30, { tutorial = false } = {}) {
  await page.clock.setFixedTime(NOW);
  if (!tutorial) await skipTutorial(page);
  // 休戰日資料改用空清單，測試不依賴外部網路
  await page.route('https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/**', (route) => route.fulfill({ json: [] }));
  await page.route('https://api.ipify.org/**', (route) => route.fulfill({ json: { ip: '203.0.113.7' } })); // IP 查詢用假資料
  await page.goto('/?emulator');
  await expect(page.locator('body.ready')).toBeAttached();
  await expect(page.locator('[data-boss]')).toHaveCount(2);
  if (pick) await chip(page, pick).click();
}

const tab = (page, name) => page.locator(`nav.tabs [data-tab="${name}"]`).click();
const chip = (page, level) => page.locator('[data-boss]', { hasText: `Lv.${level}` });

async function login(page, user) {
  await tab(page, 'settings');
  await page.locator('#login').click();
  await page.locator('#lg-email').fill(user.email);
  await page.locator('#lg-pass').fill(user.password);
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#sheet')).not.toBeVisible();
}

test('觀戰模式：不用登入就能看，看不到任何編輯功能', async ({ page }) => {
  await open(page);
  await expect(page.locator('#role')).toHaveText(/觀戰/);
  await expect(page.locator('.now .label')).toContainText('Lv.30');
  await expect(page.locator('.now .label')).toContainText('尚未上線');
  await expect(page.locator('.boss-note')).toContainText('愛喝咖啡');
  await expect(page.locator('[data-status]')).toHaveCount(0);
  await expect(page.locator('#offsets')).toHaveCount(0);
  await expect(page.locator('#boss-add, #edit-boss')).toHaveCount(0);

  await tab(page, 'settings');
  await expect(page.locator('#login')).toBeVisible();
  await expect(page.locator('[data-tpl]')).toHaveCount(0);
  await expect(page.locator('#bk-export')).toHaveCount(0);
  await expect(page.locator('#view-settings')).toContainText(`v${VERSION}`);
});

test('沒有選擇魔王時看不到任何資料', async ({ page, request }) => {
  await put(request, 'boards/main/events/n1', { boss: 'b30', at: new Date('2026-11-24T09:00:00+08:00').getTime(), status: 'work', note: '機密', by: GM.uid });
  await open(page, null);
  await expect(page.locator('[data-boss][aria-pressed="true"]')).toHaveCount(0);
  await expect(page.locator('#view-record')).toContainText('請先從上方選擇要觀戰的魔王');
  await expect(page.locator('#view-record')).not.toContainText('機密');
  await expect(page.locator('#share-now')).toHaveCount(0);
  await tab(page, 'calendar');
  await expect(page.locator('#view-calendar')).toContainText('請先從上方選擇');
  await expect(page.locator('[data-day]')).toHaveCount(0);
  await tab(page, 'stats');
  await expect(page.locator('#view-stats')).toContainText('請先從上方選擇');
  await expect(page.locator('#view-stats .tile')).toHaveCount(0);
});

test('網址的魔王參數壞掉時不會整頁空白', async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await page.route('https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/**', (route) => route.fulfill({ json: [] }));
  await page.route('https://api.ipify.org/**', (route) => route.fulfill({ json: { ip: '203.0.113.7' } })); // IP 查詢用假資料
  await skipTutorial(page);
  await page.goto('/?emulator#b=%E0%A4%A');
  await expect(page.locator('body.ready')).toBeAttached();
  await expect(page.locator('#view-record')).toContainText('請先從上方選擇');
});

test('觀戰者可以切換魔王，網址會記住', async ({ page, request }) => {
  await put(request, 'boards/main/events/n1', { boss: 'b50', at: new Date('2026-11-24T09:00:00+08:00').getTime(), status: 'nap', note: '', by: GM.uid });
  await open(page);
  await expect(page.locator('.now .label')).toContainText('尚未上線');
  await expect(chip(page, 50)).toContainText('😴');

  await chip(page, 50).click();
  await expect(chip(page, 50)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.now .label')).toContainText('Lv.50');
  await expect(page.locator('.now .label')).toContainText('睡眠補血');
  await expect(page).toHaveURL(/#b=b50/);

  // 用分享出去的網址打開，直接看到 Lv.50
  await page.reload();
  await expect(page.locator('.now .label')).toContainText('Lv.50');
});

test('登入畫面：密碼錯誤會提示', async ({ page }) => {
  await open(page);
  await tab(page, 'settings');
  await page.locator('#login').click();
  await page.locator('#lg-email').fill(GM.email);
  await page.locator('#lg-pass').fill('wrong-password');
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#lg-err')).toHaveText('帳號或密碼錯誤');
});

test('GM 記錄上線：廣播註明魔王與遲到，觀戰者即時看到', async ({ page, browser }) => {
  await open(page);
  await login(page, GM);
  await expect(page.locator('#role')).toHaveText(/GM/);

  await tab(page, 'record');
  await page.locator('#note').fill('開會');
  await page.locator('[data-status="work"]').click();
  const msg = page.locator('#msg');
  await expect(msg).toHaveValue(/Lv\.30 魔王 上線！/);
  await expect(msg).toHaveValue(/上線時間：09:12/);
  await expect(msg).toHaveValue(/⚠️ 失誤（遲到 12 分）/);
  await expect(msg).toHaveValue(/開會/);
  await page.locator('#done').click();
  await expect(page.locator('.now .label')).toContainText('上線');
  await expect(page.locator('#view-record .list')).toContainText('09:12');

  // 另一個沒登入、在紐約時區的觀戰者：看到的仍是台灣時間
  const viewerCtx = await browser.newContext({ timezoneId: 'America/New_York' });
  const viewer = await viewerCtx.newPage();
  await open(viewer);
  await expect(viewer.locator('.now .label')).toContainText('上線');
  await expect(viewer.locator('#view-record .list')).toContainText('開會');
  await expect(viewer.locator('#view-record .list')).toContainText('09:12');
  await expect(viewer.locator('.fact').first()).toContainText('09:12');
  await expect(viewer.locator('[data-edit]')).toHaveCount(0);
  // Lv.50 沒有被記到
  await chip(viewer, 50).click();
  await expect(viewer.locator('.now .label')).toContainText('尚未上線');
  await chip(viewer, 30).click();

  // 一分鐘後 GM 記錄下線，觀戰者不用重新整理就會更新
  await page.clock.setFixedTime(new Date(NOW.getTime() + 60_000));
  await page.locator('[data-status="off"]').click();
  await page.locator('#done').click();
  await expect(viewer.locator('.now .label')).toContainText('下線');
  await viewerCtx.close();
});

test('GM 新增魔王並編輯屬性備註，觀戰者看得到', async ({ page, browser }) => {
  await open(page);
  await login(page, GM);
  await page.locator('#boss-add').click();
  await page.locator('#b-level').fill('70');
  await page.locator('#b-name').fill('大魔王');
  await page.locator('#b-note').fill('會突襲');
  await page.locator('#b-save').click();
  await expect(chip(page, 70)).toHaveAttribute('aria-pressed', 'true');

  await tab(page, 'record');
  await expect(page.locator('.now .label')).toContainText('Lv.70 大魔王');
  await page.locator('#edit-boss').click();
  await page.locator('#b-note').fill('會突襲，週五請假');
  await page.locator('#b-save').click();
  await expect(page.locator('.boss-note')).toContainText('週五請假');

  // 等級不合法會被擋下
  await page.locator('#edit-boss').click();
  await page.locator('#b-level').fill('0');
  await page.locator('#b-save').click();
  await expect(page.locator('#toast')).toHaveText('等級請填 1–999 的整數');
  await page.keyboard.press('Escape');

  const viewerCtx = await browser.newContext();
  const viewer = await viewerCtx.newPage();
  await viewer.clock.setFixedTime(NOW);
  await viewer.route('https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/**', (route) => route.fulfill({ json: [] }));
  await viewer.route('https://api.ipify.org/**', (route) => route.fulfill({ json: { ip: '203.0.113.7' } })); // IP 查詢用假資料
  await skipTutorial(viewer);
  await viewer.goto('/?emulator');
  await chip(viewer, 70).click();
  await expect(viewer.locator('.boss-note')).toContainText('會突襲，週五請假');
  await viewerCtx.close();
});

test('GM 登記閉關：只記在目前的魔王，地圖與成就都會反映', async ({ page }) => {
  await open(page);
  await login(page, GM);
  await tab(page, 'record');
  await page.locator('#add-leave').click();
  await page.locator('#l-date').fill('2026-11-23');
  await page.locator('#l-save').click();
  await expect(page.locator('#msg')).toHaveValue(/Lv\.30 魔王 .*閉關/);
  await page.locator('#done').click();

  await tab(page, 'calendar');
  await expect(page.locator('[data-day="2026-11-23"]')).toContainText('特休券');
  await tab(page, 'stats');
  await expect(page.locator('#view-stats')).toContainText('🎫 特休券 1 天');

  await chip(page, 50).click();
  await expect(page.locator('#view-stats')).not.toContainText('特休券');
});

test('GM 補登：時間空白會被擋下', async ({ page }) => {
  await open(page);
  await login(page, GM);
  await tab(page, 'calendar');
  await page.locator('[data-day="2026-11-20"]').click();
  await page.locator('#d-add').click();
  await page.locator('#e-time').fill('');
  await page.locator('#e-save').click();
  await expect(page.locator('#toast')).toHaveText('請輸入時間');

  await page.locator('#e-time').fill('08:45');
  await page.locator('#e-save').click();
  await expect(page.locator('#sheet')).toContainText('08:45');
});

test('登入的冒險者：可以提供情報與修改，但不能刪除、不能改設定', async ({ page }) => {
  await open(page);
  await login(page, OTHER);
  await expect(page.locator('#role')).toHaveText('⚔️ 冒險者');
  await tab(page, 'record');
  await page.locator('[data-status="work"]').click();
  await expect(page.locator('#undo')).toHaveCount(0); // 復原＝隱藏，只有 GM
  await page.locator('#done').click();
  await expect(page.locator('#view-record .list li').first().locator('.reporter')).toHaveText('情報：ot***@e***.test');
  await page.locator('[data-edit]').first().click();
  await expect(page.locator('#e-del')).toHaveCount(0);
  await page.locator('#e-cancel').click();
  await expect(page.locator('#boss-add')).toBeVisible();
  await page.locator('#edit-boss').click();
  await expect(page.locator('#b-del')).toHaveCount(0);
  await page.locator('#b-cancel').click();
  await tab(page, 'settings');
  await expect(page.locator('[data-tpl]')).toHaveCount(0);
  await expect(page.locator('#bk-export')).toHaveCount(0);
  await expect(page.locator('#toggle-hidden')).toHaveCount(0);
});

test('登出後回到觀戰模式', async ({ page }) => {
  await open(page);
  await login(page, GM);
  await expect(page.locator('#role')).toHaveText(/GM/);
  await tab(page, 'settings');
  await page.locator('#logout').click();
  await expect(page.locator('#role')).toHaveText(/觀戰/);
  await expect(page.locator('#login')).toBeVisible();
});

test('觀戰者可以分享目前狀態到 LINE（含沒登入的）', async ({ page, request }) => {
  await put(request, 'boards/main/events/n1', { boss: 'b50', at: new Date('2026-11-24T09:00:00+08:00').getTime(), status: 'nap', note: '', by: GM.uid });
  await open(page);
  await page.locator('#share-now').click();
  await expect(page.locator('#msg')).toHaveValue(/Lv\.30 魔王 尚未上線/);
  await page.locator('#done').click();

  await chip(page, 50).click();
  await page.locator('#share-now').click();
  await expect(page.locator('#msg')).toHaveValue(/😴 Lv\.50 魔王 睡眠補血中…（09:00）/);
  // 電腦版：LINE 不支援分享網址，改成複製到剪貼簿
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await expect(page.locator('#send')).toContainText('複製戰報');
  await page.locator('#send').click();
  await expect(page.locator('#toast')).toContainText('已複製');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('睡眠補血中');
});

test('手機版：用 LINE 分享網址打開，訊息帶在網址裡', async ({ browser, request }) => {
  await put(request, 'boards/main/events/n1', { boss: 'b30', at: new Date('2026-11-24T09:00:00+08:00').getTime(), status: 'nap', note: '', by: GM.uid });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Line/14.0.0',
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
  });
  const page = await ctx.newPage();
  await open(page);
  await page.locator('#share-now').click();
  await expect(page.locator('#send')).toContainText('廣播到 LINE');
  await ctx.route('https://line.me/**', (route) => route.fulfill({ body: 'ok' }));
  const popup = page.waitForEvent('popup');
  await page.locator('#send').click();
  expect(decodeURIComponent((await popup).url())).toContain('睡眠補血中');
  await ctx.close();
});

test('同時在線人數包含沒登入的觀戰者', async ({ page, browser }) => {
  await open(page);
  await expect(page.locator('#online')).toHaveText('🟢 在線 1');
  const otherCtx = await browser.newContext();
  const other = await otherCtx.newPage();
  await open(other);
  await expect(page.locator('#online')).toHaveText('🟢 在線 2');
  await expect(other.locator('#online')).toHaveText('🟢 在線 2');
  await otherCtx.close();
  await expect(page.locator('#online')).toHaveText('🟢 在線 1');
});

test('電腦版掌機：按鍵可以換頁、換魔王、開關分享', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('maou-log:skin', 'wide')); // 預設是無外殼，這裡測掌機
  await open(page);
  await expect(page.locator('.dpad')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#view-calendar')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#view-record')).toBeVisible();
  await page.keyboard.press('Shift');
  await expect(chip(page, 50)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('z');
  await expect(page.locator('#sheet')).toBeVisible();
  await expect(page.locator('#msg')).toHaveValue(/Lv\.50/);
  // 視窗打開時游標在訊息框裡，X 會被當成打字；Esc 一律可以關閉
  await page.keyboard.press('Escape');
  await expect(page.locator('#sheet')).not.toBeVisible();
  // 畫面上的按鈕也能按
  await page.locator('.controls [data-key="right"]').click();
  await expect(page.locator('#view-calendar')).toBeVisible();
  await page.locator('.controls [data-key="start"]').click();
  await expect(page.locator('#view-record')).toBeVisible();
});

test('手機版：沒有掌機外殼，畫面滿版', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await open(page);
  await expect(page.locator('.controls')).toBeHidden();
  await expect(page.locator('.brand')).toBeHidden();
  const box = await page.locator('#screen').boundingBox();
  expect(box.width).toBe(390);
  await expect(page.locator('nav.tabs')).toBeInViewport();
  await ctx.close();
});

test('同一天重疊的閉關會被擋下（上半場＋下半場可以）', async ({ page }) => {
  await open(page);
  await login(page, GM);
  await tab(page, 'record');
  const addLeave = async (kind, extra) => {
    await page.locator('#add-leave').click();
    await page.locator('#l-date').fill('2026-11-23');
    await page.locator('#l-kind').selectOption(kind);
    if (extra) { await page.locator('#l-start').fill(extra[0]); await page.locator('#l-end').fill(extra[1]); }
    await page.locator('#l-save').click();
  };
  await addLeave('am');
  await page.locator('#done').click();
  await addLeave('custom', ['10:00', '11:00']);
  await expect(page.locator('#toast')).toHaveText('這段時間已經有閉關了');
  await page.locator('#l-cancel').click();
  await addLeave('pm');
  await expect(page.locator('#msg')).toHaveValue(/下半場/);
});

test('電腦版可以切換機種外觀，重新整理後仍記得', async ({ page }) => {
  await open(page);
  const skin = () => page.evaluate(() => document.documentElement.dataset.skin);
  expect(await skin()).toBe('none'); // 預設：無外殼
  await expect(page.locator('.controls')).toBeHidden();
  await tab(page, 'settings');
  await page.locator('#skins [data-skin="boy"]').click();
  expect(await skin()).toBe('boy');
  await expect(page.locator('.brand .name-boy')).toBeVisible();
  await page.locator('#skins [data-skin="wide"]').click();
  expect(await skin()).toBe('wide');
  await expect(page.locator('.dpad')).toBeVisible();
  await page.reload();
  expect(await skin()).toBe('wide');
  await tab(page, 'settings');
  await page.locator('#skins [data-skin="none"]').click();
  await expect(page.locator('.controls')).toBeHidden();
  await expect(page.locator('#skins [data-skin="none"]')).toHaveAttribute('aria-pressed', 'true');
});

test('GM 登入後可以切到觀戰模式避免誤觸，重新整理後仍記得', async ({ page }) => {
  await open(page);
  await login(page, GM);
  await tab(page, 'record');
  await expect(page.locator('[data-status]').first()).toBeVisible();

  await page.locator('#role').click();
  await expect(page.locator('#role')).toHaveText('👀 觀戰（GM）');
  await expect(page.locator('[data-status]')).toHaveCount(0);
  await expect(page.locator('#boss-add, #edit-boss')).toHaveCount(0);
  await page.reload();
  await chip(page, 30).click();
  await expect(page.locator('#role')).toHaveText('👀 觀戰（GM）');
  await expect(page.locator('[data-status]')).toHaveCount(0);

  await tab(page, 'settings');
  await page.locator('#toggle-view').click();
  await expect(page.locator('#role')).toHaveText('✏️ GM');
  await tab(page, 'record');
  await expect(page.locator('[data-status]').first()).toBeVisible();
});

test('在家修煉：整天照班表計算，地圖與成就都標示', async ({ page, request }) => {
  await put(request, 'boards/main/events/r1', { boss: 'b30', at: new Date('2026-11-23T10:40:00+08:00').getTime(), status: 'remote', note: '', by: GM.uid });
  await open(page);
  await tab(page, 'calendar');
  await expect(page.locator('[data-day="2026-11-23"]')).toContainText('在家修煉');
  await tab(page, 'stats');
  await expect(page.locator('#view-stats')).toContainText('在家修煉');
  await expect(page.locator('#view-stats .tile', { hasText: '晚上線' })).toContainText('0');
  await expect(page.locator('.arr')).toContainText('🏠 在家修煉');
});

test('按住按鍵不會連續觸發（按住 Shift 不會一直換魔王）', async ({ page }) => {
  await open(page);
  await expect(chip(page, 30)).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => {
    for (let i = 0; i < 5; i++) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', repeat: i > 0, bubbles: true }));
    }
  });
  // 只有第一下有效：Lv.30 → Lv.50，不會繼續輪轉回 Lv.30
  await expect(chip(page, 50)).toHaveAttribute('aria-pressed', 'true');
});

test('讀取存檔：失敗後可重選同一個檔案；超長名稱以字元截斷不切壞 emoji', async ({ page, request }) => {
  await open(page);
  await login(page, GM);
  await tab(page, 'settings');
  const input = page.locator('#bk-import');
  const bad = { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ events: [], leaves: [] })) };
  await input.setInputFiles(bad);
  await expect(page.locator('#toast')).toContainText('舊版存檔');
  expect(await input.inputValue()).toBe('');

  const longName = 'a' + '😴'.repeat(25); // 上限 20 個 UTF-16 單位：a(1) + 9 個 emoji(各 2) = 19，再加一個就超過
  const save = { bosses: [{ id: 'b99', level: 99, name: longName, note: '' }], events: [], leaves: [], settings: {} };
  await input.setInputFiles({ name: 'save.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.locator('#toast')).toContainText('讀取完成');
  const res = await request.get(`${DOCS}/boards/main/bosses/b99`, { headers: OWNER });
  const name = (await res.json()).fields.name.stringValue;
  expect(name).toBe('a' + '😴'.repeat(9));
  expect(name.isWellFormed()).toBe(true);
});

test('新手教學：第一次打開自動出現，可翻頁、略過，之後不再自動出現', async ({ page }) => {
  await open(page, 30, { tutorial: true });
  const box = page.locator('#tutorial');
  await expect(box).toBeVisible();
  await expect(page.locator('#tut-text')).toContainText('歡迎');
  await page.locator('#tut-next').click(); // 打字中：先把字打完
  await page.locator('#tut-next').click();
  await expect(page.locator('#tut-text')).toContainText('選一隻要觀戰的魔王');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#tut-text')).toContainText('歡迎');
  await page.keyboard.press('x');
  await expect(box).toBeHidden();
  await page.reload();
  await expect(page.locator('body.ready')).toBeAttached();
  await page.waitForTimeout(800);
  await expect(box).toBeHidden();

  // 選單可以重看，一路走到最後
  await tab(page, 'settings');
  await page.locator('#replay-tutorial').click();
  await expect(box).toBeVisible();
  for (let i = 0; i < 30 && await box.isVisible(); i++) await page.locator('#tut-next').click();
  await expect(box).toBeHidden();
});

test('新手教學：GM 第一次登入補教編輯功能', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('maou-log:tutorial', 'done'));
  await open(page, 30, { tutorial: true });
  await expect(page.locator('#tutorial')).toBeHidden();
  await login(page, GM);
  await expect(page.locator('#tutorial')).toBeVisible();
  await expect(page.locator('#tut-text')).toContainText('提供情報');
});

test('記錄時間與發生時間分開：記錄時間小字顯示', async ({ page, request }) => {
  const at = new Date('2026-11-24T08:50:00+08:00').getTime();
  const loggedAt = new Date('2026-11-24T09:05:00+08:00').getTime();
  await put(request, 'boards/main/events/e1', { boss: 'b30', at, status: 'work', note: '', loggedAt, by: GM.uid });
  await open(page);
  const item = page.locator('#view-record .list li').first();
  await expect(item.locator('.time')).toHaveText('08:50');
  await expect(item.locator('.logged')).toHaveText('記錄於 09:05');

  // GM 當下記錄的不會重複顯示記錄時間
  await login(page, GM);
  await tab(page, 'record');
  await page.locator('[data-status="away"]').click();
  await page.locator('#done').click();
  await expect(page.locator('#view-record .list li').nth(1).locator('.logged')).toHaveCount(0);
});

test('在家修煉的日子 GM 不能再更新狀態，但可以修改日誌', async ({ page, request }) => {
  await put(request, 'boards/main/events/r1', { boss: 'b30', at: new Date('2026-11-24T09:30:00+08:00').getTime(), status: 'remote', note: '', by: GM.uid });
  await open(page);
  await login(page, GM);
  await tab(page, 'record');
  await expect(page.locator('#view-record')).toContainText('今天在家修煉，不再更新狀態');
  // 只剩「記錄傳聞」，沒有其他狀態按鈕
  await expect(page.locator('[data-status]')).toHaveCount(1);
  await expect(page.locator('[data-status="rumor"]')).toHaveCount(1);
  await expect(page.locator('#offsets')).toHaveCount(0);
  await expect(page.locator('#view-record [data-edit]')).toHaveCount(1);
  // 地圖的單日細節：補登只能選傳聞
  await tab(page, 'calendar');
  await page.locator('[data-day="2026-11-24"]').click();
  await page.locator('#d-add').click();
  await expect(page.locator('#e-status option')).toHaveText(['🗣️ 其他觀察者說的話（傳聞）']);
  await page.keyboard.press('Escape');
  await tab(page, 'record');
  // Lv.50 沒有在家修煉，照常可以記錄
  await chip(page, 50).click();
  await expect(page.locator('[data-status]').first()).toBeVisible();
});

test('在家修煉不顯示上下線時間', async ({ page, request }) => {
  await put(request, 'boards/main/events/r1', { boss: 'b30', at: new Date('2026-11-24T09:30:00+08:00').getTime(), status: 'remote', note: '', by: GM.uid });
  await open(page);
  await expect(page.locator('#view-record')).toContainText('在家修煉：照班表計算，不記錄上下線時間');
  await expect(page.locator('#view-record .facts')).toHaveCount(0);
  await tab(page, 'calendar');
  await page.locator('[data-day="2026-11-24"]').click();
  await expect(page.locator('#sheet')).toContainText('不記錄上下線時間');
  await expect(page.locator('#sheet .facts')).toHaveCount(0);
});

test('開放註冊：新冒險者出現在清單，只顯示遮住的 email 與在線狀態', async ({ page, browser, request }) => {
  await put(request, 'boards/main', { signupOpen: true });
  await open(page);
  await tab(page, 'settings');
  await page.locator('#login').click();
  await page.locator('#lg-email').fill('newbie.hero@example.test');
  await page.locator('#lg-pass').fill('e2e-newbie-pass');
  await page.locator('#lg-signup').click();
  await expect(page.locator('#sheet')).not.toBeVisible();
  await expect(page.locator('#role')).toHaveText('⚔️ 冒險者');

  const me = page.locator('[data-adv]', { hasText: 'ne***@e***.test' });
  await expect(me).toContainText('（你）');
  await expect(me).toContainText('在線');
  await tab(page, 'record');
  await expect(page.locator('[data-status]').first()).toBeVisible(); // 冒險者可以提供情報

  // 沒登入的觀戰者也看得到清單，並被算成「未登入的觀戰者」
  const ctx = await browser.newContext();
  const viewer = await ctx.newPage();
  await open(viewer);
  await tab(viewer, 'settings');
  await expect(viewer.locator('[data-adv]', { hasText: 'ne***@e***.test' })).toContainText('在線');
  await expect(viewer.locator('#view-settings')).toContainText('另有 1 位未登入的觀戰者');
  await expect(viewer.locator('#view-settings')).not.toContainText('newbie.hero'); // 別人看不到完整 email

  // 新冒險者登出 → 觀戰者看到他變成離線
  await tab(page, 'settings');
  await page.locator('#logout').click();
  await expect(viewer.locator('[data-adv]', { hasText: 'ne***@e***.test' })).toContainText('離線');
  await ctx.close();
});

test('冒險者清單：GM 會標示 GM', async ({ page }) => {
  await open(page);
  await login(page, GM);
  await tab(page, 'settings');
  await expect(page.locator('[data-adv]', { hasText: 'g***@e***.test' })).toContainText('GM');
});

test('刪除只是隱藏：畫面不顯示、資料庫保留；GM 可打開「顯示已隱藏」', async ({ page, browser, request }) => {
  await open(page);
  await login(page, GM);
  await tab(page, 'record');
  await page.locator('[data-status="work"]').click();
  await page.locator('#done').click();
  await expect(page.locator('#view-record h2', { hasText: '冒險者觀察日誌' })).toBeVisible();
  // 情報提供者：GM 的遮罩 email
  await expect(page.locator('#view-record .list li').first().locator('.reporter')).toHaveText('情報：g***@e***.test');

  await page.locator('[data-edit]').first().click();
  await page.locator('#e-del').click();
  await expect(page.locator('#toast')).toContainText('資料仍保留');
  await expect(page.locator('#view-record .list')).toHaveCount(0);

  // 資料庫裡還在，只是標記 deleted
  // 寫入是背景送出的，等它到雲端
  await expect.poll(async () => {
    const docs = (await (await request.get(`${DOCS}/boards/main/events`, { headers: OWNER })).json()).documents || [];
    return docs.map((d) => [d.fields.deleted?.booleanValue, d.fields.history?.arrayValue?.values?.length]);
  }).toEqual([[true, 1]]); // 還在、標記隱藏、修改歷史多一筆「隱藏」

  // GM 打開開關才看得到，標示「已隱藏」且不能修改
  await tab(page, 'settings');
  await page.locator('#toggle-hidden').click();
  await tab(page, 'record');
  await expect(page.locator('#view-record .banner')).toContainText('正在顯示已隱藏的紀錄');
  await expect(page.locator('#view-record .list li.gone')).toContainText('已隱藏');
  await expect(page.locator('#view-record [data-edit]')).toHaveCount(0);
  await page.locator('#hide-hidden').click();
  await expect(page.locator('#view-record .list')).toHaveCount(0);

  // 觀戰者看不到
  const ctx = await browser.newContext();
  const viewer = await ctx.newPage();
  await open(viewer);
  await expect(viewer.locator('#view-record .list')).toHaveCount(0);
  await ctx.close();
});

test('刪除魔王只是隱藏：GM 打開開關才看得到', async ({ page }) => {
  await open(page);
  await login(page, GM);
  await chip(page, 50).click();
  await tab(page, 'record');
  await page.locator('#edit-boss').click();
  await page.locator('#b-del').click();
  await page.locator('#b-del').click();
  await expect(page.locator('[data-boss]')).toHaveCount(1);
  await tab(page, 'settings');
  await page.locator('#toggle-hidden').click();
  await expect(page.locator('[data-boss].gone')).toContainText('Lv.50');
  // 被隱藏的魔王只能看，不能記錄或編輯
  await page.locator('[data-boss].gone').click();
  await tab(page, 'record');
  await expect(page.locator('#view-record')).toContainText('這隻魔王已隱藏，只能查看不能記錄');
  await expect(page.locator('[data-status]')).toHaveCount(0);
  await expect(page.locator('#edit-boss')).toHaveCount(0);
  await tab(page, 'calendar');
  await page.locator('[data-day="2026-11-20"]').click();
  await expect(page.locator('#d-add')).toHaveCount(0);
  await expect(page.locator('#d-leave')).toHaveCount(0);
});

test('修改歷史：點「修正 N 次」展開過去的變更，情報提供者不變', async ({ page, browser }) => {
  await open(page);
  await login(page, GM);
  await tab(page, 'record');
  await page.locator('#note').fill('開會');
  await page.locator('[data-status="work"]').click();
  await page.locator('#done').click();
  const item = page.locator('#view-record .list li').first();
  await expect(item.locator('[data-hist]')).toHaveCount(0);

  // GM 把時間改成 08:55
  await item.locator('[data-edit]').click();
  await page.locator('#e-time').fill('08:55');
  await page.locator('#e-save').click();
  await expect(item.locator('.time')).toHaveText('08:55');
  await expect(item.locator('[data-hist]')).toHaveText('✎ 修正 1 次');
  await item.locator('[data-hist]').click();
  await expect(item.locator('.hist')).toContainText('g***@e***.test 修正：原本是 09:12 上線（開會）');

  // 冒險者再改一次：情報提供者仍是 GM，歷史多一筆
  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await open(other);
  await login(other, OTHER);
  await tab(other, 'record');
  const it2 = other.locator('#view-record .list li').first();
  await it2.locator('[data-edit]').click();
  await other.locator('#e-status').selectOption('remote');
  await other.locator('#e-save').click();
  await expect(it2.locator('.reporter')).toHaveText('情報：g***@e***.test');
  await expect(it2.locator('[data-hist]')).toHaveText('✎ 修正 2 次');
  await it2.locator('[data-hist]').click();
  await expect(it2.locator('.hist li').first()).toContainText('ot***@e***.test 修正：原本是 08:55 上線');
  await ctx.close();
});

test('註冊開關：預設關閉看不到建立帳號；GM 可在選單開放', async ({ page, browser }) => {
  await open(page);
  await tab(page, 'settings');
  await page.locator('#login').click();
  await expect(page.locator('#lg-signup')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('#toggle-signup')).toHaveCount(0); // 觀戰者看不到開關

  await login(page, GM);
  await tab(page, 'settings');
  await expect(page.locator('#view-settings')).toContainText('已關閉');
  await page.locator('#toggle-signup').click();
  await expect(page.locator('#view-settings')).toContainText('開放中');

  const ctx = await browser.newContext();
  const visitor = await ctx.newPage();
  await open(visitor);
  await tab(visitor, 'settings');
  await visitor.locator('#login').click();
  await expect(visitor.locator('#lg-signup')).toBeVisible();
  await ctx.close();
});

test('新註冊的冒險者：看過一般教學後，第一次登入會補教記錄方法', async ({ page, request }) => {
  await put(request, 'boards/main', { signupOpen: true });
  await page.addInitScript(() => localStorage.setItem('maou-log:tutorial', 'done'));
  await open(page, 30, { tutorial: true });
  await expect(page.locator('#tutorial')).toBeHidden();
  await tab(page, 'settings');
  await page.locator('#login').click();
  await page.locator('#lg-email').fill('rookie@example.test');
  await page.locator('#lg-pass').fill('e2e-rookie-pass');
  await page.locator('#lg-signup').click();
  await expect(page.locator('#tutorial')).toBeVisible();
  await expect(page.locator('#tut-text')).toContainText('提供情報');
});

test('讀取存檔不會關掉註冊開關', async ({ page, request }) => {
  await put(request, 'boards/main', { signupOpen: true });
  await open(page);
  await login(page, GM);
  await tab(page, 'settings');
  const save = { bosses: [{ id: 'b99', level: 99, name: '魔王', note: '' }], events: [], leaves: [], settings: {} };
  await page.locator('#bk-import').setInputFiles({ name: 'save.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.locator('#toast')).toContainText('讀取完成');
  await expect(page.locator('#view-settings')).toContainText('開放中');
});

test('發呆摸魚：可以記錄，成就頁另計', async ({ page }) => {
  await open(page);
  await login(page, GM);
  await tab(page, 'record');
  await page.locator('[data-status="slack"]').click();
  await expect(page.locator('#msg')).toHaveValue(/🐟 Lv\.30 魔王 發呆摸魚中…/);
  await page.locator('#done').click();
  await expect(page.locator('.now .label')).toContainText('發呆摸魚');
  await tab(page, 'stats');
  await expect(page.locator('#view-stats .tile', { hasText: '發呆摸魚' })).toBeVisible();
});

test('閉關顯示在冒險者觀察日誌，可以修改並留下修改歷史；GM 可從編輯視窗刪除', async ({ page }) => {
  await open(page);
  await login(page, GM);
  await tab(page, 'record');
  await page.locator('#add-leave').click();
  await page.locator('#l-date').fill('2026-11-24');
  await page.locator('#l-kind').selectOption('am');
  await page.locator('#l-save').click();
  await page.locator('#done').click();
  const row = page.locator('#view-record .list li', { hasText: '閉關' }).first();
  await expect(row).toContainText('上半場');

  await row.locator('[data-edit-leave]').click();
  await page.locator('#l-kind').selectOption('pm');
  await page.locator('#l-save').click();
  await expect(row).toContainText('下半場');
  await row.locator('[data-hist]').click();
  await expect(row.locator('.hist')).toContainText('修正：原本是 11/24（二） 🎫 特休券・上半場');

  await row.locator('[data-edit-leave]').click();
  await page.locator('#l-del').click();
  await expect(page.locator('#toast')).toContainText('資料仍保留');
  await expect(page.locator('#view-record .list li', { hasText: '閉關' })).toHaveCount(0);
});

test('魔王的修改也有歷史，所有人都能展開', async ({ page, browser }) => {
  await open(page);
  await login(page, GM);
  await tab(page, 'record');
  await page.locator('#edit-boss').click();
  await page.locator('#b-level').fill('31');
  await page.locator('#b-save').click();
  await expect(page.locator('.now .label')).toContainText('Lv.31');

  const ctx = await browser.newContext();
  const viewer = await ctx.newPage();
  await open(viewer, 31);
  await viewer.locator('.boss-note [data-hist]').click();
  await expect(viewer.locator('.boss-note .hist')).toContainText('修正：原本是 Lv.30 魔王（愛喝咖啡）');
  await ctx.close();
});

test('記錄後馬上按「按錯了，復原」會真的隱藏', async ({ page, request }) => {
  await open(page);
  await login(page, GM);
  await tab(page, 'record');
  await page.locator('[data-status="work"]').click();
  await page.locator('#undo').click();
  await expect(page.locator('#toast')).toHaveText('已復原');
  await expect(page.locator('#view-record .list')).toHaveCount(0);
  await expect.poll(async () => {
    const docs = (await (await request.get(`${DOCS}/boards/main/events`, { headers: OWNER })).json()).documents || [];
    return docs.map((d) => d.fields.deleted?.booleanValue);
  }).toEqual([true]);
});

test('讀取存檔：存檔裡的魔王和雲端現有的同一隻，會附加修改歷史後更新', async ({ page }) => {
  await open(page);
  await login(page, GM);
  await tab(page, 'settings');
  const save = { bosses: [{ id: 'b30', level: 35, name: '魔王', note: '從存檔來' }], events: [], leaves: [], settings: {} };
  await page.locator('#bk-import').setInputFiles({ name: 'save.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
  await expect(page.locator('#toast')).toContainText('讀取完成');
  await expect(chip(page, 35)).toBeVisible();
  await chip(page, 35).click();
  await tab(page, 'record');
  await expect(page.locator('.boss-note')).toContainText('從存檔來');
  await page.locator('.boss-note [data-hist]').click();
  await expect(page.locator('.boss-note .hist')).toContainText('原本是 Lv.30 魔王（愛喝咖啡）');
});

test('讀取存檔：魔王內容沒變就不附加修改歷史（重複匯入不會耗光修改次數）', async ({ page }) => {
  await open(page);
  await login(page, GM);
  await tab(page, 'settings');
  const save = { bosses: [{ id: 'b30', level: 30, name: '魔王', note: '愛喝咖啡' }], events: [], leaves: [], settings: {} };
  for (let i = 0; i < 2; i++) {
    await page.locator('#bk-import').setInputFiles({ name: 'save.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)) });
    await expect(page.locator('#toast')).toContainText('讀取完成');
  }
  await tab(page, 'record');
  await expect(page.locator('.boss-note [data-hist]')).toHaveCount(0);
});

test('傳聞：旁白必填，不改變魔王狀態，可以一次列出所有傳聞', async ({ page, browser }) => {
  await open(page);
  await login(page, GM);
  await tab(page, 'record');
  await page.locator('[data-status="work"]').click();
  await page.locator('#done').click();

  // 沒寫旁白 → 擋下
  await page.locator('[data-status="rumor"]').click();
  await expect(page.locator('#toast')).toHaveText('傳聞要寫旁白：誰說了什麼');
  await expect(page.locator('#sheet')).not.toBeVisible();

  await page.locator('#note').fill('聽說他今天要開長會');
  await page.locator('[data-status="rumor"]').click();
  await expect(page.locator('#msg')).toHaveValue(/🗣️ 傳聞（Lv\.30 魔王・09:12）：聽說他今天要開長會/);
  await page.locator('#done').click();
  // 魔王狀態仍是上線
  await expect(page.locator('.now .label')).toContainText('上線');
  await expect(page.locator('#view-record .list')).toContainText('聽說他今天要開長會');

  // 觀戰者也能看傳聞一覽
  const ctx = await browser.newContext();
  const viewer = await ctx.newPage();
  await open(viewer);
  await viewer.locator('#rumor-list').click();
  await expect(viewer.locator('#sheet')).toContainText('傳聞一覽');
  await expect(viewer.locator('#sheet')).toContainText('聽說他今天要開長會');
  await expect(viewer.locator('#sheet')).toContainText('g***@e***.test');
  // 傳聞內容與情報提供者分行顯示
  await expect(viewer.locator('#sheet .list li .meta .reporter').first()).toHaveText('情報：g***@e***.test');
  await ctx.close();
});

test('冒險頁顯示最早情報、最後情報與觀察時數，不顯示可下線', async ({ page, request }) => {
  await put(request, 'boards/main/events/a1', { boss: 'b30', at: new Date('2026-11-24T08:50:00+08:00').getTime(), status: 'work', note: '', by: GM.uid });
  await put(request, 'boards/main/events/a2', { boss: 'b30', at: new Date('2026-11-24T09:05:00+08:00').getTime(), status: 'slack', note: '', by: GM.uid });
  await open(page);
  const facts = page.locator('#view-record .facts');
  await expect(facts).toContainText('最早情報08:50');
  await expect(facts).toContainText('最後情報09:05（發呆摸魚）');
  await expect(facts).toContainText('觀察時數');
  await expect(page.locator('#view-record')).not.toContainText('可下線');
});

test('休戰日在家修煉：地圖顯示在家修煉，不是假日加場', async ({ page, request }) => {
  // 2026-11-22 是週日
  await put(request, 'boards/main/events/h1', { boss: 'b30', at: new Date('2026-11-22T10:00:00+08:00').getTime(), status: 'remote', note: '', by: GM.uid });
  await open(page);
  await tab(page, 'calendar');
  const cell = page.locator('[data-day="2026-11-22"]');
  await expect(cell).toContainText('在家修煉');
  // 格子的顏色條是「在家修煉」而不是「假日加場」
  const color = await cell.locator('.bar').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(color).toBe('rgb(115, 239, 247)');
});

test('地圖不會被長文字撐寬（切換魔王也一樣）', async ({ page, request }) => {
  for (const [id, d] of [['l1', '2026-11-02'], ['l2', '2026-11-03']]) {
    await put(request, `boards/main/leaves/${id}`, { boss: 'b50', date: d, kind: 'full', type: '❓ 一個很長很長很長的假別名稱', note: '', by: GM.uid });
  }
  await open(page);
  await tab(page, 'calendar');
  await chip(page, 50).click();
  const fits = await page.evaluate(() => {
    const scr = document.querySelector('#scroll');
    return scr.scrollWidth <= scr.clientWidth && document.querySelector('.cal').getBoundingClientRect().right <= scr.getBoundingClientRect().right;
  });
  expect(fits).toBe(true);
});

test('在家修煉的日子仍可記錄傳聞（只能記傳聞），只有傳聞的日子單日細節不顯示空白數字', async ({ page, request }) => {
  await put(request, 'boards/main/events/r1', { boss: 'b30', at: new Date('2026-11-24T09:30:00+08:00').getTime(), status: 'remote', note: '', by: GM.uid });
  await put(request, 'boards/main/events/q1', { boss: 'b30', at: new Date('2026-11-20T10:00:00+08:00').getTime(), status: 'rumor', note: '聽說請假', by: GM.uid });
  await open(page);
  await login(page, GM);
  await tab(page, 'record');
  await page.locator('#note').fill('聽說在家開會');
  await page.locator('[data-status="rumor"]').click();
  await page.locator('#done').click();
  await expect(page.locator('#view-record .list')).toContainText('聽說在家開會');

  await tab(page, 'calendar');
  await page.locator('[data-day="2026-11-24"]').click();
  await page.locator('#d-add').click();
  await expect(page.locator('#e-status option')).toHaveCount(1);
  await page.keyboard.press('Escape');

  await page.locator('[data-day="2026-11-20"]').click();
  await expect(page.locator('#sheet')).toContainText('聽說請假');
  await expect(page.locator('#sheet .facts')).toHaveCount(0);
});

test('休戰日在家修煉不鎖記錄：補登仍可選所有狀態；只有傳聞的日子補登預設 09:00 上線', async ({ page, request }) => {
  await put(request, 'boards/main/events/h1', { boss: 'b30', at: new Date('2026-11-22T10:00:00+08:00').getTime(), status: 'remote', note: '', by: GM.uid });
  await put(request, 'boards/main/events/q1', { boss: 'b30', at: new Date('2026-11-20T10:00:00+08:00').getTime(), status: 'rumor', note: '聽說請假', by: GM.uid });
  await open(page);
  await login(page, GM);
  await tab(page, 'calendar');
  await page.locator('[data-day="2026-11-22"]').click();
  await page.locator('#d-add').click();
  expect(await page.locator('#e-status option').count()).toBeGreaterThan(5);
  await page.keyboard.press('Escape');

  await page.locator('[data-day="2026-11-20"]').click();
  await page.locator('#d-add').click();
  await expect(page.locator('#e-time')).toHaveValue('09:00');
  await expect(page.locator('#e-status')).toHaveValue('work');
});

test('前幾天沒看到下線：冒險頁不提醒補登，地圖仍標「未見下線」', async ({ page, request }) => {
  await put(request, 'boards/main/events/mo1', { boss: 'b30', at: new Date('2026-11-23T09:00:00+08:00').getTime(), status: 'work', note: '', by: GM.uid });
  await open(page);
  await login(page, GM);
  await tab(page, 'record');
  await expect(page.locator('#view-record .now')).toBeVisible();
  await expect(page.locator('#view-record')).not.toContainText('沒看到');
  await expect(page.locator('#fix-missing')).toHaveCount(0);
  await tab(page, 'calendar');
  await page.locator('[data-day="2026-11-23"]').click();
  await expect(page.locator('#sheet')).toContainText('未見下線');
});

test('每日上線時刻：範圍大時刻度對齊整點，頭尾都有刻度', async ({ page, request }) => {
  await put(request, 'boards/main/events/x1', { boss: 'b30', at: new Date('2026-11-23T07:40:00+08:00').getTime(), status: 'work', note: '', by: GM.uid });
  await put(request, 'boards/main/events/x2', { boss: 'b30', at: new Date('2026-11-20T10:50:00+08:00').getTime(), status: 'work', note: '', by: GM.uid });
  await open(page);
  await tab(page, 'stats');
  const ticks = await page.locator('.arr .axis span').allTextContents();
  expect(ticks).toEqual(['07:00', '08:00', '09:00', '10:00', '11:00']);
});

test('手機寬度：日誌第一行是時間・狀態・修改（按鈕大小一致），旁白與修正紀錄用滿整列；傳聞一覽不受影響', async ({ page, request }) => {
  const at = new Date(NOW).getTime() - 60 * 1000;
  const note = '考績表 開一個下午欸 來整天下午 只處理考績表~ 確實很慎重!';
  await put(request, 'boards/main/events/long1', { boss: 'b30', at, status: 'rumor', note, by: GM.uid, reporter: GM.uid,
    history: [{ t: at, by: GM.uid, action: 'edit', at, status: 'back', note }] });
  await put(request, 'boards/main/events/short1', { boss: 'b30', at: at - 3600 * 1000, status: 'work', note: '', by: GM.uid });
  await put(request, 'boards/main/events/gone1', { boss: 'b30', at: at - 1800 * 1000, status: 'lunch', note: '', by: GM.uid, deleted: true });
  await page.setViewportSize({ width: 360, height: 780 });
  await open(page);
  await login(page, GM);
  await tab(page, 'record');

  const row = (id) => page.locator('#view-record .list li', { has: page.locator(`[data-edit="${id}"]`) });
  await row('long1').locator('[data-hist]').click();
  const b = await row('long1').locator('[data-edit]').boundingBox();
  const b2 = await row('short1').locator('[data-edit]').boundingBox();
  const li = await row('long1').boundingBox();
  const main = await row('long1').locator('.main').boundingBox();
  const meta = await row('long1').locator('.meta').boundingBox();
  expect([Math.round(b.width), Math.round(b.height)]).toEqual([Math.round(b2.width), Math.round(b2.height)]); // 每列按鈕一樣大
  expect(b.width).toBeGreaterThan(b.height); // 不會被擠成直排
  expect(b.height).toBeGreaterThanOrEqual(36); // 觸控目標
  expect(b.y).toBeLessThan(meta.y); // 按鈕在第一行
  expect(Math.abs((b.y + b.height / 2) - (main.y + main.height / 2))).toBeLessThan(10);
  expect(meta.width).toBeGreaterThan(li.width * 0.95); // 旁白與修正紀錄用滿整列
  expect((await row('long1').locator('[data-hist]').boundingBox()).height).toBeGreaterThanOrEqual(24);
  if (process.env.SHOT) { await row('long1').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${process.env.SHOT}/log-360.png` }); }

  // 已隱藏的列：刪除線仍在
  await tab(page, 'settings');
  await page.locator('#toggle-hidden').click();
  await tab(page, 'record');
  const gone = page.locator('#view-record .list li.gone').first();
  await expect(gone).toBeVisible();
  expect(await gone.locator('.main').evaluate((el) => getComputedStyle(el).textDecorationLine)).toContain('line-through');

  // 傳聞一覽：時間在左、內容在右，不重疊
  await page.locator('#rumor-list').click();
  const r = page.locator('#sheet .list li').first();
  const t = await r.locator('.time').boundingBox();
  const m = await r.locator('.main').boundingBox();
  expect(t.x + t.width).toBeLessThanOrEqual(m.x);
  if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}/rumors-360.png` });
});

test('19:00 後停止計時：狀態時間與觀察時數只算到 19:00', async ({ page, request }) => {
  await put(request, 'boards/main/events/w1', { boss: 'b30', at: new Date('2026-11-24T09:00:00+08:00').getTime(), status: 'work', note: '', by: GM.uid });
  await put(request, 'boards/main/events/a1', { boss: 'b30', at: new Date('2026-11-24T17:35:00+08:00').getTime(), status: 'away', note: '', by: GM.uid });
  await page.clock.setFixedTime(new Date('2026-11-24T20:22:00+08:00'));
  await skipTutorial(page);
  await page.route('https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/**', (route) => route.fulfill({ json: [] }));
  await page.route('https://api.ipify.org/**', (route) => route.fulfill({ json: { ip: '203.0.113.7' } }));
  await page.goto('/?emulator');
  await chip(page, 30).click();
  await expect(page.locator('.now')).toContainText('從 17:35 開始・已 1 小時 25 分（算到 19:00）');
  await expect(page.locator('.facts')).toContainText('9時'); // 09:00–19:00 扣午休（王座無人仍在冒險中），不是算到 20:22
});

test('魔王等級只能提升，不能降低', async ({ page }) => {
  await open(page);
  await login(page, GM);
  await tab(page, 'record');
  await page.locator('#edit-boss').click();
  await page.locator('#b-level').fill('29');
  await page.locator('#b-save').click();
  await expect(page.locator('#toast')).toHaveText('等級只能提升，不能低於 Lv.30');
  await page.locator('#b-level').fill('31');
  await page.locator('#b-save').click();
  await expect(page.locator('.now .label')).toContainText('Lv.31');
});

test('廣播訊息範本預設收起，點開可以編輯', async ({ page }) => {
  await open(page);
  await login(page, GM);
  await tab(page, 'settings');
  await expect(page.locator('#tpl-fold')).not.toHaveAttribute('open', '');
  await expect(page.locator('[data-tpl]').first()).toBeHidden();
  await page.locator('#tpl-fold > summary').click();
  await expect(page.locator('[data-tpl]').first()).toBeVisible();
});

test('冒險者清單：GM 看得到最後上線時間與 IP 代號（含未登入的觀戰者），其他人看不到', async ({ page, browser }) => {
  // 先有一位未登入的觀戰者來過
  const viewerCtx = await browser.newContext();
  const viewer = await viewerCtx.newPage();
  await open(viewer);
  await expect.poll(async () => (await viewer.locator('#online').textContent()) || '').toMatch(/\d/);
  await viewer.waitForTimeout(1500); // 等造訪紀錄寫入
  await tab(viewer, 'settings');
  await expect(viewer.locator('#view-settings')).not.toContainText('#9945'); // 觀戰者看不到代號

  await open(page);
  await login(page, GM);
  await tab(page, 'settings');
  const adv = page.locator('#view-settings');
  await expect(adv).toContainText('未登入的觀戰者');
  await expect(adv.locator('.var-chip', { hasText: '#9945' }).first()).toBeVisible(); // 203.0.113.7 的代號
  await expect(adv).not.toContainText('203.0.113.7'); // 不顯示完整 IP
  if (process.env.SHOT) {
    await page.setViewportSize({ width: 360, height: 780 });
    await adv.locator('.var-chip', { hasText: '#9945' }).first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.SHOT}/adv-360.png` });
  }
  await viewerCtx.close();
});

test('造訪紀錄：冒險者登出後，GM 仍看得到他的最後上線時間', async ({ page, browser }) => {
  const ctx = await browser.newContext();
  const adv = await ctx.newPage();
  await open(adv);
  await login(adv, OTHER);
  await adv.waitForTimeout(1500);
  await tab(adv, 'settings');
  await adv.locator('#logout').click();
  await adv.waitForTimeout(1500);
  await ctx.close();

  await open(page);
  await login(page, GM);
  await tab(page, 'settings');
  const row = page.locator(`[data-adv="${OTHER.uid}"]`);
  await expect(row).toContainText('最後');
  await expect(row.locator('.var-chip')).toHaveText('#9945');
  await expect(row).toContainText(/最後 (今天|昨天|\d+\/\d+) \d\d:\d\d/); // 測試時頁面時鐘固定、伺服器時間是真的，所以不限定「今天」
  // 手機寬度：離線＋代號＋時間的列、帳號卡都不會撐出畫面
  await page.setViewportSize({ width: 360, height: 780 });
  await expect.poll(() => page.evaluate(() => { const el = document.querySelector('#scroll'); return el.scrollWidth - el.clientWidth; })).toBe(0);
  const card = await row.locator('xpath=ancestor::div[contains(@class,"card")][1]').boundingBox();
  const meta = await row.locator('.adv-meta').boundingBox();
  expect(meta.x + meta.width).toBeLessThanOrEqual(card.x + card.width);
  if (process.env.SHOT) { await row.scrollIntoViewIfNeeded(); await page.screenshot({ path: `${process.env.SHOT}/adv2-360.png` }); }
});

test('19:00 後才記錄的狀態：不標註「算到 19:00」', async ({ page, request }) => {
  await put(request, 'boards/main/events/w1', { boss: 'b30', at: new Date('2026-11-24T09:00:00+08:00').getTime(), status: 'work', note: '', by: GM.uid });
  await put(request, 'boards/main/events/o1', { boss: 'b30', at: new Date('2026-11-24T19:30:00+08:00').getTime(), status: 'off', note: '', by: GM.uid });
  await page.clock.setFixedTime(new Date('2026-11-24T20:00:00+08:00'));
  await skipTutorial(page);
  await page.route('https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/**', (route) => route.fulfill({ json: [] }));
  await page.route('https://api.ipify.org/**', (route) => route.fulfill({ json: { ip: '203.0.113.7' } }));
  await page.goto('/?emulator');
  await chip(page, 30).click();
  await expect(page.locator('.now')).toContainText('從 19:30 開始・已 30 分'); // 下線多久照實際時間算
  await expect(page.locator('.now')).not.toContainText('算到');
});

test('下線多久照實際時間算，不受 19:00 影響', async ({ page, request }) => {
  await put(request, 'boards/main/events/w1', { boss: 'b30', at: new Date('2026-11-24T09:00:00+08:00').getTime(), status: 'work', note: '', by: GM.uid });
  await put(request, 'boards/main/events/o1', { boss: 'b30', at: new Date('2026-11-24T18:10:00+08:00').getTime(), status: 'off', note: '', by: GM.uid });
  await page.clock.setFixedTime(new Date('2026-11-24T20:30:00+08:00'));
  await skipTutorial(page);
  await page.route('https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/**', (route) => route.fulfill({ json: [] }));
  await page.route('https://api.ipify.org/**', (route) => route.fulfill({ json: { ip: '203.0.113.7' } }));
  await page.goto('/?emulator');
  await chip(page, 30).click();
  await expect(page.locator('.now')).toContainText('從 18:10 開始・已 2 小時 20 分');
  await expect(page.locator('.now')).not.toContainText('算到');
});

test('暫時關閉網站：觀戰者與冒險者只看到關閉畫面，GM 照常使用並可重新開放', async ({ page, browser }) => {
  await open(page);
  await login(page, GM);
  await tab(page, 'settings');
  await page.locator('#closed-note').fill('整修中，明天見');
  await page.locator('#closed-note').dispatchEvent('change');
  await expect(page.locator('#toast')).toHaveText('已儲存說明');
  // 觀戰者先開著面板（關站時要被收起）
  const viewerCtx = await browser.newContext();
  const viewer = await viewerCtx.newPage();
  await open(viewer);
  await tab(viewer, 'settings');
  await viewer.locator('#login').click();
  await expect(viewer.locator('#sheet')).toBeVisible();

  await page.locator('#toggle-site').click();
  await expect(page.locator('#toggle-site')).toHaveText('再按一次確定關閉'); // 關閉要再按一次確認
  await expect(page.locator('#closed-banner')).toBeHidden();
  await page.locator('#toggle-site').click();
  await expect(page.locator('#closed-banner')).toBeVisible(); // GM 看到提示，內容照常
  await expect(page.locator('[data-boss]').first()).toBeVisible();

  // 觀戰者：面板被收起，只看到關閉畫面與說明，讀不到魔王
  await expect(viewer.locator('#closed')).toBeVisible();
  await expect(viewer.locator('#sheet')).toBeHidden();
  await expect(viewer.locator('#closed')).toContainText('魔王城暫時關閉中');
  await expect(viewer.locator('#closed')).toContainText('整修中，明天見');
  await expect(viewer.locator('nav.tabs')).toBeHidden();
  await expect(viewer.locator('[data-boss]')).toHaveCount(0);
  if (process.env.SHOT) {
    const m = await (await browser.newContext({ viewport: { width: 360, height: 640 }, isMobile: true })).newPage();
    await skipTutorial(m);
    await m.route('https://api.ipify.org/**', (route) => route.fulfill({ json: { ip: '203.0.113.7' } }));
    await m.goto('/?emulator');
    await expect(m.locator('#closed')).toBeVisible();
    await m.screenshot({ path: `${process.env.SHOT}/closed-360.png` });
    await page.setViewportSize({ width: 360, height: 640 });
    await page.evaluate(() => document.querySelector('#scroll').scrollTo(0, 0));
    await page.screenshot({ path: `${process.env.SHOT}/closed-gm-360.png` });
  }

  // 冒險者登入也一樣，但有說明與登出的出路
  await viewer.locator('#closed-login').click();
  await viewer.locator('#lg-email').fill(OTHER.email);
  await viewer.locator('#lg-pass').fill(OTHER.password);
  await viewer.locator('#login-form button[type=submit]').click();
  await expect(viewer.locator('#closed')).toContainText('你已用 ot***@e***.test 登入');
  await expect(viewer.locator('[data-boss]')).toHaveCount(0);
  await viewer.locator('#closed-logout').click();
  await expect(viewer.locator('#closed-login')).toBeVisible();

  // GM 重新開放：觀戰者的畫面即時恢復
  await page.locator('#banner-open').click();
  await expect(page.locator('#closed-banner')).toBeHidden();
  await expect(viewer.locator('#closed')).toBeHidden();
  await expect(viewer.locator('[data-boss]')).toHaveCount(2);
  await expect(viewer.locator('#toast')).toHaveText('魔王城重新開放了');
  await viewerCtx.close();
});

test('網站已關閉時 GM 從關閉畫面登入：看得到資料，按鍵在關閉畫面不作用', async ({ page, request }) => {
  await put(request, 'boards/main', { siteOpen: false, closedNote: '休息中' });
  await page.clock.setFixedTime(NOW);
  await skipTutorial(page);
  await page.route('https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/**', (route) => route.fulfill({ json: [] }));
  await page.route('https://api.ipify.org/**', (route) => route.fulfill({ json: { ip: '203.0.113.7' } }));
  await page.goto('/?emulator');
  await expect(page.locator('body.ready')).toBeAttached();
  await expect(page.locator('#closed')).toContainText('休息中');
  await page.keyboard.press('z'); // 掌機按鍵／鍵盤快捷鍵不作用
  await expect(page.locator('#sheet')).toBeHidden();
  await page.locator('#closed-login').click();
  await page.locator('#lg-email').fill(GM.email);
  await page.locator('#lg-pass').fill(GM.password);
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#closed')).toBeHidden();
  await expect(page.locator('#closed-banner')).toBeVisible();
  await expect(page.locator('[data-boss]')).toHaveCount(2);
  await expect(page.locator('#toast')).not.toContainText('同步失敗');
});

// 開啟網站但不選魔王（網站可能是關閉的）
async function openAt(page, time) {
  await page.clock.setFixedTime(time);
  await skipTutorial(page);
  await page.route('https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/**', (route) => route.fulfill({ json: [] }));
  await page.route('https://api.ipify.org/**', (route) => route.fulfill({ json: { ip: '203.0.113.7' } }));
  await page.goto('/?emulator');
  await expect(page.locator('body.ready')).toBeAttached();
}

test('定時開放：GM 在選單設定時段；時間不對會被擋下', async ({ page }) => {
  await open(page);
  await login(page, GM);
  await tab(page, 'settings');
  await expect(page.locator('#toggle-hours')).toHaveText('啟用定時');
  await page.locator('#open-from').fill('17:00');
  await page.locator('#save-hours').click();
  await expect(page.locator('#toast')).toHaveText('開放時間要早於關閉時間');
  await expect(page.locator('#open-from')).toHaveValue('09:00'); // 退回原本的設定
  // 兩個時間一起改：先改開放時間也可以（存的時候才一起檢查）
  await page.locator('#open-from').fill('18:00');
  await page.locator('#open-to').fill('22:00');
  await page.locator('#save-hours').click();
  await expect(page.locator('#toast')).toHaveText('已儲存時段：平日 18:00–22:00');
  await page.locator('#open-from').fill('09:00');
  await page.locator('#open-to').fill('18:30');
  await page.locator('#save-hours').click();
  await expect(page.locator('#toast')).toHaveText('已儲存時段：平日 09:00–18:30');
  await page.locator('#toggle-hours').click();
  await expect(page.locator('#toast')).toHaveText('已設定定時開放：平日 09:00–18:30');
  await expect(page.locator('#toggle-hours')).toHaveText('停用定時');
  await expect(page.locator('#view-settings')).toContainText('🟢 已啟用：平日 09:00–18:30 開放');
  await expect(page.locator('#closed-banner')).toBeHidden(); // 週二 09:12：開放中
  // 停用：不管輸入框裡還沒存的時間
  await page.locator('#open-to').fill('08:00');
  await page.locator('#toggle-hours').click();
  await expect(page.locator('#toast')).toHaveText('已停用定時開放');
  await expect(page.locator('#open-to')).toHaveValue('18:30');
  await page.locator('#toggle-hours').click();
  if (process.env.SHOT) {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.locator('#toggle-hours').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.SHOT}/hours-360.png` });
  }
});

test('定時開放：時段外與週末觀戰者看到休息畫面；GM 照常使用並看到提示', async ({ page, browser, request }) => {
  await put(request, 'boards/main', { hoursOn: true, openFrom: 540, openTo: 1020 });
  await openAt(page, new Date('2026-11-24T17:30:00+08:00')); // 週二 17:30
  await expect(page.locator('#closed')).toContainText('魔王城休息中');
  await expect(page.locator('#closed')).toContainText('開放時間：平日 09:00–17:00');
  await expect(page.locator('[data-boss]')).toHaveCount(0);
  const sat = await (await browser.newContext()).newPage();
  await openAt(sat, new Date('2026-11-28T10:00:00+08:00')); // 週六
  await expect(sat.locator('#closed')).toContainText('魔王城休息中');

  await page.locator('#closed-login').click();
  await page.locator('#lg-email').fill(GM.email);
  await page.locator('#lg-pass').fill(GM.password);
  await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#closed')).toBeHidden();
  await expect(page.locator('#closed-banner')).toContainText('開放時間外（平日 09:00–17:00）');
  await expect(page.locator('#banner-open')).toHaveCount(0); // 時段外不能一鍵開放（要改時段或停用定時）
  await expect(page.locator('[data-boss]')).toHaveCount(2);
  await tab(page, 'settings');
  await expect(page.locator('#view-settings')).toContainText('🌙 開放時間外');
  await expect(page.locator('#toggle-site')).toHaveText('暫時關閉');
});

test('定時開放：時間到了開著的頁面自動關閉', async ({ page, request }) => {
  await open(page); // 週二 09:12，還沒定時
  await put(request, 'boards/main', { hoursOn: true, openFrom: 540, openTo: 553 }); // 09:00–09:13
  await expect(page.locator('#closed')).toBeHidden();
  await page.clock.setFixedTime(new Date('2026-11-24T09:13:10+08:00'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('#closed')).toContainText('魔王城休息中');
  await expect(page.locator('[data-boss]')).toHaveCount(0);
});

test('網站關閉時 GM：輸入中也看到提示列；重新整理不會先閃出關閉畫面', async ({ page, request }) => {
  await open(page);
  await login(page, GM);
  await page.locator('#closed-note').focus(); // GM 正在輸入時有人關閉網站：提示列也要出現
  await put(request, 'boards/main', { siteOpen: false, closedNote: '' });
  await expect(page.locator('#closed-banner')).toBeVisible();
  // 記錄重新整理過程中關閉畫面有沒有出現過
  await page.addInitScript(() => {
    new MutationObserver(() => {
      const el = document.getElementById('closed');
      if (el && !el.hidden) window.__closedSeen = true;
    }).observe(document, { subtree: true, childList: true, attributes: true });
  });
  await page.reload();
  await expect(page.locator('body.ready')).toBeAttached();
  await expect(page.locator('#closed-banner')).toBeVisible();
  await expect(page.locator('[data-boss]').first()).toBeVisible();
  expect(await page.evaluate(() => !!window.__closedSeen)).toBe(false);
});
