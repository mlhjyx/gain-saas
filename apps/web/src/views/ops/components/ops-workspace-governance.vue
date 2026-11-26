<script lang="ts" setup>
import { ref, watch } from 'vue';

import { formatDateTime } from '@gain-saas/shared';

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
    purgeReceipt.value = null;
    return;
  }
  detailLoading.value = true;
  try {
    const [detailRes, purgeRes] = await Promise.all([
      api<{ data: Row }>(`/api/ops/workspaces/${encodeURIComponent(workspaceId)}/detail`),
      api<{ data: Row | null }>(`/api/ops/workspaces/${encodeURIComponent(workspaceId)}/purge`).catch(() => ({
        data: null,
      })),
    ]);
    detail.value = detailRes.data ?? null;
    purgeReceipt.value = purgeRes.data ?? null;
    const quota = detail.value?.storageQuota;
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
  quotaSaving.value = true;
  try {
    await api(`/api/ops/workspaces/${encodeURIComponent(props.selectedWorkspaceId)}/storage-quota`, {
      method: 'PUT',
      body: JSON.stringify({
        maxDocumentsPerWorkspace: Number(quotaForm.value.maxDocumentsPerWorkspace),
        maxDocumentsPerCompany: Number(quotaForm.value.maxDocumentsPerCompany),
        maxBytesPerWorkspace: quotaForm.value.maxBytesPerWorkspace.trim(),
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
  const ok1 = window.confirm(
    `高危操作：确认对工作空间「${wsName}」执行整空间物理清理？\n` +
      '清理会立即吊销全部会话、停用事件游标、清空 gain_saas 租户数据并通知引擎清理数据库与对象存储。',
  );
  if (!ok1) return;
  if (purgeForm.value.force) {
    const ok2 = window.confirm('已勾选 force=true（跳过 7 天离网冷却期），请再次确认是否强制立即物理清理？');
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
      <div v-if="reconcileData" class="ops__muted" data-gs="ops-reconcile-result">
        匹配 {{ reconcileData.matchedCount ?? 0 }} · 仅在 SaaS {{ reconcileData.onlyInSaas?.length ?? 0 }} · 仅在引擎
        {{ reconcileData.onlyInEngine?.length ?? 0 }} · 状态漂移 {{ reconcileData.statusMismatch?.length ?? 0 }} · 缺
        registry {{ reconcileData.registryMissing?.length ?? 0 }}
      </div>
    </article>

    <article v-if="selectedWorkspaceId" class="ops__card ops__card--wide" data-gs="ops-workspace-detail-panel">
      <h3>工作空间治理详情 · {{ detail?.workspace?.name || selectedWorkspaceId }}</h3>
      <p v-if="detailLoading" class="ops__muted">加载治理详情…</p>

      <template v-else-if="detail">
        <p class="ops__muted">
          状态：{{ detail.workspace?.status }} · 成员：{{ detail.saasCounts?.members ?? 0 }} · 活跃会话：
          {{ detail.saasCounts?.activeSessions ?? 0 }} · 引擎资料：{{ detail.engineCounts?.sellerDocuments ?? '—' }}
        </p>

        <div class="ops__toolbar">
          <strong>存储与导出配额</strong>
          <label>空间文档上限 <input v-model.number="quotaForm.maxDocumentsPerWorkspace" type="number" min="1" /></label>
          <label>单公司文档上限 <input v-model.number="quotaForm.maxDocumentsPerCompany" type="number" min="1" /></label>
          <label>空间字节上限 <input v-model="quotaForm.maxBytesPerWorkspace" type="text" /></label>
          <label>每日导出上限 <input v-model.number="quotaForm.maxExportsPerDay" type="number" min="1" /></label>
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

        <hr />

        <div class="ops__stack" data-gs="ops-workspace-purge-section">
          <h4>整空间物理清理（无 PII 回执）</h4>
          <div class="ops__toolbar">
            <label>幂等键 <input v-model="purgeForm.idempotencyKey" type="text" data-gs="ops-purge-key" /></label>
            <label>
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
