<script lang="ts" setup>
/**
 * 设置 → 操作审计（v3.0 ch07 P5b-13 / QW15/QW20）。
 * 游标分页（at+id 复合键）+ 动作/日期筛选 + 已加载内 CSV 导出；筛选条件进 URL，
 * 刷新/分享不丢状态。只显示本人 tenant 审计（服务端按 actorId 过滤）。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

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

onMounted(() => {
  readQuery();
  void load(true);
});
</script>

<template>
  <SettingsShell :subtitle="$t('gainos.audit.subtitle')" :title="$t('gainos.audit.title')">
    <template #actions>
      <button class="au__ghost" type="button" :disabled="entries.length === 0 || exporting" @click="exportCsv">
        {{ exporting ? $t('gainos.audit.exporting') : $t('gainos.audit.exportCsv') }}
      </button>
      <button class="au__ghost" type="button" @click="load(true)">{{ $t('gainos.common.refresh') }}</button>
    </template>

    <form class="au__filters" @submit.prevent="applyFilters">
      <label class="au__field">
        <span>{{ $t('gainos.audit.filterAction') }}</span>
        <input
          v-model="filters.action"
          :placeholder="$t('gainos.audit.filterActionPlaceholder')"
          list="audit-action-options"
          type="text"
        />
        <datalist id="audit-action-options">
          <option v-for="action in KNOWN_ACTIONS" :key="action" :value="action"></option>
        </datalist>
      </label>
      <label class="au__field">
        <span>{{ $t('gainos.audit.filterFrom') }}</span>
        <input v-model="filters.from" type="date" />
      </label>
      <label class="au__field">
        <span>{{ $t('gainos.audit.filterTo') }}</span>
        <input v-model="filters.to" type="date" />
      </label>
      <div class="au__filter-actions">
        <button class="au__primary" type="submit">{{ $t('gainos.audit.applyFilters') }}</button>
        <button class="au__ghost" type="button" @click="resetFilters">{{ $t('gainos.audit.resetFilters') }}</button>
      </div>
    </form>

    <p v-if="loading" class="au__muted">{{ $t('gainos.common.loading') }}</p>
    <div v-else-if="error" class="au__error" role="alert">
      <h2>{{ error.title }}</h2>
      <p v-if="error.next">{{ error.next }}</p>
      <button class="au__ghost" type="button" @click="load(true)">{{ $t('gainos.common.retry') }}</button>
    </div>
    <section v-else class="au__card">
      <div class="au__meta">
        <span>{{ loadedLabel }}</span>
      </div>
      <table class="au__table">
        <thead>
          <tr><th>{{ $t('gainos.audit.time') }}</th><th>{{ $t('gainos.audit.action') }}</th><th>{{ $t('gainos.audit.target') }}</th><th>{{ $t('gainos.audit.detail') }}</th></tr>
        </thead>
        <tbody>
          <tr v-for="entry in entries" :key="entry.id">
            <td>{{ fmtTime(entry.at) }}</td>
            <td><code>{{ actionLabel(entry.action) }}</code></td>
            <td :title="entry.target || ''">{{ shortTarget(entry.target) }}</td>
            <td class="au__detail">{{ fmtDetail(entry.detail) }}</td>
          </tr>
          <tr v-if="entries.length === 0"><td colspan="4" class="au__muted">{{ $t('gainos.audit.empty') }}</td></tr>
        </tbody>
      </table>
      <p v-if="nextCursor" class="au__more">
        <button type="button" :disabled="loadingMore" @click="load(false)">
          {{ loadingMore ? $t('gainos.common.loading') : $t('gainos.audit.loadMore') }}
        </button>
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
.au__field input {
  border: 1px solid var(--gs-border-strong);
  border-radius: 8px;
  padding: 7px 10px;
  font: inherit;
  font-size: 13px;
  background: var(--gs-surface);
  color: var(--gs-fg-2);
  min-width: 170px;
}
.au__filter-actions {
  display: flex;
  gap: 8px;
}
.au__primary,
.au__ghost {
  border-radius: 9px;
  padding: 7px 14px;
  font-size: 12.5px;
  cursor: pointer;
}
.au__primary {
  border: none;
  background: var(--gs-accent-cta);
  color: var(--gs-accent-cta-fg);
  font-weight: 600;
}
.au__ghost {
  border: 1px solid var(--gs-border-strong);
  background: var(--gs-surface);
  color: var(--gs-fg-2);
}
.au__meta {
  display: flex;
  justify-content: space-between;
  padding: 10px 14px;
  font-size: 12px;
  color: var(--gs-fg-subtle);
  border-bottom: 1px solid var(--gs-border);
}
.au__muted { color: var(--gs-fg-subtle); font-size: 12.5px; }
.au__error { border: 1px solid var(--gs-warn); background: var(--gs-warn-bg); border-radius: 10px; padding: 12px 14px; display: grid; gap: 8px; }
.au__error h2 { margin: 0; font-size: 14px; color: var(--gs-warn); }
.au__error p { margin: 0; font-size: 12.5px; color: var(--gs-fg-2); }
.au__error button { justify-self: start; }
.au__card { background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px; overflow: auto; }
.au__table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.au__table th, .au__table td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--gs-border); vertical-align: top; }
.au__table th { color: var(--gs-fg-muted); font-weight: 600; background: var(--gs-surface-2); white-space: nowrap; }
.au__table tr:last-child td { border-bottom: 0; }
.au__table code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
.au__detail { max-width: 420px; word-break: break-all; color: var(--gs-fg-muted); }
.au__more { margin: 0; padding: 10px 14px; text-align: right; border-top: 1px solid var(--gs-border); }
.au__more button { border: 1px solid var(--gs-border-strong); background: var(--gs-surface); border-radius: 8px; padding: 6px 14px; cursor: pointer; color: var(--gs-fg-2); }
</style>
