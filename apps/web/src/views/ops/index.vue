<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue';

defineOptions({ name: 'OpsConsole' });

type Row = Record<string, any>;

const authed = ref(false);
const checking = ref(true);
const loginEmail = ref('');
const loginPassword = ref('');
const loginError = ref('');
const loggingIn = ref(false);
const operator = ref<{ email: string } | null>(null);

const TABS = [
  { key: 'overview', label: '概览' },
  { key: 'users', label: '用户' },
  { key: 'workspaces', label: '工作空间' },
  { key: 'providers', label: '数据源' },
  { key: 'sources', label: '监控源' },
  { key: 'budget', label: '预算' },
  { key: 'diagnostics', label: '诊断' },
  { key: 'schedules', label: '调度' },
  { key: 'revocations', label: '平台撤销' },
  { key: 'audit', label: '审计' },
] as const;
const active = ref<string>('overview');
const loading = ref(false);
const error = ref('');
const notice = ref('');

const overview = ref<Row | null>(null);
const providers = ref<Row[]>([]);
const sources = ref<Row[]>([]);
const budget = ref<{ accounts: Row[]; authorities: Row[] } | null>(null);
const workspaces = ref<Row[]>([]);
const users = ref<Row[]>([]);
const userQuery = ref('');
const userBusy = ref('');
const workspaceId = ref('');
const runs = ref<Row[]>([]);
const leads = ref<Row[]>([]);
const outbox = ref<Row[]>([]);
const auditEntries = ref<Row[]>([]);
const schedules = ref<Row[]>([]);
const scheduleWhitelist = ref<Array<{ type: string; label: string }>>([]);
const workflowRows = ref<Row[]>([]);
const workflowStatus = ref('');
const workflowLoading = ref(false);
const scheduleForm = ref({ scheduleId: '', workflowType: 'acquisitionSweepWorkflow', intervalMinutes: 60, note: '' });
const scheduleBusy = ref(false);
const revocationRows = ref<Row[]>([]);
const revocationPolicy = ref<Row[]>([]);
const revocationBusy = ref('');
const r4Flags = ref<{ triggerEnabled: boolean; autoConfirm: boolean }>({ triggerEnabled: false, autoConfirm: false });
const revocationForm = ref({ scheduleId: 'acq-sweep', reasonCode: 'OPERATOR_HOLD', note: '' });
const REVOCATION_REASONS = [
  { value: 'OPERATOR_HOLD', label: '运维停机（OPERATOR_HOLD）' },
  { value: 'SECURITY_RESPONSE', label: '安全响应（SECURITY_RESPONSE）' },
  { value: 'POLICY_DISABLED', label: '政策停用（POLICY_DISABLED）' },
] as const;
const REVOCATION_SCHEDULES = ['acq-sweep', 'intent-sweep', 'sanctions-refresh'] as const;
const sourceDetail = ref<{ source: Row; recentFetches: Row[] } | null>(null);
const fetchRows = ref<Row[]>([]);
const changeRows = ref<Row[]>([]);
const traceRows = ref<Row[]>([]);
const fetchStatus = ref('');
const changeType = ref('');
const traceStatus = ref('');
const sourceBusy = ref(false);
const sourceModal = ref<{ mode: 'create' | 'edit'; id?: string; sourceKey: string } | null>(null);
const sourceForm = ref({
  providerKey: '',
  sourceKey: '',
  label: '',
  region: '',
  seriesKey: '',
  sectorTags: '',
  cadenceMinutes: 0,
  configText: '{}',
});

const activeLabel = computed(() => TABS.find((tab) => tab.key === active.value)?.label ?? '');

async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message ?? body?.message ?? `HTTP ${response.status}`);
  }
  return body as T;
}

function fmt(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(value).toLocaleString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
function badgeClass(status: unknown): string {
  const value = String(status ?? '').toUpperCase();
  if (['ENABLED', 'ACTIVE', 'READY', 'SUCCEEDED', 'QUALIFIED', 'DONE', 'OK'].includes(value)) return 'is-ok';
  if (['DISABLED', 'PAUSED', 'ARCHIVED', 'FAILED', 'SUPPRESSED', 'ERROR', 'PARTIAL'].includes(value)) return 'is-warn';
  return 'is-muted';
}
function countOf(rows: Row[] | undefined): string {
  return rows?.map((row) => `${row.status ?? row.state ?? '—'} ${row.n}`).join(' · ') || '—';
}

async function loadOverview(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    overview.value = await api<Row>('/api/ops/overview');
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}
async function loadProviders(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    providers.value = (await api<{ providers: Row[] }>('/api/ops/providers')).providers ?? [];
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}
async function loadSources(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    sources.value = (await api<{ sources: Row[] }>('/api/ops/sources')).sources ?? [];
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}
async function loadBudget(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    budget.value = (await api<{ data: { accounts: Row[]; authorities: Row[] } }>('/api/ops/budget')).data;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}
const workspaceBusy = ref('');

async function loadWorkspaceAdmin(): Promise<void> {
  try {
    workspaces.value = (await api<{ workspaces: Row[] }>('/api/ops/workspaces')).workspaces ?? [];
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function handleWorkspaceStatus(workspace: Row, event: Event): Promise<void> {
  const status = (event.target as HTMLSelectElement).value;
  if (status === workspace.status) return;
  const ok = window.confirm(
    `确认把工作空间「${workspace.name || workspace.id}」改为 ${status}？停用/归档后该空间全部请求会被拒绝（数据保留，可改回 ACTIVE 恢复）。`,
  );
  if (!ok) {
    (event.target as HTMLSelectElement).value = String(workspace.status ?? 'ACTIVE');
    return;
  }
  workspaceBusy.value = String(workspace.id);
  try {
    await api(`/api/ops/workspaces/${workspace.id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    });
    notice.value = '工作空间状态已更新';
    await loadWorkspaceAdmin();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    workspaceBusy.value = '';
  }
}

async function loadWorkspaces(): Promise<void> {
  try {
    workspaces.value = (await api<{ workspaces: Row[] }>('/api/ops/workspaces')).workspaces ?? [];
    const first = workspaces.value[0];
    if (!workspaceId.value && first) {
      workspaceId.value = String(first.id);
      await loadDiagnostics();
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}
async function loadDiagnostics(): Promise<void> {
  if (!workspaceId.value) return;
  loading.value = true;
  error.value = '';
  try {
    const traceQuery = new URLSearchParams({ limit: '100' });
    if (traceStatus.value) traceQuery.set('status', traceStatus.value);
    const [runRes, leadRes, outboxRes, traceRes] = await Promise.all([
      api<{ runs: Row[] }>(`/api/ops/workspaces/${workspaceId.value}/runs`),
      api<{ leads: Row[] }>(`/api/ops/workspaces/${workspaceId.value}/leads`),
      api<{ outbox: Row[] }>(`/api/ops/workspaces/${workspaceId.value}/outbox`),
      api<{ traces: Row[] }>(`/api/ops/workspaces/${workspaceId.value}/traces?${traceQuery.toString()}`),
    ]);
    runs.value = runRes.runs ?? [];
    leads.value = leadRes.leads ?? [];
    outbox.value = outboxRes.outbox ?? [];
    traceRows.value = traceRes.traces ?? [];
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}
async function loadGlobalDiagnostics(): Promise<void> {
  error.value = '';
  try {
    const fetchQuery = new URLSearchParams({ limit: '100' });
    if (fetchStatus.value) fetchQuery.set('status', fetchStatus.value);
    const changeQuery = new URLSearchParams({ limit: '100' });
    if (changeType.value) changeQuery.set('type', changeType.value);
    const [fetchRes, changeRes] = await Promise.all([
      api<{ fetches: Row[] }>(`/api/ops/fetches?${fetchQuery.toString()}`),
      api<{ changes: Row[] }>(`/api/ops/changes?${changeQuery.toString()}`),
    ]);
    fetchRows.value = fetchRes.fetches ?? [];
    changeRows.value = changeRes.changes ?? [];
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}
async function loadUsers(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const q = userQuery.value.trim();
    users.value = (await api<{ users: Row[] }>(`/api/ops/users${q ? `?q=${encodeURIComponent(q)}` : ''}`)).users ?? [];
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function toggleUser(user: Row): Promise<void> {
  const next = user.status === 'active' ? 'disabled' : 'active';
  const action = next === 'disabled' ? '停用' : '启用';
  if (!window.confirm(`确认${action}用户 ${user.email}？${next === 'disabled' ? '停用后该用户的会话会立即失效。' : ''}`)) return;
  userBusy.value = String(user.id);
  error.value = '';
  notice.value = '';
  try {
    await api(`/api/ops/users/${user.id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status: next }),
    });
    notice.value = `已${action} ${user.email}`;
    await loadUsers();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    userBusy.value = '';
  }
}

async function loadAudit(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    auditEntries.value = (await api<{ entries: Row[] }>('/api/ops/audit?limit=100')).entries ?? [];
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}
async function loadSchedules(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const res = await api<{ schedules: Row[]; workflowWhitelist: Array<{ type: string; label: string }> }>('/api/ops/schedules');
    schedules.value = res.schedules ?? [];
    scheduleWhitelist.value = res.workflowWhitelist ?? [];
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
  await loadWorkflows();
}
async function loadWorkflows(): Promise<void> {
  workflowLoading.value = true;
  try {
    const query = new URLSearchParams({ limit: '50' });
    if (workflowStatus.value) query.set('status', workflowStatus.value);
    workflowRows.value = (await api<{ workflows: Row[] }>(`/api/ops/workflows?${query.toString()}`)).workflows ?? [];
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    workflowLoading.value = false;
  }
}
async function scheduleAction(id: string, action: 'pause' | 'unpause' | 'trigger' | 'delete'): Promise<void> {
  const labels: Record<string, string> = { pause: '暂停', unpause: '恢复', trigger: '立即触发', delete: '删除' };
  if (!window.confirm(`确认${labels[action]} schedule ${id}?`)) return;
  scheduleBusy.value = true;
  error.value = '';
  try {
    if (action === 'delete') {
      await api(`/api/ops/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } else {
      await api(`/api/ops/schedules/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' });
    }
    notice.value = `schedule ${id} 已${labels[action]}`;
    await loadSchedules();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    scheduleBusy.value = false;
  }
}
async function createSchedule(): Promise<void> {
  const form = scheduleForm.value;
  if (!form.scheduleId.trim()) {
    error.value = '请填写 schedule id';
    return;
  }
  if (!window.confirm(`创建 schedule ${form.scheduleId} (${form.workflowType}, 每 ${form.intervalMinutes} 分钟)?`)) return;
  scheduleBusy.value = true;
  error.value = '';
  try {
    await api('/api/ops/schedules', { method: 'POST', body: JSON.stringify(form) });
    notice.value = `schedule ${form.scheduleId} 已创建`;
    scheduleForm.value = { scheduleId: '', workflowType: form.workflowType, intervalMinutes: 60, note: '' };
    await loadSchedules();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    scheduleBusy.value = false;
  }
}

async function loadRevocations(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [list, policy] = await Promise.all([
      api<{ requests: Row[] }>('/api/ops/r4/revocations'),
      api<{ states: Row[]; triggerEnabled?: boolean; autoConfirm?: boolean }>('/api/ops/r4/policy-state'),
    ]);
    revocationRows.value = list.requests ?? [];
    revocationPolicy.value = policy.states ?? [];
    r4Flags.value = {
      triggerEnabled: policy.triggerEnabled ?? false,
      autoConfirm: policy.autoConfirm ?? false,
    };
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

/** 撤销请求状态 → 中文标签;原码保留在徽标 title/次要行,便于对审计。 */
const REVOCATION_STATE_LABELS: Record<string, string> = {
  ACKED: '已生效',
  PENDING_CONFIRMATION: '待确认',
  PENDING: '待投递',
  BLOCKED: '投递受阻',
  STORED_STATE_CONFLICT: '状态冲突',
  NO_LIVE_TARGET: '无生效授权',
  CANCELLED: '已取消',
};
const REVOCATION_SOURCE_LABELS: Record<string, string> = {
  POLICY_STATE: '政策停用',
  BINDING_REVOKED: '绑定撤销',
  OPERATOR: '运维手动',
};
function revocationStateLabel(state: unknown): string {
  const key = String(state ?? '');
  return REVOCATION_STATE_LABELS[key] ?? key;
}
function revocationSourceLabel(source: unknown): string {
  const key = String(source ?? '');
  return REVOCATION_SOURCE_LABELS[key] ?? key;
}
function reasonLabel(code: unknown): string {
  const key = String(code ?? '');
  return REVOCATION_REASONS.find((item) => item.value === key)?.label ?? key;
}

function revocationBadge(state: unknown): string {
  switch (String(state ?? '')) {
    case 'ACKED': return 'is-ok';
    case 'PENDING_CONFIRMATION':
    case 'PENDING': return 'is-warn';
    case 'BLOCKED':
    case 'STORED_STATE_CONFLICT': return 'is-bad';
    default: return 'is-muted'; // NO_LIVE_TARGET / CANCELLED 是已解决的终态,不是故障
  }
}

/** 最近一次投递尝试的摘要;attempts 由接口按 ordinal 倒序带 3 条。 */
function latestAttempt(row: Row): Row | null {
  const attempts = Array.isArray(row.attempts) ? (row.attempts as Row[]) : [];
  return attempts[0] ?? null;
}
function attemptSummary(attempt: Row | null): string {
  if (!attempt) return '—';
  const outcome = attempt.outcome ? String(attempt.outcome) : '无结果';
  const at = attempt.createdAt ? fmt(attempt.createdAt) : '';
  return `#${attempt.ordinal} ${outcome}${at ? ` · ${at}` : ''}`;
}

/** 微分美元 → 可读金额;引擎 cap 字段以 microusd 计。 */
function fmtUsd(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `$${(n / 1_000_000).toFixed(2)}`;
}

async function createRevocation(): Promise<void> {
  const form = revocationForm.value;
  const reason = REVOCATION_REASONS.find((item) => item.value === form.reasonCode)?.label ?? form.reasonCode;
  const confirmed = window.confirm(
    `确认对 ${form.scheduleId} 发起平台撤销（${reason}）？\n\n`
    + '影响：关闭该 schedule 的整个出网围栏，所有在途出网立即被阻断；这不是暂停，'
    + '且当前没有产品化的重开路径，恢复需要受审计的重开流程。操作会记入审计。',
  );
  if (!confirmed) return;
  revocationBusy.value = 'create';
  error.value = '';
  try {
    await api('/api/ops/r4/revocations', { method: 'POST', body: JSON.stringify(form) });
    notice.value = `${form.scheduleId} 的撤销请求已进入队列（若已有未结请求则复用该请求）`;
    revocationForm.value = { ...form, note: '' };
    await loadRevocations();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    revocationBusy.value = '';
  }
}

async function confirmRevocation(id: string, scheduleId: string): Promise<void> {
  if (!window.confirm(`确认投递 ${scheduleId} 的撤销请求？投递后 fence 会立刻生效且当前不可重开。`)) return;
  revocationBusy.value = id;
  error.value = '';
  try {
    await api(`/api/ops/r4/revocations/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: '{}' });
    notice.value = '撤销请求已确认，进入投递';
    await loadRevocations();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    revocationBusy.value = '';
  }
}

async function cancelRevocation(id: string, scheduleId: string): Promise<void> {
  const reason = window.prompt(`取消 ${scheduleId} 的撤销请求（原因会记入审计）。\n只会取消从未投递或已确定未提交的请求。`);
  if (!reason || !reason.trim()) return;
  revocationBusy.value = id;
  error.value = '';
  try {
    await api(`/api/ops/r4/revocations/${encodeURIComponent(id)}/cancel`, {
      method: 'POST', body: JSON.stringify({ reason: reason.trim() }),
    });
    notice.value = '撤销请求已取消';
    await loadRevocations();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    revocationBusy.value = '';
  }
}

async function switchTab(tab: string): Promise<void> {
  active.value = tab;
  error.value = '';
  notice.value = '';
  if (tab === 'overview') await loadOverview();
  if (tab === 'users') await loadUsers();
  if (tab === 'workspaces') await loadWorkspaceAdmin();
  if (tab === 'providers') await loadProviders();
  if (tab === 'sources') await loadSources();
  if (tab === 'budget') await loadBudget();
  if (tab === 'diagnostics') await Promise.all([loadWorkspaces(), loadGlobalDiagnostics()]);
  if (tab === 'schedules') await loadSchedules();
  if (tab === 'revocations') await loadRevocations();
  if (tab === 'audit') await loadAudit();
}

async function checkSession(): Promise<void> {
  try {
    const res = await api<{ data: { user: { email: string } } }>('/api/ops/auth/session');
    operator.value = res.data.user;
    authed.value = true;
    await loadOverview();
  } catch {
    authed.value = false;
  } finally {
    checking.value = false;
  }
}

async function login(): Promise<void> {
  loggingIn.value = true;
  loginError.value = '';
  try {
    const res = await api<{ data: { user: { email: string } } }>('/api/ops/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: loginEmail.value.trim(), password: loginPassword.value }),
    });
    operator.value = res.data.user;
    authed.value = true;
    loginPassword.value = '';
    await loadOverview();
  } catch (err) {
    loginError.value = err instanceof Error ? err.message : String(err);
  } finally {
    loggingIn.value = false;
  }
}

async function logout(): Promise<void> {
  await fetch('/api/ops/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => undefined);
  authed.value = false;
  operator.value = null;
  overview.value = null;
}

async function toggleProvider(provider: Row): Promise<void> {
  const next = String(provider.status) === 'ENABLED' ? 'DISABLED' : 'ENABLED';
  if (!window.confirm(`确认把数据源 ${provider.key} 置为 ${next}?这会立即影响新 run 的调用。`)) return;
  try {
    await api(`/api/ops/providers/${encodeURIComponent(String(provider.key))}/status`, {
      method: 'POST',
      body: JSON.stringify({ status: next }),
    });
    notice.value = `数据源 ${provider.key} 已改为 ${next}`;
    await loadProviders();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}
async function acquireNow(source: Row): Promise<void> {
  if (!window.confirm(`立即抓取 ${source.source_key}?实际抓取仍由 ACQ_SWEEP 调度执行。`)) return;
  try {
    await api(`/api/ops/sources/${source.id}/acquire-now`, { method: 'POST', body: '{}' });
    notice.value = '已置为立即到期;等待 ACQ_SWEEP 调度';
    await loadSources();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}
async function setSourceStatus(source: Row, status: string): Promise<void> {
  if (!window.confirm(`把源 ${source.source_key} 置为 ${status}?`)) return;
  try {
    await api(`/api/ops/sources/${source.id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
    notice.value = `源 ${source.source_key} 已改为 ${status}`;
    await loadSources();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}
function handleSourceStatus(source: Row, event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  void setSourceStatus(source, value);
}
function closeSourceDetail(): void {
  sourceDetail.value = null;
}
async function deleteSource(source: Row): Promise<void> {
  if (!window.confirm(`删除源 ${source.source_key}?只有从未抓取过的源可删。`)) return;
  try {
    await api(`/api/ops/sources/${source.id}`, { method: 'DELETE' });
    notice.value = `源 ${source.source_key} 已删除`;
    await loadSources();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}
async function openSource(source: Row): Promise<void> {
  try {
    sourceDetail.value = await api<{ source: Row; recentFetches: Row[] }>(`/api/ops/sources/${source.id}`);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}
function openCreateSource(): void {
  sourceModal.value = { mode: 'create', sourceKey: '' };
  sourceForm.value = {
    providerKey: '',
    sourceKey: '',
    label: '',
    region: '',
    seriesKey: '',
    sectorTags: '',
    cadenceMinutes: 0,
    configText: '{}',
  };
}
function openEditSource(source: Row): void {
  sourceModal.value = { mode: 'edit', id: String(source.id), sourceKey: String(source.source_key) };
  sourceForm.value = {
    providerKey: String(source.provider_key ?? ''),
    sourceKey: String(source.source_key ?? ''),
    label: String(source.label ?? ''),
    region: String(source.region ?? ''),
    seriesKey: String(source.series_key ?? ''),
    sectorTags: Array.isArray(source.sector_tags) ? source.sector_tags.join(', ') : '',
    cadenceMinutes: Number(source.cadence?.everyMs ?? 0) / 60_000,
    configText: JSON.stringify(source.config ?? {}, null, 2),
  };
}
function closeSourceModal(): void {
  sourceModal.value = null;
}
async function saveSource(): Promise<void> {
  if (!sourceModal.value) return;
  const form = sourceForm.value;
  let config: Record<string, unknown>;
  try {
    config = form.configText.trim() ? JSON.parse(form.configText) : {};
  } catch {
    error.value = 'config 必须是合法 JSON';
    return;
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    error.value = 'config 必须是 JSON 对象';
    return;
  }
  const sectorTags = form.sectorTags
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const cadence = form.cadenceMinutes > 0 ? { kind: 'fixed', everyMs: Math.round(form.cadenceMinutes * 60_000) } : null;
  sourceBusy.value = true;
  error.value = '';
  try {
    if (sourceModal.value.mode === 'create') {
      await api('/api/ops/sources', {
        method: 'POST',
        body: JSON.stringify({
          providerKey: form.providerKey.trim(),
          sourceKey: form.sourceKey.trim(),
          label: form.label.trim(),
          config,
          sectorTags: sectorTags.length > 0 ? sectorTags : undefined,
          region: form.region.trim() || undefined,
          seriesKey: form.seriesKey.trim() || undefined,
          cadence: cadence ?? undefined,
        }),
      });
      notice.value = `源 ${form.sourceKey} 已创建(ACTIVE);置 next_fetch_at 后由 ACQ_SWEEP 抓取`;
    } else {
      await api(`/api/ops/sources/${sourceModal.value.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          label: form.label.trim(),
          config,
          sectorTags,
          region: form.region.trim() || null,
          seriesKey: form.seriesKey.trim() || null,
          cadence,
        }),
      });
      notice.value = `源 ${form.sourceKey} 已更新`;
    }
    sourceModal.value = null;
    await loadSources();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    sourceBusy.value = false;
  }
}
function downloadExport(path: string): void {
  const link = document.createElement('a');
  link.href = path;
  link.download = '';
  document.body.append(link);
  link.click();
  link.remove();
}
function exportFetchesCsv(): void {
  downloadExport(fetchStatus.value ? `/api/ops/export/fetches?status=${fetchStatus.value}` : '/api/ops/export/fetches');
}
function exportLeadsCsv(): void {
  downloadExport(`/api/ops/export/leads?workspaceId=${workspaceId.value}`);
}

onMounted(checkSession);
</script>

<template>
  <div class="ops">
    <div v-if="checking" class="ops__state">检查运营会话…</div>

    <div v-else-if="!authed" class="ops__login">
      <section class="ops__brand">
        <span class="ops__mark">◎</span>
        <h1>GainOS 运营台</h1>
        <p>平台运营域:引擎健康、数据源 Kill Switch、监控源、预算与跨租户诊断。与租户工作空间完全隔离。</p>
        <ul>
          <li>独立登录域与 cookie</li>
          <li>写操作走白名单 + 全量审计</li>
          <li>高危动作二次确认</li>
        </ul>
      </section>
      <form class="ops__login-card" @submit.prevent="login">
        <h2>运营登录</h2>
        <p>使用运营账号,不是租户账号。</p>
        <label><span>邮箱</span><input v-model="loginEmail" type="email" autocomplete="username" placeholder="ops@gainos.local" /></label>
        <label><span>密码</span><input v-model="loginPassword" type="password" autocomplete="current-password" placeholder="至少 10 位" /></label>
        <p v-if="loginError" class="ops__error">{{ loginError }}</p>
        <button type="submit" :disabled="loggingIn">{{ loggingIn ? '登录中…' : '登录' }}</button>
      </form>
    </div>

    <template v-else>
      <header class="ops__header">
        <div class="ops__brand-inline"><span class="ops__mark">◎</span><strong>GainOS 运营台</strong><span class="ops__tag">Operator</span></div>
        <div class="ops__operator">
          <span>{{ operator?.email }}</span>
          <button type="button" @click="logout">退出</button>
        </div>
      </header>
      <div class="ops__body">
        <aside class="ops__nav">
          <button v-for="tab in TABS" :key="tab.key" type="button" :class="{ 'is-active': active === tab.key }" @click="switchTab(tab.key)">{{ tab.label }}</button>
        </aside>
        <main class="ops__main">
          <header class="ops__main-head">
            <div><span class="ops__kicker">运营域</span><h2>{{ activeLabel }}</h2></div>
            <button type="button" class="ops__refresh" @click="switchTab(active)">刷新</button>
          </header>
          <p v-if="notice" class="ops__notice">{{ notice }}</p>
          <p v-if="error" class="ops__error" role="alert">{{ error }}</p>
          <p v-if="loading" class="ops__muted">加载中…</p>

          <section v-if="active === 'overview' && overview" class="ops__grid">
            <article class="ops__card">
              <h3>引擎</h3>
              <p :class="overview.engine?.ready ? 'ops__ok' : 'ops__warn'">{{ overview.engine?.ready ? 'ready' : 'not ready' }}</p>
              <p class="ops__muted">HTTP {{ fmt(overview.engine?.httpStatus) }} · DB {{ overview.db?.ok ? 'ok' : 'failed' }}</p>
              <ul v-if="overview.engine?.failedComponents?.length" class="ops__list">
                <li v-for="item in overview.engine.failedComponents" :key="item.name">{{ item.name }}: {{ item.status }}</li>
              </ul>
            </article>
            <article class="ops__card">
              <h3>Schema 探针</h3>
              <p :class="overview.probe?.ok ? 'ops__ok' : 'ops__warn'">{{ overview.probe?.ok ? 'ok' : '漂移' }}</p>
              <ul v-if="overview.probe?.missing?.length" class="ops__list"><li v-for="item in overview.probe.missing" :key="item">{{ item }}</li></ul>
            </article>
            <article class="ops__card">
              <h3>数据源</h3>
              <p>{{ countOf(overview.providersByStatus) }}</p>
              <h3>监控源</h3>
              <p>{{ countOf(overview.sourcesByStatus) }}</p>
              <p class="ops__muted">到期源 {{ overview.dueSources }}</p>
            </article>
            <article class="ops__card">
              <h3>红灯</h3>
              <p>死信投递:{{ fmt(overview.redLights?.deadDeliveries) }}</p>
              <p>预算耗尽账户:{{ fmt(overview.redLights?.exhaustedBudgetAccounts) }}</p>
              <p>未结平台撤销:{{ fmt(overview.redLights?.r4?.openRevocations) }}</p>
              <p>投递结果未知:{{ fmt(overview.redLights?.r4?.deliveryUnknown) }}</p>
              <p>平台授权轮次耗尽:{{ fmt(overview.redLights?.r4?.platformExhaustedAuthorities) }}</p>
              <p class="ops__muted">Temporal:{{ overview.redLights?.temporal?.reachable ? '可达' : '不可达' }}</p>
            </article>
            <article class="ops__card ops__card--wide">
              <h3>近 24 小时抓取</h3>
              <p>{{ countOf(overview.fetchStats24h) }}</p>
              <h3>失败抓取</h3>
              <ul v-if="overview.failedFetches?.length" class="ops__list">
                <li v-for="item in overview.failedFetches" :key="item.id">{{ item.source_key }} · {{ fmt(item.started_at) }} · {{ item.error }}</li>
              </ul>
              <p v-else class="ops__muted">无</p>
            </article>
            <article class="ops__card ops__card--wide">
              <h3>制裁名单 / 进程租约</h3>
              <ul class="ops__list">
                <li v-for="item in overview.sanctions" :key="item.key">{{ item.key }} · {{ item.status }} · {{ fmt(item.last_refreshed_at) }}</li>
                <li v-for="item in overview.leases" :key="`lease-${item.role}`">lease {{ item.role }} · {{ item.state }} · {{ fmt(item.last_seen_at) }}</li>
              </ul>
            </article>
          </section>

          <section v-else-if="active === 'users'" class="ops__stack">
            <div class="ops__toolbar">
              <h3>注册用户</h3>
              <input v-model="userQuery" placeholder="按邮箱搜索" @keyup.enter="loadUsers" />
              <button type="button" @click="loadUsers">搜索</button>
              <span class="ops__muted">停用会立即撤销该用户的全部租户会话</span>
            </div>
            <div class="ops__table-wrap">
              <table class="ops__table">
                <thead>
                  <tr><th>邮箱</th><th>状态</th><th>工作空间</th><th>活跃会话</th><th>最近会话</th><th>注册时间</th><th>操作</th></tr>
                </thead>
                <tbody>
                  <tr v-for="user in users" :key="user.id">
                    <td><strong>{{ user.email }}</strong><br /><span class="ops__muted">{{ user.id }}</span></td>
                    <td><span class="ops__pill" :class="user.status === 'active' ? 'is-ok' : 'is-bad'">{{ user.status === 'active' ? '启用' : '停用' }}</span></td>
                    <td>
                      <div v-for="workspace in user.workspaces" :key="workspace.id">
                        {{ workspace.name }} <span class="ops__muted">· {{ workspace.role }}</span>
                      </div>
                      <span v-if="!user.workspaces?.length" class="ops__muted">无</span>
                    </td>
                    <td>{{ user.activeSessions }}</td>
                    <td>{{ user.lastSeenAt ? fmt(user.lastSeenAt) : '—' }}</td>
                    <td>{{ fmt(user.createdAt) }}</td>
                    <td>
                      <button type="button" class="ops__danger" :disabled="userBusy === user.id" @click="toggleUser(user)">
                        {{ user.status === 'active' ? '停用' : '启用' }}
                      </button>
                    </td>
                  </tr>
                  <tr v-if="!users.length"><td colspan="7" class="ops__muted">没有匹配的用户</td></tr>
                </tbody>
              </table>
            </div>
          </section>

          <section v-else-if="active === 'workspaces'" class="ops__table-wrap">
            <table class="ops__table">
              <thead><tr><th>工作空间</th><th>成员</th><th>状态</th><th>状态更新</th><th>备注</th><th></th></tr></thead>
              <tbody>
                <tr v-for="workspace in workspaces" :key="workspace.id">
                  <td><strong>{{ workspace.name || workspace.id }}</strong><br /><small class="ops__muted">{{ workspace.id }}</small></td>
                  <td>{{ workspace.members ?? '-' }}</td>
                  <td><span class="ops__badge" :class="badgeClass(workspace.status)">{{ workspace.status ?? 'ACTIVE' }}</span></td>
                  <td>{{ fmt(workspace.status_updated_at) }}</td>
                  <td class="ops__muted">{{ workspace.status_note ?? '' }}</td>
                  <td>
                    <select
                      :value="workspace.status ?? 'ACTIVE'"
                      :disabled="workspaceBusy === String(workspace.id)"
                      @change="handleWorkspaceStatus(workspace, $event)"
                    >
                      <option value="ACTIVE">ACTIVE</option>
                      <option value="DISABLED">DISABLED</option>
                      <option value="ARCHIVED">ARCHIVED</option>
                    </select>
                  </td>
                </tr>
                <tr v-if="workspaces.length === 0"><td colspan="6" class="ops__muted">没有工作空间</td></tr>
              </tbody>
            </table>
          </section>

          <section v-else-if="active === 'providers'" class="ops__table-wrap">
            <table class="ops__table">
              <thead><tr><th>Key</th><th>Class</th><th>状态</th><th>单次成本</th><th>配置</th><th></th></tr></thead>
              <tbody>
                <tr v-for="provider in providers" :key="provider.key">
                  <td>{{ provider.key }}</td>
                  <td>{{ fmt(provider.class) }}</td>
                  <td><span class="ops__badge" :class="badgeClass(provider.status)">{{ provider.status }}</span></td>
                  <td>{{ fmt(provider.cost_per_call_cents) }}</td>
                  <td class="ops__json">{{ fmt(provider.config) }}</td>
                  <td><button type="button" class="ops__btn" @click="toggleProvider(provider)">{{ provider.status === 'ENABLED' ? '停用' : '启用' }}</button></td>
                </tr>
                <tr v-if="providers.length === 0"><td colspan="6" class="ops__muted">没有数据源</td></tr>
              </tbody>
            </table>
          </section>

          <section v-else-if="active === 'sources'" class="ops__stack">
            <div class="ops__toolbar">
              <button type="button" class="ops__btn ops__btn--primary" @click="openCreateSource">新建源</button>
              <button type="button" class="ops__btn" @click="downloadExport('/api/ops/export/sources')">导出 CSV</button>
            </div>
            <div class="ops__table-wrap">
            <table class="ops__table">
              <thead><tr><th>Source</th><th>状态</th><th>最近抓取</th><th>下次</th><th>抓取/实体</th><th></th></tr></thead>
              <tbody>
                <tr v-for="source in sources" :key="source.id">
                  <td><strong>{{ source.source_key }}</strong><br /><small class="ops__muted">{{ source.label }}</small></td>
                  <td><span class="ops__badge" :class="badgeClass(source.status)">{{ source.status }}</span></td>
                  <td>{{ fmt(source.last_fetch_at) }}<br /><small class="ops__muted">{{ source.last_fetch_status }}</small></td>
                  <td>{{ fmt(source.next_fetch_at) }}</td>
                  <td>{{ source.fetch_count }} / {{ source.entity_count }}</td>
                  <td class="ops__row-actions">
                    <button type="button" class="ops__btn" @click="openSource(source)">详情</button>
                    <button type="button" class="ops__btn" @click="openEditSource(source)">编辑</button>
                    <button type="button" class="ops__btn" @click="acquireNow(source)">立即抓取</button>
                    <select :value="source.status" @change="handleSourceStatus(source, $event)">
                      <option value="ACTIVE">ACTIVE</option><option value="PAUSED">PAUSED</option><option value="ARCHIVED">ARCHIVED</option>
                    </select>
                    <button type="button" class="ops__btn ops__btn--danger" @click="deleteSource(source)">删除</button>
                  </td>
                </tr>
                <tr v-if="sources.length === 0"><td colspan="6" class="ops__muted">没有监控源</td></tr>
              </tbody>
            </table>
            <section v-if="sourceDetail" class="ops__detail">
              <header><strong>{{ sourceDetail.source.source_key }}</strong><button type="button" class="ops__btn" @click="closeSourceDetail">关闭</button></header>
              <p class="ops__muted">最近抓取</p>
              <table class="ops__table">
                <thead><tr><th>状态</th><th>总数</th><th>新增</th><th>失败原因</th><th>开始</th><th>结束</th></tr></thead>
                <tbody>
                  <tr v-for="fetch in sourceDetail.recentFetches" :key="fetch.id">
                    <td><span class="ops__badge" :class="badgeClass(fetch.status)">{{ fetch.status }}</span></td>
                    <td>{{ fmt(fetch.total) }}</td><td>{{ fmt(fetch.added) }}</td><td>{{ fmt(fetch.error) }}</td><td>{{ fmt(fetch.started_at) }}</td><td>{{ fmt(fetch.finished_at) }}</td>
                  </tr>
                </tbody>
              </table>
            </section>
            </div>
          </section>

          <section v-else-if="active === 'budget' && budget" class="ops__stack">
            <article class="ops__card ops__card--wide">
              <h3>预算账户</h3>
              <table class="ops__table">
                <thead><tr><th>Account</th><th>Scope</th><th>Cap</th><th>Reserved</th><th>Charged</th><th>耗尽</th><th>更新</th></tr></thead>
                <tbody>
                  <tr v-for="account in budget.accounts" :key="account.id">
                    <td>{{ account.account_key }}</td><td>{{ account.scope_key }}</td><td>{{ account.cap_microusd }}</td>
                    <td>{{ account.reserved_microusd }}</td><td>{{ account.charged_microusd }}</td>
                    <td>{{ account.exhausted ? '是' : '否' }}</td><td>{{ fmt(account.updated_at) }}</td>
                  </tr>
                  <tr v-if="budget.accounts.length === 0"><td colspan="7" class="ops__muted">无预算账户</td></tr>
                </tbody>
              </table>
            </article>
            <article class="ops__card ops__card--wide">
              <h3>授权(最近 100)</h3>
              <table class="ops__table">
                <thead><tr><th>Workspace / 绑定</th><th>类型</th><th>Purpose</th><th>上限</th><th>轮次</th><th>过期 / 租约</th><th>已消费</th><th>撤销</th></tr></thead>
                <tbody>
                  <tr v-for="authority in budget.authorities" :key="authority.id">
                    <td>
                      <template v-if="authority.authority_kind === 'PLATFORM'">
                        <strong>平台(全部工作空间)</strong>
                      </template>
                      <template v-else>{{ authority.workspace_id || '—' }}</template>
                      <template v-if="authority.schedule_id || authority.workflow_id">
                        <br /><small class="ops__muted">{{ authority.schedule_id || '—' }}<template v-if="authority.workflow_id"> · {{ authority.workflow_id }}</template></small>
                      </template>
                    </td>
                    <td>{{ authority.authority_kind === 'PLATFORM' ? '平台授权' : (authority.authority_kind === 'WORKSPACE_GRANT' ? '工作空间 Grant' : authority.authority_kind) }}</td>
                    <td>{{ authority.purpose }}</td>
                    <td>
                      <template v-if="authority.authority_kind === 'PLATFORM'">
                        {{ fmtUsd(authority.cap_per_run_microusd) }}/轮
                        <template v-if="authority.campaign_cap_microusd != null"><br /><small class="ops__muted">活动 {{ fmtUsd(authority.campaign_cap_microusd) }}</small></template>
                      </template>
                      <template v-else>{{ fmtUsd(authority.cap_microusd) }}</template>
                    </td>
                    <td>
                      <template v-if="authority.authority_kind === 'PLATFORM'">{{ authority.runs_consumed ?? 0 }}<template v-if="authority.max_runs != null"> / {{ authority.max_runs }}</template></template>
                      <template v-else>{{ authority.runs_consumed ?? 0 }}</template>
                    </td>
                    <td>{{ fmt(authority.expires_at) }}<template v-if="authority.admission_lease_expires_at"><br /><small class="ops__muted">租约 {{ fmt(authority.admission_lease_expires_at) }}</small></template></td>
                    <td>{{ fmt(authority.consumed_at) }}</td>
                    <td>{{ fmt(authority.revoked_at) }}</td>
                  </tr>
                  <tr v-if="budget.authorities.length === 0"><td colspan="8" class="ops__muted">无授权记录</td></tr>
                </tbody>
              </table>
              <p class="ops__muted">平台授权的金额上限按轮(cap_per_run)与活动累计(campaign)计;runs_consumed 达到 max_runs 后该授权耗尽,引擎会拒绝新的平台 run。</p>
            </article>
          </section>

          <section v-else-if="active === 'diagnostics'" class="ops__stack">
            <label class="ops__field"><span>工作空间</span>
              <select v-model="workspaceId" @change="loadDiagnostics">
                <option v-for="workspace in workspaces" :key="workspace.id" :value="workspace.id">{{ workspace.name || workspace.id }} · {{ workspace.id }}</option>
              </select>
            </label>
            <article class="ops__card ops__card--wide">
              <div class="ops__toolbar">
                <h3>抓取记录(平台级)</h3>
                <select v-model="fetchStatus" @change="loadGlobalDiagnostics">
                  <option value="">全部状态</option><option value="RUNNING">RUNNING</option><option value="DONE">DONE</option><option value="PARTIAL">PARTIAL</option><option value="FAILED">FAILED</option>
                </select>
                <button type="button" class="ops__btn" @click="exportFetchesCsv">导出 CSV</button>
              </div>
              <table class="ops__table"><thead><tr><th>源</th><th>状态</th><th>总数</th><th>增/改/删</th><th>成本分</th><th>错误</th><th>开始</th></tr></thead>
                <tbody><tr v-for="fetch in fetchRows" :key="fetch.id"><td>{{ fetch.source_key }}<br /><small class="ops__muted">{{ fetch.source_label }}</small></td><td><span class="ops__badge" :class="badgeClass(fetch.status)">{{ fetch.status }}</span></td><td>{{ fmt(fetch.total) }}</td><td>{{ fetch.added }} / {{ fetch.updated }} / {{ fetch.removed }}</td><td>{{ fmt(fetch.cost_cents) }}</td><td class="ops__json">{{ fmt(fetch.error) }}</td><td>{{ fmt(fetch.started_at) }}</td></tr>
                  <tr v-if="fetchRows.length === 0"><td colspan="7" class="ops__muted">无</td></tr></tbody>
              </table>
            </article>
            <article class="ops__card ops__card--wide">
              <div class="ops__toolbar">
                <h3>变更流(平台级)</h3>
                <input v-model="changeType" placeholder="change_type,如 NEW/CHANGED" @change="loadGlobalDiagnostics" />
              </div>
              <table class="ops__table"><thead><tr><th>源</th><th>实体</th><th>类型</th><th>明细</th><th>时间</th></tr></thead>
                <tbody><tr v-for="change in changeRows" :key="change.id"><td>{{ change.source_key }}</td><td>{{ change.entity_name || change.external_id }}</td><td>{{ change.change_type }}</td><td class="ops__json">{{ fmt(change.detail) }}</td><td>{{ fmt(change.created_at) }}</td></tr>
                  <tr v-if="changeRows.length === 0"><td colspan="5" class="ops__muted">无</td></tr></tbody>
              </table>
            </article>
            <article class="ops__card ops__card--wide">
              <div class="ops__toolbar">
                <h3>模型调用(租户级)</h3>
                <select v-model="traceStatus" @change="loadDiagnostics">
                  <option value="">全部状态</option><option value="OK">OK</option><option value="ERROR">ERROR</option><option value="RUNNING">RUNNING</option>
                </select>
              </div>
              <table class="ops__table"><thead><tr><th>Task / Op</th><th>Provider / Model</th><th>状态</th><th>延迟</th><th>Token</th><th>错误</th><th>时间</th></tr></thead>
                <tbody><tr v-for="trace in traceRows" :key="trace.id"><td>{{ trace.task }}<br /><small class="ops__muted">{{ trace.op }}</small></td><td>{{ trace.provider }}<br /><small class="ops__muted">{{ trace.model }}</small></td><td><span class="ops__badge" :class="badgeClass(trace.status)">{{ trace.status }}</span></td><td>{{ fmt(trace.latency_ms) }}</td><td>{{ fmt(trace.input_tokens) }} / {{ fmt(trace.output_tokens) }}</td><td class="ops__json">{{ fmt(trace.error_message) }}</td><td>{{ fmt(trace.created_at) }}</td></tr>
                  <tr v-if="traceRows.length === 0"><td colspan="7" class="ops__muted">无(引擎产生模型调用后才会有记录)</td></tr></tbody>
              </table>
            </article>
            <article class="ops__card ops__card--wide">
              <h3>寻源任务</h3>
              <table class="ops__table"><thead><tr><th>ID</th><th>状态</th><th>统计</th><th>创建</th><th>完成</th></tr></thead>
                <tbody><tr v-for="run in runs" :key="run.id"><td>{{ run.id }}</td><td><span class="ops__badge" :class="badgeClass(run.status)">{{ run.status }}</span></td><td class="ops__json">{{ fmt(run.stats) }}</td><td>{{ fmt(run.created_at) }}</td><td>{{ fmt(run.completed_at) }}</td></tr>
                  <tr v-if="runs.length === 0"><td colspan="5" class="ops__muted">无</td></tr></tbody>
              </table>
            </article>
            <article class="ops__card ops__card--wide">
              <div class="ops__toolbar">
                <h3>线索</h3>
                <button type="button" class="ops__btn" @click="exportLeadsCsv">导出 CSV</button>
              </div>
              <table class="ops__table"><thead><tr><th>公司</th><th>队列</th><th>Fit</th><th>分数</th><th>Fit 说明</th><th>创建</th></tr></thead>
                <tbody><tr v-for="lead in leads" :key="lead.id"><td>{{ lead.company_name }}<br /><small class="ops__muted">{{ lead.company_domain }}</small></td><td>{{ lead.queue }}</td><td>{{ lead.fit_verdict }}</td><td>{{ fmt(lead.total_score) }}</td><td class="ops__json" :title="lead.fit_reasons || ''">{{ lead.fit_reasons || '—' }}</td><td>{{ fmt(lead.created_at) }}</td></tr>
                  <tr v-if="leads.length === 0"><td colspan="6" class="ops__muted">无</td></tr></tbody>
              </table>
            </article>
            <article class="ops__card ops__card--wide">
              <h3>Outbox</h3>
              <table class="ops__table"><thead><tr><th>Type</th><th>Occurred</th><th>Published</th><th>Parked</th></tr></thead>
                <tbody><tr v-for="event in outbox" :key="event.id"><td>{{ event.event_type }}</td><td>{{ fmt(event.occurred_at) }}</td><td>{{ fmt(event.published_at) }}</td><td>{{ fmt(event.parked_at) }}</td></tr>
                  <tr v-if="outbox.length === 0"><td colspan="4" class="ops__muted">无</td></tr></tbody>
              </table>
            </article>
          </section>

          <section v-else-if="active === 'schedules'" class="ops__stack">
            <article class="ops__card ops__card--wide">
              <h3>调度</h3>
              <table class="ops__table">
                <thead><tr><th>ID</th><th>Workflow</th><th>队列</th><th>状态</th><th>间隔</th><th>备注</th><th></th></tr></thead>
                <tbody>
                  <tr v-for="schedule in schedules" :key="schedule.id">
                    <td>{{ schedule.id }}</td>
                    <td>{{ schedule.workflowType }}</td>
                    <td>{{ schedule.taskQueue }}</td>
                    <td><span class="ops__badge" :class="schedule.paused ? 'is-warn' : 'is-ok'">{{ schedule.paused ? 'PAUSED' : 'RUNNING' }}</span></td>
                    <td>{{ schedule.intervalMinutes ? `${schedule.intervalMinutes} min` : '—' }}</td>
                    <td class="ops__json">{{ schedule.note }}</td>
                    <td class="ops__row-actions">
                      <button type="button" class="ops__btn" :disabled="scheduleBusy" @click="scheduleAction(schedule.id, schedule.paused ? 'unpause' : 'pause')">{{ schedule.paused ? '恢复' : '暂停' }}</button>
                      <button type="button" class="ops__btn" :disabled="scheduleBusy" @click="scheduleAction(schedule.id, 'trigger')">立即触发</button>
                      <button type="button" class="ops__btn ops__btn--danger" :disabled="scheduleBusy" @click="scheduleAction(schedule.id, 'delete')">删除</button>
                    </td>
                  </tr>
                  <tr v-if="schedules.length === 0"><td colspan="7" class="ops__muted">没有 schedule(Temporal 不可达时也会为空)</td></tr>
                </tbody>
              </table>
            </article>
            <article class="ops__card ops__card--wide">
              <h3>新建 schedule</h3>
              <div class="ops__inline-form">
                <label class="ops__field"><span>Schedule ID</span><input v-model="scheduleForm.scheduleId" placeholder="acq-sweep-2" /></label>
                <label class="ops__field"><span>Workflow</span>
                  <select v-model="scheduleForm.workflowType">
                    <option v-for="item in scheduleWhitelist" :key="item.type" :value="item.type">{{ item.label }} · {{ item.type }}</option>
                  </select>
                </label>
                <label class="ops__field"><span>间隔(分钟)</span><input v-model.number="scheduleForm.intervalMinutes" type="number" min="1" /></label>
                <label class="ops__field"><span>备注</span><input v-model="scheduleForm.note" /></label>
                <button type="button" class="ops__btn" :disabled="scheduleBusy" @click="createSchedule">创建</button>
              </div>
              <p class="ops__muted">高危操作二次确认;创建只允许白名单 workflow,队列固定 understanding。</p>
            </article>
            <article class="ops__card ops__card--wide">
              <div class="ops__toolbar">
                <h3>近期 workflow</h3>
                <select v-model="workflowStatus" @change="loadWorkflows">
                  <option value="">全部(默认仅非运行中)</option>
                  <option value="Running">Running</option>
                  <option value="Completed">Completed</option>
                  <option value="Failed">Failed</option>
                  <option value="Canceled">Canceled</option>
                  <option value="Terminated">Terminated</option>
                  <option value="TimedOut">TimedOut</option>
                </select>
                <button type="button" class="ops__btn" :disabled="workflowLoading" @click="loadWorkflows">刷新</button>
              </div>
              <p v-if="workflowLoading" class="ops__muted">加载中…</p>
              <table v-else class="ops__table">
                <thead><tr><th>Workflow</th><th>Type</th><th>状态</th><th>开始</th><th>结束</th></tr></thead>
                <tbody>
                  <tr v-for="workflow in workflowRows" :key="workflow.runId || workflow.workflowId">
                    <td class="ops__json">{{ workflow.workflowId }}</td>
                    <td>{{ workflow.workflowType }}</td>
                    <td><span class="ops__badge" :class="badgeClass(workflow.status)">{{ workflow.status }}</span></td>
                    <td>{{ fmt(workflow.startTime) }}</td>
                    <td>{{ fmt(workflow.closeTime) }}</td>
                  </tr>
                  <tr v-if="workflowRows.length === 0"><td colspan="5" class="ops__muted">没有匹配的 workflow</td></tr>
                </tbody>
              </table>
            </article>
          </section>

          <section v-else-if="active === 'revocations'" class="ops__stack">
            <article class="ops__card ops__card--wide">
              <div class="ops__toolbar">
                <h3>平台策略状态</h3>
                <span class="ops__badge" :class="r4Flags.triggerEnabled ? 'is-ok' : 'is-warn'">
                  撤销自动触发：{{ r4Flags.triggerEnabled ? '已启用' : '未启用' }}
                </span>
                <span class="ops__badge" :class="r4Flags.autoConfirm ? 'is-warn' : 'is-ok'">
                  自动确认：{{ r4Flags.autoConfirm ? '开启（自动来源请求确认后直接投递）' : '关闭（自动来源请求需人工确认）' }}
                </span>
              </div>
              <table class="ops__table">
                <thead><tr><th>Schedule</th><th>模式</th><th>更新人</th><th>更新时间</th></tr></thead>
                <tbody>
                  <tr v-for="state in revocationPolicy" :key="state.scheduleId">
                    <td>{{ state.scheduleId }}</td>
                    <td><span class="ops__badge" :class="state.mode === 'ENABLED' ? 'is-ok' : 'is-warn'">{{ state.mode === 'ENABLED' ? '启用（ENABLED）' : state.mode }}</span></td>
                    <td>{{ state.updatedBy }}</td>
                    <td>{{ fmt(state.updatedAt) }}</td>
                  </tr>
                  <tr v-if="revocationPolicy.length === 0"><td colspan="4" class="ops__muted">还没有策略状态记录（首次启用后会建立基线）。</td></tr>
                </tbody>
              </table>
              <p class="ops__muted">该状态是后端 policy asset 的镜像；两侧不一致会让引擎 readiness fail closed。开关状态来自服务端实际配置，与 .env 同步显示。</p>
            </article>
            <article class="ops__card ops__card--wide">
              <h3>发起撤销</h3>
              <div class="ops__inline-form">
                <label class="ops__field"><span>Schedule</span>
                  <select v-model="revocationForm.scheduleId">
                    <option v-for="scheduleId in REVOCATION_SCHEDULES" :key="scheduleId" :value="scheduleId">{{ scheduleId }}</option>
                  </select>
                </label>
                <label class="ops__field"><span>原因</span>
                  <select v-model="revocationForm.reasonCode">
                    <option v-for="reason in REVOCATION_REASONS" :key="reason.value" :value="reason.value">{{ reason.label }}</option>
                  </select>
                </label>
                <label class="ops__field"><span>备注</span><input v-model="revocationForm.note" maxlength="300" placeholder="为什么撤销（会记入审计）" /></label>
                <button type="button" class="ops__btn ops__btn--danger" :disabled="!!revocationBusy || !r4Flags.triggerEnabled" @click="createRevocation">发起撤销</button>
              </div>
              <p class="ops__muted">
                撤销按 schedule 生效、当前不可重开；只有三个有 egress 的 schedule 可撤销。
                {{ r4Flags.triggerEnabled
                  ? (r4Flags.autoConfirm
                    ? '自动确认已开启：所有来源的请求确认后都会直接进入投递（当前为测试/特殊配置，注意风险）。'
                    : '操作员发起的请求立即投递；自动来源的请求会停在「待确认」，需在下方人工确认。')
                  : '撤销自动触发未启用，发起/确认/取消接口会被拒绝。' }}
              </p>
            </article>
            <article class="ops__card ops__card--wide">
              <h3>撤销请求</h3>
              <table class="ops__table">
                <thead><tr><th>创建</th><th>Schedule</th><th>原因 / 来源</th><th>状态</th><th>序列</th><th>投递</th><th></th></tr></thead>
                <tbody>
                  <tr v-for="row in revocationRows" :key="row.id">
                    <td>{{ fmt(row.createdAt) }}</td>
                    <td>{{ row.scheduleId }}</td>
                    <td>{{ reasonLabel(row.reasonCode) }}<br /><small class="ops__muted">{{ revocationSourceLabel(row.source) }} · {{ row.requestedBy }}</small></td>
                    <td>
                      <span class="ops__badge" :class="revocationBadge(row.state)" :title="row.state">{{ revocationStateLabel(row.state) }}</span>
                      <small class="ops__muted">{{ row.state }}</small>
                      <template v-if="row.deliveryUnknown">
                        <br /><span class="ops__badge is-warn" title="有投递尝试但未取得确定结果（未拿到 ACK，也不确定是否未提交）">投递结果未知</span>
                      </template>
                    </td>
                    <td>{{ row.fenceSequence }}</td>
                    <td class="ops__json">
                      <div>最近尝试：{{ attemptSummary(latestAttempt(row)) }}<template v-if="(row.attemptCount ?? 0) > 0"> · 共 {{ row.attemptCount }} 次</template></div>
                      <div v-if="row.state === 'ACKED'">receipt {{ row.ackReceiptId }} · generation {{ row.ackGeneration }}<template v-if="row.ackInFlightAttempts != null"> · in-flight {{ row.ackInFlightAttempts }}</template></div>
                      <div v-else-if="row.lastError">{{ row.lastError }}</div>
                    </td>
                    <td class="ops__row-actions">
                      <button v-if="row.state === 'PENDING_CONFIRMATION'" type="button" class="ops__btn ops__btn--danger" :disabled="!!revocationBusy || !r4Flags.triggerEnabled" @click="confirmRevocation(row.id, row.scheduleId)">确认投递</button>
                      <button v-if="['PENDING_CONFIRMATION', 'BLOCKED', 'STORED_STATE_CONFLICT'].includes(row.state)" type="button" class="ops__btn" :disabled="!!revocationBusy || !r4Flags.triggerEnabled" @click="cancelRevocation(row.id, row.scheduleId)">取消</button>
                    </td>
                  </tr>
                  <tr v-if="revocationRows.length === 0"><td colspan="7" class="ops__muted">还没有撤销请求。上方可对三个有 egress 的 schedule 发起撤销。</td></tr>
                </tbody>
              </table>
            </article>
          </section>

          <section v-else-if="active === 'audit'" class="ops__table-wrap">
            <table class="ops__table">
              <thead><tr><th>时间</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
              <tbody>
                <tr v-for="entry in auditEntries" :key="entry.id">
                  <td>{{ fmt(entry.at) }}</td><td>{{ entry.actorId }}</td><td>{{ entry.action }}</td><td>{{ fmt(entry.target) }}</td><td class="ops__json">{{ fmt(entry.detail) }}</td>
                </tr>
                <tr v-if="auditEntries.length === 0"><td colspan="5" class="ops__muted">暂无运营审计</td></tr>
              </tbody>
            </table>
          </section>
        </main>
      </div>

      <div v-if="sourceModal" class="ops__modal" @click.self="closeSourceModal">
        <form class="ops__modal-card" @submit.prevent="saveSource">
          <header>
            <h2>{{ sourceModal.mode === 'create' ? '新建监控源' : `编辑 ${sourceModal.sourceKey}` }}</h2>
            <button type="button" class="ops__btn" @click="closeSourceModal">关闭</button>
          </header>
          <div class="ops__form-grid">
            <label class="ops__field"><span>Provider Key *</span><input v-model="sourceForm.providerKey" :disabled="sourceModal.mode === 'edit'" placeholder="trade_fair | directory | public_web" required /></label>
            <label class="ops__field"><span>Source Key *</span><input v-model="sourceForm.sourceKey" :disabled="sourceModal.mode === 'edit'" placeholder="trade_fair:example-2026" required /></label>
            <label class="ops__field"><span>名称 *</span><input v-model="sourceForm.label" required /></label>
            <label class="ops__field"><span>地区</span><input v-model="sourceForm.region" placeholder="DE / CN / global" /></label>
            <label class="ops__field"><span>系列</span><input v-model="sourceForm.seriesKey" placeholder="跨届分组,如 euroblech" /></label>
            <label class="ops__field"><span>行业标签(逗号分隔)</span><input v-model="sourceForm.sectorTags" placeholder="metal_processing, machinery" /></label>
            <label class="ops__field"><span>抓取间隔(分钟,0=不定时)</span><input v-model.number="sourceForm.cadenceMinutes" type="number" min="0" step="1" /></label>
          </div>
          <label class="ops__field"><span>源配置 JSON *</span><textarea v-model="sourceForm.configText" rows="7" spellcheck="false" /></label>
          <p class="ops__muted">新建源默认 ACTIVE;仅当 next_fetch_at 到期才被 ACQ_SWEEP 调度。保存会写入运营审计。</p>
          <div class="ops__modal-actions">
            <button type="button" class="ops__btn" @click="closeSourceModal">取消</button>
            <button type="submit" class="ops__btn ops__btn--primary" :disabled="sourceBusy">{{ sourceBusy ? '保存中…' : '保存' }}</button>
          </div>
        </form>
      </div>

    </template>
  </div>
</template>

<style scoped>
.ops { min-height: 100vh; background: var(--gs-bg, #f4f6fa); color: var(--gs-fg, #0f172a); font-family: inherit; }
.ops__state { min-height: 100vh; display: grid; place-items: center; color: var(--gs-fg-muted, #64748b); }
.ops__login { min-height: 100vh; display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(360px, 480px); align-items: center; gap: 48px; padding: 6vh 8vw; box-sizing: border-box; }
.ops__brand { max-width: 560px; display: grid; gap: 14px; }
.ops__brand h1 { margin: 0; font-size: 34px; letter-spacing: -.02em; }
.ops__brand p { margin: 0; color: #475569; line-height: 1.8; }
.ops__brand ul { margin: 8px 0 0; padding-left: 18px; color: #64748b; line-height: 2; }
.ops__mark { width: 44px; height: 44px; border-radius: 14px; display: grid; place-items: center; background: var(--gs-accent, #00b96b); color: #fff; font-size: 22px; font-weight: 700; }
.ops__login-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 20px; padding: 30px; display: grid; gap: 14px; box-shadow: 0 24px 60px -30px rgba(15,23,42,.35); }
.ops__login-card h2 { margin: 0; font-size: 22px; }
.ops__login-card p { margin: 0; color: #64748b; font-size: 13px; }
.ops__login-card label, .ops__field { display: grid; gap: 6px; font-size: 13px; color: #334155; }
.ops__login-card input, .ops__field select, .ops__field input { border: 1px solid #cbd5e1; border-radius: 10px; padding: 10px 12px; font-size: 14px; background: #fff; color: #0f172a; }
.ops__login-card button { border: 0; border-radius: 10px; padding: 11px; background: var(--gs-accent, #00b96b); color: #fff; font-weight: 650; font-size: 14px; cursor: pointer; }
.ops__header { height: 58px; display: flex; align-items: center; justify-content: space-between; padding: 0 22px; background: #fff; border-bottom: 1px solid #e2e8f0; }
.ops__brand-inline { display: flex; align-items: center; gap: 10px; font-size: 15px; }
.ops__brand-inline .ops__mark { width: 28px; height: 28px; border-radius: 9px; font-size: 14px; }
.ops__tag { font-size: 10.5px; letter-spacing: .12em; text-transform: uppercase; color: #64748b; background: #f1f5f9; border-radius: 999px; padding: 3px 8px; }
.ops__operator { display: flex; align-items: center; gap: 12px; font-size: 13px; color: #475569; }
.ops__operator button { border: 1px solid #cbd5e1; background: #fff; border-radius: 8px; padding: 5px 11px; font-size: 12.5px; cursor: pointer; }
.ops__body { display: grid; grid-template-columns: 190px minmax(0, 1fr); min-height: calc(100vh - 58px); }
.ops__nav { padding: 18px 12px; border-right: 1px solid #e2e8f0; background: #fff; display: grid; align-content: start; gap: 4px; }
.ops__nav button { text-align: left; border: 0; background: transparent; border-radius: 9px; padding: 9px 12px; font-size: 13.5px; color: #475569; cursor: pointer; }
.ops__nav button.is-active { background: var(--gs-accent-soft, #e8f9f0); color: var(--gs-accent-strong, #008f52); font-weight: 650; }
.ops__main { padding: 24px clamp(18px, 2.4vw, 32px) 48px; display: grid; align-content: start; gap: 16px; }
.ops__main-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; }
.ops__kicker { font-size: 11px; letter-spacing: .18em; color: #94a3b8; font-weight: 700; }
.ops__main-head h2 { margin: 4px 0 0; font-size: 22px; }
.ops__refresh { border: 1px solid #cbd5e1; background: #fff; border-radius: 9px; padding: 7px 14px; font-size: 12.5px; cursor: pointer; }
.ops__notice { margin: 0; padding: 10px 14px; border-radius: 10px; background: #e8f9f0; color: #008f52; font-size: 13px; font-weight: 600; }
.ops__error { margin: 0; color: #b91c1c; font-size: 13px; }
.ops__muted, .ops__login-card .ops__muted { color: #94a3b8; font-size: 12.5px; }
.ops__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 14px; }
.ops__stack { display: grid; gap: 14px; }
.ops__pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 600; background: #e2e8f0; color: #475569; }
.ops__pill.is-ok { background: #dcfce7; color: #166534; }
.ops__pill.is-bad { background: #fee2e2; color: #991b1b; }
.ops__danger { border: 1px solid #fecaca; background: #fff; color: #b91c1c; border-radius: 8px; padding: 5px 10px; font-size: 12px; cursor: pointer; }
.ops__danger:disabled { opacity: .5; cursor: default; }
.ops__card { background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 18px 20px; display: grid; gap: 8px; }
.ops__card--wide { grid-column: 1 / -1; }
.ops__card h3 { margin: 0; font-size: 13px; font-weight: 650; color: #0f172a; }
.ops__card p { margin: 0; font-size: 13px; color: #334155; line-height: 1.6; }
.ops__ok { color: #008f52 !important; font-weight: 650; }
.ops__warn { color: #b45309 !important; font-weight: 650; }
.ops__list { margin: 0; padding-left: 18px; display: grid; gap: 4px; font-size: 12.5px; color: #475569; }
.ops__table-wrap { background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; overflow: auto; }
.ops__table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.ops__table th, .ops__table td { text-align: left; padding: 9px 12px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
.ops__table th { color: #64748b; font-weight: 600; background: #f8fafc; white-space: nowrap; }
.ops__table tr:last-child td { border-bottom: 0; }
.ops__json { max-width: 320px; word-break: break-all; color: #64748b; }
.ops__badge { font-size: 11px; font-weight: 650; border-radius: 999px; padding: 2px 8px; background: #f1f5f9; color: #475569; }
.ops__badge.is-ok { background: #e8f9f0; color: #008f52; }
.ops__badge.is-warn { background: #fef3c7; color: #b45309; }
.ops__badge.is-bad { background: #fee2e2; color: #991b1b; }
.ops__badge.is-muted { background: #e2e8f0; color: #475569; }
.ops__btn { border: 1px solid #cbd5e1; background: #fff; border-radius: 8px; padding: 5px 9px; font-size: 12px; cursor: pointer; color: #334155; }
.ops__btn--danger { border-color: #fecaca; color: #b91c1c; }
.ops__row-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.ops__row-actions select { border: 1px solid #cbd5e1; border-radius: 8px; padding: 5px 6px; font-size: 12px; background: #fff; }
.ops__detail { border-top: 1px solid #e2e8f0; padding: 14px 16px; display: grid; gap: 8px; }
.ops__detail header { display: flex; justify-content: space-between; align-items: center; }
.ops__inline-form { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }
.ops__inline-form .ops__field { min-width: 160px; }
.ops__toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.ops__toolbar h3 { margin: 0; margin-right: auto; }
.ops__toolbar select, .ops__toolbar input { border: 1px solid #cbd5e1; border-radius: 8px; padding: 6px 9px; font-size: 12.5px; background: #fff; color: #0f172a; }
.ops__toolbar input { min-width: 250px; }
.ops__btn--primary { background: var(--gs-accent, #00b96b); border-color: transparent; color: #fff; font-weight: 650; }
.ops__btn:disabled { opacity: .55; cursor: default; }
.ops__modal { position: fixed; inset: 0; background: rgba(15,23,42,.42); display: grid; place-items: center; padding: 24px; z-index: 1000; overflow: hidden; }
.ops__modal-card { width: min(760px, 100%); max-height: calc(100dvh - 48px); overflow-y: auto; overflow-x: hidden; background: #fff; border-radius: 16px; padding: 22px 24px; display: flex; flex-direction: column; gap: 14px; box-shadow: 0 30px 80px -30px rgba(15,23,42,.5); }
.ops__modal-card > header {
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  padding-bottom: 12px; border-bottom: 1px solid #e2e8f0;
}
.ops__modal-card h2 { margin: 0; font-size: 18px; }
.ops__form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.ops__field textarea { border: 1px solid #cbd5e1; border-radius: 10px; padding: 10px 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; resize: vertical; }
.ops__modal-actions { display: flex; justify-content: flex-end; gap: 10px; }
.ops__check { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: #334155; }
.ops__model-picker { display: grid; gap: 8px; border-top: 1px solid #f1f5f9; padding-top: 14px; }
.ops__model-picker h3 { margin: 0; font-size: 14px; color: #0f172a; }
.ops__model-picker p { margin: 0; }
.ops__model-option { display: flex; align-items: center; gap: 8px; border: 1px solid #e2e8f0; border-radius: 10px; padding: 9px 11px; font-size: 12.5px; color: #334155; cursor: pointer; word-break: break-all; }
.ops__model-option.is-selected { border-color: var(--gs-accent, #00b96b); background: #f0fdf4; color: #047857; font-weight: 600; }
.ops__model-option input { accent-color: var(--gs-accent, #00b96b); }
.ops__model-fallback { display: grid; gap: 6px; }
.ops__model-fallback p { margin: 0; }
@media (max-width: 800px) {
  .ops__login { grid-template-columns: 1fr; padding: 4vh 6vw; }
  .ops__body { grid-template-columns: 1fr; }
  .ops__nav { flex-direction: row; display: flex; overflow-x: auto; border-right: 0; border-bottom: 1px solid #e2e8f0; }
  .ops__main { padding: 18px 14px 40px; }
}
</style>
