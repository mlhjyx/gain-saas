<script lang="ts" setup>
import { onMounted, ref } from 'vue';

import { $t } from '#/locales';

import { failureText, gainosApi, type AuditEntry } from '#/api/gainos';

defineOptions({ name: 'SettingsAudit' });

const entries = ref<AuditEntry[]>([]);
const loading = ref(true);
const error = ref<{ title: string; next?: string } | null>(null);

function fmtTime(value: string): string {
  return value ? new Date(value).toLocaleString() : '—';
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

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const data = await gainosApi.audit(200);
    entries.value = data.entries ?? [];
  } catch (err) {
    error.value = failureText(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="au">
    <header class="au__head">
      <div>
        <h1>{{ $t('gainos.audit.title') }}</h1>
        <p>{{ $t('gainos.audit.subtitle') }}</p>
      </div>
      <button class="au__refresh" type="button" @click="load">{{ $t('gainos.common.refresh') }}</button>
    </header>

    <p v-if="loading" class="au__muted">{{ $t('gainos.common.loading') }}</p>
    <div v-else-if="error" class="au__error" role="alert">
      <h2>{{ error.title }}</h2>
      <p v-if="error.next">{{ error.next }}</p>
    </div>
    <section v-else class="au__card">
      <table class="au__table">
        <thead>
          <tr><th>{{ $t('gainos.audit.time') }}</th><th>{{ $t('gainos.audit.action') }}</th><th>{{ $t('gainos.audit.target') }}</th><th>{{ $t('gainos.audit.detail') }}</th></tr>
        </thead>
        <tbody>
          <tr v-for="entry in entries" :key="entry.id">
            <td>{{ fmtTime(entry.at) }}</td>
            <td><code>{{ entry.action }}</code></td>
            <td>{{ entry.target || '—' }}</td>
            <td class="au__detail">{{ fmtDetail(entry.detail) }}</td>
          </tr>
          <tr v-if="entries.length === 0"><td colspan="4" class="au__muted">{{ $t('gainos.audit.empty') }}</td></tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<style scoped>
.au {
  padding: clamp(18px, 2.4vw, 32px) clamp(18px, 2.4vw, 34px) clamp(32px, 4vh, 48px);
  max-width: 1280px; margin: 0 auto; display: grid; gap: 16px;
}
.au__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.au__head h1 { margin: 0; font-size: 22px; color: var(--gs-fg); }
.au__head p { margin: 6px 0 0; font-size: 13px; color: var(--gs-fg-muted); line-height: 1.7; max-width: 640px; }
.au__refresh { border: 1px solid var(--gs-border-strong); background: var(--gs-surface); border-radius: 9px; padding: 7px 14px; font-size: 12.5px; cursor: pointer; }
.au__muted { color: var(--gs-fg-subtle); font-size: 12.5px; }
.au__error { border: 1px solid var(--gs-warn); background: var(--gs-warn-bg); border-radius: 10px; padding: 12px 14px; }
.au__error h2 { margin: 0; font-size: 14px; color: var(--gs-warn); }
.au__error p { margin: 4px 0 0; font-size: 12.5px; color: var(--gs-fg-2); }
.au__card { background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px; overflow: auto; }
.au__table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.au__table th, .au__table td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--gs-border); vertical-align: top; }
.au__table th { color: var(--gs-fg-muted); font-weight: 600; background: var(--gs-bg-soft, #f8fafc); white-space: nowrap; }
.au__table tr:last-child td { border-bottom: 0; }
.au__table code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
.au__detail { max-width: 420px; word-break: break-all; color: var(--gs-fg-muted); }
</style>
