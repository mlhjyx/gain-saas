import type { MockBackend, MockHandler } from './support/mock-backend';

import { expect, test, type Page } from '@playwright/test';

import { errorPayload, installMockBackend, loginAs } from './support/mock-backend';
import { allowSourcing } from './support/sourcing-fixtures';

const STARTED = '2026-11-27T01:40:00.000Z';
const COMPANY = { id: 'company-1', name: '岚桥工业', status: 'ACTIVE' };
const PROFILE = {
  buyingCommittee: [{ concerns: ['采购交付'], role: 'buyer', title: '采购经理' }],
  companyAttributes: { buyer_spec: { target_roles: ['工业泵分销商'] }, country: 'FR' },
  companyId: COMPANY.id,
  exclusions: ['面向个人的零售商'],
  id: 'profile-1',
  name: '工业泵分销商',
  personas: [{ goals: ['控制备货周期'], title: '采购经理' }],
  status: 'ACTIVE',
  targetMarkets: ['DE', '奥地利', '德语区'],
  version: 3,
};
const DRAFT = { ...PROFILE, id: 'profile-2', name: '光伏配件买家', status: 'HYPOTHESIS', targetMarkets: [] };
const PLAN = {
  createdAt: STARTED,
  icpId: PROFILE.id,
  id: 'plan-1',
  queries: [{ filters: { country: 'AT' }, keywords: ['pump distributor'], source_class: 'public_web' }],
  status: 'DRAFT',
  version: 1,
};
const RUN = {
  createdAt: STARTED,
  icpId: PROFILE.id,
  id: 'run-1',
  planId: PLAN.id,
  stats: {},
  status: 'PARTIAL',
  taskRef: { taskId: 'task-1', taskRunId: 'attempt-1' },
};
const TASK = {
  icpId: PROFILE.id,
  id: 'task-1',
  name: PROFILE.name,
  runs: [{ id: 'attempt-1', planId: PLAN.id, runId: RUN.id, startedAt: STARTED, status: RUN.status }],
  status: 'active',
};
const MARKET_BUNDLE = {
  basis: {
    dataSource: 'un_comtrade_baseline_v1',
    hsCodes: [{ code: '841381', label: 'Other pumps', labelZh: '其他泵', matchedFrom: 'offering' }],
    inferredFrom: 'offerings_and_industry',
    referenceYear: 2024,
  },
  companyId: COMPANY.id,
  generatedAt: STARTED,
  isRecommendationOnly: true,
  recommendations: [
    { alreadySelected: false, code: 'DE', hsCodes: ['841381'], importVolumeUsd: 2450000000, labelEn: 'Germany', name: '德国', rank: 1, yoyGrowthPct: 18.4 },
    { alreadySelected: true, code: 'IT', hsCodes: ['841381'], importVolumeUsd: 1320000000, labelEn: 'Italy', name: '意大利', rank: 2, yoyGrowthPct: -2.5 },
    { alreadySelected: false, code: 'NL', hsCodes: ['841381'], importVolumeUsd: 980000000, labelEn: 'Netherlands', name: '荷兰', rank: 3, yoyGrowthPct: 0 },
  ],
};
const MONTHLY_MARKET_BUNDLE = {
  ...MARKET_BUNDLE,
  basis: {
    ...MARKET_BUNDLE.basis,
    coverage: 18,
    dataSource: 'un_comtrade_live',
    referencePeriod: '202608',
    referenceYear: 2026,
    shareBasis: 'comparable_reporters',
  },
};

function respond(make: () => unknown): MockHandler {
  return async ({ route }) => {
    await route.fulfill({ json: { data: make() } });
    return true;
  };
}

function fail(): MockHandler {
  return async ({ route }) => {
    await route.fulfill({
      json: errorPayload('UPSTREAM_UNAVAILABLE', { title: '服务暂不可用，请重试' }),
      status: 502,
    });
    return true;
  };
}

async function installBuyerJourneyBackend(page: Page) {
  const backend = await installMockBackend(page);
  allowSourcing(backend, COMPANY.id);
  return backend;
}

function mockProfiles(backend: MockBackend): void {
  backend.set('GET', '/companies', [COMPANY]);
  backend.set('GET', '/icps', [PROFILE, DRAFT]);
  backend.set('GET', '/icps/profile-1', PROFILE);
  backend.set('GET', '/icps/profile-2', DRAFT);
  backend.set('GET', '/icps/profile-1/query-plans', [PLAN]);
  backend.set('GET', '/icps/profile-2/query-plans', []);
}

test('画像概览只用目标市场，保留历史名称并按需读取判断反馈', async ({ page }) => {
  const backend = await installBuyerJourneyBackend(page);
  mockProfiles(backend);
  backend.set('GET', '/icps/profile-1/feedback', {
    rows: [],
    suggestions: [{ message: '优先查看现有分销商' }],
  });
  backend.set('GET', '/icps/profile-1/feedback/summary', {
    excludedDomains: ['retail.example'],
    stats: { totalRecorded: 1 },
  });
  await loginAs(page);
  await page.goto('/find-buyers');

  const oversight = page.locator('[data-gs="icp-overview"]');
  await expect(oversight.locator('[data-gs="icp-target-markets"]')).toHaveText('德国、奥地利、德语区');
  await expect(oversight).not.toContainText('法国');
  await expect(page.getByRole('link', { name: /岚桥工业/ })).toHaveAttribute(
    'href',
    '/companies?companyId=company-1&tab=facts',
  );
  await expect(page.locator('[data-gs="icp-next"]')).toHaveCount(0);
  expect(backend.callsTo('GET', '/icps/profile-1/feedback')).toHaveLength(0);

  await page.getByRole('tab', { name: '匹配条件' }).click();
  await page.getByText('采购角色与场景', { exact: true }).click();
  await expect(page.getByText('采购经理', { exact: true })).toHaveCount(1);
  await expect(page.getByText('控制备货周期')).toBeVisible();
  await expect(page.getByText('采购交付')).toBeVisible();
  await page.getByRole('tab', { name: '判断反馈' }).click();
  await expect(page.getByText('retail.example')).toBeVisible();
  await expect(page.getByText('优先查看现有分销商')).toBeVisible();

  await page.locator('[data-gs="icp-profile-switcher"]').getByRole('button', { name: /光伏配件买家/ }).click();
  await expect(page.getByRole('heading', { level: 2, name: '光伏配件买家' })).toBeVisible();
  await expect(page.getByText('暂未限定市场')).toBeVisible();
  await expect(page.getByRole('button', { name: '启用画像' })).toBeVisible();

  backend.set('GET', '/icps/profile-2', { ...DRAFT, targetMarkets: { legacy: '德国' } });
  await page.reload();
  await expect(page.locator('[data-gs="icp-target-markets"]')).toHaveText('市场待确认');
});

test('从画像到方案，确认和二次确认发起都在寻源记录中完成', async ({ page }) => {
  const backend = await installBuyerJourneyBackend(page);
  mockProfiles(backend);
  let planStatus = 'DRAFT';
  backend.set('GET', '/icps/profile-1/query-plans', respond(() => [{ ...PLAN, status: planStatus }]));
  backend.set('GET', '/tasks', [{ ...TASK, runs: [] }]);
  backend.set('POST', '/query-plans/plan-1/confirm', respond(() => ({ ...PLAN, status: (planStatus = 'READY') })));
  backend.set('POST', '/tasks/task-1/runs', { runId: RUN.id, status: 'RUNNING', taskRunId: 'attempt-new' });
  backend.set('GET', '/discovery-runs/run-1', { ...RUN, status: 'RUNNING' });
  await loginAs(page);
  await page.goto('/find-buyers?icp=profile-1');

  await page.getByRole('link', { name: '确认方案' }).click();
  await expect(page).toHaveURL(/\/tasks\?icp=profile-1&tab=plan&plan=plan-1/);
  expect(backend.callsTo('POST', '/query-plans')).toHaveLength(0);
  await page.getByRole('button', { name: '确认方案', exact: true }).click();
  await expect.poll(() => backend.callsTo('POST', '/query-plans/plan-1/confirm').length).toBe(1);
  await page.getByRole('button', { name: '开始寻源', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('link', { name: '积分钱包' })).toBeVisible();
  expect(backend.callsTo('POST', '/tasks/task-1/runs')).toHaveLength(0);
  await dialog.getByRole('button', { name: '开始寻源', exact: true }).click();
  await expect(page).toHaveURL(/\/runs\/run-1\?tab=progress/);
  expect(backend.callsTo('POST', '/tasks/task-1/runs')[0]?.body).toEqual({
    attemptId: expect.stringMatching(/^[a-f0-9-]{36}$/i),
    planId: PLAN.id,
  });
});

test('寻源结果按候选明细展示，仅本轮评分证据可链接线索', async ({ page }) => {
  const backend = await installBuyerJourneyBackend(page);
  mockProfiles(backend);
  backend.set('GET', '/tasks', [{
    ...TASK,
    runs: [
      ...TASK.runs,
      { ...TASK.runs[0], id: 'other-attempt', runId: 'run-2', status: 'DONE' },
    ],
  }]);
  backend.set('GET', '/tasks/task-1', TASK);
  backend.set('GET', '/discovery-runs/run-1', RUN);
  backend.set('GET', '/discovery-runs/run-2', { ...RUN, id: 'run-2' });
  backend.set('GET', '/discovery-runs/run-1/result-view', {
    candidates: {
      items: [
        { companyId: 'c-1', country: 'DE', name: 'Nordwerk Pumpen', stage: 'enriched' },
        { companyId: 'c-2', country: 'AT', name: 'Rheintal Fluidtechnik', stage: 'quick_judged' },
      ],
      total: 502,
      truncated: true,
    },
    icpId: PROFILE.id,
    runId: RUN.id,
    scoring: {
      latest: { items: [{ companyId: 'c-2', leadId: 'other-run-lead', scoredAt: STARTED, totalScore: 99 }], label: 'latest_not_necessarily_this_run' },
      thisRun: { available: true, batches: 1, items: [{ companyId: 'c-1', leadId: 'this-run-lead', totalScore: 0 }], label: 'this_run' },
    },
    status: RUN.status,
  });
  await loginAs(page);
  await page.goto('/runs/run-1');

  const result = page.locator('[data-gs="run-result-view"]');
  await expect(result.getByText('Nordwerk Pumpen')).toBeVisible();
  await expect(result.getByText('已显示 2 家，共 502 家')).toBeVisible();
  await expect(result.getByText(/部分完成/)).toBeVisible();
  const rows = result.locator('[data-gs="run-result-row"]');
  await expect(rows.filter({ hasText: 'Nordwerk Pumpen' }).getByText('0', { exact: true })).toBeVisible();
  await expect(rows.filter({ hasText: 'Rheintal Fluidtechnik' })).toContainText('暂无本轮评分');
  await expect(result.getByRole('link', { name: /查看线索/ })).toHaveCount(1);
  await expect(result.getByRole('link', { name: /查看线索/ })).toHaveAttribute('href', /\/leads\/this-run-lead/);
  await expect(result.locator('a[href*="other-run-lead"]')).toHaveCount(0);
  await expect(result.getByText('99', { exact: true })).toBeVisible();
  await expect(page.locator('[data-gs="run-stage"]').first()).not.toBeVisible();
  await page.getByRole('tab', { name: '寻源方案' }).click();
  await expect(page.locator('[data-gs="plan-market-scope"]')).toHaveText('奥地利');
  await expect(result).not.toBeVisible();

  await page.locator('aside a[href="/runs/run-2"]').click();
  await expect(page).toHaveURL(/\/runs\/run-2$/);
  await expect(result.getByText('本轮结果读取失败')).toBeVisible();
  await expect(result.getByText('Nordwerk Pumpen')).toHaveCount(0);
});

test('本轮结果读取失败与运行中暂无候选分别显示，重试只读取', async ({ page }) => {
  const backend = await installBuyerJourneyBackend(page);
  mockProfiles(backend);
  backend.set('GET', '/discovery-runs/run-1', { ...RUN, status: 'RUNNING' });
  backend.set('GET', '/discovery-runs/run-1/result-view', fail());
  await loginAs(page);
  await page.goto('/runs/run-1');

  const result = page.locator('[data-gs="run-result-view"]');
  await expect(result.getByText('本轮结果读取失败')).toBeVisible();
  backend.set('GET', '/discovery-runs/run-1/result-view', {
    candidates: { items: [], total: 0, truncated: false },
    icpId: PROFILE.id,
    runId: RUN.id,
    scoring: {
      latest: { items: [], label: 'latest_not_necessarily_this_run' },
      thisRun: { available: false, batches: 0, items: [], label: 'not_scored_in_run' },
    },
    status: 'RUNNING',
  });
  await result.getByRole('button', { name: '重试', exact: true }).click();
  await expect(result.getByText('寻源进行中，候选企业可用后会在这里显示')).toBeVisible();
  expect(backend.callsTo('POST', '/discovery-runs')).toHaveLength(0);
});

test('已有方案读取失败时保留错误态，钱包拒绝后保留原方案和钱包入口', async ({ page }) => {
  const backend = await installBuyerJourneyBackend(page);
  mockProfiles(backend);
  backend.set('GET', '/icps/profile-1/query-plans', fail());
  backend.set('GET', '/tasks', [{ ...TASK, runs: [] }]);
  let walletStatus = 402;
  const workspaceId = 'da5b9de4-fbe4-485b-9bce-ce88d2470e02';
  backend.set('POST', '/tasks/task-1/runs', async ({ route }) => {
    await route.fulfill({
      json: {
        error: walletStatus === 402 ? {
          code: 'INSUFFICIENT_CREDITS',
          details: { actionCode: 'DISCOVERY_EXECUTE', availableCredits: '1200', requiredCredits: '2500' },
          message: '积分不足：当前可用 1200 点，本次需预占 2500 点',
        } : {
          code: 'WALLET_FROZEN',
          message: `工作空间 ${workspaceId} 钱包已冻结`,
        },
      },
      status: walletStatus,
    });
    return true;
  });
  await loginAs(page);
  await page.goto('/tasks?icp=profile-1&tab=plan&plan=plan-1');
  const plans = page.locator('[data-gs="icp-plans"]');
  await expect(plans.getByText('寻源方案读取失败')).toBeVisible();
  await expect(plans.getByRole('button', { name: '制定寻源方案' })).toHaveCount(0);
  backend.set('GET', '/icps/profile-1/query-plans', [{ ...PLAN, status: 'READY' }]);
  await plans.getByRole('button', { name: '重试', exact: true }).click();
  await plans.getByRole('button', { name: '开始寻源', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '开始寻源', exact: true }).click();
  await expect(dialog.getByText('可用积分不足', { exact: true })).toBeVisible();
  await expect(dialog.getByText('当前可用 1,200 点，本次需预占 2,500 点。')).toBeVisible();
  await expect(dialog.getByRole('link', { name: '积分钱包' })).toHaveAttribute('href', '/settings/account#wallet');
  await expect(page).toHaveURL(/\/tasks\?icp=profile-1&tab=plan&plan=plan-1/);
  expect(backend.callsTo('POST', '/tasks/task-1/runs')).toHaveLength(1);

  walletStatus = 403;
  await dialog.getByRole('button', { name: '开始寻源', exact: true }).click();
  await expect(dialog.getByText('积分钱包已冻结', { exact: true })).toBeVisible();
  await expect(page.getByText(workspaceId)).toHaveCount(0);
});

test('读取权限和执行权限分离，未获执行权限时仍可查看方案和运行', async ({ page }) => {
  const backend = await installBuyerJourneyBackend(page);
  mockProfiles(backend);
  backend.set('GET', '/workspace/context', {
    allowedActions: [],
    onboarding: { companyId: COMPANY.id, complete: true },
    user: backend.session.user,
    workspace: backend.session.workspaces[0],
  });
  backend.set('GET', '/icps/profile-1/query-plans', [{ ...PLAN, status: 'READY' }]);
  backend.set('GET', '/discovery-runs/run-1', { ...RUN, status: 'RUNNING' });
  await loginAs(page);
  await page.goto('/tasks?icp=profile-1&tab=plan&plan=plan-1');
  await expect(page.locator('[data-gs="plan-market-scope"]')).toHaveText('奥地利');
  await expect(page.getByText('当前账号无法执行此操作')).toBeVisible();
  await expect(page.getByRole('button', { name: '开始寻源', exact: true })).toHaveCount(0);
  await page.goto('/runs/run-1?tab=progress');
  await expect(page.getByRole('tab', { name: '运行进度' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('当前账号无法执行此操作')).toBeVisible();
  await expect(page.getByRole('button', { name: '停止深挖' })).toHaveCount(0);
});

test('运行进度确认停止后，本轮已产出的候选仍可查看', async ({ page }) => {
  const backend = await installBuyerJourneyBackend(page);
  mockProfiles(backend);
  let status = 'RUNNING';
  backend.set('GET', '/discovery-runs/run-1', respond(() => ({ ...RUN, status })));
  backend.set('GET', '/discovery-runs/run-1/result-view', respond(() => ({
    candidates: {
      items: [{ companyId: 'c-1', country: 'DE', name: 'Nordwerk Pumpen', stage: 'quick_judged' }],
      total: 1,
      truncated: false,
    },
    icpId: PROFILE.id,
    runId: RUN.id,
    scoring: {
      latest: { items: [], label: 'latest_not_necessarily_this_run' },
      thisRun: { available: false, batches: 0, items: [], label: 'not_scored_in_run' },
    },
    status,
  })));
  backend.set('POST', '/discovery-runs/run-1/cancel', respond(() => ({
    runId: RUN.id,
    status: (status = 'CANCELLED'),
  })));
  await loginAs(page);
  await page.goto('/runs/run-1?tab=progress');
  await page.getByRole('button', { name: '停止深挖', exact: true }).click();
  expect(backend.callsTo('POST', '/discovery-runs/run-1/cancel')).toHaveLength(0);
  await page.getByRole('dialog').getByRole('button', { name: '停止深挖', exact: true }).click();
  await expect.poll(() => backend.callsTo('POST', '/discovery-runs/run-1/cancel').length).toBe(1);
  await expect(page.locator('[data-gs="run-head"]').getByText('已停止', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '本轮结果', exact: true }).click();
  const result = page.locator('[data-gs="run-result-view"]');
  await expect(result.getByText('Nordwerk Pumpen')).toBeVisible();
  await expect(result.getByText(/本轮已停止/)).toBeVisible();
});

test('新建画像的推荐展示真实 HS、统计年和进口量，手点加入才改变目标市场', async ({ page }) => {
  const backend = await installBuyerJourneyBackend(page);
  mockProfiles(backend);
  backend.set('GET', '/companies', [{ ...COMPANY, targetMarkets: ['DE', '德语区'] }]);
  backend.set('GET', '/companies/company-1/market-recommendations', MONTHLY_MARKET_BUNDLE);
  await loginAs(page);
  await page.goto('/find-buyers?action=create&companyId=company-1');

  const dialog = page.getByRole('dialog', { name: '设定买家画像' });
  const input = dialog.locator('[data-gs="icp-create-markets"]');
  const cards = dialog.locator('[data-gs="profile-comtrade-recommendations"]');
  await expect(input).toHaveValue('DE, 德语区');
  await expect(cards).toContainText('841381');
  await expect(cards).toContainText('2026 年 8 月');
  await expect(cards).toContainText('2025 年同月同比');
  await expect(cards).toContainText('覆盖 18 个可比市场');
  await expect(cards).toContainText('月进口额');
  await expect(cards).toContainText('$2.45B');
  await expect(cards).toContainText('18.4%');
  await expect(cards).toContainText('-2.5%');
  const italy = cards.locator('[data-gs="profile-comtrade-market-IT"]');
  await expect(italy).toHaveAttribute('aria-pressed', 'false');
  await expect(input).toHaveValue('DE, 德语区');

  await input.fill('de，德语区');
  await italy.click();
  await expect(input).toHaveValue('de，德语区, IT');
  await expect(italy).toHaveAttribute('aria-pressed', 'true');
  await cards.locator('[data-gs="profile-comtrade-add-all"]').click();
  await expect(input).toHaveValue('de，德语区, IT, NL');
  expect(backend.callsTo('POST', '/companies/company-1/icps')).toHaveLength(0);
});

test('切换画像所属企业后忽略迟到的旧企业推荐', async ({ page }) => {
  const backend = await installBuyerJourneyBackend(page);
  mockProfiles(backend);
  const other = { ...COMPANY, id: 'company-2', name: '海港设备' };
  backend.set('GET', '/companies', [COMPANY, other]);
  let release = () => {};
  let started = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  backend.set('GET', '/companies/company-1/market-recommendations', async ({ route }) => {
    started();
    await gate;
    await route.fulfill({ json: { data: MARKET_BUNDLE } });
    return true;
  });
  backend.set('GET', '/companies/company-2/market-recommendations', {
    ...MARKET_BUNDLE,
    companyId: other.id,
    recommendations: [{ ...MARKET_BUNDLE.recommendations[0], code: 'US', labelEn: 'United States', name: '美国' }],
  });
  await loginAs(page);
  try {
    await page.goto('/find-buyers?action=create&companyId=company-1');
    await requestStarted;
    const dialog = page.getByRole('dialog', { name: '设定买家画像' });
    await dialog.locator('.ant-select')
      .filter({ has: page.getByRole('combobox', { name: '引用哪份公司档案' }) })
      .locator('.ant-select-selector').click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: other.name }).click();
    const current = dialog.locator('[data-gs="profile-comtrade-market-US"], [data-gs="create-comtrade-US"]');
    await expect(current).toBeVisible();
    const late = page.waitForResponse((response) => response.url().includes('/companies/company-1/market-recommendations'));
    release();
    await (await late).finished();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(current).toBeVisible();
    await expect(dialog.locator('[data-gs="profile-comtrade-market-IT"], [data-gs="create-comtrade-IT"]')).toHaveCount(0);
  } finally {
    release();
  }
});
