/**
 * Wave B3 零刷新双语热切换回归：
 * 彻底移除 window.location.reload()，切换中英文时侧栏分组、菜单项与顶部标签栏实时变语种、
 * 不重载页面（reloaded === false），且偏好落盘后手动刷新仍保持新选择。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

test('切语言：零刷新即时热切换，且持久化在手动刷新后保持', async ({ page }) => {
  await installMockBackend(page);
  await loginAs(page);
  await page.goto('/workspace');
  await expect(page.locator('.sdr-brandtools__lang')).toHaveText('中');
  await expect(page.locator('.sdr-section__label').first()).toHaveText('总览');

  // 记号用于确认没有发生整页重载。
  await page.evaluate(() => {
    (window as unknown as { __localeReloadMark?: boolean }).__localeReloadMark = true;
  });
  await page.getByRole('button', { name: '切换到 English' }).click();

  await expect(page.locator('.sdr-brandtools__lang')).toHaveText('EN');
  await expect(page.locator('.sdr-section__label').first()).toHaveText('Overview');
  await expect(
    page.locator('[data-sdr-nav]').getByRole('menuitem', { name: 'Buyer profiles' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Switch to Chinese' })).toBeVisible();

  const reloaded = await page.evaluate(
    () =>
      !(
        window as unknown as { __localeReloadMark?: boolean }
      ).__localeReloadMark,
  );
  expect(reloaded, 'Wave B3 切语言不得整页重载').toBe(false);

  // 等偏好防抖落盘后手动刷新一次，确认持久化有效。
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.locator('.sdr-brandtools__lang')).toHaveText('EN');
  await expect(page.locator('.sdr-section__label').first()).toHaveText('Overview');

  // 切回中文同样零刷新生效。
  await page.evaluate(() => {
    (window as unknown as { __localeReloadMark?: boolean }).__localeReloadMark = true;
  });
  await page.getByRole('button', { name: 'Switch to Chinese' }).click();
  await expect(page.locator('.sdr-brandtools__lang')).toHaveText('中');
  await expect(page.locator('.sdr-section__label').first()).toHaveText('总览');
  const reloadedBack = await page.evaluate(
    () =>
      !(
        window as unknown as { __localeReloadMark?: boolean }
      ).__localeReloadMark,
  );
  expect(reloadedBack, '切回中文不得整页重载').toBe(false);
});
