/**
 * Phase 2 Track 2C 共享纯函数（严格对齐 2A 契约 #51）：
 * 1) 多模态卖家冷启动链接分类与 1688/阿里国际站卖家专属白名单（严格按 URL.hostname 校验）；
 * 2) 三层解耦画像视图（我是谁 sellerProfile / 我找谁 buyerSpec / 排除谁 peerExclusions）；
 * 3) UN Comtrade 目标国推荐响应归一化；
 * 4) 方案 B 流式三段进度看板投影（L0 召回 → L1 极速提取与判分 → L2 Top-K 联系人与邮箱验真），
 *    直接兼容 `GET /discovery-runs/:runId/streaming-progress`、既有 `stats.streaming` 及 Run 2.0 兜底。
 */
import { normalizeWebsiteUrl } from './outreach-t0.js';

export type BuyerRoleCode =
  | 'developer'
  | 'distributor'
  | 'epc'
  | 'factory_direct'
  | 'installer'
  | 'wholesaler';

export const BUYER_ROLE_CODES: readonly BuyerRoleCode[] = [
  'distributor',
  'wholesaler',
  'epc',
  'installer',
  'developer',
  'factory_direct',
] as const;

export type ProcurementScenarioCode =
  | 'distribution'
  | 'equipment_integration'
  | 'factory_direct';

export const PROCUREMENT_SCENARIO_CODES: readonly ProcurementScenarioCode[] = [
  'distribution',
  'factory_direct',
  'equipment_integration',
] as const;

export interface SellerIntakeSourceResult {
  kind: 'alibaba_store' | 'empty' | 'invalid' | 'website';
  normalizedUrl: string;
  host: string | null;
  marketplace?: '1688' | 'alibaba_intl';
}

function parseHttpHostname(raw: unknown): { normalizedUrl: string; host: string } | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalizedUrl = normalizeWebsiteUrl(trimmed);
  try {
    const parsed = new URL(normalizedUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    const host = parsed.hostname.toLowerCase();
    if (!host || (!host.includes('.') && host !== 'localhost')) return null;
    return { normalizedUrl, host };
  } catch {
    return null;
  }
}

/**
 * 严格按 hostname 判定是否为卖家自建档白名单店铺（仅限 1688 / 阿里国际站，与买家黑名单彻底隔离）。
 */
export function isSellerMarketplaceStoreUrl(raw: unknown): raw is string {
  const parsed = parseHttpHostname(raw);
  if (!parsed) return false;
  const { host } = parsed;
  return (
    host === '1688.com' ||
    host.endsWith('.1688.com') ||
    host === 'alibaba.com' ||
    host.endsWith('.alibaba.com')
  );
}

export function parseSellerIntakeSource(raw: string): SellerIntakeSourceResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { kind: 'empty', normalizedUrl: '', host: null };
  }
  const parsed = parseHttpHostname(trimmed);
  if (!parsed) {
    return { kind: 'invalid', normalizedUrl: '', host: null };
  }
  const { host, normalizedUrl } = parsed;
  if (host === '1688.com' || host.endsWith('.1688.com')) {
    return { kind: 'alibaba_store', marketplace: '1688', normalizedUrl, host };
  }
  if (host === 'alibaba.com' || host.endsWith('.alibaba.com')) {
    return { kind: 'alibaba_store', marketplace: 'alibaba_intl', normalizedUrl, host };
  }
  return { kind: 'website', normalizedUrl, host };
}

export interface ThreeLayerProfileView {
  sellerProfile: {
    companyName: string;
    industry: string;
    products: string[];
    sellingPoints: string[];
    technicalSpecs: string[];
    sourceSummary: string;
  };
  buyerSpec: {
    targetMarkets: string[];
    buyerRoles: string[];
    categoryBroad: string;
    procurementScenario: string | null;
    procurementScenarios: string[];
    keywords: string[];
  };
  peerExclusions: {
    autoDerived: string[];
    custom: string[];
    combined: string[];
    rationale: string | null;
  };
}

function uniqueStrings(values: ReadonlyArray<unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const clean = raw.trim();
    if (!clean) continue;
    const lower = clean.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(clean);
  }
  return out;
}

function normalizeMarketCodes(values: ReadonlyArray<unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const upper = raw.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(upper) || seen.has(upper)) continue;
    seen.add(upper);
    out.push(upper);
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return uniqueStrings(value);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

/**
 * 按卖方产品与行业自动派生同行排除词（避免卖组件搜出组件厂、卖泵阀搜出竞品泵厂）。
 */
export function derivePeerExclusions(
  products: ReadonlyArray<string>,
  industry?: string | null,
): string[] {
  const corpus = [...products, industry ?? ''].join(' ').toLowerCase();
  const derived: string[] = [];
  if (/光伏|太阳能|组件|电池片|逆变器|储能|solar|pv|photovoltaic|bipv|hjt|topcon/i.test(corpus)) {
    derived.push('同类光伏组件/电池片制造商', '上游硅片与辅材代工厂');
  }
  if (/泵|阀|压缩机|流体|pump|valve|compressor|hydraulic/i.test(corpus)) {
    derived.push('同类工业泵阀整机制造商', '竞品流体设备原厂');
  }
  if (/机器人|机械臂|伺服|自动化|传感器|robot|cobot|servo|automation|plc/i.test(corpus)) {
    derived.push('同类工业机器人本体厂商', '纯软件 RPA 服务商');
  }
  if (/医疗|器械|诊断|医用|medical|ivd|surgical|clinic/i.test(corpus)) {
    derived.push('同类医疗器械生产原厂', '非医疗美容消费品商户');
  }
  if (/机加工|cnc|冲压|注塑|钣金|轴承|紧固件|machining|casting|stamping|bearing/i.test(corpus)) {
    derived.push('同类代工加工厂与外协同行');
  }
  if (derived.length === 0 && products.length > 0) {
    derived.push('同赛道上游生产制造商', '竞品原厂与纯贸易同行');
  }
  return uniqueStrings(derived);
}

export function buildThreeLayerPreview(input: {
  companyName?: string | null;
  industry?: string | null;
  products?: ReadonlyArray<string>;
  sellingPoints?: ReadonlyArray<string>;
  technicalSpecs?: ReadonlyArray<string>;
  sourceSummary?: string | null;
  targetMarkets?: ReadonlyArray<string>;
  buyerRoles?: ReadonlyArray<string>;
  categoryBroad?: string | null;
  procurementScenario?: string | null;
  procurementScenarios?: ReadonlyArray<string>;
  customExclusions?: ReadonlyArray<string>;
}): ThreeLayerProfileView {
  const products = uniqueStrings(input.products ?? []);
  const autoDerived = derivePeerExclusions(products, input.industry);
  const custom = uniqueStrings(input.customExclusions ?? []);
  return {
    sellerProfile: {
      companyName: (input.companyName ?? '').trim(),
      industry: (input.industry ?? '').trim(),
      products,
      sellingPoints: uniqueStrings(input.sellingPoints ?? []),
      technicalSpecs: uniqueStrings(input.technicalSpecs ?? []),
      sourceSummary: (input.sourceSummary ?? '').trim(),
    },
    buyerSpec: {
      targetMarkets: normalizeMarketCodes(input.targetMarkets ?? []),
      buyerRoles: uniqueStrings(input.buyerRoles ?? []),
      categoryBroad: (input.categoryBroad ?? '').trim(),
      procurementScenario: input.procurementScenario?.trim() || null,
      procurementScenarios: uniqueStrings(input.procurementScenarios ?? []),
      keywords: [],
    },
    peerExclusions: {
      autoDerived,
      custom,
      combined: uniqueStrings([...autoDerived, ...custom]),
      rationale: null,
    },
  };
}

/**
 * 从后端 `Icp` 对象提取三层画像（严格兼容 2A #51 snake_case 对象与历史格式）。
 */
export function extractThreeLayerFromIcp(icp: {
  name?: string | null;
  targetMarkets?: ReadonlyArray<string>;
  exclusions?: ReadonlyArray<string>;
  valueProps?: ReadonlyArray<string>;
  companyAttributes?: Record<string, unknown> | null;
  companyName?: string | null;
}): ThreeLayerProfileView {
  const attrs = asRecord(icp.companyAttributes);
  const sellerObj = asRecord(attrs['seller_profile'] ?? attrs['sellerProfile']);
  const buyerObj = asRecord(attrs['buyer_spec'] ?? attrs['buyerSpec']);

  const sellerProducts = uniqueStrings([
    ...asStringList(sellerObj['offerings']),
    ...asStringList(sellerObj['products']),
    ...asStringList(attrs['inputProducts']),
    ...asStringList(attrs['input_products']),
  ]);
  const technicalSpecs = uniqueStrings([
    ...asStringList(sellerObj['technical_specs']),
    ...asStringList(sellerObj['technicalSpecs']),
  ]);
  const sellingPoints = uniqueStrings([
    ...asStringList(sellerObj['selling_points']),
    ...asStringList(sellerObj['sellingPoints']),
    ...(icp.valueProps ?? []),
  ]);
  const sellerIndustry =
    (typeof sellerObj['industry'] === 'string' && sellerObj['industry'].trim()) ||
    (typeof attrs['industry'] === 'string' && attrs['industry'].trim()) ||
    '';
  const sourceChannel =
    (typeof sellerObj['source_channel'] === 'string' && sellerObj['source_channel'].trim()) ||
    (typeof sellerObj['source_summary'] === 'string' && sellerObj['source_summary'].trim()) ||
    (typeof sellerObj['sourceSummary'] === 'string' && sellerObj['sourceSummary'].trim()) ||
    '';

  const buyerRoles = uniqueStrings([
    ...asStringList(buyerObj['target_roles']),
    ...asStringList(buyerObj['buyer_roles']),
    ...asStringList(buyerObj['buyerRoles']),
    ...asStringList(attrs['buyer_roles']),
    ...asStringList(attrs['buyerRoles']),
  ]);
  const buyerCategories = uniqueStrings([
    ...asStringList(buyerObj['product_categories']),
    ...asStringList(buyerObj['industries']),
  ]);
  const categoryBroad =
    (typeof buyerObj['buyer_category_broad'] === 'string' && buyerObj['buyer_category_broad'].trim()) ||
    (typeof buyerObj['categoryBroad'] === 'string' && buyerObj['categoryBroad'].trim()) ||
    (buyerCategories.length > 0 ? buyerCategories.join(' · ') : '') ||
    (typeof attrs['sub_industry'] === 'string' && attrs['sub_industry'].trim()) ||
    '';

  const procurementScenarioRaw =
    buyerObj['procurement_scenario'] ?? attrs['procurement_scenario'] ?? attrs['procurementScenario'];
  const procurementScenario =
    typeof procurementScenarioRaw === 'string' && procurementScenarioRaw.trim()
      ? procurementScenarioRaw.trim()
      : null;

  const scenarioSource =
    attrs['procurement_scenario_drafts'] ??
    buyerObj['procurement_scenarios'] ??
    buyerObj['procurementScenarios'] ??
    attrs['procurement_scenarios'] ??
    attrs['procurementScenarios'];
  const procurementScenarios = Array.isArray(scenarioSource)
    ? uniqueStrings(
        scenarioSource.map((item) => {
          if (typeof item === 'string') return item;
          const rec = asRecord(item);
          return rec['label'] ?? rec['name'] ?? rec['summary'] ?? rec['title'] ?? rec['scenario'] ?? '';
        }),
      )
    : asStringList(scenarioSource);

  const buyerKeywords = uniqueStrings([
    ...asStringList(buyerObj['keywords']),
    ...asStringList(attrs['keywords']),
  ]);

  // 2A #51: peer_exclusions 既可能是对象 { excluded_business_models, excluded_keywords, excluded_domains, rationale }，也可能兼容字符串数组
  const rawPeerValue = attrs['peer_exclusions'] ?? attrs['peerExclusions'];
  let autoPeer: string[] = [];
  let peerRationale: string | null = null;
  if (Array.isArray(rawPeerValue)) {
    autoPeer = uniqueStrings(rawPeerValue);
  } else if (rawPeerValue && typeof rawPeerValue === 'object') {
    const peerObj = asRecord(rawPeerValue);
    autoPeer = uniqueStrings([
      ...asStringList(peerObj['excluded_business_models']),
      ...asStringList(peerObj['excluded_keywords']),
      ...asStringList(peerObj['excluded_domains']),
    ]);
    if (typeof peerObj['rationale'] === 'string' && peerObj['rationale'].trim()) {
      peerRationale = peerObj['rationale'].trim();
    }
  }
  const manualExclusions = uniqueStrings(icp.exclusions ?? []);
  const combinedExclusions = uniqueStrings([...autoPeer, ...manualExclusions]);

  return {
    sellerProfile: {
      companyName:
        (typeof sellerObj['company_name'] === 'string' && sellerObj['company_name'].trim()) ||
        (typeof sellerObj['companyName'] === 'string' && sellerObj['companyName'].trim()) ||
        (icp.companyName ?? '').trim(),
      industry: sellerIndustry,
      products: sellerProducts,
      sellingPoints,
      technicalSpecs,
      sourceSummary: sourceChannel,
    },
    buyerSpec: {
      targetMarkets: normalizeMarketCodes([
        ...(icp.targetMarkets ?? []),
        ...asStringList(buyerObj['target_markets']),
        ...asStringList(buyerObj['targetMarkets']),
      ]),
      buyerRoles,
      categoryBroad,
      procurementScenario,
      procurementScenarios,
      keywords: buyerKeywords,
    },
    peerExclusions: {
      autoDerived: autoPeer,
      custom: manualExclusions,
      combined: combinedExclusions,
      rationale: peerRationale,
    },
  };
}

export interface ComtradeHsBasisItem {
  code: string;
  label: string;
  labelZh?: string;
  matchedFrom?: string;
}

export interface ComtradeMarketRecommendation {
  code: string;
  name: string;
  labelEn: string | null;
  rank: number | null;
  hsCode: string | null;
  hsCodes: string[];
  importValueUsd: number | null;
  yoyGrowthPct: number | null;
  globalImportSharePct: number | null;
  reason: string | null;
  confidence: 'high' | 'low' | 'medium' | null;
  alreadySelected: boolean;
  score: number | null;
}

export interface ComtradeRecommendationBundle {
  companyId: string | null;
  isRecommendationOnly: boolean;
  inferredFrom: string | null;
  dataSource: string | null;
  referenceYear: number | null;
  basisHsCodes: ComtradeHsBasisItem[];
  recommendations: ComtradeMarketRecommendation[];
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizeComtradeRecommendations(raw: unknown): ComtradeMarketRecommendation[] {
  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    const candidate =
      rec['recommendations'] ?? rec['markets'] ?? rec['items'] ?? rec['countries'] ?? rec['data'];
    if (Array.isArray(candidate)) list = candidate;
  }
  const seen = new Set<string>();
  const out: ComtradeMarketRecommendation[] = [];
  for (const entry of list) {
    const rec = asRecord(entry);
    const rawCode = rec['code'] ?? rec['countryCode'] ?? rec['country_code'] ?? rec['iso2'];
    if (typeof rawCode !== 'string') continue;
    const code = rawCode.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code) || seen.has(code)) continue;
    seen.add(code);
    const nameRaw = rec['name'] ?? rec['countryName'] ?? rec['country_name'] ?? rec['label'];
    const labelEnRaw = rec['labelEn'] ?? rec['label_en'];
    const hsCodes = uniqueStrings([
      ...asStringList(rec['hsCodes']),
      ...asStringList(rec['hs_codes']),
      ...asStringList(rec['hsCode']),
      ...asStringList(rec['hs_code']),
    ]);
    const reasonRaw = rec['rationale'] ?? rec['reason'] ?? rec['summary'];
    const confRaw = rec['confidence'];
    const confidence =
      confRaw === 'high' || confRaw === 'medium' || confRaw === 'low' ? confRaw : null;
    out.push({
      code,
      name: typeof nameRaw === 'string' && nameRaw.trim() ? nameRaw.trim() : code,
      labelEn: typeof labelEnRaw === 'string' && labelEnRaw.trim() ? labelEnRaw.trim() : null,
      rank: finiteNumber(rec['rank']),
      hsCode: hsCodes[0] ?? null,
      hsCodes,
      importValueUsd: finiteNumber(
        rec['importVolumeUsd'] ??
          rec['importValueUsd'] ??
          rec['import_value_usd'] ??
          rec['tradeValueUsd'] ??
          rec['importUsd'],
      ),
      yoyGrowthPct: finiteNumber(
        rec['yoyGrowthPct'] ?? rec['yoy_growth_pct'] ?? rec['growthPct'] ?? rec['yoyPct'],
      ),
      globalImportSharePct: finiteNumber(
        rec['globalImportSharePct'] ?? rec['global_import_share_pct'],
      ),
      reason: typeof reasonRaw === 'string' && reasonRaw.trim() ? reasonRaw.trim() : null,
      confidence,
      alreadySelected: Boolean(rec['alreadySelected']),
      score: finiteNumber(rec['score']),
    });
  }
  return out;
}

export function normalizeComtradeBundle(raw: unknown): ComtradeRecommendationBundle {
  const rec = asRecord(raw);
  const basis = asRecord(rec['basis']);
  const rawHs = Array.isArray(basis['hsCodes']) ? basis['hsCodes'] : [];
  const basisHsCodes: ComtradeHsBasisItem[] = [];
  for (const item of rawHs) {
    const row = asRecord(item);
    const code = typeof row['code'] === 'string' ? row['code'].trim() : '';
    if (!code) continue;
    basisHsCodes.push({
      code,
      label: typeof row['label'] === 'string' ? row['label'].trim() : code,
      labelZh: typeof row['labelZh'] === 'string' ? row['labelZh'].trim() : undefined,
      matchedFrom: typeof row['matchedFrom'] === 'string' ? row['matchedFrom'].trim() : undefined,
    });
  }
  return {
    companyId: typeof rec['companyId'] === 'string' ? rec['companyId'] : null,
    isRecommendationOnly: rec['isRecommendationOnly'] !== false,
    inferredFrom: typeof basis['inferredFrom'] === 'string' ? basis['inferredFrom'] : null,
    dataSource: typeof basis['dataSource'] === 'string' ? basis['dataSource'] : null,
    referenceYear: finiteNumber(basis['referenceYear']),
    basisHsCodes,
    recommendations: normalizeComtradeRecommendations(raw),
  };
}

export type FunnelStageStatus = 'done' | 'idle' | 'running' | 'stopped';

export interface StreamingRecentCandidate {
  companyId: string;
  name: string;
  domain: string | null;
  country: string | null;
  stage: string;
  fitVerdict: 'match' | 'mismatch' | 'weak' | null;
  fitScore: number | null;
  fetchMethod: 'crawl4ai' | 'raw_http' | 'skipped' | null;
  channelsFound: {
    emails: number;
    phones: number;
    forms: number;
    socials: number;
  };
  reasonSummary: string | null;
  updatedAt: string | null;
}

/** 2A #51 `GET /discovery-runs/:runId/streaming-progress` 响应 DTO */
export interface StreamingProgressDto {
  runId: string;
  pipelineMode: 'legacy' | 'streaming';
  runStatus: string;
  currentStage:
    | 'cancelled'
    | 'done'
    | 'failed'
    | 'finalizing'
    | 'l0_recall'
    | 'l1_extract_fit'
    | 'l2_topk_enrich'
    | string;
  updatedAt?: string;
  stages?: {
    l0Recall?: {
      status?: string;
      queriesTotal?: number;
      queriesCompleted?: number;
      candidatesRecalled?: number;
      canonicalUpserted?: number;
      startedAt?: string | null;
      completedAt?: string | null;
    };
    l1ExtractFit?: {
      status?: string;
      total?: number;
      processed?: number;
      rawHttpHits?: number;
      crawl4aiFallbacks?: number;
      pdfSkipped?: number;
      wwwRetries?: number;
      fitMatch?: number;
      fitWeak?: number;
      fitMismatch?: number;
      failed?: number;
      startedAt?: string | null;
      completedAt?: string | null;
    };
    l2TopKEnrich?: {
      status?: string;
      topKCap?: number;
      selected?: number;
      enriched?: number;
      contactsFound?: number;
      watchesRegistered?: number;
      failed?: number;
      startedAt?: string | null;
      completedAt?: string | null;
    };
  };
  recentCandidates?: Array<Record<string, unknown>>;
}

export interface StreamingFunnelProgress {
  isStreamingMode: boolean;
  isRunning: boolean;
  isTerminal: boolean;
  activeStage: 'DONE' | 'L0' | 'L1' | 'L2' | 'STOPPED';
  l0: {
    status: FunnelStageStatus;
    recalled: number;
    persisted: number;
    sourcesDone: number;
    sourcesTotal: number;
    percent: number;
  };
  l1: {
    status: FunnelStageStatus;
    fetched: number;
    httpFirstCount: number;
    fallbackRenderCount: number;
    pdfSkipped: number;
    wwwRetries: number;
    judged: number;
    matched: number;
    weak: number;
    excluded: number;
    percent: number;
  };
  l2: {
    status: FunnelStageStatus;
    queued: number;
    enriched: number;
    contactsFound: number;
    verifiedEmails: number;
    signalsCount: number;
    percent: number;
  };
  readyCandidates: number;
  recentCandidates: StreamingRecentCandidate[];
  elapsedSec: number | null;
  firstBuyerSeconds: number | null;
  httpFirstRatioPct: number | null;
}

const TERMINAL_STATUSES = new Set(['DONE', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED']);
const STOPPED_STATUSES = new Set(['FAILED', 'CANCELLED']);

function nonNegInt(value: unknown, fallback = 0): number {
  const n = finiteNumber(value);
  return n !== null && n >= 0 ? Math.round(n) : fallback;
}

function clampPct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((numerator / denominator) * 100)));
}

function mapDtoStageStatus(
  raw: unknown,
  fallback: FunnelStageStatus,
  isStopped: boolean,
): FunnelStageStatus {
  if (isStopped) return 'stopped';
  const lower = String(raw ?? '').trim().toLowerCase();
  if (lower === 'done' || lower === 'completed' || lower === 'succeeded') return 'done';
  if (lower === 'running' || lower === 'in_progress' || lower === 'active') return 'running';
  if (lower === 'failed' || lower === 'cancelled' || lower === 'stopped') return 'stopped';
  if (lower === 'pending' || lower === 'idle' || lower === 'queued') return 'idle';
  return fallback;
}

function normalizeRecentCandidates(rawList: unknown): StreamingRecentCandidate[] {
  if (!Array.isArray(rawList)) return [];
  const out: StreamingRecentCandidate[] = [];
  for (const item of rawList) {
    const rec = asRecord(item);
    const companyId = typeof rec['companyId'] === 'string' ? rec['companyId'] : '';
    const name = typeof rec['name'] === 'string' ? rec['name'].trim() : '';
    if (!companyId && !name) continue;
    const channels = asRecord(rec['channelsFound']);
    const verdictRaw = rec['fitVerdict'];
    const fitVerdict =
      verdictRaw === 'match' || verdictRaw === 'weak' || verdictRaw === 'mismatch'
        ? verdictRaw
        : null;
    const methodRaw = rec['fetchMethod'];
    const fetchMethod =
      methodRaw === 'raw_http' || methodRaw === 'crawl4ai' || methodRaw === 'skipped'
        ? methodRaw
        : null;
    out.push({
      companyId: companyId || name,
      name: name || (typeof rec['domain'] === 'string' ? rec['domain'] : companyId),
      domain: typeof rec['domain'] === 'string' && rec['domain'].trim() ? rec['domain'].trim() : null,
      country: typeof rec['country'] === 'string' && rec['country'].trim() ? rec['country'].trim().toUpperCase() : null,
      stage: typeof rec['stage'] === 'string' ? rec['stage'] : 'l0_recalled',
      fitVerdict,
      fitScore: finiteNumber(rec['fitScore']),
      fetchMethod,
      channelsFound: {
        emails: nonNegInt(channels['emails']),
        phones: nonNegInt(channels['phones']),
        forms: nonNegInt(channels['forms']),
        socials: nonNegInt(channels['socials']),
      },
      reasonSummary:
        typeof rec['reasonSummary'] === 'string' && rec['reasonSummary'].trim()
          ? rec['reasonSummary'].trim()
          : null,
      updatedAt: typeof rec['updatedAt'] === 'string' ? rec['updatedAt'] : null,
    });
  }
  return out;
}

export function deriveStreamingFunnelProgress(input: {
  streamingProgress?: StreamingProgressDto | null;
  run?: {
    status?: string | null;
    mode?: string | null;
    stats?: Record<string, unknown> | null;
    phases?: Record<string, unknown> | null;
    createdAt?: string | null;
    completedAt?: string | null;
  } | null;
  jobs?: ReadonlyArray<{
    stage?: string | null;
    verdictQuick?: string | null;
    verdictDeep?: string | null;
  }>;
  nowMs?: number;
}): StreamingFunnelProgress {
  const sp = input.streamingProgress ?? null;
  const run = input.run ?? null;
  const jobs = input.jobs ?? [];

  const statusUpper = String(sp?.runStatus ?? run?.status ?? '').trim().toUpperCase();
  const isTerminal = TERMINAL_STATUSES.has(statusUpper);
  const isStopped = STOPPED_STATUSES.has(statusUpper);
  const isRunning = Boolean(sp || run) && !isTerminal;

  let elapsedSec: number | null = null;
  const startIso = run?.createdAt ?? sp?.stages?.l0Recall?.startedAt ?? null;
  if (startIso) {
    const startMs = Date.parse(startIso);
    const endIso = run?.completedAt ?? (isTerminal ? sp?.updatedAt : null);
    const endMs = endIso ? Date.parse(endIso) : (input.nowMs ?? Date.now());
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
      elapsedSec = Math.round((endMs - startMs) / 1000);
    }
  }

  // 优先消费 2A #51 `GET /discovery-runs/:runId/streaming-progress` 专属只读投影
  if (sp && sp.stages) {
    const l0Dto = sp.stages.l0Recall ?? {};
    const l1Dto = sp.stages.l1ExtractFit ?? {};
    const l2Dto = sp.stages.l2TopKEnrich ?? {};

    const recalled = nonNegInt(l0Dto.candidatesRecalled);
    const persisted = nonNegInt(l0Dto.canonicalUpserted, recalled);
    const sourcesDone = nonNegInt(l0Dto.queriesCompleted);
    const sourcesTotal = nonNegInt(l0Dto.queriesTotal);

    const processed = nonNegInt(l1Dto.processed);
    const l1Total = nonNegInt(l1Dto.total, Math.max(persisted, recalled, processed));
    const httpFirstCount = nonNegInt(l1Dto.rawHttpHits);
    const fallbackRenderCount = nonNegInt(l1Dto.crawl4aiFallbacks);
    const pdfSkipped = nonNegInt(l1Dto.pdfSkipped);
    const wwwRetries = nonNegInt(l1Dto.wwwRetries);
    const matched = nonNegInt(l1Dto.fitMatch);
    const weak = nonNegInt(l1Dto.fitWeak);
    const excluded = nonNegInt(l1Dto.fitMismatch);
    const judged = Math.max(processed, matched + weak + excluded);

    const queued = nonNegInt(l2Dto.selected ?? l2Dto.topKCap, matched);
    const enriched = nonNegInt(l2Dto.enriched);
    const contactsFound = nonNegInt(l2Dto.contactsFound);
    const signalsCount = nonNegInt(l2Dto.watchesRegistered);

    const recentCandidates = normalizeRecentCandidates(sp.recentCandidates);
    const verifiedEmails = recentCandidates.reduce(
      (sum, item) => sum + (item.channelsFound.emails > 0 ? item.channelsFound.emails : 0),
      0,
    );

    const l0Status = mapDtoStageStatus(
      l0Dto.status,
      isTerminal || (sourcesTotal > 0 && sourcesDone >= sourcesTotal) ? 'done' : isRunning ? 'running' : 'idle',
      isStopped,
    );
    const l1Status = mapDtoStageStatus(
      l1Dto.status,
      isTerminal ? 'done' : isRunning && (processed > 0 || persisted > 0) ? 'running' : 'idle',
      isStopped,
    );
    const l2Status = mapDtoStageStatus(
      l2Dto.status,
      isTerminal ? 'done' : isRunning && (queued > 0 || enriched > 0 || matched > 0) ? 'running' : 'idle',
      isStopped,
    );

    const stageKey = String(sp.currentStage ?? '').toLowerCase();
    const activeStage: StreamingFunnelProgress['activeStage'] = isStopped || stageKey === 'cancelled' || stageKey === 'failed'
      ? 'STOPPED'
      : isTerminal || stageKey === 'done'
        ? 'DONE'
        : stageKey === 'l2_topk_enrich' || stageKey === 'finalizing' || l2Status === 'running'
          ? 'L2'
          : stageKey === 'l1_extract_fit' || l1Status === 'running'
            ? 'L1'
            : 'L0';

    const renderTotal = httpFirstCount + fallbackRenderCount;
    const httpFirstRatioPct = renderTotal > 0 ? clampPct(httpFirstCount, renderTotal) : null;
    const l0Pct = l0Status === 'done' ? 100 : sourcesTotal > 0 ? clampPct(sourcesDone, sourcesTotal) : clampPct(persisted, recalled);
    const l1Pct = l1Status === 'done' ? 100 : clampPct(processed, l1Total);
    const l2Pct = l2Status === 'done' ? 100 : clampPct(enriched, Math.max(queued, matched, enriched));

    return {
      isStreamingMode: sp.pipelineMode === 'streaming',
      isRunning,
      isTerminal,
      activeStage,
      l0: { status: l0Status, recalled, persisted, sourcesDone, sourcesTotal, percent: l0Pct },
      l1: {
        status: l1Status,
        fetched: processed,
        httpFirstCount,
        fallbackRenderCount,
        pdfSkipped,
        wwwRetries,
        judged,
        matched,
        weak,
        excluded,
        percent: l1Pct,
      },
      l2: {
        status: l2Status,
        queued,
        enriched,
        contactsFound,
        verifiedEmails,
        signalsCount,
        percent: l2Pct,
      },
      readyCandidates: Math.max(
        matched,
        recentCandidates.filter((item) => item.fitVerdict === 'match').length,
      ),
      recentCandidates,
      elapsedSec,
      firstBuyerSeconds: null,
      httpFirstRatioPct,
    };
  }

  const stats = asRecord(run?.stats);
  const phases = asRecord(run?.phases);
  const streamObj = asRecord(
    stats['streaming'] ?? phases['streaming'] ?? stats['funnel'] ?? phases['funnel'],
  );
  const hasStreamPayload =
    String(run?.mode ?? '').toLowerCase() === 'streaming' ||
    Boolean(
      streamObj['l0'] ||
        streamObj['l1'] ||
        streamObj['l2'] ||
        streamObj['l0Recall'] ||
        streamObj['l1ExtractFit'] ||
        streamObj['l2TopKEnrich'],
    );

  if (hasStreamPayload) {
    const l0Raw = asRecord(streamObj['l0Recall'] ?? streamObj['l0'] ?? streamObj['L0']);
    const l1Raw = asRecord(streamObj['l1ExtractFit'] ?? streamObj['l1'] ?? streamObj['L1']);
    const l2Raw = asRecord(streamObj['l2TopKEnrich'] ?? streamObj['l2'] ?? streamObj['L2']);

    const recalled = nonNegInt(l0Raw['candidatesRecalled'] ?? l0Raw['recalled'] ?? l0Raw['candidates']);
    const persisted = nonNegInt(l0Raw['canonicalUpserted'] ?? l0Raw['persisted'], recalled);
    const sourcesDone = nonNegInt(l0Raw['queriesCompleted'] ?? l0Raw['sourcesDone']);
    const sourcesTotal = nonNegInt(l0Raw['queriesTotal'] ?? l0Raw['sourcesTotal']);

    const fetched = nonNegInt(l1Raw['processed'] ?? l1Raw['fetched'] ?? l1Raw['extracted']);
    const httpFirstCount = nonNegInt(l1Raw['rawHttpHits'] ?? l1Raw['httpFirstCount']);
    const fallbackRenderCount = nonNegInt(l1Raw['crawl4aiFallbacks'] ?? l1Raw['fallbackRenderCount']);
    const pdfSkipped = nonNegInt(l1Raw['pdfSkipped']);
    const wwwRetries = nonNegInt(l1Raw['wwwRetries']);
    const matched = nonNegInt(l1Raw['fitMatch'] ?? l1Raw['matched'] ?? l1Raw['match']);
    const weak = nonNegInt(l1Raw['fitWeak'] ?? l1Raw['weak']);
    const excluded = nonNegInt(l1Raw['fitMismatch'] ?? l1Raw['excluded'] ?? l1Raw['mismatch']);
    const judged = nonNegInt(l1Raw['judged'] ?? l1Raw['processed'], matched + weak + excluded);

    const queued = nonNegInt(l2Raw['selected'] ?? l2Raw['queued'] ?? l2Raw['topKCap'], matched);
    const enriched = nonNegInt(l2Raw['enriched'] ?? l2Raw['completed']);
    const contactsFound = nonNegInt(l2Raw['contactsFound'] ?? l2Raw['contacts']);
    const verifiedEmails = nonNegInt(l2Raw['verifiedEmails'] ?? l2Raw['validEmails']);
    const signalsCount = nonNegInt(l2Raw['watchesRegistered'] ?? l2Raw['signalsCount']);

    const l0Pct = isTerminal && !isStopped
      ? 100
      : sourcesTotal > 0
        ? clampPct(sourcesDone, sourcesTotal)
        : recalled > 0
          ? clampPct(persisted, recalled)
          : 0;
    const l1Denom = Math.max(nonNegInt(l1Raw['total']), persisted, recalled, fetched, judged);
    const l1Pct = isTerminal && !isStopped ? 100 : clampPct(judged, l1Denom);
    const l2Denom = Math.max(queued, matched, enriched);
    const l2Pct = isTerminal && !isStopped ? 100 : clampPct(enriched, l2Denom);

    const l0Status: FunnelStageStatus = isStopped
      ? 'stopped'
      : isTerminal || (sourcesTotal > 0 && sourcesDone >= sourcesTotal) || (l1Denom > 0 && judged > 0)
        ? 'done'
        : isRunning
          ? 'running'
          : 'idle';
    const l1Status: FunnelStageStatus = isStopped
      ? 'stopped'
      : isTerminal || (l1Denom > 0 && judged >= l1Denom && l0Status === 'done')
        ? 'done'
        : isRunning && (fetched > 0 || judged > 0 || persisted > 0)
          ? 'running'
          : 'idle';
    const l2Status: FunnelStageStatus = isStopped
      ? 'stopped'
      : isTerminal
        ? 'done'
        : isRunning && (queued > 0 || enriched > 0 || matched > 0)
          ? 'running'
          : 'idle';

    const activeStage: StreamingFunnelProgress['activeStage'] = isStopped
      ? 'STOPPED'
      : isTerminal
        ? 'DONE'
        : l2Status === 'running'
          ? 'L2'
          : l1Status === 'running'
            ? 'L1'
            : 'L0';

    const renderTotal = httpFirstCount + fallbackRenderCount;
    const httpFirstRatioPct = renderTotal > 0 ? clampPct(httpFirstCount, renderTotal) : null;
    const firstBuyerSeconds = finiteNumber(
      streamObj['firstBuyerSeconds'] ?? streamObj['first_buyer_seconds'] ?? stats['firstBuyerSeconds'],
    );

    return {
      isStreamingMode: true,
      isRunning,
      isTerminal,
      activeStage,
      l0: { status: l0Status, recalled, persisted, sourcesDone, sourcesTotal, percent: l0Pct },
      l1: {
        status: l1Status,
        fetched,
        httpFirstCount,
        fallbackRenderCount,
        pdfSkipped,
        wwwRetries,
        judged,
        matched,
        weak,
        excluded,
        percent: l1Pct,
      },
      l2: {
        status: l2Status,
        queued,
        enriched,
        contactsFound,
        verifiedEmails,
        signalsCount,
        percent: l2Pct,
      },
      readyCandidates: Math.max(matched, nonNegInt(stats['leads'])),
      recentCandidates: normalizeRecentCandidates(streamObj['recentCandidates']),
      elapsedSec,
      firstBuyerSeconds,
      httpFirstRatioPct,
    };
  }

  // Fallback to Run 2.0 quickScan/deep stats + company jobs
  const quick = asRecord(stats['quickScan']);
  const deep = asRecord(stats['deep']);
  const fit = asRecord(stats['fit']);

  const recalled = nonNegInt(stats['companies'] ?? quick['poolSize'], jobs.length);
  const matched = nonNegInt(
    fit['match'] ?? quick['match'],
    jobs.filter((j) => j.verdictDeep === 'match' || j.verdictQuick === 'match').length,
  );
  const weak = nonNegInt(
    fit['weak'] ?? quick['weak'],
    jobs.filter((j) => j.verdictDeep === 'weak' || (!j.verdictDeep && j.verdictQuick === 'weak')).length,
  );
  const excluded = nonNegInt(
    fit['mismatch'] ?? quick['mismatch'],
    jobs.filter(
      (j) =>
        j.stage === 'prefiltered_out' || j.verdictDeep === 'mismatch' || j.verdictQuick === 'mismatch',
    ).length,
  );
  const judged = matched + weak + excluded;
  const doneDeep = jobs.filter((j) => j.stage === 'done').length;
  const enriched = nonNegInt(deep['done'] ?? deep['completed'], doneDeep);
  const queued = nonNegInt(deep['total'] ?? deep['queued'], Math.max(matched, enriched));

  const l0Status: FunnelStageStatus = isStopped
    ? 'stopped'
    : isTerminal || recalled > 0
      ? 'done'
      : isRunning
        ? 'running'
        : 'idle';
  const l1Status: FunnelStageStatus = isStopped
    ? 'stopped'
    : isTerminal || (recalled > 0 && judged >= recalled)
      ? 'done'
      : isRunning && judged > 0
        ? 'running'
        : 'idle';
  const l2Status: FunnelStageStatus = isStopped
    ? 'stopped'
    : isTerminal
      ? 'done'
      : isRunning && (enriched > 0 || jobs.some((j) => j.stage === 'contacts' || j.stage === 'signals'))
        ? 'running'
        : 'idle';

  return {
    isStreamingMode: false,
    isRunning,
    isTerminal,
    activeStage: isStopped
      ? 'STOPPED'
      : isTerminal
        ? 'DONE'
        : l2Status === 'running'
          ? 'L2'
          : l1Status === 'running'
            ? 'L1'
            : 'L0',
    l0: {
      status: l0Status,
      recalled,
      persisted: recalled,
      sourcesDone: 0,
      sourcesTotal: 0,
      percent: isTerminal && !isStopped ? 100 : recalled > 0 ? 100 : 0,
    },
    l1: {
      status: l1Status,
      fetched: judged,
      httpFirstCount: 0,
      fallbackRenderCount: 0,
      pdfSkipped: 0,
      wwwRetries: 0,
      judged,
      matched,
      weak,
      excluded,
      percent: isTerminal && !isStopped ? 100 : clampPct(judged, recalled),
    },
    l2: {
      status: l2Status,
      queued,
      enriched,
      contactsFound: nonNegInt(stats['contacts']),
      verifiedEmails: nonNegInt(stats['verifiedEmails']),
      signalsCount: nonNegInt(stats['signals']),
      percent: isTerminal && !isStopped ? 100 : clampPct(enriched, queued),
    },
    readyCandidates: Math.max(matched, nonNegInt(stats['leads'] ?? quick['leads'])),
    recentCandidates: [],
    elapsedSec,
    firstBuyerSeconds: null,
    httpFirstRatioPct: null,
  };
}
