<script lang="ts" setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

import { $t } from '#/locales';
import { formatDate } from '@gain-saas/shared';
import { newAttemptId } from '#/utils/attempt-id';
import ErrorNotice from '#/components/error-notice.vue';

import {
  failureText,
  gainosApi,
  type CompanyClaim,
  type CompanyCompleteness,
  type CompanyConflict,
  type CompanyOffering,
  type CompanyProfile,
  type SellerDocument,
  type UpdateCompanyInput,
  type WebsiteCandidate,
} from '#/api/gainos';

defineOptions({ name: 'Companies' });

const router = useRouter();

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

async function openClaims(company: CompanyProfile): Promise<void> {
  if (!company.id) return;
  claimsCompany.value = company;
  claimsOpen.value = true;
  claimTab.value = 'NEEDS_REVIEW';
  claimQuery.value = '';
  selectedClaimIds.value = [];
  claimActionError.value = null;
  claimNotice.value = null;
  rejectArmed.value = false;
  manualOpen.value = false;
  manualStatement.value = '';
  manualEvidence.value = '';
  manualError.value = null;
  await Promise.all([loadClaims(), loadCompanyOverview(), loadConflicts()]);
}

function closeClaims(): void {
  if (claimBusy.value) return;
  claimsOpen.value = false;
  claimsCompany.value = null;
  claims.value = [];
  companyOverview.value = null;
  completeness.value = null;
  offerings.value = [];
  overviewError.value = null;
  conflicts.value = [];
  conflictsError.value = null;
  selectedClaimIds.value = [];
  manualOpen.value = false;
}

function unwrap<T>(value: T | { data?: T }): T {
  const wrapped = value as { data?: T };
  return wrapped?.data ?? (value as T);
}

async function loadCompanyOverview(): Promise<void> {
  const companyId = claimsCompany.value?.id;
  if (!companyId) return;
  overviewLoading.value = true;
  overviewError.value = null;
  try {
    const [detail, stats, items] = await Promise.all([
      gainosApi.companyDetail(companyId),
      gainosApi.companyCompleteness(companyId),
      gainosApi.companyOfferings(companyId),
    ]);
    companyOverview.value = unwrap(detail);
    completeness.value = unwrap(stats);
    const rows = unwrap(items);
    offerings.value = Array.isArray(rows) ? rows : [];
  } catch (err) {
    overviewError.value = failureText(err).title;
  } finally {
    overviewLoading.value = false;
  }
}

async function loadConflicts(): Promise<void> {
  const companyId = claimsCompany.value?.id;
  if (!companyId) return;
  conflictsLoading.value = true;
  conflictsError.value = null;
  try {
    const data = await gainosApi.companyConflicts(companyId);
    const rows = unwrap(data);
    conflicts.value = (Array.isArray(rows) ? rows : []).filter((item) => !item.status || item.status === 'OPEN');
  } catch (err) {
    conflictsError.value = failureText(err).title;
  } finally {
    conflictsLoading.value = false;
  }
}

async function resolveConflict(conflict: CompanyConflict, keep: 'a' | 'b'): Promise<void> {
  if (!window.confirm($t('gainos.companies.conflictConfirm'))) return;
  conflictBusy.value = conflict.id;
  claimActionError.value = null;
  try {
    await gainosApi.resolveConflict(conflict.id, keep);
    claimNotice.value = $t('gainos.companies.conflictResolved');
    await Promise.all([loadClaims(), loadCompanyOverview(), loadConflicts()]);
  } catch (err) {
    claimActionError.value = failureText(err).title;
  } finally {
    conflictBusy.value = '';
  }
}

async function revokeClaim(claim: CompanyClaim): Promise<void> {
  if (!window.confirm($t('gainos.companies.revokeConfirm'))) return;
  revokingId.value = claim.id;
  claimActionError.value = null;
  try {
    await gainosApi.revokeClaim(claim.id);
    claimNotice.value = $t('gainos.companies.revoked');
    await Promise.all([loadClaims(), loadCompanyOverview(), loadConflicts()]);
  } catch (err) {
    claimActionError.value = failureText(err).title;
  } finally {
    revokingId.value = '';
  }
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
    await Promise.all([loadClaims(), loadCompanyOverview()]);
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
  claimNotice.value = null;
  try {
    const result = unwrap(await gainosApi.synthesizeClaimDrafts(companyId));
    claimNotice.value =
      result.created > 0
        ? $t('gainos.companies.synthesizeDraftsCreated', { count: result.created })
        : $t('gainos.companies.synthesizeDraftsNone');
    claimTab.value = 'NEEDS_REVIEW';
    await Promise.all([loadClaims(), loadCompanyOverview()]);
  } catch (err) {
    claimActionError.value = failureText(err).title;
  } finally {
    synthBusy.value = false;
  }
}

async function loadClaims(): Promise<void> {
  const companyId = claimsCompany.value?.id;
  if (!companyId) return;
  claimsLoading.value = true;
  claimsError.value = null;
  try {
    const data = await gainosApi.claims(companyId);
    // BFF/引擎的列表响应可能已由 request.ts 解包，也可能仍是 { data }。
    claims.value = Array.isArray(data) ? data : ((data as unknown as { data?: CompanyClaim[] })?.data ?? []);
    selectedClaimIds.value = selectedClaimIds.value.filter((id) =>
      claims.value.some((claim) => claim.id === id && claim.status === 'NEEDS_REVIEW'));
  } catch (err) {
    claimsError.value = failureText(err);
    claims.value = [];
  } finally {
    claimsLoading.value = false;
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
  await loadClaims();
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

async function removeCompany(company: CompanyProfile): Promise<void> {
  const companyId = company.id;
  if (!companyId) return;
  if (!window.confirm($t('gainos.companies.deleteConfirm'))) return;
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
}

// ── 资料库（Phase 2c）：上传（引擎中转）→ 解析 → 检索 ─────────────────────────
const docsOpen = ref(false);
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
let docsTimer: ReturnType<typeof setInterval> | null = null;

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

async function openDocuments(company: CompanyProfile): Promise<void> {
  docsCompany.value = company;
  docsOpen.value = true;
  docsError.value = null;
  docsNotice.value = null;
  docsQuery.value = '';
  docsHits.value = [];
  docsCursor.value = undefined;
  docsHasMore.value = false;
  await loadDocuments(true, true);
  // P5b-09：轮询降频 4s→10s；列表稳定（无处理中）后停止轮询，避免弹层开着就一直打接口。
  docsTimer = setInterval(() => {
    if (!docsOpen.value) return;
    const busy = docs.value.some((row) => ['pending_upload', 'committing', 'queued', 'processing'].includes(row.status));
    if (busy) {
      void loadDocuments(true);
      return;
    }
    if (docsTimer) {
      clearInterval(docsTimer);
      docsTimer = null;
    }
  }, 10_000);
}

function closeDocuments(): void {
  docsOpen.value = false;
  if (docsTimer) {
    clearInterval(docsTimer);
    docsTimer = null;
  }
}

async function loadDocuments(silent = false, reset = true): Promise<void> {
  const companyId = docsCompany.value?.id;
  if (!companyId) return;
  if (!silent) docsLoading.value = true;
  try {
    // P5b-09：资料库改游标分页；reset 拉第一页，否则按 docsCursor 追加。
    const page = await gainosApi.sellerDocuments(companyId, reset ? undefined : docsCursor.value);
    const rows = page?.data ?? [];
    docs.value = reset ? rows : [...docs.value, ...rows];
    docsCursor.value = page?.page?.next_cursor ?? undefined;
    docsHasMore.value = Boolean(page?.page?.has_more && page?.page?.next_cursor);
    docsError.value = null;
  } catch (err) {
    if (!silent) docsError.value = failureText(err).title;
  } finally {
    docsLoading.value = false;
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
  docsSearching.value = true;
  try {
    docsHits.value = (await gainosApi.searchSellerDocuments(companyId, q)) ?? [];
  } catch (err) {
    docsError.value = failureText(err).title;
    docsHits.value = [];
  } finally {
    docsSearching.value = false;
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
  try {
    const signed = await gainosApi.sellerDocumentDownloadUrl(row.id);
    window.open(signed.url, '_blank', 'noopener');
  } catch (err) {
    docsError.value = failureText(err).title;
  }
}

async function removeDocument(row: SellerDocument): Promise<void> {
  if (!window.confirm($t('gainos.companies.documentDeleteConfirm'))) return;
  try {
    await gainosApi.deleteSellerDocument(row.id);
    docsNotice.value = $t('gainos.companies.documentDeleted');
    await loadDocuments();
  } catch (err) {
    docsError.value = failureText(err).title;
  }
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
    error.value = failureText(err).title;
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
  if (claimsOpen.value) {
    closeClaims();
  } else if (wizardOpen.value) {
    wizardOpen.value = false;
  }
}
onMounted(async () => {
  window.addEventListener('keydown', onEscape);
  try {
    const session = await gainosApi.session();
    isAdmin.value = session.workspace?.role === 'admin';
  } catch {
    isAdmin.value = false;
  }
  await load();
});
onUnmounted(() => {
  window.removeEventListener('keydown', onEscape);
  if (pollTimer) clearInterval(pollTimer);
  if (docsTimer) clearInterval(docsTimer);
});
</script>

<template>
  <div class="cp">
    <header class="cp__head">
      <div>
        <h1>{{ $t('gainos.companies.title') }}</h1>
        <p>{{ $t('gainos.companies.subtitle') }}</p>
      </div>
      <button class="cp__cta" type="button" @click="openWizard">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 4v12M4 10h12"/></svg>
        {{ $t('gainos.companies.cta') }}
      </button>
    </header>

    <!-- 状态：加载 / 引擎未授权 / 空 / 列表 -->
    <p v-if="createdNotice" class="cp__claim-notice" role="status">{{ createdNotice }}</p>

    <div v-if="loading" class="cp__state cp__state--loading">{{ $t('gainos.companies.loading') }}</div>

    <div v-else-if="error" class="cp__state cp__state--error">
      <p class="cp__state-title">{{ error }}</p>
      <p class="cp__state-desc">{{ $t('gainos.companies.errorWhy') }}</p>
      <button type="button" class="cp__state-retry" @click="load()">{{ $t('gainos.common.retry') }}</button>
    </div>

    <div v-else-if="companies.length === 0" class="cp__state cp__state--empty">
      <div class="cp__empty-mark">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 21V8l8-4.5L20 8v13"/><path d="M9.5 21v-6h5v6"/></svg>
      </div>
      <p class="cp__state-title">{{ $t('gainos.companies.emptyTitle') }}</p>
      <p class="cp__state-desc">{{ $t('gainos.companies.emptyDesc') }}</p>
      <button type="button" class="cp__cta" @click="openWizard">{{ $t('gainos.companies.emptyCta') }}</button>
    </div>

    <template v-else>
      <div class="cp__filters">
        <input
          v-model="searchQuery"
          class="cp__search"
          type="search"
          :placeholder="$t('gainos.companies.searchPlaceholder')"
        />
        <select v-model="statusFilter" class="cp__status-filter">
          <option v-for="status in STATUS_FILTERS" :key="status" :value="status">
            {{ status === 'ALL' ? $t('gainos.companies.filterAll') : status === 'FAILED' ? $t('gainos.companies.statusFailed') : statusLabel(status) }}
          </option>
        </select>
        <span class="cp__muted">
          {{ $t('gainos.companies.showing', { shown: filteredCompanies.length, total: companies.length }) }}
        </span>
      </div>
      <div class="cp__table-wrap">
        <table class="cp__table">
          <thead>
            <tr>
              <th>{{ $t('gainos.companies.colCompany') }}</th>
              <th>{{ $t('gainos.companies.colStatus') }}</th>
              <th>{{ $t('gainos.companies.colDomain') }}</th>
              <th>{{ $t('gainos.companies.colIndustry') }}</th>
              <th>{{ $t('gainos.companies.colCreated') }}</th>
              <th>{{ $t('gainos.companies.colActions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in filteredCompanies" :key="c.id">
              <td>
                <strong>{{ c.name ?? c.domain ?? c.website ?? $t('gainos.companies.unnamed') }}</strong>
                <span v-if="understandingFailed(c)" class="cp__item-error">
                  {{ c.understandingLastError ?? $t('gainos.companies.statusFailed') }}
                </span>
              </td>
              <td>
                <span
                  class="cp__badge"
                  :class="understandingFailed(c) ? 'cp__badge--failed' : `cp__badge--${(c.status ?? 'DRAFT').toLowerCase()}`"
                >
                  {{ understandingFailed(c) ? $t('gainos.companies.statusFailed') : statusLabel(c.status) }}
                </span>
              </td>
              <td class="cp__mono">{{ c.website ?? c.domain ?? '—' }}</td>
              <td>{{ c.industry ?? '—' }}</td>
              <td>{{ formatDate(c.created_at) || '—' }}</td>
              <td class="cp__actions-cell">
                <button
                  v-if="c.status === 'REVIEW' || c.status === 'ACTIVE'"
                  type="button"
                  class="cp__primary-sm"
                  @click="openClaims(c)"
                >
                  {{ $t('gainos.companies.facts') }}
                </button>
                <button
                  v-else-if="c.status === 'DRAFT'"
                  type="button"
                  class="cp__primary-sm"
                  @click="openEdit(c)"
                >
                  {{ $t('gainos.companies.complete') }}
                </button>
                <span v-else class="cp__muted">—</span>
                <details class="cp__more">
                  <summary>{{ $t('gainos.companies.more') }}</summary>
                  <div class="cp__menu">
                    <button type="button" @click="openDocuments(c)">{{ $t('gainos.companies.documents') }}</button>
                    <button v-if="understandingFailed(c)" type="button" :disabled="retryingId === c.id" @click="retryUnderstanding(c)">
                      {{ $t('gainos.companies.retryUnderstanding') }}
                    </button>
                    <button v-if="c.status === 'REVIEW'" type="button" :disabled="confirmingId === c.id" @click="confirmCompany(c)">
                      {{ $t('gainos.companies.confirm') }}
                    </button>
                    <button v-if="c.status === 'DRAFT'" type="button" @click="openEdit(c)">{{ $t('gainos.companies.edit') }}</button>
                    <button v-if="c.status === 'DRAFT'" type="button" class="is-danger" :disabled="deletingId === c.id" @click="removeCompany(c)">
                      {{ $t('gainos.companies.delete') }}
                    </button>
                  </div>
                </details>
              </td>
            </tr>
            <tr v-if="filteredCompanies.length === 0">
              <td colspan="6" class="cp__muted">{{ $t('gainos.companies.noMatch') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- 建档向导（官网可选；至少名称或官网其一） -->
    <Teleport to="body">
      <div v-if="wizardOpen" class="cp__modal" :aria-label="$t('gainos.companies.wizardTitle')">
        <div class="cp__modal-mask" @click="wizardOpen = false"></div>
        <div class="cp__modal-body">
          <header>
            <h2>{{ $t('gainos.companies.wizardTitle') }}</h2>
            <button type="button" class="cp__modal-x" aria-label="Close" @click="wizardOpen = false">✕</button>
          </header>
          <p class="cp__modal-hint">{{ $t('gainos.companies.wizardHint') }}</p>
          <form novalidate @submit.prevent="create">
            <label class="cp__field">
              <span>{{ $t('gainos.companies.website') }}</span>
              <input v-model="form.website" type="url" :placeholder="$t('gainos.companies.websitePlaceholder')" />
            </label>
            <label class="cp__field">
              <span>{{ $t('gainos.companies.name') }}</span>
              <input v-model="form.name" type="text" :placeholder="$t('gainos.companies.namePlaceholder')" />
            </label>
            <p v-if="formError" class="cp__form-err" role="alert">{{ formError }}</p>
            <div class="cp__modal-actions">
              <button type="button" class="cp__btn cp__btn--ghost" @click="wizardOpen = false">{{ $t('gainos.common.cancel') }}</button>
              <button type="submit" class="cp__btn cp__btn--primary" :disabled="creating">
                {{ creating ? $t('gainos.companies.creating') : $t('gainos.companies.create') }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Teleport>

    <!-- 档案编辑 + 自动找官网（2026-11-03）：补官网后可一键启动理解 -->
    <Teleport to="body">
      <div v-if="editOpen" class="cp__modal" role="dialog" aria-modal="true" :aria-label="$t('gainos.companies.editTitle')">
        <div class="cp__modal-mask" @click="editOpen = false"></div>
        <div class="cp__modal-body">
          <header>
            <h2>{{ $t('gainos.companies.editTitle') }}</h2>
            <button type="button" class="cp__modal-x" aria-label="Close" @click="editOpen = false">✕</button>
          </header>
          <p class="cp__modal-hint">{{ $t('gainos.companies.editHint') }}</p>
          <form novalidate @submit.prevent="saveEdit">
            <label class="cp__field">
              <span>{{ $t('gainos.companies.name') }}</span>
              <input v-model="editForm.name" type="text" maxlength="200" />
            </label>
            <label class="cp__field">
              <span>{{ $t('gainos.companies.website') }}</span>
              <input v-model="editForm.website" type="url" :placeholder="$t('gainos.companies.websitePlaceholder')" />
            </label>
            <div class="cp__candidates">
              <button type="button" class="cp__btn cp__btn--ghost" :disabled="candidatesLoading" @click="findCandidates">
                {{ candidatesLoading ? $t('gainos.companies.autoFinding') : $t('gainos.companies.autoFind') }}
              </button>
              <p v-if="candidatesError" class="cp__modal-hint">{{ candidatesError }}</p>
              <template v-if="candidates.length > 0">
                <p class="cp__modal-hint">{{ $t('gainos.companies.autoFindHint') }}</p>
                <ul class="cp__candidate-list">
                  <li v-for="candidate in candidates" :key="candidate.url" class="cp__candidate">
                    <div class="cp__candidate-main">
                      <strong>{{ candidate.title || candidate.url }}</strong>
                      <span>{{ candidate.url }}</span>
                    </div>
                    <button type="button" class="cp__confirm" @click="useCandidate(candidate)">
                      {{ $t('gainos.companies.useCandidate') }}
                    </button>
                  </li>
                </ul>
              </template>
            </div>
            <label class="cp__field">
              <span>{{ $t('gainos.companies.industryLabel') }}</span>
              <input v-model="editForm.industry" type="text" maxlength="200" :placeholder="$t('gainos.companies.industryPlaceholder')" />
            </label>
            <label class="cp__field">
              <span>{{ $t('gainos.companies.businessEmailLabel') }}</span>
              <input v-model="editForm.businessEmail" type="email" maxlength="320" :placeholder="$t('gainos.companies.businessEmailPlaceholder')" />
            </label>
            <label class="cp__field">
              <span>{{ $t('gainos.companies.targetMarketsLabel') }}</span>
              <input v-model="editForm.markets" type="text" :placeholder="$t('gainos.companies.targetMarketsPlaceholder')" />
            </label>
            <p v-if="editError" class="cp__form-err" role="alert">{{ editError }}</p>
            <div class="cp__modal-actions">
              <button type="button" class="cp__btn cp__btn--ghost" @click="editOpen = false">{{ $t('gainos.common.cancel') }}</button>
              <button type="submit" class="cp__btn cp__btn--primary" :disabled="editSaving">
                {{ editSaving ? $t('gainos.companies.saving') : $t('gainos.companies.save') }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Teleport>

    <!-- 资料库（Phase 2c）：上传经引擎中转 → 解析状态 → 检索 -->
    <Teleport to="body">
      <div v-if="docsOpen" class="cp__modal" role="dialog" aria-modal="true" :aria-label="$t('gainos.companies.documentsTitle')">
        <div class="cp__modal-mask" @click="closeDocuments"></div>
        <div class="cp__modal-body cp__docs-panel">
          <header>
            <h2>{{ $t('gainos.companies.documentsTitle') }} · {{ docsCompany?.name ?? '' }}</h2>
            <button type="button" class="cp__modal-x" aria-label="Close" @click="closeDocuments">✕</button>
          </header>
          <p class="cp__modal-hint">{{ $t('gainos.companies.documentsHint') }}</p>
          <div class="cp__docs-actions">
            <label class="cp__btn cp__btn--primary cp__docs-upload" :class="{ 'cp__btn--busy': docsUploading }">
              {{ docsUploading ? $t('gainos.companies.uploading') : $t('gainos.companies.upload') }}
              <input type="file" accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.md" :disabled="docsUploading" @change="uploadDocument" />
            </label>
            <span class="cp__docs-formats">{{ $t('gainos.companies.uploadFormats') }}</span>
          </div>
          <p v-if="docsNotice" class="cp__claim-notice" role="status">{{ docsNotice }}</p>
          <p v-if="docsError" class="cp__form-err" role="alert">{{ docsError }}</p>
          <div v-if="docsLoading && docs.length === 0" class="cp__modal-hint">{{ $t('gainos.companies.loading') }}</div>
          <ul v-else-if="docs.length > 0" class="cp__docs-list">
            <li v-for="row in docs" :key="row.id" class="cp__docs-item">
              <div class="cp__docs-main">
                <strong>{{ row.filename }}</strong>
                <span>{{ docSizeLabel(row) }} · {{ docStatusLabel(row.status) }}<template v-if="row.status === 'ready'"> · {{ $t('gainos.companies.documentChunks', { count: row.chunkCount ?? 0 }) }}</template></span>
                <span v-if="row.processingErrorCode" class="cp__item-error">{{ row.processingErrorCode }}</span>
              </div>
              <div class="cp__docs-side">
                <button v-if="row.status === 'ready'" type="button" class="cp__confirm" @click="downloadDocument(row)">
                  {{ $t('gainos.companies.download') }}
                </button>
                <button v-if="row.status === 'failed_terminal' || row.status === 'queued'" type="button" class="cp__confirm" @click="retryDocument(row)">
                  {{ $t('gainos.companies.retryUnderstanding') }}
                </button>
                <button type="button" class="cp__confirm" @click="removeDocument(row)">
                  {{ $t('gainos.companies.delete') }}
                </button>
              </div>
            </li>
          </ul>
          <p v-if="docsHasMore" class="cp__docs-more">
            <button type="button" class="cp__confirm" :disabled="docsLoading" @click="loadDocuments(true, false)">
              {{ $t('gainos.companies.loadMoreDocuments') }}
            </button>
          </p>
          <p v-else-if="!docsLoading && docs.length === 0" class="cp__modal-hint">{{ $t('gainos.companies.documentsEmpty') }}</p>
          <form class="cp__docs-search" @submit.prevent="searchDocuments">
            <input v-model="docsQuery" type="search" minlength="2" maxlength="200" :placeholder="$t('gainos.companies.documentSearchPlaceholder')" />
            <button type="submit" class="cp__btn cp__btn--ghost" :disabled="docsSearching">
              {{ docsSearching ? $t('gainos.companies.loading') : $t('gainos.companies.documentSearch') }}
            </button>
          </form>
          <ul v-if="docsQuery.trim().length >= 2" class="cp__docs-hits">
            <li v-for="hit in docsHits" :key="`${hit.documentId}-${hit.seq}`" class="cp__docs-hit">
              <strong>{{ hit.filename }} · #{{ hit.seq }}</strong>
              <p>{{ hit.text.slice(0, 200) }}</p>
            </li>
            <li v-if="docsHits.length === 0" class="cp__modal-hint">{{ $t('gainos.companies.documentSearchEmpty') }}</li>
          </ul>
          <div class="cp__modal-actions">
            <button type="button" class="cp__btn cp__btn--ghost" @click="closeDocuments">{{ $t('gainos.companies.close') }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 企业事实审批（KNW-003 人工门）：只有「已通过」的事实进入目标客户画像设计 -->
    <Teleport to="body">
      <div
        v-if="claimsOpen"
        class="cp__modal"
        role="dialog"
        aria-modal="true"
        :aria-label="$t('gainos.companies.factsTitle', { name: claimsCompany?.name ?? claimsCompany?.domain ?? '' })"
      >
        <div class="cp__modal-mask" @click="closeClaims"></div>
        <div class="cp__modal-body cp__facts-panel" tabindex="-1" @keydown.esc="closeClaims">
          <header class="cp__facts-head">
            <div>
              <h2>{{ $t('gainos.companies.factsTitle', { name: claimsCompany?.name ?? claimsCompany?.domain ?? '' }) }}</h2>
              <p class="cp__facts-hint">{{ $t('gainos.companies.factsHint') }}</p>
            </div>
            <button type="button" class="cp__modal-x" :aria-label="$t('gainos.companies.close')" @click="closeClaims">✕</button>
          </header>

          <div class="cp__facts-body">
          <div v-if="overviewLoading" class="cp__overview-state">{{ $t('gainos.companies.overviewLoading') }}</div>
          <div v-else-if="overviewError" class="cp__overview-state cp__overview-state--error">
            <span>{{ overviewError }}</span>
            <button type="button" class="cp__state-retry" @click="loadCompanyOverview">{{ $t('gainos.common.retry') }}</button>
          </div>
          <div v-else class="cp__overview">
            <p v-if="companyOverview?.summary" class="cp__overview-summary">{{ companyOverview.summary }}</p>
            <div class="cp__overview-meta">
              <span v-if="companyOverview?.industry">{{ $t('gainos.companies.overviewIndustry') }}：{{ companyOverview.industry }}</span>
              <span v-if="companyOverview?.targetMarkets?.length">{{ $t('gainos.companies.overviewMarkets') }}：{{ companyOverview.targetMarkets.join(' / ') }}</span>
              <span v-if="companyOverview?.businessEmail">{{ $t('gainos.companies.overviewEmail') }}：{{ companyOverview.businessEmail }}</span>
              <a v-if="companyOverview?.website" :href="companyOverview.website" target="_blank" rel="noopener noreferrer">{{ companyOverview.website }}</a>
            </div>
            <div v-if="completeness" class="cp__stats">
              <div><strong>{{ completeness.approvedClaims }}</strong><span>{{ $t('gainos.companies.statApproved') }}</span></div>
              <div><strong>{{ completeness.pendingClaims }}</strong><span>{{ $t('gainos.companies.statPending') }}</span></div>
              <div><strong>{{ completeness.offerings }}</strong><span>{{ $t('gainos.companies.statOfferings') }}</span></div>
              <div><strong>{{ completeness.conflictsOpen }}</strong><span>{{ $t('gainos.companies.statConflicts') }}</span></div>
            </div>
            <details v-if="offerings.length" class="cp__offerings">
              <summary>{{ $t('gainos.companies.offeringsTitle', { count: offerings.length }) }}</summary>
              <ul>
                <li v-for="offering in offerings" :key="offering.id">
                  <strong>{{ offering.name }}</strong>
                  <span v-if="offering.description"> · {{ offering.description }}</span>
                  <a v-if="offering.sourceUrl" :href="offering.sourceUrl" target="_blank" rel="noopener noreferrer"> ↗</a>
                </li>
              </ul>
            </details>
            <p v-else class="cp__muted">{{ $t('gainos.companies.offeringsEmpty') }}</p>
          </div>

          <div v-if="conflictsLoading || conflictsError || conflicts.length" class="cp__conflicts">
            <div class="cp__conflicts-head">
              <h3>{{ $t('gainos.companies.conflictsTitle', { count: conflicts.length }) }}</h3>
              <p class="cp__muted">{{ $t('gainos.companies.conflictsHint') }}</p>
            </div>
            <p v-if="conflictsLoading" class="cp__muted">{{ $t('gainos.companies.claimsLoading') }}</p>
            <p v-else-if="conflictsError" class="cp__form-err">{{ conflictsError }}</p>
            <div v-for="conflict in conflicts" :key="conflict.id" class="cp__conflict">
              <div class="cp__conflict-head">
                <span class="cp__claim-type">{{ claimTypeLabel(conflict.claimType || conflict.claimA?.type || '') }}</span>
                <span v-if="!isAdmin" class="cp__muted">{{ $t('gainos.companies.conflictsAdminOnly') }}</span>
              </div>
              <div class="cp__conflict-grid">
                <div class="cp__conflict-side">
                  <p>{{ conflict.claimA?.statement || '—' }}</p>
                  <button v-if="isAdmin" type="button" class="cp__conflict-keep" :disabled="conflictBusy === conflict.id" @click="resolveConflict(conflict, 'a')">
                    {{ $t('gainos.companies.keepThis') }}
                  </button>
                </div>
                <div class="cp__conflict-side">
                  <p>{{ conflict.claimB?.statement || '—' }}</p>
                  <button v-if="isAdmin" type="button" class="cp__conflict-keep" :disabled="conflictBusy === conflict.id" @click="resolveConflict(conflict, 'b')">
                    {{ $t('gainos.companies.keepThis') }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div class="cp__tabs" role="tablist">
            <button
              type="button"
              class="cp__tab"
              :class="{ 'cp__tab--active': claimTab === 'NEEDS_REVIEW' }"
              role="tab"
              :aria-selected="claimTab === 'NEEDS_REVIEW'"
              @click="switchClaimTab('NEEDS_REVIEW')"
            >
              {{ $t('gainos.companies.tabPending') }}<span class="cp__tab-count">{{ pendingClaims.length }}</span>
            </button>
            <button
              type="button"
              class="cp__tab"
              :class="{ 'cp__tab--active': claimTab === 'APPROVED' }"
              role="tab"
              :aria-selected="claimTab === 'APPROVED'"
              @click="switchClaimTab('APPROVED')"
            >
              {{ $t('gainos.companies.tabApproved') }}<span class="cp__tab-count">{{ approvedClaims.length }}</span>
            </button>
            <button
              type="button"
              class="cp__tab"
              :class="{ 'cp__tab--active': claimTab === 'REVOKED' }"
              role="tab"
              :aria-selected="claimTab === 'REVOKED'"
              @click="switchClaimTab('REVOKED')"
            >
              {{ $t('gainos.companies.tabIgnored') }}<span class="cp__tab-count">{{ ignoredClaims.length }}</span>
            </button>
          </div>

          <div v-if="isAdmin" class="cp__manual-bar">
            <button type="button" class="cp__manual-toggle" @click="manualOpen = !manualOpen">
              {{ manualOpen ? $t('gainos.companies.manualCancel') : $t('gainos.companies.manualAdd') }}
            </button>
            <button type="button" class="cp__manual-toggle" :disabled="synthBusy" @click="synthesizeDrafts">
              {{ synthBusy ? $t('gainos.common.loading') : $t('gainos.companies.synthesizeDrafts') }}
            </button>
            <span class="cp__muted">{{ $t('gainos.companies.synthesizeDraftsHint') }}</span>
          </div>
          <div v-if="manualOpen" class="cp__manual-form">
            <label class="cp__field">
              <span>{{ $t('gainos.companies.manualStatement') }}</span>
              <textarea v-model="manualStatement" rows="3" maxlength="2000" :placeholder="$t('gainos.companies.manualStatementHint')"></textarea>
            </label>
            <label class="cp__field">
              <span>{{ $t('gainos.companies.manualEvidence') }}</span>
              <input v-model="manualEvidence" type="text" maxlength="2000" :placeholder="$t('gainos.companies.manualEvidenceHint')" />
            </label>
            <p v-if="manualError" class="cp__form-err" role="alert">{{ manualError }}</p>
            <div class="cp__manual-actions">
              <button type="button" class="cp__btn cp__btn--ghost" @click="manualOpen = false">{{ $t('gainos.common.cancel') }}</button>
              <button type="button" class="cp__btn cp__btn--primary" :disabled="manualBusy" @click="saveManualClaim">
                {{ manualBusy ? $t('gainos.common.loading') : $t('gainos.companies.manualSubmit') }}
              </button>
            </div>
          </div>

          <input
            v-model="claimQuery"
            type="search"
            class="cp__claim-search"
            :placeholder="$t('gainos.companies.claimsSearch')"
            :aria-label="$t('gainos.companies.claimsSearch')"
          />

          <div v-if="claimsLoading" class="cp__claims-state">{{ $t('gainos.companies.claimsLoading') }}</div>

          <div v-else-if="claimsError" class="cp__claims-state cp__claims-state--error">
            <ErrorNotice
              :title="claimsError.title"
              :why="claimsError.why"
              :next="claimsError.next"
              :code="claimsError.code"
            />
            <button type="button" class="cp__state-retry" @click="loadClaims">{{ $t('gainos.common.retry') }}</button>
          </div>

          <div v-else-if="visibleClaims.length === 0" class="cp__claims-state">
            <p>{{ claimQuery
              ? $t('gainos.companies.claimsNoMatch')
              : claimTab === 'NEEDS_REVIEW'
                ? $t('gainos.companies.claimsEmptyPending')
                : claimTab === 'APPROVED'
                  ? $t('gainos.companies.claimsEmptyApproved')
                  : $t('gainos.companies.claimsEmptyIgnored') }}</p>
          </div>

          <ul v-else class="cp__claims">
            <li v-for="claim in visibleClaims" :key="claim.id" class="cp__claim">
              <label v-if="isAdmin && claim.status === 'NEEDS_REVIEW'" class="cp__claim-check">
                <input
                  type="checkbox"
                  :checked="selectedClaimIds.includes(claim.id)"
                  :aria-label="$t('gainos.companies.selectClaim')"
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
                    v-if="isAdmin && claim.status === 'APPROVED'"
                    type="button"
                    class="cp__claim-revoke"
                    :disabled="revokingId === claim.id"
                    @click="revokeClaim(claim)"
                  >{{ $t('gainos.companies.revoke') }}</button>
                </div>
                <p class="cp__claim-text">{{ claim.statement }}</p>
                <p v-if="claim.evidence?.[0]?.snippet" class="cp__claim-evidence">{{ claim.evidence[0].snippet }}</p>
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
          </div>

          <div v-if="isAdmin && claimTab === 'NEEDS_REVIEW' && visibleClaims.length > 0" class="cp__claim-bar">
            <label class="cp__claim-selectall">
              <input type="checkbox" :checked="allVisibleSelected" @change="toggleAllVisible" />
              {{ $t('gainos.companies.selectAll') }}
              <span v-if="selectedCount > 0">· {{ $t('gainos.companies.selectedCount', { count: selectedCount }) }}</span>
            </label>
            <div class="cp__claim-actions">
              <button
                type="button"
                class="cp__btn cp__btn--ghost cp__btn--danger"
                :disabled="claimBusy !== null || selectedCount === 0"
                @click="reviewSelected('reject')"
              >
                {{ claimBusy === 'reject'
                  ? claimProgress
                  : rejectArmed
                    ? $t('gainos.companies.confirmReject', { count: selectedCount })
                    : $t('gainos.companies.rejectSelected') }}
              </button>
              <button
                type="button"
                class="cp__btn cp__btn--primary"
                :disabled="claimBusy !== null || selectedCount === 0"
                @click="reviewSelected('approve')"
              >
                {{ claimBusy === 'approve' ? claimProgress : $t('gainos.companies.approveSelected') }}
              </button>
            </div>
          </div>

          <footer class="cp__facts-foot">
            <span class="cp__facts-ready">
              {{ approvedCount > 0
                ? $t('gainos.companies.approvedReady', { count: approvedCount })
                : $t('gainos.companies.approvedNeed') }}
            </span>
            <button type="button" class="cp__btn cp__btn--primary" :disabled="approvedCount === 0" @click="goFindBuyers">
              {{ $t('gainos.companies.goFindBuyers') }}
            </button>
          </footer>
        </div>
      </div>
    </Teleport>
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
.cp__head h1 { margin: 0; font-size: 24px; font-weight: 700; color: var(--gs-fg); }
.cp__head p { margin: 8px 0 0; font-size: 13.5px; color: var(--gs-fg-muted); max-width: 560px; line-height: 1.7; }
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
.cp__field input:focus { border-color: var(--gs-accent); box-shadow: 0 0 0 4px rgba(0,185,107,.12); }
.cp__form-err { margin: 0 0 12px; font-size: 13px; color: var(--gs-danger); background: var(--gs-danger-bg); border: 1px solid var(--gs-danger-border); border-radius: 9px; padding: 9px 12px; }
.cp__modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px; }
.cp__candidates { margin: 4px 0 16px; }
.cp__candidate-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.cp__candidate { display: flex; align-items: center; justify-content: space-between; gap: 12px; border: 1px solid var(--gs-border); border-radius: 10px; padding: 10px 12px; }
.cp__candidate-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cp__candidate-main strong { font-size: 13px; color: var(--gs-fg-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp__candidate-main span { font-size: 12px; color: var(--gs-fg-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp__docs-panel { max-width: 760px; }
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
  width: min(800px, 100%); max-height: calc(100dvh - 32px); padding: 0; overflow: hidden;
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
.cp__claim-search:focus { border-color: var(--gs-accent); box-shadow: 0 0 0 4px rgba(0,185,107,.12); }
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
.cp__overview { display: grid; gap: 10px; margin-top: 14px; padding: 14px; background: var(--gs-divider); border-radius: 12px; }
.cp__overview-summary { margin: 0; max-height: 4.8em; overflow: auto; font-size: 13px; line-height: 1.75; color: var(--gs-fg-2); }
.cp__overview-meta { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12.5px; color: var(--gs-fg-muted); }
.cp__overview-meta a { color: var(--gs-accent-strong); text-decoration: none; }
.cp__stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.cp__stats div { display: grid; gap: 2px; padding: 8px 10px; background: var(--gs-surface); border-radius: 9px; }
.cp__stats strong { font-size: 16px; color: var(--gs-fg); }
.cp__stats span { font-size: 11.5px; color: var(--gs-fg-subtle); }
.cp__offerings { font-size: 12.5px; color: var(--gs-fg-2); }
.cp__offerings summary { cursor: pointer; font-weight: 600; }
.cp__offerings ul { margin: 8px 0 0; padding-left: 18px; display: grid; gap: 4px; max-height: 120px; overflow: auto; }
.cp__offerings a { color: var(--gs-accent-strong); text-decoration: none; }
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
  .cp__stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 560px) {
  .cp__modal { padding: 8px; }
  .cp__modal-body, .cp__facts-panel { max-height: calc(100dvh - 16px); }
  .cp__facts-head { padding: 18px 16px 0; }
  .cp__facts-hint { display: none; }
  .cp__facts-body { padding: 0 16px 12px; }
  .cp__overview { margin-top: 10px; padding: 10px; gap: 8px; }
  .cp__overview-summary { max-height: 5.2em; font-size: 12.5px; }
  .cp__stats { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
  .cp__stats div { padding: 6px 7px; }
  .cp__stats strong { font-size: 14px; }
  .cp__stats span { font-size: 10.5px; }
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
</style>
