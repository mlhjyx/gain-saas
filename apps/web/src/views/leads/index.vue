<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { glossaryStatus, statusClass } from '@gain-saas/shared';
import { preferences } from '@vben/preferences';

import { $t } from '#/locales';

import {
  failureText,
  gainosApi,
  type Icp,
  type Lead,
  type LeadDecisionInput,
  type LeadPackage,
  type LeadQueueCounts,
  type PromoteQgoInput,
} from '#/api/gainos';

import DecisionMakerCard from './DecisionMakerCard.vue';

defineOptions({ name: 'Leads' });

const route = useRoute();
const router = useRouter();
const QUEUE_KEYS = ['needs_review', 'recommended', 'rejected', 'suppressed', 'sanctions_hold'] as const;

function queueFromRoute(): string | null {
  const raw = route.query.queue;
  const queue = Array.isArray(raw) ? raw[0] : raw;
  if (typeof queue !== 'string') return null;
  return (QUEUE_KEYS as readonly string[]).includes(queue) ? queue : null;
}

/** 六步主链路(PRD §14.1);线索工作台固定在第 5 步。 */
const STEP_KEYS = [
  'gainos.workspace.stepProfile',
  'gainos.workspace.stepIcp',
  'gainos.workspace.stepPlan',
  'gainos.workspace.stepRun',
  'gainos.workspace.stepJudge',
  'gainos.workspace.stepReport',
] as const;
const stepLabels = computed(() => STEP_KEYS.map((key) => $t(key)));
const currentStep = 5;
const isAdmin = ref(false);

// 队列名称与状态色取自 @gain-saas/shared 的 glossary（P6 §4）；描述文案留在 i18n。
const QUEUE_META = [
  { key: 'needs_review', descKey: 'gainos.leads.queueReviewDesc' },
  { key: 'recommended', descKey: 'gainos.leads.queueQualifiedDesc' },
  { key: 'rejected', descKey: 'gainos.leads.queueRejectedDesc' },
  { key: 'suppressed', descKey: 'gainos.leads.queueSuppressedDesc' },
  { key: 'sanctions_hold', descKey: 'gainos.leads.queueSanctionsDesc', adminOnly: true },
] as const;

const QUEUES = computed(() =>
  QUEUE_META.filter((queue) => !('adminOnly' in queue) || isAdmin.value).map((queue) => {
    const status = glossaryStatus('leadQueue', queue.key, preferences.app.locale);
    return {
      key: queue.key,
      label: status?.label ?? '—',
      desc: $t(queue.descKey),
      tone: status?.tone ?? 'neutral',
    };
  }),
);

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
// 引擎 LeadPackage 契约是 snake_case 七维(lead.scores 直查是 camelCase,包构造器做了键名转换);
// 之前用 dataQuality 读包数据永远是 undefined,demand_proof 从未展示。
const SCORE_DIMS = ['fit', 'role', 'intent', 'demand_proof', 'reachability', 'data_quality', 'engagement'] as const;

const activeQueue = ref<string>(queueFromRoute() ?? 'needs_review');
const leads = ref<Lead[]>([]);
const loading = ref(true);
const loadError = ref<{ title: string; next?: string } | null>(null);
const notice = ref<string | null>(null);
const icps = ref<Icp[]>([]);
const activeIcpId = ref('');
const queueCounts = ref<LeadQueueCounts | null>(null);
// 分页：按队列总数逐步加载，不再静默截断（2026-11-09 组件审计三-03）。
const pageLimit = ref(50);

const selected = ref<Lead | null>(null);
const pkg = ref<LeadPackage | null>(null);
// 证据去重：同一 URL/同一文本只展示一行（审计 二-34：同一 impressum 重复 7 行）。
const pkgEvidence = computed(() => {
  const list = pkg.value?.evidence ?? [];
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const item of list) {
    const key = `${evidenceUrl(item)}|${textOf(item)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
});

const pkgLoading = ref(false);
const pkgError = ref<{ title: string; next?: string } | null>(null);
const draft = ref<Record<string, unknown> | null>(null);
const DRAFT_CACHE_KEY = 'gainos.outreachDrafts.v1';

function readDraftCache(leadId: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFT_CACHE_KEY) ?? '{}') as Record<string, Record<string, unknown>>;
    return parsed?.[leadId] ?? null;
  } catch {
    return null;
  }
}

function writeDraftCache(leadId: string, row: Record<string, unknown>): void {
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFT_CACHE_KEY) ?? '{}') as Record<string, Record<string, unknown>>;
    const entries = Object.entries({ ...parsed, [leadId]: row }).slice(-50);
    localStorage.setItem(DRAFT_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // 本地缓存不可写不影响本次展示。
  }
}
const draftError = ref<{ title: string; next?: string } | null>(null);
const draftLoading = ref(false);
const copied = ref(false);
const sanctionsBusy = ref(false);
const sanctionsError = ref<{ title: string; next?: string } | null>(null);
const sanctionsNotice = ref<string | null>(null);

// M2 步 10：从已接受线索提升为商机（QGO）。证据门与下一步在服务端再次校验。
const promoteOpen = ref(false);
const promoteTarget = ref<Lead | null>(null);
const promoteEvidence = ref<Array<{ type: string; url: string; support: string }>>([
  { type: 'customer_reply', url: '', support: '' },
]);
const promoteNextStep = ref('');
const promoteBusy = ref(false);
const promoteError = ref<ReturnType<typeof failureText> | null>(null);

function openPromote(lead: Lead): void {
  promoteTarget.value = lead;
  promoteOpen.value = true;
  promoteEvidence.value = [{ type: 'customer_reply', url: '', support: '' }];
  promoteNextStep.value = '';
  promoteError.value = null;
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
  const lead = promoteTarget.value;
  if (!lead || promoteBusy.value) return;
  const evidence = promoteEvidence.value
    .filter((row) => row.type.trim())
    .map((row) => ({
      type: row.type.trim(),
      ...(row.url.trim() ? { url: row.url.trim() } : {}),
      ...(row.support.trim() ? { support: row.support.trim() } : {}),
    }));
  const input: PromoteQgoInput = {
    leadRef: lead.id,
    evidence,
    nextStep: promoteNextStep.value.trim(),
  };
  promoteBusy.value = true;
  promoteError.value = null;
  try {
    await gainosApi.promoteQgo(input);
    promoteOpen.value = false;
    promoteTarget.value = null;
    notice.value = $t('gainos.leads.promoteDone');
    await router.push('/qgos');
  } catch (error) {
    promoteError.value = failureText(error);
  } finally {
    promoteBusy.value = false;
  }
}


const modal = ref<'accept' | 'reject' | null>(null);
const target = ref<Lead | null>(null);
const reasonCode = ref('');
const reasonNote = ref('');
const actionError = ref<{ title: string; next?: string } | null>(null);
const submitting = ref(false);

const reasonOptions = computed(() =>
  (modal.value === 'accept' ? ACCEPT_CODES : REJECT_CODES).map((code) => ({
    code,
    label: $t(`gainos.leads.reason.${code}`),
  })),
);

const modalTitle = computed(() =>
  modal.value === 'accept' ? $t('gainos.leads.acceptTitle') : $t('gainos.leads.rejectTitle'),
);
const modalDesc = computed(() =>
  modal.value === 'accept' ? $t('gainos.leads.acceptDesc') : $t('gainos.leads.rejectDesc'),
);
const confirmLabel = computed(() =>
  modal.value === 'accept' ? $t('gainos.leads.confirmAccept') : $t('gainos.leads.confirmReject'),
);

function queueMeta(key?: string) {
  return QUEUES.value.find((queue) => queue.key === key) ?? QUEUES.value[0]!;
}
function queueLabel(key?: string): string {
  return queueMeta(key).label;
}
function openSanctionsQueue(): void {
  if (!isAdmin.value) return;
  activeQueue.value = 'sanctions_hold';
}

function queueCount(key: string): number | undefined {
  const counts = queueCounts.value;
  if (!counts) return undefined;
  if (key === 'needs_review') return counts.needs_review;
  if (key === 'recommended') return counts.recommended;
  if (key === 'rejected') return counts.rejected;
  if (key === 'suppressed') return counts.suppressed;
  if (key === 'sanctions_hold') return counts.sanctions_hold;
  return undefined;
}

// 总数与「加载更多」：队列计数是权威总数，列表按 pageLimit 递增拉取。
const totalForQueue = computed(() => queueCount(activeQueue.value));
const hasMoreLeads = computed(
  () => typeof totalForQueue.value === 'number' && leads.value.length < totalForQueue.value,
);
function loadMore(): void {
  pageLimit.value += 50;
  void load();
}
function statusLabel(status?: string): string {
  if (!status) return $t('gainos.leads.status.DISCOVERED');
  const key = `gainos.leads.status.${status}`;
  const translated = $t(key);
  return translated === key ? status : translated;
}
function basisLabel(basis?: string): string {
  const map: Record<string, string> = {
    fit_gate_preset: $t('gainos.leads.basis.preset'),
    score: $t('gainos.leads.basis.score'),
    human_accept: $t('gainos.leads.basis.accept'),
    human_reject: $t('gainos.leads.basis.reject'),
  };
  return (basis && map[basis]) || '';
}
function fitLabel(verdict?: string | null): string {
  if (!verdict) return $t('gainos.leads.fit.unknown');
  const key = `gainos.leads.fit.${verdict}`;
  const translated = $t(key);
  return translated === key ? $t('gainos.leads.fit.unknown') : translated;
}
interface FactRow { label: string; value: string }

const companyProfileRows = computed<FactRow[]>(() => {
  const profile = pkg.value?.company_profile;
  if (!profile || typeof profile !== 'object') return [];
  const rows: FactRow[] = [];
  const record = profile as Record<string, unknown>;
  if (typeof record.trade_role === 'string' && record.trade_role) {
    const confidence = typeof record.trade_role_confidence === 'number'
      ? $t('gainos.leads.profileConfidence', { percent: Math.round(record.trade_role_confidence * 100) })
      : '';
    rows.push({ label: $t('gainos.leads.profileTradeRole'), value: `${record.trade_role}${confidence ? ` · ${confidence}` : ''}` });
  }
  if (typeof record.own_manufacturing === 'boolean') {
    rows.push({ label: $t('gainos.leads.profileOwnManufacturing'), value: record.own_manufacturing ? $t('gainos.leads.yes') : $t('gainos.leads.no') });
  }
  if (typeof record.carries_chinese_brand === 'boolean') {
    rows.push({ label: $t('gainos.leads.profileChineseBrand'), value: record.carries_chinese_brand ? $t('gainos.leads.yes') : $t('gainos.leads.no') });
  }
  if (typeof record.carries_foreign_brand === 'boolean') {
    rows.push({ label: $t('gainos.leads.profileForeignBrand'), value: record.carries_foreign_brand ? $t('gainos.leads.yes') : $t('gainos.leads.no') });
  }
  if (Array.isArray(record.carried_brands) && record.carried_brands.length > 0) {
    const names = record.carried_brands
      .map((brand) => (brand && typeof brand === 'object' && typeof (brand as { name?: unknown }).name === 'string' ? (brand as { name: string }).name : ''))
      .filter(Boolean);
    if (names.length) rows.push({ label: $t('gainos.leads.profileCarriedBrands'), value: names.join(' · ') });
  }
  return rows;
});

const IDENTIFIER_LABELS: Array<{ key: string; label: string }> = [
  { key: 'vat_id', label: 'VAT' },
  { key: 'lei', label: 'LEI' },
  { key: 'fda_reg', label: 'FDA' },
  { key: 'register_key', label: $t('gainos.leads.identifierRegister') },
];
const identifierRows = computed<Array<{ label: string; value: string }>>(() => {
  const identifiers = pkg.value?.identifiers;
  if (!identifiers || typeof identifiers !== 'object') return [];
  const record = identifiers as Record<string, unknown>;
  return IDENTIFIER_LABELS
    .map(({ key, label }) => ({ label, value: typeof record[key] === 'string' ? (record[key] as string) : '' }))
    .filter((row) => row.value);
});

const CONTACT_KIND_LABELS: Record<string, string> = {
  website: '官网',
  linkedin: 'LinkedIn',
  phone: '电话',
  email: '邮箱',
};
function contactKindLabel(kind: string): string {
  return CONTACT_KIND_LABELS[kind] ?? kind;
}
const companyContactRows = computed<Array<{ kind: string; url: string; status: string; href: string }>>(() => {
  const points = pkg.value?.contact_points;
  if (!Array.isArray(points)) return [];
  return points
    .filter((point) => point && typeof point.url === 'string' && point.url)
    .map((point) => ({
      kind: contactKindLabel(point.kind),
      url: point.url,
      status: point.status ?? '',
      href: /^https?:\/\//i.test(point.url) ? point.url : '',
    }));
});

function reasonsOf(lead: Lead): string[] {
  const raw = lead.fitReasons;
  if (Array.isArray(raw)) return raw.map((item) => String(item)).filter(Boolean);
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    for (const field of ['reasons', 'matched', 'notes']) {
      const value = record[field];
      if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
    }
    const text = record.summary ?? record.reason;
    if (typeof text === 'string' && text.trim()) return [text];
  }
  return [];
}
function scoreText(lead: Lead): string {
  return typeof lead.totalScore === 'number' ? $t('gainos.leads.score', { score: Math.round(lead.totalScore) }) : $t('gainos.leads.notScored');
}
function whyText(lead: Lead): string {
  const reasons = reasonsOf(lead);
  if (reasons.length > 0) return reasons.slice(0, 2).join(' · ');
  return fitLabel(lead.fitVerdict);
}
function canAct(lead: Lead): boolean {
  return !['rejected', 'suppressed', 'sanctions_hold'].includes(lead.queue ?? '') &&
    !['QUALIFIED', 'REJECTED', 'SUPPRESSED'].includes(lead.status ?? '');
}
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const field of ['label', 'summary', 'title', 'name', 'reason', 'excerpt', 'value']) {
      const text = record[field];
      if (typeof text === 'string' && text.trim()) return text;
    }
  }
  return '';
}
function evidenceUrl(item: Record<string, unknown>): string {
  for (const field of ['url', 'source_url', 'sourceUrl', 'link']) {
    const value = item[field];
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
  }
  return '';
}
function scoreValue(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.round(value));
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.score === 'number') return String(Math.round(record.score));
    if (typeof record.value === 'number') return String(Math.round(record.value));
  }
  return '—';
}
function sanctionLabel(status?: string): string {
  if (!status) return $t('gainos.leads.sanction.not_screened');
  const key = `gainos.leads.sanction.${status}`;
  const translated = $t(key);
  return translated === key ? status : translated;
}
function sanctionBlocked(status?: string): boolean {
  return status === 'potential_match' || status === 'confirmed_true_hit';
}
function formatDate(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}
const draftText = computed(() => {
  if (!draft.value) return '';
  const record = draft.value;
  // 引擎合同字段是 bodyZh(中文译文);其余键保留给旧缓存/旧引擎的兼容读取。
  const parts = [record.subject, record.body, record.bodyZh, record.translation, record.body_zh, record.text]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
  return parts.length > 0 ? parts.join('\n\n') : JSON.stringify(record, null, 2);
});

async function loadIcps(): Promise<void> {
  try {
    const data = await gainosApi.icps();
    icps.value = Array.isArray(data) ? data : [];
    activeIcpId.value =
      icps.value.find((icp) => icp.status === 'ACTIVE')?.id ??
      icps.value[0]?.id ??
      '';
  } catch {
    icps.value = [];
    activeIcpId.value = '';
  }
}

async function loadQueueCounts(): Promise<void> {
  if (!activeIcpId.value) {
    queueCounts.value = null;
    return;
  }
  try {
    const data = await gainosApi.leadQueues(activeIcpId.value);
    queueCounts.value = (data as unknown as { data?: LeadQueueCounts })?.data ?? data;
  } catch {
    queueCounts.value = null;
  }
}

async function load(): Promise<void> {
  if (!activeIcpId.value) {
    leads.value = [];
    queueCounts.value = null;
    loading.value = false;
    return;
  }
  loading.value = true;
  loadError.value = null;
  try {
    const data = await gainosApi.leads({ icpId: activeIcpId.value, queue: activeQueue.value, limit: pageLimit.value });
    leads.value = Array.isArray(data) ? data : ((data as { data?: Lead[] })?.data ?? []);
    await loadQueueCounts();
  } catch (error) {
    loadError.value = failureText(error);
    leads.value = [];
  } finally {
    loading.value = false;
  }
}

async function openPackage(lead: Lead): Promise<void> {
  selected.value = lead;
  pkg.value = null;
  pkgError.value = null;
  draft.value = readDraftCache(lead.id);
  draftError.value = null;
  copied.value = false;
  pkgLoading.value = true;
  try {
    pkg.value = await gainosApi.leadPackage(lead.id);
    // 已有草稿时直接展示；旧引擎没有这个只读端点时静默忽略，本地缓存仍可用。
    const existingDraft = await gainosApi.outreachDrafts(lead.id).catch(() => null);
    if (existingDraft && typeof existingDraft === 'object') {
      draft.value = existingDraft as Record<string, unknown>;
      writeDraftCache(lead.id, draft.value);
    }
  } catch (error) {
    pkgError.value = failureText(error);
  } finally {
    pkgLoading.value = false;
  }
}

function closePackage(): void {
  selected.value = null;
  pkg.value = null;
  pkgError.value = null;
  draft.value = null;
  draftError.value = null;
}

function downloadPackage(): void {
  if (!pkg.value || !selected.value) return;
  const blob = new Blob([JSON.stringify(pkg.value, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `lead-package-${selected.value.id}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function openAccept(lead: Lead): void {
  target.value = lead;
  modal.value = 'accept';
  reasonCode.value = '';
  reasonNote.value = '';
  actionError.value = null;
}
function openReject(lead: Lead): void {
  target.value = lead;
  modal.value = 'reject';
  reasonCode.value = '';
  reasonNote.value = '';
  actionError.value = null;
}
function closeModal(): void {
  modal.value = null;
  target.value = null;
  reasonCode.value = '';
  reasonNote.value = '';
  actionError.value = null;
  submitting.value = false;
}

async function submitDecision(): Promise<void> {
  if (!target.value || !modal.value) return;
  if (modal.value === 'reject' && !reasonCode.value) {
    actionError.value = { title: $t('gainos.leads.reasonRequired'), next: $t('gainos.leads.rejectDesc') };
    return;
  }
  submitting.value = true;
  actionError.value = null;
  const input: LeadDecisionInput = {
    ...(reasonCode.value ? { reasonCode: reasonCode.value } : {}),
    ...(reasonNote.value.trim() ? { reason: reasonNote.value.trim() } : {}),
  };
  try {
    if (modal.value === 'accept') {
      await gainosApi.acceptLead(target.value.id, input);
      notice.value = $t('gainos.leads.acceptedNotice');
    } else {
      await gainosApi.rejectLead(target.value.id, input);
      notice.value = $t('gainos.leads.rejectedNotice');
    }
    closeModal();
    closePackage();
    await load();
    setTimeout(() => { notice.value = null; }, 5000);
  } catch (error) {
    actionError.value = failureText(error);
  } finally {
    submitting.value = false;
  }
}

async function generateDraft(): Promise<void> {
  if (!selected.value) return;
  draftLoading.value = true;
  draftError.value = null;
  draft.value = null;
  copied.value = false;
  try {
    const row = await gainosApi.outreachDraft(selected.value.id);
    draft.value = row;
    writeDraftCache(selected.value.id, row);
  } catch (error) {
    draftError.value = failureText(error);
  } finally {
    draftLoading.value = false;
  }
}

async function copyDraft(): Promise<void> {
  if (!draftText.value) return;
  try {
    await navigator.clipboard.writeText(draftText.value);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 2000);
  } catch {
    copied.value = false;
  }
}

async function reviewSanctions(decision: 'cleared_false_positive' | 'confirmed_true_hit'): Promise<void> {
  if (!selected.value || sanctionsBusy.value) return;
  const confirmed = window.confirm(
    decision === 'cleared_false_positive'
      ? $t('gainos.leads.sanctionsClearConfirm')
      : $t('gainos.leads.sanctionsConfirmConfirm'),
  );
  if (!confirmed) return;
  sanctionsBusy.value = true;
  sanctionsError.value = null;
  sanctionsNotice.value = null;
  try {
    await gainosApi.sanctionsReview(selected.value.id, decision);
    sanctionsNotice.value = decision === 'cleared_false_positive'
      ? $t('gainos.leads.sanctionsCleared')
      : $t('gainos.leads.sanctionsConfirmed');
    pkg.value = await gainosApi.leadPackage(selected.value.id);
    await load();
  } catch (error) {
    sanctionsError.value = failureText(error);
  } finally {
    sanctionsBusy.value = false;
  }
}

watch(activeQueue, () => {
  notice.value = null;
  pageLimit.value = 50;
  void load();
});
watch(
  () => route.query.queue,
  () => {
    const queue = queueFromRoute();
    if (queue) activeQueue.value = queue;
  },
);
function onEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  if (modal.value) {
    closeModal();
  } else if (selected.value) {
    closePackage();
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
  const rawQueue = Array.isArray(route.query.queue) ? route.query.queue[0] : route.query.queue;
  if (isAdmin.value && rawQueue === 'sanctions_hold') {
    activeQueue.value = 'sanctions_hold';
  }
  await loadIcps();
  await load();
});
onUnmounted(() => window.removeEventListener('keydown', onEscape));
</script>

<template>
  <div class="ld">
    <header class="ld__head">
      <div>
        <span class="ld__stage">{{ $t('gainos.leads.stage') }}</span>
        <h1>{{ $t('gainos.leads.title') }}</h1>
        <p>{{ $t('gainos.leads.subtitle') }}</p>
      </div>
      <div class="ld__head-actions">
        <label v-if="icps.length" class="ld__icp-select">
          <span>{{ $t('gainos.leads.icpFilter') }}</span>
          <select v-model="activeIcpId" @change="load()">
            <option v-for="icp in icps" :key="icp.id" :value="icp.id">{{ icp.name }}</option>
          </select>
        </label>
        <button class="ld__refresh" type="button" @click="$router.push('/qgos')">{{ $t('gainos.leads.qgoEntry') }}</button>
        <button class="ld__refresh" type="button" :class="{ 'is-loading': loading }" @click="load">
          {{ loading ? $t('gainos.common.refreshing') : $t('gainos.common.refresh') }}
        </button>
      </div>
    </header>

    <section v-if="!loading && !activeIcpId" class="ld__empty">
      <p class="ld__empty-title">{{ $t('gainos.leads.noIcpTitle') }}</p>
      <p class="ld__empty-desc">{{ $t('gainos.leads.noIcpDesc') }}</p>
      <button type="button" class="ld__cta" @click="$router.push('/find-buyers')">{{ $t('gainos.leads.goFindBuyers') }}</button>
    </section>

    <ol class="ld__steps" :aria-label="$t('gainos.workspace.stepProgress', { current: currentStep, total: stepLabels.length })">
      <li v-for="(label, i) in stepLabels" :key="label" class="ld__step" :class="{ 'is-done': i + 1 < currentStep, 'is-current': i + 1 === currentStep }">
        <span class="ld__step-dot">{{ i + 1 }}</span>
        <span class="ld__step-label">{{ label }}</span>
      </li>
    </ol>

    <p v-if="notice" class="ld__notice" role="status">{{ notice }}</p>

    <nav v-if="activeIcpId" class="ld__queues" :aria-label="$t('gainos.leads.title')">
      <button
        v-for="queue in QUEUES"
        :key="queue.key"
        type="button"
        class="ld__q"
        :class="[`ld__q--${queue.tone}`, { 'is-active': activeQueue === queue.key }]"
        :aria-pressed="activeQueue === queue.key"
        @click="activeQueue = queue.key"
      >
        <div class="ld__q-head">
          <h2>{{ queue.label }}</h2>
          <span v-if="queueCount(queue.key) !== undefined" class="ld__q-count">{{ queueCount(queue.key) }}</span>
        </div>
        <p>{{ queue.desc }}</p>
      </button>
    </nav>

    <button
      v-if="activeIcpId && activeQueue !== 'sanctions_hold' && (queueCounts?.sanctions_hold ?? 0) > 0"
      type="button"
      class="ld__sanctions-banner"
      :disabled="!isAdmin"
      @click="openSanctionsQueue"
    >
      {{ $t('gainos.leads.sanctionsHoldCount', { count: queueCounts?.sanctions_hold }) }}
      <span v-if="isAdmin">→ {{ $t('gainos.leads.queueSanctions') }}</span>
      <span v-else>· {{ $t('gainos.leads.sanctionsAdminOnly') }}</span>
    </button>

    <section v-if="loadError" class="ld__error" role="alert">
      <h2>{{ loadError.title }}</h2>
      <p v-if="loadError.next">{{ loadError.next }}</p>
      <button type="button" @click="load">{{ $t('gainos.common.retry') }}</button>
    </section>

    <section v-else-if="loading" class="ld__skeletons" :aria-label="$t('gainos.common.loading')">
      <div v-for="i in 3" :key="i" class="ld__skeleton"></div>
    </section>

    <section v-else-if="activeIcpId && leads.length === 0" class="ld__empty">
      <div class="ld__empty-mark">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/><path d="M8.5 11h5"/></svg>
      </div>
      <p class="ld__empty-title">{{ $t('gainos.leads.emptyTitle') }}</p>
      <p class="ld__empty-desc">{{ $t('gainos.leads.emptyDesc') }}</p>
      <RouterLink class="ld__cta" to="/find-buyers">{{ $t('gainos.leads.emptyCta') }}</RouterLink>
    </section>

    <section v-else class="ld__list">
      <article v-for="lead in leads" :key="lead.id" class="ld__lead">
        <header class="ld__lead-head">
          <div>
            <h2>{{ lead.company?.name || $t('gainos.leads.unknownCompany') }}</h2>
            <p v-if="lead.company?.country || lead.company?.industry">
              {{ [lead.company?.country, lead.company?.industry].filter(Boolean).join(' · ') }}
            </p>
          </div>
          <span class="ld__score" :class="{ 'is-scored': typeof lead.totalScore === 'number' }">{{ scoreText(lead) }}</span>
        </header>
        <p class="ld__why">{{ whyText(lead) }}</p>
        <div class="ld__meta">
          <span class="gs-badge" :class="statusClass(queueMeta(lead.queue).tone)">{{ queueLabel(lead.queue) }}</span>
          <span v-if="basisLabel(lead.queueBasis)" class="ld__basis">{{ basisLabel(lead.queueBasis) }}</span>
          <span v-if="lead.company?.employeeCount" class="ld__basis">{{ lead.company.employeeCount }} 人</span>
        </div>
        <div class="ld__actions">
          <button type="button" class="ld__action" @click="openPackage(lead)">{{ $t('gainos.leads.viewPackage') }}</button>
          <template v-if="canAct(lead)">
            <button type="button" class="ld__action ld__action--reject" @click="openReject(lead)">{{ $t('gainos.leads.reject') }}</button>
            <button type="button" class="ld__action ld__action--accept" @click="openAccept(lead)">{{ $t('gainos.leads.accept') }}</button>
          </template>
          <button v-else-if="lead.status === 'QUALIFIED'" type="button" class="ld__action ld__action--accept" @click="openPromote(lead)">
            {{ $t('gainos.leads.promoteQgo') }}
          </button>
        </div>
      </article>
      <div v-if="hasMoreLeads" class="ld__more">
        <span class="ld__basis">{{ $t('gainos.leads.showingCount', { shown: leads.length, total: totalForQueue }) }}</span>
        <button type="button" class="ld__action" @click="loadMore">{{ $t('gainos.leads.loadMore') }}</button>
      </div>
    </section>

    <!-- 线索档案包 -->
    <div v-if="selected" class="ld__overlay" @click.self="closePackage">
      <section class="ld__modal" role="dialog" aria-modal="true" :aria-label="$t('gainos.leads.packageTitle')">
        <header class="ld__modal-head">
          <div>
            <span class="ld__modal-kicker">{{ $t('gainos.leads.packageTitle') }}</span>
            <h2>{{ pkg?.company.name || selected.company?.name || $t('gainos.leads.unknownCompany') }}</h2>
            <p v-if="pkg?.company.domain">{{ pkg.company.domain }}</p>
          </div>
          <div class="ld__modal-head-actions">
            <button v-if="pkg" type="button" class="ld__action" @click="downloadPackage">{{ $t('gainos.leads.downloadPackage') }}</button>
            <button type="button" class="ld__close" :aria-label="$t('gainos.common.cancel')" @click="closePackage">×</button>
          </div>
        </header>

        <div class="ld__modal-body">
        <p v-if="pkgLoading" class="ld__modal-state">{{ $t('gainos.common.loading') }}</p>
        <div v-else-if="pkgError" class="ld__modal-error" role="alert">
          <h3>{{ pkgError.title }}</h3>
          <p v-if="pkgError.next">{{ pkgError.next }}</p>
        </div>
        <template v-else-if="pkg">
          <div class="ld__modal-grid">
            <div class="ld__block">
              <h3>{{ $t('gainos.leads.companyFacts') }}</h3>
              <dl class="ld__facts">
                <div v-if="pkg.company.domain"><dt>{{ $t('gainos.leads.domain') }}</dt><dd>{{ pkg.company.domain }}</dd></div>
                <div v-if="pkg.company.country"><dt>{{ $t('gainos.leads.country') }}</dt><dd>{{ pkg.company.country }}</dd></div>
                <div v-if="pkg.company.city"><dt>{{ $t('gainos.leads.city') }}</dt><dd>{{ pkg.company.city }}</dd></div>
                <div v-if="pkg.registered_address"><dt>{{ $t('gainos.leads.address') }}</dt><dd>{{ pkg.registered_address }}</dd></div>
                <div><dt>{{ $t('gainos.leads.statusLabel') }}</dt><dd>{{ statusLabel(pkg.status) }}</dd></div>
              </dl>
            </div>
            <div class="ld__block">
              <h3>{{ $t('gainos.leads.fitTitle') }}</h3>
              <p class="ld__fit">{{ fitLabel(typeof pkg.fit?.verdict === 'string' ? pkg.fit.verdict : selected.fitVerdict) }}</p>
              <p v-if="pkg.fit && Array.isArray(pkg.fit.reasons)" class="ld__muted">{{ pkg.fit.reasons.join(' · ') }}</p>
            </div>
          </div>

          <div v-if="companyProfileRows.length || identifierRows.length" class="ld__block">
            <h3>{{ $t('gainos.leads.profileTitle') }}</h3>
            <dl class="ld__facts">
              <div v-for="row in companyProfileRows" :key="row.label">
                <dt>{{ row.label }}</dt><dd>{{ row.value }}</dd>
              </div>
            </dl>
            <div v-if="identifierRows.length" class="ld__profile-ids">
              <span v-for="item in identifierRows" :key="item.label" class="ld__profile-id" :title="item.label">
                <small>{{ item.label }}</small>{{ item.value }}
              </span>
            </div>
          </div>

          <div v-if="companyContactRows.length" class="ld__block">
            <h3>{{ $t('gainos.leads.companyContactsTitle') }}</h3>
            <ul class="ld__bullets">
              <li v-for="point in companyContactRows" :key="`${point.kind}-${point.url}`">
                <a v-if="point.href" :href="point.href" target="_blank" rel="noreferrer">{{ point.kind }} · {{ point.url }}</a>
                <template v-else>{{ point.kind }} · {{ point.url }}</template>
                <span v-if="point.status" class="ld__muted">（{{ point.status }}）</span>
              </li>
            </ul>
          </div>

          <div class="ld__block">
            <h3>{{ $t('gainos.leads.scoresTitle') }}</h3>
            <dl class="ld__scores">
              <div v-for="dim in SCORE_DIMS" :key="dim">
                <dt>{{ $t(`gainos.leads.dim.${dim}`) }}</dt>
                <dd>{{ scoreValue(pkg.scores?.[dim]) }}</dd>
              </div>
              <div>
                <dt>{{ $t('gainos.leads.dim.total') }}</dt>
                <dd>{{ typeof pkg.scores?.total === 'number' ? $t('gainos.leads.score', { score: Math.round(pkg.scores.total) }) : $t('gainos.leads.notScored') }}</dd>
              </div>
            </dl>
          </div>

          <div class="ld__block">
            <h3>{{ $t('gainos.leads.signalsTitle') }}</h3>
            <ul v-if="pkg.signals && pkg.signals.length" class="ld__bullets">
              <li v-for="(signal, i) in pkg.signals" :key="i">{{ textOf(signal) || '—' }}</li>
            </ul>
            <p v-else class="ld__muted">{{ $t('gainos.leads.noSignals') }}</p>
          </div>

          <div class="ld__block">
            <h3>{{ $t('gainos.leads.evidenceTitle') }}</h3>
            <ul v-if="pkgEvidence.length" class="ld__bullets">
              <li v-for="(item, i) in pkgEvidence" :key="i">
                <a v-if="evidenceUrl(item)" :href="evidenceUrl(item)" target="_blank" rel="noreferrer">{{ textOf(item) || evidenceUrl(item) }}</a>
                <span v-else>{{ textOf(item) || '—' }}</span>
              </li>
            </ul>
            <p v-else class="ld__muted">{{ $t('gainos.leads.noEvidence') }}</p>
          </div>

          <div class="ld__block">
            <h3>{{ $t('gainos.leads.contactPathTitle') }}</h3>
            <template v-if="pkg.suggested_contact_path">
              <p class="ld__contact"><a :href="pkg.suggested_contact_path.url" target="_blank" rel="noreferrer">{{ pkg.suggested_contact_path.url }}</a></p>
              <p class="ld__muted">{{ pkg.suggested_contact_path.legal_note }}</p>
            </template>
            <p v-else class="ld__muted">{{ $t('gainos.leads.noContactPath') }}</p>
            <p class="ld__muted">{{ $t('gainos.leads.contactPathNote') }}</p>
          </div>

          <!-- 决策人（联系人挖掘 M4）：具名联系人 + 联系方式状态 + 证据；仅管理员身份可读。 -->
          <DecisionMakerCard
            v-if="isAdmin && pkg.company.canonical_company_id"
            :company-id="pkg.company.canonical_company_id"
          />

          <div class="ld__block" :class="{ 'is-warn': sanctionBlocked(pkg.sanctions?.status) }">
            <h3>{{ $t('gainos.leads.sanctionsTitle') }}</h3>
            <p :class="{ 'ld__warn-text': sanctionBlocked(pkg.sanctions?.status) }">{{ sanctionLabel(pkg.sanctions?.status) }}</p>
            <div v-if="isAdmin && sanctionBlocked(pkg.sanctions?.status)" class="ld__sanctions-actions">
              <p class="ld__muted">{{ $t('gainos.leads.sanctionsAdminHint') }}</p>
              <div>
                <button
                  v-if="pkg.sanctions?.status !== 'confirmed_true_hit'"
                  type="button"
                  class="ld__action"
                  :disabled="sanctionsBusy"
                  @click="reviewSanctions('cleared_false_positive')"
                >
                  {{ $t('gainos.leads.sanctionsClear') }}
                </button>
                <button
                  v-if="pkg.sanctions?.status !== 'confirmed_true_hit'"
                  type="button"
                  class="ld__action ld__action--danger"
                  :disabled="sanctionsBusy"
                  @click="reviewSanctions('confirmed_true_hit')"
                >
                  {{ $t('gainos.leads.sanctionsConfirm') }}
                </button>
              </div>
            </div>
            <p v-if="sanctionsError" class="ld__modal-error" role="alert">{{ sanctionsError.title }}</p>
            <p v-if="sanctionsNotice" class="ld__muted" role="status">{{ sanctionsNotice }}</p>
          </div>

          <p v-if="pkg.valid_until" class="ld__muted">{{ $t('gainos.leads.validUntil', { date: formatDate(pkg.valid_until) }) }}</p>

          <div class="ld__draft">
            <div class="ld__draft-head">
              <div>
                <h3>{{ $t('gainos.leads.outreachDraft') }}</h3>
                <p class="ld__muted">{{ $t('gainos.leads.outreachDraftDesc') }}</p>
              </div>
              <button v-if="selected.status === 'QUALIFIED' && !draft" type="button" class="ld__action" :class="{ 'is-loading': draftLoading }" :disabled="draftLoading" @click="generateDraft">
                {{ draftLoading ? $t('gainos.common.loading') : $t('gainos.leads.outreachDraft') }}
              </button>
              <span v-else-if="draft" class="ld__muted">{{ $t('gainos.leads.outreachReady') }}</span>
              <span v-else class="ld__muted">{{ $t('gainos.leads.outreachNeedsQualified') }}</span>
            </div>
            <div v-if="draftError" class="ld__modal-error" role="alert">
              <h3>{{ draftError.title }}</h3>
              <p v-if="draftError.next">{{ draftError.next }}</p>
            </div>
            <template v-else-if="draftText">
              <pre class="ld__draft-body">{{ draftText }}</pre>
              <button type="button" class="ld__action" @click="copyDraft">{{ copied ? $t('gainos.leads.copied') : $t('gainos.leads.copy') }}</button>
            </template>
          </div>

          <div v-if="selected && canAct(selected)" class="ld__modal-actions">
            <button type="button" class="ld__action ld__action--reject" @click="openReject(selected)">{{ $t('gainos.leads.reject') }}</button>
            <button type="button" class="ld__action ld__action--accept" @click="openAccept(selected)">{{ $t('gainos.leads.accept') }}</button>
          </div>
        </template>
        </div>
      </section>
    </div>

    <!-- 裁决弹层 -->
    <div v-if="modal" class="ld__overlay ld__overlay--top" @click.self="closeModal">
      <section class="ld__modal ld__modal--narrow" role="dialog" aria-modal="true" :aria-label="modalTitle">
        <header class="ld__modal-head">
          <div>
            <h2>{{ modalTitle }}</h2>
            <p>{{ modalDesc }}</p>
          </div>
          <button type="button" class="ld__close" :aria-label="$t('gainos.common.cancel')" @click="closeModal">×</button>
        </header>
        <div class="ld__modal-body">
        <div v-if="actionError" class="ld__modal-error" role="alert">
          <h3>{{ actionError.title }}</h3>
          <p v-if="actionError.next">{{ actionError.next }}</p>
        </div>
        <label class="ld__field">
          <span>{{ $t('gainos.leads.reasonCode') }}<em v-if="modal === 'reject'"> *</em></span>
          <select v-model="reasonCode">
            <option value="">{{ modal === 'reject' ? $t('gainos.leads.reasonSelect') : $t('gainos.leads.reasonOptional') }}</option>
            <option v-for="option in reasonOptions" :key="option.code" :value="option.code">{{ option.label }}</option>
          </select>
        </label>
        <label class="ld__field">
          <span>{{ $t('gainos.leads.reasonNote') }}</span>
          <textarea v-model="reasonNote" rows="3" :placeholder="$t('gainos.leads.reasonPlaceholder')"></textarea>
        </label>
        <div class="ld__modal-actions">
          <button type="button" class="ld__action" @click="closeModal">{{ $t('gainos.common.cancel') }}</button>
          <button type="button" class="ld__action ld__action--accept" :class="{ 'is-loading': submitting }" :disabled="submitting" @click="submitDecision">
            {{ submitting ? $t('gainos.leads.submitting') : confirmLabel }}
          </button>
        </div>
        </div>
      </section>
    </div>

    <!-- M2 步 10：提升为商机（QGO） -->
    <div v-if="promoteOpen" class="ld__overlay ld__overlay--top" @click.self="promoteOpen = false">
      <section class="ld__modal ld__modal--narrow" role="dialog" aria-modal="true" :aria-label="$t('gainos.leads.promoteTitle')">
        <header class="ld__modal-head">
          <div>
            <h2>{{ $t('gainos.leads.promoteTitle') }}</h2>
            <p>{{ promoteTarget?.company?.name || $t('gainos.leads.unknownCompany') }}</p>
          </div>
          <button type="button" class="ld__close" :aria-label="$t('gainos.common.cancel')" @click="promoteOpen = false">×</button>
        </header>
        <div class="ld__modal-body">
          <div v-if="promoteError" class="ld__modal-error" role="alert">
            <h3>{{ promoteError.title }}</h3>
            <p v-if="promoteError.why">{{ promoteError.why }}</p>
            <p v-if="promoteError.next">{{ promoteError.next }}</p>
          </div>
          <div class="ld__field">
            <span>{{ $t('gainos.leads.promoteEvidence') }}</span>
            <div v-for="(row, i) in promoteEvidence" :key="i" class="ld__evidence-row">
              <select v-model="row.type" :aria-label="$t('gainos.leads.promoteEvidenceType')">
                <option value="customer_reply">{{ $t('gainos.leads.evidenceType.customer_reply') }}</option>
                <option value="purchase_page">{{ $t('gainos.leads.evidenceType.purchase_page') }}</option>
                <option value="tender_hit">{{ $t('gainos.leads.evidenceType.tender_hit') }}</option>
                <option value="customs_signal">{{ $t('gainos.leads.evidenceType.customs_signal') }}</option>
                <option value="other">{{ $t('gainos.leads.evidenceType.other') }}</option>
              </select>
              <input v-model="row.url" type="url" :placeholder="$t('gainos.leads.promoteUrlHint')" />
              <input v-model="row.support" type="text" maxlength="500" :placeholder="$t('gainos.leads.promoteSupportHint')" />
              <button type="button" class="ld__action" :disabled="promoteEvidence.length <= 1" @click="removeEvidenceRow(i)">×</button>
            </div>
            <button type="button" class="ld__action" @click="addEvidenceRow">{{ $t('gainos.leads.addEvidence') }}</button>
          </div>
          <label class="ld__field">
            <span>{{ $t('gainos.leads.promoteNextStep') }}</span>
            <textarea v-model="promoteNextStep" rows="2" maxlength="500" :placeholder="$t('gainos.leads.promoteNextStepHint')"></textarea>
          </label>
          <div class="ld__modal-actions">
            <button type="button" class="ld__action" @click="promoteOpen = false">{{ $t('gainos.common.cancel') }}</button>
            <button type="button" class="ld__action ld__action--accept" :disabled="promoteBusy || !promoteNextStep.trim()" @click="submitPromote">
              {{ promoteBusy ? $t('gainos.leads.submitting') : $t('gainos.leads.promoteSubmit') }}
            </button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.ld {
  padding: clamp(18px, 2.4vw, 32px) clamp(18px, 2.4vw, 34px) clamp(32px, 4vh, 48px);
  max-width: 1280px;
  margin: 0 auto;
  display: grid;
  gap: 18px;
}
.ld__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.ld__head-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ld__icp-select { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--gs-fg-muted); }
.ld__icp-select select {
  border: 1px solid var(--gs-border-strong); border-radius: 9px; background: var(--gs-surface);
  color: var(--gs-fg); padding: 7px 10px; font-size: 12.5px; max-width: 260px;
}
.ld__q-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ld__q-count {
  border-radius: 999px; background: var(--gs-surface-3); color: var(--gs-fg-2);
  padding: 1px 8px; font-size: 11.5px; font-weight: 700;
}
.ld__sanctions-banner {
  margin: 0; padding: 9px 12px; border-radius: 9px; font-size: 12.5px; font-family: inherit;
  color: var(--gs-warn); background: var(--gs-warn-bg); border: 1px solid var(--gs-warn);
  display: flex; justify-content: space-between; align-items: center; gap: 10px; text-align: left;
  cursor: pointer;
}
.ld__sanctions-banner:disabled { cursor: default; }
.ld__sanctions-banner span { font-weight: 600; white-space: nowrap; }
.ld__stage { font-size: 11.5px; font-weight: 700; letter-spacing: .18em; color: var(--gs-accent-strong); }
.ld__head h1 { margin: 6px 0 0; font-size: 24px; font-weight: 700; color: var(--gs-fg); }
.ld__head p { margin: 8px 0 0; font-size: 13.5px; color: var(--gs-fg-muted); max-width: 620px; line-height: 1.7; }
.ld__refresh {
  border: 1px solid var(--gs-border-strong); background: var(--gs-surface); border-radius: 10px; padding: 8px 16px;
  font-size: 13px; color: var(--gs-fg-2); cursor: pointer; white-space: nowrap;
}
.ld__refresh.is-loading { opacity: .6; cursor: progress; }
.ld__steps { list-style: none; margin: 0; padding: 0; display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }
.ld__step { display: flex; align-items: center; gap: 6px; flex: none; padding: 6px 10px; border-radius: 999px; font-size: 12px; color: var(--gs-fg-subtle); background: var(--gs-divider); }
.ld__step-dot { width: 19px; height: 19px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--gs-surface); font-size: 10.5px; font-weight: 700; }
.ld__step.is-done { color: var(--gs-accent-strong); background: var(--gs-accent-soft); }
.ld__step.is-current { color: var(--gs-accent-cta-fg); background: var(--gs-accent-cta); }
.ld__step.is-current .ld__step-dot { background: rgba(255,255,255,.22); color: #fff; }
.ld__notice { margin: 0; padding: 10px 14px; border-radius: 10px; background: var(--gs-accent-soft); color: var(--gs-accent-strong); font-size: 13px; font-weight: 600; }
.ld__queues { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
.ld__q {
  text-align: left; background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px; padding: 14px 16px;
  display: grid; gap: 6px; cursor: pointer; transition: border-color .15s ease, background .15s ease;
}
.ld__q h2 { margin: 0; font-size: 14px; font-weight: 650; color: var(--gs-fg); }
.ld__q p { margin: 0; font-size: 12.5px; color: var(--gs-fg-subtle); line-height: 1.6; }
.ld__q.is-active { border-color: var(--gs-accent); background: var(--gs-surface-3); }
.ld__q--primary h2 { color: var(--gs-accent-strong); }
.ld__q--warn h2 { color: var(--gs-warn); }
.ld__error { background: var(--gs-surface); border: 1px solid var(--gs-warn); border-radius: 14px; padding: 20px; display: grid; gap: 8px; }
.ld__error h2 { margin: 0; font-size: 15px; color: var(--gs-warn); }
.ld__error p { margin: 0; font-size: 13px; color: var(--gs-fg-muted); }
.ld__error button { justify-self: start; border: 0; border-radius: 8px; padding: 7px 14px; background: var(--gs-accent-cta); color: var(--gs-accent-cta-fg); cursor: pointer; font-size: 13px; }
.ld__skeletons { display: grid; gap: 12px; }
.ld__skeleton { height: 104px; border-radius: 14px; background: var(--gs-surface-2); border: 1px solid var(--gs-border); animation: ld-pulse 1.4s ease-in-out infinite; }
@keyframes ld-pulse { 50% { opacity: .55; } }
.ld__empty {
  max-width: 760px; margin: 0 auto; display: grid; place-items: center; gap: 6px; text-align: center;
  background: var(--gs-surface); border: 1px dashed var(--gs-border-dashed); border-radius: 16px; padding: 48px 24px;
}
.ld__empty-mark { width: 52px; height: 52px; border-radius: 14px; background: var(--gs-divider); color: var(--gs-fg-subtle); display: flex; align-items: center; justify-content: center; margin-bottom: 8px; }
.ld__empty-mark svg { width: 26px; height: 26px; }
.ld__empty-title { margin: 0; font-size: 16.5px; font-weight: 600; color: var(--gs-fg); }
.ld__empty-desc { margin: 0 0 14px; font-size: 13.5px; color: var(--gs-fg-muted); max-width: 520px; line-height: 1.75; }
.ld__cta { border-radius: 11px; padding: 10px 20px; font-size: 13.5px; font-weight: 600; background: var(--gs-accent-cta); color: var(--gs-accent-cta-fg); text-decoration: none; }
.ld__list { display: grid; gap: 12px; }
.ld__more { display: flex; justify-content: center; align-items: center; gap: 12px; padding: 8px 0 4px; }
.ld__lead { background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px; padding: 18px 20px; display: grid; gap: 10px; }
.ld__lead-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
.ld__lead-head h2 { margin: 0; font-size: 16px; font-weight: 650; color: var(--gs-fg); }
.ld__lead-head p { margin: 4px 0 0; font-size: 12.5px; color: var(--gs-fg-subtle); }
.ld__profile-ids { display: flex; flex-wrap: wrap; gap: 6px; }
.ld__profile-id { display: inline-grid; gap: 1px; background: var(--gs-divider); border-radius: 8px; padding: 5px 10px; font-size: 12.5px; color: var(--gs-fg-2); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.ld__profile-id small { font-size: 10.5px; color: var(--gs-fg-subtle); }
.ld__score { flex: none; font-variant-numeric: tabular-nums; font-size: 13px; font-weight: 700; color: var(--gs-fg-subtle); background: var(--gs-divider); border-radius: 8px; padding: 4px 10px; }
.ld__score.is-scored { color: var(--gs-accent-strong); background: var(--gs-accent-soft); }
.ld__why { margin: 0; font-size: 13.5px; line-height: 1.7; color: var(--gs-fg-2); }
.ld__meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.ld__basis { font-size: 11.5px; color: var(--gs-fg-subtle); }
.ld__actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.ld__action { border: 1px solid var(--gs-border-strong); background: var(--gs-surface); color: var(--gs-fg-2); border-radius: 9px; padding: 8px 14px; font-size: 13px; cursor: pointer; }
.ld__action:hover { border-color: var(--gs-accent); color: var(--gs-accent-strong); }
.ld__action--accept { background: var(--gs-accent-cta); border-color: var(--gs-accent-cta); color: var(--gs-accent-cta-fg); font-weight: 600; }
.ld__action--accept:hover { color: #fff; }
.ld__action--reject { color: var(--gs-danger); border-color: var(--gs-danger-border); }
.ld__action--danger { color: var(--gs-danger); border-color: var(--gs-danger-border); }
.ld__action.is-loading { opacity: .6; cursor: progress; }
.ld__sanctions-actions { display: grid; gap: 8px; margin-top: 6px; }
.ld__sanctions-actions > div { display: flex; gap: 8px; flex-wrap: wrap; }
.ld__overlay {
  position: fixed; inset: 0; z-index: 1000; background: rgba(15, 23, 42, .58); backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center; padding: 24px; overflow: hidden;
}
.ld__overlay--top { z-index: 1010; }
.ld__modal {
  width: min(860px, 100%); max-height: calc(100dvh - 48px); overflow: hidden; box-sizing: border-box;
  background: var(--gs-surface); border-radius: 18px; box-shadow: 0 24px 60px -20px rgba(15, 23, 42, .4);
  display: flex; flex-direction: column;
}
.ld__modal--narrow { width: min(520px, 100%); }
.ld__modal-head {
  flex: none; display: flex; justify-content: space-between; align-items: flex-start; gap: 16px;
  padding: 20px 26px 14px; background: var(--gs-surface); border-bottom: 1px solid var(--gs-border);
}
.ld__modal-body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain;
  padding: 18px 26px 24px; display: grid; gap: 18px; overflow-wrap: anywhere;
}
.ld__modal-body > * { min-width: 0; }
.ld__modal-head-actions { display: flex; align-items: center; gap: 8px; flex: none; }
.ld__modal-kicker { font-size: 11.5px; font-weight: 700; letter-spacing: .18em; color: var(--gs-accent-strong); }
.ld__modal-head h2 { margin: 6px 0 0; font-size: 20px; font-weight: 700; color: var(--gs-fg); }
.ld__modal-head p { margin: 6px 0 0; font-size: 13px; color: var(--gs-fg-muted); line-height: 1.7; }
.ld__close { border: 0; background: transparent; font-size: 24px; line-height: 1; color: var(--gs-fg-subtle); cursor: pointer; padding: 2px 6px; }
.ld__modal-state, .ld__muted { margin: 0; font-size: 13px; color: var(--gs-fg-subtle); line-height: 1.7; }
.ld__modal-error { border: 1px solid var(--gs-warn); background: var(--gs-warn-bg); border-radius: 10px; padding: 12px 14px; display: grid; gap: 4px; }
.ld__modal-error h3 { margin: 0; font-size: 13.5px; color: var(--gs-warn); }
.ld__modal-error p { margin: 0; font-size: 12.5px; color: var(--gs-fg-2); line-height: 1.65; }
.ld__modal-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
.ld__block { display: grid; gap: 8px; }
.ld__block h3 { margin: 0; font-size: 13px; font-weight: 650; color: var(--gs-fg); }
.ld__block.is-warn { border: 1px solid var(--gs-warn-bg); background: var(--gs-warn-bg); border-radius: 10px; padding: 12px 14px; }
.ld__facts { margin: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.ld__facts div { display: grid; gap: 2px; padding: 8px 10px; background: var(--gs-divider); border-radius: 8px; font-size: 12.5px; }
.ld__facts dt { color: var(--gs-fg-subtle); font-size: 11.5px; }
.ld__facts dd { margin: 0; color: var(--gs-fg-2); text-align: left; overflow-wrap: anywhere; }
.ld__scores { margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; }
.ld__scores div { background: var(--gs-divider); border-radius: 9px; padding: 9px 11px; display: grid; gap: 3px; }
.ld__scores dt { font-size: 11.5px; color: var(--gs-fg-subtle); }
.ld__scores dd { margin: 0; font-size: 15px; font-weight: 700; color: var(--gs-fg); font-variant-numeric: tabular-nums; }
.ld__fit { margin: 0; font-size: 13.5px; font-weight: 600; color: var(--gs-fg); }
.ld__bullets { margin: 0; padding-left: 18px; display: grid; gap: 5px; font-size: 12.5px; color: var(--gs-fg-2); line-height: 1.65; }
.ld__bullets a { color: var(--gs-accent-strong); text-decoration: underline; word-break: break-all; }
.ld__contact { margin: 0; font-size: 12.5px; word-break: break-all; }
.ld__contact a { color: var(--gs-accent-strong); }
.ld__warn-text { color: var(--gs-warn); font-weight: 600; }
.ld__draft { border-top: 1px solid var(--gs-border); padding-top: 16px; display: grid; gap: 10px; }
.ld__draft-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.ld__draft-head h3 { margin: 0 0 4px; font-size: 13px; font-weight: 650; color: var(--gs-fg); }
.ld__draft-body { margin: 0; padding: 12px 14px; background: var(--gs-divider); border-radius: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; max-height: 280px; overflow: auto; }
.ld__modal-actions { display: flex; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
.ld__field { display: grid; gap: 6px; font-size: 12.5px; color: var(--gs-fg-2); }
.ld__field em { color: var(--gs-warn); font-style: normal; }
.ld__field select, .ld__field textarea {
  width: 100%; box-sizing: border-box; border: 1px solid var(--gs-border-strong); border-radius: 9px; background: var(--gs-surface);
  color: var(--gs-fg); padding: 9px 11px; font-size: 13px; font-family: inherit;
}
@media (max-width: 720px) {
  .ld__head { flex-direction: column; }
  .ld__overlay { padding: 10px; }
  .ld__modal { max-height: calc(100dvh - 20px); }
  .ld__modal-head { flex-direction: column; align-items: stretch; padding: 18px 18px 12px; }
  .ld__modal-body { padding: 16px 18px 20px; }
  .ld__modal-head-actions { width: 100%; justify-content: flex-end; }
  .ld__facts { grid-template-columns: minmax(0, 1fr); }
  .ld__draft-head { flex-direction: column; }
  .ld__modal-actions { flex-direction: column-reverse; }
  .ld__modal-actions .ld__action { width: 100%; }
}
</style>

.ld__evidence-row {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 8px;
  margin-bottom: 8px;
}

.ld__evidence-row select,
.ld__evidence-row input {
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--gs-border);
  border-radius: 8px;
  background: var(--gs-bg);
  color: var(--gs-fg);
}

@media (max-width: 720px) {
  .ld__evidence-row { grid-template-columns: 1fr; }
}
