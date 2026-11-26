<script lang="ts" setup>
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { feedback } from '#/feedback';
import { $t } from '#/locales';
import { newAttemptId } from '#/utils/attempt-id';
import { Plus, RotateCw } from '@vben/icons';

import {
  Alert,
  Button,
  Dropdown,
  Input,
  Menu,
  Modal,
  Skeleton,
  Space,
  Tag,
  Textarea,
} from 'ant-design-vue';

import ErrorNotice from '#/components/error-notice.vue';
import GsCard from '#/components/gainos/ui/gs-card.vue';
import GsEmpty from '#/components/gainos/ui/gs-empty.vue';
import GsPage from '#/components/gainos/ui/gs-page.vue';
import GsSegmented from '#/components/gainos/ui/gs-segmented.vue';
import GsSelect from '#/components/gainos/ui/gs-select.vue';
import GsTag from '#/components/gainos/ui/gs-tag.vue';
import GsToolbar from '#/components/gainos/ui/gs-toolbar.vue';
import MarketCandidatesPanel from './market-candidates/market-candidates-panel.vue';

import {
  failureText,
  gainosApi,
  type CompanyClaim,
  type CompanyCompleteness,
  type CompanyConflict,
  type CompanyOffering,
  type CompanyProfile,
  type DocumentChunkView,
  type DocumentClaimPreview,
  type Icp,
  type SellerDocument,
  type UpdateCompanyInput,
  type WebsiteCandidate,
} from '#/api/gainos';

defineOptions({ name: 'Companies' });

const router = useRouter();
const marketCompany = ref<CompanyProfile | null>(null);
const factsPanel = ref<HTMLElement | null>(null);
const docsPanel = ref<HTMLElement | null>(null);
const marketContext = ref('');
let marketFocus: HTMLElement | null = null;
function openMarketCandidates(company: CompanyProfile, event?: MouseEvent) {
  if (!marketContext.value || !company.id) return;
  const target = (event?.currentTarget as HTMLElement | undefined) ?? null;
  const details = target?.closest('details') ?? null;
  marketFocus = details?.querySelector('summary') ?? target;
  if (details) details.open = false;
  marketCompany.value = company;
}
function closeMarketCandidates() { marketCompany.value = null; marketFocus?.focus(); }
function recoverMarketView(payload: { companyId: string; destination: 'facts' | 'documents' }) {
  if (!marketCompany.value || payload.companyId !== marketCompany.value.id) return;
  const company = marketCompany.value;
  // 补资料/看事实现在是页内工作台，不再叠一层弹窗：直接收起市场候选面板，
  // 把用户带到页内对应视图，避免“面板还盖着、页面已经切走”的错位。
  marketCompany.value = null;
  if (payload.destination === 'facts') void openClaims(company, { readOnly: true });
  else void openDocuments(company, { readOnly: true });
  void scrollToWorkspace();
}
onDeactivated(() => { marketCompany.value = null; });

const STATUS_KEY: Record<string, string> = {
  DRAFT: 'gainos.companies.statusDraft',
  ENRICHING: 'gainos.companies.statusEnriching',
  REVIEW: 'gainos.companies.statusReview',
  ACTIVE: 'gainos.companies.statusActive',
};

const CLAIM_TYPE_KEY: Record<string, string> = {
  capability: 'gainos.companies.claimType.capability',
  company_fact: 'gainos.companies.claimType.companyFact',
  forbidden_expression_candidate: 'gainos.companies.claimType.forbiddenExpression',
  param: 'gainos.companies.claimType.param',
  market: 'gainos.companies.claimType.market',
  certification: 'gainos.companies.claimType.certification',
  case: 'gainos.companies.claimType.case',
  value_prop: 'gainos.companies.claimType.valueProp',
  lead_time: 'gainos.companies.claimType.leadTime',
};

type ClaimTab = 'NEEDS_REVIEW' | 'APPROVED' | 'REVOKED';

const loading = ref(true);
const error = ref<string | null>(null);
const companies = ref<CompanyProfile[]>([]);

// P5b-09：列表筛选（客户端）。公司 API 一次返回全部，量级 <200 时客户端过滤足够。
const searchQuery = ref('');
const statusFilter = ref('ALL');
const STATUS_FILTERS = ['ALL', 'DRAFT', 'ENRICHING', 'REVIEW', 'ACTIVE', 'FAILED'] as const;
const filteredCompanies = computed(() =>
  companies.value.filter((company) => {
    const q = searchQuery.value.trim().toLowerCase();
    const haystack = [company.name, company.domain, company.website, company.industry]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .map((value) => value.toLowerCase());
    const matchQuery = !q || haystack.some((value) => value.includes(q));
    const effectiveStatus = understandingFailed(company) ? 'FAILED' : (company.status ?? 'DRAFT');
    const matchStatus = statusFilter.value === 'ALL' || effectiveStatus === statusFilter.value;
    return matchQuery && matchStatus;
  }),
);
// ── 主档案（注册公司）与关联公司 ─────────────────────────────────────────
// 一个工作空间可以有多份卖家档案（集团/多品牌，PRD 01-04 §2），但用户注册时填写的
// 那一份（workspace.onboardingCompanyId）是主档案：所有日常操作与寻源都以它为准，
// 其余档案收在「关联公司」里，避免用户把系统当成「随便建几个公司」。
const primaryCompanyId = ref<string | null>(null);
const icps = ref<Icp[]>([]);
const summaries = ref<Record<string, CompanyCompleteness>>({});
const addRelatedOpen = ref(false);

const sortedCompanies = computed(() =>
  [...companies.value].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '')),
);
const primaryCompany = computed(
  () =>
    companies.value.find((company) => company.id === primaryCompanyId.value) ??
    sortedCompanies.value[0] ??
    null,
);
const relatedCompanies = computed(() =>
  companies.value.filter((company) => company.id !== primaryCompany.value?.id),
);
const filteredRelated = computed(() =>
  filteredCompanies.value.filter((company) => company.id !== primaryCompany.value?.id),
);

// ── 档案工作台（页内，不用弹窗）───────────────────────────────────────────
// 企业事实与资料库是每天都要看、要批的东西；放在页内可以同时看到公司身份、
// KPI 和明细，切换公司/视图也不会丢掉页面上下文。
type PanelTab = 'facts' | 'docs';
const panelTab = ref<PanelTab>('facts');
const panelCompanyId = ref<string | null>(null);
const panelInitialized = ref(false);
const claimsStale = ref(false);
const workspaceRef = ref<HTMLElement | null>(null);

const panelCompany = computed(
  () =>
    companies.value.find((company) => company.id === panelCompanyId.value) ??
    primaryCompany.value,
);
const panelCompanyOptions = computed(() =>
  companies.value.map((company) => {
    const name = companyTitle(company);
    return {
      label:
        company.id === primaryCompany.value?.id
          ? `${name} · ${primaryBadgeLabel.value}`
          : name,
      value: company.id ?? '',
    };
  }),
);
// 页签不带计数：「企业事实 0」会被读成「没有事实」，其实那个 0 是待确认数。
// 各状态的数量放在清单自己的页签上（待确认 / 已通过 / 未采用）。
const panelTabs = computed(() => [
  { label: $t('gainos.companies.workspaceFacts'), value: 'facts' },
  { label: $t('gainos.companies.workspaceDocs'), value: 'docs' },
]);
const panelLoading = computed(() =>
  panelTab.value === 'facts'
    ? claimsLoading.value || overviewLoading.value
    : docsLoading.value,
);

async function scrollToWorkspace(): Promise<void> {
  await nextTick();
  workspaceRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
/** 页面上所有「看事实/看资料」的入口：切到对应视图并滚到工作台。 */
function showFacts(company: CompanyProfile): void {
  void openClaims(company);
  void scrollToWorkspace();
}
function showDocs(company: CompanyProfile): void {
  void openDocuments(company);
  void scrollToWorkspace();
}
function refreshPanel(): void {
  const company = panelCompany.value;
  if (!company) return;
  if (panelTab.value === 'facts') void openClaims(company);
  else void openDocuments(company);
}
function onPanelCompanyChange(value: unknown): void {
  const id = typeof value === 'string' ? value : String(value ?? '');
  const company = companies.value.find((row) => row.id === id);
  if (!company) return;
  panelCompanyId.value = id;
  if (panelTab.value === 'facts') void openClaims(company);
  else void openDocuments(company);
}
function onPanelTabChange(value: string): void {
  if (value !== 'facts' && value !== 'docs') return;
  panelTab.value = value;
  const company = panelCompany.value;
  if (!company) return;
  if (value === 'facts') {
    docsOpen.value = false;
    docsEpoch += 1;
    if (docsTimer) {
      clearInterval(docsTimer);
      docsTimer = null;
    }
    claimsOpen.value = true;
    // 资料库切换期间作废了事实请求：回来后重取，避免停在半截的 loading/空列表。
    if (claimsCompany.value?.id !== company.id || claimsStale.value) {
      void openClaims(company);
      return;
    }
    factsPanel.value?.focus({ preventScroll: true });
    return;
  }
  // 资料库切回来时总是重取一次：解析状态可能刚变化，顺便恢复轮询。
  void openDocuments(company);
}
/** 首次拿到公司列表时把工作台落到主档案，并自动拉一次事实。 */
function syncPanelState(): void {
  const primary = primaryCompany.value;
  if (!primary) {
    panelCompanyId.value = null;
    panelInitialized.value = false;
    return;
  }
  if (panelCompanyId.value && !companies.value.some((row) => row.id === panelCompanyId.value)) {
    panelCompanyId.value = primary.id ?? null;
    panelInitialized.value = false;
  }
  if (panelInitialized.value) return;
  panelInitialized.value = true;
  panelCompanyId.value = primary.id ?? null;
  if (primary.id) void openClaims(primary);
}

const hasOnboardingCompany = computed(() =>
  companies.value.some((company) => company.id === primaryCompanyId.value),
);
const primaryBadgeLabel = computed(() =>
  hasOnboardingCompany.value
    ? $t('gainos.companies.primaryBadge')
    : $t('gainos.companies.primaryBadgeFallback'),
);

const statusOptions = computed(() =>
  STATUS_FILTERS.map((status) => ({
    label:
      status === 'ALL'
        ? $t('gainos.companies.filterAll')
        : status === 'FAILED'
          ? $t('gainos.companies.statusFailed')
          : statusLabel(status),
    value: status,
  })),
);

function companyTitle(company: CompanyProfile): string {
  return (
    company.name ??
    company.domain ??
    company.website ??
    $t('gainos.companies.unnamed')
  );
}
function companyInitial(company: CompanyProfile): string {
  return Array.from(companyTitle(company))[0]?.toUpperCase() ?? '?';
}
function companyStatus(company: CompanyProfile): string {
  return understandingFailed(company)
    ? $t('gainos.companies.statusFailed')
    : statusLabel(company.status);
}
function companyTone(
  company: CompanyProfile,
): 'danger' | 'info' | 'neutral' | 'success' | 'warning' {
  if (understandingFailed(company)) return 'danger';
  switch (company.status) {
    case 'ACTIVE': {
      return 'success';
    }
    case 'ENRICHING': {
      return 'info';
    }
    case 'DRAFT':
    case 'REVIEW': {
      return 'warning';
    }
    default: {
      return 'neutral';
    }
  }
}
function companyTags(company: CompanyProfile): string[] {
  return [
    company.industry ?? '',
    ...(company.targetMarkets ?? []).slice(0, 4),
  ].filter(Boolean);
}
function summaryOf(company: CompanyProfile): CompanyCompleteness | null {
  return summaries.value[company.id ?? ''] ?? null;
}
function icpsOf(company: CompanyProfile): Icp[] {
  return icps.value.filter((icp) => icp.companyId === company.id);
}
const primaryIcps = computed(() =>
  primaryCompany.value ? icpsOf(primaryCompany.value) : [],
);
const activePrimaryIcp = computed(
  () => primaryIcps.value.find((icp) => icp.status === 'ACTIVE') ?? null,
);
function icpSummary(company: CompanyProfile): string {
  const list = icpsOf(company);
  const active = list.find((icp) => icp.status === 'ACTIVE');
  if (active) return $t('gainos.companies.icpActive', { name: active.name });
  if (list.length > 0) return $t('gainos.companies.icpCount', { count: list.length });
  return $t('gainos.companies.icpNone');
}

/** 主档案的「下一步」：按状态与事实进度给唯一明确的动作，而不是让用户自己找。 */
type NextAction = 'edit' | 'facts' | 'go' | 'refresh';
const nextStep = computed<{
  action: NextAction;
  desc: string;
  label: string;
  title: string;
}>(() => {
  const company = primaryCompany.value;
  const summary = company ? summaryOf(company) : null;
  const pending = summary?.pendingClaims ?? 0;
  const approved = summary?.approvedClaims ?? 0;
  const conflicts = summary?.conflictsOpen ?? 0;
  if (company && understandingFailed(company)) {
    return {
      action: 'edit',
      desc: $t('gainos.companies.stepEditDesc'),
      label: $t('gainos.companies.edit'),
      title: $t('gainos.companies.stepEdit'),
    };
  }
  if (!company || company.status === 'DRAFT') {
    return {
      action: 'edit',
      desc: $t('gainos.companies.stepEditDesc'),
      label: $t('gainos.companies.edit'),
      title: $t('gainos.companies.stepEdit'),
    };
  }
  if (company.status === 'ENRICHING') {
    return {
      action: 'refresh',
      desc: $t('gainos.companies.stepEnrichingDesc'),
      label: $t('gainos.common.refresh'),
      title: $t('gainos.companies.stepEnriching'),
    };
  }
  if (conflicts > 0) {
    return {
      action: 'facts',
      desc: $t('gainos.companies.stepConflictsDesc', { count: conflicts }),
      label: $t('gainos.companies.openFacts'),
      title: $t('gainos.companies.stepConflicts'),
    };
  }
  if (pending > 0) {
    return {
      action: 'facts',
      desc: $t('gainos.companies.stepFactsDesc', { count: pending }),
      label: $t('gainos.companies.openFacts'),
      title: $t('gainos.companies.stepFacts'),
    };
  }
  if (approved === 0) {
    return {
      action: 'facts',
      desc: $t('gainos.companies.stepFactsNone'),
      label: $t('gainos.companies.openFacts'),
      title: $t('gainos.companies.stepFacts'),
    };
  }
  if (primaryIcps.value.length === 0) {
    return {
      action: 'go',
      desc: $t('gainos.companies.stepReady', { count: approved }),
      label: $t('gainos.companies.goIcp'),
      title: $t('gainos.companies.stepProfileReady'),
    };
  }
  return {
    action: 'go',
    desc: activePrimaryIcp.value
      ? $t('gainos.companies.icpActive', { name: activePrimaryIcp.value.name })
      : $t('gainos.companies.icpCount', { count: primaryIcps.value.length }),
    label: $t('gainos.companies.viewIcp'),
    title: $t('gainos.companies.stepProfileReady'),
  };
});
function runNextStep(): void {
  const company = primaryCompany.value;
  if (!company) return;
  switch (nextStep.value.action) {
    case 'edit': {
      openEdit(company);
      break;
    }
    case 'facts': {
      showFacts(company);
      break;
    }
    case 'go': {
      goFindBuyers();
      break;
    }
    case 'refresh': {
      void load();
      break;
    }
  }
}

const primaryMenuItems = computed(() => {
  const items: Array<{ key: string; label: string }> = [];
  const company = primaryCompany.value;
  if (!company) return items;
  if (marketContext.value) {
    items.push({ key: 'market', label: $t('gainos.companies.marketCandidates') });
  }
  if (understandingFailed(company)) {
    items.push({ key: 'retry', label: $t('gainos.companies.retryUnderstanding') });
  }
  if (isAdmin.value && company.status === 'REVIEW') {
    items.push({ key: 'confirm', label: $t('gainos.companies.confirm') });
  }
  return items;
});
function onPrimaryMenu(info: { key: number | string }): void {
  const company = primaryCompany.value;
  if (!company) return;
  const key = String(info.key);
  if (key === 'market') openMarketCandidates(company);
  if (key === 'retry') void retryUnderstanding(company);
  if (key === 'confirm') void confirmCompany(company);
}

function relatedMenuItems(company: CompanyProfile): Array<{ key: string; label: string }> {
  const items: Array<{ key: string; label: string }> = [];
  if (company.status === 'DRAFT') items.push({ key: 'edit', label: $t('gainos.companies.edit') });
  if (marketContext.value) items.push({ key: 'market', label: $t('gainos.companies.marketCandidates') });
  if (understandingFailed(company)) items.push({ key: 'retry', label: $t('gainos.companies.retryUnderstanding') });
  if (isAdmin.value && company.status === 'REVIEW') items.push({ key: 'confirm', label: $t('gainos.companies.confirm') });
  if (isAdmin.value && company.status === 'DRAFT') items.push({ key: 'delete', label: $t('gainos.companies.delete') });
  return items;
}
function onRelatedMenu(info: { key: number | string }, company: CompanyProfile): void {
  const key = String(info.key);
  if (key === 'edit') openEdit(company);
  if (key === 'market') openMarketCandidates(company);
  if (key === 'retry') void retryUnderstanding(company);
  if (key === 'confirm') void confirmCompany(company);
  if (key === 'delete') removeCompany(company);
}

/** 关联公司卡片的主操作：有待审/已通过事实就去看档案，否则先补全资料。 */
function relatedPrimaryAction(company: CompanyProfile): void {
  if (company.status === 'REVIEW' || company.status === 'ACTIVE') showFacts(company);
  else openEdit(company);
}
function relatedPrimaryLabel(company: CompanyProfile): string {
  return company.status === 'REVIEW' || company.status === 'ACTIVE'
    ? $t('gainos.companies.openFacts')
    : $t('gainos.companies.complete');
}

function addRelatedCompany(): void {
  addRelatedOpen.value = true;
}
function continueAddRelated(): void {
  addRelatedOpen.value = false;
  openWizard();
}

async function loadContext(): Promise<void> {
  try {
    const context = await gainosApi.workspaceContext();
    primaryCompanyId.value = context.onboarding?.companyId ?? null;
  } catch {
    primaryCompanyId.value = null;
  }
}
async function loadIcps(): Promise<void> {
  try {
    const data = await gainosApi.icps();
    icps.value = Array.isArray(data) ? data : [];
  } catch {
    icps.value = [];
  }
}
async function loadSummaries(): Promise<void> {
  const ids = companies.value
    .map((company) => company.id)
    .filter((id): id is string => Boolean(id));
  if (ids.length === 0) return;
  const rows = await Promise.all(
    ids.map(async (id) => {
      try {
        return [id, await gainosApi.companyCompleteness(id)] as const;
      } catch {
        return null;
      }
    }),
  );
  const next = { ...summaries.value };
  for (const row of rows) {
    if (row) next[row[0]] = row[1];
  }
  summaries.value = next;
}

const wizardOpen = ref(false);
const creating = ref(false);
const confirmingId = ref<string | null>(null);
const retryingId = ref<string | null>(null);
const form = reactive({ website: '', name: '' });
const formError = ref<string | null>(null);
const createdNotice = ref<string | null>(null);
let pollTimer: ReturnType<typeof setInterval> | null = null;

// ── 企业事实（Claim）审批：只有「已通过」的事实会进入目标客户画像设计 ──
const claimsOpen = ref(false);
const claimsRecoveryReadOnly = ref(false);
let claimsEpoch = 0;
const claimsCompany = ref<CompanyProfile | null>(null);
const claims = ref<CompanyClaim[]>([]);
const claimsLoading = ref(false);
const claimsError = ref<ReturnType<typeof failureText> | null>(null);
const claimTab = ref<ClaimTab>('NEEDS_REVIEW');
const claimQuery = ref('');
const selectedClaimIds = ref<string[]>([]);
const claimBusy = ref<'approve' | 'reject' | null>(null);
const claimProgress = ref('');
const claimActionError = ref<string | null>(null);
const claimNotice = ref<string | null>(null);
const rejectArmed = ref(false);
const companyOverview = ref<CompanyProfile | null>(null);
const completeness = ref<CompanyCompleteness | null>(null);
const offerings = ref<CompanyOffering[]>([]);
const overviewLoading = ref(false);
const overviewError = ref<string | null>(null);
const conflicts = ref<CompanyConflict[]>([]);
const hasOverviewFacts = computed(() => {
  const company = companyOverview.value;
  return Boolean(company?.industry || company?.targetMarkets?.length || company?.website || company?.businessEmail);
});
const pageRoot = ref<HTMLElement | null>(null);
const offeringsOpen = ref(false);
let offeringsDefaultApplied = false;
/** 内容区宽度（不含左右内边距），与容器查询的参照一致。 */
function pageContentWidth(): number {
  const element = pageRoot.value;
  if (!element) return 0;
  const style = getComputedStyle(element);
  return (
    element.clientWidth -
    Number.parseFloat(style.paddingLeft) -
    Number.parseFloat(style.paddingRight)
  );
}
const conflictsLoading = ref(false);
const conflictsError = ref<string | null>(null);
const conflictBusy = ref('');
const revokingId = ref('');
const isAdmin = ref(false);
const manualOpen = ref(false);
const manualStatement = ref('');
const manualEvidence = ref('');
const manualBusy = ref(false);
const manualError = ref<string | null>(null);
const synthBusy = ref(false);

const pendingClaims = computed(() => claims.value.filter((claim) => claim.status === 'NEEDS_REVIEW'));
const approvedClaims = computed(() => claims.value.filter((claim) => claim.status === 'APPROVED'));
const ignoredClaims = computed(() => claims.value.filter((claim) => claim.status === 'REVOKED'));
const approvedCount = computed(() => approvedClaims.value.length);
const visibleClaims = computed(() => {
  const source = claimTab.value === 'NEEDS_REVIEW'
    ? pendingClaims.value
    : claimTab.value === 'APPROVED'
      ? approvedClaims.value
      : ignoredClaims.value;
  const query = claimQuery.value.trim().toLowerCase();
  if (!query) return source;
  return source.filter((claim) =>
    `${claim.statement} ${claim.type} ${claim.factKey ?? ''}`.toLowerCase().includes(query));
});
const allVisibleSelected = computed(() =>
  visibleClaims.value.length > 0 &&
  visibleClaims.value.every((claim) => selectedClaimIds.value.includes(claim.id)));
const selectedCount = computed(() => selectedClaimIds.value.length);

function claimTypeLabel(type: string): string {
  const key = CLAIM_TYPE_KEY[type];
  if (!key) return type;
  const label = $t(key);
  return label === key ? type : label;
}

async function openClaims(company: CompanyProfile, options: { readOnly?: boolean } = {}): Promise<void> {
  if (!company.id) return;
  panelTab.value = 'facts';
  panelCompanyId.value = company.id;
  docsOpen.value = false;
  docsEpoch += 1;
  if (docsTimer) {
    clearInterval(docsTimer);
    docsTimer = null;
  }
  claimsCompany.value = company;
  claimsOpen.value = true;
  claimsStale.value = false;
  claimsRecoveryReadOnly.value = options.readOnly === true;
  claimsEpoch += 1;
  claims.value = [];
  companyOverview.value = null;
  completeness.value = null;
  offerings.value = [];
  conflicts.value = [];
  claimTab.value = 'NEEDS_REVIEW';
  claimQuery.value = '';
  selectedClaimIds.value = [];
  claimActionError.value = null;
  claimNotice.value = null;
  rejectArmed.value = false;
  manualOpen.value = false;
  if (claimsRecoveryReadOnly.value) selectedClaimIds.value = [];
  manualStatement.value = '';
  manualEvidence.value = '';
  manualError.value = null;
  await nextTick();
  factsPanel.value?.focus({ preventScroll: true });
  await Promise.all([loadClaims(), loadCompanyOverview(), loadConflicts()]);
}


function unwrap<T>(value: T | { data?: T }): T {
  const wrapped = value as { data?: T };
  return wrapped?.data ?? (value as T);
}

async function loadCompanyOverview(silent = false): Promise<void> {
  const companyId = claimsCompany.value?.id;
  const epoch = claimsEpoch;
  if (!companyId) return;
  const current = () => claimsCompany.value?.id === companyId && claimsEpoch === epoch;
  // silent：已有数据时原地刷新、不进加载态。审批、生成草稿后的刷新不该让整块概览闪一下。
  if (!silent || !companyOverview.value) overviewLoading.value = true;
  overviewError.value = null;
  try {
    const [detail, stats, items] = await Promise.all([
      gainosApi.companyDetail(companyId),
      gainosApi.companyCompleteness(companyId),
      gainosApi.companyOfferings(companyId),
    ]);
    if (!current()) return;
    companyOverview.value = unwrap(detail);
    completeness.value = unwrap(stats);
    const rows = unwrap(items);
    offerings.value = Array.isArray(rows) ? rows : [];
    // 产品与服务默认是否展开只定一次：宽屏两栏时左栏高度有富余，默认展开让档案一眼看全；
    // 窄屏单栏默认收起，免得把审批清单挤远。900 与 .co-facts 的两栏断点保持一致。
    if (!offeringsDefaultApplied) {
      offeringsDefaultApplied = true;
      offeringsOpen.value = pageContentWidth() >= 900 && offerings.value.length <= 12;
    }
  } catch (err) {
    if (current()) overviewError.value = failureText(err).title;
  } finally {
    if (current()) overviewLoading.value = false;
  }
}

async function loadConflicts(): Promise<void> {
  const companyId = claimsCompany.value?.id;
  const epoch = claimsEpoch;
  if (!companyId) return;
  const current = () => claimsCompany.value?.id === companyId && claimsEpoch === epoch;
  conflictsLoading.value = true;
  conflictsError.value = null;
  try {
    const data = await gainosApi.companyConflicts(companyId);
    if (!current()) return;
    const rows = unwrap(data);
    conflicts.value = (Array.isArray(rows) ? rows : []).filter((item) => !item.status || item.status === 'OPEN');
  } catch (err) {
    if (current()) conflictsError.value = failureText(err).title;
  } finally {
    if (current()) conflictsLoading.value = false;
  }
}

function resolveConflict(conflict: CompanyConflict, keep: 'a' | 'b'): void {
  feedback.confirm({
    cancelText: $t('gainos.common.cancel'),
    content: $t('gainos.companies.conflictConfirm'),
    okText: $t('gainos.companies.confirm'),
    onOk: async () => {
      conflictBusy.value = conflict.id;
      claimActionError.value = null;
      try {
        await gainosApi.resolveConflict(conflict.id, keep);
        claimNotice.value = $t('gainos.companies.conflictResolved');
        await Promise.all([loadClaims(true), loadCompanyOverview(true), loadConflicts()]);
      } catch (err) {
        claimActionError.value = failureText(err).title;
      } finally {
        conflictBusy.value = '';
      }
    },
  });
}

function revokeClaim(claim: CompanyClaim): void {
  feedback.confirm({
    cancelText: $t('gainos.common.cancel'),
    content: $t('gainos.companies.revokeConfirm'),
    okText: $t('gainos.companies.revoke'),
    okType: 'danger',
    onOk: async () => {
      revokingId.value = claim.id;
      claimActionError.value = null;
      try {
        await gainosApi.revokeClaim(claim.id);
        claimNotice.value = $t('gainos.companies.revoked');
        await Promise.all([loadClaims(true), loadCompanyOverview(true), loadConflicts()]);
      } catch (err) {
        claimActionError.value = failureText(err).title;
      } finally {
        revokingId.value = '';
      }
    },
  });
}

async function saveManualClaim(): Promise<void> {
  const companyId = claimsCompany.value?.id;
  const statement = manualStatement.value.trim();
  if (!companyId || !statement) {
    manualError.value = $t('gainos.companies.manualRequired');
    return;
  }
  manualBusy.value = true;
  manualError.value = null;
  try {
    await gainosApi.createClaim(companyId, {
      type: 'company_fact',
      statement,
      ...(manualEvidence.value.trim() ? { evidence: manualEvidence.value.trim() } : {}),
    });
    manualOpen.value = false;
    manualStatement.value = '';
    manualEvidence.value = '';
    claimNotice.value = $t('gainos.companies.manualCreated');
    claimTab.value = 'NEEDS_REVIEW';
    await Promise.all([loadClaims(true), loadCompanyOverview(true)]);
  } catch (err) {
    manualError.value = failureText(err).title;
  } finally {
    manualBusy.value = false;
  }
}

/** P5：把注册引导/档案事实（产品、行业、目标市场）确定性转成待审事实草稿（幂等）。 */
async function synthesizeDrafts(): Promise<void> {
  const companyId = claimsCompany.value?.id;
  if (!companyId || synthBusy.value) return;
  synthBusy.value = true;
  claimActionError.value = null;
  // 上一步的行内结果（如「已通过 N 条」）与本次无关，先撤掉；本次结果用轻提示。
  claimNotice.value = null;
  try {
    const result = unwrap(await gainosApi.synthesizeClaimDrafts(companyId));
    // 结果用轻提示说清楚；清单原地刷新（不进加载态），不会整块先变空再回来。
    if (result.created > 0) {
      claimTab.value = 'NEEDS_REVIEW';
      feedback.message.success(
        $t('gainos.companies.synthesizeDraftsCreated', { count: result.created }),
      );
    } else {
      feedback.message.info($t('gainos.companies.synthesizeDraftsNone'));
    }
    await Promise.all([loadClaims(true), loadCompanyOverview(true)]);
  } catch (err) {
    claimActionError.value = failureText(err).title;
  } finally {
    synthBusy.value = false;
  }
}

async function loadClaims(silent = false): Promise<void> {
  const companyId = claimsCompany.value?.id;
  const epoch = claimsEpoch;
  if (!companyId) return;
  const current = () => claimsCompany.value?.id === companyId && claimsEpoch === epoch;
  // silent：已有数据时原地刷新、不进加载态，清单不会先变成「加载中」再回来。
  if (!silent || claims.value.length === 0) claimsLoading.value = true;
  claimsError.value = null;
  try {
    const data = await gainosApi.claims(companyId);
    if (!current()) return;
    // BFF/引擎的列表响应可能已由 request.ts 解包，也可能仍是 { data }。
    claims.value = Array.isArray(data) ? data : ((data as unknown as { data?: CompanyClaim[] })?.data ?? []);
    selectedClaimIds.value = selectedClaimIds.value.filter((id) =>
      claims.value.some((claim) => claim.id === id && claim.status === 'NEEDS_REVIEW'));
  } catch (err) {
    if (current()) {
      claimsError.value = failureText(err);
      claims.value = [];
    }
  } finally {
    if (current()) claimsLoading.value = false;
  }
}

function switchClaimTab(tab: ClaimTab): void {
  if (claimBusy.value) return;
  claimTab.value = tab;
  claimQuery.value = '';
  selectedClaimIds.value = [];
  rejectArmed.value = false;
  claimActionError.value = null;
  claimNotice.value = null;
}

function toggleClaim(claimId: string): void {
  selectedClaimIds.value = selectedClaimIds.value.includes(claimId)
    ? selectedClaimIds.value.filter((id) => id !== claimId)
    : [...selectedClaimIds.value, claimId];
  rejectArmed.value = false;
  claimActionError.value = null;
}

function toggleAllVisible(): void {
  const visibleIds = visibleClaims.value
    .filter((claim) => claim.status === 'NEEDS_REVIEW')
    .map((claim) => claim.id);
  if (allVisibleSelected.value) {
    selectedClaimIds.value = selectedClaimIds.value.filter((id) => !visibleIds.includes(id));
  } else {
    selectedClaimIds.value = [...new Set([...selectedClaimIds.value, ...visibleIds])];
  }
  rejectArmed.value = false;
  claimActionError.value = null;
}

async function reviewSelected(action: 'approve' | 'reject'): Promise<void> {
  if (claimBusy.value || selectedClaimIds.value.length === 0) return;
  if (action === 'reject' && !rejectArmed.value) {
    rejectArmed.value = true;
    return;
  }
  const ids = [...selectedClaimIds.value];
  const total = ids.length;
  claimBusy.value = action;
  rejectArmed.value = false;
  claimActionError.value = null;
  claimNotice.value = null;
  claimProgress.value = `0/${total}`;
  let done = 0;
  let failed = 0;
  const queue = [...ids];
  const worker = async (): Promise<void> => {
    for (;;) {
      const id = queue.shift();
      if (!id) return;
      try {
        if (action === 'approve') await gainosApi.approveClaim(id);
        else await gainosApi.rejectClaim(id);
      } catch {
        failed += 1;
      } finally {
        done += 1;
        claimProgress.value = `${done}/${total}`;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, total) }, () => worker()));
  selectedClaimIds.value = [];
  claimBusy.value = null;
  claimProgress.value = '';
  // 审批后清单原地进行刷新，已勾选项消失即可，不闪「加载中」。
  await loadClaims(true);
  // 审批达 3 条通过会把企业自动激活（REVIEW→ACTIVE）：列表状态必须跟上，
  // 否则卡片仍显示「待确认」，再点「确认档案」会撞 INVALID_STATE。
  if (action === 'approve' && failed < total) void load(true);
  if (failed > 0) {
    claimActionError.value = $t('gainos.companies.claimsPartialFail', { count: failed });
  } else {
    claimNotice.value = action === 'approve'
      ? $t('gainos.companies.claimsApproved', { count: total })
      : $t('gainos.companies.claimsRejected', { count: total });
  }
}

function goFindBuyers(): void {
  claimsOpen.value = false;
  void router.push('/find-buyers');
}

function schedulePoll(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (companies.value.some((company) => company.status === 'ENRICHING')) {
    pollTimer = setInterval(() => {
      void load(true);
    }, 8_000);
  }
}

async function load(silent = false): Promise<void> {
  if (!silent) loading.value = true;
  error.value = null;
  try {
    const data = await gainosApi.companies();
    companies.value = Array.isArray(data) ? data : (data?.data ?? []);
    syncPanelState();
    void loadSummaries();
  } catch (err) {
    error.value = failureText(err).title;
  } finally {
    loading.value = false;
    schedulePoll();
  }
}

function statusLabel(status?: string): string {
  const key = STATUS_KEY[status ?? 'DRAFT'];
  if (!key) return status ?? '';
  const label = $t(key);
  return label === key ? (status ?? '') : label;
}

function understandingFailed(company: CompanyProfile): boolean {
  return company.status === 'DRAFT' && Boolean(company.understandingFailedAt);
}

async function retryUnderstanding(company: CompanyProfile): Promise<void> {
  const companyId = company.id;
  if (!companyId || retryingId.value) return;
  retryingId.value = companyId;
  error.value = null;
  try {
    // 每次点击生成新的幂等键：引擎按它分配独立的请求作用域与预算账户，
    // 失败后的再次重试不会撞上「授权已使用过」。
    await gainosApi.retryCompanyUnderstanding(companyId, newAttemptId());
    await load(true);
    // 工作流把状态翻到 ENRICHING 需要几秒；补一次延迟刷新，让轮询接管。
    setTimeout(() => void load(true), 3_000);
  } catch (err) {
    error.value = failureText(err).title;
  } finally {
    retryingId.value = null;
  }
}

// ── 档案编辑 / 软删除 / 自动找官网（2026-11-03）─────────────────────────────
const editOpen = ref(false);
const editCompany = ref<CompanyProfile | null>(null);
const editSaving = ref(false);
const editError = ref<string | null>(null);
const editForm = reactive({ name: '', website: '', industry: '', businessEmail: '', markets: '' });
const candidates = ref<WebsiteCandidate[]>([]);
const candidatesLoading = ref(false);
const candidatesError = ref<string | null>(null);
const deletingId = ref<string | null>(null);
const startingUnderstandingId = ref<string | null>(null);

function openEdit(company: CompanyProfile): void {
  if (company.status !== 'DRAFT') {
    error.value = $t('gainos.companies.editNotAllowed');
    return;
  }
  editCompany.value = company;
  editForm.name = company.name ?? '';
  editForm.website = company.website ?? '';
  editForm.industry = company.industry ?? '';
  editForm.businessEmail = company.businessEmail ?? '';
  editForm.markets = (company.targetMarkets ?? []).join(', ');
  candidates.value = [];
  candidatesError.value = null;
  editError.value = null;
  editOpen.value = true;
}

function parseMarkets(raw: string): string[] | null {
  const items = raw.split(/[,，\s]+/u).map((item) => item.trim().toUpperCase()).filter(Boolean);
  if (items.length === 0) return [];
  if (items.length > 30 || !items.every((item) => /^[A-Z]{2}$/u.test(item))) return null;
  return [...new Set(items)];
}

async function findCandidates(): Promise<void> {
  const companyId = editCompany.value?.id;
  if (!companyId) return;
  candidatesLoading.value = true;
  candidatesError.value = null;
  try {
    const data = await gainosApi.companyWebsiteCandidates(companyId);
    candidates.value = data ?? [];
    if (candidates.value.length === 0) candidatesError.value = $t('gainos.companies.autoFindEmpty');
  } catch {
    candidatesError.value = $t('gainos.companies.autoFindFailed');
  } finally {
    candidatesLoading.value = false;
  }
}

function useCandidate(candidate: WebsiteCandidate): void {
  editForm.website = candidate.url;
}

async function startUnderstanding(companyId: string): Promise<void> {
  startingUnderstandingId.value = companyId;
  createdNotice.value = $t('gainos.companies.startUnderstanding');
  try {
    await gainosApi.retryCompanyUnderstanding(companyId, newAttemptId());
    createdNotice.value = $t('gainos.companies.understandingQueued');
  } catch (err) {
    createdNotice.value = $t('gainos.companies.understandingStartFailed', {
      reason: failureText(err).title,
    });
  } finally {
    startingUnderstandingId.value = null;
    await load(true);
    setTimeout(() => void load(true), 3_000);
  }
}

async function saveEdit(): Promise<void> {
  editError.value = null;
  const companyId = editCompany.value?.id;
  if (!companyId) return;
  const website = editForm.website.trim();
  if (website && !/^https?:\/\/.+/i.test(website)) {
    editError.value = $t('gainos.companies.errWebsiteInvalid');
    return;
  }
  const markets = parseMarkets(editForm.markets);
  if (markets === null) {
    editError.value = $t('gainos.companies.targetMarketsInvalid');
    return;
  }
  const payload: UpdateCompanyInput = {};
  if (editForm.name.trim()) payload.name = editForm.name.trim();
  if (website) payload.website = website;
  if (editForm.industry.trim()) payload.industry = editForm.industry.trim();
  if (editForm.businessEmail.trim()) payload.businessEmail = editForm.businessEmail.trim();
  if (markets.length > 0) payload.targetMarkets = markets;
  const websiteNewlySet = !editCompany.value?.website && Boolean(website);
  editSaving.value = true;
  try {
    await gainosApi.updateCompany(companyId, payload);
    editOpen.value = false;
    createdNotice.value = $t('gainos.companies.saved');
    if (websiteNewlySet) {
      await startUnderstanding(companyId);
    } else {
      await load();
    }
  } catch (err) {
    editError.value = failureText(err).title;
  } finally {
    editSaving.value = false;
  }
}

function removeCompany(company: CompanyProfile): void {
  const companyId = company.id;
  if (!companyId) return;
  feedback.confirm({
    cancelText: $t('gainos.common.cancel'),
    content: $t('gainos.companies.deleteConfirm'),
    okText: $t('gainos.companies.delete'),
    okType: 'danger',
    onOk: async () => {
      deletingId.value = companyId;
      error.value = null;
      try {
        await gainosApi.deleteCompany(companyId);
        createdNotice.value = $t('gainos.companies.deleted');
        await load();
      } catch (err) {
        error.value = failureText(err).title || $t('gainos.companies.deleteFailed');
      } finally {
        deletingId.value = null;
      }
    },
  });
}

// ── 资料库（Phase 2c）：上传（引擎中转）→ 解析 → 检索 ─────────────────────────
const docsOpen = ref(false);
const docsFileInput = ref<HTMLInputElement | null>(null);
const docsRecoveryReadOnly = ref(false);
let docsEpoch = 0;
let docsSearchSeq = 0;
const docsCompany = ref<CompanyProfile | null>(null);
const docs = ref<SellerDocument[]>([]);
const docsCursor = ref<string | undefined>(undefined);
const docsHasMore = ref(false);
const docsLoading = ref(false);
const docsError = ref<string | null>(null);
const docsUploading = ref(false);
const docsNotice = ref<string | null>(null);
const docsQuery = ref('');
const docsHits = ref<Array<{ documentId: string; filename: string; seq: number; text: string; score: number }>>([]);
const docsSearching = ref(false);
const downloadingDocId = ref<string | null>(null);
let docsTimer: ReturnType<typeof setInterval> | null = null;

// ── 文档分段提炼企业事实（chunks/:seq → claim-previews → claim-drafts）──
const utf8Encoder = new TextEncoder();
const extractOpen = ref(false);
const extractCompanyId = ref<string | null>(null);
const extractDoc = ref<{ id: string; filename: string; chunkCount?: number } | null>(null);
const extractSeq = ref(0);
const extractChunk = ref<DocumentChunkView | null>(null);
const extractLoading = ref(false);
const extractError = ref<string | null>(null);
const extractQuote = ref('');
const extractType = ref('capability');
const extractStatement = ref('');
const extractPreview = ref<DocumentClaimPreview | null>(null);
const extractPreviewBusy = ref(false);
const extractSaveBusy = ref(false);
let extractEpoch = 0;

const extractTypeOptions = computed(() =>
  Object.entries(CLAIM_TYPE_KEY).map(([value, key]) => ({
    value,
    label: $t(key),
  })),
);

const extractPageNumber = computed<number | null>(() => {
  const page = extractChunk.value?.context?.page;
  return typeof page === 'number' && Number.isFinite(page) ? page : null;
});

watch([extractQuote, extractType, extractStatement], () => {
  extractPreview.value = null;
  extractError.value = null;
});

function findUtf8ByteRange(haystack: string, needle: string): { startByte: number; endByte: number } | null {
  if (!needle) return null;
  let match = needle;
  let charIdx = haystack.indexOf(match);
  if (charIdx < 0 && needle.trim() !== needle) {
    match = needle.trim();
    charIdx = match ? haystack.indexOf(match) : -1;
  }
  if (charIdx < 0) return null;
  const startByte = utf8Encoder.encode(haystack.slice(0, charIdx)).byteLength;
  const endByte = startByte + utf8Encoder.encode(match).byteLength;
  return { startByte, endByte };
}

async function loadExtractChunk(seq: number): Promise<void> {
  const companyId = extractCompanyId.value;
  const doc = extractDoc.value;
  if (!companyId || !doc) return;
  const epoch = ++extractEpoch;
  extractLoading.value = true;
  extractError.value = null;
  extractPreview.value = null;
  extractChunk.value = null;
  try {
    const chunk = await gainosApi.sellerDocumentChunk(companyId, doc.id, seq);
    if (epoch !== extractEpoch) return;
    extractChunk.value = chunk;
    extractSeq.value = chunk.chunkSeq;
    extractQuote.value = Array.from(chunk.text).slice(0, 300).join('');
  } catch (err) {
    if (epoch === extractEpoch) {
      const detail = failureText(err);
      extractError.value = detail.next ? `${detail.title} —— ${detail.next}` : detail.title;
    }
  } finally {
    if (epoch === extractEpoch) extractLoading.value = false;
  }
}

function openExtractModal(doc: { id: string; filename: string; chunkCount?: number }, seq = 0): void {
  const companyId = docsCompany.value?.id;
  if (!companyId) return;
  extractCompanyId.value = companyId;
  extractDoc.value = { id: doc.id, filename: doc.filename, chunkCount: doc.chunkCount };
  extractSeq.value = seq;
  extractStatement.value = '';
  extractQuote.value = '';
  extractPreview.value = null;
  extractError.value = null;
  extractOpen.value = true;
  void loadExtractChunk(seq);
}

async function runExtractPreview(): Promise<void> {
  const companyId = extractCompanyId.value;
  const doc = extractDoc.value;
  const chunk = extractChunk.value;
  if (!companyId || !doc || !chunk || extractPreviewBusy.value) return;
  extractError.value = null;
  const statement = extractStatement.value.trim();
  if (!statement) {
    extractError.value = $t('gainos.companies.chunkStatementRequired');
    return;
  }
  const range = findUtf8ByteRange(chunk.text, extractQuote.value);
  if (!range) {
    extractError.value = $t('gainos.companies.chunkQuoteNotFound');
    return;
  }
  extractPreviewBusy.value = true;
  try {
    extractPreview.value = await gainosApi.previewSellerDocumentClaim(companyId, doc.id, {
      reference: {
        documentId: chunk.documentId,
        documentContentHash: chunk.documentContentHash,
        parseRevision: chunk.parseRevision,
        chunkSeq: chunk.chunkSeq,
        chunkTextHash: chunk.chunkTextHash,
        quoteStartByte: range.startByte,
        quoteEndByte: range.endByte,
      },
      type: extractType.value,
      statement,
    });
  } catch (err) {
    extractPreview.value = null;
    const detail = failureText(err);
    extractError.value = detail.next ? `${detail.title} —— ${detail.next}` : detail.title;
  } finally {
    extractPreviewBusy.value = false;
  }
}

async function saveExtractDraft(): Promise<void> {
  const companyId = extractCompanyId.value;
  const doc = extractDoc.value;
  const chunk = extractChunk.value;
  const preview = extractPreview.value;
  if (!companyId || !doc || !chunk || !preview || extractSaveBusy.value) return;
  const range = findUtf8ByteRange(chunk.text, extractQuote.value);
  if (!range) {
    extractError.value = $t('gainos.companies.chunkQuoteNotFound');
    extractPreview.value = null;
    return;
  }
  extractSaveBusy.value = true;
  extractError.value = null;
  try {
    const draft = await gainosApi.createSellerDocumentClaimDraft(companyId, doc.id, {
      reference: {
        documentId: chunk.documentId,
        documentContentHash: chunk.documentContentHash,
        parseRevision: chunk.parseRevision,
        chunkSeq: chunk.chunkSeq,
        chunkTextHash: chunk.chunkTextHash,
        quoteStartByte: range.startByte,
        quoteEndByte: range.endByte,
      },
      type: extractType.value,
      statement: extractStatement.value.trim(),
      requestDigest: preview.requestDigest,
    });
    feedback.message.success(
      draft.replayed ? $t('gainos.companies.chunkDraftReplayed') : $t('gainos.companies.chunkDraftCreated'),
    );
    claimsStale.value = true;
    extractOpen.value = false;
    void loadSummaries();
    if (claimsCompany.value?.id === companyId) void loadClaims();
  } catch (err) {
    const detail = failureText(err);
    extractError.value = detail.next ? `${detail.title} —— ${detail.next}` : detail.title;
  } finally {
    extractSaveBusy.value = false;
  }
}

const DOC_MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  md: 'text/markdown',
};

const DOC_STATUS_KEY: Record<string, string> = {
  pending_upload: 'gainos.companies.documentStatusPending',
  committing: 'gainos.companies.documentStatusQueued',
  queued: 'gainos.companies.documentStatusQueued',
  processing: 'gainos.companies.documentStatusProcessing',
  ready: 'gainos.companies.documentStatusReady',
  failed_terminal: 'gainos.companies.documentStatusFailed',
  rejected: 'gainos.companies.documentStatusRejected',
};

function docMime(file: File): string | null {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return DOC_MIME_BY_EXT[ext] ?? (file.type && file.type in Object.fromEntries(Object.values(DOC_MIME_BY_EXT).map((m) => [m, 1])) ? file.type : null);
}

function docSizeLabel(row: SellerDocument): string {
  const bytes = Number(row.sizeBytes ?? 0);
  if (!bytes) return '';
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

function docStatusLabel(status: string): string {
  return $t(DOC_STATUS_KEY[status] ?? 'gainos.companies.documentStatusQueued');
}

async function openDocuments(company: CompanyProfile, options: { readOnly?: boolean } = {}): Promise<void> {
  panelTab.value = 'docs';
  panelCompanyId.value = company.id ?? null;
  claimsOpen.value = false;
  claimsEpoch += 1;
  claimsStale.value = true;
  docsCompany.value = company;
  docsOpen.value = true;
  docsRecoveryReadOnly.value = options.readOnly === true;
  docsEpoch += 1;
  const epoch = docsEpoch;
  docsSearchSeq += 1;
  docsSearching.value = false;
  docsLoading.value = false;
  docs.value = [];
  await nextTick();
  if (!docsOpen.value || docsEpoch !== epoch || docsCompany.value?.id !== company.id) return;
  docsPanel.value?.focus({ preventScroll: true });
  docsError.value = null;
  docsNotice.value = null;
  docsQuery.value = '';
  docsHits.value = [];
  docsCursor.value = undefined;
  docsHasMore.value = false;
  await loadDocuments(true, true);
  // 一次打开只安装自己的轮询；迟到初始化不得在关闭/切换后留下 interval。
  if (!docsOpen.value || docsEpoch !== epoch || docsCompany.value?.id !== company.id) return;
  let timer: ReturnType<typeof setInterval> | null = null;
  timer = setInterval(() => {
    if (!docsOpen.value || docsEpoch !== epoch || docsTimer !== timer) {
      clearInterval(timer!);
      if (docsTimer === timer) docsTimer = null;
      return;
    }
    const busy = docs.value.some((row) => ['pending_upload', 'committing', 'queued', 'processing'].includes(row.status));
    if (busy) {
      void loadDocuments(true);
      return;
    }
    clearInterval(timer!);
    if (docsTimer === timer) docsTimer = null;
  }, 10_000);
  docsTimer = timer;
}


async function loadDocuments(silent = false, reset = true): Promise<void> {
  const companyId = docsCompany.value?.id;
  const epoch = docsEpoch;
  if (!companyId) return;
  const current = () => docsCompany.value?.id === companyId && docsEpoch === epoch;
  if (!silent) docsLoading.value = true;
  try {
    // P5b-09：资料库改游标分页；reset 拉第一页，否则按 docsCursor 追加。
    const page = await gainosApi.sellerDocuments(companyId, reset ? undefined : docsCursor.value);
    if (!current()) return;
    const rows = page?.data ?? [];
    docs.value = reset ? rows : [...docs.value, ...rows];
    docsCursor.value = page?.page?.next_cursor ?? undefined;
    docsHasMore.value = Boolean(page?.page?.has_more && page?.page?.next_cursor);
    docsError.value = null;
  } catch (err) {
    if (current() && !silent) docsError.value = failureText(err).title;
  } finally {
    if (current()) docsLoading.value = false;
  }
}

async function uploadDocument(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  const companyId = docsCompany.value?.id;
  input.value = '';
  if (!file || !companyId) return;
  const mime = docMime(file);
  if (!mime) {
    docsNotice.value = $t('gainos.companies.uploadFailed', { reason: $t('gainos.companies.uploadFormats') });
    return;
  }
  docsUploading.value = true;
  docsNotice.value = null;
  try {
    const signed = await gainosApi.presignSellerDocument(companyId, {
      filename: file.name,
      mime,
      size: file.size,
    });
    const put = await fetch(`/api/companies/${companyId}/seller-documents/${signed.documentId}/content`, {
      method: 'PUT',
      headers: { 'content-type': mime },
      body: file,
    });
    if (!put.ok) throw new Error(`upload ${put.status}`);
    await gainosApi.commitSellerDocument(companyId, signed.documentId);
    docsNotice.value = $t('gainos.companies.uploadDone');
    await loadDocuments();
  } catch (err) {
    docsNotice.value = $t('gainos.companies.uploadFailed', { reason: failureText(err).title });
  } finally {
    docsUploading.value = false;
  }
}

async function searchDocuments(): Promise<void> {
  const companyId = docsCompany.value?.id;
  const q = docsQuery.value.trim();
  if (!companyId || q.length < 2) return;
  const epoch = docsEpoch;
  const seq = ++docsSearchSeq;
  const sameScope = () => docsCompany.value?.id === companyId && docsEpoch === epoch && docsSearchSeq === seq;
  docsSearching.value = true;
  docsError.value = null;
  try {
    const hits = (await gainosApi.searchSellerDocuments(companyId, q)) ?? [];
    if (!sameScope() || docsQuery.value.trim() !== q) return;
    docsHits.value = hits;
  } catch (err) {
    if (sameScope() && docsQuery.value.trim() === q) {
      docsError.value = failureText(err).title;
      docsHits.value = [];
    }
  } finally {
    if (sameScope()) docsSearching.value = false;
  }
}

async function retryDocument(row: SellerDocument): Promise<void> {
  try {
    await gainosApi.retrySellerDocument(row.id);
    docsNotice.value = $t('gainos.companies.documentRetryDone');
    await loadDocuments();
  } catch (err) {
    docsError.value = failureText(err).title;
  }
}

async function downloadDocument(row: SellerDocument): Promise<void> {
  if (downloadingDocId.value) return;
  downloadingDocId.value = row.id;
  docsError.value = null;
  try {
    const filename = await gainosApi.downloadSellerDocument(row.id, row.filename);
    feedback.message.success($t('gainos.companies.downloadDone', { name: filename }));
  } catch (err) {
    const detail = failureText(err);
    docsError.value = detail.next ? `${detail.title} —— ${detail.next}` : detail.title;
    feedback.message.error(detail.title);
  } finally {
    downloadingDocId.value = null;
  }
}

function removeDocument(row: SellerDocument): void {
  feedback.confirm({
    cancelText: $t('gainos.common.cancel'),
    content: $t('gainos.companies.documentDeleteConfirm'),
    okText: $t('gainos.companies.delete'),
    okType: 'danger',
    onOk: async () => {
      try {
        await gainosApi.deleteSellerDocument(row.id);
        docsNotice.value = $t('gainos.companies.documentDeleted');
        await loadDocuments();
      } catch (err) {
        docsError.value = failureText(err).title;
      }
    },
  });
}

async function confirmCompany(company: CompanyProfile): Promise<void> {
  const companyId = company.id;
  if (!companyId) return;
  confirmingId.value = companyId;
  error.value = null;
  try {
    await gainosApi.confirmCompany(companyId);
    await load();
  } catch (err) {
    // 事实审批达阈值会自动激活（引擎 claim 审批事务内 REVIEW→ACTIVE），
    // 列表还停在旧的「待确认」时点确认会撞 INVALID_STATE——此时操作其实已完成。
    const payload = (err as { response?: { data?: { error?: { code?: string; message?: string }; meta?: { engineCode?: string; engineMessage?: string } } } })?.response?.data;
    const detail = payload?.error;
    const code = detail?.code ?? payload?.meta?.engineCode;
    const engineMessage = detail?.message ?? payload?.meta?.engineMessage ?? '';
    if (code === 'INVALID_STATE' && engineMessage.includes('company is ACTIVE')) {
      createdNotice.value = $t('gainos.companies.autoActivated');
      await load();
    } else {
      error.value = failureText(err).title;
    }
  } finally {
    confirmingId.value = null;
  }
}

function openWizard(): void {
  form.website = '';
  form.name = '';
  formError.value = null;
  wizardOpen.value = true;
}

async function create(): Promise<void> {
  formError.value = null;
  const website = form.website.trim();
  const name = form.name.trim();
  if (!website && !name) {
    formError.value = $t('gainos.companies.errNameOrWebsite');
    return;
  }
  if (website && !/^https?:\/\/.+/i.test(website)) {
    formError.value = $t('gainos.companies.errWebsiteInvalid');
    return;
  }
  creating.value = true;
  try {
    const created = await gainosApi.createCompany({
      ...(website ? { website } : {}),
      ...(name ? { name } : {}),
    });
    // BFF 返回引擎信封；兼容直接返回实体的情况。
    const detail = (created as unknown as { data?: CompanyProfile })?.data ?? created;
    wizardOpen.value = false;
    createdNotice.value = detail?.understanding === 'not_started'
      ? $t('gainos.companies.createdNoUnderstanding')
      : $t('gainos.companies.created');
    await load();
  } catch (err) {
    formError.value = failureText(err).title;
  } finally {
    creating.value = false;
  }
}

function onEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  if (wizardOpen.value) wizardOpen.value = false;
}
onMounted(async () => {
  window.addEventListener('keydown', onEscape);
  try {
    const session = await gainosApi.session();
    isAdmin.value = session.workspace?.role === 'admin';
    marketContext.value = JSON.stringify([session.workspace.id, session.user.id]);
  } catch {
    isAdmin.value = false;
  }
  await Promise.allSettled([loadContext(), loadIcps()]);
  await load();
});
onActivated(() => {
  // 从「找买家」回来时，目标客户画像可能刚变化：刷新画像与事实计数。
  if (!loading.value) {
    void loadIcps();
    void loadSummaries();
  }
});
onUnmounted(() => {
  window.removeEventListener('keydown', onEscape);
  if (pollTimer) clearInterval(pollTimer);
  docsEpoch += 1;
  docsSearchSeq += 1;
  claimsEpoch += 1;
  if (docsTimer) clearInterval(docsTimer);
});
</script>

<template>
  <div
    ref="pageRoot"
    class="mx-auto grid w-full max-w-[var(--gs-page-max)] grid-cols-1 gap-3 px-[var(--gs-page-pad)] pb-12 @container"
    data-gs="companies-page"
  >
    <GsPage
      art="company"
      :subtitle="$t('gainos.companies.subtitle')"
      :title="$t('gainos.companies.title')"
    />

    <!-- 内容压在页头渐变上（与买家线索/找买家同一层次处理） -->
    <div class="relative z-[1] -mt-12 grid gap-3">
    <Alert
      v-if="createdNotice"
      :message="createdNotice"
      closable
      data-gs="companies-notice"
      role="status"
      show-icon
      type="success"
      @close="createdNotice = null"
    />

    <GsCard v-if="loading" data-gs="companies-loading">
      <Skeleton active :paragraph="{ rows: 4 }" />
      <span class="co-sr-only">{{ $t('gainos.companies.loading') }}</span>
    </GsCard>

    <div v-else-if="error" class="grid gap-3" data-gs="companies-error">
      <ErrorNotice :next="$t('gainos.companies.errorWhy')" :title="error" />
      <Button class="justify-self-start" @click="load()">
        {{ $t('gainos.common.retry') }}
      </Button>
    </div>

    <GsCard v-else-if="!primaryCompany" data-gs="companies-empty">
      <GsEmpty
        simple
        :description="$t('gainos.companies.emptyDesc')"
        :title="$t('gainos.companies.emptyTitle')"
      >
        <template #actions>
          <Button type="primary" @click="openWizard">
            {{ $t('gainos.companies.emptyCta') }}
          </Button>
          <Button @click="router.push('/leads')">{{ $t('gainos.leads.title') }}</Button>
          <Button @click="router.push(isAdmin ? '/settings/sources' : '/tasks')">
            {{ isAdmin ? $t('gainos.sources.title') : $t('gainos.tasks.title') }}
          </Button>
        </template>
      </GsEmpty>
    </GsCard>

    <template v-else>
      <!-- 主档案：注册时填写的公司。所有寻源都基于这份档案。 -->
      <GsCard class="co-primary" data-gs="primary-company" padding="0">
        <div class="co-primary__body">
          <div class="co-primary__grid">
            <div class="co-primary__identity">
              <span aria-hidden="true" class="co-logo">
                {{ companyInitial(primaryCompany) }}
              </span>
              <div class="min-w-0">
                <div class="co-primary__title">
                  <h2>{{ companyTitle(primaryCompany) }}</h2>
                  <Tag :bordered="false" class="co-badge">
                    {{ primaryBadgeLabel }}
                  </Tag>
                  <GsTag :tone="companyTone(primaryCompany)">
                    {{ companyStatus(primaryCompany) }}
                  </GsTag>
                </div>
                <p class="co-muted">
                  {{ primaryCompany.website || primaryCompany.domain || $t('gainos.companies.noWebsite') }}
                </p>
                <div v-if="companyTags(primaryCompany).length" class="co-tags">
                  <Tag
                    v-for="tag in companyTags(primaryCompany)"
                    :key="tag"
                    :bordered="false"
                    class="co-chip"
                  >
                    {{ tag }}
                  </Tag>
                </div>
              </div>
            </div>

            <div class="co-primary__kpis">
              <button class="co-kpi" type="button" @click="showFacts(primaryCompany)">
                <strong>{{ summaryOf(primaryCompany)?.approvedClaims ?? '—' }}</strong>
                <span>{{ $t('gainos.companies.statApproved') }}</span>
              </button>
              <button class="co-kpi" type="button" @click="showFacts(primaryCompany)">
                <strong>{{ summaryOf(primaryCompany)?.pendingClaims ?? '—' }}</strong>
                <span>{{ $t('gainos.companies.statPending') }}</span>
              </button>
              <button class="co-kpi" type="button" @click="showFacts(primaryCompany)">
                <strong>{{ summaryOf(primaryCompany)?.offerings ?? '—' }}</strong>
                <span>{{ $t('gainos.companies.statOfferings') }}</span>
              </button>
              <button class="co-kpi" type="button" @click="showFacts(primaryCompany)">
                <strong>{{ summaryOf(primaryCompany)?.conflictsOpen ?? '—' }}</strong>
                <span>{{ $t('gainos.companies.statConflicts') }}</span>
              </button>
            </div>

            <!-- 档案已就绪时不再显示「下一步」引导，只留一个去设定画像的按钮。 -->
            <div v-if="nextStep.action === 'go'" class="co-next co-next--ready" data-gs="next-step">
              <p class="co-next__title">{{ nextStep.title }}</p>
              <Button data-gs="primary-next" type="primary" @click="runNextStep">
                {{ nextStep.label }}
              </Button>
            </div>
            <div v-else class="co-next" data-gs="next-step">
              <p class="co-label">{{ $t('gainos.companies.nextStep') }}</p>
              <p class="co-next__title">{{ nextStep.title }}</p>
              <p class="co-next__desc">{{ nextStep.desc }}</p>
              <Button data-gs="primary-next" type="primary" @click="runNextStep">
                {{ nextStep.label }}
              </Button>
            </div>
          </div>

          <div class="co-primary__foot">
            <Space :size="8" wrap>
              <Button :loading="loading" data-gs="refresh" @click="load()">
                <template v-if="!loading" #icon><RotateCw :size="14" /></template>
                {{ loading ? $t('gainos.common.refreshing') : $t('gainos.common.refresh') }}
              </Button>
              <Button data-gs="primary-facts" @click="showFacts(primaryCompany)">
                {{ $t('gainos.companies.openFacts') }}
              </Button>
              <Button data-gs="primary-docs" @click="showDocs(primaryCompany)">
                {{ $t('gainos.companies.documents') }}
              </Button>
              <Button
                v-if="primaryCompany.status === 'DRAFT'"
                data-gs="primary-edit"
                @click="openEdit(primaryCompany)"
              >
                {{ $t('gainos.companies.edit') }}
              </Button>
              <Button data-gs="add-related" @click="addRelatedCompany">
                <template #icon><Plus :size="14" /></template>
                {{ $t('gainos.companies.addRelated') }}
              </Button>
              <Dropdown
                v-if="primaryMenuItems.length > 0"
                :trigger="['click']"
                placement="bottomRight"
              >
                <Button>{{ $t('gainos.companies.more') }}</Button>
                <template #overlay>
                  <Menu :items="primaryMenuItems" @click="onPrimaryMenu" />
                </template>
              </Dropdown>
            </Space>
            <div class="co-icp">
              <p class="co-label">{{ $t('gainos.companies.icpTitle') }}</p>
              <p class="co-icp__value">
                <template v-if="primaryIcps.length > 0">
                  <strong>{{ $t('gainos.companies.icpCount', { count: primaryIcps.length }) }}</strong>
                  <span v-if="activePrimaryIcp" class="co-muted">
                    · {{ $t('gainos.companies.icpActive', { name: activePrimaryIcp.name }) }}
                  </span>
                </template>
                <span v-else class="co-muted">{{ $t('gainos.companies.icpNone') }}</span>
              </p>
            </div>
          </div>
        </div>
      </GsCard>

      <!-- 档案工作台：企业事实与资料库都在页内完成，不再用弹窗打断阅读 -->
      <div ref="workspaceRef" class="co-workspace__anchor scroll-mt-24">
      <GsCard class="co-workspace" data-gs="company-workspace" padding="0">
        <header class="co-workspace__head">
          <div class="min-w-0">
            <p class="co-workspace__eyebrow">{{ $t('gainos.companies.workspaceEyebrow') }}</p>
            <h2 class="co-workspace__title">{{ $t('gainos.companies.workspaceTitle') }}</h2>
            <p class="co-workspace__hint">{{ $t('gainos.companies.workspaceHint') }}</p>
          </div>
          <div class="co-workspace__tools">
            <label class="co-workspace__field">
              <span>{{ $t('gainos.companies.workspaceCompany') }}</span>
              <GsSelect
                :ariaLabel="$t('gainos.companies.workspaceCompany')"
                class="co-workspace__select"
                :options="panelCompanyOptions"
                :value="panelCompanyId ?? undefined"
                @change="onPanelCompanyChange"
              />
            </label>
            <Button :loading="panelLoading" data-gs="workspace-refresh" @click="refreshPanel">
              <template v-if="!panelLoading" #icon><RotateCw :size="14" /></template>
              {{ $t('gainos.companies.workspaceRefresh') }}
            </Button>
          </div>
        </header>

        <div class="co-workspace__bar">
          <GsSegmented
            :ariaLabel="$t('gainos.companies.workspaceViewLabel')"
            :model-value="panelTab"
            :options="panelTabs"
            @update:model-value="onPanelTabChange"
          />
          <div class="co-workspace__context">
            <GsTag v-if="panelCompany" :tone="companyTone(panelCompany)">
              {{ companyStatus(panelCompany) }}
            </GsTag>
            <span class="co-muted">
              {{ panelCompany?.website || panelCompany?.domain || $t('gainos.companies.noWebsite') }}
            </span>
            <Button
              v-if="panelCompany && primaryCompany && panelCompany.id !== primaryCompany.id"
              size="small"
              type="link"
              @click="showFacts(primaryCompany)"
            >
              {{ $t('gainos.companies.workspaceBackPrimary') }}
            </Button>
          </div>
        </div>

        <!-- 企业事实：DOM 顺序是「审批清单 → 概览/冲突」——窄屏单栏时先看到要处理的事实；
             宽屏两栏用 grid-area 把概览放回左侧，作为判断事实时的上下文。 -->
        <div
          v-if="panelTab === 'facts'"
          ref="factsPanel"
          class="co-workspace__body co-facts"
          :data-readonly="claimsRecoveryReadOnly"
          data-gs="company-facts"
          tabindex="-1"
        >
          <div class="co-facts__main">
            <div class="cp__tabs" role="tablist">
              <button
                type="button"
                class="cp__tab"
                :class="{ 'cp__tab--active': claimTab === 'NEEDS_REVIEW' }"
                role="tab"
                :aria-selected="claimTab === 'NEEDS_REVIEW'"
                @click="switchClaimTab('NEEDS_REVIEW')"
              >
                {{ $t('gainos.companies.tabPending') }}
                <span class="cp__tab-count">{{ pendingClaims.length }}</span>
              </button>
              <button
                type="button"
                class="cp__tab"
                :class="{ 'cp__tab--active': claimTab === 'APPROVED' }"
                role="tab"
                :aria-selected="claimTab === 'APPROVED'"
                @click="switchClaimTab('APPROVED')"
              >
                {{ $t('gainos.companies.tabApproved') }}
                <span class="cp__tab-count">{{ approvedClaims.length }}</span>
              </button>
              <button
                type="button"
                class="cp__tab"
                :class="{ 'cp__tab--active': claimTab === 'REVOKED' }"
                role="tab"
                :aria-selected="claimTab === 'REVOKED'"
                @click="switchClaimTab('REVOKED')"
              >
                {{ $t('gainos.companies.tabIgnored') }}
                <span class="cp__tab-count">{{ ignoredClaims.length }}</span>
              </button>
            </div>

            <Input
              v-model:value="claimQuery"
              allow-clear
              class="co-facts__search"
              :placeholder="$t('gainos.companies.claimsSearch')"
            />

            <div v-if="isAdmin && !claimsRecoveryReadOnly" class="cp__manual-bar">
              <Button size="small" @click="manualOpen = !manualOpen">
                {{ manualOpen ? $t('gainos.companies.manualCancel') : $t('gainos.companies.manualAdd') }}
              </Button>
              <Button :loading="synthBusy" size="small" @click="synthesizeDrafts">
                {{ synthBusy ? $t('gainos.common.loading') : $t('gainos.companies.synthesizeDrafts') }}
              </Button>
              <span class="cp__muted">{{ $t('gainos.companies.synthesizeDraftsHint') }}</span>
            </div>

            <div v-if="manualOpen && !claimsRecoveryReadOnly" class="cp__manual-form">
              <label class="cp__field">
                <span>{{ $t('gainos.companies.manualStatement') }}</span>
                <Textarea
                  v-model:value="manualStatement"
                  :maxlength="2000"
                  :placeholder="$t('gainos.companies.manualStatementHint')"
                  :rows="3"
                />
              </label>
              <label class="cp__field">
                <span>{{ $t('gainos.companies.manualEvidence') }}</span>
                <Input
                  v-model:value="manualEvidence"
                  :maxlength="2000"
                  :placeholder="$t('gainos.companies.manualEvidenceHint')"
                />
              </label>
              <p v-if="manualError" class="cp__form-err" role="alert">{{ manualError }}</p>
              <div class="cp__manual-actions">
                <Button @click="manualOpen = false">{{ $t('gainos.common.cancel') }}</Button>
                <Button :loading="manualBusy" type="primary" @click="saveManualClaim">
                  {{ manualBusy ? $t('gainos.common.loading') : $t('gainos.companies.manualSubmit') }}
                </Button>
              </div>
            </div>

            <div v-if="claimsLoading" class="cp__claims-state">
              {{ $t('gainos.companies.claimsLoading') }}
            </div>

            <div v-else-if="claimsError" class="cp__claims-state cp__claims-state--error">
              <ErrorNotice
                :code="claimsError.code"
                :next="claimsError.next"
                :title="claimsError.title"
                :why="claimsError.why"
              />
              <Button size="small" @click="loadClaims()">{{ $t('gainos.common.retry') }}</Button>
            </div>

            <div v-else-if="visibleClaims.length === 0" class="cp__claims-state">
              <p>
                {{ claimQuery
                  ? $t('gainos.companies.claimsNoMatch')
                  : claimTab === 'NEEDS_REVIEW'
                    ? $t('gainos.companies.claimsEmptyPending')
                    : claimTab === 'APPROVED'
                      ? $t('gainos.companies.claimsEmptyApproved')
                      : $t('gainos.companies.claimsEmptyIgnored') }}
              </p>
            </div>

            <ul v-else class="cp__claims">
              <li v-for="claim in visibleClaims" :key="claim.id" class="cp__claim">
                <label
                  v-if="isAdmin && claim.status === 'NEEDS_REVIEW' && !claimsRecoveryReadOnly"
                  class="cp__claim-check"
                >
                  <input
                    type="checkbox"
                    :aria-label="$t('gainos.companies.selectClaim')"
                    :checked="selectedClaimIds.includes(claim.id)"
                    @change="toggleClaim(claim.id)"
                  />
                </label>
                <div class="cp__claim-main">
                  <div class="cp__claim-head">
                    <span class="cp__claim-type">{{ claimTypeLabel(claim.type) }}</span>
                    <span v-if="typeof claim.confidence === 'number'" class="cp__claim-conf">
                      {{ Math.round(claim.confidence * 100) }}%
                    </span>
                    <button
                      v-if="isAdmin && claim.status === 'APPROVED' && !claimsRecoveryReadOnly"
                      type="button"
                      class="cp__claim-revoke"
                      :disabled="revokingId === claim.id"
                      @click="revokeClaim(claim)"
                    >
                      {{ $t('gainos.companies.revoke') }}
                    </button>
                  </div>
                  <p class="cp__claim-text">{{ claim.statement }}</p>
                  <p v-if="claim.evidence?.[0]?.snippet" class="cp__claim-evidence">
                    {{ claim.evidence[0].snippet }}
                  </p>
                  <a
                    v-if="claim.evidence?.[0]?.sourceUrl"
                    class="cp__claim-source"
                    :href="claim.evidence[0].sourceUrl ?? undefined"
                    target="_blank"
                    rel="noopener noreferrer"
                  >{{ $t('gainos.companies.claimSource') }}</a>
                </div>
              </li>
            </ul>

            <p v-if="claimActionError" class="cp__form-err" role="alert">{{ claimActionError }}</p>
            <p v-if="claimNotice" class="cp__claim-notice" role="status">{{ claimNotice }}</p>

            <div
              v-if="isAdmin && claimTab === 'NEEDS_REVIEW' && visibleClaims.length > 0 && !claimsRecoveryReadOnly"
              class="cp__claim-bar"
            >
              <label class="cp__claim-selectall">
                <input
                  type="checkbox"
                  :checked="allVisibleSelected"
                  @change="toggleAllVisible"
                />
                {{ $t('gainos.companies.selectAll') }}
                <span v-if="selectedCount > 0">
                  · {{ $t('gainos.companies.selectedCount', { count: selectedCount }) }}
                </span>
              </label>
              <div class="cp__claim-actions">
                <Button
                  danger
                  :disabled="claimBusy !== null || selectedCount === 0"
                  :loading="claimBusy === 'reject'"
                  @click="reviewSelected('reject')"
                >
                  {{ claimBusy === 'reject'
                    ? claimProgress
                    : rejectArmed
                      ? $t('gainos.companies.confirmReject', { count: selectedCount })
                      : $t('gainos.companies.rejectSelected') }}
                </Button>
                <Button
                  :disabled="claimBusy !== null || selectedCount === 0"
                  :loading="claimBusy === 'approve'"
                  type="primary"
                  @click="reviewSelected('approve')"
                >
                  {{ claimBusy === 'approve' ? claimProgress : $t('gainos.companies.approveSelected') }}
                </Button>
              </div>
            </div>
          </div>

          <div class="co-facts__aside">
            <h3 class="co-pane__title">{{ $t('gainos.companies.overviewTitle') }}</h3>

            <div v-if="overviewLoading" class="co-panel__state">
              {{ $t('gainos.companies.overviewLoading') }}
            </div>
            <div v-else-if="overviewError" class="co-panel__state co-panel__state--error">
              <span>{{ overviewError }}</span>
              <Button size="small" @click="loadCompanyOverview()">
                {{ $t('gainos.common.retry') }}
              </Button>
            </div>
            <div v-else class="co-overview">
              <!-- 简介整段展示：左栏本来就有余量，不再沿用弹窗时代的截断加内滚动。 -->
              <div v-if="companyOverview?.summary || hasOverviewFacts" class="co-overview__sheet">
                <p v-if="companyOverview?.summary" class="co-overview__summary">
                  {{ companyOverview.summary }}
                </p>
                <dl class="co-overview__facts">
                  <div v-if="companyOverview?.industry">
                    <dt>{{ $t('gainos.companies.overviewIndustry') }}</dt>
                    <dd>{{ companyOverview.industry }}</dd>
                  </div>
                  <div v-if="companyOverview?.targetMarkets?.length">
                    <dt>{{ $t('gainos.companies.overviewMarkets') }}</dt>
                    <dd class="co-overview__markets">
                      <Tag
                        v-for="market in companyOverview.targetMarkets"
                        :key="market"
                        :bordered="false"
                        class="co-chip"
                      >
                        {{ market }}
                      </Tag>
                    </dd>
                  </div>
                  <div v-if="companyOverview?.website">
                    <dt>{{ $t('gainos.companies.overviewWebsite') }}</dt>
                    <dd>
                      <a :href="companyOverview.website" target="_blank" rel="noopener noreferrer">
                        {{ companyOverview.website }}
                      </a>
                    </dd>
                  </div>
                  <div v-if="companyOverview?.businessEmail">
                    <dt>{{ $t('gainos.companies.overviewEmail') }}</dt>
                    <dd>{{ companyOverview.businessEmail }}</dd>
                  </div>
                </dl>
              </div>
              <div v-if="completeness" class="co-overview__stats">
                <div>
                  <strong>{{ completeness.approvedClaims }}</strong>
                  <span>{{ $t('gainos.companies.statApproved') }}</span>
                </div>
                <div>
                  <strong>{{ completeness.pendingClaims }}</strong>
                  <span>{{ $t('gainos.companies.statPending') }}</span>
                </div>
                <div>
                  <strong>{{ completeness.offerings }}</strong>
                  <span>{{ $t('gainos.companies.statOfferings') }}</span>
                </div>
                <div>
                  <strong>{{ completeness.conflictsOpen }}</strong>
                  <span>{{ $t('gainos.companies.statConflicts') }}</span>
                </div>
              </div>
              <details v-if="offerings.length" :open="offeringsOpen" class="co-overview__offerings">
                <summary>{{ $t('gainos.companies.offeringsTitle', { count: offerings.length }) }}</summary>
                <ul>
                  <li v-for="offering in offerings" :key="offering.id">
                    <strong>{{ offering.name }}</strong>
                    <span v-if="offering.description"> · {{ offering.description }}</span>
                    <a
                      v-if="offering.sourceUrl"
                      :href="offering.sourceUrl"
                      target="_blank"
                      rel="noopener noreferrer"
                    > ↗</a>
                  </li>
                </ul>
              </details>
              <p v-else class="cp__muted">{{ $t('gainos.companies.offeringsEmpty') }}</p>
            </div>

            <div
              v-if="conflictsLoading || conflictsError || conflicts.length"
              class="cp__conflicts"
            >
              <div class="cp__conflicts-head">
                <h3>{{ $t('gainos.companies.conflictsTitle', { count: conflicts.length }) }}</h3>
                <p class="cp__muted">{{ $t('gainos.companies.conflictsHint') }}</p>
              </div>
              <p v-if="conflictsLoading" class="cp__muted">
                {{ $t('gainos.companies.claimsLoading') }}
              </p>
              <p v-else-if="conflictsError" class="cp__form-err">{{ conflictsError }}</p>
              <div v-for="conflict in conflicts" :key="conflict.id" class="cp__conflict">
                <div class="cp__conflict-head">
                  <span class="cp__claim-type">
                    {{ claimTypeLabel(conflict.claimType || conflict.claimA?.type || '') }}
                  </span>
                  <span v-if="!isAdmin" class="cp__muted">
                    {{ $t('gainos.companies.conflictsAdminOnly') }}
                  </span>
                </div>
                <div class="cp__conflict-grid">
                  <div class="cp__conflict-side">
                    <p>{{ conflict.claimA?.statement || '—' }}</p>
                    <Button
                      v-if="isAdmin && !claimsRecoveryReadOnly"
                      :disabled="conflictBusy === conflict.id"
                      size="small"
                      @click="resolveConflict(conflict, 'a')"
                    >
                      {{ $t('gainos.companies.keepThis') }}
                    </Button>
                  </div>
                  <div class="cp__conflict-side">
                    <p>{{ conflict.claimB?.statement || '—' }}</p>
                    <Button
                      v-if="isAdmin && !claimsRecoveryReadOnly"
                      :disabled="conflictBusy === conflict.id"
                      size="small"
                      @click="resolveConflict(conflict, 'b')"
                    >
                      {{ $t('gainos.companies.keepThis') }}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <footer class="co-facts__foot">
            <span class="cp__facts-ready">
              {{ approvedCount > 0
                ? $t('gainos.companies.approvedReady', { count: approvedCount })
                : $t('gainos.companies.approvedNeed') }}
            </span>
            <Button :disabled="approvedCount === 0" type="primary" @click="goFindBuyers">
              {{ $t('gainos.companies.goFindBuyers') }}
            </Button>
          </footer>
        </div>

        <!-- 资料库：左侧上传与文件清单，右侧检索，适合边看边查 -->
        <div
          v-else
          ref="docsPanel"
          class="co-workspace__body co-docs"
          :data-readonly="docsRecoveryReadOnly"
          data-gs="company-docs"
          tabindex="-1"
        >
          <div class="co-docs__main">
            <header class="co-docs__head">
              <div class="min-w-0">
                <h3 class="co-pane__title">{{ $t('gainos.companies.documentsTitle') }}</h3>
                <p class="co-muted">{{ $t('gainos.companies.documentsHint') }}</p>
              </div>
              <div v-if="!docsRecoveryReadOnly" class="co-docs__upload">
                <Button
                  :disabled="docsUploading"
                  type="primary"
                  @click="docsFileInput?.click()"
                >
                  {{ docsUploading ? $t('gainos.companies.uploading') : $t('gainos.companies.upload') }}
                </Button>
                <input
                  ref="docsFileInput"
                  accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.md"
                  class="co-docs__file"
                  type="file"
                  @change="uploadDocument"
                />
                <span class="cp__docs-formats">{{ $t('gainos.companies.uploadFormats') }}</span>
              </div>
            </header>

            <p v-if="docsNotice" class="cp__claim-notice" role="status">{{ docsNotice }}</p>
            <p v-if="docsError" class="cp__form-err" role="alert">{{ docsError }}</p>

            <div v-if="docsLoading && docs.length === 0" class="co-panel__state">
              {{ $t('gainos.companies.loading') }}
            </div>
            <ul v-else-if="docs.length > 0" class="cp__docs-list co-docs__list">
              <li v-for="row in docs" :key="row.id" class="cp__docs-item">
                <div class="cp__docs-main">
                  <strong>{{ row.filename }}</strong>
                  <span>
                    {{ docSizeLabel(row) }} · {{ docStatusLabel(row.status) }}
                    <template v-if="row.status === 'ready'">
                      · {{ $t('gainos.companies.documentChunks', { count: row.chunkCount ?? 0 }) }}
                    </template>
                  </span>
                  <span v-if="row.processingErrorCode" class="cp__item-error">
                    {{ row.processingErrorCode }}
                  </span>
                </div>
                <div class="cp__docs-side">
                  <Button
                    v-if="row.status === 'ready'"
                    :disabled="downloadingDocId === row.id"
                    :loading="downloadingDocId === row.id"
                    size="small"
                    @click="downloadDocument(row)"
                  >
                    {{ downloadingDocId === row.id ? $t('gainos.companies.downloading') : $t('gainos.companies.download') }}
                  </Button>
                  <Button
                    v-if="row.status === 'ready' && (row.chunkCount ?? 0) > 0 && !docsRecoveryReadOnly"
                    size="small"
                    @click="openExtractModal(row, 0)"
                  >
                    {{ $t('gainos.companies.extractFact') }}
                  </Button>
                  <Button
                    v-if="!docsRecoveryReadOnly && (row.status === 'failed_terminal' || row.status === 'queued')"
                    size="small"
                    @click="retryDocument(row)"
                  >
                    {{ $t('gainos.companies.retryUnderstanding') }}
                  </Button>
                  <Button v-if="isAdmin && !docsRecoveryReadOnly" size="small" @click="removeDocument(row)">
                    {{ $t('gainos.companies.delete') }}
                  </Button>
                </div>
              </li>
            </ul>
            <p v-else class="co-panel__state">{{ $t('gainos.companies.documentsEmpty') }}</p>

            <Button
              v-if="docsHasMore"
              :loading="docsLoading"
              block
              @click="loadDocuments(true, false)"
            >
              {{ $t('gainos.companies.loadMoreDocuments') }}
            </Button>
          </div>

          <aside class="co-docs__search-pane">
            <h3 class="co-pane__title">{{ $t('gainos.companies.documentSearch') }}</h3>
            <p class="co-muted">{{ $t('gainos.companies.documentSearchHint') }}</p>
            <form class="co-docs__search-form" @submit.prevent="searchDocuments">
              <Input
                v-model:value="docsQuery"
                :placeholder="$t('gainos.companies.documentSearchPlaceholder')"
                type="search"
              />
              <Button :disabled="docsSearching" html-type="submit">
                {{ docsSearching ? $t('gainos.companies.loading') : $t('gainos.companies.documentSearch') }}
              </Button>
            </form>
            <ul v-if="docsQuery.trim().length >= 2" class="cp__docs-hits co-docs__hits">
              <li
                v-for="hit in docsHits"
                :key="`${hit.documentId}-${hit.seq}`"
                class="cp__docs-hit"
              >
                <strong>{{ hit.filename }} · #{{ hit.seq }}</strong>
                <p>{{ hit.text.slice(0, 200) }}</p>
                <div v-if="!docsRecoveryReadOnly" class="mt-2 flex justify-end">
                  <Button size="small" @click="openExtractModal({ id: hit.documentId, filename: hit.filename }, hit.seq)">
                    {{ $t('gainos.companies.extractFact') }}
                  </Button>
                </div>
              </li>
              <li v-if="docsHits.length === 0" class="co-muted">
                {{ $t('gainos.companies.documentSearchEmpty') }}
              </li>
            </ul>
          </aside>
        </div>
      </GsCard>
      </div>

      <!-- 关联公司：集团/多品牌才需要，默认收起在次级区域。 -->
      <section v-if="relatedCompanies.length > 0" class="co-related" data-gs="related-companies">
        <header class="co-related__head">
          <div class="min-w-0">
            <h2 class="co-related__title">{{ $t('gainos.companies.relatedTitle') }}</h2>
            <p class="co-muted">{{ $t('gainos.companies.relatedHint') }}</p>
          </div>
          <Button @click="addRelatedCompany">
            <template #icon><Plus :size="14" /></template>
            {{ $t('gainos.companies.addRelated') }}
          </Button>
        </header>

        <GsToolbar v-if="relatedCompanies.length > 3">
          <Input
            v-model:value="searchQuery"
            allow-clear
            class="w-[240px]"
            :placeholder="$t('gainos.companies.searchPlaceholder')"
            type="search"
          />
          <GsSelect
            v-model="statusFilter"
            :ariaLabel="$t('gainos.companies.filterAll')"
            class="w-[160px]"
            :options="statusOptions"
          />
          <span class="co-muted">
            {{ $t('gainos.companies.showing', { shown: filteredRelated.length, total: relatedCompanies.length }) }}
          </span>
        </GsToolbar>

        <div class="co-related__grid">
          <GsCard
            v-for="company in filteredRelated"
            :key="company.id"
            class="co-rel-card"
            data-gs="related-company"
            padding="18px 20px"
          >
            <div class="co-rel-card__top">
              <span aria-hidden="true" class="co-logo co-logo--sm">
                {{ companyInitial(company) }}
              </span>
              <div class="min-w-0">
                <h3 class="co-rel-card__name">{{ companyTitle(company) }}</h3>
                <p class="co-muted">
                  {{ company.website || company.domain || $t('gainos.companies.noWebsite') }}
                </p>
              </div>
              <GsTag :tone="companyTone(company)">{{ companyStatus(company) }}</GsTag>
            </div>
            <div v-if="companyTags(company).length" class="co-tags">
              <Tag
                v-for="tag in companyTags(company)"
                :key="tag"
                :bordered="false"
                class="co-chip"
              >
                {{ tag }}
              </Tag>
            </div>
            <p class="co-muted">
              {{ $t('gainos.companies.icpTitle') }}：{{ icpSummary(company) }}
            </p>
            <div class="co-rel-card__actions">
              <Button size="small" type="primary" @click="relatedPrimaryAction(company)">
                {{ relatedPrimaryLabel(company) }}
              </Button>
              <Button size="small" @click="showDocs(company)">
                {{ $t('gainos.companies.documents') }}
              </Button>
              <Dropdown
                v-if="relatedMenuItems(company).length > 0"
                :trigger="['click']"
                placement="bottomRight"
              >
                <Button size="small">{{ $t('gainos.companies.more') }}</Button>
                <template #overlay>
                  <Menu
                    :items="relatedMenuItems(company)"
                    @click="(info) => onRelatedMenu(info, company)"
                  />
                </template>
              </Dropdown>
            </div>
          </GsCard>
          <p v-if="filteredRelated.length === 0" class="co-muted">
            {{ $t('gainos.companies.noMatch') }}
          </p>
        </div>
      </section>
    </template>
    </div>

    <MarketCandidatesPanel v-if="marketCompany?.id" :hidden="wizardOpen || editOpen || addRelatedOpen" :company-id="marketCompany.id" :company-name="marketCompany.name ?? marketCompany.domain ?? ''" :context="marketContext" @close="closeMarketCandidates" @recover="recoverMarketView" />

    <!-- 添加关联公司：先说明「日常只需维护注册公司」，再进入建档界面 -->
    <Modal
      v-model:open="addRelatedOpen"
      :ok-text="$t('gainos.companies.addRelatedContinue')"
      :title="$t('gainos.companies.addRelatedTitle')"
      :width="480"
      data-gs="add-related-modal"
      @ok="continueAddRelated"
    >
      <p class="co-modal-desc">{{ $t('gainos.companies.addRelatedDesc') }}</p>
    </Modal>

    <!-- 建档（新增注册公司或关联公司；官网可选，名称与官网至少其一） -->
    <Modal
      v-model:open="wizardOpen"
      :confirm-loading="creating"
      :ok-text="$t('gainos.companies.create')"
      :title="$t('gainos.companies.wizardTitle')"
      :width="520"
      data-gs="company-wizard"
      @ok="create"
    >
      <div class="co-form">
        <p class="co-muted">{{ $t('gainos.companies.wizardHint') }}</p>
        <label class="co-field">
          <span>{{ $t('gainos.companies.website') }}</span>
          <Input
            v-model:value="form.website"
            :placeholder="$t('gainos.companies.websitePlaceholder')"
            type="url"
          />
        </label>
        <label class="co-field">
          <span>{{ $t('gainos.companies.name') }}</span>
          <Input
            v-model:value="form.name"
            :placeholder="$t('gainos.companies.namePlaceholder')"
            type="text"
          />
        </label>
        <Alert v-if="formError" :message="formError" role="alert" show-icon type="error" />
      </div>
    </Modal>

    <!-- 编辑档案 + 自动找官网 -->
    <Modal
      v-model:open="editOpen"
      :confirm-loading="editSaving"
      :ok-text="$t('gainos.companies.save')"
      :title="$t('gainos.companies.editTitle')"
      :width="640"
      data-gs="company-edit"
      @ok="saveEdit"
    >
      <div class="co-form">
        <p class="co-muted">{{ $t('gainos.companies.editHint') }}</p>
        <label class="co-field">
          <span>{{ $t('gainos.companies.name') }}</span>
          <Input v-model:value="editForm.name" :maxlength="200" type="text" />
        </label>
        <label class="co-field">
          <span>{{ $t('gainos.companies.website') }}</span>
          <Input
            v-model:value="editForm.website"
            :placeholder="$t('gainos.companies.websitePlaceholder')"
            type="url"
          />
        </label>
        <div class="co-candidates">
          <Button :loading="candidatesLoading" @click="findCandidates">
            {{ candidatesLoading ? $t('gainos.companies.autoFinding') : $t('gainos.companies.autoFind') }}
          </Button>
          <p v-if="candidatesError" class="co-muted">{{ candidatesError }}</p>
          <template v-if="candidates.length > 0">
            <p class="co-muted">{{ $t('gainos.companies.autoFindHint') }}</p>
            <ul class="co-candidate-list">
              <li v-for="candidate in candidates" :key="candidate.url" class="co-candidate">
                <div class="min-w-0">
                  <strong>{{ candidate.title || candidate.url }}</strong>
                  <span>{{ candidate.url }}</span>
                </div>
                <Button size="small" @click="useCandidate(candidate)">
                  {{ $t('gainos.companies.useCandidate') }}
                </Button>
              </li>
            </ul>
          </template>
        </div>
        <label class="co-field">
          <span>{{ $t('gainos.companies.industryLabel') }}</span>
          <Input
            v-model:value="editForm.industry"
            :maxlength="200"
            :placeholder="$t('gainos.companies.industryPlaceholder')"
          />
        </label>
        <label class="co-field">
          <span>{{ $t('gainos.companies.businessEmailLabel') }}</span>
          <Input
            v-model:value="editForm.businessEmail"
            :maxlength="320"
            :placeholder="$t('gainos.companies.businessEmailPlaceholder')"
            type="email"
          />
        </label>
        <label class="co-field">
          <span>{{ $t('gainos.companies.targetMarketsLabel') }}</span>
          <Input
            v-model:value="editForm.markets"
            :placeholder="$t('gainos.companies.targetMarketsPlaceholder')"
          />
        </label>
        <Alert v-if="editError" :message="editError" role="alert" show-icon type="error" />
      </div>
    </Modal>

    <!-- 从资料分段提炼企业事实（读取分段 → 预览校验 → 保存待审草稿） -->
    <Modal
      v-model:open="extractOpen"
      :footer="null"
      :title="$t('gainos.companies.extractModalTitle')"
      :width="660"
    >
      <div class="grid gap-3 pt-2" data-gs="doc-claim-modal">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="min-w-0 text-sm">
            <strong class="mr-2">{{ extractDoc?.filename }}</strong>
            <GsTag v-if="extractDoc?.chunkCount" tone="neutral">
              {{ $t('gainos.companies.chunkSeqLabel', { current: extractSeq + 1, total: extractDoc.chunkCount }) }}
            </GsTag>
            <GsTag v-else tone="neutral">
              {{ $t('gainos.companies.chunkSingleLabel', { seq: extractSeq }) }}
            </GsTag>
            <GsTag v-if="extractPageNumber !== null" class="ml-1" tone="info">
              {{ $t('gainos.companies.chunkPageLabel', { page: extractPageNumber }) }}
            </GsTag>
          </div>
          <Space :size="6">
            <Button
              :disabled="extractLoading || extractSeq <= 0"
              size="small"
              @click="loadExtractChunk(extractSeq - 1)"
            >
              {{ $t('gainos.companies.chunkPrev') }}
            </Button>
            <Button
              :disabled="extractLoading || (extractDoc?.chunkCount !== undefined && extractSeq >= extractDoc.chunkCount - 1)"
              size="small"
              @click="loadExtractChunk(extractSeq + 1)"
            >
              {{ $t('gainos.companies.chunkNext') }}
            </Button>
          </Space>
        </div>

        <Skeleton v-if="extractLoading" active :paragraph="{ rows: 3 }" />
        <template v-else-if="extractChunk">
          <div class="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-[var(--gs-border)] bg-[var(--gs-surface-2)] p-3 text-xs leading-relaxed text-[var(--gs-fg-2)]">
            {{ extractChunk.text }}
          </div>

          <label class="grid gap-1 text-xs">
            <span class="font-medium text-[var(--gs-fg-2)]">{{ $t('gainos.companies.chunkQuoteLabel') }}</span>
            <Textarea
              v-model:value="extractQuote"
              :rows="2"
              data-gs="doc-claim-quote"
            />
            <span class="text-[var(--gs-fg-subtle)]">{{ $t('gainos.companies.chunkQuoteHint') }}</span>
          </label>

          <label class="grid gap-1 text-xs">
            <span class="font-medium text-[var(--gs-fg-2)]">{{ $t('gainos.companies.chunkTypeLabel') }}</span>
            <GsSelect
              v-model="extractType"
              :ariaLabel="$t('gainos.companies.chunkTypeLabel')"
              :options="extractTypeOptions"
            />
          </label>

          <label class="grid gap-1 text-xs">
            <span class="font-medium text-[var(--gs-fg-2)]">{{ $t('gainos.companies.chunkStatementLabel') }}</span>
            <Textarea
              v-model:value="extractStatement"
              :maxlength="4000"
              :placeholder="$t('gainos.companies.chunkStatementPlaceholder')"
              :rows="2"
              data-gs="doc-claim-statement"
            />
          </label>

          <Alert
            v-if="extractPreview"
            :description="$t('gainos.companies.chunkPreviewQuote', { quote: extractPreview.quote })"
            :message="$t('gainos.companies.chunkPreviewTitle')"
            data-gs="doc-claim-preview"
            show-icon
            type="success"
          />
        </template>

        <Alert v-if="extractError" :message="extractError" role="alert" show-icon type="warning" />

        <div class="flex flex-wrap justify-end gap-2 border-t border-[var(--gs-border)] pt-3">
          <Button @click="extractOpen = false">{{ $t('gainos.common.cancel') }}</Button>
          <Button
            :disabled="extractLoading || !extractChunk || extractPreviewBusy"
            :loading="extractPreviewBusy"
            data-gs="doc-claim-preview-btn"
            @click="runExtractPreview"
          >
            {{ extractPreviewBusy ? $t('gainos.companies.chunkPreviewing') : $t('gainos.companies.chunkPreviewBtn') }}
          </Button>
          <Button
            :disabled="!extractPreview || extractSaveBusy"
            :loading="extractSaveBusy"
            data-gs="doc-claim-save-btn"
            type="primary"
            @click="saveExtractDraft"
          >
            {{ extractSaveBusy ? $t('gainos.companies.chunkSaving') : $t('gainos.companies.chunkSaveDraft') }}
          </Button>
        </div>
      </div>
    </Modal>

  </div>
</template>

<style scoped>
.cp {
  /* 页面容器：统一外边距与可读宽度上限(vben 内容区默认 0 内边距) */
  padding: clamp(18px, 2.4vw, 32px) clamp(18px, 2.4vw, 34px) clamp(32px, 4vh, 48px);
  max-width: 1280px;
  margin: 0 auto;
 display: grid; gap: 20px; }
.cp__head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; }
.cp__head h1 { margin: 0; font-size: 24px; line-height: 32px; font-weight: 500; letter-spacing: -.011em; color: var(--gs-fg); }
.cp__head p { margin: 8px 0 0; font-size: 16px; line-height: 24px; letter-spacing: -.011em; color: var(--gs-fg-muted); max-width: 560px; }
.cp__cta {
  display: inline-flex; align-items: center; gap: 7px; flex: none; cursor: pointer;
  border: 0; border-radius: 11px; padding: 11px 18px; font-size: 14px; font-weight: 600;
  background: var(--gs-accent-cta); color: var(--gs-accent-cta-fg); box-shadow: 0 8px 18px -6px var(--gs-accent-glow);
  transition: transform .15s ease, box-shadow .15s ease;
}
.cp__cta:hover { transform: translateY(-1px); }
.cp__cta:active { transform: scale(.97); }
.cp__cta svg { width: 15px; height: 15px; }

.cp__state {
  max-width: 760px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
  display: grid; place-items: center; gap: 6px; text-align: center;
  background: var(--gs-surface); border: 1px dashed var(--gs-border-dashed); border-radius: 16px; padding: 56px 24px;
}
.cp__state--loading { color: var(--gs-fg-subtle); font-size: 14px; }
.cp__empty-mark {
  width: 52px; height: 52px; border-radius: 14px; background: var(--gs-accent-soft); color: var(--gs-accent-strong);
  display: flex; align-items: center; justify-content: center; margin-bottom: 8px;
}
.cp__empty-mark svg { width: 26px; height: 26px; }
.cp__state-title { margin: 0; font-size: 16.5px; font-weight: 600; color: var(--gs-fg); }
.cp__state-desc { margin: 0 0 14px; font-size: 13.5px; color: var(--gs-fg-muted); max-width: 520px; line-height: 1.75; text-wrap: pretty; }
.cp__state--error .cp__state-title { color: var(--gs-warn); }
.cp__state-retry {
  border: 1px solid var(--gs-border-strong); border-radius: 10px; background: var(--gs-surface); padding: 9px 22px;
  font-size: 13.5px; cursor: pointer; color: var(--gs-fg-2); transition: border-color .15s ease, color .15s ease;
}
.cp__state-retry:hover { border-color: var(--gs-accent); color: var(--gs-accent-strong); }
.cp__state-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
.cp__cta-secondary {
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--gs-border); border-radius: 999px; padding: 9px 18px;
  background: var(--gs-surface); color: var(--gs-fg-2); font-size: 13.5px; text-decoration: none;
}
.cp__cta-secondary:hover { border-color: var(--gs-accent); color: var(--gs-accent-strong); }

.cp__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.cp__item {
  display: flex; justify-content: space-between; align-items: center; gap: 16px;
  background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px; padding: 16px 20px;
  transition: border-color .15s ease, box-shadow .15s ease;
}
.cp__item:hover { border-color: var(--gs-accent-soft-border); box-shadow: 0 6px 16px -8px var(--gs-shadow-card); }
.cp__item-main { display: grid; gap: 3px; min-width: 0; }
.cp__item-name { font-size: 15px; font-weight: 600; color: var(--gs-fg); }
.cp__item-site { font-size: 12.5px; color: var(--gs-fg-subtle); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp__badge { flex: none; font-size: 12px; font-weight: 600; border-radius: 999px; padding: 4px 12px; }
.cp__badge--draft { background: var(--gs-divider); color: var(--gs-fg-muted); }
.cp__badge--enriching { background: var(--gs-indigo-soft); color: var(--gs-indigo); }
.cp__badge--review { background: var(--gs-warn-bg); color: var(--gs-warn); }
.cp__badge--active { background: var(--gs-accent-soft); color: var(--gs-accent-strong); }
.cp__badge--failed { background: var(--gs-danger-bg); color: var(--gs-danger); }
.cp__item-error { margin-top: 2px; font-size: 12px; color: var(--gs-danger); font-family: var(--gs-mono, monospace); }
.cp__item-side { display: flex; align-items: center; gap: 10px; flex: none; }
.cp__confirm { border: 0; border-radius: 9px; padding: 7px 12px; background: var(--gs-accent-cta); color: var(--gs-accent-cta-fg); font-size: 12.5px; font-weight: 600; cursor: pointer; }
.cp__confirm--ghost { background: var(--gs-surface); color: var(--gs-fg-2); border: 1px solid var(--gs-border-strong); }
.cp__confirm--ghost:hover { border-color: var(--gs-accent); color: var(--gs-accent-strong); }
.cp__confirm--danger { color: var(--gs-danger); }
.cp__confirm--danger:hover { border-color: var(--gs-danger-border); color: var(--gs-danger); }
.cp__confirm:disabled { opacity: .55; cursor: default; }

.cp__modal {
  position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
  padding: 24px; overflow: hidden;
}
.cp__modal-mask { position: fixed; inset: 0; background: var(--gs-mask); backdrop-filter: blur(3px); }
.cp__modal-body {
  position: relative; width: min(460px, 100%); max-height: calc(100dvh - 48px); overflow-y: auto; box-sizing: border-box;
  background: var(--gs-surface); border-radius: 18px; padding: 26px 26px 24px;
  box-shadow: 0 28px 70px -20px var(--gs-shadow-modal); animation: cp-pop .28s cubic-bezier(.2,.9,.3,1.2) both;
  overflow-wrap: anywhere;
}
@keyframes cp-pop { from { opacity: 0; transform: translateY(14px) scale(.97); } to { opacity: 1; transform: none; } }
.cp__modal-body header { display: flex; justify-content: space-between; align-items: center; }
.cp__modal-body h2 { margin: 0; font-size: 19px; font-weight: 700; color: var(--gs-fg); }
.cp__modal-x { border: 0; background: transparent; color: var(--gs-fg-subtle); font-size: 15px; cursor: pointer; padding: 4px; }
.cp__modal-x:hover { color: var(--gs-fg-2); }
.cp__modal-hint { margin: 12px 0 20px; font-size: 13px; line-height: 1.8; color: var(--gs-fg-muted); }
.cp__field { display: block; margin-bottom: 16px; }
.cp__field span { display: block; margin-bottom: 7px; font-size: 13px; font-weight: 500; color: var(--gs-fg-2); }
.cp__field input {
  width: 100%; box-sizing: border-box; border: 1.5px solid var(--gs-border-strong); border-radius: 11px;
  padding: 11px 14px; font-size: 14.5px; outline: 0; transition: border-color .16s ease, box-shadow .16s ease;
}
.cp__field input:focus { border-color: var(--gs-accent); box-shadow: 0 0 0 4px rgba(51,92,255,.16); }
.cp__form-err { margin: 0 0 12px; font-size: 13px; color: var(--gs-danger); background: var(--gs-danger-bg); border: 1px solid var(--gs-danger-border); border-radius: 9px; padding: 9px 12px; }
.cp__modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px; }
.cp__candidates { margin: 4px 0 16px; }
.cp__candidate-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.cp__candidate { display: flex; align-items: center; justify-content: space-between; gap: 12px; border: 1px solid var(--gs-border); border-radius: 10px; padding: 10px 12px; }
.cp__candidate-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cp__candidate-main strong { font-size: 13px; color: var(--gs-fg-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp__candidate-main span { font-size: 12px; color: var(--gs-fg-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp__docs-panel { width: 100%; max-width: 760px; margin: 0 auto; padding: 22px 24px 18px; box-sizing: border-box; }
.cp__docs-panel > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.cp__docs-panel > header h2 { margin: 0; color: var(--gs-fg); font-size: 17px; line-height: 26px; font-weight: 600; }
.cp__docs-actions { display: flex; align-items: center; gap: 12px; margin: 12px 0; flex-wrap: wrap; }
.cp__docs-upload { position: relative; overflow: hidden; cursor: pointer; }
.cp__docs-upload input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.cp__docs-formats { font-size: 12px; color: var(--gs-fg-3); }
.cp__docs-list { list-style: none; margin: 8px 0 16px; padding: 0; display: flex; flex-direction: column; gap: 8px; max-height: 320px; overflow: auto; }
.cp__docs-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; border: 1px solid var(--gs-border); border-radius: 10px; padding: 10px 12px; }
.cp__docs-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cp__docs-main strong { font-size: 13px; color: var(--gs-fg-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp__docs-main span { font-size: 12px; color: var(--gs-fg-3); }
.cp__docs-side { display: flex; gap: 8px; flex-shrink: 0; }
.cp__docs-search { display: flex; gap: 8px; margin-top: 4px; }
.cp__docs-search input { flex: 1; border: 1px solid var(--gs-border); border-radius: 9px; padding: 8px 11px; font-size: 13px; }
.cp__docs-hits { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; max-height: 260px; overflow: auto; }
.cp__docs-hit { border: 1px solid var(--gs-border); border-radius: 10px; padding: 8px 11px; }
.cp__docs-hit strong { font-size: 12px; color: var(--gs-fg-2); }
.cp__docs-hit p { margin: 4px 0 0; font-size: 12px; color: var(--gs-fg-3); white-space: pre-wrap; }
.cp__btn { border-radius: 11px; padding: 11px 20px; font-size: 14px; font-weight: 600; cursor: pointer; border: 0; }
.cp__btn--ghost { background: var(--gs-divider); color: var(--gs-fg-2); }
.cp__btn--ghost:hover { background: var(--gs-border-strong); }
.cp__btn--primary { background: var(--gs-accent-cta); color: var(--gs-accent-cta-fg); }
.cp__btn--primary:hover { filter: brightness(1.04); }
.cp__btn--primary:disabled { opacity: .7; cursor: default; }
.cp__btn--danger { color: var(--gs-danger); }
.cp__btn--danger:not(:disabled):hover { color: var(--gs-accent-cta-fg); background: var(--gs-danger); }
.cp__btn:disabled { cursor: default; }

/* ── 企业列表：事实入口 ── */
.cp__facts {
  flex: none; border: 1px solid var(--gs-border-strong); border-radius: 9px; background: var(--gs-surface);
  color: var(--gs-fg-2); padding: 7px 12px; font-size: 12.5px; font-weight: 600; cursor: pointer;
  transition: border-color .15s ease, color .15s ease;
}
.cp__facts:hover { border-color: var(--gs-accent); color: var(--gs-accent-strong); }

/* ── 企业事实审批面板 ── */
.cp__facts-panel {
  width: 100%; max-width: 800px; margin: 0 auto; max-height: calc(100dvh - 32px); padding: 0; overflow: hidden;
  display: flex; flex-direction: column; outline: none; overflow-wrap: anywhere;
}
.cp__facts-head { flex: none; padding: 24px 26px 0; display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.cp__facts-head > div { min-width: 0; }
.cp__facts-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; padding: 0 26px 16px; }
.cp__facts-body > * { min-width: 0; }
.cp__facts-hint { margin: 8px 0 0; font-size: 13px; line-height: 1.7; color: var(--gs-fg-muted); }
.cp__tabs {
  display: flex; gap: 4px; margin: 18px 0 10px;
  border-bottom: 1px solid var(--gs-border);
}
.cp__tab {
  display: flex; align-items: center; gap: 6px; border: 0; border-bottom: 2px solid transparent;
  background: transparent; padding: 8px 10px 9px; font-size: 13px; font-weight: 600;
  color: var(--gs-fg-muted); cursor: pointer;
}
.cp__tab:hover { color: var(--gs-fg-2); }
.cp__tab--active { color: var(--gs-accent-strong); border-bottom-color: var(--gs-accent); }
.cp__tab-count {
  border-radius: 999px; background: var(--gs-divider); padding: 1px 7px;
  font-size: 11.5px; font-weight: 600; color: var(--gs-fg-muted);
}
.cp__tab--active .cp__tab-count { background: var(--gs-accent-soft); color: var(--gs-accent-strong); }
.cp__claim-search {
  width: 100%; box-sizing: border-box; margin-bottom: 10px;
  border: 1.5px solid var(--gs-border-strong); border-radius: 10px;
  padding: 9px 12px; font-size: 13.5px; outline: 0;
}
.cp__claim-search:focus { border-color: var(--gs-accent); box-shadow: 0 0 0 4px rgba(51,92,255,.16); }
.cp__claims {
  list-style: none; margin: 0; padding: 0;
  border-top: 1px solid var(--gs-border); border-bottom: 1px solid var(--gs-border);
}
.cp__claim {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 12px 10px; border-radius: 10px;
}
.cp__claim + .cp__claim { border-top: 1px solid var(--gs-border); }
.cp__claim:hover { background: var(--gs-divider); }
.cp__claim-check { padding-top: 2px; flex: none; }
.cp__claim-check input,
.cp__claim-selectall input { width: 16px; height: 16px; accent-color: var(--gs-accent); cursor: pointer; }
.cp__claim-main { min-width: 0; display: grid; gap: 5px; }
.cp__claim-head { display: flex; align-items: center; gap: 8px; }
.cp__claim-type {
  border-radius: 999px; background: var(--gs-indigo-soft); color: var(--gs-indigo);
  padding: 2px 8px; font-size: 11.5px; font-weight: 600;
}
.cp__claim-conf { font-size: 11.5px; color: var(--gs-fg-subtle); }
.cp__claim-revoke {
  margin-left: auto; border: 1px solid var(--gs-border-strong); background: transparent;
  color: var(--gs-fg-muted); border-radius: 7px; padding: 2px 8px; font-size: 11.5px; cursor: pointer;
}
.cp__claim-revoke:hover { color: var(--gs-danger); border-color: var(--gs-danger-border); }
.cp__conflicts { margin-top: 12px; padding: 12px; border: 1px solid var(--gs-warn); background: var(--gs-warn-bg); border-radius: 10px; display: grid; gap: 8px; }
.cp__conflicts-head { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; flex-wrap: wrap; }
.cp__conflicts-head h3 { margin: 0; font-size: 13px; color: var(--gs-warn); }
.cp__conflict { background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 9px; padding: 10px 12px; display: grid; gap: 8px; }
.cp__conflict-head { display: flex; gap: 8px; }
.cp__conflict-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.cp__conflict-side { display: grid; gap: 8px; align-content: start; }
.cp__conflict-side p { margin: 0; font-size: 12.5px; line-height: 1.65; color: var(--gs-fg-2); overflow-wrap: anywhere; }
.cp__conflict-keep { justify-self: start; border: 1px solid var(--gs-accent); background: var(--gs-surface); color: var(--gs-accent-strong); border-radius: 8px; padding: 5px 10px; font-size: 12px; cursor: pointer; }
.cp__conflict-keep:disabled { opacity: .5; cursor: default; }
.cp__claim-text { margin: 0; font-size: 13.5px; line-height: 1.65; color: var(--gs-fg-2); overflow-wrap: anywhere; }
.cp__claim-evidence { margin: 0; font-size: 12px; line-height: 1.6; color: var(--gs-fg-subtle); overflow-wrap: anywhere; }
.cp__claim-source { font-size: 12px; color: var(--gs-accent-strong); text-decoration: none; }
.cp__claim-source:hover { text-decoration: underline; }
.cp__claims-state { padding: 34px 12px; text-align: center; font-size: 13.5px; line-height: 1.7; color: var(--gs-fg-muted); }
.cp__claims-state p { margin: 0 0 10px; }
.cp__claims-state--error p { color: var(--gs-warn); }
.cp__claim-bar {
  flex: none; display: flex; justify-content: space-between; align-items: center; gap: 12px;
  padding: 12px 26px; flex-wrap: wrap; border-top: 1px solid var(--gs-border);
  background: var(--gs-surface); box-shadow: 0 -10px 20px -18px var(--gs-shadow-modal);
}
.cp__claim-selectall { display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--gs-fg-2); cursor: pointer; }
.cp__claim-actions { display: flex; gap: 8px; }
.cp__claim-actions .cp__btn { padding: 9px 16px; font-size: 13px; }
.cp__claim-notice {
  margin: 0 0 10px; padding: 9px 12px; border-radius: 9px;
  background: var(--gs-accent-soft); color: var(--gs-accent-strong); font-size: 13px;
}
.cp__facts-foot {
  flex: none; display: flex; justify-content: space-between; align-items: center; gap: 12px;
  flex-wrap: wrap; margin: 0; padding: 14px 26px 20px; border-top: 1px solid var(--gs-border);
  background: var(--gs-surface);
}
.cp__facts-ready { font-size: 12.5px; line-height: 1.6; color: var(--gs-fg-muted); }
.cp__facts-foot .cp__btn { padding: 9px 16px; font-size: 13px; }
.cp__muted { margin: 0; font-size: 12.5px; color: var(--gs-fg-subtle); line-height: 1.6; }
/* 档案概览：简介整段展示 + 关键信息对照，靠页面本身滚动，不设内滚动区 */
.co-overview { display: grid; gap: 12px; }
.co-overview__sheet { display: grid; gap: 12px; padding: 14px; border-radius: 12px; background: var(--gs-divider); }
.co-overview__summary { margin: 0; font-size: 13px; line-height: 1.75; color: var(--gs-fg-2); overflow-wrap: anywhere; }
.co-overview__facts { display: grid; gap: 8px; margin: 0; }
.co-overview__facts > div { display: grid; grid-template-columns: 60px minmax(0, 1fr); gap: 10px; font-size: 12.5px; line-height: 20px; }
.co-overview__facts dt { color: var(--gs-fg-muted); }
.co-overview__facts dd { margin: 0; min-width: 0; color: var(--gs-fg); overflow-wrap: anywhere; }
.co-overview__facts a { color: var(--gs-accent-strong); text-decoration: none; }
.co-overview__facts a:hover { text-decoration: underline; }
.co-overview__markets { display: flex; flex-wrap: wrap; gap: 6px; }
.co-overview__stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.co-overview__stats > div { display: grid; gap: 2px; padding: 8px 10px; border-radius: 9px; background: var(--gs-surface-2); }
.co-overview__stats strong { color: var(--gs-fg); font-size: 16px; line-height: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.co-overview__stats span { color: var(--gs-fg-subtle); font-size: 11.5px; }
.co-overview__offerings { font-size: 12.5px; color: var(--gs-fg-2); }
.co-overview__offerings summary { cursor: pointer; font-weight: 600; color: var(--gs-fg); }
.co-overview__offerings ul { display: grid; gap: 6px; margin: 8px 0 0; padding: 0; list-style: none; }
.co-overview__offerings li { line-height: 1.6; overflow-wrap: anywhere; }
.co-overview__offerings li strong { color: var(--gs-fg); font-weight: 600; }
.co-overview__offerings li span { color: var(--gs-fg-muted); }
.co-overview__offerings a { color: var(--gs-accent-strong); text-decoration: none; }
.cp__overview-state {
  display: flex; align-items: center; gap: 10px; margin-top: 14px; padding: 14px;
  border-radius: 10px; background: var(--gs-divider); color: var(--gs-fg-muted); font-size: 13px;
}
.cp__overview-state--error { color: var(--gs-warn); }
.cp__manual-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
.cp__manual-toggle {
  border: 1px solid var(--gs-border-strong); border-radius: 8px; background: var(--gs-surface);
  color: var(--gs-fg-2); padding: 6px 10px; font-size: 12px; cursor: pointer;
}
.cp__manual-toggle:hover { border-color: var(--gs-accent); color: var(--gs-accent-strong); }
.cp__manual-form {
  display: grid; gap: 10px; padding: 12px; margin-bottom: 10px;
  border: 1px solid var(--gs-border); border-radius: 10px;
}
.cp__manual-form textarea,
.cp__manual-form input {
  width: 100%; box-sizing: border-box; border: 1.5px solid var(--gs-border-strong);
  border-radius: 9px; padding: 8px 10px; font-size: 13px; font-family: inherit; outline: 0;
}
.cp__manual-form textarea:focus,
.cp__manual-form input:focus { border-color: var(--gs-accent); }
.cp__manual-form .cp__field { margin-bottom: 0; }
.cp__manual-actions { display: flex; justify-content: flex-end; gap: 8px; }
.cp__manual-actions .cp__btn { padding: 8px 14px; font-size: 12.5px; }

@media (max-width: 620px) {
  .cp__item { flex-wrap: wrap; }
  .cp__item-side { width: 100%; justify-content: flex-end; flex-wrap: wrap; }
}
@media (max-width: 560px) {
  .cp__modal { padding: 8px; }
  .cp__modal-body, .cp__facts-panel { max-height: calc(100dvh - 16px); }
  .cp__facts-head { padding: 18px 16px 0; }
  .cp__facts-hint { display: none; }
  .cp__facts-body { padding: 0 16px 12px; }
  .cp__tabs { margin: 12px 0 8px; overflow-x: auto; }
  .cp__manual-bar .cp__muted { display: none; }
  .cp__claim-bar, .cp__facts-foot { align-items: stretch; padding: 12px 16px; }
  .cp__claim-bar { flex-direction: column; }
  .cp__claim-actions { width: 100%; }
  .cp__claim-actions .cp__btn { flex: 1; }
  .cp__facts-ready { display: none; }
  .cp__facts-foot .cp__btn { width: 100%; }
}

/* P5b-09：公司档案表格化 */
.cp__filters { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.cp__search {
  flex: 1; min-width: 220px; max-width: 420px; border: 1px solid var(--gs-border-strong);
  border-radius: 10px; padding: 8px 12px; font: inherit; font-size: 13px;
  background: var(--gs-surface); color: var(--gs-fg);
}
.cp__status-filter {
  border: 1px solid var(--gs-border-strong); border-radius: 10px; padding: 8px 10px;
  background: var(--gs-surface); color: var(--gs-fg-2); font-size: 13px;
}
.cp__table-wrap { border: 1px solid var(--gs-border); border-radius: 14px; background: var(--gs-surface); overflow: auto; }
.cp__table { width: 100%; border-collapse: collapse; font-size: 13px; }
.cp__table th, .cp__table td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--gs-divider); vertical-align: middle; }
.cp__table th { font-size: 12px; font-weight: 600; color: var(--gs-fg-muted); background: var(--gs-surface-2); white-space: nowrap; }
.cp__table tbody tr { height: 60px; }
.cp__table tbody tr:hover { background: var(--gs-surface-2); }
.cp__table tr:last-child td { border-bottom: none; }
.cp__mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--gs-fg-muted); }
.cp__actions-cell { display: flex; gap: 8px; align-items: center; }
.cp__primary-sm {
  border: none; border-radius: 8px; padding: 7px 13px; font-size: 12.5px; font-weight: 600;
  background: var(--gs-accent-cta); color: var(--gs-accent-cta-fg); cursor: pointer; white-space: nowrap;
}
.cp__more { position: relative; }
.cp__more summary {
  list-style: none; cursor: pointer; font-size: 12.5px; color: var(--gs-fg-muted);
  border: 1px solid var(--gs-border-strong); border-radius: 8px; padding: 7px 10px; white-space: nowrap;
}
.cp__more summary::-webkit-details-marker { display: none; }
.cp__menu {
  position: absolute; right: 0; top: calc(100% + 6px); z-index: 20; min-width: 160px;
  background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 10px;
  box-shadow: var(--gs-shadow-card); padding: 6px; display: grid; gap: 2px;
}
.cp__menu button {
  border: none; background: none; text-align: left; padding: 8px 10px; border-radius: 8px;
  font-size: 12.5px; color: var(--gs-fg-2); cursor: pointer;
}
.cp__menu button:hover { background: var(--gs-surface-2); }
.cp__menu button.is-danger { color: var(--gs-danger); }

/* ── 2026-11-25：公司档案 = 主档案 + 关联公司（对齐买家线索/找买家的卡片语言） ── */
.co-sr-only {
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
.co-muted {
  margin: 0;
  color: var(--gs-fg-muted);
  font-size: 13px;
  line-height: 20px;
}
.co-label {
  margin: 0;
  color: var(--gs-fg-muted);
  font-size: 12px;
  line-height: 18px;
}
.co-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.co-chip {
  margin: 0;
  padding-inline: 8px;
  border-radius: 6px;
  background: var(--gs-surface-2);
  color: var(--gs-fg-muted);
  font-size: 12px;
  line-height: 22px;
}
.co-badge {
  margin: 0;
  padding-inline: 8px;
  border-radius: 6px;
  background: var(--gs-accent-soft);
  color: var(--gs-accent-fg);
  font-size: 12px;
  line-height: 22px;
  font-weight: 500;
}
.co-logo {
  display: grid;
  flex: none;
  place-items: center;
  width: 56px;
  height: 56px;
  border-radius: 12px;
  background: var(--gs-accent-soft);
  color: var(--gs-accent-fg);
  font-size: 20px;
  font-weight: 600;
  line-height: 1;
}
.co-logo--sm {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  font-size: 16px;
}

/* 主档案卡 */
.co-primary__body {
  display: grid;
}
.co-primary__grid {
  display: grid;
  grid-template-areas:
    'identity'
    'kpis'
    'next';
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  padding: 20px 24px;
}
.co-primary__identity {
  grid-area: identity;
  display: flex;
  min-width: 0;
  gap: 14px;
  align-items: flex-start;
}
.co-primary__title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.co-primary__title h2 {
  margin: 0;
  color: var(--gs-fg);
  font-size: 18px;
  line-height: 26px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.co-primary__kpis {
  grid-area: kpis;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.co-kpi {
  display: grid;
  gap: 2px;
  width: 100%;
  padding: 10px 12px;
  border: 0;
  border-radius: 10px;
  background: var(--gs-surface-2);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    box-shadow 0.15s ease;
}
.co-kpi:hover {
  background: var(--gs-accent-soft);
}
.co-kpi:focus-visible {
  outline: 2px solid var(--gs-accent);
  outline-offset: 1px;
}
.co-kpi strong {
  color: var(--gs-fg);
  font-size: 20px;
  line-height: 26px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.co-kpi span {
  color: var(--gs-fg-muted);
  font-size: 12px;
  line-height: 18px;
}
.co-next {
  grid-area: next;
  display: grid;
  align-content: start;
  gap: 4px;
  padding: 14px 16px;
  border: 1px solid var(--gs-accent-soft-border);
  border-radius: 10px;
  background: var(--gs-accent-soft);
}
.co-next .co-label {
  color: var(--gs-accent-fg);
}
.co-next__title {
  margin: 0;
  color: var(--gs-fg);
  font-size: 14px;
  line-height: 22px;
  font-weight: 600;
}
.co-next__desc {
  margin: 0 0 6px;
  color: var(--gs-fg-muted);
  font-size: 12.5px;
  line-height: 20px;
}
.co-next :deep(.ant-btn) {
  justify-self: start;
}
.co-next--ready {
  gap: 10px;
}
.co-primary__foot {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 14px 24px 18px;
  border-top: 1px solid var(--gs-divider);
}
.co-icp {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.co-icp__value {
  margin: 0;
  color: var(--gs-fg);
  font-size: 13px;
  line-height: 20px;
}
.co-icp__value strong {
  font-weight: 600;
}

/* 关联公司 */
.co-related {
  display: grid;
  gap: 12px;
}
.co-related__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.co-related__title {
  margin: 0;
  color: var(--gs-fg);
  font-size: 16px;
  line-height: 24px;
  font-weight: 600;
}
.co-related__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
}
.co-rel-card {
  display: grid;
  gap: 4px;
}
.co-rel-card__top {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.co-rel-card__top > :last-child {
  margin-left: auto;
  flex: none;
}
.co-rel-card__name {
  margin: 0;
  color: var(--gs-fg);
  font-size: 15px;
  line-height: 22px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.co-rel-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

/* 弹层表单 */
.co-modal-desc {
  margin: 0;
  color: var(--gs-fg-muted);
  font-size: 13px;
  line-height: 1.8;
}
.co-form {
  display: grid;
  gap: 12px;
}
.co-field {
  display: grid;
  gap: 6px;
  color: var(--gs-fg-muted);
  font-size: 12px;
  font-weight: 500;
}
.co-candidates {
  display: grid;
  gap: 8px;
  justify-items: start;
}
.co-candidate-list {
  display: grid;
  gap: 8px;
  width: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
}
.co-candidate {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--gs-surface-2);
}
.co-candidate strong {
  display: block;
  color: var(--gs-fg);
  font-size: 13px;
}
.co-candidate span {
  color: var(--gs-fg-muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}

/* 内容区变宽后：主档案三列，关联公司两列 */
@container (min-width: 960px) {
  .co-primary__grid {
    grid-template-areas: 'identity kpis next';
    grid-template-columns: minmax(0, 1.35fr) minmax(280px, 0.9fr) minmax(260px, 0.9fr);
    align-items: start;
  }
  .co-primary__kpis {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .co-related__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

/* ── 2026-11-25：页内档案工作台（企业事实 + 资料库，不再用弹窗） ────────── */
.co-workspace {
  overflow: hidden;
}
.co-workspace__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 20px 24px 0;
}
.co-workspace__eyebrow {
  margin: 0 0 2px;
  color: var(--gs-accent-strong);
  font-size: 12px;
  line-height: 18px;
  font-weight: 600;
}
.co-workspace__title {
  margin: 0;
  color: var(--gs-fg);
  font-size: 17px;
  line-height: 26px;
  font-weight: 600;
}
.co-workspace__hint {
  margin: 4px 0 0;
  max-width: 640px;
  color: var(--gs-fg-muted);
  font-size: 12.5px;
  line-height: 20px;
}
.co-workspace__tools {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
.co-workspace__field {
  display: grid;
  gap: 4px;
  color: var(--gs-fg-muted);
  font-size: 12px;
  line-height: 18px;
}
.co-workspace__select {
  width: 280px;
}
.co-workspace__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 12px;
  padding: 8px 24px 12px;
  border-bottom: 1px solid var(--gs-divider);
}
.co-workspace__context {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.co-workspace__body {
  padding: 16px 24px 20px;
  outline: none;
}
.co-workspace__body:focus-visible {
  outline: 2px solid var(--gs-accent);
  outline-offset: -2px;
}

.co-pane__title {
  margin: 0;
  color: var(--gs-fg);
  font-size: 15px;
  line-height: 22px;
  font-weight: 600;
}
.co-panel__state {
  display: grid;
  gap: 8px;
  justify-items: center;
  padding: 20px 14px;
  border: 1px dashed var(--gs-border);
  border-radius: 10px;
  color: var(--gs-fg-muted);
  font-size: 13px;
  line-height: 1.7;
  text-align: center;
}
.co-panel__state--error {
  color: var(--gs-warn);
}

/* 事实：左概览/冲突，右审批清单 */
.co-facts {
  display: grid;
  grid-template-areas:
    'main'
    'aside'
    'foot';
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
}
.co-facts__aside,
.co-facts__main {
  display: grid;
  gap: 10px;
  align-content: start;
  min-width: 0;
}
.co-facts__main {
  grid-area: main;
}
.co-facts__aside {
  grid-area: aside;
}
.co-facts__aside .cp__conflicts {
  margin-top: 0;
}
.co-facts__main .cp__tabs {
  margin: 0;
  border-bottom: 0;
}
.co-facts__main .cp__tab {
  border-bottom: 0;
  border-radius: 8px;
}
.co-facts__main .cp__tab--active {
  background: var(--gs-accent-soft);
}
.co-facts__main .cp__tab--active .cp__tab-count {
  background: var(--gs-surface);
}
.co-facts__main .cp__claims {
  max-height: 540px;
  overflow-y: auto;
}
.co-facts__main .cp__claim-bar {
  padding: 10px 12px;
  border: 1px solid var(--gs-border);
  border-radius: 10px;
  box-shadow: none;
}
.co-facts__search {
  width: 100%;
}
.co-facts__foot {
  display: flex;
  grid-area: foot;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding-top: 14px;
  border-top: 1px solid var(--gs-divider);
}

/* 资料库：左文件清单，右检索 */
.co-docs {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
}
.co-docs__main,
.co-docs__search-pane {
  display: grid;
  gap: 12px;
  align-content: start;
  min-width: 0;
}
.co-docs__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.co-docs__upload {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.co-docs__file {
  display: none;
}
.co-docs__list {
  max-height: 540px;
  margin: 0;
}
.co-docs__search-pane {
  padding: 16px;
  border-radius: 12px;
  background: var(--gs-surface-2);
}
.co-docs__search-form {
  display: flex;
  gap: 8px;
}
.co-docs__search-form :deep(.ant-input) {
  flex: 1;
  min-width: 0;
}
.co-docs__hits {
  max-height: 460px;
  margin-top: 0;
}

@container (min-width: 900px) {
  .co-facts {
    grid-template-areas:
      'aside main'
      'foot foot';
    grid-template-columns: minmax(280px, 0.82fr) minmax(0, 1.18fr);
    align-items: start;
  }
  .co-docs {
    grid-template-columns: minmax(0, 1.25fr) minmax(280px, 0.75fr);
    align-items: start;
  }
}

@container (max-width: 719px) {
  .co-workspace__head,
  .co-workspace__bar,
  .co-workspace__body {
    padding-inline: 16px;
  }
  .co-workspace__tools {
    width: 100%;
  }
  .co-workspace__field {
    flex: 1 1 200px;
  }
  .co-workspace__select {
    width: 100%;
  }
  .co-facts__foot {
    align-items: stretch;
    flex-direction: column;
  }
  .co-facts__foot :deep(.ant-btn) {
    width: 100%;
  }
  .co-docs__upload {
    width: 100%;
  }
}

/* 单栏但较宽（平板）：概览通栏，关键信息排两列，免得右半边空着 */
@container (min-width: 560px) and (max-width: 899px) {
  .co-overview__facts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    column-gap: 16px;
  }
}
@container (max-width: 559px) {
  .co-overview__stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .co-workspace .cp__conflict-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

</style>
