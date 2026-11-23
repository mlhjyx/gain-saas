<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { glossaryStatus } from '@gain-saas/shared';
import { preferences } from '@vben/preferences';

import {
  Alert,
  Button,
  Input,
  Modal,
  RadioButton,
  RadioGroup,
  Skeleton,
  Space,
  Steps,
} from 'ant-design-vue';

import ErrorNotice from '#/components/error-notice.vue';
import GsCard from '#/components/gainos/ui/gs-card.vue';
import GsEmpty from '#/components/gainos/ui/gs-empty.vue';
import GsPage from '#/components/gainos/ui/gs-page.vue';
import GsSelect from '#/components/gainos/ui/gs-select.vue';
import GsTag from '#/components/gainos/ui/gs-tag.vue';
import GsToolbar from '#/components/gainos/ui/gs-toolbar.vue';
import { $t } from '#/locales';
import { usePendingAction } from '#/composables/use-pending-action';
import { feedback } from '#/feedback';

import {
  failureText,
  gainosApi,
  type Icp,
  type Lead,
  type LeadDecisionInput,
  type LeadQueueCounts,
  type PromoteQgoInput,
} from '#/api/gainos';

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

const activeQueue = ref<string>(queueFromRoute() ?? 'needs_review');
const leads = ref<Lead[]>([]);
const searchQuery = ref('');
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
const loading = ref(true);
const loadError = ref<{ title: string; next?: string } | null>(null);
const icps = ref<Icp[]>([]);
const activeIcpId = ref('');
const queueCounts = ref<LeadQueueCounts | null>(null);
// 分页：按队列总数逐步加载，不再静默截断（2026-11-09 组件审计三-03）。
const pageLimit = ref(50);

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

function toneOf(tone?: string): 'danger' | 'info' | 'neutral' | 'success' | 'warning' {
  if (tone === 'processing') return 'info';
  if (tone === 'success' || tone === 'warning' || tone === 'danger') return tone;
  return 'neutral';
}

function queueMeta(key?: string) {
  return QUEUES.value.find((queue) => queue.key === key) ?? QUEUES.value[0]!;
}
const queueOptions = computed(() =>
  QUEUES.value.map((queue) => {
    const count = queueCount(queue.key);
    return {
      count,
      desc: queue.desc,
      key: queue.key,
      label: queue.label,
      tone: queue.tone,
    };
  }),
);

/** 裁决弹层开关（保留 modal/closeModal 语义，模板用 v-model:open）。 */
const decisionOpen = computed({
  get: () => modal.value !== null,
  set: (value: boolean) => {
    if (!value) closeModal();
  },
});

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
}

async function submitDecision(): Promise<void> {
  if (!target.value || !modal.value) return;
  if (modal.value === 'reject' && !reasonCode.value) {
    actionError.value = { title: $t('gainos.leads.reasonRequired'), next: $t('gainos.leads.rejectDesc') };
    return;
  }
  actionError.value = null;
  const leadId = target.value.id;
  const kind = modal.value;
  const input: LeadDecisionInput = {
    ...(reasonCode.value ? { reasonCode: reasonCode.value } : {}),
    ...(reasonNote.value.trim() ? { reason: reasonNote.value.trim() } : {}),
  };
  try {
    // 幂等键由 usePendingAction 管理：双击/失败重试沿用同键，服务端按幂等重放。
    await runDecision(async (idempotencyKey) => {
      if (kind === 'accept') {
        await gainosApi.acceptLead(leadId, input, idempotencyKey);
        feedback.message.success($t('gainos.leads.acceptedNotice'));
      } else {
        await gainosApi.rejectLead(leadId, input, idempotencyKey);
        feedback.message.success($t('gainos.leads.rejectedNotice'));
      }
    });
    closeModal();
    await load();
  } catch (error) {
    actionError.value = failureText(error);
  }
}

watch(activeQueue, () => {
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
  <div class="mx-auto grid w-full max-w-[1280px] gap-6 px-6 pb-12 pt-6">
    <GsPage
      :kicker="$t('gainos.leads.stage')"
      :subtitle="$t('gainos.leads.subtitle')"
      :title="$t('gainos.leads.title')"
    >
      <template #actions>
        <GsSelect
          v-if="icps.length"
          v-model="activeIcpId"
          :aria-label="$t('gainos.leads.icpFilter')"
          :ariaLabel="$t('gainos.leads.icpFilter')"
          :options="icps.map((icp) => ({ label: icp.name, value: icp.id }))"
          class="min-w-[220px] max-w-[280px]"
          data-gs="icp-filter"
          @change="load()"
        />
        <Button data-gs="qgo-entry" @click="$router.push('/qgos')">
          {{ $t('gainos.leads.qgoEntry') }}
        </Button>
        <Button :loading="loading" data-gs="refresh" @click="load">
          {{ loading ? $t('gainos.common.refreshing') : $t('gainos.common.refresh') }}
        </Button>
      </template>
    </GsPage>

    <div
      :aria-label="$t('gainos.workspace.stepProgress', { current: currentStep, total: stepLabels.length })"
      data-gs="stage-steps"
    >
      <Steps
        :current="currentStep - 1"
        :items="stepLabels.map((label) => ({ title: label }))"
        size="small"
      />
    </div>

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
      <GsToolbar data-gs="queue-toolbar">
        <RadioGroup
          v-model:value="activeQueue"
          button-style="solid"
          data-gs="queue-switch"
        >
          <RadioButton
            v-for="queue in queueOptions"
            :key="queue.key"
            :value="queue.key"
          >
            {{ queue.label }}
            <span v-if="queue.count !== undefined" class="ml-1.5 opacity-60">
              {{ queue.count }}
            </span>
          </RadioButton>
        </RadioGroup>
        <Button
          v-if="activeQueue !== 'needs_review'"
          :aria-label="`${$t('gainos.common.cancel')}：${queueLabel(activeQueue)}`"
          size="small"
          type="text"
          @click="activeQueue = 'needs_review'"
        >
          ×
        </Button>
        <div class="ml-auto w-[280px]">
          <Input
            v-model:value="searchQuery"
            :aria-label="$t('gainos.companies.searchPlaceholder')"
            :placeholder="$t('gainos.companies.searchPlaceholder')"
            allow-clear
            data-gs="lead-search"
            type="search"
          />
        </div>
      </GsToolbar>

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
        <p v-if="filteredLeads.length === 0" class="m-0 text-[13px] text-[var(--gs-fg-muted)]">
          {{ $t('gainos.companies.noMatch') }}
        </p>

        <GsCard
          v-for="lead in filteredLeads"
          :key="lead.id"
          data-gs="lead-card"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="m-0 text-[15px] font-semibold leading-6">
                <RouterLink
                  class="text-[var(--gs-fg)] no-underline hover:text-[var(--gs-accent-strong)]"
                  :to="{ name: 'LeadDetail', params: { leadId: lead.id } }"
                >
                  {{ lead.company?.name || $t('gainos.leads.unknownCompany') }}
                </RouterLink>
              </h2>
              <p
                v-if="lead.company?.country || lead.company?.industry"
                class="m-0 mt-0.5 text-xs text-[var(--gs-fg-muted)]"
              >
                {{ [lead.company?.country, lead.company?.industry].filter(Boolean).join(' · ') }}
              </p>
            </div>
            <span
              class="text-sm font-semibold tabular-nums"
              :class="typeof lead.totalScore === 'number' ? 'text-[var(--gs-accent-strong)]' : 'text-[var(--gs-fg-subtle)]'"
            >
              {{ scoreText(lead) }}
            </span>
          </div>

          <p class="mb-0 mt-3 text-[13px] leading-5 text-[var(--gs-fg-muted)]">
            {{ whyText(lead) }}
          </p>

          <div class="mt-3 flex flex-wrap items-center gap-2">
            <GsTag :tone="toneOf(queueMeta(lead.queue).tone)">
              {{ queueLabel(lead.queue) }}
            </GsTag>
            <span v-if="basisLabel(lead.queueBasis)" class="text-xs text-[var(--gs-fg-subtle)]">
              {{ basisLabel(lead.queueBasis) }}
            </span>
            <span v-if="lead.company?.employeeCount" class="text-xs text-[var(--gs-fg-subtle)]">
              {{ lead.company.employeeCount }} 人
            </span>
          </div>

          <Space class="mt-4" :size="8" wrap>
            <Button
              size="small"
              @click="router.push({ name: 'LeadDetail', params: { leadId: lead.id } })"
            >
              {{ $t('gainos.leads.viewPackage') }}
            </Button>
            <template v-if="canAct(lead)">
              <Button
                danger
                size="small"
                data-gs="lead-reject"
                @click="openReject(lead)"
              >
                {{ $t('gainos.leads.reject') }}
              </Button>
              <Button
                size="small"
                type="primary"
                data-gs="lead-accept"
                @click="openAccept(lead)"
              >
                {{ $t('gainos.leads.accept') }}
              </Button>
            </template>
            <Button
              v-else-if="lead.status === 'QUALIFIED'"
              size="small"
              type="primary"
              @click="openPromote(lead)"
            >
              {{ $t('gainos.leads.promoteQgo') }}
            </Button>
          </Space>
        </GsCard>

        <div v-if="hasMoreLeads" class="flex items-center justify-between" data-gs="load-more">
          <span class="text-xs text-[var(--gs-fg-subtle)]">
            {{ $t('gainos.leads.showingCount', { shown: leads.length, total: totalForQueue }) }}
          </span>
          <Button @click="loadMore">{{ $t('gainos.leads.loadMore') }}</Button>
        </div>
      </template>
    </template>

    <!-- 裁决弹层 -->
    <Modal
      v-model:open="decisionOpen"
      :confirm-loading="submitting"
      :ok-text="confirmLabel"
      :ok-button-props="{ danger: modal === 'reject' }"
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
      :ok-button-props="{ disabled: promoteBusy || !promoteNextStep.trim() }"
      :confirm-loading="promoteBusy"
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
  </div>
</template>
