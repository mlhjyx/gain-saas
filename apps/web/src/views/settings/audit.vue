<script lang="ts" setup>
/**
 * 设置 → 操作审计（v3.0 ch07 P5b-13 / QW15/QW20）。
 * 游标分页（at+id 复合键）+ 动作/日期筛选 + 已加载内 CSV 导出；筛选条件进 URL，
 * 刷新/分享不丢状态。只显示本人 tenant 审计（服务端按 actorId 过滤）。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { Alert, Button, DatePicker, Empty, Input, Table } from 'ant-design-vue';

import { formatDate, formatDateTime } from '@gain-saas/shared';

import SettingsShell from '#/components/gainos/settings-shell.vue';

import { $t } from '#/locales';

import { failureText, gainosApi, type AuditEntry } from '#/api/gainos';

defineOptions({ name: 'SettingsAudit' });

const route = useRoute();
const router = useRouter();

const entries = ref<AuditEntry[]>([]);
const total = ref<number | null>(null);
const nextCursor = ref<null | string>(null);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref<{ title: string; next?: string } | null>(null);

const filters = reactive({ action: '', from: '', to: '' });
const applied = ref({ action: '', from: '', to: '' });
const exporting = ref(false);

const KNOWN_ACTIONS = [
  'auth.login',
  'bff.request',
  'member.invite',
  'role.change',
  'member.remove',
  'outreach.batch.create',
  'outreach.batch.approve',
  'outreach.draft.create',
  'outreach.send',
  'channel.create',
  'channel.probe',
  'deletion.request',
  'claim.approve',
  'claim.reject',
] as const;

const ACTION_LABELS: Record<string, string> = {
  'auth.login': $t('gainos.audit.actionName.login'),
  'bff.request': $t('gainos.audit.actionName.bffRequest'),
  'member.invite': $t('gainos.audit.actionName.memberInvite'),
  'role.change': $t('gainos.audit.actionName.roleChange'),
};

function actionLabel(action?: string | null): string {
  return (action && ACTION_LABELS[action]) || action || '—';
}

function shortTarget(target?: string | null): string {
  if (!target) return '—';
  const uuid = target.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuid) return `${target.replace(uuid[0], `#${uuid[0].slice(0, 8)}`)}`;
  return target;
}

function fmtTime(value: string): string {
  return formatDateTime(value) || '—';
}

function fmtDetail(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** YYYY-MM-DD ↔ dayjs（antd DatePicker 的值类型）。 */
function toDate(value: string): string | undefined {
  return value || undefined;
}

function fromDate(value?: string | null): string {
  return value ?? '';
}

function readQuery(): void {
  const q = route.query;
  filters.action = typeof q.action === 'string' ? q.action : '';
  filters.from = typeof q.from === 'string' ? q.from : '';
  filters.to = typeof q.to === 'string' ? q.to : '';
  applied.value = { action: filters.action, from: filters.from, to: filters.to };
}

function syncQuery(): void {
  const query: Record<string, string> = {};
  if (applied.value.action) query.action = applied.value.action;
  if (applied.value.from) query.from = applied.value.from;
  if (applied.value.to) query.to = applied.value.to;
  void router.replace({ query });
}

async function load(reset = true): Promise<void> {
  if (reset) loading.value = true;
  else loadingMore.value = true;
  error.value = null;
  try {
    const data = await gainosApi.audit({
      ...(applied.value.action ? { action: applied.value.action } : {}),
      ...(applied.value.from ? { from: applied.value.from } : {}),
      ...(applied.value.to ? { to: applied.value.to } : {}),
      ...(reset ? {} : { cursor: nextCursor.value ?? undefined }),
      limit: 100,
    });
    entries.value = reset ? (data.entries ?? []) : [...entries.value, ...(data.entries ?? [])];
    total.value = typeof data.total === 'number' ? data.total : null;
    nextCursor.value = data.nextCursor ?? null;
  } catch (err) {
    error.value = failureText(err);
    if (reset) entries.value = [];
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

function applyFilters(): void {
  applied.value = { action: filters.action.trim(), from: filters.from, to: filters.to };
  syncQuery();
  void load(true);
}

function resetFilters(): void {
  filters.action = '';
  filters.from = '';
  filters.to = '';
  applied.value = { action: '', from: '', to: '' };
  syncQuery();
  void load(true);
}

function exportCsv(): void {
  if (entries.value.length === 0) return;
  exporting.value = true;
  try {
    const escape = (value: string): string => `"${value.replaceAll('"', '""')}"`;
    const rows = [
      [$t('gainos.audit.time'), $t('gainos.audit.action'), $t('gainos.audit.target'), $t('gainos.audit.detail')],
      ...entries.value.map((entry) => [
        fmtTime(entry.at),
        actionLabel(entry.action),
        shortTarget(entry.target),
        fmtDetail(entry.detail),
      ]),
    ];
    const csv = rows.map((row) => row.map(escape).join(',')).join('\r\n');
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `audit-${formatDate(new Date())}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  } finally {
    exporting.value = false;
  }
}

const loadedLabel = computed(() =>
  total.value === null
    ? $t('gainos.audit.loaded', { count: entries.value.length })
    : $t('gainos.audit.totalLoaded', {
        count: total.value,
        loaded: entries.value.length,
      }),
);

const columns = [
  { key: 'at', dataIndex: 'at', title: $t('gainos.audit.time'), width: 170 },
  { key: 'action', dataIndex: 'action', title: $t('gainos.audit.action'), width: 180 },
  { key: 'target', dataIndex: 'target', title: $t('gainos.audit.target'), width: 220 },
  { key: 'detail', dataIndex: 'detail', title: $t('gainos.audit.detail') },
];

onMounted(() => {
  readQuery();
  void load(true);
});
</script>

<template>
  <SettingsShell :subtitle="$t('gainos.audit.subtitle')" :title="$t('gainos.audit.title')">
    <template #actions>
      <Button :disabled="entries.length === 0 || exporting" :loading="exporting" @click="exportCsv">
        {{ exporting ? $t('gainos.audit.exporting') : $t('gainos.audit.exportCsv') }}
      </Button>
      <Button @click="load(true)">{{ $t('gainos.common.refresh') }}</Button>
    </template>

    <form class="au__filters" @submit.prevent="applyFilters">
      <label class="au__field">
        <span>{{ $t('gainos.audit.filterAction') }}</span>
        <Input
          v-model:value="filters.action"
          :list="'audit-action-options'"
          :placeholder="$t('gainos.audit.filterActionPlaceholder')"
          style="min-width: 170px"
        />
        <datalist id="audit-action-options">
          <option v-for="action in KNOWN_ACTIONS" :key="action" :value="action"></option>
        </datalist>
      </label>
      <label class="au__field">
        <span>{{ $t('gainos.audit.filterFrom') }}</span>
        <DatePicker
          :value="toDate(filters.from)"
          value-format="YYYY-MM-DD"
          @update:value="(v) => (filters.from = fromDate(String(v ?? '')))"
        />
      </label>
      <label class="au__field">
        <span>{{ $t('gainos.audit.filterTo') }}</span>
        <DatePicker
          :value="toDate(filters.to)"
          value-format="YYYY-MM-DD"
          @update:value="(v) => (filters.to = fromDate(String(v ?? '')))"
        />
      </label>
      <div class="au__filter-actions">
        <Button type="primary" html-type="submit">{{ $t('gainos.audit.applyFilters') }}</Button>
        <Button @click="resetFilters">{{ $t('gainos.audit.resetFilters') }}</Button>
      </div>
    </form>

    <div v-if="loading" class="au__loading"><i class="au__spinner" aria-hidden="true"></i>{{ $t('gainos.common.loading') }}</div>
    <Alert
      v-else-if="error"
      :message="error.title"
      :description="error.next"
      role="alert"
      show-icon
      type="warning"
    >
      <template #action>
        <Button size="small" @click="load(true)">{{ $t('gainos.common.retry') }}</Button>
      </template>
    </Alert>
    <section v-else class="au__card">
      <div class="au__meta">
        <span>{{ loadedLabel }}</span>
      </div>
      <Empty
        v-if="entries.length === 0"
        :description="$t('gainos.audit.empty')"
        :image="Empty.PRESENTED_IMAGE_SIMPLE"
      />
      <Table
        v-else
        :columns="columns"
        :data-source="entries"
        :pagination="false"
        :scroll="{ x: 760 }"
        row-key="id"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'at'">{{ fmtTime(record.at) }}</template>
          <template v-else-if="column.key === 'action'"><code>{{ actionLabel(record.action) }}</code></template>
          <template v-else-if="column.key === 'target'">
            <span :title="record.target || ''">{{ shortTarget(record.target) }}</span>
          </template>
          <template v-else-if="column.key === 'detail'">
            <span class="au__detail">{{ fmtDetail(record.detail) }}</span>
          </template>
        </template>
      </Table>
      <p v-if="nextCursor" class="au__more">
        <Button :disabled="loadingMore" :loading="loadingMore" size="small" @click="load(false)">
          {{ loadingMore ? $t('gainos.common.loading') : $t('gainos.audit.loadMore') }}
        </Button>
      </p>
    </section>
  </SettingsShell>
</template>

<style scoped>
.au__filters {
  display: flex;
  gap: 12px;
  align-items: flex-end;
  flex-wrap: wrap;
  border: 1px solid var(--gs-border);
  border-radius: 12px;
  background: var(--gs-surface);
  padding: 12px 14px;
}
.au__field {
  display: grid;
  gap: 4px;
  font-size: 12px;
  color: var(--gs-fg-muted);
}
.au__filter-actions {
  display: flex;
  gap: 8px;
}
.au__loading { display: flex; align-items: center; gap: 10px; justify-content: center; padding: 32px; color: var(--gs-fg-subtle); font-size: 13px; background: var(--gs-surface); border: 1px dashed var(--gs-border-dashed); border-radius: 14px; }
.au__spinner {
  width: 16px; height: 16px; border-radius: 50%;
  border: 2px solid var(--gs-border-strong); border-top-color: var(--gs-accent);
  animation: au-spin 0.8s linear infinite;
}
@keyframes au-spin { to { transform: rotate(360deg); } }
.au__meta {
  display: flex;
  justify-content: space-between;
  padding: 10px 14px;
  font-size: 12px;
  color: var(--gs-fg-subtle);
  border-bottom: 1px solid var(--gs-border);
}
.au__card { background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px; overflow: auto; }
.au__detail { word-break: break-all; color: var(--gs-fg-muted); }
.au__more { margin: 0; padding: 10px 14px; text-align: right; border-top: 1px solid var(--gs-border); }
</style>
