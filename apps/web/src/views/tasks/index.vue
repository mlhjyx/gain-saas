<script lang="ts" setup>
import type { AcquisitionTaskView, Icp, QueryPlan, TaskRunView } from '#/api/gainos';

import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { Alert, Button, Modal, Skeleton, Space, Table } from 'ant-design-vue';

import { formatDateTime, glossaryStatus, statusClass } from '@gain-saas/shared';
import { preferences } from '@vben/preferences';

import { $t } from '#/locales';

import AsyncSection from '#/components/gainos/async-section.vue';

import { failureText, gainosApi } from '#/api/gainos';
import { feedback } from '#/feedback';
import ErrorNotice from '#/components/error-notice.vue';
import GsSelect from '#/components/gainos/ui/gs-select.vue';
import { notifyChainChanged } from '#/composables/use-main-chain-progress';
import { useWorkspaceAccess } from '#/composables/use-workspace-access';

import SourcingLayout from '../runs/sourcing-layout.vue';
import {
  isRunInProgress,
  mintAttemptId,
  newestPlans,
  queryValue,
  recentTaskRuns,
  sourcingPlansLocation,
  sourcingRunLocation,
  taskRunLocation,
} from '../runs/sourcing-navigation';
import QueryPlanSummary from './query-plan-summary.vue';

/**
 * 任务列表（Q32 + Wave B4）：
 * 同步展示任务状态徽标（active / paused / archived）与最近执行状态，支持快捷暂停/恢复/归档。
 */
defineOptions({ name: 'Tasks' });

const router = useRouter();
const route = useRoute();
const { can, ensureLoaded, loaded: accessLoaded } = useWorkspaceAccess();
const canManage = computed(() => can('acquisition.run'));
const activeTab = computed(() => queryValue(route.query.tab));
const requestedIcp = computed(() => queryValue(route.query.icp));

const tasks = ref<AcquisitionTaskView[]>([]);
const icps = ref<Icp[]>([]);
const loading = ref(true);
const error = ref<{ title: string; next?: string } | null>(null);
const busyTaskId = ref<string | null>(null);
const profilesLoading = ref(true);
const profilesError = ref<ReturnType<typeof failureText> | null>(null);
const plans = ref<QueryPlan[]>([]);
const plansLoading = ref(false);
const plansError = ref<ReturnType<typeof failureText> | null>(null);
const operationError = ref<ReturnType<typeof failureText> | null>(null);
const planBusy = ref(false);
const pendingLaunch = ref<{ planId: string; taskRunId: string } | null>(null);
const dialog = ref<'generate' | 'launch' | null>(null);
const intentKeys = new Map<string, string>();
let historySequence = 0;
let planSequence = 0;

const activeProfiles = computed(() => icps.value.filter((item) => item.status === 'ACTIVE'));
const planProfile = computed(() => {
  if (requestedIcp.value) return icps.value.find((item) => item.id === requestedIcp.value) ?? null;
  return activeProfiles.value[0] ?? null;
});
const scopedTasks = computed(() => {
  const id = planProfile.value?.id;
  return id ? tasks.value.filter((task) => task.icpId === id) : [];
});
const taskInProgress = computed(() => scopedTasks.value.some((task) =>
  (task.runs ?? []).some((run) => isRunInProgress(run.status)),
));
const planTask = computed(() => scopedTasks.value.find((task) => task.status === 'active') ??
  scopedTasks.value.find((task) => task.status === 'paused'));
const newestRun = computed(() => recentTaskRuns(tasks.value)[0]);
const activePlan = computed(() => {
  const id = queryValue(route.query.plan);
  return id ? plans.value.find((plan) => plan.id === id) : plans.value[0];
});
const launchLabel = computed(() => activePlan.value?.status === 'EXECUTED'
  ? $t('gainosBuyerJourney.sourcing.restart') : $t('gainos.findBuyers.executePlan'));
const canChangePlans = computed(() => canManage.value && planProfile.value?.status === 'ACTIVE' && !plansLoading.value && !plansError.value);
const canLaunch = computed(() => canChangePlans.value && Boolean(activePlan.value &&
  ['READY', 'EXECUTED'].includes(activePlan.value.status) && !loading.value && !error.value &&
  !taskInProgress.value && planTask.value?.status !== 'paused' && pendingLaunch.value?.planId !== activePlan.value.id));
const planRun = computed(() => {
  const id = activePlan.value?.id;
  return id ? recentTaskRuns(scopedTasks.value).find(({ run }) => run.planId === id) : undefined;
});

const icpNameMap = computed(() => new Map(icps.value.map((icp) => [icp.id, icp.name])));

function icpLabel(icpId?: string | null): string {
  if (!icpId) return '—';
  return icpNameMap.value.get(icpId) || $t('gainosP0.tasks.profileFallback');
}

function taskStatusLabel(status?: string): string {
  const key = `gainos.tasks.task${(status ?? 'active').replace(/^./, (c) => c.toUpperCase())}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? (status ?? '—') : translated;
}

function taskStatusBadgeClass(status?: string): string {
  if (status === 'active') return statusClass('success');
  if (status === 'paused') return statusClass('warning');
  return statusClass('neutral');
}

async function loadTasks(): Promise<void> {
  const sequence = ++historySequence;
  loading.value = true;
  error.value = null;
  try {
    const data = await gainosApi.acquisitionTasks();
    if (!Array.isArray(data)) throw new Error('Invalid task list');
    if (sequence === historySequence) {
      tasks.value = data;
      if (pendingLaunch.value && recentTaskRuns(data).some(({ run }) => run.id === pendingLaunch.value?.taskRunId && run.runId)) {
        pendingLaunch.value = null;
      }
    }
  } catch (err) {
    if (sequence === historySequence) error.value = failureText(err);
  } finally {
    if (sequence === historySequence) loading.value = false;
  }
}

async function loadProfiles(): Promise<void> {
  profilesLoading.value = true;
  profilesError.value = null;
  try {
    const data = await gainosApi.icps();
    if (!Array.isArray(data)) throw new Error('Invalid profiles');
    icps.value = data;
  } catch (err) {
    profilesError.value = failureText(err);
  } finally {
    profilesLoading.value = false;
  }
}

async function loadPlans(id: string): Promise<void> {
  const sequence = ++planSequence;
  plansLoading.value = true;
  plansError.value = null;
  try {
    const data = await gainosApi.queryPlans(id);
    if (!Array.isArray(data)) throw new Error('Invalid plan list');
    if (sequence === planSequence) plans.value = newestPlans(data.filter((plan) => plan.icpId === id));
  } catch (err) {
    if (sequence === planSequence) plansError.value = failureText(err);
  } finally {
    if (sequence === planSequence) plansLoading.value = false;
  }
}

watch([activeTab, () => planProfile.value?.id], ([tab, id]) => {
  dialog.value = null;
  operationError.value = null;
  plans.value = [];
  plansError.value = null;
  planSequence += 1;
  plansLoading.value = false;
  if (tab === 'plan' && id) void loadPlans(id);
});

watch(() => route.query.plan, () => {
  dialog.value = null;
  operationError.value = null;
});

function selectProfile(id: unknown): void {
  if (typeof id === 'string' && id && !planBusy.value) void router.replace(sourcingPlansLocation(id));
}

function selectPlan(id: unknown): void {
  if (typeof id === 'string' && planProfile.value && !planBusy.value) {
    operationError.value = null;
    void router.replace({ query: { ...route.query, plan: id } });
  }
}

function attempt(key: string): string {
  const existing = intentKeys.get(key);
  if (existing) return existing;
  const fresh = mintAttemptId();
  intentKeys.set(key, fresh);
  return fresh;
}

function resetRejectedAttempt(err: unknown, key: string): void {
  const status = (err as { response?: { status?: number } })?.response?.status;
  if (status && status >= 400 && status < 500 && status !== 408) intentKeys.delete(key);
}

async function generatePlan(): Promise<void> {
  const profile = planProfile.value;
  if (!profile || !canChangePlans.value || planBusy.value) return;
  const key = `generate:${profile.id}`;
  planBusy.value = true;
  operationError.value = null;
  try {
    const plan = await gainosApi.createQueryPlan(profile.id, attempt(key));
    intentKeys.delete(key);
    dialog.value = null;
    notifyChainChanged();
    feedback.message.success($t('gainos.findBuyers.planCreated'));
    if (planProfile.value?.id === profile.id) {
      if (plan?.id) await router.replace(sourcingPlansLocation(profile.id, plan.id));
      await loadPlans(profile.id);
    }
  } catch (err) {
    resetRejectedAttempt(err, key);
    operationError.value = failureText(err);
  } finally {
    planBusy.value = false;
  }
}

async function confirmPlan(): Promise<void> {
  const plan = activePlan.value;
  if (plan?.status !== 'DRAFT' || !canChangePlans.value || planBusy.value) return;
  planBusy.value = true;
  operationError.value = null;
  try {
    await gainosApi.confirmQueryPlan(plan.id);
    notifyChainChanged();
    feedback.message.success($t('gainos.findBuyers.planConfirmed'));
    if (planProfile.value?.id === plan.icpId) await loadPlans(plan.icpId);
  } catch (err) {
    operationError.value = failureText(err);
  } finally {
    planBusy.value = false;
  }
}

async function launchPlan(): Promise<void> {
  const plan = activePlan.value;
  const profile = planProfile.value;
  if (!plan || !profile || !canLaunch.value || planBusy.value) return;
  const key = `launch:${plan.id}`;
  planBusy.value = true;
  operationError.value = null;
  try {
    // Confirm the current task state again after the user has reviewed the plan.
    const latest = await gainosApi.acquisitionTasks(profile.id);
    if (!Array.isArray(latest)) throw new Error('Invalid task list');
    const scoped = latest.filter((task) => task.icpId === profile.id);
    if (scoped.some((task) => (task.runs ?? []).some((run) => isRunInProgress(run.status)))) {
      operationError.value = { title: $t('gainosBuyerJourney.sourcing.progressBlocked'), why: undefined, next: undefined };
      await loadTasks();
      return;
    }
    const existing = scoped.find((task) => task.status === 'active');
    if (!existing && scoped.some((task) => task.status === 'paused')) {
      operationError.value = { title: $t('gainosBuyerJourney.sourcing.pausedBlocked'), why: undefined, next: undefined };
      await loadTasks();
      return;
    }
    const task = existing ?? await gainosApi.createAcquisitionTask({
      icpId: profile.id,
      name: Array.from(profile.name).slice(0, 120).join(''),
    });
    const result = await gainosApi.startAcquisitionTaskRun(task.id, plan.id, attempt(key));
    dialog.value = null;
    notifyChainChanged();
    if (result.runId) {
      intentKeys.delete(key);
      await router.push(sourcingRunLocation(result.runId, 'progress'));
    } else {
      pendingLaunch.value = { planId: plan.id, taskRunId: result.taskRunId };
      await loadTasks();
    }
  } catch (err) {
    resetRejectedAttempt(err, key);
    operationError.value = failureText(err);
  } finally {
    planBusy.value = false;
  }
}

function cancelDialog(): void {
  if (planBusy.value) return;
  dialog.value = null;
  operationError.value = null;
}

function refresh(): void {
  void loadTasks();
  void loadProfiles();
  if (activeTab.value === 'plan' && planProfile.value) void loadPlans(planProfile.value.id);
}

async function toggleTaskPause(record: AcquisitionTaskView): Promise<void> {
  if (record.status === 'archived' || busyTaskId.value) return;
  const nextStatus: 'active' | 'paused' = record.status === 'paused' ? 'active' : 'paused';
  busyTaskId.value = record.id;
  try {
    const updated = await gainosApi.updateTask(record.id, { status: nextStatus });
    tasks.value = tasks.value.map((row) =>
      row.id === record.id
        ? (updated && typeof updated === 'object' && 'id' in updated ? updated : { ...row, status: nextStatus })
        : row,
    );
    feedback.message.success(
      nextStatus === 'paused' ? $t('gainosB4.tasks.pausedDone') : $t('gainosB4.tasks.resumedDone'),
    );
  } catch (err) {
    feedback.message.error(failureText(err).title);
  } finally {
    busyTaskId.value = null;
  }
}

function archiveTask(record: AcquisitionTaskView): void {
  if (record.status === 'archived' || busyTaskId.value) return;
  feedback.confirm({
    title: $t('gainosB4.tasks.archiveConfirmTitle'),
    content: $t('gainosB4.tasks.archiveConfirmContent'),
    okText: $t('gainosB4.tasks.archiveConfirmOk'),
    cancelText: $t('gainos.common.cancel'),
    okType: 'danger',
    onOk: async () => {
      busyTaskId.value = record.id;
      try {
        const updated = await gainosApi.updateTask(record.id, { status: 'archived' });
        tasks.value = tasks.value.map((row) =>
          row.id === record.id
            ? (updated && typeof updated === 'object' && 'id' in updated ? updated : { ...row, status: 'archived' })
            : row,
        );
        feedback.message.success($t('gainosB4.tasks.archivedDone'));
      } catch (err) {
        feedback.message.error(failureText(err).title);
      } finally {
        busyTaskId.value = null;
      }
    },
  });
}

onMounted(() => {
  void ensureLoaded();
  refresh();
});

function latestRun(task: AcquisitionTaskView): TaskRunView | null {
  const runs = [...(task.runs ?? [])].sort((a, b) =>
    String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')),
  );
  return runs[0] ?? null;
}

function runLabel(status?: string | null): string {
  const meta = glossaryStatus('run', status, preferences.app.locale);
  return meta?.label ?? $t('gainos.tasks.noRun');
}

function runBadgeClass(status?: string | null): string {
  const meta = glossaryStatus('run', status, preferences.app.locale);
  return statusClass(meta?.tone ?? 'neutral');
}

function fmtTime(ts?: string | null): string {
  return formatDateTime(ts) || $t('gainos.tasks.never');
}

const columns = computed(() => [
  { key: 'name', dataIndex: 'name', title: $t('gainos.tasks.colTask') },
  { key: 'taskStatus', dataIndex: 'status', title: $t('gainosB4.tasks.colTaskStatus'), width: 120 },
  { key: 'status', dataIndex: 'status', title: $t('gainosB4.tasks.colLatestExecution'), width: 150 },
  { key: 'lastRunAt', dataIndex: 'lastRunAt', title: $t('gainos.tasks.colLastRun'), width: 170 },
  { key: 'actions', dataIndex: 'actions', title: $t('gainos.tasks.colActions'), width: 240 },
]);
</script>

<template>
  <SourcingLayout :loading="loading" :load-error="error" :profiles="icpNameMap" :tasks="tasks" @retry="loadTasks">
    <template #actions>
      <Button @click="refresh">{{ $t('gainos.common.refresh') }}</Button>
    </template>
    <template #rail>
      <nav class="task-management-nav">
        <RouterLink :to="{ name: 'Tasks', query: { tab: 'plan', ...(requestedIcp ? { icp: requestedIcp } : {}) } }">
          {{ $t('gainosBuyerJourney.sourcing.plans') }}
        </RouterLink>
        <RouterLink :to="{ name: 'Tasks', query: { tab: 'manage' } }">{{ $t('gainosBuyerJourney.sourcing.taskManagement') }}</RouterLink>
      </nav>
    </template>

    <section v-if="activeTab === 'plan'" class="tasks-body" data-gs="icp-plans">
      <header class="tasks-header">
        <h2>{{ $t('gainosBuyerJourney.sourcing.plans') }}</h2>
        <RouterLink
          v-if="planProfile"
          :to="{ name: 'FindBuyers', query: { icp: planProfile.id } }"
        >{{ $t('gainosBuyerJourney.sourcing.openProfile') }}</RouterLink>
      </header>
      <div v-if="profilesError" class="tasks-body">
        <ErrorNotice :title="$t('gainosBuyerJourney.sourcing.profileListError')" :next="profilesError.title" />
        <Button class="justify-self-start" @click="loadProfiles">{{ $t('gainos.common.retry') }}</Button>
      </div>
      <Skeleton v-else-if="profilesLoading" active :paragraph="{ rows: 2 }" />
      <template v-else>
        <div class="tasks-form">
          <label v-if="icps.length">
            <span>{{ $t('gainosBuyerJourney.sourcing.selectProfile') }}</span>
            <GsSelect
              :aria-label="$t('gainosBuyerJourney.sourcing.selectProfile')"
              :disabled="planBusy"
              :value="planProfile?.id"
              :options="icps.map((profile) => ({ label: profile.name, value: profile.id }))"
              @change="selectProfile"
            />
          </label>
          <label v-if="plans.length > 1">
            <span>{{ $t('gainosBuyerJourney.sourcing.planHistory') }}</span>
            <GsSelect
              :aria-label="$t('gainosBuyerJourney.sourcing.planHistory')"
              :disabled="planBusy"
              :value="activePlan?.id"
              :options="plans.map((plan) => ({ label: `${$t('gainos.findBuyers.version', { version: plan.version })} · ${fmtTime(plan.createdAt)}`, value: plan.id }))"
              @change="selectPlan"
            />
          </label>
        </div>
        <div v-if="!planProfile" class="tasks-body">
          <p class="tk__muted">{{ $t('gainosBuyerJourney.sourcing.activeProfileRequired') }}</p>
          <RouterLink :to="{ name: 'FindBuyers' }">{{ $t('gainos.findBuyers.title') }}</RouterLink>
        </div>
        <template v-else>
          <p v-if="planProfile.status !== 'ACTIVE'" class="tk__muted">{{ $t('gainosBuyerJourney.sourcing.activeProfileRequired') }}</p>
          <p v-else-if="accessLoaded && !canManage" class="tk__muted">{{ $t('gainosBuyerJourney.profile.notPermitted') }}</p>
          <div v-if="plansError" class="tasks-body">
            <ErrorNotice :title="$t('gainosBuyerJourney.sourcing.planError')" :next="plansError.title" />
            <Button class="justify-self-start" @click="loadPlans(planProfile.id)">{{ $t('gainos.common.retry') }}</Button>
          </div>
          <Skeleton v-else-if="plansLoading" active :paragraph="{ rows: 3 }" />
          <template v-else>
            <ErrorNotice v-if="operationError && !dialog" v-bind="operationError" />
            <Alert
              v-if="route.query.edited === '1' && plans.length"
              :message="$t('gainosBuyerJourney.sourcing.planNeedsRefresh')"
              show-icon
              type="info"
            />
            <QueryPlanSummary v-if="activePlan" :key="activePlan.id" :plan="activePlan" />
            <p v-else class="tk__muted">{{ $t(route.query.plan ? 'gainosBuyerJourney.sourcing.planMissing' : 'gainos.findBuyers.noPlans') }}</p>
            <p v-if="activePlan && pendingLaunch?.planId === activePlan.id" class="tk__muted" role="status">{{ $t('gainosBuyerJourney.sourcing.outcomeUnknown') }}</p>
            <p v-else-if="taskInProgress" class="tk__muted">{{ $t('gainosBuyerJourney.sourcing.progressBlocked') }}</p>
            <p v-else-if="planTask?.status === 'paused'" class="tk__muted">{{ $t('gainosBuyerJourney.sourcing.pausedBlocked') }}</p>
            <div class="tasks-actions">
              <Button
                v-if="canChangePlans"
                :disabled="planBusy"
                :type="activePlan ? 'default' : 'primary'"
                @click="dialog = 'generate'; operationError = null"
              >{{ $t(plans.length ? 'gainos.findBuyers.regeneratePlan' : 'gainosBuyerJourney.sourcing.emptyRunAction') }}</Button>
              <Button
                v-if="canChangePlans && activePlan?.status === 'DRAFT'"
                :loading="planBusy"
                type="primary"
                @click="confirmPlan"
              >{{ $t('gainos.findBuyers.confirmPlan') }}</Button>
              <Button
                v-if="canChangePlans && activePlan && ['READY', 'EXECUTED'].includes(activePlan.status)"
                :disabled="!canLaunch || planBusy"
                type="primary"
                @click="dialog = 'launch'; operationError = null"
              >{{ launchLabel }}</Button>
              <RouterLink v-if="planRun" class="tk__link" :to="taskRunLocation(planRun.task, planRun.run)">{{ $t('gainosBuyerJourney.profile.seeLast') }}</RouterLink>
              <RouterLink v-if="planTask" class="tk__link" :to="{ name: 'TaskDetail', params: { taskId: planTask.id } }">{{ $t('gainosBuyerJourney.sourcing.thisPlanManaged') }}</RouterLink>
            </div>
          </template>
        </template>
      </template>
    </section>
    <section v-else-if="activeTab === 'manage'" class="tasks-body">
      <h2>{{ $t('gainosBuyerJourney.sourcing.taskManagement') }}</h2>
      <AsyncSection
        :loading="loading"
        :error="error"
        :empty="!loading && !error && tasks.length === 0"
        :loading-text="$t('gainos.common.loading')"
        :retry-text="$t('gainos.common.retry')"
        @retry="loadTasks"
      >
        <template #empty><p class="tk__muted">{{ $t('gainosBuyerJourney.sourcing.noTasks') }}</p></template>
      <Table
        :columns="columns"
        :data-source="tasks"
        :loading="false"
        :pagination="false"
        :scroll="{ x: 820 }"
        row-key="id"
        size="middle"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <RouterLink class="tk__link" :to="{ name: 'TaskDetail', params: { taskId: record.id } }">
              <strong>{{ record.name }}</strong>
            </RouterLink>
            <div class="tk__muted">
              {{ icpLabel(record.icpId) }}
            </div>
          </template>
          <template v-else-if="column.key === 'taskStatus'">
            <span class="gs-badge" :class="taskStatusBadgeClass(record.status)" data-gs="task-row-status">
              {{ taskStatusLabel(record.status) }}
            </span>
          </template>
          <template v-else-if="column.key === 'status'">
            <span v-if="latestRun(record as AcquisitionTaskView)" class="gs-badge" :class="runBadgeClass(latestRun(record as AcquisitionTaskView)!.status)">
              {{ runLabel(latestRun(record as AcquisitionTaskView)!.status) }}
            </span>
            <span v-else class="tk__muted">{{ $t('gainos.tasks.noRun') }}</span>
          </template>
          <template v-else-if="column.key === 'lastRunAt'">
            {{ fmtTime(record.lastRunAt) }}
          </template>
          <template v-else-if="column.key === 'actions'">
            <Space :size="8" wrap>
              <RouterLink
                v-if="latestRun(record as AcquisitionTaskView)?.runId"
                class="tk__link"
                :to="`/runs/${latestRun(record as AcquisitionTaskView)!.runId}`"
              >
                {{ $t('gainosBuyerJourney.sourcing.resultReady') }}
              </RouterLink>
              <Button
                v-if="canManage && record.status !== 'archived'"
                :loading="busyTaskId === record.id"
                data-gs="task-row-toggle-pause"
                size="small"
                @click="toggleTaskPause(record as AcquisitionTaskView)"
              >
                {{ record.status === 'paused' ? $t('gainosB4.tasks.resume') : $t('gainosB4.tasks.pause') }}
              </Button>
              <Button
                v-if="canManage && record.status !== 'archived'"
                :disabled="busyTaskId === record.id"
                danger
                data-gs="task-row-archive"
                size="small"
                @click="archiveTask(record as AcquisitionTaskView)"
              >
                {{ $t('gainosB4.tasks.archive') }}
              </Button>
            </Space>
          </template>
        </template>
      </Table>
      </AsyncSection>
    </section>
    <section v-else class="tasks-body">
      <template v-if="newestRun && !error && !loading">
        <h2>{{ newestRun.task.name }}</h2>
        <p class="tk__muted">{{ runLabel(newestRun.run.status) }} · {{ fmtTime(newestRun.run.startedAt) }}</p>
        <RouterLink class="tk__link" :to="taskRunLocation(newestRun.task, newestRun.run)">{{ $t('gainosBuyerJourney.profile.seeLast') }}</RouterLink>
      </template>
      <template v-else-if="!error && !loading">
        <h2>{{ $t('gainos.findBuyers.noRuns') }}</h2>
        <RouterLink v-if="activeProfiles[0]" class="tk__link" :to="sourcingPlansLocation(activeProfiles[0].id)">{{ $t('gainosBuyerJourney.sourcing.emptyRunAction') }}</RouterLink>
        <RouterLink v-else class="tk__link" :to="{ name: 'FindBuyers' }">{{ $t('gainos.findBuyers.title') }}</RouterLink>
      </template>
      <h2 v-else>{{ $t('gainosBuyerJourney.sourcing.chooseRun') }}</h2>
    </section>

    <Modal
      :open="Boolean(dialog)"
      :title="$t(dialog === 'generate' ? 'gainosBuyerJourney.sourcing.generateConfirmTitle' : activePlan?.status === 'EXECUTED' ? 'gainosBuyerJourney.sourcing.retryTitle' : 'gainosBuyerJourney.sourcing.startTitle')"
      :ok-text="dialog === 'generate' ? $t('gainosBuyerJourney.sourcing.emptyRunAction') : launchLabel"
      :cancel-text="$t('gainos.common.cancel')"
      :confirm-loading="planBusy"
      :closable="!planBusy"
      :mask-closable="!planBusy"
      :keyboard="!planBusy"
      @cancel="cancelDialog"
      @ok="dialog === 'generate' ? generatePlan() : launchPlan()"
    >
      <div class="tasks-body">
        <p>{{ $t(dialog === 'generate' ? 'gainosBuyerJourney.sourcing.generateConfirm' : activePlan?.status === 'EXECUTED' ? 'gainosBuyerJourney.sourcing.retryBilling' : 'gainosBuyerJourney.sourcing.startBilling') }}</p>
        <RouterLink v-if="dialog === 'launch'" class="tk__link" :to="{ path: '/settings/account', hash: '#wallet' }">{{ $t('gainosBuyerJourney.sourcing.wallet') }}</RouterLink>
        <ErrorNotice v-if="operationError" v-bind="operationError" />
      </div>
    </Modal>
  </SourcingLayout>
</template>

<style scoped>
.tasks-body { display: grid; align-content: start; gap: 12px; min-width: 0; overflow-wrap: anywhere; }
.tasks-body h2 { margin: 0; color: var(--gs-fg); font-size: 19px; font-weight: 600; }
.tasks-body p { margin: 0; }
.tasks-header, .tasks-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
.tasks-header { justify-content: space-between; }
.tasks-actions { justify-content: flex-end; padding-top: 10px; border-top: 1px solid var(--gs-border); }
.tasks-form { display: flex; flex-wrap: wrap; gap: 8px 14px; }
.tasks-form label { display: grid; min-width: min(100%, 210px); gap: 4px; color: var(--gs-fg-muted); }
.task-management-nav { display: grid; gap: 4px; }
.task-management-nav a { display: inline-flex; align-items: center; min-height: 40px; color: var(--gs-accent-fg); }
.tk__muted { color: var(--gs-fg-subtle); font-size: 13px; }
.tk__link { color: var(--gs-accent-fg); font-weight: 600; text-decoration: none; }
.tk__link:hover { text-decoration: underline; }
</style>
