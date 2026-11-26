import { defineConfig } from '@playwright/test';

/**
 * P6 前端验收的 Playwright 基线（M2 步 14）。
 * 全部用例走 BFF mock（不需要引擎与数据库）；CI job `e2e` 负责浏览器安装与运行。
 * 本机用系统 Chrome（channel: 'chrome'），CI 用 Playwright 内置 chromium。
 *
 * 同一台机器上多个 worktree 同时跑 e2e 会抢 4173，而 Playwright 见端口已被占用会直接复用，
 * 等于拿别的目录的构建在测（断言全挂却查不出原因）。4173 被别的任务占着时，
 * 用 GAINOS_E2E_PORT 换一个端口；mock 层读的是同一个变量。
 */
const E2E_PORT = process.env.GAINOS_E2E_PORT || process.env.PLAYWRIGHT_PORT || '4173';
if (!/^\d+$/.test(E2E_PORT)) {
  throw new Error(`GAINOS_E2E_PORT 必须是端口号，收到：${E2E_PORT}`);
}
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
    reuseExistingServer: !process.env.CI && !process.env.GAINOS_E2E_PORT && !process.env.PLAYWRIGHT_PORT,
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
