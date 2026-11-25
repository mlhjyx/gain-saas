import { describe, expect, it } from 'vitest';

import {
  buildThreeLayerPreview,
  derivePeerExclusions,
  deriveStreamingFunnelProgress,
  extractThreeLayerFromIcp,
  isSellerMarketplaceStoreUrl,
  normalizeComtradeBundle,
  normalizeComtradeRecommendations,
  parseSellerIntakeSource,
} from './acquisition-streaming.js';

describe('Phase 2 Track 2C: seller intake, three-layer profile, Comtrade & streaming progress (#51 aligned)', () => {
  it('distinguishes official websites from whitelisted 1688/Alibaba seller store links and rejects spoofed hosts', () => {
    expect(isSellerMarketplaceStoreUrl('https://shop123.1688.com/page/offerlist.htm')).toBe(true);
    expect(isSellerMarketplaceStoreUrl('https://solarfactory.en.alibaba.com')).toBe(true);
    expect(isSellerMarketplaceStoreUrl('1688.com/shop/abc')).toBe(true);
    expect(isSellerMarketplaceStoreUrl('https://evil.example/1688.com/shop')).toBe(false);
    expect(isSellerMarketplaceStoreUrl('https://fake-1688.com/shop')).toBe(false);
    expect(isSellerMarketplaceStoreUrl('https://alibaba.com.evil.example/store')).toBe(false);
    expect(isSellerMarketplaceStoreUrl('javascript:alert(1)')).toBe(false);

    expect(parseSellerIntakeSource('solarfactory.en.alibaba.com')).toMatchObject({
      kind: 'alibaba_store',
      marketplace: 'alibaba_intl',
      normalizedUrl: 'https://solarfactory.en.alibaba.com',
      host: 'solarfactory.en.alibaba.com',
    });
    expect(parseSellerIntakeSource('shop99.1688.com')).toMatchObject({
      kind: 'alibaba_store',
      marketplace: '1688',
      normalizedUrl: 'https://shop99.1688.com',
    });
    expect(parseSellerIntakeSource('www.lianstech.com')).toMatchObject({
      kind: 'website',
      normalizedUrl: 'https://www.lianstech.com',
      host: 'www.lianstech.com',
    });
    expect(parseSellerIntakeSource('not-a-url')).toMatchObject({ kind: 'invalid' });
    expect(parseSellerIntakeSource('ftp://example.com')).toMatchObject({ kind: 'invalid' });
    expect(parseSellerIntakeSource('   ')).toMatchObject({ kind: 'empty' });
  });

  it('derives clean three-layer preview and parses exact 2A #51 snake_case object structure', () => {
    const pvExclusions = derivePeerExclusions(['HJT 700W 光伏组件', 'N型双面太阳能组件'], '光伏设备制造');
    expect(pvExclusions.length).toBeGreaterThan(0);

    const preview = buildThreeLayerPreview({
      companyName: '琏升新能源',
      industry: '光伏设备制造',
      products: ['HJT 700W 光伏组件', 'BIPV 光伏瓦'],
      targetMarkets: ['it', 'DE', 'invalid'],
      buyerRoles: ['distributor', 'epc'],
      procurementScenario: 'distribution',
      customExclusions: ['硅片代工厂'],
      sourceSummary: '产品画册 PDF',
    });
    expect(preview.sellerProfile.products).toEqual(['HJT 700W 光伏组件', 'BIPV 光伏瓦']);
    expect(preview.buyerSpec.targetMarkets).toEqual(['IT', 'DE']);
    expect(preview.buyerSpec.buyerRoles).toEqual(['distributor', 'epc']);
    expect(preview.buyerSpec.procurementScenario).toBe('distribution');
    expect(preview.peerExclusions.combined).toContain('硅片代工厂');

    // Exact 2A #51 schema: seller_profile / buyer_spec / peer_exclusions object
    const extracted = extractThreeLayerFromIcp({
      name: '意大利光伏分销与 EPC',
      targetMarkets: ['IT', 'ES'],
      exclusions: ['手工补充排除词'],
      valueProps: ['700W 高效组件'],
      companyAttributes: {
        seller_profile: {
          company_name: '琏升新能源',
          industry: '光伏设备制造',
          offerings: ['HJT 700W 光伏组件'],
          technical_specs: ['HJT', '0BB', 'G12'],
          source_channel: 'alibaba_intl',
        },
        buyer_spec: {
          target_roles: ['distributor', 'epc'],
          trade_side: 'distributor',
          product_categories: ['Solar PV Distribution'],
          industries: ['Renewable Energy'],
          target_markets: ['IT', 'ES'],
          procurement_scenario: 'distribution',
        },
        peer_exclusions: {
          excluded_business_models: ['Solar module OEM'],
          excluded_keywords: ['cell manufacturer'],
          excluded_domains: ['futurasun.com'],
          rationale: '避免命中同类上游光伏制造同行',
        },
        procurement_scenario_drafts: [
          { scenario: 'distribution', label: '欧洲光伏渠道分销', recommended: true },
        ],
      },
    });
    expect(extracted.sellerProfile.companyName).toBe('琏升新能源');
    expect(extracted.sellerProfile.products).toEqual(['HJT 700W 光伏组件']);
    expect(extracted.sellerProfile.technicalSpecs).toEqual(['HJT', '0BB', 'G12']);
    expect(extracted.buyerSpec.buyerRoles).toEqual(['distributor', 'epc']);
    expect(extracted.buyerSpec.procurementScenario).toBe('distribution');
    expect(extracted.buyerSpec.procurementScenarios).toContain('欧洲光伏渠道分销');
    expect(extracted.peerExclusions.autoDerived).toEqual([
      'Solar module OEM',
      'cell manufacturer',
      'futurasun.com',
    ]);
    expect(extracted.peerExclusions.combined).toContain('手工补充排除词');
    expect(extracted.peerExclusions.rationale).toBe('避免命中同类上游光伏制造同行');
  });

  it('normalizes exact 2A #51 UN Comtrade market-recommendations payload', () => {
    const bundle = normalizeComtradeBundle({
      companyId: 'comp-1',
      isRecommendationOnly: true,
      basis: {
        hsCodes: [{ code: '854143', label: 'Photovoltaic cells in modules', labelZh: '光伏组件', matchedFrom: 'offering' }],
        inferredFrom: 'offerings_and_industry',
        dataSource: 'un_comtrade_baseline_v1',
        referenceYear: 2024,
      },
      recommendations: [
        {
          code: 'it',
          name: '意大利',
          labelEn: 'Italy',
          rank: 1,
          hsCodes: ['854143'],
          importVolumeUsd: 2_450_000_000,
          yoyGrowthPct: 18.4,
          globalImportSharePct: 5.2,
          rationale: '欧洲分布式光伏装机增速领先',
          confidence: 'high',
          alreadySelected: false,
        },
        { code: 'INVALID', name: '坏数据' },
      ],
    });
    expect(bundle.isRecommendationOnly).toBe(true);
    expect(bundle.referenceYear).toBe(2024);
    expect(bundle.basisHsCodes[0]?.code).toBe('854143');
    expect(bundle.recommendations).toHaveLength(1);
    expect(bundle.recommendations[0]).toMatchObject({
      code: 'IT',
      name: '意大利',
      labelEn: 'Italy',
      hsCode: '854143',
      importValueUsd: 2_450_000_000,
      yoyGrowthPct: 18.4,
      globalImportSharePct: 5.2,
      confidence: 'high',
    });
    expect(normalizeComtradeRecommendations(bundle.recommendations)).toHaveLength(1);
  });

  it('projects exact 2A #51 streaming-progress DTO including recentCandidates and falls back to Run 2.0 jobs', () => {
    const dtoResult = deriveStreamingFunnelProgress({
      streamingProgress: {
        runId: 'run-stream-1',
        pipelineMode: 'streaming',
        runStatus: 'RUNNING',
        currentStage: 'l2_topk_enrich',
        updatedAt: '2026-11-26T00:01:30.000Z',
        stages: {
          l0Recall: {
            status: 'done',
            queriesTotal: 4,
            queriesCompleted: 4,
            candidatesRecalled: 48,
            canonicalUpserted: 42,
            startedAt: '2026-11-26T00:00:00.000Z',
            completedAt: '2026-11-26T00:00:20.000Z',
          },
          l1ExtractFit: {
            status: 'done',
            total: 42,
            processed: 42,
            rawHttpHits: 35,
            crawl4aiFallbacks: 7,
            pdfSkipped: 3,
            wwwRetries: 2,
            fitMatch: 14,
            fitWeak: 8,
            fitMismatch: 20,
            failed: 0,
          },
          l2TopKEnrich: {
            status: 'running',
            topKCap: 14,
            selected: 14,
            enriched: 5,
            contactsFound: 11,
            watchesRegistered: 4,
            failed: 0,
          },
        },
        recentCandidates: [
          {
            companyId: 'c-1',
            name: 'Memodo Italia S.r.l.',
            domain: 'memodo.it',
            country: 'IT',
            stage: 'done',
            fitVerdict: 'match',
            fitScore: 91,
            fetchMethod: 'raw_http',
            channelsFound: { emails: 2, phones: 1, forms: 1, socials: 1 },
            reasonSummary: '意大利头部光伏分销商，官网明确主营组件批发',
            updatedAt: '2026-11-26T00:01:25.000Z',
          },
        ],
      },
      nowMs: Date.parse('2026-11-26T00:01:30.000Z'),
    });
    expect(dtoResult.isStreamingMode).toBe(true);
    expect(dtoResult.isRunning).toBe(true);
    expect(dtoResult.activeStage).toBe('L2');
    expect(dtoResult.l0.recalled).toBe(48);
    expect(dtoResult.l0.persisted).toBe(42);
    expect(dtoResult.l1.matched).toBe(14);
    expect(dtoResult.l1.pdfSkipped).toBe(3);
    expect(dtoResult.httpFirstRatioPct).toBe(83);
    expect(dtoResult.l2.contactsFound).toBe(11);
    expect(dtoResult.l2.verifiedEmails).toBe(2);
    expect(dtoResult.readyCandidates).toBe(14);
    expect(dtoResult.recentCandidates).toHaveLength(1);
    expect(dtoResult.recentCandidates[0]?.name).toBe('Memodo Italia S.r.l.');
    expect(dtoResult.elapsedSec).toBe(90);

    // Legacy fallback still works seamlessly
    const legacy = deriveStreamingFunnelProgress({
      run: {
        status: 'DONE',
        stats: { quickScan: { poolSize: 20, match: 6, weak: 4, mismatch: 10 } },
      },
      jobs: [
        { stage: 'done', verdictQuick: 'match', verdictDeep: 'match' },
        { stage: 'contacts', verdictQuick: 'match', verdictDeep: 'match' },
        { stage: 'prefiltered_out', verdictQuick: 'mismatch', verdictDeep: null },
      ],
    });
    expect(legacy.isStreamingMode).toBe(false);
    expect(legacy.isTerminal).toBe(true);
    expect(legacy.activeStage).toBe('DONE');
    expect(legacy.l1.matched).toBe(6);
  });
});
