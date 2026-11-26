/**
 * PR-UI1 全局壳层验收（48px 极简面包屑顶栏 + 新版左侧展示目录 + 静态图标 + 折叠 rail + 移动端抽屉）：
 *  1) 彻底关闭顶部黑色多标签栏（[data-tab-item] 为 0），48px 顶栏呈现响应式面包屑 + 克制刷新按钮；
 *  2) 侧栏顶区 48px 企业头（[G] 公司名 + 折叠按钮）与顶栏底线平齐；
 *  3) 顶区高频核心项（工作台 / 通知 + 未读徽标）无多余分组标题；获客主线 4 项顺序准确；
 *  4) 底部收纳主流程进度芯片（主流程页显示）+ 设置 + 紧凑账号条（弹出主题/语言/帮助/退出）；
 *  5) 折叠 rail 60px 可导航可展开；侧栏拖拽最小宽度 220px 且品牌行零重叠；
 *  6) 移动端 48px 顶栏汉堡按钮打开与桌面一致的新版侧栏抽屉。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const settle = (page: import('@playwright/test').Page, ms = 400) =>
  page.waitForTimeout(ms);

test('48px 极简面包屑顶栏：关闭多标签栏、响应式面包屑（含详情与设置二级）与刷新按钮', async ({
  page,
}) => {
  await installMockBackend(page);
  await loginAs(page);
  await page.goto('/workspace');
  await expect(page.locator("[data-gs='sidebar-brand']")).toBeVisible();
  await expect(page.locator("[data-gs='topbar-breadcrumb']")).toBeVisible();
  await settle(page);

  // 彻底关闭顶部多标签栏，不再存在任何黑胶囊 [data-tab-item]
  await expect(page.locator('[data-tab-item]')).toHaveCount(0);

  // 48px 顶栏与侧栏顶区企业头严格平齐（误差 <= 1px），且刷新按钮靠右对齐
  const headerGeo = await page.evaluate(() => {
    const header = document.querySelector("[data-layout-region='header'] > header") as HTMLElement;
    const brand = document.querySelector("[data-gs='sidebar-brand']") as HTMLElement;
    const refresh = document.querySelector("[data-gs='topbar-refresh']") as HTMLElement;
    const hr = header.getBoundingClientRect();
    const br = brand.getBoundingClientRect();
    const rr = refresh.getBoundingClientRect();
    return {
      brandBottom: Math.round(br.bottom),
      brandHeight: Math.round(br.height),
      headerBottom: Math.round(hr.bottom),
      headerHeight: Math.round(hr.height),
      headerLeft: Math.round(hr.left),
      headerRight: Math.round(hr.right),
      headerWidth: Math.round(hr.width),
      refreshLeft: Math.round(rr.left),
      refreshRight: Math.round(rr.right),
    };
  });
  expect(headerGeo.headerHeight).toBe(48);
  expect(headerGeo.brandHeight).toBe(48);
  expect(Math.abs(headerGeo.headerBottom - headerGeo.brandBottom)).toBeLessThanOrEqual(1);
  expect(
    headerGeo.refreshLeft,
    '顶栏刷新按钮必须居于顶栏最右侧而非紧贴面包屑',
  ).toBeGreaterThan(headerGeo.headerLeft + headerGeo.headerWidth * 0.7);
  expect(headerGeo.headerRight - headerGeo.refreshRight).toBeLessThanOrEqual(28);

  // 面包屑随路由准确响应
  const crumb = page.locator("[data-gs='topbar-breadcrumb']");
  await expect(crumb).toHaveText('工作台');
  await expect(page.locator("[data-gs='topbar-refresh']")).toBeVisible();

  await page.goto('/leads');
  await expect(crumb).toHaveText('买家线索');

  await page.goto('/leads/lead-1');
  await expect(crumb).toContainText('买家线索');
  await expect(crumb).toContainText('线索档案包');
  await crumb.getByRole('link', { name: '买家线索' }).click();
  await page.waitForURL((url) => url.pathname === '/leads');

  await page.goto('/settings/account');
  await expect(crumb).toContainText('设置');
  await expect(crumb).toContainText('账号与空间');

  // 刷新按钮可正常触发且页面稳定
  await page.locator("[data-gs='topbar-refresh']").click();
  await expect(page.locator("[data-gs='settings-shell']")).toBeVisible();
});

test('新版侧栏结构：48px 企业头 + 顶区高频通知徽标 + 底部设置与账号弹出菜单（主题/语言/帮助/退出）', async ({
  page,
}) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/notifications', {
    items: [
      {
        createdAt: '2026-11-26T08:00:00.000Z',
        id: 'n1',
        link: '/leads',
        readAt: null,
        title: '新的买家线索',
        type: 'LeadQualified',
      },
      {
        createdAt: '2026-11-26T08:05:00.000Z',
        id: 'n2',
        link: '/leads',
        readAt: null,
        title: '寻源任务已完成',
        type: 'DiscoveryRunCompleted',
      },
    ],
    unreadCount: 2,
  });

  await loginAs(page);
  await page.goto('/workspace');
  await settle(page);

  // 顶区企业头展示工作空间名称 + 简洁折叠按钮（不再挤入月亮/中英文）
  await expect(page.locator("[data-gs='sidebar-workspace-name']")).toHaveText('E2E 测试公司');
  await expect(page.locator('.sdr-brandtools')).toHaveCount(0);

  // 静态打包图标首屏即显（0ms 同步 SVG，无缺失空图标）
  const svgStats = await page.locator('[data-sdr-nav] .sdr-row svg').evaluateAll((svgs) => ({
    count: svgs.length,
    visible: svgs.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width >= 14 && r.height >= 14;
    }).length,
  }));
  expect(svgStats.count).toBeGreaterThanOrEqual(6);
  expect(svgStats.visible).toBe(svgStats.count);

  // 通知在顶区高频位且展示紧凑未读数字徽标（保留 data-gs="nav-unread"）
  const notifyLink = page.locator('[data-sdr-nav]').getByRole('menuitem', { name: /通知/ });
  await expect(notifyLink).toBeVisible();
  await expect(notifyLink.locator("[data-gs='nav-unread']")).toHaveText('2');

  // 底部设置直达整页 /settings/account，无 SettingsDialog 弹窗
  const footer = page.locator('.sdr-footer');
  await expect(footer.locator("[data-gs='nav-settings']")).toHaveText('设置');
  await expect(footer.locator('.sdr-account__email')).toHaveText('e2e@gainos.local');
  await expect(
    page.locator('[data-sdr-nav]').getByRole('menuitem', { name: '成员与角色' }),
  ).toHaveCount(0);

  await footer.locator("[data-gs='nav-settings']").click();
  await page.waitForURL((url) => url.pathname === '/settings/account');
  await expect(page.locator('.gs-settings__panel')).toHaveCount(0);
  await expect(page.locator('[data-gs="settings-shell"]')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: '账号与空间' })).toBeVisible();

  // 顶区通知行直达通知页
  await notifyLink.click();
  await page.waitForURL((url) => url.pathname === '/notifications');
  await settle(page);

  // 账号弹出菜单：收纳外观主题、界面语言、搜索或跳转、快捷键与帮助、退出登录
  await page.locator("[data-gs='account-trigger']").click();
  const menu = page.locator("[data-gs='account-menu']");
  await expect(menu).toBeVisible();
  await expect(menu.locator('.gs-account-menu__name')).toHaveText('E2E 测试公司');
  await expect(menu.locator('.gs-account-menu__mail')).toHaveText('e2e@gainos.local');
  await expect(menu.locator("[data-gs='theme-toggle']")).toBeVisible();
  await expect(menu.locator("[data-gs='locale-toggle']")).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '设置' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /搜索或跳转/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '退出登录' })).toBeVisible();

  // 快捷键与帮助展开（含版本号）
  await menu.locator("[data-gs='account-help-toggle']").click();
  await expect(menu.locator("[data-gs='account-help-panel']")).toBeVisible();
  await expect(menu.locator('.sdr-help__version')).toHaveText(/^v[\d.]/);

  // 「搜索或跳转」直达命令面板；标签为真实译文
  await menu.getByRole('menuitem', { name: /搜索或跳转/ }).click();
  await expect(
    page.getByRole('dialog').filter({ has: page.locator('.cmdk__list') }),
  ).toBeVisible();
  await expect(page.locator('.cmdk__list')).toContainText('寻源记录');
  await expect(page.locator('.cmdk__list')).toContainText('成员与角色');
  await expect(page.locator('.cmdk__list')).not.toContainText('gainos.menu.');
  await page.keyboard.press('Escape');
  await expect(page.locator('.cmdk__list')).toHaveCount(0);

  // 账号菜单「设置」同样直达整页 /settings/account
  await page.locator("[data-gs='account-trigger']").click();
  await menu.getByRole('menuitem', { name: '设置' }).click();
  await page.waitForURL((url) => url.pathname === '/settings/account');
  await expect(page.locator('[data-gs="settings-shell"]')).toBeVisible();
  await expect(page.locator('.gs-settings__panel')).toHaveCount(0);
});

test('折叠 rail：顶区折叠按钮 → 60px 图标窄栏 → 展开回到完整侧栏', async ({ page }) => {
  await installMockBackend(page);
  await loginAs(page);
  await page.goto('/workspace');
  await settle(page);

  await page.locator("[data-gs='sidebar-collapse']").click();
  await settle(page);
  await expect(page.locator('.sdr-rail')).toBeVisible();
  await expect(page.locator('.sdr-nav')).toBeHidden();

  // rail 宽度 = Vben collapseWidth（60px），不覆盖内容区
  const width = await page
    .locator('.sdr-rail')
    .evaluate((el) => Math.round(el.getBoundingClientRect().width));
  expect(width).toBe(60);

  // rail 内仍可导航（点击通知或企业档案图标）
  await page.locator('.sdr-rail__item').nth(1).click();
  await settle(page, 300);

  // 展开入口回到完整侧栏
  await page.locator('.sdr-rail__expand').click();
  await settle(page);
  await expect(page.locator('.sdr-nav')).toBeVisible();
  await expect(page.locator('.sdr-rail')).toBeHidden();
});

test('侧栏拖拽最小宽度：低于 220px 自动拉回，顶区企业头与折叠键零重叠', async ({ page }) => {
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
  await expect(page.locator("aside[data-layout-region='sidebar']")).toBeVisible();
  await expect(page.locator("[data-gs='sidebar-brand']")).toBeVisible();

  const geo = await page.evaluate(() => {
    const aside = document.querySelector(
      "aside[data-layout-region='sidebar']",
    ) as HTMLElement;
    const nameEl = document.querySelector("[data-gs='sidebar-workspace-name']") as HTMLElement;
    const collapseBtn = document.querySelector("[data-gs='sidebar-collapse']") as HTMLElement;
    const name = nameEl.getBoundingClientRect();
    const collapse = collapseBtn.getBoundingClientRect();
    return {
      asideW: Math.round(aside.getBoundingClientRect().width),
      brandOverlap:
        collapse.left < name.right && name.left < collapse.right &&
        collapse.top < name.bottom && name.top < collapse.bottom,
    };
  });
  expect(geo.asideW).toBeGreaterThanOrEqual(220);
  expect(geo.brandOverlap, '企业名与折叠按钮不得重叠').toBe(false);
});

test('移动端：48px 顶栏汉堡按钮打开新版侧栏抽屉（导航 + 设置 + 账号菜单含主题/语言/退出）', async ({
  browser,
}) => {
  const ctx = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    locale: 'zh-CN',
    viewport: { height: 844, width: 390 },
  });
  const page = await ctx.newPage();
  await installMockBackend(page);
  await loginAs(page);
  await page.goto('/workspace');
  await settle(page, 700);

  const burger = page.locator('.sdr-mobile-burger');
  await expect(burger).toBeVisible();
  await expect(burger).toHaveAttribute('aria-expanded', 'false');
  await burger.click();
  await settle(page, 400);

  const drawer = page.locator("[data-gs='mobile-nav']");
  await expect(drawer).toBeVisible();
  await expect(burger).toHaveAttribute('aria-expanded', 'true');

  // 与桌面侧栏一致的新版目录项
  for (const name of ['工作台', '通知', '企业档案', '买家画像', '买家线索', '寻源记录', '设置']) {
    await expect(drawer.getByRole('menuitem', { name })).toBeVisible();
  }
  await expect(page.locator("aside[data-layout-region='sidebar']")).toHaveCount(0);

  // 账号条 → 菜单含深浅主题、中英热切与退出登录
  await drawer.locator("[data-gs='account-trigger']").click();
  const menu = page.locator("[data-gs='account-menu']");
  await expect(menu.locator("[data-gs='theme-toggle']")).toBeVisible();
  await expect(menu.locator("[data-gs='locale-toggle']")).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '退出登录' })).toBeVisible();

  // 关闭账号弹出层（不按 Escape 以免连带关闭 AntDV Drawer）并跳转买家画像，抽屉自动收起
  await drawer.locator("[data-gs='account-trigger']").click();
  await expect(menu).toBeHidden();
  await drawer.getByRole('menuitem', { name: '买家画像' }).click();
  await page.waitForURL(/\/find-buyers/);
  await expect(drawer).toBeHidden();
  await ctx.close();
});
