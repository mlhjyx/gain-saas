/**
 * 一企一空间（2026-11-21）：注册企业查重 + 引导。
 * 注册端点返回 409 COMPANY_WORKSPACE_EXISTS 时,注册页必须出现
 * 专属加入引导面板(企业名/日期 + 邀请指引),而不是泛泛的失败文案。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend } from './support/mock-backend';

const conflictBody = {
  error: {
    code: 'COMPANY_WORKSPACE_EXISTS',
    message: '该企业已开通工作空间,请通过邀请加入',
    userCopy: {
      title: '贵司已开通工作空间',
      why: '该企业已注册过工作空间。按「一企一空间」原则，同一企业只有一个工作空间，同事通过邀请加入，不再重复开通。',
      next: '请联系贵司管理员在「设置 → 成员」生成邀请链接；若这不是贵司的工作空间，请联系运营处理。',
    },
  },
  meta: { existingWorkspaceName: '宁波宏达机电有限公司', existingCreatedAt: '2026-10-28' },
};

test('注册重名企业 → 409 → 加入引导面板（企业名+日期+邀请指引）', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('POST', '/auth/register', async ({ route }) => {
    await route.fulfill({ body: JSON.stringify(conflictBody), contentType: 'application/json', status: 409 });
    return true;
  });

  await page.goto('/auth/register');
  await page.locator('input[type="text"]').first().fill('宁波宏达机电有限公司');
  await page.locator('input[type="email"]').fill('new-colleague@gainos.local');
  await page.locator('input[type="password"]').fill('e2e-password-123');
  await page.locator('button.g-submit').click();

  const panel = page.locator('.g-enterprise-exists');
  await expect(panel).toBeVisible();
  await expect(panel.getByText('贵司已开通工作空间')).toBeVisible();
  await expect(panel.getByText(/宁波宏达机电有限公司/)).toBeVisible();
  await expect(panel.getByText(/2026-10-28/)).toBeVisible();
  await expect(panel.getByText(/邀请链接/)).toBeVisible();
  // 引导里的「去登录」链接
  await expect(panel.getByRole('link', { name: /去登录/ })).toBeVisible();
  // 不应发生登录跳转,仍在注册页
  await expect(page).toHaveURL(/\/auth\/register/);
  // 通用失败文案不应出现(专属面板已覆盖)
  await expect(page.locator('.g-failure')).not.toBeVisible();
});

test('后缀"+1"式重名同样命中引导（服务端归一化包含判断,e2e 只验透传渲染）', async ({ page }) => {
  const backend = await installMockBackend(page);
  const suffixed = structuredClone(conflictBody) as typeof conflictBody;
  (suffixed.meta as { existingWorkspaceName: string }).existingWorkspaceName = '琏升科技股份有限公司';
  (suffixed.meta as { existingCreatedAt: string }).existingCreatedAt = '2026-11-08';
  backend.set('POST', '/auth/register', async ({ route }) => {
    await route.fulfill({ body: JSON.stringify(suffixed), contentType: 'application/json', status: 409 });
    return true;
  });

  await page.goto('/auth/register');
  await page.locator('input[type="text"]').first().fill('琏升科技股份有限公司1');
  await page.locator('input[type="email"]').fill('brand2@gainos.local');
  await page.locator('input[type="password"]').fill('e2e-password-123');
  await page.locator('button.g-submit').click();

  await expect(page.locator('.g-enterprise-exists')).toBeVisible();
  await expect(page.locator('.g-enterprise-exists')).toContainText('琏升科技股份有限公司');
});

test('全新企业注册成功 → 照常进入引导向导（查重不误伤）', async ({ page }) => {
  await installMockBackend(page, { onboardingComplete: false });
  await page.goto('/auth/register');
  await page.locator('input[type="text"]').first().fill('全新企业有限公司');
  await page.locator('input[type="email"]').fill('owner@gainos.local');
  await page.locator('input[type="password"]').fill('e2e-password-123');
  await page.locator('button.g-submit').click();
  await page.waitForURL(/\/onboarding/);
  await expect(page.getByRole('heading', { name: '完善公司档案' })).toBeVisible();
});
