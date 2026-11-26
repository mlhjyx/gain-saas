/**
 * Wave B3：设置整页单轨容器（退役 SettingsDialog 双轨弹窗）。
 *
 * 侧栏底部「设置」直达 /settings/account，页面左侧为 SettingsShell 分组子导航，
 * 右侧为对应设置内容区；admin 可见 7 个子页（含发信邮箱），审计页筛选与导出控件可用。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const ADMIN_SECTIONS = [
  '账号与空间',
  '成员与角色',
  '禁联名单',
  '数据来源',
  '隐私与数据',
  '审计日志',
  '发信邮箱',
];

test('整页设置单轨：侧栏直达 /settings/account、七分区切换、审计页筛选与导出控件可用', async ({
  page,
}) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/audit', { entries: [], nextCursor: null, total: 0 });
  await loginAs(page);
  await page.goto('/workspace');
  await page.waitForTimeout(400);

  // 主侧栏不展开设置子页；底部「设置」直达整页 /settings/account（无 SettingsDialog 弹窗）。
  await expect(
    page.locator('[data-sdr-nav]').getByRole('menuitem', { name: '审计' }),
  ).toHaveCount(0);
  await page.locator('.sdr-footer__row', { hasText: '设置' }).click();
  await page.waitForURL((url) => url.pathname === '/settings/account');
  await expect(page.locator('.gs-settings__panel')).toHaveCount(0);

  const subnav = page.locator('[data-gs="settings-subnav"]');
  await expect(subnav).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: '账号与空间' })).toBeVisible();

  // 七个分区齐全（含发信邮箱）。
  for (const name of ADMIN_SECTIONS) {
    await expect(
      subnav.locator('[data-gs="settings-nav-item"]', { hasText: name }),
    ).toBeVisible();
  }

  // 切到审计日志：整页路由切换至 /settings/audit，筛选与导出控件可用。
  await subnav.locator('[data-gs="settings-nav-item"]', { hasText: '审计日志' }).click();
  await page.waitForURL((url) => url.pathname === '/settings/audit');
  await expect(page.getByRole('heading', { level: 1, name: '操作审计' })).toBeVisible();
  await expect(page.getByText('还没有审计记录')).toBeVisible();
  await expect(page.getByRole('button', { name: '导出 CSV' })).toBeVisible();
  await expect(page.getByLabel('动作')).toBeVisible();

  // 深链直达 /settings/members 同样在整页壳层内，无弹窗。
  await page.goto('/settings/members');
  await expect(page.getByRole('heading', { level: 1, name: '成员与角色' })).toBeVisible();
  await expect(page.locator('[data-gs="settings-shell"]')).toBeVisible();
  await expect(page.locator('.gs-settings__panel')).toHaveCount(0);
});
