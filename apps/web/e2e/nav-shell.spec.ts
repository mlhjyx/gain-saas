/**
 * M2 步 14-1 验收：六项导航可点、无死链；glossary 词表落地到导航与页面。
 *
 * 不需要 BFF：登录与页面数据用路由 mock（14-3 扩主链路时按设计 §5 打 `mock` 标签）。
 * 运行：pnpm exec playwright test（先 pnpm build 生成 apps/web/dist）。
 */
import type { Page } from '@playwright/test';

import { expect, test } from '@playwright/test';

const SESSION = {
  user: { email: 'e2e@gainos.local', id: 'user-e2e' },
  workspace: { id: 'ws-e2e', role: 'admin' },
  workspaces: [{ id: 'ws-e2e', name: 'E2E 测试公司', role: 'admin' }],
};

async function mockApi(page: Page): Promise<void> {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:4173') return route.continue();
    const path = url.pathname;
    const json = (data: unknown) =>
      route.fulfill({
        body: JSON.stringify({ data }),
        contentType: 'application/json',
        status: 200,
      });

    if (path === '/auth/login') return json({});
    if (path === '/auth/session') return json(SESSION);
    if (path === '/onboarding/status') return json({ complete: true });
    if (path === '/notifications') return json({ items: [], unreadCount: 0 });
    if (path === '/workspaces') return json(SESSION.workspaces);
    if (path === '/members') return json({ invites: [], members: [] });
    if (['/companies', '/discovery-runs', '/icps', '/leads'].includes(path)) return json([]);
    if (
      request.method() === 'GET' &&
      path !== '/' &&
      !path.startsWith('/assets/') &&
      !/\.(?:css|ico|js|json|map|png|svg|woff2?)$/.test(path)
    ) {
      return json(null);
    }
    return route.continue();
  });
}

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForURL(/\/auth\/login/);
  await page.locator('input[type="email"]').fill('e2e@gainos.local');
  await page.locator('input[type="password"]').fill('e2e-password-123');
  await page.locator('button.g-submit').click();
  await page.waitForURL(/\/workspace/);
  // 等登录成功通知消失、首屏淡入结束，截图与断言才拿到稳定画面
  await page.waitForTimeout(3800);
}

/** 路由切换有 120-180ms 淡入过渡；截图前等它结束。 */
async function settle(page: Page): Promise<void> {
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
  await mockApi(page);
  await login(page);
  await settle(page);
  await page.screenshot({ path: testInfo.outputPath('nav-workspace.png') });

  // 六项一级导航齐全，且没有旧的「周报」项
  for (const item of TOP_NAV) {
    await expect(page.getByRole('menuitem', { name: item.name })).toBeVisible();
  }
  await expect(page.locator('.vben-menu').getByText('设置', { exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '周报' })).toHaveCount(0);

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

test('商机与触达：三 tab 空壳、影子语义与词表', async ({ page }, testInfo) => {
  await mockApi(page);
  await login(page);
  await page.getByRole('menuitem', { name: '商机与触达' }).click();

  // 页头与影子期徽标（全站统一的「将执行但不执行」语义）
  await expect(page.getByRole('heading', { level: 1, name: '商机与触达' })).toBeVisible();
  await expect(page.getByText('影子期 · 将执行但不执行')).toBeVisible();

  // 三 tab：战役计划 / 商机 / 触达（术语取自 glossary）
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveText(['战役计划', '商机', '触达']);
  await settle(page);
  await page.screenshot({ path: testInfo.outputPath('growth-campaigns.png') });

  await tabs.nth(1).click();
  await page.waitForURL(/tab=opportunities/);
  await expect(page.getByRole('heading', { level: 2, name: '商机' })).toBeVisible();
  await settle(page);
  await page.screenshot({ path: testInfo.outputPath('growth-opportunities.png') });

  await tabs.nth(2).click();
  await page.waitForURL(/tab=outreach/);
  await expect(page.getByRole('heading', { level: 2, name: '触达' })).toBeVisible();
  await expect(page.getByText('发送通道开放前，系统不会发出任何邮件。')).toBeVisible();
  await settle(page);
  await page.screenshot({ path: testInfo.outputPath('growth-outreach.png') });

  // 主行动可点、死链路不存在
  await page.getByRole('button', { name: '去查看买家线索' }).click();
  await page.waitForURL((url) => url.pathname === '/leads');
});
