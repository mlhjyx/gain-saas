<script lang="ts" setup>
import type { AcquisitionTaskView, Icp, TaskRunView } from '#/api/gainos';

import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { Button, Space, Table } from 'ant-design-vue';

import { formatDateTime, glossaryStatus, statusClass } from '@gain-saas/shared';
import { preferences } from '@vben/preferences';

import { $t } from '#/locales';

import AsyncSection from '#/components/gainos/async-section.vue';
import EmptyState from '#/components/gainos/empty-state.vue';
import PageContainer from '#/components/gainos/page-container.vue';
import PageHeader from '#/components/gainos/page-header.vue';

import { failureText, gainosApi } from '#/api/gainos';
import { feedback } from '#/feedback';

/**
 * 任务列表（Q32 + Wave B4）：
 * 同步展示任务状态徽标（active / paused / archived）与最近执行状态，支持快捷暂停/恢复/归档。
 */
defineOptions({ name: 'Tasks' });

const router = useRouter();

const tasks = ref<AcquisitionTaskView[]>([]);
const icps = ref<Icp[]>([]);
const loading = ref(false);
const error = ref<{ title: string; next?: string } | null>(null);
const busyTaskId = ref<string | null>(null);

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

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const [data, icpList] = await Promise.all([
      gainosApi.acquisitionTasks(),
      gainosApi.icps().catch(() => [] as Icp[]),
    ]);
    tasks.value = Array.isArray(data) ? data : [];
    icps.value = Array.isArray(icpList) ? icpList : [];
  } catch (err) {
    error.value = failureText(err);
    tasks.value = [];
  } finally {
    loading.value = false;
  }
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

onMounted(load);

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
  <PageContainer>
    <PageHeader :title="$t('gainos.tasks.title')" :subtitle="$t('gainos.tasks.subtitle')">
      <template #actions>
        <Button :loading="loading" @click="load">
          {{ $t('gainos.common.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <AsyncSection
      :loading="loading"
      :error="error"
      :empty="!loading && !error && tasks.length === 0"
      :loading-text="$t('gainos.common.loading')"
      :retry-text="$t('gainos.common.retry')"
      @retry="load"
    >
      <template #empty>
        <EmptyState :title="$t('gainos.tasks.empty')">
          <template #actions>
            <Button type="primary" @click="router.push('/find-buyers')">
              {{ $t('gainos.tasks.emptyCta') }}
            </Button>
            <Button @click="router.push('/leads')">
              {{ $t('gainos.leads.title') }}
            </Button>
            <Button @click="router.push('/companies')">
              {{ $t('gainos.companies.title') }}
            </Button>
          </template>
        </EmptyState>
      </template>
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
                {{ $t('gainos.tasks.viewRun') }}
              </RouterLink>
              <Button
                v-if="record.status !== 'archived'"
                :loading="busyTaskId === record.id"
                data-gs="task-row-toggle-pause"
                size="small"
                @click="toggleTaskPause(record as AcquisitionTaskView)"
              >
                {{ record.status === 'paused' ? $t('gainosB4.tasks.resume') : $t('gainosB4.tasks.pause') }}
              </Button>
              <Button
                v-if="record.status !== 'archived'"
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
  </PageContainer>
</template>

<style scoped>
.tk__muted { color: var(--gs-fg-subtle); font-size: 13px; }
.tk__link { color: var(--gs-accent-fg); font-weight: 600; text-decoration: none; }
.tk__link:hover { text-decoration: underline; }
</style>
