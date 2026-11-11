<script lang="ts" setup>
/**
 * 线索档案包整页（v3.0 ch07 P5b-08）：/leads/:leadId?tab=package|people|draft|outcomes
 * 四个 tab 各自可分享；顶部固定操作条（接受/拒绝/提升商机/去触达）。
 * 数据以引擎 LeadPackage 为准（package 一次拉取），不复制列表页的抽屉状态。
 */
import type { LeadDecisionInput, LeadPackage, PromoteQgoInput } from '#/api/gainos';

import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { useAccessStore } from '@vben/stores';

import { $t } from '#/locales';

import { formatDate, formatDateTime, statusClass } from '@gain-saas/shared';

import AsyncSection from '#/components/gainos/async-section.vue';
import PageHeader from '#/components/gainos/page-header.vue';

import { failureText, gainosApi } from '#/api/gainos';
import { usePendingAction } from '#/composables/use-pending-action';

import DecisionMakerCard from './DecisionMakerCard.vue';

defineOptions({ name: 'LeadDetail' });

const TAB_KEYS = ['package', 'people', 'draft', 'outcomes'] as const;
type TabKey = (typeof TAB_KEYS)[number];

const REJECT_CODES = [
  'NOT_TARGET_ROLE',
  'WRONG_PRODUCT',
  'TOO_SMALL',
  'TOO_LARGE',
  'ALREADY_KNOWN',
  'NO_IMPORT_SIGNAL',
  'WRONG_COUNTRY',
  'BAD_CONTACT_PATH',
  'DUPLICATE',
  'OTHER',
] as const;
const ACCEPT_CODES = ['GOOD_FIT', 'WILL_FOLLOW_UP', 'OTHER'] as const;

const route = useRoute();
const router = useRouter();
const accessStore = useAccessStore();
const isAdmin = computed(() => accessStore.accessCodes.includes('ADMIN'));

const leadId = computed(() => String(route.params.leadId ?? ''));
const tab = ref<TabKey>(readTab());

function readTab(): TabKey {
  const raw = route.query.tab;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (TAB_KEYS as readonly string[]).includes(String(value)) ? (value as TabKey) : 'package';
}

watch(
  () => route.query.tab,
  () => (tab.value = readTab()),
);

function selectTab(next: TabKey): void {
  tab.value = next;
  void router.replace({ query: { ...route.query, tab: next } });
}

const pkg = ref<LeadPackage | null>(null);
const loading = ref(true);
const error = ref<{ next?: string; title: string } | null>(null);
const notice = ref<string | null>(null);

const draft = ref<Record<string, unknown> | null>(null);
const draftLoading = ref(false);
const draftError = ref<{ next?: string; title: string } | null>(null);
const copied = ref(false);

const decision = ref<'accept' | 'reject' | null>(null);
const reasonCode = ref('');
const reasonNote = ref('');
const actionError = ref<{ next?: string; title: string } | null>(null);
const { pending: submitting, run: runDecision } = usePendingAction();

const promoteOpen = ref(false);
const promoteEvidence = ref<Array<{ support: string; type: string; url: string }>>([
  { type: 'customer_reply', url: '', support: '' },
]);
const promoteNextStep = ref('');
const promoteBusy = ref(false);
const promoteError = ref<{ next?: string; title: string } | null>(null);

const sanctionsBusy = ref(false);
const sanctionsError = ref<{ next?: string; title: string } | null>(null);

const status = computed(() => pkg.value?.status ?? '');
const canDecide = computed(
  () => status.value === 'DISCOVERED' || status.value === 'REVIEW',
);
const sanctionBlocked = computed(() => {
  const value = pkg.value?.sanctions?.status;
  return value === 'potential_match' || value === 'confirmed_true_hit';
});

function statusLabel(status?: string): string {
  if (!status) return $t('gainos.leads.status.DISCOVERED');
  const key = `gainos.leads.status.${status}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? status : translated;
}

const statusToneClass = computed(() => {
  const tone =
    status.value === 'QUALIFIED'
      ? 'success'
      : status.value === 'REJECTED'
        ? 'danger'
        : status.value === 'SUPPRESSED'
          ? 'warning'
          : 'neutral';
  return statusClass(tone);
});

const reasonOptions = computed(() =>
  (decision.value === 'accept' ? ACCEPT_CODES : REJECT_CODES).map((code) => ({
    code,
    label: $t(`gainos.leads.reason.${code}`),
  })),
);

const profileRows = computed<Array<{ label: string; value: string }>>(() => {
  const profile = pkg.value?.company_profile;
  if (!profile || typeof profile !== 'object') return [];
  const record = profile as Record<string, unknown>;
  const rows: Array<{ label: string; value: string }> = [];
  const push = (label: string, value: unknown): void => {
    if (typeof value === 'string' && value.trim()) rows.push({ label, value: value.trim() });
  };
  const role = typeof record.trade_role === 'string' && record.trade_role.trim()
    ? record.trade_role.trim() : '';
  const confidence = typeof record.trade_role_confidence === 'number' && Number.isFinite(record.trade_role_confidence)
    ? $t('gainos.leads.profileConfidence', { percent: Math.round(record.trade_role_confidence * 100) })
    : '';
  push($t('gainos.leads.profileTradeRole'), role ? (confidence ? `${role} · ${confidence}` : role) : undefined);
  // carried_brands 是 {name, country} 对象数组：逐个取 name（country 一并展示）
  const brands = Array.isArray(record.carried_brands) ? record.carried_brands : [];
  const brandNames = brands
    .map((brand) => {
      if (!brand || typeof brand !== 'object') return '';
      const entry = brand as Record<string, unknown>;
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      const country = typeof entry.country === 'string' && entry.country.trim() ? entry.country.trim() : '';
      return name ? (country ? `${name}（${country}）` : name) : '';
    })
    .filter(Boolean);
  if (brandNames.length > 0) {
    rows.push({ label: $t('gainos.leads.profileCarriedBrands'), value: brandNames.join(' · ') });
  }
  if (record.own_manufacturing === true) rows.push({ label: $t('gainos.leads.profileOwnManufacturing'), value: $t('gainos.leads.yes') });
  if (record.carries_chinese_brand === true) rows.push({ label: $t('gainos.leads.profileChineseBrand'), value: $t('gainos.leads.yes') });
  if (record.carries_foreign_brand === true) rows.push({ label: $t('gainos.leads.profileForeignBrand'), value: $t('gainos.leads.yes') });
  return rows;
});

/** 引擎合同只回这四个标识键：翻译成业务语言，不把蛇形命名直接上屏。 */
const IDENTIFIER_LABELS: Record<string, () => string> = {
  register_key: () => $t('gainos.leads.identifierRegister'),
  vat_id: () => $t('gainos.leads.identifierVat'),
  lei: () => $t('gainos.leads.identifierLei'),
  fda_reg: () => $t('gainos.leads.identifierFda'),
};

const identifierRows = computed<Array<{ label: string; value: string }>>(() => {
  const identifiers = pkg.value?.identifiers;
  if (!identifiers || typeof identifiers !== 'object') return [];
  return Object.entries(identifiers)
    .filter(([key, value]) => Boolean(IDENTIFIER_LABELS[key]) && typeof value === 'string' && value)
    .map(([key, value]) => ({ label: IDENTIFIER_LABELS[key]!(), value: String(value) }));
});

/** 引擎 evidence 形状是 {field, source_url, fetched_at}（不是提升商机的 {type,url,support}）。 */
const evidenceItems = computed(() => {
  const seen = new Set<string>();
  const rows: Array<{ field: string; url: string; fetchedAt: string }> = [];
  for (const item of pkg.value?.evidence ?? []) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const field = typeof record.field === 'string' ? record.field.trim() : '';
    const url = typeof record.source_url === 'string' ? record.source_url : '';
    const fetchedAt = typeof record.fetched_at === 'string' ? record.fetched_at : '';
    const key = `${field}|${url}`;
    if (!field || seen.has(key)) continue;
    seen.add(key);
    rows.push({ field, url, fetchedAt });
  }
  return rows;
});

/** 匹配判断（引擎 fit：verdict + 人话理由），档案页此前完全没展示。 */
const fitVerdictLabel = computed(() => {
  const verdict = pkg.value?.fit?.verdict;
  if (!verdict) return $t('gainos.leads.fit.unknown');
  const key = `gainos.leads.fit.${verdict}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? verdict : translated;
});

const fitReasons = computed(() => pkg.value?.fit?.reasons ?? []);

/** 八维评分（合同 snake_case），档案页此前完全没展示。 */
const SCORE_DIMS = ['fit', 'role', 'intent', 'demand_proof', 'reachability', 'data_quality', 'engagement'] as const;

const scoreRows = computed(() => {
  const scores = pkg.value?.scores;
  if (!scores || typeof scores !== 'object') return [];
  const record = scores as Record<string, unknown>;
  return SCORE_DIMS
    .map((dim) => ({ dim, value: record[dim] }))
    .filter((row): row is { dim: (typeof SCORE_DIMS)[number]; value: number } =>
      typeof row.value === 'number' && Number.isFinite(row.value));
});

const totalScore = computed(() => {
  const total = pkg.value?.scores?.total;
  return typeof total === 'number' && Number.isFinite(total) ? total : null;
});

const contactPaths = computed(() =>
  (pkg.value?.contact_points ?? []).filter((point) => point.url),
);

function sanctionLabel(value?: null | string): string {
  // 引擎状态未回填时按「未筛查」呈现；文案节是单数 sanction（勿写成 sanctions）。
  if (!value) return $t('gainos.leads.sanction.not_screened');
  const key = `gainos.leads.sanction.${value}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? value : translated;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    pkg.value = await gainosApi.leadPackage(leadId.value);
    draftError.value = null;
    draft.value = null;
    void loadDraft();
  } catch (err) {
    error.value = failureText(err);
    pkg.value = null;
  } finally {
    loading.value = false;
  }
}

async function loadDraft(): Promise<void> {
  if (!pkg.value) return;
  draftLoading.value = true;
  draftError.value = null;
  try {
    const existing = await gainosApi.outreachDrafts(leadId.value).catch(() => null);
    if (existing && typeof existing === 'object') {
      draft.value = existing as Record<string, unknown>;
    }
  } catch (err) {
    draftError.value = failureText(err);
  } finally {
    draftLoading.value = false;
  }
}

/** 生成草稿是一次付费模型调用：只在用户点击时发生。 */
async function generateDraft(): Promise<void> {
  if (!pkg.value || draftLoading.value) return;
  draftLoading.value = true;
  draftError.value = null;
  try {
    draft.value = await gainosApi.outreachDraft(leadId.value);
  } catch (err) {
    draftError.value = failureText(err);
  } finally {
    draftLoading.value = false;
  }
}

const draftText = computed(() => {
  const record = draft.value;
  if (!record) return '';
  const parts = [record.subject, record.body, record.bodyZh, record.translation, record.body_zh, record.text]
    .filter((part) => typeof part === 'string' && part.trim());
  return [...new Set(parts as string[])].join('\n\n');
});

async function copyDraft(): Promise<void> {
  try {
    await navigator.clipboard.writeText(draftText.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    /* 剪贴板权限被拒时保持原样，用户可手动选择文本 */
  }
}

function openDecision(kind: 'accept' | 'reject'): void {
  decision.value = kind;
  reasonCode.value = '';
  reasonNote.value = '';
  actionError.value = null;
}

async function submitDecision(): Promise<void> {
  if (!decision.value) return;
  if (decision.value === 'reject' && !reasonCode.value) return;
  actionError.value = null;
  const input: LeadDecisionInput = {
    ...(reasonCode.value ? { reasonCode: reasonCode.value } : {}),
    ...(reasonNote.value.trim() ? { reason: reasonNote.value.trim() } : {}),
  };
  const kind = decision.value;
  try {
    // 幂等键由 usePendingAction 管理：双击/重试沿用同键，服务端按幂等重放而非重复执行。
    await runDecision(async (idempotencyKey) => {
      if (kind === 'accept') {
        await gainosApi.acceptLead(leadId.value, input, idempotencyKey);
        notice.value = $t('gainos.leads.acceptedNotice');
      } else {
        await gainosApi.rejectLead(leadId.value, input, idempotencyKey);
        notice.value = $t('gainos.leads.rejectedNotice');
      }
    });
    decision.value = null;
    await load();
  } catch (err) {
    actionError.value = failureText(err);
  }
}

function addEvidenceRow(): void {
  if (promoteEvidence.value.length < 10) {
    promoteEvidence.value.push({ type: 'other', url: '', support: '' });
  }
}

function removeEvidenceRow(index: number): void {
  if (promoteEvidence.value.length > 1) promoteEvidence.value.splice(index, 1);
}

async function submitPromote(): Promise<void> {
  if (promoteBusy.value || !promoteNextStep.value.trim()) return;
  promoteBusy.value = true;
  promoteError.value = null;
  const evidence = promoteEvidence.value
    .filter((row) => row.type.trim())
    .map((row) => ({
      type: row.type.trim(),
      ...(row.url.trim() ? { url: row.url.trim() } : {}),
      ...(row.support.trim() ? { support: row.support.trim() } : {}),
    }));
  const input: PromoteQgoInput = {
    leadRef: leadId.value,
    evidence,
    nextStep: promoteNextStep.value.trim(),
  };
  try {
    await gainosApi.promoteQgo(input);
    promoteOpen.value = false;
    void router.push('/qgos');
  } catch (err) {
    promoteError.value = failureText(err);
  } finally {
    promoteBusy.value = false;
  }
}

async function reviewSanctions(kind: 'cleared_false_positive' | 'confirmed_true_hit'): Promise<void> {
  if (sanctionsBusy.value) return;
  sanctionsBusy.value = true;
  sanctionsError.value = null;
  try {
    await gainosApi.sanctionsReview(leadId.value, kind);
    await load();
  } catch (err) {
    sanctionsError.value = failureText(err);
  } finally {
    sanctionsBusy.value = false;
  }
}

function goOutreach(): void {
  void router.push({ path: '/growth', query: { tab: 'outreach', lead: leadId.value } });
}

onMounted(load);

watch(tab, (next) => {
  if (next === 'draft' && !draft.value) void loadDraft();
});
</script>

<template>
  <div class="lpd">
    <PageHeader
      :subtitle="pkg ? (pkg.company.country || '') + (pkg.company.domain ? ` · ${pkg.company.domain}` : '') : ''"
      :title="pkg?.company.name || $t('gainos.leads.unknownCompany')"
    >
      <template #actions>
        <button class="lpd__back" type="button" @click="router.push('/leads')">
          {{ $t('gainos.leads.backToList') }}
        </button>
      </template>
    </PageHeader>

    <div v-if="pkg" class="lpd__bar">
      <span class="gs-badge" :class="statusToneClass">{{ statusLabel(status) }}</span>
      <div class="lpd__bar-actions">
        <button v-if="canDecide" class="lpd__ghost lpd__ghost--danger" type="button" @click="openDecision('reject')">
          {{ $t('gainos.leads.reject') }}
        </button>
        <button v-if="canDecide" class="lpd__primary" type="button" @click="openDecision('accept')">
          {{ $t('gainos.leads.accept') }}
        </button>
        <button v-if="status === 'QUALIFIED'" class="lpd__primary" type="button" @click="promoteOpen = true">
          {{ $t('gainos.leads.promoteQgo') }}
        </button>
        <button v-if="status === 'QUALIFIED'" class="lpd__ghost" type="button" @click="goOutreach">
          {{ $t('gainos.leads.goOutreach') }}
        </button>
      </div>
    </div>

    <p v-if="notice" class="lpd__notice" role="status">{{ notice }}</p>

    <nav class="lpd__tabs" role="tablist" :aria-label="$t('gainos.leads.detailTabs')">
      <button
        v-for="key in TAB_KEYS"
        :key="key"
        type="button"
        role="tab"
        class="lpd__tab"
        :aria-selected="tab === key"
        :class="{ 'is-active': tab === key }"
        @click="selectTab(key)"
      >
        {{ $t(`gainos.leads.tab.${key}`) }}
      </button>
    </nav>

    <AsyncSection
      :error="error"
      :loading="loading"
      :loading-text="$t('gainos.common.loading')"
      :retry-text="$t('gainos.common.retry')"
      @retry="load"
    >
      <template v-if="pkg">
        <section v-if="tab === 'package'" class="lpd__grid">
          <article class="lpd__card lpd__card--wide">
            <h2>{{ $t('gainos.leads.fitTitle') }}</h2>
            <p class="lpd__fit">{{ fitVerdictLabel }}</p>
            <ul v-if="fitReasons.length" class="lpd__reasons">
              <li v-for="(reason, index) in fitReasons" :key="index">{{ reason }}</li>
            </ul>
          </article>

          <article class="lpd__card">
            <h2>{{ $t('gainos.leads.scoresTitle') }}</h2>
            <dl v-if="scoreRows.length || totalScore !== null" class="lpd__scores">
              <div v-for="row in scoreRows" :key="row.dim">
                <dt>{{ $t(`gainos.leads.dim.${row.dim}`) }}</dt>
                <dd>{{ Math.round(row.value * 100) }}</dd>
              </div>
              <div v-if="totalScore !== null" class="lpd__score-total">
                <dt>{{ $t('gainos.leads.dim.total') }}</dt>
                <dd>{{ Math.round(totalScore * 100) }}</dd>
              </div>
            </dl>
            <p v-else class="lpd__muted">{{ $t('gainos.leads.notScored') }}</p>
          </article>

          <article class="lpd__card">
            <h2>{{ $t('gainos.leads.profileTitle') }}</h2>
            <dl class="lpd__facts">
              <template v-for="row in profileRows" :key="row.label">
                <dt>{{ row.label }}</dt>
                <dd>{{ row.value }}</dd>
              </template>
              <template v-if="pkg.registered_address">
                <dt>{{ $t('gainos.leads.address') }}</dt>
                <dd>{{ pkg.registered_address }}</dd>
              </template>
              <template v-for="row in identifierRows" :key="`id-${row.label}`">
                <dt>{{ row.label }}</dt>
                <dd class="lpd__mono">{{ row.value }}</dd>
              </template>
              <template v-if="profileRows.length === 0 && identifierRows.length === 0 && !pkg.registered_address">
                <dt>{{ $t('gainos.leads.profileEmpty') }}</dt>
                <dd>—</dd>
              </template>
            </dl>
          </article>

          <article class="lpd__card">
            <h2>{{ $t('gainos.leads.contactTitle') }}</h2>
            <template v-if="contactPaths.length > 0">
              <p v-for="(point, index) in contactPaths" :key="index" class="lpd__contact">
                <a :href="point.url" target="_blank" rel="noreferrer">{{ point.url }}</a>
                <span class="lpd__muted">{{ point.status }}</span>
              </p>
            </template>
            <p v-else class="lpd__muted">{{ $t('gainos.leads.noContactPath') }}</p>
            <template v-if="pkg.suggested_contact_path">
              <p class="lpd__muted">{{ pkg.suggested_contact_path.legal_note }}</p>
            </template>
          </article>

          <article class="lpd__card lpd__card--wide">
            <h2>{{ $t('gainos.leads.evidenceTitle') }}</h2>
            <ul v-if="evidenceItems.length > 0" class="lpd__evidence">
              <li v-for="(item, index) in evidenceItems" :key="index">
                <span class="lpd__chip">{{ item.field }}</span>
                <a v-if="item.url" :href="item.url" target="_blank" rel="noreferrer">{{ item.url }}</a>
                <span v-if="item.fetchedAt" class="lpd__muted">{{ formatDate(item.fetchedAt) }}</span>
              </li>
            </ul>
            <p v-else class="lpd__muted">{{ $t('gainos.leads.evidenceEmpty') }}</p>

            <h2>{{ $t('gainos.leads.signalsTitle') }}</h2>
            <ul v-if="(pkg.signals ?? []).length > 0" class="lpd__evidence">
              <li v-for="(signal, index) in pkg.signals" :key="`sig-${index}`">
                <span class="lpd__chip">{{ signal.type }}</span>
                <a v-if="signal.url" :href="signal.url" target="_blank" rel="noreferrer">{{ signal.url }}</a>
                <span class="lpd__muted">{{ formatDateTime(signal.at) }}</span>
              </li>
            </ul>
            <p v-else class="lpd__muted">{{ $t('gainos.leads.noSignals') }}</p>
          </article>

          <article class="lpd__card" :class="{ 'is-warn': sanctionBlocked }">
            <h2>{{ $t('gainos.leads.sanctionsTitle') }}</h2>
            <p :class="{ 'lpd__warn': sanctionBlocked }">{{ sanctionLabel(pkg.sanctions?.status) }}</p>
            <p v-if="pkg.sanctions?.screened_at" class="lpd__muted">
              {{ formatDateTime(pkg.sanctions.screened_at) }}
            </p>
            <div v-if="isAdmin && sanctionBlocked" class="lpd__actions">
              <button
                v-if="pkg.sanctions?.status !== 'confirmed_true_hit'"
                class="lpd__ghost"
                type="button"
                :disabled="sanctionsBusy"
                @click="reviewSanctions('cleared_false_positive')"
              >
                {{ $t('gainos.leads.sanctionsClear') }}
              </button>
              <button
                v-if="pkg.sanctions?.status !== 'confirmed_true_hit'"
                class="lpd__ghost lpd__ghost--danger"
                type="button"
                :disabled="sanctionsBusy"
                @click="reviewSanctions('confirmed_true_hit')"
              >
                {{ $t('gainos.leads.sanctionsConfirm') }}
              </button>
            </div>
            <p v-if="sanctionsError" class="lpd__error" role="alert">{{ sanctionsError.title }}</p>
            <p v-if="pkg.valid_until" class="lpd__muted">
              {{ $t('gainos.leads.validUntil', { date: formatDate(pkg.valid_until) }) }}
            </p>
          </article>
        </section>

        <section v-else-if="tab === 'people'" class="lpd__grid">
          <article class="lpd__card lpd__card--wide">
            <template v-if="isAdmin && pkg.company.canonical_company_id">
              <DecisionMakerCard :company-id="pkg.company.canonical_company_id" />
            </template>
            <p v-else class="lpd__muted">{{ $t('gainos.leads.peopleAdminOnly') }}</p>
          </article>
        </section>

        <section v-else-if="tab === 'draft'" class="lpd__grid">
          <article class="lpd__card lpd__card--wide">
            <div class="lpd__card-head">
              <h2>{{ $t('gainos.leads.outreachDraft') }}</h2>
              <button
                v-if="status === 'QUALIFIED'"
                class="lpd__ghost"
                type="button"
                :disabled="draftLoading"
                @click="generateDraft"
              >
                {{ draftLoading ? $t('gainos.common.loading') : $t('gainos.leads.outreachDraft') }}
              </button>
            </div>
            <p class="lpd__muted">{{ $t('gainos.leads.outreachDraftDesc') }}</p>
            <div v-if="draftError" class="lpd__error" role="alert">
              <strong>{{ draftError.title }}</strong>
              <span v-if="draftError.next">{{ draftError.next }}</span>
            </div>
            <template v-else-if="draftText">
              <pre class="lpd__draft">{{ draftText }}</pre>
              <button class="lpd__ghost" type="button" @click="copyDraft">
                {{ copied ? $t('gainos.leads.copied') : $t('gainos.leads.copy') }}
              </button>
            </template>
            <p v-else-if="status !== 'QUALIFIED'" class="lpd__muted">
              {{ $t('gainos.leads.outreachNeedsQualified') }}
            </p>
            <p v-else class="lpd__muted">{{ $t('gainos.leads.outreachEmpty') }}</p>
          </article>
        </section>

        <section v-else class="lpd__grid">
          <article class="lpd__card lpd__card--wide">
            <h2>{{ $t('gainos.leads.outcomesTitle') }}</h2>
            <p class="lpd__muted">{{ $t('gainos.leads.outcomesDesc') }}</p>
            <div class="lpd__actions">
              <button class="lpd__ghost" type="button" @click="router.push('/qgos')">
                {{ $t('gainos.leads.outcomesQgos') }}
              </button>
              <button class="lpd__ghost" type="button" @click="goOutreach">
                {{ $t('gainos.leads.outcomesOutreach') }}
              </button>
            </div>
          </article>
        </section>
      </template>
    </AsyncSection>

    <!-- 接受/拒绝 -->
    <div v-if="decision" class="lpd__overlay" @click.self="decision = null">
      <section class="lpd__modal" role="dialog" aria-modal="true" :aria-label="$t('gainos.leads.decisionTitle')">
        <header class="lpd__modal-head">
          <h2>{{ decision === 'accept' ? $t('gainos.leads.acceptTitle') : $t('gainos.leads.rejectTitle') }}</h2>
          <button class="lpd__close" type="button" :aria-label="$t('gainos.common.cancel')" @click="decision = null">×</button>
        </header>
        <p class="lpd__muted">
          {{ decision === 'accept' ? $t('gainos.leads.acceptDesc') : $t('gainos.leads.rejectDesc') }}
        </p>
        <div v-if="actionError" class="lpd__error" role="alert">
          <strong>{{ actionError.title }}</strong>
          <span v-if="actionError.next">{{ actionError.next }}</span>
        </div>
        <label class="lpd__field">
          <span>{{ $t('gainos.leads.reasonCode') }}<em v-if="decision === 'reject'"> *</em></span>
          <select v-model="reasonCode">
            <option value="">{{ decision === 'reject' ? $t('gainos.leads.reasonSelect') : $t('gainos.leads.reasonOptional') }}</option>
            <option v-for="option in reasonOptions" :key="option.code" :value="option.code">{{ option.label }}</option>
          </select>
        </label>
        <label class="lpd__field">
          <span>{{ $t('gainos.leads.reasonNote') }}</span>
          <textarea v-model="reasonNote" maxlength="500" rows="2"></textarea>
        </label>
        <div class="lpd__actions lpd__actions--end">
          <button class="lpd__ghost" type="button" @click="decision = null">{{ $t('gainos.common.cancel') }}</button>
          <button
            class="lpd__primary"
            type="button"
            :disabled="submitting || (decision === 'reject' && !reasonCode)"
            @click="submitDecision"
          >
            {{ submitting ? $t('gainos.leads.submitting') : decision === 'accept' ? $t('gainos.leads.confirmAccept') : $t('gainos.leads.confirmReject') }}
          </button>
        </div>
      </section>
    </div>

    <!-- 提升为商机 -->
    <div v-if="promoteOpen" class="lpd__overlay" @click.self="promoteOpen = false">
      <section class="lpd__modal" role="dialog" aria-modal="true" :aria-label="$t('gainos.leads.promoteTitle')">
        <header class="lpd__modal-head">
          <h2>{{ $t('gainos.leads.promoteTitle') }}</h2>
          <button class="lpd__close" type="button" :aria-label="$t('gainos.common.cancel')" @click="promoteOpen = false">×</button>
        </header>
        <div v-if="promoteError" class="lpd__error" role="alert">
          <strong>{{ promoteError.title }}</strong>
          <span v-if="promoteError.next">{{ promoteError.next }}</span>
        </div>
        <div class="lpd__field">
          <span>{{ $t('gainos.leads.promoteEvidence') }}</span>
          <div v-for="(row, index) in promoteEvidence" :key="index" class="lpd__evidence-row">
            <select v-model="row.type" :aria-label="$t('gainos.leads.promoteEvidenceType')">
              <option value="customer_reply">{{ $t('gainos.leads.evidenceType.customer_reply') }}</option>
              <option value="purchase_page">{{ $t('gainos.leads.evidenceType.purchase_page') }}</option>
              <option value="tender_hit">{{ $t('gainos.leads.evidenceType.tender_hit') }}</option>
              <option value="customs_signal">{{ $t('gainos.leads.evidenceType.customs_signal') }}</option>
              <option value="other">{{ $t('gainos.leads.evidenceType.other') }}</option>
            </select>
            <input v-model="row.url" type="url" :placeholder="$t('gainos.leads.promoteUrlHint')" />
            <input v-model="row.support" type="text" maxlength="500" :placeholder="$t('gainos.leads.promoteSupportHint')" />
            <button class="lpd__ghost" type="button" :disabled="promoteEvidence.length <= 1" @click="removeEvidenceRow(index)">×</button>
          </div>
          <button class="lpd__ghost" type="button" @click="addEvidenceRow">{{ $t('gainos.leads.addEvidence') }}</button>
        </div>
        <label class="lpd__field">
          <span>{{ $t('gainos.leads.promoteNextStep') }}</span>
          <textarea v-model="promoteNextStep" maxlength="500" rows="2" :placeholder="$t('gainos.leads.promoteNextStepHint')"></textarea>
        </label>
        <div class="lpd__actions lpd__actions--end">
          <button class="lpd__ghost" type="button" @click="promoteOpen = false">{{ $t('gainos.common.cancel') }}</button>
          <button
            class="lpd__primary"
            type="button"
            :disabled="promoteBusy || !promoteNextStep.trim()"
            @click="submitPromote"
          >
            {{ promoteBusy ? $t('gainos.leads.submitting') : $t('gainos.leads.promoteSubmit') }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.lpd {
  padding: clamp(18px, 2.4vw, 32px) clamp(18px, 2.4vw, 34px) clamp(32px, 4vh, 48px);
  max-width: 1280px;
  margin: 0 auto;
  display: grid;
  gap: 16px;
}
.lpd__back,
.lpd__ghost,
.lpd__primary {
  border-radius: 10px;
  padding: 8px 16px;
  font-size: 13px;
  cursor: pointer;
}
.lpd__back,
.lpd__ghost {
  border: 1px solid var(--gs-border-strong);
  background: var(--gs-surface);
  color: var(--gs-fg-2);
}
.lpd__ghost--danger {
  border-color: var(--gs-danger-border);
  background: var(--gs-danger-bg);
  color: var(--gs-danger);
}
.lpd__primary {
  border: none;
  background: var(--gs-accent-cta);
  color: var(--gs-accent-cta-fg);
  font-weight: 600;
}
.lpd__primary:disabled,
.lpd__ghost:disabled {
  opacity: 0.5;
  cursor: default;
}
.lpd__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 14px;
  border: 1px solid var(--gs-border);
  border-radius: 12px;
  background: var(--gs-surface);
}
.lpd__bar-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.lpd__notice {
  margin: 0;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--gs-accent-soft);
  color: var(--gs-accent-strong);
  font-size: 13px;
}
.lpd__tabs {
  display: flex;
  gap: 6px;
  border-bottom: 1px solid var(--gs-border);
}
.lpd__tab {
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  padding: 9px 14px;
  font-size: 13.5px;
  color: var(--gs-fg-muted);
  cursor: pointer;
}
.lpd__tab.is-active {
  border-bottom-color: var(--gs-accent-cta);
  color: var(--gs-accent-strong);
  font-weight: 600;
}
.lpd__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 14px;
}
.lpd__card {
  border: 1px solid var(--gs-border);
  border-radius: 14px;
  background: var(--gs-surface);
  padding: 16px 18px;
  display: grid;
  gap: 10px;
  align-content: start;
}
.lpd__card.is-warn {
  border-color: var(--gs-warn);
  background: var(--gs-warn-bg);
}
.lpd__card--wide {
  grid-column: 1 / -1;
}
.lpd__card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}
.lpd__card h2 {
  margin: 0;
  font-size: 14.5px;
  font-weight: 650;
  color: var(--gs-fg);
}
.lpd__facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 14px;
  margin: 0;
  font-size: 13px;
}
.lpd__facts dt {
  color: var(--gs-fg-muted);
}
.lpd__facts dd {
  margin: 0;
  color: var(--gs-fg-2);
}
.lpd__mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.lpd__contact {
  margin: 0;
  font-size: 13px;
  word-break: break-all;
}
.lpd__contact a {
  color: var(--gs-accent-strong);
}
.lpd__evidence {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}
.lpd__evidence li {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: baseline;
  font-size: 13px;
  word-break: break-all;
}
.lpd__chip {
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11.5px;
  background: var(--gs-surface-2);
  color: var(--gs-fg-muted);
}
.lpd__warn {
  color: var(--gs-warn);
  font-weight: 600;
}
.lpd__muted {
  margin: 0;
  color: var(--gs-fg-subtle);
  font-size: 12.5px;
}
.lpd__draft {
  margin: 0;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--gs-surface-2);
  font-size: 12.5px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 420px;
  overflow: auto;
}
.lpd__actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.lpd__actions--end {
  justify-content: flex-end;
}
.lpd__error {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--gs-danger-bg);
  color: var(--gs-danger);
  font-size: 12.5px;
  display: grid;
  gap: 4px;
}
.lpd__overlay {
  position: fixed;
  inset: 0;
  background: var(--gs-mask);
  display: grid;
  place-items: center;
  padding: 20px;
  z-index: 50;
}
.lpd__modal {
  width: min(560px, 100%);
  max-height: 88vh;
  overflow: auto;
  border-radius: 14px;
  background: var(--gs-surface);
  border: 1px solid var(--gs-border);
  padding: 18px 20px;
  display: grid;
  gap: 12px;
}
.lpd__modal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}
.lpd__modal-head h2 {
  margin: 0;
  font-size: 16px;
  color: var(--gs-fg);
}
.lpd__close {
  border: none;
  background: none;
  font-size: 20px;
  line-height: 1;
  color: var(--gs-fg-subtle);
  cursor: pointer;
}
.lpd__field {
  display: grid;
  gap: 6px;
  font-size: 12.5px;
  color: var(--gs-fg-muted);
}
.lpd__field select,
.lpd__field textarea,
.lpd__field input {
  border: 1px solid var(--gs-border-strong);
  border-radius: 8px;
  padding: 8px 10px;
  font: inherit;
  font-size: 13px;
  background: var(--gs-surface);
  color: var(--gs-fg-2);
}
.lpd__fit { margin: 0; font-size: 15px; font-weight: 700; color: var(--gs-fg); }
.lpd__reasons { margin: 10px 0 0; padding-left: 18px; display: grid; gap: 6px; color: var(--gs-fg-2); font-size: 13px; line-height: 1.7; }
.lpd__scores { margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 8px; }
.lpd__scores div { background: var(--gs-divider); border-radius: 9px; padding: 8px 10px; display: grid; gap: 3px; }
.lpd__scores dt { font-size: 11px; color: var(--gs-fg-subtle); }
.lpd__scores dd { margin: 0; font-size: 15px; font-weight: 700; color: var(--gs-fg); font-variant-numeric: tabular-nums; }
.lpd__score-total { background: var(--gs-accent-soft) !important; }
.lpd__score-total dd { color: var(--gs-accent-strong); }
.lpd__evidence-row {
  display: grid;
  grid-template-columns: 130px 1fr 1fr auto;
  gap: 6px;
  align-items: center;
}
</style>
