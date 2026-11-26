/**
 * PR-UI1 新版展示目录与导航壳层验收：
 * - 顶区高频核心项（无分组标题）：工作台（/workspace）、通知（/notifications）
 * - 分组 1「获客主线」：企业档案（/companies）、买家画像（/find-buyers）、买家线索（/leads）、寻源记录（/tasks）
 * - 分组 2「触达与转化」（全部 3 项受 GROWTH_PAGE_HIDDEN 统一门控）：外发与战役（/outreach）、商机管线（/opportunities）、成效复盘（/analytics）
 * - 直接深链 /outreach、/opportunities、/analytics 始终 100% 可达；/tasks/:id 与 /runs/:id 高亮 /tasks，/leads/:id 高亮 /leads。
 */
import { GROWTH_PAGE_HIDDEN } from '../src/feature-flags';

import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

async function settle(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForTimeout(450);
}

const NAV_GROUPS = [
  {
    group: '',
    items: [
      { landmark: '.wk', name: '工作台', path: '/workspace' },
      { heading: '通知', landmark: '.gpc', name: '通知', path: '/notifications' },
    ],
  },
  {
    group: '获客主线',
    items: [
      { heading: '企业档案', landmark: '[data-gs="page-header"]', name: '企业档案', path: '/companies' },
      { heading: '买家画像', landmark: '[data-gs="page-header"]', name: '买家画像', path: '/find-buyers' },
      { heading: '买家线索', landmark: '[data-gs="page-header"]', name: '买家线索', path: '/leads' },
      { landmark: '.gpc', name: '寻源记录', path: '/tasks' },
    ],
  },
  {
    group: '触达与转化',
    items: [
      { heading: '外发与战役', landmark: '[data-gs="outreach-hub"]', name: '外发与战役', path: '/outreach' },
      { heading: '商机', landmark: '.gpc', name: '商机管线', path: '/opportunities' },
      { heading: '成效复盘', landmark: '.mt', name: '成效复盘', path: '/analytics' },
    ],
  },
] as const;

function groupLocator(page: import('@playwright/test').Page, group: string) {
  return page.locator('[data-sdr-nav] .sdr-section__label').filter({ hasText: group });
}

test('新版左侧目录可点、顶区无多余标题、GROWTH_PAGE_HIDDEN 门控触达与转化 3 项、子路由高亮准确', async ({
  page,
}, testInfo) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/tasks', [
    {
      createdAt: '2026-11-26T08:00:00.000Z',
      createdBy: 'user-e2e',
      icpId: 'icp-1',
      id: 'task-1',
      lastRunAt: '2026-11-26T08:00:00.000Z',
      name: '德国五金进口商',
      runs: [],
      status: 'active',
      updatedAt: '2026-11-26T08:00:00.000Z',
    },
  ]);
  backend.set('GET', '/discovery-runs/run-1', {
    createdAt: '2026-11-26T08:00:00.000Z',
    icpId: 'icp-1',
    id: 'run-1',
    mode: 'quick',
    planId: 'plan-1',
    stats: {},
    status: 'RUNNING',
  });
  backend.set('GET', '/discovery-runs/run-1/jobs', []);
  backend.set('GET', '/discovery-runs/run-1/events', { events: [], nextAfter: 0, status: 'RUNNING' });
  backend.set('GET', '/runs/run-1/trace', { data: [], page: { has_more: false } });

  await loginAs(page);
  await settle(page);
  await page.screenshot({ path: testInfo.outputPath('nav-workspace.png') });

  // 顶栏（banner）不得出现任何菜单项；导航只存在于侧边栏。
  await expect(page.getByRole('banner').getByRole('menuitem')).toHaveCount(0);

  // GROWTH_PAGE_HIDDEN=true 时，「触达与转化」整组（外发与战役 / 商机管线 / 成效复盘）自动隐藏。
  const visibleGroups = NAV_GROUPS.filter(
    (group) => !(GROWTH_PAGE_HIDDEN && group.group === '触达与转化'),
  );
  if (GROWTH_PAGE_HIDDEN) {
    await expect(groupLocator(page, '触达与转化')).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: '外发与战役' })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: '商机管线' })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: '成效复盘' })).toHaveCount(0);
  }

  const sectionCounts = await page
    .locator('[data-sdr-nav] .sdr-section')
    .evaluateAll((sections) =>
      sections.map((section) => ({
        count: section.querySelectorAll('a.sdr-row').length,
        label: section.querySelector('.sdr-section__label')?.textContent?.trim() ?? '',
      })),
    );
  expect(sectionCounts.map((s) => s.label)).toEqual(visibleGroups.map((g) => g.group));
  for (const section of sectionCounts) {
    expect(section.count, `分组「${section.label || '顶区高频'}」不得为单条目分组`).toBeGreaterThanOrEqual(2);
  }

  // 分组标题核对；无旧词/死项（总览、获客与筛选、周报、战役计划、商机与触达、找买家）
  await expect(groupLocator(page, '获客主线')).toBeVisible();
  await expect(groupLocator(page, '总览')).toHaveCount(0);
  await expect(groupLocator(page, '获客与筛选')).toHaveCount(0);
  await expect(page.locator('.sdr-section__label').filter({ hasText: '设置' })).toHaveCount(0);
  await expect(page.locator('[data-sdr-nav]').getByRole('menuitem', { name: '成员与角色' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: '周报' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: '战役计划' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: '商机与触达' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: '找买家' })).toHaveCount(0);

  for (const group of visibleGroups) {
    for (const item of group.items) {
      await page.getByRole('menuitem', { name: item.name }).click();
      await page.waitForURL((url) => url.pathname === item.path);
      if ('heading' in item) {
        await expect(page.getByRole('heading', { level: 1, name: item.heading })).toBeVisible();
      } else {
        await expect(page.locator(item.landmark)).toBeVisible();
      }
    }
  }

  // /tasks/:taskId 与 /runs/:runId 均高亮侧栏「寻源记录」
  const tasksMenu = page.locator('[data-sdr-nav]').getByRole('menuitem', { name: '寻源记录' });
  await page.goto('/tasks/task-1');
  await expect(tasksMenu).toHaveAttribute('aria-current', 'page');
  await expect(tasksMenu).toHaveClass(/\bis-active\b/);

  await page.goto('/runs/run-1', { waitUntil: 'domcontentloaded' });
  await expect(tasksMenu).toHaveAttribute('aria-current', 'page', { timeout: 30_000 });
  await expect(tasksMenu).toHaveClass(/\bis-active\b/);

  // /leads/:leadId 高亮侧栏「买家线索」
  const leadsMenu = page.locator('[data-sdr-nav]').getByRole('menuitem', { name: '买家线索' });
  await page.goto('/leads/lead-1');
  await expect(leadsMenu).toHaveAttribute('aria-current', 'page');
  await expect(leadsMenu).toHaveClass(/\bis-active\b/);

  // 设置：底部入口直达整页 /settings/account
  await page.locator("[data-gs='nav-settings']").click();
  await page.waitForURL((url) => url.pathname === '/settings/account');
  await expect(page.locator('.gs-settings__panel')).toHaveCount(0);
  await expect(page.locator('[data-gs="settings-shell"]')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: '账号与空间' })).toBeVisible();

  // 直接深链 /analytics 与历史 /reports 重定向仍 100% 可达
  await page.goto('/reports');
  await page.waitForURL((url) => url.pathname === '/analytics');
  await expect(page.getByText('周报概览')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: '成效复盘', exact: true })).toBeVisible();
});

test('外发与战役枢纽（3 Tab、无页头影子徽标）、商机管线、线索判定复核与命令面板门控', async ({
  page,
}, testInfo) => {
  await installMockBackend(page);
  await loginAs(page);

  // 即使 GROWTH_PAGE_HIDDEN=true，直接访问 /outreach 与 /opportunities 照常可用
  await page.goto('/outreach');
  await settle(page);
  await expect(page.getByRole('heading', { level: 1, name: '外发与战役', exact: true })).toBeVisible();
  await expect(page.getByText('运行期 · 按授权执行')).toHaveCount(0);

  const hubTabs = page.locator('[data-gs="outreach-hub-tabs"] > .ant-tabs > .ant-tabs-nav [role="tab"]');
  await expect(hubTabs).toHaveText(['战役计划', '触达批次', '回复']);

  await expect(page.getByRole('heading', { level: 1, name: '战役计划', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新建计划' }).first()).toBeVisible();
  await expect(page.getByText('还没有任何计划。先新建一个，再让系统起草。')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('outreach-campaigns.png') });

  await hubTabs.nth(1).click();
  await page.waitForURL(/\/outreach\?.*tab=batches/);
  await settle(page);
  await expect(page.getByRole('heading', { level: 1, name: '触达批次', exact: true })).toHaveCount(0);
  await expect(page.getByText('还没有触达批次。新建一个批次，加入草稿后提交审批。')).toBeVisible();
  await page.getByRole('button', { name: '新建批次' }).click();
  await expect(page.getByPlaceholder('例如：德国泵业首触')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('outreach-batches.png') });

  await hubTabs.nth(2).click();
  await page.waitForURL(/\/outreach\?.*tab=replies/);
  await settle(page);
  await expect(page.getByRole('heading', { level: 1, name: '回复收件箱', exact: true })).toHaveCount(0);
  await expect(page.getByText('还没有收到回复。首次发送后，回复与退信会出现在这里。')).toBeVisible();

  await page.goto('/opportunities');
  await settle(page);
  await expect(page.getByRole('heading', { level: 1, name: '商机', exact: true })).toBeVisible();
  await expect(page.getByText('还没有商机')).toBeVisible();
  await expect(page.getByRole('link', { name: '去买家线索' })).toBeVisible();

  await page.goto('/leads');
  await expect(page.locator('[data-gs="leads-view-switch"]')).toBeVisible();
  await page.locator('[data-gs="leads-view-switch"]').getByRole('button', { name: '判定复核' }).click();
  await page.waitForURL(/\/leads\?.*view=reviews/);
  await expect(page.locator('[data-gs="leads-reviews-panel"]')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: '判定复核' })).toBeVisible();
  await page.locator('[data-gs="leads-view-switch"]').getByRole('button', { name: '线索列表' }).click();
  await page.waitForURL((url) => url.pathname === '/leads' && !url.searchParams.has('view'));

  // 命令面板：GROWTH_PAGE_HIDDEN 门控触达与转化（外发/商机/成效复盘），AI 判定复核与获客主线直达
  await page.keyboard.press('Control+K');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const list = dialog.locator('.cmdk__list');
  await expect(list).toContainText('寻源记录');
  await expect(list).toContainText('AI 判定复核');
  if (GROWTH_PAGE_HIDDEN) {
    await expect(list).not.toContainText('外发与战役');
    await expect(list).not.toContainText('商机管线');
    await expect(list).not.toContainText('成效复盘');
    await expect(list).not.toContainText('回复收件箱');
  }
  await dialog.getByRole('option', { name: /AI 判定复核/ }).click();
  await page.waitForURL(/\/leads\?.*view=reviews/);
});
