/**
 * Wave B4 专项 E2E 回归测试：
 * 1) /ops 暗色模式 + URL ?tab= 深链同步 + GsModal 取消撤销原因弹窗（0 原生 dialog）+ PR #215 配额/对账；
 * 2) leads/detail：切 Tab 保留 T0 外联草稿；member 可见公开渠道且 0 contact-enrichment 403；
 *    admin 可见 B1 联系人补强进度/质量事实/明细与一键 recover；?tab=outcomes 真实聚合时间线；
 * 3) leads/index：行选/全选 + GsBulkActionBar（与底部进度条零遮挡）+ 批量排除/批量接受/批量外发 + URL 筛选同步；
 * 4) tasks/detail & runs/index：单查 GET /tasks/:id + 改名/暂停/恢复/归档（不可逆）+ result-view 渲染。
 */
import type { MockHandler } from './support/mock-backend';

import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const NOW = '2026-11-26T10:00:00.000Z';
const ICP_ID = '11111111-1111-4111-8111-111111111111';
const LEAD_1 = '22222222-2222-4222-8222-222222222222';
const LEAD_2 = '33333333-3333-4333-8333-333333333333';
const CANON_ID = '44444444-4444-4444-8444-444444444444';
const CONTACT_ID = '55555555-5555-4555-8555-555555555555';
const TASK_ID = '66666666-6666-4666-8666-666666666666';
const RUN_ID = '77777777-7777-4777-8777-777777777777';
const OPS_WS_ID = '88888888-8888-4888-8888-888888888888';
const BATCH_ID = '99999999-9999-4999-8999-999999999999';
const OP_REF_FAILED = 'a'.repeat(64);
const OP_REF_DONE = 'b'.repeat(64);

function rawJson(payload: unknown, status = 200): MockHandler {
  return async ({ route }) => {
    await route.fulfill({
      body: JSON.stringify(payload),
      contentType: 'application/json',
      status,
    });
    return true;
  };
}

function luminance(rgb: string): number {
  const match = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return 0;
  const [r, g, b] = match.slice(1, 4).map(Number) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test('1. /ops 暗色模式无白底、Tab 同步 URL、PR #215 配额对账与取消撤销 GsModal（0 原生 dialog）', async ({
  page,
}) => {
  const backend = await installMockBackend(page);
  const nativeDialogs: string[] = [];
  page.on('dialog', (d) => {
    nativeDialogs.push(`${d.type()}:${d.message()}`);
    void d.dismiss();
  });

  let cancelPayload: unknown = null;
  let cancelCalled = 0;

  backend.set('GET', '/ops/auth/session', rawJson({ data: { user: { email: 'ops@gainos.local' } } }));
  backend.set(
    'GET',
    '/ops/overview',
    rawJson({
      db: { ok: true },
      dueSources: 0,
      engine: { failedComponents: [], httpStatus: 200, ready: true },
      failedFetches: [],
      fetchStats24h: [],
      leases: [],
      probe: { missing: [], ok: true },
      providersByStatus: [],
      redLights: { deadDeliveries: 0, exhaustedBudgetAccounts: 0, r4: { deliveryUnknown: 0, openRevocations: 1, platformExhaustedAuthorities: 0 }, temporal: { reachable: true } },
      sanctions: [],
      sourcesByStatus: [],
    }),
  );
  backend.set(
    'GET',
    '/ops/workspaces',
    rawJson({
      workspaces: [
        { id: OPS_WS_ID, members: 4, name: 'Quota Ops GmbH', status: 'ACTIVE', status_note: '', status_updated_at: NOW },
      ],
    }),
  );
  backend.set(
    'GET',
    '/ops/reconcile/workspaces',
    rawJson({
      data: {
        complete: true,
        nameMismatches: [{ engineName: 'Old Name', id: OPS_WS_ID, saasName: 'Quota Ops GmbH', saasStatus: 'ACTIVE' }],
        onlyInEngine: [],
        onlyInSaas: [],
        summary: {
          engineTotal: 3,
          matchedCount: 3,
          nameMismatchCount: 1,
          onlyInEngineCount: 0,
          onlyInSaasCount: 0,
          saasTotal: 3,
        },
      },
    }),
  );
  backend.set(
    'GET',
    `/ops/workspaces/${OPS_WS_ID}/detail`,
    rawJson({
      data: {
        activeSessions: 2,
        engine: {
          available: true,
          counts: { companies: 1, icps: 1, leads: 5 },
          exists: true,
          name: 'Quota Ops GmbH',
          sellerDocuments: { pendingUpload: 0, total: 9, totalBytes: 5_242_880 },
        },
        members: [{ email: 'a@example.com', role: 'admin', status: 'active', userId: 'u1' }],
        registry: { cursor: '10', enabled: true, lastPulledAt: NOW },
        saasCounts: { campaigns: 1, deletionMirrors: 0, outreachBatches: 1, outreachSends30d: 0, qgos: 1, saos: 0 },
        storageQuota: {
          isDefault: false,
          maxBytesPerWorkspace: '1073741824',
          maxDocumentsPerCompany: 100,
          maxDocumentsPerWorkspace: 300,
          maxExportsPerDay: 20,
          updatedAt: NOW,
          updatedBy: 'ops-1',
          workspaceId: OPS_WS_ID,
        },
        workspace: { id: OPS_WS_ID, name: 'Quota Ops GmbH', status: 'ACTIVE' },
      },
    }),
  );
  backend.set(
    'GET',
    `/ops/workspaces/${OPS_WS_ID}/storage-quota`,
    rawJson({
      data: {
        isDefault: false,
        maxBytesPerWorkspace: '1073741824',
        maxDocumentsPerCompany: 100,
        maxDocumentsPerWorkspace: 300,
        maxExportsPerDay: 20,
        updatedAt: NOW,
        updatedBy: 'ops-1',
        usage: { pendingUpload: 0, totalBytes: 5_242_880, totalDocuments: 9 },
        workspaceId: OPS_WS_ID,
      },
    }),
  );
  backend.set('GET', `/ops/workspaces/${OPS_WS_ID}/purge`, rawJson({ data: null }));
  backend.set(
    'GET',
    '/ops/r4/revocations',
    rawJson({
      requests: [
        {
          attemptCount: 0,
          attempts: [],
          createdAt: NOW,
          deliveryUnknown: false,
          fenceSequence: 1,
          id: 'rev-1',
          reasonCode: 'OPERATOR_HOLD',
          requestedBy: 'ops@gainos.local',
          scheduleId: 'acq-sweep',
          source: 'OPERATOR',
          state: 'PENDING_CONFIRMATION',
        },
      ],
    }),
  );
  backend.set(
    'GET',
    '/ops/r4/policy-state',
    rawJson({ autoConfirm: false, states: [], triggerEnabled: true }),
  );
  backend.set('POST', '/ops/r4/revocations/rev-1/cancel', async ({ body, route }) => {
    cancelCalled += 1;
    cancelPayload = body;
    await route.fulfill({
      body: JSON.stringify({ data: { cancelled: true } }),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  });

  await loginAs(page);
  // 切换暗色模式（PR-UI1 收纳在账号弹出菜单内），并等待 Vben 150ms debouncedSave 落盘后再整页跳转
  await page.locator("[data-gs='account-trigger']").click();
  await page.locator("[data-gs='theme-toggle']").click();
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).some(
          (k) => k.endsWith('preferences-theme') && String(localStorage.getItem(k)).includes('dark'),
        ),
      ),
    )
    .toBe(true);

  await page.goto('/ops');
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await expect(page.locator('.ops__header')).toBeVisible();
  const headerBg = await page.locator('.ops__header').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(luminance(headerBg), `暗色顶栏不应白底：${headerBg}`).toBeLessThan(60);

  // 切到工作空间并同步 URL ?tab=workspaces
  await page.getByRole('button', { name: '工作空间' }).click();
  await page.waitForURL((url) => url.pathname === '/ops' && url.searchParams.get('tab') === 'workspaces');

  await page.locator('[data-gs="ops-reconcile-btn"]').click();
  await expect(page.locator('[data-gs="ops-reconcile-result"]')).toContainText('匹配 3');
  await expect(page.locator('[data-gs="ops-reconcile-result"]')).toContainText('名称漂移 1');

  await page.getByRole('button', { name: '治理' }).click();
  await expect(page.locator('[data-gs="ops-workspace-usage-summary"]')).toContainText('引擎资料：9');
  await expect(page.locator('[data-gs="ops-workspace-usage-summary"]')).toContainText('5.0 MB');
  await expect(page.locator('[data-gs="ops-storage-quota-section"]')).toContainText('自定义配额');

  // 切到平台撤销，刷新页面验证 ?tab=revocations 保持当前 Tab
  await page.getByRole('button', { name: '平台撤销' }).click();
  await page.waitForURL((url) => url.pathname === '/ops' && url.searchParams.get('tab') === 'revocations');
  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name: '平台撤销' })).toBeVisible();

  // 打开取消撤销 GsModal：空原因校验阻断 -> 填原因提交
  await page.locator('[data-gs="ops-cancel-revocation-btn"]').click();
  await expect(page.locator('[data-gs="ops-cancel-revocation-modal"]')).toBeVisible();
  await page.locator('.ant-modal-footer .ant-btn-primary').click();
  await expect(page.locator('[data-gs="ops-cancel-revocation-error"]')).toBeVisible();
  expect(cancelCalled).toBe(0);

  await page.locator('[data-gs="ops-cancel-revocation-reason"]').fill('演练验证误触发，取消撤销');
  await page.locator('.ant-modal-footer .ant-btn-primary').click();
  await expect.poll(() => cancelCalled).toBe(1);
  expect(cancelPayload).toEqual({ reason: '演练验证误触发，取消撤销' });

  expect(nativeDialogs).toEqual([]);
});

test('2a. 线索详情（admin）：切 Tab 保留 T0 草稿 + B1 联系人补强进度/质量事实/一键恢复 + outcomes 真实时间线', async ({
  page,
}) => {
  const backend = await installMockBackend(page, { role: 'admin' });
  let enrichmentStatus = 'RESULT_UNKNOWN';
  let recoverCount = 0;

  backend.set('GET', `/leads/${LEAD_1}/package`, {
    company: {
      canonical_company_id: CANON_ID,
      country: 'IT',
      domain: 'solar-italia.it',
      name: 'Solar Italia S.r.l.',
    },
    company_channels: [
      { channel: 'email', email_type: 'department', status: 'public', value: 'sales@solar-italia.it' },
      { channel: 'phone', status: 'public', value: '+39 02 9988776' },
      { channel: 'form_url', status: 'public', value: 'https://solar-italia.it/contact' },
    ],
    evidence: [{ fetched_at: NOW, field: '官网产品页', source_url: 'https://solar-italia.it/products' }],
    fit: { reasons: ['区域光伏进口分销商'], verdict: 'FIT' },
    lead_id: LEAD_1,
    sanctions: { screened_at: NOW, status: 'clear' },
    scores: { fit: 0.9, total: 0.88 },
    social_profiles: [{ platform: 'linkedin', url: 'https://www.linkedin.com/company/solar-italia' }],
    status: 'QUALIFIED',
  });
  backend.set('GET', `/canonical-companies/${CANON_ID}`, {
    company: {
      contacts: [
        {
          contactPoints: [{ id: 'pt-1', status: 'VALID', type: 'email', value: 'm.bianchi@solar-italia.it' }],
          fullName: 'Marco Bianchi',
          id: CONTACT_ID,
          title: 'Head of Procurement',
        },
      ],
      country: 'IT',
      domain: 'solar-italia.it',
      id: CANON_ID,
      name: 'Solar Italia S.r.l.',
    },
    evidence: [],
  });
  backend.set('GET', `/canonical-companies/${CANON_ID}/contact-enrichment-results`, async ({ route }) => {
    await route.fulfill({
      body: JSON.stringify({
        data: [
          {
            businessRunId: null,
            companyId: CANON_ID,
            createdAt: NOW,
            entrypoint: 'http',
            operationRef: OP_REF_FAILED,
            perContact: [{ contactId: CONTACT_ID, newCandidate: true, reasonCode: 'RESULT_UNKNOWN' }],
            protocolVersion: 1,
            qualityCoverage: 'PREREQUISITE_ONLY',
            resultRevision: 1,
            spend: { costBasis: 'estimated_upper_bound', knownChargedMicrousd: '250000', quotedUpperBoundMicrousd: '500000', unknownUpperBoundMicrousd: null },
            status: enrichmentStatus,
            summary: {
              consideredUniqueContacts: 2,
              eligibleUniqueContacts: 2,
              newCandidatePoints: 1,
              newValidPersonalContacts: null,
              physicallyAttemptedUniqueContacts: 2,
              skippedByReason: [{ count: 1, reasonCode: 'NO_MATCH' }],
              stockValidPersonalContacts: null,
              unresolvedUniqueContacts: 1,
            },
            unavailableMetrics: ['newValidPersonalContacts'],
            version: 1,
          },
        ],
        page: { has_more: false, next_cursor: null },
      }),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  });
  backend.set(
    'GET',
    `/canonical-companies/${CANON_ID}/contact-enrichment-quality-facts`,
    rawJson({
      data: [
        {
          basis: 'verified_snapshot',
          businessRunId: null,
          companyId: CANON_ID,
          createdAt: NOW,
          entrypoint: 'http',
          operationRef: OP_REF_FAILED,
          perContact: [],
          protocolVersion: 1,
          qualityCoverage: 'PREREQUISITE_ONLY',
          resultRevision: 1,
          spend: { costBasis: 'estimated_upper_bound', knownChargedMicrousd: '250000', quotedUpperBoundMicrousd: '500000', unknownUpperBoundMicrousd: null },
          status: 'COMPLETED',
          summary: {
            consideredUniqueContacts: 2,
            coveredUniqueContacts: 2,
            eligibleUniqueContacts: 2,
            newCandidatePoints: 1,
            newValidPersonalContacts: null,
            organizationChannelContacts: 1,
            physicallyAttemptedUniqueContacts: 2,
            skippedByReason: [],
            stockValidPersonalContacts: null,
            unknownEmailTypeContacts: 0,
            unresolvedUniqueContacts: 0,
          },
          unavailableMetrics: [],
          version: 1,
        },
      ],
      page: { has_more: false, next_cursor: null },
    }),
  );
  backend.set(
    'GET',
    `/canonical-companies/${CANON_ID}/contact-enrichment-results/${OP_REF_FAILED}`,
    {
      businessRunId: null,
      companyId: CANON_ID,
      createdAt: NOW,
      entrypoint: 'http',
      operationRef: OP_REF_FAILED,
      perContact: [{ contactId: CONTACT_ID, newCandidate: true, reasonCode: 'STORED' }],
      protocolVersion: 1,
      qualityCoverage: 'PREREQUISITE_ONLY',
      resultRevision: 1,
      spend: { costBasis: 'estimated_upper_bound', knownChargedMicrousd: '250000', quotedUpperBoundMicrousd: '500000', unknownUpperBoundMicrousd: null },
      status: enrichmentStatus,
      summary: {
        consideredUniqueContacts: 2,
        eligibleUniqueContacts: 2,
        newCandidatePoints: 1,
        newValidPersonalContacts: null,
        physicallyAttemptedUniqueContacts: 2,
        skippedByReason: [],
        stockValidPersonalContacts: null,
        unresolvedUniqueContacts: 1,
      },
      unavailableMetrics: [],
      version: 1,
    },
  );
  backend.set(
    'GET',
    `/canonical-companies/${CANON_ID}/contact-enrichment-quality-facts/${OP_REF_FAILED}`,
    {
      businessRunId: null,
      companyId: CANON_ID,
      createdAt: NOW,
      entrypoint: 'http',
      operationRef: OP_REF_FAILED,
      perContact: [],
      protocolVersion: 1,
      qualityCoverage: 'PREREQUISITE_ONLY',
      resultRevision: 1,
      spend: { costBasis: 'estimated_upper_bound', knownChargedMicrousd: '250000', quotedUpperBoundMicrousd: '500000', unknownUpperBoundMicrousd: null },
      status: 'COMPLETED',
      summary: {
        consideredUniqueContacts: 2,
        coveredUniqueContacts: 2,
        eligibleUniqueContacts: 2,
        newCandidatePoints: 1,
        newValidPersonalContacts: null,
        organizationChannelContacts: 1,
        physicallyAttemptedUniqueContacts: 2,
        skippedByReason: [],
        stockValidPersonalContacts: null,
        unknownEmailTypeContacts: 0,
        unresolvedUniqueContacts: 0,
      },
      unavailableMetrics: [],
      version: 1,
    },
  );
  backend.set('POST', `/canonical-companies/${CANON_ID}/contact-enrichment-results/${OP_REF_FAILED}/recover`, async ({ route }) => {
    recoverCount += 1;
    enrichmentStatus = 'COMPLETED';
    await route.fulfill({
      body: JSON.stringify({
        data: {
          businessRunId: null,
          companyId: CANON_ID,
          createdAt: NOW,
          entrypoint: 'http',
          operationRef: OP_REF_FAILED,
          perContact: [{ contactId: CONTACT_ID, newCandidate: true, reasonCode: 'STORED' }],
          protocolVersion: 1,
          qualityCoverage: 'PREREQUISITE_ONLY',
          resultRevision: 2,
          spend: { costBasis: 'estimated_upper_bound', knownChargedMicrousd: '250000', quotedUpperBoundMicrousd: '500000', unknownUpperBoundMicrousd: null },
          status: 'COMPLETED',
          summary: {
            consideredUniqueContacts: 2,
            eligibleUniqueContacts: 2,
            newCandidatePoints: 1,
            newValidPersonalContacts: null,
            physicallyAttemptedUniqueContacts: 2,
            skippedByReason: [],
            stockValidPersonalContacts: null,
            unresolvedUniqueContacts: 0,
          },
          unavailableMetrics: [],
          version: 1,
        },
      }),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  });
  backend.set('GET', '/outreach/t0/touches', [
    {
      actorId: 'user-e2e',
      channel: 'mailto',
      createdAt: '2026-11-26T11:00:00.000Z',
      id: 'touch-1',
      leadId: LEAD_1,
      note: '已发送首轮产品规格书',
      outcome: 'SENT',
      targetMasked: 's***@solar-italia.it',
    },
  ]);
  backend.set('GET', '/qgos', [
    {
      campaignId: null,
      canonicalCompanyRef: CANON_ID,
      createdAt: '2026-11-26T12:00:00.000Z',
      createdBy: 'user-e2e',
      evidence: [],
      icpRef: ICP_ID,
      id: 'qgo-1',
      leadRef: LEAD_1,
      nextStep: '安排技术会议',
      outcomes: [
        {
          createdAt: '2026-11-26T14:00:00.000Z',
          id: 'out-1',
          note: '客户同意周四线上演示',
          occurredAt: '2026-11-26T14:00:00.000Z',
          outcome: 'MEETING_BOOKED',
          source: 'customer',
        },
      ],
      sao: { decidedAt: '2026-11-26T13:00:00.000Z', id: 'sao-1', reason: '高意愿客户', state: 'ACCEPTED' },
      score: 88,
      state: 'CONVERTED',
      title: 'Solar Italia 5MW 询盘',
      updatedAt: '2026-11-26T14:00:00.000Z',
    },
  ]);

  await loginAs(page);
  await page.goto(`/leads/${LEAD_1}`);

  // 1) 在档案 Tab 编辑 T0 草稿并切过全部 4 个 Tab 后仍保留草稿
  await expect(page.locator('[data-gs="t0-outreach"]')).toBeVisible();
  await page.locator('[data-gs="t0-subject"]').fill('Custom T0 Subject Kept Across Tabs');
  await page.locator('[data-gs="t0-body"]').fill('Custom T0 Body Never Destroyed');

  await page.getByRole('tab', { name: '联系人' }).click();
  await expect(page.locator('[data-gs="people-public-channels"]')).toContainText('sales@solar-italia.it');
  await expect(page.locator('[data-gs="enrichment-results-card"]')).toBeVisible();
  await expect(page.locator('[data-gs="enrichment-quality-summary"]')).toContainText('已覆盖 2 人');

  // 展开补强明细 + 一键恢复
  await page.locator('[data-gs="enrichment-detail-btn"]').first().click();
  await expect(page.locator('[data-gs="enrichment-detail-panel"]')).toContainText('已写入新联系点');

  await page.locator('[data-gs="enrichment-recover-btn"]').first().click();
  await expect(page.locator('.ant-modal-confirm')).toBeVisible();
  await page.locator('.ant-modal-confirm-btns button').last().click();
  await expect.poll(() => recoverCount).toBe(1);
  await expect(page.locator('[data-gs="enrichment-item-status"]').first()).toContainText('已完成');

  // 切到触达草稿 Tab，验证单一挂载 T0OutreachPanel 完整保留用户编辑
  await page.getByRole('tab', { name: '触达草稿' }).click();
  await expect(page.locator('[data-gs="t0-subject"]')).toHaveValue('Custom T0 Subject Kept Across Tabs');
  await expect(page.locator('[data-gs="t0-body"]')).toHaveValue('Custom T0 Body Never Destroyed');

  // 切到结果 Tab，验证真实聚合时间线（按时间倒序）
  await page.getByRole('tab', { name: '结果' }).click();
  const timeline = page.locator('[data-gs="outcomes-timeline"]');
  await expect(timeline).toBeVisible();
  await expect(timeline).toContainText('商机结果：已约会议');
  await expect(timeline).toContainText('销售接受状态：已接受');
  await expect(timeline).toContainText('Solar Italia 5MW 询盘');
  await expect(timeline).toContainText('已发送首轮产品规格书');
  await expect(timeline).toContainText('联系人补强：已完成');

  // 再切回档案 Tab，T0 草稿仍然完整保留
  await page.getByRole('tab', { name: '档案' }).click();
  await expect(page.locator('[data-gs="t0-subject"]')).toHaveValue('Custom T0 Subject Kept Across Tabs');
});

test('2b. 线索详情（member）：可见公司公开渠道，且 0 请求 contact-enrichment / canonical-companies（0 HTTP 403）', async ({
  page,
}) => {
  const backend = await installMockBackend(page, { role: 'member' });
  const forbidden: string[] = [];
  page.on('response', (res) => {
    if (res.status() === 403) forbidden.push(`${res.request().method()} ${res.url()}`);
  });

  backend.set('GET', `/leads/${LEAD_1}/package`, {
    company: {
      canonical_company_id: CANON_ID,
      country: 'IT',
      domain: 'solar-italia.it',
      name: 'Solar Italia S.r.l.',
    },
    company_channels: [
      { channel: 'email', email_type: 'department', status: 'public', value: 'sales@solar-italia.it' },
      { channel: 'phone', status: 'public', value: '+39 02 9988776' },
      { channel: 'form_url', status: 'public', value: 'https://solar-italia.it/contact' },
    ],
    evidence: [],
    fit: { reasons: ['光伏进口商'], verdict: 'FIT' },
    lead_id: LEAD_1,
    sanctions: { screened_at: NOW, status: 'clear' },
    social_profiles: [{ platform: 'linkedin', url: 'https://www.linkedin.com/company/solar-italia' }],
    status: 'REVIEW',
  });
  backend.set('GET', `/canonical-companies/${CANON_ID}`, rawJson({ error: { code: 'FORBIDDEN' } }, 403));
  backend.set(
    'GET',
    `/canonical-companies/${CANON_ID}/contact-enrichment-results`,
    rawJson({ error: { code: 'FORBIDDEN' } }, 403),
  );
  backend.set(
    'GET',
    `/canonical-companies/${CANON_ID}/contact-enrichment-quality-facts`,
    rawJson({ error: { code: 'FORBIDDEN' } }, 403),
  );

  await loginAs(page);
  await page.goto(`/leads/${LEAD_1}?tab=people`);

  // 公开渠道对普通成员完全可见
  await expect(page.locator('[data-gs="people-public-channels"]')).toBeVisible();
  await expect(page.locator('[data-gs="people-public-channels"]')).toContainText('sales@solar-italia.it');
  await expect(page.locator('[data-gs="people-public-channels"]')).toContainText('+39 02 9988776');
  await expect(page.locator('[data-gs="people-public-channels"]')).toContainText('https://solar-italia.it/contact');

  // 仅具名决策人与补强受管理员门控
  await expect(page.locator('[data-gs="decision-makers-admin-only"]')).toBeVisible();
  await expect(page.locator('[data-gs="decision-makers"]')).toHaveCount(0);

  // 切到 outcomes 也绝不发 contact-enrichment 请求
  await page.getByRole('tab', { name: '结果' }).click();
  await expect(page.locator('[data-gs="outcomes-timeline"]')).toBeVisible();

  expect(forbidden).toEqual([]);
  expect(backend.callsTo('GET', `/canonical-companies/${CANON_ID}`)).toHaveLength(0);
});

test('3. 线索列表：多选 GsBulkActionBar（与底部进度条零遮挡）、批量排除/接受/外发与 URL 筛选同步', async ({
  page,
}) => {
  const backend = await installMockBackend(page, { role: 'admin' });
  const rejectedIds: string[] = [];
  const acceptedIds: string[] = [];
  const addedDrafts: Array<Record<string, unknown>> = [];

  backend.set('GET', '/icps', [{ companyId: 'co-1', createdAt: NOW, id: ICP_ID, name: '意大利光伏', status: 'ACTIVE' }]);
  backend.set('GET', `/icps/${ICP_ID}/lead-queues`, {
    needs_review: 2,
    queueBasis: { fit_gate_preset: 0, human_accept: 0, human_reject: 0, score: 2 },
    recommended: 1,
    rejected: 0,
    sanctions_hold: 0,
    scored: true,
    suppressed: 0,
  });
  backend.set('GET', '/leads', [
    {
      channelSummary: { decisionMakerCount: 1, emails: ['buyer@alpha-solar.it'], forms: [], phones: ['+39 02 111'], socials: [], verifiedEmailCount: 1 },
      company: { country: 'IT', domain: 'alpha-solar.it', id: 'c-1', industry: 'Solar', name: 'Alpha Solar S.r.l.' },
      fitVerdict: 'FIT',
      icpId: ICP_ID,
      id: LEAD_1,
      queue: 'needs_review',
      scored: true,
      status: 'REVIEW',
      totalScore: 86,
    },
    {
      channelSummary: { decisionMakerCount: 0, emails: ['info@beta-grid.de'], forms: [], phones: [], socials: [], verifiedEmailCount: 0 },
      company: { country: 'DE', domain: 'beta-grid.de', id: 'c-2', industry: 'Energy', name: 'Beta Grid GmbH' },
      fitVerdict: 'UNKNOWN',
      icpId: ICP_ID,
      id: LEAD_2,
      queue: 'needs_review',
      scored: true,
      status: 'DISCOVERED',
      totalScore: 68,
    },
  ]);
  backend.set('POST', `/leads/${LEAD_1}/reject`, async ({ route }) => {
    rejectedIds.push(LEAD_1);
    await route.fulfill({ body: JSON.stringify({ data: { id: LEAD_1, status: 'REJECTED' } }), contentType: 'application/json', status: 200 });
    return true;
  });
  backend.set('POST', `/leads/${LEAD_2}/reject`, async ({ route }) => {
    rejectedIds.push(LEAD_2);
    await route.fulfill({ body: JSON.stringify({ data: { id: LEAD_2, status: 'REJECTED' } }), contentType: 'application/json', status: 200 });
    return true;
  });
  backend.set('POST', `/leads/${LEAD_1}/accept`, async ({ route }) => {
    acceptedIds.push(LEAD_1);
    await route.fulfill({ body: JSON.stringify({ data: { accepted: true, eventId: 'ev-1' } }), contentType: 'application/json', status: 200 });
    return true;
  });
  backend.set('GET', '/outreach/batches', [
    { createdAt: NOW, draftCount: 0, id: BATCH_ID, name: '批量外发草稿批', status: 'DRAFT', updatedAt: NOW },
  ]);
  backend.set('POST', `/outreach/batches/${BATCH_ID}/drafts`, async ({ body, route }) => {
    addedDrafts.push(body as Record<string, unknown>);
    await route.fulfill({ body: JSON.stringify({ data: { id: `draft-${addedDrafts.length}` } }), contentType: 'application/json', status: 201 });
    return true;
  });

  await loginAs(page);
  await page.goto('/leads');

  // 1) 全选本页 -> GsBulkActionBar 浮出且位于 flow-bar 上方（零遮挡）
  await page.locator('[data-gs="leads-select-all"]').click();
  const bulkBar = page.locator('[data-gs="bulk-action-bar"]');
  await expect(bulkBar).toBeVisible();
  await expect(page.locator('[data-gs="bulk-action-count"]')).toHaveText('2');

  const flowBar = page.locator('[data-gs="flow-bar"]');
  if (await flowBar.isVisible().catch(() => false)) {
    const bulkBox = await bulkBar.boundingBox();
    const flowBox = await flowBar.boundingBox();
    if (bulkBox && flowBox) {
      expect(bulkBox.y + bulkBox.height).toBeLessThanOrEqual(flowBox.y + 1);
    }
  }

  // 2) 批量加入外发批次
  await page.locator('[data-gs="bulk-outreach"]').click();
  await expect(page.locator('[data-gs="bulk-outreach-modal"]')).toBeVisible();
  await page.locator('[data-gs="bulk-outreach-confirm"]').click();
  await expect.poll(() => addedDrafts.length).toBe(2);

  // 3) 单选第一条 -> 批量跟进（需二次确认）
  await page.locator('[data-gs="lead-select-checkbox"]').first().click();
  await page.locator('[data-gs="bulk-accept"]').click();
  await expect(page.locator('.ant-modal-confirm')).toBeVisible();
  await page.locator('.ant-modal-confirm-btns button').last().click();
  await expect.poll(() => acceptedIds).toEqual([LEAD_1]);

  // 4) 全选 -> 批量排除（选原因码）
  await page.locator('[data-gs="leads-select-all"]').click();
  await page.locator('[data-gs="bulk-reject"]').click();
  await expect(page.locator('[data-gs="bulk-reject-modal"]')).toBeVisible();
  await page.locator('[data-gs="bulk-reject-reason"] .ant-select-selector').click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').first().click();
  await page.locator('.ant-modal-footer .ant-btn-primary').click();
  await expect.poll(() => rejectedIds.length).toBe(2);

  // 5) 筛选条件同步至 URL Query 并透传 status 给 GET /api/leads
  await page.locator('[data-gs="lead-status-filter"] .ant-select-selector').click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: '待复核' }).click();
  await page.locator('[data-gs="lead-search"] input').fill('Alpha');

  await page.waitForURL(
    (url) =>
      url.pathname === '/leads' &&
      url.searchParams.get('status') === 'REVIEW' &&
      url.searchParams.get('q') === 'Alpha',
  );
  await expect
    .poll(() => backend.callsTo('GET', '/leads').some((call) => call.query.status === 'REVIEW'))
    .toBe(true);
});

test('4. 挖掘任务单查/改名/暂停/归档（不可逆）与运行页 result-view + 双语跳过原因', async ({ page }) => {
  const backend = await installMockBackend(page);
  const taskState: Record<string, unknown> = {
    createdAt: NOW,
    createdBy: 'user-e2e',
    icpId: ICP_ID,
    id: TASK_ID,
    lastRunAt: NOW,
    name: '欧洲泵业挖掘任务',
    runCount: 1,
    runs: [
      {
        attempt: 1,
        finishedAt: NOW,
        id: 'tr-1',
        planId: 'plan-1',
        runId: RUN_ID,
        startedAt: NOW,
        status: 'FAILED',
        trigger: 'manual',
      },
    ],
    status: 'active',
    updatedAt: NOW,
  };

  backend.set('GET', `/tasks/${TASK_ID}`, async ({ route }) => {
    await route.fulfill({
      body: JSON.stringify({ data: taskState }),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  });
  backend.set('PATCH', `/tasks/${TASK_ID}`, async ({ body, route }) => {
    const patch = body as { name?: string; status?: string };
    if (patch.name) taskState.name = patch.name;
    if (patch.status) taskState.status = patch.status;
    await route.fulfill({
      body: JSON.stringify({ data: taskState }),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  });
  backend.set('GET', `/discovery-runs/${RUN_ID}`, {
    completedAt: NOW,
    createdAt: NOW,
    icpId: ICP_ID,
    id: RUN_ID,
    planId: 'plan-1',
    stats: { skippedQueries: { source_disabled: 2 } },
    status: 'DONE',
  });
  backend.set('GET', `/discovery-runs/${RUN_ID}/result-view`, {
    candidates: { items: [{ id: 'c-1' }], total: 18, truncated: false },
    completedAt: NOW,
    icpId: ICP_ID,
    runId: RUN_ID,
    scoring: {
      latest: { items: [{ id: 'l-1' }, { id: 'l-2' }], label: 'latest_not_necessarily_this_run' },
      thisRun: {
        available: true,
        batches: 2,
        items: [{ id: 'l-1' }],
        label: 'this_run',
        scoredAt: NOW,
        scoredCompanies: 12,
        truncated: false,
      },
    },
    status: 'DONE',
  });

  await loginAs(page);
  await page.goto(`/tasks/${TASK_ID}`);

  // 单查 GET /tasks/:id，未调用列表 GET /tasks
  await expect(page.getByRole('heading', { level: 1, name: '欧洲泵业挖掘任务' })).toBeVisible();
  expect(backend.callsTo('GET', `/tasks/${TASK_ID}`).length).toBe(1);
  expect(backend.calls.filter((c) => c.method === 'GET' && c.path === '/tasks').length).toBe(0);

  // 行内改名
  await page.locator('[data-gs="task-rename-btn"]').click();
  await page.locator('[data-gs="task-rename-input"]').fill('德国精密泵业 Q4 任务');
  await page.locator('[data-gs="task-rename-save"]').click();
  await expect(page.getByRole('heading', { level: 1, name: '德国精密泵业 Q4 任务' })).toBeVisible();

  // 暂停 -> 恢复
  await page.locator('[data-gs="task-toggle-pause"]').click();
  await expect(page.locator('[data-gs="task-status-badge"]')).toContainText('已暂停');
  await page.locator('[data-gs="task-toggle-pause"]').click();
  await expect(page.locator('[data-gs="task-status-badge"]')).toContainText('进行中');

  // 归档（危险二次确认，归档后不可恢复/暂停/重试）
  await page.locator('[data-gs="task-archive-btn"]').click();
  await expect(page.locator('.ant-modal-confirm')).toBeVisible();
  await page.locator('.ant-modal-confirm-btns button').last().click();
  await expect(page.locator('[data-gs="task-status-badge"]')).toContainText('已归档');
  await expect(page.locator('[data-gs="task-archived-hint"]')).toBeVisible();
  await expect(page.locator('[data-gs="task-toggle-pause"]')).toHaveCount(0);
  await expect(page.locator('[data-gs="task-archive-btn"]')).toHaveCount(0);

  // 运行页 result-view 正常展示且跳过原因来自双语映射
  await page.goto(`/runs/${RUN_ID}`);
  const rv = page.locator('[data-gs="run-result-view"]');
  await expect(rv).toBeVisible();
  await expect(rv).toContainText('18');
  await expect(rv).toContainText('已评分 12 家（2 批）');
});
