<script lang="ts" setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

import { $t } from '#/locales';

import {
  failureText,
  gainosApi,
  type CompanyClaim,
  type CompanyCompleteness,
  type CompanyConflict,
  type CompanyOffering,
  type CompanyProfile,
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
const wizardOpen = ref(false);
const creating = ref(false);
const confirmingId = ref<string | null>(null);
const retryingId = ref<string | null>(null);
const form = reactive({ website: '', name: '' });
const formError = ref<string | null>(null);
let pollTimer: ReturnType<typeof setInterval> | null = null;

// ── 企业事实（Claim）审批：只有「已通过」的事实会进入目标买家设计 ──
const claimsOpen = ref(false);
const claimsCompany = ref<CompanyProfile | null>(null);
const claims = ref<CompanyClaim[]>([]);
const claimsLoading = ref(false);
const claimsError = ref<string | null>(null);
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
    claimsError.value = failureText(err).title;
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
    await gainosApi.retryCompanyUnderstanding(companyId);
    await load(true);
    // 工作流把状态翻到 ENRICHING 需要几秒；补一次延迟刷新，让轮询接管。
    setTimeout(() => void load(true), 3_000);
  } catch (err) {
    error.value = failureText(err).title;
  } finally {
    retryingId.value = null;
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
  if (!website) {
    formError.value = $t('gainos.companies.errWebsite');
    return;
  }
  creating.value = true;
  try {
    await gainosApi.createCompany({ website, name: form.name.trim() || undefined });
    wizardOpen.value = false;
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

    <ul v-else class="cp__list">
      <li v-for="c in companies" :key="c.id" class="cp__item">
        <div class="cp__item-main">
          <strong class="cp__item-name">{{ c.name ?? c.domain ?? c.website ?? $t('gainos.companies.unnamed') }}</strong>
          <span class="cp__item-site">{{ c.website ?? c.domain ?? '' }}</span>
          <span v-if="understandingFailed(c)" class="cp__item-error">
            {{ c.understandingLastError ?? $t('gainos.companies.statusFailed') }}
          </span>
        </div>
        <div class="cp__item-side">
          <button
            v-if="c.status === 'REVIEW' || c.status === 'ACTIVE'"
            type="button"
            class="cp__facts"
            @click="openClaims(c)"
          >
            {{ $t('gainos.companies.facts') }}
          </button>
          <span
            class="cp__badge"
            :class="understandingFailed(c) ? 'cp__badge--failed' : `cp__badge--${(c.status ?? 'DRAFT').toLowerCase()}`"
          >
            {{ understandingFailed(c) ? $t('gainos.companies.statusFailed') : statusLabel(c.status) }}
          </span>
          <button
            v-if="understandingFailed(c)"
            type="button"
            class="cp__confirm"
            :disabled="retryingId === c.id"
            @click="retryUnderstanding(c)"
          >
            {{ retryingId === c.id ? $t('gainos.companies.retrying') : $t('gainos.companies.retryUnderstanding') }}
          </button>
          <button
            v-if="c.status === 'REVIEW'"
            type="button"
            class="cp__confirm"
            :disabled="confirmingId === c.id"
            @click="confirmCompany(c)"
          >
            {{ confirmingId === c.id ? $t('gainos.companies.confirming') : $t('gainos.companies.confirm') }}
          </button>
        </div>
      </li>
    </ul>

    <!-- 建档向导(M2:引擎合同 = website + name;其余由理解管线补充) -->
    <Teleport to="body">
      <div v-if="wizardOpen" class="cp__modal" :aria-label="$t('gainos.companies.wizardTitle')">
        <div class="cp__modal-mask" @click="wizardOpen = false"></div>
        <div class="cp__modal-body">
          <header>
            <h2>{{ $t('gainos.companies.wizardTitle') }}</h2>
            <button type="button" class="cp__modal-x" aria-label="Close" @click="wizardOpen = false">✕</button>
          </header>
          <p class="cp__modal-hint">只需官网和名称。GainOS 会沿官网理解产品、能力与品牌，并持续补全——理解失败也不影响你手动完善。</p>
          <form novalidate @submit.prevent="create">
            <label class="cp__field">
              <span>{{ $t('gainos.companies.website') }}</span>
              <input v-model="form.website" type="url" placeholder="https://www.your-company.com" />
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

    <!-- 企业事实审批（KNW-003 人工门）：只有「已通过」的事实进入目标买家设计 -->
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
            <span class="cp__muted">{{ $t('gainos.companies.manualHint') }}</span>
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
            <p>{{ claimsError }}</p>
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
  background: var(--gs-accent); color: #fff; box-shadow: 0 8px 18px -6px var(--gs-accent-glow);
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
.cp__badge--review { background: #fef3c7; color: #b45309; }
.cp__badge--active { background: var(--gs-accent-soft); color: var(--gs-accent-strong); }
.cp__badge--failed { background: #fee2e2; color: #b91c1c; }
.cp__item-error { margin-top: 2px; font-size: 12px; color: #b91c1c; font-family: var(--gs-mono, monospace); }
.cp__item-side { display: flex; align-items: center; gap: 10px; flex: none; }
.cp__confirm { border: 0; border-radius: 9px; padding: 7px 12px; background: var(--gs-accent); color: #fff; font-size: 12.5px; font-weight: 600; cursor: pointer; }
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
.cp__btn { border-radius: 11px; padding: 11px 20px; font-size: 14px; font-weight: 600; cursor: pointer; border: 0; }
.cp__btn--ghost { background: var(--gs-divider); color: var(--gs-fg-2); }
.cp__btn--ghost:hover { background: var(--gs-border-strong); }
.cp__btn--primary { background: var(--gs-accent); color: #fff; }
.cp__btn--primary:hover { filter: brightness(1.04); }
.cp__btn--primary:disabled { opacity: .7; cursor: default; }
.cp__btn--danger { color: var(--gs-danger); }
.cp__btn--danger:not(:disabled):hover { color: #fff; background: var(--gs-danger); }
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
</style>
