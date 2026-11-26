/**
 * PR-UI1 主流程进度芯片验收（替代旧版 40px 压底满宽白条）：
 * - 仅在主流程页面（企业档案、买家画像、寻源记录、运行页、买家线索）挂载于侧栏底部（设置上方）；
 * - 不再 position: fixed 压底切卡片，--gs-flow-bar-h 恒为 0px；
 * - 单行芯片展示「主流程 · 第 N/5 步 · <当前步>」，点击弹出 Popover 展示全部 5 个可点击步骤按钮；
 * - 当前步 aria-current="step"，「等待寻源」直达最近运行；折叠窄栏同样可点击弹出。
 */
import type { Page } from '@playwright/test';

import { expect, test } from '@playwright/test';

import type { MockBackend, MockHandler } from './support/mock-backend';

import { installMockBackend, loginAs } from './support/mock-backend';

const NOW = '2026-11-26T08:00:00.000Z';

const COMPANY = {
  businessEmail: 'sales@example.org',
  domain: 'example.org',
  id: 'c1',
  industry: '医疗设备',
  name: '深圳步安科技有限公司',
  status: 'ACTIVE',
  targetMarkets: ['US'],
  website: 'https://example.org',
};

const PROFILE = {
  companyId: 'c1',
  createdAt: NOW,
  id: 'icp-1',
  name: '美国高校的步态研究实验室',
  status: 'ACTIVE',
  version: 2,
};

const PLAN = {
  createdAt: NOW,
  icpId: 'icp-1',
  id: 'plan-1',
  queries: [{ keywords: ['gait lab'], source_class: 'public_web' }],
  status: 'READY',
  version: 1,
};

function taskRun(status: string): Record<string, unknown> {
  return {
    attempt: 1,
    finishedAt: status === 'RUNNING' ? null : NOW,
    id: 'tr-1',
    planId: 'plan-1',
    runId: 'run-1',
    startedAt: NOW,
    status,
    trigger: 'manual',
  };
}

function json(make: () => unknown): MockHandler {
  return async ({ route }) => {
    await route.fulfill({
      body: JSON.stringify({ data: make() }),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  };
}

function mockProgress(backend: MockBackend) {
  const state = {
    companies: [] as unknown[],
    icps: [] as unknown[],
    plans: [] as unknown[],
    run: null as null | Record<string, unknown>,
  };
  backend.set('GET', '/companies', json(() => state.companies));
  backend.set('GET', '/icps', json(() => state.icps));
  backend.set('GET', '/icps/icp-1', json(() => state.icps[0] ?? null));
  backend.set('GET', '/icps/icp-1/query-plans', json(() => state.plans));
  backend.set(
    'GET',
    '/tasks',
    json(() => (state.run ? [{ id: 'task-1', runs: [state.run], status: 'active' }] : [])),
  );
  return state;
}

const wrap = (page: Page) => page.locator("[data-gs='flow-progress-bar']");
const chip = (page: Page) => page.locator("[data-gs='flow-progress-chip']");
const popover = (page: Page) => page.locator("[data-gs='flow-progress-popover']");

async function openPopover(page: Page) {
  await expect(chip(page)).toBeVisible();
  const expanded = await chip(page).getAttribute('aria-expanded');
  if (expanded !== 'true') {
    await chip(page).click();
  }
  await expect(chip(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(popover(page)).toBeVisible();
}

async function expectCurrentStep(page: Page, stepNum: number, label: string): Promise<void> {
  await expect(chip(page)).toContainText(`主流程 · 第 ${stepNum}/5 步 · ${label}`);
  await openPopover(page);
  await expect(
    popover(page).getByRole('button', { exact: true, name: label }),
  ).toHaveAttribute('aria-current', 'step');
}

test('主流程芯片仅在主流程页面显示于侧栏底部，且不占用内容区底部高度（--gs-flow-bar-h=0px）', async ({
  page,
}) => {
  await installMockBackend(page);
  await loginAs(page);
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(wrap(page)).toHaveCount(0);

  await page.goto('/notifications');
  await expect(page.getByRole('heading', { level: 1, name: '通知' })).toBeVisible();
  await expect(wrap(page)).toHaveCount(0);

  for (const path of ['/companies', '/find-buyers', '/tasks', '/leads']) {
    await page.goto(path);
    await expect(chip(page)).toBeVisible();
    // 嵌入侧栏内部且宽度严守侧栏边界不溢出，内容区底部不再有 40px 占位
    const geo = await page.evaluate(() => {
      const chipEl = document.querySelector("[data-gs='flow-progress-chip']") as HTMLElement;
      const sidebar = document.querySelector('[data-sdr-nav]') as HTMLElement;
      const aside = document.querySelector("aside[data-layout-region='sidebar']") as HTMLElement;
      const view = document.querySelector('.page-route-container') as HTMLElement;
      const chipRect = chipEl.getBoundingClientRect();
      const asideRect = aside.getBoundingClientRect();
      return {
        chipInSidebar: Boolean(chipEl && sidebar && sidebar.contains(chipEl)),
        chipRight: Math.round(chipRect.right),
        asideRight: Math.round(asideRect.right),
        flowBarH: getComputedStyle(document.documentElement).getPropertyValue('--gs-flow-bar-h').trim(),
        spacerH: getComputedStyle(view, '::after').height,
      };
    });
    expect(geo.chipInSidebar).toBe(true);
    expect(geo.chipRight, '主流程芯片不得溢出侧栏右边界').toBeLessThanOrEqual(geo.asideRight);
    expect(geo.flowBarH).toBe('0px');
    expect(geo.spacerH).toBe('0px');
  }
});

test('Popover 展开 5 步按钮均唯一可点，且与页面按钮无重名冲突', async ({ page }) => {
  await installMockBackend(page);
  await loginAs(page);
  for (const path of ['/companies', '/find-buyers', '/tasks', '/leads']) {
    await page.goto(path);
    await openPopover(page);
    for (const label of ['完善档案', '设定买家画像', '确认寻源方案', '等待寻源', '判断线索']) {
      await expect(page.getByRole('button', { exact: true, name: label })).toHaveCount(1);
    }
    await page.keyboard.press('Escape');
  }
});

test('站内离开主流程页面再回来：芯片自动隐藏与恢复，底部高度恒为 0px', async ({ page }) => {
  await installMockBackend(page);
  await loginAs(page);
  await page.goto('/leads');
  const viewPad = () =>
    page.evaluate(
      () =>
        getComputedStyle(document.querySelector('.page-route-container') as HTMLElement, '::after')
          .height,
    );
  await expect(chip(page)).toBeVisible();
  await expect.poll(viewPad).toBe('0px');

  const nav = page.locator('[data-sdr-nav]');
  await nav.getByRole('menuitem', { name: '工作台' }).click();
  await page.waitForURL(/\/workspace$/);
  await expect(wrap(page)).toHaveCount(0);
  await expect.poll(viewPad).toBe('0px');

  await expect(nav.getByText('获客主线', { exact: true })).toBeVisible();
  await nav.getByRole('menuitem', { name: '买家线索' }).click();
  await page.waitForURL(/\/leads$/);
  await expect(chip(page)).toBeVisible();
  await expect.poll(viewPad).toBe('0px');
});

test('进度按真实状态演进，Popover 内点击任意步骤直达目标页（「等待寻源」直达最近运行）', async ({
  page,
}) => {
  const backend = await installMockBackend(page);
  const state = mockProgress(backend);
  await loginAs(page);
  await page.goto('/companies');

  // 第 1 步：完善档案
  await expectCurrentStep(page, 1, '完善档案');

  // 第 2 步：设定买家画像
  state.companies = [COMPANY];
  await popover(page).getByRole('button', { exact: true, name: '设定买家画像' }).click();
  await page.waitForURL(/\/find-buyers$/);
  await expectCurrentStep(page, 2, '设定买家画像');

  // 第 3 步：确认寻源方案
  state.icps = [PROFILE];
  await popover(page).getByRole('button', { exact: true, name: '完善档案' }).click();
  await page.waitForURL(/\/companies$/);
  await expectCurrentStep(page, 3, '确认寻源方案');

  // 第 4 步：等待寻源 → 直达 /runs/run-1
  state.plans = [PLAN];
  state.run = taskRun('RUNNING');
  await popover(page).getByRole('button', { exact: true, name: '设定买家画像' }).click();
  await page.waitForURL(/\/find-buyers$/);
  await expectCurrentStep(page, 4, '等待寻源');
  await popover(page).getByRole('button', { exact: true, name: '等待寻源' }).click();
  await page.waitForURL(/\/runs\/run-1$/);
  await expect(chip(page)).toBeVisible();

  // 第 5 步：判断线索 → 直达 /leads
  state.run = taskRun('DONE');
  await openPopover(page);
  await popover(page).getByRole('button', { exact: true, name: '完善档案' }).click();
  await page.waitForURL(/\/companies$/);
  await expectCurrentStep(page, 5, '判断线索');
  await popover(page).getByRole('button', { exact: true, name: '判断线索' }).click();
  await page.waitForURL(/\/leads$/);
});

test('折叠窄栏下芯片切换为紧凑图标按钮，点击仍可弹出 5 步 Popover 并跳转', async ({ page }) => {
  await installMockBackend(page);
  await loginAs(page);
  await page.goto('/leads');
  await expect(chip(page)).toBeVisible();

  await page.locator("[data-gs='sidebar-collapse']").click();
  await expect(page.locator('.sdr-rail')).toBeVisible();
  const railChip = page.locator(".sdr-rail [data-gs='flow-progress-chip']");
  await expect(railChip).toBeVisible();

  await railChip.click();
  await expect(popover(page)).toBeVisible();
  await popover(page).getByRole('button', { exact: true, name: '完善档案' }).click();
  await page.waitForURL(/\/companies$/);
});

test('关键操作后芯片即时更新：激活画像后从第 2 步推进到第 3 步，底部操作条紧贴视口底边 12px', async ({
  page,
}) => {
  const backend = await installMockBackend(page);
  const state = mockProgress(backend);
  state.companies = [COMPANY];
  state.icps = [{ ...PROFILE, companyAttributes: {}, status: 'HYPOTHESIS', version: 1 }];
  backend.set(
    'POST',
    '/icps/icp-1/activate',
    json(() => {
      state.icps = [PROFILE];
      return PROFILE;
    }),
  );
  await loginAs(page);
  await page.goto('/find-buyers');
  await expect(chip(page)).toContainText('主流程 · 第 2/5 步 · 设定买家画像');

  await page.locator("[data-gs='icp-next-button']").click();
  await expect.poll(() => backend.callsTo('POST', '/icps/icp-1/activate').length).toBe(1);
  await expect(chip(page)).toContainText('主流程 · 第 3/5 步 · 确认寻源方案');

  // 底部不再有 40px 压底栏，贴底「下一步」直接距视口底边 12px
  const next = (await page.locator("[data-gs='icp-next']").boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(Math.abs(next.y + next.height - (viewport.height - 12))).toBeLessThan(3);
});
