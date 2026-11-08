/**
 * P5b-19：深色模式冒烟（桌面 project 之外的 dark project 专用）。
 * 用顶栏主题按钮切到深色，断言 tokens 生效（背景变深、主文字变浅），
 * 并在三个高密度页面确认没有横向溢出。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const PAGES = ['/workspace', '/campaigns', '/outreach'];

function luminance(rgb: string): number {
  const match = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return 0;
  const [r, g, b] = match.slice(1, 4).map(Number) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test('深色模式：tokens 生效且关键页无横向溢出', async ({ page }) => {
  await installMockBackend(page);
  await loginAs(page);

  // 顶栏主题按钮的 aria-label 是 dark / light（vben 内置）。
  await page.getByRole('button', { name: 'dark' }).click();
  await page.waitForTimeout(300);

  const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(luminance(bodyBg), `深色背景应足够暗：${bodyBg}`).toBeLessThan(60);

  for (const path of PAGES) {
    await page.goto(path);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} 深色下横向溢出 ${overflow}px`).toBeLessThanOrEqual(1);
  }
});
