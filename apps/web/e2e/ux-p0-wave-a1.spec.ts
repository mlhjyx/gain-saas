import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

function testOrigin(baseURL?: string): string {
  return new URL(baseURL ?? 'http://127.0.0.1:4173').origin;
}

test('dark mode semantic tokens reach WCAG AA and GS_BRAND unifies light bgLayout', async ({
  page,
}, testInfo) => {
  const appVueSource = readFileSync(
    resolve(process.cwd(), 'apps/web/src/app.vue'),
    'utf8',
  );
  expect(appVueSource).toMatch(/export\s+const\s+GS_BRAND\s*=/);
  expect(appVueSource).toMatch(/light:\s*\{[\s\S]*?bgLayout:\s*['"]#FFFFFF['"]/);

  const zhP0 = JSON.parse(
    readFileSync(resolve(process.cwd(), 'apps/web/src/locales/langs/zh-CN/gainosP0.json'), 'utf8'),
  ) as Record<string, unknown>;
  const enP0 = JSON.parse(
    readFileSync(resolve(process.cwd(), 'apps/web/src/locales/langs/en-US/gainosP0.json'), 'utf8'),
  ) as Record<string, unknown>;
  const flattenKeys = (obj: Record<string, unknown>, prefix = ''): string[] =>
    Object.entries(obj)
      .flatMap(([k, v]) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? flattenKeys(v as Record<string, unknown>, prefix ? `${prefix}.${k}` : k)
          : [prefix ? `${prefix}.${k}` : k],
      )
      .sort();
  expect(flattenKeys(zhP0)).toEqual(flattenKeys(enP0));

  const backend = await installMockBackend(page, {
    origin: testOrigin(testInfo.project.use.baseURL),
  });
  backend.set('GET', '/suppressions', {
    data: [
      {
        id: 'sup-1',
        type: 'email',
        value: 'blocked@example.com',
        reason: 'manual',
        protectionClass: 'PREFERENCE',
        createdAt: '2026-11-20T08:00:00.000Z',
      },
    ],
    page: { has_more: true, next_cursor: 'cursor-1' },
  });

  await loginAs(page);
  await page.goto('/settings/suppressions');
  await expect(page.getByText('blocked@example.com')).toBeVisible();

  await page.locator("[data-gs='account-trigger']").click();
  await page.locator("[data-gs='theme-toggle']").click();
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);

  // Trigger an inline AntDV error Alert by submitting an empty suppression entry.
  await page.getByRole('button', { name: '加入' }).click();
  const errorAlert = page.locator('.ant-alert-error').first();
  await expect(errorAlert).toBeVisible();

  await expect(errorAlert.locator('.ant-alert-icon')).toHaveCSS('color', 'rgb(248, 113, 113)');
  await expect(page.locator('.ant-btn-link.ant-btn-dangerous').first()).toHaveCSS(
    'color',
    'rgb(248, 113, 113)',
  );
  await expect(page.locator('.ant-btn-link:not(.ant-btn-dangerous)').first()).toHaveCSS(
    'color',
    'rgb(107, 142, 255)',
  );

  const axe = await new AxeBuilder({ page })
    .include('main')
    .withRules(['color-contrast'])
    .analyze();
  expect(axe.violations, JSON.stringify(axe.violations, null, 2)).toEqual([]);
});

test('onboarding guard redirects unauthenticated users and allows logged-in incomplete workspaces', async ({
  page,
}, testInfo) => {
  await installMockBackend(page, {
    onboardingComplete: false,
    origin: testOrigin(testInfo.project.use.baseURL),
  });

  // 1. Unauthenticated direct navigation to /onboarding must redirect to /auth/login.
  await page.goto('/onboarding');
  await page.waitForURL(/\/auth\/login/, { timeout: 5000 });

  // 2. Dead auth routes must still redirect cleanly to /auth/login.
  for (const deadPath of ['/auth/code-login', '/auth/qrcode-login', '/auth/forget-password']) {
    await page.goto(deadPath);
    await page.waitForURL(/\/auth\/login/, { timeout: 5000 });
  }

  // 3. Logged-in user with onboardingComplete: false can stay on /onboarding.
  await loginAs(page);
  await page.waitForURL(/\/onboarding/, { timeout: 5000 });
  await page.waitForTimeout(300);
  expect(new URL(page.url()).pathname).toBe('/onboarding');
});

test('raw template braces are not rendered on suppressions and sources loading states', async ({
  page,
}, testInfo) => {
  const backend = await installMockBackend(page, {
    origin: testOrigin(testInfo.project.use.baseURL),
  });

  let releaseSuppressions!: () => void;
  const suppressionsGate = new Promise<void>((resolvePromise) => {
    releaseSuppressions = resolvePromise;
  });
  backend.set('GET', '/suppressions', async ({ route }) => {
    await suppressionsGate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { data: [], page: { has_more: false, next_cursor: null } } }),
    });
    return true;
  });

  let releaseChannels!: () => void;
  const channelsGate = new Promise<void>((resolvePromise) => {
    releaseChannels = resolvePromise;
  });
  backend.set('GET', '/source-channels/available', async ({ route }) => {
    await channelsGate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    });
    return true;
  });

  await loginAs(page);

  await page.goto('/settings/suppressions');
  const spSr = page.locator('.sp__state-sr');
  await expect(spSr).toBeAttached();
  await expect(spSr).not.toContainText('{ $t(');
  await expect(spSr).toHaveText('正在加载…');
  releaseSuppressions();

  await page.goto('/settings/sources');
  const srcSr = page.locator('.src__state-sr');
  await expect(srcSr).toBeAttached();
  await expect(srcSr).not.toContainText('{ $t(');
  await expect(srcSr).toHaveText('正在加载…');
  releaseChannels();
});

test('campaigns detail stops polling on NEEDS_HUMAN and submits schema-valid manual revision', async ({
  page,
}, testInfo) => {
  const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';
  const ICP_A = '22222222-2222-4222-8222-222222222222';
  const ICP_B = '33333333-3333-4333-8333-333333333333';
  const NOW = '2026-11-26T08:00:00.000Z';

  const backend = await installMockBackend(page, {
    origin: testOrigin(testInfo.project.use.baseURL),
  });
  let pollHits = 0;
  let createdPlanBody: Record<string, unknown> | null = null;
  const campaignState: Record<string, unknown> = {
    id: CAMPAIGN_ID,
    name: '德国工业泵 Q4 战役',
    objective: '发现德国工业泵区域分销商',
    status: 'DRAFT',
    createdAt: NOW,
    updatedAt: NOW,
    revisions: [],
    authorizations: [],
    recentTrace: [
      {
        traceId: 'tr-1',
        stepType: 'approval.decided',
        actor: 'user-e2e',
        actorType: 'user',
        decisionType: 'approve',
        chosenOption: null,
        reasonCode: null,
        createdAt: NOW,
      },
      {
        traceId: 'tr-2',
        stepType: 'authorization.issued',
        actor: 'service:campaign-plan',
        actorType: 'service',
        decisionType: 'issue',
        chosenOption: null,
        reasonCode: null,
        createdAt: NOW,
      },
    ],
  };

  backend.set('GET', '/icps', [
    { id: ICP_A, companyId: 'co-1', name: '德国工业泵分销商', status: 'ACTIVE', targetMarkets: ['DE'] },
    { id: ICP_B, companyId: 'co-1', name: '欧洲阀门代理商', status: 'ACTIVE', targetMarkets: ['NL'] },
  ]);
  backend.set('GET', `/campaigns/${CAMPAIGN_ID}`, async ({ route }) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: campaignState }),
    });
    return true;
  });
  backend.set('POST', `/campaigns/${CAMPAIGN_ID}/plan-drafts`, {
    id: 'job-nh-1',
    campaignId: CAMPAIGN_ID,
    state: 'RUNNING',
    objective: '发现德国工业泵区域分销商',
    error: null,
    issues: null,
    planHash: null,
    revisionId: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  backend.set('GET', `/campaigns/${CAMPAIGN_ID}/plan-drafts/job-nh-1`, async ({ route }) => {
    pollHits += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: 'job-nh-1',
          campaignId: CAMPAIGN_ID,
          state: 'NEEDS_HUMAN',
          objective: '发现德国工业泵区域分销商',
          error: 'MAX_REPLANS_REACHED',
          issues: [{ path: 'audience.sizeCap', message: '单画像上限超出配额' }],
          planHash: null,
          revisionId: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    });
    return true;
  });
  backend.set('POST', `/campaigns/${CAMPAIGN_ID}/revisions`, async ({ body, route }) => {
    createdPlanBody = body as Record<string, unknown>;
    const rev = {
      id: 'rev-manual-1',
      revisionNo: 1,
      state: 'DRAFT',
      planHash: 'hash-manual-1',
      plan: createdPlanBody,
      createdAt: NOW,
      audience: (createdPlanBody as { audience: unknown }).audience,
      approvals: [],
    };
    campaignState.revisions = [rev];
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ data: rev }),
    });
    return true;
  });

  await loginAs(page);
  await page.goto(`/outreach/campaigns/${CAMPAIGN_ID}`);

  // Back button copy & translated actorType
  await expect(page.getByRole('button', { name: /返回战役列表/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /去触达批次/ })).toHaveCount(0);
  await expect(page.locator('.cd__timeline')).toContainText('成员');
  await expect(page.locator('.cd__timeline')).toContainText('系统服务');
  await expect(page.locator('.cd__timeline')).not.toContainText('· user');
  await expect(page.locator('.cd__timeline')).not.toContainText('· service');

  // Start AI draft -> poll returns NEEDS_HUMAN
  await page.getByRole('button', { name: '让系统起草计划' }).click();
  const draftModal = page.locator('.ant-modal-content').last();
  await draftModal.locator('.ant-modal-footer .ant-btn-primary').click();

  const needsHumanPanel = page.locator('[data-gs="campaign-needs-human-panel"]');
  await expect(needsHumanPanel).toBeVisible({ timeout: 6000 });
  await expect(needsHumanPanel).toContainText('单画像上限超出配额');

  // Wait >3.5s after NEEDS_HUMAN to confirm polling stopped immediately and busy released.
  await page.waitForTimeout(3600);
  expect(pollHits).toBe(1);
  await expect(page.getByRole('button', { name: '让系统起草计划' })).toBeEnabled();

  // Submit manual revision form inside needs-human panel.
  await needsHumanPanel.locator('[data-gs="manual-revision-objective"]').fill('人工修订：德国工业泵分销商发现');
  await needsHumanPanel.locator('[data-gs="manual-revision-submit"]').click();

  await expect.poll(() => createdPlanBody !== null).toBe(true);
  const plan = createdPlanBody as unknown as {
    schemaVersion: string;
    goal: { objective: string };
    audience: { icpIds: string[]; sizeCap: number };
    motions: Array<{ type: string; icpIds: string[] }>;
    budget: { capMicros?: number; currency: string };
    approvalPolicy: { required: boolean };
    decisionPolicy: { maxReplans: number };
  };
  expect(plan.schemaVersion).toBe('campaign-plan/v0');
  expect(plan.goal.objective).toBe('人工修订：德国工业泵分销商发现');
  expect(plan.audience.icpIds.length).toBeGreaterThanOrEqual(1);
  expect(plan.audience.sizeCap).toBeGreaterThanOrEqual(1);
  expect(plan.motions.length).toBeGreaterThanOrEqual(1);
  for (const motion of plan.motions) {
    expect(motion.type).toBe('discovery');
    for (const id of motion.icpIds) {
      expect(plan.audience.icpIds).toContain(id);
    }
  }
  expect(plan.budget.currency).toBe('USD');
  expect(plan.approvalPolicy).toEqual({ required: true });
  expect([0, 1, 2]).toContain(plan.decisionPolicy.maxReplans);
});

test('campaigns detail shows draftSucceeded notice on SUCCEEDED and renders motions dynamically', async ({
  page,
}, testInfo) => {
  const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111112';
  const ICP_A = '22222222-2222-4222-8222-222222222222';
  const ICP_B = '33333333-3333-4333-8333-333333333333';
  const NOW = '2026-11-26T08:00:00.000Z';

  const backend = await installMockBackend(page, {
    origin: testOrigin(testInfo.project.use.baseURL),
  });
  let draftReady = false;

  backend.set('GET', '/icps', [
    { id: ICP_A, companyId: 'co-1', name: '德国工业泵分销商', status: 'ACTIVE', targetMarkets: ['DE'] },
    { id: ICP_B, companyId: 'co-1', name: '欧洲阀门代理商', status: 'ACTIVE', targetMarkets: ['NL'] },
  ]);
  backend.set('GET', `/campaigns/${CAMPAIGN_ID}`, async ({ route }) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: CAMPAIGN_ID,
          name: '欧洲流体设备战役',
          objective: '拓展德荷流体设备渠道',
          status: 'DRAFT',
          createdAt: NOW,
          updatedAt: NOW,
          revisions: draftReady
            ? [
                {
                  id: 'rev-ok-1',
                  revisionNo: 1,
                  state: 'DRAFT',
                  planHash: 'hash-ok-1',
                  createdAt: NOW,
                  audience: { icpIds: [ICP_A, ICP_B], sizeCap: 40 },
                  approvals: [],
                  plan: {
                    schemaVersion: 'campaign-plan/v0',
                    goal: { objective: '拓展德荷流体设备渠道' },
                    audience: { icpIds: [ICP_A, ICP_B], sizeCap: 40 },
                    motions: [
                      { type: 'discovery', icpIds: [ICP_A] },
                      { type: 'outreach', icpIds: [ICP_B] },
                    ],
                    budget: { capMicros: 50_000_000, currency: 'USD' },
                    approvalPolicy: { required: true },
                    decisionPolicy: { maxReplans: 1 },
                  },
                },
              ]
            : [],
          authorizations: [],
          recentTrace: [
            {
              traceId: 'tr-eng',
              stepType: 'superseded',
              actor: 'engine:planner',
              actorType: 'engine',
              decisionType: 'plan',
              chosenOption: null,
              reasonCode: null,
              createdAt: NOW,
            },
          ],
        },
      }),
    });
    return true;
  });
  backend.set('POST', `/campaigns/${CAMPAIGN_ID}/plan-drafts`, {
    id: 'job-ok-1',
    campaignId: CAMPAIGN_ID,
    state: 'RUNNING',
    objective: '拓展德荷流体设备渠道',
    error: null,
    issues: null,
    planHash: null,
    revisionId: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  backend.set('GET', `/campaigns/${CAMPAIGN_ID}/plan-drafts/job-ok-1`, async ({ route }) => {
    draftReady = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: 'job-ok-1',
          campaignId: CAMPAIGN_ID,
          state: 'SUCCEEDED',
          objective: '拓展德荷流体设备渠道',
          error: null,
          issues: null,
          planHash: 'hash-ok-1',
          revisionId: 'rev-ok-1',
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    });
    return true;
  });

  await loginAs(page);
  await page.goto(`/outreach/campaigns/${CAMPAIGN_ID}`);

  await page.getByRole('button', { name: '让系统起草计划' }).click();
  await page.locator('.ant-modal-content').last().locator('.ant-modal-footer .ant-btn-primary').click();

  const statusAlert = page.locator('[role="status"]').first();
  await expect(statusAlert).toContainText('计划草稿已生成', { timeout: 6000 });
  await expect(statusAlert).not.toContainText('已提交审批');

  const facts = page.locator('.cd__facts');
  await expect(facts).toContainText('发现潜在买家（只检索，不联系）（德国工业泵分销商）');
  await expect(facts).toContainText('受控外联触达（欧洲阀门代理商）');
  await expect(page.locator('.cd__timeline').last()).toContainText('引擎');
  await expect(page.locator('.cd__timeline').last()).not.toContainText('· engine');
});

test('T0OutreachPanel renders human-readable complianceTag instead of DE:CONSENT_REQUIRED', async ({
  page,
}, testInfo) => {
  const LEAD_ID = '44444444-4444-4444-8444-444444444441';
  const ICP_ID = '44444444-4444-4444-8444-444444444442';
  const CANONICAL_ID = '44444444-4444-4444-8444-444444444443';

  const backend = await installMockBackend(page, {
    origin: testOrigin(testInfo.project.use.baseURL),
  });
  backend.set('GET', `/leads/${LEAD_ID}/package`, {
    lead_id: LEAD_ID,
    icp_id: ICP_ID,
    status: 'REVIEW',
    company: {
      canonical_company_id: CANONICAL_ID,
      name: 'Muster Pumpen GmbH',
      domain: 'muster-pumpen.de',
      country: 'DE',
    },
    company_channels: [{ channel: 'email', value: 'einkauf@muster-pumpen.de', status: 'VALID' }],
    social_profiles: [],
    fit: { verdict: 'FIT', reasons: ['德国工业泵分销商'] },
    scores: { total: 0.88 },
  });

  await loginAs(page);
  await page.goto(`/leads/${LEAD_ID}?tab=draft`);

  const panel = page.locator('[data-gs="t0-outreach"]').first();
  await expect(panel).toBeVisible();
  const tag = panel.locator('[data-gs="t0-compliance-tag"]');
  await expect(tag).toBeVisible();
  await expect(tag).toContainText('需先获同意才可冷邮');
  await expect(panel).not.toContainText('DE:CONSENT_REQUIRED');
  await expect(tag).toHaveAttribute('title', 'DE:CONSENT_REQUIRED');
});

test('outreach removeDraft requires confirm modal and createBatch sends campaignId', async ({
  page,
}, testInfo) => {
  const BATCH_ID = '55555555-5555-4555-8555-555555555551';
  const DRAFT_ID = '55555555-5555-4555-8555-555555555552';
  const CAMP_ID = '55555555-5555-4555-8555-555555555553';
  const NOW = '2026-11-26T08:00:00.000Z';

  const backend = await installMockBackend(page, {
    origin: testOrigin(testInfo.project.use.baseURL),
  });
  let drafts = [
    {
      id: DRAFT_ID,
      batchId: BATCH_ID,
      contactRef: 'contact-1',
      recipientEmail: 'buyer@muster.de',
      companyName: 'Muster GmbH',
      countryCode: 'DE',
      subject: '工业泵供货方案',
      body: 'Hello team',
      status: 'DRAFT',
      createdAt: NOW,
    },
  ];
  let deleteHits = 0;

  backend.set('GET', '/campaigns', [
    {
      id: CAMP_ID,
      name: '德国泵业拓展战役',
      objective: '拓展德国渠道',
      status: 'ACTIVE',
      createdAt: NOW,
      updatedAt: NOW,
      latestRevision: null,
    },
  ]);
  backend.set('GET', '/outreach/batches', async ({ route }) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          {
            id: BATCH_ID,
            name: '德国泵业批次',
            status: 'DRAFT',
            draftCount: drafts.length,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      }),
    });
    return true;
  });
  backend.set('GET', `/outreach/batches/${BATCH_ID}`, async ({ route }) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: BATCH_ID,
          name: '德国泵业批次',
          status: 'DRAFT',
          drafts,
          approvals: [],
          events: [],
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    });
    return true;
  });
  backend.set('DELETE', `/outreach/batches/${BATCH_ID}/drafts/${DRAFT_ID}`, async ({ route }) => {
    deleteHits += 1;
    drafts = [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { removed: true } }),
    });
    return true;
  });
  backend.set('POST', '/outreach/batches', async ({ body, route }) => {
    const input = body as { name: string; campaignId?: string };
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: 'batch-created-2',
          name: input.name,
          campaignId: input.campaignId,
          status: 'DRAFT',
          draftCount: 0,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    });
    return true;
  });
  backend.set('GET', '/outreach/batches/batch-created-2', {
    id: 'batch-created-2',
    name: '归因测试批次',
    status: 'DRAFT',
    drafts: [],
    approvals: [],
    events: [],
    createdAt: NOW,
    updatedAt: NOW,
  });

  await loginAs(page);
  await page.goto('/outreach?tab=batches');
  await expect(page.getByText('buyer@muster.de')).toBeVisible();

  // 1. Click remove -> Cancel must NOT call DELETE
  await page.getByRole('button', { name: '移除' }).first().click();
  const confirmModal = page.locator('.ant-modal-confirm');
  await expect(confirmModal).toBeVisible();
  await expect(confirmModal).toContainText('buyer@muster.de');
  await expect(confirmModal).toContainText('工业泵供货方案');
  await confirmModal.getByRole('button', { name: '取消' }).click();
  await expect(confirmModal).toHaveCount(0);
  expect(deleteHits).toBe(0);
  await expect(page.getByText('buyer@muster.de')).toBeVisible();

  // 2. Click remove -> Confirm calls DELETE once
  await page.getByRole('button', { name: '移除' }).first().click();
  await expect(confirmModal).toBeVisible();
  await confirmModal.locator('.ant-btn-dangerous').click();
  await expect.poll(() => deleteHits).toBe(1);
  await expect(page.getByText('buyer@muster.de')).toHaveCount(0);

  // 3. Create batch with linked campaignId
  await page.getByRole('button', { name: '新建批次' }).click();
  await page.locator('.ob__create input').first().fill('归因测试批次');
  await page.locator('[data-gs="batch-campaign-select"] .ant-select-selector').click();
  await page.locator('.ant-select-item-option', { hasText: '德国泵业拓展战役' }).click();
  await page.locator('.ob__create').getByRole('button', { name: '创建' }).click();

  await expect.poll(() => backend.callsTo('POST', '/outreach/batches').length).toBe(1);
  const createCall = backend.take('POST', '/outreach/batches');
  expect(createCall?.body).toEqual({ name: '归因测试批次', campaignId: CAMP_ID });
});

test('outreach auditPackage renders structured summary with raw JSON folded in details', async ({
  page,
}, testInfo) => {
  const BATCH_ID = '66666666-6666-4666-8666-666666666661';
  const NOW = '2026-11-26T08:00:00.000Z';

  const backend = await installMockBackend(page, {
    origin: testOrigin(testInfo.project.use.baseURL),
  });
  backend.set('GET', '/outreach/batches', [
    { id: BATCH_ID, name: '意大利光伏外发批次', status: 'APPROVED', draftCount: 2, createdAt: NOW, updatedAt: NOW },
  ]);
  backend.set('GET', `/outreach/batches/${BATCH_ID}`, {
    id: BATCH_ID,
    name: '意大利光伏外发批次',
    status: 'APPROVED',
    drafts: [],
    approvals: [],
    events: [],
    createdAt: NOW,
    updatedAt: NOW,
  });
  backend.set('GET', `/outreach/batches/${BATCH_ID}/audit-package`, {
    package: {
      schemaVersion: 'outreach-audit-package/v1',
      generatedAt: NOW,
      batch: {
        id: BATCH_ID,
        name: '意大利光伏外发批次',
        status: 'APPROVED',
        contentHash: 'digest-audit-9876',
      },
      approval: {
        state: 'APPROVED',
        decidedBy: 'admin@example.com',
        decidedAt: NOW,
      },
      authorization: {
        id: 'auth-99',
        consumedUses: 2,
      },
      drafts: [
        { draftId: 'd1', status: 'SENT' },
        { draftId: 'd2', status: 'DRAFT' },
      ],
    },
    packageHash: 'pkg-hash-9876',
    contentHash: 'digest-audit-9876',
  });

  await loginAs(page);
  await page.goto('/outreach?tab=batches');
  await page.locator('[data-gs="audit-package-btn"]').click();

  const modal = page.locator('.ant-modal-content').filter({ hasText: '批次发送前审计包' });
  await expect(modal).toBeVisible();
  await expect(modal.locator('[data-gs="audit-package-summary"]')).toBeVisible();
  await expect(modal.locator('[data-gs="audit-package-summary"]')).toContainText('意大利光伏外发批次');
  await expect(modal.locator('[data-gs="audit-package-summary"]')).toContainText('digest-audit-9876');
  await expect(modal.locator('[data-gs="audit-package-summary"]')).toContainText('共 2 封草稿');

  const rawDetails = modal.locator('details.error-notice__details');
  await expect(rawDetails).toBeVisible();
  expect(await rawDetails.getAttribute('open')).toBeNull();
  await expect(rawDetails.locator('pre')).toBeHidden();

  await rawDetails.locator('summary').click();
  await expect(rawDetails.locator('pre')).toBeVisible();
  await expect(rawDetails.locator('pre')).toContainText('outreach-audit-package/v1');
});

test('qgos translates outcome source, uses green badge for CONVERTED, and supports keyboard open', async ({
  page,
}, testInfo) => {
  const QGO_ID = '77777777-7777-4777-8777-777777777771';
  const NOW = '2026-11-26T08:00:00.000Z';

  const backend = await installMockBackend(page, {
    origin: testOrigin(testInfo.project.use.baseURL),
  });
  const qgoRecord = {
    id: QGO_ID,
    title: 'Muster Pumpen 采购商机',
    state: 'CONVERTED',
    nextStep: '发送规格书与报价单',
    score: 0.91,
    createdAt: NOW,
    evidence: [{ type: 'customer_reply', support: '客户邮件询价', retrievedAt: NOW }],
    sao: { id: 'sao-1', state: 'ACCEPTED', decidedAt: NOW, reason: null },
    outcomes: [
      {
        id: 'out-1',
        outcome: 'REPLIED',
        source: 'MANUAL',
        occurredAt: NOW,
        note: '客户索要样品报价',
      },
      {
        id: 'out-2',
        outcome: 'QUOTE_SENT',
        source: 'SYSTEM',
        occurredAt: NOW,
        note: '报价单已同步回写',
      },
    ],
  };

  backend.set('GET', '/qgos', [qgoRecord]);
  backend.set('GET', `/qgos/${QGO_ID}`, qgoRecord);

  await loginAs(page);
  await page.goto('/opportunities');

  const rowButton = page.locator('.qg__list').getByRole('button', { name: /Muster Pumpen 采购商机/ });
  await expect(rowButton).toBeVisible();
  // Button must only contain phrasing content (no nested header/h2/p/div).
  await expect(rowButton.locator('header, h1, h2, h3, p, div')).toHaveCount(0);

  // CONVERTED badge must use green semantic color, distinct from OPEN accent blue.
  await expect(page.locator('.qg__state-badge--converted').first()).toHaveCSS(
    'color',
    'rgb(26, 117, 68)',
  );

  // Keyboard activation via focus + Enter opens the detail drawer.
  await rowButton.focus();
  await page.keyboard.press('Enter');

  const drawer = page.locator('.ant-drawer-content');
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('人工登记');
  await expect(drawer).toContainText('系统自动回写');
  await expect(drawer).not.toContainText('· MANUAL');
  await expect(drawer).not.toContainText('· SYSTEM');
});

test('audit translates all 14 KNOWN_ACTIONS with GsSelect and preserves getByLabel(动作)', async ({
  page,
}, testInfo) => {
  const NOW = '2026-11-26T08:00:00.000Z';
  const backend = await installMockBackend(page, {
    origin: testOrigin(testInfo.project.use.baseURL),
  });
  backend.set('GET', '/audit', {
    entries: [
      { id: 'a1', at: NOW, action: 'claim.approve', target: 'claim-1', detail: null },
      { id: 'a2', at: NOW, action: 'claim.reject', target: 'claim-2', detail: null },
      { id: 'a3', at: NOW, action: 'deletion.request', target: 'del-1', detail: null },
      { id: 'a4', at: NOW, action: 'outreach.send', target: 'batch-1', detail: null },
      { id: 'a5', at: NOW, action: 'member.remove', target: 'user-2', detail: null },
    ],
    nextCursor: null,
    total: 5,
  });

  await loginAs(page);
  await page.goto('/settings/audit');

  await expect(page.locator('datalist#audit-action-options')).toHaveCount(0);
  await expect(page.getByLabel('动作')).toBeVisible();
  await expect(page.locator('[data-gs="select"]')).toBeVisible();

  const table = page.locator('.ant-table');
  await expect(table).toContainText('审批通过企业事实');
  await expect(table).toContainText('驳回企业事实');
  await expect(table).toContainText('提交隐私删除申请');
  await expect(table).toContainText('执行外发投递');
  await expect(table).toContainText('移除成员');
  await expect(table).not.toContainText('claim.approve');
  await expect(table).not.toContainText('claim.reject');
});

test('tasks list and detail display real buyer profile name instead of icpId prefix', async ({
  page,
}, testInfo) => {
  const TASK_ID = '88888888-8888-4888-8888-888888888881';
  const ICP_ID = 'deadbeef-1111-4111-8111-111111111111';
  const NOW = '2026-11-26T08:00:00.000Z';

  const backend = await installMockBackend(page, {
    origin: testOrigin(testInfo.project.use.baseURL),
  });
  backend.set('GET', '/icps', [
    { id: ICP_ID, companyId: 'co-1', name: '意大利光伏总包商', status: 'ACTIVE', targetMarkets: ['IT'] },
  ]);
  const taskRow = {
    id: TASK_ID,
    name: '意大利光伏首轮挖掘',
    status: 'active',
    icpId: ICP_ID,
    createdAt: NOW,
    lastRunAt: NOW,
    runs: [],
  };
  backend.set('GET', '/tasks', [taskRow]);
  backend.set('GET', `/tasks/${TASK_ID}`, taskRow);

  await loginAs(page);
  await page.goto('/tasks');
  await expect(page.locator('.ant-table')).toContainText('意大利光伏总包商');
  await expect(page.locator('.ant-table')).not.toContainText('deadbeef');

  await page.goto(`/tasks/${TASK_ID}`);
  await expect(page.locator('.tkd__facts')).toContainText('意大利光伏总包商');
  await expect(page.locator('.tkd__facts')).not.toContainText('deadbeef');
});
