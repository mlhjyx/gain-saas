/**
 * v3.0 P5b-17 / G10 & Wave B2：被删除或合并的历史路由必须继续可解析（redirect ≥2 个发布版本）。
 * 深链落点必须是新 IA 里的真实页面（含 `?tab=` 精确分流、动态段与其余查询参数保留），不能落到 404。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

interface RedirectCase {
  expectedPath: string;
  expectedQuery?: Record<string, string>;
  from: string;
  stripQuery?: string[];
}

const LEGACY_CASES: RedirectCase[] = [
  // 原有 7 条历史重定向
  { expectedPath: '/workspace', from: '/dashboard' },
  { expectedPath: '/workspace', from: '/dashboard/analytics' },
  { expectedPath: '/workspace', from: '/demos' },
  { expectedPath: '/workspace', from: '/demos/antd' },
  { expectedPath: '/settings/members', from: '/profile' },
  { expectedPath: '/workspace', from: '/about' },
  { expectedPath: '/settings/members', from: '/settings/workspaces' },
  // Wave B2 新增 10 条历史重定向（含 /growth 全部 6 个 tab、动态段与查询保留）
  { expectedPath: '/outreach', expectedQuery: { tab: 'campaigns' }, from: '/growth' },
  { expectedPath: '/outreach', expectedQuery: { tab: 'campaigns' }, from: '/growth?tab=campaigns' },
  { expectedPath: '/outreach', expectedQuery: { tab: 'batches' }, from: '/growth?tab=outreach' },
  {
    expectedPath: '/outreach',
    expectedQuery: { lead: 'lead-99', tab: 'batches' },
    from: '/growth?tab=outreach&lead=lead-99',
  },
  { expectedPath: '/outreach', expectedQuery: { tab: 'replies' }, from: '/growth?tab=replies' },
  {
    expectedPath: '/opportunities',
    expectedQuery: { state: 'OPEN' },
    from: '/growth?tab=opportunities&state=OPEN',
    stripQuery: ['tab'],
  },
  {
    expectedPath: '/leads',
    expectedQuery: { view: 'reviews' },
    from: '/growth?tab=reviews',
    stripQuery: ['tab'],
  },
  {
    expectedPath: '/analytics',
    from: '/growth?tab=metrics',
    stripQuery: ['tab'],
  },
  { expectedPath: '/outreach', expectedQuery: { tab: 'campaigns' }, from: '/campaigns' },
  {
    expectedPath: '/outreach/campaigns/camp-42',
    expectedQuery: { src: 'mail' },
    from: '/campaigns/camp-42?src=mail',
  },
  { expectedPath: '/opportunities', from: '/qgos' },
  { expectedPath: '/analytics', from: '/reports' },
];

test('全部历史深链（含 /growth 6 个 tab 与动态段）精确重定向到新规范路由且无 404', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const backend = await installMockBackend(page);
  backend.set('GET', '/campaigns/camp-42', {
    authorizations: [],
    createdAt: '2026-11-26T08:00:00.000Z',
    id: 'camp-42',
    name: '历史重定向战役',
    objective: '验证动态段重定向',
    recentTrace: [],
    revisions: [],
    status: 'DRAFT',
    updatedAt: '2026-11-26T08:00:00.000Z',
  });

  await loginAs(page);

  for (const item of LEGACY_CASES) {
    await page.goto(item.from);
    await page.waitForURL((url) => url.pathname === item.expectedPath, { timeout: 15_000 });
    const landed = new URL(page.url());
    expect(landed.pathname, `${item.from} 应重定向到 ${item.expectedPath}`).toBe(item.expectedPath);
    for (const [key, value] of Object.entries(item.expectedQuery ?? {})) {
      expect(landed.searchParams.get(key), `${item.from} 应保留/写入 query ${key}=${value}`).toBe(
        value,
      );
    }
    for (const removed of item.stripQuery ?? []) {
      expect(landed.searchParams.has(removed), `${item.from} 不应残留旧 query ${removed}`).toBe(
        false,
      );
    }
    await expect(page.locator('main')).toBeVisible();
    await expect(page.getByText('404')).toHaveCount(0);
  }
});
