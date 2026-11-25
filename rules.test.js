import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateSchedule, evaluateDay, summarize, leavesWorkMinutes, leavesOverlap, taipeiMs, dateKey, minutesOf, addDays, dayType, leaveDays, renderTemplate, faultText, leaveSpanText, bossLabel, DEFAULT_TEMPLATES, maskEmail, parseHHMM as t,
} from './rules.js';

const at = (date, hhmm) => taipeiMs(date, hhmm);
const D = '2026-11-23'; // 週一
const day = (evs, extra = {}) => evaluateDay({
  date: D, today: '2026-11-25', nowMin: 600, workday: true,
  events: evs.map(([hhmm, status]) => ({ at: at(D, hhmm), status })),
  ...extra,
});

test('彈性上班：08:30 前以 08:30 起算，17:30 可下班', () => {
  const r = evaluateSchedule(t('08:10'));
  assert.equal(r.expectedLeave, t('17:30'));
  assert.equal(r.lateMinutes, 0);
});

test('彈性上班：08:45 到班，17:45 可下班', () => {
  assert.equal(evaluateSchedule(t('08:45')).expectedLeave, t('17:45'));
});

test('09:00 準時，18:00 下班', () => {
  const r = evaluateSchedule(t('09:00'));
  assert.equal(r.expectedLeave, t('18:00'));
  assert.equal(r.lateMinutes, 0);
});

test('09:10 到班：遲到 10 分，18:00 下班', () => {
  const r = evaluateSchedule(t('09:10'));
  assert.equal(r.lateMinutes, 10);
  assert.equal(r.expectedLeave, t('18:00'));
});

test('上午半天：13:00 前到不算遲到，18:00 下班', () => {
  const r = evaluateSchedule(t('12:50'), [{ kind: 'am' }]);
  assert.equal(r.lateMinutes, 0);
  assert.equal(r.expectedLeave, t('18:00'));
  assert.equal(evaluateSchedule(t('13:20'), [{ kind: 'am' }]).lateMinutes, 20);
});

test('下午半天：到班 + 3 小時下班', () => {
  assert.equal(evaluateSchedule(t('09:00'), [{ kind: 'pm' }]).expectedLeave, t('12:00'));
  assert.equal(evaluateSchedule(t('08:30'), [{ kind: 'pm' }]).expectedLeave, t('11:30'));
  assert.equal(evaluateSchedule(t('08:00'), [{ kind: 'pm' }]).expectedLeave, t('11:30'));
});

test('自訂時段：09:00–10:30 請假，10:30 後才算遲到', () => {
  const lv = [{ kind: 'custom', start: '09:00', end: '10:30' }];
  assert.equal(evaluateSchedule(t('10:20'), lv).lateMinutes, 0);
  assert.equal(evaluateSchedule(t('10:40'), lv).lateMinutes, 10);
});

test('自訂時段：16:00–18:00 請假，提早到 16:00 下班', () => {
  const lv = [{ kind: 'custom', start: '16:00', end: '18:00' }];
  assert.equal(evaluateSchedule(t('09:00'), lv).expectedLeave, t('16:00'));
});

test('自訂時段放到收服：提早上線的人可下線時間一起往前移', () => {
  // 08:30 上線（原本 17:30 可下線），17:30–18:00 請假 → 17:00
  assert.equal(evaluateSchedule(t('08:30'), [{ kind: 'custom', start: '17:30', end: '18:00' }]).expectedLeave, t('17:00'));
  assert.equal(evaluateSchedule(t('08:30'), [{ kind: 'custom', start: '17:29', end: '18:00' }]).expectedLeave, t('16:59'));
  // 假在可下線之後才開始也不會延後
  assert.equal(evaluateSchedule(t('09:00'), [{ kind: 'custom', start: '18:00', end: '19:00' }]).expectedLeave, t('18:00'));
});

test('重疊的閉關只算一次', () => {
  const am = { kind: 'am', date: D };
  const c = { kind: 'custom', start: '10:00', end: '12:00', date: D };
  assert.equal(leavesWorkMinutes([am, c]), 180);
  assert.equal(day([], { leaves: [am, c] }).requiredMinutes, 300);
  assert.equal(leavesOverlap(am, c), true);
  assert.equal(leavesOverlap(am, { kind: 'pm', date: D }), false); // 只在午休重疊
  assert.equal(leavesOverlap(am, { kind: 'custom', start: '14:00', end: '15:00', date: D }), false);
  assert.equal(leavesOverlap(am, { ...c, date: '2026-11-24' }), false);
});

test('整天假視為休假', () => {
  assert.equal(evaluateSchedule(0, [{ kind: 'full' }]).fullLeave, true);
  assert.equal(day([], { leaves: [{ kind: 'full', type: '特休' }] }).state, 'leave');
});

test('完整一天：工時扣午休', () => {
  const r = day([['08:50', 'makeup'], ['09:10', 'work'], ['12:00', 'lunch'], ['13:20', 'work'], ['18:10', 'off']]);
  assert.equal(r.state, 'complete');
  assert.equal(r.arrival, t('08:50'));
  assert.equal(r.expectedLeave, t('17:50'));
  assert.equal(r.overtimeMinutes, 20);
  assert.equal(r.lunchMinutes, 80);
  // 08:50–12:00 = 190 分；13:20–18:10 = 290 分
  assert.equal(r.workMinutes, 480);
});

test('離開座位算工時，並統計次數', () => {
  const r = day([['09:00', 'work'], ['10:00', 'away'], ['10:30', 'work'], ['17:00', 'off']]);
  assert.equal(r.awayCount, 1);
  assert.equal(r.awayMinutes, 30);
  assert.equal(r.workMinutes, 420);
  assert.equal(r.earlyMinutes, 60);
});

test('回到王座、睡覺回血都算工時，睡覺另計次數', () => {
  const r = day([['09:00', 'work'], ['10:00', 'away'], ['10:20', 'back'], ['14:00', 'nap'], ['14:30', 'work'], ['18:00', 'off']]);
  assert.equal(r.workMinutes, 480);
  assert.equal(r.napCount, 1);
  assert.equal(r.napMinutes, 30);
});

test('在家修煉：整天視為照班表上班，不計失誤', () => {
  const r = day([['10:30', 'remote']]); // 晚、也沒有下線紀錄
  assert.equal(r.remote, true);
  assert.equal(r.state, 'complete');
  assert.equal(r.lateMinutes, 0);
  assert.equal(r.earlyMinutes, 0);
  assert.equal(r.workMinutes, 480);
  // 下半場閉關：只算剩下的表定時數
  assert.equal(day([['09:30', 'remote']], { leaves: [{ kind: 'pm', type: 'x' }] }).workMinutes, 180);
  // 統計：算通關日，但不列入上線時刻
  const s = summarize([r, day([['08:50', 'work'], ['18:00', 'off']])]);
  assert.equal(s.completeDays, 2);
  assert.equal(s.remoteDays, 1);
  assert.equal(s.lateCount, 0);
  assert.equal(s.avgArrival, t('08:50'));
  assert.equal(s.workMinutes, 480 + 490); // 在家修煉 480 + 08:50–18:00 扣午休 490
});

test('發呆摸魚：算上線時數，另計次數與時間', () => {
  const r = day([['09:00', 'work'], ['10:00', 'slack'], ['10:40', 'work'], ['18:00', 'off']]);
  assert.equal(r.workMinutes, 480);
  assert.equal(r.slackCount, 1);
  assert.equal(r.slackMinutes, 40);
  const s = summarize([r]);
  assert.equal(s.slackCount, 1);
  assert.equal(s.slackMinutes, 40);
});

test('傳聞：不改變狀態、不算時數，但會留在日誌', () => {
  const r = day([['09:00', 'work'], ['10:00', 'rumor'], ['18:00', 'off']]);
  assert.equal(r.workMinutes, 480);
  assert.equal(r.events.length, 3);
  assert.equal(r.segments.length, 2);
  // 只有傳聞的日子＝無情報
  assert.equal(day([['10:00', 'rumor']]).state, 'noRecord');
});

test('休戰日在家修煉：不算假日加場，地圖顯示在家修煉', () => {
  const r = day([['10:00', 'remote']], { workday: false });
  assert.equal(r.state, 'holiday');
  assert.equal(r.remoteHoliday, true);
  assert.equal(r.remote, false); // 不鎖記錄（人可能後來進公司）
  assert.equal(day([['10:00', 'work']], { workday: false }).state, 'extra');
});

test('範本舊變數 {今日上線} 對應到 {觀察時數}', () => {
  assert.equal(renderTemplate('今日上線：{今日上線}', { 觀察時數: '3 小時' }), '今日上線：3 小時');
});

test('過去日沒有下班紀錄 → missingOff', () => {
  assert.equal(day([['09:00', 'work']]).state, 'missingOff');
});

test('今天沒下班 → inProgress，工時算到現在', () => {
  const r = evaluateDay({
    date: '2026-11-25', today: '2026-11-25', nowMin: t('10:00'), workday: true,
    events: [{ at: at('2026-11-25', '09:00'), status: 'work' }],
  });
  assert.equal(r.state, 'inProgress');
  assert.equal(r.workMinutes, 60);
});

test('過去工作日沒任何紀錄 → noRecord；假日 → holiday', () => {
  assert.equal(day([]).state, 'noRecord');
  assert.equal(day([], { workday: false }).state, 'holiday');
});

test('上半場＋下半場，或兩段自訂假補滿整天 → 閉關', () => {
  assert.equal(day([], { leaves: [{ kind: 'am' }, { kind: 'pm' }] }).state, 'leave');
  assert.equal(day([], { leaves: [{ kind: 'custom', start: '09:00', end: '12:00' }, { kind: 'custom', start: '13:00', end: '18:00' }] }).state, 'leave');
  assert.notEqual(day([], { leaves: [{ kind: 'custom', start: '09:00', end: '11:00' }, { kind: 'custom', start: '13:00', end: '18:00' }] }).state, 'leave');
});

test('遲到、早退跨午休時扣掉午休', () => {
  assert.equal(evaluateSchedule(t('13:30')).lateMinutes, 210);
  const r = day([['09:00', 'work'], ['11:00', 'off']]);
  assert.equal(r.earlyMinutes, 360);
});

test('未來的閉關不論全日或半天都不計入統計', () => {
  const future = (leaves) => evaluateDay({ date: '2026-11-30', today: '2026-11-25', nowMin: 600, workday: true, events: [], leaves });
  const s = summarize([future([{ kind: 'full', type: 'a' }]), future([{ kind: 'am', type: 'b' }])]);
  assert.deepEqual(s.leaveByType, {});
  assert.equal(s.workdays, 0);
});

test('今天冒險中不算進情報完整度的分母', () => {
  const today = evaluateDay({ date: '2026-11-25', today: '2026-11-25', nowMin: 600, workday: true, events: [{ at: at('2026-11-25', '09:00'), status: 'work' }] });
  const s = summarize([day([['09:00', 'work'], ['18:00', 'off']]), today]);
  assert.equal(s.observableDays, 1);
  assert.equal(s.completeDays, 1);
});

test('bossLabel 與範本的 {魔王}', () => {
  assert.equal(bossLabel({ level: 30, name: '魔王' }), 'Lv.30 魔王');
  assert.equal(renderTemplate(DEFAULT_TEMPLATES.lunch, { 魔王: 'Lv.50 魔王', 時間: '12:00', 旁白: '' }), '🍖 Lv.50 魔王 吃飯中（12:00）');
});

test('maskEmail：只留前幾個字，看不出完整 email', () => {
  assert.equal(maskEmail('john.smith@gmail.com'), 'jo***@g***.com');
  assert.equal(maskEmail('AB@Yahoo.com.tw'), 'a***@y***.com.tw');
  assert.equal(maskEmail('x@localhost'), 'x***@l***');
  assert.equal(maskEmail(''), '***');
  assert.equal(maskEmail('not-an-email'), '***');
  assert.equal(maskEmail('😀a@gmail.com'), '😀***@g***.com'); // 只有 2 個字元，只留 1 個
});

test('leaveSpanText', () => {
  assert.equal(leaveSpanText({ kind: 'pm' }), '下半場');
  assert.equal(leaveSpanText({ kind: 'custom', start: '14:00', end: '16:00' }), '14:00–16:00');
});

test('時間一律以台灣時間計算，與執行環境時區無關', () => {
  const ms = taipeiMs('2026-11-24', '00:30'); // 台灣 11/24 00:30 = UTC 11/23 16:30
  assert.equal(new Date(ms).toISOString(), '2026-11-23T16:30:00.000Z');
  assert.equal(dateKey(ms), '2026-11-24');
  assert.equal(minutesOf(ms), 30);
  assert.ok(Number.isNaN(taipeiMs('2026-11-24', '')));
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('dayType：手動覆寫 > 行事曆 > 週末', () => {
  const cal = { '2026-12-25': { isHoliday: true, description: '行憲紀念日' } };
  assert.equal(dayType('2026-12-25', cal).workday, false);
  assert.equal(dayType('2026-12-25', cal, { '2026-12-25': 'workday' }).workday, true);
  assert.equal(dayType('2026-11-28', {}).workday, false); // 週六
  assert.equal(dayType('2026-11-27', {}).workday, true);
});

test('休假天數', () => {
  assert.equal(leaveDays({ kind: 'full' }), 1);
  assert.equal(leaveDays({ kind: 'pm' }), 0.5);
  assert.equal(leaveDays({ kind: 'custom', start: '14:00', end: '16:00' }), 0.25);
});

test('summarize：未完整的天數不算進工時與早退', () => {
  const days = [
    day([['09:10', 'work'], ['18:00', 'off']]),
    day([['08:40', 'work']]), // 未記錄下班
    day([]),
    day([], { leaves: [{ kind: 'full', type: '特休' }] }),
  ];
  const s = summarize(days);
  assert.equal(s.workdays, 4);
  assert.equal(s.completeDays, 1);
  assert.equal(s.missingOffDays, 1);
  assert.equal(s.noRecordDays, 1);
  assert.equal(s.lateCount, 1);
  assert.equal(s.lateMinutes, 10);
  assert.equal(s.requiredMinutes, 480);
  assert.equal(s.leaveByType['特休'], 1);
  assert.equal(s.avgArrival, t('08:55'));
  assert.equal(s.earliestArrival.minutes, t('08:40'));
  assert.equal(s.latestArrival.minutes, t('09:10'));
});

test('faultText：註明遲到／早退，沒有失誤時為空', () => {
  assert.equal(faultText(day([['09:10', 'work'], ['17:30', 'off']])), '⚠️ 失誤（遲到 10 分、早退 30 分）');
  assert.equal(faultText(day([['09:10', 'work']])), '⚠️ 失誤（遲到 10 分）');
  assert.equal(faultText(day([['09:00', 'work'], ['18:00', 'off']])), '');
});

test('renderTemplate：替換變數並清掉多餘空行', () => {
  assert.equal(renderTemplate('{狀態}・{時間}\n{旁白}\n', { 狀態: '吃飯中', 時間: '12:03', 旁白: '' }), '吃飯中・12:03');
  // 中間的空變數行也要拿掉，不留空行
  assert.equal(renderTemplate('上線\n{失誤}\n{旁白}', { 失誤: '', 旁白: '開會' }), '上線\n開會');
  // 帶標籤的行，變數沒資料時整行拿掉
  assert.equal(renderTemplate('上線\n備註：{旁白}', { 旁白: '' }), '上線');
  // 舊名稱 {備註} 仍可用
  assert.equal(renderTemplate('備註：{備註}', { 旁白: '去銀行' }), '備註：去銀行');
  // 不認得的變數原樣保留
  assert.equal(renderTemplate('{不存在}', {}), '{不存在}');
  // 內建屬性名稱不會被替換
  assert.equal(renderTemplate('x {constructor}', {}), 'x {constructor}');
});
