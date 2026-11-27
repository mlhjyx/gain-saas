import type { AcquisitionTaskView, QueryPlan, TaskRunView } from '#/api/gainos';

const TERMINAL_STATUSES = new Set(['DONE', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED']);

export function isRunInProgress(status: string): boolean {
  return !TERMINAL_STATUSES.has(status.trim().toUpperCase());
}

export function recentTaskRuns(tasks: AcquisitionTaskView[]) {
  return tasks
    .flatMap((task) => (task.runs ?? []).map((run) => ({ run, task })))
    .sort((a, b) => (b.run.startedAt ?? '').localeCompare(a.run.startedAt ?? ''));
}

export function newestPlans(plans: QueryPlan[]): QueryPlan[] {
  return [...plans].sort(
    (a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || b.version - a.version,
  );
}

export function queryValue(input: unknown): string {
  const value = Array.isArray(input) ? input[0] : input;
  return typeof value === 'string' ? value : '';
}

export function sourcingPlansLocation(icp: string, plan?: string) {
  return { name: 'Tasks', query: { icp, tab: 'plan', ...(plan ? { plan } : {}) } };
}

export function sourcingRunLocation(runId: string, tab?: 'plan' | 'progress' | 'results') {
  return {
    name: 'DiscoveryRun',
    params: { runId },
    query: tab && tab !== 'results' ? { tab } : {},
  };
}

export function taskRunLocation(task: AcquisitionTaskView, run: TaskRunView) {
  return run.runId
    ? sourcingRunLocation(run.runId)
    : { name: 'TaskDetail', params: { taskId: task.id } };
}

export function mintAttemptId(): string {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  // getRandomValues is also available on HTTP installations without randomUUID.
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
