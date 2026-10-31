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
  { key: 'providers', label: '数据源' },
  { key: 'ai', label: '模型网关' },
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

const gateway = ref<Row | null>(null);
const gatewayLoading = ref(false);
const gatewayBusy = ref(false);

const AI_PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', mark: 'D', color: '#4d6bfe', hint: '官方 API', baseUrl: 'https://api.deepseek.com/v1', requiresKey: true },
  { id: 'openai', name: 'OpenAI', mark: '◎', color: '#10a37f', hint: 'GPT 系列', baseUrl: 'https://api.openai.com/v1', requiresKey: true },
  { id: 'volcengine', name: '火山方舟', mark: '火', color: '#1664ff', hint: '豆包 / Ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', requiresKey: true },
  { id: 'dashscope', name: '通义千问', mark: '通', color: '#615ced', hint: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', requiresKey: true },
  { id: 'moonshot', name: 'Kimi', mark: 'K', color: '#1f2329', hint: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', requiresKey: true },
  { id: 'zhipu', name: '智谱 GLM', mark: '智', color: '#2f54eb', hint: 'BigModel', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', requiresKey: true },
  { id: 'ollama', name: 'Ollama', mark: 'O', color: '#334155', hint: '本机运行,无需 Key', baseUrl: 'http://127.0.0.1:11434/v1', requiresKey: false },
  { id: 'custom', name: '自定义', mark: '+', color: '#64748b', hint: '任意 OpenAI 兼容接口', baseUrl: '', requiresKey: true },
] as const;
type AiPreset = (typeof AI_PRESETS)[number];

const aiWizard = ref<{
  mode: 'create' | 'edit';
  providerId?: string;
  presetId: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  priority: number;
  timeoutMs: number;
  minOutputTokens: number;
  maxTokensField: string;
  headersText: string;
  testing: boolean;
  tested: boolean;
  latencyMs: number | null;
  models: string[];
  modelsError: string;
  testError: string;
  selectedModel: string;
  manualModel: string;
  error: string;
} | null>(null);

const aiRouteModal = ref<{ mode: 'create' | 'edit'; id?: string; alias: string } | null>(null);
const aiRouteForm = ref({
  providerId: '',
  alias: '',
  upstreamModel: '',
  isDefault: false,
  enabled: true,
});
const aiModelOptions = ref<string[]>([]);
const aiTestResult = ref<Record<string, { tone: 'ok' | 'bad'; text: string }>>({});

const activeLabel = computed(() => TABS.find((tab) => tab.key === active.value)?.label ?? '');
const aiWizardPreset = computed(() =>
  aiWizard.value ? presetById(aiWizard.value.presetId) : null,
);
const aiChosenModel = computed(() => aiWizard.value?.selectedModel || aiWizard.value?.manualModel.trim() || '');
const gatewayRoutes = computed<Row[]>(() =>
  Array.isArray(gateway.value?.routes) ? (gateway.value!.routes as Row[]) : [],
);
const aiCanSave = computed(() => {
  const wizard = aiWizard.value;
  if (!wizard || !aiChosenModel.value || wizard.testing) return false;
  return wizard.mode === 'edit' || Boolean(wizard.apiKey.trim()) || aiWizardPreset.value?.requiresKey === false;
});

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
async function loadGateway(): Promise<void> {
  gatewayLoading.value = true;
  error.value = '';
  try {
    gateway.value = await api<Row>('/api/ops/model-gateway');
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    gatewayLoading.value = false;
  }
}
function presetById(id: string): AiPreset {
  return AI_PRESETS.find((preset) => preset.id === id) ?? AI_PRESETS[AI_PRESETS.length - 1]!;
}
function presetForProvider(provider: Row): AiPreset {
  const baseUrl = String(provider.baseUrl ?? '');
  return (
    AI_PRESETS.find((preset) => preset.baseUrl && baseUrl.startsWith(preset.baseUrl.replace(/\/v1$/, ''))) ??
    AI_PRESETS[AI_PRESETS.length - 1]!
  );
}
function openAiWizard(presetId = 'deepseek'): void {
  const preset = presetById(presetId);
  aiWizard.value = {
    mode: 'create',
    presetId: preset.id,
    name: preset.name,
    baseUrl: preset.baseUrl,
    apiKey: '',
    priority: 100,
    timeoutMs: 120000,
    minOutputTokens: 0,
    maxTokensField: 'max_tokens',
    headersText: '{}',
    testing: false,
    tested: false,
    latencyMs: null,
    models: [],
    modelsError: '',
    testError: '',
    selectedModel: '',
    manualModel: '',
    error: '',
  };
}
function openEditAiWizard(provider: Row): void {
  const defaultRoute = aiDefaultRoute(provider);
  const preset = presetForProvider(provider);
  aiWizard.value = {
    mode: 'edit',
    providerId: String(provider.id),
    presetId: preset.id,
    name: String(provider.name ?? ''),
    baseUrl: String(provider.baseUrl ?? ''),
    apiKey: '',
    priority: Number(provider.priority ?? 100),
    timeoutMs: Number(provider.timeoutMs ?? 120000),
    minOutputTokens: Number(provider.minOutputTokens ?? 0),
    maxTokensField: String(provider.maxTokensField ?? 'max_tokens'),
    headersText: JSON.stringify(provider.headers ?? {}, null, 2),
    testing: false,
    tested: false,
    latencyMs: null,
    models: defaultRoute ? [String(defaultRoute.upstreamModel)] : [],
    modelsError: '',
    testError: '',
    selectedModel: defaultRoute ? String(defaultRoute.upstreamModel) : '',
    manualModel: '',
    error: '',
  };
}
function closeAiWizard(): void {
  aiWizard.value = null;
}
function selectAiPreset(preset: AiPreset): void {
  if (!aiWizard.value) return;
  aiWizard.value.presetId = preset.id;
  aiWizard.value.name = preset.name;
  aiWizard.value.baseUrl = preset.baseUrl;
  aiWizard.value.models = [];
  aiWizard.value.tested = false;
  aiWizard.value.selectedModel = '';
  aiWizard.value.manualModel = '';
  aiWizard.value.modelsError = '';
  aiWizard.value.testError = '';
  aiWizard.value.error = '';
}
function parseWizardHeaders(): Record<string, string> | null {
  if (!aiWizard.value) return null;
  try {
    const parsed = aiWizard.value.headersText.trim() ? JSON.parse(aiWizard.value.headersText) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
  } catch {
    return null;
  }
}
async function probeAiWizard(): Promise<void> {
  const wizard = aiWizard.value;
  if (!wizard) return;
  const preset = presetById(wizard.presetId);
  wizard.error = '';
  wizard.testError = '';
  wizard.modelsError = '';
  wizard.tested = false;
  if (!wizard.baseUrl.trim()) {
    wizard.error = '请先填写接口地址(高级设置里)';
    return;
  }
  if (wizard.mode === 'create' && preset.requiresKey && !wizard.apiKey.trim()) {
    wizard.error = `请先填写 ${preset.name} 的 API Key`;
    return;
  }
  const headers = parseWizardHeaders();
  if (!headers) {
    wizard.error = '高级设置里的额外请求头必须是 JSON 对象';
    return;
  }
  wizard.testing = true;
  try {
    const response =
      wizard.mode === 'create'
        ? await api<{ data: Row }>('/api/ops/model-gateway/probe', {
            method: 'POST',
            body: JSON.stringify({
              baseUrl: wizard.baseUrl.trim(),
              apiKey: wizard.apiKey.trim() || undefined,
              headers,
              maxTokensField: wizard.maxTokensField,
              model: wizard.manualModel.trim() || undefined,
            }),
          })
        : await api<{ data: Row }>(`/api/ops/model-gateway/providers/${wizard.providerId}/test`, {
            method: 'POST',
            body: JSON.stringify({
              apiKey: wizard.apiKey.trim() || undefined,
              model: wizard.selectedModel || wizard.manualModel.trim() || undefined,
            }),
          });
    const data = response.data ?? {};
    wizard.latencyMs = Number(data.latencyMs ?? 0) || null;
    const fetched = Array.isArray(data.models) ? data.models.map(String) : [];
    wizard.models = [...new Set([...(wizard.selectedModel ? [wizard.selectedModel] : []), ...fetched])];
    wizard.modelsError = String(data.modelsError ?? '');
    wizard.testError = String(data.testError ?? data.error ?? '');
    wizard.tested = true;
    if (!wizard.selectedModel && wizard.models.length > 0) wizard.selectedModel = wizard.models[0]!;
  } catch (err) {
    wizard.error = err instanceof Error ? err.message : String(err);
  } finally {
    wizard.testing = false;
  }
}
async function saveAiWizard(): Promise<void> {
  const wizard = aiWizard.value;
  if (!wizard) return;
  const model = wizard.selectedModel || wizard.manualModel.trim();
  if (!model) {
    wizard.error = '请选择一个默认模型';
    return;
  }
  const preset = presetById(wizard.presetId);
  if (wizard.mode === 'create' && preset.requiresKey && !wizard.apiKey.trim()) {
    wizard.error = `请先填写 ${preset.name} 的 API Key`;
    return;
  }
  const headers = parseWizardHeaders();
  if (!headers) {
    wizard.error = '高级设置里的额外请求头必须是 JSON 对象';
    return;
  }
  gatewayBusy.value = true;
  wizard.error = '';
  try {
    if (wizard.mode === 'create') {
      await api('/api/ops/model-gateway/providers', {
        method: 'POST',
        body: JSON.stringify({
          name: wizard.name.trim() || preset.name,
          baseUrl: wizard.baseUrl.trim(),
          apiKey: wizard.apiKey.trim() || undefined,
          headers,
          priority: wizard.priority,
          timeoutMs: wizard.timeoutMs,
          minOutputTokens: wizard.minOutputTokens > 0 ? wizard.minOutputTokens : null,
          maxTokensField: wizard.maxTokensField,
          defaultModel: model,
        }),
      });
      notice.value = `${wizard.name.trim() || preset.name} 已启用,默认模型 ${model}`;
    } else {
      const providerId = wizard.providerId!;
      await api(`/api/ops/model-gateway/providers/${providerId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: wizard.name.trim(),
          baseUrl: wizard.baseUrl.trim(),
          ...(wizard.apiKey.trim() ? { apiKey: wizard.apiKey.trim() } : {}),
          headers,
          priority: wizard.priority,
          timeoutMs: wizard.timeoutMs,
          minOutputTokens: wizard.minOutputTokens > 0 ? wizard.minOutputTokens : null,
          maxTokensField: wizard.maxTokensField,
        }),
      });
      const existingDefault = gatewayRoutes.value.find(
        (route) => route.providerId === providerId && route.isDefault,
      );
      if (existingDefault) {
        await api(`/api/ops/model-gateway/routes/${existingDefault.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ upstreamModel: model, enabled: true, isDefault: true }),
        });
      } else {
        await api('/api/ops/model-gateway/routes', {
          method: 'POST',
          body: JSON.stringify({
            providerId,
            alias: 'default',
            upstreamModel: model,
            enabled: true,
            isDefault: true,
          }),
        });
      }
      notice.value = `${wizard.name} 的默认模型已设为 ${model}`;
    }
    aiWizard.value = null;
    await loadGateway();
  } catch (err) {
    wizard.error = err instanceof Error ? err.message : String(err);
  } finally {
    gatewayBusy.value = false;
  }
}
function aiDefaultRoute(provider: Row): Row | null {
  return gatewayRoutes.value.find(
    (route) => route.providerId === provider.id && route.isDefault,
  ) ?? null;
}
function aiProviderRouteCount(provider: Row): number {
  return gatewayRoutes.value.filter((route) => route.providerId === provider.id).length;
}
async function toggleAiProvider(provider: Row): Promise<void> {
  gatewayBusy.value = true;
  try {
    await api(`/api/ops/model-gateway/providers/${provider.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !provider.enabled }),
    });
    notice.value = `厂商 ${provider.name} 已${provider.enabled ? '停用' : '启用'}`;
    await loadGateway();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    gatewayBusy.value = false;
  }
}
async function deleteAiProvider(provider: Row): Promise<void> {
  if (!window.confirm(`删除 ${provider.name}?它的模型配置会一并删除。`)) return;
  gatewayBusy.value = true;
  try {
    await api(`/api/ops/model-gateway/providers/${provider.id}`, { method: 'DELETE' });
    notice.value = `${provider.name} 已删除`;
    await loadGateway();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    gatewayBusy.value = false;
  }
}
async function testAiProvider(provider: Row): Promise<void> {
  gatewayBusy.value = true;
  delete aiTestResult.value[provider.id];
  try {
    const res = await api<{ data: Row }>(`/api/ops/model-gateway/providers/${provider.id}/test`, {
      method: 'POST',
      body: '{}',
    });
    const data = res.data ?? {};
    if (data.ok) {
      const count = Array.isArray(data.models) ? data.models.length : 0;
      aiTestResult.value[provider.id] = {
        tone: 'ok',
        text: `连接正常 ${data.latencyMs}ms · ${data.model}${count ? ` · 可用模型 ${count} 个` : ''}`,
      };
    } else {
      aiTestResult.value[provider.id] = {
        tone: 'bad',
        text: String(data.testError ?? data.error ?? '连接失败'),
      };
    }
  } catch (err) {
    aiTestResult.value[provider.id] = { tone: 'bad', text: err instanceof Error ? err.message : String(err) };
  } finally {
    gatewayBusy.value = false;
  }
}
async function fetchAiModels(providerId: string): Promise<void> {
  if (!providerId) return;
  gatewayBusy.value = true;
  try {
    const res = await api<{ data: { models: string[] } }>(`/api/ops/model-gateway/providers/${providerId}/models`);
    aiModelOptions.value = res.data?.models ?? [];
    notice.value = `从服务商读取到 ${aiModelOptions.value.length} 个模型`;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    gatewayBusy.value = false;
  }
}
function openCreateAiRoute(): void {
  aiRouteModal.value = { mode: 'create', alias: '' };
  aiRouteForm.value = {
    providerId: String(gateway.value?.providers?.[0]?.id ?? ''),
    alias: '',
    upstreamModel: '',
    isDefault: false,
    enabled: true,
  };
  aiModelOptions.value = [];
}
function openEditAiRoute(route: Row): void {
  aiRouteModal.value = { mode: 'edit', id: String(route.id), alias: String(route.alias) };
  aiRouteForm.value = {
    providerId: String(route.providerId ?? ''),
    alias: String(route.alias ?? ''),
    upstreamModel: String(route.upstreamModel ?? ''),
    isDefault: Boolean(route.isDefault),
    enabled: Boolean(route.enabled),
  };
  aiModelOptions.value = [];
}
function closeAiRouteModal(): void {
  aiRouteModal.value = null;
}
async function saveAiRoute(): Promise<void> {
  if (!aiRouteModal.value) return;
  const form = aiRouteForm.value;
  gatewayBusy.value = true;
  error.value = '';
  try {
    if (aiRouteModal.value.mode === 'create') {
      await api('/api/ops/model-gateway/routes', {
        method: 'POST',
        body: JSON.stringify({
          providerId: form.providerId,
          alias: form.alias.trim(),
          upstreamModel: form.upstreamModel.trim(),
          isDefault: form.isDefault,
          enabled: form.enabled,
        }),
      });
      notice.value = `模型别名 ${form.alias} 已创建`;
    } else {
      await api(`/api/ops/model-gateway/routes/${aiRouteModal.value.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          alias: form.alias.trim(),
          upstreamModel: form.upstreamModel.trim(),
          isDefault: form.isDefault,
          enabled: form.enabled,
        }),
      });
      notice.value = `模型别名 ${form.alias} 已更新`;
    }
    aiRouteModal.value = null;
    await loadGateway();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    gatewayBusy.value = false;
  }
}
async function deleteAiRoute(route: Row): Promise<void> {
  if (!window.confirm(`删除模型别名 ${route.alias} → ${route.upstreamModel}?`)) return;
  gatewayBusy.value = true;
  try {
    await api(`/api/ops/model-gateway/routes/${route.id}`, { method: 'DELETE' });
    notice.value = `模型别名 ${route.alias} 已删除`;
    await loadGateway();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    gatewayBusy.value = false;
  }
}
async function setDefaultAiRoute(route: Row): Promise<void> {
  gatewayBusy.value = true;
  try {
    await api(`/api/ops/model-gateway/routes/${route.id}`, { method: 'PATCH', body: JSON.stringify({ isDefault: true }) });
    notice.value = `默认路由已切换为 ${route.alias}`;
    await loadGateway();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    gatewayBusy.value = false;
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
      api<{ states: Row[] }>('/api/ops/r4/policy-state'),
    ]);
    revocationRows.value = list.requests ?? [];
    revocationPolicy.value = policy.states ?? [];
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

function revocationBadge(state: unknown): string {
  if (state === 'ACKED') return 'is-ok';
  if (state === 'PENDING_CONFIRMATION' || state === 'PENDING') return 'is-warn';
  return 'is-bad';
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
  if (tab === 'providers') await loadProviders();
  if (tab === 'ai') await loadGateway();
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

          <section v-else-if="active === 'ai' && gateway" class="ops__stack">
            <article class="ops__ai-hero">
              <div>
                <span class="ops__kicker">AI 设置</span>
                <h3>让 AI 用起来</h3>
                <p>选一个常用服务商,填入 API Key。系统会自动测试连接、读取可用模型,你只需要选一个默认模型。</p>
                <p v-if="!gateway.gateway?.configured" class="ops__warn">网关尚未启用:在服务器 .env 配置 MODEL_GATEWAY_API_KEY 后重启。</p>
              </div>
              <div class="ops__ai-hero-actions">
                <span class="ops__badge" :class="gateway.gateway?.configured ? 'is-ok' : 'is-warn'">{{ gateway.gateway?.configured ? '网关已启用' : '网关未启用' }}</span>
                <button v-if="gateway.providers.length > 0" type="button" class="ops__btn ops__btn--primary" @click="openAiWizard()">添加 AI 服务商</button>
              </div>
            </article>

            <template v-if="gateway.providers.length === 0">
              <div class="ops__preset-grid">
                <button v-for="preset in AI_PRESETS" :key="preset.id" type="button" class="ops__preset-card" @click="openAiWizard(preset.id)">
                  <span class="ops__preset-mark" :style="{ background: preset.color }">{{ preset.mark }}</span>
                  <strong>{{ preset.name }}</strong>
                  <small>{{ preset.hint }}</small>
                </button>
              </div>
              <p class="ops__muted">接口地址已经帮你填好,通常只需要填 API Key。本机 Ollama 不需要 Key。</p>
            </template>

            <template v-else>
              <div class="ops__ai-grid">
                <article v-for="provider in gateway.providers" :key="provider.id" class="ops__ai-card">
                  <header class="ops__ai-card-head">
                    <span class="ops__preset-mark" :style="{ background: presetForProvider(provider).color }">{{ presetForProvider(provider).mark }}</span>
                    <div class="ops__ai-card-title">
                      <strong>{{ provider.name }}</strong>
                      <small>{{ presetForProvider(provider).hint }}</small>
                    </div>
                    <span class="ops__badge" :class="provider.enabled ? 'is-ok' : 'is-warn'">{{ provider.enabled ? '使用中' : '已停用' }}</span>
                  </header>
                  <div class="ops__ai-default">
                    <span>默认模型</span>
                    <strong>{{ aiDefaultRoute(provider)?.upstreamModel || '未设置' }}</strong>
                  </div>
                  <p class="ops__muted">Key {{ provider.apiKeyMasked }} · 共 {{ aiProviderRouteCount(provider) }} 个模型配置</p>
                  <p v-if="aiTestResult[provider.id]" class="ops__muted" :class="aiTestResult[provider.id]?.tone === 'ok' ? 'ops__ok' : 'ops__warn'">{{ aiTestResult[provider.id]?.text }}</p>
                  <footer class="ops__ai-card-actions">
                    <button type="button" class="ops__btn" :disabled="gatewayBusy" @click="testAiProvider(provider)">测试</button>
                    <button type="button" class="ops__btn ops__btn--primary" :disabled="gatewayBusy" @click="openEditAiWizard(provider)">
                      {{ aiDefaultRoute(provider) ? '更换模型 / Key' : '完成设置' }}
                    </button>
                    <button type="button" class="ops__btn" :disabled="gatewayBusy" @click="toggleAiProvider(provider)">{{ provider.enabled ? '停用' : '启用' }}</button>
                    <button type="button" class="ops__btn ops__btn--danger" :disabled="gatewayBusy" @click="deleteAiProvider(provider)">删除</button>
                  </footer>
                </article>
              </div>
              <p v-if="!gatewayRoutes.some((route) => route.isDefault)" class="ops__warn ops__warn--inline">
                还没有默认模型。点服务商的「完成设置」选一个模型;在那之前 AI 任务不会成功。
              </p>
            </template>

            <details class="ops__card ops__card--wide ops__advanced">
              <summary>高级:按模型别名路由(通常不需要)</summary>
              <div class="ops__toolbar">
                <h3>模型别名</h3>
                <button type="button" class="ops__btn ops__btn--primary" :disabled="gateway.providers.length === 0" @click="openCreateAiRoute">新增别名</button>
              </div>
              <p class="ops__muted">只有想给不同任务指定不同模型时才需要。引擎按任务名请求;未命中别名时使用默认模型。</p>
              <table class="ops__table">
                <thead><tr><th>别名</th><th>服务商</th><th>实际模型</th><th>默认</th><th>状态</th><th></th></tr></thead>
                <tbody>
                  <tr v-for="route in gatewayRoutes" :key="route.id">
                    <td><strong>{{ route.alias }}</strong></td>
                    <td>{{ route.providerName }}</td>
                    <td class="ops__json">{{ route.upstreamModel }}</td>
                    <td><span v-if="route.isDefault" class="ops__badge is-ok">默认</span><span v-else class="ops__muted">—</span></td>
                    <td><span class="ops__badge" :class="route.enabled ? 'is-ok' : 'is-warn'">{{ route.enabled ? '启用' : '停用' }}</span></td>
                    <td class="ops__row-actions">
                      <button v-if="!route.isDefault" type="button" class="ops__btn" :disabled="gatewayBusy" @click="setDefaultAiRoute(route)">设为默认</button>
                      <button type="button" class="ops__btn" @click="openEditAiRoute(route)">编辑</button>
                      <button type="button" class="ops__btn ops__btn--danger" :disabled="gatewayBusy" @click="deleteAiRoute(route)">删除</button>
                    </td>
                  </tr>
                  <tr v-if="gatewayRoutes.length === 0"><td colspan="6" class="ops__muted">还没有模型别名;设置默认模型后会自动出现一条默认配置。</td></tr>
                </tbody>
              </table>
              <div class="ops__advanced-env">
                <p class="ops__muted">引擎侧配置(切换后生效):</p>
                <pre class="ops__code">MODEL_GATEWAY_URL=http://127.0.0.1:4020/v1
MODEL_GATEWAY_KEY=<与服务端 MODEL_GATEWAY_API_KEY 一致>
MODEL_GATEWAY_STREAM_CHAT_COMPLETIONS=false</pre>
              </div>
            </details>

            <details class="ops__card ops__card--wide ops__advanced">
              <summary>调用记录(最近 100 条) · 24h {{ Object.entries(gateway.stats24h ?? {}).map(([k, v]) => `${k} ${v}`).join(' · ') || '无调用' }}</summary>
              <table class="ops__table">
                <thead><tr><th>时间</th><th>请求模型 → 实际模型</th><th>服务商</th><th>状态</th><th>延迟</th><th>Token</th><th>错误</th></tr></thead>
                <tbody>
                  <tr v-for="call in gateway.calls" :key="call.id">
                    <td>{{ fmt(call.at) }}</td>
                    <td>{{ call.alias }}<br /><small class="ops__muted">{{ call.upstreamModel }}</small></td>
                    <td>{{ call.providerName || '—' }}</td>
                    <td><span class="ops__badge" :class="call.status === 'OK' ? 'is-ok' : 'is-warn'">{{ call.status }}</span></td>
                    <td>{{ call.latencyMs }} ms</td>
                    <td>{{ fmt(call.inputTokens) }} / {{ fmt(call.outputTokens) }}</td>
                    <td class="ops__json">{{ call.error || '—' }}</td>
                  </tr>
                  <tr v-if="gateway.calls.length === 0"><td colspan="7" class="ops__muted">还没有调用记录</td></tr>
                </tbody>
              </table>
              <p class="ops__muted">只记录元数据与 token 计数,不保存 prompt/补全。</p>
            </details>
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
                <thead><tr><th>Workspace</th><th>Kind</th><th>Purpose</th><th>Cap</th><th>过期</th><th>已消费</th><th>撤销</th></tr></thead>
                <tbody>
                  <tr v-for="authority in budget.authorities" :key="authority.id">
                    <td>{{ authority.workspace_id }}</td><td>{{ authority.authority_kind }}</td><td>{{ authority.purpose }}</td>
                    <td>{{ authority.cap_microusd }}</td><td>{{ fmt(authority.expires_at) }}</td><td>{{ fmt(authority.consumed_at) }}</td><td>{{ fmt(authority.revoked_at) }}</td>
                  </tr>
                  <tr v-if="budget.authorities.length === 0"><td colspan="7" class="ops__muted">无授权记录</td></tr>
                </tbody>
              </table>
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
                  <tr v-if="traceRows.length === 0"><td colspan="7" class="ops__muted">无(模型网关恢复后才会有调用记录)</td></tr></tbody>
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
              <table class="ops__table"><thead><tr><th>公司</th><th>队列</th><th>Fit</th><th>分数</th><th>创建</th></tr></thead>
                <tbody><tr v-for="lead in leads" :key="lead.id"><td>{{ lead.company_name }}<br /><small class="ops__muted">{{ lead.company_domain }}</small></td><td>{{ lead.queue }}</td><td>{{ lead.fit_verdict }}</td><td>{{ fmt(lead.total_score) }}</td><td>{{ fmt(lead.created_at) }}</td></tr>
                  <tr v-if="leads.length === 0"><td colspan="5" class="ops__muted">无</td></tr></tbody>
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
              <h3>平台策略状态</h3>
              <table class="ops__table">
                <thead><tr><th>Schedule</th><th>模式</th><th>更新人</th><th>更新时间</th></tr></thead>
                <tbody>
                  <tr v-for="state in revocationPolicy" :key="state.scheduleId">
                    <td>{{ state.scheduleId }}</td>
                    <td><span class="ops__badge" :class="state.mode === 'ENABLED' ? 'is-ok' : 'is-warn'">{{ state.mode }}</span></td>
                    <td>{{ state.updatedBy }}</td>
                    <td>{{ fmt(state.updatedAt) }}</td>
                  </tr>
                  <tr v-if="revocationPolicy.length === 0"><td colspan="4" class="ops__muted">还没有策略状态记录（首次启用后会建立基线）。</td></tr>
                </tbody>
              </table>
              <p class="ops__muted">该状态是后端 policy asset 的镜像；两侧不一致会让引擎 readiness fail closed。</p>
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
                <button type="button" class="ops__btn ops__btn--danger" :disabled="!!revocationBusy" @click="createRevocation">发起撤销</button>
              </div>
              <p class="ops__muted">撤销按 schedule 生效、当前不可重开；操作员发起的请求立即投递，自动来源的请求需在下方确认。只有三个有 egress 的 schedule 可撤销。</p>
            </article>
            <article class="ops__card ops__card--wide">
              <h3>撤销请求</h3>
              <table class="ops__table">
                <thead><tr><th>创建</th><th>Schedule</th><th>原因 / 来源</th><th>状态</th><th>序列</th><th>ACK / 错误</th><th></th></tr></thead>
                <tbody>
                  <tr v-for="row in revocationRows" :key="row.id">
                    <td>{{ fmt(row.createdAt) }}</td>
                    <td>{{ row.scheduleId }}</td>
                    <td>{{ row.reasonCode }}<br /><small class="ops__muted">{{ row.source }} · {{ row.requestedBy }}</small></td>
                    <td><span class="ops__badge" :class="revocationBadge(row.state)">{{ row.state }}</span></td>
                    <td>{{ row.fenceSequence }}</td>
                    <td class="ops__json">{{ row.state === 'ACKED' ? `receipt ${row.ackReceiptId} · generation ${row.ackGeneration} · in-flight ${row.ackInFlightAttempts}` : (row.lastError || '—') }}</td>
                    <td class="ops__row-actions">
                      <button v-if="row.state === 'PENDING_CONFIRMATION'" type="button" class="ops__btn ops__btn--danger" :disabled="!!revocationBusy" @click="confirmRevocation(row.id, row.scheduleId)">确认投递</button>
                      <button v-if="['PENDING_CONFIRMATION', 'BLOCKED', 'STORED_STATE_CONFLICT'].includes(row.state)" type="button" class="ops__btn" :disabled="!!revocationBusy" @click="cancelRevocation(row.id, row.scheduleId)">取消</button>
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

      <div v-if="aiWizard && aiWizardPreset" class="ops__modal" @click.self="closeAiWizard">
        <form class="ops__modal-card ops__modal-card--wizard" @submit.prevent="saveAiWizard">
          <header>
            <div>
              <span class="ops__kicker">{{ aiWizard.mode === 'create' ? '添加 AI 服务商' : 'AI 服务商设置' }}</span>
              <h2>{{ aiWizardPreset.name }}</h2>
            </div>
            <button type="button" class="ops__btn" @click="closeAiWizard">关闭</button>
          </header>

          <div v-if="aiWizard.mode === 'create'" class="ops__preset-strip">
            <button
              v-for="preset in AI_PRESETS"
              :key="preset.id"
              type="button"
              class="ops__preset-chip"
              :class="{ 'is-active': aiWizard.presetId === preset.id }"
              @click="selectAiPreset(preset)"
            >
              <span class="ops__preset-dot" :style="{ background: preset.color }">{{ preset.mark }}</span>
              {{ preset.name }}
            </button>
          </div>

          <div class="ops__ai-key-row">
            <label class="ops__field ops__ai-key-input">
              <span>API Key {{ aiWizardPreset.requiresKey ? '*' : '(本地服务可留空)' }}</span>
              <input
                v-model="aiWizard.apiKey"
                type="password"
                autocomplete="new-password"
                :placeholder="aiWizard.mode === 'edit' ? '留空则保留当前 Key' : '粘贴服务商控制台里的 API Key'"
              />
            </label>
            <div class="ops__ai-endpoint">
              <span>{{ aiWizardPreset.hint }}</span>
              <code>{{ aiWizard.baseUrl || '在高级设置里填写接口地址' }}</code>
            </div>
          </div>
          <p class="ops__muted">Key 只用于调用 {{ aiWizardPreset.name }},加密保存在本机,不会回显。</p>

          <details class="ops__advanced-toggle">
            <summary>高级设置(接口地址、模型字段、超时)</summary>
            <div class="ops__form-grid">
              <label class="ops__field"><span>显示名称</span><input v-model="aiWizard.name" maxlength="80" /></label>
              <label class="ops__field"><span>接口地址</span><input v-model="aiWizard.baseUrl" placeholder="https://api.example.com/v1" /></label>
              <label class="ops__field"><span>max_tokens 字段</span>
                <select v-model="aiWizard.maxTokensField">
                  <option value="max_tokens">max_tokens(多数服务)</option>
                  <option value="max_completion_tokens">max_completion_tokens(OpenAI 新推理模型)</option>
                </select>
              </label>
              <label class="ops__field"><span>超时(毫秒)</span><input v-model.number="aiWizard.timeoutMs" type="number" min="5000" step="1000" /></label>
              <label class="ops__field"><span>最小输出预算(可选)</span><input v-model.number="aiWizard.minOutputTokens" type="number" min="0" step="1024" placeholder="推理模型建议 16384" /></label>
              <label class="ops__field"><span>优先级(越小越先)</span><input v-model.number="aiWizard.priority" type="number" min="1" step="1" /></label>
            </div>
            <label class="ops__field"><span>额外请求头(JSON,一般不用填)</span><textarea v-model="aiWizard.headersText" rows="3" spellcheck="false" placeholder='{"HTTP-Referer":"https://gainos.example"}' /></label>
          </details>

          <div class="ops__probe-panel">
            <button type="button" class="ops__btn ops__btn--primary" :disabled="aiWizard.testing" @click="probeAiWizard">
              {{ aiWizard.testing ? '正在连接并读取模型…' : aiWizard.tested ? '重新测试' : '测试连接并获取模型' }}
            </button>
            <span v-if="aiWizard.latencyMs" class="ops__ok">连接成功 · {{ aiWizard.latencyMs }}ms</span>
          </div>
          <p v-if="aiWizard.error" class="ops__error" role="alert">{{ aiWizard.error }}</p>
          <p v-if="aiWizard.testError" class="ops__warn">连接测试未通过:{{ aiWizard.testError }}</p>
          <p v-if="aiWizard.modelsError" class="ops__muted">模型列表未读取到:{{ aiWizard.modelsError }};可手动填写模型名。</p>

          <section v-if="aiWizard.models.length > 0" class="ops__model-picker">
            <h3>选择默认模型</h3>
            <p class="ops__muted">所有 AI 任务先使用这个模型;以后可以在高级里按任务细分。</p>
            <div class="ops__model-grid">
              <label
                v-for="model in aiWizard.models"
                :key="model"
                class="ops__model-option"
                :class="{ 'is-selected': aiWizard.selectedModel === model }"
              >
                <input v-model="aiWizard.selectedModel" type="radio" :value="model" />
                <span>{{ model }}</span>
              </label>
            </div>
          </section>
          <section v-else-if="aiWizard.tested" class="ops__model-fallback">
            <label class="ops__field"><span>模型名称</span><input v-model="aiWizard.manualModel" placeholder="如 deepseek-chat" /></label>
            <p class="ops__muted">没有自动读取到模型列表,可直接填写服务商控制台里的模型名。</p>
          </section>

          <div class="ops__modal-actions">
            <button type="button" class="ops__btn" @click="closeAiWizard">取消</button>
            <button type="submit" class="ops__btn ops__btn--primary" :disabled="!aiCanSave || gatewayBusy">
              {{ gatewayBusy ? '保存中…' : '保存并启用' }}
            </button>
          </div>
        </form>
      </div>

      <div v-if="aiRouteModal" class="ops__modal" @click.self="closeAiRouteModal">
        <form class="ops__modal-card" @submit.prevent="saveAiRoute">
          <header>
            <h2>{{ aiRouteModal.mode === 'create' ? '新增模型路由' : `编辑 ${aiRouteModal.alias}` }}</h2>
            <button type="button" class="ops__btn" @click="closeAiRouteModal">关闭</button>
          </header>
          <div class="ops__form-grid">
            <label class="ops__field"><span>上游厂商 *</span>
              <select v-model="aiRouteForm.providerId" :disabled="aiRouteModal.mode === 'edit'" required @change="aiModelOptions = []">
                <option v-for="provider in gateway?.providers ?? []" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
              </select>
            </label>
            <label class="ops__field"><span>模型别名(引擎请求名) *</span><input v-model="aiRouteForm.alias" required placeholder="deepseek-v4-pro" /></label>
            <label class="ops__field"><span>上游模型 *</span><input v-model="aiRouteForm.upstreamModel" required list="ai-model-options" placeholder="deepseek-chat / gpt-4o-mini" /></label>
            <datalist id="ai-model-options"><option v-for="model in aiModelOptions" :key="model" :value="model" /></datalist>
          </div>
          <div class="ops__toolbar">
            <button type="button" class="ops__btn" :disabled="gatewayBusy || !aiRouteForm.providerId" @click="fetchAiModels(aiRouteForm.providerId)">从上游拉取模型</button>
            <label class="ops__check"><input v-model="aiRouteForm.enabled" type="checkbox" /> 启用</label>
            <label class="ops__check"><input v-model="aiRouteForm.isDefault" type="checkbox" /> 设为默认路由(未命中别名时使用)</label>
          </div>
          <p class="ops__muted">同一别名可添加到多个厂商做按优先级回退;引擎收到的响应 model 会回写为别名。</p>
          <div class="ops__modal-actions">
            <button type="button" class="ops__btn" @click="closeAiRouteModal">取消</button>
            <button type="submit" class="ops__btn ops__btn--primary" :disabled="gatewayBusy">{{ gatewayBusy ? '保存中…' : '保存' }}</button>
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
.ops__code { margin: 0; padding: 12px 14px; border-radius: 10px; background: #0f172a; color: #e2e8f0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.8; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
.ops__ai-hero { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; padding: 24px 26px; border-radius: 18px; border: 1px solid #d1fae5; background: linear-gradient(135deg, #f0fdf4 0%, #fff 62%); }
.ops__ai-hero h3 { margin: 6px 0 0; font-size: 24px; letter-spacing: -.02em; color: #0f172a; }
.ops__ai-hero p { margin: 8px 0 0; max-width: 640px; font-size: 13.5px; line-height: 1.75; color: #475569; }
.ops__ai-hero-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ops__preset-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.ops__preset-card { display: grid; justify-items: start; gap: 8px; padding: 16px 18px; border: 1px solid #e2e8f0; border-radius: 14px; background: #fff; cursor: pointer; text-align: left; transition: transform .15s ease, border-color .15s ease, box-shadow .15s ease; }
.ops__preset-card:hover { transform: translateY(-2px); border-color: #a7f3d0; box-shadow: 0 16px 36px -24px rgba(15,23,42,.35); }
.ops__preset-card strong { font-size: 14px; color: #0f172a; }
.ops__preset-card small { font-size: 11.5px; color: #94a3b8; }
.ops__preset-mark { width: 38px; height: 38px; border-radius: 12px; display: grid; place-items: center; color: #fff; font-size: 16px; font-weight: 700; }
.ops__preset-strip { display: flex; gap: 8px; flex-wrap: wrap; }
.ops__preset-chip { display: inline-flex; align-items: center; gap: 7px; border: 1px solid #e2e8f0; background: #fff; border-radius: 999px; padding: 5px 11px 5px 6px; font-size: 12.5px; color: #475569; cursor: pointer; }
.ops__preset-chip.is-active { border-color: var(--gs-accent, #00b96b); background: #f0fdf4; color: #047857; font-weight: 650; }
.ops__preset-dot { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; color: #fff; font-size: 10px; font-weight: 700; }
.ops__ai-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 420px)); gap: 14px; }
.ops__ai-card { display: grid; gap: 10px; padding: 18px 20px; border: 1px solid #e2e8f0; border-radius: 16px; background: #fff; align-content: start; }
.ops__ai-card-head { display: flex; align-items: center; gap: 10px; }
.ops__ai-card-title { display: grid; gap: 2px; margin-right: auto; }
.ops__ai-card-title strong { font-size: 14px; color: #0f172a; }
.ops__ai-card-title small { font-size: 11px; color: #94a3b8; }
.ops__ai-default { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; background: #f8fafc; border: 1px solid #f1f5f9; border-radius: 10px; padding: 10px 12px; }
.ops__ai-default span { font-size: 11.5px; color: #64748b; }
.ops__ai-default strong { font-size: 13px; color: #0f172a; word-break: break-all; text-align: right; }
.ops__ai-card-actions { display: flex; gap: 7px; flex-wrap: wrap; padding-top: 2px; }
.ops__warn--inline { margin: 0; padding: 10px 12px; border-radius: 10px; background: #fffbeb; border: 1px solid #fde68a; font-size: 12.5px; }
.ops__advanced { padding: 16px 20px; }
.ops__advanced > summary { cursor: pointer; font-size: 13.5px; font-weight: 650; color: #0f172a; }
.ops__advanced > summary::marker { color: #94a3b8; }
.ops__advanced[open] > summary { margin-bottom: 12px; }
.ops__advanced-env { margin-top: 14px; display: grid; gap: 6px; }
.ops__advanced-env p { margin: 0; }
.ops__modal-card--wizard { width: min(780px, 100%); }
.ops__ai-key-row { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 14px; align-items: end; }
.ops__ai-key-input input { font-size: 14px; }
.ops__ai-endpoint { display: grid; gap: 4px; padding: 9px 11px; border-radius: 10px; background: #f8fafc; border: 1px solid #e2e8f0; min-width: 0; }
.ops__ai-endpoint span { font-size: 11px; color: #64748b; }
.ops__ai-endpoint code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #334155; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ops__advanced-toggle { border: 1px solid #e2e8f0; border-radius: 12px; padding: 10px 12px; }
.ops__advanced-toggle > summary { cursor: pointer; font-size: 12.5px; color: #64748b; }
.ops__advanced-toggle[open] > summary { margin-bottom: 10px; }
.ops__advanced-toggle .ops__form-grid { margin-bottom: 10px; }
.ops__probe-panel { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ops__model-picker { display: grid; gap: 8px; border-top: 1px solid #f1f5f9; padding-top: 14px; }
.ops__model-picker h3 { margin: 0; font-size: 14px; color: #0f172a; }
.ops__model-picker p { margin: 0; }
.ops__model-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; max-height: 260px; overflow: auto; padding-right: 4px; }
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
  .ops__ai-hero { flex-direction: column; padding: 18px; }
  .ops__preset-grid { grid-template-columns: repeat(2, 1fr); }
  .ops__ai-grid { grid-template-columns: 1fr; }
  .ops__ai-key-row { grid-template-columns: 1fr; }
  .ops__model-grid { grid-template-columns: 1fr; }
}
</style>
