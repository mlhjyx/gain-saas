/**
 * MT-P1 PR 3 独立 E2E：
 * 1. /settings/privacy 管理员异步租户数据导出（筛选/翻页/创建/流式下载/限流提示）与 7 天离网注销（误填拦截/提交/撤回）
 * 2. /settings/privacy 普通成员只读门控（无导出发起、无离网按钮）
 * 3. /ops 工作空间跨库对账、存储配额调整与整空间物理清理回执
 */
import type { MockHandler } from './support/mock-backend';

import { expect, test } from '@playwright/test';

import { errorPayload, installMockBackend, loginAs } from './support/mock-backend';

const EXPORT_READY_ID = '11111111-aaaa-4aaa-8aaa-111111111111';
const EXPORT_PROC_ID = '22222222-bbbb-4bbb-8bbb-222222222222';
const EXPORT_NEW_ID = '33333333-cccc-4ccc-8ccc-333333333333';
const EXPORT_PAGE2_ID = '44444444-dddd-4ddd-8ddd-444444444444';
const OFFBOARDING_ID = '55555555-eeee-4eee-8eee-555555555555';
const OPS_WS_ID = '66666666-ffff-4fff-8fff-666666666666';
const PURGE_RECEIPT_ID = '77777777-aaaa-4aaa-8aaa-777777777777';

function rawJson(make: (url: URL) => unknown, status = 200): MockHandler {
  return async ({ route, url }) => {
    await route.fulfill({
      body: JSON.stringify(make(url)),
      contentType: 'application/json',
      status,
    });
    return true;
  };
}

test('数据与隐私页（管理员）：异步导出创建/筛选/翻页/流式下载 + 7天离网注销申请与撤回，零裸 UUID', async ({
  page,
}) => {
  const backend = await installMockBackend(page, { displayName: 'E2E 测试公司', role: 'admin' });

  const exportRows: Array<Record<string, unknown>> = [
    {
      byteSize: 4096,
      completedAt: '2026-11-26T09:05:00.000Z',
      contentType: 'text/csv; charset=utf-8',
      createdAt: '2026-11-26T09:00:00.000Z',
      errorCode: null,
      expiresAt: '2026-12-03T09:05:00.000Z',
      filename: 'leads-export.csv',
      format: 'csv',
      id: EXPORT_READY_ID,
      requestedBy: 'user-e2e',
      rowCount: 42,
      scope: 'leads',
      status: 'ready',
      updatedAt: '2026-11-26T09:05:00.000Z',
      workspaceId: 'ws-e2e',
    },
    {
      byteSize: null,
      completedAt: null,
      contentType: null,
      createdAt: '2026-11-26T08:00:00.000Z',
      errorCode: null,
      expiresAt: null,
      filename: null,
      format: 'jsonl',
      id: EXPORT_PROC_ID,
      requestedBy: 'user-e2e',
      rowCount: null,
      scope: 'companies',
      status: 'processing',
      updatedAt: '2026-11-26T08:01:00.000Z',
      workspaceId: 'ws-e2e',
    },
  ];

  const page2Export = {
    byteSize: 1024,
    completedAt: '2026-11-10T08:00:00.000Z',
    contentType: 'text/csv; charset=utf-8',
    createdAt: '2026-11-10T07:55:00.000Z',
    errorCode: null,
    expiresAt: '2026-11-17T08:00:00.000Z',
    filename: 'old-contacts.csv',
    format: 'csv',
    id: EXPORT_PAGE2_ID,
    requestedBy: 'user-e2e',
    rowCount: 10,
    scope: 'contacts',
    status: 'expired',
    updatedAt: '2026-11-17T08:00:00.000Z',
    workspaceId: 'ws-e2e',
  };

  let offboardingState: Record<string, unknown> | null = null;
  let createCalls = 0;

  backend.set(
    'GET',
    '/data-exports',
    rawJson((url) => {
      const status = url.searchParams.get('status');
      const cursor = url.searchParams.get('cursor');
      if (cursor === 'exp-c1') {
        return { data: [page2Export], page: { has_more: false, next_cursor: null } };
      }
      const filtered = status ? exportRows.filter((row) => row.status === status) : exportRows;
      return {
        data: filtered,
        page: status
          ? { has_more: false, next_cursor: null }
          : { has_more: true, next_cursor: 'exp-c1' },
      };
    }),
  );

  backend.set('POST', '/data-exports', async ({ body, route }) => {
    createCalls += 1;
    if (createCalls >= 2) {
      await route.fulfill({
        body: JSON.stringify(
          errorPayload('DATA_EXPORT_RATE_LIMITED', {
            next: '明天再试或联系平台运营调整配额。',
            title: '今日数据导出次数已达上限',
          }),
        ),
        contentType: 'application/json',
        status: 429,
      });
      return true;
    }
    const payload = body as { format: string; scope: string };
    const created = {
      byteSize: null,
      completedAt: null,
      contentType: null,
      createdAt: '2026-11-26T10:00:00.000Z',
      errorCode: null,
      expiresAt: null,
      filename: null,
      format: payload.format,
      id: EXPORT_NEW_ID,
      requestedBy: 'user-e2e',
      rowCount: null,
      scope: payload.scope,
      status: 'pending',
      updatedAt: '2026-11-26T10:00:00.000Z',
      workspaceId: 'ws-e2e',
    };
    exportRows.unshift(created);
    await route.fulfill({
      body: JSON.stringify({ data: created }),
      contentType: 'application/json',
      status: 202,
    });
    return true;
  });

  backend.set('GET', `/data-exports/${EXPORT_READY_ID}/download`, async ({ route }) => {
    await route.fulfill({
      body: 'company,country\nAcme GmbH,DE\n',
      contentType: 'text/csv; charset=utf-8',
      headers: {
        'content-disposition': 'attachment; filename="leads-export.csv"',
      },
      status: 200,
    });
    return true;
  });

  backend.set('GET', '/workspaces/ws-e2e/offboarding', rawJson(() => ({ data: offboardingState })));

  backend.set('POST', '/workspaces/ws-e2e/offboarding', async ({ body, route }) => {
    const payload = body as { confirmName: string; reason?: string };
    offboardingState = {
      canCancel: true,
      cancelledAt: null,
      cancelledBy: null,
      coolOffEndsAt: '2026-12-03T10:00:00.000Z',
      id: OFFBOARDING_ID,
      purgedAt: null,
      purgedBy: null,
      reason: payload.reason ?? null,
      remainingDays: 7,
      requestedAt: '2026-11-26T10:00:00.000Z',
      requestedBy: 'user-e2e',
      status: 'SCHEDULED',
      workspaceId: 'ws-e2e',
    };
    await route.fulfill({
      body: JSON.stringify({ data: offboardingState }),
      contentType: 'application/json',
      status: 201,
    });
    return true;
  });

  backend.set('POST', '/workspaces/ws-e2e/offboarding/cancel', async ({ route }) => {
    offboardingState = {
      ...offboardingState,
      canCancel: false,
      cancelledAt: '2026-11-27T08:00:00.000Z',
      cancelledBy: 'user-e2e',
      remainingDays: 0,
      status: 'CANCELLED',
    };
    await route.fulfill({
      body: JSON.stringify({ data: offboardingState }),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  });

  await loginAs(page);
  await page.goto('/settings/privacy');

  // 1) 异步数据导出卡片渲染 + 创建导出
  const exportsCard = page.locator('[data-gs="data-exports-card"]');
  await expect(exportsCard).toContainText('线索清单');
  await expect(exportsCard).toContainText('可下载');
  await expect(exportsCard).toContainText('42 条');

  await page.locator('[data-gs="data-exports-scope"] .ant-select-selector').click();
  await page.locator('.ant-select-item-option', { hasText: '全量数据归档' }).click();
  await page.locator('[data-gs="data-exports-format"] .ant-select-selector').click();
  await page.locator('.ant-select-item-option', { hasText: 'JSONL 数据集' }).click();
  await page.locator('[data-gs="data-exports-submit"]').click();

  await expect.poll(() => backend.callsTo('POST', '/data-exports').length).toBe(1);
  expect(backend.callsTo('POST', '/data-exports')[0]?.body).toEqual({
    format: 'jsonl',
    scope: 'full_archive',
  });
  await expect(exportsCard).toContainText('全量数据归档');
  await expect(exportsCard).toContainText('排队中');

  // 2) 流式下载
  await page.locator(`[data-gs="data-export-download-${EXPORT_READY_ID.slice(0, 8)}"]`).click();
  await expect
    .poll(() => backend.callsTo('GET', `/data-exports/${EXPORT_READY_ID}/download`).length)
    .toBe(1);
  await expect(exportsCard).toContainText('leads-export.csv');

  // 3) 游标翻页与状态筛选
  await page.locator('[data-gs="data-exports-load-more"]').click();
  await expect(exportsCard).toContainText('已过期');
  await page.locator('[data-gs="data-exports-status-filter"] .ant-select-selector').click();
  await page.locator('.ant-select-item-option', { hasText: '可下载' }).click();
  await expect
    .poll(() => backend.callsTo('GET', '/data-exports').some((c) => c.query.status === 'ready'))
    .toBe(true);

  // 4) 触发 429 限流告警展示
  await page.locator('[data-gs="data-exports-submit"]').click();
  await expect(exportsCard).toContainText('今日数据导出次数已达上限');

  // 5) 工作空间 7 天离网注销：错误名称拦截 -> 正确名称+弹窗确认提交 -> 冷却期撤回
  const offboardingCard = page.locator('[data-gs="workspace-offboarding-card"]');
  await expect(offboardingCard.locator('[data-gs="offboarding-status-tag"]')).toContainText('正常使用中');

  await page.locator('[data-gs="offboarding-toggle-form"]').click();
  await page.locator('[data-gs="offboarding-confirm-name"]').fill('错误公司名');
  await page.locator('[data-gs="offboarding-submit-btn"]').click();
  await expect(offboardingCard).toContainText('输入的名称与当前工作空间名称不一致');
  expect(backend.callsTo('POST', '/workspaces/ws-e2e/offboarding').length).toBe(0);

  await page.locator('[data-gs="offboarding-confirm-name"]').fill('E2E 测试公司');
  await page.locator('[data-gs="offboarding-reason"]').fill('项目结项');
  await page.locator('[data-gs="offboarding-submit-btn"]').click();
  await page.locator('.ant-modal-confirm-btns button').last().click();

  await expect.poll(() => backend.callsTo('POST', '/workspaces/ws-e2e/offboarding').length).toBe(1);
  expect(backend.callsTo('POST', '/workspaces/ws-e2e/offboarding')[0]?.body).toEqual({
    confirmName: 'E2E 测试公司',
    reason: '项目结项',
  });
  await expect(offboardingCard.locator('[data-gs="offboarding-status-tag"]')).toContainText('注销冷却期中');
  await expect(offboardingCard.locator('[data-gs="offboarding-scheduled-banner"]')).toContainText('7 天');

  // 撤回注销
  await page.locator('[data-gs="offboarding-cancel-btn"]').click();
  await page.locator('.ant-modal-confirm-btns button').last().click();
  await expect.poll(() => backend.callsTo('POST', '/workspaces/ws-e2e/offboarding/cancel').length).toBe(1);
  await expect(offboardingCard.locator('[data-gs="offboarding-status-tag"]')).toContainText('已撤销注销');

  // 6) 租户页面零裸 UUID 暴露
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});

test('数据与隐私页（普通成员）：路由守卫拦截管理员专属页且零导出/离网请求', async ({ page }) => {
  const backend = await installMockBackend(page, { displayName: '成员测试公司', role: 'member' });

  await loginAs(page);
  await page.goto('/settings/privacy');

  await expect(page.locator('[data-gs="data-exports-card"]')).toHaveCount(0);
  await expect(page.locator('[data-gs="workspace-offboarding-card"]')).toHaveCount(0);
  await expect(page.locator('body')).toContainText('未找到页面');
  expect(backend.callsTo('GET', '/data-exports').length).toBe(0);
  expect(backend.callsTo('POST', '/workspaces/ws-e2e/offboarding').length).toBe(0);
});

test('运营台工作空间治理：跨库对账、存储配额更新与整空间物理清理回执', async ({ page }) => {
  const backend = await installMockBackend(page);
  let savedQuotaPayload: unknown = null;
  let purgePayload: unknown = null;
  let receiptState: Record<string, unknown> | null = null;

  backend.set('GET', '/ops/auth/session', rawJson(() => ({ data: { user: { email: 'ops@gainos.local' } } })));
  backend.set('GET', '/ops/overview', rawJson(() => ({ db: { ok: true }, engine: { httpStatus: 200, ready: true } })));
  backend.set(
    'GET',
    '/ops/workspaces',
    rawJson(() => ({
      workspaces: [
        {
          id: OPS_WS_ID,
          members: 3,
          name: 'Offboarding Corp',
          status: 'ACTIVE',
          status_note: '',
          status_updated_at: '2026-11-26T00:00:00.000Z',
        },
      ],
    })),
  );
  backend.set(
    'GET',
    '/ops/reconcile/workspaces',
    rawJson(() => ({
      data: {
        matchedCount: 5,
        onlyInEngine: [],
        onlyInSaas: [],
        registryMissing: [],
        statusMismatch: [],
      },
    })),
  );
  backend.set(
    'GET',
    `/ops/workspaces/${OPS_WS_ID}/detail`,
    rawJson(() => ({
      data: {
        engineCounts: { sellerDocuments: 12 },
        saasCounts: { activeSessions: 2, members: 3 },
        storageQuota: {
          isDefault: true,
          maxBytesPerWorkspace: '2147483648',
          maxDocumentsPerCompany: 200,
          maxDocumentsPerWorkspace: 500,
          maxExportsPerDay: 10,
          workspaceId: OPS_WS_ID,
        },
        workspace: { id: OPS_WS_ID, name: 'Offboarding Corp', status: 'ACTIVE' },
      },
    })),
  );
  backend.set('GET', `/ops/workspaces/${OPS_WS_ID}/purge`, rawJson(() => ({ data: receiptState })));
  backend.set('PUT', `/ops/workspaces/${OPS_WS_ID}/storage-quota`, async ({ body, route }) => {
    savedQuotaPayload = body;
    await route.fulfill({
      body: JSON.stringify({ data: { workspaceId: OPS_WS_ID, ...(body as Record<string, unknown>) } }),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  });
  backend.set('POST', `/ops/workspaces/${OPS_WS_ID}/purge`, async ({ body, route }) => {
    purgePayload = body;
    receiptState = {
      completedAt: '2026-12-04T00:00:00.000Z',
      deletedCounts: { membership: 3, outreach_draft: 5 },
      enginePurgeReceiptId: '88888888-aaaa-4aaa-8aaa-888888888888',
      enginePurgeStatus: 'PENDING',
      errorCode: null,
      forced: false,
      id: PURGE_RECEIPT_ID,
      idempotencyKey: `purge-${OPS_WS_ID}`,
      revokedSessions: 2,
      startedAt: '2026-12-04T00:00:00.000Z',
      status: 'COMPLETED',
      workspaceId: OPS_WS_ID,
    };
    await route.fulfill({
      body: JSON.stringify({ data: receiptState }),
      contentType: 'application/json',
      status: 202,
    });
    return true;
  });

  page.on('dialog', (dialog) => dialog.accept());

  await page.goto('/ops');
  await page.getByRole('button', { name: '工作空间' }).click();

  await page.locator('[data-gs="ops-reconcile-btn"]').click();
  await expect(page.locator('[data-gs="ops-reconcile-result"]')).toContainText('匹配 5');

  await page.getByRole('button', { name: '治理' }).click();
  await expect(page.locator('[data-gs="ops-workspace-detail-panel"]')).toContainText('Offboarding Corp');

  await page.locator('[data-gs="ops-save-quota-btn"]').click();
  await expect.poll(() => savedQuotaPayload).toMatchObject({
    maxDocumentsPerCompany: 200,
    maxDocumentsPerWorkspace: 500,
    maxExportsPerDay: 10,
  });

  await page.locator('[data-gs="ops-purge-btn"]').click();
  await expect.poll(() => purgePayload).toMatchObject({
    force: false,
    idempotencyKey: `purge-${OPS_WS_ID}`,
  });
  await expect(page.locator('[data-gs="ops-purge-receipt"]')).toContainText('COMPLETED');
  await expect(page.locator('[data-gs="ops-purge-receipt"]')).toContainText('吊销会话：2');
});
