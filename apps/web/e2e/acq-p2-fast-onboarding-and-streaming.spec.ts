/**
 * Phase 2 Track 2C E2E 回归测试：
 * 1. 3 步 ≤3 分钟极速上手（1688/阿里店铺白名单校验 → UN Comtrade 推荐国徽章 → 三栏审阅卡片 → 一键建档+自动审事实+生画像+启动流式寻源）
 * 2. 多模态冷启动（PDF 画册三步直传 + 简短主营产品描述）
 * 3. 1 公司多画像并行管理（公司切换栏 + 多画像创建与并存激活 + 三层画像卡片 + 方案 B 流式三段进度在 /find-buyers、/leads 与 /runs/:runId 贯通）
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const NOW = '2026-11-26T01:00:00.000Z';
const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const ICP_IT = '22222222-2222-4222-8222-222222222222';
const ICP_DE = '33333333-3333-4333-8333-333333333333';
const PLAN_ID = '44444444-4444-4444-8444-444444444444';
const TASK_ID = '55555555-5555-4555-8555-555555555555';
const RUN_STREAM = '66666666-6666-4666-8666-666666666666';
const DOC_ID = '77777777-7777-4777-8777-777777777777';

const STREAMING_PROGRESS_FIXTURE = {
  runId: RUN_STREAM,
  pipelineMode: 'streaming',
  runStatus: 'RUNNING',
  currentStage: 'l2_topk_enrich',
  updatedAt: NOW,
  stages: {
    l0Recall: {
      status: 'done',
      queriesTotal: 4,
      queriesCompleted: 4,
      candidatesRecalled: 48,
      canonicalUpserted: 42,
      startedAt: NOW,
      completedAt: NOW,
    },
    l1ExtractFit: {
      status: 'done',
      total: 42,
      processed: 42,
      rawHttpHits: 35,
      crawl4aiFallbacks: 7,
      pdfSkipped: 3,
      wwwRetries: 2,
      fitMatch: 12,
      fitWeak: 8,
      fitMismatch: 22,
      failed: 0,
    },
    l2TopKEnrich: {
      status: 'running',
      topKCap: 12,
      selected: 12,
      enriched: 5,
      contactsFound: 9,
      watchesRegistered: 4,
      failed: 0,
    },
  },
  recentCandidates: [
    {
      companyId: 'cand-1',
      name: 'Memodo Italia S.r.l.',
      domain: 'memodo.it',
      country: 'IT',
      stage: 'done',
      fitVerdict: 'match',
      fitScore: 92,
      fetchMethod: 'raw_http',
      channelsFound: { emails: 2, phones: 1, forms: 1, socials: 1 },
      reasonSummary: '意大利头部光伏组件分销商，官网主营工商业组件批发',
      updatedAt: NOW,
    },
  ],
};

const COMTRADE_FIXTURE = {
  companyId: COMPANY_ID,
  isRecommendationOnly: true,
  basis: {
    hsCodes: [{ code: '854143', label: 'Photovoltaic modules', labelZh: '光伏组件', matchedFrom: 'offering' }],
    inferredFrom: 'offerings_and_industry',
    dataSource: 'un_comtrade_baseline_v1',
    referenceYear: 2024,
  },
  recommendations: [
    {
      code: 'IT',
      name: '意大利',
      labelEn: 'Italy',
      rank: 1,
      hsCodes: ['854143'],
      importVolumeUsd: 2_450_000_000,
      yoyGrowthPct: 18.4,
      globalImportSharePct: 5.2,
      rationale: '欧洲分布式光伏需求高增长',
      confidence: 'high',
      alreadySelected: false,
    },
    {
      code: 'ES',
      name: '西班牙',
      labelEn: 'Spain',
      rank: 2,
      hsCodes: ['854143'],
      importVolumeUsd: 1_920_000_000,
      yoyGrowthPct: 14.2,
      globalImportSharePct: 4.1,
      rationale: '工商业屋顶装机活跃',
      confidence: 'high',
      alreadySelected: false,
    },
  ],
  generatedAt: NOW,
};

test('3 步极速上手：1688/阿里店铺白名单 → UN Comtrade 选国 → 三栏审阅 → 一键启动流式寻源', async ({ page }) => {
  const backend = await installMockBackend(page, { onboardingComplete: false });

  backend.set('POST', '/onboarding/preview', {
    started: true,
    preview: {
      companyId: COMPANY_ID,
      name: '琏升新能源',
      website: 'https://solarfactory.en.alibaba.com',
      websiteChannel: 'alibaba_intl',
      status: 'REVIEW',
      state: 'ready',
      failure: null,
      pagesAnalyzed: 3,
      industry: {
        raw: '光伏组件制造',
        suggested: { raw: '光伏组件制造', code: '27', label: '电气设备制造', labelEn: 'Electrical equipment', matched: true },
        options: [{ code: '27', label: '电气设备制造', labelEn: 'Electrical equipment', nace: ['27'] }],
      },
      products: [
        { name: 'HJT 700W 双面光伏组件', source: 'understanding', sourceUrl: 'https://solarfactory.en.alibaba.com', evidence: 'HJT 700W' },
      ],
      markets: [],
    },
  });
  backend.set('GET', `/companies/${COMPANY_ID}/market-recommendations`, COMTRADE_FIXTURE);
  backend.set('POST', '/onboarding/company', { id: COMPANY_ID, name: '琏升新能源', status: 'REVIEW' });
  backend.set('POST', `/onboarding/companies/${COMPANY_ID}/claim-drafts`, { created: 1, skipped: 0, claims: [] });
  backend.set('GET', `/companies/${COMPANY_ID}/claims`, [
    { id: 'claim-1', companyId: COMPANY_ID, type: 'capability', statement: 'HJT 700W 双面光伏组件', status: 'NEEDS_REVIEW', version: 1 },
  ]);
  backend.set('POST', '/claims/claim-1/approve', { id: 'claim-1', status: 'APPROVED' });
  backend.set('POST', `/companies/${COMPANY_ID}/icps`, {
    id: ICP_IT,
    companyId: COMPANY_ID,
    name: '意大利光伏分销与 EPC',
    status: 'HYPOTHESIS',
    companyAttributes: {
      seller_profile: { company_name: '琏升新能源', offerings: ['HJT 700W 双面光伏组件'], technical_specs: ['HJT', '0BB'] },
      buyer_spec: { target_roles: ['distributor', 'epc'], target_markets: ['IT'], procurement_scenario: 'distribution' },
      peer_exclusions: { excluded_business_models: ['同类光伏组件制造商'], excluded_keywords: ['cell OEM'], excluded_domains: [] },
    },
    painPoints: [],
    triggerSignals: [],
    exclusions: ['硅片代工厂'],
    valueProps: [],
    targetMarkets: ['IT'],
    version: 1,
    personas: [],
    buyingCommittee: [],
    rules: [],
    ruleLint: [],
    createdAt: NOW,
  });
  backend.set('POST', `/icps/${ICP_IT}/activate`, { id: ICP_IT, status: 'ACTIVE' });
  backend.set('POST', `/icps/${ICP_IT}/query-plans`, { id: PLAN_ID, icpId: ICP_IT, status: 'READY', queries: [], version: 1, createdAt: NOW });
  backend.set('POST', '/tasks', { id: TASK_ID, icpId: ICP_IT, name: '意大利光伏分销与 EPC', status: 'active', createdBy: 'user-e2e', lastRunAt: NOW, createdAt: NOW, updatedAt: NOW, runs: [] });
  backend.set('POST', `/tasks/${TASK_ID}/runs`, { taskRunId: 'tr-1', runId: RUN_STREAM, status: 'RUNNING' });

  // 跳转到 /find-buyers 后需要的只读数据
  backend.set('GET', '/companies', [{ id: COMPANY_ID, name: '琏升新能源', targetMarkets: ['IT'] }]);
  backend.set('GET', '/icps', [
    {
      id: ICP_IT,
      companyId: COMPANY_ID,
      name: '意大利光伏分销与 EPC',
      status: 'ACTIVE',
      companyAttributes: {
        seller_profile: { company_name: '琏升新能源', offerings: ['HJT 700W 双面光伏组件'], technical_specs: ['HJT', '0BB'] },
        buyer_spec: { target_roles: ['distributor', 'epc'], target_markets: ['IT'], procurement_scenario: 'distribution' },
        peer_exclusions: { excluded_business_models: ['同类光伏组件制造商'], excluded_keywords: [], excluded_domains: [] },
      },
      painPoints: [],
      triggerSignals: [],
      exclusions: ['硅片代工厂'],
      valueProps: [],
      targetMarkets: ['IT'],
      version: 1,
      personas: [],
      buyingCommittee: [],
      rules: [],
      ruleLint: [],
      createdAt: NOW,
    },
  ]);
  backend.set('GET', `/icps/${ICP_IT}`, {
    id: ICP_IT,
    companyId: COMPANY_ID,
    name: '意大利光伏分销与 EPC',
    status: 'ACTIVE',
    companyAttributes: {
      seller_profile: { company_name: '琏升新能源', offerings: ['HJT 700W 双面光伏组件'], technical_specs: ['HJT', '0BB'] },
      buyer_spec: { target_roles: ['distributor', 'epc'], target_markets: ['IT'], procurement_scenario: 'distribution' },
      peer_exclusions: { excluded_business_models: ['同类光伏组件制造商'], excluded_keywords: [], excluded_domains: [] },
    },
    painPoints: [],
    triggerSignals: [],
    exclusions: ['硅片代工厂'],
    valueProps: [],
    targetMarkets: ['IT'],
    version: 1,
    personas: [],
    buyingCommittee: [],
    rules: [],
    ruleLint: [],
    createdAt: NOW,
  });
  backend.set('GET', `/discovery-runs/${RUN_STREAM}/streaming-progress`, STREAMING_PROGRESS_FIXTURE);
  backend.set('GET', `/discovery-runs/${RUN_STREAM}/jobs`, []);
  backend.set('GET', `/discovery-runs/${RUN_STREAM}/events`, { events: [], nextAfter: 0 });
  backend.set('GET', `/discovery-runs/${RUN_STREAM}/trace`, { data: [], page: { next_cursor: null, has_more: false } });
  backend.set('GET', `/discovery-runs/${RUN_STREAM}`, {
    id: RUN_STREAM,
    planId: PLAN_ID,
    icpId: ICP_IT,
    status: 'RUNNING',
    mode: 'streaming',
    stats: {},
    createdAt: NOW,
  });

  await loginAs(page);
  await page.waitForURL(/\/onboarding/);

  // Step 1：切换至 1688/阿里国际站店铺模式，验证伪造域名被拦，合法店铺链接放行
  await page.locator('.onboarding-section input').first().fill('琏升新能源');
  await page.locator('[data-gs="intake-mode-store"]').click();
  await page.locator('[data-gs="store-url-input"]').fill('https://evil.example/1688.com/shop');
  await expect(page.locator('[data-gs="store-start-btn"]')).toBeDisabled();

  await page.locator('[data-gs="store-url-input"]').fill('solarfactory.en.alibaba.com');
  await expect(page.locator('[data-gs="store-start-btn"]')).toBeEnabled();
  await page.locator('[data-gs="store-start-btn"]').click();

  // Step 2：展示 UN Comtrade 推荐国徽章（默认不自动代选），点击 IT 选中
  await expect(page.locator('[data-gs="comtrade-recommendations"]')).toBeVisible();
  await expect(page.locator('[data-gs="comtrade-market-IT"]')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('[data-gs="comtrade-market-IT"]').click();
  await expect(page.locator('[data-gs="comtrade-market-IT"]')).toHaveAttribute('aria-pressed', 'true');

  // 进入 Step 3：三栏审阅卡片（我是谁 / 我找谁 / 排除谁）
  await page.locator('[data-gs="go-step-review"]').click();
  await expect(page.locator('[data-gs="three-layer-review"]')).toBeVisible();
  await expect(page.locator('[data-gs="three-layer-seller"]')).toContainText('HJT 700W 双面光伏组件');
  await expect(page.locator('[data-gs="three-layer-buyer"]')).toContainText('IT');
  await page.locator('[data-gs="three-layer-exclusion-input"]').fill('硅片代工厂');
  await page.locator('[data-gs="three-layer-add-exclusion"]').click();
  await expect(page.locator('[data-gs="three-layer-exclusions"]')).toContainText('硅片代工厂');

  // 一键启动寻源 → 自动完成建档、审事实、建画像、激活、启动并落入流式进度看板
  await page.locator('[data-gs="onboarding-launch-discovery"]').click();
  await page.waitForURL(/\/find-buyers/);

  await expect.poll(() => backend.callsTo('POST', '/claims/claim-1/approve').length).toBe(1);
  const icpCall = backend.callsTo('POST', `/companies/${COMPANY_ID}/icps`)[0]!.body as Record<string, unknown>;
  expect(icpCall.confirmedTargetMarkets).toEqual(['IT']);
  expect(icpCall.buyerRoles).toEqual(['distributor', 'epc']);
  expect(icpCall.peerExclusionNotes).toEqual(['硅片代工厂']);

  const activateCall = backend.callsTo('POST', `/icps/${ICP_IT}/activate`)[0]!.body as Record<string, unknown>;
  expect(activateCall.keepExistingActive).toBe(true);

  await expect(page.locator('[data-gs="streaming-progress-board"]')).toBeVisible();
  await expect(page.locator('[data-gs="streaming-stage-l0"]')).toContainText('48');
  await expect(page.locator('[data-gs="streaming-stage-l1"]')).toContainText('12');
  await expect(page.locator('[data-gs="streaming-recent-candidates"]')).toContainText('Memodo Italia S.r.l.');
});

test('多模态冷启动：官网+PDF画册组合提交、仅画册建档、返回修改资料与产品简介建档', async ({ page }) => {
  const backend = await installMockBackend(page, { onboardingComplete: false });
  backend.set('POST', '/onboarding/preview', {
    started: true,
    preview: {
      companyId: COMPANY_ID,
      name: '具安泵业',
      website: null,
      status: 'DRAFT',
      state: 'not_started',
      failure: null,
      pagesAnalyzed: 0,
      industry: { raw: null, suggested: { raw: null, code: null, label: null, labelEn: null, matched: false }, options: [] },
      products: [],
      markets: [],
    },
  });
  backend.set('POST', `/companies/${COMPANY_ID}/seller-documents/presign`, {
    documentId: DOC_ID,
    uploadUrl: `/api/companies/${COMPANY_ID}/seller-documents/${DOC_ID}/content`,
    expiresAt: NOW,
  });
  backend.set('PUT', `/companies/${COMPANY_ID}/seller-documents/${DOC_ID}/content`, { ok: true });
  backend.set('POST', `/companies/${COMPANY_ID}/seller-documents/${DOC_ID}/commit`, {
    id: DOC_ID,
    filename: 'industrial-pumps-2026.pdf',
    status: 'UPLOADED',
  });

  await loginAs(page);
  await page.waitForURL(/\/onboarding/);

  // 1. 官网 + PDF 画册组合提交：先填官网再附 PDF，不提前跳转，点主按钮后同时提交官网与画册
  await page.locator('.onboarding-section input').first().fill('具安泵业');
  await page.locator('input[placeholder*="https://"]').fill('lianstech.com');
  await page.locator('[data-gs="brochure-file-input"]').setInputFiles({
    name: 'industrial-pumps-2026.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF'),
  });
  await expect(page.locator('[data-gs="pending-brochure-list"]')).toContainText('industrial-pumps-2026.pdf');
  expect(backend.callsTo('POST', '/onboarding/preview')).toHaveLength(0);
  await page.locator('[data-gs="website-start-btn"]').click();

  await expect.poll(() => backend.callsTo('POST', `/companies/${COMPANY_ID}/seller-documents/${DOC_ID}/commit`).length).toBe(1);
  const combinedPreview = backend.callsTo('POST', '/onboarding/preview')[0]!.body as Record<string, unknown>;
  expect(combinedPreview.website).toBe('https://lianstech.com');
  await expect(page.locator('[data-gs="step2-brochure-badges"]')).toContainText('industrial-pumps-2026.pdf');

  // 2. 第 2 步可点击「返回修改资料」回到第 1 步，且保留已上传画册标记
  await page.locator('[data-gs="back-to-start-btn"]').click();
  await expect(page.locator('[data-gs="brochure-uploaded-badge"]')).toContainText('industrial-pumps-2026.pdf');

  // 3. 切换简短产品描述模式（透传 productDescription 并自动拆出产品标签）
  await page.locator('[data-gs="intake-mode-brief"]').click();
  await page.locator('[data-gs="product-brief-input"]').fill('化工离心泵、磁力驱动泵、耐腐蚀阀门');
  await page.locator('[data-gs="brief-start-btn"]').click();

  await expect.poll(() =>
    backend.callsTo('POST', '/onboarding/preview').some((c) => Boolean((c.body as Record<string, unknown>)?.productDescription)),
  ).toBe(true);
  await expect(page.locator('.product-tags')).toContainText('化工离心泵');
});

test('多模态冷启动：不填官网仅附 PDF 画册可直接进入第 2 步', async ({ page }) => {
  const backend = await installMockBackend(page, { onboardingComplete: false });
  backend.set('POST', '/onboarding/preview', {
    started: true,
    preview: {
      companyId: COMPANY_ID,
      name: '画册冷启动测试',
      website: null,
      status: 'DRAFT',
      state: 'not_started',
      failure: null,
      pagesAnalyzed: 0,
      industry: { raw: null, suggested: { raw: null, code: null, label: null, labelEn: null, matched: false }, options: [] },
      products: [],
      markets: [],
    },
  });
  backend.set('POST', `/companies/${COMPANY_ID}/seller-documents/presign`, {
    documentId: DOC_ID,
    uploadUrl: `/api/companies/${COMPANY_ID}/seller-documents/${DOC_ID}/content`,
    expiresAt: NOW,
  });
  backend.set('PUT', `/companies/${COMPANY_ID}/seller-documents/${DOC_ID}/content`, { ok: true });
  backend.set('POST', `/companies/${COMPANY_ID}/seller-documents/${DOC_ID}/commit`, {
    id: DOC_ID,
    filename: 'brochure-only.pdf',
    status: 'UPLOADED',
  });

  await loginAs(page);
  await page.waitForURL(/\/onboarding/);

  await page.locator('.onboarding-section input').first().fill('画册冷启动测试');
  await expect(page.locator('[data-gs="website-start-btn"]')).toBeDisabled();

  await page.locator('[data-gs="brochure-file-input"]').setInputFiles({
    name: 'brochure-only.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF'),
  });
  await expect(page.locator('[data-gs="website-start-btn"]')).toBeEnabled();
  await expect(page.locator('[data-gs="website-start-btn"]')).toContainText('上传画册并继续');
  await page.locator('[data-gs="website-start-btn"]').click();

  await expect.poll(() => backend.callsTo('POST', `/companies/${COMPANY_ID}/seller-documents/${DOC_ID}/commit`).length).toBe(1);
  const previewBody = backend.callsTo('POST', '/onboarding/preview')[0]!.body as Record<string, unknown>;
  expect(previewBody.website).toBeUndefined();
  await expect(page.locator('[data-gs="step2-brochure-badges"]')).toContainText('brochure-only.pdf');
});

test('1 公司多画像管理与方案 B 流式进度贯通（/find-buyers → /leads → /runs/:runId）', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/companies', [{ id: COMPANY_ID, name: '琏升新能源', targetMarkets: ['IT', 'DE'] }]);
  backend.set('GET', '/icps', [
    {
      id: ICP_IT,
      companyId: COMPANY_ID,
      name: '意大利光伏分销商',
      status: 'ACTIVE',
      companyAttributes: {
        seller_profile: { company_name: '琏升新能源', offerings: ['HJT 700W 组件'], technical_specs: ['HJT'] },
        buyer_spec: { target_roles: ['distributor'], target_markets: ['IT'], procurement_scenario: 'distribution' },
        peer_exclusions: { excluded_business_models: ['光伏组件工厂'], excluded_keywords: [], excluded_domains: [] },
      },
      painPoints: [],
      triggerSignals: [],
      exclusions: [],
      valueProps: [],
      targetMarkets: ['IT'],
      version: 1,
      personas: [],
      buyingCommittee: [],
      rules: [],
      ruleLint: [],
      createdAt: NOW,
    },
    {
      id: ICP_DE,
      companyId: COMPANY_ID,
      name: '德国光伏 EPC 总包',
      status: 'DRAFT',
      companyAttributes: {
        seller_profile: { company_name: '琏升新能源', offerings: ['BIPV 光伏瓦'] },
        buyer_spec: { target_roles: ['epc', 'installer'], target_markets: ['DE'], procurement_scenario: 'equipment_integration' },
        peer_exclusions: { excluded_business_models: ['组件制造商'], excluded_keywords: [], excluded_domains: [] },
      },
      painPoints: [],
      triggerSignals: [],
      exclusions: [],
      valueProps: [],
      targetMarkets: ['DE'],
      version: 1,
      personas: [],
      buyingCommittee: [],
      rules: [],
      ruleLint: [],
      createdAt: NOW,
    },
  ]);
  backend.set('GET', `/icps/${ICP_IT}`, {
    id: ICP_IT,
    companyId: COMPANY_ID,
    name: '意大利光伏分销商',
    status: 'ACTIVE',
    companyAttributes: {
      seller_profile: { company_name: '琏升新能源', offerings: ['HJT 700W 组件'], technical_specs: ['HJT'] },
      buyer_spec: { target_roles: ['distributor'], target_markets: ['IT'], procurement_scenario: 'distribution' },
      peer_exclusions: { excluded_business_models: ['光伏组件工厂'], excluded_keywords: [], excluded_domains: [] },
    },
    painPoints: [],
    triggerSignals: [],
    exclusions: [],
    valueProps: [],
    targetMarkets: ['IT'],
    version: 1,
    personas: [],
    buyingCommittee: [],
    rules: [],
    ruleLint: [],
    createdAt: NOW,
  });
  backend.set('GET', '/tasks', [
    {
      id: TASK_ID,
      icpId: ICP_IT,
      name: '意大利光伏寻源',
      status: 'active',
      createdBy: 'user-e2e',
      lastRunAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      runs: [{ id: 'tr-1', runId: RUN_STREAM, planId: PLAN_ID, trigger: 'manual', status: 'RUNNING', startedAt: NOW, finishedAt: null }],
    },
  ]);
  backend.set('GET', `/discovery-runs/${RUN_STREAM}/streaming-progress`, STREAMING_PROGRESS_FIXTURE);
  backend.set('GET', `/discovery-runs/${RUN_STREAM}/jobs`, []);
  backend.set('GET', `/discovery-runs/${RUN_STREAM}/events`, { events: [], nextAfter: 0 });
  backend.set('GET', `/discovery-runs/${RUN_STREAM}/trace`, { data: [], page: { next_cursor: null, has_more: false } });
  backend.set('GET', `/discovery-runs/${RUN_STREAM}`, {
    id: RUN_STREAM,
    planId: PLAN_ID,
    icpId: ICP_IT,
    status: 'RUNNING',
    mode: 'streaming',
    stats: {},
    createdAt: NOW,
  });
  backend.set('GET', '/leads', [
    {
      id: 'lead-1',
      icpId: ICP_IT,
      status: 'REVIEW',
      queue: 'recommended',
      totalScore: 92,
      company: { name: 'Memodo Italia S.r.l.', domain: 'memodo.it', country: 'IT', industry: 'Solar PV Distribution' },
    },
  ]);
  backend.set('GET', `/icps/${ICP_IT}/lead-queues`, {
    recommended: 1,
    needs_review: 0,
    rejected: 0,
    suppressed: 0,
    sanctions_hold: 0,
    scored: true,
    queueBasis: { fit_gate_preset: 0, score: 1, human_accept: 0, human_reject: 0 },
  });

  await loginAs(page);
  await page.goto('/find-buyers');

  // 1. 同一公司下两套画像清晰并列，公司切换栏可见
  await expect(page.locator('[data-gs="company-icp-switcher"]')).toBeVisible();
  await expect(page.locator('[data-gs="icp-card"]')).toHaveCount(2);

  // 打开意大利画像详情抽屉：验证三层画像卡片 + 方案 B 流式三段进度看板 + 一键跳转线索页
  await page.getByRole('button', { name: '意大利光伏分销商' }).click();
  await expect(page.locator('[data-gs="icp-three-layer"]')).toBeVisible();
  await expect(page.locator('[data-gs="streaming-progress-board"]')).toBeVisible();
  await expect(page.locator('[data-gs="streaming-view-leads"]')).toContainText('12');

  // 2. 点击查看已筛出买家直达 /leads，列表顶部展示紧凑流式进度横幅 + 实时候选买家卡片
  await page.locator('[data-gs="streaming-view-leads"]').click();
  await page.waitForURL(/\/leads/);
  await expect(page.locator('[data-gs="streaming-progress-board"]')).toBeVisible();
  await expect(page.locator('[data-gs="streaming-stage-l1"]')).toContainText('12');
  await expect(page.getByText('Memodo Italia S.r.l.')).toBeVisible();

  // 3. 打开挖掘任务运行详情页 /runs/:runId，同样展示流式三段进度与实时候选企业
  await page.goto(`/runs/${RUN_STREAM}`);
  await expect(page.locator('[data-gs="streaming-progress-board"]')).toBeVisible();
  await expect(page.locator('[data-gs="streaming-recent-candidates"]')).toContainText('Memodo Italia S.r.l.');
});
