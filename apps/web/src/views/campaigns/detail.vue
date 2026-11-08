<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { $t } from '#/locales';

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
const draftBudgetUsd = ref<string>('');
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
    const budgetUsd = Number(draftBudgetUsd.value);
    const job = await gainosApi.createCampaignPlanDraft(campaignId.value, {
      ...(draftIcpId.value ? { icpId: draftIcpId.value } : {}),
      ...(typeof draftSizeCap.value === 'number' && draftSizeCap.value > 0
        ? { audienceSizeCap: Math.trunc(draftSizeCap.value) }
        : {}),
      ...(Number.isFinite(budgetUsd) && budgetUsd > 0
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
  <div class="cd">
    <header class="cd__head">
      <button type="button" class="cd__back" @click="router.push({ name: 'Campaigns' })">←</button>
      <div>
        <h1>{{ detail?.name ?? $t('gainos.menu.campaigns') }}</h1>
        <p v-if="detail?.objective">{{ detail.objective }}</p>
      </div>
      <button class="cd__primary" type="button" :disabled="busy === 'draft'" @click="showDraftForm = true">
        {{ busy === 'draft' ? $t('gainos.campaigns.drafting') : $t('gainos.campaigns.draftButton') }}
      </button>
    </header>

    <p class="cd__banner" role="note">{{ $t('gainos.campaigns.shadowBanner') }}</p>

    <p v-if="notice" class="cd__notice" role="status">{{ notice }}</p>
    <div v-if="actionError" class="cd__error" role="alert">
      <strong>{{ actionError.title }}</strong>
      <details v-if="actionError.code">
        <summary>{{ $t('gainos.campaigns.whyTechnical') }}</summary>
        <code>{{ actionError.code }}</code>
      </details>
    </div>

    <p v-if="loading" class="cd__hint">{{ $t('gainos.common.loading') }}</p>
    <div v-else-if="error" class="cd__error" role="alert">
      <strong>{{ error.title }}</strong>
      <p v-if="error.next">{{ error.next }}</p>
      <button type="button" @click="load">{{ $t('gainos.common.retry') }}</button>
    </div>

    <template v-else-if="detail">
      <p v-if="!latest" class="cd__hint">{{ $t('gainos.campaigns.noRevision') }}</p>

      <!-- 待审批卡：approve / decline（拒绝必填理由） -->
      <section v-if="pendingApproval" class="cd__card cd__card--gate">
        <h2>{{ $t('gainos.campaigns.approvalTitle') }}</h2>
        <p>{{ conclusion }}</p>
        <p class="cd__muted">
          {{ $t('gainos.campaigns.approvalExpires') }}:
          {{ new Date(pendingApproval.expiresAt).toLocaleString() }}
        </p>
        <div class="cd__actions">
          <button type="button" class="cd__primary" :disabled="busy === 'decide'" @click="showApprove = true">
            {{ $t('gainos.campaigns.approve') }}
          </button>
          <button type="button" class="cd__danger" :disabled="busy === 'decide'" @click="showDecline = true">
            {{ $t('gainos.campaigns.decline') }}
          </button>
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
          <button type="button" class="cd__primary" :disabled="busy === 'submit'" @click="submitForApproval">
            {{ $t('gainos.campaigns.submit') }}
          </button>
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
            <li>{{ $t('gainos.campaigns.revision', { no: latest.revisionNo }) }} · {{ new Date(latest.createdAt).toLocaleString() }}</li>
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
          {{ new Date(authorization.issuedAt).toLocaleString() }} –
          {{ new Date(authorization.expiresAt).toLocaleString() }}
        </p>
      </section>

      <section v-if="revisions.length" class="cd__card">
        <h2>{{ $t('gainos.campaigns.revisions') }}</h2>
        <ol class="cd__timeline">
          <li v-for="revision in revisions" :key="revision.id">
            <strong>{{ $t('gainos.campaigns.revision', { no: revision.revisionNo }) }}</strong>
            <span class="cd__state">{{ revisionStateLabel(revision.state) }}</span>
            <span class="cd__muted">{{ new Date(revision.createdAt).toLocaleString() }}</span>
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
            <span class="cd__muted">{{ new Date(entry.createdAt).toLocaleString() }}</span>
            <span>{{ entry.stepType }} · {{ entry.actorType }}</span>
          </li>
        </ol>
      </section>
    </template>

    <div v-if="showDraftForm" class="cd__modal" role="dialog" aria-modal="true">
      <div class="cd__dialog">
        <h2>{{ $t('gainos.campaigns.draftButton') }}</h2>
        <label>
          {{ $t('gainos.campaigns.summaryAudience') }}
          <select v-model="draftIcpId">
            <option value="">—</option>
            <option v-for="icp in icps" :key="icp.id" :value="icp.id">{{ icp.name }}</option>
          </select>
        </label>
        <label>
          {{ $t('gainos.campaigns.summarySizeCap') }}
          <input v-model.number="draftSizeCap" type="number" min="1" max="1000" />
        </label>
        <label>
          {{ $t('gainos.campaigns.summaryBudget') }} (USD)
          <input v-model="draftBudgetUsd" type="number" min="0" step="0.01" />
        </label>
        <div class="cd__actions">
          <button type="button" class="cd__primary" :disabled="busy === 'draft'" @click="startDraft">
            {{ busy === 'draft' ? $t('gainos.campaigns.drafting') : $t('gainos.campaigns.draftButton') }}
          </button>
          <button type="button" class="cd__ghost" @click="showDraftForm = false">
            {{ $t('gainos.common.cancel') }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="showApprove" class="cd__modal" role="dialog" aria-modal="true">
      <div class="cd__dialog">
        <h2>{{ $t('gainos.campaigns.approve') }}</h2>
        <p>{{ conclusion }}</p>
        <p class="cd__muted">{{ $t('gainos.campaigns.approveConfirm') }}</p>
        <div class="cd__actions">
          <button type="button" class="cd__primary" :disabled="busy === 'decide'" @click="approve">
            {{ $t('gainos.campaigns.approve') }}
          </button>
          <button type="button" class="cd__ghost" @click="showApprove = false">
            {{ $t('gainos.common.cancel') }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="showDecline" class="cd__modal" role="dialog" aria-modal="true">
      <div class="cd__dialog">
        <h2>{{ $t('gainos.campaigns.decline') }}</h2>
        <label>
          {{ $t('gainos.campaigns.declineReason') }}
          <textarea v-model="declineReason" rows="3" maxlength="500" />
        </label>
        <p v-if="declineError" class="cd__error-inline" role="alert">{{ declineError }}</p>
        <div class="cd__actions">
          <button type="button" class="cd__danger" :disabled="busy === 'decide'" @click="decline">
            {{ $t('gainos.campaigns.decline') }}
          </button>
          <button type="button" class="cd__ghost" @click="showDecline = false">
            {{ $t('gainos.common.cancel') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cd { max-width: 1080px; margin: 0 auto; padding: 24px; display: grid; gap: 16px; }
.cd__head { display: flex; gap: 16px; align-items: flex-start; }
.cd__head h1 { margin: 0; font-size: 24px; }
.cd__head p { margin: 4px 0 0; color: #6b6257; }
.cd__back { border: 1px solid #d8cbb8; background: #fff; border-radius: 8px; width: 34px; height: 34px; cursor: pointer; }
.cd__primary { background: #b45309; color: #fff; border: none; border-radius: 8px; padding: 10px 16px; cursor: pointer; margin-left: auto; }
.cd__danger { background: #b91c1c; color: #fff; border: none; border-radius: 8px; padding: 10px 16px; cursor: pointer; }
.cd__ghost { background: #f3ece1; color: #6b6257; border: none; border-radius: 8px; padding: 10px 16px; cursor: pointer; }
.cd__banner { margin: 0; padding: 10px 14px; border-radius: 8px; background: #fef3c7; color: #92400e; }
.cd__notice { margin: 0; color: #166534; }
.cd__hint { color: #6b6257; }
.cd__muted { color: #8a7f70; font-size: 13px; }
.cd__card { border: 1px solid #ede3d3; border-radius: 12px; padding: 16px 20px; background: #fffdf8; }
.cd__card--gate { border-color: #f3c78a; background: #fff7ea; }
.cd__card--ok { border-color: #bbe5c8; background: #f2fbf5; }
.cd__card h2 { margin: 0 0 10px; font-size: 18px; }
.cd__facts { display: grid; grid-template-columns: 180px 1fr; gap: 8px 16px; margin: 0; }
.cd__facts dt { color: #8a7f70; }
.cd__facts dd { margin: 0; }
.cd__actions { display: flex; gap: 10px; margin-top: 10px; }
.cd__why-1 { font-size: 16px; margin: 0 0 10px; }
.cd__why-2 summary, .cd__why-3 summary { cursor: pointer; color: #b45309; }
.cd__why-2 ul { margin: 8px 0 0; }
.cd__why-3 pre { background: #f6f1e7; padding: 10px; border-radius: 8px; overflow: auto; max-height: 320px; font-size: 12px; }
.cd__why-3 code { display: block; margin-top: 6px; font-size: 12px; color: #6b6257; }
.cd__timeline { margin: 0; padding-left: 18px; display: grid; gap: 8px; }
.cd__state { margin: 0 8px; color: #b45309; }
.cd__error { background: #fef2f2; color: #991b1b; padding: 12px 16px; border-radius: 8px; }
.cd__error details { margin-top: 6px; }
.cd__error-inline { color: #991b1b; margin: 0; }
.cd__modal { position: fixed; inset: 0; background: rgba(30, 20, 8, 0.4); display: flex; align-items: center; justify-content: center; }
.cd__dialog { background: #fff; border-radius: 12px; padding: 20px; width: min(480px, 92vw); display: grid; gap: 12px; }
.cd__dialog label { display: grid; gap: 6px; font-size: 14px; }
.cd__dialog input, .cd__dialog select, .cd__dialog textarea { border: 1px solid #d8cbb8; border-radius: 8px; padding: 8px 10px; font: inherit; }
</style>
