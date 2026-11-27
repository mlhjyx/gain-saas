/**
 * Phase 2 Track 2C E2E 回归测试：
 * 1. 工作台建档（店铺链接校验、显式采用目标市场、独立生成和激活买家画像）
 * 2. 多模态冷启动（PDF 画册三步直传 + 简短主营产品描述）
 * 3. 同一企业的多份画像可从左侧切换，寻源进度通过运行详情与买家线索查看。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';
import { allowSourcing } from './support/sourcing-fixtures';

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

test('店铺建档：市场推荐显式确认，初稿生成和激活由管理员分别发起', async ({ page }) => {
  const backend = await installMockBackend(page, { onboardingComplete: false });
  allowSourcing(backend);
  const product = 'HJT 700W 双面光伏组件';
  const website = 'https://solarfactory.en.alibaba.com';
  const company = { id: COMPANY_ID, name: '日光新能源', industry: '电气设备制造', website };
  const claim = { id: 'claim-1', companyId: COMPANY_ID, type: 'capability', statement: product, version: 1 };
  const profile = {
    id: ICP_IT, companyId: COMPANY_ID, name: '意大利光伏分销与 EPC', status: 'HYPOTHESIS',
    companyAttributes: {
      seller_profile: { company_name: company.name, offerings: [product] },
      buyer_spec: { target_roles: ['distributor', 'epc'], target_markets: ['IT'] },
    },
    targetMarkets: ['IT'], createdAt: NOW, version: 1, rules: [], ruleLint: [], personas: [],
    buyingCommittee: [], exclusions: [], painPoints: [], triggerSignals: [], valueProps: [],
  };

  backend.set('POST', '/onboarding/preview', { started: true, preview: companyPreview({
    name: company.name,
    website,
    state: 'ready',
    status: 'REVIEW',
    industry: {
      raw: company.industry,
      suggested: { raw: company.industry, code: '27', label: company.industry, labelEn: 'Electrical equipment', matched: true },
      options: [{ code: '27', label: company.industry, labelEn: 'Electrical equipment' }],
    },
    products: [{ name: product, sourceUrl: website }],
  }) });
  backend.set('GET', '/companies/' + COMPANY_ID + '/market-recommendations', COMTRADE_FIXTURE);
  backend.set('POST', '/onboarding/company', async ({ body, route }) => {
    const markets = (body as { targetMarkets: string[] }).targetMarkets;
    backend.onboardingComplete = true;
    backend.set('GET', '/companies', [{ ...company, targetMarkets: markets }]);
    backend.set('GET', '/companies/' + COMPANY_ID + '/offerings', [{ id: 'offering-1', name: product }]);
    await route.fulfill({ json: { data: { ...company, targetMarkets: markets } } });
    return true;
  });
  backend.set('GET', '/companies/' + COMPANY_ID + '/claims', async ({ route, url }) => {
    const status = url.searchParams.get('status');
    await route.fulfill({ json: { data: status === 'APPROVED' ? [] : [{ ...claim, status: 'NEEDS_REVIEW' }] } });
    return true;
  });
  backend.set('POST', '/claims/claim-1/approve', async ({ route }) => {
    backend.set('GET', '/companies/' + COMPANY_ID + '/claims', [{ ...claim, status: 'APPROVED' }]);
    await route.fulfill({ json: { data: { ...claim, status: 'APPROVED' } } });
    return true;
  });
  backend.set('POST', '/companies/' + COMPANY_ID + '/icps', async ({ route }) => {
    backend.set('GET', '/icps', [profile]);
    backend.set('GET', '/icps/' + ICP_IT, profile);
    await route.fulfill({ json: { data: profile } });
    return true;
  });
  backend.set('POST', '/icps/' + ICP_IT + '/activate', async ({ route }) => {
    const active = { ...profile, status: 'ACTIVE' };
    backend.set('GET', '/icps', [active]);
    backend.set('GET', '/icps/' + ICP_IT, active);
    await route.fulfill({ json: { data: active } });
    return true;
  });

  await loginAs(page);
  await page.locator('[data-gs="intake-mode-store"]').click();
  const source = page.locator('[data-gs="setup-website"]');
  await source.fill('https://example.org/1688.com/shop');
  await expect(page.locator('[data-gs="setup-start"]')).toBeDisabled();
  await source.fill('solarfactory.en.alibaba.com');
  await page.locator('[data-gs="setup-start"]').click();
  await expect(page.locator('[data-gs="setup-product-option"]')).toHaveText(product);
  const italy = page.locator('[data-gs="comtrade-market-IT"]');
  await expect(italy).toHaveAttribute('aria-pressed', 'false');
  await italy.click();
  await expect(italy).toHaveAttribute('aria-pressed', 'true');

  await page.locator('[data-gs="setup-save"]').click();
  expect(backend.callsTo('POST', '/discovery-runs')).toHaveLength(0);
  await page.getByRole('link', { name: '建立首个买家画像' }).click();
  const dialog = page.getByRole('dialog', { name: '设定买家画像' });
  await expect(dialog.locator('[data-gs="icp-create-markets"]')).toHaveValue('IT');
  await dialog.locator('[data-gs="quick-approve-facts"]').click();
  await dialog.locator('[data-gs="create-buyer-role-distributor"]').click();
  await dialog.locator('[data-gs="create-buyer-role-epc"]').click();
  await dialog.getByRole('button', { name: '生成初稿' }).click();
  await expect(page.locator('[data-gs="icp-target-markets"]')).toHaveText('意大利');
  await expect(page.locator('[data-gs="icp-workspace-meta"]')).toHaveAttribute('href', `/companies?companyId=${COMPANY_ID}&tab=facts`);
  await page.getByRole('button', { name: '启用画像' }).click();

  expect(backend.callsTo('POST', '/onboarding/preview')[0]?.body).toMatchObject({ website });
  expect(backend.callsTo('POST', '/onboarding/company')[0]?.body).toMatchObject({ products: [product], targetMarkets: ['IT'] });
  expect(backend.callsTo('POST', '/claims/claim-1/approve')).toHaveLength(1);
  expect(backend.callsTo('POST', '/claims/claim-1/approve')[0]?.body).toEqual({
    expectedVersion: 1,
  });
  expect(backend.callsTo('POST', '/companies/' + COMPANY_ID + '/icps')[0]?.body).toMatchObject({
    confirmedTargetMarkets: ['IT'], buyerRoles: ['distributor', 'epc'],
  });
  await expect.poll(() => backend.callsTo('POST', '/icps/' + ICP_IT + '/activate').length).toBe(1);
  expect(backend.callsTo('POST', '/tasks')).toHaveLength(0);
});

function companyPreview(overrides: Record<string, unknown> = {}) {
  return {
    companyId: COMPANY_ID,
    name: '具安泵业',
    website: null,
    status: 'DRAFT',
    state: 'not_started',
    failure: null,
    pagesAnalyzed: 0,
    industry: { raw: null, suggested: null, options: [] },
    products: [],
    markets: [],
    ...overrides,
  };
}

for (const withWebsite of [true, false]) {
  test(withWebsite ? '官网和 PDF 画册可组合提交，切页后上传继续' : '仅凭 PDF 建档，在确认页改用产品简介', async ({ page }) => {
    const backend = await installMockBackend(page, { onboardingComplete: false });
    const documentPath = '/companies/' + COMPANY_ID + '/seller-documents/' + DOC_ID;
    let releasePreview!: () => void;
    const previewGate = new Promise<void>((resolve) => { releasePreview = resolve; });
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve; });
    backend.set('POST', '/onboarding/preview', async ({ body, route }) => {
      if (withWebsite) await previewGate;
      const input = body as { website?: string; productDescription?: string };
      await route.fulfill({ json: { data: { started: true, preview: companyPreview({
        website: input.website,
        products: input.productDescription ? [{ name: '化工离心泵' }] : [],
      }) } } });
      return true;
    });
    backend.set('POST', '/companies/' + COMPANY_ID + '/seller-documents/presign', {
      documentId: DOC_ID,
      uploadMode: 'direct',
      directUploadSupported: true,
      uploadUrl: '/api' + documentPath + '/content',
      expiresAt: NOW,
    });
    backend.set('PUT', documentPath + '/content', async ({ route }) => {
      if (withWebsite) await uploadGate;
      await route.fulfill({ json: { data: { ok: true } } });
      return true;
    });
    backend.set('POST', documentPath + '/commit', { id: DOC_ID, filename: 'pumps.pdf', status: 'queued' });
    backend.set('GET', '/seller-documents/' + DOC_ID, { id: DOC_ID, filename: 'pumps.pdf', status: 'ready' });

    await loginAs(page);
    if (withWebsite) await page.locator('[data-gs="setup-website"]').fill('pumps.example.org');
    else await expect(page.locator('[data-gs="setup-start"]')).toBeDisabled();
    await page.locator('[data-gs="brochure-file-input"]').setInputFiles({
      name: 'pumps.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF'),
    });
    await expect(page.locator('[data-gs="pending-brochure-list"]')).toContainText('pumps.pdf');
    await page.locator('[data-gs="setup-start"]').click();
    if (withWebsite) {
      await expect.poll(() => backend.callsTo('POST', '/onboarding/preview').length).toBe(1);
      await page.getByRole('link', { name: '查看企业档案' }).click();
      await expect(page).toHaveURL(/\/companies\?/);
      releasePreview();
    } else {
      await expect(page.locator('[data-gs="setup-brochure-summary"]')).toContainText('pumps.pdf');
    }
    await expect.poll(() => backend.callsTo('PUT', documentPath + '/content').length).toBe(1);
    expect((backend.callsTo('POST', '/onboarding/preview')[0]?.body as { website?: string }).website)
      .toBe(withWebsite ? 'https://pumps.example.org' : undefined);

    if (withWebsite) {
      expect(backend.callsTo('POST', documentPath + '/commit')).toHaveLength(0);
      await expect(page.locator('[data-gs="upload-queue-tray"]')).toBeVisible();
      releaseUpload();
    }
    await expect.poll(() => backend.callsTo('POST', documentPath + '/commit').length).toBe(1);

    if (!withWebsite) {
      await page.locator('[data-gs="back-to-start-btn"]').click();
      await expect(page.locator('[data-gs="setup-brochure-summary"]')).toContainText('pumps.pdf');
      await page.locator('[data-gs="product-brief-input"]').fill('化工离心泵、磁力驱动泵');
      await page.locator('[data-gs="setup-start"]').click();
      await expect(page.locator('[data-gs="setup-product-option"]')).toHaveText('化工离心泵');
      expect(backend.callsTo('POST', '/onboarding/preview').at(-1)?.body).toMatchObject({
        productDescription: '化工离心泵、磁力驱动泵',
      });
      expect(backend.callsTo('POST', documentPath + '/commit')).toHaveLength(1);
    }
    expect(backend.callsTo('POST', '/onboarding/company')).toHaveLength(0);
  });
}

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

  await expect(page.locator('[data-gs="icp-profile-switcher"]').locator('[data-gs="icp-card"]')).toHaveCount(2);
  await expect(page.locator('[data-gs="icp-target-markets"]')).toHaveText('意大利');
  await expect(page.locator('[data-gs="streaming-progress-board"]')).toHaveCount(0);
  await page.getByRole('link', { name: '查看寻源进度', exact: true }).click();
  await expect(page).toHaveURL(`/runs/${RUN_STREAM}?tab=progress`);
  await expect(page.locator('[data-gs="streaming-progress-board"]')).toBeVisible();
  await expect(page.locator('[data-gs="streaming-stage-l1"]')).toContainText('12');
  await expect(page.locator('[data-gs="streaming-recent-candidates"]')).toContainText('Memodo Italia S.r.l.');
  await page.goto(`/leads?icp=${ICP_IT}`);
  await expect(page.locator('[data-gs="streaming-progress-board"]')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Memodo Italia S.r.l.', exact: true })).toBeVisible();
});
