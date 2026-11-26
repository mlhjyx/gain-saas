<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { Alert, Button, Form, Input, InputNumber, Modal, Select } from 'ant-design-vue';

import { formatDateTime, glossaryStatus, statusClass } from '@gain-saas/shared';

import { $t } from '#/locales';

import AsyncSection from '#/components/gainos/async-section.vue';
import PageContainer from '#/components/gainos/page-container.vue';
import PageHeader from '#/components/gainos/page-header.vue';

import {
  failureText,
  gainosApi,
  type CampaignDetail,
  type CampaignPlanJobView,
  type CampaignRevisionView,
  type Icp,
} from '#/api/gainos';
import {
  createCampaignRevision,
  type ManualCampaignRevisionInput,
} from '#/api/campaign-revisions';
import { useWorkspaceAccess } from '#/composables/use-workspace-access';

defineOptions({ name: 'CampaignDetail' });

const MAX_POLL_TICKS = 30;
const MAX_REPLANS_OPTIONS: Array<{ label: string; value: 0 | 1 | 2 }> = [
  { label: '0', value: 0 },
  { label: '1', value: 1 },
  { label: '2', value: 2 },
];

const route = useRoute();
const router = useRouter();
const { isAdmin, can, loaded: accessLoaded, ensureLoaded } = useWorkspaceAccess();
const canDraftCampaign = computed(() => isAdmin.value || can('campaigns.draft'));
const canApproveCampaign = computed(() => isAdmin.value || can('campaigns.approve'));
const showReadOnlyHint = computed(
  () => accessLoaded.value && !isAdmin.value && !canDraftCampaign.value,
);
const campaignId = computed(() => String(route.params.campaignId ?? ''));

const detail = ref<CampaignDetail | null>(null);
const icps = ref<Icp[]>([]);
const loading = ref(true);
const error = ref<{ title: string; why?: string; next?: string; code?: string } | null>(null);
const notice = ref<string | null>(null);
const actionError = ref<{ title: string; code?: string } | null>(null);
const busy = ref<string | null>(null);

const draft = ref<CampaignPlanJobView | null>(null);
const showDraftForm = ref(false);
const draftIcpId = ref('');
const draftSizeCap = ref<number | undefined>(undefined);
const draftBudgetUsd = ref<number | undefined>(undefined);
const pollTimer = ref<ReturnType<typeof setInterval> | null>(null);
const needsHuman = ref(false);
const pollTimedOut = ref(false);
const showManualForm = ref(false);
const manualObjective = ref('');
const manualSuccessMetric = ref('');
const manualIcpIds = ref<string[]>([]);
const manualSizeCap = ref<number>(50);
const manualBudgetUsd = ref<number | undefined>(undefined);
const manualMaxReplans = ref<0 | 1 | 2>(1);
const manualError = ref<string | null>(null);

const revisions = computed(() => detail.value?.revisions ?? []);
const latest = computed<CampaignRevisionView | null>(() => revisions.value[0] ?? null);
const pendingApproval = computed(() => {
  const revision = latest.value;
  if (!revision || revision.state !== 'SUBMITTED') return null;
  return revision.approvals.find((approval) => approval.state === 'PENDING') ?? null;
});
const authorization = computed(() => {
  const revision = latest.value;
  if (!revision) return null;
  return (
    detail.value?.authorizations.find(
      (row) => row.revisionId === revision.id && row.state === 'ISSUED',
    ) ?? null
  );
});

const icpName = (id: string): string => {
  const found = icps.value.find((icp) => icp.id === id);
  return found?.name ?? $t('gainos.campaigns.summaryAudience');
};

const money = (micros: number | undefined): string =>
  typeof micros === 'number' ? `$${(micros / 1_000_000).toFixed(2)}` : '';

function traceStepLabel(stepType?: string | null): string {
  const known: Record<string, string> = {
    'authorization.issued': $t('gainos.campaigns.traceStep.authorizationIssued'),
    'approval.decided': $t('gainos.campaigns.traceStep.approvalDecided'),
    superseded: $t('gainos.campaigns.traceStep.superseded'),
  };
  return (stepType && known[stepType]) || stepType || '—';
}

function approvalBadgeClass(state?: string | null): string {
  const meta = glossaryStatus('approval', state);
  return statusClass(meta?.tone ?? 'neutral');
}

const revisionStateLabel = (state: string): string => {
  switch (state) {
    case 'DRAFT': return $t('gainos.campaigns.statusDRAFT');
    case 'SUBMITTED': return $t('gainos.campaigns.statusSUBMITTED');
    case 'APPROVED': return $t('gainos.campaigns.statusAPPROVED');
    case 'DECLINED': return $t('gainos.campaigns.statusDECLINED');
    case 'EXPIRED': return $t('gainos.campaigns.statusEXPIRED');
    case 'SUPERSEDED': return $t('gainos.campaigns.statusSUPERSEDED');
    default: return state;
  }
};

function motionTypeLabel(type?: string | null): string {
  const normalized = (type ?? '').trim().toLowerCase();
  const known = ['discovery', 'outreach', 'enrichment'];
  const key = known.includes(normalized)
    ? `gainosP0.campaigns.motionType.${normalized}`
    : 'gainosP0.campaigns.motionType.other';
  return $t(key as Parameters<typeof $t>[0]);
}

function formatMotion(motion: { type: string; icpIds: string[] }): string {
  const action = motionTypeLabel(motion.type);
  const audience = motion.icpIds.map(icpName).join('、');
  return audience ? $t('gainosP0.campaigns.motionItem', { action, audience }) : action;
}

function actorTypeLabel(actorType?: string | null): string {
  const normalized = (actorType ?? '').trim().toLowerCase();
  const known = ['user', 'service', 'system', 'engine'];
  const key = known.includes(normalized)
    ? `gainosP0.campaigns.actorType.${normalized}`
    : 'gainosP0.campaigns.actorType.unknown';
  return $t(key as Parameters<typeof $t>[0]);
}

const conclusion = computed(() => {
  const plan = latest.value?.plan;
  if (!plan) return '';
  const audience = plan.audience.icpIds.map(icpName).join('、');
  const budget = money(plan.budget.capMicros);
  return budget
    ? $t('gainosP0.campaigns.conclusionWithBudget', {
        objective: plan.goal.objective,
        audience,
        sizeCap: plan.audience.sizeCap,
        budget,
      })
    : $t('gainosP0.campaigns.conclusion', {
        objective: plan.goal.objective,
        audience,
        sizeCap: plan.audience.sizeCap,
      });
});

function prefillManualForm(): void {
  const plan = latest.value?.plan;
  manualObjective.value = detail.value?.objective || plan?.goal.objective || '';
  manualSuccessMetric.value = plan?.goal.successMetric ?? '';
  if (draftIcpId.value) {
    manualIcpIds.value = [draftIcpId.value];
  } else if (plan?.audience.icpIds.length) {
    manualIcpIds.value = [...plan.audience.icpIds];
  } else if (icps.value[0]) {
    manualIcpIds.value = [icps.value[0].id];
  } else {
    manualIcpIds.value = [];
  }
  manualSizeCap.value = draftSizeCap.value ?? plan?.audience.sizeCap ?? 50;
  manualBudgetUsd.value =
    draftBudgetUsd.value ??
    (typeof plan?.budget.capMicros === 'number' ? plan.budget.capMicros / 1_000_000 : undefined);
  const replans = plan?.decisionPolicy.maxReplans;
  manualMaxReplans.value = replans === 0 || replans === 1 || replans === 2 ? replans : 1;
  manualError.value = null;
}

function openManualRevision(): void {
  if (!canDraftCampaign.value) return;
  prefillManualForm();
  showManualForm.value = true;
}

async function submitManualRevision(): Promise<void> {
  if (!canDraftCampaign.value) return;
  manualError.value = null;
  actionError.value = null;
  const objective = manualObjective.value.trim();
  const validIcpIds = [...new Set(manualIcpIds.value.filter(Boolean))];
  const sizeCap = Math.trunc(Number(manualSizeCap.value));
  if (!objective || validIcpIds.length === 0 || !Number.isFinite(sizeCap) || sizeCap < 1 || sizeCap > 1000) {
    manualError.value = $t('gainosP0.campaigns.manualRequiredError');
    return;
  }
  const budgetUsd = manualBudgetUsd.value;
  const plan: ManualCampaignRevisionInput = {
    schemaVersion: 'campaign-plan/v0',
    goal: {
      objective,
      ...(manualSuccessMetric.value.trim()
        ? { successMetric: manualSuccessMetric.value.trim() }
        : {}),
    },
    audience: {
      icpIds: validIcpIds,
      sizeCap,
    },
    motions: [
      {
        type: 'discovery',
        icpIds: [...validIcpIds],
      },
    ],
    budget: {
      ...(typeof budgetUsd === 'number' && Number.isFinite(budgetUsd) && budgetUsd >= 0
        ? { capMicros: Math.round(budgetUsd * 1_000_000) }
        : {}),
      currency: 'USD',
    },
    approvalPolicy: { required: true },
    decisionPolicy: { maxReplans: manualMaxReplans.value },
  };
  busy.value = 'manual';
  try {
    await createCampaignRevision(campaignId.value, plan);
    needsHuman.value = false;
    pollTimedOut.value = false;
    showManualForm.value = false;
    notice.value = $t('gainosP0.campaigns.manualRevisionSaved');
    await load();
  } catch (err) {
    const failure = failureText(err);
    manualError.value = failure.title;
  } finally {
    busy.value = null;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const [campaign, icpList] = await Promise.all([
      gainosApi.campaign(campaignId.value),
      gainosApi.icps().catch(() => [] as Icp[]),
    ]);
    detail.value = campaign;
    icps.value = Array.isArray(icpList) ? icpList : [];
  } catch (err) {
    error.value = failureText(err);
  } finally {
    loading.value = false;
  }
}

function stopPolling(): void {
  if (pollTimer.value) {
    clearInterval(pollTimer.value);
    pollTimer.value = null;
  }
}

function poll(jobId: string): void {
  stopPolling();
  let pollTicks = 0;
  pollTimer.value = setInterval(async () => {
    pollTicks += 1;
    try {
      const job = await gainosApi.campaignPlanDraft(campaignId.value, jobId);
      draft.value = job;
      const state = job.state as string;
      if (state === 'SUCCEEDED') {
        stopPolling();
        busy.value = null;
        needsHuman.value = false;
        pollTimedOut.value = false;
        notice.value = $t('gainosP0.campaigns.draftSucceeded');
        await load();
      } else if (state === 'NEEDS_HUMAN') {
        stopPolling();
        busy.value = null;
        pollTimedOut.value = false;
        needsHuman.value = true;
        prefillManualForm();
        showManualForm.value = true;
      } else if (state === 'FAILED') {
        stopPolling();
        busy.value = null;
        actionError.value = {
          title: `${$t('gainos.campaigns.draftFailed')} · ${$t('gainos.campaigns.draftRetryHint')}`,
          code: job.error ?? undefined,
        };
      } else if (pollTicks >= MAX_POLL_TICKS) {
        stopPolling();
        busy.value = null;
        pollTimedOut.value = true;
      }
    } catch {
      if (pollTicks >= MAX_POLL_TICKS) {
        stopPolling();
        busy.value = null;
        pollTimedOut.value = true;
      }
      /* 轮询瞬时失败忽略，下一拍再试 */
    }
  }, 3000);
}

async function startDraft(): Promise<void> {
  if (!canDraftCampaign.value) return;
  actionError.value = null;
  notice.value = null;
  needsHuman.value = false;
  pollTimedOut.value = false;
  busy.value = 'draft';
  draft.value = null;
  try {
    const budgetUsd = draftBudgetUsd.value;
    const job = await gainosApi.createCampaignPlanDraft(campaignId.value, {
      ...(draftIcpId.value ? { icpId: draftIcpId.value } : {}),
      ...(typeof draftSizeCap.value === 'number' && draftSizeCap.value > 0
        ? { audienceSizeCap: Math.trunc(draftSizeCap.value) }
        : {}),
      ...(typeof budgetUsd === 'number' && budgetUsd > 0
        ? { budgetCapMicros: Math.round(budgetUsd * 1_000_000) }
        : {}),
    });
    draft.value = job;
    showDraftForm.value = false;
    poll(job.id);
  } catch (err) {
    busy.value = null;
    const failure = failureText(err);
    actionError.value = { title: failure.title, code: failure.code };
  }
}

async function submitForApproval(): Promise<void> {
  if (!canDraftCampaign.value) return;
  const revision = latest.value;
  if (!revision) return;
  busy.value = 'submit';
  actionError.value = null;
  try {
    await gainosApi.submitCampaignRevision(campaignId.value, revision.id);
    notice.value = $t('gainos.campaigns.submitted');
    await load();
  } catch (err) {
    const failure = failureText(err);
    actionError.value = { title: failure.title, code: failure.code };
  } finally {
    busy.value = null;
  }
}

async function approve(): Promise<void> {
  if (!canApproveCampaign.value) return;
  const approval = pendingApproval.value;
  if (!approval) return;
  busy.value = 'decide';
  actionError.value = null;
  try {
    await gainosApi.decideCampaignApproval(campaignId.value, approval.id, {
      decision: 'approve',
    });
    showApprove.value = false;
    notice.value = $t('gainos.campaigns.approveDone');
    await load();
  } catch (err) {
    const failure = failureText(err);
    actionError.value = { title: failure.title, code: failure.code };
  } finally {
    busy.value = null;
  }
}

const showDecline = ref(false);
const declineReason = ref('');
const declineError = ref<string | null>(null);
const showApprove = ref(false);

async function decline(): Promise<void> {
  if (!canApproveCampaign.value) return;
  const approval = pendingApproval.value;
  if (!approval) return;
  declineError.value = null;
  if (!declineReason.value.trim()) {
    declineError.value = $t('gainos.campaigns.declineReasonRequired');
    return;
  }
  busy.value = 'decide';
  try {
    await gainosApi.decideCampaignApproval(campaignId.value, approval.id, {
      decision: 'decline',
      reason: declineReason.value.trim(),
    });
    showDecline.value = false;
    declineReason.value = '';
    notice.value = $t('gainos.campaigns.declineDone');
    await load();
  } catch (err) {
    const failure = failureText(err);
    declineError.value = failure.title;
  } finally {
    busy.value = null;
  }
}

onMounted(() => {
  void ensureLoaded();
  void load();
});
onUnmounted(stopPolling);
</script>

<template>
  <PageContainer>
    <PageHeader :subtitle="detail?.objective" :title="detail?.name ?? $t('gainos.menu.campaigns')">
      <template #actions>
        <Button @click="router.push({ path: '/outreach', query: { tab: 'campaigns' } })">← {{ $t('gainosP0.campaigns.backToList') }}</Button>
        <Button
          v-if="canDraftCampaign"
          data-gs="campaign-manual-revision-btn"
          :disabled="busy === 'manual'"
          @click="openManualRevision"
        >
          {{ $t('gainosP0.campaigns.manualRevisionBtn') }}
        </Button>
        <Button
          v-if="canDraftCampaign"
          type="primary"
          :disabled="busy === 'draft'"
          :loading="busy === 'draft'"
          @click="showDraftForm = true"
        >
          {{ busy === 'draft' ? $t('gainos.campaigns.drafting') : $t('gainos.campaigns.draftButton') }}
        </Button>
      </template>
    </PageHeader>

    <Alert :message="$t('gainos.campaigns.shadowBanner')" banner role="note" type="warning" />

    <Alert
      v-if="showReadOnlyHint"
      :message="$t('gainosP0.access.campaignsReadonlyHint')"
      data-gs="campaigns-readonly-hint"
      role="status"
      show-icon
      type="info"
    />

    <Alert v-if="notice" :message="notice" role="status" show-icon type="success" />
    <Alert
      v-if="pollTimedOut"
      :message="$t('gainosP0.campaigns.draftPollingTimeout')"
      data-gs="campaign-poll-timeout"
      role="status"
      show-icon
      type="info"
    />
    <Alert v-if="actionError" role="alert" show-icon type="error">
      <template #message>{{ actionError.title }}</template>
      <template v-if="actionError.code" #description>
        <details>
          <summary>{{ $t('gainos.campaigns.whyTechnical') }}</summary>
          <code>{{ actionError.code }}</code>
        </details>
      </template>
    </Alert>

    <AsyncSection
      :error="error"
      :loading="loading"
      :loading-text="$t('gainos.common.loading')"
      :retry-text="$t('gainos.common.retry')"
      @retry="load"
    >
      <template v-if="detail">
        <section
          v-if="canDraftCampaign && (needsHuman || showManualForm)"
          class="cd__card cd__card--gate"
          data-gs="campaign-needs-human-panel"
        >
          <h2>
            {{
              needsHuman
                ? $t('gainosP0.campaigns.needsHumanTitle')
                : $t('gainosP0.campaigns.manualRevisionTitle')
            }}
          </h2>
          <p v-if="needsHuman" class="cd__muted">
            {{ $t('gainosP0.campaigns.needsHumanDesc') }}
          </p>
          <ul v-if="needsHuman && draft?.issues?.length" class="cd__issues">
            <li v-for="(issue, idx) in draft.issues" :key="`${issue.path}-${idx}`">
              {{ issue.message }}
            </li>
          </ul>
          <Form layout="vertical">
            <Form.Item :label="$t('gainosP0.campaigns.manualObjectiveLabel')">
              <Input
                v-model:value="manualObjective"
                :maxlength="500"
                :placeholder="$t('gainosP0.campaigns.manualObjectivePlaceholder')"
                data-gs="manual-revision-objective"
              />
            </Form.Item>
            <Form.Item :label="$t('gainosP0.campaigns.manualMetricLabel')">
              <Input
                v-model:value="manualSuccessMetric"
                :maxlength="200"
                :placeholder="$t('gainosP0.campaigns.manualMetricPlaceholder')"
                data-gs="manual-revision-metric"
              />
            </Form.Item>
            <Form.Item :label="$t('gainosP0.campaigns.manualAudienceLabel')">
              <Select
                v-model:value="manualIcpIds"
                :options="icps.map((icp) => ({ value: icp.id, label: icp.name }))"
                :placeholder="$t('gainosP0.campaigns.manualAudiencePlaceholder')"
                data-gs="manual-revision-icps"
                mode="multiple"
                style="width: 100%"
              />
            </Form.Item>
            <Form.Item :label="$t('gainosP0.campaigns.manualSizeCapLabel')">
              <InputNumber
                v-model:value="manualSizeCap"
                :max="1000"
                :min="1"
                class="cd__input"
                data-gs="manual-revision-size-cap"
              />
            </Form.Item>
            <Form.Item :label="$t('gainosP0.campaigns.manualBudgetLabel')">
              <InputNumber
                v-model:value="manualBudgetUsd"
                :min="0"
                :step="0.01"
                class="cd__input"
                data-gs="manual-revision-budget"
              />
            </Form.Item>
            <Form.Item :label="$t('gainosP0.campaigns.manualMaxReplansLabel')">
              <Select
                v-model:value="manualMaxReplans"
                :options="MAX_REPLANS_OPTIONS"
                data-gs="manual-revision-max-replans"
                style="width: 100%"
              />
            </Form.Item>
          </Form>
          <Alert v-if="manualError" :message="manualError" role="alert" show-icon type="error" />
          <div class="cd__actions">
            <Button
              type="primary"
              data-gs="manual-revision-submit"
              :disabled="busy === 'manual'"
              :loading="busy === 'manual'"
              @click="submitManualRevision"
            >
              {{ $t('gainosP0.campaigns.manualSubmit') }}
            </Button>
            <Button :disabled="busy === 'manual'" @click="showManualForm = false; needsHuman = false">
              {{ $t('gainos.common.cancel') }}
            </Button>
          </div>
        </section>

        <p v-if="!latest" class="cd__muted">{{ $t('gainos.campaigns.noRevision') }}</p>

        <!-- 待审批卡：approve / decline（拒绝必填理由） -->
        <section v-if="pendingApproval" class="cd__card cd__card--gate">
          <h2>{{ $t('gainos.campaigns.approvalTitle') }}</h2>
          <p>{{ conclusion }}</p>
          <p class="cd__muted">
            {{ $t('gainos.campaigns.approvalExpires') }}:
            {{ formatDateTime(pendingApproval.expiresAt) }}
          </p>
          <div v-if="canApproveCampaign" class="cd__actions">
            <Button type="primary" :disabled="busy === 'decide'" @click="showApprove = true">
              {{ $t('gainos.campaigns.approve') }}
            </Button>
            <Button danger :disabled="busy === 'decide'" @click="showDecline = true">
              {{ $t('gainos.campaigns.decline') }}
            </Button>
          </div>
          <p v-else class="cd__muted">{{ $t('gainosP0.access.adminApprovalRequired') }}</p>
        </section>

        <section v-if="latest" class="cd__card">
          <h2>{{ $t('gainos.campaigns.planSummary') }}</h2>
          <dl class="cd__facts">
            <dt>{{ $t('gainos.campaigns.summaryGoal') }}</dt>
            <dd>{{ latest.plan.goal.objective }}</dd>
            <template v-if="latest.plan.goal.successMetric">
              <dt>{{ $t('gainos.campaigns.summaryMetric') }}</dt>
              <dd>{{ latest.plan.goal.successMetric }}</dd>
            </template>
            <dt>{{ $t('gainos.campaigns.summaryAudience') }}</dt>
            <dd>{{ latest.plan.audience.icpIds.map(icpName).join('、') }}</dd>
            <dt>{{ $t('gainos.campaigns.summarySizeCap') }}</dt>
            <dd>{{ latest.plan.audience.sizeCap }} {{ $t('gainos.campaigns.sizeCapUnit') }}</dd>
            <dt>{{ $t('gainos.campaigns.summaryBudget') }}</dt>
            <dd>{{ money(latest.plan.budget.capMicros) || $t('gainos.campaigns.noBudget') }}</dd>
            <dt>{{ $t('gainos.campaigns.summaryMotion') }}</dt>
            <dd>
              <ul v-if="latest.plan.motions?.length" class="cd__motions">
                <li v-for="(motion, idx) in latest.plan.motions" :key="`${motion.type}-${idx}`">
                  {{ formatMotion(motion) }}
                </li>
              </ul>
              <span v-else>{{ $t('gainos.campaigns.motionDiscovery') }}</span>
            </dd>
          </dl>
          <div v-if="latest.state === 'DRAFT' && canDraftCampaign" class="cd__actions">
            <Button type="primary" :disabled="busy === 'submit'" :loading="busy === 'submit'" @click="submitForApproval">
              {{ $t('gainos.campaigns.submit') }}
            </Button>
          </div>
          <p v-else-if="latest.state === 'EXPIRED'" class="cd__muted">
            {{ $t('gainos.campaigns.approvalExpired') }}
          </p>
        </section>

        <!-- Why 卡：三层渐进（结论 / 依据 / 技术详情默认折叠） -->
        <section v-if="latest" class="cd__card">
          <h2>{{ $t('gainos.campaigns.why') }}</h2>
          <p class="cd__why-1">{{ conclusion }}</p>
          <details class="cd__why-2">
            <summary>{{ $t('gainos.campaigns.whyBasis') }}</summary>
            <ul>
              <li>{{ $t('gainos.campaigns.summaryGoal') }}: {{ latest.plan.goal.objective }}</li>
              <li>
                {{ $t('gainos.campaigns.summaryAudience') }}:
                {{ latest.plan.audience.icpIds.map(icpName).join('、') }}
              </li>
              <li>
                {{ $t('gainos.campaigns.summarySizeCap') }}: {{ latest.plan.audience.sizeCap }}
                {{ $t('gainos.campaigns.sizeCapUnit') }}
              </li>
              <li>
                {{ $t('gainos.campaigns.summaryBudget') }}:
                {{ money(latest.plan.budget.capMicros) || $t('gainos.campaigns.noBudget') }}
              </li>
              <li>{{ $t('gainos.campaigns.revision', { no: latest.revisionNo }) }} · {{ formatDateTime(latest.createdAt) }}</li>
            </ul>
          </details>
          <details class="cd__why-3">
            <summary>{{ $t('gainos.campaigns.whyTechnical') }}</summary>
            <p class="cd__muted">{{ $t('gainos.campaigns.whyTechnicalHint') }}</p>
            <pre>{{ JSON.stringify(latest.plan, null, 2) }}</pre>
            <code>{{ $t('gainos.campaigns.planVersion') }} · {{ latest.planHash }}</code>
            <code>revision_id: {{ latest.id }}</code>
            <code>job_id: {{ draft?.id ?? '—' }}</code>
          </details>
        </section>

        <section v-if="authorization" class="cd__card cd__card--ok">
          <h2>{{ $t('gainos.campaigns.authorization') }}</h2>
          <p>{{ $t('gainos.campaigns.authIssued') }}</p>
          <p class="cd__muted">
            {{ formatDateTime(authorization.issuedAt) }} –
            {{ formatDateTime(authorization.expiresAt) }}
          </p>
        </section>

        <section v-if="revisions.length" class="cd__card">
          <h2>{{ $t('gainos.campaigns.revisions') }}</h2>
          <ol class="cd__timeline">
            <li v-for="revision in revisions" :key="revision.id">
              <strong>{{ $t('gainos.campaigns.revision', { no: revision.revisionNo }) }}</strong>
              <span class="gs-badge" :class="approvalBadgeClass(revision.state)">{{ revisionStateLabel(revision.state) }}</span>
              <span class="cd__muted">{{ formatDateTime(revision.createdAt) }}</span>
              <p v-if="revision.approvals[0]?.decisionReason" class="cd__muted">
                {{ revision.approvals[0].decisionReason }}
              </p>
            </li>
          </ol>
        </section>

        <section v-if="detail.recentTrace.length" class="cd__card">
          <h2>{{ $t('gainos.campaigns.traceTitle') }}</h2>
          <ol class="cd__timeline">
            <li v-for="entry in detail.recentTrace" :key="entry.traceId">
              <span class="cd__muted">{{ formatDateTime(entry.createdAt) }}</span>
              <span>{{ traceStepLabel(entry.stepType) }} · {{ actorTypeLabel(entry.actorType) }}</span>
            </li>
          </ol>
        </section>
      </template>
    </AsyncSection>

    <Modal
      v-if="canDraftCampaign"
      v-model:open="showDraftForm"
      :cancel-text="$t('gainos.common.cancel')"
      :confirm-loading="busy === 'draft'"
      :ok-text="$t('gainos.campaigns.draftButton')"
      :title="$t('gainos.campaigns.draftButton')"
      :width="480"
      @ok="startDraft"
    >
      <Form layout="vertical">
        <Form.Item :label="$t('gainos.campaigns.summaryAudience')">
          <Select v-model:value="draftIcpId" :options="icps.map((icp) => ({ value: icp.id, label: icp.name }))" allow-clear placeholder="—" />
        </Form.Item>
        <Form.Item :label="$t('gainos.campaigns.summarySizeCap')">
          <InputNumber v-model:value="draftSizeCap" :max="1000" :min="1" class="cd__input" />
        </Form.Item>
        <Form.Item :label="`${$t('gainos.campaigns.summaryBudget')} (USD)`">
          <InputNumber v-model:value="draftBudgetUsd" :min="0" :step="0.01" class="cd__input" />
        </Form.Item>
      </Form>
    </Modal>

    <Modal
      v-if="canApproveCampaign"
      v-model:open="showApprove"
      :cancel-text="$t('gainos.common.cancel')"
      :confirm-loading="busy === 'decide'"
      :ok-text="$t('gainos.campaigns.approve')"
      :title="$t('gainos.campaigns.approve')"
      :width="480"
      @ok="approve"
    >
      <p>{{ conclusion }}</p>
      <p class="cd__muted">{{ $t('gainos.campaigns.approveConfirm') }}</p>
    </Modal>

    <Modal
      v-if="canApproveCampaign"
      v-model:open="showDecline"
      :cancel-text="$t('gainos.common.cancel')"
      :confirm-loading="busy === 'decide'"
      :ok-text="$t('gainos.campaigns.decline')"
      :ok-button-props="{ danger: true }"
      :title="$t('gainos.campaigns.decline')"
      :width="480"
      @ok="decline"
    >
      <Form layout="vertical">
        <Form.Item :label="$t('gainos.campaigns.declineReason')">
          <Input.TextArea v-model:value="declineReason" :maxlength="500" :rows="3" />
        </Form.Item>
      </Form>
      <Alert v-if="declineError" :message="declineError" role="alert" show-icon type="error" />
    </Modal>
  </PageContainer>
</template>

<style scoped>
.cd__muted { color: var(--gs-fg-muted); font-size: 13px; }
.cd__card { border: 1px solid var(--gs-border); border-radius: 12px; padding: 16px 20px; background: var(--gs-surface); }
.cd__card--gate { border-color: var(--gs-warn); background: var(--gs-warn-bg); }
.cd__card--ok { border-color: var(--gs-accent-soft-border); background: var(--gs-accent-soft); }
.cd__card h2 { margin: 0 0 10px; font-size: 18px; }
.cd__facts { display: grid; grid-template-columns: 180px 1fr; gap: 8px 16px; margin: 0; }
.cd__facts dt { color: var(--gs-fg-muted); }
.cd__facts dd { margin: 0; }
.cd__actions { display: flex; gap: 10px; margin-top: 10px; }
.cd__why-1 { font-size: 16px; margin: 0 0 10px; }
.cd__why-2 summary, .cd__why-3 summary { cursor: pointer; color: var(--gs-accent-strong); }
.cd__why-2 ul { margin: 8px 0 0; }
.cd__why-3 pre { background: var(--gs-surface-2); padding: 10px; border-radius: 8px; overflow: auto; max-height: 320px; font-size: 12px; }
.cd__why-3 code { display: block; margin-top: 6px; font-size: 12px; color: var(--gs-fg-muted); }
.cd__timeline { margin: 0; padding-left: 18px; display: grid; gap: 8px; }
.cd__timeline li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }
.cd__input { width: 100%; }
.cd__issues { margin: 0 0 12px; padding-left: 18px; color: var(--gs-fg-2); font-size: 13px; display: grid; gap: 4px; }
.cd__motions { margin: 0; padding-left: 18px; display: grid; gap: 4px; }
</style>
