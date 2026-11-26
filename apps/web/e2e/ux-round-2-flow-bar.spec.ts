/**
 * 体验问题第二轮（2026-11-26）· 交互建议 1：主链路进度浮窗。
 * 进度是跨页面的，所以做成只在主流程页面显示的底部细条，取代买家画像、买家线索两页里的步骤条。
 * 全部走 BFF mock，不依赖引擎与数据库。
 */
import type { Locator, Page } from '@playwright/test';

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

/** 可变的进度状态：公司、画像、方案、运行。 */
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
  backend.set('GET', '/tasks', json(() => (state.run ? [{ id: 'task-1', runs: [state.run], status: 'active' }] : [])));
  return state;
}

const bar = (page: Page) => page.locator("[data-gs='flow-bar']");
/** 当前步的标题（antd 给当前步加 ant-steps-item-process）。 */
const current = (page: Page) =>
  bar(page).locator('.ant-steps-item-process .ant-steps-item-title');

async function expectStep(page: Page, step: Locator, label: string): Promise<void> {
  await expect(page.locator("[data-gs='flow-bar']").getByRole('button', { name: label })).toHaveAttribute(
    'aria-current',
    'step',
  );
  await expect(step).toHaveText(label);
}

test('进度浮窗只在主流程页面显示，其他页面不占地方', async ({ page }) => {
  await installMockBackend(page);
  await loginAs(page);
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(bar(page)).toHaveCount(0);

  await page.goto('/notifications');
  await expect(page.getByRole('heading', { level: 1, name: '通知' })).toBeVisible();
  await expect(bar(page)).toHaveCount(0);

  for (const path of ['/companies', '/find-buyers', '/tasks', '/leads']) {
    await page.goto(path);
    await expect(bar(page)).toBeVisible();
  }
});

test('页面上的按钮不和步骤同名，否则读屏软件和按名称找按钮都用不了', async ({ page }) => {
  await installMockBackend(page);
  await loginAs(page);
  for (const path of ['/companies', '/find-buyers', '/tasks', '/leads']) {
    await page.goto(path);
    await expect(bar(page)).toBeVisible();
    for (const label of ['完善档案', '设定买家画像', '确认寻源方案', '等待寻源', '判断线索']) {
      await expect(page.getByRole('button', { exact: true, name: label })).toHaveCount(1);
    }
  }
});

test('站内离开主流程页面再回来：浮窗和底部留白都恢复', async ({ page }) => {
  await installMockBackend(page);
  await loginAs(page);
  await page.goto('/leads');
  // 占位块加在路由视图容器末尾（原因见设计系统 §18）
  const viewPad = () =>
    page.evaluate(
      () => getComputedStyle(document.querySelector('.page-route-container') as HTMLElement, '::after').height,
    );
  await expect(bar(page)).toBeVisible();
  await expect.poll(viewPad).toBe('40px');

  // 站内跳到工作台（不是整页刷新）：浮窗卸载，留白归零
  const nav = page.locator('[data-sdr-nav]');
  await nav.getByRole('menuitem', { name: '工作台' }).click();
  await page.waitForURL(/\/workspace$/);
  await expect(bar(page)).toHaveCount(0);
  await expect.poll(viewPad).toBe('0px');

  // 再回主流程页面：进度数据还在，浮窗重新出现，留白恢复
  await expect(nav.getByText('获客与筛选', { exact: true })).toBeVisible();
  await nav.getByRole('menuitem', { name: '买家线索' }).click();
  await page.waitForURL(/\/leads$/);
  await expect(bar(page)).toBeVisible();
  await expect.poll(viewPad).toBe('40px');
});

test('进度按真实状态走，点某一步直接跳过去', async ({ page }) => {
  const backend = await installMockBackend(page);
  const state = mockProgress(backend);
  await loginAs(page);
  await page.goto('/companies');

  // 还没有确认过的公司档案：第 1 步
  await expect(current(page)).toHaveText('完善档案');
  await expectStep(page, current(page), '完善档案');

  // 档案确认了、还没有生效中的买家画像：第 2 步（点步骤本身跳到买家画像页，浮窗跟着重新取数）
  state.companies = [COMPANY];
  await bar(page).getByRole('button', { name: '设定买家画像' }).click();
  await page.waitForURL(/\/find-buyers$/);
  await expect(current(page)).toHaveText('设定买家画像');

  // 画像生效、还没有方案：第 3 步
  state.icps = [PROFILE];
  await bar(page).getByRole('button', { name: '完善档案' }).click();
  await page.waitForURL(/\/companies$/);
  await expect(current(page)).toHaveText('确认寻源方案');

  // 方案可执行、这一轮还在跑：第 4 步，点它直达最近一次运行
  state.plans = [PLAN];
  state.run = taskRun('RUNNING');
  await bar(page).getByRole('button', { name: '设定买家画像' }).click();
  await page.waitForURL(/\/find-buyers$/);
  await expect(current(page)).toHaveText('等待寻源');
  await bar(page).getByRole('button', { name: '等待寻源' }).click();
  await page.waitForURL(/\/runs\/run-1$/);
  await expect(bar(page)).toBeVisible();

  // 这一轮已产出线索：第 5 步，点它去买家线索
  state.run = taskRun('DONE');
  await bar(page).getByRole('button', { name: '完善档案' }).click();
  await page.waitForURL(/\/companies$/);
  await expect(current(page)).toHaveText('判断线索');
  await bar(page).getByRole('button', { name: '判断线索' }).click();
  await page.waitForURL(/\/leads$/);
});

test('可以收起成右下角的小标签并记住；窄屏收成一句，点开才展开五步', async ({ page }) => {
  await installMockBackend(page);
  await loginAs(page);
  await page.goto('/leads');
  await expect(bar(page)).toBeVisible();

  await page.locator("[data-gs='flow-bar-collapse']").click();
  await expect(bar(page)).toHaveCount(0);
  const pill = page.locator("[data-gs='flow-bar-expand']");
  await expect(pill).toContainText('第 1 / 5 步 · 完善档案');
  // 刷新后仍然是收起的
  await page.reload();
  await expect(pill).toBeVisible();
  await pill.click();
  await expect(bar(page)).toBeVisible();

  // 手机宽度：只剩一句，点开是从底部展开的一列
  await page.setViewportSize({ height: 844, width: 390 });
  const summary = page.locator("[data-gs='flow-bar-summary']");
  await expect(summary).toContainText('第 1 / 5 步 · 完善档案');
  await expect(bar(page).getByRole('button', { name: '判断线索' })).toHaveCount(0);
  await summary.click();
  const sheet = page.locator("[data-gs='flow-bar-sheet']");
  await expect(sheet.getByRole('button', { name: '判断线索' })).toBeVisible();
  await sheet.getByRole('button', { name: '判断线索' }).click();
  await page.waitForURL(/\/leads$/);
});

test('买家画像、买家线索两页不再有页内步骤条；浮窗贴底、从侧栏右边开始，页面底部留出同样的高度', async ({
  page,
}) => {
  const backend = await installMockBackend(page);
  mockProgress(backend);
  await loginAs(page);
  for (const path of ['/find-buyers', '/leads']) {
    await page.goto(path);
    await expect(bar(page)).toBeVisible();
    await expect(page.locator("[data-gs='stage-steps']")).toHaveCount(0);
  }

  const metrics = await page.evaluate(() => {
    const flow = document.querySelector("[data-gs='flow-bar']") as HTMLElement;
    const sidebar = document.querySelector("aside[data-layout-region='sidebar']") as HTMLElement;
    const view = document.querySelector('.page-route-container') as HTMLElement;
    const scroll = document.querySelector("[data-layout-region='scroll']") as HTMLElement;
    const rect = flow.getBoundingClientRect();
    return {
      barBottom: rect.bottom,
      barHeight: rect.height,
      barLeft: rect.left,
      // 占位块加在路由视图容器末尾（::after）；滚动区和容器自己都不留内边距
      spacerHeight: getComputedStyle(view, '::after').height,
      viewPaddingBottom: getComputedStyle(view).paddingBottom,
      scrollPaddingBottom: getComputedStyle(scroll).paddingBottom,
      sidebarWidth: sidebar.getBoundingClientRect().width,
      viewportHeight: window.innerHeight,
    };
  });
  expect(metrics.barHeight).toBe(40);
  expect(Math.abs(metrics.barBottom - metrics.viewportHeight)).toBeLessThan(1);
  expect(Math.abs(metrics.barLeft - metrics.sidebarWidth)).toBeLessThan(1);
  expect(metrics.spacerHeight).toBe('40px');
  expect(metrics.viewPaddingBottom).toBe('0px');
  expect(metrics.scrollPaddingBottom).toBe('0px');
  // 滚到底后，页面内容的底边不落在浮窗下面（最后一段能完整露出来）
  const clearance = await coveredPixels(page);
  expect(clearance).toBeLessThanOrEqual(1);
});

/** 滚到底后，页面内容的底边超出浮窗顶边的像素数（不大于 0 表示没被盖住）。 */
async function coveredPixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const scroll = document.querySelector("[data-layout-region='scroll']") as HTMLElement;
    const flow = document.querySelector("[data-gs='flow-bar']") as HTMLElement;
    const content = document.querySelector('.page-route-container > :last-child') as HTMLElement;
    scroll.scrollTop = scroll.scrollHeight;
    return Math.round(content.getBoundingClientRect().bottom - flow.getBoundingClientRect().top);
  });
}

test('关键操作后进度立刻更新：激活画像后从第 2 步走到第 3 步', async ({ page }) => {
  const backend = await installMockBackend(page);
  const state = mockProgress(backend);
  state.companies = [COMPANY];
  state.icps = [{ ...PROFILE, companyAttributes: {}, status: 'HYPOTHESIS', version: 1 }];
  backend.set('POST', '/icps/icp-1/activate', json(() => {
    state.icps = [PROFILE];
    return PROFILE;
  }));
  await loginAs(page);
  await page.goto('/find-buyers');
  await expect(current(page)).toHaveText('设定买家画像');

  await page.locator("[data-gs='icp-next-button']").click();
  await expect.poll(() => backend.callsTo('POST', '/icps/icp-1/activate').length).toBe(1);
  await expect(current(page)).toHaveText('确认寻源方案');

  // 页面在顶部时，贴底的「下一步」浮在浮窗上方 12px
  const next = (await page.locator("[data-gs='icp-next']").boundingBox())!;
  const flowBar = (await bar(page).boundingBox())!;
  expect(Math.abs(next.y + next.height - (flowBar.y - 12))).toBeLessThan(2);

  // 这一页内容比视口长：滚到底后，工作区最后一段不被浮窗盖住
  // （贴底元素在页底会回到页面里自己的位置，所以先量位置、再滚动）
  const covered = await coveredPixels(page);
  expect(covered).toBeLessThanOrEqual(1);
});
