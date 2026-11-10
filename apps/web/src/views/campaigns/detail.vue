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

defineOptions({ name: 'CampaignDetail' });

const route = useRoute();
const router = useRouter();
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

const conclusion = computed(() => {
  const plan = latest.value?.plan;
  if (!plan) return '';
  const audience = plan.audience.icpIds.map(icpName).join('、');
  const budget = money(plan.budget.capMicros);
  return `${plan.goal.objective}（受众：${audience}；每个画像最多 ${plan.audience.sizeCap} 家${
    budget ? `；预算上限 ${budget}` : ''
  }）`;
});

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
  pollTimer.value = setInterval(async () => {
    try {
      const job = await gainosApi.campaignPlanDraft(campaignId.value, jobId);
      draft.value = job;
      if (job.state === 'SUCCEEDED') {
        stopPolling();
        busy.value = null;
        notice.value = $t('gainos.campaigns.submitted');
        await load();
      } else if (job.state === 'FAILED') {
        stopPolling();
        busy.value = null;
        actionError.value = {
          title: `${$t('gainos.campaigns.draftFailed')} · ${$t('gainos.campaigns.draftRetryHint')}`,
          code: job.error ?? undefined,
        };
      }
    } catch {
      /* 轮询瞬时失败忽略，下一拍再试 */
    }
  }, 3000);
}

async function startDraft(): Promise<void> {
  actionError.value = null;
  notice.value = null;
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

onMounted(load);
onUnmounted(stopPolling);
</script>

<template>
  <PageContainer>
    <PageHeader :subtitle="detail?.objective" :title="detail?.name ?? $t('gainos.menu.campaigns')">
      <template #actions>
        <Button @click="router.push({ name: 'Campaigns' })">← {{ $t('gainos.campaigns.goOutreach') }}</Button>
        <Button
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

    <Alert v-if="notice" :message="notice" role="status" show-icon type="success" />
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
        <p v-if="!latest" class="cd__muted">{{ $t('gainos.campaigns.noRevision') }}</p>

        <!-- 待审批卡：approve / decline（拒绝必填理由） -->
        <section v-if="pendingApproval" class="cd__card cd__card--gate">
          <h2>{{ $t('gainos.campaigns.approvalTitle') }}</h2>
          <p>{{ conclusion }}</p>
          <p class="cd__muted">
            {{ $t('gainos.campaigns.approvalExpires') }}:
            {{ formatDateTime(pendingApproval.expiresAt) }}
          </p>
          <div class="cd__actions">
            <Button type="primary" :disabled="busy === 'decide'" @click="showApprove = true">
              {{ $t('gainos.campaigns.approve') }}
            </Button>
            <Button danger :disabled="busy === 'decide'" @click="showDecline = true">
              {{ $t('gainos.campaigns.decline') }}
            </Button>
          </div>
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
            <dd>{{ $t('gainos.campaigns.motionDiscovery') }}</dd>
          </dl>
          <div v-if="latest.state === 'DRAFT'" class="cd__actions">
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
              <span>{{ traceStepLabel(entry.stepType) }} · {{ entry.actorType }}</span>
            </li>
          </ol>
        </section>
      </template>
    </AsyncSection>

    <Modal
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
</style>
