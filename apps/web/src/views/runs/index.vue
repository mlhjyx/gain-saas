<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import {
  deriveStreamingFunnelProgress,
  formatDateTime,
  glossaryStatus,
  type StreamingProgressDto,
} from '@gain-saas/shared';
import { preferences } from '@vben/preferences';

import { Button, Modal, Skeleton, TabPane, Tabs } from 'ant-design-vue';

import ErrorNotice from '#/components/error-notice.vue';
import GsTag from '#/components/gainos/ui/gs-tag.vue';
import { notifyChainChanged } from '#/composables/use-main-chain-progress';
import { useWorkspaceAccess } from '#/composables/use-workspace-access';

import StreamingProgressBoard from '#/components/gainos/StreamingProgressBoard.vue';
import { feedback } from '#/feedback';
import { $t } from '#/locales';

import {
  failureText,
  type AcquisitionTaskView,
  type QueryPlan,
  gainosApi,
  type DiscoveryRun,
  type DiscoveryRunJob,
  type DiscoveryRunResultView,
  type DiscoveryRunTrace,
} from '#/api/gainos';

import QueryPlanSummary from '../tasks/query-plan-summary.vue';
import RunResults from './run-results.vue';
import SourcingLayout from './sourcing-layout.vue';
import { isRunInProgress, mintAttemptId, queryValue, sourcingPlansLocation, sourcingRunLocation } from './sourcing-navigation';

defineOptions({ name: 'DiscoveryRunView' });

type Tone = 'done' | 'current' | 'pending' | 'skipped' | 'failed';

const route = useRoute();
const router = useRouter();
// The router-view key is the concrete path, so switching run IDs remounts the view.
const runId = String(route.params.runId ?? '');
const { can, ensureLoaded, loaded: accessLoaded } = useWorkspaceAccess();
const canManage = computed(() => can('acquisition.run'));
const activeTab = computed(() => {
  const query = queryValue(route.query.tab);
  return query === 'progress' || query === 'plan' ? query : 'results';
});

function selectTab(key: string | number): void {
  if (key === 'progress' || key === 'plan' || key === 'results') {
    void router.replace(sourcingRunLocation(runId, key));
  }
}

const run = ref<DiscoveryRun | null>(null);
const streamingDto = ref<StreamingProgressDto | null>(null);
const resultView = ref<DiscoveryRunResultView | null>(null);
const loading = ref(true);
const resultsLoading = ref(true);
const resultsError = ref(false);
const recentTasks = ref<AcquisitionTaskView[]>([]);
const historyLoading = ref(true);
const historyError = ref<ReturnType<typeof failureText> | null>(null);
const profileNames = ref(new Map<string, string>());
const plan = ref<QueryPlan | null>(null);
const planLoading = ref(false);
const planError = ref<ReturnType<typeof failureText> | null>(null);
const diagnosticsOpen = ref(false);
const progressLoading = ref(false);
const progressError = ref<ReturnType<typeof failureText> | null>(null);
let disposed = false;
let runRequest = false;
let resultRequest = false;
const streamingFunnel = computed(() =>
  run.value || streamingDto.value
    ? deriveStreamingFunnelProgress({
        streamingProgress: streamingDto.value,
        run: run.value,
        jobs: jobs.value,
      })
    : null,
);
const error = ref<{ title: string; next?: string } | null>(null);
const auto = ref(true);
let timer: ReturnType<typeof setTimeout> | null = null;

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
    const rows = await gainosApi.runJobs(runId);
    jobs.value = Array.isArray(rows) ? rows : [];
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
    traceRows.value = Array.isArray(page?.data) ? page.data : [];
    traceCursor.value = page?.page?.next_cursor ?? null;
    traceHasMore.value = page?.page?.has_more ?? false;
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
    const time = formatDateTime(row.createdAt);
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
    if (Array.isArray(page?.events) && page.events.length > 0) {
      lastSeq.value = page.nextAfter;
      await Promise.all([loadJobs(), diagnosticsOpen.value ? loadTrace() : Promise.resolve()]);
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
const retryError = ref<ReturnType<typeof failureText> | null>(null);
const retryAttemptId = ref<string | null>(null);
const taskDetail = ref<AcquisitionTaskView | null>(null);
const taskAttempts = computed<AttemptRow[]>(() => (taskDetail.value?.runs ?? [])
  .map((row) => ({
    id: row.id,
    runId: row.runId,
    attempt: row.attempt ?? 1,
    rerunOf: row.rerunOf ?? null,
    status: row.status,
    startedAt: row.startedAt,
  }))
  .sort((a, b) => a.attempt - b.attempt));
const canRetry = computed(() => {
  const status = run.value?.status ?? '';
  return canManage.value && ['FAILED', 'PARTIAL', 'CANCELLED'].includes(status) &&
    Boolean(run.value?.planId) && taskDetail.value?.status === 'active' &&
    !taskAttempts.value.some((attempt) => isRunInProgress(attempt.status));
});
const runTitle = computed(() =>
  (run.value?.icpId ? profileNames.value.get(run.value.icpId) : undefined) ??
  taskDetail.value?.name ?? $t('gainosBuyerJourney.sourcing.runtimeDetail'));
const canStop = computed(() => canManage.value && run.value?.status === 'RUNNING');

const retryOutcomeText = computed(() => {
  const status = statusLabel(run.value?.status);
  const stage = String(failure.value?.stage ?? '');
  const key = FAILURE_STAGE[stage];
  return key
    ? $t('gainos.runs.retryLastOutcome', { status, stage: userStageLabel(key) })
    : status;
});

async function loadHistory(): Promise<void> {
  historyLoading.value = true;
  historyError.value = null;
  try {
    const items = await gainosApi.acquisitionTasks();
    if (!Array.isArray(items)) throw new Error('Invalid task list');
    recentTasks.value = items;
    if (run.value?.taskRef?.taskId && !taskDetail.value) {
      taskDetail.value = items.find((item) => item.id === run.value?.taskRef?.taskId) ?? null;
    }
  } catch (err) {
    historyError.value = failureText(err);
  } finally {
    historyLoading.value = false;
  }
}

async function loadTaskAttempts(taskId: string): Promise<AcquisitionTaskView | null> {
  try {
    const task = await gainosApi.getTask(taskId);
    taskDetail.value = task?.id === taskId ? task : null;
    return taskDetail.value;
  } catch {
    taskDetail.value = null;
    return null;
  }
}

async function confirmRetry(): Promise<void> {
  const current = run.value;
  const taskId = current?.taskRef?.taskId;
  if (retrying.value || !canRetry.value || !taskId || !current?.planId) return;
  retrying.value = true;
  retryError.value = null;
  try {
    // Recheck the bound task before making another billable dispatch.
    const task = await loadTaskAttempts(taskId);
    if (!task || !canRetry.value) {
      retryError.value = { title: $t('gainos.runs.retryUnavailable'), why: undefined, next: undefined };
      return;
    }
    retryAttemptId.value ??= mintAttemptId();
    const result = await gainosApi.startAcquisitionTaskRun(taskId, current.planId, retryAttemptId.value);
    notifyChainChanged();
    retryDialog.value = false;
    if (result.runId) {
      retryAttemptId.value = null;
      await router.push(sourcingRunLocation(result.runId, 'progress'));
    } else {
      retryNotice.value = $t('gainosBuyerJourney.sourcing.outcomeUnknown');
      await loadTaskAttempts(taskId);
    }
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status && status >= 400 && status < 500 && status !== 408) retryAttemptId.value = null;
    retryError.value = failureText(err);
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
  if (stopping.value || !canStop.value) return;
  feedback.confirm({
    title: $t('gainos.runs.stopDeep'),
    cancelText: $t('gainos.common.cancel'),
    content: $t('gainos.runs.stopConfirm'),
    okText: $t('gainos.runs.stopDeep'),
    okType: 'danger',
    onOk: async () => {
      stopping.value = true;
      stopNotice.value = null;
      try {
        await gainosApi.cancelDiscoveryRun(runId);
        stopNotice.value = $t('gainos.runs.stopRequested');
        notifyChainChanged();
        await load();
      } catch (err) {
        jobError.value = failureText(err).title;
      } finally {
        stopping.value = false;
      }
    },
  });
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
/** 查询跳过原因 → 双语映射（自 gainosB4.json 读取；未收录的原样回退）。 */
function skipReasonLabel(reason: string): string {
  const key = `gainosB4.runs.skipReason.${reason}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? reason : translated;
}
/** 租约跳过按阶段 → 双语映射（键与引擎 leaseSkips 一致）。 */
function stageLabel(stage: string): string {
  const key = `gainosB4.runs.leaseStage.${stage}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? stage : translated;
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

type UserStageKey = 'collect' | 'enrich' | 'match' | 'output' | 'search';

const userStages = computed(() => {
  const terminal = Boolean(run.value) && run.value!.status !== 'RUNNING';
  const failedKey = FAILURE_STAGE[String(recordOf('failure').stage ?? '')];
  // 引擎 2.0 的进度以 run.phases 为准。旧版的统计字段（搜索组数、企业数、匹配数）不再回填，
  // 只靠它们判断，会把已经走过的步骤一直显示成「等待开始」。
  // 数字同理：新格式 run 记在 stats.quickScan / stats.deep，stats.queries / companies / fit / signals
  // 只有旧版 run 才有。
  const phases = (run.value as { phases?: PhaseView | null } | null)?.phases;
  const filled = (value: unknown): boolean => typeof value === 'string' && value.length > 0;
  const quickStarted = filled(phases?.quickStartedAt);
  const quickDone = filled(phases?.quickDoneAt);
  const deepStarted = filled(phases?.deepStartedAt);
  const deepDone = filled(phases?.deepDoneAt);
  const deepRunning = deepStarted && !deepDone;
  const legacyFit = stats.value.fit !== undefined;
  const hasSignals = stats.value.signals !== undefined;
  const signalMatched = Number(stats.value.signals?.matched ?? 0);
  // 引擎阶段 → 用户步骤：快扫（quick）覆盖搜索、收集、匹配；深挖（deep）是补充信号；收尾是汇总产出。
  // 快扫内部不再细分，所以快扫一开始就算搜索、收集已走过，由「匹配判断」代表快扫的进度。
  const phaseCurrent: null | UserStageKey = terminal
    ? null
    : deepDone
      ? 'output'
      : deepStarted || quickDone
        ? 'enrich'
        : quickStarted
          ? 'match'
          : null;
  const withCount = (value: unknown, key: string): string =>
    value === undefined || value === null ? '' : $t(`gainos.runs.userStage.${key}`, { count: textOf(value) });
  const done = $t('gainos.runs.userStage.done');
  const running = $t('gainos.runs.userStage.inProgress');
  const waiting = $t('gainos.runs.userStage.waiting');
  const defs: Array<{ has: boolean; hint: string; key: UserStageKey; label: string; value: string }> = [
    {
      key: 'search',
      label: userStageLabel('search'),
      value: withCount(stats.value.queries, 'searchValue') || (quickStarted ? done : waiting),
      hint: $t('gainos.runs.userStage.searchHint'),
      has: stats.value.queries !== undefined || quickStarted,
    },
    {
      key: 'collect',
      label: userStageLabel('collect'),
      value: withCount(summaryCompanies.value, 'collectValue') || (quickStarted ? done : waiting),
      hint: $t('gainos.runs.userStage.collectHint'),
      has: stats.value.companies !== undefined || quickScan.value.poolSize !== undefined || quickStarted,
    },
    {
      key: 'match',
      label: userStageLabel('match'),
      value:
        withCount(legacyFit ? (fit.value.match ?? 0) : quickScan.value.match, 'matchValue') ||
        (quickDone ? done : quickStarted ? running : waiting),
      hint: $t('gainos.runs.userStage.matchHint'),
      // 快扫进行中时匹配数会先出来一部分，这时仍算「进行中」，等快扫结束才算完成。
      has: legacyFit || quickDone || (terminal && quickScan.value.match !== undefined),
    },
    {
      key: 'enrich',
      label: userStageLabel('enrich'),
      value: hasSignals
        ? signalMatched > 0
          ? $t('gainos.runs.userStage.enrichValue', { count: textOf(signalMatched) })
          : $t('gainos.runs.userStage.noExtraSignals')
        : deepDone
          ? done
          : deepRunning
            ? running
            : waiting,
      hint: $t('gainos.runs.userStage.enrichHint'),
      // 深挖还没结束时信号数会先出来一部分，这时仍算「进行中」。
      has: deepDone || (hasSignals && !deepRunning),
    },
    {
      key: 'output',
      label: userStageLabel('output'),
      value: terminal ? statusLabel(run.value?.status) : deepDone ? running : $t('gainos.runs.userStage.outputRunning'),
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
      // 有阶段标记时按标记走；标记里还没轮到的步骤一律「等待开始」。
      // 没有标记（旧 run，或刚建好还没开始快扫）时退回「第一个没走过的步骤就是当前步骤」。
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
  if (status === 'DONE' || status === 'COMPLETED') return 'is-ok';
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
  return glossaryStatus('run', status, preferences.app.locale)?.label ??
    $t(status === 'QUEUED' ? 'gainosBuyerJourney.sourcing.queued' : 'gainosBuyerJourney.sourcing.unknownStatus');
}

function toneLabel(tone: Tone): string {
  return $t(`gainos.runs.stageState.${tone}`);
}

async function loadResult(): Promise<void> {
  const current = run.value;
  if (!current || resultRequest || disposed) return;
  resultRequest = true;
  resultsLoading.value = true;
  try {
    const result = await gainosApi.discoveryRunResultView(runId);
    if (disposed) return;
    if (result?.runId !== runId || result.icpId !== current.icpId ||
      !Array.isArray(result.candidates?.items) ||
      !Array.isArray(result.scoring?.thisRun?.items) || !Array.isArray(result.scoring?.latest?.items)) {
      throw new Error('Invalid result view');
    }
    resultView.value = result;
    resultsError.value = false;
  } catch {
    resultsError.value = true;
  } finally {
    resultRequest = false;
    resultsLoading.value = false;
  }
}

async function loadPlan(): Promise<void> {
  const current = run.value;
  if (!current?.icpId || !current.planId || planLoading.value) return;
  planLoading.value = true;
  planError.value = null;
  try {
    const data = await gainosApi.queryPlans(current.icpId);
    if (!Array.isArray(data)) throw new Error('Invalid plan list');
    plan.value = data.find((entry) => entry.id === current.planId && entry.icpId === current.icpId) ?? null;
  } catch (err) {
    planError.value = failureText(err);
  } finally {
    planLoading.value = false;
  }
}

async function loadProgress(): Promise<void> {
  if (progressLoading.value) return;
  progressLoading.value = true;
  try {
    const res = await gainosApi.streamingProgress(runId);
    streamingDto.value = res && typeof res === 'object' && 'stages' in res ? res : null;
    progressError.value = null;
  } catch (err) {
    progressError.value = failureText(err);
  } finally {
    progressLoading.value = false;
  }
  if (diagnosticsOpen.value) await pollEvents();
}

function toggleDiagnostics(event: Event): void {
  const open = (event.currentTarget as HTMLDetailsElement).open;
  diagnosticsOpen.value = open;
  if (open && !traceRows.value.length) void Promise.all([loadJobs(), loadTrace()]);
}

watch(activeTab, (tab) => {
  if (tab === 'results') void loadResult();
  if (tab === 'progress') void loadProgress();
  if (tab === 'plan' && !plan.value) void loadPlan();
});

async function load(): Promise<void> {
  if (runRequest || disposed) return;
  runRequest = true;
  loading.value = !run.value;
  try {
    const data = await gainosApi.discoveryRun(runId);
    if (disposed) return;
    if (!data || data.id !== runId) throw new Error('Invalid run');
    const initial = !run.value;
    run.value = data;
    error.value = null;
    if (initial || activeTab.value === 'results') void loadResult();
    if (activeTab.value === 'progress') void loadProgress();
    if (activeTab.value === 'plan' && !plan.value) void loadPlan();
    if (initial && data.taskRef?.taskId) void loadTaskAttempts(data.taskRef.taskId);
  } catch (err) {
    error.value = failureText(err);
  } finally {
    runRequest = false;
    loading.value = false;
    schedule();
  }
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!disposed && auto.value && run.value && isRunInProgress(run.value.status)) {
    timer = setTimeout(() => void load(), 3000);
  }
}

watch(auto, schedule);

onMounted(() => {
  void ensureLoaded();
  void load();
  void loadHistory();
  void gainosApi.icps().then((rows) => {
    if (Array.isArray(rows)) profileNames.value = new Map(rows.map((item) => [item.id, item.name]));
  }).catch(() => undefined);
});
onUnmounted(() => {
  disposed = true;
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <SourcingLayout
    :active-run-id="runId"
    :load-error="historyError"
    :loading="historyLoading"
    :profiles="profileNames"
    :tasks="recentTasks"
    @retry="loadHistory"
  >
    <template #rail>
      <RouterLink class="run__task-link" :to="{ name: 'Tasks', query: { tab: 'manage' } }">
        {{ $t('gainosBuyerJourney.sourcing.taskManagement') }}
      </RouterLink>
    </template>
    <div class="run">
      <div v-if="error" class="run__inline-stack">
        <ErrorNotice v-bind="error" />
        <Button class="justify-self-start" @click="load">{{ $t('gainos.common.retry') }}</Button>
      </div>
      <Skeleton v-if="loading" active :paragraph="{ rows: 3 }" />
      <template v-else-if="run">
        <header class="run__head" data-gs="run-head">
          <div>
            <div class="run__title">
              <h2>{{ runTitle }}</h2>
              <GsTag :tone="statusTone === 'is-ok' ? 'success' : run.status === 'RUNNING' ? 'info' : run.status === 'PARTIAL' ? 'warning' : run.status === 'FAILED' ? 'danger' : 'neutral'">
                {{ statusLabel(run.status) }}
              </GsTag>
            </div>
            <RouterLink
              v-if="run.icpId"
              class="run__task-link"
              :to="{ name: 'FindBuyers', query: { icp: run.icpId } }"
            >{{ $t('gainosBuyerJourney.sourcing.openProfile') }}</RouterLink>
          </div>
          <Button v-if="canRetry" type="primary" @click="retryDialog = true">{{ $t('gainosBuyerJourney.sourcing.restart') }}</Button>
        </header>
        <p v-if="retryNotice" class="run__muted" role="status">{{ retryNotice }}</p>
        <Tabs :active-key="activeTab" @change="selectTab">
          <TabPane key="results" :tab="$t('gainosBuyerJourney.results.results')">
            <RunResults :error="resultsError" :loading="resultsLoading" :result="resultView" :status="run.status" @retry="loadResult" />
          </TabPane>
          <TabPane key="progress" :tab="$t('gainosBuyerJourney.results.progress')">
            <div class="run__inline-stack">
              <div class="run__head-actions">
                <label v-if="isRunInProgress(run.status)" class="run__auto"><input v-model="auto" type="checkbox" /> {{ $t('gainos.runs.autoRefresh') }}</label>
                <Button @click="load">{{ $t('gainos.common.refresh') }}</Button>
                <Button v-if="canStop" danger :loading="stopping" @click="stopDeep">{{ $t('gainos.runs.stopDeep') }}</Button>
              </div>
              <p v-if="accessLoaded && !canManage && run.status === 'RUNNING'" class="run__muted">{{ $t('gainosBuyerJourney.profile.notPermitted') }}</p>
              <p v-if="stopNotice" class="run__muted" role="status">{{ stopNotice }}</p>
              <p v-if="jobError" class="run__error-text" role="alert">{{ jobError }}</p>
              <div v-if="progressError" class="run__inline-stack">
                <ErrorNotice v-bind="progressError" />
                <Button class="justify-self-start" @click="loadProgress">{{ $t('gainos.common.retry') }}</Button>
              </div>
      <StreamingProgressBoard
        v-if="streamingDto && streamingFunnel"
        :cancelling="stopping"
        :progress="streamingFunnel"
        :show-cancel-action="false"
        :show-refresh-action="false"
        @cancel="stopDeep"
        @refresh="load"
        @view-leads="selectTab('results')"
      />
      <section v-if="!streamingDto" class="run__user-stages" :aria-label="$t('gainos.runs.userProgress')">
        <article
          v-for="(stage, index) in userStages"
          :key="stage.key"
          class="run__user-stage"
          :class="`is-${stage.tone}`"
          :data-gs-state="stage.tone"
          data-gs="run-stage"
        >
          <span class="run__stage-index">{{ index + 1 }}</span>
          <strong>{{ stage.label }}</strong>
          <span class="run__user-stage-value" data-gs="run-stage-value">{{ stage.value }}</span>
          <span class="run__stage-hint">{{ stage.hint }}</span>
        </article>
      </section>

      <section class="run__summary">
        <article class="run__status-card">
          <span class="run__badge" :class="statusTone">{{ statusLabel(run.status) }}</span>
          <p class="run__muted">{{ $t('gainos.runs.started') }} {{ formatDateTime(run.createdAt) }}</p>
          <p v-if="run.taskRef?.taskId" class="run__muted">
            {{ $t('gainos.runs.taskLabel') }}
            <RouterLink class="run__task-link" :to="{ name: 'TaskDetail', params: { taskId: run.taskRef.taskId } }">
              {{ taskDetail?.name ?? $t('gainosBuyerJourney.sourcing.taskManagement') }}
            </RouterLink>
          </p>
          <p class="run__muted">{{ $t('gainos.runs.duration') }} {{ elapsed }}</p>
          <p v-if="run.completedAt" class="run__muted">{{ $t('gainos.runs.completed') }} {{ formatDateTime(run.completedAt) }}</p>
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
              <td>{{ formatDateTime(attempt.startedAt) }}</td>
              <td>
                <button v-if="attempt.runId && attempt.runId !== runId" class="run__action" type="button" @click="router.push({ name: 'DiscoveryRun', params: { runId: attempt.runId } })">{{ $t('gainos.runs.attemptOpen') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </section>


              <details class="run__tech run__diagnostics" @toggle="toggleDiagnostics">
                <summary>{{ $t('gainosBuyerJourney.results.diagnostics') }}</summary>
                <div v-if="diagnosticsOpen" class="run__inline-stack">      <section class="run__grid">
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

      <!-- 内部编号对用户没有意义，从页头挪到这里：反馈问题时才需要拿来对账。 -->
      <details class="run__tech">
        <summary>{{ $t('gainos.runs.techIdentity') }}</summary>
        <p class="run__muted run__identity" data-gs="run-identity">
          <span v-if="run.icpId">{{ $t('gainos.runs.icp') }} <code class="run__mono">{{ run.icpId }}</code></span>
          <span v-if="run.planId"> · {{ $t('gainos.runs.plan') }} <code class="run__mono">{{ run.planId }}</code></span>
          <span> · {{ $t('gainos.runs.taskId') }} <code class="run__mono">{{ run.id }}</code></span>
        </p>
      </details>

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

                </div>
              </details>
            </div>
          </TabPane>
          <TabPane key="plan" :tab="$t('gainosBuyerJourney.results.plan')">
            <div class="run__inline-stack">
              <Skeleton v-if="planLoading" active :paragraph="{ rows: 3 }" />
              <div v-else-if="planError" class="run__inline-stack">
                <ErrorNotice :title="$t('gainosBuyerJourney.sourcing.planError')" :next="planError.title" />
                <Button class="justify-self-start" @click="loadPlan">{{ $t('gainos.common.retry') }}</Button>
              </div>
              <QueryPlanSummary v-else-if="plan" :key="plan.id" :plan="plan" />
              <p v-else class="run__muted">{{ $t('gainosBuyerJourney.sourcing.planMissing') }}</p>
              <RouterLink v-if="run.icpId" class="run__task-link" :to="sourcingPlansLocation(run.icpId)">
                {{ $t('gainosBuyerJourney.sourcing.planHistory') }}
              </RouterLink>
            </div>
          </TabPane>
        </Tabs>
      </template>
    </div>
    <Modal
      :open="retryDialog"
      :title="$t('gainosBuyerJourney.sourcing.retryTitle')"
      :ok-text="$t('gainosBuyerJourney.sourcing.restart')"
      :cancel-text="$t('gainos.common.cancel')"
      :confirm-loading="retrying"
      :closable="!retrying"
      :mask-closable="!retrying"
      :keyboard="!retrying"
      @ok="confirmRetry"
      @cancel="closeRetryDialog"
    >
      <div class="run__inline-stack">
        <p class="run__muted">{{ $t('gainos.runs.retryLastOutcomeLabel') }} · {{ retryOutcomeText }}</p>
        <p class="run__muted">{{ $t('gainosBuyerJourney.sourcing.retryBilling') }}</p>
        <RouterLink class="run__task-link" :to="{ path: '/settings/account', hash: '#wallet' }">{{ $t('gainosBuyerJourney.sourcing.wallet') }}</RouterLink>
        <ErrorNotice v-if="retryError" v-bind="retryError" />
      </div>
    </Modal>
  </SourcingLayout>
</template>

<style scoped>
.run { display: grid; min-width: 0; gap: 10px; overflow-wrap: anywhere; }
.run__title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.run__title h2 { margin: 0; font-size: clamp(19px, 2vw, 24px); font-weight: 600; }
.run__inline-stack { display: grid; gap: 12px; min-width: 0; }
.run__head .run__task-link { display: inline-flex; min-height: 40px; align-items: center; }
.run__diagnostics > summary { min-height: 30px; }

.run__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.run__back { border: 0; background: transparent; padding: 0; color: var(--gs-fg-muted); font-size: 13px; cursor: pointer; }
.run__back:hover { color: var(--gs-accent-strong); }
.run__kicker { display: block; margin-top: 10px; font-size: 12px; line-height: 16px; font-weight: 500; letter-spacing: .04em; color: var(--gs-accent-strong); }
.run__head h1 { margin: 6px 0 0; font-size: 24px; line-height: 32px; font-weight: 500; letter-spacing: -.011em; color: var(--gs-fg); }
.run__head-actions { display: flex; align-items: center; gap: 12px; padding-top: 4px; }
.run__auto { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--gs-fg-muted); }
.run__action { border: 1px solid var(--gs-border); background: var(--gs-surface); border-radius: 10px; padding: 7px 14px; font-size: 13px; cursor: pointer; color: var(--gs-fg); }
.run__modal { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; background: rgba(23,23,23,.45); padding: 24px; }
.run__modal-card { width: min(520px, 100%); background: var(--gs-surface); border-radius: 16px; padding: 22px 24px; display: grid; gap: 10px; box-shadow: 0 24px 64px rgba(23,23,23,.28); }
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
.run__task-link { color: var(--gs-accent-strong); font-weight: 600; text-decoration: none; }
.run__task-link:hover { text-decoration: underline; }
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
.run__head-actions button { white-space: nowrap; }
.run__summary { display: grid; grid-template-columns: minmax(260px, 1.6fr) repeat(5, minmax(110px, 1fr)); gap: 12px; }
.run__summary article { background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px; padding: 14px 16px; display: grid; gap: 6px; align-content: start; }
.run__summary article span { font-size: 12px; color: var(--gs-fg-muted); }
.run__summary article strong { font-size: 24px; font-weight: 680; color: var(--gs-fg); }
.run__summary article.is-bad strong { color: var(--gs-danger); }
.run__status-card { gap: 6px !important; }
.run__badge { justify-self: start; border-radius: 999px; padding: 3px 10px; font-size: 11.5px; font-weight: 700; }
.run__badge.is-ok { background: var(--gs-accent-soft); color: var(--gs-accent-strong); }
.run__badge.is-warn { background: var(--gs-warn-bg); color: var(--gs-warn); }
.run__badge.is-bad { background: var(--gs-danger-bg); color: var(--gs-danger); }
.run__badge.is-running { background: var(--gs-indigo-soft); color: var(--gs-indigo); }
.run__user-stages { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
.run__user-stage { background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px; padding: 12px 14px; display: grid; gap: 5px; }
.run__user-stage.is-done { border-color: var(--gs-accent-soft-border); background: linear-gradient(180deg, var(--gs-accent-soft), var(--gs-surface)); }
.run__user-stage.is-current { border-color: var(--gs-accent); box-shadow: 0 0 0 1px var(--gs-accent) inset; }
.run__user-stage.is-failed { border-color: var(--gs-danger-border); background: var(--gs-danger-bg); }
.run__user-stage.is-pending, .run__user-stage.is-skipped { opacity: .62; }
.run__user-stage strong { font-size: 13.5px; color: var(--gs-fg); }
.run__user-stage-value { font-size: 20px; font-weight: 700; color: var(--gs-fg); line-height: 1.2; }
.run__tech { border: 1px solid var(--gs-border); border-radius: 12px; background: var(--gs-surface); padding: 12px 14px; }
.run__tech > summary { cursor: pointer; font-size: 13px; font-weight: 600; color: var(--gs-fg-2); }
.run__tech[open] > summary { margin-bottom: 12px; }
.run__stages { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; }
.run__stage { position: relative; background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px; padding: 12px 14px; display: grid; gap: 4px; }
.run__stage.is-done { border-color: var(--gs-accent-soft-border); background: linear-gradient(180deg, var(--gs-accent-soft), var(--gs-surface)); }
.run__stage.is-current { border-color: var(--gs-accent); box-shadow: 0 0 0 1px var(--gs-accent) inset; }
.run__stage.is-failed { border-color: var(--gs-danger-border); background: var(--gs-danger-bg); }
.run__stage.is-pending, .run__stage.is-skipped { opacity: .62; }
.run__stage-top { display: flex; justify-content: space-between; align-items: center; }
.run__stage-index { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; background: var(--gs-surface-2); color: var(--gs-fg-muted); font-size: 11px; font-weight: 700; }
.run__stage.is-done .run__stage-index { background: var(--gs-accent-cta); color: var(--gs-accent-cta-fg); }
.run__stage-state { font-size: 10.5px; font-weight: 700; letter-spacing: .04em; color: var(--gs-fg-muted); text-transform: uppercase; }
.run__stage.is-done .run__stage-state { color: var(--gs-accent-strong); }
.run__stage.is-failed .run__stage-state { color: var(--gs-danger); }
.run__stage strong { font-size: 13px; color: var(--gs-fg); }
.run__stage-value { font-size: 20px; font-weight: 700; color: var(--gs-fg); }
.run__stage-hint { font-size: 11px; color: var(--gs-fg-muted); min-height: 28px; }
.run__failure { border-radius: 14px; border: 1px solid var(--gs-danger-border); background: var(--gs-danger-bg); padding: 16px 18px; display: grid; gap: 10px; }
.run__failure h2 { margin: 0; font-size: 15px; color: var(--gs-danger); }
.run__failure dl { margin: 0; display: flex; gap: 24px; flex-wrap: wrap; }
.run__failure dt { font-size: 11px; color: var(--gs-danger); text-transform: uppercase; letter-spacing: .08em; }
.run__failure dd { margin: 2px 0 0; font-size: 13px; color: var(--gs-danger); }
.run__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; }
.run__card { background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px; padding: 16px 18px; display: grid; gap: 10px; align-content: start; }
.run__card--wide { grid-column: 1 / -1; }
.run__rv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
.run__rv-box { display: grid; gap: 4px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--gs-border); background: var(--gs-surface-2); }
.run__rv-box strong { font-size: 14px; font-weight: 600; color: var(--gs-fg); display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.run__card h2 { margin: 0; font-size: 14px; font-weight: 650; color: var(--gs-fg); }
.run__table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.run__table th, .run__table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--gs-border); vertical-align: top; }
.run__table th { color: var(--gs-fg-muted); font-weight: 600; background: var(--gs-bg-soft, var(--gs-surface-3)); }
.run__table tr:last-child td { border-bottom: 0; }
.run__chips { display: flex; flex-wrap: wrap; gap: 8px; }
.run__chip { border-radius: 999px; padding: 2px 9px; background: var(--gs-surface-2); color: var(--gs-fg-muted); font-size: 11.5px; font-weight: 600; }
.run__chip.is-warn { background: var(--gs-warn-bg); color: var(--gs-warn); }
.run__facts { margin: 0; display: grid; gap: 6px; }
.run__facts div { display: grid; grid-template-columns: 130px 1fr; gap: 8px; font-size: 12.5px; }
.run__facts dt { color: var(--gs-fg-muted); }
.run__facts dd { margin: 0; color: var(--gs-fg); word-break: break-word; }
.run__error-text { color: var(--gs-warn); max-width: 420px; word-break: break-word; }
/* M2 步 9b-4：「过程」时间线（只读）。 */
.run__trace { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.run__trace-item { border-left: 3px solid var(--gs-border); padding: 2px 0 2px 12px; display: grid; gap: 4px; }
.run__trace-head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; font-size: 13px; }
.run__trace-line { margin: 0; font-size: 12.5px; line-height: 1.5; }
.run__trace-line--warn { color: var(--gs-warn); }
.run__trace-meta { display: inline-flex; align-items: baseline; gap: 8px; }
.run__trace-evidence { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; font-size: 12.5px; }
.run__trace-evidence a { color: var(--gs-accent-strong); text-decoration: none; }
.run__trace-evidence a:hover { text-decoration: underline; }
.run__trace-tech { font-size: 12px; color: var(--gs-fg-subtle); }
.run__trace-tech summary { cursor: pointer; }
.run__trace-tech dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 6px 0 0; font-variant-numeric: tabular-nums; }
.run__trace-tech dt { color: var(--gs-fg-subtle); }
.run__trace-tech dd { margin: 0; overflow-wrap: anywhere; }
.run__action--danger { border-color: var(--gs-warn); color: var(--gs-warn); }
.run__details { border: 1px solid var(--gs-border); border-radius: 14px; background: var(--gs-surface); padding: 14px 18px; }
.run__details summary { cursor: pointer; font-size: 13px; font-weight: 600; color: var(--gs-fg); }
.run__details pre { margin: 12px 0 0; font-size: 11.5px; line-height: 1.6; max-height: 420px; overflow: auto; background: var(--gs-bg-soft, var(--gs-surface-3)); padding: 14px; border-radius: 10px; }
@media (max-width: 900px) {
  .run__summary { grid-template-columns: repeat(2, 1fr); }
  .run__summary article:first-child { grid-column: 1 / -1; }
  .run__user-stages { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .run__user-stage:last-child { grid-column: 1 / -1; }
}
</style>
