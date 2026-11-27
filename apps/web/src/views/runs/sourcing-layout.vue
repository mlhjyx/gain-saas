<script lang="ts" setup>
import type { AcquisitionTaskView } from '#/api/gainos';

import { computed } from 'vue';

import { formatDateTime, glossaryStatus } from '@gain-saas/shared';
import { ChevronRight, Search } from '@vben/icons';
import { preferences } from '@vben/preferences';

import { Button } from 'ant-design-vue';

import ErrorNotice from '#/components/error-notice.vue';
import GsPage from '#/components/gainos/ui/gs-page.vue';
import { $t } from '#/locales';

import { recentTaskRuns, taskRunLocation } from './sourcing-navigation';

const props = defineProps<{
  activeRunId?: string;
  loading: boolean;
  loadError?: { next?: string; title: string } | null;
  profiles?: Map<string, string>;
  tasks: AcquisitionTaskView[];
}>();
defineEmits<{ retry: [] }>();

const MAX_RECENT_RUNS = 12;
const runs = computed(() => recentTaskRuns(props.tasks).slice(0, MAX_RECENT_RUNS));

function runLabel(status: string): string {
  return glossaryStatus('run', status, preferences.app.locale)?.label ??
    $t(status === 'QUEUED' ? 'gainosBuyerJourney.sourcing.queued' : 'gainosBuyerJourney.sourcing.unknownStatus');
}
</script>

<template>
  <div class="sourcing" data-gs="sourcing-workspace">
    <GsPage :title="$t('gainosBuyerJourney.sourcing.title')">
      <template #actions>
        <slot name="actions" />
      </template>
    </GsPage>
    <div class="sourcing-frame">
      <aside class="sourcing-rail" :aria-label="$t('gainosBuyerJourney.sourcing.recentRuns')">
        <h2>{{ $t('gainosBuyerJourney.sourcing.recentRuns') }}</h2>
        <p v-if="loading" class="sourcing-muted" role="status">{{ $t('gainos.common.loading') }}</p>
        <div v-else-if="loadError" class="sourcing-history-error">
          <ErrorNotice :title="$t('gainosBuyerJourney.sourcing.historyError')" :next="loadError.title" />
          <Button size="small" @click="$emit('retry')">{{ $t('gainos.common.retry') }}</Button>
        </div>
        <p v-else-if="!runs.length" class="sourcing-muted">{{ $t('gainos.findBuyers.noRuns') }}</p>
        <ul v-else>
          <li v-for="{ run, task } in runs" :key="run.id">
            <RouterLink
              :aria-current="run.runId && run.runId === activeRunId ? 'page' : undefined"
              class="sourcing-run-link"
              :to="taskRunLocation(task, run)"
            >
              <span class="sourcing-run-icon"><Search :size="17" aria-hidden="true" /></span>
              <span class="sourcing-run-label">
                <strong>{{ (task.icpId && profiles?.get(task.icpId)) || task.name }}</strong>
                <small>{{ runLabel(run.status) }}<template v-if="run.startedAt"> · {{ formatDateTime(run.startedAt) }}</template></small>
              </span>
              <ChevronRight :size="15" aria-hidden="true" />
            </RouterLink>
          </li>
        </ul>
        <div v-if="$slots.rail" class="sourcing-rail-actions"><slot name="rail" /></div>
      </aside>
      <div class="sourcing-body">
        <slot />
      </div>
    </div>
  </div>
</template>

<style scoped>
.sourcing {
  display: grid;
  gap: 18px;
  max-width: 1440px;
  margin-inline: auto;
  padding: 0 clamp(16px, 3vw, 40px) 32px;
}
.sourcing-frame {
  display: grid;
  grid-template-columns: minmax(185px, 22%) minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--gs-border);
  border-radius: 14px;
  background: var(--gs-surface);
}
.sourcing-rail {
  min-width: 0;
  padding: 15px 10px;
  border-inline-end: 1px solid var(--gs-border);
  background: var(--gs-surface-3);
}
.sourcing-rail h2 {
  margin: 0 8px 12px;
  color: var(--gs-fg-muted);
  font-size: 13px;
  font-weight: 600;
}
.sourcing-rail ul {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.sourcing-rail-actions { margin: 12px 8px 0; }
.sourcing-history-error { display: grid; gap: 8px; justify-items: start; }
.sourcing-muted { margin: 8px; color: var(--gs-fg-muted); font-size: 13px; }
.sourcing-run-link {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  min-height: 50px;
  gap: 8px;
  padding: 8px;
  border-radius: 8px;
  color: var(--gs-fg);
}
.sourcing-run-link:hover { background: var(--gs-surface-2); }
.sourcing-run-link[aria-current] { background: var(--gs-accent-soft); color: var(--gs-accent-fg); }
.sourcing-run-link:focus-visible { outline: 2px solid var(--gs-accent); outline-offset: -2px; }
.sourcing-run-icon {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border-radius: 7px;
  background: var(--gs-surface-2);
  color: var(--gs-fg-muted);
}
.sourcing-run-label { display: grid; gap: 3px; overflow-wrap: anywhere; }
.sourcing-run-label strong { font-size: 13px; font-weight: 600; }
.sourcing-run-label small { color: var(--gs-fg-muted); font-size: 11px; }
.sourcing-body { min-width: 0; padding: clamp(14px, 2vw, 28px); }
@media (max-width: 760px) {
  .sourcing-frame { grid-template-columns: minmax(0, 1fr); }
  .sourcing-rail { border-inline-end: 0; border-bottom: 1px solid var(--gs-border); }
  .sourcing-rail ul { display: flex; overflow-x: auto; }
  .sourcing-rail li { flex: 0 0 auto; max-width: 230px; }
}
</style>
