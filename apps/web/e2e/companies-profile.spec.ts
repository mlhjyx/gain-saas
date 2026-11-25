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

test('资料库流式下载（Content-Disposition + 错误提示）与分段提炼企业事实草稿', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/workspace/context', {
    user: backend.session.user,
    workspace: { ...backend.session.workspaces[0], role: backend.session.workspace.role },
    onboarding: { complete: true, companyId: 'c1' },
    allowedActions: [],
  });
  backend.set('GET', '/companies', [PRIMARY]);
  backend.set('GET', '/companies/c1', PRIMARY);
  backend.set('GET', '/companies/c1/completeness', {
    approvedClaims: 1,
    conflictsOpen: 0,
    offerings: 1,
    pendingClaims: 1,
  });
  backend.set('GET', '/companies/c1/offerings', []);
  backend.set('GET', '/companies/c1/conflicts', []);

  const claimsList = [
    {
      companyId: 'c1',
      createdAt: NOW,
      id: 'claim-1',
      statement: '通过 IATF 16949 认证',
      status: 'NEEDS_REVIEW',
      type: 'capability',
      version: 1,
    },
  ];
  backend.set('GET', '/companies/c1/claims', async ({ route }) => {
    await route.fulfill({
      body: JSON.stringify({ data: claimsList }),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  });
  backend.set('GET', '/companies/c1/seller-documents', {
    data: [
      {
        chunkCount: 3,
        createdAt: NOW,
        filename: '公司介绍.pdf',
        id: 'doc-1',
        sizeBytes: 2048,
        status: 'ready',
      },
      {
        chunkCount: 2,
        createdAt: NOW,
        filename: '质检报告.pdf',
        id: 'doc-err',
        sizeBytes: 1024,
        status: 'ready',
      },
    ],
    page: { has_more: false },
  });

  // 1) 流式下载成功：Content-Disposition UTF-8 文件名 + 字节内容
  backend.set('GET', '/seller-documents/doc-1/content', async ({ route }) => {
    await route.fulfill({
      body: Buffer.from('%PDF-1.4\nmock-brochure-bytes'),
      headers: {
        'Cache-Control': 'no-store',
        'Content-Disposition':
          "attachment; filename=\"company.pdf\"; filename*=UTF-8''%E5%85%AC%E5%8F%B8%E4%BB%8B%E7%BB%8D-%E6%9C%80%E6%96%B0.pdf",
        'Content-Type': 'application/pdf',
        'X-Content-Type-Options': 'nosniff',
      },
      status: 200,
    });
    return true;
  });

  // 2) 流式下载 409 错误映射
  backend.set('GET', '/seller-documents/doc-err/content', async ({ route }) => {
    await route.fulfill({
      body: JSON.stringify({
        error: {
          code: 'SELLER_DOCUMENT_NOT_READY',
          userCopy: {
            next: '等待状态变为「已就绪」后再下载',
            title: '资料尚未处理完成，暂时不能下载',
            why: '这份资料仍在解析中。',
          },
        },
      }),
      contentType: 'application/json',
      status: 409,
    });
    return true;
  });

  // 3) 分段读取 → 预览校验 → 保存草稿
  backend.set('GET', '/companies/c1/seller-documents/doc-1/chunks/0', {
    chunkSeq: 0,
    chunkTextHash: 'hash-chunk-0',
    context: { page: 2 },
    documentContentHash: 'hash-doc-1',
    documentId: 'doc-1',
    parseRevision: 1,
    text: '公司拥有 12 台五轴加工中心，并于 2025 年通过 ISO 13485 医疗器械质量体系认证。',
  });
  backend.set('POST', '/companies/c1/seller-documents/doc-1/claim-previews', async ({ body, route }) => {
    const req = body as { reference: { quoteStartByte: number; quoteEndByte: number }; statement: string; type: string };
    await route.fulfill({
      body: JSON.stringify({
        data: {
          bindingHash: 'bind-1',
          chunkSeq: 0,
          context: { page: 2 },
          documentContentHash: 'hash-doc-1',
          documentId: 'doc-1',
          parseRevision: 1,
          quote: '通过 ISO 13485 医疗器械质量体系认证',
          quoteDigest: 'qd-1',
          quoteEndByte: req.reference.quoteEndByte,
          quoteStartByte: req.reference.quoteStartByte,
          requestDigest: 'req-digest-xyz',
          statementDigest: 'sd-1',
        },
      }),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  });
  backend.set('POST', '/companies/c1/seller-documents/doc-1/claim-drafts', async ({ body, route }) => {
    const req = body as { statement: string; type: string };
    claimsList.unshift({
      companyId: 'c1',
      createdAt: NOW,
      id: 'claim-doc-new',
      statement: req.statement,
      status: 'NEEDS_REVIEW',
      type: req.type,
      version: 1,
    });
    await route.fulfill({
      body: JSON.stringify({
        data: {
          available: true,
          bindingHash: 'bind-1',
          claimId: 'claim-doc-new',
          claimVersion: 1,
          evidenceId: 'ev-1',
          referenceId: 'ref-1',
          replayed: false,
          status: 'NEEDS_REVIEW',
        },
      }),
      contentType: 'application/json',
      status: 201,
    });
    return true;
  });

  await loginAs(page);
  await page.goto('/companies');
  await page
    .getByRole('group', { name: '企业事实与资料库视图' })
    .getByRole('button', { name: '资料库' })
    .click();

  const docRows = page.locator('.co-docs__list li');
  await expect(docRows).toHaveCount(2);

  // 下载 doc-1（不走 /download-url）
  const downloadPromise = page.waitForEvent('download');
  await docRows.nth(0).getByRole('button', { name: '下载' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('公司介绍-最新.pdf');
  expect(backend.callsTo('GET', '/seller-documents/doc-1/content').length).toBe(1);
  expect(backend.callsTo('GET', '/seller-documents/doc-1/download-url').length).toBe(0);

  // 下载 doc-err 展示 409 三层错误文案
  await docRows.nth(1).getByRole('button', { name: '下载' }).click();
  await expect(page.locator('[data-gs="company-docs"]')).toContainText('资料尚未处理完成，暂时不能下载');

  // 提炼事实流程
  await docRows.nth(0).getByRole('button', { name: '提炼事实' }).click();
  const modal = page.locator('[data-gs="doc-claim-modal"]');
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('公司拥有 12 台五轴加工中心');
  await expect(modal).toContainText('第 2 页');

  await modal.locator('[data-gs="doc-claim-quote"]').fill('通过 ISO 13485 医疗器械质量体系认证');
  await modal.locator('[data-gs="doc-claim-statement"]').fill('已通过 ISO 13485 医疗器械质量体系认证');
  await modal.locator('[data-gs="doc-claim-preview-btn"]').click();
  await expect(modal.locator('[data-gs="doc-claim-preview"]')).toBeVisible();
  await expect(modal.locator('[data-gs="doc-claim-preview"]')).toContainText('通过 ISO 13485 医疗器械质量体系认证');

  await modal.locator('[data-gs="doc-claim-save-btn"]').click();
  await expect(modal).toBeHidden();

  const previewCall = backend.take('POST', '/companies/c1/seller-documents/doc-1/claim-previews');
  const draftCall = backend.take('POST', '/companies/c1/seller-documents/doc-1/claim-drafts');
  expect(previewCall?.body).toMatchObject({
    reference: {
      chunkSeq: 0,
      chunkTextHash: 'hash-chunk-0',
      documentContentHash: 'hash-doc-1',
      documentId: 'doc-1',
      parseRevision: 1,
    },
    statement: '已通过 ISO 13485 医疗器械质量体系认证',
  });
  expect((previewCall?.body as { reference: { quoteStartByte: number; quoteEndByte: number } }).reference.quoteEndByte)
    .toBeGreaterThan((previewCall?.body as { reference: { quoteStartByte: number } }).reference.quoteStartByte);
  expect(draftCall?.body).toMatchObject({ requestDigest: 'req-digest-xyz' });

  // 切回企业事实验证列表已刷新
  await page
    .getByRole('group', { name: '企业事实与资料库视图' })
    .getByRole('button', { name: '企业事实' })
    .click();
  await expect(page.locator('[data-gs="company-facts"]')).toContainText('已通过 ISO 13485 医疗器械质量体系认证');
});
