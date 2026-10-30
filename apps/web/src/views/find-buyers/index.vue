<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { $t } from '#/locales';

import {
  failureText,
  gainosApi,
  type Backtest,
  type CompanyProfile,
  type Icp,
  type IcpRule,
  type IcpRuleInput,
  type QueryPlan,
} from '#/api/gainos';

defineOptions({ name: 'FindBuyers' });

const router = useRouter();

const STEP_KEYS = [
  'gainos.workspace.stepProfile',
  'gainos.workspace.stepIcp',
  'gainos.workspace.stepPlan',
  'gainos.workspace.stepRun',
  'gainos.workspace.stepJudge',
  'gainos.workspace.stepReport',
] as const;
const stepLabels = computed(() => STEP_KEYS.map((key) => $t(key)));

const RULE_KINDS = ['MUST_HAVE', 'NICE_TO_HAVE', 'EXCLUSION'] as const;
const RULE_OPERATORS = ['eq', 'neq', 'in', 'not_in', 'contains', 'not_contains', 'gte', 'lte', 'matches'] as const;

const icps = ref<Icp[]>([]);
const companies = ref<CompanyProfile[]>([]);
const loading = ref(true);
const loadError = ref<{ title: string; next?: string } | null>(null);
const notice = ref<string | null>(null);

const createOpen = ref(false);
const selectedCompanyId = ref('');
const creating = ref(false);
const createError = ref<{ title: string; next?: string } | null>(null);
const approvedClaimCount = ref<number | null>(null);
const claimsChecking = ref(false);
const claimsCheckError = ref<string | null>(null);
let claimsCheckToken = 0;

const selected = ref<Icp | null>(null);
const detailLoading = ref(false);
const detailError = ref<{ title: string; next?: string } | null>(null);
const plans = ref<QueryPlan[]>([]);
const plansLoading = ref(false);
const plansError = ref<{ title: string; next?: string } | null>(null);
const planBusy = ref<string | null>(null);

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
        next[row.planId] = { runId: row.runId, startedAt: row.startedAt ?? '' };
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
// 引擎的 ICP 预算作用域按 company 固定，同一档案目前只能生成一次；已有初稿时直接编辑/激活。
const companiesWithoutIcp = computed(() =>
  companies.value.filter((company) =>
    company.id && !icps.value.some((icp) => icp.companyId === company.id)));

function statusLabel(status?: string): string {
  const key = `gainos.findBuyers.icpStatus.${status ?? 'DRAFT'}`;
  const value = $t(key);
  return value === key ? (status ?? '') : value;
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
const ATTRIBUTE_LABELS: Record<string, string> = {
  tech: '技术与工艺',
  region: '区域',
  country: '国家/地区',
  revenue: '营收规模',
  industry: '行业',
  keywords: '关键词',
  end_markets: '终端市场',
  sub_industry: '细分行业',
  business_model: '业务模式',
  certifications: '认证',
  employee_count: '员工规模',
  company_size: '公司规模',
  role: '产业链角色',
};

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
    .map(([key, value]) => ({ key: ATTRIBUTE_LABELS[key] ?? key, value: attrText(value) }))
    .filter((item) => item.value.length > 0);
}
function canActivate(icp: Icp): boolean {
  return ['DRAFT', 'HYPOTHESIS', 'VALIDATING'].includes(icp.status);
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
  } catch (error) {
    loadError.value = failureText(error);
    icps.value = [];
  } finally {
    loading.value = false;
  }
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
  try {
    selected.value = await gainosApi.icp(icp.id);
    await Promise.all([loadPlans(icp.id), loadRunLinks(icp.id)]);
  } catch (error) {
    detailError.value = failureText(error);
  } finally {
    detailLoading.value = false;
  }
}
function closeDetail(): void {
  selected.value = null;
  plans.value = [];
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
  if (companies.value.length > 0 && companiesWithoutIcp.value.length === 0) {
    notice.value = $t('gainos.findBuyers.allCompaniesHaveIcp');
    return;
  }
  selectedCompanyId.value = companiesWithoutIcp.value[0]?.id ?? '';
  createError.value = null;
  createOpen.value = true;
  void checkApprovedClaims(selectedCompanyId.value);
}
async function createIcp(): Promise<void> {
  if (!canCreateIcp.value || !selectedCompanyId.value) return;
  creating.value = true;
  createError.value = null;
  try {
    const icp = await gainosApi.createIcp(selectedCompanyId.value);
    createOpen.value = false;
    notice.value = $t('gainos.findBuyers.created');
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
    notice.value = $t('gainos.findBuyers.activated');
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
    notice.value = $t('gainos.findBuyers.saved');
    await load();
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
    notice.value = $t('gainos.findBuyers.ruleSaved');
  } catch (error) {
    ruleError.value = failureText(error);
  } finally {
    ruleBusy.value = false;
  }
}
async function removeRule(rule: IcpRule): Promise<void> {
  if (!selected.value) return;
  if (!window.confirm($t('gainos.findBuyers.deleteRuleConfirm'))) return;
  ruleBusy.value = true;
  try {
    await gainosApi.deleteIcpRule(rule.id);
    selected.value = await gainosApi.icp(selected.value.id);
    notice.value = $t('gainos.findBuyers.ruleDeleted');
  } catch (error) {
    ruleError.value = failureText(error);
  } finally {
    ruleBusy.value = false;
  }
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

async function createPlan(): Promise<void> {
  if (!selected.value) return;
  planBusy.value = 'create';
  plansError.value = null;
  try {
    await gainosApi.createQueryPlan(selected.value.id);
    await loadPlans(selected.value.id);
    notice.value = $t('gainos.findBuyers.planCreated');
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
    notice.value = $t('gainos.findBuyers.planConfirmed');
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
    const result = await gainosApi.executeQueryPlan(plan.id);
    rememberRun(plan.id, result.runId);
    try {
      await gainosApi.recordDiscoveryRun({ runId: result.runId, planId: plan.id, icpId: plan.icpId });
    } catch {
      // 本地引用已保存；服务端登记失败不阻断进入任务页。
    }
    await loadPlans(plan.icpId);
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

function onEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  if (editOpen.value) {
    editOpen.value = false;
  } else if (createOpen.value) {
    createOpen.value = false;
  } else if (selected.value) {
    closeDetail();
  }
}
onMounted(() => {
  loadRunRefs();
  void load();
  window.addEventListener('keydown', onEscape);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onEscape));
</script>

<template>
  <div class="fb">
    <header class="fb__head">
      <div>
        <span class="fb__stage">{{ $t('gainos.findBuyers.stage') }}</span>
        <h1>{{ $t('gainos.findBuyers.title') }}</h1>
        <p>{{ $t('gainos.findBuyers.subtitle') }}</p>
      </div>
      <button class="fb__refresh" type="button" :class="{ 'is-loading': loading }" @click="load">
        {{ loading ? $t('gainos.common.refreshing') : $t('gainos.common.refresh') }}
      </button>
    </header>

    <ol class="fb__steps" :aria-label="$t('gainos.workspace.stepProgress', { current: currentStep, total: stepLabels.length })">
      <li v-for="(label, i) in stepLabels" :key="label" class="fb__step" :class="{ 'is-done': i + 1 < currentStep, 'is-current': i + 1 === currentStep }">
        <span class="fb__step-dot">{{ i + 1 }}</span>
        <span>{{ label }}</span>
      </li>
    </ol>

    <p v-if="notice" class="fb__notice" role="status">{{ notice }}</p>

    <section class="fb__toolbar">
      <div>
        <h2>{{ $t('gainos.findBuyers.listTitle') }}</h2>
        <p>{{ activeIcp ? $t('gainos.findBuyers.activeHint', { name: activeIcp.name }) : $t('gainos.findBuyers.listDesc') }}</p>
      </div>
      <button v-if="icps.length > 0" class="fb__cta" type="button" @click="openCreate">{{ $t('gainos.findBuyers.newIcp') }}</button>
    </section>

    <section v-if="loadError" class="fb__error" role="alert">
      <h3>{{ loadError.title }}</h3>
      <p v-if="loadError.next">{{ loadError.next }}</p>
      <button type="button" class="fb__action" @click="load">{{ $t('gainos.common.retry') }}</button>
    </section>
    <p v-else-if="loading" class="fb__muted">{{ $t('gainos.common.loading') }}</p>
    <section v-else-if="icps.length === 0" class="fb__empty">
      <div class="fb__empty-mark">🎯</div>
      <p class="fb__empty-title">{{ $t('gainos.findBuyers.emptyTitle') }}</p>
      <p class="fb__empty-desc">{{ $t('gainos.findBuyers.emptyDesc') }}</p>
      <button class="fb__cta" type="button" @click="openCreate">{{ $t('gainos.findBuyers.emptyCta') }}</button>
    </section>
    <section v-else class="fb__list">
      <article v-for="icp in icps" :key="icp.id" class="fb__card">
        <header class="fb__card-head">
          <div>
            <h2>{{ icp.name }}</h2>
            <p>{{ companyName(icp.companyId) }} · v{{ icp.version }}</p>
          </div>
          <span class="fb__badge" :class="`fb__badge--${icp.status.toLowerCase()}`">{{ statusLabel(icp.status) }}</span>
        </header>
        <div v-if="icp.targetMarkets.length" class="fb__chips">
          <span v-for="market in icp.targetMarkets" :key="market" class="fb__chip">{{ market }}</span>
        </div>
        <p class="fb__muted">{{ icp.rules.length }} 条资格规则 · {{ icp.personas.length }} 个买家画像</p>
        <div class="fb__actions">
          <button type="button" class="fb__action" @click="openDetail(icp)">{{ $t('gainos.findBuyers.view') }}</button>
        </div>
      </article>
    </section>

    <div v-if="createOpen" class="fb__overlay" @click.self="createOpen = false">
      <section class="fb__modal fb__modal--narrow" role="dialog" aria-modal="true" :aria-label="$t('gainos.findBuyers.createTitle')">
        <header class="fb__modal-head">
          <div>
            <h2>{{ $t('gainos.findBuyers.createTitle') }}</h2>
            <p>{{ $t('gainos.findBuyers.createDesc') }}</p>
          </div>
          <button class="fb__close" type="button" :aria-label="$t('gainos.common.cancel')" @click="createOpen = false">×</button>
        </header>
        <div class="fb__modal-body">
          <div v-if="createError" class="fb__error" role="alert">
            <h3>{{ createError.title }}</h3>
            <p v-if="createError.next">{{ createError.next }}</p>
          </div>
          <label class="fb__field">
            <span>{{ $t('gainos.findBuyers.company') }}</span>
            <select v-model="selectedCompanyId" :disabled="companiesWithoutIcp.length === 0">
              <option v-for="company in companiesWithoutIcp" :key="company.id" :value="company.id">
                {{ company.name || company.website }} · {{ company.status }}
              </option>
            </select>
          </label>
          <p v-if="!companies.length" class="fb__muted">{{ $t('gainos.findBuyers.noCompanies') }}</p>
          <p v-else-if="companiesWithoutIcp.length === 0" class="fb__warn">{{ $t('gainos.findBuyers.allCompaniesHaveIcp') }}</p>
          <p v-if="claimsChecking" class="fb__muted">{{ $t('gainos.findBuyers.checkingFacts') }}</p>
          <div v-else-if="claimsCheckError" class="fb__error" role="alert">
            <p>{{ $t('gainos.findBuyers.factsCheckFailed') }}</p>
            <button class="fb__action" type="button" @click="checkApprovedClaims(selectedCompanyId)">
              {{ $t('gainos.common.retry') }}
            </button>
          </div>
          <p v-else-if="approvedClaimCount === 0" class="fb__warn">{{ $t('gainos.findBuyers.noApprovedFacts') }}</p>
          <p v-else-if="approvedClaimCount !== null" class="fb__muted">
            {{ $t('gainos.findBuyers.approvedFactsCount', { count: approvedClaimCount }) }}
          </p>
          <p class="fb__muted">{{ $t('gainos.findBuyers.createNote') }}</p>
        </div>
        <div class="fb__modal-actions fb__modal-foot">
          <button class="fb__action" type="button" @click="createOpen = false">{{ $t('gainos.common.cancel') }}</button>
          <button class="fb__cta" type="button" :disabled="!canCreateIcp" :class="{ 'is-loading': creating }" @click="createIcp">
            {{ creating ? $t('gainos.findBuyers.generating') : $t('gainos.findBuyers.generate') }}
          </button>
        </div>
      </section>
    </div>

    <div v-if="selected" class="fb__overlay" @click.self="closeDetail">
      <section class="fb__modal" role="dialog" aria-modal="true" :aria-label="selected.name">
        <header class="fb__modal-head">
          <div>
            <span class="fb__modal-kicker">{{ $t('gainos.findBuyers.detailKicker') }}</span>
            <h2>{{ selected.name }}</h2>
            <p>{{ companyName(selected.companyId) }} · {{ statusLabel(selected.status) }} · {{ $t('gainos.findBuyers.version', { version: selected.version }) }}</p>
            <p class="fb__muted">{{ $t('gainos.findBuyers.detailHint') }}</p>
          </div>
          <div class="fb__modal-head-actions">
            <button v-if="canActivate(selected)" class="fb__cta" type="button" :disabled="planBusy === 'activate'" :class="{ 'is-loading': planBusy === 'activate' }" @click="activate">
              {{ planBusy === 'activate' ? $t('gainos.findBuyers.activating') : $t('gainos.findBuyers.activate') }}
            </button>
            <button class="fb__action" type="button" @click="openEdit">{{ $t('gainos.findBuyers.edit') }}</button>
            <button class="fb__close" type="button" :aria-label="$t('gainos.common.cancel')" @click="closeDetail">×</button>
          </div>
        </header>

        <div class="fb__modal-body">
        <p v-if="detailLoading" class="fb__muted">{{ $t('gainos.common.loading') }}</p>
        <div v-else-if="detailError" class="fb__error" role="alert">
          <h3>{{ detailError.title }}</h3>
          <p v-if="detailError.next">{{ detailError.next }}</p>
        </div>
        <template v-else>
          <div class="fb__block">
            <h3>{{ $t('gainos.findBuyers.targetMarkets') }}</h3>
            <div v-if="selected.targetMarkets.length" class="fb__chips">
              <span v-for="market in selected.targetMarkets" :key="market" class="fb__chip">{{ market }}</span>
            </div>
            <p v-else class="fb__muted">—</p>
          </div>
          <div class="fb__block">
            <h3>{{ $t('gainos.findBuyers.companyAttributes') }}</h3>
            <dl class="fb__attr-grid">
              <div v-for="item in attributesOf(selected)" :key="item.key" class="fb__attr">
                <dt>{{ item.key }}</dt><dd>{{ item.value }}</dd>
              </div>
            </dl>
          </div>
          <div class="fb__grid fb__grid--two">
            <div v-for="section in [
              { key: 'painPoints', title: 'painPoints', items: selected.painPoints },
              { key: 'triggerSignals', title: 'triggerSignals', items: selected.triggerSignals },
              { key: 'exclusions', title: 'exclusions', items: selected.exclusions },
              { key: 'valueProps', title: 'valueProps', items: selected.valueProps },
            ]" :key="section.key" class="fb__block">
              <h3>{{ $t(`gainos.findBuyers.${section.title}`) }}</h3>
              <ul v-if="section.items.length" class="fb__bullets">
                <li v-for="(item, i) in section.items" :key="i">{{ item }}</li>
              </ul>
              <p v-else class="fb__muted">—</p>
            </div>
          </div>

          <div v-if="selected.personas.length" class="fb__block">
            <h3>{{ $t('gainos.findBuyers.personas') }}</h3>
            <div class="fb__grid">
              <article v-for="persona in selected.personas" :key="persona.title" class="fb__persona">
                <h4>{{ persona.title }}</h4>
                <p v-if="persona.goals.length"><strong>{{ $t('gainos.findBuyers.goals') }}</strong> {{ persona.goals.join(' · ') }}</p>
                <p v-if="persona.painPoints.length"><strong>{{ $t('gainos.findBuyers.painPoints') }}</strong> {{ persona.painPoints.join(' · ') }}</p>
              </article>
            </div>
          </div>
          <div v-if="selected.buyingCommittee.length" class="fb__block">
            <h3>{{ $t('gainos.findBuyers.buyingCommittee') }}</h3>
            <ul class="fb__bullets">
              <li v-for="(role, i) in selected.buyingCommittee" :key="i">
                <strong>{{ role.title || role.role }}</strong><span v-if="role.concerns.length"> · {{ role.concerns.join(' · ') }}</span>
              </li>
            </ul>
          </div>

          <details class="fb__advanced">
            <summary>{{ $t('gainos.findBuyers.advanced') }}</summary>

          <div v-if="selected.ruleLint.length" class="fb__lint">
            <h3>{{ $t('gainos.findBuyers.ruleLint') }}</h3>
            <ul class="fb__bullets"><li v-for="(warning, i) in selected.ruleLint" :key="i">{{ warning }}</li></ul>
          </div>

          <div class="fb__block">
            <div class="fb__section-head">
              <div><h3>{{ $t('gainos.findBuyers.rulesTitle') }}</h3><p class="fb__muted">{{ $t('gainos.findBuyers.rulesDesc') }}</p></div>
              <button class="fb__action" type="button" @click="openRule()">{{ $t('gainos.findBuyers.addRule') }}</button>
            </div>
            <div v-if="ruleError" class="fb__error" role="alert"><h3>{{ ruleError.title }}</h3><p v-if="ruleError.next">{{ ruleError.next }}</p></div>
            <ul v-if="selected.rules.length" class="fb__rules">
              <li v-for="rule in selected.rules" :key="rule.id">
                <span class="fb__chip">{{ kindLabel(rule.kind) }}</span>
                <code>{{ rule.field }} {{ operatorLabel(rule.operator) }} {{ ruleValueText(rule.value) }}</code>
                <span v-if="rule.kind === 'NICE_TO_HAVE'" class="fb__muted">· ×{{ rule.weight }}</span>
                <span v-if="rule.rationale" class="fb__muted">· {{ rule.rationale }}</span>
                <span class="fb__rule-actions">
                  <button type="button" @click="openRule(rule)">{{ $t('gainos.findBuyers.editRule') }}</button>
                  <button type="button" @click="removeRule(rule)">{{ $t('gainos.findBuyers.deleteRule') }}</button>
                </span>
              </li>
            </ul>
            <p v-else class="fb__muted">{{ $t('gainos.findBuyers.noRules') }}</p>
            <div v-if="ruleOpen" class="fb__rule-form">
              <label class="fb__field"><span>{{ $t('gainos.findBuyers.ruleKind') }}</span>
                <select v-model="ruleForm.kind"><option v-for="kind in RULE_KINDS" :key="kind" :value="kind">{{ kindLabel(kind) }}</option></select>
              </label>
              <label class="fb__field"><span>{{ $t('gainos.findBuyers.ruleField') }}</span><input v-model="ruleForm.field" /></label>
              <label class="fb__field"><span>{{ $t('gainos.findBuyers.ruleOperator') }}</span>
                <select v-model="ruleForm.operator"><option v-for="op in RULE_OPERATORS" :key="op" :value="op">{{ operatorLabel(op) }}</option></select>
              </label>
              <label class="fb__field"><span>{{ $t('gainos.findBuyers.ruleValue') }}</span><input v-model="ruleForm.valueText" :placeholder="$t('gainos.findBuyers.ruleValueHint')" /></label>
              <label class="fb__field"><span>{{ $t('gainos.findBuyers.ruleWeight') }}</span><input v-model.number="ruleForm.weight" type="number" min="0" step="0.5" /></label>
              <label class="fb__field"><span>{{ $t('gainos.findBuyers.ruleRationale') }}</span><input v-model="ruleForm.rationale" /></label>
              <div class="fb__modal-actions">
                <button class="fb__action" type="button" @click="ruleOpen = false">{{ $t('gainos.common.cancel') }}</button>
                <button class="fb__cta" type="button" :disabled="ruleBusy" :class="{ 'is-loading': ruleBusy }" @click="saveRule">{{ $t('gainos.findBuyers.saveRule') }}</button>
              </div>
            </div>
          </div>

          <div class="fb__block">
            <h3>{{ $t('gainos.findBuyers.backtestTitle') }}</h3>
            <p class="fb__muted">{{ $t('gainos.findBuyers.backtestDesc') }}</p>
            <textarea v-model="backtestText" rows="8" class="fb__textarea fb__mono" :aria-label="$t('gainos.findBuyers.backtestSamples')"></textarea>
            <div v-if="backtestError" class="fb__error" role="alert"><h3>{{ backtestError.title }}</h3><p v-if="backtestError.next">{{ backtestError.next }}</p></div>
            <div class="fb__modal-actions">
              <button class="fb__cta" type="button" :disabled="backtestBusy" :class="{ 'is-loading': backtestBusy }" @click="runBacktest">
                {{ backtestBusy ? $t('gainos.common.loading') : $t('gainos.findBuyers.runBacktest') }}
              </button>
            </div>
            <template v-if="backtest">
              <dl class="fb__facts">
                <div v-for="(value, key) in backtest.metrics" :key="key"><dt>{{ key }}</dt><dd>{{ textOf(value) || JSON.stringify(value) }}</dd></div>
              </dl>
              <ul class="fb__bullets">
                <li v-for="(result, i) in backtest.results" :key="i">{{ textOf(result) || JSON.stringify(result) }}</li>
              </ul>
            </template>
          </div>
          </details>

          <div class="fb__block">
            <div class="fb__section-head">
              <div><h3>{{ $t('gainos.findBuyers.plansTitle') }}</h3><p class="fb__muted">{{ $t('gainos.findBuyers.plansDesc') }}</p></div>
              <button v-if="!plansLoading && plans.length === 0" class="fb__action" type="button" :disabled="selected.status !== 'ACTIVE' || planBusy === 'create'" :title="selected.status !== 'ACTIVE' ? $t('gainos.findBuyers.planNeedsActive') : ''" @click="createPlan">
                {{ planBusy === 'create' ? $t('gainos.common.loading') : $t('gainos.findBuyers.createPlan') }}
              </button>
            </div>
            <p v-if="plansError" class="fb__error-text">{{ plansError.title }}<span v-if="plansError.next"> · {{ plansError.next }}</span></p>
            <p v-else-if="plansLoading" class="fb__muted">{{ $t('gainos.common.loading') }}</p>
            <ul v-else-if="plans.length" class="fb__plans">
              <li v-for="plan in plans" :key="plan.id">
                <div class="fb__plan-head">
                  <span class="fb__badge">{{ planStatusLabel(plan.status) }}</span>
                  <span class="fb__muted">
                    {{ $t('gainos.findBuyers.planSearchCount', { count: plan.queries.length }) }}<span v-if="plan.estimatedVolume"> · {{ $t('gainos.findBuyers.planEstimated', { count: plan.estimatedVolume }) }}</span>
                  </span>
                </div>
                <p class="fb__muted">{{ $t('gainos.findBuyers.planSources') }}：{{ planSourceSummary(plan) }}</p>
                <details class="fb__plan-details">
                  <summary>{{ $t('gainos.findBuyers.planConditions', { count: plan.queries.length }) }}</summary>
                  <ul class="fb__queries">
                    <li v-for="(query, i) in plan.queries" :key="i">
                      <div class="fb__query-head">
                        <strong>{{ querySourceLabel(query) }}</strong>
                        <span v-if="query.priority" class="fb__muted">{{ $t('gainos.findBuyers.planPriority', { priority: query.priority }) }}</span>
                      </div>
                      <div v-if="queryFilterItems(query).length" class="fb__query-filters">
                        <span v-for="item in queryFilterItems(query)" :key="item.label" class="fb__query-filter">
                          <em>{{ item.label }}</em>{{ item.value }}
                        </span>
                      </div>
                      <div v-if="queryKeywords(query).length" class="fb__chips">
                        <span v-for="keyword in queryKeywords(query)" :key="keyword" class="fb__chip">{{ keyword }}</span>
                      </div>
                      <p v-if="query.rationale" class="fb__muted">{{ textOf(query.rationale) }}</p>
                    </li>
                  </ul>
                  <details class="fb__raw">
                    <summary>{{ $t('gainos.findBuyers.planRaw') }}</summary>
                    <pre>{{ JSON.stringify(plan.queries, null, 2) }}</pre>
                  </details>
                </details>
                <div class="fb__actions">
                  <button v-if="runRefs[plan.id]" class="fb__action" type="button" @click="openPlanRun(plan)">{{ $t('gainos.findBuyers.viewRun') }}</button>
                  <template v-else>
                    <button v-if="plan.status === 'DRAFT'" class="fb__action" type="button" :disabled="planBusy === plan.id" @click="confirmPlan(plan)">{{ $t('gainos.findBuyers.confirmPlan') }}</button>
                    <button v-if="plan.status === 'READY'" class="fb__action fb__action--primary" type="button" :disabled="planBusy === plan.id" @click="executePlan(plan)">{{ $t('gainos.findBuyers.executePlan') }}</button>
                  </template>
                </div>
                <p v-if="runRefs[plan.id]" class="fb__muted">{{ $t('gainos.findBuyers.runStarted') }}</p>
                <p v-else-if="plan.status === 'EXECUTED'" class="fb__muted">{{ $t('gainos.findBuyers.runLinkMissing') }}</p>
              </li>
            </ul>
            <p v-else class="fb__muted">{{ $t('gainos.findBuyers.noPlans') }}</p>
          </div>
        </template>
        </div>
      </section>
    </div>

    <div v-if="editOpen && selected" class="fb__overlay fb__overlay--top" @click.self="editOpen = false">
      <section class="fb__modal fb__modal--narrow" role="dialog" aria-modal="true" :aria-label="$t('gainos.findBuyers.editTitle')">
        <header class="fb__modal-head">
          <h2>{{ $t('gainos.findBuyers.editTitle') }}</h2>
          <button class="fb__close" type="button" :aria-label="$t('gainos.common.cancel')" @click="editOpen = false">×</button>
        </header>
        <div class="fb__modal-body">
          <div v-if="editError" class="fb__error" role="alert"><h3>{{ editError.title }}</h3><p v-if="editError.next">{{ editError.next }}</p></div>
          <label class="fb__field"><span>{{ $t('gainos.findBuyers.name') }}</span><input v-model="editForm.name" /></label>
          <label class="fb__field"><span>{{ $t('gainos.findBuyers.targetMarkets') }}</span><input v-model="editForm.targetMarkets" :placeholder="$t('gainos.findBuyers.marketsHint')" /></label>
          <label class="fb__field"><span>{{ $t('gainos.findBuyers.painPoints') }}</span><textarea v-model="editForm.painPoints" rows="4"></textarea></label>
          <label class="fb__field"><span>{{ $t('gainos.findBuyers.triggerSignals') }}</span><textarea v-model="editForm.triggerSignals" rows="4"></textarea></label>
          <label class="fb__field"><span>{{ $t('gainos.findBuyers.exclusions') }}</span><textarea v-model="editForm.exclusions" rows="4"></textarea></label>
          <label class="fb__field"><span>{{ $t('gainos.findBuyers.valueProps') }}</span><textarea v-model="editForm.valueProps" rows="4"></textarea></label>
          <label class="fb__field"><span>{{ $t('gainos.findBuyers.companyAttributes') }}</span><textarea v-model="editForm.attributesText" rows="5" class="fb__mono"></textarea></label>
          <p class="fb__muted">{{ $t('gainos.findBuyers.attributesHint') }}</p>
          <code class="fb__code">{{ '{"industry": "metal fabrication", "country": "DE"}' }}</code>
        </div>
        <div class="fb__modal-actions fb__modal-foot">
          <button class="fb__action" type="button" @click="editOpen = false">{{ $t('gainos.common.cancel') }}</button>
          <button class="fb__cta" type="button" :disabled="editing" :class="{ 'is-loading': editing }" @click="saveEdit">{{ $t('gainos.findBuyers.saveChanges') }}</button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.fb { padding: clamp(18px, 2.4vw, 32px) clamp(18px, 2.4vw, 34px) clamp(32px, 4vh, 48px); max-width: 1280px; margin: 0 auto; display: grid; gap: 18px; }
.fb__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.fb__stage { font-size: 11.5px; font-weight: 700; letter-spacing: .18em; color: var(--gs-accent-strong); }
.fb__head h1 { margin: 6px 0 0; font-size: 24px; font-weight: 700; color: var(--gs-fg); }
.fb__head p { margin: 8px 0 0; font-size: 13.5px; color: var(--gs-fg-muted); max-width: 640px; line-height: 1.7; }
.fb__refresh { border: 1px solid var(--gs-border-strong); background: var(--gs-surface); border-radius: 10px; padding: 8px 16px; font-size: 13px; color: var(--gs-fg-2); cursor: pointer; white-space: nowrap; }
.fb__refresh.is-loading { opacity: .6; cursor: progress; }
.fb__steps { list-style: none; margin: 0; padding: 0; display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }
.fb__step { display: flex; align-items: center; gap: 6px; flex: none; padding: 6px 10px; border-radius: 999px; font-size: 12px; color: var(--gs-fg-subtle); background: var(--gs-divider); }
.fb__step-dot { width: 19px; height: 19px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--gs-surface); font-size: 10.5px; font-weight: 700; }
.fb__step.is-done { color: var(--gs-accent-strong); background: var(--gs-accent-soft); }
.fb__step.is-current { color: #fff; background: var(--gs-accent); }
.fb__step.is-current .fb__step-dot { background: rgba(255,255,255,.22); color: #fff; }
.fb__notice { margin: 0; padding: 10px 14px; border-radius: 10px; background: var(--gs-accent-soft); color: var(--gs-accent-strong); font-size: 13px; font-weight: 600; }
.fb__toolbar { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.fb__toolbar h2 { margin: 0; font-size: 16px; font-weight: 650; color: var(--gs-fg); }
.fb__toolbar p { margin: 5px 0 0; font-size: 12.5px; color: var(--gs-fg-subtle); }
.fb__cta { border: 0; border-radius: 10px; padding: 9px 18px; background: var(--gs-accent); color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; }
.fb__cta:disabled { opacity: .45; cursor: not-allowed; }
.fb__action { border: 1px solid var(--gs-border-strong); background: var(--gs-surface); color: var(--gs-fg-2); border-radius: 9px; padding: 7px 13px; font-size: 12.5px; cursor: pointer; }
.fb__action:disabled { opacity: .45; cursor: not-allowed; }
.fb__action--primary { background: var(--gs-accent); border-color: var(--gs-accent); color: #fff; }
.fb__error { border: 1px solid var(--gs-warn); background: var(--gs-warn-bg); border-radius: 10px; padding: 12px 14px; display: grid; gap: 4px; }
.fb__error h3 { margin: 0; font-size: 13.5px; color: var(--gs-warn); }
.fb__error p, .fb__error-text { margin: 0; font-size: 12.5px; color: var(--gs-fg-2); line-height: 1.65; }
.fb__error-text { color: var(--gs-warn); }
.fb__muted { margin: 0; font-size: 12.5px; color: var(--gs-fg-subtle); line-height: 1.7; }
.fb__warn {
  margin: 0; padding: 10px 12px; border-radius: 9px; line-height: 1.65;
  font-size: 12.5px; color: var(--gs-warn); background: var(--gs-warn-bg); border: 1px solid var(--gs-warn);
}
.fb__empty { max-width: 760px; margin: 0 auto; display: grid; place-items: center; gap: 8px; text-align: center; background: var(--gs-surface); border: 1px dashed var(--gs-border-dashed); border-radius: 16px; padding: 48px 24px; }
.fb__empty-mark { font-size: 30px; }
.fb__empty-title { margin: 0; font-size: 16.5px; font-weight: 600; color: var(--gs-fg); }
.fb__empty-desc { margin: 0 0 10px; font-size: 13.5px; color: var(--gs-fg-muted); max-width: 540px; line-height: 1.75; }
.fb__list { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
.fb__card { background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px; padding: 18px 20px; display: grid; gap: 10px; }
.fb__card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.fb__card-head h2 { margin: 0; font-size: 16px; font-weight: 650; color: var(--gs-fg); }
.fb__card-head p { margin: 4px 0 0; font-size: 12.5px; color: var(--gs-fg-subtle); }
.fb__badge { flex: none; font-size: 11.5px; font-weight: 600; padding: 3px 9px; border-radius: 999px; background: var(--gs-divider); color: var(--gs-fg-2); }
.fb__badge--active { background: var(--gs-accent-soft); color: var(--gs-accent-strong); }
.fb__badge--draft, .fb__badge--hypothesis { background: var(--gs-warn-bg); color: var(--gs-warn); }
.fb__chips { display: flex; flex-wrap: wrap; gap: 6px; }
.fb__chip { font-size: 11.5px; background: var(--gs-divider); color: var(--gs-fg-2); border-radius: 999px; padding: 3px 9px; }
.fb__actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.fb__overlay {
  position: fixed; inset: 0; z-index: 1000; background: rgba(15,23,42,.58); backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center; padding: 24px; overflow: hidden;
}
.fb__overlay--top { z-index: 1010; }
.fb__modal {
  width: min(920px, 100%); max-height: calc(100dvh - 48px); box-sizing: border-box; min-width: 0;
  background: var(--gs-surface); border-radius: 18px; box-shadow: 0 24px 60px -20px rgba(15,23,42,.4);
  display: flex; flex-direction: column; overflow: hidden;
}
.fb__modal--narrow { width: min(560px, 100%); }
.fb__modal-body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain;
  padding: 20px 26px; display: grid; gap: 16px; overflow-wrap: anywhere;
}
.fb__modal-body > * { min-width: 0; }
.fb__modal-head {
  flex: none; display: flex; justify-content: space-between; align-items: flex-start; gap: 16px;
  padding: 22px 26px 16px; border-bottom: 1px solid var(--gs-border);
}
.fb__modal-head > div { min-width: 0; }
.fb__modal-foot {
  flex: none; padding: 14px 26px 20px; border-top: 1px solid var(--gs-border);
  background: var(--gs-surface);
}
.fb__modal-kicker { font-size: 11.5px; font-weight: 700; letter-spacing: .18em; color: var(--gs-accent-strong); }
.fb__modal-head h2 { margin: 6px 0 0; font-size: 20px; font-weight: 700; color: var(--gs-fg); }
.fb__modal-head p { margin: 6px 0 0; font-size: 13px; color: var(--gs-fg-muted); line-height: 1.7; }
.fb__modal-head-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.fb__close { border: 0; background: transparent; font-size: 24px; line-height: 1; color: var(--gs-fg-subtle); cursor: pointer; padding: 2px 6px; }
.fb__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
.fb__grid--two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.fb__advanced { border: 1px solid var(--gs-border); border-radius: 10px; padding: 10px 12px; }
.fb__advanced > summary { cursor: pointer; font-size: 12.5px; color: var(--gs-fg-muted); }
.fb__advanced[open] > summary { margin-bottom: 12px; }
.fb__advanced .fb__block { margin-top: 12px; }
.fb__block { display: grid; gap: 8px; min-width: 0; }
.fb__block h3 { margin: 0; font-size: 13px; font-weight: 650; color: var(--gs-fg); }
.fb__attr-grid { margin: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.fb__attr { min-width: 0; display: grid; gap: 3px; padding: 8px 10px; background: var(--gs-divider); border-radius: 9px; }
.fb__attr dt { font-size: 11.5px; color: var(--gs-fg-subtle); }
.fb__attr dd { margin: 0; font-size: 12.5px; line-height: 1.6; color: var(--gs-fg-2); overflow-wrap: anywhere; }
.fb__section-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.fb__facts { margin: 0; display: grid; gap: 6px; }
.fb__facts div { display: flex; justify-content: space-between; gap: 12px; font-size: 12.5px; }
.fb__facts dt { color: var(--gs-fg-subtle); }
.fb__facts dd { margin: 0; color: var(--gs-fg-2); text-align: right; }
.fb__bullets { margin: 0; padding-left: 18px; display: grid; gap: 5px; font-size: 12.5px; color: var(--gs-fg-2); line-height: 1.65; }
.fb__persona { background: var(--gs-divider); border-radius: 10px; padding: 12px 14px; display: grid; gap: 5px; }
.fb__persona h4 { margin: 0; font-size: 13px; color: var(--gs-fg); }
.fb__persona p { margin: 0; font-size: 12px; color: var(--gs-fg-2); line-height: 1.65; }
.fb__lint { border: 1px solid var(--gs-warn-bg); background: var(--gs-warn-bg); border-radius: 10px; padding: 12px 14px; display: grid; gap: 6px; }
.fb__lint h3 { margin: 0; font-size: 13px; color: var(--gs-warn); }
.fb__rules, .fb__plans { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.fb__rules li { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; color: var(--gs-fg-2); background: var(--gs-divider); border-radius: 9px; padding: 8px 10px; }
.fb__rules code { font-size: 12px; color: var(--gs-fg); }
.fb__rule-actions { margin-left: auto; display: flex; gap: 8px; }
.fb__rule-actions button { border: 0; background: transparent; color: var(--gs-accent-strong); font-size: 12px; cursor: pointer; padding: 0; }
.fb__rule-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; background: var(--gs-surface-3); border-radius: 10px; padding: 12px; }
.fb__rule-form .fb__modal-actions { grid-column: 1 / -1; }
.fb__field { display: grid; gap: 5px; font-size: 12.5px; color: var(--gs-fg-2); }
.fb__field input, .fb__field select, .fb__field textarea, .fb__textarea {
  width: 100%; box-sizing: border-box; border: 1px solid var(--gs-border-strong); border-radius: 9px; background: var(--gs-surface); color: var(--gs-fg);
  padding: 9px 11px; font-size: 13px; font-family: inherit;
}
.fb__field textarea, .fb__textarea { resize: vertical; }
.fb__mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.fb__code { display: block; margin: 0; padding: 10px 12px; background: var(--gs-divider); border-radius: 9px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.6; color: var(--gs-fg-2); white-space: pre; overflow-x: auto; }
.fb__modal-actions { display: flex; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
.fb__plan-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.fb__plans li { background: var(--gs-divider); border-radius: 10px; padding: 10px 12px; display: grid; gap: 6px; }
.fb__plan-details > summary { cursor: pointer; font-size: 12.5px; color: var(--gs-fg-muted); }
.fb__queries { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 8px; max-height: 360px; overflow: auto; }
.fb__queries li { background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 10px; padding: 10px 12px; display: grid; gap: 6px; }
.fb__query-head { display: flex; justify-content: space-between; gap: 8px; align-items: center; flex-wrap: wrap; }
.fb__query-head strong { font-size: 13px; color: var(--gs-fg); }
.fb__query-filters { display: flex; flex-wrap: wrap; gap: 6px; }
.fb__query-filter { font-size: 11.5px; color: var(--gs-fg-2); background: var(--gs-divider); border-radius: 6px; padding: 3px 7px; }
.fb__query-filter em { font-style: normal; color: var(--gs-fg-subtle); margin-right: 4px; }
.fb__raw { margin-top: 8px; }
.fb__raw > summary { cursor: pointer; font-size: 12px; color: var(--gs-fg-subtle); }
.fb__raw pre { margin: 8px 0 0; padding: 10px; background: var(--gs-divider); border-radius: 8px; overflow: auto; max-height: 260px; font-size: 11.5px; }
.fb__details { font-size: 12px; color: var(--gs-fg-subtle); }
.fb__details pre { margin: 8px 0 0; padding: 10px; background: var(--gs-divider); border-radius: 8px; overflow: auto; max-height: 260px; }
@media (max-width: 720px) {
  .fb__head, .fb__toolbar { flex-direction: column; }
  .fb__overlay { padding: 10px; }
  .fb__modal { max-height: calc(100dvh - 20px); }
  .fb__modal-head { flex-direction: column; align-items: stretch; padding: 18px 16px 14px; }
  .fb__modal-head:has(> h2:first-child) { flex-direction: row; align-items: flex-start; justify-content: space-between; }
  .fb__modal-head > div > p.fb__muted { display: none; }
  .fb__modal-head-actions { width: 100%; justify-content: flex-end; }
  .fb__modal-body { padding: 16px; }
  .fb__modal-foot { padding: 12px 16px 16px; }
  .fb__modal-actions { flex-direction: column; }
  .fb__modal-actions > * { width: 100%; }
  .fb__grid--two, .fb__attr-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
