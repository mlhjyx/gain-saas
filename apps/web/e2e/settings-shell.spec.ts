/**
 * P5b-13：设置五个子页共用主侧栏「设置」分组；审计页筛选/导出控件与空态可用。
 * 2026-11-22 UI 重设计：去掉设置页内部的重复二级导航，统一由主侧栏承担。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

test('设置子导航切换审计页，筛选与导出控件可用', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/audit', { entries: [], nextCursor: null, total: 0 });
  await loginAs(page);

  await page.goto('/settings/members');
  await expect(page.getByRole('heading', { level: 1, name: '成员与角色' })).toBeVisible();

  const menu = page.locator('.vben-menu');
  const auditItem = page.getByRole('menuitem', { name: '审计' });
  if (!(await auditItem.isVisible().catch(() => false))) {
    await menu.getByText('设置', { exact: true }).click();
    await page.waitForTimeout(200);
  }
  for (const name of ['成员与角色', '禁联名单', '数据源', '数据与隐私', '审计']) {
    await expect(page.getByRole('menuitem', { name })).toBeVisible();
  }

  await auditItem.click();
  await page.waitForURL((url) => url.pathname === '/settings/audit');

  await expect(page.getByRole('heading', { level: 1, name: '操作审计' })).toBeVisible();
  await expect(page.getByText('还没有审计记录')).toBeVisible();
  await expect(page.getByRole('button', { name: '导出 CSV' })).toBeVisible();
  await expect(page.getByLabel('动作')).toBeVisible();
});
