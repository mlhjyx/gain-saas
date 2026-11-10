<script lang="ts" setup>
import type { AcquisitionTaskView, TaskRunView } from '#/api/gainos';

import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { Button, Table } from 'ant-design-vue';

import { formatDateTime, glossaryStatus, statusClass } from '@gain-saas/shared';

import { $t } from '#/locales';

import AsyncSection from '#/components/gainos/async-section.vue';
import PageContainer from '#/components/gainos/page-container.vue';
import PageHeader from '#/components/gainos/page-header.vue';

import { failureText, gainosApi } from '#/api/gainos';

/**
 * 任务列表（Q32：任务为导航主轴）。
 * 一个任务按计划挖一类客户；run 是任务下的执行记录。列表回答三件事：
 * 这个任务在挖谁、最近一次跑成什么样、去哪里看这次运行。
 */
defineOptions({ name: 'Tasks' });

const router = useRouter();

const tasks = ref<AcquisitionTaskView[]>([]);
const loading = ref(false);
const error = ref<{ title: string; next?: string } | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const data = await gainosApi.acquisitionTasks();
    tasks.value = Array.isArray(data) ? data : [];
  } catch (err) {
    error.value = failureText(err);
    tasks.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function latestRun(task: AcquisitionTaskView): TaskRunView | null {
  const runs = [...(task.runs ?? [])].sort((a, b) =>
    String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')),
  );
  return runs[0] ?? null;
}

function runLabel(status?: string | null): string {
  const meta = glossaryStatus('run', status);
  return meta?.label ?? $t('gainos.tasks.noRun');
}

function runBadgeClass(status?: string | null): string {
  const meta = glossaryStatus('run', status);
  return statusClass(meta?.tone ?? 'neutral');
}

function fmtTime(ts?: string | null): string {
  return formatDateTime(ts) || $t('gainos.tasks.never');
}

const columns = [
  { key: 'name', dataIndex: 'name', title: $t('gainos.tasks.colTask') },
  { key: 'status', dataIndex: 'status', title: $t('gainos.tasks.colStatus'), width: 160 },
  { key: 'lastRunAt', dataIndex: 'lastRunAt', title: $t('gainos.tasks.colLastRun'), width: 180 },
  { key: 'actions', dataIndex: 'actions', title: $t('gainos.tasks.colActions'), width: 140 },
];
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
        <p>{{ $t('gainos.tasks.empty') }}</p>
        <Button type="primary" @click="router.push('/find-buyers')">
          {{ $t('gainos.tasks.emptyCta') }}
        </Button>
      </template>
      <Table
        :columns="columns"
        :data-source="tasks"
        :loading="false"
        :pagination="false"
        :scroll="{ x: 640 }"
        row-key="id"
        size="middle"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <RouterLink class="tk__link" :to="{ name: 'TaskDetail', params: { taskId: record.id } }">
              <strong>{{ record.name }}</strong>
            </RouterLink>
            <div class="tk__muted">
              {{ record.icpId ? `${$t('gainos.runs.icp')} ${record.icpId.slice(0, 8)}` : '—' }}
            </div>
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
            <RouterLink
              v-if="latestRun(record as AcquisitionTaskView)?.runId"
              class="tk__link"
              :to="`/runs/${latestRun(record as AcquisitionTaskView)!.runId}`"
            >
              {{ $t('gainos.tasks.viewRun') }}
            </RouterLink>
            <span v-else class="tk__muted">—</span>
          </template>
        </template>
      </Table>
    </AsyncSection>
  </PageContainer>
</template>

<style scoped>
.tk__muted { color: var(--gs-fg-subtle); font-size: 13px; }
.tk__link { color: var(--gs-accent-strong); font-weight: 600; text-decoration: none; }
.tk__link:hover { text-decoration: underline; }
</style>
