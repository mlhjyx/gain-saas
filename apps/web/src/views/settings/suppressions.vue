<script lang="ts" setup>
/**
 * 设置 · 禁联名单（C2，P6 设计 §3「设置：…禁联名单…」）。
 *
 * 数据走 BFF 既有代理（GET/POST /api/suppressions、DELETE /api/suppressions/:id，admin）。
 * 注意引擎语义：DELETE 是「解除申请」（append-only release request），不会物理删除——
 * 页面文案如实呈现，不给「删除成功」的假象。
 */
import { onMounted, reactive, ref } from 'vue';

import { Alert, Button, Form, Input, Select, Spin, Table } from 'ant-design-vue';

import { $t } from '#/locales';

import SettingsShell from '#/components/gainos/settings-shell.vue';

import { formatDate } from '@gain-saas/shared';

import {
  failureText,
  gainosApi,
  type SuppressionReason,
  type SuppressionRecordView,
  type SuppressionType,
} from '#/api/gainos';

defineOptions({ name: 'SettingsSuppressions' });

const TYPES: SuppressionType[] = ['email', 'domain', 'company_name'];
const REASONS: SuppressionReason[] = ['manual', 'unsubscribe', 'bounce', 'complaint', 'legal'];

const rows = ref<SuppressionRecordView[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const form = reactive<{ reason: SuppressionReason; type: SuppressionType; value: string }>({
  reason: 'manual',
  type: 'email',
  value: '',
});
const adding = ref(false);
const addError = ref<string | null>(null);

const releasing = ref<string | null>(null);

function typeLabel(type: string): string {
  const key = `gainos.suppressions.type.${type}`;
  const value = $t(key);
  return value === key ? type : value;
}

function reasonLabel(reason: string | null): string {
  if (!reason) return '—';
  const key = `gainos.suppressions.reason.${reason}`;
  const value = $t(key);
  return value === key ? '—' : value;
}

function protectionLabel(protection: string): string {
  return protection === 'LEGAL' ? $t('gainos.suppressions.protectionLegal') : $t('gainos.suppressions.protectionPreference');
}

const limit = ref(50);
const hasMore = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const page = await gainosApi.suppressions({ limit: limit.value });
    rows.value = page.data ?? [];
    hasMore.value = Boolean((page as unknown as { page?: { has_more?: boolean } }).page?.has_more);
  } catch (err) {
    error.value = failureText(err).title;
  } finally {
    loading.value = false;
  }
}

function loadMore(): void {
  limit.value += 50;
  void load();
}

async function add(): Promise<void> {
  addError.value = null;
  const value = form.value.trim();
  if (!value) {
    addError.value = $t('gainos.suppressions.errValueRequired');
    return;
  }
  if (form.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    addError.value = $t('gainos.suppressions.errEmail');
    return;
  }
  adding.value = true;
  try {
    await gainosApi.createSuppression({ reason: form.reason, type: form.type, value });
    form.value = '';
    notice.value = $t('gainos.suppressions.added');
    await load();
  } catch (err) {
    addError.value = failureText(err).title;
  } finally {
    adding.value = false;
  }
}

async function release(row: SuppressionRecordView): Promise<void> {
  if (!window.confirm($t('gainos.suppressions.releaseConfirm', { value: row.value }))) return;
  releasing.value = row.id;
  try {
    const result = await gainosApi.requestSuppressionRelease(row.id);
    notice.value = result?.releaseRequested
      ? $t('gainos.suppressions.releaseRequested')
      : $t('gainos.suppressions.released');
    await load();
  } catch (err) {
    error.value = failureText(err).title;
  } finally {
    releasing.value = null;
  }
}

const typeOptions = TYPES.map((type) => ({ value: type, label: typeLabel(type) }));
const reasonOptions = REASONS.map((reason) => ({ value: reason, label: reasonLabel(reason) }));

const columns = [
  { key: 'value', dataIndex: 'value', title: $t('gainos.suppressions.colValue') },
  { key: 'type', dataIndex: 'type', title: $t('gainos.suppressions.colType'), width: 130 },
  { key: 'reason', dataIndex: 'reason', title: $t('gainos.suppressions.colReason'), width: 130 },
  { key: 'protectionClass', dataIndex: 'protectionClass', title: $t('gainos.suppressions.colProtection'), width: 140 },
  { key: 'createdAt', dataIndex: 'createdAt', title: $t('gainos.suppressions.colCreated'), width: 130 },
  { key: 'actions', dataIndex: 'actions', title: '', width: 110 },
];

onMounted(load);
</script>

<template>
  <SettingsShell :subtitle="$t('gainos.suppressions.subtitle')" :title="$t('gainos.suppressions.title')">

    <Alert v-if="notice" :message="notice" role="status" show-icon type="success" />

    <section class="sp__card">
      <h2>{{ $t('gainos.suppressions.addTitle') }}</h2>
      <Form class="sp__form" layout="vertical" @submit.prevent="add">
        <Form.Item :label="$t('gainos.suppressions.typeLabel')">
          <Select v-model:value="form.type" :options="typeOptions" style="width: 140px" />
        </Form.Item>
        <Form.Item class="sp__grow" :label="$t('gainos.suppressions.valueLabel')">
          <Input
            v-model:value="form.value"
            :maxlength="2048"
            :placeholder="$t(`gainos.suppressions.valuePlaceholder.${form.type}`)"
            @press-enter="add"
          />
        </Form.Item>
        <Form.Item :label="$t('gainos.suppressions.reasonLabel')">
          <Select v-model:value="form.reason" :options="reasonOptions" style="width: 160px" />
        </Form.Item>
        <Button type="primary" :disabled="adding" :loading="adding" style="margin-bottom: 22px" @click="add">
          {{ adding ? $t('gainos.common.loading') : $t('gainos.suppressions.add') }}
        </Button>
      </Form>
      <Alert v-if="addError" :message="addError" role="alert" show-icon type="error" />
      <p class="sp__hint">{{ $t('gainos.suppressions.addHint') }}</p>
    </section>

    <div v-if="loading" class="sp__state"><Spin /></div>
    <Alert
      v-else-if="error"
      :message="error"
      show-icon
      type="warning"
    >
      <template #action>
        <Button size="small" @click="load">{{ $t('gainos.common.retry') }}</Button>
      </template>
    </Alert>
    <section v-else class="sp__card">
      <h2>{{ $t('gainos.suppressions.listTitle', { count: rows.length }) }}</h2>
      <p v-if="rows.length === 0" class="sp__empty">{{ $t('gainos.suppressions.empty') }}</p>
      <Table
        v-else
        :columns="columns"
        :data-source="rows"
        :pagination="false"
        :scroll="{ x: 760 }"
        row-key="id"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'value'"><span class="sp__value">{{ record.value }}</span></template>
          <template v-else-if="column.key === 'type'">{{ typeLabel(record.type) }}</template>
          <template v-else-if="column.key === 'reason'">{{ reasonLabel(record.reason) }}</template>
          <template v-else-if="column.key === 'protectionClass'">
            <span class="gs-badge" :class="record.protectionClass === 'LEGAL' ? 'gs-badge--warning' : 'gs-badge--neutral'">
              {{ protectionLabel(record.protectionClass) }}
            </span>
          </template>
          <template v-else-if="column.key === 'createdAt'">{{ formatDate(record.createdAt) }}</template>
          <template v-else-if="column.key === 'actions'">
            <Button
              danger
              type="link"
              size="small"
              :disabled="releasing === record.id"
              :loading="releasing === record.id"
              @click="release(record as SuppressionRecordView)"
            >
              {{ $t('gainos.suppressions.release') }}
            </Button>
          </template>
        </template>
      </Table>
      <p v-if="hasMore" class="sp__hint sp__more">
        <Button type="link" size="small" @click="loadMore">{{ $t('gainos.suppressions.loadMore') }}</Button>
      </p>
      <p class="sp__hint">{{ $t('gainos.suppressions.releaseHint') }}</p>
    </section>
  </SettingsShell>
</template>

<style scoped>
.sp__card { background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px; padding: 18px 20px; display: grid; gap: 12px; }
.sp__card h2 { margin: 0; font-size: 15px; font-weight: 650; color: var(--gs-fg); }
.sp__form { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-start; }
.sp__form :deep(.ant-form-item) { margin-bottom: 0; }
.sp__grow { flex: 1 1 240px; }
.sp__hint { margin: 0; font-size: 12.5px; color: var(--gs-fg-subtle); line-height: 1.7; }
.sp__state { color: var(--gs-fg-muted); font-size: 13px; padding: 24px; display: grid; place-items: center; }
.sp__more { text-align: center; }
.sp__empty { margin: 0; color: var(--gs-fg-muted); font-size: 13px; }
.sp__value { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
</style>
