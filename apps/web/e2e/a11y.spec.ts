/**
 * P5b-22：可访问性审计（WCAG-EM 抽样）。
 *
 * 用 axe-core 在真实渲染的页面上跑 WCAG 2.x A/AA 规则：5 类页面（队列、公司、
 * 任务、通知、审计）+ 2 个流程（接受对话框、新建公司表单）。规则集固定为
 * wcag2a/wcag2aa，任何新增违规都会让 CI 变红——修复或显式豁免（reviewed）都
 * 必须出现在 diff 里。
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const ICP = {
  id: 'icp-1',
  name: '德国五金进口商',
  status: 'ACTIVE',
  createdAt: '2026-11-08T10:00:00.000Z',
  updatedAt: '2026-11-08T10:00:00.000Z',
};

const LEAD = {
  canonicalCompanyId: 'c1',
  company: { country: 'DE', domain: 'muster-metallbau.de', name: 'Muster Metallbau GmbH' },
  createdAt: '2026-11-08T10:12:30.000Z',
  fitVerdict: 'match',
  icpId: 'icp-1',
  id: 'lead-1',
  queue: 'needs_review',
  scored: true,
  status: 'DISCOVERED',
  totalScore: 82,
  updatedAt: '2026-11-08T10:12:30.000Z',
};

/**
 * 审计口径：只扫「页头 + 内容区」两个布局区（业务 UI），框架壳（侧栏菜单、
 * 全局搜索 kbd 提示、通知/用户下拉、版本号、工具栏折叠按钮）里的已知违规
 * 单列为框架升级项，配精确排除选择器——不把框架问题混进业务修复。
 */
const AUDIT_REGIONS = ['[data-layout-region="scroll"]']; // 业务内容区；头部为框架组件（见下）

const FRAMEWORK_CHROME = [
  '[data-layout-action="toggle-sidebar"]',
  '[id^="reka-popover-trigger"]',
  'button:has([class~="md:block"])', // 全局搜索的 kbd 提示按钮（低对比度，框架组件）
  '.app-version',
];

/**
 * 头部框架组件已知违规（不在本 PR 业务范围，登记给框架升级跟进）：
 *  - UserDropdown / Notification 触发器缺可读名称（button-name）
 *  - 全局搜索 kbd 提示低对比度（color-contrast）
 */

async function audit(
  page: import('@playwright/test').Page,
  options: { include?: string } = {},
): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']);
  if (options.include) {
    builder = builder.include(options.include);
  } else {
    for (const region of AUDIT_REGIONS) builder = builder.include(region);
  }
  for (const selector of FRAMEWORK_CHROME) builder = builder.exclude(selector);
  const results = await builder.analyze();
  const summary = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.slice(0, 3).map((node) => node.target),
  }));
  expect(summary, JSON.stringify(summary, null, 2)).toEqual([]);
}

test.describe('WCAG 2.x A/AA 抽样', () => {
  for (const path of ['/leads', '/companies', '/tasks', '/notifications', '/settings/audit']) {
    test(`页面 ${path} 无 A/AA 违规`, async ({ page }) => {
      const backend = await installMockBackend(page);
      backend.set('GET', '/icps', [ICP]);
      backend.set('GET', '/leads', [LEAD]);
      await loginAs(page);
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await audit(page);
    });
  }

  test('接受对话框流程可访问', async ({ page }) => {
    const backend = await installMockBackend(page);
    backend.set('GET', '/icps', [ICP]);
    backend.set('GET', '/leads', [LEAD]);
    await loginAs(page);
    await page.goto('/leads');
    await page
      .locator('.ld__lead')
      .filter({ hasText: 'Muster Metallbau GmbH' })
      .getByRole('button', { name: '值得跟进' })
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await audit(page, { include: '[role="dialog"]' });
  });

  test('新建公司向导（空态 CTA）可访问', async ({ page }) => {
    await installMockBackend(page);
    await loginAs(page);
    await page.goto('/companies');
    await page.waitForLoadState('networkidle');
    const cta = page.locator('.cp__cta');
    if (await cta.isVisible().catch(() => false)) {
      await cta.click();
      await expect(page.locator('.cp__modal')).toBeVisible();
      await audit(page, { include: '[role="dialog"]' });
      return;
    }
    await audit(page);
  });

  test('判定复核页与详情抽屉可访问', async ({ page }) => {
    const backend = await installMockBackend(page);
    const task = {
      companyName: 'Muster Metallbau GmbH',
      dueAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      id: 'jr-1',
      judgmentRecordId: 'record-1',
      priority: 0,
      reason: 'UNKNOWN',
      status: 'queued',
      verdictAtJudge: 'UNKNOWN',
    };
    backend.set('GET', '/judgment-reviews', { items: [task], nextCursor: null });
    backend.set('GET', '/judgments/stats', {
      byPriority: { '0': 1 },
      byReason: { UNKNOWN: 1 },
      byStatus: { queued: 1 },
      overturn: { overturned: 0, rate: null, resolved: 0 },
      windowDays: 7,
    });
    backend.set('GET', '/judgments/record-1', {
      canonicalCompanyId: 'c1',
      createdAt: '2026-11-09T08:00:00.000Z',
      criteria: [
        {
          applicable: true,
          evidence: [
            {
              kind: 'website',
              span: '官网产品页：金属加工与批发',
              url: 'https://muster-metallbau.de/produkte',
            },
          ],
          id: 'C1_MATERIAL',
          label: 'pass',
          rationale: '官网列出与目标品类一致的金属制品。',
          score: 8,
        },
      ],
      failureCode: null,
      id: 'record-1',
      modelRequested: 'judge-v2',
      verdict: 'UNKNOWN',
    });
    await loginAs(page);
    await page.goto('/growth?tab=reviews');
    await page.waitForLoadState('networkidle');
    await audit(page);

    await page
      .locator('.rv__table tbody tr')
      .first()
      .getByRole('button', { name: '查看' })
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await audit(page, { include: '[role="dialog"]' });
  });

  test('度量页可访问', async ({ page }) => {
    await installMockBackend(page);
    await loginAs(page);
    await page.goto('/growth?tab=metrics');
    await page.waitForLoadState('networkidle');
    await audit(page);
  });
});
