// 出勤規則與統計（純函式，不碰 DOM 與儲存）
// 時間一律以「當天 0 點起算的分鐘數」計算，例如 9:00 = 540。

export const SCHEDULE = {
  flexStart: 8 * 60 + 30, // 最早可起算 08:30
  start: 9 * 60,          // 表定上班 09:00，之後算遲到
  lunchStart: 12 * 60,
  lunchEnd: 13 * 60,
  end: 18 * 60,           // 表定下班 18:00
  span: 9 * 60,           // 到班後 9 小時（含午休）可下班
  dailyMinutes: 8 * 60,   // 每日表定工時（不含午休）
  observeEnd: 19 * 60,    // 19:00 後就沒人觀察了：今天還沒結束的時段只算到這裡
};

// 冒險者清單用：email 去識別化，只留帳號前 2 個字（太短留 1 個）與網域第一個字＋後綴
// 例：john@gmail.com → jo***@g***.com；ab@yahoo.com.tw → a***@y***.com.tw
export function maskEmail(email) {
  const [local = '', domain = ''] = String(email || '').toLowerCase().split('@');
  if (!local || !domain) return '***';
  const chars = Array.from(local); // 以字元計算，emoji 也算一個字
  const keep = chars.slice(0, chars.length > 2 ? 2 : 1).join('');
  const dot = domain.indexOf('.');
  const tail = dot > 0 ? domain.slice(dot) : '';
  return `${keep}***@${Array.from(domain)[0]}***${tail}`;
}

// 魔王（觀察對象）：用等級與名稱區分，例如 Lv.30 魔王、Lv.50 魔王
export function bossLabel(boss) {
  return boss ? `Lv.${boss.level} ${boss.name}` : '魔王';
}

export const STATUSES = {
  work:   { label: '上線',     emoji: '👹', working: true,  color: '#b13e53' },
  remote: { label: '在家修煉', emoji: '🏠', working: true,  color: '#73eff7' }, // 遠端上班
  makeup: { label: '化妝',     emoji: '💄', working: true,  color: '#5d275d' },
  lunch:  { label: '吃飯',     emoji: '🍖', working: false, color: '#ef7d57' },
  away:   { label: '王座無人', emoji: '🚪', working: true,  color: '#3b5dc9' },
  back:   { label: '在王座上', emoji: '🪑', working: true,  color: '#38b764' },
  nap:    { label: '睡眠補血', emoji: '😴', working: true,  color: '#257179' },
  slack:  { label: '發呆摸魚', emoji: '🐟', working: true,  color: '#41a6f6' }, // 人在位子上，算上線時數
  // 傳聞：記錄其他觀察者轉述的話，不改變魔王的狀態，旁白必填
  rumor:  { label: '其他觀察者說的話（傳聞）', short: '傳聞', emoji: '🗣️', working: false, color: '#a7f070', rumor: true },
  off:    { label: '下線',     emoji: '🌙', working: false, color: '#566c86' },
};

// 假別：特休、病假、事假、公假、其他
export const LEAVE_TYPES = ['🎫 特休券', '🤒 中毒', '📜 私人任務', '⚔️ 公會任務', '❓ 其他'];

export const LEAVE_KINDS = {
  full: { label: '全日' },
  am:   { label: '上半場' },
  pm:   { label: '下半場' },
  custom: { label: '自訂時段' },
};

// ---------- 基本工具 ----------

export const pad = (n) => String(n).padStart(2, '0');

// 時間一律以台灣時間（UTC+8，沒有日光節約）計算，觀戰者在其他時區看到的也一樣
const TZ_OFFSET_MS = 8 * 3600_000;

export function dateKey(ms) {
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

export function minutesOf(ms) {
  const d = new Date(ms + TZ_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// 台灣時間的「日期 + HH:MM」轉成時間戳；格式不對回傳 NaN
export function taipeiMs(date, hhmm) {
  const [y, m, d] = String(date).split('-').map(Number);
  const [h, mi] = String(hhmm).split(':').map(Number);
  return Date.UTC(y, m - 1, d, h, mi) - TZ_OFFSET_MS;
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function fmtMin(m) {
  if (m == null) return '—';
  return `${pad(Math.floor(m / 60))}:${pad(Math.round(m % 60))}`;
}

// 短格式（窄欄位用）：7時52分、7時、52分
export function fmtDurationShort(m) {
  m = Math.round(m || 0);
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h && r) return `${h}時${r}分`;
  if (h) return `${h}時`;
  return `${r}分`;
}

export function fmtDuration(m) {
  m = Math.round(m || 0);
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h && r) return `${h} 小時 ${r} 分`;
  if (h) return `${h} 小時`;
  return `${r} 分`;
}

export function parseHHMM(s) {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

const overlap = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));

// 一段時間扣掉午休後的工作分鐘數
export function minusLunch(s, e) {
  return Math.max(0, e - s) - overlap(s, e, SCHEDULE.lunchStart, SCHEDULE.lunchEnd);
}

// ---------- 假日 ----------

// calendar: { 'YYYY-MM-DD': { isHoliday, description } }（政府行事曆）
// overrides: { 'YYYY-MM-DD': 'holiday' | 'workday' }（手動調整，優先）
export function dayType(date, calendar = {}, overrides = {}) {
  const o = overrides[date];
  if (o === 'holiday') return { workday: false, reason: '手動設為休戰日' };
  if (o === 'workday') return { workday: true, reason: '手動設為冒險日' };
  const c = calendar[date];
  if (c) {
    const [y, m, d] = date.split('-').map(Number);
    const weekend = [0, 6].includes(new Date(y, m - 1, d).getDay());
    return {
      workday: !c.isHoliday,
      reason: c.description || (c.isHoliday ? (weekend ? '' : '假日') : (weekend ? '補班' : '')),
    };
  }
  const [y, m, d] = date.split('-').map(Number);
  const wd = new Date(y, m - 1, d).getDay();
  return { workday: wd !== 0 && wd !== 6, reason: '' };
}

// ---------- 休假 ----------

export function leaveInterval(leave) {
  const S = SCHEDULE;
  switch (leave.kind) {
    case 'full': return [S.start, S.end];
    case 'am': return [S.start, S.lunchEnd];
    case 'pm': return [S.lunchStart, S.end];
    default: return [parseHHMM(leave.start), parseHHMM(leave.end)];
  }
}

// 這筆假佔掉多少表定工時（分鐘）
export function leaveWorkMinutes(leave) {
  const [s, e] = leaveInterval(leave);
  return minusLunch(Math.max(s, SCHEDULE.start), Math.min(e, SCHEDULE.end));
}

export function leaveDays(leave) {
  if (leave.kind === 'full') return 1;
  if (leave.kind === 'am' || leave.kind === 'pm') return 0.5;
  return Math.round((leaveWorkMinutes(leave) / SCHEDULE.dailyMinutes) * 100) / 100;
}

export function leaveSpanText(leave, sep = '–') {
  return leave.kind === 'custom' ? `${leave.start}${sep}${leave.end}` : LEAVE_KINDS[leave.kind].label;
}

// 多筆假合併後是否涵蓋整天（午休空檔視為已涵蓋，例如 09:00–12:00 + 13:00–18:00）
function coversWholeDay(sortedIv) {
  const S = SCHEDULE;
  let reach = S.start;
  for (const [s, e] of sortedIv) {
    if (s > reach && !(reach >= S.lunchStart && s <= S.lunchEnd)) break;
    reach = Math.max(reach, e);
  }
  return reach >= S.end;
}

// 同一天的閉關時段合併後，佔掉多少表定工時（重疊的部分只算一次）
export function leavesWorkMinutes(leaves) {
  const S = SCHEDULE;
  const iv = leaves.map(leaveInterval).map(([s, e]) => [Math.max(s, S.start), Math.min(e, S.end)])
    .filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [cs, ce] = [null, null];
  for (const [s, e] of iv) {
    if (cs === null || s > ce) { if (cs !== null) total += minusLunch(cs, ce); [cs, ce] = [s, e]; } else ce = Math.max(ce, e);
  }
  if (cs !== null) total += minusLunch(cs, ce);
  return total;
}

// 兩筆閉關是否時段重疊（同一天；只在午休重疊不算，例如上半場＋下半場）
export function leavesOverlap(a, b) {
  if (a.date !== b.date) return false;
  const [as, ae] = leaveInterval(a);
  const [bs, be] = leaveInterval(b);
  return minusLunch(Math.max(as, bs), Math.min(ae, be)) > 0;
}

// ---------- 班表判定 ----------

// 依到班時間與當天休假，算出遲到門檻與應下班時間
export function evaluateSchedule(arrival, leaves = []) {
  const S = SCHEDULE;
  const iv = leaves.map(leaveInterval).sort((a, b) => a[0] - b[0]);
  if (coversWholeDay(iv)) return { fullLeave: true };

  // 休假涵蓋上班開始時，遲到門檻延到假結束（落在午休就延到 13:00）
  let lateAt = S.start;
  for (const [s, e] of iv) if (s <= lateAt && e > lateAt) lateAt = e;
  if (lateAt >= S.lunchStart && lateAt < S.lunchEnd) lateAt = S.lunchEnd;
  const morningOnLeave = lateAt !== S.start;

  // 一般彈性規則：08:30 前以 08:30 起算；09:00 後遲到，18:00 下班
  let expectedLeave;
  if (morningOnLeave || arrival > S.start) expectedLeave = S.end;
  else expectedLeave = Math.max(arrival, S.flexStart) + S.span;

  // 休假涵蓋下班前時段：提早下班（下午半天 = 到班時間 + 3 小時）
  const shift = S.end - expectedLeave;
  for (const [s, e] of [...iv].sort((a, b) => b[1] - a[1])) {
    if (e >= S.end) expectedLeave = Math.min(expectedLeave, s - shift); // 假放到收服：依提早上線的時間一起往前移
    else if (s < expectedLeave && e >= expectedLeave) expectedLeave = s;
  }

  return {
    fullLeave: false,
    lateAt,
    expectedLeave,
    lateMinutes: arrival > lateAt ? minusLunch(lateAt, arrival) : 0,
  };
}

// 目前狀態持續了多久（分鐘）：只算到 19:00（之後沒人觀察）
export function observedSince(startMin, nowMin) {
  return Math.max(0, Math.min(nowMin, SCHEDULE.observeEnd) - startMin);
}

// ---------- 單日評估 ----------

// events: 該日的狀態紀錄 [{ at: ms, status }]，leaves: 該日休假
export function evaluateDay({ date, events = [], leaves = [], workday = true, today, nowMin }) {
  const all = [...events].sort((a, b) => a.at - b.at);
  // 傳聞只是轉述，不算魔王的狀態（不影響時段、上線、統計）
  const evs = all.filter((e) => !STATUSES[e.status]?.rumor);
  const isToday = date === today;
  const isFuture = date > today;
  const result = {
    date, workday, events: all, leaves, isFuture,
    leaveDays: leaves.reduce((s, l) => s + leaveDays(l), 0),
    segments: [],
    arrival: null, departure: null,
    workMinutes: 0, lunchMinutes: 0,
    awayCount: 0, awayMinutes: 0,
    napCount: 0, napMinutes: 0,
    slackCount: 0, slackMinutes: 0,
    lateMinutes: 0, earlyMinutes: 0, overtimeMinutes: 0,
    expectedLeave: null, lateAt: null,
    remote: false,        // 冒險日在家修煉：照班表、不能再記錄狀態
    remoteHoliday: false, // 休戰日在家修煉：只在地圖上顯示，不鎖記錄
    requiredMinutes: 0,
    state: 'noRecord',
  };

  // 時段：每筆紀錄到下一筆紀錄為止
  for (let i = 0; i < evs.length; i++) {
    const start = minutesOf(evs[i].at);
    let end = i + 1 < evs.length ? minutesOf(evs[i + 1].at) : null;
    if (end == null && isToday && evs[i].status !== 'off') end = Math.max(start, Math.min(nowMin, SCHEDULE.observeEnd));
    const open = i + 1 >= evs.length && evs[i].status !== 'off';
    result.segments.push({ status: evs[i].status, start, end, open, note: evs[i].note || '' });
  }

  const firstIn = evs.find((e) => e.status !== 'off');
  if (firstIn) result.arrival = minutesOf(firstIn.at);
  const last = evs[evs.length - 1];
  if (firstIn && last.status === 'off') result.departure = minutesOf(last.at);

  for (const seg of result.segments) {
    if (seg.end == null) continue;
    const st = STATUSES[seg.status];
    if (st?.working) result.workMinutes += minusLunch(seg.start, seg.end);
    if (seg.status === 'lunch') result.lunchMinutes += seg.end - seg.start;
    if (seg.status === 'away') { result.awayCount++; result.awayMinutes += seg.end - seg.start; }
    if (seg.status === 'nap') { result.napCount++; result.napMinutes += seg.end - seg.start; }
    if (seg.status === 'slack') { result.slackCount++; result.slackMinutes += seg.end - seg.start; }
  }

  // 狀態判定
  const fullLeave = evaluateSchedule(0, leaves).fullLeave;
  const remoteToday = evs.some((e) => e.status === 'remote');
  // 休戰日在家修煉不算「假日加場」
  if (!workday) result.state = evs.length && !remoteToday ? 'extra' : 'holiday';
  else if (fullLeave) result.state = 'leave';
  else if (!firstIn) result.state = isFuture ? 'future' : isToday ? 'pending' : 'noRecord';
  else if (result.departure == null) result.state = isToday ? 'inProgress' : 'missingOff';
  else result.state = 'complete';

  if (workday && !fullLeave) {
    result.requiredMinutes = SCHEDULE.dailyMinutes - leavesWorkMinutes(leaves);
    if (result.arrival != null) {
      const sch = evaluateSchedule(result.arrival, leaves);
      result.lateAt = sch.lateAt;
      result.expectedLeave = sch.expectedLeave;
      result.lateMinutes = sch.lateMinutes;
      if (result.departure != null) {
        result.earlyMinutes = minusLunch(result.departure, sch.expectedLeave);
        result.overtimeMinutes = minusLunch(sch.expectedLeave, result.departure);
      }
    }
  }

  // 在家修煉（遠端上班）：當天視為照班表完整上班，不計失誤與加時
  if (!workday && remoteToday) result.remoteHoliday = true; // 地圖顯示「在家修煉」
  if (workday && !fullLeave && remoteToday) {
    Object.assign(result, {
      remote: true, state: 'complete',
      lateMinutes: 0, earlyMinutes: 0, overtimeMinutes: 0,
      workMinutes: result.requiredMinutes,
    });
  }
  return result;
}

export const DAY_STATES = {
  complete:   { label: '通關',         color: '#38b764' },
  remote:     { label: '在家修煉',     color: '#73eff7' },
  late:       { label: '失誤',         color: '#b13e53' },
  inProgress: { label: '冒險中',       color: '#41a6f6' },
  missingOff: { label: '未見下線',     color: '#ef7d57' },
  leave:      { label: '閉關',         color: '#a35dd8' },
  noRecord:   { label: '無情報',       color: '#566c86' },
  holiday:    { label: '休戰日',       color: '#333c57' },
  extra:      { label: '假日加場',     color: '#ffcd75' },
  pending:    { label: '今天',         color: '#566c86' },
  future:     { label: '',             color: 'transparent' },
};

// 月曆顏色用：正常但有遲到或早退時改成紅色
export function displayState(day) {
  if (day.remote || day.remoteHoliday) return 'remote';
  if (day.state === 'complete' && (day.lateMinutes > 0 || day.earlyMinutes > 0)) return 'late';
  if (day.state === 'inProgress' && day.lateMinutes > 0) return 'late';
  return day.state;
}

// ---------- 區間統計 ----------

export function summarize(days) {
  const s = {
    workdays: 0, recordedDays: 0, completeDays: 0, missingOffDays: 0, noRecordDays: 0,
    lateCount: 0, lateMinutes: 0,
    earlyCount: 0, earlyMinutes: 0,
    overtimeCount: 0, overtimeMinutes: 0,
    awayCount: 0, awayMinutes: 0,
    napCount: 0, napMinutes: 0,
    slackCount: 0, slackMinutes: 0,
    workMinutes: 0, requiredMinutes: 0,
    avgArrival: null, avgDeparture: null,
    earliestArrival: null, latestArrival: null, // { date, minutes }
    leaveByType: {}, leaveDays: 0,
    extraDays: 0,
    fullLeaveDays: 0, todayDays: 0, remoteDays: 0,
    observableDays: 0, // 工作日扣掉整天閉關與今天
  };
  const arrivals = [];
  const departures = [];
  for (const d of days) {
    if (d.state === 'future' || d.isFuture) continue;
    for (const l of d.leaves) {
      if (!d.workday) continue;
      const n = leaveDays(l);
      s.leaveByType[l.type] = (s.leaveByType[l.type] || 0) + n;
      s.leaveDays += n;
    }
    if (d.state === 'extra') { s.extraDays++; continue; }
    if (!d.workday) continue;
    s.workdays++;
    if (d.state === 'leave') { s.fullLeaveDays++; continue; }
    if (d.state === 'noRecord') { s.noRecordDays++; continue; }
    if (d.state === 'pending' || d.state === 'inProgress') s.todayDays++;
    if (d.state === 'pending') continue;
    s.recordedDays++;
    if (d.lateMinutes > 0) { s.lateCount++; s.lateMinutes += d.lateMinutes; }
    s.awayCount += d.awayCount;
    s.awayMinutes += d.awayMinutes;
    s.napCount += d.napCount;
    s.napMinutes += d.napMinutes;
    s.slackCount += d.slackCount;
    s.slackMinutes += d.slackMinutes;
    if (d.arrival != null && !d.remote) { // 在家修煉不列入上線時刻統計
      arrivals.push(d.arrival);
      if (!s.earliestArrival || d.arrival < s.earliestArrival.minutes) s.earliestArrival = { date: d.date, minutes: d.arrival };
      if (!s.latestArrival || d.arrival > s.latestArrival.minutes) s.latestArrival = { date: d.date, minutes: d.arrival };
    }
    if (d.state === 'missingOff') { s.missingOffDays++; continue; }
    if (d.state !== 'complete') continue;
    s.completeDays++;
    if (d.remote) s.remoteDays++;
    if (d.earlyMinutes > 0) { s.earlyCount++; s.earlyMinutes += d.earlyMinutes; }
    if (d.overtimeMinutes > 0) { s.overtimeCount++; s.overtimeMinutes += d.overtimeMinutes; }
    s.workMinutes += d.workMinutes;
    s.requiredMinutes += d.requiredMinutes;
    if (!d.remote) departures.push(d.departure);
  }
  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
  s.avgArrival = avg(arrivals);
  s.avgDeparture = avg(departures);
  s.observableDays = s.workdays - s.fullLeaveDays - s.todayDays;
  return s;
}

// ---------- 訊息範本 ----------

// 轉傳給別人時要看得懂：失誤一律註明遲到／早退
export function faultText(day) {
  const parts = [];
  if (day.lateMinutes > 0) parts.push(`遲到 ${fmtDuration(day.lateMinutes)}`);
  if (day.earlyMinutes > 0) parts.push(`早退 ${fmtDuration(day.earlyMinutes)}`);
  return parts.length ? `⚠️ 失誤（${parts.join('、')}）` : '';
}

// 舊變數名稱仍可使用
const VAR_ALIASES = { 備註: '旁白', 遲到: '晚上線', 到班時間: '上線時間', 應下班: '可下線', 今日工時: '觀察時數', 今日上線: '觀察時數' };

// 一行裡的變數全部沒資料時，整行不顯示（例如「旁白：{旁白}」沒填旁白就整行拿掉）
export function renderTemplate(tpl, vars) {
  const lookup = (k) => (Object.hasOwn(vars, k) ? vars[k] : Object.hasOwn(VAR_ALIASES, k) ? vars[VAR_ALIASES[k]] : undefined);
  return tpl.split('\n').flatMap((line) => {
    const keys = [...line.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]).filter((k) => lookup(k) !== undefined);
    if (keys.length && keys.every((k) => String(lookup(k)).trim() === '')) return [];
    return [line.replace(/\{([^{}]+)\}/g, (m, k) => (lookup(k) !== undefined ? lookup(k) : m))];
  }).join('\n').trim();
}

export const DEFAULT_TEMPLATES = {
  work: '👹 {魔王} 上線！\n上線時間：{時間}\n{失誤}\n{旁白}',
  remote: '🏠 {魔王} 在家修煉中（{時間}）\n{失誤}\n{旁白}',
  makeup: '💄 {魔王} 化妝中…（{時間}）\n{旁白}',
  lunch: '🍖 {魔王} 吃飯中（{時間}）\n{旁白}',
  away: '🚪 {魔王} 王座無人（{時間}）\n{旁白}',
  back: '🪑 {魔王} 在王座上（{時間}）\n{旁白}',
  rumor: '🗣️ 傳聞（{魔王}・{時間}）：{旁白}',
  nap: '😴 {魔王} 睡眠補血中…（{時間}）\n{旁白}',
  slack: '🐟 {魔王} 發呆摸魚中…（{時間}）\n{旁白}',
  off: '🌙 {魔王} 下線了（{時間}）\n觀察時數：{觀察時數}\n{失誤}\n{旁白}',
  leave: '🏝️ {魔王} {日期}閉關（{假別}・{時段}）\n{旁白}',
};

export const TEMPLATE_VARS = ['魔王', '狀態', '時間', '日期', '旁白', '上線時間', '可下線', '觀察時數', '晚上線', '失誤', '假別', '時段'];
