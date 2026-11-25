<script lang="ts" setup>
/**
 * 找买家（目标客户画像 + 寻源方案）。
 *
 * 2026-11-25 按买家线索页的风格与理念重排：
 * - 列表 = 对齐分列的画像卡，「寻源方案 / 最近寻源」直接摆在卡片上（进入页面时并行预取）；
 * - 详情 = 右侧抽屉，内容按卡片分区（画像概览 / 反馈建议 / 寻源方案 / 最近运行 / 高级），
 *   取代原来一个 920px 的手写大弹层；
 * - 控件全部走 antd + Gs 封装；结果提示走统一反馈层。
 *
 * 业务逻辑（规则、回测、方案、发起寻源、本机运行记录）保持不变。
 */
import type { StatusTone } from '@gain-saas/shared';

import type {
  AcquisitionTaskView,
  Backtest,
  CompanyProfile,
  Icp,
  IcpFeedbackReport,
  IcpRule,
  IcpRuleInput,
  QueryPlan,
  TaskRunView,
} from '#/api/gainos';
import type { FbTone, IcpCardRow, SummaryState } from './icp-card-types';

import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { formatDateTime, glossaryStatus, glossaryTerm } from '@gain-saas/shared';
import { RotateCw } from '@vben/icons';
import { preferences } from '@vben/preferences';

import {
  Alert,
  Button,
  Collapse,
  CollapsePanel,
  Descriptions,
  DescriptionsItem,
  Drawer,
  Input,
  InputNumber,
  Modal,
  Skeleton,
  Space,
  Tag,
} from 'ant-design-vue';

import ErrorNotice from '#/components/error-notice.vue';
import GsCard from '#/components/gainos/ui/gs-card.vue';
import GsEmpty from '#/components/gainos/ui/gs-empty.vue';
import GsPage from '#/components/gainos/ui/gs-page.vue';
import GsSelect from '#/components/gainos/ui/gs-select.vue';
import GsSteps from '#/components/gainos/ui/gs-steps.vue';
import GsTag from '#/components/gainos/ui/gs-tag.vue';
import GsToolbar from '#/components/gainos/ui/gs-toolbar.vue';
import { feedback as uiFeedback } from '#/feedback';
import { $t } from '#/locales';

import { failureText, gainosApi } from '#/api/gainos';

import IcpCard from './icp-card.vue';

defineOptions({ name: 'FindBuyers' });

const router = useRouter();

const RULE_KINDS = ['MUST_HAVE', 'NICE_TO_HAVE', 'EXCLUSION'] as const;
const RULE_OPERATORS = ['eq', 'neq', 'in', 'not_in', 'contains', 'not_contains', 'gte', 'lte', 'matches'] as const;

const icps = ref<Icp[]>([]);
const companies = ref<CompanyProfile[]>([]);
const loading = ref(true);
const loadError = ref<{ title: string; next?: string } | null>(null);

const createOpen = ref(false);
const selectedCompanyId = ref('');
const createTargetMarkets = ref('');
const creating = ref(false);
const createError = ref<ReturnType<typeof failureText> | null>(null);
const approvedClaimCount = ref<number | null>(null);
const claimsChecking = ref(false);
const claimsCheckError = ref<string | null>(null);
const quickApprovingFacts = ref(false);
let claimsCheckToken = 0;

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
// M2：反馈建议卡（只建议，采纳=手动改 ICP）。
const feedback = ref<IcpFeedbackReport | null>(null);

async function loadFeedback(icpId: string): Promise<void> {
  try {
    feedback.value = await gainosApi.icpFeedback(icpId);
  } catch {
    feedback.value = null;
  }
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
  attributesText: '{}',
});

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

const currentStep = computed(() => (icps.value.some((icp) => icp.status === 'ACTIVE') ? 3 : 2));
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
// 目标客户画像与挖掘任务的状态文案/色板一律取自 @gain-saas/shared 的 glossary（P6 §4）；
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
function planSourceSummary(plan: QueryPlan): string {
  const counts = new Map<string, number>();
  for (const query of plan.queries) {
    const label = querySourceLabel(query);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => `${label} ${count}`).join(' · ');
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
    .map(([key, value]) => ({ key: attributeLabel(key), value: attrText(value) }))
    .filter((item) => item.value.length > 0);
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
    taskRuns.value = taskCache?.runs ?? [];
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

async function openDetail(icp: Icp): Promise<void> {
  selected.value = icp;
  detailError.value = null;
  detailLoading.value = true;
  backtest.value = null;
  backtestError.value = null;
  ruleOpen.value = false;
  taskCache = null;
  taskRuns.value = [];
  feedback.value = null;
  profileEdited.value = false;
  try {
    selected.value = await gainosApi.icp(icp.id);
    await Promise.all([loadPlans(icp.id), loadRunLinks(icp.id), loadTaskRuns(icp.id), loadFeedback(icp.id)]);
  } catch (error) {
    detailError.value = failureText(error);
  } finally {
    detailLoading.value = false;
  }
}
function closeDetail(): void {
  selected.value = null;
  plans.value = [];
  taskRuns.value = [];
  taskCache = null;
  feedback.value = null;
  profileEdited.value = false;
  backtest.value = null;
  ruleOpen.value = false;
}

async function checkApprovedClaims(companyId: string): Promise<void> {
  const token = ++claimsCheckToken;
  approvedClaimCount.value = null;
  claimsCheckError.value = null;
  if (!companyId) {
    claimsChecking.value = false;
    return;
  }
  claimsChecking.value = true;
  try {
    const data = await gainosApi.claims(companyId, 'APPROVED');
    const rows = Array.isArray(data) ? data : ((data as unknown as { data?: unknown[] })?.data ?? []);
    if (token === claimsCheckToken) approvedClaimCount.value = rows.length;
  } catch (error) {
    if (token === claimsCheckToken) claimsCheckError.value = failureText(error).title;
  } finally {
    if (token === claimsCheckToken) claimsChecking.value = false;
  }
}
watch(selectedCompanyId, (companyId) => {
  void checkApprovedClaims(companyId);
});

const canCreateIcp = computed(() =>
  Boolean(selectedCompanyId.value) &&
  !creating.value &&
  !claimsChecking.value &&
  approvedClaimCount.value !== null &&
  approvedClaimCount.value > 0);

function openCreate(): void {
  selectedCompanyId.value = orderedCompanies.value[0]?.id ?? '';
  const selectedCompany = orderedCompanies.value.find((c) => c.id === selectedCompanyId.value);
  createTargetMarkets.value = (selectedCompany?.targetMarkets ?? []).join(', ');
  createError.value = null;
  createOpen.value = true;
  void checkApprovedClaims(selectedCompanyId.value);
}

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
    const icp = await gainosApi.createIcp(selectedCompanyId.value, {
      attemptId: mintAttemptId(),
      ...(markets.length > 0 ? { confirmedTargetMarkets: markets } : {}),
    });
    createOpen.value = false;
    uiFeedback.message.success($t('gainos.findBuyers.created'));
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
    selected.value = await gainosApi.activateIcp(selected.value.id);
    uiFeedback.message.success($t('gainos.findBuyers.activated'));
    await load();
    await loadPlans(selected.value.id);
  } catch (error) {
    detailError.value = failureText(error);
  } finally {
    planBusy.value = null;
  }
}

function openEdit(): void {
  if (!selected.value) return;
  const icp = selected.value;
  editForm.value = {
    name: icp.name,
    targetMarkets: (icp.targetMarkets ?? []).join(', '),
    painPoints: (icp.painPoints ?? []).join('\n'),
    triggerSignals: (icp.triggerSignals ?? []).join('\n'),
    exclusions: (icp.exclusions ?? []).join('\n'),
    valueProps: (icp.valueProps ?? []).join('\n'),
    attributesText: JSON.stringify(icp.companyAttributes ?? {}, null, 2),
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
  let attributes: Record<string, unknown>;
  try {
    const parsed = JSON.parse(editForm.value.attributesText || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    attributes = parsed as Record<string, unknown>;
  } catch {
    editError.value = { title: $t('gainos.findBuyers.attributesInvalid'), next: $t('gainos.findBuyers.attributesHint') };
    return;
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
    summary.runs = tasks[0]?.runs ?? [];
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

// ── 详情抽屉 ────────────────────────────────────────────────────────────
/** antd Drawer 的 v-model:open：关窗统一走 closeDetail（清空方案/运行/反馈等临时状态）。 */
const detailOpen = computed({
  get: () => selected.value !== null,
  set: (open: boolean) => {
    if (!open) closeDetail();
  },
});

const statusOfSelected = computed(() => icpStatus(selected.value?.status));
const versionOfSelected = computed(() => selected.value?.version ?? 1);

const overviewSections = computed(() => [
  { items: selected.value?.painPoints ?? [], key: 'painPoints', title: $t('gainos.findBuyers.painPoints') },
  { items: selected.value?.triggerSignals ?? [], key: 'triggerSignals', title: $t('gainos.findBuyers.triggerSignals') },
  { items: selected.value?.exclusions ?? [], key: 'exclusions', title: $t('gainos.findBuyers.exclusions') },
  { items: selected.value?.valueProps ?? [], key: 'valueProps', title: $t('gainos.findBuyers.valueProps') },
]);

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
const planMetaOf = (plan: QueryPlan): string[] => {
  const parts = [$t('gainos.findBuyers.planSearchCount', { count: plan.queries?.length ?? 0 })];
  if (plan.estimatedVolume) parts.push($t('gainos.findBuyers.planEstimated', { count: plan.estimatedVolume }));
  const cost = planCostLabel(plan.estimatedCostCents);
  if (cost) parts.push($t('gainos.findBuyers.planEstimatedCost', { cost }));
  return parts;
};

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
onMounted(() => {
  loadRunRefs();
  void loadPrimaryCompany();
  void load();
});
</script>

<template>
  <div class="mx-auto grid w-full max-w-[var(--gs-page-max)] grid-cols-1 gap-3 px-[var(--gs-page-pad)] pb-12 @container">
    <GsPage art="find-buyers" :subtitle="$t('gainos.findBuyers.subtitle')" :title="$t('gainos.findBuyers.title')" />

    <!-- 主链路步骤：白色薄面板压在页头渐变上（上移量写在普通 div 上，见设计系统 §1） -->
    <div class="relative z-[1] -mt-12">
      <GsCard data-gs="stage-steps" dense>
        <GsSteps :current="currentStep" />
      </GsCard>
    </div>

    <GsToolbar data-gs="icp-toolbar">
      <div class="fb-toolbar__main">
        <h2 class="fb-h2">{{ $t('gainos.findBuyers.listTitle') }}</h2>
        <p class="fb-muted fb-toolbar__hint">
          {{
            activeIcp
              ? $t('gainos.findBuyers.activeHint', { name: activeIcp.name })
              : $t('gainos.findBuyers.listDesc')
          }}
        </p>
      </div>
      <div class="ml-auto flex flex-wrap items-center gap-2 @max-[640px]:ml-0 @max-[640px]:w-full">
        <Button class="@max-[640px]:flex-1 @max-[640px]:basis-[calc(50%-4px)]" :loading="loading" data-gs="refresh" @click="load">
          <template v-if="!loading" #icon>
            <RotateCw :size="14" />
          </template>
          {{ loading ? $t('gainos.common.refreshing') : $t('gainos.common.refresh') }}
        </Button>
        <Button v-if="icps.length > 0" class="@max-[640px]:flex-1 @max-[640px]:basis-[calc(50%-4px)]" data-gs="new-icp" type="primary" @click="openCreate">
          {{ $t('gainos.findBuyers.newIcp') }}
        </Button>
      </div>
    </GsToolbar>

    <div v-if="loadError" class="grid gap-3" data-gs="load-error">
      <ErrorNotice :next="loadError.next" :title="loadError.title" />
      <Button class="justify-self-start" @click="load">{{ $t('gainos.common.retry') }}</Button>
    </div>

    <GsCard v-else-if="loading" data-gs="icp-loading" padding="20px 24px">
      <Skeleton active :paragraph="{ rows: 3 }" />
      <span class="fb-sr-only">{{ $t('gainos.common.loading') }}</span>
    </GsCard>

    <GsCard v-else-if="rows.length === 0" data-gs="icp-empty" padding="40px 24px">
      <GsEmpty :description="$t('gainos.findBuyers.emptyDesc')" :title="$t('gainos.findBuyers.emptyTitle')">
        <template #actions>
          <Button type="primary" @click="openCreate">{{ $t('gainos.findBuyers.emptyCta') }}</Button>
          <Button @click="router.push('/companies')">{{ $t('gainos.companies.title') }}</Button>
          <Button @click="router.push('/tasks')">{{ $t('gainos.tasks.title') }}</Button>
        </template>
      </GsEmpty>
    </GsCard>

    <template v-else>
      <IcpCard v-for="row in rows" :key="row.id" :row="row" @open="openDetail(row.icp)" />
    </template>

    <!-- 详情：右侧抽屉，内容按卡片分区 -->
    <Drawer
      v-model:open="detailOpen"
      :body-style="{ padding: '16px 24px 28px' }"
      class="fb-drawer"
      data-gs="icp-detail"
      width="min(920px, 100vw)"
    >
      <template #title>
        <div class="fb-drawer__title">
          <p class="fb-kicker">{{ $t('gainos.findBuyers.detailKicker') }}</p>
          <h2 class="fb-drawer__name">{{ selected?.name }}</h2>
          <div class="fb-drawer__meta">
            <GsTag :tone="statusOfSelected.tone">{{ statusOfSelected.label }}</GsTag>
            <span class="fb-muted">
              {{ companyName(selected?.companyId) }} ·
              {{ $t('gainos.findBuyers.version', { version: versionOfSelected }) }}
            </span>
          </div>
        </div>
      </template>
      <template #extra>
        <Space :size="8" wrap>
          <Button
            v-if="selected && canActivate(selected)"
            :loading="planBusy === 'activate'"
            type="primary"
            @click="activate"
          >
            {{ $t('gainos.findBuyers.activate') }}
          </Button>
          <Button v-if="selected" @click="openEdit">{{ $t('gainos.findBuyers.edit') }}</Button>
        </Space>
      </template>

      <p class="fb-muted fb-drawer__hint">{{ $t('gainos.findBuyers.detailHint') }}</p>

      <Skeleton v-if="detailLoading" active :paragraph="{ rows: 8 }" />
      <ErrorNotice v-else-if="detailError" :next="detailError.next" :title="detailError.title" />
      <div v-else-if="selected" class="fb-drawer__body">
        <!-- 画像概览 -->
        <GsCard :title="$t('gainos.findBuyers.overviewTitle')" data-gs="icp-overview">
          <div class="fb-sections">
          <div class="fb-block">
            <p class="fb-label">{{ $t('gainos.findBuyers.targetMarkets') }}</p>
            <div v-if="(selected.targetMarkets ?? []).length > 0" class="fb-chips">
              <Tag v-for="market in selected.targetMarkets" :key="market" :bordered="false" class="fb-chip">
                {{ market }}
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

          <div class="fb-grid-2">
            <div v-for="section in overviewSections" :key="section.key" class="fb-block">
              <p class="fb-label">{{ section.title }}</p>
              <ul v-if="section.items.length > 0" class="fb-list">
                <li v-for="(item, i) in section.items" :key="i">{{ item }}</li>
              </ul>
              <p v-else class="fb-muted">—</p>
            </div>
          </div>

          <div v-if="(selected.personas ?? []).length > 0" class="fb-block">
            <p class="fb-label">{{ $t('gainos.findBuyers.personas') }}</p>
            <div class="fb-personas">
              <div v-for="persona in selected.personas" :key="persona.title" class="fb-persona">
                <p class="fb-persona__title">{{ persona.title }}</p>
                <p v-if="persona.goals?.length" class="fb-muted">
                  <em class="fb-key">{{ $t('gainos.findBuyers.goals') }}</em>{{ persona.goals.join(' · ') }}
                </p>
                <p v-if="persona.painPoints?.length" class="fb-muted">
                  <em class="fb-key">{{ $t('gainos.findBuyers.painPoints') }}</em>
                  {{ persona.painPoints.join(' · ') }}
                </p>
              </div>
            </div>
          </div>

          <div v-if="(selected.buyingCommittee ?? []).length > 0" class="fb-block">
            <p class="fb-label">{{ $t('gainos.findBuyers.buyingCommittee') }}</p>
            <ul class="fb-list">
              <li v-for="(role, i) in selected.buyingCommittee" :key="i">
                <strong>{{ role.title || role.role }}</strong>
                <span v-if="role.concerns?.length"> · {{ role.concerns.join(' · ') }}</span>
              </li>
            </ul>
          </div>
          </div>
        </GsCard>

        <!-- 反馈建议（只建议，采纳=手动编辑画像） -->
        <GsCard
          v-if="feedback && feedback.suggestions.length > 0"
          :title="$t('gainos.findBuyers.suggestionsTitle')"
          data-gs="icp-suggestions"
        >
          <p class="fb-muted">{{ $t('gainos.findBuyers.suggestionsDesc') }}</p>
          <ul class="fb-list">
            <li v-for="(card, index) in feedback.suggestions" :key="index">{{ card.message }}</li>
          </ul>
        </GsCard>

        <!-- 寻源方案 -->
        <GsCard data-gs="icp-plans">
          <template #title>{{ $t('gainos.findBuyers.plansTitle') }}</template>
          <template #extra>
            <!-- 画像生效中随时可以再生成：迭代画像后靠它出新方案，已有方案不会自动跟着变。 -->
            <Button
              v-if="!plansLoading"
              :disabled="selected.status !== 'ACTIVE' || planBusy === 'create'"
              :loading="planBusy === 'create'"
              :title="selected.status !== 'ACTIVE' ? $t('gainos.findBuyers.planNeedsActive') : undefined"
              type="primary"
              @click="createPlan"
            >
              {{
                plans.length > 0
                  ? $t('gainos.findBuyers.regeneratePlan')
                  : $t('gainos.findBuyers.createPlan')
              }}
            </Button>
          </template>
          <p class="fb-muted">{{ $t('gainos.findBuyers.plansDesc') }}</p>
          <Alert
            v-if="profileEdited"
            :message="$t('gainos.findBuyers.planStaleAfterEdit', { version: versionOfSelected })"
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
                <span class="fb-muted">{{ planMetaOf(plan).join(' · ') }}</span>
              </div>
              <p class="fb-muted">
                {{ $t('gainos.findBuyers.planSources') }}：{{ planSourceSummary(plan) }}
              </p>

              <Collapse expand-icon-position="end" ghost>
                <CollapsePanel
                  key="conditions"
                  :header="$t('gainos.findBuyers.planConditions', { count: plan.queries.length })"
                >
                  <ul class="fb-stack">
                    <li v-for="(query, i) in plan.queries" :key="i" class="fb-query">
                      <div class="fb-query__head">
                        <strong>{{ querySourceLabel(query) }}</strong>
                        <span v-if="query.priority" class="fb-muted">
                          {{ $t('gainos.findBuyers.planPriority', { priority: query.priority }) }}
                        </span>
                      </div>
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
                          class="fb-chip"
                        >
                          {{ keyword }}
                        </Tag>
                      </div>
                      <p v-if="query.rationale" class="fb-muted">{{ textOf(query.rationale) }}</p>
                    </li>
                  </ul>
                  <details class="fb-raw">
                    <summary>{{ $t('gainos.findBuyers.planRaw') }}</summary>
                    <pre>{{ JSON.stringify(plan.queries, null, 2) }}</pre>
                  </details>
                </CollapsePanel>
              </Collapse>

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
                  type="primary"
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
              <p v-if="runRefs[plan.id]" class="fb-muted">{{ $t('gainos.findBuyers.runStarted') }}</p>
              <p v-else-if="plan.status === 'EXECUTED'" class="fb-muted">
                {{ $t('gainos.findBuyers.runLinkMissing') }}
              </p>
            </li>
          </ul>
          <p v-else class="fb-muted">{{ $t('gainos.findBuyers.noPlans') }}</p>
        </GsCard>

        <!-- 最近运行 -->
        <GsCard :title="$t('gainos.findBuyers.latestRun')" data-gs="icp-runs">
          <p class="fb-muted">{{ $t('gainos.findBuyers.taskRunsDesc') }}</p>
          <ul v-if="taskRuns.length > 0" class="fb-stack">
            <li v-for="run in taskRuns" :key="run.id" class="fb-run">
              <div class="fb-run__head">
                <GsTag :tone="taskRunStatusTone(run.status)">{{ taskRunStatusLabel(run.status) }}</GsTag>
                <span class="fb-muted">{{ formatRunTime(run.startedAt) }}</span>
              </div>
              <Button v-if="run.runId" class="fb-run__action" size="small" @click="openRun(run.runId)">
                {{ $t('gainos.findBuyers.viewRun') }}
              </Button>
            </li>
          </ul>
          <p v-else class="fb-muted">{{ $t('gainos.findBuyers.taskRunsEmpty') }}</p>
        </GsCard>

        <!-- 高级：资格规则与回测（默认收起） -->
        <GsCard data-gs="icp-advanced" padding="4px 20px">
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
        </GsCard>
      </div>
    </Drawer>

    <!-- 设定目标客户画像（从公司档案生成初稿） -->
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
        <p class="fb-muted">{{ $t('gainos.findBuyers.createDesc') }}</p>
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
          <span>{{ $t('gainos.findBuyers.createTargetMarkets') }}</span>
          <Input
            v-model:value="createTargetMarkets"
            :placeholder="$t('gainos.findBuyers.createTargetMarketsHint')"
            data-gs="icp-create-markets"
          />
        </label>
        <p v-if="companies.length === 0" class="fb-muted">{{ $t('gainos.findBuyers.noCompanies') }}</p>
        <p v-else-if="claimsChecking" class="fb-muted">{{ $t('gainos.findBuyers.checkingFacts') }}</p>
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
          <template v-if="isAdmin" #action>
            <Button
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

    <!-- 编辑画像 -->
    <Modal
      v-model:open="editOpen"
      :confirm-loading="editing"
      :ok-text="$t('gainos.findBuyers.saveChanges')"
      :title="$t('gainos.findBuyers.editTitle')"
      :width="640"
      data-gs="icp-edit-modal"
      @ok="saveEdit"
    >
      <div class="fb-dialog">
        <ErrorNotice v-if="editError" :next="editError.next" :title="editError.title" />
        <label class="fb-field">
          <span>{{ $t('gainos.findBuyers.name') }}</span>
          <Input v-model:value="editForm.name" />
        </label>
        <label class="fb-field">
          <span>{{ $t('gainos.findBuyers.targetMarkets') }}</span>
          <Input v-model:value="editForm.targetMarkets" :placeholder="$t('gainos.findBuyers.marketsHint')" />
        </label>
        <label class="fb-field">
          <span>{{ $t('gainos.findBuyers.painPoints') }}</span>
          <Input.TextArea v-model:value="editForm.painPoints" :rows="3" />
        </label>
        <label class="fb-field">
          <span>{{ $t('gainos.findBuyers.triggerSignals') }}</span>
          <Input.TextArea v-model:value="editForm.triggerSignals" :rows="3" />
        </label>
        <label class="fb-field">
          <span>{{ $t('gainos.findBuyers.exclusions') }}</span>
          <Input.TextArea v-model:value="editForm.exclusions" :rows="3" />
        </label>
        <label class="fb-field">
          <span>{{ $t('gainos.findBuyers.valueProps') }}</span>
          <Input.TextArea v-model:value="editForm.valueProps" :rows="3" />
        </label>
        <label class="fb-field">
          <span>{{ $t('gainos.findBuyers.companyAttributes') }}</span>
          <Input.TextArea v-model:value="editForm.attributesText" :rows="6" class="fb-mono" />
        </label>
        <p class="fb-muted">{{ $t('gainos.findBuyers.attributesHint') }}</p>
        <pre class="fb-code">{{ '{"industry": "metal fabrication", "country": "DE"}' }}</pre>
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

/* ── 详情抽屉 ─────────────────────────────────────────────────────────── */
.fb-drawer :deep(.ant-drawer-header) {
  padding: 18px 24px 14px;
}
.fb-drawer__title {
  display: grid;
  min-width: 0;
  gap: 2px;
}
.fb-kicker {
  margin: 0;
  color: var(--gs-accent-fg);
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
}
.fb-drawer__name {
  margin: 0;
  color: var(--gs-fg);
  font-size: 20px;
  line-height: 28px;
  font-weight: 600;
}
.fb-drawer__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 2px;
}
.fb-drawer__hint {
  margin-bottom: 16px;
}
.fb-drawer__body {
  display: grid;
  gap: 16px;
}

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
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--gs-divider);
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

/* ── 方案 / 运行 / 搜索条件 ────────────────────────────────────────────── */
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
.fb-plan__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.fb-run__action {
  justify-self: start;
}
.fb-query__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}
.fb-query__head strong {
  color: var(--gs-fg);
  font-size: 13px;
  font-weight: 600;
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
/* 方案盒内的折叠头与内容贴齐盒子内边距（antd 默认 16px 横向内边距） */
.fb-plan :deep(.ant-collapse-header) {
  padding-inline: 0;
  color: var(--gs-fg-muted);
  font-size: 12.5px;
}
.fb-plan :deep(.ant-collapse-content-box) {
  padding-inline: 0;
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
.fb-code {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--gs-surface-2);
  font-family: var(--gs-font-mono);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
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

@media (max-width: 719px) {
  .fb-grid-2,
  .fb-form-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
