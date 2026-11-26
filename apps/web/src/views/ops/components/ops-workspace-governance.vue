<script lang="ts" setup>
import { computed, ref, watch } from 'vue';

import { formatDateTime } from '@gain-saas/shared';

import { feedback } from '#/feedback';

defineOptions({ name: 'OpsWorkspaceGovernance' });

type Row = Record<string, any>;

const props = defineProps<{
  selectedWorkspaceId: string;
}>();

const emit = defineEmits<{
  (e: 'notice', message: string): void;
  (e: 'error', message: string): void;
  (e: 'purged'): void;
}>();

const reconcileData = ref<Row | null>(null);
const reconcileLoading = ref(false);
const detailLoading = ref(false);
const detail = ref<Row | null>(null);
const storageQuotaData = ref<Row | null>(null);
const purgeReceipt = ref<Row | null>(null);
const quotaSaving = ref(false);
const purging = ref(false);

const quotaForm = ref({
  maxDocumentsPerWorkspace: 500,
  maxDocumentsPerCompany: 200,
  maxBytesPerWorkspace: '2147483648',
  maxExportsPerDay: 10,
});

const purgeForm = ref({
  idempotencyKey: '',
  force: false,
});

function confirmDanger(options: {
  title: string;
  content: string;
  okText?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    feedback.confirm({
      title: options.title,
      content: options.content,
      okText: options.okText ?? '确认执行',
      cancelText: '取消',
      okType: 'danger',
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

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

function fmtTime(value?: string | null): string {
  return formatDateTime(value) || '—';
}

function fmtBytes(raw: unknown): string {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** 兼容 PR #215 真实嵌套 summary 与旧 mock 平铺字段。 */
const reconcileSummary = computed(() => {
  const data = reconcileData.value;
  if (!data) return null;
  const s = data.summary ?? {};
  return {
    complete: typeof data.complete === 'boolean' ? data.complete : null,
    warning: typeof data.warning === 'string' ? data.warning : '',
    saasTotal: s.saasTotal ?? null,
    engineTotal: s.engineTotal ?? null,
    matchedCount: s.matchedCount ?? data.matchedCount ?? 0,
    onlyInSaasCount: s.onlyInSaasCount ?? data.onlyInSaas?.length ?? 0,
    onlyInEngineCount: s.onlyInEngineCount ?? data.onlyInEngine?.length ?? 0,
    nameMismatchCount: s.nameMismatchCount ?? data.nameMismatches?.length ?? 0,
    statusMismatchCount: data.statusMismatch?.length ?? 0,
    registryMissingCount: data.registryMissing?.length ?? 0,
    onlyInSaas: Array.isArray(data.onlyInSaas) ? (data.onlyInSaas as Row[]) : [],
    onlyInEngine: Array.isArray(data.onlyInEngine) ? (data.onlyInEngine as Row[]) : [],
    nameMismatches: Array.isArray(data.nameMismatches) ? (data.nameMismatches as Row[]) : [],
  };
});

/** 兼容 PR #215 真实 workspaceDetail（members/activeSessions/engine.sellerDocuments）与旧 mock 字段。 */
const detailSummary = computed(() => {
  const d = detail.value;
  if (!d) return null;
  const membersCount = Array.isArray(d.members) ? d.members.length : (d.saasCounts?.members ?? 0);
  const activeSessions = d.activeSessions ?? d.saasCounts?.activeSessions ?? 0;
  const engineDocs =
    storageQuotaData.value?.usage?.totalDocuments ??
    d.engine?.sellerDocuments?.total ??
    d.engineCounts?.sellerDocuments ??
    null;
  const engineBytes =
    storageQuotaData.value?.usage?.totalBytes ??
    d.engine?.sellerDocuments?.totalBytes ??
    null;
  const pendingUpload =
    storageQuotaData.value?.usage?.pendingUpload ??
    d.engine?.sellerDocuments?.pendingUpload ??
    null;
  const quota = storageQuotaData.value ?? d.storageQuota ?? null;
  return {
    status: d.workspace?.status ?? '—',
    membersCount,
    activeSessions,
    engineDocs,
    engineBytes,
    pendingUpload,
    isDefaultQuota: quota?.isDefault ?? true,
    quotaUpdatedAt: quota?.updatedAt ?? null,
    quotaUpdatedBy: quota?.updatedBy ?? null,
    registry: d.registry ?? null,
  };
});

async function loadReconcile(): Promise<void> {
  reconcileLoading.value = true;
  try {
    const res = await api<{ data: Row }>('/api/ops/reconcile/workspaces');
    reconcileData.value = res.data ?? null;
  } catch (err) {
    emit('error', err instanceof Error ? err.message : String(err));
  } finally {
    reconcileLoading.value = false;
  }
}

async function loadDetail(workspaceId: string): Promise<void> {
  if (!workspaceId) {
    detail.value = null;
    storageQuotaData.value = null;
    purgeReceipt.value = null;
    return;
  }
  detailLoading.value = true;
  try {
    const [detailRes, quotaRes, purgeRes] = await Promise.all([
      api<{ data: Row }>(`/api/ops/workspaces/${encodeURIComponent(workspaceId)}/detail`),
      api<{ data: Row | null }>(`/api/ops/workspaces/${encodeURIComponent(workspaceId)}/storage-quota`).catch(
        () => ({ data: null }),
      ),
      api<{ data: Row | null }>(`/api/ops/workspaces/${encodeURIComponent(workspaceId)}/purge`).catch(() => ({
        data: null,
      })),
    ]);
    detail.value = detailRes.data ?? null;
    storageQuotaData.value = quotaRes.data ?? null;
    purgeReceipt.value = purgeRes.data ?? null;
    const quota = storageQuotaData.value ?? detail.value?.storageQuota;
    if (quota) {
      quotaForm.value = {
        maxDocumentsPerWorkspace: Number(quota.maxDocumentsPerWorkspace ?? 500),
        maxDocumentsPerCompany: Number(quota.maxDocumentsPerCompany ?? 200),
        maxBytesPerWorkspace: String(quota.maxBytesPerWorkspace ?? '2147483648'),
        maxExportsPerDay: Number(quota.maxExportsPerDay ?? 10),
      };
    }
    purgeForm.value = {
      idempotencyKey: `purge-${workspaceId}`,
      force: false,
    };
  } catch (err) {
    emit('error', err instanceof Error ? err.message : String(err));
  } finally {
    detailLoading.value = false;
  }
}

async function saveStorageQuota(): Promise<void> {
  if (!props.selectedWorkspaceId || quotaSaving.value) return;
  const maxBytesRaw = quotaForm.value.maxBytesPerWorkspace.trim();
  if (!/^\d+$/.test(maxBytesRaw) || BigInt(maxBytesRaw) < 1n) {
    emit('error', '空间字节上限必须是正整数');
    return;
  }
  quotaSaving.value = true;
  try {
    await api(`/api/ops/workspaces/${encodeURIComponent(props.selectedWorkspaceId)}/storage-quota`, {
      method: 'PUT',
      body: JSON.stringify({
        maxDocumentsPerWorkspace: Number(quotaForm.value.maxDocumentsPerWorkspace),
        maxDocumentsPerCompany: Number(quotaForm.value.maxDocumentsPerCompany),
        maxBytesPerWorkspace: maxBytesRaw,
        maxExportsPerDay: Number(quotaForm.value.maxExportsPerDay),
      }),
    });
    emit('notice', '工作空间存储与导出配额已更新');
    await loadDetail(props.selectedWorkspaceId);
  } catch (err) {
    emit('error', err instanceof Error ? err.message : String(err));
  } finally {
    quotaSaving.value = false;
  }
}

async function executePurge(): Promise<void> {
  const wsId = props.selectedWorkspaceId;
  if (!wsId || purging.value) return;
  const wsName = detail.value?.workspace?.name || wsId;
  const ok1 = await confirmDanger({
    title: '高危操作：确认整空间物理清理',
    content:
      `确认对工作空间「${wsName}」执行整空间物理清理？` +
      '清理会立即吊销全部会话、停用事件游标、清空 gain_saas 租户数据并通知引擎清理数据库与对象存储。',
    okText: '继续清理',
  });
  if (!ok1) return;
  if (purgeForm.value.force) {
    const ok2 = await confirmDanger({
      title: '二次危险确认（force=true）',
      content: '已勾选 force=true（跳过 7 天离网冷却期），请再次确认是否强制立即物理清理？此操作不可撤销。',
      okText: '强制立即清理',
    });
    if (!ok2) return;
  }
  purging.value = true;
  try {
    const res = await api<{ data: Row }>(`/api/ops/workspaces/${encodeURIComponent(wsId)}/purge`, {
      method: 'POST',
      body: JSON.stringify({
        idempotencyKey: purgeForm.value.idempotencyKey.trim() || `purge-${wsId}`,
        force: purgeForm.value.force,
      }),
    });
    purgeReceipt.value = res.data ?? null;
    emit('notice', `工作空间 ${wsId} 物理清理已提交（回执状态：${purgeReceipt.value?.status ?? 'COMPLETED'}）`);
    emit('purged');
    await loadDetail(wsId);
  } catch (err) {
    emit('error', err instanceof Error ? err.message : String(err));
    await loadDetail(wsId);
  } finally {
    purging.value = false;
  }
}

watch(
  () => props.selectedWorkspaceId,
  (id) => {
    void loadDetail(id);
  },
  { immediate: true },
);
</script>

<template>
  <!-- terms-lint-disable-file: 运营台租户治理面板，供平台运营核对跨库对账、配额与整空间物理清理 -->
  <div class="ops__stack" data-gs="ops-workspace-governance">
    <article class="ops__card ops__card--wide">
      <div class="ops__toolbar">
        <h3>跨库工作空间对账（gain_saas ↔ 引擎）</h3>
        <span
          v-if="reconcileSummary && reconcileSummary.complete !== null"
          class="ops__badge"
          :class="reconcileSummary.complete ? 'is-ok' : 'is-warn'"
        >
          {{ reconcileSummary.complete ? '全集对账' : '部分对账（缺 OWNER 池）' }}
        </span>
        <button
          type="button"
          class="ops__btn"
          :disabled="reconcileLoading"
          data-gs="ops-reconcile-btn"
          @click="loadReconcile"
        >
          {{ reconcileLoading ? '对账中…' : '运行对账检查' }}
        </button>
      </div>
      <div v-if="reconcileSummary" class="ops__stack" data-gs="ops-reconcile-result">
        <p v-if="reconcileSummary.warning" class="ops__warn-note">{{ reconcileSummary.warning }}</p>
        <div class="ops__muted">
          <template v-if="reconcileSummary.saasTotal !== null">
            SaaS {{ reconcileSummary.saasTotal }} · 引擎 {{ reconcileSummary.engineTotal ?? 0 }} ·
          </template>
          匹配 {{ reconcileSummary.matchedCount }} · 仅在 SaaS {{ reconcileSummary.onlyInSaasCount }} · 仅在引擎
          {{ reconcileSummary.onlyInEngineCount }} · 名称漂移 {{ reconcileSummary.nameMismatchCount }}
          <template v-if="reconcileSummary.statusMismatchCount > 0 || reconcileSummary.registryMissingCount > 0">
            · 状态漂移 {{ reconcileSummary.statusMismatchCount }} · 缺 registry {{ reconcileSummary.registryMissingCount }}
          </template>
        </div>
        <div
          v-if="reconcileSummary.onlyInSaas.length > 0 || reconcileSummary.onlyInEngine.length > 0 || reconcileSummary.nameMismatches.length > 0"
          class="ops__table-wrap"
        >
          <table class="ops__table">
            <thead>
              <tr>
                <th>差异类型</th>
                <th>Workspace ID</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in reconcileSummary.onlyInSaas" :key="`saas-${item.id}`">
                <td><span class="ops__badge is-warn">仅在 SaaS</span></td>
                <td><code>{{ item.id }}</code></td>
                <td>{{ item.name }} · {{ item.status }} · 成员 {{ item.memberCount ?? 0 }}</td>
              </tr>
              <tr v-for="item in reconcileSummary.onlyInEngine" :key="`eng-${item.id}`">
                <td><span class="ops__badge is-bad">仅在引擎</span></td>
                <td><code>{{ item.id }}</code></td>
                <td>{{ item.name || '—' }} · 创建于 {{ fmtTime(item.createdAt) }}</td>
              </tr>
              <tr v-for="item in reconcileSummary.nameMismatches" :key="`name-${item.id}`">
                <td><span class="ops__badge is-warn">名称不一致</span></td>
                <td><code>{{ item.id }}</code></td>
                <td>SaaS: {{ item.saasName }} ↔ 引擎: {{ item.engineName }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </article>

    <article v-if="selectedWorkspaceId" class="ops__card ops__card--wide" data-gs="ops-workspace-detail-panel">
      <h3>工作空间治理详情 · {{ detail?.workspace?.name || selectedWorkspaceId }}</h3>
      <p v-if="detailLoading" class="ops__muted">加载治理详情…</p>

      <template v-else-if="detail && detailSummary">
        <p class="ops__muted" data-gs="ops-workspace-usage-summary">
          状态：{{ detailSummary.status }} · 成员：{{ detailSummary.membersCount }} · 活跃会话：
          {{ detailSummary.activeSessions }} · 引擎资料：{{ detailSummary.engineDocs ?? '—' }}
          <template v-if="detailSummary.engineBytes !== null">
            （已用 {{ fmtBytes(detailSummary.engineBytes) }} / 上限 {{ fmtBytes(quotaForm.maxBytesPerWorkspace) }}）
          </template>
          <template v-if="detailSummary.pendingUpload !== null && detailSummary.pendingUpload > 0">
            · 待提交上传 {{ detailSummary.pendingUpload }}
          </template>
        </p>

        <div class="ops__quota-block" data-gs="ops-storage-quota-section">
          <div class="ops__toolbar">
            <strong>存储与导出配额</strong>
            <span class="ops__badge" :class="detailSummary.isDefaultQuota ? 'is-muted' : 'is-ok'">
              {{ detailSummary.isDefaultQuota ? '平台默认配额' : '自定义配额' }}
            </span>
            <span v-if="detailSummary.quotaUpdatedAt" class="ops__muted">
              最近更新：{{ fmtTime(detailSummary.quotaUpdatedAt) }}
            </span>
          </div>
          <div class="ops__toolbar">
            <label class="ops__gov-label">
              <span>空间文档上限</span>
              <input v-model.number="quotaForm.maxDocumentsPerWorkspace" type="number" min="1" data-gs="ops-quota-ws-docs" />
            </label>
            <label class="ops__gov-label">
              <span>单公司文档上限</span>
              <input v-model.number="quotaForm.maxDocumentsPerCompany" type="number" min="1" data-gs="ops-quota-company-docs" />
            </label>
            <label class="ops__gov-label">
              <span>空间字节上限（{{ fmtBytes(quotaForm.maxBytesPerWorkspace) }}）</span>
              <input v-model="quotaForm.maxBytesPerWorkspace" type="text" data-gs="ops-quota-bytes" />
            </label>
            <label class="ops__gov-label">
              <span>每日导出上限</span>
              <input v-model.number="quotaForm.maxExportsPerDay" type="number" min="1" data-gs="ops-quota-exports" />
            </label>
            <button
              type="button"
              class="ops__btn ops__btn--primary"
              :disabled="quotaSaving"
              data-gs="ops-save-quota-btn"
              @click="saveStorageQuota"
            >
              {{ quotaSaving ? '保存中…' : '保存配额' }}
            </button>
          </div>
        </div>

        <hr class="ops__divider" />

        <div class="ops__stack" data-gs="ops-workspace-purge-section">
          <h4 class="ops__subhead">整空间物理清理（无 PII 回执）</h4>
          <div class="ops__toolbar">
            <label class="ops__gov-label">
              <span>幂等键</span>
              <input v-model="purgeForm.idempotencyKey" type="text" data-gs="ops-purge-key" />
            </label>
            <label class="ops__check">
              <input v-model="purgeForm.force" type="checkbox" data-gs="ops-purge-force" />
              force（跳过 7 天冷却期，慎用）
            </label>
            <button
              type="button"
              class="ops__btn ops__btn--danger"
              :disabled="purging"
              data-gs="ops-purge-btn"
              @click="executePurge"
            >
              {{ purging ? '清理中…' : '执行整空间物理清理' }}
            </button>
          </div>

          <div v-if="purgeReceipt" class="ops__muted" data-gs="ops-purge-receipt">
            回执状态：<strong>{{ purgeReceipt.status }}</strong> · 吊销会话：{{ purgeReceipt.revokedSessions }} · 引擎状态：
            {{ purgeReceipt.enginePurgeStatus || '—' }} · 错误码：{{ purgeReceipt.errorCode || '无' }} · 完成时间：
            {{ fmtTime(purgeReceipt.completedAt) }}
          </div>
        </div>
      </template>
    </article>
  </div>
</template>

<style scoped>
.ops__quota-block {
  display: grid;
  gap: 10px;
}
.ops__gov-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--gs-fg-2);
}
.ops__subhead {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--gs-fg);
}
.ops__divider {
  margin: 4px 0;
  border: 0;
  border-top: 1px solid var(--gs-border);
}
.ops__warn-note {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--gs-warn-bg);
  color: var(--gs-warn-fg);
  font-size: 12.5px;
}
</style>
