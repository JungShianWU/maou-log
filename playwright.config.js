// E2E 測試設定：npm run test:e2e（會先啟動 Firebase 模擬器）
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  workers: 1, // 共用同一個模擬器，依序執行
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5289',
    channel: 'chrome', // 用本機的 Chrome，不另外下載瀏覽器
    timezoneId: 'Asia/Taipei',
    locale: 'zh-TW',
  },
  webServer: {
    command: 'python3 -m http.server 5289 --bind 127.0.0.1',
    url: 'http://127.0.0.1:5289/',
    reuseExistingServer: false,
  },
});
