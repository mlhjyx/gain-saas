/**
 * Wave B3 + PR-UI1 零刷新双语热切换回归：
 * 彻底移除 window.location.reload()，通过账号菜单内 data-gs="locale-toggle" 切换中英文时，
 * 侧栏分组、菜单项与 48px 顶栏面包屑实时变语种、不重载页面（reloaded === false），
 * 且偏好落盘后手动刷新仍保持新选择。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

test('切语言：账号菜单零刷新即时热切换（侧栏 + 48px 面包屑），且持久化在手动刷新后保持', async ({
  page,
}) => {
  await installMockBackend(page);
  await loginAs(page);
  await page.goto('/workspace');
  await expect(page.locator('.sdr-section__label').first()).toHaveText('获客主线');
  await expect(page.locator("[data-gs='topbar-breadcrumb']")).toHaveText('工作台');

  // 打开账号菜单检查当前语言标记
  await page.locator("[data-gs='account-trigger']").click();
  await expect(page.locator("[data-gs='locale-indicator']")).toHaveText('中');

  // 记号用于确认没有发生整页重载
  await page.evaluate(() => {
    (window as unknown as { __localeReloadMark?: boolean }).__localeReloadMark = true;
  });
  await page.locator("[data-gs='locale-toggle']").click();

  await expect(page.locator("[data-gs='locale-indicator']")).toHaveText('EN');
  await expect(page.locator('.sdr-section__label').first()).toHaveText('Acquisition');
  await expect(page.locator("[data-gs='topbar-breadcrumb']")).toHaveText('Workspace');
  await expect(
    page.locator('[data-sdr-nav]').getByRole('menuitem', { name: 'Buyer profiles' }),
  ).toBeVisible();

  const reloaded = await page.evaluate(
    () =>
      !(window as unknown as { __localeReloadMark?: boolean }).__localeReloadMark,
  );
  expect(reloaded, 'Wave B3 切语言不得整页重载').toBe(false);

  // 等偏好防抖落盘后手动刷新一次，确认持久化有效
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.locator('.sdr-section__label').first()).toHaveText('Acquisition');
  await expect(page.locator("[data-gs='topbar-breadcrumb']")).toHaveText('Workspace');

  // 切回中文同样零刷新生效
  await page.evaluate(() => {
    (window as unknown as { __localeReloadMark?: boolean }).__localeReloadMark = true;
  });
  await page.locator("[data-gs='account-trigger']").click();
  await expect(page.locator("[data-gs='locale-indicator']")).toHaveText('EN');
  await page.locator("[data-gs='locale-toggle']").click();
  await expect(page.locator("[data-gs='locale-indicator']")).toHaveText('中');
  await expect(page.locator('.sdr-section__label').first()).toHaveText('获客主线');
  await expect(page.locator("[data-gs='topbar-breadcrumb']")).toHaveText('工作台');
  const reloadedBack = await page.evaluate(
    () =>
      !(window as unknown as { __localeReloadMark?: boolean }).__localeReloadMark,
  );
  expect(reloadedBack, '切回中文不得整页重载').toBe(false);
});
