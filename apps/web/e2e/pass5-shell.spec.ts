/**
 * pass5 壳层验收（2026-11-22）：
 *  1) 顶部 = 标签页（Vben tabbar，[data-tab-item]）：导航留痕、点击切回；
 *  2) 侧栏底部 = 通知/设置/帮助 + 工作空间账号卡（AgentSDR 同款）；
 *  3) 折叠 rail 有展开入口（Vben 自带折叠按钮已关闭）；
 *  4) 移动端抽屉开关（顶栏隐藏后由 .sdr-mobile-burger 代理）。
 * 顶栏（banner）整体隐藏：导航只存在于侧栏，全局操作在侧栏品牌行与底部。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const settle = (page: import('@playwright/test').Page, ms = 600) =>
  page.waitForTimeout(ms);

test('顶部标签页：导航留痕、active 药丸、点击切回', async ({ page }) => {
  await installMockBackend(page);
  await loginAs(page);
  await page.goto('/workspace');
  await settle(page);

  // 首页只有一个标签；顶栏元素仍在 DOM（margin-top 滑出）但视口顶部
  // 属于标签栏——按命中测试断言，而非按存在性。
  await expect(page.locator('[data-tab-item]')).toHaveCount(1);
  const topHit = await page.evaluate(() => {
    const el = document.elementFromPoint(720, 10);
    return !!el?.closest("[data-layout-region='header'] section");
  });
  expect(topHit, '视口顶部应是标签栏').toBe(true);

  await page.goto('/find-buyers');
  await settle(page);
  await page.goto('/leads');
  await settle(page);
  await expect(page.locator('[data-tab-item]')).toHaveCount(3);

  // active 是灰底药丸 + 近黑文字（AgentSDR 规格，非蓝底蓝字）。
  const active = page.locator('[data-tab-item].is-active');
  await expect(active).toHaveText(/买家线索/);
  const styles = await active.evaluate((el) => {
    const cs = getComputedStyle(el);
    const span = el.querySelector('span');
    return {
      bg: cs.backgroundColor,
      color: cs.color,
      title: span ? getComputedStyle(span).color : '',
    };
  });
  expect(styles.bg).toBe('rgb(245, 245, 245)');
  expect(styles.color).toBe('rgb(23, 23, 23)');
  expect(styles.title).toBe('rgb(23, 23, 23)');

  // 点击第一个标签切回工作台（用户自由切换页签）。
  await page.locator('[data-tab-item]').first().click();
  await page.waitForURL((url) => url.pathname === '/workspace');
  await expect(page.locator('[data-tab-item].is-active')).toHaveText(/工作台/);

  // 关闭非当前标签：数量减一，且不影响所在页。
  await page.locator('[data-tab-item]').nth(1).locator('svg').first().click();
  await settle(page);
  await expect(page.locator('[data-tab-item]')).toHaveCount(2);
  await expect(page.locator('.wk')).toBeVisible();
});

test('侧栏底部：通知/设置/帮助行 + 账号卡菜单', async ({ page }) => {
  await installMockBackend(page);
  await loginAs(page);
  await page.goto('/workspace');
  await settle(page);

  // 底部三行 + 账号卡（工作空间名 + 账号）。
  const footer = page.locator('.sdr-footer');
  await expect(footer.getByText('通知', { exact: true })).toBeVisible();
  await expect(footer.getByText('设置', { exact: true })).toBeVisible();
  await expect(footer.getByText('帮助', { exact: true })).toBeVisible();
  await expect(footer.locator('.sdr-account__name')).toHaveText('E2E 测试公司');
  await expect(footer.locator('.sdr-account__email')).toHaveText(
    'e2e@gainos.local',
  );

  // 通知行直达通知页。
  await footer.getByText('通知', { exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/notifications');
  await settle(page);

  // 帮助弹层：快捷键说明 + 版本号（__APP_COMMIT__ 可能为空，断言 v 前缀）。
  await page.locator('.sdr-footer__row', { hasText: '帮助' }).click();
  await expect(page.locator('.sdr-help')).toBeVisible();
  await expect(page.locator('.sdr-help__version')).toHaveText(/^v[\d.]/);
  await page.keyboard.press('Escape');

  // 账号卡下拉：工作空间头 + 通知/设置/退出登录（不点退出，保持登录态）。
  await page.locator('.sdr-account').click();
  const menu = page.locator('.ant-dropdown-menu');
  await expect(menu.locator('li').filter({ hasText: 'E2E 测试公司' })).toBeVisible();
  await expect(
    menu.getByText('退出登录', { exact: true }),
  ).toBeVisible();
  await expect(menu.getByText('通知', { exact: true })).toBeVisible();
  await expect(menu.getByText('设置', { exact: true })).toBeVisible();
});

test('折叠 rail：品牌行折叠 → 展开入口回到完整侧栏', async ({ page }) => {
  await installMockBackend(page);
  await loginAs(page);
  await page.goto('/workspace');
  await settle(page);

  await page.getByRole('button', { name: '切换侧边栏' }).click();
  await settle(page);
  await expect(page.locator('.sdr-rail')).toBeVisible();
  await expect(page.locator('.sdr-nav')).toBeHidden();

  // rail 宽度 = Vben collapseWidth（60px），不覆盖内容区。
  const width = await page.locator('.sdr-rail').evaluate(
    (el) => Math.round(el.getBoundingClientRect().width),
  );
  expect(width).toBe(60);

  // rail 内仍可导航（图标点击）。
  await page.locator('.sdr-rail__item', { hasText: '' }).nth(1).click();
  await settle(page, 400);

  // 展开入口（Vben 自带按钮已关闭）。
  await page.locator('.sdr-rail__expand').click();
  await settle(page);
  await expect(page.locator('.sdr-nav')).toBeVisible();
  await expect(page.locator('.sdr-rail')).toBeHidden();
});

test('移动端：burger 代理打开抽屉导航', async ({ browser }) => {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: 'zh-CN',
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  await installMockBackend(page);
  await loginAs(page);
  await page.goto('/workspace');
  await settle(page, 900);

  await page.locator('.sdr-mobile-burger').click();
  await settle(page, 400);
  // 抽屉里是 Vben 菜单（工作台可达）。
  await expect(page.getByRole('menuitem', { name: '工作台' })).toBeVisible();
  await ctx.close();
});
