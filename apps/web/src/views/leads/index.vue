<script lang="ts" setup>
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import {
  deriveStreamingFunnelProgress,
  glossaryStatus,
  mapRejectCodeToFeedbackReason,
  type StreamingProgressDto,
} from '@gain-saas/shared';
import { LayoutGrid, List, RotateCw, Search } from '@vben/icons';
import { preferences } from '@vben/preferences';

import { useElementSize } from '@vueuse/core';
import { Alert, Button, Checkbox, Input, Modal, Skeleton } from 'ant-design-vue';

import ErrorNotice from '#/components/error-notice.vue';
import StreamingProgressBoard from '#/components/gainos/StreamingProgressBoard.vue';
import GsBulkActionBar from '#/components/gainos/ui/gs-bulk-action-bar.vue';
import GsEmpty from '#/components/gainos/ui/gs-empty.vue';
import GsModal from '#/components/gainos/ui/gs-modal.vue';
import GsPage from '#/components/gainos/ui/gs-page.vue';
import GsSegmented from '#/components/gainos/ui/gs-segmented.vue';
import GsSelect from '#/components/gainos/ui/gs-select.vue';
import { $t } from '#/locales';
import { usePendingAction } from '#/composables/use-pending-action';
import { useWorkspaceAccess } from '#/composables/use-workspace-access';
import { feedback } from '#/feedback';
import { newAttemptId } from '#/utils/attempt-id';
import { copyText } from '#/utils/clipboard';

import {
  failureText,
  gainosApi,
  type Icp,
  type Lead,
  type LeadDecisionInput,
  type LeadQueueCounts,
  type OutreachBatchSummary,
  type PromoteQgoInput,
} from '#/api/gainos';

import LeadCard from './lead-card.vue';
import LeadCompactTable from './lead-compact-table.vue';
import LeadQuickDrawer from './lead-quick-drawer.vue';
import LeadReviewQueue from './lead-review-queue.vue';

defineOptions({ name: 'Leads' });

const JudgmentReviews = defineAsyncComponent(() => import('#/views/reviews/index.vue'));

const route = useRoute();
const router = useRouter();
const QUEUE_KEYS = ['needs_review', 'recommended', 'rejected', 'suppressed', 'sanctions_hold'] as const;

type LeadsView = 'list' | 'reviews';

function viewFromRoute(): LeadsView {
  const raw = route.query.view;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === 'reviews' ? 'reviews' : 'list';
}

const activeView = computed<LeadsView>({
  get: () => viewFromRoute(),
  set: (next) => {
    if (next === viewFromRoute()) return;
    const query = { ...route.query };
    if (next === 'reviews') {
      query.view = 'reviews';
    } else {
      delete query.view;
    }
    void router.replace({ path: '/leads', query });
  },
});

const viewOptions = computed(() => [
  { label: $t('gainosP0.leadsView.list'), value: 'list' },
  { label: $t('gainosP0.leadsView.reviews'), value: 'reviews' },
]);

type LeadsDisplayMode = 'card' | 'review' | 'table';
const displayMode = ref<LeadsDisplayMode>('review');
const contentRef = ref<HTMLElement | null>(null);
const { width: contentWidth } = useElementSize(contentRef);
const inlineReview = computed(() =>
  displayMode.value === 'review' && activeView.value === 'list' && contentWidth.value >= 860,
);

const previewLeadId = ref<null | string>(null);
const previewOpen = computed({
  get: () => Boolean(previewLeadId.value && previewLead.value),
  set: (value: boolean) => {
    if (!value) previewLeadId.value = null;
  },
});
const previewIndex = computed(() =>
  previewLeadId.value ? filteredLeads.value.findIndex((item) => item.id === previewLeadId.value) : -1,
);
const previewLead = computed<Lead | null>(() =>
  previewIndex.value >= 0 ? (filteredLeads.value[previewIndex.value] ?? null) : null,
);

function openPreview(lead: Lead): void {
  previewLeadId.value = lead.id;
}
function setDisplayMode(mode: LeadsDisplayMode): void {
  if (displayMode.value === mode) return;
  previewLeadId.value = null;
  displayMode.value = mode;
}
function previewPrev(): void {
  const idx = previewIndex.value;
  if (idx > 0) previewLeadId.value = filteredLeads.value[idx - 1]?.id ?? null;
}
function previewNext(): void {
  const idx = previewIndex.value;
  if (idx >= 0 && idx < filteredLeads.value.length - 1) {
    previewLeadId.value = filteredLeads.value[idx + 1]?.id ?? null;
  }
}

const leadsInitialized = ref(false);

const STATUS_KEYS = ['DISCOVERED', 'REVIEW', 'QUALIFIED', 'REJECTED', 'SUPPRESSED'] as const;

function queueFromRoute(): string | null {
  const raw = route.query.queue;
  const queue = Array.isArray(raw) ? raw[0] : raw;
  if (typeof queue !== 'string') return null;
  return (QUEUE_KEYS as readonly string[]).includes(queue) ? queue : null;
}

function queryTextFromRoute(): string {
  const raw = route.query.q;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : '';
}

function statusFromRoute(): string {
  const raw = route.query.status;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && (STATUS_KEYS as readonly string[]).includes(value) ? value : '';
}

const { isAdmin: accessIsAdmin, can: accessCan, ensureLoaded: ensureWorkspaceAccess } = useWorkspaceAccess();
const isAdmin = ref(false);
const canDraftOutreach = computed(() => isAdmin.value || accessIsAdmin.value || accessCan('outreach.draft'));

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
  'WRONG_COUNTRY',
  'DEAD_COMPANY',
  'BAD_CONTACT_PATH',
  'TOO_LARGE',
  'ALREADY_KNOWN',
  'NO_IMPORT_SIGNAL',
  'DUPLICATE',
  'OTHER',
] as const;
const ACCEPT_CODES = ['GOOD_FIT', 'WILL_FOLLOW_UP', 'OTHER'] as const;

const activeQueue = ref<string>(queueFromRoute() ?? 'needs_review');
const activeStatus = ref<string>(statusFromRoute());
const leads = ref<Lead[]>([]);
const searchQuery = ref(queryTextFromRoute());

const statusFilterOptions = computed(() => [
  { label: $t('gainosB4.leadsBulk.statusAll'), value: '' },
  { label: $t('gainosB4.leadsBulk.statusDiscovered'), value: 'DISCOVERED' },
  { label: $t('gainosB4.leadsBulk.statusReview'), value: 'REVIEW' },
  { label: $t('gainosB4.leadsBulk.statusQualified'), value: 'QUALIFIED' },
  { label: $t('gainosB4.leadsBulk.statusRejected'), value: 'REJECTED' },
  { label: $t('gainosB4.leadsBulk.statusSuppressed'), value: 'SUPPRESSED' },
]);

function syncFiltersToUrl(): void {
  if (activeView.value !== 'list') return;
  const nextQuery: Record<string, string> = {};
  for (const [k, v] of Object.entries(route.query)) {
    if (['icp', 'q', 'queue', 'status'].includes(k)) continue;
    const single = Array.isArray(v) ? v[0] : v;
    if (typeof single === 'string' && single) nextQuery[k] = single;
  }
  if (activeQueue.value && (activeQueue.value !== 'needs_review' || route.query.queue !== undefined)) {
    nextQuery.queue = activeQueue.value;
  }
  const trimmedQ = searchQuery.value.trim();
  if (trimmedQ) nextQuery.q = trimmedQ;
  if (activeStatus.value) nextQuery.status = activeStatus.value;
  if (activeIcpId.value && (route.query.icp !== undefined || icps.value.length > 1)) {
    nextQuery.icp = activeIcpId.value;
  }
  const currentComparable: Record<string, string> = {};
  for (const [k, v] of Object.entries(route.query)) {
    const single = Array.isArray(v) ? v[0] : v;
    if (typeof single === 'string' && single) currentComparable[k] = single;
  }
  if (JSON.stringify(currentComparable) !== JSON.stringify(nextQuery)) {
    void router.replace({ path: '/leads', query: nextQuery });
  }
}

const filteredLeads = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return leads.value;
  return leads.value.filter((lead) => {
    const haystack = [lead.company?.name, lead.company?.domain, lead.company?.country]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  });
});

watch([inlineReview, filteredLeads], ([inline, items], [wasInline]) => {
  if (inline) {
    if (!items.some((item) => item.id === previewLeadId.value)) {
      previewLeadId.value = items[0]?.id ?? null;
    }
  } else if (wasInline) {
    previewLeadId.value = null;
  }
});

watch(activeView, () => {
  previewLeadId.value = inlineReview.value ? filteredLeads.value[0]?.id ?? null : null;
});

// ── 批量选择与 GsBulkActionBar 操作 ───────────────────────────────────────
const selectedLeadIds = ref<Set<string>>(new Set());
const selectedLeads = computed(() =>
  filteredLeads.value.filter((lead) => selectedLeadIds.value.has(lead.id)),
);
const allPageSelected = computed(
  () =>
    filteredLeads.value.length > 0 &&
    filteredLeads.value.every((lead) => selectedLeadIds.value.has(lead.id)),
);
const somePageSelected = computed(
  () =>
    !allPageSelected.value &&
    filteredLeads.value.some((lead) => selectedLeadIds.value.has(lead.id)),
);

function isLeadSelected(id: string): boolean {
  return selectedLeadIds.value.has(id);
}

function toggleLeadSelection(id: string, checked: boolean): void {
  const next = new Set(selectedLeadIds.value);
  if (checked) next.add(id);
  else next.delete(id);
  selectedLeadIds.value = next;
}

function toggleSelectAllPage(checked: boolean): void {
  if (!checked) {
    selectedLeadIds.value = new Set();
    return;
  }
  selectedLeadIds.value = new Set(filteredLeads.value.map((lead) => lead.id));
}

function clearSelection(): void {
  selectedLeadIds.value = new Set();
}

const bulkBusy = ref(false);
const bulkRejectOpen = ref(false);
const bulkRejectCode = ref('');
const bulkRejectNote = ref('');
const bulkRejectError = ref('');

const bulkOutreachOpen = ref(false);
const bulkOutreachLoading = ref(false);
const bulkOutreachBatches = ref<OutreachBatchSummary[]>([]);
const bulkOutreachBatchId = ref('');
const bulkOutreachError = ref('');

const bulkActionableLeads = computed(() => selectedLeads.value.filter((lead) => canAct(lead)));

function openBulkReject(): void {
  if (bulkActionableLeads.value.length === 0) {
    feedback.message.info($t('gainosB4.leadsBulk.bulkNoActionable'));
    return;
  }
  bulkRejectCode.value = '';
  bulkRejectNote.value = '';
  bulkRejectError.value = '';
  bulkRejectOpen.value = true;
}

async function submitBulkReject(): Promise<void> {
  if (bulkBusy.value) return;
  if (!bulkRejectCode.value) {
    bulkRejectError.value = $t('gainos.leads.reasonRequired');
    return;
  }
  const targets = bulkActionableLeads.value;
  if (targets.length === 0) {
    bulkRejectOpen.value = false;
    return;
  }
  bulkBusy.value = true;
  bulkRejectError.value = '';
  const selectedReasonCode = bulkRejectCode.value;
  const noteTrimmed = bulkRejectNote.value.trim();
  const input: LeadDecisionInput = {
    reasonCode: selectedReasonCode,
    ...(noteTrimmed ? { reason: noteTrimmed } : {}),
  };
  let succeeded = 0;
  let failed = 0;
  try {
    for (const lead of targets) {
      try {
        await gainosApi.rejectLead(lead.id, input, newAttemptId());
        succeeded += 1;
        const targetIcpId = lead.icpId || activeIcpId.value;
        if (targetIcpId) {
          const mappedReason = mapRejectCodeToFeedbackReason(selectedReasonCode);
          await gainosApi
            .recordIcpFeedback(targetIcpId, {
              leadId: lead.id,
              companyId: lead.company?.id,
              domain: lead.company?.domain ?? undefined,
              companyName: lead.company?.name ?? undefined,
              industry: lead.company?.industry ?? undefined,
              outcome: 'rejected',
              ...(mappedReason ? { rejectionReason: mappedReason } : {}),
              ...(noteTrimmed ? { note: noteTrimmed } : {}),
            })
            .catch(() => undefined);
        }
      } catch {
        failed += 1;
      }
    }
    bulkRejectOpen.value = false;
    clearSelection();
    if (failed === 0) {
      feedback.message.success($t('gainosB4.leadsBulk.bulkDone', { succeeded }));
    } else {
      feedback.message.warning($t('gainosB4.leadsBulk.bulkPartial', { failed, succeeded }));
    }
    await load();
  } finally {
    bulkBusy.value = false;
  }
}

function confirmBulkAccept(): void {
  const targets = bulkActionableLeads.value;
  if (targets.length === 0) {
    feedback.message.info($t('gainosB4.leadsBulk.bulkNoActionable'));
    return;
  }
  feedback.confirm({
    title: $t('gainosB4.leadsBulk.bulkAcceptTitle'),
    content: $t('gainosB4.leadsBulk.bulkAcceptContent', {
      actionable: targets.length,
      total: selectedLeads.value.length,
    }),
    okText: $t('gainosB4.leadsBulk.bulkAcceptOk'),
    cancelText: $t('gainos.common.cancel'),
    onOk: async () => {
      bulkBusy.value = true;
      let succeeded = 0;
      let failed = 0;
      try {
        for (const lead of targets) {
          try {
            await gainosApi.acceptLead(lead.id, {}, newAttemptId());
            succeeded += 1;
          } catch {
            failed += 1;
          }
        }
        clearSelection();
        if (failed === 0) {
          feedback.message.success($t('gainosB4.leadsBulk.bulkDone', { succeeded }));
        } else {
          feedback.message.warning($t('gainosB4.leadsBulk.bulkPartial', { failed, succeeded }));
        }
        await load();
      } finally {
        bulkBusy.value = false;
      }
    },
  });
}

async function openBulkOutreach(): Promise<void> {
  if (selectedLeads.value.length === 0) return;
  bulkOutreachError.value = '';
  bulkOutreachBatchId.value = '';
  bulkOutreachOpen.value = true;
  bulkOutreachLoading.value = true;
  try {
    const rows = await gainosApi.outreachBatches();
    bulkOutreachBatches.value = (Array.isArray(rows) ? rows : []).filter((b) => b.status === 'DRAFT');
    if (bulkOutreachBatches.value[0]) {
      bulkOutreachBatchId.value = bulkOutreachBatches.value[0].id;
    }
  } catch (err) {
    bulkOutreachBatches.value = [];
    bulkOutreachError.value = failureText(err).title;
  } finally {
    bulkOutreachLoading.value = false;
  }
}

function goBulkOutreachPage(): void {
  const firstLead = selectedLeads.value[0];
  bulkOutreachOpen.value = false;
  void router.push({
    path: '/outreach',
    query: {
      tab: 'batches',
      ...(firstLead ? { lead: firstLead.id } : {}),
    },
  });
}

async function submitBulkOutreach(): Promise<void> {
  if (bulkBusy.value || !bulkOutreachBatchId.value || !canDraftOutreach.value) return;
  const targets = selectedLeads.value;
  const withEmail = targets.filter((lead) => Boolean(lead.channelSummary?.emails?.[0]));
  if (withEmail.length === 0) {
    bulkOutreachError.value = $t('gainosB4.leadsBulk.bulkOutreachNoEmail');
    return;
  }
  bulkBusy.value = true;
  bulkOutreachError.value = '';
  let added = 0;
  let skipped = targets.length - withEmail.length;
  try {
    for (const lead of withEmail) {
      const email = lead.channelSummary?.emails?.[0];
      if (!email) {
        skipped += 1;
        continue;
      }
      const companyName = lead.company?.name || $t('gainos.leads.unknownCompany');
      try {
        await gainosApi.addOutreachDraft(bulkOutreachBatchId.value, {
          contactRef: lead.id,
          recipientEmail: email,
          companyName,
          ...(lead.company?.country ? { countryCode: lead.company.country } : {}),
          subject: `B2B Supply Inquiry — ${companyName}`,
          body: `Hello ${companyName} team,\n\nWe would be glad to share product specifications and supply details for your review.\n\nBest regards,`,
        });
        added += 1;
      } catch {
        skipped += 1;
      }
    }
    bulkOutreachOpen.value = false;
    clearSelection();
    feedback.message.success($t('gainosB4.leadsBulk.bulkOutreachDone', { added, skipped }));
  } finally {
    bulkBusy.value = false;
  }
}

function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

function exportSelectedCsv(): void {
  if (!isAdmin.value || selectedLeads.value.length === 0) return;
  const header = ['Company', 'Domain', 'Country', 'Industry', 'Queue', 'Status', 'Score', 'Email', 'Phone'];
  const rows = selectedLeads.value.map((lead) => [
    lead.company?.name ?? '',
    lead.company?.domain ?? '',
    lead.company?.country ?? '',
    lead.company?.industry ?? '',
    lead.queue ?? '',
    lead.status ?? '',
    typeof lead.totalScore === 'number' ? Math.round(lead.totalScore) : '',
    lead.channelSummary?.emails?.[0] ?? '',
    lead.channelSummary?.phones?.[0] ?? '',
  ]);
  const csv = `\uFEFF${[header, ...rows].map((cols) => cols.map(csvCell).join(',')).join('\n')}\n`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `selected-leads-${activeQueue.value}.csv`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
  feedback.message.success(
    $t('gainosB4.leadsBulk.bulkExportDone', { count: selectedLeads.value.length }),
  );
}
const loading = ref(true);
const loadError = ref<{ title: string; next?: string } | null>(null);
const icps = ref<Icp[]>([]);
const activeIcpId = ref('');
const activeRunId = ref<string | null>(null);
const activeRunStreaming = ref<StreamingProgressDto | null>(null);
let streamingPollTimer: ReturnType<typeof setInterval> | null = null;

const liveStreamingProgress = computed(() =>
  activeRunStreaming.value
    ? deriveStreamingFunnelProgress({ streamingProgress: activeRunStreaming.value })
    : null,
);

function stopStreamingPoll(): void {
  if (streamingPollTimer) {
    clearInterval(streamingPollTimer);
    streamingPollTimer = null;
  }
}

async function loadActiveStreamingRun(): Promise<void> {
  const icpId = activeIcpId.value;
  if (!icpId) {
    activeRunId.value = null;
    activeRunStreaming.value = null;
    stopStreamingPoll();
    return;
  }
  try {
    const tasks = await gainosApi.acquisitionTasks(icpId);
    const runningRun = (Array.isArray(tasks) ? tasks : [])
      .flatMap((t) => t.runs ?? [])
      .find((r) => String(r.status ?? '').toUpperCase() === 'RUNNING' && Boolean(r.runId));
    if (!runningRun?.runId) {
      activeRunId.value = null;
      activeRunStreaming.value = null;
      stopStreamingPoll();
      return;
    }
    activeRunId.value = runningRun.runId;
    const sp = await gainosApi.streamingProgress(runningRun.runId);
    if (sp && typeof sp === 'object' && 'stages' in sp) {
      activeRunStreaming.value = sp;
    } else {
      activeRunStreaming.value = null;
    }
    if (activeRunStreaming.value && !['DONE', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(String(activeRunStreaming.value.runStatus ?? '').toUpperCase())) {
      if (!streamingPollTimer) {
        streamingPollTimer = setInterval(() => {
          void refreshStreamingAndLeads();
        }, 5000);
      }
    } else {
      stopStreamingPoll();
    }
  } catch {
    activeRunStreaming.value = null;
    stopStreamingPoll();
  }
}

async function refreshStreamingAndLeads(): Promise<void> {
  await Promise.all([loadActiveStreamingRun(), load()]);
}
const queueCounts = ref<LeadQueueCounts | null>(null);
const exportingCsv = ref(false);
// 分页：按队列总数逐步加载，不再静默截断（2026-11-09 组件审计三-03）。
const pageLimit = ref(50);

async function exportBattleCsv(): Promise<void> {
  if (!activeIcpId.value || !isAdmin.value || exportingCsv.value) return;
  exportingCsv.value = true;
  const scope: 'delivered' | 'reviewable' =
    activeQueue.value === 'needs_review' ? 'reviewable' : 'delivered';
  try {
    const { blob, filename, rows } = await gainosApi.exportBattleCsv({
      icpId: activeIcpId.value,
      scope,
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    feedback.message.success(
      rows !== null
        ? $t('gainos.leads.exportBattleCsvDoneCount', { count: rows })
        : $t('gainos.leads.exportBattleCsvDone'),
    );
  } catch (error) {
    feedback.message.error(failureText(error).title);
  } finally {
    exportingCsv.value = false;
  }
}

// 判定明细展开状态（卡片自己解析 C1–C5，页面只记住哪些卡是展开的）
const expandedIds = ref<Set<string>>(new Set());
function isExpanded(id: string): boolean {
  return expandedIds.value.has(id);
}
function toggleExpanded(id: string): void {
  const next = new Set(expandedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedIds.value = next;
}

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
    feedback.message.success($t('gainos.leads.promoteDone'));
    await router.push('/opportunities');
  } catch (error) {
    promoteError.value = failureText(error);
  } finally {
    promoteBusy.value = false;
  }
}

function openPackage(lead: Lead): void {
  void router.push({
    name: 'LeadDetail',
    params: { leadId: lead.id },
    ...(activeIcpId.value ? { state: { icpId: activeIcpId.value } } : {}),
  });
}
async function copyDomain(lead: Lead): Promise<void> {
  if (!lead.company?.domain) return;
  try {
    await copyText(lead.company.domain);
    feedback.message.success($t('gainos.leads.copiedDomain'));
  } catch {
    // 以前这里静默失败：用 http:// 内网地址打开时浏览器不给脚本写剪贴板，用户以为按钮坏了。
    feedback.message.error($t('gainos.common.copyFailed'));
  }
}

const modal = ref<'accept' | 'reject' | null>(null);
const target = ref<Lead | null>(null);
const reasonCode = ref('');
const reasonNote = ref('');
const actionError = ref<{ title: string; next?: string } | null>(null);
const { pending: submitting, run: runDecision } = usePendingAction();

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

/** 队列页签的选项（名称来自词表，计数来自队列统计）。 */
const queueOptions = computed(() =>
  QUEUES.value.map((queue) => ({
    count: queueCount(queue.key),
    label: queue.label,
    value: queue.key,
  })),
);

/** 裁决弹层开关（保留 modal/closeModal 语义，模板用 v-model:open）。 */
const decisionOpen = computed({
  get: () => modal.value !== null,
  set: (value: boolean) => {
    if (!value) closeModal();
  },
});

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
function basisLabel(basis?: string): string {
  const map: Record<string, string> = {
    fit_gate_preset: $t('gainos.leads.basis.preset'),
    score: $t('gainos.leads.basis.score'),
    human_accept: $t('gainos.leads.basis.accept'),
    human_reject: $t('gainos.leads.basis.reject'),
  };
  return (basis && map[basis]) || '';
}
function canAct(lead: Lead): boolean {
  return !['rejected', 'suppressed', 'sanctions_hold'].includes(lead.queue ?? '') &&
    !['QUALIFIED', 'REJECTED', 'SUPPRESSED'].includes(lead.status ?? '');
}

async function loadIcps(): Promise<void> {
  try {
    const data = await gainosApi.icps();
    icps.value = Array.isArray(data) ? data : [];
    const routeIcpRaw = Array.isArray(route.query.icp) ? route.query.icp[0] : route.query.icp;
    const routeIcp =
      typeof routeIcpRaw === 'string' && icps.value.some((icp) => icp.id === routeIcpRaw)
        ? routeIcpRaw
        : '';
    activeIcpId.value =
      routeIcp ||
      icps.value.find((icp) => icp.status === 'ACTIVE')?.id ||
      icps.value[0]?.id ||
      '';
  } catch {
    icps.value = [];
    activeIcpId.value = '';
  }
}

let leadLoadSeq = 0;
let countsIcpId = '';

async function loadQueueCounts(icpId: string, seq: number): Promise<void> {
  try {
    const data = await gainosApi.leadQueues(icpId);
    if (seq === leadLoadSeq && icpId === activeIcpId.value) {
      countsIcpId = icpId;
      queueCounts.value = (data as unknown as { data?: LeadQueueCounts })?.data ?? data;
    }
  } catch {
    if (seq === leadLoadSeq && icpId === activeIcpId.value) queueCounts.value = null;
  }
}

async function load(): Promise<void> {
  const seq = ++leadLoadSeq;
  const icpId = activeIcpId.value;
  const queue = activeQueue.value;
  const status = activeStatus.value;
  const isCurrent = () =>
    seq === leadLoadSeq && icpId === activeIcpId.value &&
    queue === activeQueue.value && status === activeStatus.value;
  if (countsIcpId !== icpId) queueCounts.value = null;
  if (!icpId) {
    leads.value = [];
    queueCounts.value = null;
    loading.value = false;
    return;
  }
  loading.value = true;
  loadError.value = null;
  void loadQueueCounts(icpId, seq);
  try {
    const data = await gainosApi.leads({
      icpId,
      queue,
      ...(status ? { status } : {}),
      limit: pageLimit.value,
    });
    if (!isCurrent()) return;
    leads.value = Array.isArray(data) ? data : ((data as { data?: Lead[] })?.data ?? []);
    // 清理已不在当前结果集中的勾选项
    const validIds = new Set(leads.value.map((lead) => lead.id));
    selectedLeadIds.value = new Set([...selectedLeadIds.value].filter((id) => validIds.has(id)));
  } catch (error) {
    if (!isCurrent()) return;
    loadError.value = failureText(error);
    leads.value = [];
  } finally {
    if (isCurrent()) loading.value = false;
  }
}

function openAccept(lead: Lead): void {
  if (submitting.value) return;
  target.value = lead;
  modal.value = 'accept';
  reasonCode.value = '';
  reasonNote.value = '';
  actionError.value = null;
}
function openReject(lead: Lead): void {
  if (submitting.value) return;
  target.value = lead;
  modal.value = 'reject';
  reasonCode.value = '';
  reasonNote.value = '';
  actionError.value = null;
}
function closeModal(): void {
  if (submitting.value) return;
  modal.value = null;
  target.value = null;
  reasonCode.value = '';
  reasonNote.value = '';
  actionError.value = null;
}

async function submitDecision(): Promise<void> {
  if (!target.value || !modal.value || submitting.value) return;
  if (modal.value === 'reject' && !reasonCode.value) {
    actionError.value = { title: $t('gainos.leads.reasonRequired'), next: $t('gainos.leads.rejectDesc') };
    return;
  }
  actionError.value = null;
  const lead = target.value;
  const leadId = lead.id;
  const targetIcpId = lead.icpId || activeIcpId.value;
  const kind = modal.value;
  const selectedReasonCode = reasonCode.value;
  const noteTrimmed = reasonNote.value.trim();
  const input: LeadDecisionInput = {
    ...(selectedReasonCode ? { reasonCode: selectedReasonCode } : {}),
    ...(noteTrimmed ? { reason: noteTrimmed } : {}),
  };
  try {
    // 幂等键由 usePendingAction 管理：双击/失败重试沿用同键，服务端按幂等重放。
    await runDecision(async (idempotencyKey) => {
      if (kind === 'accept') {
        await gainosApi.acceptLead(leadId, input, idempotencyKey);
        feedback.message.success($t('gainos.leads.acceptedNotice'));
      } else {
        await gainosApi.rejectLead(leadId, input, idempotencyKey);
        let synced = false;
        if (targetIcpId) {
          const mappedReason = mapRejectCodeToFeedbackReason(selectedReasonCode);
          await gainosApi
            .recordIcpFeedback(targetIcpId, {
              leadId,
              companyId: lead.company?.id,
              domain: lead.company?.domain ?? undefined,
              companyName: lead.company?.name ?? undefined,
              industry: lead.company?.industry ?? undefined,
              outcome: 'rejected',
              ...(mappedReason ? { rejectionReason: mappedReason } : {}),
              ...(noteTrimmed ? { note: noteTrimmed } : {}),
            })
            .then(() => {
              synced = true;
            })
            .catch(() => undefined);
        }
        feedback.message.success(
          synced ? $t('gainos.leads.feedbackSyncedNotice') : $t('gainos.leads.rejectedNotice'),
        );
      }
    });
    closeModal();
    await load();
  } catch (error) {
    actionError.value = failureText(error);
  }
}

async function initLeadsView(): Promise<void> {
  if (leadsInitialized.value) return;
  leadsInitialized.value = true;
  await loadIcps();
  await Promise.all([load(), loadActiveStreamingRun()]);
}

watch(activeQueue, () => {
  if (!leadsInitialized.value) return;
  pageLimit.value = 50;
  clearSelection();
  syncFiltersToUrl();
  void load();
});
watch(activeStatus, () => {
  if (!leadsInitialized.value) return;
  pageLimit.value = 50;
  clearSelection();
  syncFiltersToUrl();
  void load();
});
watch(searchQuery, () => {
  if (!leadsInitialized.value) return;
  syncFiltersToUrl();
});
watch(activeIcpId, () => {
  if (!leadsInitialized.value) return;
  clearSelection();
  syncFiltersToUrl();
});
watch(activeView, (next) => {
  if (next === 'list') {
    void initLeadsView();
  }
});
watch(
  () => [route.query.queue, route.query.q, route.query.status],
  () => {
    const queue = queueFromRoute();
    if (queue && queue !== activeQueue.value) activeQueue.value = queue;
    const q = queryTextFromRoute();
    if (q !== searchQuery.value) searchQuery.value = q;
    const st = statusFromRoute();
    if (st !== activeStatus.value) activeStatus.value = st;
  },
);
function onEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  if (modal.value) {
    closeModal();
  }
}
onMounted(async () => {
  window.addEventListener('keydown', onEscape);
  try {
    const [session] = await Promise.all([
      gainosApi.session(),
      ensureWorkspaceAccess(),
    ]);
    isAdmin.value = session.workspace?.role === 'admin' || accessIsAdmin.value;
  } catch {
    isAdmin.value = accessIsAdmin.value;
  }
  const rawQueue = Array.isArray(route.query.queue) ? route.query.queue[0] : route.query.queue;
  if (isAdmin.value && rawQueue === 'sanctions_hold') {
    activeQueue.value = 'sanctions_hold';
  }
  if (activeView.value === 'list') {
    await initLeadsView();
  }
});
onUnmounted(() => {
  window.removeEventListener('keydown', onEscape);
  stopStreamingPoll();
});
</script>

<template>
  <!-- grid-cols-1 + @container：约束列宽（子内容再宽也不会把整列撑出屏幕），并作为容器查询的参照——
       表格与卡片按内容区实际宽度分级，而不是按视口。 -->
  <div ref="contentRef" class="mx-auto grid w-full max-w-[var(--gs-page-max)] grid-cols-1 gap-3 px-[var(--gs-page-pad)] pb-12 @container">
    <GsPage art="leads" :subtitle="$t('gainos.leads.subtitle')" :title="$t('gainos.leads.title')">
      <template #actions>
        <div class="leads-head-actions">
          <div class="leads-view-seg" data-gs="leads-view-switch">
            <GsSegmented
              v-model="activeView"
              :ariaLabel="$t('gainosP0.leadsView.ariaLabel')"
              :options="viewOptions"
            />
          </div>
          <template v-if="activeView === 'list' && activeIcpId">
            <Button
              v-if="isAdmin"
              :loading="exportingCsv"
              :title="$t('gainos.leads.exportBattleCsvHint')"
              data-gs="export-battle-csv"
              size="small"
              @click="exportBattleCsv"
            >
              {{ exportingCsv ? $t('gainos.leads.exportingBattleCsv') : $t('gainos.leads.exportBattleCsv') }}
            </Button>
            <Button data-gs="qgo-entry" size="small" @click="$router.push('/opportunities')">
              {{ $t('gainos.leads.qgoEntry') }}
            </Button>
            <Button
              :aria-label="$t('gainos.common.refresh')"
              :loading="loading"
              :title="$t('gainos.common.refresh')"
              data-gs="refresh"
              size="small"
              @click="load"
            >
              <template v-if="!loading" #icon>
                <RotateCw :size="14" />
              </template>
            </Button>
          </template>
        </div>
      </template>
    </GsPage>

    <div v-if="activeView === 'reviews'" data-gs="leads-reviews-panel">
      <JudgmentReviews embedded />
    </div>

    <template v-else>
    <GsEmpty
      v-if="!loading && !activeIcpId"
      :description="$t('gainos.leads.noIcpDesc')"
      :title="$t('gainos.leads.noIcpTitle')"
    >
      <template #actions>
        <Button type="primary" @click="$router.push('/find-buyers')">
          {{ $t('gainos.leads.goFindBuyers') }}
        </Button>
        <Button @click="$router.push('/companies')">
          {{ $t('gainos.companies.title') }}
        </Button>
        <Button @click="$router.push('/tasks')">
          {{ $t('gainos.tasks.title') }}
        </Button>
      </template>
    </GsEmpty>

    <template v-if="activeIcpId">
      <!-- 单行 44px 极轻细线工具栏（无孤悬圆角白块，压缩纵向壳层还空间给数据列表） -->
      <div class="leads-bar" data-gs="queue-toolbar">
        <div class="leads-bar__queues">
          <GsSegmented
            v-model="activeQueue"
            :ariaLabel="$t('gainos.leads.statusLabel')"
            data-gs="queue-switch"
            :options="queueOptions"
          />
        </div>
        <div class="leads-bar__filters">
          <div
            v-if="icps.length"
            class="w-[172px] @max-[640px]:min-w-0 @max-[640px]:flex-1 @max-[640px]:basis-[calc(50%-4px)]"
            data-gs="icp-filter"
          >
            <GsSelect
              v-model="activeIcpId"
              :aria-label="$t('gainos.leads.icpFilter')"
              :ariaLabel="$t('gainos.leads.icpFilter')"
              :options="icps.map((icp) => ({ label: icp.name, value: icp.id }))"
              class="w-full"
              size="small"
              @change="refreshStreamingAndLeads()"
            />
          </div>
          <div
            class="w-[116px] @max-[640px]:min-w-0 @max-[640px]:flex-1 @max-[640px]:basis-[calc(50%-4px)]"
            data-gs="lead-status-filter"
          >
            <GsSelect
              v-model="activeStatus"
              :ariaLabel="$t('gainosB4.leadsBulk.statusFilterLabel')"
              :options="statusFilterOptions"
              class="w-full"
              size="small"
            />
          </div>
          <div
            class="w-[184px] @max-[640px]:min-w-0 @max-[640px]:flex-1 @max-[640px]:basis-[calc(60%-4px)]"
            data-gs="lead-search"
          >
            <Input
              v-model:value="searchQuery"
              :aria-label="$t('gainos.companies.searchPlaceholder')"
              :placeholder="$t('gainos.companies.searchPlaceholder')"
              allow-clear
              size="small"
              type="search"
            >
              <template #prefix>
                <Search :size="13" />
              </template>
            </Input>
          </div>
          <div
            :aria-label="$t('gainosUi2.leads.viewSwitchAria')"
            class="leads-mode"
            data-gs="leads-display-mode"
            role="group"
          >
            <button
              :aria-pressed="displayMode === 'review'"
              :class="{ 'is-active': displayMode === 'review' }"
              class="leads-mode__btn"
              data-gs="leads-display-review"
              type="button"
              @click="setDisplayMode('review')"
            >
              <span>{{ $t('gainosUi2.leads.viewReview') }}</span>
            </button>
            <button
              :aria-pressed="displayMode === 'table'"
              :class="{ 'is-active': displayMode === 'table' }"
              class="leads-mode__btn"
              data-gs="leads-display-table"
              type="button"
              @click="setDisplayMode('table')"
            >
              <List :size="13" />
              <span>{{ $t('gainosUi2.leads.viewTable') }}</span>
            </button>
            <button
              :aria-pressed="displayMode === 'card'"
              :class="{ 'is-active': displayMode === 'card' }"
              class="leads-mode__btn"
              data-gs="leads-display-card"
              type="button"
              @click="setDisplayMode('card')"
            >
              <LayoutGrid :size="13" />
              <span>{{ $t('gainosUi2.leads.viewCard') }}</span>
            </button>
          </div>
        </div>
      </div>

      <StreamingProgressBoard
        v-if="liveStreamingProgress && liveStreamingProgress.isRunning"
        :progress="liveStreamingProgress"
        :show-leads-action="false"
        compact
        @refresh="refreshStreamingAndLeads"
      />

      <Alert
        v-if="activeQueue !== 'sanctions_hold' && (queueCounts?.sanctions_hold ?? 0) > 0"
        :message="$t('gainos.leads.sanctionsHoldCount', { count: queueCounts?.sanctions_hold })"
        :type="isAdmin ? 'warning' : 'info'"
        data-gs="sanctions-banner"
        show-icon
      >
        <template #action>
          <Button
            v-if="isAdmin"
            size="small"
            type="link"
            @click="openSanctionsQueue"
          >
            {{ $t('gainos.leads.queueSanctions') }}
          </Button>
          <span v-else class="text-xs">{{ $t('gainos.leads.sanctionsAdminOnly') }}</span>
        </template>
      </Alert>

      <div v-if="loadError" class="grid gap-3" data-gs="load-error">
        <ErrorNotice :next="loadError.next" :title="loadError.title" />
        <Button class="justify-self-start" @click="load">
          {{ $t('gainos.common.retry') }}
        </Button>
      </div>

      <Skeleton v-else-if="loading" active :paragraph="{ rows: 6 }" />

      <GsEmpty
        v-else-if="leads.length === 0"
        :description="$t('gainos.leads.emptyDesc')"
        :title="$t('gainos.leads.emptyTitle')"
      >
        <template #actions>
          <Button type="primary" @click="$router.push('/find-buyers')">
            {{ $t('gainos.leads.emptyCta') }}
          </Button>
          <Button @click="$router.push('/companies')">
            {{ $t('gainos.companies.title') }}
          </Button>
          <Button @click="$router.push('/tasks')">
            {{ $t('gainos.tasks.title') }}
          </Button>
        </template>
      </GsEmpty>

      <template v-else>
        <p v-if="filteredLeads.length === 0" class="m-0 py-6 text-center text-[13px] text-[var(--gs-fg-muted)]">
          {{ $t('gainos.companies.noMatch') }}
        </p>

        <div
          v-else
          :class="{ 'leads-results--inline': inlineReview }"
          :data-gs="displayMode === 'review' ? 'leads-review-workbench' : undefined"
          class="leads-results"
        >
        <LeadReviewQueue
          v-if="displayMode === 'review'"
          :active-id="previewLeadId"
          :all-selected="allPageSelected"
          :leads="filteredLeads"
          :selected-ids="selectedLeadIds"
          :some-selected="somePageSelected"
          @preview="openPreview"
          @select="toggleLeadSelection"
          @select-all="toggleSelectAllPage"
        />

        <LeadCompactTable
          v-else-if="displayMode === 'table'"
          :active-lead-id="previewLeadId"
          :all-selected="allPageSelected"
          :can-act="canAct"
          :leads="filteredLeads"
          :selected-ids="selectedLeadIds"
          :some-selected="somePageSelected"
          @accept="openAccept"
          @package="openPackage"
          @preview="openPreview"
          @promote="openPromote"
          @reject="openReject"
          @select="toggleLeadSelection"
          @select-all="toggleSelectAllPage"
        />

        <!-- 卡片视图（按需切换，保留展开五维详解与完整触达通道条） -->
        <template v-else>
          <div
            class="flex items-center justify-between px-1"
            data-gs="leads-selection-bar"
          >
            <Checkbox
              :checked="allPageSelected"
              :indeterminate="somePageSelected"
              data-gs="leads-select-all"
              @change="(e: { target?: { checked?: boolean } }) => toggleSelectAllPage(Boolean(e?.target?.checked))"
            >
              <span class="text-xs text-[var(--gs-fg-muted)]">
                {{ $t('gainosB4.leadsBulk.selectAllPage') }}
              </span>
            </Checkbox>
            <span v-if="selectedLeads.length > 0" class="text-xs text-[var(--gs-fg-muted)]">
              {{ $t('gainosB4.leadsBulk.selectedSummary', { count: selectedLeads.length }) }}
            </span>
          </div>

          <LeadCard
            v-for="lead in filteredLeads"
            :key="lead.id"
            :basis-label="basisLabel(lead.queueBasis)"
            :can-act="canAct(lead)"
            :expanded="isExpanded(lead.id)"
            :lead="lead"
            :selectable="true"
            :selected="isLeadSelected(lead.id)"
            @accept="openAccept(lead)"
            @copy="copyDomain(lead)"
            @package="openPackage(lead)"
            @promote="openPromote(lead)"
            @reject="openReject(lead)"
            @select="(checked) => toggleLeadSelection(lead.id, checked)"
            @toggle="toggleExpanded(lead.id)"
          />
        </template>

        <LeadQuickDrawer
          v-model:open="previewOpen"
          :can-act="previewLead ? canAct(previewLead) : false"
          :current-index="previewIndex"
          :inline="inlineReview"
          :lead="previewLead"
          :total-count="filteredLeads.length"
          @accept="openAccept"
          @next="previewNext"
          @package="openPackage"
          @prev="previewPrev"
          @promote="openPromote"
          @reject="openReject"
        />
        </div>

        <!-- 底部批量操作栏：抬高 --gs-flow-bar-h 与底部主链路浮窗零遮挡 -->
        <GsBulkActionBar
          :clear-label="$t('gainosB4.leadsBulk.clearSelection')"
          :selected-count="selectedLeads.length"
          :selected-label="$t('gainosB4.leadsBulk.selectedSummary', { count: selectedLeads.length })"
          :style="{ bottom: 'calc(12px + var(--gs-flow-bar-h, 0px))' }"
          :total-count="filteredLeads.length"
          @clear="clearSelection"
        >
          <template #actions>
            <Button
              :disabled="bulkBusy || bulkActionableLeads.length === 0"
              danger
              data-gs="bulk-reject"
              size="small"
              @click="openBulkReject"
            >
              {{ $t('gainosB4.leadsBulk.bulkReject') }}
            </Button>
            <Button
              :disabled="bulkBusy"
              data-gs="bulk-outreach"
              size="small"
              @click="openBulkOutreach"
            >
              {{ $t('gainosB4.leadsBulk.bulkOutreach') }}
            </Button>
            <Button
              :disabled="bulkBusy || bulkActionableLeads.length === 0"
              data-gs="bulk-accept"
              size="small"
              type="primary"
              @click="confirmBulkAccept"
            >
              {{ $t('gainosB4.leadsBulk.bulkAccept') }}
            </Button>
            <Button
              v-if="isAdmin"
              :disabled="bulkBusy"
              data-gs="bulk-export"
              size="small"
              @click="exportSelectedCsv"
            >
              {{ $t('gainosB4.leadsBulk.bulkExport') }}
            </Button>
          </template>
        </GsBulkActionBar>

        <div v-if="hasMoreLeads" class="flex items-center justify-between" data-gs="load-more">
          <span class="text-xs text-[var(--gs-fg-subtle)]">
            {{ $t('gainos.leads.showingCount', { shown: leads.length, total: totalForQueue }) }}
          </span>
          <Button @click="loadMore">{{ $t('gainos.leads.loadMore') }}</Button>
        </div>
      </template>
    </template>
    </template>

    <!-- 裁决弹层 -->
    <Modal
      v-model:open="decisionOpen"
      :cancel-button-props="{ disabled: submitting }"
      :closable="!submitting"
      :confirm-loading="submitting"
      :keyboard="!submitting"
      :mask-closable="!submitting"
      :ok-button-props="{ danger: modal === 'reject' }"
      :ok-text="confirmLabel"
      :title="modalTitle"
      :width="560"
      data-gs="decision-modal"
      @cancel="closeModal"
      @ok="submitDecision"
    >
      <p class="mt-0 text-[13px] text-[var(--gs-fg-muted)]">{{ modalDesc }}</p>
      <div v-if="actionError" class="mb-3">
        <ErrorNotice :next="actionError.next" :title="actionError.title" />
      </div>
      <div class="grid gap-3">
        <label class="grid gap-1.5 text-xs font-medium text-[var(--gs-fg-2)]">
          <span>{{ $t('gainos.leads.reasonCode') }}<em v-if="modal === 'reject'"> *</em></span>
          <GsSelect
            v-model="reasonCode"
            :ariaLabel="$t('gainos.leads.reasonCode')"
            :options="reasonOptions.map((option) => ({ label: option.label, value: option.code }))"
            :placeholder="modal === 'reject' ? $t('gainos.leads.reasonSelect') : $t('gainos.leads.reasonOptional')"
            allow-clear
          />
        </label>
        <label class="grid gap-1.5 text-xs font-medium text-[var(--gs-fg-2)]">
          <span>{{ $t('gainos.leads.reasonNote') }}</span>
          <Input.TextArea
            v-model:value="reasonNote"
            :placeholder="$t('gainos.leads.reasonPlaceholder')"
            :rows="3"
          />
        </label>
      </div>
    </Modal>

    <!-- M2 步 10：提升为商机（QGO） -->
    <Modal
      v-model:open="promoteOpen"
      :confirm-loading="promoteBusy"
      :ok-button-props="{ disabled: promoteBusy || !promoteNextStep.trim() }"
      :ok-text="$t('gainos.leads.promoteSubmit')"
      :title="$t('gainos.leads.promoteTitle')"
      :width="680"
      data-gs="promote-modal"
      @ok="submitPromote"
    >
      <p class="mt-0 text-[13px] text-[var(--gs-fg-muted)]">
        {{ promoteTarget?.company?.name || $t('gainos.leads.unknownCompany') }}
      </p>
      <div v-if="promoteError" class="mb-3">
        <ErrorNotice
          :code="promoteError.code"
          :next="promoteError.next"
          :title="promoteError.title"
          :why="promoteError.why"
        />
      </div>
      <div class="grid gap-3">
        <div class="grid gap-2">
          <span class="text-xs font-medium text-[var(--gs-fg-2)]">{{ $t('gainos.leads.promoteEvidence') }}</span>
          <div
            v-for="(row, i) in promoteEvidence"
            :key="i"
            class="flex flex-wrap items-center gap-2"
          >
            <GsSelect
              v-model="row.type"
              :ariaLabel="$t('gainos.leads.promoteEvidenceType')"
              :options="[
                'customer_reply',
                'purchase_page',
                'tender_hit',
                'customs_signal',
                'other',
              ].map((type) => ({ label: $t(`gainos.leads.evidenceType.${type}`), value: type }))"
              class="w-[150px]"
            />
            <Input
              v-model:value="row.url"
              :placeholder="$t('gainos.leads.promoteUrlHint')"
              class="min-w-[200px] flex-1"
              type="url"
            />
            <Input
              v-model:value="row.support"
              :maxlength="500"
              :placeholder="$t('gainos.leads.promoteSupportHint')"
              class="min-w-[200px] flex-1"
            />
            <Button
              :disabled="promoteEvidence.length <= 1"
              @click="removeEvidenceRow(i)"
            >
              ×
            </Button>
          </div>
          <Button class="justify-self-start" type="dashed" @click="addEvidenceRow">
            {{ $t('gainos.leads.addEvidence') }}
          </Button>
        </div>
        <label class="grid gap-1.5 text-xs font-medium text-[var(--gs-fg-2)]">
          <span>{{ $t('gainos.leads.promoteNextStep') }}</span>
          <Input.TextArea
            v-model:value="promoteNextStep"
            :maxlength="500"
            :placeholder="$t('gainos.leads.promoteNextStepHint')"
            :rows="2"
          />
        </label>
      </div>
    </Modal>

    <!-- 批量排除弹层 -->
    <GsModal
      v-model:open="bulkRejectOpen"
      :cancel-text="$t('gainos.common.cancel')"
      :confirm-loading="bulkBusy"
      :ok-text="$t('gainosB4.leadsBulk.bulkRejectOk')"
      :subtitle="$t('gainosB4.leadsBulk.bulkRejectSubtitle', { actionable: bulkActionableLeads.length })"
      :title="$t('gainosB4.leadsBulk.bulkRejectTitle')"
      danger
      size="md"
      @ok="submitBulkReject"
    >
      <div class="grid gap-3" data-gs="bulk-reject-modal">
        <p v-if="bulkRejectError" class="m-0 text-xs text-[var(--gs-danger-fg)]" role="alert">
          {{ bulkRejectError }}
        </p>
        <label class="grid gap-1.5 text-xs font-medium text-[var(--gs-fg-2)]" data-gs="bulk-reject-reason">
          <span>{{ $t('gainos.leads.reasonCode') }} *</span>
          <GsSelect
            v-model="bulkRejectCode"
            :ariaLabel="$t('gainos.leads.reasonCode')"
            :options="REJECT_CODES.map((code) => ({ label: $t(`gainos.leads.reason.${code}`), value: code }))"
            :placeholder="$t('gainos.leads.reasonSelect')"
          />
        </label>
        <label class="grid gap-1.5 text-xs font-medium text-[var(--gs-fg-2)]">
          <span>{{ $t('gainos.leads.reasonNote') }}</span>
          <Input.TextArea
            v-model:value="bulkRejectNote"
            :maxlength="500"
            :placeholder="$t('gainos.leads.reasonPlaceholder')"
            :rows="2"
            data-gs="bulk-reject-note"
          />
        </label>
      </div>
    </GsModal>

    <!-- 批量加入外发批次弹层 -->
    <GsModal
      v-model:open="bulkOutreachOpen"
      :cancel-text="$t('gainos.common.cancel')"
      :confirm-loading="bulkBusy"
      :ok-text="$t('gainosB4.leadsBulk.bulkOutreachSubmit')"
      :subtitle="$t('gainosB4.leadsBulk.bulkOutreachSubtitle')"
      :title="$t('gainosB4.leadsBulk.bulkOutreachTitle')"
      size="md"
      @ok="submitBulkOutreach"
    >
      <div class="grid gap-3" data-gs="bulk-outreach-modal">
        <p v-if="bulkOutreachError" class="m-0 text-xs text-[var(--gs-danger-fg)]" role="alert">
          {{ bulkOutreachError }}
        </p>
        <p v-if="bulkOutreachLoading" class="m-0 text-xs text-[var(--gs-fg-muted)]">
          {{ $t('gainos.common.loading') }}
        </p>
        <template v-else-if="!canDraftOutreach">
          <p class="m-0 text-xs text-[var(--gs-fg-muted)]">
            {{ $t('gainosB4.leadsBulk.bulkOutreachReadonly') }}
          </p>
        </template>
        <template v-else-if="bulkOutreachBatches.length === 0">
          <p class="m-0 text-xs text-[var(--gs-fg-muted)]">
            {{ $t('gainosB4.leadsBulk.bulkOutreachNoBatch') }}
          </p>
        </template>
        <label v-else class="grid gap-1.5 text-xs font-medium text-[var(--gs-fg-2)]" data-gs="bulk-outreach-batch-select">
          <span>{{ $t('gainosB4.leadsBulk.bulkOutreachBatchLabel') }}</span>
          <GsSelect
            v-model="bulkOutreachBatchId"
            :ariaLabel="$t('gainosB4.leadsBulk.bulkOutreachBatchLabel')"
            :options="bulkOutreachBatches.map((b) => ({ label: b.name, value: b.id }))"
            :placeholder="$t('gainosB4.leadsBulk.bulkOutreachBatchPlaceholder')"
          />
        </label>
      </div>
      <template #footer>
        <Button @click="bulkOutreachOpen = false">{{ $t('gainos.common.cancel') }}</Button>
        <Button data-gs="bulk-outreach-open-page" @click="goBulkOutreachPage">
          {{ $t('gainosB4.leadsBulk.bulkOutreachOpenPage') }}
        </Button>
        <Button
          v-if="canDraftOutreach && bulkOutreachBatches.length > 0"
          :disabled="!bulkOutreachBatchId || bulkBusy"
          :loading="bulkBusy"
          data-gs="bulk-outreach-confirm"
          type="primary"
          @click="submitBulkOutreach"
        >
          {{ $t('gainosB4.leadsBulk.bulkOutreachSubmit') }}
        </Button>
      </template>
    </GsModal>
  </div>
</template>

<style scoped>
.leads-results {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}

.leads-results--inline {
  grid-template-columns: minmax(250px, 29%) minmax(0, 1fr);
}

.leads-head-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.leads-view-seg {
  display: inline-flex;
  padding: 2px;
  border: 1px solid var(--gs-border);
  border-radius: 8px;
  background: var(--gs-surface-2);
}

.leads-view-seg :deep(.gs-segmented__item) {
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  font-size: 12.5px;
}

.leads-view-seg :deep(.gs-segmented__item.is-active) {
  background: var(--gs-surface);
  color: var(--gs-fg);
  box-shadow: var(--gs-shadow-xs);
}

.leads-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  min-height: 44px;
  padding: 4px 0 8px;
  border-bottom: 1px solid var(--gs-border);
}

.leads-bar__queues {
  display: flex;
  align-items: center;
  min-width: 0;
}

.leads-bar__queues :deep(.gs-segmented__item) {
  height: 32px;
  padding: 0 10px;
  font-size: 12.5px;
}

.leads-bar__filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

.leads-mode {
  display: inline-flex;
  align-items: center;
  padding: 2px;
  border: 1px solid var(--gs-border);
  border-radius: 8px;
  background: var(--gs-surface-2);
}

.leads-mode__btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--gs-fg-muted);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color 0.12s ease,
    color 0.12s ease;
}

.leads-mode__btn:hover {
  color: var(--gs-fg);
}

.leads-mode__btn.is-active {
  background: var(--gs-surface);
  color: var(--gs-fg);
  box-shadow: var(--gs-shadow-xs);
}

@container (max-width: 640px) {
  .leads-bar__filters {
    margin-left: 0;
    width: 100%;
  }
}
</style>
