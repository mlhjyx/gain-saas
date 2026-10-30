<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { $t } from '#/locales';

import { failureText, gainosApi, type DiscoveryRun } from '#/api/gainos';

defineOptions({ name: 'DiscoveryRunView' });

type Tone = 'done' | 'current' | 'pending' | 'skipped' | 'failed';

const route = useRoute();
const router = useRouter();
const runId = String(route.params.runId ?? '');

const run = ref<DiscoveryRun | null>(null);
const loading = ref(true);
const error = ref<{ title: string; next?: string } | null>(null);
const auto = ref(true);
let timer: ReturnType<typeof setInterval> | null = null;

function textOf(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const stats = computed<Record<string, any>>(() => (run.value?.stats ?? {}) as Record<string, any>);

function recordOf(key: string): Record<string, any> {
  const value = stats.value[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

const fit = computed<Record<string, number>>(() => (recordOf('fit') as Record<string, number>) ?? {});
type SourceRow = Record<string, any> & { source: string };
const perSource = computed<SourceRow[]>(() =>
  Object.entries(recordOf('perSource')).map(([source, value]) => ({
    source,
    ...(value as Record<string, any>),
  })) as SourceRow[],
);

const fitSummary = computed(() => {
  const entries = Object.entries(fit.value);
  return entries.length > 0 ? entries.map(([key, value]) => `${key} ${value}`).join(' · ') : '—';
});

const elapsed = computed(() => {
  const start = run.value?.createdAt ? new Date(run.value.createdAt).getTime() : Number.NaN;
  const end = run.value?.completedAt ? new Date(run.value.completedAt).getTime() : Date.now();
  if (!Number.isFinite(start)) return '—';
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
});

interface StageView {
  key: string;
  label: string;
  value: string;
  hint: string;
  tone: Tone;
}

const stages = computed<StageView[]>(() => {
  const s = stats.value;
  const terminal = Boolean(run.value) && run.value!.status !== 'RUNNING';
  const failureStage = recordOf('failure').stage as string | undefined;
  const defs = [
    {
      key: 'query',
      label: $t('gainos.runs.stageQuery'),
      has: s.queries !== undefined,
      value: textOf(s.queries),
      hint: $t('gainos.runs.queryHint', { sources: perSource.value.length, failures: num(s.failures) ?? 0 }),
    },
    {
      key: 'canonicalize',
      label: $t('gainos.runs.stageCanonical'),
      has: s.companies !== undefined,
      value: textOf(s.companies),
      hint: $t('gainos.runs.canonicalHint', { suppressed: textOf(s.suppressed) }),
    },
    {
      key: 'fit',
      label: $t('gainos.runs.stageFit'),
      has: s.fit !== undefined,
      value: textOf(fit.value.match ?? 0),
      hint: fitSummary.value,
    },
    {
      key: 'websiteProfile',
      label: $t('gainos.runs.stageWebsite'),
      has: s.websiteProfile !== undefined,
      value: textOf(s.websiteProfile?.profiled),
      hint: $t('gainos.runs.websiteHint', { matched: textOf(s.websiteProfile?.matched), unclassified: textOf(s.websiteProfile?.unclassified) }),
    },
    {
      key: 'enrich',
      label: $t('gainos.runs.stageEnrich'),
      has: s.enrich !== undefined,
      value: textOf(s.enrich?.matched),
      hint: $t('gainos.runs.ofHint', { of: textOf(s.enrich?.of), provider: textOf(s.enrich?.provider) }),
    },
    {
      key: 'signals',
      label: $t('gainos.runs.stageSignals'),
      has: s.signals !== undefined,
      value: textOf(s.signals?.matched),
      hint: $t('gainos.runs.ofHint', { of: textOf(s.signals?.of), provider: textOf(s.signals?.provider) }),
    },
    {
      key: 'watches',
      label: $t('gainos.runs.stageWatches'),
      has: s.watches !== undefined,
      value: textOf(s.watches?.registered),
      hint: $t('gainos.runs.ofHint', { of: textOf(s.watches?.of), provider: '—' }),
    },
    {
      key: 'patentEnqueue',
      label: $t('gainos.runs.stagePatents'),
      has: s.patentEnqueue !== undefined,
      value: textOf(s.patentEnqueue?.enqueued),
      hint: $t('gainos.runs.ofHint', { of: textOf(s.patentEnqueue?.of), provider: '—' }),
    },
  ];
  let assignedCurrent = false;
  return defs.map((def) => {
    let tone: Tone;
    if (def.has) tone = 'done';
    else if (failureStage === def.key) tone = 'failed';
    else if (!terminal) {
      tone = assignedCurrent ? 'pending' : 'current';
      assignedCurrent = true;
    } else {
      tone = 'skipped';
    }
    return { ...def, tone };
  });
});

const failure = computed(() => {
  const value = recordOf('failure');
  return Object.keys(value).length > 0 ? value : null;
});

const FAILURE_STAGE: Record<string, string> = {
  query: 'search',
  canonicalize: 'collect',
  websiteProfile: 'collect',
  fit: 'match',
  enrich: 'enrich',
  signals: 'enrich',
  watches: 'enrich',
  patentEnqueue: 'enrich',
};

function userStageLabel(key: string): string {
  return $t(`gainos.runs.userStage.${key}`);
}

const userStages = computed(() => {
  const terminal = Boolean(run.value) && run.value!.status !== 'RUNNING';
  const failedKey = FAILURE_STAGE[String(recordOf('failure').stage ?? '')];
  const hasSignals = stats.value.signals !== undefined;
  const defs = [
    {
      key: 'search',
      label: userStageLabel('search'),
      value: stats.value.queries !== undefined ? $t('gainos.runs.userStage.searchValue', { count: textOf(stats.value.queries) }) : $t('gainos.runs.userStage.waiting'),
      hint: $t('gainos.runs.userStage.searchHint'),
      has: stats.value.queries !== undefined,
    },
    {
      key: 'collect',
      label: userStageLabel('collect'),
      value: stats.value.companies !== undefined ? $t('gainos.runs.userStage.collectValue', { count: textOf(stats.value.companies) }) : $t('gainos.runs.userStage.waiting'),
      hint: $t('gainos.runs.userStage.collectHint'),
      has: stats.value.companies !== undefined,
    },
    {
      key: 'match',
      label: userStageLabel('match'),
      value: stats.value.fit !== undefined ? $t('gainos.runs.userStage.matchValue', { count: textOf(fit.value.match ?? 0) }) : $t('gainos.runs.userStage.waiting'),
      hint: $t('gainos.runs.userStage.matchHint'),
      has: stats.value.fit !== undefined,
    },
    {
      key: 'enrich',
      label: userStageLabel('enrich'),
      value: hasSignals
        ? Number(stats.value.signals?.matched ?? 0) > 0
          ? $t('gainos.runs.userStage.enrichValue', { count: textOf(stats.value.signals?.matched ?? 0) })
          : $t('gainos.runs.userStage.noExtraSignals')
        : $t('gainos.runs.userStage.waiting'),
      hint: $t('gainos.runs.userStage.enrichHint'),
      has: hasSignals,
    },
    {
      key: 'output',
      label: userStageLabel('output'),
      value: terminal ? statusLabel(run.value?.status) : $t('gainos.runs.userStage.outputRunning'),
      hint: $t('gainos.runs.userStage.outputHint'),
      has: terminal,
    },
  ];
  let assignedCurrent = false;
  return defs.map((def) => {
    let tone: Tone;
    if (def.has) tone = 'done';
    else if (failedKey === def.key) tone = 'failed';
    else if (!terminal) {
      tone = assignedCurrent ? 'pending' : 'current';
      assignedCurrent = true;
    } else {
      tone = 'skipped';
    }
    return { ...def, tone };
  });
});

const failureSummary = computed(() => {
  const stage = String(failure.value?.stage ?? '');
  const key = FAILURE_STAGE[stage];
  return key
    ? $t('gainos.runs.failedAtStage', { stage: userStageLabel(key) })
    : $t('gainos.runs.failedUnknownStage');
});

const statusTone = computed(() => {
  const status = run.value?.status ?? '';
  if (status === 'DONE') return 'is-ok';
  if (status === 'FAILED') return 'is-bad';
  if (status === 'PARTIAL') return 'is-warn';
  return 'is-running';
});

function statusLabel(status?: string): string {
  const key = `gainos.runs.status.${status ?? 'RUNNING'}`;
  const value = $t(key);
  return value === key ? (status ?? '') : value;
}

function toneLabel(tone: Tone): string {
  return $t(`gainos.runs.stageState.${tone}`);
}

async function load(): Promise<void> {
  loading.value = !run.value;
  try {
    run.value = await gainosApi.discoveryRun(runId);
    error.value = null;
  } catch (err) {
    error.value = failureText(err);
  } finally {
    loading.value = false;
    schedule();
  }
}

function schedule(): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (auto.value && run.value?.status === 'RUNNING') {
    timer = setInterval(() => {
      void load();
    }, 3000);
  }
}

function toggleAuto(): void {
  auto.value = !auto.value;
  schedule();
}

function back(): void {
  void router.push('/find-buyers');
}

function goLeads(): void {
  void router.push('/leads');
}

onMounted(load);
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="run">
    <header class="run__head">
      <div>
        <button class="run__back" type="button" @click="back">← {{ $t('gainos.runs.back') }}</button>
        <span class="run__kicker">{{ $t('gainos.runs.kicker') }}</span>
        <h1>{{ $t('gainos.runs.title') }}</h1>
        <p class="run__muted">{{ $t('gainos.runs.subtitle') }}</p>
      </div>
      <div class="run__head-actions">
        <label v-if="run?.status === 'RUNNING'" class="run__auto"><input v-model="auto" type="checkbox" @change="toggleAuto" /> {{ $t('gainos.runs.autoRefresh') }}</label>
        <button class="run__action" type="button" @click="load">{{ $t('gainos.common.refresh') }}</button>
      </div>
    </header>

    <p v-if="loading" class="run__muted">{{ $t('gainos.common.loading') }}</p>
    <div v-else-if="error" class="run__error" role="alert">
      <h2>{{ error.title }}</h2>
      <p v-if="error.next">{{ error.next }}</p>
      <button class="run__action" type="button" @click="back">{{ $t('gainos.runs.back') }}</button>
    </div>

    <template v-else-if="run">
      <section class="run__summary">
        <article class="run__status-card">
          <span class="run__badge" :class="statusTone">{{ statusLabel(run.status) }}</span>
          <p class="run__muted">{{ $t('gainos.runs.started') }} {{ new Date(run.createdAt).toLocaleString() }}</p>
          <p class="run__muted">{{ $t('gainos.runs.duration') }} {{ elapsed }}</p>
          <p v-if="run.completedAt" class="run__muted">{{ $t('gainos.runs.completed') }} {{ new Date(run.completedAt).toLocaleString() }}</p>
          <p v-if="run.status === 'RUNNING'" class="run__muted">{{ $t('gainos.runs.runStatusHint') }}</p>
        </article>
        <article><span>{{ $t('gainos.runs.summaryCompanies') }}</span><strong>{{ textOf(stats.companies) }}</strong></article>
        <article><span>{{ $t('gainos.runs.summaryMatch') }}</span><strong>{{ textOf(fit.match ?? 0) }}</strong></article>
        <article><span>{{ $t('gainos.runs.summaryPartialMatch') }}</span><strong>{{ textOf(fit.weak ?? 0) }}</strong></article>
        <article><span>{{ $t('gainos.runs.summaryExcluded') }}</span><strong>{{ textOf(Number(fit.mismatch ?? 0) + Number(stats.suppressed ?? 0)) }}</strong></article>
        <article><span>{{ $t('gainos.runs.summaryDuration') }}</span><strong>{{ elapsed }}</strong></article>
      </section>

      <section class="run__user-stages" :aria-label="$t('gainos.runs.userProgress')">
        <article v-for="(stage, index) in userStages" :key="stage.key" class="run__user-stage" :class="`is-${stage.tone}`">
          <span class="run__stage-index">{{ index + 1 }}</span>
          <strong>{{ stage.label }}</strong>
          <span class="run__user-stage-value">{{ stage.value }}</span>
          <span class="run__stage-hint">{{ stage.hint }}</span>
        </article>
      </section>

      <section
        v-if="run.status === 'PARTIAL' || run.status === 'FAILED'"
        class="run__outcome"
        :class="run.status === 'FAILED' ? 'is-bad' : 'is-warn'"
      >
        <div>
          <strong>{{ run.status === 'PARTIAL' ? $t('gainos.runs.partialTitle') : $t('gainos.runs.failedTitle') }}</strong>
          <p>
            {{ run.status === 'PARTIAL'
              ? $t('gainos.runs.partialDesc', { count: textOf(stats.companies) })
              : $t('gainos.runs.failedDesc', { count: textOf(stats.companies) }) }}
          </p>
        </div>
        <div class="run__outcome-actions">
          <button v-if="run.status === 'PARTIAL'" class="run__action run__action--primary" type="button" @click="goLeads">{{ $t('gainos.runs.goLeads') }}</button>
          <button class="run__action" type="button" @click="back">{{ $t('gainos.runs.adjustIcp') }}</button>
        </div>
      </section>

      <details class="run__tech">
        <summary>{{ $t('gainos.runs.techStages') }}</summary>
        <section class="run__stages" :aria-label="$t('gainos.runs.pipeline')">
          <article v-for="(stage, index) in stages" :key="stage.key" class="run__stage" :class="`is-${stage.tone}`">
            <div class="run__stage-top">
              <span class="run__stage-index">{{ index + 1 }}</span>
              <span class="run__stage-state">{{ toneLabel(stage.tone) }}</span>
            </div>
            <strong>{{ stage.label }}</strong>
            <span class="run__stage-value">{{ stage.value }}</span>
            <span class="run__stage-hint">{{ stage.hint }}</span>
          </article>
        </section>
      </details>

      <section v-if="failure" class="run__failure" role="alert">
        <h2>{{ failureSummary }}</h2>
        <p class="run__muted">{{ $t('gainos.runs.failureHint') }}</p>
        <details>
          <summary>{{ $t('gainos.runs.techDetails') }}</summary>
          <dl>
            <div><dt>{{ $t('gainos.runs.failureStage') }}</dt><dd class="run__mono">{{ failure.stage }}</dd></div>
            <div><dt>{{ $t('gainos.runs.failureType') }}</dt><dd class="run__mono">{{ failure.errorType }}</dd></div>
            <div><dt>{{ $t('gainos.runs.failureControl') }}</dt><dd>{{ failure.control ? 'true' : 'false' }}</dd></div>
          </dl>
        </details>
      </section>

      <details class="run__tech">
        <summary>{{ $t('gainos.runs.techOutputs') }}</summary>
        <section class="run__grid">
        <article class="run__card run__card--wide">
          <h2>{{ $t('gainos.runs.sourcesTitle') }}</h2>
          <table class="run__table">
            <thead>
              <tr><th>{{ $t('gainos.runs.source') }}</th><th>{{ $t('gainos.runs.sourceRaw') }}</th><th>{{ $t('gainos.runs.sourceGovernance') }}</th><th>{{ $t('gainos.runs.sourceCost') }}</th><th>{{ $t('gainos.runs.sourceError') }}</th></tr>
            </thead>
            <tbody>
              <tr v-for="source in perSource" :key="source.source">
                <td><strong>{{ source.source }}</strong><br /><small class="run__muted">{{ textOf(source.provider ?? source.providers) }}</small></td>
                <td>{{ textOf(source.rawCount) }}</td>
                <td>
                  <span v-if="num(source.governanceDenied)" class="run__chip is-warn">denied {{ source.governanceDenied }}</span>
                  <span v-if="num(source.quarantinedCount)" class="run__chip">quarantine {{ source.quarantinedCount }}</span>
                  <span v-if="num(source.rejectedCount)" class="run__chip is-warn">rejected {{ source.rejectedCount }}</span>
                  <span v-if="num(source.duplicateCount)" class="run__chip">dup {{ source.duplicateCount }}</span>
                  <span v-if="!source.governanceDenied && !source.quarantinedCount && !source.rejectedCount && !source.duplicateCount">—</span>
                </td>
                <td>{{ textOf(source.costCents) }}</td>
                <td class="run__error-text">{{ textOf(source.error) }}</td>
              </tr>
              <tr v-if="perSource.length === 0"><td colspan="5" class="run__muted">{{ $t('gainos.runs.emptySources') }}</td></tr>
            </tbody>
          </table>
        </article>

        <article class="run__card">
          <h2>{{ $t('gainos.runs.fitTitle') }}</h2>
          <div class="run__chips">
            <span v-for="(value, key) in fit" :key="key" class="run__chip">{{ key }} {{ value }}</span>
            <span v-if="Object.keys(fit).length === 0" class="run__muted">—</span>
          </div>
          <p class="run__muted">{{ $t('gainos.runs.unjudged') }} {{ textOf(stats.fitUnjudged) }} · {{ $t('gainos.runs.skippedForBudget') }} {{ textOf(stats.fitSkippedForBudget) }}</p>
        </article>

        <article class="run__card">
          <h2>{{ $t('gainos.runs.outputsTitle') }}</h2>
          <dl class="run__facts">
            <div><dt>websiteProfile</dt><dd>{{ textOf(stats.websiteProfile) }}</dd></div>
            <div><dt>enrich</dt><dd>{{ textOf(stats.enrich) }}</dd></div>
            <div><dt>signals</dt><dd>{{ textOf(stats.signals) }}</dd></div>
            <div><dt>watches</dt><dd>{{ textOf(stats.watches) }}</dd></div>
            <div><dt>patentEnqueue</dt><dd>{{ textOf(stats.patentEnqueue) }}</dd></div>
            <div><dt>skippedSubjects</dt><dd>{{ textOf(stats.skippedSubjects) }}</dd></div>
            <div><dt>budgetTruncated</dt><dd>{{ stats.budgetTruncated ? 'true' : 'false' }}</dd></div>
          </dl>
        </article>
        </section>
      </details>

      <details class="run__details">
        <summary>{{ $t('gainos.runs.detailsTitle') }}</summary>
        <pre>{{ JSON.stringify(run, null, 2) }}</pre>
      </details>
    </template>
  </div>
</template>

<style scoped>
.run { padding: clamp(18px, 2.4vw, 32px) clamp(18px, 2.4vw, 34px) clamp(32px, 4vh, 48px); max-width: 1240px; margin: 0 auto; display: grid; gap: 18px; }
.run__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.run__back { border: 0; background: transparent; padding: 0; color: var(--gs-fg-muted); font-size: 13px; cursor: pointer; }
.run__back:hover { color: var(--gs-accent-strong); }
.run__kicker { display: block; margin-top: 10px; font-size: 11.5px; font-weight: 700; letter-spacing: .18em; color: var(--gs-accent-strong); }
.run__head h1 { margin: 6px 0 0; font-size: 26px; font-weight: 700; color: var(--gs-fg); }
.run__head-actions { display: flex; align-items: center; gap: 12px; padding-top: 4px; }
.run__auto { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--gs-fg-muted); }
.run__action { border: 1px solid var(--gs-border); background: var(--gs-surface); border-radius: 10px; padding: 7px 14px; font-size: 13px; cursor: pointer; color: var(--gs-fg); }
.run__action--primary { background: var(--gs-accent); border-color: var(--gs-accent); color: #fff; font-weight: 600; }
.run__outcome {
  display: flex; justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap;
  padding: 14px 16px; border-radius: 12px; border: 1px solid var(--gs-border);
  background: var(--gs-surface);
}
.run__outcome.is-warn { border-color: var(--gs-warn); background: var(--gs-warn-bg); }
.run__outcome.is-bad { border-color: var(--gs-danger-border); background: var(--gs-danger-bg); }
.run__outcome strong { display: block; font-size: 14px; color: var(--gs-fg); }
.run__outcome p { margin: 4px 0 0; font-size: 12.5px; line-height: 1.65; color: var(--gs-fg-muted); }
.run__outcome-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.run__muted { color: var(--gs-fg-muted); font-size: 12.5px; margin: 0; }
.run__mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; word-break: break-all; }
.run__error { border-radius: 14px; border: 1px solid #fecaca; background: #fef2f2; color: #991b1b; padding: 16px 18px; display: grid; gap: 8px; }
.run__error h2 { margin: 0; font-size: 16px; }
.run__error p { margin: 0; font-size: 13px; }
.run__summary { display: grid; grid-template-columns: minmax(260px, 1.6fr) repeat(5, minmax(110px, 1fr)); gap: 12px; }
.run__summary article { background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px; padding: 14px 16px; display: grid; gap: 6px; align-content: start; }
.run__summary article span { font-size: 12px; color: var(--gs-fg-muted); }
.run__summary article strong { font-size: 24px; font-weight: 680; color: var(--gs-fg); }
.run__summary article.is-bad strong { color: #b91c1c; }
.run__status-card { gap: 6px !important; }
.run__badge { justify-self: start; border-radius: 999px; padding: 3px 10px; font-size: 11.5px; font-weight: 700; }
.run__badge.is-ok { background: #e8f9f0; color: #008f52; }
.run__badge.is-warn { background: #fef3c7; color: #b45309; }
.run__badge.is-bad { background: #fee2e2; color: #b91c1c; }
.run__badge.is-running { background: #e0f2fe; color: #0369a1; }
.run__user-stages { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
.run__user-stage { background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px; padding: 12px 14px; display: grid; gap: 5px; }
.run__user-stage.is-done { border-color: #bbf7d0; background: linear-gradient(180deg, #f0fdf4, #fff); }
.run__user-stage.is-current { border-color: var(--gs-accent); box-shadow: 0 0 0 1px var(--gs-accent) inset; }
.run__user-stage.is-failed { border-color: #fecaca; background: #fff7f7; }
.run__user-stage.is-pending, .run__user-stage.is-skipped { opacity: .62; }
.run__user-stage strong { font-size: 13.5px; color: var(--gs-fg); }
.run__user-stage-value { font-size: 20px; font-weight: 700; color: var(--gs-fg); line-height: 1.2; }
.run__tech { border: 1px solid var(--gs-border); border-radius: 12px; background: var(--gs-surface); padding: 12px 14px; }
.run__tech > summary { cursor: pointer; font-size: 13px; font-weight: 600; color: var(--gs-fg-2); }
.run__tech[open] > summary { margin-bottom: 12px; }
.run__stages { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; }
.run__stage { position: relative; background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px; padding: 12px 14px; display: grid; gap: 4px; }
.run__stage.is-done { border-color: #bbf7d0; background: linear-gradient(180deg, #f0fdf4, #fff); }
.run__stage.is-current { border-color: var(--gs-accent); box-shadow: 0 0 0 1px var(--gs-accent) inset; }
.run__stage.is-failed { border-color: #fecaca; background: #fff7f7; }
.run__stage.is-pending, .run__stage.is-skipped { opacity: .62; }
.run__stage-top { display: flex; justify-content: space-between; align-items: center; }
.run__stage-index { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; background: #f1f5f9; color: var(--gs-fg-muted); font-size: 11px; font-weight: 700; }
.run__stage.is-done .run__stage-index { background: var(--gs-accent); color: #fff; }
.run__stage-state { font-size: 10.5px; font-weight: 700; letter-spacing: .04em; color: var(--gs-fg-muted); text-transform: uppercase; }
.run__stage.is-done .run__stage-state { color: #008f52; }
.run__stage.is-failed .run__stage-state { color: #b91c1c; }
.run__stage strong { font-size: 13px; color: var(--gs-fg); }
.run__stage-value { font-size: 20px; font-weight: 700; color: var(--gs-fg); }
.run__stage-hint { font-size: 11px; color: var(--gs-fg-muted); min-height: 28px; }
.run__failure { border-radius: 14px; border: 1px solid #fecaca; background: #fef2f2; padding: 16px 18px; display: grid; gap: 10px; }
.run__failure h2 { margin: 0; font-size: 15px; color: #991b1b; }
.run__failure dl { margin: 0; display: flex; gap: 24px; flex-wrap: wrap; }
.run__failure dt { font-size: 11px; color: #b91c1c; text-transform: uppercase; letter-spacing: .08em; }
.run__failure dd { margin: 2px 0 0; font-size: 13px; color: #7f1d1d; }
.run__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; }
.run__card { background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px; padding: 16px 18px; display: grid; gap: 10px; align-content: start; }
.run__card--wide { grid-column: 1 / -1; }
.run__card h2 { margin: 0; font-size: 14px; font-weight: 650; color: var(--gs-fg); }
.run__table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.run__table th, .run__table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--gs-border); vertical-align: top; }
.run__table th { color: var(--gs-fg-muted); font-weight: 600; background: var(--gs-bg-soft, #f8fafc); }
.run__table tr:last-child td { border-bottom: 0; }
.run__chips { display: flex; flex-wrap: wrap; gap: 8px; }
.run__chip { border-radius: 999px; padding: 2px 9px; background: #f1f5f9; color: #475569; font-size: 11.5px; font-weight: 600; }
.run__chip.is-warn { background: #fef3c7; color: #b45309; }
.run__facts { margin: 0; display: grid; gap: 6px; }
.run__facts div { display: grid; grid-template-columns: 130px 1fr; gap: 8px; font-size: 12.5px; }
.run__facts dt { color: var(--gs-fg-muted); }
.run__facts dd { margin: 0; color: var(--gs-fg); word-break: break-word; }
.run__error-text { color: #b45309; max-width: 420px; word-break: break-word; }
.run__details { border: 1px solid var(--gs-border); border-radius: 14px; background: var(--gs-surface); padding: 14px 18px; }
.run__details summary { cursor: pointer; font-size: 13px; font-weight: 600; color: var(--gs-fg); }
.run__details pre { margin: 12px 0 0; font-size: 11.5px; line-height: 1.6; max-height: 420px; overflow: auto; background: var(--gs-bg-soft, #f8fafc); padding: 14px; border-radius: 10px; }
@media (max-width: 900px) {
  .run__summary { grid-template-columns: repeat(2, 1fr); }
  .run__summary article:first-child { grid-column: 1 / -1; }
  .run__user-stages { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .run__user-stage:last-child { grid-column: 1 / -1; }
}
</style>
