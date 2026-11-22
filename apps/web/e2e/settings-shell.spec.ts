/**
 * P5b-13：设置五页（2026-11-22 pass5 改造）。
 *
 * SDR 同款信息架构：设置不再占侧栏分组，底部「设置」打开设置弹窗
 * （左分区导航 + 右侧真实页面）。直接访问 /settings/* 仍是整页——
 * 深链、命令面板与旧链接不变。本用例钉住两条路径与审计页控件可用。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const SECTIONS = ['成员与角色', '禁联名单', '数据源', '数据与隐私', '审计'];

test('设置弹窗：五个分区切换，审计页筛选与导出控件可用', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/audit', { entries: [], nextCursor: null, total: 0 });
  await loginAs(page);
  await page.goto('/workspace');
  await page.waitForTimeout(600);

  // 侧栏不再有设置分组；底部「设置」打开弹窗。
  await expect(
    page.locator('[data-sdr-nav]').getByRole('menuitem', { name: '审计' }),
  ).toHaveCount(0);
  await page.locator('.sdr-footer__row', { hasText: '设置' }).click();
  const panel = page.locator('.gs-settings__panel');
  await expect(panel).toBeVisible();

  // 五个分区齐全，默认「成员与角色」。
  for (const name of SECTIONS) {
    await expect(
      panel.locator('.gs-settings__row', { hasText: name }),
    ).toBeVisible();
  }
  await expect(
    page.getByRole('heading', { level: 1, name: '成员与角色' }),
  ).toBeVisible();

  // 切到审计：页面内容在弹窗内渲染，背景 URL 不变。
  await panel.locator('.gs-settings__row', { hasText: '审计' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: '操作审计' }),
  ).toBeVisible();
  await expect(page.getByText('还没有审计记录')).toBeVisible();
  await expect(page.getByRole('button', { name: '导出 CSV' })).toBeVisible();
  await expect(page.getByLabel('动作')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/workspace');

  // Esc 关闭，焦点回到触发点。
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  // 深链仍是整页：直接访问 /settings/members 不弹窗。
  await page.goto('/settings/members');
  await expect(
    page.getByRole('heading', { level: 1, name: '成员与角色' }),
  ).toBeVisible();
  await expect(page.locator('.gs-settings__panel')).toHaveCount(0);
});
