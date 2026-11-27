<script lang="ts" setup>
/**
 * 任务详情（v3.0 ch07 P5b-06 + Wave B4）：/tasks/:taskId
 * 接入 B1 单任务查询 GET /api/tasks/:taskId 与 PATCH /api/tasks/:taskId（改名 / 暂停 / 恢复 / 归档）。
 * 严格遵循 archived 不可逆规则（后端禁止已归档任务恢复、暂停或发起新执行）。
 */
import type { AcquisitionTaskView, Icp, TaskRunView } from '#/api/gainos';

import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { preferences } from '@vben/preferences';

import { Alert, Button, Input, Modal, Space, Table } from 'ant-design-vue';

import { $t } from '#/locales';

import { formatDateTime, glossaryStatus, statusClass } from '@gain-saas/shared';

import AsyncSection from '#/components/gainos/async-section.vue';
import ErrorNotice from '#/components/error-notice.vue';
import PageContainer from '#/components/gainos/page-container.vue';
import PageHeader from '#/components/gainos/page-header.vue';
import { notifyChainChanged } from '#/composables/use-main-chain-progress';
import { useWorkspaceAccess } from '#/composables/use-workspace-access';

import { failureText, gainosApi } from '#/api/gainos';
import { feedback } from '#/feedback';

import { isRunInProgress, mintAttemptId, sourcingPlansLocation, sourcingRunLocation } from '../runs/sourcing-navigation';

defineOptions({ name: 'TaskDetail' });

const route = useRoute();
const router = useRouter();
const taskId = computed(() => String(route.params.taskId ?? ''));
const { can, ensureLoaded } = useWorkspaceAccess();

const task = ref<AcquisitionTaskView | null>(null);
const icps = ref<Icp[]>([]);
const loading = ref(true);
const error = ref<{ next?: string; title: string } | null>(null);
const notice = ref<string | null>(null);
const retrying = ref(false);
const retryDialog = ref(false);
const retryAttemptId = ref<string | null>(null);
const retryError = ref<ReturnType<typeof failureText> | null>(null);
const retryWaiting = ref(false);

const editingName = ref(false);
const nameDraft = ref('');
const nameError = ref('');
const updating = ref(false);

const icpNameMap = computed(() => new Map(icps.value.map((icp) => [icp.id, icp.name])));
const taskIcpName = computed(() => {
  const id = task.value?.icpId;
  if (!id) return '';
  return icpNameMap.value.get(id) || $t('gainosP0.tasks.profileFallback');
});

const isArchived = computed(() => task.value?.status === 'archived');
const isPaused = computed(() => task.value?.status === 'paused');

const runs = computed<TaskRunView[]>(() =>
  [...(task.value?.runs ?? [])].sort((a, b) =>
    String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')),
  ),
);

const latestRun = computed(() => runs.value[0] ?? null);

const canRetry = computed(() => {
  if (loading.value || !can('acquisition.run') || isArchived.value || isPaused.value || retryWaiting.value) return false;
  const run = latestRun.value;
  if (!run) return false;
  return (
    !runs.value.some((entry) => isRunInProgress(entry.status)) &&
    ['FAILED', 'PARTIAL', 'CANCELLED'].includes(run.status) &&
    Boolean(run.planId)
  );
});

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

function runStatusLabel(status?: string): string {
  return glossaryStatus('run', status, preferences.app.locale)?.label ?? status ?? '—';
}

function runBadgeClass(status?: string): string {
  return statusClass(
    glossaryStatus('run', status, preferences.app.locale)?.tone ?? 'neutral',
  );
}

function triggerLabel(trigger?: string): string {
  const key = `gainos.tasks.trigger.${trigger ?? 'manual'}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? (trigger ?? '—') : translated;
}

async function load(): Promise<void> {
  if (!taskId.value) return;
  loading.value = true;
  error.value = null;
  try {
    const [detail, icpList] = await Promise.all([
      gainosApi.getTask(taskId.value),
      gainosApi.icps().catch(() => [] as Icp[]),
    ]);
    icps.value = Array.isArray(icpList) ? icpList : [];
    task.value = detail && typeof detail === 'object' && 'id' in detail ? detail : null;
    if (!task.value) {
      error.value = {
        title: $t('gainos.tasks.notFoundTitle'),
        next: $t('gainos.tasks.notFoundNext'),
      };
    }
  } catch (err) {
    error.value = failureText(err);
    task.value = null;
  } finally {
    loading.value = false;
  }
}

function startRename(): void {
  if (!task.value) return;
  nameDraft.value = task.value.name;
  nameError.value = '';
  editingName.value = true;
}

function cancelRename(): void {
  editingName.value = false;
  nameError.value = '';
}

async function saveRename(): Promise<void> {
  if (!task.value || updating.value) return;
  const trimmed = nameDraft.value.trim();
  if (!trimmed) {
    nameError.value = $t('gainosB4.tasks.renameRequired');
    return;
  }
  if (trimmed === task.value.name) {
    editingName.value = false;
    return;
  }
  updating.value = true;
  nameError.value = '';
  notice.value = null;
  try {
    const updated = await gainosApi.updateTask(task.value.id, { name: trimmed });
    task.value = updated && typeof updated === 'object' && 'id' in updated ? updated : { ...task.value, name: trimmed };
    editingName.value = false;
    notice.value = $t('gainosB4.tasks.renameDone');
    feedback.message.success($t('gainosB4.tasks.renameDone'));
  } catch (err) {
    const fail = failureText(err);
    nameError.value = fail.title;
    feedback.message.error(fail.title);
  } finally {
    updating.value = false;
  }
}

async function togglePause(): Promise<void> {
  if (!task.value || isArchived.value || updating.value) return;
  const nextStatus: 'active' | 'paused' = isPaused.value ? 'active' : 'paused';
  updating.value = true;
  notice.value = null;
  try {
    const updated = await gainosApi.updateTask(task.value.id, { status: nextStatus });
    task.value = updated && typeof updated === 'object' && 'id' in updated ? updated : { ...task.value, status: nextStatus };
    const msg = nextStatus === 'paused' ? $t('gainosB4.tasks.pausedDone') : $t('gainosB4.tasks.resumedDone');
    notice.value = msg;
    feedback.message.success(msg);
  } catch (err) {
    feedback.message.error(failureText(err).title);
  } finally {
    updating.value = false;
  }
}

function confirmArchive(): void {
  if (!task.value || isArchived.value || updating.value) return;
  const targetId = task.value.id;
  feedback.confirm({
    title: $t('gainosB4.tasks.archiveConfirmTitle'),
    content: $t('gainosB4.tasks.archiveConfirmContent'),
    okText: $t('gainosB4.tasks.archiveConfirmOk'),
    cancelText: $t('gainos.common.cancel'),
    okType: 'danger',
    onOk: async () => {
      updating.value = true;
      notice.value = null;
      try {
        const updated = await gainosApi.updateTask(targetId, { status: 'archived' });
        task.value =
          updated && typeof updated === 'object' && 'id' in updated
            ? updated
            : task.value
              ? { ...task.value, status: 'archived' }
              : null;
        editingName.value = false;
        notice.value = $t('gainosB4.tasks.archivedDone');
        feedback.message.success($t('gainosB4.tasks.archivedDone'));
      } catch (err) {
        feedback.message.error(failureText(err).title);
      } finally {
        updating.value = false;
      }
    },
  });
}

async function retryLatest(): Promise<void> {
  const run = latestRun.value;
  const id = taskId.value;
  if (!run?.planId || retrying.value || !canRetry.value) return;
  retrying.value = true;
  notice.value = null;
  retryError.value = null;
  try {
    await load();
    if (!canRetry.value || latestRun.value?.id !== run.id || taskId.value !== id) {
      retryError.value = { title: $t('gainos.runs.retryUnavailable'), why: undefined, next: undefined };
      return;
    }
    retryAttemptId.value ??= mintAttemptId();
    const result = await gainosApi.startAcquisitionTaskRun(
      id,
      run.planId,
      retryAttemptId.value,
    );
    retryDialog.value = false;
    notifyChainChanged();
    if (result.runId) {
      retryAttemptId.value = null;
      await router.push(sourcingRunLocation(result.runId, 'progress'));
      return;
    }
    retryWaiting.value = true;
    notice.value = $t('gainosBuyerJourney.sourcing.outcomeUnknown');
    await load();
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status && status >= 400 && status < 500 && status !== 408) retryAttemptId.value = null;
    retryError.value = failureText(err);
  } finally {
    retrying.value = false;
  }
}

onMounted(() => {
  void ensureLoaded();
  void load();
});
watch(taskId, () => {
  editingName.value = false;
  retryDialog.value = false;
  retryError.value = null;
  retryAttemptId.value = null;
  retryWaiting.value = false;
  void load();
});

const runColumns = computed(() => [
  { key: 'attempt', dataIndex: 'attempt', title: $t('gainos.tasks.colAttempt'), width: 90 },
  { key: 'status', dataIndex: 'status', title: $t('gainos.tasks.colRunStatus'), width: 140 },
  { key: 'trigger', dataIndex: 'trigger', title: $t('gainos.tasks.colTrigger'), width: 110 },
  { key: 'startedAt', dataIndex: 'startedAt', title: $t('gainos.tasks.colStarted'), width: 170 },
  { key: 'finishedAt', dataIndex: 'finishedAt', title: $t('gainos.tasks.colFinished'), width: 170 },
  { key: 'actions', dataIndex: 'actions', title: '', width: 110 },
]);
</script>

<template>
  <PageContainer>
    <PageHeader
      :title="task?.name ?? $t('gainosBuyerJourney.sourcing.taskManagement')"
    >
      <template #actions>
        <Space :size="8" wrap>
          <Button @click="router.push({ name: 'Tasks', query: { tab: 'manage' } })">
            {{ $t('gainos.tasks.backToList') }}
          </Button>
          <RouterLink v-if="task?.icpId" :to="sourcingPlansLocation(task.icpId)" class="td__link">
            {{ $t('gainosBuyerJourney.sourcing.plans') }}
          </RouterLink>
          <Button
            v-if="task && !isArchived && !editingName"
            :disabled="updating"
            data-gs="task-rename-btn"
            @click="startRename"
          >
            {{ $t('gainosB4.tasks.rename') }}
          </Button>
          <Button
            v-if="task && !isArchived"
            :loading="updating"
            data-gs="task-toggle-pause"
            @click="togglePause"
          >
            {{ isPaused ? $t('gainosB4.tasks.resume') : $t('gainosB4.tasks.pause') }}
          </Button>
          <Button
            v-if="task && !isArchived"
            :disabled="updating"
            danger
            data-gs="task-archive-btn"
            @click="confirmArchive"
          >
            {{ $t('gainosB4.tasks.archive') }}
          </Button>
          <Button
            v-if="canRetry"
            type="primary"
            :disabled="retrying"
            :loading="retrying"
            @click="retryDialog = true; retryError = null"
          >
            {{ retrying ? $t('gainos.tasks.retrying') : $t('gainos.tasks.retryLast') }}
          </Button>
        </Space>
      </template>
    </PageHeader>

    <Alert v-if="notice" :message="notice" role="status" show-icon type="success" />
    <Alert
      v-if="task && isArchived"
      :message="$t('gainosB4.tasks.archivedReadonlyHint')"
      data-gs="task-archived-hint"
      show-icon
      type="info"
    />

    <AsyncSection
      :error="error"
      :loading="loading"
      :loading-text="$t('gainos.common.loading')"
      :retry-text="$t('gainos.common.retry')"
      @retry="load"
    >
      <template v-if="task">
        <section v-if="editingName" class="tkd__card" data-gs="task-rename-form">
          <div class="tkd__rename-row">
            <Input
              v-model:value="nameDraft"
              :disabled="updating"
              :maxlength="200"
              :placeholder="$t('gainosB4.tasks.renamePlaceholder')"
              class="flex-1"
              data-gs="task-rename-input"
              @press-enter="saveRename"
            />
            <Button
              :loading="updating"
              data-gs="task-rename-save"
              type="primary"
              @click="saveRename"
            >
              {{ $t('gainosB4.tasks.save') }}
            </Button>
            <Button :disabled="updating" data-gs="task-rename-cancel" @click="cancelRename">
              {{ $t('gainos.common.cancel') }}
            </Button>
          </div>
          <p v-if="nameError" class="tkd__error" role="alert">{{ nameError }}</p>
        </section>

        <section class="tkd__card">
          <dl class="tkd__facts">
            <dt>{{ $t('gainos.tasks.colStatus') }}</dt>
            <dd>
              <span class="gs-badge" :class="taskStatusBadgeClass(task.status)" data-gs="task-status-badge">
                {{ taskStatusLabel(task.status) }}
              </span>
            </dd>
            <dt>{{ $t('gainos.tasks.icp') }}</dt>
            <dd>
              <RouterLink
                v-if="task.icpId"
                class="tkd__link"
                :to="{ name: 'FindBuyers', query: { icp: task.icpId } }"
              >
                {{ taskIcpName }}
              </RouterLink>
              <span v-else>—</span>
            </dd>
            <dt>{{ $t('gainos.tasks.createdAt') }}</dt>
            <dd>{{ formatDateTime(task.createdAt) || '—' }}</dd>
            <dt>{{ $t('gainos.tasks.colLastRun') }}</dt>
            <dd>{{ formatDateTime(task.lastRunAt) || $t('gainos.tasks.never') }}</dd>
            <dt>{{ $t('gainos.tasks.runsCount') }}</dt>
            <dd>{{ task.runCount ?? runs.length }}</dd>
          </dl>
        </section>

        <section class="tkd__card">
          <h2>{{ $t('gainos.tasks.runHistory') }}</h2>
          <Table
            v-if="runs.length > 0"
            :columns="runColumns"
            :data-source="runs"
            :pagination="false"
            :scroll="{ x: 760 }"
            row-key="id"
            size="small"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'attempt'">#{{ record.attempt ?? 1 }}</template>
              <template v-else-if="column.key === 'status'">
                <span class="gs-badge" :class="runBadgeClass(record.status)">
                  {{ runStatusLabel(record.status) }}
                </span>
              </template>
              <template v-else-if="column.key === 'trigger'">{{ triggerLabel(record.trigger) }}</template>
              <template v-else-if="column.key === 'startedAt'">{{ formatDateTime(record.startedAt) || '—' }}</template>
              <template v-else-if="column.key === 'finishedAt'">{{ formatDateTime(record.finishedAt) || '—' }}</template>
              <template v-else-if="column.key === 'actions'">
                <RouterLink
                  v-if="record.runId"
                  class="tkd__link"
                  :to="{ name: 'DiscoveryRun', params: { runId: record.runId } }"
                >
                  {{ $t('gainos.tasks.viewRun') }}
                </RouterLink>
                <span v-else class="tkd__muted">—</span>
              </template>
            </template>
          </Table>
          <p v-else class="tkd__muted">{{ $t('gainos.tasks.noRunYet') }}</p>
        </section>
      </template>
    </AsyncSection>
    <Modal
      :open="retryDialog"
      :title="$t('gainosBuyerJourney.sourcing.retryTitle')"
      :ok-text="$t('gainosBuyerJourney.sourcing.restart')"
      :cancel-text="$t('gainos.common.cancel')"
      :confirm-loading="retrying"
      :closable="!retrying"
      :mask-closable="!retrying"
      :keyboard="!retrying"
      @cancel="!retrying && (retryDialog = false)"
      @ok="retryLatest"
    >
      <p>{{ $t('gainosBuyerJourney.sourcing.retryBilling') }}</p>
      <RouterLink class="td__link" :to="{ path: '/settings/account', hash: '#wallet' }">{{ $t('gainosBuyerJourney.sourcing.wallet') }}</RouterLink>
      <ErrorNotice v-if="retryError" v-bind="retryError" />
    </Modal>
  </PageContainer>
</template>

<style scoped>
.tkd__card {
  border: 1px solid var(--gs-border);
  border-radius: 14px;
  background: var(--gs-surface);
  padding: 16px 18px;
  display: grid;
  gap: 12px;
}
.tkd__card h2 {
  margin: 0;
  font-size: 14.5px;
  font-weight: 650;
  color: var(--gs-fg);
}
.tkd__rename-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.tkd__error {
  margin: 0;
  font-size: 12.5px;
  color: var(--gs-danger-fg);
}
.tkd__facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 8px 16px;
  margin: 0;
  font-size: 13px;
}
.tkd__facts dt {
  color: var(--gs-fg-muted);
}
.tkd__facts dd {
  margin: 0;
  color: var(--gs-fg-2);
}
.tkd__link {
  color: var(--gs-accent-fg);
  font-weight: 600;
  text-decoration: none;
}
.tkd__link:hover {
  text-decoration: underline;
}
.tkd__muted {
  color: var(--gs-fg-subtle);
  font-size: 12.5px;
  margin: 0;
}
</style>
