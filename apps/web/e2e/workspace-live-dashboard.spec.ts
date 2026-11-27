import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const startedAt = '2026-11-26T08:00:00.000Z';
const company = {
  id: 'industrial-company',
  name: '工业设备出口企业',
  status: 'ACTIVE',
};
const profile = {
  companyId: company.id,
  createdAt: startedAt,
  id: 'profile-industrial',
  name: '工业泵 · 德语区买家',
  status: 'ACTIVE',
};
const plan = {
  createdAt: startedAt,
  icpId: profile.id,
  id: 'plan-industrial',
  status: 'EXECUTED',
};
const run = {
  createdAt: startedAt,
  icpId: profile.id,
  id: 'run-industrial',
  planId: plan.id,
  stats: {},
  status: 'RUNNING',
};
const runningTask = {
  id: 'task-industrial',
  icpId: profile.id,
  name: profile.name,
  runCount: 1,
  runs: [{
    id: 'task-run-industrial',
    runId: run.id,
    startedAt,
    status: 'RUNNING',
  }],
  status: 'active',
};
const finishedTaskRun = {
  id: 'task-run-prior',
  runId: 'run-prior',
  startedAt: '2026-11-25T08:00:00.000Z',
  status: 'DONE',
};
const pending = {
  company: { country: 'DE', industry: '设备经销', name: 'Industrie Pumpen GmbH' },
  createdAt: startedAt,
  icpId: profile.id,
  id: 'lead-review',
  queue: 'needs_review',
  status: 'CONTACT_READY',
  totalScore: 92,
};
const recommended = {
  ...pending,
  company: { country: 'NL', name: 'Suggested Buyer BV' },
  id: 'lead-recommended',
  queue: 'recommended',
};
const queueCounts = {
  needs_review: 5,
  recommended: 7,
  rejected: 0,
  suppressed: 0,
  sanctions_hold: 0,
  scored: true,
  queueBasis: { fit_gate_preset: 0, score: 10, human_accept: 2, human_reject: 0 },
};
const wallet = {
  account: { availableCredits: '1260', heldCredits: '100', status: 'ACTIVE' },
  billingEnabled: true,
};

test('成熟工作区从旧启航链接回工作台，可进入寻源记录与积分钱包', async ({ page }, testInfo) => {
  const backend = await installMockBackend(page, { displayName: company.name, role: 'member' });
  backend.set('GET', '/companies', [company]);
  backend.set('GET', '/icps', [profile]);
  backend.set('GET', '/runs', [{
    icpId: profile.id,
    planId: plan.id,
    runId: run.id,
    startedAt,
  }]);
  backend.set('GET', '/icps/' + profile.id + '/query-plans', [plan]);
  backend.set('GET', '/icps/' + profile.id + '/lead-queues', queueCounts);
  backend.set('GET', '/leads', [
    pending,
    { ...pending, company: { country: 'DE', industry: '流体设备集成', name: 'Rheinwerk Fluidtechnik' }, id: 'lead-review-2', totalScore: 88 },
    { ...pending, company: { country: 'NL', industry: '工业部件进口', name: 'Delta Mech Supply' }, id: 'lead-review-3', totalScore: 84 },
    recommended,
  ]);
  backend.set('GET', '/tasks', [{
    ...runningTask,
    runCount: 2,
    runs: [...runningTask.runs, finishedTaskRun],
  }]);
  backend.set('GET', '/discovery-runs/' + run.id, run);
  backend.set('GET', '/discovery-runs/' + run.id + '/result-view', {
    candidates: { items: [], total: 0, truncated: false },
    icpId: profile.id,
    runId: run.id,
    scoring: {
      latest: { items: [], label: 'latest_not_necessarily_this_run' },
      thisRun: { available: false, batches: 0, items: [], label: 'not_scored_in_run' },
    },
    status: run.status,
  });
  backend.set('GET', '/wallet/summary', wallet);

  await loginAs(page);
  await expect(page.getByRole('heading', { level: 1, name: '先判断这批买家' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '企业启航清单' })).toHaveCount(0);
  await page.goto('/onboarding', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/workspace\?setup=1$/);
  await expect(page.getByRole('heading', { name: '企业启航清单' })).toBeFocused();
  await expect(page.getByText(/已完成首次寻源/)).toBeVisible();
  await page.getByRole('button', { name: '收起启航清单' }).click();
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.getByRole('heading', { name: '企业启航清单' })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: '先判断这批买家' })).toBeVisible();
  const summary = page.locator('[data-gs="workspace-summary"]');
  await expect(summary.locator('[data-gs="workspace-pending"]')).toContainText('5');
  await expect(summary.locator('[data-gs="workspace-accepted"]')).toContainText('2');
  await expect(summary.locator('[data-gs="workspace-running"]')).toContainText('1');
  await expect(summary.locator('[data-gs="workspace-wallet"]')).toContainText('1,260');
  const recent = page.locator('[data-gs="workspace-recent-review"]');
  await expect(recent.getByText(pending.company.name)).toBeVisible();
  await expect(recent.getByText(recommended.company.name)).toHaveCount(0);
  await expect(page.locator('[data-gs="workspace-current-run"]')).toContainText(profile.name);
  await expect(page.getByText('登录成功', { exact: true })).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('workspace-connected.png') });

  await expect.poll(() => backend.callsTo('GET', '/wallet/summary').length).toBeGreaterThan(0);
  await expect.poll(() => backend.callsTo('GET', '/tasks').length).toBeGreaterThan(0);

  await page.getByRole('button', { name: '开始判断' }).click();
  await expect(page).toHaveURL(/\/leads\?.*queue=needs_review/);
  await page.goto('/workspace');

  await page.getByRole('link', { name: '发起寻源' }).click();
  await expect(page).toHaveURL(/\/find-buyers(?:\?|$)/);
  await page.goto('/workspace');

  await recent.getByRole('link', { name: new RegExp(pending.company.name) }).click();
  await expect(page).toHaveURL(/\/leads\/lead-review(?:\?|$)/);
  await page.goto('/workspace');

  await page.getByRole('link', { name: '查看进度' }).click();
  await expect(page).toHaveURL(/\/runs\/run-industrial/);
  const recordsMenu = page.getByRole('menuitem', { name: '寻源记录', exact: true });
  await expect(recordsMenu).toHaveAttribute('aria-current', 'page');
  await recordsMenu.click();
  await expect(page).toHaveURL(/\/tasks$/);
  const records = page.locator('[data-gs="sourcing-workspace"]').filter({
    has: page.getByRole('link', { name: '寻源方案', exact: true }),
  });
  const currentRun = records.getByRole('complementary', { name: '最近运行' })
    .locator(`a[href="/runs/${run.id}"]`);
  await expect(currentRun).toContainText(profile.name);
  await expect(currentRun).toContainText('进行中');
  await currentRun.click();
  await expect(page).toHaveURL(`/runs/${run.id}`);
  await expect(page.locator('[data-gs="run-head"]').getByRole('heading', { name: profile.name, exact: true })).toBeVisible();
  await expect(page.locator('[data-gs="run-result-view"]')).toContainText('寻源进行中，候选企业可用后会在这里显示');
  await page.goto('/workspace');

  await summary.locator('[data-gs="workspace-accepted"]').click();
  await expect(page).toHaveURL(/\/leads\?.*status=QUALIFIED/);
  await page.goto('/workspace');

  await summary.locator('[data-gs="workspace-wallet"]').click();
  await expect(page).toHaveURL(/\/settings\/account#wallet$/);
  const walletSection = page.locator('#wallet[data-gs="account-wallet-section"]');
  await expect(walletSection.getByRole('heading', { name: '积分钱包摘要', exact: true })).toBeInViewport();
  await expect(page.locator('[data-gs="account-wallet-available"]')).toContainText('1,260');
  await page.goto('/workspace');
  await page.getByRole('menuitem', { name: '积分钱包' }).click();
  await expect(page).toHaveURL(/\/settings\/account#wallet$/);
  await expect(walletSection.getByRole('heading', { name: '积分钱包摘要', exact: true })).toBeInViewport();
});

test('钱包请求尚未返回时，待判断和寻源记录已可使用', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/companies', [company]);
  backend.set('GET', '/icps', [profile]);
  backend.set('GET', '/icps/' + profile.id + '/lead-queues', queueCounts);
  backend.set('GET', '/leads', [pending]);
  backend.set('GET', '/tasks', [runningTask]);
  let sendWallet: () => void = () => {};
  const waitingForWallet = new Promise<void>((resolve) => {
    sendWallet = resolve;
  });
  backend.set('GET', '/wallet/summary', async ({ route }) => {
    await waitingForWallet;
    await route.fulfill({ json: { data: wallet } });
    return true;
  });

  try {
    await loginAs(page);
    await expect.poll(() => backend.callsTo('GET', '/wallet/summary').length).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: '开始判断' })).toBeVisible();
    await expect(page.locator('[data-gs="workspace-running"]')).toContainText('1');
    await expect(page.locator('[data-gs="workspace-wallet"]')).toContainText('—');
    sendWallet();
    await expect(page.locator('[data-gs="workspace-wallet"]')).toContainText('1,260');
  } finally {
    sendWallet();
  }
});

test('有同一记录的任务状态已结束时，工作台显示任务终态', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/icps', [profile]);
  backend.set('GET', '/runs', [{ icpId: profile.id, planId: plan.id, runId: run.id, startedAt }]);
  backend.set('GET', '/discovery-runs/' + run.id, run);
  backend.set('GET', '/tasks', [{
    ...runningTask,
    runs: [{ ...runningTask.runs[0], status: 'DONE' }],
  }]);

  await loginAs(page);
  await expect(page.locator('[data-gs="workspace-running"] strong')).toHaveText('0');
  await expect(page.locator('[data-gs="workspace-current-run"]')).toContainText('已完成');
});

test('积分功能关闭时显示未启用，任务接口失败时不显示虚假的零轮运行', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/wallet/summary', { ...wallet, billingEnabled: false });
  backend.set('GET', '/tasks', async ({ route }) => {
    await route.fulfill({
      body: JSON.stringify({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'unavailable' } }),
      status: 502,
      contentType: 'application/json',
    });
    return true;
  });

  await loginAs(page);
  const summary = page.locator('[data-gs="workspace-summary"]');
  await expect(summary.locator('[data-gs="workspace-wallet"]')).toContainText('未启用');
  await expect(summary.locator('[data-gs="workspace-wallet"]')).not.toContainText('1,260');
  await expect(summary.locator('[data-gs="workspace-running"]')).toContainText('—');
  await expect(page.getByText('暂时无法读取寻源任务')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
});
