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

  // active 是反白实心药丸（浅色：近黑底白字；深色：白底深字），一眼可辨；
  // 关闭符只在 hover/当前页出现（不可见时不可点）。
  const active = page.locator('[data-tab-item].is-active');
  await expect(active).toHaveText(/买家线索/);
  const styles = await active.evaluate((el) => {
    const cs = getComputedStyle(el);
    const span = el.querySelector('span[class*="flex-1"]');
    return {
      bg: cs.backgroundColor,
      border: cs.borderTopColor,
      color: cs.color,
      height: cs.height,
      title: span ? getComputedStyle(span).color : '',
      titleFont: span ? getComputedStyle(span).fontSize : '',
    };
  });
  expect(styles.bg).toBe('rgb(23, 23, 23)');
  expect(styles.color).toBe('rgb(255, 255, 255)');
  expect(styles.title).toBe('rgb(255, 255, 255)');
  expect(styles.height).toBe('30px');
  expect(styles.titleFont).toBe('13px');

  // 顶栏恒隐藏 + 侧栏常显；工具组只有「更多/刷新」——Vben 的
  // 「内容最大化」按钮会破坏 pass5 布局，已移除（2026-11-23 用户实测）。
  const tools = page.locator(
    "[data-layout-region='header'] section > div:last-child > *",
  );
  await expect(tools).toHaveCount(2);

  // 未选中 = 透明底 + muted 文字（与选中形成明确层级）。
  const inactive = page.locator('[data-tab-item]').first();
  const inactiveStyles = await inactive.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, color: cs.color };
  });
  expect(inactiveStyles.bg).toBe('rgba(0, 0, 0, 0)');
  expect(inactiveStyles.color).toBe('rgb(92, 92, 92)');

  // 标签条永不出现滚动条（溢出靠滚轮/拖动 + 两端渐隐提示）。
  const viewport = page.locator(
    "[data-layout-region='header'] [data-slot='scroll-area-viewport']",
  );
  expect(
    await viewport.evaluate((el) => getComputedStyle(el).scrollbarWidth),
  ).toBe('none');

  // 非当前标签：关闭符隐藏且不可点（防误关）。
  const inactiveClose = page
    .locator('[data-tab-item]')
    .first()
    .locator('.absolute');
  expect(await inactiveClose.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
  expect(
    await inactiveClose.evaluate((el) => getComputedStyle(el).pointerEvents),
  ).toBe('none');
  // hover 后浮出。
  await page.locator('[data-tab-item]').first().hover();
  await expect
    .poll(async () =>
      inactiveClose.evaluate((el) => getComputedStyle(el).opacity),
    )
    .toBe('1');

  // 点击第一个标签切回工作台（用户自由切换页签）。
  await page.locator('[data-tab-item]').first().click();
  await page.waitForURL((url) => url.pathname === '/workspace');
  await expect(page.locator('[data-tab-item].is-active')).toHaveText(/工作台/);

  // 关闭非当前标签：关闭符 hover 才出现（pass5 交互），先悬停再点 ×。
  const secondTab = page.locator('[data-tab-item]').nth(1);
  await secondTab.hover();
  await secondTab.locator('.absolute .lucide-x').click();
  await settle(page);
  await expect(page.locator('[data-tab-item]')).toHaveCount(2);
  await expect(page.locator('.wk')).toBeVisible();

  // 鼠标中键：按下不关、释放才关（浏览器标签习惯，2026-11-23 用户要求）。
  await page.getByRole('menuitem', { name: '公司档案' }).click();
  await page.waitForURL((url) => url.pathname === '/companies');
  await settle(page);
  await expect(page.locator('[data-tab-item]')).toHaveCount(3);
  const middleTab = page.locator('[data-tab-item]').nth(1);
  // 只有 mousedown（没有 auxclick）→ 不关闭。
  await middleTab.dispatchEvent('mousedown', { button: 1, bubbles: true });
  await settle(page, 300);
  await expect(page.locator('[data-tab-item]')).toHaveCount(3);
  // 完整中键点击（按下 + 释放）→ 关闭。
  await middleTab.click({ button: 'middle' });
  await settle(page, 400);
  await expect(page.locator('[data-tab-item]')).toHaveCount(2);
  await expect(page.locator('.cp')).toBeVisible();
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

  // 侧栏不再列设置子页；「设置」行打开设置弹窗（SDR 同款）。
  await expect(
    page.locator('[data-sdr-nav]').getByRole('menuitem', { name: '成员与角色' }),
  ).toHaveCount(0);
  await footer.getByText('设置', { exact: true }).click();
  await expect(page.locator('.gs-settings__panel')).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: '成员与角色' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.gs-settings__panel')).toHaveCount(0);

  // 通知行直达通知页。
  await footer.getByText('通知', { exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/notifications');
  await settle(page);

  // 帮助弹层：快捷键说明 + 版本号（__APP_COMMIT__ 可能为空，断言 v 前缀）。
  await page.locator('.sdr-footer__row', { hasText: '帮助' }).click();
  await expect(page.locator('.sdr-help')).toBeVisible();
  await expect(page.locator('.sdr-help__version')).toHaveText(/^v[\d.]/);
  await page.keyboard.press('Escape');

  // 账号菜单（SDR Dropdown 同款）：抬头 + 通知/设置/搜索或跳转 + 退出登录。
  await page.locator('.sdr-account').click();
  const menu = page.locator('.gs-account-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.gs-account-menu__name')).toHaveText('E2E 测试公司');
  await expect(menu.locator('.gs-account-menu__mail')).toHaveText('e2e@gainos.local');
  await expect(menu.getByRole('menuitem', { name: '通知' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '设置' })).toBeVisible();
  await expect(
    menu.getByRole('menuitem', { name: /搜索或跳转/ }),
  ).toBeVisible();
  await expect(
    menu.getByRole('menuitem', { name: '退出登录' }),
  ).toBeVisible();

  // 「搜索或跳转」直达命令面板；标签必须是译文，不能出现 gainos.menu.* 原文。
  await menu.getByRole('menuitem', { name: /搜索或跳转/ }).click();
  await expect(page.getByRole('dialog').filter({ has: page.locator('.cmdk__list') })).toBeVisible();
  await expect(page.locator('.cmdk__list')).toContainText('挖掘任务');
  await expect(page.locator('.cmdk__list')).toContainText('成员与角色');
  await expect(page.locator('.cmdk__list')).not.toContainText('gainos.menu.');
  await page.keyboard.press('Escape');
  await expect(page.locator('.cmdk__list')).toHaveCount(0);

  // 「设置」同样打开设置弹窗，遮罩带 SDR 同款模糊。
  await page.locator('.sdr-account').click();
  await menu.getByRole('menuitem', { name: '设置' }).click();
  await expect(page.locator('.gs-settings__panel')).toBeVisible();
  expect(
    await page
      .locator('.gs-settings')
      .evaluate((el) => getComputedStyle(el).backdropFilter),
  ).toContain('blur');
  await page.keyboard.press('Escape');
  await expect(page.locator('.gs-settings__panel')).toHaveCount(0);
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

test('侧栏拖拽有最小宽度：低于 224px 时拉回且品牌行不重叠', async ({ page }) => {
  // 预置一个被拖窄的缓存（Vben 允许拖到 60px，品牌行会叠在一起）。
  await page.addInitScript(
    ([key, value]) => {
      if (!window.localStorage.getItem('min-width-injected')) {
        window.localStorage.setItem(key!, value!);
        window.localStorage.setItem('min-width-injected', '1');
      }
    },
    [
      'vben-web-antd-5.8.0-prod-preferences',
      JSON.stringify({ value: { sidebar: { width: 150 } } }),
    ],
  );
  await installMockBackend(page);
  await loginAs(page);
  await page.goto('/workspace');
  await settle(page);

  const geo = await page.evaluate(() => {
    const aside = document.querySelector(
      "aside[data-layout-region='sidebar']",
    ) as HTMLElement;
    const tools = document.querySelector('.sdr-brandtools') as HTMLElement;
    const logoText = [
      ...document.querySelectorAll("aside[data-layout-region='sidebar'] *"),
    ].find(
      (el) => el.textContent?.trim() === 'GainOS' && el.children.length === 0,
    ) as HTMLElement | null;
    return {
      asideW: Math.round(aside.getBoundingClientRect().width),
      brandOverlap:
        logoText && tools
          ? tools.getBoundingClientRect().left <
            logoText.getBoundingClientRect().right
          : null,
    };
  });
  expect(geo.asideW).toBeGreaterThanOrEqual(224);
  expect(geo.brandOverlap, '品牌行 logo 与工具按钮不得重叠').toBe(false);
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
