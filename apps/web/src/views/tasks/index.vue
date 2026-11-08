<script lang="ts" setup>
import type { AcquisitionTaskView, TaskRunView } from '#/api/gainos';

import { onMounted, ref } from 'vue';

import { formatDateTime, glossaryStatus, statusClass } from '@gain-saas/shared';

import { $t } from '#/locales';

import AsyncSection from '#/components/gainos/async-section.vue';
import PageHeader from '#/components/gainos/page-header.vue';

import { failureText, gainosApi } from '#/api/gainos';

/**
 * 任务列表（Q32：任务为导航主轴）。
 * 一个任务按计划挖一类客户；run 是任务下的执行记录。列表回答三件事：
 * 这个任务在挖谁、最近一次跑成什么样、去哪里看这次运行。
 */
defineOptions({ name: 'Tasks' });

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
  const meta = glossaryStatus('engine', status);
  return meta?.label ?? $t('gainos.tasks.noRun');
}

function runBadgeClass(status?: string | null): string {
  const meta = glossaryStatus('engine', status);
  return statusClass(meta?.tone ?? 'neutral');
}

function fmtTime(ts?: string | null): string {
  return formatDateTime(ts) || $t('gainos.tasks.never');
}
</script>

<template>
  <div class="tk">
    <PageHeader :title="$t('gainos.tasks.title')" :subtitle="$t('gainos.tasks.subtitle')">
      <template #actions>
        <button class="tk__refresh" type="button" @click="load">
          {{ $t('gainos.common.refresh') }}
        </button>
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
        <router-link class="tk__cta" to="/find-buyers">{{ $t('gainos.tasks.emptyCta') }}</router-link>
      </template>
    <table class="tk__table">
      <thead>
        <tr>
          <th>{{ $t('gainos.tasks.colTask') }}</th>
          <th>{{ $t('gainos.tasks.colStatus') }}</th>
          <th>{{ $t('gainos.tasks.colLastRun') }}</th>
          <th>{{ $t('gainos.tasks.colActions') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="task in tasks" :key="task.id">
          <td>
            <RouterLink class="tk__link" :to="{ name: 'TaskDetail', params: { taskId: task.id } }">
              <strong>{{ task.name }}</strong>
            </RouterLink>
            <br />
            <small class="tk__muted">
              {{ task.icpId ? `${$t('gainos.runs.icp')} ${task.icpId.slice(0, 8)}` : '—' }}
            </small>
          </td>
          <td>
            <span v-if="latestRun(task)" class="gs-badge" :class="runBadgeClass(latestRun(task)!.status)">
              {{ runLabel(latestRun(task)!.status) }}
            </span>
            <span v-else class="tk__muted">{{ $t('gainos.tasks.noRun') }}</span>
          </td>
          <td>{{ fmtTime(task.lastRunAt) }}</td>
          <td>
            <router-link
              v-if="latestRun(task)?.runId"
              class="tk__link"
              :to="`/runs/${latestRun(task)!.runId}`"
            >
              {{ $t('gainos.tasks.viewRun') }}
            </router-link>
            <span v-else class="tk__muted">—</span>
          </td>
        </tr>
      </tbody>
    </table>
    </AsyncSection>
  </div>
</template>

<style scoped>
.tk {
  padding: clamp(18px, 2.4vw, 32px) clamp(18px, 2.4vw, 34px) clamp(32px, 4vh, 48px);
  max-width: 1280px;
  margin: 0 auto;
  display: grid;
  gap: 16px;
}
.tk__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.tk__head h1 { margin: 0; font-size: 24px; font-weight: 700; color: var(--gs-fg); }
.tk__sub { margin: 6px 0 0; font-size: 13.5px; line-height: 1.7; color: var(--gs-fg-muted); max-width: 680px; }
.tk__refresh {
  flex: none; border: 1px solid var(--gs-border-strong); background: var(--gs-surface);
  border-radius: 10px; padding: 8px 16px; font-size: 13px; color: var(--gs-fg-2); cursor: pointer;
}
.tk__muted { color: var(--gs-fg-subtle); font-size: 13px; }
.tk__error {
  border: 1px solid var(--gs-danger-border); background: var(--gs-danger-bg);
  border-radius: 12px; padding: 16px; display: grid; gap: 8px; color: var(--gs-danger);
}
.tk__error button {
  justify-self: start; border: 1px solid var(--gs-danger-border); background: var(--gs-surface);
  border-radius: 8px; padding: 6px 14px; cursor: pointer; color: var(--gs-danger);
}
.tk__empty {
  border: 1px dashed var(--gs-border-dashed); border-radius: 16px; background: var(--gs-surface);
  padding: 48px 24px; display: grid; place-items: center; gap: 12px; color: var(--gs-fg-muted);
}
.tk__cta {
  background: var(--gs-accent-cta); color: var(--gs-accent-cta-fg); text-decoration: none;
  border-radius: 10px; padding: 10px 18px; font-size: 13.5px; font-weight: 600;
}
.tk__table { width: 100%; border-collapse: collapse; background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px; overflow: hidden; }
.tk__table th {
  text-align: left; font-size: 12px; font-weight: 600; color: var(--gs-fg-muted);
  background: var(--gs-surface-2); padding: 10px 14px; border-bottom: 1px solid var(--gs-border);
}
.tk__table td { padding: 12px 14px; border-bottom: 1px solid var(--gs-divider); font-size: 13.5px; color: var(--gs-fg-2); vertical-align: top; }
.tk__table tr:last-child td { border-bottom: none; }
.tk__link { color: var(--gs-accent-strong); font-weight: 600; text-decoration: none; }
.tk__link:hover { text-decoration: underline; }
</style>
