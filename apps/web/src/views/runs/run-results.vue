<script lang="ts" setup>
import type { DiscoveryRunResultView } from '#/api/gainos';

import { computed } from 'vue';

import { formatDateTime } from '@gain-saas/shared';
import { ChevronRight } from '@vben/icons';

import { Alert, Button } from 'ant-design-vue';

import ErrorNotice from '#/components/error-notice.vue';
import { $t } from '#/locales';
import { regionName } from '#/utils/region-name';
import { displayLeadScore } from '#/views/leads/judge';

import { isRunInProgress } from './sourcing-navigation';

const props = defineProps<{
  error: boolean;
  loading: boolean;
  result: DiscoveryRunResultView | null;
  status: string;
}>();
defineEmits<{ retry: [] }>();

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function byCompany(items: Record<string, unknown>[] | undefined) {
  return new Map((items ?? []).map((item) => [text(item.companyId), item]));
}

const thisRun = computed(() => props.result?.scoring.thisRun);
const rows = computed(() => {
  if (!props.result) return [];
  const local = byCompany(thisRun.value?.label === 'this_run' && thisRun.value.available ? thisRun.value.items : []);
  const latest = byCompany(props.result.scoring.latest.items);
  return props.result.candidates.items.map((candidate, index) => {
    const companyId = text(candidate.companyId);
    const scored = companyId ? local.get(companyId) : undefined;
    const current = companyId ? latest.get(companyId) : undefined;
    const stage = text(candidate.stage);
    const stageKey = `gainos.runs.jobStage.${stage}`;
    const stageLabel = $t(stageKey);
    return {
      country: regionName(text(candidate.country)),
      id: companyId || index,
      latestScore: displayLeadScore(current?.totalScore),
      latestScoredAt: formatDateTime(text(current?.scoredAt)),
      leadId: text(scored?.leadId),
      name: text(candidate.name) || text(candidate.domain) || $t('gainosBuyerJourney.results.unknownCompany'),
      score: displayLeadScore(scored?.totalScore),
      stage: stageLabel === stageKey ? '' : stageLabel,
    };
  });
});
const hasLatestScores = computed(() => rows.value.some((row) => row.latestScore !== null));
const status = computed(() => props.result?.status || props.status);
const emptyMessage = computed(() => {
  if (isRunInProgress(status.value)) return $t('gainosBuyerJourney.results.runningEmpty');
  if (status.value === 'FAILED') return $t('gainosBuyerJourney.results.failedEmpty');
  if (status.value === 'CANCELLED') return $t('gainosBuyerJourney.results.stoppedEmpty');
  return $t('gainosBuyerJourney.results.empty');
});
</script>

<template>
  <section class="sourcing-results" data-gs="run-result-view">
    <h3>{{ $t('gainosBuyerJourney.results.title') }}</h3>
    <div v-if="error" class="sourcing-results">
      <ErrorNotice :title="$t('gainosBuyerJourney.results.readError')" />
      <Button class="justify-self-start" size="small" @click="$emit('retry')">{{ $t('gainos.common.retry') }}</Button>
    </div>
    <p v-if="loading && !result" class="result-muted" role="status">{{ $t('gainos.common.loading') }}</p>
    <template v-if="result">
      <Alert
        v-if="status === 'PARTIAL' || (rows.length && ['FAILED', 'CANCELLED'].includes(status))"
        :message="$t(`gainosBuyerJourney.results.outcome.${status}`)"
        show-icon
        type="warning"
      />
      <p v-if="result.candidates.truncated" class="result-muted">
        {{ $t('gainosBuyerJourney.results.truncated', { displayed: rows.length, total: result.candidates.total }) }}
      </p>
      <p v-else-if="rows.length" class="result-muted">
        {{ $t('gainosBuyerJourney.results.count', { count: rows.length }) }}
      </p>
      <p v-if="!rows.length" class="result-muted" role="status">{{ emptyMessage }}</p>
      <template v-else>
        <p v-if="thisRun?.truncated" class="result-muted">{{ $t('gainosBuyerJourney.results.scoreTruncated') }}</p>
        <p v-if="thisRun?.available" class="result-muted">
          {{ $t('gainosB4.runs.resultViewScored', { count: thisRun.scoredCompanies ?? thisRun.items.length, batches: thisRun.batches }) }}
          <template v-if="thisRun.scoredAt"> · {{ formatDateTime(thisRun.scoredAt) }}</template>
        </p>
        <table class="result-table">
          <thead>
            <tr>
              <th scope="col">{{ $t('gainosBuyerJourney.results.company') }}</th>
              <th scope="col">{{ $t('gainosBuyerJourney.results.thisScore') }}</th>
              <th v-if="hasLatestScores" scope="col">
                {{ $t('gainosBuyerJourney.results.latestScore') }}
                <span class="result-meta">{{ $t('gainosBuyerJourney.results.latestScope') }}</span>
              </th>
              <th scope="col">{{ $t('gainosBuyerJourney.results.lead') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id" data-gs="run-result-row">
              <th scope="row">
                <strong>{{ row.name }}</strong>
                <span v-if="row.country || row.stage" class="result-meta">
                  {{ [row.country, row.stage].filter(Boolean).join(' · ') }}
                </span>
              </th>
              <td>
                <span v-if="row.score !== null">{{ row.score }}</span>
                <span v-else class="result-muted">{{ $t('gainosBuyerJourney.results.noThisScore') }}</span>
              </td>
              <td v-if="hasLatestScores">
                <template v-if="row.latestScore !== null">
                  <span>{{ row.latestScore }}</span>
                  <span v-if="row.latestScoredAt" class="result-meta">{{ row.latestScoredAt }}</span>
                </template>
                <span v-else class="result-muted">—</span>
              </td>
              <td>
                <RouterLink
                  v-if="row.leadId"
                  :aria-label="$t('gainosBuyerJourney.results.openNamedLead', { name: row.name })"
                  class="result-link"
                  :to="{ name: 'LeadDetail', params: { leadId: row.leadId }, query: { icp: result.icpId, run: result.runId } }"
                >
                  {{ $t('gainosBuyerJourney.results.openLead') }} <ChevronRight :size="15" aria-hidden="true" />
                </RouterLink>
                <span v-else class="result-muted">{{ $t('gainosBuyerJourney.results.noLeadLink') }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </template>
    </template>
  </section>
</template>

<style scoped>
.sourcing-results { display: grid; gap: 10px; }
.sourcing-results h3 { margin: 0; font-size: 16px; font-weight: 600; }
.result-muted, .result-meta { margin: 0; color: var(--gs-fg-muted); font-size: 12px; }
.result-meta { display: block; margin-top: 3px; line-height: 1.35; }
.result-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.result-table thead { border-top: 1px solid var(--gs-divider); }
.result-table tr { border-bottom: 1px solid var(--gs-divider); }
.result-table th, .result-table td {
  padding: 10px 8px;
  text-align: start;
  overflow-wrap: anywhere;
}
.result-table th:first-child, .result-table td:first-child { width: 40%; padding-inline-start: 0; }
.result-table thead th { color: var(--gs-fg-muted); font-size: 12px; font-weight: 500; }
.result-table tbody th { font-size: 14px; }
.result-table tbody td { font-variant-numeric: tabular-nums; }
.result-link {
  display: inline-flex;
  min-height: 40px;
  align-items: center;
  gap: 4px;
  color: var(--gs-accent-fg);
  font-weight: 600;
}
.result-link svg { flex: none; }
@media (max-width: 560px) {
  .result-table th, .result-table td { padding: 7px 4px; font-size: 11px; }
  .result-table th:first-child, .result-table td:first-child { width: 34%; }
  .result-table tbody th { font-size: 12px; }
  .result-link { align-items: flex-start; }
  .result-link svg { display: none; }
}
</style>
