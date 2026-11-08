/**
 * QW16：顶栏「查看全部」落到独立通知页；空态与标题必须可读。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

test('通知页可达且空态可读', async ({ page }) => {
  await installMockBackend(page);
  await loginAs(page);

  await page.goto('/notifications');
  await expect(page.getByRole('heading', { level: 1, name: '通知' })).toBeVisible();
  await expect(page.getByText('暂时没有通知。新的进展会在这里提醒你。')).toBeVisible();
});
