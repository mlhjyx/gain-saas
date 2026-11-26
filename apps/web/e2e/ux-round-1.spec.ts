/**
 * 体验问题第一轮（2026-11-26）的回归用例：全部走 BFF mock，不依赖引擎与数据库。
 * 每条对应体验反馈里的一个编号，用例名里带编号，方便回查。
 * 断言只挂 role / 文案 / data-gs 锚点，不依赖页面的样式类名。
 */
import type { Page } from '@playwright/test';

import { expect, test } from '@playwright/test';

import type { MockBackend, MockHandler } from './support/mock-backend';

import { installMockBackend, loginAs } from './support/mock-backend';

const NOW = '2026-11-26T08:00:00.000Z';
const LATER = '2026-11-26T09:00:00.000Z';

const ICP = {
  companyId: 'c1',
  createdAt: NOW,
  id: 'icp-1',
  name: '德国五金进口商',
  status: 'ACTIVE',
  version: 1,
};

const COMPANY = {
  businessEmail: 'sales@example.org',
  domain: 'example.org',
  id: 'c1',
  industry: '五金工具',
  name: '宁波宏达机电有限公司',
  status: 'ACTIVE',
  targetMarkets: ['DE'],
  website: 'https://example.org',
};

const PLAN = {
  createdAt: NOW,
  icpId: 'icp-1',
  id: 'plan-1',
  queries: [{ keywords: ['五金工具 进口商'], source_class: 'public_web' }],
  status: 'READY',
  version: 1,
};

function taskRun(status: string, startedAt: string, id = 'tr-1') {
  return {
    attempt: 1,
    finishedAt: null,
    id,
    planId: 'plan-1',
    rerunOf: null,
    runId: `run-${id}`,
    startedAt,
    status,
    trigger: 'manual',
  };
}

/** 动态数据端点：每次请求时求值，用闭包状态模拟服务端状态机。 */
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

function errorBody(payload: unknown, status: number): MockHandler {
  return async ({ route }) => {
    await route.fulfill({
      body: JSON.stringify(payload),
      contentType: 'application/json',
      status,
    });
    return true;
  };
}

/** 步骤条当前所在步骤的标题（antd 给当前步加 ant-steps-item-process）。 */
function currentStep(page: Page) {
  return page.locator("[data-gs='stage-steps'] .ant-steps-item-process .ant-steps-item-title");
}

/** 运行页五张进度卡的状态，按顺序（已完成 / 进行中 / 等待开始分别记为 done / current / pending）。 */
function stageStates(page: Page): Promise<Array<null | string>> {
  return page
    .locator("[data-gs='run-stage']")
    .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-gs-state')));
}

test('#11 命令面板关闭时不吞掉回车和方向键', async ({ page }) => {
  await installMockBackend(page);
  await loginAs(page);
  await page.goto('/leads');
  // 放一个真实的多行输入框：回车要能换行，方向键要能上下移动光标。
  await page.evaluate(() => {
    const probe = document.createElement('textarea');
    probe.id = 'key-probe';
    document.body.append(probe);
    probe.focus();
  });
  await page.keyboard.press('Enter');
  await page.keyboard.type('ab');
  await page.keyboard.press('ArrowUp');
  const probe = page.locator('#key-probe');
  expect(await probe.inputValue()).toBe('\nab');
  expect(await probe.evaluate((el) => (el as HTMLTextAreaElement).selectionStart)).toBe(0);
});

// #1（注册引导返回修改官网）与 #2（引导页行业选项去分类码）已移交并行 PR feat/onboarding-intake-combine
// 随 acq-p2-fast-onboarding-and-streaming.spec.ts 一并收口，此处不再重复断言 onboarding 页面。

test('#14 买家画像：步骤条跟着寻源进度走', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/companies', [COMPANY]);
  backend.set('GET', '/icps', [ICP]);
  const progress = { plans: [] as unknown[], runs: [] as unknown[] };
  backend.set('GET', '/icps/icp-1/query-plans', json(() => progress.plans));
  backend.set(
    'GET',
    '/tasks',
    json(() => [{ id: 'task-1', name: '挖掘任务', runs: progress.runs, status: 'active' }]),
  );

  await loginAs(page);
  await page.goto('/find-buyers');
  // 画像已生效、还没有方案：停在「确认寻源方案」
  await expect(currentStep(page)).toHaveText('确认寻源方案');

  progress.plans.push(PLAN);
  await page.reload();
  // 方案已确认、这一轮还没产出：停在「等待寻源」
  await expect(currentStep(page)).toHaveText('等待寻源');

  progress.runs.push(taskRun('PARTIAL', NOW));
  await page.reload();
  // 这一轮已产出线索：走到「判断线索」
  await expect(currentStep(page)).toHaveText('判断线索');

  // 迭代画像后发起了新一轮，还在跑：退回「等待寻源」
  progress.runs.push(taskRun('RUNNING', LATER, 'tr-2'));
  await page.reload();
  await expect(currentStep(page)).toHaveText('等待寻源');
});

test('#14 买家线索：步骤条按实际进度显示，多个任务的运行合并取最近一次', async ({ page }) => {
  const backend = await installMockBackend(page);
  const icp = { ...ICP };
  const progress = { plans: [] as unknown[], runs: [] as unknown[] };
  backend.set('GET', '/icps', json(() => [icp]));
  backend.set('GET', '/icps/icp-1/query-plans', json(() => progress.plans));
  backend.set(
    'GET',
    '/tasks',
    json(() => [
      { id: 'task-1', name: '第一轮', runs: [taskRun('PARTIAL', NOW)], status: 'active' },
      { id: 'task-2', name: '第二轮', runs: progress.runs, status: 'active' },
    ]),
  );

  await loginAs(page);
  await page.goto('/leads');
  await expect(currentStep(page)).toHaveText('确认寻源方案');

  progress.plans.push(PLAN);
  await page.reload();
  // 第一个任务的那一轮已经产出过线索
  await expect(currentStep(page)).toHaveText('判断线索');

  // 第二个任务里新一轮还在跑：以最近的一次为准
  progress.runs.push(taskRun('RUNNING', LATER, 'tr-2'));
  await page.reload();
  await expect(currentStep(page)).toHaveText('等待寻源');

  // 画像还没生效：回到「设定买家画像」
  icp.status = 'DRAFT';
  await page.reload();
  await expect(currentStep(page)).toHaveText('设定买家画像');
});

test('#15 #18 运行页：编号收进技术详情，五步进度按引擎阶段显示', async ({ page }) => {
  const backend = await installMockBackend(page);
  const run: Record<string, unknown> = {
    createdAt: NOW,
    icpId: 'icp-11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    id: 'run-1',
    mode: 'quick',
    phases: { deepStartedAt: LATER, quickDoneAt: NOW, quickStartedAt: NOW },
    planId: 'plan-22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    // 新格式 run 的数字在 quickScan / deep 里；旧的 queries / companies / fit 字段不再回填
    stats: { deep: { done: 4, failed: 0 }, quickScan: { match: 30, poolSize: 120 } },
    status: 'RUNNING',
  };
  backend.set('GET', '/discovery-runs/run-1', json(() => run));
  backend.set('GET', '/discovery-runs/run-1/jobs', []);
  backend.set('GET', '/discovery-runs/run-1/events', { events: [], nextAfter: 0, status: 'RUNNING' });
  backend.set('GET', '/runs/run-1/trace', { data: [], page: { has_more: false } });

  await loginAs(page);
  await page.goto('/runs/run-1');

  // 页头不再摆内部编号；编号在折叠的「技术详情：任务编号」里，给反馈问题时对账用
  const head = page.locator("[data-gs='run-head']");
  await expect(head).not.toContainText('icp-1111');
  await expect(head).not.toContainText('plan-2222');
  const identity = page.locator("[data-gs='run-identity']");
  await expect(identity).toContainText('icp-11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  await expect(identity).toContainText('plan-22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  await expect(identity).not.toBeVisible();

  const values = page.locator("[data-gs='run-stage-value']");

  // 快扫走完（搜索、收集、匹配完成），深挖进行中，还没到汇总
  await expect.poll(() => stageStates(page)).toEqual([
    'done',
    'done',
    'done',
    'current',
    'pending',
  ]);
  await expect(values).toHaveText(['已完成', '120 家企业', '30 家匹配', '进行中', '等待完成']);

  // 快扫刚开始：没有旧字段也算「走过」，不再五张卡全是「等待开始」
  run.phases = { quickStartedAt: NOW };
  run.stats = {};
  await page.reload();
  await expect.poll(() => stageStates(page)).toEqual([
    'done',
    'done',
    'current',
    'pending',
    'pending',
  ]);
  await expect(values).toHaveText(['已完成', '已完成', '进行中', '等待开始', '等待完成']);

  // 没有阶段标记的旧记录：退回「第一个没走过的步骤就是当前步骤」
  delete run.phases;
  await page.reload();
  await expect.poll(() => stageStates(page)).toEqual([
    'current',
    'pending',
    'pending',
    'pending',
    'pending',
  ]);
});

test('#16 通知页标记已读后，侧栏红点立刻消失', async ({ page }) => {
  const backend = await installMockBackend(page);
  let read = false;
  backend.set('POST', '/notifications/n1/read', json(() => {
    read = true;
    return { ok: true };
  }));
  backend.set(
    'GET',
    '/notifications',
    json(() => ({
      items: [
        {
          createdAt: NOW,
          id: 'n1',
          link: '/leads',
          readAt: read ? NOW : null,
          title: '寻源完成，有 3 条线索待判断',
          type: 'DiscoveryRunCompleted',
        },
      ],
      unreadCount: read ? 0 : 1,
    })),
  );

  const unread = page.locator("[data-gs='nav-unread']:visible");
  await loginAs(page);
  await expect(unread).toHaveCount(1);
  await page.getByRole('menuitem', { name: '通知' }).click();
  await page.waitForURL(/\/notifications/);
  await page.getByRole('button', { name: /寻源完成/ }).click();
  await page.waitForURL(/\/leads/);
  expect(backend.callsTo('POST', '/notifications/n1/read')).toHaveLength(1);
  // 侧栏红点是布局里另一份 30 秒轮询的数据：已读后要主动通知它刷新，而不是等下一轮
  await expect(unread).toHaveCount(0);
});

test('#17 工作台：没有可去页面的通知标为「通知」，不给「去处理」', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/notifications', {
    items: [
      {
        createdAt: LATER,
        id: 'n2',
        title: '一条已批准的企业事实已被撤销，相关后续生成将不再引用',
        type: 'ClaimRevoked',
      },
      { createdAt: NOW, id: 'n1', link: '/leads', title: '新的买家线索', type: 'LeadQualified' },
    ],
    unreadCount: 2,
  });
  await loginAs(page);
  await page.goto('/workspace');

  const alerts = page.locator("[data-gs='workspace-alert']");
  const notice = alerts.filter({ hasText: '一条已批准的企业事实已被撤销' });
  await expect(notice).toContainText('通知');
  await expect(notice.locator('.gs-badge')).toHaveText('通知');
  await expect(notice.getByRole('button', { name: /去处理/ })).toHaveCount(0);

  // 有链接的通知照旧可以「去处理」
  const linked = alerts.filter({ hasText: '新的买家线索' });
  await expect(linked.getByRole('button', { name: /去处理/ })).toBeVisible();
});

test('#23 #26 买家线索：卡片上直接有「查看档案包」，浏览器不给剪贴板时复制也生效', async ({
  page,
}) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/icps', [ICP]);
  backend.set('GET', '/leads', [
    {
      company: { country: '奥地利', domain: 'alpen-solar.at', name: 'Alpen Solar Technik GmbH' },
      createdAt: NOW,
      fitVerdict: 'match',
      icpId: 'icp-1',
      id: 'lead-1',
      queue: 'needs_review',
      status: 'DISCOVERED',
      totalScore: 80,
      updatedAt: NOW,
    },
  ]);
  // 模拟用内网 IP 或 http:// 打开：浏览器不提供 navigator.clipboard，只能走老办法
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => undefined });
    document.execCommand = (command: string) => {
      if (command === 'copy') {
        (window as unknown as { __uxCopied: string }).__uxCopied =
          (document.activeElement as HTMLTextAreaElement | null)?.value ?? '';
        return true;
      }
      return false;
    };
  });

  await loginAs(page);
  await page.goto('/leads');
  const card = page.locator("[data-gs='lead-card']");
  const open = card.locator("[data-gs='lead-package']");
  await expect(open).toHaveText('查看档案包');

  // 「⋯」里不再重复放「查看档案包」，只留复制官网
  await card.getByRole('button', { name: '更多操作' }).click();
  const menu = page.locator('.ant-dropdown:visible').getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText(['复制官网域名']);
  await menu.getByRole('menuitem', { name: '复制官网域名' }).click();
  await expect(page.getByText('已复制官网域名')).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { __uxCopied?: string }).__uxCopied),
  ).toBe('alpen-solar.at');

  await open.click();
  await page.waitForURL(/\/leads\/lead-1$/);
});

test('#21 接口报错按状态码给中文说明，不摆英文原文', async ({ page }) => {
  const backend = await installMockBackend(page);
  // 网关直接回的 502：没有三层文案，正文也不是 JSON
  backend.set(
    'GET',
    '/notifications',
    async ({ route }) => {
      await route.fulfill({
        body: '<html><body><center>502 Bad Gateway</center></body></html>',
        contentType: 'text/html',
        status: 502,
      });
      return true;
    },
  );
  await loginAs(page);
  await page.goto('/notifications');

  const alert = page.locator("[data-gs='async-error']");
  await expect(alert.locator('strong')).toHaveText('服务暂时不可用（502）');
  await expect(alert).toContainText('稍后重试');
  // 右上角的全局提示同理
  const toast = page.locator('.ant-message-notice').last();
  await expect(toast).toContainText('服务暂时不可用（502）');
  await expect(toast).not.toContainText('Request failed');

  // 引擎透传的英文报错（没有三层文案）：标题换成中文说明，原始信息留在技术详情
  backend.set(
    'GET',
    '/notifications',
    errorBody({ error: { code: 'PLAN_NOT_FOUND', message: 'query plan not found' } }, 404),
  );
  await page.reload();
  await expect(alert.locator('strong')).toHaveText('请求的内容不存在或已被删除');
  await expect(alert).not.toContainText('query plan not found');

  // 服务端自己写了中文说明的：照用
  backend.set(
    'GET',
    '/notifications',
    errorBody({ error: { code: 'X', message: '方案还在生成，请稍后再看' } }, 409),
  );
  await page.reload();
  await expect(alert.locator('strong')).toHaveText('方案还在生成，请稍后再看');
});

test('#3 #6 建议 2 公司档案：页签不带数量，档案就绪后收起「下一步」说明，生成草稿无新增时明确提示', async ({
  page,
}) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/workspace/context', {
    allowedActions: [],
    onboarding: { complete: true, companyId: 'c1' },
    user: backend.session.user,
    workspace: { ...backend.session.workspaces[0], role: backend.session.workspace.role },
  });
  backend.set('GET', '/companies', [COMPANY]);
  backend.set('GET', '/companies/c1/completeness', {
    approvedClaims: 2,
    conflictsOpen: 0,
    offerings: 1,
    pendingClaims: 0,
  });
  backend.set('GET', '/companies/c1/claims', [
    {
      companyId: 'c1',
      createdAt: NOW,
      id: 'claim-1',
      statement: '主营五金工具出口',
      status: 'APPROVED',
      type: 'capability',
      version: 1,
    },
  ]);
  backend.set('POST', '/onboarding/companies/c1/claim-drafts', {
    claims: [],
    created: 0,
    skipped: 3,
  });

  await loginAs(page);
  await page.goto('/companies');

  const views = page.getByRole('group', { name: '企业事实与资料库视图' }).getByRole('button');
  await expect(views).toHaveText(['企业事实', '资料库']);

  // 事实都审完了、画像还没建：只留「去设定画像」，不再写「下一步」加一段说明
  const next = page.locator("[data-gs='next-step']");
  await expect(next).toHaveCount(1);
  await expect(next).not.toContainText('下一步');
  await expect(next).not.toContainText('已通过');
  await expect(next.locator("[data-gs='primary-next']")).toHaveText('设定买家画像');

  // 从档案生成草稿、一条新的都没有：说清楚「没有新增」，清单原地刷新不进加载态
  await page.getByRole('button', { name: '从档案生成事实草稿' }).click();
  await expect(
    page.getByText('档案里的产品、行业和市场都已经生成过事实，本次没有新增。'),
  ).toBeVisible();
  expect(backend.callsTo('POST', '/onboarding/companies/c1/claim-drafts')).toHaveLength(1);
  await expect(page.locator("[data-gs='company-workspace']")).toBeVisible();
});
