import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const NOW = '2026-11-08T10:12:30.000Z';

test('pass2 cockpit actions: suggestion, alert go, read-only note', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/notifications', {
    items: [
      {
        createdAt: NOW,
        id: 'n1',
        link: '/leads',
        refId: 'lead-1',
        title: '新的买家线索',
        type: 'LeadQualified',
      },
    ],
    unreadCount: 1,
  });
  await loginAs(page);
  await page.goto('/workspace');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(500);

  const suggestion = page.getByRole('button', { name: '立即处理' });
  await expect(suggestion).toBeVisible();
  await suggestion.click();
  await page.waitForURL(/\/companies/);

  await page.goto('/workspace');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(500);
  const alertGo = page.getByRole('button', { name: /去处理/ });
  await expect(alertGo).toBeVisible();
  await alertGo.click();
  await page.waitForURL(/\/leads/);
  expect(backend.callsTo('POST', '/notifications/n1/read')).toHaveLength(1);

  await page.goto('/workspace');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(500);
  await expect(page.getByText('在目标页完成').first()).toBeVisible();
});
