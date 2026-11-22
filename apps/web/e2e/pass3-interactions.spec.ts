/**
 * pass3 C1/C5/C6 交互验收（自动化部分；人工点通录屏/截图另行留档）。
 *
 * - C1 命令面板：⌘K 唤起 → 模糊搜索 → 键盘上下 + 回车跳转到既有路由；
 *   动作项（如「去发现买家」）也在结果中。
 * - C5 今日建议 hero 卡：工作台最上方大卡 + 主 CTA「立即处理」+ 次链接。
 * - C6 行动清单完成反馈：完成 → 划线动画 → 归档（列表即时更新）+ toast。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

test('C1 命令面板：⌘K 搜索动作并回车跳转', async ({ page }) => {
  const backend = await installMockBackend(page);
  await loginAs(page);
  await page.goto('/workspace');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(400);

  // 顶栏触发按钮存在
  await expect(page.getByRole('button', { name: '搜索或跳转…' })).toBeVisible();

  // ⌘K / Ctrl+K 唤起
  await page.keyboard.press('Control+K');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // 模糊搜索动作
  const input = dialog.getByRole('combobox');
  await input.fill('发现买家');
  await expect(dialog.getByRole('option', { name: /去发现买家/ })).toBeVisible();

  // 键盘选择 + 回车跳转到既有路由
  await input.press('Enter');
  await page.waitForURL(/\/find-buyers/);
  await expect(dialog).toBeHidden();

  // Esc 关闭
  await page.keyboard.press('Control+K');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(backend.callsTo('GET', '/icps')).toBeTruthy();
});

test('C5 hero 卡 + C6 行动完成反馈', async ({ page }) => {
  await installMockBackend(page);
  await loginAs(page);
  await page.goto('/workspace');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(500);

  // C5：hero 大卡在最上方，含主 CTA 与次链接
  const hero = page.locator('.wk__hero');
  await expect(hero).toBeVisible();
  await expect(hero.getByRole('button', { name: /立即处理/ })).toBeVisible();
  await expect(hero.getByRole('link').first()).toBeVisible();

  // C6：行动清单有「完成」按钮；点击后划线 → 归档 → toast
  const done = page.getByRole('button', { name: /^完成：/ }).first();
  await expect(done).toBeVisible();
  const itemCount = await page.locator('.wk__action').count();
  await done.click();
  await expect(page.locator('.wk__action.is-completing').first()).toBeVisible();
  await expect(page.locator('.ant-message-notice')).toContainText('已完成');
  await page.waitForTimeout(600);
  const afterCount = await page.locator('.wk__action').count();
  expect(afterCount).toBe(itemCount - 1);

  // 归档视图可恢复
  await page.getByRole('button', { name: '已归档' }).click();
  await expect(page.getByRole('button', { name: '恢复' }).first()).toBeVisible();
});
