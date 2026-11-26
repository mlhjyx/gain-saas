/**
 * Phase 3 Track 3C 端到端 Mock-E2E：
 * 1) T1 完整外联工作台：批次草稿关联公司就绪 PDF 画册 + 信号破冰首句插入 + 签发执行授权 +
 *    审计包 + 通道开启态执行投递 + SPF/DKIM/DMARC/MX 域名体检 + 健康熔断恢复 +
 *    预热周检清单 + 合规模板/法审 + 2–4 轮自动跟进序列规划与回信硬终止；
 * 2) 回复收件箱转交联系人（REFERRAL）抽取与合规预检一键建稿；
 * 3) 信号破冰首句在 T0 面板插入 + 结构化线索驳回回流 Track 3B `feedback/record` +
 *    目标客户画像详情展示 `feedback/summary` 已沉淀排除规则与反例。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const NOW = '2026-11-26T08:00:00.000Z';
const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const ICP_ID = '22222222-2222-4222-8222-222222222222';
const LEAD_ID = '33333333-3333-4333-8333-333333333333';
const CANONICAL_ID = '44444444-4444-4444-8444-444444444444';
const CONTACT_ID = '55555555-5555-4555-8555-555555555555';
const BATCH_ID = '66666666-6666-4666-8666-666666666666';
const DOC_PDF_ID = '77777777-7777-4777-8777-777777777777';
const REPLY_ID = '88888888-8888-4888-8888-888888888888';

test('T1 完整外联工作台：画册附件、授权与投递、DNS 体检、健康熔断、预热、模板与 4 轮跟进序列', async ({ page }) => {
  const backend = await installMockBackend(page);

  const batch: Record<string, unknown> = {
    id: BATCH_ID,
    name: '意大利光伏分销商 Q4',
    status: 'DRAFT',
    drafts: [],
    approvals: [],
    events: [{ id: 'ev-1', type: 'BATCH_CREATED', actor: 'user-e2e', createdAt: NOW }],
    createdAt: NOW,
    updatedAt: NOW,
  };

  backend.set('GET', '/companies', [{ id: COMPANY_ID, name: '琏升新能源', website: 'https://liansheng.example' }]);
  backend.set('GET', `/companies/${COMPANY_ID}/seller-documents`, [
    {
      id: DOC_PDF_ID,
      companyId: COMPANY_ID,
      filename: 'HJT-700W-Datasheet.pdf',
      mime: 'application/pdf',
      sizeBytes: 2_048_000,
      status: 'ready',
      createdAt: NOW,
    },
  ]);
  backend.set('GET', '/outreach/t1/readiness', {
    sendEnabled: true,
    shadowMode: false,
    smtpConfigured: true,
    fromDomain: 'mail.liansheng.example',
  });
  backend.set('GET', '/outreach/batches', async ({ route }) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          {
            id: BATCH_ID,
            name: batch.name,
            status: batch.status,
            draftCount: (batch.drafts as unknown[]).length,
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
      body: JSON.stringify({ data: batch }),
    });
    return true;
  });
  backend.set('POST', `/outreach/batches/${BATCH_ID}/drafts`, async ({ body, route }) => {
    const input = body as Record<string, unknown>;
    const created = {
      id: 'draft-t1-1',
      batchId: BATCH_ID,
      status: 'DRAFT',
      ...input,
      createdAt: NOW,
    };
    (batch.drafts as unknown[]).push(created);
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ data: created }),
    });
    return true;
  });
  backend.set('POST', `/outreach/batches/${BATCH_ID}/authorize`, {
    authorizationId: 'auth-1',
    batchId: BATCH_ID,
    state: 'ACTIVE',
    expiresAt: NOW,
  });
  backend.set('GET', `/outreach/batches/${BATCH_ID}/audit-package`, {
    batchId: BATCH_ID,
    contentHash: 'abc123',
    draftsCount: 1,
  });
  backend.set('POST', `/outreach/batches/${BATCH_ID}/send`, async ({ route }) => {
    batch.status = 'SENT';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          batchId: BATCH_ID,
          status: 'SENT',
          sent: 1,
          failed: 0,
          skipped: 0,
          deferred: 0,
          shadowed: 0,
          results: [{ draftId: 'draft-t1-1', status: 'SENT', messageId: '<msg-1@mail.liansheng.example>' }],
        },
      }),
    });
    return true;
  });
  backend.set('POST', '/outreach/t1/dns-check', {
    report: {
      domain: 'mail.liansheng.example',
      mx: [{ exchange: 'smtp.google.com', priority: 1 }],
      spf: { present: true, record: 'v=spf1 include:_spf.google.com ~all', qualifier: '~all' },
      dmarc: { present: true, record: 'v=DMARC1; p=quarantine; rua=mailto:dmarc@mail.liansheng.example', policy: 'quarantine', pct: 100, hasRua: true },
      dkim: { present: false, selector: 'google' },
      ok: { spf: true, dmarc: true, dkim: false, mx: true },
      ready: false,
    },
    advice: {
      score: 3,
      ready: false,
      items: [
        { key: 'spf', ok: true, severity: 'ok', adviceCode: 'SPF_OK' },
        { key: 'dkim', ok: false, severity: 'error', adviceCode: 'DKIM_MISSING' },
        { key: 'dmarc', ok: true, severity: 'ok', adviceCode: 'DMARC_OK' },
        { key: 'mx', ok: true, severity: 'ok', adviceCode: 'MX_OK' },
      ],
    },
    template: 'mail.liansheng.example. TXT "v=spf1 include:_spf.google.com ~all"',
  });
  backend.set('GET', '/outreach/health', {
    breakers: [
      {
        id: 'brk-1',
        scope: 'domain',
        scopeRef: 'mail.liansheng.example',
        state: 'OPEN',
        reason: 'BOUNCE_RATE',
        openedAt: NOW,
      },
    ],
    events: [],
  });
  backend.set('GET', '/outreach/warmup/checklist', {
    generatedAt: NOW,
    windowDays: 7,
    thresholds: { inboxPctMin: 80, spamPctMax: 10 },
    domains: [
      {
        domain: 'mail.liansheng.example',
        domainState: 'ACTIVE',
        mailboxes: [
          {
            address: 'sales@mail.liansheng.example',
            state: 'ACTIVE',
            warmupStage: 'W2',
            dailyCap: 20,
            weeklyCap: 100,
            dailySent: 6,
            weeklySent: 24,
            dailyRemaining: 14,
            weeklyRemaining: 76,
          },
        ],
        lastSeedTest: { testedAt: NOW, provider: 'glockapps', inboxPct: 92, spamPct: 2 },
        checks: { seedFresh: true, inboxOk: true, spamOk: true, mailboxesOk: true, ok: true },
      },
    ],
  });
  backend.set('GET', '/outreach/templates', [
    {
      id: 'tpl-1',
      kind: 'email_first',
      jurisdiction: 'IT',
      language: 'en',
      version: 1,
      subject: 'HJT 700W PV Supply',
      body: 'Hello team',
      bodyHash: 'a'.repeat(64),
      state: 'ACTIVE',
    },
  ]);
  backend.set('GET', '/outreach/legal-reviews', []);
  backend.set('GET', '/outreach/t1/sequences', []);
  backend.set('POST', '/outreach/t1/sequences', {
    id: 'seq-1',
    contactRef: CONTACT_ID,
    recipientMasked: 'i***@memodo.it',
    companyName: 'Memodo Italia S.r.l.',
    countryCode: 'IT',
    subject: 'HJT 700W Supply',
    createdAt: NOW,
    plan: {
      rounds: 4,
      jurisdictionPolicy: 'OPT_OUT',
      stopped: true,
      stopReason: 'REPLY_RECEIVED',
      activeRoundCount: 0,
      steps: [
        { round: 1, dayOffset: 0, scheduledAt: NOW, subject: 'HJT 700W Supply', body: 'Hello', status: 'sent', stopReason: null },
        { round: 2, dayOffset: 3, scheduledAt: NOW, subject: 'Re: HJT 700W Supply', body: 'Follow up', status: 'stopped', stopReason: 'REPLY_RECEIVED' },
        { round: 3, dayOffset: 7, scheduledAt: NOW, subject: 'Re: HJT 700W Supply', body: 'Follow up', status: 'stopped', stopReason: 'REPLY_RECEIVED' },
        { round: 4, dayOffset: 14, scheduledAt: NOW, subject: 'Re: HJT 700W Supply', body: 'Follow up', status: 'stopped', stopReason: 'REPLY_RECEIVED' },
      ],
    },
  });

  await loginAs(page);
  await page.goto('/growth?tab=outreach');

  // 1. 新建草稿并勾选公司就绪 PDF 画册附件
  await page.locator('[data-gs="add-draft"]').click();
  const modal = page.locator('.ant-modal-content').filter({ has: page.locator('[data-gs="draft-email"]') });
  await modal.locator('input').first().fill(CONTACT_ID);
  await modal.locator('[data-gs="draft-email"]').fill('info@memodo.it');
  await modal.locator('[data-gs="draft-country"]').fill('IT');
  await modal.locator('[data-gs="draft-company"]').fill('Memodo Italia S.r.l.');
  await modal.locator('[data-gs="draft-subject"]').fill('HJT 700W PV Supply');
  await modal.locator('[data-gs="draft-body"]').fill('Hello Memodo team, attached is our datasheet.');
  await modal.locator('[data-gs="draft-attachments-select"] .ant-select-selector').click();
  await page.locator('.ant-select-item-option', { hasText: 'HJT-700W-Datasheet.pdf' }).click();
  await modal.locator('.ant-modal-title').click();
  await modal.locator('.ant-modal-footer .ant-btn-primary').click();

  await expect(page.locator('[data-gs="draft-attachments-badge"]')).toContainText('1');
  const draftCall = backend.take('POST', `/outreach/batches/${BATCH_ID}/drafts`);
  expect((draftCall?.body as { attachments?: Array<{ documentId: string }> })?.attachments?.[0]?.documentId).toBe(DOC_PDF_ID);

  // 2. 切换批次为 APPROVED，验证签发授权、审计包与发送通道开启时的投递动作
  batch.status = 'APPROVED';
  await page.reload();
  await page.locator('[data-gs="authorize-batch"]').click();
  await expect.poll(() => backend.callsTo('POST', `/outreach/batches/${BATCH_ID}/authorize`).length).toBe(1);

  await page.locator('[data-gs="audit-package-btn"]').click();
  const auditModal = page.locator('.ant-modal-content', { hasText: 'abc123' });
  await expect(auditModal).toBeVisible();
  await auditModal.locator('.ant-modal-close').click();
  await expect(auditModal).toBeHidden();

  await page.locator('[data-gs="send-batch"]').click();
  await expect.poll(() => backend.callsTo('POST', `/outreach/batches/${BATCH_ID}/send`).length).toBe(1);

  // 3. T1 工作台：DNS 体检、健康熔断、预热、模板与 4 轮跟进序列
  await page.locator('[data-gs="t1-dns-check-btn"]').click();
  await expect(page.locator('[data-gs="t1-dns-result"]')).toBeVisible();
  await expect(page.locator('[data-gs="t1-dns-item-dkim"]')).toContainText('DKIM');

  await page.getByRole('tab', { name: '发信健康与熔断' }).click();
  await expect(page.locator('[data-gs="t1-breaker-list"]')).toContainText('mail.liansheng.example');

  await page.getByRole('tab', { name: '预热清单' }).click();
  await expect(page.locator('[data-gs="t1-warmup-list"]')).toContainText('92%');

  await page.getByRole('tab', { name: '模板与法审' }).click();
  await expect(page.locator('[data-gs="t1-templates-list"]')).toContainText('HJT 700W PV Supply');

  await page.getByRole('tab', { name: '跟进序列' }).click();
  await page.locator('[data-gs="t1-seq-create-btn"]').click();
  await expect(page.locator('[data-gs="t1-seq-stop-alert"]')).toContainText('回信');
});

test('回复收件箱：识别转交联系人（REFERRAL）并一键合规创建跟进草稿', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/outreach/replies', {
    data: [
      {
        id: REPLY_ID,
        contactRef: CONTACT_ID,
        recipientEmail: 'info@memodo.it',
        kind: 'REPLY',
        classification: 'POSITIVE',
        subject: 'Re: HJT 700W PV Supply',
        snippet: 'Please speak with our purchasing director [referred: purchasing@memodo.it]',
        receivedAt: NOW,
      },
    ],
  });
  backend.set('GET', '/outreach/batches', [
    { id: BATCH_ID, name: '转交跟进批次', status: 'DRAFT', draftCount: 0, createdAt: NOW, updatedAt: NOW },
  ]);
  backend.set('POST', '/outreach/t1/referrals/draft', {
    draft: { id: 'draft-ref-1', batchId: BATCH_ID },
    newContactRef: '99999999-9999-4999-8999-999999999999',
    jurisdictionPolicy: 'OPT_OUT',
  });

  await loginAs(page);
  await page.goto('/growth?tab=replies');

  await expect(page.locator('[data-gs="referral-leads-card"]')).toContainText('purchasing@memodo.it');
  await page.locator('[data-gs="referral-create-draft"]').first().click();
  const modal = page.locator('.ant-modal-content').filter({ has: page.locator('[data-gs="referral-country"]') });
  await expect(modal).toBeVisible();
  await modal.locator('.ant-modal-footer .ant-btn-primary').click();

  await expect.poll(() => backend.callsTo('POST', '/outreach/t1/referrals/draft').length).toBe(1);
  const call = backend.take('POST', '/outreach/t1/referrals/draft');
  expect(call?.body).toMatchObject({
    batchId: BATCH_ID,
    replyId: REPLY_ID,
    referredEmail: 'purchasing@memodo.it',
    countryCode: 'IT',
  });
});

test('信号破冰首句一键插入 + 结构化驳回回流 ICP 学习摘要展示', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/companies', [{ id: COMPANY_ID, name: '琏升新能源', website: 'https://liansheng.example' }]);
  backend.set('GET', '/icps', [
    {
      id: ICP_ID,
      companyId: COMPANY_ID,
      name: '意大利光伏分销商',
      status: 'ACTIVE',
      companyAttributes: {},
      painPoints: [],
      triggerSignals: [],
      exclusions: [],
      valueProps: [],
      targetMarkets: ['IT'],
      version: 2,
      personas: [],
      buyingCommittee: [],
      rules: [],
      ruleLint: [],
      createdAt: NOW,
    },
  ]);
  backend.set('GET', `/icps/${ICP_ID}`, {
    id: ICP_ID,
    companyId: COMPANY_ID,
    name: '意大利光伏分销商',
    status: 'ACTIVE',
    companyAttributes: {},
    painPoints: [],
    triggerSignals: [],
    exclusions: [],
    valueProps: [],
    targetMarkets: ['IT'],
    version: 2,
    personas: [],
    buyingCommittee: [],
    rules: [],
    ruleLint: [],
    createdAt: NOW,
  });
  backend.set('GET', `/leads/${LEAD_ID}/package`, {
    lead_id: LEAD_ID,
    icp_id: ICP_ID,
    status: 'REVIEW',
    company: {
      canonical_company_id: CANONICAL_ID,
      name: 'SolarGrid Italia S.r.l.',
      domain: 'solargrid.it',
      country: 'IT',
    },
    company_channels: [{ channel: 'email', value: 'sales@solargrid.it', status: 'VALID' }],
    social_profiles: [],
    icebreakerSuggestions: [
      {
        signalType: 'TENDER_AWARDED',
        signalTitle: '中标托斯卡纳 18MW 光伏 EPC 项目',
        signalUrl: 'https://ted.europa.eu/notice/2026-18mw',
        detectedAt: NOW,
        openerZh: '祝贺贵司近期中标托斯卡纳 18MW 光伏 EPC 项目，冒昧分享我司现货组件规格。',
        openerEn: 'Congratulations on winning the 18MW Tuscany PV EPC award.',
      },
    ],
    fit: { verdict: 'FIT', reasons: ['区域光伏分销商'] },
    scores: { total: 0.9 },
  });
  backend.set('POST', `/leads/${LEAD_ID}/reject`, { id: LEAD_ID, status: 'REJECTED' });
  backend.set('POST', `/icps/${ICP_ID}/feedback/record`, {
    icpId: ICP_ID,
    icpVersion: 3,
    recorded: { outcome: 'rejected', rejectionReason: 'wrong_role_peer', domain: 'solargrid.it', companyId: CANONICAL_ID, leadId: LEAD_ID, recordedAt: NOW },
    appliedRules: { addedExcludedDomain: 'solargrid.it', addedExcludedKeywords: [], addedCounterExample: true },
    summary: {
      icpId: ICP_ID,
      icpName: '意大利光伏分销商',
      icpVersion: 3,
      excludedDomains: ['solargrid.it'],
      excludedKeywords: ['组件制造同行'],
      excludedBusinessModels: [],
      counterExamples: [
        {
          domain: 'solargrid.it',
          companyName: 'SolarGrid Italia S.r.l.',
          industry: 'Solar',
          outcome: 'rejected',
          reason: 'wrong_role_peer',
          note: '上游组件制造同行',
          recordedAt: NOW,
        },
      ],
      positiveExamples: [],
      stats: { totalRecorded: 1, outcomeCounts: { rejected: 1 }, rejectionReasonCounts: { wrong_role_peer: 1 }, lastRecordedAt: NOW },
    },
  });
  backend.set('GET', `/icps/${ICP_ID}/feedback/summary`, {
    icpId: ICP_ID,
    icpName: '意大利光伏分销商',
    icpVersion: 3,
    excludedDomains: ['solargrid.it'],
    excludedKeywords: ['组件制造同行'],
    excludedBusinessModels: [],
    counterExamples: [
      {
        domain: 'solargrid.it',
        companyName: 'SolarGrid Italia S.r.l.',
        industry: 'Solar',
        outcome: 'rejected',
        reason: 'wrong_role_peer',
        note: '上游组件制造同行',
        recordedAt: NOW,
      },
    ],
    positiveExamples: [],
    stats: { totalRecorded: 1, outcomeCounts: { rejected: 1 }, rejectionReasonCounts: { wrong_role_peer: 1 }, lastRecordedAt: NOW },
  });

  await loginAs(page);
  await page.goto(`/leads/${LEAD_ID}?tab=draft`);

  // 1. T0 面板展示信号破冰首句并支持一键插入到外联正文
  await expect(page.locator('[data-gs="t0-signal-icebreakers"]')).toContainText('18MW');
  await page.locator('[data-gs="t0-insert-icebreaker"]').first().click();
  await expect(page.locator('[data-gs="t0-body"]')).toHaveValue(/祝贺贵司近期中标托斯卡纳 18MW/);

  // 2. 结构化驳回（同行竞争对手）触发 rejectLead + POST /icps/:icpId/feedback/record
  await page.locator('button', { hasText: /排\s*除/ }).first().click();
  const rejectModal = page.locator('.ant-modal-content').filter({ has: page.locator('textarea') }).last();
  await rejectModal.locator('.ant-select-selector').click();
  await page.locator('.ant-select-item-option', { hasText: '同行竞争对手' }).click();
  await rejectModal.locator('textarea').fill('上游组件制造同行');
  await rejectModal.locator('.ant-modal-footer .ant-btn-primary').click();

  await expect.poll(() => backend.callsTo('POST', `/icps/${ICP_ID}/feedback/record`).length).toBe(1);
  const fbCall = backend.take('POST', `/icps/${ICP_ID}/feedback/record`);
  expect(fbCall?.body).toMatchObject({
    leadId: LEAD_ID,
    domain: 'solargrid.it',
    outcome: 'rejected',
    rejectionReason: 'wrong_role_peer',
    note: '上游组件制造同行',
  });

  // 3. 在 /find-buyers 打开画像详情抽屉，展示已沉淀的排除域名、关键词与反例学习摘要
  await page.goto('/find-buyers');
  await page.getByRole('button', { name: '意大利光伏分销商' }).click();
  await expect(page.locator('[data-gs="icp-learned-feedback"]')).toBeVisible();
  await expect(page.locator('[data-gs="icp-learned-domains"]')).toContainText('solargrid.it');
  await expect(page.locator('[data-gs="icp-learned-keywords"]')).toContainText('组件制造同行');
  await expect(page.locator('[data-gs="icp-learned-counter-examples"]')).toContainText('SolarGrid Italia S.r.l.');
});
