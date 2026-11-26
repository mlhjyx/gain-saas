<script lang="ts" setup>
import { computed, ref, watch } from 'vue';

import { Alert, Button, Form } from 'ant-design-vue';

import { formatDateTime } from '@gain-saas/shared';

import {
  failureText,
  gainosApi,
  type DataExportFormat,
  type DataExportJobView,
  type DataExportScope,
} from '#/api/gainos';
import GsCard from '#/components/gainos/ui/gs-card.vue';
import GsEmpty from '#/components/gainos/ui/gs-empty.vue';
import GsSelect from '#/components/gainos/ui/gs-select.vue';
import GsTable from '#/components/gainos/ui/gs-table.vue';
import GsTag from '#/components/gainos/ui/gs-tag.vue';
import { feedback } from '#/feedback';
import { $t } from '#/locales';

defineOptions({ name: 'DataExportsCard' });

const props = defineProps<{
  isAdmin: boolean;
}>();

const form = ref<{ format: DataExportFormat; scope: DataExportScope }>({
  format: 'csv',
  scope: 'leads',
});

const jobs = ref<DataExportJobView[]>([]);
const nextCursor = ref<string | null>(null);
const hasMore = ref(false);
const statusFilter = ref<string>('ALL');
const loading = ref(false);
const loadingMore = ref(false);
const creating = ref(false);
const downloadingId = ref<string | null>(null);
const errorBox = ref<{ next?: string; title: string } | null>(null);
const notice = ref<string | null>(null);

const scopeOptions = computed(() => [
  { label: $t('gainos.privacy.exports.scopeLeads'), value: 'leads' },
  { label: $t('gainos.privacy.exports.scopeCompanies'), value: 'companies' },
  { label: $t('gainos.privacy.exports.scopeContacts'), value: 'contacts' },
  { label: $t('gainos.privacy.exports.scopeOutreach'), value: 'outreach' },
  { label: $t('gainos.privacy.exports.scopeFullArchive'), value: 'full_archive' },
]);

const formatOptions = computed(() => [
  { label: $t('gainos.privacy.exports.formatCsv'), value: 'csv' },
  { label: $t('gainos.privacy.exports.formatJsonl'), value: 'jsonl' },
]);

const statusFilterOptions = computed(() => [
  { label: $t('gainos.privacy.exports.statusAll'), value: 'ALL' },
  { label: $t('gainos.privacy.exports.statusPending'), value: 'pending' },
  { label: $t('gainos.privacy.exports.statusProcessing'), value: 'processing' },
  { label: $t('gainos.privacy.exports.statusReady'), value: 'ready' },
  { label: $t('gainos.privacy.exports.statusFailed'), value: 'failed' },
  { label: $t('gainos.privacy.exports.statusExpired'), value: 'expired' },
]);

const columns = computed(() => [
  { dataIndex: 'id', key: 'id', title: $t('gainos.privacy.exports.colId'), width: 120 },
  { dataIndex: 'scope', key: 'scope', title: $t('gainos.privacy.exports.colScope'), width: 190 },
  { dataIndex: 'status', key: 'status', title: $t('gainos.privacy.exports.colStatus'), width: 120 },
  { dataIndex: 'size', key: 'size', title: $t('gainos.privacy.exports.colSize'), width: 160 },
  { dataIndex: 'expiresAt', key: 'expiresAt', title: $t('gainos.privacy.exports.colExpires'), width: 170 },
  { dataIndex: 'action', key: 'action', title: $t('gainos.privacy.exports.colAction'), width: 130 },
]);

function shortId(id: string): string {
  return `#${id.slice(0, 8)}`;
}

function scopeLabel(scope?: string): string {
  if (scope === 'leads') return $t('gainos.privacy.exports.scopeLeads');
  if (scope === 'companies') return $t('gainos.privacy.exports.scopeCompanies');
  if (scope === 'contacts') return $t('gainos.privacy.exports.scopeContacts');
  if (scope === 'outreach') return $t('gainos.privacy.exports.scopeOutreach');
  if (scope === 'full_archive') return $t('gainos.privacy.exports.scopeFullArchive');
  return '—';
}

function formatLabel(format?: string): string {
  if (format === 'csv') return $t('gainos.privacy.exports.formatCsv');
  if (format === 'jsonl') return $t('gainos.privacy.exports.formatJsonl');
  return '—';
}

function statusLabel(status?: string): string {
  if (status === 'pending') return $t('gainos.privacy.exports.statusPending');
  if (status === 'processing') return $t('gainos.privacy.exports.statusProcessing');
  if (status === 'ready') return $t('gainos.privacy.exports.statusReady');
  if (status === 'failed') return $t('gainos.privacy.exports.statusFailed');
  if (status === 'expired') return $t('gainos.privacy.exports.statusExpired');
  return '—';
}

function statusTone(status?: string): 'danger' | 'info' | 'neutral' | 'success' | 'warning' {
  if (status === 'ready') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'processing') return 'warning';
  if (status === 'pending') return 'info';
  return 'neutral';
}

function formatBytes(bytes?: number | null): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtTime(value?: string | null): string {
  return formatDateTime(value) || '—';
}

async function loadExports(reset = true): Promise<void> {
  if (!props.isAdmin) return;
  if (reset) {
    loading.value = true;
  } else {
    loadingMore.value = true;
  }
  errorBox.value = null;
  try {
    const res = await gainosApi.dataExports({
      limit: 20,
      ...(statusFilter.value !== 'ALL' ? { status: statusFilter.value } : {}),
      ...(!reset && nextCursor.value ? { cursor: nextCursor.value } : {}),
    });
    const rows = Array.isArray(res?.data) ? res.data : [];
    if (reset) {
      jobs.value = rows;
    } else {
      const seen = new Set(jobs.value.map((item) => item.id));
      jobs.value = [...jobs.value, ...rows.filter((item) => !seen.has(item.id))];
    }
    nextCursor.value = res?.page?.next_cursor ?? null;
    hasMore.value = Boolean(res?.page?.has_more && res?.page?.next_cursor);
  } catch (err) {
    errorBox.value = failureText(err);
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

function onStatusFilterChange(): void {
  nextCursor.value = null;
  hasMore.value = false;
  void loadExports(true);
}

async function createExport(): Promise<void> {
  if (!props.isAdmin || creating.value) return;
  creating.value = true;
  errorBox.value = null;
  notice.value = null;
  try {
    const created = await gainosApi.createDataExport({
      format: form.value.format,
      scope: form.value.scope,
    });
    const msg = $t('gainos.privacy.exports.created', { id: created.id.slice(0, 8) });
    notice.value = msg;
    feedback.message.success(msg);
    await loadExports(true);
  } catch (err) {
    errorBox.value = failureText(err);
  } finally {
    creating.value = false;
  }
}

async function downloadExport(job: DataExportJobView): Promise<void> {
  if (downloadingId.value) return;
  downloadingId.value = job.id;
  errorBox.value = null;
  try {
    const filename = await gainosApi.downloadDataExport(job.id, job.filename);
    const msg = $t('gainos.privacy.exports.downloaded', { filename });
    notice.value = msg;
    feedback.message.success(msg);
  } catch (err) {
    errorBox.value = failureText(err);
  } finally {
    downloadingId.value = null;
  }
}

watch(
  () => props.isAdmin,
  (admin) => {
    if (admin) {
      void loadExports(true);
    }
  },
  { immediate: true },
);
</script>

<template>
  <GsCard :title="$t('gainos.privacy.exports.title')" data-gs="data-exports-card">
    <template #extra>
      <div v-if="isAdmin" class="flex flex-wrap items-center gap-2">
        <div class="w-[150px]" data-gs="data-exports-status-filter">
          <GsSelect
            v-model="statusFilter"
            :aria-label="$t('gainos.privacy.exports.statusFilterLabel')"
            :options="statusFilterOptions"
            @change="onStatusFilterChange"
          />
        </div>
        <Button :disabled="loading" :loading="loading" data-gs="data-exports-refresh" @click="loadExports(true)">
          {{ $t('gainos.common.refresh') }}
        </Button>
      </div>
    </template>

    <div class="grid gap-3">
      <p class="m-0 text-sm text-[var(--gs-fg-muted)]">{{ $t('gainos.privacy.exports.desc') }}</p>

      <Alert
        v-if="!isAdmin"
        :message="$t('gainos.privacy.exports.adminOnly')"
        data-gs="data-exports-admin-only"
        show-icon
        type="info"
      />

      <template v-else>
        <Alert v-if="notice" :message="notice" closable role="status" show-icon type="success" @close="notice = null" />
        <Alert v-if="errorBox" role="alert" show-icon type="warning">
          <template #message>{{ errorBox.title }}</template>
          <template v-if="errorBox.next" #description>{{ errorBox.next }}</template>
        </Alert>

        <div class="grid grid-cols-1 gap-3 rounded-xl border border-[var(--gs-border)] bg-[var(--gs-surface-2)] p-4 @min-[680px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] @min-[680px]:items-end">
          <Form.Item :label="$t('gainos.privacy.exports.scopeLabel')" class="mb-0">
            <div data-gs="data-exports-scope">
              <GsSelect
                v-model="form.scope"
                :aria-label="$t('gainos.privacy.exports.scopeLabel')"
                :options="scopeOptions"
              />
            </div>
          </Form.Item>
          <Form.Item :label="$t('gainos.privacy.exports.formatLabel')" class="mb-0">
            <div data-gs="data-exports-format">
              <GsSelect
                v-model="form.format"
                :aria-label="$t('gainos.privacy.exports.formatLabel')"
                :options="formatOptions"
              />
            </div>
          </Form.Item>
          <Button
            :disabled="creating"
            :loading="creating"
            data-gs="data-exports-submit"
            type="primary"
            @click="createExport"
          >
            {{ creating ? $t('gainos.privacy.exports.creating') : $t('gainos.privacy.exports.createBtn') }}
          </Button>
        </div>

        <GsEmpty v-if="!loading && jobs.length === 0" :title="$t('gainos.privacy.exports.empty')" simple />
        <GsTable
          v-else
          :columns="columns"
          :data-source="jobs"
          :loading="loading"
          :scroll="{ x: 760 }"
          row-key="id"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'id'">
              <span class="font-mono text-xs text-[var(--gs-fg-2)]" :title="record.id">{{ shortId(record.id) }}</span>
            </template>
            <template v-else-if="column.key === 'scope'">
              <div class="text-xs font-medium text-[var(--gs-fg)]">{{ scopeLabel(record.scope) }}</div>
              <div class="text-xs text-[var(--gs-fg-subtle)]">{{ formatLabel(record.format) }}</div>
            </template>
            <template v-else-if="column.key === 'status'">
              <GsTag :tone="statusTone(record.status)">{{ statusLabel(record.status) }}</GsTag>
            </template>
            <template v-else-if="column.key === 'size'">
              <div class="text-xs text-[var(--gs-fg-muted)]">{{ formatBytes(record.byteSize) }}</div>
              <div v-if="record.rowCount !== null && record.rowCount !== undefined" class="text-xs text-[var(--gs-fg-subtle)]">
                {{ $t('gainos.privacy.exports.rowsCount', { rows: record.rowCount }) }}
              </div>
            </template>
            <template v-else-if="column.key === 'expiresAt'">
              <span class="text-xs text-[var(--gs-fg-muted)]">{{ fmtTime(record.expiresAt ?? record.createdAt) }}</span>
            </template>
            <template v-else-if="column.key === 'action'">
              <Button
                v-if="record.status === 'ready'"
                :data-gs="`data-export-download-${record.id.slice(0, 8)}`"
                :disabled="downloadingId !== null"
                :loading="downloadingId === record.id"
                size="small"
                type="primary"
                @click="downloadExport(record)"
              >
                {{
                  downloadingId === record.id
                    ? $t('gainos.privacy.exports.downloading')
                    : $t('gainos.privacy.exports.downloadBtn')
                }}
              </Button>
              <span v-else class="text-xs text-[var(--gs-fg-subtle)]">—</span>
            </template>
          </template>
        </GsTable>

        <Button
          v-if="hasMore"
          :loading="loadingMore"
          block
          data-gs="data-exports-load-more"
          @click="loadExports(false)"
        >
          {{ $t('gainos.privacy.exports.loadMore') }}
        </Button>
        <p class="m-0 text-xs leading-relaxed text-[var(--gs-fg-subtle)]">{{ $t('gainos.privacy.exports.note') }}</p>
      </template>
    </div>
  </GsCard>
</template>
