/**
 * P5b-13：设置壳五个子页共用同一导航；审计页筛选/导出控件与空态可用。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

test('设置子导航切换审计页，筛选与导出控件可用', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/audit', { entries: [], nextCursor: null, total: 0 });
  await loginAs(page);

  await page.goto('/settings/members');
  await expect(page.getByRole('heading', { level: 1, name: '成员与角色' })).toBeVisible();

  const nav = page.locator('nav[aria-label="设置导航"]');
  await expect(nav.getByRole('link')).toHaveCount(5);

  await nav.getByRole('link', { name: '审计' }).click();
  await page.waitForURL((url) => url.pathname === '/settings/audit');

  await expect(page.getByRole('heading', { level: 1, name: '操作审计' })).toBeVisible();
  await expect(page.getByText('还没有审计记录')).toBeVisible();
  await expect(page.getByRole('button', { name: '导出 CSV' })).toBeVisible();
  await expect(page.getByLabel('动作')).toBeVisible();
});
