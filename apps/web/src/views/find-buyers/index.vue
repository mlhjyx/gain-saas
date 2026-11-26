<script lang="ts" setup>
/**
 * 买家画像页（原「找买家」：买家画像 + 寻源方案）。
 *
 * 2026-11-26 体验问题第二轮：
 * - 「目标客户画像」全站统一叫「买家画像」，页面与菜单随之改名，和「买家线索」放同一个分组；
 * - 画像里的五个板块换成用户读得懂的说法并各加一行说明（客户难题 / 采购信号 / 不找的对象 /
 *   我们的卖点 / 该找的人）；
 * - 「目标公司属性」里的英文字段补中文名；引擎写入的四个输入血缘字段不是目标公司属性，
 *   单独列成「画像依据」并用白话写；
 * - 画像详情从右侧抽屉改成页内工作区（和公司档案一致）：画像列表在上，选中的画像在下方展开，
 *   右下角始终有当前该做的「下一步」；「资格规则与回测」用开关隐藏；寻源方案、最近寻源只在画像
 *   生效后出现；编辑表单不再让人直接改 JSON；寻源方案先给结论，内部代码收进技术详情。
 *
 * 2026-11-25 按买家线索页的风格与理念重排：
 * - 列表 = 对齐分列的画像卡，「寻源方案 / 最近寻源」直接摆在卡片上（进入页面时并行预取）；
 * - 控件全部走 antd + Gs 封装；结果提示走统一反馈层。
 *
 * 业务逻辑（规则、回测、方案、发起寻源、本机运行记录）保持不变。
 */
import type {
  ComtradeMarketRecommendation,
  IcpFeedbackSummaryDto,
  ProcurementScenarioCode,
  StatusTone,
  StreamingProgressDto,
} from '@gain-saas/shared';

import type {
  AcquisitionTaskView,
  Backtest,
  CompanyProfile,
  DiscoveryRun,
  Icp,
  IcpFeedbackReport,
  IcpRule,
  IcpRuleInput,
  QueryPlan,
  TaskRunView,
} from '#/api/gainos';
import type { FbTone, IcpCardRow, SummaryState } from './icp-card-types';

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import {
  BUYER_ROLE_CODES,
  deriveStreamingFunnelProgress,
  extractThreeLayerFromIcp,
  formatDateTime,
  glossaryStatus,
  glossaryTerm,
  normalizeComtradeRecommendations,
  normalizeIcpFeedbackSummary,
  PROCUREMENT_SCENARIO_CODES,
} from '@gain-saas/shared';
import { RotateCw } from '@vben/icons';
import { preferences } from '@vben/preferences';

import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  CollapsePanel,
  Descriptions,
  DescriptionsItem,
  Input,
  InputNumber,
  Modal,
  Skeleton,
  Tag,
} from 'ant-design-vue';

import { ICP_ADVANCED_HIDDEN } from '#/feature-flags';
import ErrorNotice from '#/components/error-notice.vue';
import StreamingProgressBoard from '#/components/gainos/StreamingProgressBoard.vue';
import ThreeLayerProfileCard from '#/components/gainos/ThreeLayerProfileCard.vue';
import GsCard from '#/components/gainos/ui/gs-card.vue';
import GsEmpty from '#/components/gainos/ui/gs-empty.vue';
import GsPage from '#/components/gainos/ui/gs-page.vue';
import GsSelect from '#/components/gainos/ui/gs-select.vue';
import GsTag from '#/components/gainos/ui/gs-tag.vue';
import { feedback as uiFeedback } from '#/feedback';
import { $t } from '#/locales';
import { notifyChainChanged } from '#/composables/use-main-chain-progress';
import { regionName } from '#/utils/region-name';

import { failureText, gainosApi } from '#/api/gainos';

import IcpCard from './icp-card.vue';

defineOptions({ name: 'FindBuyers' });

const route = useRoute();
const router = useRouter();

const RULE_KINDS = ['MUST_HAVE', 'NICE_TO_HAVE', 'EXCLUSION'] as const;
const RULE_OPERATORS = ['eq', 'neq', 'in', 'not_in', 'contains', 'not_contains', 'gte', 'lte', 'matches'] as const;

const icps = ref<Icp[]>([]);
const companies = ref<CompanyProfile[]>([]);
const activeCompanyFilter = ref('');
const loading = ref(true);
const loadError = ref<{ title: string; next?: string } | null>(null);

const createOpen = ref(false);
const selectedCompanyId = ref('');
const createName = ref('');
const createProductLines = ref('');
const createTargetMarkets = ref('');
const createBuyerRoles = ref<string[]>([]);
const createScenario = ref<'' | ProcurementScenarioCode>('');
const createComtradeRecs = ref<ComtradeMarketRecommendation[]>([]);
const keepExistingActive = ref(true);
const creating = ref(false);
const createError = ref<ReturnType<typeof failureText> | null>(null);
const approvedClaimCount = ref<number | null>(null);
const productSelection = ref<'available' | 'cleared' | 'empty' | 'unknown'>('unknown');
const claimsChecking = ref(false);
const claimsCheckError = ref<string | null>(null);
const quickApprovingFacts = ref(false);
let claimsCheckToken = 0;

// Phase 2 方案 B 流式三段进度看板态（详情抽屉内实时跟踪，运行中 4 秒轮询）
const detailStreamRunId = ref<string | null>(null);
const detailStreamDto = ref<StreamingProgressDto | null>(null);
const detailStreamRun = ref<DiscoveryRun | null>(null);
const detailStreamCancelling = ref(false);
let detailStreamTimer: ReturnType<typeof setInterval> | null = null;
let detailStreamSeq = 0;

const selected = ref<Icp | null>(null);
const detailLoading = ref(false);
const detailError = ref<{ title: string; next?: string } | null>(null);
const plans = ref<QueryPlan[]>([]);
const plansLoading = ref(false);
const plansError = ref<{ title: string; next?: string } | null>(null);
const planBusy = ref<string | null>(null);
/** 本次打开详情后改过画像：已有方案是按改动前的内容生成的，要提示重新生成。 */
const profileEdited = ref(false);
/** 运行终态；不在这个集合里的（如 RUNNING）算还在跑。 */
const TERMINAL_RUN_STATUSES = new Set(['DONE', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED']);
// Run 2.0（M0②）：挖掘任务（每个 ICP 复用一个活动任务）与最近运行。
const taskRuns = ref<TaskRunView[]>([]);
let taskCache: AcquisitionTaskView | null = null;
// M2：反馈建议卡（只建议，采纳=手动改 ICP）+ Phase 3B 已沉淀排除规则与反例学习摘要。
const feedback = ref<IcpFeedbackReport | null>(null);
const feedbackSummary = ref<IcpFeedbackSummaryDto | null>(null);

function learnedReasonLabel(code: string): string {
  const key = `gainos.findBuyers.learnedReason.${code}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? $t('gainos.findBuyers.learnedReason.unspecified') : translated;
}

async function loadFeedback(icpId: string): Promise<void> {
  const [fbRes, summaryRes] = await Promise.allSettled([
    gainosApi.icpFeedback(icpId),
    gainosApi.icpFeedbackSummary(icpId),
  ]);
  feedback.value = fbRes.status === 'fulfilled' ? fbRes.value : null;
  const rawSummary = summaryRes.status === 'fulfilled' ? summaryRes.value : null;
  feedbackSummary.value =
    rawSummary && typeof rawSummary === 'object' && ('excludedDomains' in rawSummary || 'counterExamples' in rawSummary || 'stats' in rawSummary)
      ? normalizeIcpFeedbackSummary(rawSummary)
      : null;
}

/** 引擎没有“按方案列 run”的端点；把已发起的 runId 留在本机，关闭页面后还能回到任务。 */
interface RunRef {
  runId: string;
  startedAt: string;
}
const RUN_REFS_KEY = 'gainos.discoveryRuns.v1';
const runRefs = ref<Record<string, RunRef>>({});

function loadRunRefs(): void {
  try {
    const raw = localStorage.getItem(RUN_REFS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, RunRef>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const valid: Record<string, RunRef> = {};
    for (const [planId, ref] of Object.entries(parsed)) {
      if (ref && typeof ref.runId === 'string' && ref.runId) {
        valid[planId] = { runId: ref.runId, startedAt: typeof ref.startedAt === 'string' ? ref.startedAt : '' };
      }
    }
    runRefs.value = valid;
  } catch {
    // 本地缓存损坏不影响寻源主流程。
  }
}

function persistRunRefs(): void {
  try {
    const entries = Object.entries(runRefs.value).slice(-100);
    localStorage.setItem(RUN_REFS_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // 本地缓存不可写时仍然允许本次跳转，只是下次需要重新找到任务链接。
  }
}

function rememberRun(planId: string, runId: string, startedAt = new Date().toISOString()): void {
  runRefs.value = { ...runRefs.value, [planId]: { runId, startedAt } };
  persistRunRefs();
}

async function loadRunLinks(icpId: string): Promise<void> {
  try {
    const data = await gainosApi.discoveryRunLinks(icpId);
    const rows = Array.isArray(data) ? data : ((data as unknown as { data?: unknown[] })?.data ?? []);
    const next = { ...runRefs.value };
    for (const row of rows as Array<{ runId?: string; planId?: string; startedAt?: string }>) {
      if (row.runId && row.planId) {
        // 保新（P1）：本机已记录的引用比服务器行更新时不要回退。
        const existing = next[row.planId];
        const rowStarted = row.startedAt ?? '';
        if (existing && (existing.startedAt ?? '') > rowStarted) continue;
        next[row.planId] = { runId: row.runId, startedAt: rowStarted };
      }
    }
    runRefs.value = next;
    persistRunRefs();
  } catch {
    // 服务端引用暂不可用时，保留本机已有的 run 记录。
  }
}

const editOpen = ref(false);
const editing = ref(false);
const editError = ref<{ title: string; next?: string } | null>(null);
const editForm = ref({
  name: '',
  targetMarkets: '',
  painPoints: '',
  triggerSignals: '',
  exclusions: '',
  valueProps: '',
  /** 已登记的目标公司属性：键 → 文本（列表类一项一行）。 */
  attributes: {} as Record<string, string>,
  /** 没登记的属性、嵌套结构的属性，以及引擎写入的输入血缘字段：保持原始 JSON。 */
  otherAttributesText: '{}',
});

/**
 * 编辑表单里直接摆出来的目标公司属性。`list` 为 true 的是列表（一项一行），其余是单个值。
 * 引擎的 companyAttributes 是自由对象，这里只覆盖已登记的键；其余进「其他属性」。
 */
const ATTRIBUTE_FIELDS: ReadonlyArray<{ key: string; list: boolean }> = [
  { key: 'country', list: false },
  { key: 'industry', list: false },
  { key: 'sub_industry', list: false },
  { key: 'end_markets', list: true },
  { key: 'product', list: true },
  { key: 'trade_side', list: false },
  { key: 'tech', list: true },
  { key: 'keywords', list: true },
  { key: 'business_model', list: false },
  { key: 'role', list: false },
  { key: 'company_size', list: false },
  { key: 'employee_count', list: false },
  { key: 'region', list: false },
  { key: 'revenue', list: false },
  { key: 'certifications', list: true },
];
const ATTRIBUTE_KEYS = new Set(ATTRIBUTE_FIELDS.map((field) => field.key));

const ruleOpen = ref(false);
const editingRuleId = ref<string | null>(null);
const ruleBusy = ref(false);
const ruleError = ref<{ title: string; next?: string } | null>(null);
const ruleForm = ref({
  kind: 'MUST_HAVE',
  field: 'industry',
  operator: 'eq',
  valueText: '',
  weight: 1,
  rationale: '',
});

const backtestText = ref('[\n  {\n    "name": "Muster Metallbau GmbH",\n    "domain": "muster-metallbau.de",\n    "attributes": { "industry": "metal fabrication", "country": "DE", "employee_count": 120 },\n    "expected": "match"\n  },\n  {\n    "name": "Beispiel Handel AG",\n    "attributes": { "industry": "retail", "country": "DE", "employee_count": 8 },\n    "expected": "exclude"\n  }\n]');
const backtestBusy = ref(false);
const backtestError = ref<{ title: string; next?: string } | null>(null);
const backtest = ref<Backtest | null>(null);

const activeIcp = computed(() => icps.value.find((icp) => icp.status === 'ACTIVE') ?? null);

// 注册时填写的公司是主档案（workspace.onboardingCompanyId）：设定画像时排在第一位并标注。
// Phase 1：解除单公司仅能建一组画像的前端锁，允许按不同市场/产品线为同一公司创建多组画像。
const primaryCompanyId = ref<string | null>(null);
const isAdmin = ref(false);
const icpCountByCompany = computed(() => {
  const counts = new Map<string, number>();
  for (const icp of icps.value) {
    counts.set(icp.companyId, (counts.get(icp.companyId) ?? 0) + 1);
  }
  return counts;
});
const orderedCompanies = computed(() =>
  companies.value
    .filter((company): company is CompanyProfile & { id: string } => Boolean(company.id))
    .sort((a, b) => {
      const pa = a.id === primaryCompanyId.value ? 0 : 1;
      const pb = b.id === primaryCompanyId.value ? 0 : 1;
      return pa - pb;
    }),
);

/** 词表 tone → 药丸 tone（GsTag 没有 processing，用品牌蓝 info 表示）。 */
function toneOf(tone: StatusTone): FbTone {
  return tone === 'processing' ? 'info' : tone;
}
// 买家画像与挖掘任务的状态文案/色板一律取自 @gain-saas/shared 的 glossary（P6 §4）；
// 未登记的状态显示占位符，绝不把裸枚举直接渲染进界面。
function icpStatus(status?: string): { label: string; tone: FbTone } {
  const meta = glossaryStatus('icp', status, preferences.app.locale);
  return meta ? { label: meta.label, tone: toneOf(meta.tone) } : { label: '—', tone: 'neutral' };
}
/** 寻源方案状态药丸：待确认=琥珀、可执行=品牌蓝、已执行=绿。 */
function planTone(status?: string): FbTone {
  if (status === 'READY') return 'info';
  if (status === 'EXECUTED') return 'success';
  if (status === 'DRAFT') return 'warning';
  return 'neutral';
}
function planStatusLabel(status?: string): string {
  const key = `gainos.findBuyers.planStatus.${status ?? 'DRAFT'}`;
  const value = $t(key);
  return value === key ? (status ?? '') : value;
}
const QUERY_SOURCE_KEYS: Record<string, string> = {
  public_intelligence: 'gainos.findBuyers.querySource.publicIntelligence',
  industry_data: 'gainos.findBuyers.querySource.industryData',
  public_web: 'gainos.findBuyers.querySource.publicWeb',
  ted: 'gainos.findBuyers.querySource.ted',
  openfda: 'gainos.findBuyers.querySource.openFda',
};
function querySourceLabel(query: Record<string, unknown>): string {
  const key = QUERY_SOURCE_KEYS[String(query.source_class ?? '')];
  if (!key) return $t('gainos.findBuyers.querySource.other');
  const label = $t(key);
  return label === key ? $t('gainos.findBuyers.querySource.other') : label;
}
function queryKeywords(query: Record<string, unknown>): string[] {
  return Array.isArray(query.keywords) ? query.keywords.map((item) => String(item)).filter(Boolean) : [];
}
function queryFilterItems(query: Record<string, unknown>): Array<{ label: string; value: string }> {
  const filters = (query.filters ?? {}) as Record<string, unknown>;
  const items: Array<{ label: string; value: string }> = [];
  const push = (key: string, labelKey: string) => {
    const value = attrText(filters[key]);
    if (value) items.push({ label: $t(`gainos.findBuyers.queryFilter.${labelKey}`), value });
  };
  push('country', 'country');
  push('region', 'region');
  push('area_name', 'area');
  push('industry', 'industry');
  push('sub_industry', 'subIndustry');
  const trade = String(filters.trade_side ?? '');
  const tradeKey = trade === 'manufacturer'
    ? 'gainos.findBuyers.tradeSide.manufacturer'
    : trade === 'distributor'
      ? 'gainos.findBuyers.tradeSide.distributor'
      : trade === 'buyer'
        ? 'gainos.findBuyers.tradeSide.buyer'
        : '';
  if (tradeKey) items.push({ label: $t('gainos.findBuyers.queryFilter.tradeSide'), value: $t(tradeKey) });
  return items;
}
function planCostLabel(cents?: number | null): string {
  const n = Number(cents);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `$${(n / 100).toFixed(2)}`;
}
function kindLabel(kind: string): string {
  const key = `gainos.findBuyers.ruleKind.${kind}`;
  const value = $t(key);
  return value === key ? kind : value;
}
function operatorLabel(operator: string): string {
  const key = `gainos.findBuyers.ruleOperator.${operator}`;
  const value = $t(key);
  return value === key ? operator : value;
}
function companyName(companyId?: string): string {
  return companies.value.find((company) => company.id === companyId)?.name || $t('gainos.findBuyers.unknownCompany');
}
function ruleValueText(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const field of ['label', 'summary', 'title', 'name', 'reason', 'excerpt', 'value', 'source_class']) {
      const text = record[field];
      if (typeof text === 'string' && text.trim()) return text;
    }
  }
  return '';
}
/** 公司属性字段的业务名；未登记的字段原样显示字段名。 */
function attributeLabel(key: string): string {
  const i18nKey = `gainos.findBuyers.attribute.${key}`;
  const translated = $t(i18nKey);
  return translated === i18nKey ? key : translated;
}

function attrText(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => attrText(item)).filter(Boolean).join('、');
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}：${attrText(item)}`)
      .join('；');
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function attributesOf(icp: Icp): Array<{ key: string; value: string }> {
  return Object.entries(icp.companyAttributes ?? {})
    .filter(([key]) => !LINEAGE_KEYS.has(key))
    .map(([key, value]) => ({ key: attributeLabel(key), value: attrText(value) }))
    .filter((item) => item.value.length > 0);
}

/**
 * 引擎写进 companyAttributes 的「输入血缘」字段：记录这份画像依据什么生成（用了哪些产品、
 * 市场按什么定），不是目标公司的属性。单独列成「画像依据」，值是内部代码，要换成白话。
 */
const LINEAGE_KEYS = new Set(['inputBasis', 'inputProducts', 'marketBasis', 'modelSuggestedMarkets']);

function lineageLabel(group: 'lineageBasis' | 'lineageMarket', value: unknown): string {
  const code = attrText(value);
  const key = `gainos.findBuyers.${group}.${code}`;
  const translated = $t(key);
  return translated === key ? code : translated;
}

/** 「画像依据」：依据的产品、市场按什么定、AI 另外建议了哪些市场。只显示有内容的项。 */
function lineageOf(icp: Icp): Array<{ key: string; value: string }> {
  const attributes = icp.companyAttributes ?? {};
  return [
    { key: $t('gainos.findBuyers.lineageProducts'), value: attrText(attributes.inputProducts) },
    {
      key: $t('gainos.findBuyers.lineageProductBasis'),
      value: lineageLabel('lineageBasis', attributes.inputBasis),
    },
    {
      key: $t('gainos.findBuyers.lineageMarketBasis'),
      value: lineageLabel('lineageMarket', attributes.marketBasis),
    },
    {
      key: $t('gainos.findBuyers.lineageSuggestedMarkets'),
      value: attrText(attributes.modelSuggestedMarkets),
    },
  ].filter((row) => row.value.length > 0);
}
function canActivate(icp: Icp): boolean {
  return ['DRAFT', 'HYPOTHESIS', 'VALIDATING'].includes(icp.status);
}
/** 静默刷新 ICP 列表：规则增删会改变卡片的规则数/版本号，不闪 loading。 */
async function refreshIcpList(): Promise<void> {
  try {
    const icpData = await gainosApi.icps();
    icps.value = Array.isArray(icpData) ? icpData : [];
  } catch {
    /* 列表刷新失败不打断弹窗流程，下次进页会重新加载 */
  }
}

function parseRuleValue(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return '';
  try { return JSON.parse(trimmed); } catch { return trimmed; }
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    const [icpData, companyData] = await Promise.all([gainosApi.icps(), gainosApi.companies()]);
    icps.value = Array.isArray(icpData) ? icpData : [];
    companies.value = Array.isArray(companyData) ? companyData : ((companyData as { data?: CompanyProfile[] })?.data ?? []);
    void prefetchSummaries();
    // 工作区常驻：已选中的画像还在就保持选中；首次进入优先尊重路由 ?icp=&run=，否则默认展示生效中的那份（没有就取第一份）。
    const kept = selected.value ? icps.value.find((item) => item.id === selected.value?.id) : undefined;
    if (kept) {
      selected.value = kept;
    } else {
      selected.value = null;
      const routeIcpRaw = Array.isArray(route.query.icp) ? route.query.icp[0] : route.query.icp;
      const routeRunRaw = Array.isArray(route.query.run) ? route.query.run[0] : route.query.run;
      const routeTarget =
        typeof routeIcpRaw === 'string' && routeIcpRaw
          ? icps.value.find((item) => item.id === routeIcpRaw)
          : undefined;
      const initial = routeTarget ?? icps.value.find((item) => item.status === 'ACTIVE') ?? icps.value[0];
      if (initial) {
        await openDetail(initial, {
          focusRunId: routeTarget && typeof routeRunRaw === 'string' ? routeRunRaw : undefined,
          scroll: false,
        });
      }
    }
  } catch (error) {
    loadError.value = failureText(error);
    icps.value = [];
  } finally {
    loading.value = false;
  }
}

function taskRunStatusLabel(status: string): string {
  return glossaryStatus('run', status, preferences.app.locale)?.label ?? '—';
}
function taskRunStatusTone(status: string): FbTone {
  const meta = glossaryStatus('run', status, preferences.app.locale);
  return toneOf(meta?.tone ?? 'neutral');
}

function formatRunTime(value: string): string {
  return formatDateTime(value);
}

async function loadTaskRuns(icpId: string): Promise<void> {
  try {
    const tasks = await gainosApi.acquisitionTasks(icpId);
    taskCache = tasks[0] ?? null;
    // 列表和「是否还有寻源在跑」要看这个画像下所有任务的运行，按发起时间倒序。
    taskRuns.value = tasks
      .flatMap((task) => task.runs ?? [])
      .sort((a, b) => Date.parse(b.startedAt ?? '') - Date.parse(a.startedAt ?? ''));
  } catch {
    taskCache = null;
    taskRuns.value = [];
  }
}

/** 这个任务的上一轮寻源是否还在跑。引擎没有并发锁，同时起两条会各算一次费用，界面先挡住。 */
const taskRunning = computed(() =>
  taskRuns.value.some(
    (run) => !TERMINAL_RUN_STATUSES.has(String(run.status ?? '').trim().toUpperCase()),
  ));

/** 任务对象前移（M0②）：每个 ICP 复用一个活动任务；没有则懒创建「默认挖掘任务」。 */
async function ensureTask(icpId: string): Promise<AcquisitionTaskView> {
  if (taskCache?.icpId === icpId) return taskCache;
  const tasks = await gainosApi.acquisitionTasks(icpId);
  const reusable = tasks.find((task) => task.status === 'active') ?? tasks[0];
  if (reusable) {
    taskCache = reusable;
    return reusable;
  }
  const icpName = selected.value?.id === icpId ? selected.value.name : '';
  const runTerm = glossaryTerm('run', preferences.app.locale);
  const created = await gainosApi.createAcquisitionTask({
    icpId,
    name: icpName ? `${icpName} · ${runTerm}` : runTerm,
  });
  taskCache = created;
  return created;
}

async function loadPlans(icpId: string): Promise<void> {
  plansLoading.value = true;
  plansError.value = null;
  try {
    const data = await gainosApi.queryPlans(icpId);
    plans.value = Array.isArray(data) ? data : [];
  } catch (error) {
    plansError.value = failureText(error);
    plans.value = [];
  } finally {
    plansLoading.value = false;
  }
}

const selectedThreeLayer = computed(() =>
  selected.value
    ? extractThreeLayerFromIcp({
        ...selected.value,
        companyName: companyName(selected.value.companyId),
      })
    : null,
);

const detailStreamingProgress = computed(() =>
  detailStreamDto.value || detailStreamRun.value
    ? deriveStreamingFunnelProgress({
        streamingProgress: detailStreamDto.value,
        run: detailStreamRun.value,
      })
    : null,
);

function stopDetailStreamPoll(): void {
  if (detailStreamTimer) {
    clearInterval(detailStreamTimer);
    detailStreamTimer = null;
  }
}

async function loadDetailStreamingProgress(runId: string): Promise<void> {
  const seq = ++detailStreamSeq;
  detailStreamRunId.value = runId;
  const [spRes, runRes] = await Promise.allSettled([
    gainosApi.streamingProgress(runId),
    gainosApi.discoveryRun(runId),
  ]);
  if (seq !== detailStreamSeq) return;
  const sp = spRes.status === 'fulfilled' ? spRes.value : null;
  detailStreamDto.value = sp && typeof sp === 'object' && 'stages' in sp ? sp : null;
  detailStreamRun.value = runRes.status === 'fulfilled' ? runRes.value : null;

  const progress = detailStreamingProgress.value;
  if (progress?.isRunning) {
    if (!detailStreamTimer) {
      detailStreamTimer = setInterval(() => {
        if (detailStreamRunId.value) void loadDetailStreamingProgress(detailStreamRunId.value);
      }, 4000);
    }
  } else {
    stopDetailStreamPoll();
  }
}

async function cancelDetailStreamRun(): Promise<void> {
  if (!detailStreamRunId.value || detailStreamCancelling.value) return;
  detailStreamCancelling.value = true;
  try {
    await gainosApi.cancelDiscoveryRun(detailStreamRunId.value);
    await loadDetailStreamingProgress(detailStreamRunId.value);
    if (selected.value) await loadTaskRuns(selected.value.id);
  } catch (err) {
    detailError.value = failureText(err);
  } finally {
    detailStreamCancelling.value = false;
  }
}

function goSelectedIcpLeads(): void {
  if (!selected.value) return;
  void router.push({ path: '/leads', query: { icp: selected.value.id } });
}

/** 在工作区里展示一份画像。`scroll` 为 true（从画像卡进来）时滚到工作区；默认选中和切换时不滚。 */
async function openDetail(
  icp: Icp,
  options: { focusRunId?: string; scroll?: boolean } = {},
): Promise<void> {
  selected.value = icp;
  detailError.value = null;
  detailLoading.value = true;
  backtest.value = null;
  backtestError.value = null;
  ruleOpen.value = false;
  taskCache = null;
  taskRuns.value = [];
  feedback.value = null;
  feedbackSummary.value = null;
  profileEdited.value = false;
  stopDetailStreamPoll();
  detailStreamRunId.value = null;
  detailStreamDto.value = null;
  detailStreamRun.value = null;
  try {
    selected.value = await gainosApi.icp(icp.id);
    await Promise.all([loadPlans(icp.id), loadRunLinks(icp.id), loadTaskRuns(icp.id), loadFeedback(icp.id)]);
    const latestRunId =
      options.focusRunId ||
      taskRuns.value.find((r) => Boolean(r.runId))?.runId ||
      Object.values(runRefs.value)[0]?.runId ||
      null;
    if (latestRunId) {
      void loadDetailStreamingProgress(latestRunId);
    }
  } catch (error) {
    detailError.value = failureText(error);
  } finally {
    detailLoading.value = false;
  }
  if (options.scroll) {
    await nextTick();
    workspaceRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

async function checkApprovedClaims(companyId: string): Promise<void> {
  const token = ++claimsCheckToken;
  approvedClaimCount.value = null;
  productSelection.value = 'unknown';
  claimsCheckError.value = null;
  if (!companyId) {
    claimsChecking.value = false;
    return;
  }
  claimsChecking.value = true;
  const [claims, offerings] = await Promise.allSettled([
    gainosApi.claims(companyId, 'APPROVED'),
    gainosApi.companyOfferings(companyId),
  ]);
  if (token !== claimsCheckToken) return;
  claimsChecking.value = false;
  if (claims.status === 'fulfilled') {
    const data = claims.value;
    const rows = Array.isArray(data) ? data : ((data as unknown as { data?: unknown[] })?.data ?? []);
    approvedClaimCount.value = rows.length;
  } else {
    claimsCheckError.value = failureText(claims.reason).title;
  }
  if (offerings.status === 'fulfilled' && Array.isArray(offerings.value)) {
    const selections = offerings.value
      .map((product) => product.attributes?.selectedByUser)
      .filter((marked) => typeof marked === 'boolean');
    if (selections.length > 0) {
      productSelection.value = selections.includes(true) ? 'available' : 'cleared';
    } else {
      productSelection.value = offerings.value.length > 0 ? 'available' : 'empty';
    }
  }
}
async function loadCreateComtrade(companyId: string): Promise<void> {
  if (!companyId) {
    createComtradeRecs.value = [];
    return;
  }
  try {
    const raw = await gainosApi.marketRecommendations(companyId, { limit: 6 });
    createComtradeRecs.value = normalizeComtradeRecommendations(raw);
  } catch {
    createComtradeRecs.value = [];
  }
}

function toggleCreateComtradeMarket(code: string): void {
  const upper = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return;
  const current = commas(createTargetMarkets.value)
    .map((item) => item.toUpperCase())
    .filter((item) => /^[A-Z]{2}$/.test(item));
  const next = current.includes(upper)
    ? current.filter((item) => item !== upper)
    : [...current, upper];
  createTargetMarkets.value = next.join(', ');
}

function toggleCreateBuyerRole(role: string): void {
  createBuyerRoles.value = createBuyerRoles.value.includes(role)
    ? createBuyerRoles.value.filter((item) => item !== role)
    : [...createBuyerRoles.value, role];
}

watch(selectedCompanyId, (companyId) => {
  void checkApprovedClaims(companyId);
  if (createOpen.value) void loadCreateComtrade(companyId);
});

const missingProduct = computed(() =>
  productSelection.value === 'cleared' ||
  (productSelection.value === 'empty' && commas(createProductLines.value).length === 0),
);
const canCreateIcp = computed(() =>
  Boolean(selectedCompanyId.value) &&
  !creating.value &&
  !claimsChecking.value &&
  !missingProduct.value &&
  approvedClaimCount.value !== null &&
  approvedClaimCount.value > 0);

function openCreate(presetCompanyId?: string): void {
  const previousId = selectedCompanyId.value;
  const defaultId =
    (typeof presetCompanyId === 'string' && presetCompanyId) ||
    activeCompanyFilter.value ||
    orderedCompanies.value[0]?.id ||
    '';
  selectedCompanyId.value = defaultId;
  const selectedCompany = orderedCompanies.value.find((c) => c.id === selectedCompanyId.value);
  createName.value = '';
  createProductLines.value = '';
  createBuyerRoles.value = [];
  createScenario.value = '';
  createTargetMarkets.value = (selectedCompany?.targetMarkets ?? []).join(', ');
  createError.value = null;
  createOpen.value = true;
  if (previousId === defaultId) {
    void checkApprovedClaims(defaultId);
    void loadCreateComtrade(defaultId);
  }
}

let openedCreatePath: string | undefined;
watch([() => route.fullPath, loading], ([path, pending]) => {
  if (route.path !== '/find-buyers' || route.query.action !== 'create') {
    openedCreatePath = undefined;
    return;
  }
  if (openedCreatePath === path || pending || loadError.value) return;
  const companyId = route.query.companyId;
  if (typeof companyId === 'string' && !companies.value.some((company) => company.id === companyId)) return;
  openedCreatePath = path;
  openCreate(typeof companyId === 'string' ? companyId : undefined);
});

async function quickApproveOnboardingFacts(): Promise<void> {
  if (!isAdmin.value || !selectedCompanyId.value || quickApprovingFacts.value) return;
  quickApprovingFacts.value = true;
  createError.value = null;
  try {
    await gainosApi.synthesizeClaimDrafts(selectedCompanyId.value).catch(() => undefined);
    const pending = await gainosApi.claims(selectedCompanyId.value, 'NEEDS_REVIEW');
    const rows = Array.isArray(pending) ? pending : [];
    let approved = 0;
    let lastApproveError: unknown = null;
    for (const claim of rows.slice(0, 12)) {
      try {
        await gainosApi.approveClaim(claim.id);
        approved += 1;
      } catch (err) {
        lastApproveError = err;
      }
    }
    await checkApprovedClaims(selectedCompanyId.value);
    if (approved > 0) {
      uiFeedback.message.success($t('gainos.findBuyers.quickApproveDone', { count: approved }));
    } else if (lastApproveError) {
      createError.value = failureText(lastApproveError);
    } else if ((approvedClaimCount.value ?? 0) === 0) {
      uiFeedback.message.warning($t('gainos.findBuyers.quickApproveEmpty'));
    }
  } catch (error) {
    createError.value = failureText(error);
  } finally {
    quickApprovingFacts.value = false;
  }
}

async function createIcp(): Promise<void> {
  if (!canCreateIcp.value || !selectedCompanyId.value) return;
  creating.value = true;
  createError.value = null;
  try {
    const markets = commas(createTargetMarkets.value)
      .map((item) => item.toUpperCase())
      .filter((code) => /^[A-Z]{2}$/.test(code));
    const productLines = commas(createProductLines.value);
    const icp = await gainosApi.createIcp(selectedCompanyId.value, {
      attemptId: mintAttemptId(),
      ...(markets.length > 0 ? { confirmedTargetMarkets: markets } : {}),
      ...(createName.value.trim() ? { name: createName.value.trim() } : {}),
      ...(productLines.length > 0 ? { productLines } : {}),
      ...(createBuyerRoles.value.length > 0 ? { buyerRoles: [...createBuyerRoles.value] } : {}),
      ...(createScenario.value ? { procurementScenario: createScenario.value } : {}),
    });
    createOpen.value = false;
    uiFeedback.message.success($t('gainos.findBuyers.created'));
    notifyChainChanged();
    await load();
    await openDetail(icp);
  } catch (error) {
    createError.value = failureText(error);
  } finally {
    creating.value = false;
  }
}

async function activate(): Promise<void> {
  if (!selected.value) return;
  planBusy.value = 'activate';
  detailError.value = null;
  try {
    const hasSiblingActive = icps.value.some(
      (item) =>
        item.companyId === selected.value?.companyId &&
        item.id !== selected.value?.id &&
        item.status === 'ACTIVE',
    );
    selected.value = await gainosApi.activateIcp(
      selected.value.id,
      hasSiblingActive && keepExistingActive.value ? { keepExistingActive: true } : undefined,
    );
    uiFeedback.message.success($t('gainos.findBuyers.activated'));
    notifyChainChanged();
    await load();
    await loadPlans(selected.value.id);
  } catch (error) {
    detailError.value = failureText(error);
  } finally {
    planBusy.value = null;
  }
}

/** 属性值 → 表单文本。列表类一项一行，其余用「、」连起来。嵌套对象没法用文本框改，返回 null，留在「其他属性」里。 */
function attributeText(value: unknown, list: boolean): null | string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    const items = value.map((item) => attrText(item)).filter(Boolean);
    return list ? items.join('\n') : items.join('、');
  }
  if (typeof value === 'object') return null;
  return String(value);
}

/**
 * 表单文本 → 属性值。原来是数字的仍是数字；列表类按行拆成数组；单个值可以写多个（逗号或顿号分隔），
 * 只有一个时保持字符串，和引擎原来的写法一致。
 */
function attributeValue(text: string, original: unknown, list: boolean): undefined | unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const items = list ? lines(trimmed) : trimmed.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean);
  if (typeof original === 'number' || (original === undefined && items.length === 1 && /^\d+(?:\.\d+)?$/.test(trimmed))) {
    return Number(trimmed);
  }
  // 只有一项、且原来就是单个值（或新填）时保持字符串，不把引擎写的 "US" 变成 ["US"]；列表类的原来就是数组就仍是数组。
  if (items.length === 1 && (typeof original === 'string' || original === undefined)) return items[0];
  return items;
}

function openEdit(): void {
  if (!selected.value) return;
  const icp = selected.value;
  const source = icp.companyAttributes ?? {};
  const texts: Record<string, string> = {};
  const other: Record<string, unknown> = {};
  for (const field of ATTRIBUTE_FIELDS) {
    const text = attributeText(source[field.key], field.list);
    if (text === null) other[field.key] = source[field.key];
    else texts[field.key] = text;
  }
  for (const [key, value] of Object.entries(source)) {
    if (!ATTRIBUTE_KEYS.has(key)) other[key] = value;
  }
  editForm.value = {
    name: icp.name,
    targetMarkets: (icp.targetMarkets ?? []).join(', '),
    painPoints: (icp.painPoints ?? []).join('\n'),
    triggerSignals: (icp.triggerSignals ?? []).join('\n'),
    exclusions: (icp.exclusions ?? []).join('\n'),
    valueProps: (icp.valueProps ?? []).join('\n'),
    attributes: texts,
    otherAttributesText: JSON.stringify(other, null, 2),
  };
  editError.value = null;
  editOpen.value = true;
}
function lines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}
function commas(text: string): string[] {
  return text.split(',').map((item) => item.trim()).filter(Boolean);
}
async function saveEdit(): Promise<void> {
  if (!selected.value) return;
  let other: Record<string, unknown>;
  try {
    const parsed = JSON.parse(editForm.value.otherAttributesText || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    other = parsed as Record<string, unknown>;
  } catch {
    editError.value = {
      title: $t('gainos.findBuyers.attributesInvalid'),
      next: $t('gainos.findBuyers.attributesOtherHint'),
    };
    return;
  }
  // 「其他属性」原样保留；文本框里的已登记属性写回去（留空的删掉，嵌套结构的不被覆盖）。
  const original = selected.value.companyAttributes ?? {};
  const attributes: Record<string, unknown> = { ...other };
  for (const field of ATTRIBUTE_FIELDS) {
    if (field.key in other) continue;
    const value = attributeValue(editForm.value.attributes[field.key] ?? '', original[field.key], field.list);
    if (value !== undefined) attributes[field.key] = value;
  }
  editing.value = true;
  editError.value = null;
  try {
    selected.value = await gainosApi.updateIcp(selected.value.id, {
      name: editForm.value.name.trim(),
      targetMarkets: commas(editForm.value.targetMarkets),
      painPoints: lines(editForm.value.painPoints),
      triggerSignals: lines(editForm.value.triggerSignals),
      exclusions: lines(editForm.value.exclusions),
      valueProps: lines(editForm.value.valueProps),
      companyAttributes: attributes,
      expectedVersion: selected.value.version,
    });
    editOpen.value = false;
    uiFeedback.message.success($t('gainos.findBuyers.saved'));
    await load();
    // 方案是生成那一刻的快照，不会跟着画像变：有旧方案时提示重新生成。
    profileEdited.value = plans.value.length > 0;
  } catch (error) {
    editError.value = failureText(error);
  } finally {
    editing.value = false;
  }
}

function openRule(rule?: IcpRule): void {
  editingRuleId.value = rule?.id ?? null;
  ruleError.value = null;
  ruleForm.value = rule
    ? {
        kind: rule.kind,
        field: rule.field,
        operator: rule.operator,
        valueText: typeof rule.value === 'string' ? rule.value : JSON.stringify(rule.value),
        weight: rule.weight,
        rationale: rule.rationale ?? '',
      }
    : { kind: 'MUST_HAVE', field: 'industry', operator: 'eq', valueText: '', weight: 1, rationale: '' };
  ruleOpen.value = true;
}
async function saveRule(): Promise<void> {
  if (!selected.value) return;
  ruleBusy.value = true;
  ruleError.value = null;
  const input: IcpRuleInput = {
    kind: ruleForm.value.kind,
    field: ruleForm.value.field.trim(),
    operator: ruleForm.value.operator,
    value: parseRuleValue(ruleForm.value.valueText),
    weight: Number(ruleForm.value.weight) || 0,
    rationale: ruleForm.value.rationale.trim() || undefined,
  };
  try {
    if (editingRuleId.value) {
      await gainosApi.updateIcpRule(editingRuleId.value, input);
    } else {
      await gainosApi.createIcpRule(selected.value.id, input);
    }
    ruleOpen.value = false;
    selected.value = await gainosApi.icp(selected.value.id);
    void refreshIcpList();
    uiFeedback.message.success($t('gainos.findBuyers.ruleSaved'));
  } catch (error) {
    ruleError.value = failureText(error);
  } finally {
    ruleBusy.value = false;
  }
}
function removeRule(rule: IcpRule): void {
  const current = selected.value;
  if (!current) return;
  uiFeedback.confirm({
    cancelText: $t('gainos.common.cancel'),
    content: $t('gainos.findBuyers.deleteRuleConfirm'),
    okText: $t('gainos.findBuyers.deleteRule'),
    okType: 'danger',
    onOk: async () => {
      ruleBusy.value = true;
      try {
        await gainosApi.deleteIcpRule(rule.id);
        selected.value = await gainosApi.icp(current.id);
        void refreshIcpList();
        uiFeedback.message.success($t('gainos.findBuyers.ruleDeleted'));
      } catch (error) {
        ruleError.value = failureText(error);
      } finally {
        ruleBusy.value = false;
      }
    },
  });
}

async function runBacktest(): Promise<void> {
  if (!selected.value) return;
  backtestBusy.value = true;
  backtestError.value = null;
  backtest.value = null;
  try {
    const samples = JSON.parse(backtestText.value);
    if (!Array.isArray(samples) || samples.length === 0) throw new Error('invalid samples');
    backtest.value = await gainosApi.runBacktest(selected.value.id, samples);
    selected.value = await gainosApi.icp(selected.value.id);
  } catch (error) {
    backtestError.value = error instanceof SyntaxError
      ? { title: $t('gainos.findBuyers.backtestInvalid'), next: $t('gainos.findBuyers.backtestHint') }
      : failureText(error);
  } finally {
    backtestBusy.value = false;
  }
}

function mintAttemptId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `attempt-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

async function createPlan(): Promise<void> {
  if (!selected.value) return;
  planBusy.value = 'create';
  plansError.value = null;
  try {
    // P1：每次「生成方案」点击带新的幂等键（同一计划不再被防重放砖化；同一次点击重试复用）。
    await gainosApi.createQueryPlan(selected.value.id, mintAttemptId());
    await loadPlans(selected.value.id);
    profileEdited.value = false;
    void prefetchSummary(selected.value.id);
    uiFeedback.message.success($t('gainos.findBuyers.planCreated'));
    notifyChainChanged();
  } catch (error) {
    plansError.value = failureText(error);
  } finally {
    planBusy.value = null;
  }
}
async function confirmPlan(plan: QueryPlan): Promise<void> {
  planBusy.value = plan.id;
  plansError.value = null;
  try {
    await gainosApi.confirmQueryPlan(plan.id);
    await loadPlans(plan.icpId);
    void prefetchSummary(plan.icpId);
    uiFeedback.message.success($t('gainos.findBuyers.planConfirmed'));
    notifyChainChanged();
  } catch (error) {
    plansError.value = failureText(error);
  } finally {
    planBusy.value = null;
  }
}
async function executePlan(plan: QueryPlan): Promise<void> {
  planBusy.value = plan.id;
  plansError.value = null;
  try {
    // 任务对象前移（M0②）：先确保该 ICP 的任务，再由任务发起执行（引擎侧带 taskRef）。
    const task = await ensureTask(plan.icpId);
    // P1：每次「执行」点击带新的幂等键；双击由 BFF 的 attempt_key 唯一约束兜底只算一次。
    const result = await gainosApi.startAcquisitionTaskRun(task.id, plan.id, mintAttemptId());
    if (!result.runId) {
      // 重放命中一条引擎 run 尚未回填的执行（极少数竞态）：刷新任务视图，稍后从任务里进入。
      await Promise.all([loadPlans(plan.icpId), loadTaskRuns(plan.icpId)]);
      void prefetchSummary(plan.icpId);
      uiFeedback.message.success($t('gainos.findBuyers.runStarting'));
      return;
    }
    rememberRun(plan.id, result.runId);
    notifyChainChanged();
    try {
      await gainosApi.recordDiscoveryRun({ runId: result.runId, planId: plan.id, icpId: plan.icpId });
    } catch {
      // 本地引用已保存；服务端登记失败不阻断进入任务页。
    }
    await Promise.all([loadPlans(plan.icpId), loadTaskRuns(plan.icpId)]);
    await openRun(result.runId);
  } catch (error) {
    plansError.value = failureText(error);
  } finally {
    planBusy.value = null;
  }
}
async function openRun(runId: string): Promise<void> {
  await router.push({ name: 'DiscoveryRun', params: { runId } });
}

function openPlanRun(plan: QueryPlan): void {
  const ref = runRefs.value[plan.id];
  if (ref) void openRun(ref.runId);
}

// ── 列表卡片上的「寻源方案 / 最近寻源」摘要 ──────────────────────────────
interface IcpSummary {
  /** undefined = 这次没取到；[] = 确实没有。 */
  plans?: QueryPlan[];
  runs?: TaskRunView[];
}
const summaries = ref<Record<string, IcpSummary>>({});
const summaryPending = ref<Set<string>>(new Set());

/**
 * 并行预取一个画像的方案与最近运行：取不到只影响对应那一列（显示「—」），
 * 不打断列表，也不把「没取到」显示成「还没有」。
 */
async function prefetchSummary(icpId: string): Promise<void> {
  summaryPending.value = new Set(summaryPending.value).add(icpId);
  const [plansResult, tasksResult] = await Promise.allSettled([
    gainosApi.queryPlans(icpId),
    gainosApi.acquisitionTasks(icpId),
  ]);
  const summary: IcpSummary = {};
  if (plansResult.status === 'fulfilled') {
    summary.plans = Array.isArray(plansResult.value) ? plansResult.value : [];
  }
  if (tasksResult.status === 'fulfilled') {
    const tasks = Array.isArray(tasksResult.value) ? tasksResult.value : [];
    // 一个画像下可以有多个任务，运行记录合在一起按发起时间倒序，取最近的一次。
    summary.runs = tasks
      .flatMap((task) => task.runs ?? [])
      .sort((a, b) => Date.parse(b.startedAt ?? '') - Date.parse(a.startedAt ?? ''));
  }
  summaries.value = { ...summaries.value, [icpId]: summary };
  const next = new Set(summaryPending.value);
  next.delete(icpId);
  summaryPending.value = next;
}
function prefetchSummaries(): void {
  for (const icp of icps.value) void prefetchSummary(icp.id);
}

function summaryState(loaded: boolean, pending: boolean, has: boolean): SummaryState {
  if (!loaded) return pending ? 'loading' : 'failed';
  return has ? 'ok' : 'none';
}

const rows = computed<IcpCardRow[]>(() =>
  icps.value.map((icp) => {
    const summary = summaries.value[icp.id];
    const pending = summaryPending.value.has(icp.id);
    const latestPlan = [...(summary?.plans ?? [])].sort(
      (a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? ''),
    )[0];
    const latestRun = summary?.runs?.[0];
    const status = icpStatus(icp.status);
    return {
      company: companyName(icp.companyId),
      icp,
      id: icp.id,
      markets: icp.targetMarkets ?? [],
      name: icp.name,
      personas: icp.personas?.length ?? 0,
      plan: latestPlan
        ? {
            label: planStatusLabel(latestPlan.status),
            queries: latestPlan.queries?.length ?? 0,
            tone: planTone(latestPlan.status),
          }
        : null,
      planState: summaryState(summary?.plans !== undefined, pending, Boolean(latestPlan)),
      rules: icp.rules?.length ?? 0,
      run: latestRun
        ? {
            label: taskRunStatusLabel(latestRun.status),
            startedAt: formatRunTime(latestRun.startedAt),
            tone: taskRunStatusTone(latestRun.status),
          }
        : null,
      runState: summaryState(summary?.runs !== undefined, pending, Boolean(latestRun)),
      statusLabel: status.label,
      statusTone: status.tone,
      version: icp.version,
    };
  }),
);

// ── 画像工作区（页内常驻，取代原来的右侧抽屉）────────────────────────────
const workspaceRef = ref<HTMLElement | null>(null);

const statusOfSelected = computed(() => icpStatus(selected.value?.status));
const versionOfSelected = computed<null | number>(() => {
  const raw = selected.value?.version;
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
});
const selectedCompanyVersionMeta = computed(() => {
  const name = companyName(selected.value?.companyId);
  return versionOfSelected.value !== null
    ? `${name} · ${$t('gainos.findBuyers.version', { version: versionOfSelected.value })}`
    : name;
});
const pageSubtitle = computed(() =>
  activeIcp.value
    ? $t('gainosUi2.findBuyers.activeSummary', { name: activeIcp.value.name })
    : $t('gainos.findBuyers.subtitle'),
);

/** 多份画像时在工作区头部切换；只有一份时不显示。 */
const profileOptions = computed(() =>
  rows.value.map((row) => ({ label: `${row.name}（${row.statusLabel}）`, value: row.id })),
);
function switchProfile(id: unknown): void {
  const icp = icps.value.find((item) => item.id === id);
  if (icp && icp.id !== selected.value?.id) void openDetail(icp);
}

const overviewSections = computed(() =>
  (['painPoints', 'triggerSignals', 'exclusions', 'valueProps'] as const).map((key) => ({
    hint: $t(`gainos.findBuyers.${key}Hint`),
    items: selected.value?.[key] ?? [],
    key,
    title: $t(`gainos.findBuyers.${key}`),
  })),
);

interface ProfilePerson {
  concerns: string[];
  goals: string[];
  pains: string[];
  title: string;
}
/** 「该找的人」：personas 和 buyingCommittee 是引擎对同一批角色的两种写法（一个带目标和难题，一个带关注点），按职务合并。 */
const peopleOfSelected = computed<ProfilePerson[]>(() => {
  const byTitle = new Map<string, ProfilePerson>();
  const slot = (raw: string | undefined): ProfilePerson => {
    const title = (raw ?? '').trim();
    const key = title.toLowerCase();
    let row = byTitle.get(key);
    if (!row) {
      row = { concerns: [], goals: [], pains: [], title };
      byTitle.set(key, row);
    }
    return row;
  };
  for (const persona of selected.value?.personas ?? []) {
    const row = slot(persona.title);
    row.goals.push(...(persona.goals ?? []));
    row.pains.push(...(persona.painPoints ?? []));
  }
  for (const role of selected.value?.buyingCommittee ?? []) {
    slot(role.title || role.role).concerns.push(...(role.concerns ?? []));
  }
  return [...byTitle.values()].filter((row) => row.title.length > 0);
});

const companyOptions = computed(() =>
  orderedCompanies.value.map((company) => {
    const name = company.name || company.website || '';
    const existingCount = icpCountByCompany.value.get(company.id) ?? 0;
    const badges = [
      company.id === primaryCompanyId.value ? $t('gainos.companies.primaryBadge') : '',
      existingCount > 0 ? $t('gainos.findBuyers.companyIcpCount', { count: existingCount }) : '',
    ].filter(Boolean);
    return {
      label: badges.length > 0 ? `${name}（${badges.join(' · ')}）` : name,
      value: company.id,
    };
  }),
);
const kindOptions = computed(() =>
  RULE_KINDS.map((kind) => ({ label: kindLabel(kind), value: kind })),
);
const operatorOptions = computed(() =>
  RULE_OPERATORS.map((operator) => ({ label: operatorLabel(operator), value: operator })),
);
const ruleModalTitle = computed(() =>
  editingRuleId.value ? $t('gainos.findBuyers.editRule') : $t('gainos.findBuyers.addRule'),
);

// ── 下一步：这份画像现在该做什么，页面上只给一个按钮 ────────────────────
/** 最新的一份方案。引擎允许同一画像多份方案，对用户来说「下一步」只看最新的。 */
const latestPlan = computed<null | QueryPlan>(() =>
  [...plans.value].sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? ''))[0] ?? null,
);
const selectedActive = computed(() => selected.value?.status === 'ACTIVE');
const hasSiblingActive = computed(() =>
  Boolean(
    selected.value &&
      icps.value.some(
        (item) =>
          item.companyId === selected.value?.companyId &&
          item.id !== selected.value?.id &&
          item.status === 'ACTIVE',
      ),
  ),
);

interface NextAction {
  desc: string;
  loading?: boolean;
  run: () => void;
  title: string;
}

function openLatestRun(): void {
  const running = taskRuns.value.find((run) => run.runId && !TERMINAL_RUN_STATUSES.has(String(run.status ?? '').toUpperCase()));
  const planId = latestPlan.value?.id;
  const runId = running?.runId ?? (planId ? runRefs.value[planId]?.runId : undefined) ?? taskRuns.value.find((run) => run.runId)?.runId;
  if (runId) void openRun(runId);
}

/**
 * 按状态给出唯一明确的下一步：没激活 → 激活；生效后没方案 → 生成方案；方案待确认 → 确认；
 * 可执行 → 开始寻源；寻源在跑 → 看进度；这一轮已产出线索 → 去判断；没跑成 → 再跑一次。
 * 数据还在加载或出错时不显示，避免给出错误的引导。
 */
const nextAction = computed<null | NextAction>(() => {
  const icp = selected.value;
  if (!icp || detailLoading.value || detailError.value) return null;
  if (canActivate(icp)) {
    return {
      desc: $t('gainos.findBuyers.nextActivateDesc'),
      loading: planBusy.value === 'activate',
      run: activate,
      title: $t('gainos.findBuyers.activate'),
    };
  }
  // 寻源方案、最近寻源只在画像生效后才出现，下一步也只从生效后开始给。
  if (!selectedActive.value || plansLoading.value || plansError.value) return null;
  const plan = latestPlan.value;
  if (!plan) {
    return {
      desc: $t('gainos.findBuyers.nextCreatePlanDesc'),
      loading: planBusy.value === 'create',
      run: createPlan,
      title: $t('gainos.findBuyers.createPlan'),
    };
  }
  if (plan.status === 'DRAFT') {
    return {
      desc: $t('gainos.findBuyers.nextConfirmPlanDesc'),
      loading: planBusy.value === plan.id,
      run: () => confirmPlan(plan),
      title: $t('gainos.findBuyers.confirmPlan'),
    };
  }
  if (taskRunning.value) {
    return { desc: $t('gainos.findBuyers.nextRunningDesc'), run: openLatestRun, title: $t('gainos.findBuyers.viewRun') };
  }
  if (plan.status === 'READY') {
    return {
      desc: $t('gainos.findBuyers.nextExecutePlanDesc'),
      loading: planBusy.value === plan.id,
      run: () => executePlan(plan),
      title: $t('gainos.findBuyers.executePlan'),
    };
  }
  const run = taskRuns.value[0];
  if (run && (run.status === 'DONE' || run.status === 'PARTIAL')) {
    return {
      desc: $t('gainos.findBuyers.nextJudgeDesc'),
      run: () => void router.push('/leads'),
      title: $t('gainos.findBuyers.goLeads'),
    };
  }
  return {
    desc: $t('gainos.findBuyers.nextRerunDesc'),
    loading: planBusy.value === plan.id,
    run: () => executePlan(plan),
    title: $t('gainos.findBuyers.rerunPlan'),
  };
});

// ── 寻源方案：先给结论，再按渠道看搜索词 ────────────────────────────────
interface PlanGroup {
  key: string;
  label: string;
  queries: Array<Record<string, unknown>>;
}

/** 同一份方案里的搜索按来源渠道分组，用户先看到「去哪几个渠道找」。 */
function planGroups(plan: QueryPlan): PlanGroup[] {
  const groups = new Map<string, PlanGroup>();
  for (const query of plan.queries) {
    const key = String(query.source_class ?? 'other') || 'other';
    const existing = groups.get(key);
    if (existing) existing.queries.push(query);
    else groups.set(key, { key, label: querySourceLabel(query), queries: [query] });
  }
  return [...groups.values()];
}

/** 一句话结论：去几个渠道、几组搜索、预计多少家、费用多少。 */
function planLead(plan: QueryPlan): string {
  let text = $t('gainos.findBuyers.planLead', {
    channels: planGroups(plan).length,
    queries: plan.queries?.length ?? 0,
  });
  if (plan.estimatedVolume) {
    text += $t('gainos.findBuyers.planLeadEstimated', { count: plan.estimatedVolume });
  }
  const cost = planCostLabel(plan.estimatedCostCents);
  if (cost) text += $t('gainos.findBuyers.planLeadCost', { cost });
  return text;
}

/** 内部代码：snake_case 标识（source_filter、seed_gap）或全大写常量（SOURCE_QUERY_BUDGET、CPV）。 */
const INTERNAL_CODE = /(^|[^A-Za-z0-9])[a-z]+(?:_[a-z0-9]+)+(?![A-Za-z0-9])|\b[A-Z][A-Z_]{2,}\b/;
const WARNING_PREFIX = /^(icp_fit_warning|icp_seed_gap)\s*[:：]\s*/i;

/**
 * 引擎写在搜索条件旁的说明里常混着内部代码（`[source_filter] 已移除…: SOURCE_QUERY_BUDGET…`）。
 * 按「；」「。」和换行切成小句：`icp_fit_warning:` 去掉前缀是给用户看的提醒，换成「注意」留在正文；
 * 其余带代码的小句收进技术详情，不带代码的照常展示。
 */
function splitRationale(text: string): { notes: string[]; technical: string[] } {
  const notes: string[] = [];
  const technical: string[] = [];
  const segments = text
    .replace(/\[source_filter\]/gi, '')
    .split(/[;；。\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  for (const raw of segments) {
    const warning = WARNING_PREFIX.exec(raw);
    if (warning && warning[1]!.toLowerCase() === 'icp_fit_warning') {
      const body = raw.slice(warning[0].length).trim();
      if (body && !/[a-z]+(?:_[a-z0-9]+)+/.test(body)) {
        notes.push(`${$t('gainos.findBuyers.noteWarning')}：${body}`);
        continue;
      }
    }
    if (INTERNAL_CODE.test(raw)) technical.push(raw);
    else notes.push(raw);
  }
  return { notes, technical };
}
function queryNotes(query: Record<string, unknown>): string[] {
  return splitRationale(textOf(query.rationale)).notes;
}
function queryTechnical(query: Record<string, unknown>): string[] {
  return splitRationale(textOf(query.rationale)).technical;
}

/** 哪个方案的哪个渠道展开了搜索词；默认都收起，先看结论。 */
const expandedGroups = ref<Set<string>>(new Set());
function groupKey(planId: string, group: PlanGroup): string {
  return `${planId}:${group.key}`;
}
function isGroupExpanded(planId: string, group: PlanGroup): boolean {
  return expandedGroups.value.has(groupKey(planId, group));
}
function toggleGroup(planId: string, group: PlanGroup): void {
  const key = groupKey(planId, group);
  const next = new Set(expandedGroups.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedGroups.value = next;
}

async function loadPrimaryCompany(): Promise<void> {
  try {
    const context = await gainosApi.workspaceContext();
    primaryCompanyId.value = context.onboarding?.companyId ?? null;
    isAdmin.value = context.workspace?.role === 'admin';
  } catch {
    primaryCompanyId.value = null;
    isAdmin.value = false;
  }
}
const filteredRows = computed(() =>
  activeCompanyFilter.value
    ? rows.value.filter((row) => row.icp.companyId === activeCompanyFilter.value)
    : rows.value,
);

const companiesWithIcps = computed(() =>
  orderedCompanies.value.filter((company) => (icpCountByCompany.value.get(company.id) ?? 0) > 0),
);

onMounted(async () => {
  loadRunRefs();
  void loadPrimaryCompany();
  await load();
});
onUnmounted(stopDetailStreamPoll);
</script>

<template>
  <div class="mx-auto grid w-full max-w-[var(--gs-page-max)] grid-cols-1 gap-4 px-[var(--gs-page-pad)] pb-12 @container">
    <GsPage art="find-buyers" :subtitle="pageSubtitle" :title="$t('gainos.findBuyers.title')">
      <template #actions>
        <div class="flex flex-wrap items-center gap-2" data-gs="icp-toolbar">
          <Button :loading="loading" data-gs="refresh" size="small" @click="load">
            <template v-if="!loading" #icon>
              <RotateCw :size="14" />
            </template>
            {{ loading ? $t('gainos.common.refreshing') : $t('gainos.common.refresh') }}
          </Button>
          <!-- 降级为描边次按钮：全页唯一蓝色 Primary CTA 留给当前状态的「下一步」 -->
          <Button v-if="icps.length > 0" data-gs="new-icp" size="small" @click="openCreate()">
            {{ $t('gainos.findBuyers.newIcp') }}
          </Button>
        </div>
      </template>
    </GsPage>

    <!-- 1 公司多画像切换栏（同公司多市场/多产品线并列管理） -->
    <div
      v-if="!loading && !loadError && companiesWithIcps.length > 0 && rows.length > 1"
      class="fb-company-switcher"
      data-gs="company-icp-switcher"
    >
      <div class="fb-company-switcher__pills">
        <button
          :class="{ active: activeCompanyFilter === '' }"
          class="fb-pill"
          data-gs="company-filter-all"
          type="button"
          @click="activeCompanyFilter = ''"
        >
          {{ $t('gainos.findBuyers.companyFilterAll', { count: rows.length }) }}
        </button>
        <button
          v-for="co in companiesWithIcps"
          :key="co.id"
          :class="{ active: activeCompanyFilter === co.id }"
          :data-gs="`company-filter-${co.id}`"
          class="fb-pill"
          type="button"
          @click="activeCompanyFilter = co.id"
        >
          {{
            $t('gainos.findBuyers.companyFilterItem', {
              name: co.name || co.website || $t('gainos.findBuyers.unknownCompany'),
              count: icpCountByCompany.get(co.id) ?? 0,
            })
          }}
        </button>
      </div>
      <Button
        v-if="activeCompanyFilter"
        data-gs="new-icp-for-company"
        size="small"
        @click="openCreate(activeCompanyFilter)"
      >
        {{ $t('gainos.findBuyers.newIcpForCompany') }}
      </Button>
    </div>

    <div v-if="loadError" class="grid gap-3" data-gs="load-error">
      <ErrorNotice :next="loadError.next" :title="loadError.title" />
      <Button class="justify-self-start" @click="load">{{ $t('gainos.common.retry') }}</Button>
    </div>

    <GsCard v-else-if="loading" data-gs="icp-loading" padding="20px 24px">
      <Skeleton active :paragraph="{ rows: 3 }" />
      <span class="fb-sr-only">{{ $t('gainos.common.loading') }}</span>
    </GsCard>

    <GsCard v-else-if="rows.length === 0" data-gs="icp-empty" padding="40px 24px">
      <GsEmpty :description="$t(ICP_ADVANCED_HIDDEN ? 'gainos.findBuyers.emptyDescSimple' : 'gainos.findBuyers.emptyDesc')" :title="$t('gainos.findBuyers.emptyTitle')">
        <template #actions>
          <Button type="primary" @click="openCreate()">{{ $t('gainos.findBuyers.emptyCta') }}</Button>
          <Button @click="router.push('/companies')">{{ $t('gainos.companies.title') }}</Button>
          <Button @click="router.push('/tasks')">{{ $t('gainos.tasks.title') }}</Button>
        </template>
      </GsEmpty>
    </GsCard>

    <template v-else>
      <!-- 多份画像：左侧 240px 窄栏 + 右侧主工作区；≤1 份画像自动隐藏左栏直达工作区 -->
      <div
        :class="rows.length > 1 ? 'fb-layout fb-layout--split' : 'fb-layout'"
        data-gs="icp-split-layout"
      >
        <aside v-if="rows.length > 1" class="fb-rail" data-gs="icp-rail">
          <div class="fb-rail__head">
            <span class="fb-rail__title">{{ $t('gainosUi2.findBuyers.railTitle') }}</span>
            <span class="fb-rail__count">
              {{ $t('gainosUi2.findBuyers.railCount', { count: filteredRows.length }) }}
            </span>
          </div>
          <div class="fb-rail__list">
            <IcpCard
              v-for="row in filteredRows"
              :key="row.id"
              rail
              :row="row"
              :selected="row.id === selected?.id"
              @open="openDetail(row.icp, { scroll: false })"
            />
          </div>
        </aside>

        <div class="fb-main">
          <!-- 单份画像时保留轻量单行概览条（无多蓝按钮打架，保留查看与调整与对接角色/方案态） -->
          <IcpCard
            v-if="rows.length === 1 && filteredRows[0]"
            :row="filteredRows[0]"
            :selected="filteredRows[0].id === selected?.id"
            @open="openDetail(filteredRows[0].icp, { scroll: true })"
          />

          <!-- 画像工作区：查看、激活、确认方案、发起寻源都在页内完成 -->
          <div ref="workspaceRef" class="scroll-mt-24">
            <GsCard class="fb-workspace" data-gs="icp-workspace" padding="0">
              <header class="fb-workspace__head">
                <div class="min-w-0">
                  <h2 class="fb-workspace__name">{{ selected?.name }}</h2>
                  <div class="fb-workspace__meta">
                    <GsTag :tone="statusOfSelected.tone">{{ statusOfSelected.label }}</GsTag>
                    <span class="fb-muted" data-gs="icp-workspace-meta">
                      {{ selectedCompanyVersionMeta }}
                    </span>
                  </div>
                </div>
                <div class="fb-workspace__tools">
                  <label v-if="profileOptions.length > 1" class="fb-workspace__field">
                    <span>{{ $t('gainos.findBuyers.workspaceProfile') }}</span>
                    <GsSelect
                      :ariaLabel="$t('gainos.findBuyers.workspaceProfile')"
                      class="fb-workspace__select"
                      :options="profileOptions"
                      :value="selected?.id"
                      size="small"
                      @change="switchProfile"
                    />
                  </label>
                  <Button data-gs="icp-edit" size="small" @click="openEdit">
                    {{ $t('gainos.findBuyers.edit') }}
                  </Button>
                </div>
              </header>

          <div class="fb-workspace__body">
            <div v-if="detailLoading" class="fb-section">
              <Skeleton active :paragraph="{ rows: 8 }" />
            </div>
            <div v-else-if="detailError" class="fb-section">
              <ErrorNotice :next="detailError.next" :title="detailError.title" />
            </div>
            <template v-else-if="selected">
              <!-- 还没激活：这一步只需要看内容和激活。寻源方案、最近寻源要等画像生效后才出现。 -->
              <div v-if="canActivate(selected)" class="fb-section">
                <Alert
                  :message="$t('gainos.findBuyers.activateHint')"
                  role="status"
                  show-icon
                  type="info"
                />
                <Checkbox
                  v-if="hasSiblingActive"
                  v-model:checked="keepExistingActive"
                  data-gs="keep-existing-active"
                >
                  <span class="text-xs">{{ $t('gainos.findBuyers.keepExistingActive') }}</span>
                </Checkbox>
              </div>

              <!-- 方案 B 流式三段实时进度看板（有运行记录时直接可见，不等黑盒结束） -->
              <section v-if="detailStreamingProgress" class="fb-section">
                <StreamingProgressBoard
                  :cancelling="detailStreamCancelling"
                  :progress="detailStreamingProgress"
                  :show-cancel-action="detailStreamingProgress.isRunning"
                  :title="$t('gainos.findBuyers.streamingProgressTitle')"
                  @cancel="cancelDetailStreamRun"
                  @refresh="detailStreamRunId && loadDetailStreamingProgress(detailStreamRunId)"
                  @view-leads="goSelectedIcpLeads"
                />
              </section>

              <template v-if="selectedActive">
                <!-- 寻源方案：先给结论（去哪几个渠道、几组搜索、预计多少家），搜索词按渠道展开看 -->
                <section class="fb-section" data-gs="icp-plans">
                  <header class="fb-section__head">
                    <div class="min-w-0">
                      <h3 class="fb-section__title">{{ $t('gainos.findBuyers.plansTitle') }}</h3>
                      <p class="fb-muted">{{ $t('gainos.findBuyers.plansDesc') }}</p>
                    </div>
                    <!-- 画像生效中随时可以再生成：降级为描边次按钮，唯一蓝色 Primary CTA 留给下一步 -->
                    <Button
                      v-if="!plansLoading"
                      :disabled="planBusy === 'create'"
                      :loading="planBusy === 'create'"
                      size="small"
                      @click="createPlan"
                    >
                      {{
                        plans.length > 0
                          ? $t('gainos.findBuyers.regeneratePlan')
                          : $t('gainos.findBuyers.createPlan')
                      }}
                    </Button>
                  </header>
                  <Alert
                    v-if="profileEdited"
                    :message="$t('gainos.findBuyers.planStaleAfterEdit', { version: versionOfSelected ?? 1 })"
                    role="status"
                    show-icon
                    type="warning"
                  />

                  <ErrorNotice v-if="plansError" :next="plansError.next" :title="plansError.title" />
                  <Skeleton v-else-if="plansLoading" active :paragraph="{ rows: 2 }" />
                  <ul v-else-if="plans.length > 0" class="fb-stack">
                    <li v-for="plan in plans" :key="plan.id" class="fb-plan">
                      <div class="fb-plan__head">
                        <GsTag :tone="planTone(plan.status)">{{ planStatusLabel(plan.status) }}</GsTag>
                        <p class="fb-plan__lead">{{ planLead(plan) }}</p>
                      </div>

                      <ul class="fb-channels">
                        <li v-for="group in planGroups(plan)" :key="group.key" class="fb-channel">
                          <div class="fb-channel__head">
                            <strong class="fb-channel__name">{{ group.label }}</strong>
                            <span class="fb-muted">
                              {{ $t('gainos.findBuyers.planSearchCount', { count: group.queries.length }) }}
                            </span>
                            <Button
                              :aria-expanded="isGroupExpanded(plan.id, group)"
                              class="fb-channel__toggle"
                              size="small"
                              type="link"
                              @click="toggleGroup(plan.id, group)"
                            >
                              {{
                                isGroupExpanded(plan.id, group)
                                  ? $t('gainos.findBuyers.planQueriesHide')
                                  : $t('gainos.findBuyers.planQueriesShow')
                              }}
                            </Button>
                          </div>
                          <ol v-if="isGroupExpanded(plan.id, group)" class="fb-queries">
                            <li v-for="(query, i) in group.queries" :key="i" class="fb-query">
                              <p v-if="query.priority" class="fb-muted fb-query__meta">
                                {{ $t('gainos.findBuyers.planPriority', { priority: query.priority }) }}
                              </p>
                              <div v-if="queryFilterItems(query).length > 0" class="fb-chips">
                                <span
                                  v-for="item in queryFilterItems(query)"
                                  :key="item.label"
                                  class="fb-query__filter"
                                >
                                  <em>{{ item.label }}</em>{{ item.value }}
                                </span>
                              </div>
                              <div v-if="queryKeywords(query).length > 0" class="fb-chips">
                                <Tag
                                  v-for="keyword in queryKeywords(query)"
                                  :key="keyword"
                                  :bordered="false"
                                  class="fb-chip fb-chip--keyword"
                                >
                                  {{ keyword }}
                                </Tag>
                              </div>
                              <!-- 引擎的说明里混着内部代码：给人看的留在正文，带代码的收进技术详情 -->
                              <ul v-if="queryNotes(query).length > 0" class="fb-notes">
                                <li v-for="(note, index) in queryNotes(query)" :key="index">{{ note }}</li>
                              </ul>
                              <details v-if="queryTechnical(query).length > 0" class="fb-raw">
                                <summary>{{ $t('gainos.findBuyers.technicalDetails') }}</summary>
                                <ul class="fb-list">
                                  <li v-for="(item, index) in queryTechnical(query)" :key="index">{{ item }}</li>
                                </ul>
                              </details>
                            </li>
                          </ol>
                        </li>
                      </ul>

                      <div class="fb-plan__actions">
                        <Button v-if="runRefs[plan.id]" @click="openPlanRun(plan)">
                          {{ $t('gainos.findBuyers.viewRun') }}
                        </Button>
                        <Button
                          v-if="plan.status === 'DRAFT'"
                          :disabled="planBusy === plan.id"
                          @click="confirmPlan(plan)"
                        >
                          {{ $t('gainos.findBuyers.confirmPlan') }}
                        </Button>
                        <Button
                          v-if="plan.status === 'READY' && !runRefs[plan.id]"
                          :disabled="planBusy === plan.id || taskRunning"
                          :loading="planBusy === plan.id"
                          :title="taskRunning ? $t('gainos.findBuyers.runInProgress') : undefined"
                          size="small"
                          @click="executePlan(plan)"
                        >
                          {{ $t('gainos.findBuyers.executePlan') }}
                        </Button>
                        <!-- 已执行或已有历史运行的方案可按原样再跑一次：引擎凭新的尝试标识放行，每次都是一条新的运行。 -->
                        <Button
                          v-if="plan.status === 'EXECUTED' || (plan.status === 'READY' && Boolean(runRefs[plan.id]))"
                          :disabled="planBusy === plan.id || taskRunning"
                          :loading="planBusy === plan.id"
                          :title="taskRunning ? $t('gainos.findBuyers.runInProgress') : undefined"
                          @click="executePlan(plan)"
                        >
                          {{ $t('gainos.findBuyers.rerunPlan') }}
                        </Button>
                      </div>
                      <details class="fb-raw">
                        <summary>{{ $t('gainos.findBuyers.planRaw') }}</summary>
                        <pre>{{ JSON.stringify(plan.queries, null, 2) }}</pre>
                      </details>
                      <p v-if="runRefs[plan.id]" class="fb-muted">{{ $t('gainos.findBuyers.runStarted') }}</p>
                      <p v-else-if="plan.status === 'EXECUTED'" class="fb-muted">
                        {{ $t('gainos.findBuyers.runLinkMissing') }}
                      </p>
                    </li>
                  </ul>
                  <p v-else class="fb-muted">{{ $t('gainos.findBuyers.noPlans') }}</p>
                </section>

                <!-- 最近寻源 -->
                <section class="fb-section" data-gs="icp-runs">
                  <header class="fb-section__head">
                    <div class="min-w-0">
                      <h3 class="fb-section__title">{{ $t('gainos.findBuyers.latestRun') }}</h3>
                      <p class="fb-muted">{{ $t('gainos.findBuyers.taskRunsDesc') }}</p>
                    </div>
                  </header>
                  <ul v-if="taskRuns.length > 0" class="fb-stack">
                    <li v-for="run in taskRuns" :key="run.id" class="fb-run">
                      <div class="fb-run__head">
                        <GsTag :tone="taskRunStatusTone(run.status)">{{ taskRunStatusLabel(run.status) }}</GsTag>
                        <span class="fb-muted">{{ formatRunTime(run.startedAt) }}</span>
                        <Button v-if="run.runId" class="fb-run__action" size="small" @click="openRun(run.runId)">
                          {{ $t('gainos.findBuyers.viewRun') }}
                        </Button>
                      </div>
                    </li>
                  </ul>
                  <p v-else class="fb-muted">{{ $t('gainos.findBuyers.taskRunsEmpty') }}</p>
                </section>
              </template>

              <!-- 三层画像结构（卖方 / 买方 / 同行排除彻底解耦） -->
              <section
                v-if="selectedThreeLayer"
                class="fb-section"
                data-gs="icp-three-layer"
              >
                <header class="fb-section__head">
                  <div class="min-w-0">
                    <h3 class="fb-section__title">{{ $t('gainos.findBuyers.threeLayerTitle') }}</h3>
                    <p class="fb-muted">{{ $t('gainos.findBuyers.threeLayerDesc') }}</p>
                  </div>
                </header>
                <ThreeLayerProfileCard :profile="selectedThreeLayer" />
              </section>

              <!-- 画像概览 -->
              <section class="fb-section" data-gs="icp-overview">
                <header class="fb-section__head">
                  <div class="min-w-0">
                    <h3 class="fb-section__title">{{ $t('gainos.findBuyers.overviewTitle') }}</h3>
                    <p class="fb-muted">{{ $t('gainos.findBuyers.detailHint') }}</p>
                  </div>
                </header>
                <div class="fb-sections">
                  <div class="fb-block">
                    <p class="fb-label">{{ $t('gainos.findBuyers.targetMarkets') }}</p>
                    <div v-if="(selected.targetMarkets ?? []).length > 0" class="fb-chips">
                      <Tag
                        v-for="market in selected.targetMarkets"
                        :key="market"
                        :bordered="false"
                        class="fb-chip"
                        :title="market"
                      >
                        {{ regionName(market) }}
                      </Tag>
                    </div>
                    <p v-else class="fb-muted">—</p>
                  </div>

                  <div class="fb-block">
                    <p class="fb-label">{{ $t('gainos.findBuyers.companyAttributes') }}</p>
                    <Descriptions
                      v-if="attributesOf(selected).length > 0"
                      :colon="false"
                      :column="{ md: 2, xs: 1 }"
                      size="small"
                    >
                      <DescriptionsItem
                        v-for="item in attributesOf(selected)"
                        :key="item.key"
                        :label="item.key"
                      >
                        {{ item.value }}
                      </DescriptionsItem>
                    </Descriptions>
                    <p v-else class="fb-muted">—</p>
                  </div>

                  <!-- 画像依据：引擎记录的「这份画像按什么生成」，和上面的目标公司属性不是一回事。 -->
                  <div v-if="lineageOf(selected).length > 0" class="fb-block">
                    <p class="fb-label">{{ $t('gainos.findBuyers.lineageTitle') }}</p>
                    <Descriptions :colon="false" :column="{ md: 2, xs: 1 }" size="small">
                      <DescriptionsItem
                        v-for="item in lineageOf(selected)"
                        :key="item.key"
                        :label="item.key"
                      >
                        {{ item.value }}
                      </DescriptionsItem>
                    </Descriptions>
                  </div>

                  <div class="fb-grid-2">
                    <div v-for="section in overviewSections" :key="section.key" class="fb-block">
                      <p class="fb-label">{{ section.title }}</p>
                      <p class="fb-hint">{{ section.hint }}</p>
                      <ul v-if="section.items.length > 0" class="fb-list">
                        <li v-for="(item, i) in section.items" :key="i">{{ item }}</li>
                      </ul>
                      <p v-else class="fb-muted">—</p>
                    </div>
                  </div>

                  <!-- 该找的人：角色卡（想达成什么 / 客户难题 / 关注点） -->
                  <div v-if="peopleOfSelected.length > 0" class="fb-block">
                    <p class="fb-label">{{ $t('gainos.findBuyers.personas') }}</p>
                    <p class="fb-hint">{{ $t('gainos.findBuyers.personasHint') }}</p>
                    <div class="fb-personas">
                      <div v-for="person in peopleOfSelected" :key="person.title" class="fb-persona">
                        <p class="fb-persona__title">{{ person.title }}</p>
                        <p v-if="person.goals.length" class="fb-muted">
                          <em class="fb-key">{{ $t('gainos.findBuyers.goals') }}</em>{{ person.goals.join(' · ') }}
                        </p>
                        <p v-if="person.pains.length" class="fb-muted">
                          <em class="fb-key">{{ $t('gainos.findBuyers.painPoints') }}</em>
                          {{ person.pains.join(' · ') }}
                        </p>
                        <p v-if="person.concerns.length" class="fb-muted">
                          <em class="fb-key">{{ $t('gainos.findBuyers.concerns') }}</em>{{ person.concerns.join(' · ') }}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              <!-- Phase 3B：已沉淀的排除规则与反例学习摘要 -->
              <section
                v-if="feedbackSummary"
                class="fb-section"
                data-gs="icp-learned-feedback"
              >
                <header class="fb-section__head">
                  <div class="min-w-0">
                    <h3 class="fb-section__title">{{ $t('gainos.findBuyers.learnedFeedbackTitle') }}</h3>
                    <p class="fb-muted">{{ $t('gainos.findBuyers.learnedFeedbackDesc') }}</p>
                  </div>
                  <GsTag tone="info">
                    {{ $t('gainos.findBuyers.learnedTotalCount', { count: feedbackSummary.stats.totalRecorded }) }}
                  </GsTag>
                </header>
                <div
                  v-if="
                    feedbackSummary.excludedDomains.length === 0 &&
                    feedbackSummary.excludedKeywords.length === 0 &&
                    feedbackSummary.counterExamples.length === 0 &&
                    feedbackSummary.positiveExamples.length === 0
                  "
                  class="fb-muted"
                >
                  {{ $t('gainos.findBuyers.learnedEmpty') }}
                </div>
                <div v-else class="fb-stack">
                  <div v-if="feedbackSummary.excludedDomains.length > 0" class="fb-block">
                    <p class="fb-label">{{ $t('gainos.findBuyers.learnedExcludedDomains') }}</p>
                    <div class="fb-chips" data-gs="icp-learned-domains">
                      <Tag
                        v-for="domain in feedbackSummary.excludedDomains"
                        :key="domain"
                        :bordered="false"
                        class="fb-chip"
                        color="red"
                      >
                        {{ domain }}
                      </Tag>
                    </div>
                  </div>
                  <div v-if="feedbackSummary.excludedKeywords.length > 0" class="fb-block">
                    <p class="fb-label">{{ $t('gainos.findBuyers.learnedExcludedKeywords') }}</p>
                    <div class="fb-chips" data-gs="icp-learned-keywords">
                      <Tag
                        v-for="kw in feedbackSummary.excludedKeywords"
                        :key="kw"
                        :bordered="false"
                        class="fb-chip"
                        color="orange"
                      >
                        {{ kw }}
                      </Tag>
                    </div>
                  </div>
                  <div v-if="feedbackSummary.counterExamples.length > 0" class="fb-block">
                    <p class="fb-label">{{ $t('gainos.findBuyers.learnedCounterExamples') }}</p>
                    <ul class="fb-list" data-gs="icp-learned-counter-examples">
                      <li v-for="(ex, idx) in feedbackSummary.counterExamples" :key="`${ex.domain ?? idx}-${idx}`">
                        <strong>{{ ex.companyName || ex.domain || '—' }}</strong>
                        <Tag :bordered="false" class="ml-2 text-xs">{{ learnedReasonLabel(ex.reason) }}</Tag>
                        <span v-if="ex.note" class="fb-muted"> · {{ ex.note }}</span>
                        <span v-if="ex.recordedAt" class="fb-muted"> · {{ formatDateTime(ex.recordedAt) }}</span>
                      </li>
                    </ul>
                  </div>
                </div>
              </section>

              <!-- 反馈建议（只建议，采纳=手动编辑画像） -->
              <section
                v-if="feedback && feedback.suggestions.length > 0"
                class="fb-section"
                data-gs="icp-suggestions"
              >
                <header class="fb-section__head">
                  <div class="min-w-0">
                    <h3 class="fb-section__title">{{ $t('gainos.findBuyers.suggestionsTitle') }}</h3>
                    <p class="fb-muted">{{ $t('gainos.findBuyers.suggestionsDesc') }}</p>
                  </div>
                </header>
                <ul class="fb-list">
                  <li v-for="(card, index) in feedback.suggestions" :key="index">{{ card.message }}</li>
                </ul>
              </section>

              <!-- 高级：资格规则与回测。产品决定暂时隐藏（feature-flags.ts）；恢复时仍是默认收起。 -->
              <section v-if="!ICP_ADVANCED_HIDDEN" class="fb-section fb-section--flush" data-gs="icp-advanced">
                <Collapse ghost>
                  <CollapsePanel key="advanced" :header="$t('gainos.findBuyers.advanced')">
                    <div class="fb-stack">
                      <Alert
                        v-if="selected.ruleLint.length > 0"
                        :message="$t('gainos.findBuyers.ruleLint')"
                        show-icon
                        type="warning"
                      >
                        <template #description>
                          <ul class="fb-list">
                            <li v-for="(warning, i) in selected.ruleLint" :key="i">{{ warning }}</li>
                          </ul>
                        </template>
                      </Alert>

                      <div class="fb-sub">
                        <div class="fb-sub__head">
                          <div>
                            <p class="fb-h3">{{ $t('gainos.findBuyers.rulesTitle') }}</p>
                            <p class="fb-muted">{{ $t('gainos.findBuyers.rulesDesc') }}</p>
                          </div>
                          <Button size="small" @click="openRule()">{{ $t('gainos.findBuyers.addRule') }}</Button>
                        </div>
                        <ErrorNotice
                          v-if="ruleError && !ruleOpen"
                          :next="ruleError.next"
                          :title="ruleError.title"
                        />
                        <ul v-if="selected.rules.length > 0" class="fb-stack">
                          <li v-for="rule in selected.rules" :key="rule.id" class="fb-rule">
                            <Tag :bordered="false" class="fb-chip">{{ kindLabel(rule.kind) }}</Tag>
                            <code class="fb-rule__expr">
                              {{ rule.field }} {{ operatorLabel(rule.operator) }} {{ ruleValueText(rule.value) }}
                            </code>
                            <span v-if="rule.kind === 'NICE_TO_HAVE'" class="fb-muted">×{{ rule.weight }}</span>
                            <span v-if="rule.rationale" class="fb-muted fb-rule__why">{{ rule.rationale }}</span>
                            <span class="fb-rule__actions">
                              <Button size="small" type="link" @click="openRule(rule)">
                                {{ $t('gainos.findBuyers.editRule') }}
                              </Button>
                              <Button danger size="small" type="link" @click="removeRule(rule)">
                                {{ $t('gainos.findBuyers.deleteRule') }}
                              </Button>
                            </span>
                          </li>
                        </ul>
                        <p v-else class="fb-muted">{{ $t('gainos.findBuyers.noRules') }}</p>
                      </div>

                      <div class="fb-sub">
                        <p class="fb-h3">{{ $t('gainos.findBuyers.backtestTitle') }}</p>
                        <p class="fb-muted">{{ $t('gainos.findBuyers.backtestDesc') }}</p>
                        <Input.TextArea
                          v-model:value="backtestText"
                          :aria-label="$t('gainos.findBuyers.backtestSamples')"
                          :rows="8"
                          class="fb-mono"
                        />
                        <ErrorNotice
                          v-if="backtestError"
                          :next="backtestError.next"
                          :title="backtestError.title"
                        />
                        <Button :loading="backtestBusy" class="justify-self-start" type="primary" @click="runBacktest">
                          {{ $t('gainos.findBuyers.runBacktest') }}
                        </Button>
                        <template v-if="backtest">
                          <dl class="fb-facts">
                            <div v-for="(value, key) in backtest.metrics" :key="key">
                              <dt>{{ key }}</dt>
                              <dd>{{ textOf(value) || JSON.stringify(value) }}</dd>
                            </div>
                          </dl>
                          <ul class="fb-list">
                            <li v-for="(result, i) in backtest.results" :key="i">
                              {{ textOf(result) || JSON.stringify(result) }}
                            </li>
                          </ul>
                        </template>
                      </div>
                    </div>
                  </CollapsePanel>
                </Collapse>
              </section>
            </template>
          </div>
        </GsCard>
          </div>
        </div>
      </div>
    </template>
    <!-- 设定买家画像（从公司档案生成初稿） -->
    <Modal
      v-model:open="createOpen"
      :confirm-loading="creating"
      :ok-button-props="{ disabled: !canCreateIcp }"
      :ok-text="$t('gainos.findBuyers.generate')"
      :title="$t('gainos.findBuyers.createTitle')"
      :width="560"
      data-gs="icp-create-modal"
      @ok="createIcp"
    >
      <div class="fb-dialog">
        <p class="fb-muted">{{ $t(ICP_ADVANCED_HIDDEN ? 'gainos.findBuyers.createDescSimple' : 'gainos.findBuyers.createDesc') }}</p>
        <ErrorNotice
          v-if="createError"
          :code="createError.code"
          :next="createError.next"
          :title="createError.title"
          :why="createError.why"
        />
        <label class="fb-field">
          <span>{{ $t('gainos.findBuyers.company') }}</span>
          <GsSelect
            v-model="selectedCompanyId"
            :ariaLabel="$t('gainos.findBuyers.company')"
            class="w-full"
            data-gs="icp-company-select"
            :disabled="orderedCompanies.length === 0"
            :options="companyOptions"
          />
        </label>
        <label v-if="orderedCompanies.length > 0" class="fb-field">
          <span>{{ $t('gainos.findBuyers.createName') }}</span>
          <Input
            v-model:value="createName"
            :maxlength="120"
            :placeholder="$t('gainos.findBuyers.createNameHint')"
            data-gs="icp-create-name"
          />
        </label>
        <label v-if="orderedCompanies.length > 0" class="fb-field">
          <span>{{ $t('gainos.findBuyers.createProductLines') }}</span>
          <Input
            v-model:value="createProductLines"
            :placeholder="$t('gainos.findBuyers.createProductLinesHint')"
            data-gs="icp-create-products"
          />
        </label>
        <label v-if="orderedCompanies.length > 0" class="fb-field">
          <span>{{ $t('gainos.findBuyers.createTargetMarkets') }}</span>
          <Input
            v-model:value="createTargetMarkets"
            :placeholder="$t('gainos.findBuyers.createTargetMarketsHint')"
            data-gs="icp-create-markets"
          />
          <div
            v-if="createComtradeRecs.length > 0"
            class="fb-comtrade-chips"
            data-gs="create-comtrade-badges"
          >
            <button
              v-for="rec in createComtradeRecs.slice(0, 6)"
              :key="rec.code"
              :class="{ active: commas(createTargetMarkets).map((m) => m.toUpperCase()).includes(rec.code) }"
              :data-gs="`create-comtrade-${rec.code}`"
              :title="rec.reason ?? undefined"
              class="fb-pill fb-pill--sm"
              type="button"
              @click="toggleCreateComtradeMarket(rec.code)"
            >
              + {{ rec.name }} ({{ rec.code }})
            </button>
          </div>
        </label>
        <div v-if="orderedCompanies.length > 0" class="fb-field">
          <span>{{ $t('gainos.findBuyers.createBuyerRoles') }}</span>
          <div class="fb-comtrade-chips" data-gs="icp-create-roles">
            <button
              v-for="role in BUYER_ROLE_CODES"
              :key="role"
              :aria-pressed="createBuyerRoles.includes(role)"
              :class="{ active: createBuyerRoles.includes(role) }"
              :data-gs="`create-buyer-role-${role}`"
              class="fb-pill fb-pill--sm"
              type="button"
              @click="toggleCreateBuyerRole(role)"
            >
              {{ createBuyerRoles.includes(role) ? '✓' : '+' }} {{ $t(`gainos.threeLayer.role.${role}`) }}
            </button>
          </div>
        </div>
        <label v-if="orderedCompanies.length > 0" class="fb-field">
          <span>{{ $t('gainos.findBuyers.createScenario') }}</span>
          <GsSelect
            v-model="createScenario"
            :ariaLabel="$t('gainos.findBuyers.createScenario')"
            :options="[
              { label: $t('gainos.findBuyers.createScenarioAuto'), value: '' },
              ...PROCUREMENT_SCENARIO_CODES.map((code) => ({
                label: $t(`gainos.threeLayer.scenario.${code}`),
                value: code,
              })),
            ]"
            class="w-full"
            data-gs="icp-create-scenario"
          />
        </label>
        <Alert v-if="companies.length === 0" type="info" show-icon data-gs="profile-needs-company"
          :message="$t('gainosOb.setup.profileNeedCompany')">
          <template #action>
            <RouterLink :to="{ path: '/workspace', query: { setup: '1' } }" @click="createOpen = false">
              {{ $t('gainosOb.setup.goSetup') }}
            </RouterLink>
          </template>
        </Alert>
        <Alert v-if="missingProduct && selectedCompanyId" type="warning" show-icon data-gs="profile-needs-product"
          :message="$t(productSelection === 'cleared' ? 'gainosOb.setup.profileProductSelectionCleared' : 'gainosOb.setup.profileNeedProduct')">
          <template #action>
            <RouterLink :to="{ path: '/companies', query: { companyId: selectedCompanyId, tab: 'facts' } }" @click="createOpen = false">
              {{ $t('gainosOb.setup.goCompanyFacts') }}
            </RouterLink>
          </template>
        </Alert>
        <p v-if="claimsChecking" class="fb-muted">{{ $t('gainos.findBuyers.checkingFacts') }}</p>
        <Alert
          v-else-if="claimsCheckError"
          :message="$t('gainos.findBuyers.factsCheckFailed')"
          role="alert"
          show-icon
          type="error"
        >
          <template #action>
            <Button size="small" @click="checkApprovedClaims(selectedCompanyId)">
              {{ $t('gainos.common.retry') }}
            </Button>
          </template>
        </Alert>
        <Alert
          v-else-if="approvedClaimCount === 0"
          :message="
            isAdmin
              ? $t('gainos.findBuyers.noApprovedFacts')
              : $t('gainos.findBuyers.noApprovedFactsMember')
          "
          data-gs="no-approved-facts-alert"
          show-icon
          type="warning"
        >
          <template #action>
            <Button
              v-if="isAdmin"
              :loading="quickApprovingFacts"
              data-gs="quick-approve-facts"
              size="small"
              type="primary"
              @click="quickApproveOnboardingFacts"
            >
              {{
                quickApprovingFacts
                  ? $t('gainos.findBuyers.quickApprovingFacts')
                  : $t('gainos.findBuyers.quickApproveFacts')
              }}
            </Button>
            <RouterLink :to="{ path: '/companies', query: { companyId: selectedCompanyId, tab: 'facts' } }" @click="createOpen = false">
              {{ $t('gainosOb.setup.goCompanyFacts') }}
            </RouterLink>
          </template>
        </Alert>
        <Alert
          v-else-if="approvedClaimCount !== null"
          :message="$t('gainos.findBuyers.approvedFactsCount', { count: approvedClaimCount })"
          show-icon
          type="info"
        />
        <p class="fb-muted">{{ $t('gainos.findBuyers.createNote') }}</p>
      </div>
    </Modal>

    <!-- 编辑画像：常用内容都是普通输入框；目标公司属性按字段填，没登记的才留在「其他属性」的原始数据里 -->
    <Modal
      v-model:open="editOpen"
      :confirm-loading="editing"
      :ok-text="$t('gainos.findBuyers.saveChanges')"
      :title="$t('gainos.findBuyers.editTitle')"
      :width="760"
      @ok="saveEdit"
    >
      <div class="fb-dialog">
        <ErrorNotice v-if="editError" :next="editError.next" :title="editError.title" />
        <div class="fb-form-grid">
          <label class="fb-field">
            <span>{{ $t('gainos.findBuyers.name') }}</span>
            <Input v-model:value="editForm.name" />
          </label>
          <label class="fb-field">
            <span>{{ $t('gainos.findBuyers.targetMarkets') }}</span>
            <Input v-model:value="editForm.targetMarkets" :placeholder="$t('gainos.findBuyers.marketsHint')" />
          </label>
        </div>
        <label class="fb-field">
          <span>{{ $t('gainos.findBuyers.painPoints') }}</span>
          <em class="fb-field-hint">{{ $t('gainos.findBuyers.painPointsHint') }}</em>
          <Input.TextArea v-model:value="editForm.painPoints" :auto-size="{ maxRows: 6, minRows: 2 }" />
        </label>
        <label class="fb-field">
          <span>{{ $t('gainos.findBuyers.triggerSignals') }}</span>
          <em class="fb-field-hint">{{ $t('gainos.findBuyers.triggerSignalsHint') }}</em>
          <Input.TextArea v-model:value="editForm.triggerSignals" :auto-size="{ maxRows: 6, minRows: 2 }" />
        </label>
        <label class="fb-field">
          <span>{{ $t('gainos.findBuyers.exclusions') }}</span>
          <em class="fb-field-hint">{{ $t('gainos.findBuyers.exclusionsHint') }}</em>
          <Input.TextArea v-model:value="editForm.exclusions" :auto-size="{ maxRows: 6, minRows: 2 }" />
        </label>
        <label class="fb-field">
          <span>{{ $t('gainos.findBuyers.valueProps') }}</span>
          <em class="fb-field-hint">{{ $t('gainos.findBuyers.valuePropsHint') }}</em>
          <Input.TextArea v-model:value="editForm.valueProps" :auto-size="{ maxRows: 6, minRows: 2 }" />
        </label>

        <fieldset class="fb-fieldset">
          <legend>{{ $t('gainos.findBuyers.companyAttributes') }}</legend>
          <p class="fb-hint fb-fieldset__hint">{{ $t('gainos.findBuyers.attributesSectionHint') }}</p>
          <div class="fb-form-grid">
            <label v-for="field in ATTRIBUTE_FIELDS" :key="field.key" class="fb-field">
              <span>{{ attributeLabel(field.key) }}</span>
              <Input.TextArea
                v-if="field.list"
                v-model:value="editForm.attributes[field.key]"
                :auto-size="{ maxRows: 5, minRows: 1 }"
              />
              <Input v-else v-model:value="editForm.attributes[field.key]" />
            </label>
          </div>
          <details class="fb-adv">
            <summary>{{ $t('gainos.findBuyers.attributesOther') }}</summary>
            <p class="fb-hint">{{ $t('gainos.findBuyers.attributesOtherHint') }}</p>
            <Input.TextArea v-model:value="editForm.otherAttributesText" :rows="5" class="fb-mono" />
          </details>
        </fieldset>
      </div>
    </Modal>

    <!-- 新增 / 编辑规则 -->
    <Modal
      v-model:open="ruleOpen"
      :confirm-loading="ruleBusy"
      :ok-text="$t('gainos.findBuyers.saveRule')"
      :title="ruleModalTitle"
      :width="640"
      data-gs="icp-rule-modal"
      @ok="saveRule"
    >
      <div class="fb-dialog">
        <ErrorNotice v-if="ruleError" :next="ruleError.next" :title="ruleError.title" />
        <div class="fb-form-grid">
          <label class="fb-field">
            <span>{{ $t('gainos.findBuyers.ruleKindLabel') }}</span>
            <GsSelect
              v-model="ruleForm.kind"
              :ariaLabel="$t('gainos.findBuyers.ruleKindLabel')"
              class="w-full"
              :options="kindOptions"
            />
          </label>
          <label class="fb-field">
            <span>{{ $t('gainos.findBuyers.ruleField') }}</span>
            <Input v-model:value="ruleForm.field" />
          </label>
          <label class="fb-field">
            <span>{{ $t('gainos.findBuyers.ruleOperatorLabel') }}</span>
            <GsSelect
              v-model="ruleForm.operator"
              :ariaLabel="$t('gainos.findBuyers.ruleOperatorLabel')"
              class="w-full"
              :options="operatorOptions"
            />
          </label>
          <label class="fb-field">
            <span>{{ $t('gainos.findBuyers.ruleWeight') }}</span>
            <InputNumber v-model:value="ruleForm.weight" :min="0" :step="0.5" style="width: 100%" />
          </label>
          <label class="fb-field fb-field--wide">
            <span>{{ $t('gainos.findBuyers.ruleValue') }}</span>
            <Input v-model:value="ruleForm.valueText" :placeholder="$t('gainos.findBuyers.ruleValueHint')" />
          </label>
          <label class="fb-field fb-field--wide">
            <span>{{ $t('gainos.findBuyers.ruleRationale') }}</span>
            <Input v-model:value="ruleForm.rationale" />
          </label>
        </div>
      </div>
    </Modal>

    <!-- 下一步：贴在视口底部。这份画像现在该做什么，全页只给这一个按钮（和方案里的具体按钮做同一件事）。 -->
    <div v-if="nextAction" class="fb-next" data-gs="icp-next">
      <p class="fb-next__hint">
        <strong>{{ $t('gainos.findBuyers.nextLabel') }}：{{ nextAction.title }}</strong>
        <span>{{ nextAction.desc }}</span>
      </p>
      <Button
        class="fb-next__btn"
        data-gs="icp-next-button"
        :loading="nextAction.loading"
        size="large"
        type="primary"
        @click="nextAction.run"
      >
        {{ $t('gainos.findBuyers.nextLabel') }} <span aria-hidden="true">→</span>
      </Button>
    </div>
  </div>
</template>

<style scoped>
/* ── 页面级文字 ───────────────────────────────────────────────────────── */
.fb-h2 {
  margin: 0;
  color: var(--gs-fg);
  font-size: 16px;
  line-height: 24px;
  font-weight: 600;
}
.fb-h3 {
  margin: 0;
  color: var(--gs-fg);
  font-size: 14px;
  line-height: 22px;
  font-weight: 600;
}
.fb-muted {
  margin: 0;
  color: var(--gs-fg-muted);
  font-size: 13px;
  line-height: 20px;
}
.fb-label {
  margin: 0 0 4px;
  color: var(--gs-fg-muted);
  font-size: 12px;
  line-height: 18px;
}
/* 板块标题下的一行白话说明：让没看过文档的人也知道这一栏是问什么。 */
.fb-hint {
  margin: -2px 0 2px;
  color: var(--gs-fg-subtle);
  font-size: 12px;
  line-height: 18px;
}
.fb-field-hint {
  display: block;
  margin: -2px 0 4px;
  color: var(--gs-fg-subtle);
  font-size: 12px;
  line-height: 18px;
  font-style: normal;
}
.fb-toolbar__main {
  min-width: 0;
  padding-left: 12px;
}
.fb-toolbar__hint {
  margin-top: 2px;
}
.fb-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}

/* ── 多画像 240px 左侧窄栏 + 右侧工作区 ──────────────────────────────── */
.fb-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.fb-main {
  display: grid;
  gap: 12px;
  min-width: 0;
}

.fb-rail {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.fb-rail__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2px;
}

.fb-rail__title {
  color: var(--gs-fg-muted);
  font-size: 12px;
  font-weight: 600;
}

.fb-rail__count {
  color: var(--gs-fg-subtle);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.fb-rail__list {
  display: grid;
  gap: 8px;
}

@container (min-width: 960px) {
  .fb-layout--split {
    grid-template-columns: 240px minmax(0, 1fr);
    gap: 18px;
  }
  .fb-rail {
    position: sticky;
    top: 16px;
  }
}

/* ── 画像工作区（页内常驻）─────────────────────────────────────────────── */
.fb-kicker {
  margin: 0;
  color: var(--gs-accent-fg);
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
}
.fb-workspace__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px 24px;
  padding: 20px 24px 16px;
  border-bottom: 1px solid var(--gs-divider);
}
.fb-workspace__name {
  margin: 0;
  color: var(--gs-fg);
  font-size: 20px;
  line-height: 28px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.fb-workspace__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}
.fb-workspace__tools {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}
.fb-workspace__field {
  display: grid;
  gap: 4px;
  color: var(--gs-fg-muted);
  font-size: 12px;
}
.fb-workspace__select {
  min-width: 280px;
}
.fb-workspace__body {
  display: grid;
}
.fb-section {
  display: grid;
  gap: 12px;
  padding: 20px 24px;
}
.fb-section + .fb-section {
  border-top: 1px solid var(--gs-divider);
}
.fb-section--flush {
  padding-top: 4px;
  padding-bottom: 4px;
}
.fb-section__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
}
.fb-section__title {
  margin: 0;
  color: var(--gs-fg);
  font-size: 16px;
  line-height: 24px;
  font-weight: 600;
}
.fb-section__head .fb-muted {
  margin-top: 2px;
}

/* ── 下一步：贴在视口底部 ──────────────────────────────────────────────── */
.fb-next {
  position: sticky;
  /* 底部有进度浮窗时抬到它上面 */
  bottom: calc(12px + var(--gs-flow-bar-h, 0px));
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 12px 10px 18px;
  border-radius: 10px;
  background: var(--gs-surface);
  box-shadow: var(--gs-shadow-float);
}
.fb-next__hint {
  display: grid;
  gap: 2px;
  min-width: 0;
  margin: 0;
}
.fb-next__hint strong {
  color: var(--gs-fg);
  font-size: 13.5px;
  line-height: 20px;
  font-weight: 600;
}
.fb-next__hint span {
  color: var(--gs-fg-muted);
  font-size: 12.5px;
  line-height: 18px;
}
.fb-next__btn {
  flex: none;
}

/* ── 画像概览 ─────────────────────────────────────────────────────────── */
.fb-block {
  display: grid;
  gap: 6px;
}
.fb-sections > * + * {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--gs-divider);
}
.fb-key {
  display: inline-block;
  margin-right: 6px;
  color: var(--gs-fg-subtle);
  font-style: normal;
}
.fb-grid-2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px 24px;
}
.fb-list {
  display: grid;
  gap: 4px;
  margin: 0;
  padding-left: 18px;
  color: var(--gs-fg);
  font-size: 13px;
  line-height: 1.7;
}
.fb-list strong {
  font-weight: 600;
}
.fb-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.fb-chip {
  margin: 0;
  padding-inline: 8px;
  border-radius: 6px;
  background: var(--gs-surface-2);
  color: var(--gs-fg-muted);
  font-size: 12px;
  line-height: 22px;
}
.fb-chip--keyword {
  background: var(--gs-accent-soft);
  color: var(--gs-accent-fg);
}
.fb-personas {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 10px;
}
.fb-persona {
  display: grid;
  gap: 4px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--gs-surface-2);
}
.fb-persona__title {
  margin: 0;
  color: var(--gs-fg);
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
}

/* ── 寻源方案：结论 → 渠道 → 搜索词 ───────────────────────────────────── */
.fb-stack {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.fb-plan,
.fb-run,
.fb-query {
  display: grid;
  min-width: 0;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--gs-surface-2);
}
.fb-plan__head,
.fb-run__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.fb-plan__lead {
  margin: 0;
  color: var(--gs-fg);
  font-size: 13.5px;
  line-height: 20px;
  font-weight: 500;
}
.fb-plan__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.fb-run__action {
  margin-left: auto;
}
.fb-channels {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.fb-channel {
  display: grid;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--gs-surface);
}
.fb-channel__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.fb-channel__name {
  color: var(--gs-fg);
  font-size: 13px;
  font-weight: 600;
}
.fb-channel__toggle {
  height: auto;
  margin-left: auto;
  padding: 0;
}
.fb-queries {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0 0 0 12px;
  list-style: none;
  border-left: 2px solid var(--gs-divider);
}
.fb-query__meta {
  margin: 0;
}
.fb-query__filter {
  padding: 1px 8px;
  border-radius: 6px;
  background: var(--gs-surface);
  color: var(--gs-fg);
  font-size: 12px;
  line-height: 20px;
}
.fb-query__filter em {
  margin-right: 4px;
  color: var(--gs-fg-muted);
  font-style: normal;
}
.fb-notes {
  display: grid;
  gap: 4px;
  margin: 0;
  padding-left: 18px;
  color: var(--gs-fg);
  font-size: 13px;
  line-height: 1.7;
}
.fb-raw > summary {
  color: var(--gs-fg-subtle);
  font-size: 12px;
  cursor: pointer;
}
.fb-raw pre {
  max-height: 260px;
  margin: 8px 0 0;
  padding: 10px 12px;
  overflow: auto;
  border-radius: 8px;
  background: var(--gs-surface);
  font-size: 11.5px;
}
.fb-raw .fb-list {
  margin-top: 6px;
  color: var(--gs-fg-muted);
}

/* ── 高级：规则与回测 ──────────────────────────────────────────────────── */
.fb-sub {
  display: grid;
  gap: 8px;
  padding-top: 16px;
  border-top: 1px solid var(--gs-divider);
}
.fb-sub__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.fb-rule {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--gs-surface-2);
}
.fb-rule__expr {
  color: var(--gs-fg);
  font-family: var(--gs-font-mono);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.fb-rule__why {
  flex: 1 1 160px;
  min-width: 0;
}
.fb-rule__actions {
  display: flex;
  gap: 4px;
}
.fb-facts {
  display: grid;
  gap: 4px;
  margin: 0;
}
.fb-facts div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}
.fb-facts dt {
  color: var(--gs-fg-muted);
}
.fb-facts dd {
  margin: 0;
  text-align: right;
}
.fb-mono {
  font-family: var(--gs-font-mono);
  font-size: 12px;
}

/* ── 弹层表单 ─────────────────────────────────────────────────────────── */
.fb-dialog {
  display: grid;
  gap: 12px;
}
.fb-field {
  display: grid;
  gap: 6px;
  color: var(--gs-fg-muted);
  font-size: 12px;
  font-weight: 500;
}
.fb-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 16px;
}
.fb-field--wide {
  grid-column: 1 / -1;
}
.fb-company-switcher {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.fb-company-switcher__pills,
.fb-comtrade-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.fb-pill {
  padding: 5px 12px;
  border: 1px solid var(--gs-divider, #d1d5db);
  border-radius: 999px;
  background: var(--gs-surface, #fff);
  color: var(--gs-fg-2, #374151);
  font-size: 12.5px;
  cursor: pointer;
}
.fb-pill--sm {
  padding: 3px 9px;
  font-size: 11.5px;
}
.fb-pill.active {
  border-color: var(--gs-accent, #2563eb);
  background: var(--gs-accent-soft, #eff6ff);
  color: var(--gs-accent-fg, #1d4ed8);
  font-weight: 600;
}
.fb-fieldset {
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 12px 14px 14px;
  border: 1px solid var(--gs-divider);
  border-radius: 10px;
}
.fb-fieldset > legend {
  padding: 0 6px;
  color: var(--gs-fg);
  font-size: 13px;
  font-weight: 600;
}
.fb-fieldset__hint {
  margin: 0;
}
.fb-adv > summary {
  color: var(--gs-fg-muted);
  font-size: 12.5px;
  cursor: pointer;
}
.fb-adv[open] > summary {
  margin-bottom: 6px;
}

/* ── 窄屏（按内容区宽度）──────────────────────────────────────────────── */
@container (max-width: 719px) {
  .fb-grid-2,
  .fb-form-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .fb-section,
  .fb-workspace__head {
    padding: 16px;
  }
  .fb-workspace__select {
    min-width: 0;
    width: 100%;
  }
  .fb-next {
    align-items: stretch;
    flex-direction: column;
    gap: 8px;
    padding: 12px 12px 12px 14px;
  }
  .fb-next__btn {
    width: 100%;
  }
}
</style>
