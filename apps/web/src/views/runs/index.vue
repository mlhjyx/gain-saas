<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { glossaryStatus } from '@gain-saas/shared';
import { preferences } from '@vben/preferences';

import { deriveRunActions } from '@gain-saas/shared';

import { $t } from '#/locales';

import { failureText, gainosApi, type DiscoveryRun, type DiscoveryRunJob, type DiscoveryRunTrace } from '#/api/gainos';

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

// M0⑤：快扫名单 / 深挖队列 / 增量事件 / 停止深挖。
const jobs = ref<DiscoveryRunJob[]>([]);
const lastSeq = ref(0);
const jobError = ref<string | null>(null);
const stopping = ref(false);
const stopNotice = ref<string | null>(null);

const QUICK_STAGES = new Set(['queued', 'prefiltered_out', 'quick_judged']);
const quickJobs = computed(() => jobs.value.filter((job) => QUICK_STAGES.has(job.stage)));
// 快扫名单默认只展示「匹配/待复核」，其余折叠——避免 200 行把结论区埋到十几屏外（审计 一-01）。
const showAllQuick = ref(false);
const quickJobsShown = computed(() =>
  showAllQuick.value
    ? quickJobs.value
    : quickJobs.value.filter((job) => String(job.verdictQuick ?? '') !== 'mismatch'),
);
const quickHiddenCount = computed(() => quickJobs.value.length - quickJobsShown.value.length);
const deepJobs = computed(() => jobs.value.filter((job) => !QUICK_STAGES.has(job.stage)));

function jobStageLabel(stage: string): string {
  const key = `gainos.runs.jobStage.${stage}`;
  const value = $t(key);
  return value === key ? stage : value;
}

function jobVerdictLabel(verdict?: string | null): string {
  if (!verdict) return '—';
  const key = `gainos.runs.jobVerdict.${verdict}`;
  const value = $t(key);
  return value === key ? verdict : value;
}

async function loadJobs(): Promise<void> {
  try {
    jobs.value = await gainosApi.runJobs(runId);
    jobError.value = null;
  } catch (err) {
    jobError.value = failureText(err).title;
  }
}

// M2 步 9b-4：「过程」时间线（源侦察员选源/跳过原因 + 资格判定员批量判定/被否候选），只读。
const traceRows = ref<DiscoveryRunTrace[]>([]);
const traceCursor = ref<string | null>(null);
const traceHasMore = ref(false);
const traceLoading = ref(false);
const traceError = ref<string | null>(null);

async function loadTrace(): Promise<void> {
  if (!runId) return;
  traceLoading.value = true;
  try {
    const page = await gainosApi.runTrace(runId, { limit: 50 });
    traceRows.value = page.data ?? [];
    traceCursor.value = page.page?.next_cursor ?? null;
    traceHasMore.value = page.page?.has_more ?? false;
    traceError.value = null;
  } catch (err) {
    traceError.value = failureText(err).title;
  } finally {
    traceLoading.value = false;
  }
}

async function loadMoreTrace(): Promise<void> {
  if (!traceCursor.value) return;
  traceLoading.value = true;
  try {
    const page = await gainosApi.runTrace(runId, { limit: 50, cursor: traceCursor.value });
    traceRows.value = [...traceRows.value, ...(page.data ?? [])];
    traceCursor.value = page.page?.next_cursor ?? null;
    traceHasMore.value = page.page?.has_more ?? false;
  } catch (err) {
    traceError.value = failureText(err).title;
  } finally {
    traceLoading.value = false;
  }
}

// 零术语红线：未登记的值一律回退人话，绝不把引擎标识/原因码原样渲染进可见面。
function traceAgentLabel(agentKey: string): string {
  const key = `gainos.runs.traceAgent.${agentKey}`;
  const value = $t(key);
  return value === key ? $t('gainos.runs.traceAgentFallback') : value;
}

function traceStepLabel(decisionType: string): string {
  const key = `gainos.runs.traceStep.${decisionType}`;
  const value = $t(key);
  return value === key ? $t('gainos.runs.traceStepFallback') : value;
}

function traceReasonLabel(code: unknown): string {
  if (typeof code !== 'string' || !code) return '—';
  const key = `gainos.runs.traceRejectReason.${code}`;
  const value = $t(key);
  return value === key ? $t('gainos.runs.traceReasonUnknown') : value;
}

function traceRejectReasonLabel(code: unknown): string {
  if (typeof code !== 'string' || !code) return '—';
  const key = `gainos.runs.traceVerdictReason.${code}`;
  const value = $t(key);
  return value === key ? $t('gainos.runs.traceReasonUnknown') : value;
}

/** 数据源标识（引擎 adapter key）→ 人话名称；未登记回退「其它数据源」。 */
function traceSourceLabel(key: unknown): string {
  if (typeof key !== 'string' || !key) return $t('gainos.runs.traceSourceOther');
  const full = `gainos.runs.traceSource.${key}`;
  const value = $t(full);
  return value === full ? $t('gainos.runs.traceSourceOther') : value;
}

interface TraceEvidence {
  support: string | null;
  url: string;
}

interface TraceTech {
  agentKey: string;
  attempt: number;
  cost: string;
  decisionType: string;
  reasonCode: string;
  rejectedCount: number;
  score: string;
  traceId: string;
}

interface TraceEntry {
  agentLabel: string;
  attempt: number;
  detail: string | null;
  evidence: TraceEvidence[];
  headline: string;
  id: string;
  rejected: string | null;
  stepLabel: string;
  tech: TraceTech;
  time: string;
}

function traceStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function traceObjectList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => item !== null && typeof item === 'object',
      )
    : [];
}

function traceNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const traceEntries = computed<TraceEntry[]>(() =>
  traceRows.value.map((row) => {
    const chosen = (row.chosenOption ?? {}) as Record<string, unknown>;
    const time = new Date(row.createdAt).toLocaleString();
    const evidence: TraceEvidence[] = traceObjectList(row.evidence)
      .filter((item) => typeof item['url'] === 'string' && item['url'])
      .map((item) => ({
        support: typeof item['support'] === 'string' && item['support'] ? item['support'] : null,
        url: item['url'] as string,
      }));
    const tech: TraceTech = {
      agentKey: row.agentKey,
      attempt: row.attempt,
      cost: `${row.costEstimatedMicros ?? '—'} / ${row.costActualMicros ?? '—'}`,
      decisionType: row.decisionType,
      reasonCode: row.reasonCode ?? '—',
      rejectedCount: traceObjectList(row.rejectedCandidates).length,
      score: row.score === null ? '—' : String(row.score),
      traceId: row.id,
    };
    if (row.decisionType === 'source.route') {
      const sources = traceStringList(chosen['sources']);
      const rejected = traceObjectList(row.rejectedCandidates);
      const skipped = rejected
        .map((item) => {
          const ref = traceSourceLabel(item['candidateRef']);
          return `${ref}（${traceReasonLabel(item['rejectReason'])}）`;
        })
        .join('、');
      const headline =
        sources.length > 0
          ? `${$t('gainos.runs.traceChosenSources')}：${sources.map(traceSourceLabel).join('、')}`
          : $t('gainos.runs.traceNoSource');
      const reason =
        typeof row.reasonCode === 'string' && row.reasonCode
          ? $t('gainos.runs.traceReason', { reason: traceReasonLabel(row.reasonCode) })
          : null;
      return {
        id: row.id,
        agentLabel: traceAgentLabel(row.agentKey),
        attempt: row.attempt,
        stepLabel: traceStepLabel(row.decisionType),
        time,
        headline,
        detail: reason,
        evidence,
        tech,
        rejected: skipped ? `${$t('gainos.runs.traceSkipped')}：${skipped}` : null,
      };
    }
    if (row.decisionType === 'fit.judge') {
      const verdicts = (chosen['verdicts'] ?? {}) as Record<string, unknown>;
      const judged = traceNumber(chosen['judged']);
      const total = traceNumber(chosen['batchSize']);
      const rejected = traceObjectList(row.rejectedCandidates);
      const counts = new Map<string, number>();
      for (const item of rejected) {
        const code = typeof item['rejectReason'] === 'string' ? item['rejectReason'] : '—';
        counts.set(code, (counts.get(code) ?? 0) + 1);
      }
      const rejectedText = [...counts]
        .map(([code, count]) => `${traceRejectReasonLabel(code)} ${count} 家`)
        .join('、');
      const headline =
        judged !== null && total !== null
          ? $t('gainos.runs.traceJudged', { judged, total })
          : $t('gainos.runs.traceJudged', { judged: '—', total: '—' });
      const verdictText = $t('gainos.runs.traceVerdicts', {
        match: traceNumber(verdicts['match']) ?? 0,
        weak: traceNumber(verdicts['weak']) ?? 0,
        mismatch: traceNumber(verdicts['mismatch']) ?? 0,
      });
      return {
        id: row.id,
        agentLabel: traceAgentLabel(row.agentKey),
        attempt: row.attempt,
        stepLabel: traceStepLabel(row.decisionType),
        time,
        headline,
        detail: verdictText,
        evidence,
        tech,
        rejected: rejectedText ? `${$t('gainos.runs.traceRejected')}：${rejectedText}` : null,
      };
    }
    return {
      id: row.id,
      agentLabel: traceAgentLabel(row.agentKey),
      attempt: row.attempt,
      stepLabel: traceStepLabel(row.decisionType),
      time,
      headline: row.reasonCode
        ? `${$t('gainos.runs.traceReason', { reason: traceReasonLabel(row.reasonCode) })}`
        : '—',
      detail: null,
      evidence,
      tech,
      rejected: null,
    };
  }),
);

/** 按 seq 增量拉事件；有新事件才刷新逐家状态（3 秒轮询的判据）。 */
async function pollEvents(): Promise<void> {
  try {
    const page = await gainosApi.runEvents(runId, lastSeq.value);
    if (page.events.length > 0) {
      lastSeq.value = page.nextAfter;
      await Promise.all([loadJobs(), loadTrace()]);
    }
  } catch {
    /* 事件轮询失败不打断 run 视图；下一轮重试 */
  }
}

// P1（方案 2.5/G2）：失败/部分完成/已停止的 run 可重试——同一计划发起新 attempt（新预算账户），
// 同一 attemptId 双击幂等；启动失败先核对任务是否其实已受理，再决定是否允许再点。
interface AttemptRow {
  id: string;
  runId: string | null;
  attempt: number;
  rerunOf: string | null;
  status: string;
  startedAt: string;
}
const retrying = ref(false);
const retryDialog = ref(false);
const retryNotice = ref<string | null>(null);
const retryError = ref<string | null>(null);
const retryAttemptId = ref<string | null>(null);
const taskAttempts = ref<AttemptRow[]>([]);

const canRetry = computed(() => {
  const status = run.value?.status;
  return Boolean(run.value) &&
    (status === 'FAILED' || status === 'PARTIAL' || status === 'CANCELLED') &&
    Boolean(run.value?.taskRef?.taskId) &&
    Boolean(run.value?.planId);
});
const hasLeadOutput = computed(
  () => run.value?.status === 'PARTIAL' || Number(stats.value.leads ?? quickScan.value.leads ?? 0) > 0,
);
const runActions = computed(() =>
  deriveRunActions({ status: run.value?.status, retriable: canRetry.value, hasLeads: hasLeadOutput.value }),
);



const retryOutcomeText = computed(() => {
  const status = statusLabel(run.value?.status);
  const stage = String(failure.value?.stage ?? '');
  const key = FAILURE_STAGE[stage];
  return key
    ? $t('gainos.runs.retryLastOutcome', { status, stage: userStageLabel(key) })
    : status;
});

function mintAttemptId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `attempt-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

async function loadTaskAttempts(): Promise<void> {
  const taskId = run.value?.taskRef?.taskId;
  const icpId = run.value?.icpId;
  if (!taskId || !icpId) {
    taskAttempts.value = [];
    return;
  }
  try {
    const tasks = await gainosApi.acquisitionTasks(icpId);
    const task = tasks.find((entry) => entry.id === taskId);
    taskAttempts.value = (task?.runs ?? [])
      .map((row) => ({
        id: row.id,
        runId: row.runId,
        attempt: row.attempt ?? 1,
        rerunOf: row.rerunOf ?? null,
        status: row.status,
        startedAt: row.startedAt,
      }))
      .sort((a, b) => a.attempt - b.attempt);
  } catch {
    // 尝试历史不可用时不影响主流程。
  }
}

async function reconcileStartedRun(taskId: string): Promise<string | null> {
  const icpId = run.value?.icpId;
  if (!icpId) return null;
  const before = new Set(taskAttempts.value.map((row) => row.runId).filter(Boolean));
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const tasks = await gainosApi.acquisitionTasks(icpId);
      const task = tasks.find((entry) => entry.id === taskId);
      const fresh = (task?.runs ?? []).find((row) => row.runId && !before.has(row.runId));
      if (fresh?.runId) return fresh.runId;
    } catch {
      // 继续轮询到窗口结束。
    }
  }
  return null;
}

async function confirmRetry(): Promise<void> {
  if (retrying.value || !run.value) return;
  const taskId = run.value.taskRef?.taskId;
  const planId = run.value.planId;
  if (!taskId || !planId) {
    retryError.value = $t('gainos.runs.retryUnavailable');
    return;
  }
  retrying.value = true;
  retryError.value = null;
  retryAttemptId.value ??= mintAttemptId();
  try {
    const result = await gainosApi.startAcquisitionTaskRun(taskId, planId, retryAttemptId.value);
    retryDialog.value = false;
    retryAttemptId.value = null;
    retryNotice.value = $t('gainos.runs.retryRequested');
    if (result.runId) {
      await router.push({ name: 'DiscoveryRun', params: { runId: result.runId } });
    } else {
      await load();
    }
  } catch (err) {
    const settled = await reconcileStartedRun(taskId);
    if (settled) {
      retryDialog.value = false;
      retryAttemptId.value = null;
      retryNotice.value = $t('gainos.runs.retryRequested');
      await router.push({ name: 'DiscoveryRun', params: { runId: settled } });
      return;
    }
    retryError.value = failureText(err).title;
  } finally {
    retrying.value = false;
  }
}

function closeRetryDialog(): void {
  if (retrying.value) return;
  retryDialog.value = false;
  retryError.value = null;
}

async function stopDeep(): Promise<void> {
  if (stopping.value) return;
  if (!window.confirm($t('gainos.runs.stopConfirm'))) return;
  stopping.value = true;
  stopNotice.value = null;
  try {
    await gainosApi.cancelDiscoveryRun(runId);
    stopNotice.value = $t('gainos.runs.stopRequested');
    await load();
  } catch (err) {
    jobError.value = failureText(err).title;
  } finally {
    stopping.value = false;
  }
}

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
function recordValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
}
/** 微分美元 → 可读金额(引擎 contactBudget 等以 microusd 十进制字符串计)。 */
function fmtUsd(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `$${(n / 1_000_000).toFixed(2)}`;
}
/** 查询跳过原因 → 中文(未收录的原样显示,便于对引擎新增原因)。 */
const SKIP_REASON_LABELS: Record<string, string> = {
  source_disabled: '源已停用',
  no_enabled_provider: '无可用数据源',
  source_lineage_unavailable: '源血缘不可用',
};
function skipReasonLabel(reason: string): string {
  return SKIP_REASON_LABELS[reason] ?? reason;
}
/** 租约跳过按阶段 → 用户可读阶段名(键与引擎 leaseSkips 一致)。 */
const LEASE_STAGE_LABELS: Record<string, string> = {
  queries: '搜索',
  companies: '收集',
  fit: '匹配',
  enrich: '富集',
  signals: '信号',
  contacts: '联系人',
  watches: '监控',
  patentEnqueue: '专利',
};
function stageLabel(stage: string): string {
  return LEASE_STAGE_LABELS[stage] ?? stage;
}

const fit = computed<Record<string, number>>(() => (recordOf('fit') as Record<string, number>) ?? {});
// 新格式 run 用 stats.quickScan / stats.deep（旧 run 才有 stats.companies/stats.fit）。
// 摘要与元信息行在两种格式下都要显示真实数字（2026-11-09 信息契约审计：KPI 全 0 对 448 判定）。
const quickScan = computed<Record<string, any>>(() => recordOf('quickScan'));
const deepStage = computed<Record<string, any>>(() => recordOf('deep'));
const summaryCompanies = computed<number | null>(() =>
  stats.value.companies ?? quickScan.value.poolSize ?? null,
);
const summaryMatch = computed<number | null>(() => fit.value.match ?? quickScan.value.match ?? null);
const summaryWeak = computed<number | null>(() => fit.value.weak ?? quickScan.value.weak ?? null);
const summaryExcluded = computed<number | null>(() => {
  if (fit.value.mismatch !== undefined) return Number(fit.value.mismatch) + Number(stats.value.suppressed ?? 0);
  if (quickScan.value.mismatch !== undefined) return Number(quickScan.value.mismatch) + Number(quickScan.value.prefilteredOut ?? 0);
  return null;
});
const failureRateHigh = computed(() =>
  Array.isArray(stats.value.alerts) && (stats.value.alerts as string[]).includes('failure_rate_high'),
);
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
  const rawFailureStage = recordOf('failure').stage as string | undefined;
  const failureStage = rawFailureStage ? (rawFailureStage && Object.prototype.hasOwnProperty.call(TECH_FAILURE_STAGE, rawFailureStage) ? TECH_FAILURE_STAGE[rawFailureStage] : rawFailureStage) : undefined;
  const phaseCurrent = currentPhaseKey(run.value, terminal);
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
      key: 'contacts',
      label: $t('gainos.runs.stageContacts'),
      has: s.contacts !== undefined,
      value: textOf(s.contacts?.people),
      hint: $t('gainos.runs.contactsHint', {
        companies: textOf(s.contacts?.companies),
        emails: textOf(s.contacts?.emails),
        phones: textOf(s.contacts?.phones),
      }),
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
      if (phaseCurrent) {
        tone = def.key === phaseCurrent ? 'current' : 'pending';
      } else {
        tone = assignedCurrent ? 'pending' : 'current';
        assignedCurrent = true;
      }
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
  // Run 2.0（P1）：引擎在 plan/quickScan/deep/finalize 阶段的失败也要落到对应的用户阶段卡上。
  plan: 'search',
  query: 'search',
  quickScan: 'match',
  canonicalize: 'collect',
  websiteProfile: 'collect',
  fit: 'match',
  enrich: 'enrich',
  signals: 'enrich',
  contacts: 'enrich',
  deep: 'enrich',
  watches: 'enrich',
  patentEnqueue: 'enrich',
  finalize: 'output',
};

/** Run 2.0 引擎阶段名 → 技术卡 key（技术卡仍按 query/fit/enrich/contacts 的细分展示）。 */
const TECH_FAILURE_STAGE: Record<string, string> = {
  plan: 'query',
  quickScan: 'fit',
  deep: 'enrich',
  finalize: 'contacts',
};

/** 当前处于哪个技术卡：以引擎 run.phases 为准（池优先的 run 不再卡在「搜索」上）。 */
interface PhaseView {
  quickStartedAt?: unknown;
  quickDoneAt?: unknown;
  deepStartedAt?: unknown;
  deepDoneAt?: unknown;
}

/**
 * P1（方案 2.5）：当前阶段以引擎 run.phases 为准。
 * - 进入深挖（deepStartedAt）→ 技术卡 enrich / 用户卡 enrich；
 * - 快扫中（quickStartedAt 且未 quickDoneAt）→ 技术卡 fit / 用户卡 match；
 * - 没有 phases（旧 run）或已终态 → null（沿用原有「首个未完成卡」推断）。
 */
function currentPhaseKey(
  runRecord: unknown,
  terminal: boolean,
): 'fit' | 'enrich' | null {
  if (terminal) return null;
  const phases = (runRecord as { phases?: PhaseView } | null)?.phases;
  const filled = (value: unknown): boolean => typeof value === 'string' && value.length > 0;
  if (!phases) return null;
  if (filled(phases.deepStartedAt)) return 'enrich';
  if (filled(phases.quickStartedAt)) return filled(phases.quickDoneAt) ? 'enrich' : 'fit';
  return null;
}

function userStageLabel(key: string): string {
  return $t(`gainos.runs.userStage.${key}`);
}

const userStages = computed(() => {
  const terminal = Boolean(run.value) && run.value!.status !== 'RUNNING';
  const failedKey = FAILURE_STAGE[String(recordOf('failure').stage ?? '')];
  const phaseCurrent = currentPhaseKey(run.value, terminal);
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
      // 失败/取消的 run 没有可交付产出——不要把 output 卡渲染成绿色的「完成」。
      has: terminal && (run.value?.status === 'DONE' || run.value?.status === 'PARTIAL'),
    },
  ];
  let assignedCurrent = false;
  return defs.map((def) => {
    let tone: Tone;
    if (def.has) tone = 'done';
    else if (failedKey === def.key) tone = 'failed';
    else if (!terminal) {
      if (phaseCurrent) {
        tone = def.key === phaseCurrent ? 'current' : 'pending';
      } else {
        tone = assignedCurrent ? 'pending' : 'current';
        assignedCurrent = true;
      }
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
  if (status === 'CANCELLED') return 'is-warn';
  return 'is-running';
});

// 状态文案取自 @gain-saas/shared 的 glossary（P6 §4），未登记值不裸奔。
function jobErrorLabel(code?: string | null): string {
  if (!code) return '—';
  const known: Record<string, string> = {
    COMPANY_PIPELINE_FAILED: $t('gainos.runs.jobErrorPipeline'),
    CancelledFailure: $t('gainos.runs.jobErrorCancelled'),
  };
  return known[code] ?? code;
}

function statusLabel(status?: string): string {
  return glossaryStatus('run', status, preferences.app.locale)?.label ?? '—';
}

function toneLabel(tone: Tone): string {
  return $t(`gainos.runs.stageState.${tone}`);
}

async function load(): Promise<void> {
  loading.value = !run.value;
  try {
    run.value = await gainosApi.discoveryRun(runId);
    error.value = null;
    await Promise.all([
      pollEvents(),
      jobs.value.length === 0 ? loadJobs() : Promise.resolve(),
      traceRows.value.length === 0 ? loadTrace() : Promise.resolve(),
      loadTaskAttempts(),
    ]);
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
        <p class="run__muted run__identity">
          <span v-if="run.icpId">{{ $t('gainos.runs.icp') }} {{ run.icpId.slice(0, 8) }}</span>
          <span v-if="run.planId"> · {{ $t('gainos.runs.plan') }} {{ run.planId.slice(0, 8) }}</span>
          <span> · {{ $t('gainos.runs.taskId') }} {{ run.id.slice(0, 8) }}</span>
        </p>
      </div>
      <div class="run__head-actions">
        <label v-if="run?.status === 'RUNNING'" class="run__auto"><input v-model="auto" type="checkbox" @change="toggleAuto" /> {{ $t('gainos.runs.autoRefresh') }}</label>
        <button v-if="run?.status === 'RUNNING'" class="run__action run__action--danger" type="button" :disabled="stopping" @click="stopDeep">{{ stopping ? $t('gainos.common.loading') : $t('gainos.runs.stopDeep') }}</button>
        <button v-if="canRetry" class="run__action run__action--primary" type="button" @click="retryDialog = true">{{ $t('gainos.runs.retry') }}</button>
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
        <article><span>{{ $t('gainos.runs.summaryCompanies') }}</span><strong>{{ textOf(summaryCompanies) }}</strong></article>
        <article><span>{{ $t('gainos.runs.summaryMatch') }}</span><strong>{{ textOf(summaryMatch) }}</strong></article>
        <article><span>{{ $t('gainos.runs.summaryPartialMatch') }}</span><strong>{{ textOf(summaryWeak) }}</strong></article>
        <article><span>{{ $t('gainos.runs.summaryExcluded') }}</span><strong>{{ textOf(summaryExcluded) }}</strong></article>
        <article><span>{{ $t('gainos.runs.summaryDuration') }}</span><strong>{{ elapsed }}</strong></article>
      </section>
      <p v-if="quickScan.judged !== undefined || deepStage.done !== undefined" class="run__meta run__muted">
        <span v-if="quickScan.judged !== undefined">{{ $t('gainos.runs.metaJudged') }} {{ textOf(quickScan.judged) }}</span>
        <span v-if="quickScan.prefilteredOut !== undefined"> · {{ $t('gainos.runs.metaPrefiltered') }} {{ textOf(quickScan.prefilteredOut) }}</span>
        <span v-if="deepStage.done !== undefined || deepStage.failed !== undefined"> · {{ $t('gainos.runs.metaDeep') }} {{ textOf(deepStage.done) }}/{{ textOf(deepStage.failed) }}</span>
        <span v-if="failureRateHigh" class="gs-badge gs-badge--danger" style="margin-left: 8px">{{ $t('gainos.runs.metaFailureHigh') }}</span>
      </p>

      <p v-if="stopNotice" class="run__muted">{{ stopNotice }}</p>
      <p v-if="retryNotice" class="run__muted">{{ retryNotice }}</p>
      <p v-if="retryError" class="run__error-text" role="alert">{{ retryError }}</p>
      <p v-if="jobError" class="run__error-text" role="alert">{{ jobError }}</p>

      <section class="run__grid">
        <article class="run__card run__card--wide">
          <h2>{{ $t('gainos.runs.quickListTitle') }}</h2>
          <p class="run__quick-toggle run__muted">
            <span>{{ $t('gainos.runs.quickSummary', { total: quickJobs.length, hidden: quickHiddenCount }) }}</span>
            <button type="button" @click="showAllQuick = !showAllQuick">
              {{ showAllQuick ? $t('gainos.runs.quickToggleCollapse') : $t('gainos.runs.quickToggleAll') }}
            </button>
          </p>
          <div class="run__table-scroll">
          <table class="run__table">
            <thead><tr><th>{{ $t('gainos.runs.jobName') }}</th><th>{{ $t('gainos.runs.jobStageColumn') }}</th><th>{{ $t('gainos.runs.jobVerdictLabel') }}</th></tr></thead>
            <tbody>
              <tr v-for="job in quickJobsShown" :key="job.id">
                <td><strong>{{ job.name ?? job.companyId }}</strong><br /><small class="run__muted">{{ job.domain ?? '' }}</small></td>
                <td>{{ jobStageLabel(job.stage) }}</td>
                <td>{{ jobVerdictLabel(job.verdictQuick) }}</td>
              </tr>
              <tr v-if="quickJobs.length === 0"><td colspan="3" class="run__muted">{{ $t('gainos.runs.jobsEmpty') }}</td></tr>
              <tr v-else-if="quickJobsShown.length === 0"><td colspan="3" class="run__muted">{{ $t('gainos.runs.quickFilterEmpty') }}</td></tr>
            </tbody>
          </table>
          </div>
        </article>
        <article class="run__card run__card--wide">
          <h2>{{ $t('gainos.runs.deepQueueTitle') }}</h2>
          <table class="run__table">
            <thead><tr><th>{{ $t('gainos.runs.jobName') }}</th><th>{{ $t('gainos.runs.jobStageColumn') }}</th><th>{{ $t('gainos.runs.jobVerdictLabel') }}</th><th>{{ $t('gainos.runs.jobError') }}</th></tr></thead>
            <tbody>
              <tr v-for="job in deepJobs" :key="job.id">
                <td><strong>{{ job.name ?? job.companyId }}</strong><br /><small class="run__muted">{{ job.domain ?? '' }}</small></td>
                <td>{{ jobStageLabel(job.stage) }}</td>
                <td>{{ jobVerdictLabel(job.verdictDeep ?? job.verdictQuick) }}</td>
                <td class="run__error-text">{{ jobErrorLabel(job.lastErrorCode) }}</td>
              </tr>
              <tr v-if="deepJobs.length === 0"><td colspan="4" class="run__muted">{{ $t('gainos.runs.jobsEmpty') }}</td></tr>
            </tbody>
          </table>
        </article>
      </section>

      <section class="run__card run__card--wide">
        <h2>{{ $t('gainos.runs.traceTitle') }}</h2>
        <p class="run__muted">{{ $t('gainos.runs.traceSubtitle') }}</p>
        <p v-if="traceError" class="run__error-text">{{ $t('gainos.runs.traceLoadError') }}</p>
        <p v-else-if="traceLoading && traceRows.length === 0" class="run__muted">{{ $t('gainos.runs.traceLoading') }}</p>
        <p v-else-if="traceRows.length === 0" class="run__muted">{{ $t('gainos.runs.traceEmpty') }}</p>
        <ol v-else class="run__trace">
          <li v-for="entry in traceEntries" :key="entry.id" class="run__trace-item">
            <div class="run__trace-head">
              <strong>{{ entry.agentLabel }} · {{ entry.stepLabel }}</strong>
              <span class="run__trace-meta">
                <span v-if="entry.attempt > 1" class="run__chip is-warn">{{ $t('gainos.runs.traceAttemptBadge', { n: entry.attempt }) }}</span>
                <small class="run__muted">{{ entry.time }}</small>
              </span>
            </div>
            <p class="run__trace-line">{{ entry.headline }}</p>
            <p v-if="entry.detail" class="run__trace-line run__muted">{{ entry.detail }}</p>
            <p v-if="entry.rejected" class="run__trace-line run__trace-line--warn">{{ entry.rejected }}</p>
            <ul v-if="entry.evidence.length" class="run__trace-evidence">
              <li v-for="(item, index) in entry.evidence" :key="index">
                <a :href="item.url" target="_blank" rel="noopener noreferrer">{{ $t('gainos.runs.traceEvidenceLink', { n: index + 1 }) }}</a>
                <span v-if="item.support" class="run__muted"> · {{ item.support }}</span>
              </li>
            </ul>
            <details class="run__trace-tech">
              <summary>{{ $t('gainos.runs.traceTech') }}</summary>
              <dl>
                <dt>{{ $t('gainos.runs.traceTechDecision') }}</dt><dd>{{ entry.tech.decisionType }}</dd>
                <dt>{{ $t('gainos.runs.traceTechAgent') }}</dt><dd>{{ entry.tech.agentKey }}</dd>
                <dt>{{ $t('gainos.runs.traceTechAttempt') }}</dt><dd>{{ entry.tech.attempt }}</dd>
                <dt>{{ $t('gainos.runs.traceTechReason') }}</dt><dd>{{ entry.tech.reasonCode }}</dd>
                <dt>{{ $t('gainos.runs.traceTechScore') }}</dt><dd>{{ entry.tech.score }}</dd>
                <dt>{{ $t('gainos.runs.traceTechCost') }}</dt><dd>{{ entry.tech.cost }}</dd>
                <dt>{{ $t('gainos.runs.traceTechRejected') }}</dt><dd>{{ entry.tech.rejectedCount }}</dd>
                <dt>{{ $t('gainos.runs.traceTechTraceId') }}</dt><dd>{{ entry.tech.traceId }}</dd>
              </dl>
            </details>
          </li>
        </ol>
        <button v-if="traceHasMore" class="run__action" type="button" :disabled="traceLoading" @click="loadMoreTrace">{{ $t('gainos.runs.traceLoadMore') }}</button>
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
          <button v-if="runActions.canRetry" class="run__action" type="button" @click="retryDialog = true">{{ $t('gainos.runs.retry') }}</button>
          <button v-if="runActions.canViewLeads" class="run__action run__action--primary" type="button" @click="goLeads">{{ $t('gainos.runs.goLeads') }}</button>
          <button class="run__action" type="button" @click="back">{{ $t('gainos.runs.adjustIcp') }}</button>
        </div>
      </section>

      <section v-if="taskAttempts.length > 1" class="run__card run__card--wide">
        <h2>{{ $t('gainos.runs.attemptHistoryTitle') }}</h2>
        <table class="run__table">
          <thead><tr><th>{{ $t('gainos.runs.attemptColumn') }}</th><th>{{ $t('gainos.runs.attemptStatus') }}</th><th>{{ $t('gainos.runs.started') }}</th><th></th></tr></thead>
          <tbody>
            <tr v-for="attempt in taskAttempts" :key="attempt.id">
              <td>
                {{ $t('gainos.runs.attemptNth', { n: attempt.attempt }) }}
                <small v-if="attempt.rerunOf" class="run__muted"> · {{ $t('gainos.runs.attemptRetriedFrom', { n: taskAttempts.find((row) => row.id === attempt.rerunOf)?.attempt ?? '?' }) }}</small>
              </td>
              <td>{{ statusLabel(attempt.status) }}</td>
              <td>{{ new Date(attempt.startedAt).toLocaleString() }}</td>
              <td>
                <button v-if="attempt.runId && attempt.runId !== runId" class="run__action" type="button" @click="router.push({ name: 'DiscoveryRun', params: { runId: attempt.runId } })">{{ $t('gainos.runs.attemptOpen') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
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

        <article v-if="stats.contacts !== undefined" class="run__card run__card--wide">
          <h2>{{ $t('gainos.runs.contactsTitle') }}</h2>
          <div class="run__chips">
            <span class="run__chip">{{ $t('gainos.runs.contactsCompanies', { count: textOf(stats.contacts.companies) }) }}</span>
            <span class="run__chip">{{ $t('gainos.runs.contactsPeople', { count: textOf(stats.contacts.people) }) }}</span>
            <span class="run__chip">{{ $t('gainos.runs.contactsEmails', { count: textOf(stats.contacts.emails) }) }}</span>
            <span class="run__chip">{{ $t('gainos.runs.contactsPhones', { count: textOf(stats.contacts.phones) }) }}</span>
            <span v-if="num(stats.contacts.failed)" class="run__chip is-warn">{{ $t('gainos.runs.contactsFailed', { count: textOf(stats.contacts.failed) }) }}</span>
            <span v-if="num(stats.contacts.skippedForLease)" class="run__chip is-warn">{{ $t('gainos.runs.leaseSkipped', { count: textOf(stats.contacts.skippedForLease) }) }}</span>
            <span v-if="stats.contacts.budgetTruncated" class="run__chip is-warn">{{ $t('gainos.runs.contactsBudgetCut') }}</span>
            <span v-for="entry in Object.entries(recordValue(stats.contacts.diagnostics))" :key="`diag-${entry[0]}`" class="run__chip">{{ entry[0] }} {{ entry[1] }}</span>
          </div>
          <dl class="run__facts">
            <div v-if="stats.contacts.contactBudget">
              <dt>{{ $t('gainos.runs.contactsBudget') }}</dt>
              <dd>{{ fmtUsd(stats.contacts.contactBudget.spentMicrousd) }} / {{ fmtUsd(stats.contacts.contactBudget.capMicrousd) }}<template v-if="stats.contacts.contactBudget.exhausted"> · {{ $t('gainos.runs.contactsBudgetExhausted') }}</template></dd>
            </div>
            <div v-if="stats.contacts.emailGuess">
              <dt>{{ $t('gainos.runs.emailGuess') }}</dt>
              <dd>{{ $t('gainos.runs.emailGuessValue', {
                missing: textOf(stats.contacts.emailGuess.emaillessContacts),
                attempted: textOf(stats.contacts.emailGuess.attempted),
                persisted: textOf(stats.contacts.emailGuess.persisted),
                verified: textOf(stats.contacts.emailGuess.verified),
                risky: textOf(stats.contacts.emailGuess.risky),
                blocked: textOf(stats.contacts.emailGuess.blocked),
              }) }}</dd>
            </div>
          </dl>
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

        <article class="run__card">
          <h2>{{ $t('gainos.runs.skipsTitle') }}</h2>
          <dl class="run__facts">
            <div v-if="recordOf('skippedQueries') && Object.keys(recordOf('skippedQueries')).length">
              <dt>{{ $t('gainos.runs.skippedQueries') }}</dt>
              <dd>
                <span v-for="(count, reason) in recordOf('skippedQueries')" :key="reason" class="run__chip is-warn" style="margin-right:6px">{{ skipReasonLabel(String(reason)) }} {{ count }}</span>
              </dd>
            </div>
            <div v-if="recordOf('skippedForLease') && Object.keys(recordOf('skippedForLease')).length">
              <dt>{{ $t('gainos.runs.skippedForLease') }}</dt>
              <dd>
                <span v-for="(count, stage) in recordOf('skippedForLease')" :key="stage" class="run__chip is-warn" style="margin-right:6px">{{ stageLabel(String(stage)) }} {{ count }}</span>
              </dd>
            </div>
            <div v-if="recordOf('modelExtractions').failed">
              <dt>{{ $t('gainos.runs.modelExtractions') }}</dt>
              <dd>{{ $t('gainos.runs.modelExtractionsValue', { invoked: textOf(recordOf('modelExtractions').invoked), failed: textOf(recordOf('modelExtractions').failed) }) }}</dd>
            </div>
            <div v-if="num(recordOf('unreplayableSkips').fit) || num(recordOf('unreplayableSkips').signals)">
              <dt>{{ $t('gainos.runs.unreplayable') }}</dt>
              <dd>fit {{ textOf(recordOf('unreplayableSkips').fit) }} · signals {{ textOf(recordOf('unreplayableSkips').signals) }}</dd>
            </div>
            <div v-if="num(recordOf('transportFailed').signals)">
              <dt>{{ $t('gainos.runs.transportFailed') }}</dt>
              <dd>{{ textOf(recordOf('transportFailed').signals) }}</dd>
            </div>
            <div v-if="num(stats.taxonomyFallback) || num(stats.taxonomyModelSkipped)">
              <dt>{{ $t('gainos.runs.taxonomy') }}</dt>
              <dd>{{ $t('gainos.runs.taxonomyValue', { fallback: textOf(stats.taxonomyFallback ?? 0), modelSkipped: textOf(stats.taxonomyModelSkipped ?? 0) }) }}</dd>
            </div>
            <div>
              <dt>{{ $t('gainos.runs.budgetCutByStage') }}</dt>
              <dd>{{ $t('gainos.runs.budgetCutValue', {
                discovery: stats.discoveryBudgetTruncated ? '✓' : '—',
                enrich: stats.enrichBudgetTruncated ? '✓' : '—',
                signals: stats.signalsBudgetTruncated ? '✓' : '—',
              }) }}</dd>
            </div>
          </dl>
        </article>
        </section>
      </details>

      <details class="run__details">
        <summary>{{ $t('gainos.runs.detailsTitle') }}</summary>
        <pre>{{ JSON.stringify(run, null, 2) }}</pre>
      </details>
    </template>

    <div v-if="retryDialog" class="run__modal" role="dialog" aria-modal="true" :aria-label="$t('gainos.runs.retryTitle')">
      <div class="run__modal-card">
        <h2>{{ $t('gainos.runs.retryTitle') }}</h2>
        <p class="run__muted">{{ $t('gainos.runs.retryLastOutcomeLabel') }}：{{ retryOutcomeText }}</p>
        <p class="run__muted">{{ $t('gainos.runs.retryBudget') }}</p>
        <p v-if="retryError" class="run__error-text" role="alert">{{ retryError }}</p>
        <div class="run__modal-actions">
          <button class="run__action" type="button" :disabled="retrying" @click="closeRetryDialog">{{ $t('gainos.common.cancel') }}</button>
          <button class="run__action run__action--primary" type="button" :disabled="retrying" @click="confirmRetry">{{ retrying ? $t('gainos.common.loading') : $t('gainos.runs.retryConfirm') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.run { padding: clamp(18px, 2.4vw, 32px) clamp(18px, 2.4vw, 34px) clamp(32px, 4vh, 48px); max-width: 1280px; margin: 0 auto; display: grid; gap: 18px; }
.run__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.run__back { border: 0; background: transparent; padding: 0; color: var(--gs-fg-muted); font-size: 13px; cursor: pointer; }
.run__back:hover { color: var(--gs-accent-strong); }
.run__kicker { display: block; margin-top: 10px; font-size: 11.5px; font-weight: 700; letter-spacing: .18em; color: var(--gs-accent-strong); }
.run__head h1 { margin: 6px 0 0; font-size: 26px; font-weight: 700; color: var(--gs-fg); }
.run__head-actions { display: flex; align-items: center; gap: 12px; padding-top: 4px; }
.run__auto { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--gs-fg-muted); }
.run__action { border: 1px solid var(--gs-border); background: var(--gs-surface); border-radius: 10px; padding: 7px 14px; font-size: 13px; cursor: pointer; color: var(--gs-fg); }
.run__modal { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; background: rgba(15, 23, 42, 0.45); padding: 24px; }
.run__modal-card { width: min(520px, 100%); background: var(--gs-surface); border-radius: 16px; padding: 22px 24px; display: grid; gap: 10px; box-shadow: 0 24px 64px rgba(15, 23, 42, 0.28); }
.run__modal-card h2 { margin: 0; font-size: 17px; }
.run__modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px; }
.run__action--primary { background: var(--gs-accent-cta); border-color: var(--gs-accent-cta); color: var(--gs-accent-cta-fg); font-weight: 600; }
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
.run__error { border-radius: 14px; border: 1px solid var(--gs-danger-border); background: var(--gs-danger-bg); color: var(--gs-danger); padding: 16px 18px; display: grid; gap: 8px; }
.run__error button { justify-self: start; border: 1px solid var(--gs-danger-border); background: var(--gs-surface); border-radius: 8px; padding: 6px 14px; cursor: pointer; color: var(--gs-danger); }
.run__error h2 { margin: 0; font-size: 16px; }
.run__error p { margin: 0; font-size: 13px; }
.run__table-scroll { max-height: 480px; overflow: auto; border-radius: 10px; }
.run__table-scroll .run__table thead th { position: sticky; top: 0; background: var(--gs-surface-2); z-index: 1; }
.run__quick-toggle { display: flex; gap: 8px; align-items: center; margin: 0 0 6px; }
.run__quick-toggle button { border: 1px solid var(--gs-border-strong); background: var(--gs-surface); border-radius: 8px; padding: 4px 10px; cursor: pointer; color: var(--gs-fg-2); }
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
.run__stage.is-done .run__stage-index { background: var(--gs-accent-cta); color: var(--gs-accent-cta-fg); }
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
/* M2 步 9b-4：「过程」时间线（只读）。 */
.run__trace { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.run__trace-item { border-left: 3px solid var(--gs-border); padding: 2px 0 2px 12px; display: grid; gap: 4px; }
.run__trace-head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; font-size: 13px; }
.run__trace-line { margin: 0; font-size: 12.5px; line-height: 1.5; }
.run__trace-line--warn { color: #b45309; }
.run__trace-meta { display: inline-flex; align-items: baseline; gap: 8px; }
.run__trace-evidence { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; font-size: 12.5px; }
.run__trace-evidence a { color: var(--gs-accent-strong); text-decoration: none; }
.run__trace-evidence a:hover { text-decoration: underline; }
.run__trace-tech { font-size: 12px; color: var(--gs-fg-subtle); }
.run__trace-tech summary { cursor: pointer; }
.run__trace-tech dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 6px 0 0; font-variant-numeric: tabular-nums; }
.run__trace-tech dt { color: var(--gs-fg-subtle); }
.run__trace-tech dd { margin: 0; overflow-wrap: anywhere; }
.run__action--danger { border-color: #b45309; color: #b45309; }
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
