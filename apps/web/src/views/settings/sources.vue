<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue';

import { Alert, Button, Select, Spin, Table, Upload } from 'ant-design-vue';

import { $t } from '#/locales';

import SettingsShell from '#/components/gainos/settings-shell.vue';

import {
  failureText,
  gainosApi,
  type AvailableChannelView,
  type ImportPreviewView,
  type ImportResultView,
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
const busyChannel = ref<string | null>(null);

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

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    available.value = await gainosApi.availableChannels();
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

async function onFile(file: File): Promise<boolean> {
  resetImport();
  csvText.value = await file.text();
  const firstLine = csvText.value.replace(/^\uFEFF/u, '').split(/\r?\n/u)[0] ?? '';
  const delimiter = (firstLine.match(/;/gu) ?? []).length > (firstLine.match(/,/gu) ?? []).length ? ';' : ',';
  headers.value = firstLine.split(delimiter).map((value) => value.trim()).filter(Boolean);
  autoGuessMapping();
  return false; // 阻止 antd Upload 自动上传
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

const headerOptions = computed(() =>
  headers.value.map((header) => ({ value: header, label: header })),
);

const previewColumns = [
  { key: 'rowNumber', dataIndex: 'rowNumber', title: '#', width: 70 },
  { key: 'name', dataIndex: 'name', title: $t('gainos.sources.mapName') },
  { key: 'domain', dataIndex: 'domain', title: $t('gainos.sources.mapWebsite') },
  { key: 'country', dataIndex: 'country', title: $t('gainos.sources.mapCountry'), width: 120 },
];

onMounted(load);
</script>

<template>
  <SettingsShell :subtitle="$t('gainos.sources.subtitle')" :title="$t('gainos.sources.title')">
    <template #actions>
      <Button :loading="loading" @click="load">{{ $t('gainos.common.refresh') }}</Button>
    </template>

    <Alert v-if="notice" :message="notice.text" show-icon :type="notice.tone === 'ok' ? 'success' : 'warning'" />
    <div v-if="loading" class="src__state"><Spin /></div>
    <Alert v-else-if="error" :message="error.title" :description="error.next" role="alert" show-icon type="warning" />

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
              <Button
                :type="channel.enabled ? 'primary' : 'default'"
                size="small"
                :disabled="busyChannel === channel.id"
                :loading="busyChannel === channel.id"
                @click="toggleChannel(channel)"
              >
                {{ channel.enabled ? $t('gainos.sources.enabled') : $t('gainos.sources.enable') }}
              </Button>
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
          <Upload
            :before-upload="onFile"
            :show-upload-list="false"
            accept=".csv,text/csv"
          >
            <Button>{{ $t('gainos.sources.chooseFile') }}</Button>
          </Upload>
          <Button @click="downloadTemplate">{{ $t('gainos.sources.downloadTemplate') }}</Button>
        </div>

        <div v-if="headers.length" class="src__mapping">
          <label class="src__field">
            <span>{{ $t('gainos.sources.mapName') }} *</span>
            <Select v-model:value="mapping.name" :options="headerOptions" allow-clear placeholder="—" style="width: 100%" />
          </label>
          <label class="src__field">
            <span>{{ $t('gainos.sources.mapWebsite') }}</span>
            <Select v-model:value="mapping.website" :options="headerOptions" allow-clear placeholder="—" style="width: 100%" />
          </label>
          <label class="src__field">
            <span>{{ $t('gainos.sources.mapCountry') }}</span>
            <Select v-model:value="mapping.country" :options="headerOptions" allow-clear placeholder="—" style="width: 100%" />
          </label>
          <label class="src__field">
            <span>{{ $t('gainos.sources.mapIndustry') }}</span>
            <Select v-model:value="mapping.industry" :options="headerOptions" allow-clear placeholder="—" style="width: 100%" />
          </label>
        </div>

        <Alert
          v-if="importError"
          :message="`${importError.title}${importError.next ? ' · ' + importError.next : ''}`"
          role="alert"
          show-icon
          type="warning"
        />

        <div v-if="headers.length" class="src__import-actions">
          <Button :disabled="!canPreview || importBusy !== null" :loading="importBusy === 'preview'" @click="doPreview">
            {{ importBusy === 'preview' ? $t('gainos.common.loading') : $t('gainos.sources.preview') }}
          </Button>
          <Button type="primary" :disabled="!canPreview || importBusy !== null" :loading="importBusy === 'commit'" @click="doCommit">
            {{ importBusy === 'commit' ? $t('gainos.common.loading') : $t('gainos.sources.commit') }}
          </Button>
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
          <Table
            :columns="previewColumns"
            :data-source="preview.sample"
            :pagination="false"
            row-key="rowNumber"
            size="small"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'domain'">{{ record.domain ?? '—' }}</template>
              <template v-else-if="column.key === 'country'">{{ record.country ?? '—' }}</template>
            </template>
          </Table>
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

    </template>
  </SettingsShell>
</template>

<style scoped>
.src__state { display: grid; place-items: center; padding: 32px; background: var(--gs-surface); border: 1px dashed var(--gs-border-dashed); border-radius: 14px; }
.src__muted { margin: 0; font-size: 12.5px; color: var(--gs-fg-subtle); line-height: 1.7; }
.src__card { background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px; padding: 16px 18px; display: grid; gap: 10px; }
.src__card h2 { margin: 0; font-size: 15px; font-weight: 650; color: var(--gs-fg); }
.src__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.src__row { display: flex; justify-content: space-between; align-items: center; gap: 12px; background: var(--gs-divider); border-radius: 10px; padding: 10px 12px; }
.src__row-main { display: grid; gap: 2px; }
.src__row-actions { display: flex; gap: 8px; }
.src__import-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.src__mapping { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
.src__field { display: grid; gap: 4px; font-size: 12.5px; color: var(--gs-fg-muted); }
</style>
