/**
 * v3.0 P5b-17 / G10：被删除或合并的历史路由必须继续可解析（redirect ≥2 个发布版本）。
 * 深链落点必须是新 IA 里的真实页面，不能落到 404。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const LEGACY: Array<[from: string, to: string]> = [
  ['/dashboard', '/workspace'],
  ['/dashboard/analytics', '/workspace'],
  ['/demos', '/workspace'],
  ['/demos/antd', '/workspace'],
  ['/profile', '/settings/members'],
  ['/about', '/workspace'],
  ['/settings/workspaces', '/settings/members'],
];

test('历史深链全部重定向到新路由', async ({ page }) => {
  await installMockBackend(page);
  await loginAs(page);

  for (const [from, to] of LEGACY) {
    await page.goto(from);
    await page.waitForURL((url) => url.pathname === to, { timeout: 15_000 });
    expect(page.url(), `${from} 应重定向到 ${to}`).toContain(to);
  }
});
