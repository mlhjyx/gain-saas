<script lang="ts" setup>
import { onMounted, ref } from 'vue';

import { Alert, Button, Form, Input, Select, Table } from 'ant-design-vue';

import { $t } from '#/locales';

import SettingsShell from '#/components/gainos/settings-shell.vue';

import { formatDateTime } from '@gain-saas/shared';

import { failureText, gainosApi, type DeletionRequestView } from '#/api/gainos';

defineOptions({ name: 'SettingsPrivacy' });

const STORAGE_KEY = 'gainos.dsr.requests.v1';

interface TrackedRequest {
  id: string;
  subjectType: string;
  subjectId: string;
  createdAt: string;
}

const form = ref({
  subjectType: 'company' as 'company' | 'contact',
  subjectId: '',
  reason: 'erasure',
  requestRef: '',
});
const submitting = ref(false);
const formError = ref<{ title: string; next?: string } | null>(null);
const notice = ref<string | null>(null);

const tracked = ref<TrackedRequest[]>([]);
const companyOptions = ref<Array<{ id: string; name: string }>>([]);

/** P5b-13：公司对象用选择器，不再要求用户手抄 UUID；联系人仍允许手填。 */
async function loadCompanies(): Promise<void> {
  try {
    const data = await gainosApi.companies();
    const rows = Array.isArray(data) ? data : (data.data ?? []);
    companyOptions.value = rows.flatMap((row) =>
      row.id
        ? [{ id: row.id, name: row.name?.trim() || row.domain || row.id.slice(0, 8) }]
        : [],
    );
  } catch {
    companyOptions.value = [];
  }
}
const details = ref<Record<string, DeletionRequestView>>({});
const refreshing = ref(false);

const lookupId = ref('');
const lookupError = ref<{ title: string; next?: string } | null>(null);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function statusTone(status?: string): string {
  if (status === 'COMPLETED') return 'is-ok';
  if (status === 'FAILED') return 'is-bad';
  if (status === 'ERASING' || status === 'FROZEN') return 'is-warn';
  return 'is-muted';
}

function fmtTime(value?: string | null): string {
  return formatDateTime(value) || '—';
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tracked.value.slice(0, 50)));
  } catch {
    /* 本地记录失败不影响服务端请求 */
  }
}

function remember(id: string, subjectType: string, subjectId: string, createdAt: string): void {
  if (!tracked.value.some((item) => item.id === id)) {
    tracked.value.unshift({ id, subjectType, subjectId, createdAt });
    persist();
  }
}

async function refresh(): Promise<void> {
  refreshing.value = true;
  const results = await Promise.allSettled(
    tracked.value.map(async (item) => ({ id: item.id, detail: await gainosApi.deletionRequest(item.id) })),
  );
  for (const result of results) {
    if (result.status === 'fulfilled') details.value[result.value.id] = result.value.detail;
  }
  refreshing.value = false;
}

async function submit(): Promise<void> {
  formError.value = null;
  notice.value = null;
  const subjectId = form.value.subjectId.trim();
  if (!UUID.test(subjectId)) {
    formError.value = { title: $t('gainos.privacy.invalidId'), next: $t('gainos.privacy.invalidIdHint') };
    return;
  }
  submitting.value = true;
  try {
    const created = await gainosApi.createDeletionRequest({
      subjectType: form.value.subjectType,
      subjectId,
      reason: form.value.reason,
      ...(form.value.requestRef.trim() ? { requestRef: form.value.requestRef.trim() } : {}),
    });
    details.value[created.id] = created;
    remember(created.id, created.subjectType, created.subjectId, created.createdAt);
    notice.value = $t('gainos.privacy.submitted', { id: created.id });
    form.value.subjectId = '';
    form.value.requestRef = '';
    await refresh();
  } catch (err) {
    formError.value = failureText(err);
  } finally {
    submitting.value = false;
  }
}

async function lookup(): Promise<void> {
  lookupError.value = null;
  const id = lookupId.value.trim();
  if (!UUID.test(id)) {
    lookupError.value = { title: $t('gainos.privacy.invalidId'), next: $t('gainos.privacy.invalidIdHint') };
    return;
  }
  try {
    const detail = await gainosApi.deletionRequest(id);
    details.value[id] = detail;
    remember(detail.id, detail.subjectType, detail.subjectId, detail.createdAt);
    notice.value = $t('gainos.privacy.found', { id });
    lookupId.value = '';
  } catch (err) {
    lookupError.value = failureText(err);
  }
}

function filterCompanyOption(input: string, option: unknown): boolean {
  const label = (option as { label?: string })?.label ?? '';
  return label.toLowerCase().includes(input.toLowerCase());
}

const subjectTypeOptions = [
  { value: 'company', label: $t('gainos.privacy.subjectCompany') },
  { value: 'contact', label: $t('gainos.privacy.subjectContact') },
];
const reasonOptions = [
  { value: 'erasure', label: $t('gainos.privacy.reasonErasure') },
  { value: 'objection', label: $t('gainos.privacy.reasonObjection') },
  { value: 'legal', label: $t('gainos.privacy.reasonLegal') },
  { value: 'manual', label: $t('gainos.privacy.reasonManual') },
];

const columns = [
  { key: 'id', dataIndex: 'id', title: $t('gainos.privacy.requestId'), width: 260 },
  { key: 'subject', dataIndex: 'subject', title: $t('gainos.privacy.subject'), width: 220 },
  { key: 'status', dataIndex: 'status', title: $t('gainos.privacy.status'), width: 130 },
  { key: 'receipt', dataIndex: 'receipt', title: $t('gainos.privacy.receipt') },
  { key: 'createdAt', dataIndex: 'createdAt', title: $t('gainos.privacy.createdAt'), width: 170 },
];

onMounted(() => {
  void loadCompanies();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) tracked.value = JSON.parse(raw) as TrackedRequest[];
  } catch {
    tracked.value = [];
  }
  void refresh();
});
</script>

<template>
  <SettingsShell :subtitle="$t('gainos.privacy.subtitle')" :title="$t('gainos.privacy.title')">
    <template #actions>
      <Button :disabled="refreshing" :loading="refreshing" @click="refresh">
        {{ refreshing ? $t('gainos.privacy.refreshing') : $t('gainos.common.refresh') }}
      </Button>
    </template>

    <Alert v-if="notice" :message="notice" role="status" show-icon type="success" />

    <section class="pv__grid">
      <article class="pv__card">
        <h2>{{ $t('gainos.privacy.rightsTitle') }}</h2>
        <ul class="pv__list">
          <li>{{ $t('gainos.privacy.rightAccess') }}</li>
          <li>{{ $t('gainos.privacy.rightErasure') }}</li>
          <li>{{ $t('gainos.privacy.rightObjection') }}</li>
          <li>{{ $t('gainos.privacy.rightResponse') }}</li>
        </ul>
        <p class="pv__muted">{{ $t('gainos.privacy.scopeNote') }}</p>
      </article>

      <article class="pv__card">
        <h2>{{ $t('gainos.privacy.formTitle') }}</h2>
        <p class="pv__muted">{{ $t('gainos.privacy.formDesc') }}</p>
        <Form class="pv__form" layout="vertical" @submit.prevent="submit">
          <Form.Item :label="$t('gainos.privacy.subjectType')">
            <Select v-model:value="form.subjectType" :options="subjectTypeOptions" />
          </Form.Item>
          <Form.Item :label="$t('gainos.privacy.subjectId')">
            <Select
              v-if="form.subjectType === 'company' && companyOptions.length"
              v-model:value="form.subjectId"
              :filter-option="filterCompanyOption"
              :options="companyOptions.map((c) => ({ value: c.id, label: c.name }))"
              :placeholder="$t('gainos.privacy.subjectIdHint')"
              show-search
            />
            <Input v-else v-model:value="form.subjectId" :placeholder="$t('gainos.privacy.subjectIdHint')" />
          </Form.Item>
          <Form.Item :label="$t('gainos.privacy.reason')">
            <Select v-model:value="form.reason" :options="reasonOptions" />
          </Form.Item>
          <Form.Item :label="$t('gainos.privacy.requestRef')">
            <Input v-model:value="form.requestRef" :maxlength="200" :placeholder="$t('gainos.privacy.requestRefHint')" />
          </Form.Item>
        </Form>
        <Alert v-if="formError" role="alert" show-icon type="warning">
          <template #message>{{ formError.title }}</template>
          <template v-if="formError.next" #description>{{ formError.next }}</template>
        </Alert>
        <div class="pv__actions">
          <Button type="primary" :disabled="submitting" :loading="submitting" @click="submit">{{ submitting ? $t('gainos.privacy.submitting') : $t('gainos.privacy.submit') }}</Button>
          <span class="pv__muted">{{ $t('gainos.privacy.asyncNote') }}</span>
        </div>
      </article>
    </section>

    <section class="pv__card">
      <div class="pv__row">
        <h2>{{ $t('gainos.privacy.trackedTitle') }}</h2>
        <Input.Search
          v-model:value="lookupId"
          class="pv__lookup"
          :placeholder="$t('gainos.privacy.lookupHint')"
          enter-button
          @search="lookup"
        />
      </div>
      <Alert v-if="lookupError" role="alert" show-icon type="warning" class="pv__lookup-error">
        <template #message>{{ lookupError.title }}</template>
        <template v-if="lookupError.next" #description>{{ lookupError.next }}</template>
      </Alert>
      <p v-if="tracked.length === 0" class="pv__muted">{{ $t('gainos.privacy.noTracked') }}</p>
      <Table
        v-else
        :columns="columns"
        :data-source="tracked"
        :pagination="false"
        :scroll="{ x: 760 }"
        row-key="id"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'id'"><span class="pv__mono">{{ record.id }}</span></template>
          <template v-else-if="column.key === 'subject'">
            {{ record.subjectType }}
            <div class="pv__mono pv__muted">{{ record.subjectId }}</div>
          </template>
          <template v-else-if="column.key === 'status'">
            <span v-if="details[record.id]" class="pv__badge" :class="statusTone(details[record.id]?.status)">{{ details[record.id]?.status }}</span>
            <span v-else class="pv__muted">{{ $t('gainos.privacy.unknownStatus') }}</span>
          </template>
          <template v-else-if="column.key === 'receipt'">
            <template v-if="details[record.id]?.receipt">
              <span class="pv__muted">{{ $t('gainos.privacy.receiptSummary', {
                contacts: details[record.id]?.receipt?.contactsErased ?? 0,
                points: details[record.id]?.receipt?.contactPointsErased ?? 0,
                evidence: details[record.id]?.receipt?.fieldEvidenceErased ?? 0,
              }) }}</span>
            </template>
            <span v-else class="pv__muted">—</span>
          </template>
          <template v-else-if="column.key === 'createdAt'">{{ fmtTime(details[record.id]?.createdAt ?? record.createdAt) }}</template>
        </template>
      </Table>
      <p class="pv__muted">{{ $t('gainos.privacy.trackedNote') }}</p>
    </section>
  </SettingsShell>
</template>

<style scoped>
.pv__grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); gap: 14px; }
.pv__card { background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px; padding: 18px 20px; display: grid; gap: 10px; align-content: start; }
.pv__card h2 { margin: 0; font-size: 15px; font-weight: 650; color: var(--gs-fg); }
.pv__list { margin: 0; padding-left: 18px; color: var(--gs-fg-2); font-size: 13px; line-height: 1.9; }
.pv__muted { margin: 0; color: var(--gs-fg-subtle); font-size: 12.5px; line-height: 1.7; }
.pv__form :deep(.ant-form-item) { margin-bottom: 10px; }
.pv__actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.pv__row { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.pv__lookup { max-width: 420px; }
.pv__lookup-error { margin-top: 8px; }
.pv__mono { font-family: var(--gs-mono); font-size: 11px; word-break: break-all; }
.pv__badge { border-radius: 999px; padding: 2px 9px; font-size: 11px; font-weight: 650; background: var(--gs-surface-2); color: var(--gs-fg-muted); }
.pv__badge.is-ok { background: var(--gs-accent-soft); color: var(--gs-accent-strong); }
.pv__badge.is-warn { background: var(--gs-warn-bg); color: var(--gs-warn); }
.pv__badge.is-bad { background: var(--gs-danger-bg); color: var(--gs-danger); }
@media (max-width: 900px) { .pv__grid { grid-template-columns: 1fr; } .pv__lookup { max-width: none; } }
</style>
