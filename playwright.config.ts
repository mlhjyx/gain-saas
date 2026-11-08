import { defineConfig } from '@playwright/test';

/**
 * P6 前端验收的 Playwright 基线（M2 步 14）。
 * 14-1 只跑导航壳用例（登录用路由 mock，不需要 BFF）；14-3 扩到 10 条主链路并接 CI。
 * 本机用系统 Chrome（channel: 'chrome'）；CI 需要 `pnpm exec playwright install chromium` 后再接线。
 */
export default defineConfig({
  testDir: './apps/web/e2e',
  timeout: 120_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    channel: 'chrome',
    headless: true,
    locale: 'zh-CN',
    viewport: { height: 900, width: 1440 },
  },
  webServer: {
    command: 'pnpm --filter @vben/web-antd preview --port 4173 --strictPort',
    reuseExistingServer: true,
    timeout: 300_000,
    url: 'http://127.0.0.1:4173',
  },
});
