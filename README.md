# 👹 魔王出沒紀錄

8-bit 像素風的觀察日誌：記錄魔王們每天的行動，累積成地圖與成就，還能把當下動態廣播給 LINE 隊友。

- **觀戰**：不用登入，打開就能看；上方魔王選單可切換（Lv.30 魔王、Lv.50 魔王…）
- **GM**：只有編輯名單裡的帳號登入後能記錄、登記閉關、編輯魔王屬性與設定；點右上角「✏️ GM」可切到觀戰模式，避免誤觸
- **冒險者**：GM 在「選單 → 冒險者註冊」開放註冊後，任何人可建立帳號（預設關閉）；登入後可提供情報（記錄狀態、閉關、新增／編輯魔王、修改任何人的日誌），刪除只有 GM；「選單 → 冒險者清單」公開顯示去識別化的 email（例：jo***@g***.com）與是否在線
- **情報提供者**：每筆日誌、閉關標註是誰記錄的（去識別化的 email）
- **修改歷史**：修正過的紀錄會顯示「✎ 修正 N 次」，點開可看每次修改前的內容、修改者與時間（無法竄改）
- **刪除＝隱藏**：刪除只標記為隱藏，畫面不顯示但資料庫保留完整紀錄；GM 可在選單打開「顯示已隱藏」查看
- **分享**：任何人都能按「📣 分享目前狀態」，用 LINE 傳給自己的好友（手機直接開 LINE；電腦版 LINE 不支援分享網址，改成複製後貼上）
- **新手教學**：第一次打開會有嚮導帶著走一遍，可在「選單 → 📖 新手教學」重看
- **時間**：日誌顯示的是「發生時間」；按下記錄的「記錄時間」不同時會以小字附註
- **外觀**：電腦版可在「選單 → 外觀」切換橫式掌機（預設）、直式掌機或無外殼；按鍵與鍵盤（← → 換頁、↑ ↓ 捲動、Z 確認/分享、X/Esc 關閉、Shift 換魔王、Enter 回冒險）都能操作。手機是滿版 RWD
- **在線人數**：右上角顯示目前開著網站的人數（含沒登入的）。人數只是參考：沒登入的人無法驗證身分，理論上可被灌假人數（也會增加 Realtime Database 流量），15 分鐘沒更新就不計入

**遊玩：** https://jungshianwu.github.io/maou-log/

## 行動指令

| 指令 | 計入上線時數 |
|---|---|
| 👹 上線 | ✅ |
| 🏠 在家修煉 | ✅（遠端上班：當天視為照班表完整上班，不計失誤、不顯示上下線時間，也不能再更新當天狀態） |
| 💄 化妝 | ✅ |
| 🍖 吃飯 | ❌ |
| 🚪 離開王座 | ✅ |
| 🪑 回到王座 | ✅ |
| 😴 睡眠補血 | ✅（另計次數與時間） |
| 🌙 下線 | ❌ |
| 🏝️ 閉關 | — |

## 遊戲規則

| 項目 | 規則 |
|---|---|
| 開服 | 09:00–18:00，12:00–13:00 休息（不計時數） |
| 提早上線 | 08:30 前上線以 08:30 起算；08:30–09:00 上線，可下線時間 = 上線 + 9 小時 |
| 晚上線 | 09:00 後上線，18:00 才可下線 |
| 失誤 | 晚上線或早下線；廣播訊息與匯出的 CSV 會註明遲到／早退 |
| 冒險日 | 週一至五，依台灣政府行事曆排除休戰日（國定假日）、加入補班日；可在地圖手動調整 |

### 閉關

| 類型 | 規則 |
|---|---|
| 全日 | 不計失誤 |
| 上半場 | 13:00 前上線、18:00 可下線 |
| 下半場 | 可下線時間 = 上線 + 3 小時 |
| 自訂時段 | 涵蓋開服時延後晚上線門檻；涵蓋收服前時段時提早可下線時間 |

### 情報不完整時

- 冒險日沒有任何紀錄 → 「無情報」，不直接判定失誤
- 有上線但沒看到下線 → 「未見下線」，不計入時數與早下線；冒險頁會提醒補登
- 成就頁顯示「情報完整度」

所有時間一律以台灣時間（UTC+8）計算，在其他時區觀戰看到的也一樣。

「讀取存檔」會先寫入新資料、成功後才刪除舊資料：中途失敗時舊資料仍在（可能多出部分重複紀錄），不會整個清空。

## 開發

純靜態網頁，部署在 GitHub Pages；帳號與存檔使用 Firebase（Auth Email 登入 + Firestore），在線人數使用 Realtime Database。

```bash
npm install          # 安裝測試工具（網站本身不需要）
npm start            # http://localhost:5288（Firebase 只授權 localhost，請勿用 127.0.0.1）
firebase deploy --only firestore:rules,database   # 更新 Firestore 與 Realtime Database 安全規則
```

### 測試

| 指令 | 內容 | 需求 |
|---|---|---|
| `npm test` | 遊戲規則、統計、訊息範本、版本號一致 | Node 20 |
| `npm run test:rules` | Firestore 安全規則（觀戰只能看、非編輯者不能改、欄位驗證） | JDK 21、Firebase CLI |
| `npm run test:e2e` | Playwright 端對端：觀戰、切換魔王、登入、記錄、閉關、補登、登出、分享、在線人數、掌機按鍵與外觀、手機版 | JDK 21、Firebase CLI、Chrome |
| `npm run test:all` | 以上全部 | |

模擬器需要 JDK 21：macOS 可用 `brew install openjdk@21`，執行前加上 `export PATH="/opt/homebrew/opt/openjdk@21/bin:$PATH"`。
E2E 使用 Firebase 模擬器與測試帳號（網址加 `?emulator`，僅限本機），不會動到正式資料。

### 開放其他人編輯

1. 請對方用 Email 登入一次，到 Firebase 主控台 → Authentication 找到對方的 uid
2. 把 uid 加進 `firebase-config.js` 的 `EDITOR_UIDS` 與 `firestore.rules` 的 `isEditor()`
3. `firebase deploy --only firestore:rules`，再推上 GitHub

每筆日誌、閉關、魔王都會記錄最後寫入者（`by`）。

### 版本

版本號在 `version.js`、`package.json`、`CHANGELOG.md` 三處，發佈時一起更新（`npm test` 會檢查一致）。

### 檔案

| 檔案 | 說明 |
|---|---|
| `index.html` | 介面（魔王選單、冒險、地圖、成就、選單、登入） |
| `rules.js` | 遊戲規則與統計（純函式） |
| `rules.test.js` | 規則測試（`node --test`） |
| `store.js` | 帳號與雲端存檔（Firebase Auth + Firestore） |
| `version.js` | 版本號 |
| `tests/firestore-rules.test.js` | 安全規則測試 |
| `e2e/app.spec.js` | E2E 測試 |
| `firebase-config.js` | Firebase 網頁設定（公開資訊，權限由安全規則控管） |
| `firestore.rules` | Firestore 安全規則：任何人可讀；登入者可寫魔王／日誌／閉關，隱藏與看板設定只有 GM；修改必須附加真實的修改歷史；冒險者只能登記自己（只能存遮罩 email）；禁止真的刪除 |
| `database.rules.json` | Realtime Database 規則：只開放在線人數（presence）的讀寫與格式驗證；帶 uid 時必須是本人 |

休戰日資料來自 [ruyut/TaiwanCalendar](https://github.com/ruyut/TaiwanCalendar)。像素字型為 [俐方體11號 Cubic 11](https://github.com/ACh-K/Cubic-11)（OFL）。
