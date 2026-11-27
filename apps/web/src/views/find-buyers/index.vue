<script lang="ts" setup>
import type {
  ComtradeRecommendationBundle,
  IcpFeedbackSummaryDto,
  ProcurementScenarioCode,
  StatusTone,
} from '@gain-saas/shared';

import type {
  Backtest,
  CompanyProfile,
  Icp,
  IcpFeedbackReport,
  LeadQueueCounts,
  IcpRule,
  IcpRuleInput,
  QueryPlan,
  TaskRunView,
} from '#/api/gainos';

import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import {
  BUYER_ROLE_CODES,
  extractThreeLayerFromIcp,
  formatDateTime,
  glossaryStatus,
  normalizeComtradeBundle,
  normalizeIcpFeedbackSummary,
  PROCUREMENT_SCENARIO_CODES,
} from '@gain-saas/shared';
import { ChevronRight, Globe, RotateCw, Search } from '@vben/icons';
import { preferences } from '@vben/preferences';

import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  CollapsePanel,
  Input,
  InputNumber,
  Modal,
  Skeleton,
  TabPane,
  Tabs,
  Tag,
} from 'ant-design-vue';

import { ICP_ADVANCED_HIDDEN } from '#/feature-flags';
import ErrorNotice from '#/components/error-notice.vue';
import ComtradeMarketRecommendations from '#/components/gainos/comtrade-market-recommendations.vue';
import GsCard from '#/components/gainos/ui/gs-card.vue';
import GsEmpty from '#/components/gainos/ui/gs-empty.vue';
import GsPage from '#/components/gainos/ui/gs-page.vue';
import GsSelect from '#/components/gainos/ui/gs-select.vue';
import GsTag from '#/components/gainos/ui/gs-tag.vue';
import { feedback as uiFeedback } from '#/feedback';
import { $t } from '#/locales';
import { notifyChainChanged } from '#/composables/use-main-chain-progress';
import { useWorkspaceAccess } from '#/composables/use-workspace-access';
import { regionName } from '#/utils/region-name';

import { failureText, gainosApi } from '#/api/gainos';

import {
  isRunInProgress,
  mintAttemptId,
  newestPlans,
  queryValue,
  recentTaskRuns,
  sourcingPlansLocation,
  sourcingRunLocation,
} from '../runs/sourcing-navigation';

defineOptions({ name: 'FindBuyers' });

const route = useRoute();
const router = useRouter();
const { can, ensureLoaded, isAdmin, loaded: accessLoaded } = useWorkspaceAccess();
const canManage = computed(() => can('acquisition.run'));
type FbTone = Exclude<StatusTone, 'processing'> | 'info';
type LoadError = ReturnType<typeof failureText>;

const RULE_KINDS = ['MUST_HAVE', 'NICE_TO_HAVE', 'EXCLUSION'] as const;
const RULE_OPERATORS = ['eq', 'neq', 'in', 'not_in', 'contains', 'not_contains', 'gte', 'lte', 'matches'] as const;
const MAX_CREATE_MARKETS = 20;

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
const createComtradeBundle = ref<ComtradeRecommendationBundle | null>(null);
const createComtradeLoading = ref(false);
const createComtradeError = ref(false);
let createComtradeRequest = 0;
let createMarketSeed = '';
const confirmedCreateMarkets = computed(() => [...new Set(
  commas(createTargetMarkets.value).map((item) => item.toUpperCase()).filter((code) => /^[A-Z]{2}$/.test(code)),
)]);
const keepExistingActive = ref(true);
const creating = ref(false);
const createError = ref<ReturnType<typeof failureText> | null>(null);
const approvedClaimCount = ref<number | null>(null);
const productSelection = ref<'available' | 'cleared' | 'empty' | 'unknown'>('unknown');
const claimsChecking = ref(false);
const claimsCheckError = ref<string | null>(null);
const quickApprovingFacts = ref(false);
let claimsCheckToken = 0;

type ProfileTab = 'feedback' | 'matching' | 'overview';

const selected = ref<Icp | null>(null);
const detailLoading = ref(false);
const detailError = ref<LoadError | null>(null);
const activating = ref(false);
const activationError = ref<LoadError | null>(null);
const editedProfileId = ref('');
const plans = ref<QueryPlan[]>([]);
const plansLoading = ref(false);
const plansError = ref<LoadError | null>(null);
const runLoading = ref(false);
const runError = ref<LoadError | null>(null);
const recentRun = ref<(TaskRunView & { taskId?: string }) | null>(null);
const runHasResults = ref(false);
let detailVersion = 0;
let sourcingVersion = 0;

const feedback = ref<IcpFeedbackReport | null>(null);
const feedbackSummary = ref<IcpFeedbackSummaryDto | null>(null);
const feedbackCounts = ref<LeadQueueCounts['queueBasis'] | null>(null);
const feedbackError = ref(false);
const feedbackLoading = ref(false);
const feedbackLoaded = ref('');
let feedbackVersion = 0;

const profileTab = computed<ProfileTab>(() => {
  const tab = queryValue(route.query.tab);
  return tab === 'matching' || tab === 'feedback' ? tab : 'overview';
});

function learnedReasonLabel(code: string): string {
  const key = `gainos.findBuyers.learnedReason.${code}`;
  const translated = $t(key);
  return translated === key ? $t('gainos.findBuyers.learnedReason.unspecified') : translated;
}

async function loadFeedback(icpId: string): Promise<void> {
  const seq = ++feedbackVersion;
  feedbackLoading.value = true;
  const [report, summary, counts] = await Promise.allSettled([
    gainosApi.icpFeedback(icpId),
    gainosApi.icpFeedbackSummary(icpId),
    gainosApi.leadQueues(icpId),
  ]);
  if (seq !== feedbackVersion || selected.value?.id !== icpId) return;
  const raw = summary.status === 'fulfilled' ? summary.value : null;
  feedback.value = report.status === 'fulfilled' ? report.value : null;
  feedbackSummary.value = raw && typeof raw === 'object' ? normalizeIcpFeedbackSummary(raw) : null;
  feedbackCounts.value = counts.status === 'fulfilled' ? (counts.value?.queueBasis ?? null) : null;
  feedbackError.value = [report, summary, counts].some((item) => item.status === 'rejected');
  feedbackLoaded.value = icpId;
  feedbackLoading.value = false;
}

function selectTab(key: string | number): void {
  if (!selected.value || typeof key !== 'string') return;
  const { tab: _tab, run: _run, ...rest } = route.query;
  void router.replace({ query: { ...rest, ...(key !== 'overview' ? { tab: key } : {}) } });
}

watch([profileTab, selected], ([tab, icp]) => {
  if (tab === 'feedback' && icp && !feedbackLoading.value && feedbackLoaded.value !== icp.id) {
    void loadFeedback(icp.id);
  }
});

const editOpen = ref(false);
const editing = ref(false);
const editVersion = ref(0);
const editError = ref<{ title: string; next?: string; code?: string } | null>(null);
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


// 注册时填写的公司是主档案（workspace.onboardingCompanyId）：设定画像时排在第一位并标注。
// Phase 1：解除单公司仅能建一组画像的前端锁，允许按不同市场/产品线为同一公司创建多组画像。
const primaryCompanyId = ref<string | null>(null);
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

const MATCH_FIELDS = ['industry', 'sub_industry', 'product', 'category', 'size', 'employee_count', 'revenue_range'];

function matchingAttributes(icp: Icp): Array<{ key: string; value: string }> {
  return MATCH_FIELDS.flatMap((key) => {
    const value = attrText(icp.companyAttributes?.[key]);
    return value ? [{ key: attributeLabel(key), value }] : [];
  });
}

/**
 * 引擎写进 companyAttributes 的「输入血缘」字段：记录这份画像依据什么生成（用了哪些产品、
 * 市场按什么定），不是目标公司的属性。单独列成「画像依据」，值是内部代码，要换成白话。
 */
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
    {
      key: $t('gainos.findBuyers.lineageProductBasis'),
      value: lineageLabel('lineageBasis', attributes.inputBasis),
    },
    {
      key: $t('gainos.findBuyers.lineageMarketBasis'),
      value: lineageLabel('lineageMarket', attributes.marketBasis),
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

function requestedProfile(): Icp | undefined {
  const id = queryValue(route.query.icp);
  return icps.value.find((item) => item.id === id) ??
    icps.value.find((item) => item.id === selected.value?.id) ??
    icps.value.find((item) => item.status === 'ACTIVE') ??
    icps.value[0];
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    const [icpData, companyData] = await Promise.all([gainosApi.icps(), gainosApi.companies()]);
    icps.value = Array.isArray(icpData) ? icpData : [];
    companies.value = Array.isArray(companyData) ? companyData : ((companyData as { data?: CompanyProfile[] })?.data ?? []);
    const initial = requestedProfile();
    if (initial) void openDetail(initial);
    else selected.value = null;
  } catch (error) {
    loadError.value = failureText(error);
  } finally {
    loading.value = false;
  }
}

function taskRunStatusLabel(status: string): string {
  return glossaryStatus('run', status, preferences.app.locale)?.label ??
    $t(status === 'QUEUED' ? 'gainosBuyerJourney.sourcing.queued' : 'gainosBuyerJourney.sourcing.unknownStatus');
}

async function loadSourcing(icpId: string): Promise<void> {
  const seq = ++sourcingVersion;
  const stillCurrent = () => seq === sourcingVersion && selected.value?.id === icpId;
  plansLoading.value = true;
  runLoading.value = true;
  plansError.value = null;
  runError.value = null;
  await Promise.all([
    gainosApi.queryPlans(icpId).then((data) => {
      if (!Array.isArray(data)) throw new Error('Invalid plan list');
      if (stillCurrent()) plans.value = newestPlans(data);
    }).catch((err: unknown) => {
      if (stillCurrent()) plansError.value = failureText(err);
    }).finally(() => {
      if (stillCurrent()) plansLoading.value = false;
    }),
    (async () => {
      try {
        const tasks = await gainosApi.acquisitionTasks(icpId);
        if (!Array.isArray(tasks)) throw new Error('Invalid task list');
        const scopedTasks = tasks.filter((task) => !task.icpId || task.icpId === icpId);
        const runs = recentTaskRuns(scopedTasks);
        const latest = runs.find(({ run }) => isRunInProgress(run.status)) ?? runs[0];
        let recent: typeof recentRun.value = latest ? { ...latest.run, taskId: latest.task.id } : null;
        if (!recent) {
          const references = await gainosApi.discoveryRunLinks(icpId);
          const ref = Array.isArray(references) ? [...references].filter((row) => row.icpId === icpId)
            .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] : undefined;
          if (ref?.runId) {
            const run = await gainosApi.discoveryRun(ref.runId);
            if (run?.icpId === icpId) {
              recent = { id: run.id, runId: run.id, status: run.status, startedAt: ref.startedAt, finishedAt: run.completedAt ?? null, trigger: 'manual' };
            }
          }
        }
        if (!stillCurrent()) return;
        recentRun.value = recent;
        runHasResults.value = false;
        if (recent?.runId && ['DONE', 'COMPLETED', 'PARTIAL'].includes(recent.status)) {
          const result = await gainosApi.discoveryRunResultView(recent.runId).catch(() => null);
          if (stillCurrent()) {
            runHasResults.value = result?.runId === recent.runId && result.icpId === icpId &&
              Array.isArray(result.candidates?.items) && result.candidates.items.length > 0;
          }
        }
      } catch (err) {
        if (stillCurrent()) runError.value = failureText(err);
      } finally {
        if (stillCurrent()) runLoading.value = false;
      }
    })(),
  ]);
}

async function openDetail(icp: Icp): Promise<void> {
  const seq = ++detailVersion;
  sourcingVersion += 1;
  feedbackVersion += 1;
  detailLoading.value = true;
  detailError.value = null;
  activationError.value = null;
  editOpen.value = false;
  backtest.value = null;
  backtestError.value = null;
  ruleOpen.value = false;
  plans.value = [];
  plansLoading.value = false;
  plansError.value = null;
  recentRun.value = null;
  runLoading.value = false;
  runError.value = null;
  runHasResults.value = false;
  feedback.value = null;
  feedbackSummary.value = null;
  feedbackCounts.value = null;
  feedbackLoaded.value = '';
  feedbackLoading.value = false;
  feedbackError.value = false;
  keepExistingActive.value = true;
  selected.value = icp;
  try {
    const detail = await gainosApi.icp(icp.id);
    if (seq !== detailVersion) return;
    if (!detail || detail.id !== icp.id) throw new Error('Invalid profile');
    selected.value = detail;
    if (detail.status === 'ACTIVE') void loadSourcing(icp.id);
    const oldRun = queryValue(route.query.run);
    if (oldRun && queryValue(route.query.icp) === detail.id) {
      void router.replace(sourcingRunLocation(oldRun, 'progress'));
    }
  } catch (error) {
    if (seq === detailVersion) detailError.value = failureText(error);
  } finally {
    if (seq === detailVersion) detailLoading.value = false;
  }
}

watch(() => route.query.icp, () => {
  if (route.name !== 'FindBuyers' || loading.value) return;
  const profile = requestedProfile();
  if (activeCompanyFilter.value && profile?.companyId !== activeCompanyFilter.value) {
    activeCompanyFilter.value = '';
  }
  if (profile && profile.id !== selected.value?.id) void openDetail(profile);
});

function switchProfile(id: string): void {
  if (id !== selected.value?.id && !editing.value && !activating.value) {
    void router.push({ name: 'FindBuyers', query: { icp: id } });
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
  const request = ++createComtradeRequest;
  createComtradeBundle.value = null;
  createComtradeError.value = false;
  createComtradeLoading.value = Boolean(companyId && createOpen.value);
  if (!createComtradeLoading.value) return;
  const current = () => request === createComtradeRequest && selectedCompanyId.value === companyId && createOpen.value;
  try {
    const raw = await gainosApi.marketRecommendations(companyId, { limit: 6 });
    if (!current()) return;
    const bundle = normalizeComtradeBundle(raw);
    if (bundle.companyId && bundle.companyId !== companyId) {
      createComtradeError.value = true;
      return;
    }
    createComtradeBundle.value = bundle;
  } catch {
    if (current()) createComtradeError.value = true;
  } finally {
    if (current()) createComtradeLoading.value = false;
  }
}

function addCreateMarkets(codes: readonly string[]): void {
  if (!createOpen.value || creating.value || !canManage.value || !createComtradeBundle.value) return;
  const selected = new Set(confirmedCreateMarkets.value);
  const available = new Set(createComtradeBundle.value.recommendations.map(({ code }) => code));
  const additions = [...new Set(codes)]
    .filter((code) => available.has(code) && !selected.has(code))
    .slice(0, Math.max(0, MAX_CREATE_MARKETS - selected.size));
  if (!additions.length) return;
  const current = createTargetMarkets.value;
  const separator = /[,，、\n]\s*$/.test(current) ? ' ' : ', ';
  createTargetMarkets.value = current.trim()
    ? `${current}${separator}${additions.join(', ')}`
    : additions.join(', ');
}

function toggleCreateBuyerRole(role: string): void {
  createBuyerRoles.value = createBuyerRoles.value.includes(role)
    ? createBuyerRoles.value.filter((item) => item !== role)
    : [...createBuyerRoles.value, role];
}

function companyMarketSeed(companyId: string): string {
  const markets = orderedCompanies.value.find((company) => company.id === companyId)?.targetMarkets;
  return Array.isArray(markets) ? markets.filter((market) => typeof market === 'string').join(', ') : '';
}

watch([createOpen, selectedCompanyId], ([open, companyId]) => {
  if (open) {
    const nextSeed = companyMarketSeed(companyId);
    if (createTargetMarkets.value === createMarketSeed) createTargetMarkets.value = nextSeed;
    createMarketSeed = nextSeed;
    void checkApprovedClaims(companyId);
  }
  void loadCreateComtrade(open ? companyId : '');
});

const missingProduct = computed(() =>
  productSelection.value === 'cleared' ||
  (productSelection.value === 'empty' && commas(createProductLines.value).length === 0),
);
const canCreateIcp = computed(() =>
  canManage.value &&
  Boolean(selectedCompanyId.value) &&
  !creating.value &&
  confirmedCreateMarkets.value.length <= MAX_CREATE_MARKETS &&
  !claimsChecking.value &&
  !missingProduct.value &&
  approvedClaimCount.value !== null &&
  approvedClaimCount.value > 0);

function openCreate(presetCompanyId?: string): void {
  const defaultId =
    (typeof presetCompanyId === 'string' && presetCompanyId) ||
    activeCompanyFilter.value ||
    orderedCompanies.value[0]?.id ||
    '';
  selectedCompanyId.value = defaultId;
  createName.value = '';
  createProductLines.value = '';
  createBuyerRoles.value = [];
  createScenario.value = '';
  createMarketSeed = companyMarketSeed(defaultId);
  createTargetMarkets.value = createMarketSeed;
  createError.value = null;
  createOpen.value = true;
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
        await gainosApi.approveClaim(claim.id, claim.version, { silentErrorToast: true });
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
    const markets = confirmedCreateMarkets.value;
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
    icps.value = [icp, ...icps.value.filter((item) => item.id !== icp.id)];
    await router.replace({ name: 'FindBuyers', query: { icp: icp.id } });
    if (selected.value?.id !== icp.id) await openDetail(icp);
  } catch (error) {
    createError.value = failureText(error);
  } finally {
    creating.value = false;
  }
}

async function activate(): Promise<void> {
  const profile = selected.value;
  if (!profile || !canManage.value || !canActivate(profile) || activating.value) return;
  activating.value = true;
  activationError.value = null;
  try {
    const updated = await gainosApi.activateIcp(
      profile.id,
      hasSiblingActive.value && keepExistingActive.value ? { keepExistingActive: true } : undefined,
    );
    icps.value = icps.value.map((item) => item.id === updated.id ? updated : item);
    if (selected.value?.id === updated.id) {
      selected.value = updated;
      if (updated.status === 'ACTIVE') void loadSourcing(updated.id);
    }
    void refreshIcpList();
    uiFeedback.message.success($t('gainos.findBuyers.activated'));
    notifyChainChanged();
  } catch (error) {
    activationError.value = failureText(error);
  } finally {
    activating.value = false;
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
  if (!selected.value || !canEdit.value || !versionOfSelected.value) return;
  const icp = selected.value;
  editVersion.value = versionOfSelected.value;
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
    targetMarkets: Array.isArray(icp.targetMarkets) ? icp.targetMarkets.join(', ') : '',
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
  return text.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean);
}
async function saveEdit(): Promise<void> {
  if (!selected.value || !canManage.value || editing.value) return;
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
    const updated = await gainosApi.updateIcp(selected.value.id, {
      name: editForm.value.name.trim(),
      targetMarkets: commas(editForm.value.targetMarkets),
      painPoints: lines(editForm.value.painPoints),
      triggerSignals: lines(editForm.value.triggerSignals),
      exclusions: lines(editForm.value.exclusions),
      valueProps: lines(editForm.value.valueProps),
      companyAttributes: attributes,
      expectedVersion: editVersion.value,
    });
    editOpen.value = false;
    uiFeedback.message.success($t('gainos.findBuyers.saved'));
    if (selected.value?.id === updated.id) selected.value = updated;
    icps.value = icps.value.map((item) => item.id === updated.id ? updated : item);
    editedProfileId.value = updated.id;
    notifyChainChanged();
  } catch (error) {
    editError.value = failureText(error);
  } finally {
    editing.value = false;
  }
}

function openRule(rule?: IcpRule): void {
  if (!canManage.value) return;
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
  if (!selected.value || !canManage.value) return;
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
  if (!current || !canManage.value) return;
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
  if (!selected.value || !canManage.value) return;
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

const statusOfSelected = computed(() => icpStatus(selected.value?.status));
const selectedActive = computed(() => selected.value?.status === 'ACTIVE');
const versionOfSelected = computed(() => {
  const version = Number(selected.value?.version);
  return Number.isSafeInteger(version) && version > 0 ? version : null;
});
const canEdit = computed(() => canManage.value && Boolean(versionOfSelected.value) &&
  !['SUPERSEDED', 'ARCHIVED'].includes(selected.value?.status ?? ''));
const hasSiblingActive = computed(() =>
  icps.value.some((item) => item.companyId === selected.value?.companyId && item.id !== selected.value?.id && item.status === 'ACTIVE'),
);
const companyProfiles = computed(() => activeCompanyFilter.value
  ? icps.value.filter((profile) => profile.companyId === activeCompanyFilter.value)
  : icps.value);
const companiesWithIcps = computed(() =>
  orderedCompanies.value.filter((company) => (icpCountByCompany.value.get(company.id) ?? 0) > 0),
);

function filterCompany(id: string): void {
  activeCompanyFilter.value = id;
  if (id && selected.value?.companyId !== id && companyProfiles.value[0]) switchProfile(companyProfiles.value[0].id);
}

const matchingProfile = computed(() => selected.value ? extractThreeLayerFromIcp({
  companyAttributes: selected.value.companyAttributes,
  exclusions: Array.isArray(selected.value.exclusions) ? selected.value.exclusions : [],
}) : null);
const targets = computed(() => matchingProfile.value?.buyerSpec);
const exclusions = computed(() => matchingProfile.value?.peerExclusions);
const companyTypes = computed(() => {
  const marketRoles = targets.value?.buyerRoles ?? [];
  const roles = marketRoles.length ? marketRoles : [attrText(selected.value?.companyAttributes?.role)];
  return roles.filter(Boolean).map((role) => {
    const key = `gainos.threeLayer.role.${role}`;
    const label = $t(key);
    return label === key ? role : label;
  });
});

const marketText = computed(() => {
  const values = selected.value?.targetMarkets;
  if (!Array.isArray(values)) return $t('gainosBuyerJourney.profile.marketUnknown');
  if (!values.length) return $t('gainosBuyerJourney.profile.marketAny');
  if (values.some((value) => typeof value !== 'string' || !value.trim())) {
    return $t('gainosBuyerJourney.profile.marketUnknown');
  }
  return [...new Set(values.map((value) => regionName(value.trim())))].join($t('gainosBuyerJourney.profile.listSeparator'));
});

const latestPlan = computed(() => plans.value[0]);
const latestRunTo = computed(() => {
  const run = recentRun.value;
  if (!run) return null;
  if (run.runId) return sourcingRunLocation(run.runId, isRunInProgress(run.status) ? 'progress' : 'results');
  if (run.taskId) return { name: 'TaskDetail', params: { taskId: run.taskId } };
  return null;
});

function profilePlans(plan?: string) {
  const id = selected.value?.id ?? '';
  const destination = sourcingPlansLocation(id, plan);
  return id === editedProfileId.value
    ? { ...destination, query: { ...destination.query, edited: '1' } }
    : destination;
}

const nextSourcing = computed(() => {
  if (!selectedActive.value || detailLoading.value || detailError.value || runLoading.value || runError.value) return null;
  const run = recentRun.value;
  const plan = latestPlan.value;
  if (run && latestRunTo.value && isRunInProgress(run.status)) {
    return { label: $t('gainosBuyerJourney.profile.seeProgress'), to: latestRunTo.value };
  }
  if (run && latestRunTo.value && ['FAILED', 'CANCELLED'].includes(run.status)) {
    return { label: $t('gainosBuyerJourney.profile.seeLast'), to: latestRunTo.value };
  }
  if (plansLoading.value || plansError.value) return null;
  if (plan?.status === 'DRAFT' && canManage.value) {
    return { label: $t('gainosBuyerJourney.profile.planReview'), to: profilePlans(plan.id) };
  }
  if (run && latestRunTo.value) {
    const label = runHasResults.value ? 'seeResult' : 'seeLast';
    return { label: $t(`gainosBuyerJourney.profile.${label}`), to: latestRunTo.value };
  }
  if (!plan && !canManage.value) return null;
  return {
    label: $t(plan ? 'gainosBuyerJourney.profile.latestPlan' : 'gainosBuyerJourney.profile.planCreate'),
    to: profilePlans(plan?.id),
  };
});

const selectedScenario = computed(() => {
  const raw = targets.value?.procurementScenario;
  if (!raw) return '';
  const key = `gainos.threeLayer.scenario.${raw}`;
  const label = $t(key);
  return label === key ? raw : label;
});

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
    const key = title.normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase();
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
  return [...byTitle.values()].filter((row) => row.title.length > 0).map((row) => ({
    ...row,
    goals: [...new Set(row.goals)],
    pains: [...new Set(row.pains)],
    concerns: [...new Set(row.concerns)],
  }));
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

async function loadPrimaryCompany(): Promise<void> {
  const context = await ensureLoaded();
  primaryCompanyId.value = context?.onboarding?.companyId ?? null;
}
onMounted(() => {
  void loadPrimaryCompany();
  void load();
});
</script>

<template>
  <div class="mx-auto grid w-full max-w-[var(--gs-page-max)] grid-cols-1 gap-4 px-[var(--gs-page-pad)] pb-12 @container">
    <GsPage :title="$t('gainos.findBuyers.title')">
      <template #actions>
        <div class="flex flex-wrap items-center gap-2" data-gs="icp-toolbar">
          <Button :loading="loading" data-gs="refresh" @click="load">
            <template v-if="!loading" #icon><RotateCw :size="14" aria-hidden="true" /></template>
            {{ $t('gainos.common.refresh') }}
          </Button>
          <Button v-if="canManage && icps.length" data-gs="new-icp" @click="openCreate()">{{ $t('gainos.findBuyers.newIcp') }}</Button>
        </div>
      </template>
    </GsPage>

    <div v-if="loadError" class="grid gap-3" data-gs="load-error">
      <ErrorNotice v-bind="loadError" />
      <Button class="justify-self-start" @click="load">{{ $t('gainos.common.retry') }}</Button>
    </div>
    <GsCard v-else-if="loading" data-gs="icp-loading" padding="20px 24px">
      <Skeleton active :paragraph="{ rows: 3 }" />
      <span class="fb-sr-only">{{ $t('gainos.common.loading') }}</span>
    </GsCard>
    <GsCard v-else-if="!selected" data-gs="icp-empty" padding="40px 24px">
      <GsEmpty :description="$t('gainos.findBuyers.emptyDescSimple')" :title="$t('gainos.findBuyers.emptyTitle')">
        <template #actions>
          <Button v-if="canManage" type="primary" @click="openCreate()">{{ $t('gainos.findBuyers.emptyCta') }}</Button>
          <Button @click="router.push('/companies')">{{ $t('gainosBuyerJourney.profile.company') }}</Button>
          <Button @click="router.push('/tasks')">{{ $t('gainosBuyerJourney.sourcing.title') }}</Button>
        </template>
      </GsEmpty>
    </GsCard>
    <div v-else class="profile-frame">
      <aside class="profile-rail" data-gs="icp-profile-switcher" :aria-label="$t('gainosBuyerJourney.profile.all')">
        <h2>{{ $t('gainosBuyerJourney.profile.all') }}</h2>
        <GsSelect
          v-if="companiesWithIcps.length > 1"
          :aria-label="$t('gainosBuyerJourney.profile.company')"
          :options="[
            { label: $t('gainos.findBuyers.companyFilterAll', { count: icps.length }), value: '' },
            ...companiesWithIcps.map((company) => ({ label: companyName(company.id), value: company.id })),
          ]"
          :value="activeCompanyFilter"
          class="profile-company-filter"
          data-gs="company-icp-switcher"
          @change="filterCompany(String($event ?? ''))"
        />
        <ul>
          <li v-for="profile in companyProfiles" :key="profile.id">
            <button
              :aria-pressed="profile.id === selected.id"
              class="profile-choice"
              data-gs="icp-card"
              :disabled="editing || activating"
              type="button"
              @click="switchProfile(profile.id)"
            >
              <span class="profile-avatar" aria-hidden="true">{{ Array.from(profile.name.trim())[0] }}</span>
              <span class="profile-choice-main">
                <strong>{{ profile.name }}</strong>
                <small>{{ icpStatus(profile.status).label }}</small>
              </span>
              <ChevronRight :size="15" aria-hidden="true" />
            </button>
          </li>
        </ul>
      </aside>
      <section class="profile-detail" data-gs="icp-workspace">
        <header class="profile-head">
          <div>
            <div class="profile-title">
              <h2>{{ selected.name }}</h2>
              <GsTag :tone="statusOfSelected.tone">{{ statusOfSelected.label }}</GsTag>
            </div>
            <RouterLink
              v-if="selected.companyId"
              class="profile-link"
              :to="{ name: 'Companies', query: { companyId: selected.companyId, tab: 'facts' } }"
              data-gs="icp-workspace-meta"
            >
              <Globe :size="15" aria-hidden="true" />
              {{ companyName(selected.companyId) }} · {{ $t('gainosBuyerJourney.profile.company') }}
            </RouterLink>
          </div>
          <div v-if="!detailLoading && !detailError" class="profile-actions">
            <Button v-if="canEdit" data-gs="icp-edit" @click="openEdit">{{ $t('gainosBuyerJourney.profile.edit') }}</Button>
            <Button
              v-if="canManage && canActivate(selected)"
              data-gs="icp-next-button"
              :loading="activating"
              type="primary"
              @click="activate"
            >{{ $t('gainosBuyerJourney.profile.activate') }}</Button>
            <RouterLink v-if="nextSourcing" class="profile-primary" :to="nextSourcing.to" data-gs="icp-next-button">
              {{ nextSourcing.label }} <ChevronRight :size="16" aria-hidden="true" />
            </RouterLink>
          </div>
        </header>

        <Skeleton v-if="detailLoading" active :paragraph="{ rows: 4 }" />
        <div v-else-if="detailError" class="profile-stack">
          <ErrorNotice v-bind="detailError" />
          <Button class="justify-self-start" @click="openDetail(selected)">{{ $t('gainos.common.retry') }}</Button>
        </div>
        <template v-else>
          <ErrorNotice v-if="activationError" v-bind="activationError" />
          <Checkbox v-if="canManage && canActivate(selected) && hasSiblingActive" v-model:checked="keepExistingActive" data-gs="keep-existing-active">
            {{ $t('gainos.findBuyers.keepExistingActive') }}
          </Checkbox>
          <p v-if="accessLoaded && !canManage && canActivate(selected)" class="fb-muted">{{ $t('gainosBuyerJourney.profile.notPermitted') }}</p>
          <Tabs :active-key="profileTab" @change="selectTab">
            <TabPane key="overview" :tab="$t('gainosBuyerJourney.profile.overview')">
              <section class="profile-stack" data-gs="icp-overview">
                <h3>{{ $t('gainosBuyerJourney.profile.targetBuyer') }}</h3>
                <p v-if="targets?.categoryBroad" class="fb-muted">{{ targets.categoryBroad }}</p>
                <dl class="profile-facts">
                  <div>
                    <dt>{{ $t('gainos.findBuyers.targetMarkets') }}</dt>
                    <dd data-gs="icp-target-markets">{{ marketText }}</dd>
                  </div>
                  <div>
                    <dt>{{ $t('gainosBuyerJourney.profile.companyType') }}</dt>
                    <dd>{{ companyTypes.join($t('gainosBuyerJourney.profile.listSeparator')) || $t('gainosBuyerJourney.profile.notSpecified') }}</dd>
                  </div>
                  <div>
                    <dt>{{ $t('gainosBuyerJourney.profile.exclusions') }}</dt>
                    <dd>{{ exclusions?.combined.join($t('gainosBuyerJourney.profile.listSeparator')) || $t('gainosBuyerJourney.profile.notSpecified') }}</dd>
                  </div>
                </dl>
                <Button type="link" class="profile-match-button" @click="selectTab('matching')">
                  {{ $t('gainosBuyerJourney.profile.seeMatching') }} <ChevronRight :size="15" aria-hidden="true" />
                </Button>
                <div v-if="selectedActive" class="profile-recent">
                  <div class="profile-recent-head">
                    <h3>{{ $t('gainosBuyerJourney.profile.latestRun') }}</h3>
                    <RouterLink v-if="recentRun && latestPlan && !plansError && nextSourcing?.to.name !== 'Tasks'" class="profile-link" :to="profilePlans(latestPlan.id)">
                      {{ $t('gainosBuyerJourney.sourcing.plans') }} <ChevronRight :size="15" aria-hidden="true" />
                    </RouterLink>
                  </div>
                  <p v-if="runLoading && !recentRun" class="fb-muted" role="status">{{ $t('gainosBuyerJourney.profile.loadingRun') }}</p>
                  <div v-else-if="runError" class="profile-stack">
                    <ErrorNotice :title="$t('gainosBuyerJourney.sourcing.historyError')" :next="runError.title" />
                    <Button class="justify-self-start" @click="loadSourcing(selected.id)">{{ $t('gainos.common.retry') }}</Button>
                  </div>
                  <RouterLink v-else-if="recentRun && latestRunTo" class="profile-recent-link" :to="latestRunTo">
                    <span class="profile-avatar"><Search :size="17" aria-hidden="true" /></span>
                    <span class="profile-choice-main">
                      <strong>{{ recentRun.startedAt ? formatDateTime(recentRun.startedAt) : $t('gainosBuyerJourney.profile.latestRun') }}</strong>
                      <small>{{ taskRunStatusLabel(recentRun.status) }}</small>
                    </span>
                    <ChevronRight :size="16" aria-hidden="true" />
                  </RouterLink>
                  <p v-else class="fb-muted">{{ $t('gainos.findBuyers.noRuns') }}</p>
                  <div v-if="plansError" class="profile-stack">
                    <ErrorNotice :title="$t('gainosBuyerJourney.sourcing.planError')" :next="plansError.title" />
                    <Button class="justify-self-start" @click="loadSourcing(selected.id)">{{ $t('gainos.common.retry') }}</Button>
                  </div>
                </div>
              </section>
            </TabPane>
            <TabPane key="matching" :tab="$t('gainosBuyerJourney.profile.matching')">
              <div class="profile-stack" data-gs="icp-matching">
                <dl class="profile-facts">
                  <div><dt>{{ $t('gainos.findBuyers.targetMarkets') }}</dt><dd>{{ marketText }}</dd></div>
                  <div v-if="companyTypes.length">
                    <dt>{{ $t('gainosBuyerJourney.profile.companyType') }}</dt>
                    <dd>{{ companyTypes.join($t('gainosBuyerJourney.profile.listSeparator')) }}</dd>
                  </div>
                  <div v-for="item in matchingAttributes(selected)" :key="item.key"><dt>{{ item.key }}</dt><dd>{{ item.value }}</dd></div>
                  <div v-if="selected.painPoints?.length">
                    <dt>{{ $t('gainos.findBuyers.painPoints') }}</dt><dd>{{ selected.painPoints.join(' · ') }}</dd>
                  </div>
                  <div v-if="selected.triggerSignals?.length">
                    <dt>{{ $t('gainos.findBuyers.triggerSignals') }}</dt><dd>{{ selected.triggerSignals.join(' · ') }}</dd>
                  </div>
                </dl>
                <div v-if="exclusions?.combined.length" class="profile-stack">
                  <h3>{{ $t('gainosBuyerJourney.profile.exclusions') }}</h3>
                  <dl class="profile-facts">
                    <div v-if="exclusions.custom.length">
                      <dt>{{ $t('gainosBuyerJourney.profile.manualExclusions') }}</dt><dd>{{ exclusions.custom.join(' · ') }}</dd>
                    </div>
                    <div v-if="exclusions.autoDerived.length">
                      <dt>{{ $t('gainosBuyerJourney.profile.autoExclusions') }}</dt>
                      <dd>{{ exclusions.autoDerived.join(' · ') }}<p v-if="exclusions.rationale" class="fb-muted">{{ exclusions.rationale }}</p></dd>
                    </div>
                  </dl>
                </div>
                <details v-if="peopleOfSelected.length || selectedScenario || targets?.procurementScenarios.length" class="profile-disclosure">
                  <summary>{{ $t('gainosBuyerJourney.profile.rolesAndScenes') }}</summary>
                  <div class="profile-stack">
                    <p v-if="selectedScenario" class="fb-muted">{{ selectedScenario }}</p>
                    <ul v-if="targets?.procurementScenarios.length" class="fb-list">
                      <li v-for="scene in targets.procurementScenarios" :key="scene">{{ scene }}</li>
                    </ul>
                    <div v-if="peopleOfSelected.length" class="fb-personas">
                      <article v-for="person in peopleOfSelected" :key="person.title" class="fb-persona">
                        <h4>{{ person.title }}</h4>
                        <p v-if="person.goals.length" class="fb-muted">{{ $t('gainos.findBuyers.goals') }} · {{ person.goals.join(' · ') }}</p>
                        <p v-if="person.pains.length" class="fb-muted">{{ $t('gainos.findBuyers.painPoints') }} · {{ person.pains.join(' · ') }}</p>
                        <p v-if="person.concerns.length" class="fb-muted">{{ $t('gainos.findBuyers.concerns') }} · {{ person.concerns.join(' · ') }}</p>
                      </article>
                    </div>
                  </div>
                </details>
                <details class="profile-disclosure">
                  <summary>{{ $t('gainosBuyerJourney.profile.sourceBasis') }}</summary>
                  <dl class="profile-facts">
                    <div v-if="versionOfSelected"><dt>{{ $t('gainosBuyerJourney.profile.sourceVersion') }}</dt><dd>{{ $t('gainos.findBuyers.version', { version: versionOfSelected }) }}</dd></div>
                    <div v-for="item in lineageOf(selected)" :key="item.key"><dt>{{ item.key }}</dt><dd>{{ item.value }}</dd></div>
                  </dl>
                  <RouterLink v-if="selected.companyId" class="profile-link" :to="{ name: 'Companies', query: { companyId: selected.companyId, tab: 'facts' } }">
                    {{ $t('gainosBuyerJourney.profile.company') }} <ChevronRight :size="15" aria-hidden="true" />
                  </RouterLink>
                </details>
                <!-- 高级：资格规则与回测。产品决定暂时隐藏（feature-flags.ts）；恢复时仍是默认收起。 -->
              <section v-if="!ICP_ADVANCED_HIDDEN && canManage" class="fb-section fb-section--flush" data-gs="icp-advanced">
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
              </div>
            </TabPane>
            <TabPane key="feedback" :tab="$t('gainosBuyerJourney.profile.feedback')">
              <section class="profile-stack" data-gs="icp-feedback">
                <Skeleton v-if="feedbackLoading" active :paragraph="{ rows: 2 }" />
                <template v-else>
                  <div v-if="feedbackError" class="profile-stack">
                    <ErrorNotice :title="$t('gainosBuyerJourney.profile.feedbackUnavailable')" />
                    <Button class="justify-self-start" @click="loadFeedback(selected.id)">{{ $t('gainos.common.retry') }}</Button>
                  </div>
                  <div v-if="feedbackCounts" class="profile-feedback-counts">
                    <RouterLink :to="{ name: 'Leads', query: { icp: selected.id, status: 'QUALIFIED' } }" class="profile-link">
                      {{ $t('gainosBuyerJourney.profile.accepted') }} <strong>{{ feedbackCounts.human_accept }}</strong>
                    </RouterLink>
                    <span class="profile-count">
                      {{ $t('gainosBuyerJourney.profile.rejected') }} <strong>{{ feedbackCounts.human_reject }}</strong>
                    </span>
                  </div>
                  <div v-if="feedbackSummary && (feedbackSummary.stats.totalRecorded || feedbackSummary.excludedDomains.length || feedbackSummary.excludedKeywords.length || feedbackSummary.excludedBusinessModels.length || feedbackSummary.counterExamples.length || feedbackSummary.positiveExamples.length)" class="profile-stack" data-gs="icp-learned-feedback">
                    <h3>{{ $t('gainos.findBuyers.learnedFeedbackTitle') }}</h3>
                    <dl class="profile-facts">
                      <div v-if="feedbackSummary.excludedDomains.length">
                        <dt>{{ $t('gainos.findBuyers.learnedExcludedDomains') }}</dt><dd data-gs="icp-learned-domains">{{ feedbackSummary.excludedDomains.join(' · ') }}</dd>
                      </div>
                      <div v-if="feedbackSummary.excludedKeywords.length">
                        <dt>{{ $t('gainos.findBuyers.learnedExcludedKeywords') }}</dt><dd data-gs="icp-learned-keywords">{{ feedbackSummary.excludedKeywords.join(' · ') }}</dd>
                      </div>
                      <div v-if="feedbackSummary.excludedBusinessModels.length">
                        <dt>{{ $t('gainosBuyerJourney.profile.autoExclusions') }}</dt><dd>{{ feedbackSummary.excludedBusinessModels.join(' · ') }}</dd>
                      </div>
                    </dl>
                    <div v-if="feedbackSummary.counterExamples.length">
                      <h3>{{ $t('gainos.findBuyers.learnedCounterExamples') }}</h3>
                      <ul class="fb-list" data-gs="icp-learned-counter-examples">
                        <li v-for="(example, index) in feedbackSummary.counterExamples" :key="index">
                          <strong>{{ example.companyName || example.domain || '—' }}</strong>
                          <span> · {{ learnedReasonLabel(example.reason) }}</span>
                          <span v-if="example.note"> · {{ example.note }}</span>
                          <small v-if="example.recordedAt" class="fb-muted"> · {{ formatDateTime(example.recordedAt) }}</small>
                        </li>
                      </ul>
                    </div>
                    <div v-if="feedbackSummary.positiveExamples.length">
                      <h3>{{ $t('gainosBuyerJourney.profile.positiveExamples') }}</h3>
                      <ul class="fb-list">
                        <li v-for="(example, index) in feedbackSummary.positiveExamples" :key="index">
                          {{ example.companyName || example.domain || '—' }}
                          <small v-if="example.recordedAt" class="fb-muted"> · {{ formatDateTime(example.recordedAt) }}</small>
                        </li>
                      </ul>
                    </div>
                  </div>
                  <div v-if="feedback?.suggestions?.length" class="profile-stack" data-gs="icp-suggestions">
                    <h3>{{ $t('gainos.findBuyers.suggestionsTitle') }}</h3>
                    <p class="fb-muted">{{ $t('gainos.findBuyers.suggestionsDesc') }}</p>
                    <ul class="fb-list">
                      <li v-for="(card, index) in feedback.suggestions" :key="index">{{ card.message }}</li>
                    </ul>
                  </div>
                  <p v-else-if="!feedbackError && !feedbackSummary?.stats.totalRecorded && !feedbackCounts?.human_accept && !feedbackCounts?.human_reject" class="fb-muted">{{ $t('gainosBuyerJourney.profile.feedbackEmpty') }}</p>
                  <RouterLink :to="{ name: 'Leads', query: { icp: selected.id } }" class="profile-link">
                    {{ $t('gainosBuyerJourney.profile.needsReview') }} <ChevronRight :size="15" aria-hidden="true" />
                  </RouterLink>
                </template>
              </section>
            </TabPane>
          </Tabs>
        </template>
      </section>
    </div>

    <!-- 设定买家画像（从公司档案生成初稿） -->
    <Modal
      v-model:open="createOpen"
      :confirm-loading="creating"
      :ok-button-props="{ disabled: !canCreateIcp }"
      :ok-text="$t('gainos.findBuyers.generate')"
      :title="$t('gainos.findBuyers.createTitle')"
      :width="680"
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
        </label>
        <p v-if="confirmedCreateMarkets.length >= MAX_CREATE_MARKETS" class="fb-muted" role="status">
          {{ $t('gainosOb.setup.marketLimit', { limit: MAX_CREATE_MARKETS }) }}
        </p>
        <p v-if="createComtradeLoading" class="fb-muted" role="status">{{ $t('gainos.common.loading') }}</p>
        <div v-else-if="createComtradeError" class="fb-comtrade-chips">
          <span class="fb-muted" role="alert">{{ $t('gainosBuyerJourney.profile.marketRecommendationsError') }}</span>
          <Button size="small" @click="loadCreateComtrade(selectedCompanyId)">{{ $t('gainos.common.retry') }}</Button>
        </div>
        <ComtradeMarketRecommendations
          v-else-if="createComtradeBundle?.recommendations.length"
          anchor-prefix="profile-comtrade"
          :bundle="createComtradeBundle"
          :disabled="creating || !canManage"
          :limit-reached="confirmedCreateMarkets.length >= MAX_CREATE_MARKETS"
          :selected-markets="confirmedCreateMarkets"
          @add="addCreateMarkets([$event])"
          @add-all="addCreateMarkets"
        />
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
        <ErrorNotice v-if="editError" :code="editError.code" :next="editError.next" :title="editError.title" />
        <Button v-if="editError?.code === 'VERSION_CONFLICT'" class="justify-self-start" @click="selected && openDetail(selected)">
          {{ $t('gainosBuyerJourney.profile.refreshProfile') }}
        </Button>
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

.profile-frame {
  display: grid;
  grid-template-columns: minmax(180px, 22%) minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--gs-border);
  border-radius: 14px;
  background: var(--gs-surface);
}
.profile-rail {
  min-width: 0;
  padding: 15px 10px;
  border-inline-end: 1px solid var(--gs-border);
  background: var(--gs-surface-3);
}
.profile-rail h2, .profile-detail h3 {
  margin: 0;
  font-weight: 600;
}
.profile-rail h2 { margin: 0 8px 12px; color: var(--gs-fg-muted); font-size: 13px; }
.profile-rail ul { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.profile-company-filter { width: 100%; margin-bottom: 6px; }
.profile-choice, .profile-recent-link {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  width: 100%;
  min-height: 52px;
  gap: 8px;
  padding: 8px;
  border-radius: 8px;
  text-align: start;
}
.profile-choice { color: var(--gs-fg); }
.profile-choice:hover { background: var(--gs-surface-2); }
.profile-choice[aria-pressed="true"] { background: var(--gs-accent-soft); color: var(--gs-accent-fg); }
.profile-choice:focus-visible { outline: 2px solid var(--gs-accent); outline-offset: -2px; }
.profile-avatar {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border-radius: 7px;
  background: var(--gs-surface-2);
  color: var(--gs-fg-muted);
  font-size: 14px;
  font-weight: 600;
}
.profile-choice-main { display: grid; gap: 3px; overflow-wrap: anywhere; }
.profile-choice-main strong { font-size: 13px; font-weight: 600; }
.profile-choice-main small { color: var(--gs-fg-muted); font-size: 11px; }
.profile-detail { min-width: 0; padding: clamp(15px, 2vw, 28px); overflow-wrap: anywhere; }
.profile-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 14px 18px; margin-bottom: 14px; }
.profile-title, .profile-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.profile-title h2 { margin: 0; color: var(--gs-fg); font-size: clamp(19px, 2vw, 24px); font-weight: 600; }
.profile-detail h3 { font-size: 16px; }
.profile-primary, .profile-link { display: inline-flex; align-items: center; gap: 6px; }
.profile-primary { min-height: 34px; padding: 6px 12px; border-radius: 999px; background: var(--gs-accent-cta); color: var(--gs-accent-cta-fg); font-weight: 600; }
.profile-primary:hover { background: var(--gs-accent-cta-hover); color: var(--gs-accent-cta-fg); }
.profile-link { min-height: 36px; color: var(--gs-accent-fg); font-weight: 600; }
.profile-link svg, .profile-primary svg { flex: none; }
.profile-stack, .profile-recent { display: grid; gap: 10px; min-width: 0; }
.profile-facts { display: grid; margin: 0; }
.profile-facts > div { display: grid; grid-template-columns: minmax(95px, 20%) minmax(0, 1fr); gap: 8px; padding: 10px 0; border-bottom: 1px solid var(--gs-divider); }
.profile-facts dt { color: var(--gs-fg-muted); }
.profile-facts dd { margin: 0; }
.profile-match-button { display: inline-flex; align-items: center; justify-self: start; gap: 7px; padding-inline: 0; }
.profile-recent { margin-top: 8px; padding-top: 14px; border-top: 1px solid var(--gs-divider); }
.profile-recent-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; }
.profile-recent-link { margin-inline: -8px; width: auto; color: var(--gs-fg); }
.profile-recent-link:hover { background: var(--gs-surface-2); color: var(--gs-accent-fg); }
.profile-disclosure { padding: 8px 10px; border: 1px solid var(--gs-border); border-radius: 8px; }
.profile-disclosure summary { min-height: 30px; color: var(--gs-accent-fg); cursor: pointer; font-weight: 500; }
.profile-feedback-counts { display: flex; flex-wrap: wrap; gap: 8px 24px; }
.profile-count { display: inline-flex; min-height: 36px; align-items: center; gap: 6px; color: var(--gs-fg-muted); }
.fb-list { display: grid; gap: 4px; margin: 0; padding-inline-start: 18px; color: var(--gs-fg); font-size: 13px; line-height: 1.7; }
.fb-personas { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(200px, 100%), 1fr)); gap: 10px; }
.fb-persona { display: grid; gap: 4px; padding: 10px 12px; border-radius: 8px; background: var(--gs-surface-2); }
.fb-persona h4 { margin: 0; font-size: 13px; font-weight: 600; }
.fb-stack { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }

@container (max-width: 680px) {
  .profile-frame { grid-template-columns: minmax(0, 1fr); }
  .profile-rail { border-inline-end: 0; border-bottom: 1px solid var(--gs-border); }
  .profile-rail ul { display: flex; overflow-x: auto; }
  .profile-rail li { flex: 0 0 auto; max-width: 220px; }
  .profile-primary, .profile-link { min-height: 40px; }
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
  .fb-form-grid {
    grid-template-columns: minmax(0, 1fr);
  }

}
</style>
