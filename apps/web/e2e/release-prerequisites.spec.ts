/**
 * Isolated BFF-mock regressions for the release type fixes.
 * This is not a deployed-stack or customer-data acceptance test.
 */
import type { Page } from '@playwright/test';

import { expect, test } from '@playwright/test';

import { errorPayload, installMockBackend, loginAs } from './support/mock-backend';

const RUN_PATH = '/discovery-runs/run-test-123';
const RUN = {
  createdAt: '2026-11-21T00:00:00.000Z',
  icpId: 'icp-test-123',
  id: 'run-test-123',
  mode: 'quick',
  planId: 'plan-test-123',
  stats: {},
  status: 'DONE',
};

function observeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && /failed to (resolve|load).*module|error loading dynamically imported module/i.test(message.text())) {
      errors.push(message.text());
    }
  });
  return errors;
}

/**
 * 本地构建的接口地址带 /api 前缀（apps/web/.env.production，不进仓库），CI 没有这个文件、不带前缀。
 * 与 mock-backend 的去前缀规则保持一致，两种构建都能匹配。
 */
function isRunRecordResponse(response: { request(): { method(): string }; url(): string }): boolean {
  const path = new URL(response.url()).pathname;
  return (path === RUN_PATH || path === `/api${RUN_PATH}`) && response.request().method() === 'GET';
}

test('run identity waits for the delayed result and survives refresh', async ({ page }) => {
  const errors = observeErrors(page);
  const backend = await installMockBackend(page);
  let release = () => {};
  let requested = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requestStarted = new Promise<void>((resolve) => { requested = resolve; });
  let first = true;
  backend.set('GET', `${RUN_PATH}/jobs`, []);
  backend.set('GET', `${RUN_PATH}/events`, { events: [], nextAfter: 0, status: 'DONE' });
  backend.set('GET', '/runs/run-test-123/trace', { data: [], page: { has_more: false, next_cursor: null } });
  backend.set('GET', RUN_PATH, async ({ route }) => {
    const result = first ? RUN : { ...RUN, planId: 'plan-next-123' };
    if (first) {
      first = false;
      requested();
      await gate;
    }
    await route.fulfill({ body: JSON.stringify({ data: result }), contentType: 'application/json', status: 200 });
    return true;
  });
  await loginAs(page);
  try {
    await page.goto('/runs/run-test-123?tab=progress');
    await requestStarted;
    await expect(page.locator('.run .ant-skeleton')).toBeVisible();
    // 编号只在「技术详情：任务编号」里出现，运行记录到手前整块都不渲染。
    await expect(page.locator('.run__identity')).toHaveCount(0);
  } finally {
    release();
  }
  await page.getByText('技术详情与寻源过程', { exact: true }).click();
  const identity = page.locator('.run__identity');
  await expect(identity).toContainText('icp-test');
  await expect(identity).toContainText('plan-tes');
  await expect(identity).toContainText('run-test');
  // 页头不再展示内部编号。
  await expect(page.locator('.run__head')).not.toContainText('icp-test');
  const refreshed = page.waitForResponse(isRunRecordResponse);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  expect((await refreshed).ok()).toBe(true);
  await expect(identity).toContainText('plan-nex');
  expect(backend.calls.filter((call) => call.method === 'GET' && call.path === RUN_PATH)).toHaveLength(2);
  await expect(page.locator('.run [role="alert"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('initial run request failure displays the error without a render crash', async ({ page }) => {
  const errors = observeErrors(page);
  const backend = await installMockBackend(page);
  backend.set('GET', RUN_PATH, async ({ route }) => {
    await route.fulfill({
      body: JSON.stringify(errorPayload('TEST_FAILURE', { title: '测试请求失败' })),
      contentType: 'application/json',
      status: 503,
    });
    return true;
  });
  await loginAs(page);
  await page.goto('/runs/run-test-123');
  await expect(page.getByRole('heading', { name: '测试请求失败', exact: true })).toBeVisible();
  await expect(page.locator('.run__identity')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a null run result renders no identity values and does not crash', async ({ page }) => {
  const errors = observeErrors(page);
  const backend = await installMockBackend(page);
  backend.set('GET', RUN_PATH, null);
  await loginAs(page);
  const response = page.waitForResponse(isRunRecordResponse);
  await page.goto('/runs/run-test-123');
  expect((await response).ok()).toBe(true);
  await expect(page.locator('.run__identity')).toHaveCount(0);
  await expect(page.getByText('正在加载…', { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('workspace retains its empty KPI values and company navigation', async ({ page }) => {
  const errors = observeErrors(page);
  await installMockBackend(page);
  await loginAs(page);
  await page.locator('[data-gs="workspace-activity"] > summary').click();
  await expect(page.locator('.wk__kpi--companies .wk__kpi-value')).toHaveText('0');
  await expect(page.locator('.wk__kpi--run .wk__kpi-value')).toHaveText('尚未发起');
  await page.locator('.wk__kpi--companies').click();
  await expect(page).toHaveURL(/\/companies/);
  expect(errors).toEqual([]);
});

test('English workspace loads after changing the application language', async ({ page }) => {
  const errors = observeErrors(page);
  await installMockBackend(page);
  await page.goto('/auth/login');
  await page.getByRole('button', { name: 'Switch to English' }).click();
  await page.locator('input[type="email"]').fill('e2e@gainos.local');
  await page.locator('input[type="password"]').fill('e2e-password-123');
  await page.locator('button.g-submit').click();
  await page.waitForURL(/\/workspace/);
  await page.locator('[data-gs="workspace-activity"] > summary').click();
  await expect(page.locator('.wk__kpi--companies .wk__kpi-value')).toHaveText('0');
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await expect(page.locator('.wk__kpi--run .wk__kpi-value')).toHaveText('Not started');
  expect(errors).toEqual([]);
});
