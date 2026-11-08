<script lang="ts" setup>
/**
 * 任务详情（v3.0 ch07 P5b-06 收尾）：/tasks/:taskId
 * 回答三件事：这个任务在挖谁、历史每次跑成什么样、失败后怎么重试。
 * 数据来自 /tasks 列表（引擎暂无单任务端点），重试走任务级 attempt 语义。
 */
import type { AcquisitionTaskView, TaskRunView } from '#/api/gainos';

import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { preferences } from '@vben/preferences';

import { $t } from '#/locales';

import { formatDateTime, glossaryStatus, statusClass } from '@gain-saas/shared';

import AsyncSection from '#/components/gainos/async-section.vue';
import PageHeader from '#/components/gainos/page-header.vue';

import { failureText, gainosApi } from '#/api/gainos';

defineOptions({ name: 'TaskDetail' });

const route = useRoute();
const router = useRouter();
const taskId = computed(() => String(route.params.taskId ?? ''));

const task = ref<AcquisitionTaskView | null>(null);
const loading = ref(true);
const error = ref<{ next?: string; title: string } | null>(null);
const notice = ref<string | null>(null);
const retrying = ref(false);

const runs = computed<TaskRunView[]>(() =>
  [...(task.value?.runs ?? [])].sort((a, b) =>
    String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')),
  ),
);

const latestRun = computed(() => runs.value[0] ?? null);

const canRetry = computed(() => {
  const run = latestRun.value;
  if (!run) return false;
  return (
    ['FAILED', 'PARTIAL', 'CANCELLED'].includes(run.status) &&
    Boolean(run.planId)
  );
});

function taskStatusLabel(status?: string): string {
  const key = `gainos.tasks.task${(status ?? 'active').replace(/^./, (c) => c.toUpperCase())}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? (status ?? '—') : translated;
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

function mintAttemptId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `attempt-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const tasks = await gainosApi.acquisitionTasks();
    task.value = (tasks ?? []).find((row) => row.id === taskId.value) ?? null;
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

async function retryLatest(): Promise<void> {
  const run = latestRun.value;
  if (!run?.planId || retrying.value) return;
  retrying.value = true;
  notice.value = null;
  try {
    const result = await gainosApi.startAcquisitionTaskRun(
      taskId.value,
      run.planId,
      mintAttemptId(),
    );
    notice.value = $t('gainos.tasks.retryRequested');
    if (result.runId) {
      await router.push({ name: 'DiscoveryRun', params: { runId: result.runId } });
      return;
    }
    await load();
  } catch (err) {
    error.value = failureText(err);
  } finally {
    retrying.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="tkd">
    <PageHeader
      :subtitle="$t('gainos.tasks.detailSubtitle')"
      :title="task?.name ?? $t('gainos.tasks.title')"
    >
      <template #actions>
        <button class="tkd__ghost" type="button" @click="router.push('/tasks')">
          {{ $t('gainos.tasks.backToList') }}
        </button>
        <button
          v-if="canRetry"
          class="tkd__primary"
          type="button"
          :disabled="retrying"
          @click="retryLatest"
        >
          {{ retrying ? $t('gainos.tasks.retrying') : $t('gainos.tasks.retryLast') }}
        </button>
      </template>
    </PageHeader>

    <p v-if="notice" class="tkd__notice" role="status">{{ notice }}</p>

    <AsyncSection
      :error="error"
      :loading="loading"
      :loading-text="$t('gainos.common.loading')"
      :retry-text="$t('gainos.common.retry')"
      @retry="load"
    >
      <template v-if="task">
        <section class="tkd__card">
          <dl class="tkd__facts">
            <dt>{{ $t('gainos.tasks.colStatus') }}</dt>
            <dd>
              <span class="gs-badge" :class="statusClass('neutral')">{{ taskStatusLabel(task.status) }}</span>
            </dd>
            <dt>{{ $t('gainos.tasks.icp') }}</dt>
            <dd>
              <RouterLink v-if="task.icpId" class="tkd__link" to="/find-buyers">
                {{ task.icpId.slice(0, 8) }}
              </RouterLink>
              <span v-else>—</span>
            </dd>
            <dt>{{ $t('gainos.tasks.createdAt') }}</dt>
            <dd>{{ formatDateTime(task.createdAt) || '—' }}</dd>
            <dt>{{ $t('gainos.tasks.colLastRun') }}</dt>
            <dd>{{ formatDateTime(task.lastRunAt) || $t('gainos.tasks.never') }}</dd>
            <dt>{{ $t('gainos.tasks.runsCount') }}</dt>
            <dd>{{ runs.length }}</dd>
          </dl>
        </section>

        <section class="tkd__card">
          <h2>{{ $t('gainos.tasks.runHistory') }}</h2>
          <table v-if="runs.length > 0" class="tkd__table">
            <thead>
              <tr>
                <th>{{ $t('gainos.tasks.colAttempt') }}</th>
                <th>{{ $t('gainos.tasks.colRunStatus') }}</th>
                <th>{{ $t('gainos.tasks.colTrigger') }}</th>
                <th>{{ $t('gainos.tasks.colStarted') }}</th>
                <th>{{ $t('gainos.tasks.colFinished') }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="run in runs" :key="run.id">
                <td>#{{ run.attempt ?? 1 }}</td>
                <td>
                  <span class="gs-badge" :class="runBadgeClass(run.status)">
                    {{ runStatusLabel(run.status) }}
                  </span>
                </td>
                <td>{{ triggerLabel(run.trigger) }}</td>
                <td>{{ formatDateTime(run.startedAt) || '—' }}</td>
                <td>{{ formatDateTime(run.finishedAt) || '—' }}</td>
                <td>
                  <RouterLink
                    v-if="run.runId"
                    class="tkd__link"
                    :to="{ name: 'DiscoveryRun', params: { runId: run.runId } }"
                  >
                    {{ $t('gainos.tasks.viewRun') }}
                  </RouterLink>
                  <span v-else class="tkd__muted">—</span>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else class="tkd__muted">{{ $t('gainos.tasks.noRunYet') }}</p>
        </section>
      </template>
    </AsyncSection>
  </div>
</template>

<style scoped>
.tkd {
  padding: clamp(18px, 2.4vw, 32px) clamp(18px, 2.4vw, 34px) clamp(32px, 4vh, 48px);
  max-width: 1280px;
  margin: 0 auto;
  display: grid;
  gap: 16px;
}
.tkd__ghost,
.tkd__primary {
  border-radius: 10px;
  padding: 8px 16px;
  font-size: 13px;
  cursor: pointer;
}
.tkd__ghost {
  border: 1px solid var(--gs-border-strong);
  background: var(--gs-surface);
  color: var(--gs-fg-2);
}
.tkd__primary {
  border: none;
  background: var(--gs-accent-cta);
  color: var(--gs-accent-cta-fg);
  font-weight: 600;
}
.tkd__primary:disabled {
  opacity: 0.5;
  cursor: default;
}
.tkd__notice {
  margin: 0;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--gs-accent-soft);
  color: var(--gs-accent-strong);
  font-size: 13px;
}
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
.tkd__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.tkd__table th,
.tkd__table td {
  text-align: left;
  padding: 9px 10px;
  border-bottom: 1px solid var(--gs-divider);
}
.tkd__table th {
  font-size: 12px;
  font-weight: 600;
  color: var(--gs-fg-muted);
  background: var(--gs-surface-2);
}
.tkd__table tr:last-child td {
  border-bottom: none;
}
.tkd__link {
  color: var(--gs-accent-strong);
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
