/**
 * M2 步 14-4（设计 §6）：移动端单列布局冒烟。
 *
 * 窄屏（390×844）下逐页检查：文档无横向溢出、主内容区有实际内容。
 * 覆盖全部一级导航页与「商机与触达」三 tab 的真实页面。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const PAGES = [
  '/workspace',
  '/companies',
  '/find-buyers',
  '/leads',
  '/growth',
  '/growth?tab=opportunities',
  '/growth?tab=outreach',
  '/growth?tab=reviews',
  '/growth?tab=metrics',
  '/settings/members',
  '/settings/suppressions',
  '/reports',
  '/campaigns',
  '/qgos',
];

test.use({ viewport: { height: 844, width: 390 } });

test('移动端单列冒烟：无横向溢出、主内容可见', async ({ page }) => {
  test.setTimeout(180_000);
  await installMockBackend(page);
  await loginAs(page);

  const offenders: string[] = [];
  for (const path of PAGES) {
    await page.goto(path);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page
      .waitForFunction(() => (document.querySelector('main')?.innerText.trim().length ?? 0) > 10, undefined, {
        timeout: 8000,
      })
      .catch(() => {});
    const { clientWidth, scrollWidth } = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    if (scrollWidth > clientWidth + 1) {
      offenders.push(`${path}: 横向溢出（scrollWidth ${scrollWidth} > ${clientWidth}）`);
    }
    const mainText = await page
      .locator('main')
      .innerText()
      .catch(() => '');
    if (mainText.trim().length < 10) offenders.push(`${path}: 主内容为空`);
  }
  expect(offenders, offenders.join('\n')).toEqual([]);
});
