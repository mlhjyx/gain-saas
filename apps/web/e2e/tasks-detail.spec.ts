/**
 * P5b-06 收尾：任务详情 /tasks/:taskId（历史运行 + 重试）。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const NOW = '2026-11-08T10:12:30.000Z';

const TASK = {
  id: 'task-1',
  icpId: 'icp-1',
  name: '德国五金进口商',
  status: 'active',
  createdBy: 'user-e2e',
  lastRunAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  runs: [
    {
      id: 'tr-2',
      runId: 'run-2',
      planId: 'plan-1',
      attempt: 2,
      trigger: 'manual',
      status: 'FAILED',
      startedAt: NOW,
      finishedAt: NOW,
    },
    {
      id: 'tr-1',
      runId: 'run-1',
      planId: 'plan-1',
      attempt: 1,
      trigger: 'schedule',
      status: 'PARTIAL',
      startedAt: NOW,
      finishedAt: NOW,
    },
  ],
};

test('任务详情：历史运行与重试', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/tasks', [TASK]);
  backend.set('POST', '/tasks/task-1/runs', { taskRunId: 'tr-3', runId: 'run-3', status: 'QUEUED' });

  await loginAs(page);
  await page.goto('/tasks/task-1');

  await expect(page.getByRole('heading', { level: 1, name: '德国五金进口商' })).toBeVisible();
  await expect(page.getByRole('link', { name: '查看运行' })).toHaveCount(2);
  await expect(page.getByRole('link', { name: '查看运行' }).first()).toHaveAttribute(
    'href',
    '/runs/run-2',
  );

  await page.getByRole('button', { name: '重试上次运行' }).click();
  await page.waitForURL((url) => url.pathname === '/runs/run-3');
  const retry = backend.take('POST', '/tasks/task-1/runs');
  expect(retry, '应提交任务级重试').toBeTruthy();
  expect((retry!.body as { planId?: string }).planId).toBe('plan-1');
});
