/**
 * P5b-19 / Wave B2：深色模式冒烟 + WCAG 2.1 AA 对比度硬门禁（dark project 专用）。
 * 用侧栏主题按钮切到深色，断言 tokens 生效（背景变深），并在所有核心与新增路由上确认：
 * 1) 无横向溢出（<= 1px）；
 * 2) @axe-core/playwright color-contrast 严重/致命违规为 0。
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const PAGES = [
  '/workspace',
  '/analytics',
  '/outreach',
  '/outreach?tab=batches',
  '/outreach?tab=replies',
  '/opportunities',
  '/leads',
  '/leads?view=reviews',
];

function luminance(rgb: string): number {
  const match = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return 0;
  const [r, g, b] = match.slice(1, 4).map(Number) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test('深色模式：tokens 生效、关键与新增路由无横向溢出且 axe-core color-contrast 零严重违规', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await installMockBackend(page);
  await loginAs(page);

  // 侧栏主题按钮的 aria-label 是 dark / light。
  await page.getByRole('button', { name: 'dark' }).click();
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await page.waitForTimeout(300);

  const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(luminance(bodyBg), `深色背景应足够暗：${bodyBg}`).toBeLessThan(60);

  const contrastFailures: Array<{
    path: string;
    violations: Array<{ impact: string | null | undefined; nodes: string[][] }>;
  }> = [];

  for (const path of PAGES) {
    await page.goto(path);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.locator('.loading').first().waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(350);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} 深色下横向溢出 ${overflow}px`).toBeLessThanOrEqual(1);

    const axe = await new AxeBuilder({ page })
      .include('main')
      .withRules(['color-contrast'])
      .analyze();

    const serious = axe.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    if (serious.length > 0) {
      contrastFailures.push({
        path,
        violations: serious.map((violation) => ({
          impact: violation.impact,
          nodes: violation.nodes.slice(0, 5).map((node) => node.target.map(String)),
        })),
      });
    }
  }

  expect(
    contrastFailures,
    `暗色模式 color-contrast 严重违规应为 0：\n${JSON.stringify(contrastFailures, null, 2)}`,
  ).toEqual([]);
});
