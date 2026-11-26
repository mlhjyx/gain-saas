/**
 * Wave B2 导航壳层验收：「3 组 8 项」一级信息架构、零单条目分组、子路由侧栏高亮、
 * /outreach 三 Tab 枢纽（无页头无条件 shadowBadge）、/leads?view=reviews 复核切换与命令面板门控。
 */
import { GROWTH_PAGE_HIDDEN } from '../src/feature-flags';

import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

/** 路由切换有 120-180ms 淡入过渡；断言与截图前等它结束。 */
async function settle(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForTimeout(500);
}

/**
 * Wave B2「3 组 8 项」一级信息架构：
 * - 总览：工作台（/workspace）、成效复盘（/analytics）
 * - 获客与筛选：公司档案（/companies）、买家画像（/find-buyers）、挖掘任务（/tasks）、买家线索（/leads）
 * - 触达与转化（受 GROWTH_PAGE_HIDDEN 控制）：外发与战役（/outreach）、商机管线（/opportunities）
 */
const NAV_GROUPS = [
  {
    group: '总览',
    items: [
      { landmark: '.wk', name: '工作台', path: '/workspace' },
      { heading: '度量', landmark: '.mt', name: '成效复盘', path: '/analytics' },
    ],
  },
  {
    group: '获客与筛选',
    items: [
      { heading: '公司档案', landmark: '[data-gs="page-header"]', name: '公司档案', path: '/companies' },
      { heading: '买家画像', landmark: '[data-gs="page-header"]', name: '买家画像', path: '/find-buyers' },
      { landmark: '.gpc', name: '挖掘任务', path: '/tasks' },
      { heading: '买家线索', landmark: '[data-gs="page-header"]', name: '买家线索', path: '/leads' },
    ],
  },
  {
    group: '触达与转化',
    items: [
      { heading: '外发与战役', landmark: '[data-gs="outreach-hub"]', name: '外发与战役', path: '/outreach' },
      { heading: '商机', landmark: '.gpc', name: '商机管线', path: '/opportunities' },
    ],
  },
] as const;

function groupLocator(page: import('@playwright/test').Page, group: string) {
  return page.locator('[data-sdr-nav] .sdr-section__label').filter({ hasText: group });
}

test('3 组 8 项导航可点、零单条目分组，详情与运行页高亮归属菜单，周报重定向至成效复盘', async ({
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

  // pass3 B：顶栏（banner）不得出现任何菜单项；导航只存在于侧边栏。
  await expect(page.getByRole('banner').getByRole('menuitem')).toHaveCount(0);

  // GROWTH_PAGE_HIDDEN=true 时，「触达与转化」分组因无可见子项自动隐藏；剩余每个可见分组均 >= 2 项（零单条目分组）。
  const visibleGroups = NAV_GROUPS.filter(
    (group) => !(GROWTH_PAGE_HIDDEN && group.group === '触达与转化'),
  );
  if (GROWTH_PAGE_HIDDEN) {
    await expect(groupLocator(page, '触达与转化')).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: '外发与战役' })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: '商机管线' })).toHaveCount(0);
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
    expect(section.count, `分组「${section.label}」不得为单条目分组`).toBeGreaterThanOrEqual(2);
  }

  // 业务分组齐全；无旧词/死项（周报、战役计划、商机与触达、找买家）
  for (const group of visibleGroups) {
    await expect(groupLocator(page, group.group)).toBeVisible();
  }
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

  // /tasks/:taskId 与 /runs/:runId 均高亮侧栏「挖掘任务」
  const tasksMenu = page.locator('[data-sdr-nav]').getByRole('menuitem', { name: '挖掘任务' });
  await page.goto('/tasks/task-1');
  await expect(tasksMenu).toHaveAttribute('aria-current', 'page');
  await expect(tasksMenu).toHaveClass(/\bis-active\b/);

  await page.goto('/runs/run-1');
  await expect(tasksMenu).toHaveAttribute('aria-current', 'page');
  await expect(tasksMenu).toHaveClass(/\bis-active\b/);

  // /leads/:leadId 高亮侧栏「买家线索」
  const leadsMenu = page.locator('[data-sdr-nav]').getByRole('menuitem', { name: '买家线索' });
  await page.goto('/leads/lead-1');
  await expect(leadsMenu).toHaveAttribute('aria-current', 'page');
  await expect(leadsMenu).toHaveClass(/\bis-active\b/);

  // 设置：底部入口仍打开设置弹窗（Wave B3 统一退役）。
  await page.locator('.sdr-footer__row', { hasText: '设置' }).click();
  await expect(page.locator('.gs-settings__panel')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: '成员与角色' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.gs-settings__panel')).toHaveCount(0);

  // 周报已重定向至成效复盘 /analytics（无周报内容渲染）
  await page.goto('/reports');
  await page.waitForURL((url) => url.pathname === '/analytics');
  await expect(page.getByText('周报概览')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: '度量' })).toBeVisible();
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
  // 页头彻底移除无条件挂接的 shadowBadge
  await expect(page.getByText('运行期 · 按授权执行')).toHaveCount(0);

  // 3 个 Tab：战役计划 / 触达批次 / 回复
  const hubTabs = page.locator('[data-gs="outreach-hub-tabs"] > .ant-tabs > .ant-tabs-nav [role="tab"]');
  await expect(hubTabs).toHaveText(['战役计划', '触达批次', '回复']);

  // Tab 1：内嵌战役计划列表（不重复渲染 H1）
  await expect(page.getByRole('heading', { level: 1, name: '战役计划', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新建计划' }).first()).toBeVisible();
  await expect(page.getByText('还没有任何计划。先新建一个，再让系统起草。')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('outreach-campaigns.png') });

  // Tab 2：触达批次（?tab=batches）
  await hubTabs.nth(1).click();
  await page.waitForURL(/\/outreach\?.*tab=batches/);
  await settle(page);
  await expect(page.getByRole('heading', { level: 1, name: '触达批次', exact: true })).toHaveCount(0);
  await expect(page.getByText('还没有触达批次。新建一个批次，加入草稿后提交审批。')).toBeVisible();
  await page.getByRole('button', { name: '新建批次' }).click();
  await expect(page.getByPlaceholder('例如：德国泵业首触')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('outreach-batches.png') });

  // Tab 3：回复（?tab=replies）
  await hubTabs.nth(2).click();
  await page.waitForURL(/\/outreach\?.*tab=replies/);
  await settle(page);
  await expect(page.getByRole('heading', { level: 1, name: '回复收件箱', exact: true })).toHaveCount(0);
  await expect(page.getByText('还没有收到回复。首次发送后，回复与退信会出现在这里。')).toBeVisible();

  // 独立商机管线 /opportunities
  await page.goto('/opportunities');
  await settle(page);
  await expect(page.getByRole('heading', { level: 1, name: '商机', exact: true })).toBeVisible();
  await expect(page.getByText('还没有商机')).toBeVisible();
  await expect(page.getByRole('link', { name: '去买家线索' })).toBeVisible();

  // 买家线索页内分段切换 ?view=reviews 查看判定复核队列
  await page.goto('/leads');
  await expect(page.locator('[data-gs="leads-view-switch"]')).toBeVisible();
  await page.locator('[data-gs="leads-view-switch"]').getByRole('button', { name: '判定复核' }).click();
  await page.waitForURL(/\/leads\?.*view=reviews/);
  await expect(page.locator('[data-gs="leads-reviews-panel"]')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: '判定复核' })).toBeVisible();
  // 切回线索列表，清掉 view 参数
  await page.locator('[data-gs="leads-view-switch"]').getByRole('button', { name: '线索列表' }).click();
  await page.waitForURL((url) => url.pathname === '/leads' && !url.searchParams.has('view'));

  // 命令面板：GROWTH_PAGE_HIDDEN 门控 /outreach 和 /opportunities，但成效复盘与 AI 判定复核可直达
  await page.keyboard.press('Control+K');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const list = dialog.locator('.cmdk__list');
  await expect(list).toContainText('成效复盘');
  await expect(list).toContainText('AI 判定复核');
  if (GROWTH_PAGE_HIDDEN) {
    await expect(list).not.toContainText('外发与战役');
    await expect(list).not.toContainText('商机管线');
    await expect(list).not.toContainText('回复收件箱');
  }
  await dialog.getByRole('option', { name: /AI 判定复核/ }).click();
  await page.waitForURL(/\/leads\?.*view=reviews/);
});
