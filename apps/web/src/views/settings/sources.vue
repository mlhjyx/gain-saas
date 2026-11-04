<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue';

import { $t } from '#/locales';

import {
  failureText,
  gainosApi,
  type AvailableChannelView,
  type ImportPreviewView,
  type ImportResultView,
  type SourceChannelView,
} from '#/api/gainos';

defineOptions({ name: 'SettingsSources' });

interface Notice {
  tone: 'ok' | 'warn';
  text: string;
}

const loading = ref(true);
const error = ref<{ title: string; next?: string } | null>(null);
const notice = ref<Notice | null>(null);

const available = ref<AvailableChannelView[]>([]);
const registry = ref<SourceChannelView[]>([]);
const busyChannel = ref<string | null>(null);

const CATEGORY_KEYS = ['trade_fair', 'customs', 'association', 'directory', 'tender', 'other'] as const;

const createForm = ref({ name: '', category: 'customs' as string });
const creating = ref(false);

const csvText = ref('');
const headers = ref<string[]>([]);
const mapping = ref<{ name: string; website: string; country: string; industry: string }>({
  name: '',
  website: '',
  country: '',
  industry: '',
});
const preview = ref<ImportPreviewView | null>(null);
const result = ref<ImportResultView | null>(null);
const importBusy = ref<'preview' | 'commit' | null>(null);
const importError = ref<{ title: string; next?: string } | null>(null);

const canPreview = computed(() => csvText.value.length > 0 && mapping.value.name !== '');

function categoryLabel(category: string): string {
  const key = `gainos.sources.category.${category}`;
  const value = $t(key);
  return value === key ? category : value;
}

function modeLabel(mode: string): string {
  const key = `gainos.sources.mode.${mode}`;
  const value = $t(key);
  return value === key ? mode : value;
}

function statusLabel(status: string): string {
  const key = `gainos.sources.status.${status}`;
  const value = $t(key);
  return value === key ? status : value;
}

function fmtTime(value?: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const [availableRows, registryRows] = await Promise.all([
      gainosApi.availableChannels(),
      gainosApi.sourceChannels(),
    ]);
    available.value = availableRows;
    registry.value = registryRows;
  } catch (err) {
    error.value = failureText(err);
  } finally {
    loading.value = false;
  }
}

async function toggleChannel(channel: AvailableChannelView): Promise<void> {
  busyChannel.value = channel.id;
  notice.value = null;
  try {
    if (channel.enabled) {
      await gainosApi.disableChannel(channel.id);
      notice.value = { tone: 'ok', text: $t('gainos.sources.disabledNotice', { name: channel.name }) };
    } else {
      await gainosApi.enableChannel(channel.id);
      notice.value = { tone: 'ok', text: $t('gainos.sources.enabledNotice', { name: channel.name }) };
    }
    await load();
  } catch (err) {
    notice.value = { tone: 'warn', text: failureText(err).title };
  } finally {
    busyChannel.value = null;
  }
}

async function previewCrawl(channel: AvailableChannelView): Promise<void> {
  busyChannel.value = channel.id;
  notice.value = null;
  try {
    await gainosApi.previewChannelCrawl(channel.id);
    notice.value = { tone: 'ok', text: $t('gainos.sources.crawlPreviewOk', { name: channel.name }) };
  } catch (err) {
    notice.value = { tone: 'warn', text: failureText(err).title };
  } finally {
    busyChannel.value = null;
  }
}

async function createImportChannel(): Promise<void> {
  if (!createForm.value.name.trim() || creating.value) return;
  creating.value = true;
  notice.value = null;
  try {
    await gainosApi.createImportChannel({
      name: createForm.value.name.trim(),
      category: createForm.value.category,
    });
    createForm.value.name = '';
    notice.value = { tone: 'ok', text: $t('gainos.sources.channelCreated') };
    await load();
  } catch (err) {
    notice.value = { tone: 'warn', text: failureText(err).title };
  } finally {
    creating.value = false;
  }
}

function resetImport(): void {
  preview.value = null;
  result.value = null;
  importError.value = null;
}

function guessHeader(patterns: string[]): string {
  const found = headers.value.find((header) =>
    patterns.some((pattern) => header.toLowerCase().includes(pattern)),
  );
  return found ?? '';
}

function autoGuessMapping(): void {
  mapping.value = {
    name: guessHeader(['company', 'name', '公司', '企业']),
    website: guessHeader(['website', 'site', 'url', '网站', '官网']),
    country: guessHeader(['country', '国家']),
    industry: guessHeader(['industry', '行业']),
  };
}

async function onFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  resetImport();
  csvText.value = await file.text();
  const firstLine = csvText.value.replace(/^\uFEFF/u, '').split(/\r?\n/u)[0] ?? '';
  const delimiter = (firstLine.match(/;/gu) ?? []).length > (firstLine.match(/,/gu) ?? []).length ? ';' : ',';
  headers.value = firstLine.split(delimiter).map((value) => value.trim()).filter(Boolean);
  autoGuessMapping();
  input.value = '';
}

async function doPreview(): Promise<void> {
  if (!canPreview.value) return;
  importBusy.value = 'preview';
  importError.value = null;
  result.value = null;
  try {
    preview.value = await gainosApi.previewImport({
      csv: csvText.value,
      mapping: {
        name: mapping.value.name,
        ...(mapping.value.website ? { website: mapping.value.website } : {}),
        ...(mapping.value.country ? { country: mapping.value.country } : {}),
        ...(mapping.value.industry ? { industry: mapping.value.industry } : {}),
      },
    });
  } catch (err) {
    importError.value = failureText(err);
    preview.value = null;
  } finally {
    importBusy.value = null;
  }
}

async function doCommit(): Promise<void> {
  if (!canPreview.value) return;
  importBusy.value = 'commit';
  importError.value = null;
  try {
    result.value = await gainosApi.commitImport({
      csv: csvText.value,
      mapping: {
        name: mapping.value.name,
        ...(mapping.value.website ? { website: mapping.value.website } : {}),
        ...(mapping.value.country ? { country: mapping.value.country } : {}),
        ...(mapping.value.industry ? { industry: mapping.value.industry } : {}),
      },
    });
    preview.value = null;
    notice.value = {
      tone: 'ok',
      text: $t('gainos.sources.importDone', { count: result.value.materialized }),
    };
  } catch (err) {
    importError.value = failureText(err);
  } finally {
    importBusy.value = null;
  }
}

async function downloadTemplate(): Promise<void> {
  try {
    const { csv } = await gainosApi.importTemplate();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'import-sample.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    notice.value = { tone: 'warn', text: failureText(err).title };
  }
}

onMounted(load);
</script>

<template>
  <div class="src">
    <header class="src__head">
      <div>
        <h1>{{ $t('gainos.sources.title') }}</h1>
        <p class="src__muted">{{ $t('gainos.sources.subtitle') }}</p>
      </div>
      <button class="src__action" type="button" @click="load">{{ $t('gainos.common.refresh') }}</button>
    </header>

    <p v-if="notice" class="src__notice" :class="`is-${notice.tone}`">{{ notice.text }}</p>
    <p v-if="loading" class="src__muted">{{ $t('gainos.common.loading') }}</p>
    <div v-else-if="error" class="src__error" role="alert">
      <h2>{{ error.title }}</h2>
      <p v-if="error.next">{{ error.next }}</p>
    </div>

    <template v-else>
      <section class="src__card">
        <h2>{{ $t('gainos.sources.availableTitle') }}</h2>
        <p class="src__muted">{{ $t('gainos.sources.availableDesc') }}</p>
        <ul v-if="available.length" class="src__list">
          <li v-for="channel in available" :key="channel.id" class="src__row">
            <div class="src__row-main">
              <strong>{{ channel.name }}</strong>
              <span class="src__muted">{{ categoryLabel(channel.category) }} · {{ modeLabel(channel.mode) }}</span>
            </div>
            <div class="src__row-actions">
              <button
                v-if="channel.mode === 'crawl'"
                class="src__action"
                type="button"
                :disabled="busyChannel === channel.id"
                @click="previewCrawl(channel)"
              >
                {{ $t('gainos.sources.trial') }}
              </button>
              <button
                class="src__action"
                :class="{ 'src__action--on': channel.enabled }"
                type="button"
                :disabled="busyChannel === channel.id"
                @click="toggleChannel(channel)"
              >
                {{ channel.enabled ? $t('gainos.sources.enabled') : $t('gainos.sources.enable') }}
              </button>
            </div>
          </li>
        </ul>
        <p v-else class="src__muted">{{ $t('gainos.sources.availableEmpty') }}</p>
        <p class="src__muted">{{ $t('gainos.sources.crawlGateNote') }}</p>
      </section>

      <section class="src__card">
        <h2>{{ $t('gainos.sources.importTitle') }}</h2>
        <p class="src__muted">{{ $t('gainos.sources.importDesc') }}</p>
        <div class="src__import-actions">
          <label class="src__file">
            <input type="file" accept=".csv,text/csv" @change="onFile" />
            <span>{{ $t('gainos.sources.chooseFile') }}</span>
          </label>
          <button class="src__action" type="button" @click="downloadTemplate">{{ $t('gainos.sources.downloadTemplate') }}</button>
        </div>

        <div v-if="headers.length" class="src__mapping">
          <label class="src__field">
            <span>{{ $t('gainos.sources.mapName') }} *</span>
            <select v-model="mapping.name">
              <option value="">—</option>
              <option v-for="header in headers" :key="header" :value="header">{{ header }}</option>
            </select>
          </label>
          <label class="src__field">
            <span>{{ $t('gainos.sources.mapWebsite') }}</span>
            <select v-model="mapping.website">
              <option value="">—</option>
              <option v-for="header in headers" :key="header" :value="header">{{ header }}</option>
            </select>
          </label>
          <label class="src__field">
            <span>{{ $t('gainos.sources.mapCountry') }}</span>
            <select v-model="mapping.country">
              <option value="">—</option>
              <option v-for="header in headers" :key="header" :value="header">{{ header }}</option>
            </select>
          </label>
          <label class="src__field">
            <span>{{ $t('gainos.sources.mapIndustry') }}</span>
            <select v-model="mapping.industry">
              <option value="">—</option>
              <option v-for="header in headers" :key="header" :value="header">{{ header }}</option>
            </select>
          </label>
        </div>

        <p v-if="importError" class="src__error-text" role="alert">{{ importError.title }}<span v-if="importError.next"> · {{ importError.next }}</span></p>

        <div v-if="headers.length" class="src__import-actions">
          <button class="src__action" type="button" :disabled="!canPreview || importBusy !== null" @click="doPreview">
            {{ importBusy === 'preview' ? $t('gainos.common.loading') : $t('gainos.sources.preview') }}
          </button>
          <button class="src__action src__action--on" type="button" :disabled="!canPreview || importBusy !== null" @click="doCommit">
            {{ importBusy === 'commit' ? $t('gainos.common.loading') : $t('gainos.sources.commit') }}
          </button>
        </div>

        <div v-if="preview" class="src__preview">
          <p class="src__muted">
            {{ $t('gainos.sources.previewSummary', {
              total: preview.totalRows,
              valid: preview.validRows,
              duplicate: preview.preview.duplicate,
              suppressed: preview.preview.suppressed,
              invalid: preview.invalidCount,
            }) }}
          </p>
          <table class="src__table">
            <thead><tr><th>#</th><th>{{ $t('gainos.sources.mapName') }}</th><th>{{ $t('gainos.sources.mapWebsite') }}</th><th>{{ $t('gainos.sources.mapCountry') }}</th></tr></thead>
            <tbody>
              <tr v-for="row in preview.sample" :key="row.rowNumber">
                <td>{{ row.rowNumber }}</td>
                <td>{{ row.name }}</td>
                <td>{{ row.domain ?? '—' }}</td>
                <td>{{ row.country ?? '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <p v-if="result" class="src__muted">
          {{ $t('gainos.sources.importResult', {
            batch: result.batchId,
            total: result.totalRows,
            materialized: result.materialized,
            duplicate: result.duplicates,
            suppressed: result.suppressed,
            invalid: result.invalidCount,
          }) }}
        </p>
      </section>

      <section class="src__card">
        <h2>{{ $t('gainos.sources.registryTitle') }}</h2>
        <p class="src__muted">{{ $t('gainos.sources.registryDesc') }}</p>
        <table class="src__table">
          <thead>
            <tr>
              <th>{{ $t('gainos.sources.colName') }}</th>
              <th>{{ $t('gainos.sources.colMode') }}</th>
              <th>{{ $t('gainos.sources.colStatus') }}</th>
              <th>{{ $t('gainos.sources.colFailure') }}</th>
              <th>{{ $t('gainos.sources.colLastRun') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="channel in registry" :key="channel.id">
              <td>{{ channel.name }}</td>
              <td>{{ modeLabel(channel.mode) }}</td>
              <td>{{ statusLabel(channel.status) }}</td>
              <td>{{ channel.failureStreak }}</td>
              <td>{{ fmtTime(channel.lastRunAt) }}</td>
            </tr>
            <tr v-if="registry.length === 0"><td colspan="5" class="src__muted">{{ $t('gainos.sources.registryEmpty') }}</td></tr>
          </tbody>
        </table>

        <div class="src__create">
          <h3>{{ $t('gainos.sources.createChannelTitle') }}</h3>
          <p class="src__muted">{{ $t('gainos.sources.createChannelDesc') }}</p>
          <div class="src__import-actions">
            <input v-model="createForm.name" class="src__input" :placeholder="$t('gainos.sources.channelName')" maxlength="200" />
            <select v-model="createForm.category" class="src__input">
              <option v-for="category in CATEGORY_KEYS" :key="category" :value="category">{{ categoryLabel(category) }}</option>
            </select>
            <button class="src__action src__action--on" type="button" :disabled="creating || !createForm.name.trim()" @click="createImportChannel">
              {{ creating ? $t('gainos.common.loading') : $t('gainos.sources.createChannel') }}
            </button>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.src { padding: clamp(18px, 2.4vw, 32px); max-width: 1040px; margin: 0 auto; display: grid; gap: 16px; }
.src__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.src__head h1 { margin: 0; font-size: 22px; font-weight: 700; color: var(--gs-fg); }
.src__muted { margin: 0; font-size: 12.5px; color: var(--gs-fg-subtle); line-height: 1.7; }
.src__notice { margin: 0; padding: 10px 14px; border-radius: 10px; font-size: 13px; font-weight: 600; }
.src__notice.is-ok { background: var(--gs-accent-soft); color: var(--gs-accent-strong); }
.src__notice.is-warn { background: var(--gs-warn-bg); color: var(--gs-warn); }
.src__error { border: 1px solid var(--gs-warn); background: var(--gs-warn-bg); border-radius: 10px; padding: 12px 14px; }
.src__error-text { color: var(--gs-warn); font-size: 12.5px; }
.src__card { background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px; padding: 16px 18px; display: grid; gap: 10px; }
.src__card h2 { margin: 0; font-size: 15px; font-weight: 650; color: var(--gs-fg); }
.src__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.src__row { display: flex; justify-content: space-between; align-items: center; gap: 12px; background: var(--gs-divider); border-radius: 10px; padding: 10px 12px; }
.src__row-main { display: grid; gap: 2px; }
.src__row-actions { display: flex; gap: 8px; }
.src__import-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.src__mapping { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
.src__field { display: grid; gap: 4px; font-size: 12.5px; color: var(--gs-fg-muted); }
.src__field select, .src__input { border: 1px solid var(--gs-border-strong); border-radius: 8px; padding: 7px 10px; font-size: 12.5px; background: var(--gs-surface); color: var(--gs-fg); }
.src__file { position: relative; overflow: hidden; display: inline-flex; }
.src__file input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.src__file span, .src__action { border: 1px solid var(--gs-border-strong); background: var(--gs-surface); color: var(--gs-fg-2); border-radius: 9px; padding: 7px 13px; font-size: 12.5px; cursor: pointer; }
.src__action--on { background: var(--gs-accent); border-color: var(--gs-accent); color: #fff; }
.src__action:disabled { opacity: .45; cursor: not-allowed; }
.src__table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.src__table th, .src__table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--gs-border); }
.src__table th { color: var(--gs-fg-muted); font-weight: 600; }
.src__create { border-top: 1px dashed var(--gs-border); padding-top: 10px; display: grid; gap: 8px; }
.src__create h3 { margin: 0; font-size: 13.5px; font-weight: 650; color: var(--gs-fg); }
</style>
