/**
 * 语言切换回归（2026-11-22 用户实测 BUG）：
 * 切语言会整页重载（设计内——路由标题在模块加载时求值一次，审计 二-06），
 * 但 updatePreferences 的偏好持久化是 150ms debounce，旧实现立即 reload，
 * 页面在落盘前卸载 → 重载后语言回退（「刷新了但切换失败」）。
 * 修复：reload 延迟 300ms（先存后刷）。本用例钉住该行为。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

test('切语言：整页重载后语言保持为新选择', async ({ page }) => {
  await installMockBackend(page);
  await loginAs(page);
  await page.goto('/workspace');
  await expect(page.locator('.sdr-brandtools__lang')).toHaveText('中');
  await expect(page.locator('.sdr-section__label').first()).toHaveText(/总览|Overview/);

  // 记号用于确认确实发生了整页重载（重载后 window 是全新对象）。
  await page.evaluate(() => {
    (window as unknown as { __localeReloadMark?: boolean }).__localeReloadMark = true;
  });
  await page.getByRole('button', { name: '切换到 English' }).click();

  // 修复后的时序：toggle → 150ms 落盘 → 300ms reload。等重载完成并重新挂载。
  await page.waitForTimeout(3500);
  const reloaded = await page.evaluate(
    () =>
      !(
        window as unknown as { __localeReloadMark?: boolean }
      ).__localeReloadMark,
  );
  expect(reloaded, '应发生整页重载（语言切换的设计行为）').toBe(true);

  // 重载后从缓存恢复的仍是新语言——切换没有失败。
  await expect(page.locator('.sdr-brandtools__lang')).toHaveText('EN');
  await expect(
    page.getByRole('button', { name: 'Switch to Chinese' }),
  ).toBeVisible();

  // 切回中文同样成立。
  await page.getByRole('button', { name: 'Switch to Chinese' }).click();
  await page.waitForTimeout(3500);
  await expect(page.locator('.sdr-brandtools__lang')).toHaveText('中');
});
