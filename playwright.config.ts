import { defineConfig } from '@playwright/test';

/**
 * P6 前端验收的 Playwright 基线（M2 步 14）。
 * 全部用例走 BFF mock（不需要引擎与数据库）；CI job `e2e` 负责浏览器安装与运行。
 * 本机用系统 Chrome（channel: 'chrome'），CI 用 Playwright 内置 chromium。
 */
export default defineConfig({
  testDir: './apps/web/e2e',
  timeout: 120_000,
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    channel: process.env.CI ? undefined : 'chrome',
    headless: true,
    locale: 'zh-CN',
    viewport: { height: 900, width: 1440 },
  },
  webServer: {
    command: 'pnpm --filter @vben/web-antd preview --port 4173 --strictPort',
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    url: 'http://127.0.0.1:4173',
  },
});
