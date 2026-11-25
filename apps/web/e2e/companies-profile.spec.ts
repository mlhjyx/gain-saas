/**
 * 公司档案：主档案（注册公司）+ 关联公司 + 页内事实/资料库工作台。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const NOW = '2026-11-25T09:00:00.000Z';

const PRIMARY = {
  id: 'c1',
  name: 'Muster Metallbau GmbH',
  domain: 'muster-metallbau.de',
  website: 'https://muster-metallbau.de',
  status: 'REVIEW',
  industry: 'metalworking',
  created_at: NOW,
};

const RELATED = {
  id: 'c2',
  name: 'Nordlicht Handel AG',
  domain: 'nordlicht-handel.de',
  status: 'DRAFT',
  industry: 'wholesale',
  created_at: '2026-11-20T09:00:00.000Z',
};

test('公司档案：主档案、关联公司与页内工作台', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/workspace/context', {
    user: backend.session.user,
    workspace: { ...backend.session.workspaces[0], role: backend.session.workspace.role },
    onboarding: { complete: true, companyId: 'c1' },
    allowedActions: [],
  });
  backend.set('GET', '/companies', [PRIMARY, RELATED]);
  backend.set('GET', '/companies/c1', {
    ...PRIMARY,
    summary: '德国中型金属结构件制造商。',
  });
  backend.set('GET', '/companies/c2', RELATED);
  backend.set('GET', '/companies/c1/completeness', {
    approvedClaims: 1,
    conflictsOpen: 0,
    offerings: 2,
    pendingClaims: 1,
  });
  backend.set('GET', '/companies/c2/completeness', {
    approvedClaims: 0,
    conflictsOpen: 0,
    offerings: 0,
    pendingClaims: 0,
  });
  backend.set('GET', '/companies/c1/offerings', []);
  backend.set('GET', '/companies/c1/conflicts', []);
  backend.set('GET', '/companies/c1/claims', [
    {
      companyId: 'c1',
      createdAt: NOW,
      id: 'claim-1',
      statement: '通过 IATF 16949 认证',
      status: 'NEEDS_REVIEW',
      type: 'capability',
      version: 1,
    },
  ]);
  backend.set('GET', '/companies/c1/seller-documents', {
    data: [
      {
        chunkCount: 12,
        createdAt: NOW,
        filename: '公司介绍.pdf',
        id: 'doc-1',
        sizeBytes: 1024,
        status: 'ready',
      },
    ],
    page: { has_more: false },
  });

  await loginAs(page);
  await page.goto('/companies');

  // 注册公司是主档案，其他档案收在关联公司区
  const primary = page.locator('[data-gs="primary-company"]');
  await expect(primary.getByRole('heading', { name: 'Muster Metallbau GmbH' })).toBeVisible();
  await expect(primary).toContainText('注册公司');
  await expect(page.locator('[data-gs="related-company"]')).toHaveCount(1);
  await expect(page.getByText('Nordlicht Handel AG').first()).toBeVisible();

  // 事实工作台：页内可见，不再弹窗
  const workspace = page.locator('[data-gs="company-workspace"]');
  await expect(workspace).toBeVisible();
  await expect(page.locator('[data-gs="company-facts"]')).toContainText('通过 IATF 16949 认证');
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);

  // 资料库是同一工作台里的第二个视图
  await page
    .getByRole('group', { name: '企业事实与资料库视图' })
    .getByRole('button', { name: '资料库' })
    .click();
  await expect(page.locator('[data-gs="company-docs"]')).toContainText('公司介绍.pdf');
  await expect(page.getByRole('button', { name: '上传资料' })).toBeVisible();

  // 关联公司入口会切换工作台上下文，并允许返回主档案
  await page
    .locator('[data-gs="related-company"]')
    .getByRole('button', { name: '资料库' })
    .click();
  await expect(workspace).toContainText('Nordlicht Handel AG');
  await expect(workspace.getByRole('button', { name: '返回主档案' })).toBeVisible();
  await workspace.getByRole('button', { name: '返回主档案' }).click();
  await expect(workspace).toContainText('Muster Metallbau GmbH');

  // KPI 是事实工作台的快捷入口
  await primary.locator('.co-kpi').nth(1).click();
  await expect(page.locator('[data-gs="company-facts"]')).toBeVisible();
});
