import { expect, test } from '@playwright/test';

import { errorPayload, installMockBackend, loginAs, type MockBackend } from './support/mock-backend';

const NOW = '2026-11-26T08:00:00.000Z';
const CAMPAIGN_DRAFT_ID = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN_PENDING_ID = '11111111-1111-4111-8111-111111111112';
const ICP_ID = '22222222-2222-4222-8222-222222222222';
const LEAD_ID = '33333333-3333-4333-8333-333333333333';
const CANONICAL_ID = '44444444-4444-4444-8444-444444444444';
const CONTACT_ID = '55555555-5555-4555-8555-555555555555';
const BATCH_DRAFT_ID = '66666666-6666-4666-8666-666666666666';
const BATCH_APPROVED_ID = '66666666-6666-4666-8666-666666666667';
const BATCH_PENDING_ID = '66666666-6666-4666-8666-666666666668';
const REPLY_ID = '88888888-8888-4888-8888-888888888888';

const ADMIN_ALLOWED_ACTIONS = [
  'workspace.rename',
  'workspace.leave',
  'members.manage',
  'company.manage',
  'acquisition.run',
  'leads.review',
  'qgo.manage',
  't0.outreach',
  'campaigns.view',
  'campaigns.draft',
  'campaigns.manage',
  'campaigns.approve',
  'outreach.view',
  'outreach.draft',
  'outreach.manage',
  'outreach.approve',
  'outreach.send',
  'outreach.warmup.view',
  'settings.manage',
  'audit.view',
  'onboarding.complete',
];

const MEMBER_ALLOWED_ACTIONS = [
  'workspace.leave',
  'acquisition.run',
  'leads.review',
  'qgo.manage',
  't0.outreach',
  'campaigns.view',
  'outreach.view',
];

function resolveOrigin(baseURL?: string): string {
  return new URL(baseURL ?? 'http://127.0.0.1:4173').origin;
}

function seedCampaignsAndOutreachFixtures(backend: MockBackend, role: 'admin' | 'member'): void {
  backend.set('GET', '/workspace/context', {
    user: backend.session.user,
    workspace: { ...backend.session.workspaces[0], role },
    onboarding: { complete: true, companyId: null },
    allowedActions: role === 'admin' ? ADMIN_ALLOWED_ACTIONS : MEMBER_ALLOWED_ACTIONS,
  });

  backend.set('GET', '/icps', [
    { id: ICP_ID, companyId: 'co-1', name: '德国工业泵分销商', status: 'ACTIVE', targetMarkets: ['DE'] },
  ]);

  const samplePlan = {
    schemaVersion: 'campaign-plan/v0',
    goal: { objective: '拓展德国工业泵分销渠道' },
    audience: { icpIds: [ICP_ID], sizeCap: 40 },
    motions: [{ type: 'discovery', icpIds: [ICP_ID] }],
    budget: { capMicros: 50_000_000, currency: 'USD' },
    approvalPolicy: { required: true },
    decisionPolicy: { maxReplans: 1 },
  };

  backend.set('GET', '/campaigns', [
    {
      id: CAMPAIGN_DRAFT_ID,
      name: '德国工业泵 Q4 战役',
      objective: '拓展德国工业泵分销渠道',
      status: 'DRAFT',
      updatedAt: NOW,
      latestRevision: { revisionNo: 1, state: 'DRAFT' },
    },
    {
      id: CAMPAIGN_PENDING_ID,
      name: '意大利光伏 Q4 审批中战役',
      objective: '待审批战役计划',
      status: 'DRAFT',
      updatedAt: NOW,
      latestRevision: { revisionNo: 2, state: 'SUBMITTED' },
    },
  ]);

  backend.set('GET', `/campaigns/${CAMPAIGN_DRAFT_ID}`, {
    id: CAMPAIGN_DRAFT_ID,
    name: '德国工业泵 Q4 战役',
    objective: '拓展德国工业泵分销渠道',
    status: 'DRAFT',
    createdAt: NOW,
    updatedAt: NOW,
    revisions: [
      {
        id: 'rev-draft-1',
        revisionNo: 1,
        state: 'DRAFT',
        planHash: 'hash-draft-1',
        createdAt: NOW,
        audience: samplePlan.audience,
        plan: samplePlan,
        approvals: [],
      },
    ],
    authorizations: [],
    recentTrace: [],
  });

  backend.set('GET', `/campaigns/${CAMPAIGN_PENDING_ID}`, {
    id: CAMPAIGN_PENDING_ID,
    name: '意大利光伏 Q4 审批中战役',
    objective: '待审批战役计划',
    status: 'DRAFT',
    createdAt: NOW,
    updatedAt: NOW,
    revisions: [
      {
        id: 'rev-sub-1',
        revisionNo: 2,
        state: 'SUBMITTED',
        planHash: 'hash-sub-1',
        createdAt: NOW,
        audience: samplePlan.audience,
        plan: samplePlan,
        approvals: [{ id: 'app-1', state: 'PENDING', expiresAt: NOW }],
      },
    ],
    authorizations: [],
    recentTrace: [],
  });

  backend.set('GET', '/outreach/t1/readiness', {
    sendEnabled: true,
    shadowMode: false,
    smtpConfigured: true,
    fromDomain: 'mail.acme.example',
  });

  const draftRow = {
    id: 'draft-1',
    batchId: BATCH_DRAFT_ID,
    contactRef: CONTACT_ID,
    recipientEmail: 'buyer@nordicpump.de',
    companyName: 'Nordic Pump GmbH',
    countryCode: 'DE',
    subject: 'Industrial Pump Supply',
    body: 'Hello Nordic Pump team',
    status: 'DRAFT',
    createdAt: NOW,
  };

  backend.set('GET', '/outreach/batches', [
    {
      id: BATCH_DRAFT_ID,
      name: '德国泵业首批外发',
      status: 'DRAFT',
      draftCount: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: BATCH_APPROVED_ID,
      name: '意大利光伏已批准批次',
      status: 'APPROVED',
      draftCount: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: BATCH_PENDING_ID,
      name: '法国暖通待审批批次',
      status: 'PENDING_APPROVAL',
      draftCount: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]);

  backend.set('GET', `/outreach/batches/${BATCH_DRAFT_ID}`, {
    id: BATCH_DRAFT_ID,
    name: '德国泵业首批外发',
    status: 'DRAFT',
    drafts: [draftRow],
    approvals: [],
    events: [{ id: 'ev-1', type: 'BATCH_CREATED', actor: 'user-e2e', createdAt: NOW }],
    createdAt: NOW,
    updatedAt: NOW,
  });

  backend.set('GET', `/outreach/batches/${BATCH_APPROVED_ID}`, {
    id: BATCH_APPROVED_ID,
    name: '意大利光伏已批准批次',
    status: 'APPROVED',
    drafts: [{ ...draftRow, id: 'draft-2', batchId: BATCH_APPROVED_ID }],
    approvals: [{ id: 'oa-approved', state: 'APPROVED', decidedAt: NOW }],
    events: [{ id: 'ev-2', type: 'BATCH_APPROVED', actor: 'user-e2e', createdAt: NOW }],
    createdAt: NOW,
    updatedAt: NOW,
  });

  backend.set('GET', `/outreach/batches/${BATCH_PENDING_ID}`, {
    id: BATCH_PENDING_ID,
    name: '法国暖通待审批批次',
    status: 'PENDING_APPROVAL',
    drafts: [{ ...draftRow, id: 'draft-3', batchId: BATCH_PENDING_ID }],
    approvals: [{ id: 'oa-pending', state: 'PENDING', expiresAt: NOW }],
    events: [{ id: 'ev-3', type: 'BATCH_SUBMITTED', actor: 'user-e2e', createdAt: NOW }],
    createdAt: NOW,
    updatedAt: NOW,
  });

  backend.set('GET', `/outreach/batches/${BATCH_APPROVED_ID}/audit-package`, {
    batchId: BATCH_APPROVED_ID,
    contentHash: 'digest-approved-001',
    draftsCount: 1,
    package: {
      batch: { name: '意大利光伏已批准批次', status: 'APPROVED' },
      approval: { state: 'APPROVED', decidedAt: NOW },
      drafts: [{ status: 'DRAFT' }],
      generatedAt: NOW,
    },
  });

  backend.set('POST', '/outreach/t1/dns-check', {
    report: {
      domain: 'mail.acme.example',
      mx: [{ exchange: 'smtp.google.com', priority: 1 }],
      spf: { present: true, record: 'v=spf1 include:_spf.google.com ~all', qualifier: '~all' },
      dmarc: { present: true, record: 'v=DMARC1; p=quarantine', policy: 'quarantine', pct: 100, hasRua: true },
      dkim: { present: true, selector: 'google' },
      ok: { spf: true, dmarc: true, dkim: true, mx: true },
      ready: true,
    },
    advice: {
      score: 4,
      ready: true,
      items: [
        { key: 'spf', ok: true, severity: 'ok', adviceCode: 'SPF_OK' },
        { key: 'dkim', ok: true, severity: 'ok', adviceCode: 'DKIM_OK' },
        { key: 'dmarc', ok: true, severity: 'ok', adviceCode: 'DMARC_OK' },
        { key: 'mx', ok: true, severity: 'ok', adviceCode: 'MX_OK' },
      ],
    },
    template: 'mail.acme.example. TXT "v=spf1 include:_spf.google.com ~all"',
  });

  backend.set('GET', '/outreach/health', {
    breakers: [
      {
        id: 'brk-1',
        scope: 'domain',
        scopeRef: 'mail.acme.example',
        state: 'OPEN',
        reason: 'BOUNCE_RATE',
        openedAt: NOW,
      },
      {
        id: 'brk-2',
        scope: 'domain',
        scopeRef: 'eu.acme.example',
        state: 'HALF_OPEN',
        reason: 'RECOVERING',
        openedAt: NOW,
      },
    ],
    events: [],
  });

  if (role === 'member') {
    // Mirror real AdminGuard on OutreachWarmupController: GET /outreach/warmup/checklist returns 403 for member.
    backend.set('GET', '/outreach/warmup/checklist', async ({ route }) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify(errorPayload('ADMIN_REQUIRED', { title: '仅工作空间管理员可操作' })),
      });
      return true;
    });
  } else {
    backend.set('GET', '/outreach/warmup/checklist', {
      generatedAt: NOW,
      windowDays: 7,
      thresholds: { inboxPctMin: 80, spamPctMax: 10 },
      domains: [
        {
          domain: 'mail.acme.example',
          domainState: 'ACTIVE',
          mailboxes: [
            {
              address: 'sales@mail.acme.example',
              state: 'ACTIVE',
              warmupStage: 'W2',
              dailyCap: 20,
              weeklyCap: 100,
              dailySent: 5,
              weeklySent: 20,
              dailyRemaining: 15,
              weeklyRemaining: 80,
            },
          ],
          lastSeedTest: { testedAt: NOW, provider: 'glockapps', inboxPct: 94, spamPct: 1 },
          checks: { seedFresh: true, inboxOk: true, spamOk: true, mailboxesOk: true, ok: true },
        },
      ],
    });
  }

  backend.set('GET', '/outreach/templates', [
    {
      id: 'tpl-draft',
      kind: 'email_first',
      jurisdiction: 'DE',
      language: 'en',
      version: 1,
      subject: 'Pump Intro Draft',
      body: 'Hello',
      bodyHash: 'a'.repeat(64),
      state: 'DRAFT',
    },
    {
      id: 'tpl-approved',
      kind: 'email_followup',
      jurisdiction: 'IT',
      language: 'en',
      version: 1,
      subject: 'PV Followup Approved',
      body: 'Follow up',
      bodyHash: 'b'.repeat(64),
      state: 'APPROVED',
    },
    {
      id: 'tpl-active',
      kind: 'email_first',
      jurisdiction: 'ALL',
      language: 'en',
      version: 2,
      subject: 'Global Active Template',
      body: 'Active body',
      bodyHash: 'c'.repeat(64),
      state: 'ACTIVE',
    },
  ]);
  backend.set('GET', '/outreach/legal-reviews', []);

  backend.set('GET', '/outreach/t1/sequences', [
    {
      id: 'seq-1',
      contactRef: CONTACT_ID,
      recipientMasked: 'b***@nordicpump.de',
      companyName: 'Nordic Pump GmbH',
      countryCode: 'DE',
      subject: 'Pump 4-Round Followup',
      createdAt: NOW,
      plan: {
        rounds: 4,
        jurisdictionPolicy: 'CONSENT_REQUIRED',
        stopped: false,
        stopReason: null,
        activeRoundCount: 4,
        steps: [
          { round: 1, dayOffset: 0, scheduledAt: NOW, subject: 'Pump 4-Round Followup', body: 'Hello', status: 'scheduled', stopReason: null },
        ],
      },
    },
  ]);

  backend.set('GET', '/outreach/replies', {
    data: [
      {
        id: REPLY_ID,
        contactRef: CONTACT_ID,
        recipientEmail: 'info@memodo.it',
        kind: 'REPLY',
        classification: 'POSITIVE',
        subject: 'Re: HJT 700W PV Supply',
        snippet: 'Please contact our buyer [referred: purchasing@memodo.it]',
        receivedAt: NOW,
      },
    ],
  });
}

test('F5 reload syncs accessCodes when an admin is downgraded to member (Review Focus #5)', async ({
  page,
  baseURL,
}) => {
  const origin = resolveOrigin(baseURL);
  const backend = await installMockBackend(page, { origin, role: 'admin' });

  const companyName = 'Nordic Pump GmbH';
  const contactName = 'Test Procurement Contact';
  const publicEmail = 'sales@nordicpump.de';
  const companyReadPath = `/canonical-companies/${CANONICAL_ID}`;
  let currentRole: 'admin' | 'member' = 'admin';
  backend.set('GET', '/workspace/context', async ({ route }) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          user: backend.session.user,
          workspace: { ...backend.session.workspaces[0], role: currentRole },
          onboarding: { complete: true, companyId: null },
          allowedActions: currentRole === 'admin' ? ADMIN_ALLOWED_ACTIONS : MEMBER_ALLOWED_ACTIONS,
        },
      }),
    });
    return true;
  });

  backend.set('GET', `/leads/${LEAD_ID}/package`, {
    lead_id: LEAD_ID,
    status: 'QUALIFIED',
    company: {
      canonical_company_id: CANONICAL_ID,
      name: companyName,
      domain: 'nordicpump.de',
      country: 'DE',
    },
    company_channels: [{ channel: 'email', email_type: 'department', status: 'public', value: publicEmail }],
    social_profiles: [],
    scores: { total: 0.85 },
    fit: { verdict: 'MATCH', reasons: ['工业泵分销商'] },
    evidence: [],
    sanctions: { status: 'clear', screened_at: NOW },
  });
  backend.set('GET', companyReadPath, async ({ route }) => {
    await route.fulfill({
      json: currentRole === 'admin'
        ? {
            data: {
              company: {
                id: CANONICAL_ID,
                name: companyName,
                domain: 'nordicpump.de',
                country: 'DE',
                contacts: [{ id: CONTACT_ID, fullName: contactName, title: 'Purchasing Manager', contactPoints: [] }],
              },
              evidence: [],
            },
          }
        : errorPayload('FORBIDDEN'),
      status: currentRole === 'admin' ? 200 : 403,
    });
    return true;
  });

  // 1. Sign in as admin: accessStore persists accessCodes = ['ADMIN'].
  await loginAs(page);
  await page.goto(`/leads/${LEAD_ID}?tab=people`);
  const memberNotice = page.locator('[data-gs="decision-makers-admin-only"]');
  const company = page.locator('[data-gs="lead-contact-company"]');
  const channels = page.locator('[data-gs="people-public-channels"]');
  const person = page.locator('[data-gs="lead-contact-identity"]');
  await expect(company.getByRole('heading', { name: companyName, exact: true })).toBeVisible();
  await expect(person.getByRole('heading', { name: contactName, exact: true })).toBeVisible();
  await expect(memberNotice).toHaveCount(0);
  const adminReads = backend.callsTo('GET', companyReadPath).length;
  expect(adminReads).toBeGreaterThan(0);

  // 2. Downgrade role to member on the server while keeping persisted browser storage, then F5 reload.
  currentRole = 'member';
  backend.session.workspace.role = 'member';
  backend.session.workspaces[0]!.role = 'member';

  await page.reload();

  // 3. The member retains public company access and the protected contact request stays gated.
  await expect(memberNotice).toBeVisible({ timeout: 10_000 });
  await expect(company.getByRole('heading', { name: companyName, exact: true })).toBeVisible();
  await expect(channels).toContainText(publicEmail);
  await expect(person).toHaveCount(0);
  await expect(page.getByText(contactName, { exact: true })).toHaveCount(0);
  expect(backend.callsTo('GET', companyReadPath)).toHaveLength(adminReads);
});

test('member gets transparent read-only campaigns/outreach views with 0 HTTP 403 and 0 warmup checklist GETs (Review Focus #6)', async ({
  page,
  baseURL,
}) => {
  const origin = resolveOrigin(baseURL);
  const backend = await installMockBackend(page, { origin, role: 'member' });
  seedCampaignsAndOutreachFixtures(backend, 'member');

  const forbiddenResponses: string[] = [];
  page.on('response', (res) => {
    if (res.status() === 403) {
      forbiddenResponses.push(`${res.request().method()} ${res.url()}`);
    }
  });

  await loginAs(page);

  // 1. /campaigns list: read-only hint shown, create button hidden.
  await page.goto('/outreach?tab=campaigns');
  await expect(page.getByText('德国工业泵 Q4 战役')).toBeVisible();
  await expect(page.locator('[data-gs="campaigns-readonly-hint"]')).toBeVisible();
  await expect(page.getByRole('button', { name: '新建计划' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '继续起草' })).toHaveCount(0);

  // 2. /campaigns/:id (DRAFT revision): plan visible, drafting/manual/submit buttons hidden.
  await page.goto(`/outreach/campaigns/${CAMPAIGN_DRAFT_ID}`);
  await expect(page.getByText('德国工业泵 Q4 战役')).toBeVisible();
  await expect(page.locator('[data-gs="campaigns-readonly-hint"]')).toBeVisible();
  await expect(page.getByRole('button', { name: /返回战役列表/ })).toBeVisible();
  await expect(page.locator('[data-gs="campaign-manual-revision-btn"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '让系统起草计划' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '提交审批' })).toHaveCount(0);

  // 3. /campaigns/:id (SUBMITTED pending approval): card visible for transparency, approve/decline hidden.
  await page.goto(`/outreach/campaigns/${CAMPAIGN_PENDING_ID}`);
  await expect(page.getByText('意大利光伏 Q4 审批中战役')).toBeVisible();
  await expect(page.locator('[data-gs="campaigns-readonly-hint"]')).toBeVisible();
  await expect(page.getByRole('button', { name: '批准', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '拒绝', exact: true })).toHaveCount(0);

  // 4. /growth?tab=outreach: read-only hint shown, write buttons hidden across DRAFT / APPROVED / PENDING batches.
  await page.goto('/outreach?tab=batches');
  await expect(page.locator('[data-gs="outreach-readonly-hint"]')).toBeVisible();
  await expect(page.getByText('德国泵业首批外发').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '新建批次' })).toHaveCount(0);
  await expect(page.locator('[data-gs="add-draft"]')).toHaveCount(0);
  await expect(page.locator('[data-gs="edit-draft"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '移除' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '提交审批' })).toHaveCount(0);

  // Switch to APPROVED batch: authorize & send hidden, read-only audit package still accessible.
  await page.locator('.ob__item', { hasText: '意大利光伏已批准批次' }).click();
  await expect(page.locator('[data-gs="authorize-batch"]')).toHaveCount(0);
  await expect(page.locator('[data-gs="send-batch"]')).toHaveCount(0);
  await expect(page.locator('[data-gs="audit-package-btn"]')).toBeVisible();
  await page.locator('[data-gs="audit-package-btn"]').click();
  const auditModal = page.locator('.ant-modal-content', { hasText: 'digest-approved-001' });
  await expect(auditModal).toBeVisible();
  await auditModal.locator('.ant-modal-close').click();
  await expect(auditModal).toBeHidden();

  // Switch to PENDING_APPROVAL batch: approval status visible, approve/decline hidden.
  await page.locator('.ob__item', { hasText: '法国暖通待审批批次' }).click();
  await expect(page.getByRole('button', { name: '批准', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '拒绝', exact: true })).toHaveCount(0);

  // 5. T1 Operations Panel — traverse all 5 tabs.
  // 5a. dns tab remains fully usable for member.
  await page.locator('[data-gs="t1-dns-check-btn"]').click();
  await expect(page.locator('[data-gs="t1-dns-result"]')).toBeVisible();
  expect(backend.callsTo('POST', '/outreach/t1/dns-check').length).toBe(1);

  // 5b. health tab: breakers readable, evaluate / recover / close hidden.
  await page.getByRole('tab', { name: '发信健康与熔断' }).click();
  await expect(page.locator('[data-gs="t1-breaker-list"]')).toContainText('mail.acme.example');
  await expect(page.locator('[data-gs="t1-health-evaluate"]')).toHaveCount(0);
  await expect(page.locator('[data-gs="t1-breaker-recover"]')).toHaveCount(0);
  await expect(page.locator('[data-gs="t1-breaker-close"]')).toHaveCount(0);

  // 5c. warmup tab: shows admin-only hint and fires 0 GET /outreach/warmup/checklist requests.
  await page.getByRole('tab', { name: '预热清单' }).click();
  await expect(page.locator('[data-gs="t1-warmup-admin-only"]')).toBeVisible();
  await expect(page.locator('[data-gs="t1-warmup-list"]')).toHaveCount(0);
  expect(backend.callsTo('GET', '/outreach/warmup/checklist')).toHaveLength(0);

  // 5d. templates tab: templates readable, create & lifecycle actions hidden.
  await page.getByRole('tab', { name: '模板与法审' }).click();
  await expect(page.locator('[data-gs="t1-templates-list"]')).toContainText('Global Active Template');
  await expect(page.locator('[data-gs="t1-template-new"]')).toHaveCount(0);
  await expect(page.locator('[data-gs="t1-templates-pane"]').getByRole('button', { name: /提交法审|激活|停用/ })).toHaveCount(0);

  // 5e. sequence tab: existing sequences readable, sequence planning form hidden.
  await page.getByRole('tab', { name: '跟进序列' }).click();
  await expect(page.locator('[data-gs="t1-sequence-list"]')).toContainText('Pump 4-Round Followup');
  await expect(page.locator('[data-gs="t1-seq-create-btn"]')).toHaveCount(0);

  // 6. /growth?tab=replies: referral contact visible for transparency, referral-create-draft hidden.
  await page.goto('/outreach?tab=replies');
  await expect(page.locator('[data-gs="outreach-readonly-hint"]')).toBeVisible();
  await expect(page.locator('[data-gs="referral-leads-card"]')).toContainText('purchasing@memodo.it');
  await expect(page.locator('[data-gs="referral-create-draft"]')).toHaveCount(0);

  // Final strict assertions: 0 HTTP 403 and 0 warmup checklist calls across the entire member session.
  expect(forbiddenResponses).toEqual([]);
  expect(backend.callsTo('GET', '/outreach/warmup/checklist')).toHaveLength(0);
});

test('admin retains full write actions across campaigns, outreach, T1 warmup, and replies', async ({
  page,
  baseURL,
}) => {
  const origin = resolveOrigin(baseURL);
  const backend = await installMockBackend(page, { origin, role: 'admin' });
  seedCampaignsAndOutreachFixtures(backend, 'admin');

  await loginAs(page);

  // 1. /campaigns list
  await page.goto('/outreach?tab=campaigns');
  await expect(page.getByRole('button', { name: '新建计划' })).toBeVisible();
  await expect(page.locator('[data-gs="campaigns-readonly-hint"]')).toHaveCount(0);

  // 2. /campaigns/:id (DRAFT + SUBMITTED)
  await page.goto(`/outreach/campaigns/${CAMPAIGN_DRAFT_ID}`);
  await expect(page.locator('[data-gs="campaign-manual-revision-btn"]')).toBeVisible();
  await expect(page.getByRole('button', { name: '让系统起草计划' })).toBeVisible();
  await expect(page.getByRole('button', { name: '提交审批' })).toBeVisible();
  await expect(page.locator('[data-gs="campaigns-readonly-hint"]')).toHaveCount(0);

  await page.goto(`/outreach/campaigns/${CAMPAIGN_PENDING_ID}`);
  await expect(page.getByRole('button', { name: '批准', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '拒绝', exact: true })).toBeVisible();

  // 3. /growth?tab=outreach + T1 panel (including warmup checklist)
  await page.goto('/outreach?tab=batches');
  await expect(page.getByRole('button', { name: '新建批次' })).toBeVisible();
  await expect(page.locator('[data-gs="add-draft"]')).toBeVisible();
  await expect(page.locator('[data-gs="edit-draft"]').first()).toBeVisible();
  await expect(page.locator('[data-gs="outreach-readonly-hint"]')).toHaveCount(0);

  await page.locator('.ob__item', { hasText: '意大利光伏已批准批次' }).click();
  await expect(page.locator('[data-gs="authorize-batch"]')).toBeVisible();
  await expect(page.locator('[data-gs="send-batch"]')).toBeVisible();

  await page.getByRole('tab', { name: '发信健康与熔断' }).click();
  await expect(page.locator('[data-gs="t1-health-evaluate"]')).toBeVisible();
  await expect(page.locator('[data-gs="t1-breaker-recover"]')).toBeVisible();
  await expect(page.locator('[data-gs="t1-breaker-close"]')).toBeVisible();

  await page.getByRole('tab', { name: '预热清单' }).click();
  await expect(page.locator('[data-gs="t1-warmup-list"]')).toContainText('94%');
  await expect(page.locator('[data-gs="t1-warmup-admin-only"]')).toHaveCount(0);
  expect(backend.callsTo('GET', '/outreach/warmup/checklist')).toHaveLength(1);

  await page.getByRole('tab', { name: '模板与法审' }).click();
  await expect(page.locator('[data-gs="t1-template-new"]')).toBeVisible();

  await page.getByRole('tab', { name: '跟进序列' }).click();
  await expect(page.locator('[data-gs="t1-seq-create-btn"]')).toBeVisible();

  // 4. /growth?tab=replies
  await page.goto('/outreach?tab=replies');
  await expect(page.locator('[data-gs="referral-create-draft"]')).toBeVisible();
  await expect(page.locator('[data-gs="outreach-readonly-hint"]')).toHaveCount(0);
});
