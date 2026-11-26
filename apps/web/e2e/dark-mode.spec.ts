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
  '/ops',
  '/ops?tab=workspaces',
];

function luminance(rgb: string): number {
  const match = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return 0;
  const [r, g, b] = match.slice(1, 4).map(Number) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test('深色模式：tokens 生效、关键与新增路由（含 /ops）无横向溢出且 axe-core color-contrast 零严重违规', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const backend = await installMockBackend(page);
  const rawJson = (payload: unknown) => async ({ route }: { route: import('@playwright/test').Route }) => {
    await route.fulfill({
      body: JSON.stringify(payload),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  };
  backend.set('GET', '/ops/auth/session', rawJson({ data: { user: { email: 'ops@gainos.local' } } }));
  backend.set(
    'GET',
    '/ops/overview',
    rawJson({
      db: { ok: true },
      dueSources: 1,
      engine: { failedComponents: [], httpStatus: 200, ready: true },
      failedFetches: [],
      fetchStats24h: [{ n: 12, status: 'DONE' }],
      leases: [{ last_seen_at: '2026-11-26T08:00:00.000Z', role: 'worker', state: 'ACTIVE' }],
      probe: { missing: [], ok: true },
      providersByStatus: [{ n: 4, status: 'ENABLED' }],
      redLights: {
        deadDeliveries: 0,
        exhaustedBudgetAccounts: 0,
        r4: { deliveryUnknown: 0, openRevocations: 0, platformExhaustedAuthorities: 0 },
        temporal: { reachable: true },
      },
      sanctions: [{ key: 'ofac', last_refreshed_at: '2026-11-26T08:00:00.000Z', status: 'READY' }],
      sourcesByStatus: [{ n: 6, status: 'ACTIVE' }],
    }),
  );
  backend.set(
    'GET',
    '/ops/workspaces',
    rawJson({
      workspaces: [
        {
          id: '66666666-ffff-4fff-8fff-666666666666',
          members: 3,
          name: 'Dark Ops Corp',
          status: 'ACTIVE',
          status_note: 'ok',
          status_updated_at: '2026-11-26T08:00:00.000Z',
        },
      ],
    }),
  );
  await loginAs(page);

  // PR-UI1：深浅主题切换入口收纳在左下角账号弹出菜单内（data-gs="theme-toggle"）。
  await page.locator("[data-gs='account-trigger']").click();
  await page.locator("[data-gs='theme-toggle']").click();
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(luminance(bodyBg), `深色背景应足够暗：${bodyBg}`).toBeLessThan(60);

  const contrastFailures: Array<{
    path: string;
    violations: Array<{ impact: string | null | undefined; nodes: string[][] }>;
  }> = [];

  for (const path of PAGES) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    // 轮询和传输连接可能保持活跃，页面可用后仍要执行所有对比度检查。
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    await expect(page.locator('main').first(), path + ' 应渲染主要区域').toBeVisible({ timeout: 12000 });
    await page.locator('.loading').first().waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(350);

    if (path.startsWith('/ops')) {
      const cardBg = await page.evaluate(() => {
        const card = document.querySelector('.ops__card, .ops__table-wrap, .ops__header');
        return card ? getComputedStyle(card).backgroundColor : '';
      });
      if (cardBg) {
        expect(luminance(cardBg), `${path} 暗色卡片不应为白色底：${cardBg}`).toBeLessThan(70);
      }
    }

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
