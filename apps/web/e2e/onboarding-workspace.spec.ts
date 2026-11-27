import { expect, test } from '@playwright/test';
import { allowSourcing } from './support/sourcing-fixtures';

import { installMockBackend, loginAs } from './support/mock-backend';

async function submitPassword(page: import('@playwright/test').Page) {
  await page.locator('input[type="password"]').fill('e2e-password-123');
  await page.locator('button.g-submit').click();
}

test('新管理员注册后直接进入工作台', async ({ page }) => {
  const backend = await installMockBackend(page, { onboardingComplete: false });
  await page.goto('/auth/register');
  await page.locator('input[type="text"]').first().fill('E2E 测试公司');
  await page.locator('input[type="email"]').fill('e2e@gainos.local');
  await submitPassword(page);

  await expect(page).toHaveURL(/\/workspace$/, { timeout: 10_000 });
  await expect(page.getByRole('heading', { name: '企业启航清单' })).toBeVisible({ timeout: 5000 });
  await expect(page.locator('[data-workspace-mode="setup"]')).toBeVisible();
  await expect(page.locator('.wk__hero')).not.toBeVisible();
  expect(backend.callsTo('POST', '/auth/register')).toHaveLength(1);
  expect(backend.callsTo('POST', '/auth/login')).toHaveLength(1);
});

test('受邀普通成员直接进入未完成建档的工作台', async ({ page }) => {
  const backend = await installMockBackend(page, {
    onboardingComplete: false,
    role: 'member',
  });
  await page.goto('/auth/register?invite=workspace-member-fixture');
  await submitPassword(page);

  await expect(page).toHaveURL(/\/workspace$/, { timeout: 10_000 });
  await expect(page.getByText('请联系管理员完成企业资料')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('[data-gs="setup-intake"]')).toHaveCount(0);
  await page.goto('/companies?tab=facts');
  await expect(page).toHaveURL(/\/companies\?tab=facts$/);
  const companyPage = page.locator('[data-gs="companies-empty"]');
  await expect(companyPage.getByText(/请联系管理员/)).toBeVisible();
  await expect(companyPage.getByRole('button', { name: '开始建档' })).toHaveCount(0);
  expect(backend.callsTo('POST', '/companies')).toHaveLength(0);
  expect(backend.callsTo('POST', '/auth/accept-invite')).toHaveLength(1);
  expect(backend.callsTo('POST', '/auth/login')).toHaveLength(0);
});

test('旧引导链接先登录，再保留启航清单入口', async ({ page }) => {
  await installMockBackend(page, { onboardingComplete: false });
  await page.goto('/onboarding');

  await expect(page).toHaveURL(/\/auth\/login\?redirect=/);
  const redirect = new URL(page.url()).searchParams.get('redirect');
  expect(decodeURIComponent(redirect ?? '')).toBe('/workspace?setup=1');
  await page.locator('input[type="email"]').fill('e2e@gainos.local');
  await submitPassword(page);
  await expect(page).toHaveURL(/\/workspace\?setup=1$/);

  await page.goto('/onboarding');
  await expect(page).toHaveURL(/\/workspace\?setup=1$/);
  await expect(page.getByRole('heading', { name: '企业启航清单' })).toBeFocused({ timeout: 5000 });
});

test('已有完成寻源的工作空间打开工作台，旧书签仍能查看清单', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/icps', [{ id: 'profile-1', name: '德国分销商', status: 'ACTIVE', companyId: 'company-e2e' }]);
  backend.set('GET', '/runs', [
    { icpId: 'profile-1', planId: 'plan-1', runId: 'current-run', startedAt: '2026-11-19T10:00:00Z' },
    { icpId: 'profile-1', planId: 'plan-1', runId: 'prior-run', startedAt: '2026-11-18T10:00:00Z' },
  ]);
  backend.set('GET', '/discovery-runs/current-run', { id: 'current-run', status: 'RUNNING', stats: {} });
  backend.set('GET', '/discovery-runs/prior-run', { id: 'prior-run', status: 'DONE', stats: {} });

  await loginAs(page);
  await expect(page.locator('[data-workspace-mode="dashboard"]')).toBeVisible({ timeout: 5000 });
  await expect.poll(() => backend.callsTo('GET', '/discovery-runs/prior-run').length).toBe(1);
  await expect(page.getByRole('heading', { name: '企业启航清单' })).toHaveCount(0);
  await page.goto('/onboarding');
  await expect(page.getByRole('heading', { name: '企业启航清单' })).toBeFocused();
  await expect(page.getByText('已完成首次寻源')).toBeVisible();
  await page.getByRole('button', { name: '收起启航清单' }).click();
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.getByRole('heading', { name: '企业启航清单' })).toHaveCount(0);
});

test('网站后台分析时用户已修改的行业和产品优先保留', async ({ page }) => {
  const backend = await installMockBackend(page, { onboardingComplete: false });
  const working = {
    companyId: 'company-e2e',
    failure: null,
    industry: { options: [], raw: null, suggested: null },
    markets: [],
    name: 'E2E 测试公司',
    pagesAnalyzed: 0,
    products: [],
    state: 'running',
    status: 'ENRICHING',
    website: 'https://example.org',
  };
  backend.set('POST', '/onboarding/preview', { started: true, preview: working });
  backend.set('GET', '/onboarding/preview', { started: true, preview: working });
  await loginAs(page);
  await page.locator('[data-gs="setup-website"]').fill('example.org');
  await page.locator('[data-gs="setup-start"]').click();
  await page.locator('[data-gs="custom-industry-input"]').fill('工业泵及阀门');
  const product = page.locator('[data-gs="setup-product-input"]');
  await product.fill('主打离心泵');
  await product.press('Enter');
  await expect(page.locator('[data-gs="setup-save"]')).toBeDisabled();
  backend.set('GET', '/onboarding/preview', {
    started: true,
    preview: {
      ...working,
      industry: {
        options: [{ code: '28', label: '机械设备制造' }],
        suggested: { code: '28', matched: true },
      },
      products: [{ name: '待选真空泵' }],
      state: 'ready',
      status: 'REVIEW',
    },
  });
  await expect(page.locator('[data-gs="setup-save"]')).toBeEnabled();
  await expect(page.locator('[data-gs="custom-industry-input"]')).toHaveValue('工业泵及阀门');
  await expect(page.getByRole('button', { name: '主打离心泵' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '待选真空泵' })).toHaveAttribute('aria-pressed', 'false');
  await page.locator('[data-gs="setup-save"]').click();
  await expect.poll(() => backend.callsTo('POST', '/onboarding/company')[0]?.body).toMatchObject({
    industry: '工业泵及阀门',
    products: ['主打离心泵'],
    targetMarkets: [],
  });
});

test('已有独立创建的主公司时，清单沿用同一份档案', async ({ page }) => {
  const backend = await installMockBackend(page, { onboardingComplete: false });
  backend.set('GET', '/companies', [
    { id: 'existing-company', industry: '工业泵', name: '既有企业档案', status: 'ACTIVE' },
  ]);
  backend.set('GET', '/companies/existing-company/completeness', { offerings: 1 });
  await loginAs(page);
  const setup = page.locator('[data-gs="workspace-setup"]');
  await expect(setup.getByRole('link', { name: '建立首个买家画像' })).toHaveAttribute(
    'href', '/find-buyers?action=create&companyId=existing-company',
  );
  await expect(setup.locator('[data-gs="setup-intake"]')).toHaveCount(0);
  expect(backend.callsTo('POST', '/onboarding/preview')).toHaveLength(0);
});

test('未完成建档的工作区仍可打开通知深链接', async ({ page }) => {
  await installMockBackend(page, { onboardingComplete: false });
  await loginAs(page);
  await page.goto('/workspace?panel=notifications');
  await expect(page.locator('#workspace-notifications')).toBeVisible();
  await expect(page.getByRole('heading', { name: '企业启航清单' })).toBeVisible();
});

test('买家画像缺公司时提供补资料入口，有公司时可就地补主营产品', async ({ page }) => {
  const backend = await installMockBackend(page, { onboardingComplete: false });
  allowSourcing(backend);
  await loginAs(page);
  await page.goto('/find-buyers?action=create');
  const modal = page.getByRole('dialog', { name: '设定买家画像' });
  await expect(modal.locator('[data-gs="profile-needs-company"]')).toBeVisible();
  await expect(modal.getByRole('button', { name: '生成初稿' })).toBeDisabled();
  await modal.getByRole('link', { name: '去启航清单补资料' }).click();
  await expect(page).toHaveURL(/\/workspace\?setup=1$/);
  await expect(page.getByRole('heading', { name: '企业启航清单' })).toBeFocused();

  const companyId = 'company-e2e';
  backend.set('GET', '/companies', [{ id: companyId, name: 'E2E 测试公司' }]);
  backend.set('GET', '/companies/' + companyId + '/offerings', []);
  backend.set('GET', '/companies/' + companyId + '/claims', [{ id: 'claim-1', status: 'APPROVED' }]);
  await page.goto('/find-buyers?action=create&companyId=company-e2e');
  await expect(modal.locator('[data-gs="profile-needs-product"]')).toBeVisible();
  await expect(modal.getByRole('button', { name: '生成初稿' })).toBeDisabled();
  await modal.locator('[data-gs="icp-create-products"]').fill('工业泵');
  await expect(modal.getByRole('button', { name: '生成初稿' })).toBeEnabled();

  backend.set('GET', '/companies/' + companyId + '/offerings', [
    { id: 'old-product', name: '旧产品', attributes: { selectedByUser: false } },
    { id: 'extracted-product', name: '新提取的产品' },
  ]);
  await page.reload();
  await expect(modal.getByText(/主营产品选择已被清空/)).toBeVisible();
  await modal.locator('[data-gs="icp-create-products"]').fill('工业泵');
  await expect(modal.getByRole('button', { name: '生成初稿' })).toBeDisabled();
});

test('替换画像后仍识别已结束且有结果的寻源', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/icps', [
    { id: 'current', companyId: 'company-e2e', name: '新画像', status: 'ACTIVE' },
    { id: 'retired', companyId: 'company-e2e', name: '旧画像', status: 'SUPERSEDED' },
  ]);
  backend.set('GET', '/runs', async ({ route, url }) => {
    const historical = url.searchParams.get('icpId') === 'retired';
    await route.fulfill({ json: { data: historical ? [
      { runId: 'prior', planId: 'prior-plan', icpId: 'retired', startedAt: '2026-11-24T10:00:00Z' },
    ] : [] } });
    return true;
  });
  backend.set('GET', '/discovery-runs/prior', { id: 'prior', status: 'PARTIAL' });
  backend.set('GET', '/discovery-runs/prior/result-view', { candidates: { total: 3 } });

  await loginAs(page);
  await expect.poll(() => backend.callsTo('GET', '/discovery-runs/prior/result-view').length).toBe(1);
  await expect(page.getByRole('heading', { name: '企业启航清单' })).toHaveCount(0);
  await page.goto('/onboarding');
  await expect(page.getByText('已完成首次寻源')).toBeVisible();
});

test('刷新后恢复纯画册识别并更新可确认的产品', async ({ page }) => {
  const backend = await installMockBackend(page, { onboardingComplete: false });
  const companyId = 'restored-company';
  const docId = 'restored-brochure';
  const document = { id: docId, filename: 'restored.pdf', status: 'queued' };
  const draft = {
    companyId, name: '画册示例企业', website: null, failure: null,
    status: 'DRAFT', state: 'not_started', pagesAnalyzed: 0,
    industry: { options: [], raw: null, suggested: null }, markets: [],
  };
  let ready = false;
  backend.set('GET', '/workspace/context', {
    workspace: backend.session.workspaces[0],
    user: backend.session.user,
    onboarding: { companyId, complete: false },
  });
  backend.set('GET', '/onboarding/preview', async ({ route }) => {
    await route.fulfill({ json: { data: { started: true, preview: {
      ...draft,
      products: ready ? [{ name: '画册识别出的泵' }] : [],
      documents: { items: [document] },
    } } } });
    return true;
  });
  backend.set('GET', '/seller-documents/' + docId, async ({ route }) => {
    await route.fulfill({ json: { data: ready ? {
      ...document, status: 'ready', parsedMeta: { mode: 'full', aiProductsCount: 1 },
    } : document } });
    return true;
  });

  await loginAs(page);
  await expect(page.locator('[data-gs="upload-queue-tray"]')).toContainText('restored.pdf');
  await page.reload();
  await expect(page.locator('[data-gs="upload-queue-tray"]')).toContainText('restored.pdf');
  ready = true;
  await expect(page.getByRole('button', { name: '画册识别出的泵' })).toBeVisible();
  expect(backend.callsTo('POST', '/onboarding/preview')).toHaveLength(0);
  expect(backend.callsTo('POST', '/companies/' + companyId + '/seller-documents/presign')).toHaveLength(0);
});

test('跨标签换账号后禁止从旧启航表单写入', async ({ context, page }) => {
  const backend = await installMockBackend(page, { onboardingComplete: false });
  await loginAs(page);
  await page.locator('[data-gs="setup-website"]').fill('example.org');
  await page.locator('[data-gs="setup-start"]').click();
  await expect(page.locator('[data-gs="setup-save"]')).toBeEnabled();

  const otherTab = await context.newPage();
  const replacement = await installMockBackend(otherTab);
  await otherTab.goto('/workspace');
  await otherTab.locator('[data-gs="account-trigger"]').click();
  await otherTab.getByRole('menuitem', { name: '退出登录' }).click();
  await expect(otherTab).toHaveURL(/\/auth\/login$/);
  await otherTab.locator('input[type="email"]').fill('another-account@example.test');
  await submitPassword(otherTab);
  await expect(otherTab).toHaveURL(/\/workspace$/);
  expect(replacement.callsTo('POST', '/auth/logout')).toHaveLength(1);
  expect(replacement.take('POST', '/auth/login')?.body).toMatchObject({
    email: 'another-account@example.test',
  });
  await otherTab.close();

  await expect(page.getByText(/登录状态已变化/)).toBeVisible();
  await expect(page.locator('[data-gs="setup-save"]')).toBeDisabled();
  await page.locator('[data-gs="back-to-start-btn"]').click();
  await expect(page.locator('[data-gs="setup-start"]')).toBeDisabled();
  expect(backend.callsTo('POST', '/onboarding/preview')).toHaveLength(1);
  expect(backend.callsTo('POST', '/onboarding/company')).toHaveLength(0);
});
