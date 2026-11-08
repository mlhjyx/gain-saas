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

const TOP_NAV = [
  { landmark: '.wk', name: '工作台', path: '/workspace' },
  { landmark: '.cp', name: '公司档案', path: '/companies' },
  { landmark: '.fb', name: '找买家', path: '/find-buyers' },
  { landmark: '.ld', name: '买家线索', path: '/leads' },
  { landmark: '.gr', name: '商机与触达', path: '/growth' },
] as const;

test('六项导航可点、无死链，周报退出导航但路由保留', async ({ page }, testInfo) => {
  await installMockBackend(page);
  await loginAs(page);
  await settle(page);
  await page.screenshot({ path: testInfo.outputPath('nav-workspace.png') });

  // 六项一级导航齐全，且没有旧的「周报」项
  for (const item of TOP_NAV) {
    await expect(page.getByRole('menuitem', { name: item.name })).toBeVisible();
  }
  await expect(page.locator('.vben-menu').getByText('设置', { exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '周报' })).toHaveCount(0);
  // 战役计划收编在「商机与触达」入口内（D-14-a），不占一级导航
  await expect(page.getByRole('menuitem', { name: '战役计划' })).toHaveCount(0);

  for (const item of TOP_NAV) {
    await page.getByRole('menuitem', { name: item.name }).click();
    await page.waitForURL((url) => url.pathname === item.path);
    await expect(page.locator(item.landmark)).toBeVisible();
  }

  // 设置是含子项的分组：展开后进入「成员与角色」
  await page.locator('.vben-menu').getByText('设置', { exact: true }).click();
  await page.getByRole('menuitem', { name: '成员与角色' }).click();
  await page.waitForURL((url) => url.pathname === '/settings/members');
  await expect(page.locator('.mb')).toBeVisible();

  // 收编不等于删除：/reports 深链仍可达
  await page.goto('/reports');
  await page.waitForURL((url) => url.pathname === '/reports');
});

test('商机与触达：三 tab 内嵌真实页面、影子语义与词表', async ({ page }, testInfo) => {
  await installMockBackend(page);
  await loginAs(page);
  await page.getByRole('menuitem', { name: '商机与触达' }).click();

  // 枢纽页头与影子期徽标（全站统一的「将执行但不执行」语义）
  await settle(page);
  await expect(page.getByRole('heading', { level: 1, name: '商机与触达', exact: true })).toBeVisible();
  await expect(page.getByText('影子期 · 将执行但不执行')).toBeVisible();

  // 三 tab：战役计划 / 商机 / 触达（术语取自 glossary）
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveText(['战役计划', '商机', '触达']);

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
