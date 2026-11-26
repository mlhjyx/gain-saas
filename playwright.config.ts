import { defineConfig } from '@playwright/test';

/**
 * P6 前端验收的 Playwright 基线（M2 步 14）。
 * 全部用例走 BFF mock（不需要引擎与数据库）；CI job `e2e` 负责浏览器安装与运行。
 * 本机用系统 Chrome（channel: 'chrome'），CI 用 Playwright 内置 chromium。
 */
const E2E_PORT = Number(process.env.PLAYWRIGHT_PORT || 4173);
const E2E_ORIGIN = `http://127.0.0.1:${E2E_PORT}`;

export default defineConfig({
  testDir: './apps/web/e2e',
  timeout: 120_000,
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: E2E_ORIGIN,
    channel: process.env.CI ? undefined : 'chrome',
    headless: true,
    locale: 'zh-CN',
    viewport: { height: 900, width: 1440 },
  },
  webServer: {
    command: `pnpm --filter @vben/web-antd preview --port ${E2E_PORT} --strictPort`,
    reuseExistingServer: !process.env.CI && !process.env.PLAYWRIGHT_PORT,
    timeout: 300_000,
    url: E2E_ORIGIN,
  },
  /**
   * P5b-19：按形态分 project——桌面为主；移动端冒烟与深色模式各自独立，
   * 真栈冒烟默认跳过（只有设置 GAINOS_SMOKE_* 才跑）。每个 spec 只跑一次。
   */
  projects: [
    {
      name: 'desktop',
      testIgnore: [
        '**/responsive.spec.ts',
        '**/dark-mode.spec.ts',
        '**/real-stack-smoke.spec.ts',
      ],
    },
    {
      name: 'mobile',
      testMatch: ['**/responsive.spec.ts'],
      use: { viewport: { height: 844, width: 390 } },
    },
    {
      // 平板竖屏（iPad 10.2/10.9 介于 768–834）：侧栏自动收成图标窄栏，内容区约 760px
      name: 'tablet',
      testMatch: ['**/responsive.spec.ts'],
      use: { hasTouch: true, viewport: { height: 1180, width: 820 } },
    },
    { name: 'dark', testMatch: ['**/dark-mode.spec.ts'] },
    { name: 'real-stack', testMatch: ['**/real-stack-smoke.spec.ts'] },
  ],
});
