// E2E：在 Firebase 模擬器上跑完整流程（npm run test:e2e）
// 帳號與資料都在模擬器裡，不會碰到正式資料
import { test, expect } from '@playwright/test';
import { EDITOR_UIDS } from '../firebase-config.js';

const PROJECT = 'maou-log-jt2c4';
const AUTH = 'http://127.0.0.1:9099';
const DOCS = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`;
const GM = { uid: EDITOR_UIDS[0], email: 'gm@example.test', password: 'e2e-gm-pass' };
const OTHER = { uid: 'e2e-other', email: 'other@example.test', password: 'e2e-other-pass' };
// 2026-11-24（二）09:12：比 09:00 晚 12 分
const NOW = new Date('2026-11-24T09:12:00+08:00');
const OWNER = { Authorization: 'Bearer owner' }; // 模擬器的管理權限，跳過安全規則

// 直接在模擬器寫入資料（Firestore REST 格式）
const value = (v) => (typeof v === 'number' ? { integerValue: String(v) } : { stringValue: v });
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
});

// 打開網站並選擇魔王（pick = null 表示不選）
async function open(page, pick = 30) {
  await page.clock.setFixedTime(NOW);
  // 休戰日資料改用空清單，測試不依賴外部網路
  await page.route('https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/**', (route) => route.fulfill({ json: [] }));
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
  await expect(page.locator('#view-settings')).toContainText('v1.0.0');
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

test('登入畫面沒有建立帳號，密碼錯誤會提示', async ({ page }) => {
  await open(page);
  await tab(page, 'settings');
  await page.locator('#login').click();
  await expect(page.locator('#sheet')).not.toContainText('建立帳號');
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

test('非編輯者登入：仍是觀戰模式，不能記錄', async ({ page }) => {
  await open(page);
  await login(page, OTHER);
  await expect(page.locator('#toast')).toContainText('沒有編輯權限');
  await expect(page.locator('#role')).toHaveText(/觀戰/);
  await tab(page, 'record');
  await expect(page.locator('[data-status]')).toHaveCount(0);
  await expect(page.locator('#boss-add')).toHaveCount(0);
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
  await open(page);
  await expect(page.locator('.controls')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#view-calendar')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#view-record')).toBeVisible();
  await page.keyboard.press('Shift');
  await expect(chip(page, 50)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('z');
  await expect(page.locator('#sheet')).toBeVisible();
  await expect(page.locator('#msg')).toHaveValue(/Lv\.50/);
  await page.keyboard.press('x');
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
  expect(await skin()).toBe('boy');
  await tab(page, 'settings');
  await page.locator('#skins [data-skin="wide"]').click();
  expect(await skin()).toBe('wide');
  await expect(page.locator('.brand .name-wide')).toBeVisible();
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
