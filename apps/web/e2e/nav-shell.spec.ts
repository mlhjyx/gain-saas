/**
 * M2 步 14-1 验收：六项导航可点、无死链；glossary 词表落地到导航与页面。
 *
 * 不需要 BFF：登录与页面数据用共享 mock 层（support/mock-backend）。
 * 运行：pnpm exec playwright test（先 pnpm build 生成 apps/web/dist）。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

/** 路由切换有 120-180ms 淡入过渡；断言与截图前等它结束。 */
async function settle(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForTimeout(600);
}

/**
 * 2026-11-22 UI 重设计：一级导航按业务分组（工作空间/获客/线索/活动/增长/设置）。
 * 路由仍是扁平的；分组只是 Vben 菜单数据的展示层。测试按“组 → 叶子”点击，
 * 并保留原断言：所有页面可达、无死链、无「周报」、战役计划不占一级导航。
 */
const NAV_GROUPS = [
  {
    group: '工作空间',
    items: [{ landmark: '.wk', name: '工作台', path: '/workspace' }],
  },
  {
    group: '获客',
    items: [
      { heading: '公司档案', landmark: '[data-gs="page-header"]', name: '公司档案', path: '/companies' },
      { heading: '找买家', landmark: '[data-gs="page-header"]', name: '找买家', path: '/find-buyers' },
    ],
  },
  {
    group: '线索',
    items: [{ heading: '买家线索', landmark: '[data-gs="page-header"]', name: '买家线索', path: '/leads' }],
  },
  {
    group: '活动',
    items: [{ landmark: '.gpc', name: '挖掘任务', path: '/tasks' }],
  },
  {
    group: '增长',
    items: [{ landmark: '.gr', name: '商机与触达', path: '/growth' }],
  },
] as const;

function groupLocator(
  page: import('@playwright/test').Page,
  group: string,
) {
  // Vben 的分组标题是 submenu 的 toggle，不是 menuitem；按可见文本定位。
  return page.locator('[data-sdr-nav]').getByText(group, { exact: true });
}

async function ensureLeafVisible(
  page: import('@playwright/test').Page,
  group: string,
  leaf: string,
): Promise<void> {
  const item = page.getByRole('menuitem', { name: leaf });
  if (await item.isVisible().catch(() => false)) return;
  await groupLocator(page, group).click();
  await page.waitForTimeout(200);
}

test('六项导航可点、无死链，周报已下线', async ({ page }, testInfo) => {
  await installMockBackend(page);
  await loginAs(page);
  await settle(page);
  await page.screenshot({ path: testInfo.outputPath('nav-workspace.png') });

  // pass3 B：顶栏（banner）不得出现任何菜单项；导航只存在于侧边栏。
  await expect(page.getByRole('banner').getByRole('menuitem')).toHaveCount(0);

  // 六个业务分组齐全；没有「周报」项；战役计划不占一级导航
  for (const group of NAV_GROUPS) {
    await expect(groupLocator(page, group.group)).toBeVisible();
  }
  // pass5：设置不再占导航分组（SDR 同款：底部「设置」打开设置弹窗）。
  await expect(
    page.locator('.sdr-section__label').filter({ hasText: '设置' }),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-sdr-nav]').getByRole('menuitem', { name: '成员与角色' }),
  ).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: '周报' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: '战役计划' })).toHaveCount(0);

  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      await ensureLeafVisible(page, group.group, item.name);
      await page.getByRole('menuitem', { name: item.name }).click();
      await page.waitForURL((url) => url.pathname === item.path);
      // 页面切换过渡期间新旧两页会同时在 DOM 里，[data-gs="page-header"] 会短暂出现两个。
      // 已迁移的页面断言它的一级标题（名称唯一，天然排掉旧页），其余页面类名本来就唯一。
      if ('heading' in item) {
        await expect(
          page.getByRole('heading', { level: 1, name: item.heading }),
        ).toBeVisible();
      } else {
        await expect(page.locator(item.landmark)).toBeVisible();
      }
    }
  }

  // 设置：底部入口打开设置弹窗（SDR SettingsShell），默认分区「成员与角色」。
  await page.locator('.sdr-footer__row', { hasText: '设置' }).click();
  await expect(page.locator('.gs-settings__panel')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: '成员与角色' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.gs-settings__panel')).toHaveCount(0);

  // 周报已下线：/reports 深链回 SPA 壳（无周报内容渲染）
  await page.goto('/reports');
  await page.waitForTimeout(1200);
  await expect(page.getByText('周报概览')).toHaveCount(0);
});

test('商机与触达：多 tab 内嵌真实页面、运行期语义与词表', async ({ page }, testInfo) => {
  await installMockBackend(page);
  await loginAs(page);
  await ensureLeafVisible(page, '增长', '商机与触达');
  await page.getByRole('menuitem', { name: '商机与触达' }).click();

  // 枢纽页头与运行期徽标（2026-11-10 起取消影子期：按授权执行）
  await settle(page);
  await expect(page.getByRole('heading', { level: 1, name: '商机与触达', exact: true })).toBeVisible();
  await expect(page.getByText('运行期 · 按授权执行')).toBeVisible();

  // 六个 tab：战役计划 / 商机 / 触达 / 回复 + 判定复核 / 度量（术语取自 glossary）
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveText(['战役计划', '商机', '触达', '回复', '判定复核', '度量']);

  // tab 1：内嵌真实战役计划列表（M2.1）——父页已给标题，内嵌页不再渲染自己的 H1（F0：双页头消除）
  await expect(page.getByRole('heading', { level: 1, name: '战役计划', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新建计划' }).first()).toBeVisible();
  await expect(page.getByText('还没有任何计划。先新建一个，再让系统起草。')).toBeVisible();
  await settle(page);
  await page.screenshot({ path: testInfo.outputPath('growth-campaigns.png') });

  // tab 2：内嵌真实商机管线（步 10）——空态引导回买家线索
  await tabs.nth(1).click();
  await page.waitForURL(/tab=opportunities/);
  await settle(page);
  await expect(page.getByRole('heading', { level: 1, name: '商机', exact: true })).toHaveCount(0);
  await expect(page.getByText('还没有商机')).toBeVisible();
  await expect(page.getByRole('link', { name: '去买家线索' })).toBeVisible();
  await settle(page);
  await page.screenshot({ path: testInfo.outputPath('growth-opportunities.png') });

  // tab 3：触达批次工作台（步 11-2）——空态与新建入口都是真页面自己的
  await tabs.nth(2).click();
  await page.waitForURL(/tab=outreach/);
  await settle(page);
  await expect(page.getByRole('heading', { level: 2, name: '触达批次', exact: true })).toHaveCount(0);
  await expect(page.getByText('还没有触达批次。新建一个批次，加入草稿后提交审批。')).toBeVisible();
  await settle(page);
  await page.screenshot({ path: testInfo.outputPath('growth-outreach.png') });

  // 主行动可点：新建批次展开表单
  await page.getByRole('button', { name: '新建批次' }).click();
  await expect(page.getByPlaceholder('例如：德国泵业首触')).toBeVisible();
});
