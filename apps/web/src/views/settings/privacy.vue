<script lang="ts" setup>
import { computed, onMounted, ref, watch } from 'vue';

import { Alert, Button, Form, Input } from 'ant-design-vue';

import { feedback } from '#/feedback';
import { $t } from '#/locales';

import SettingsShell from '#/components/gainos/settings-shell.vue';
import GsCard from '#/components/gainos/ui/gs-card.vue';
import GsEmpty from '#/components/gainos/ui/gs-empty.vue';
import GsSelect from '#/components/gainos/ui/gs-select.vue';
import GsTable from '#/components/gainos/ui/gs-table.vue';
import GsTag from '#/components/gainos/ui/gs-tag.vue';

import DataExportsCard from './components/data-exports-card.vue';
import WalletBillingCard from './components/wallet-billing-card.vue';
import WorkspaceOffboardingCard from './components/workspace-offboarding-card.vue';

import { formatDateTime } from '@gain-saas/shared';

import { failureText, gainosApi, type DeletionRequestView } from '#/api/gainos';

defineOptions({ name: 'SettingsPrivacy' });

const form = ref({
  subjectType: 'company' as 'company' | 'contact',
  subjectId: '',
  reason: 'erasure',
  requestRef: '',
});
const submitting = ref(false);
const formError = ref<{ title: string; next?: string } | null>(null);
const notice = ref<string | null>(null);
const showManualTool = ref(false);

const companyOptions = ref<Array<{ id: string; name: string }>>([]);
const requests = ref<DeletionRequestView[]>([]);
const nextCursor = ref<string | null>(null);
const hasMore = ref(false);
const statusFilter = ref<string>('ALL');
const loadingList = ref(false);
const loadingMore = ref(false);
const listError = ref<{ title: string; next?: string } | null>(null);

const lookupId = ref('');
const lookupError = ref<{ title: string; next?: string } | null>(null);
const workspaceId = ref('');
const workspaceName = ref('');
const isAdmin = ref(false);

async function loadWorkspaceMeta(): Promise<void> {
  try {
    const ctx = await gainosApi.workspaceContext();
    if (ctx?.workspace?.id) {
      workspaceId.value = ctx.workspace.id;
      workspaceName.value = ctx.workspace.name ?? '';
      isAdmin.value = ctx.workspace.role === 'admin';
      return;
    }
  } catch {
    // fallback to session
  }
  try {
    const session = await gainosApi.session();
    const activeWs = session.workspaces?.find((w) => w.id === session.workspace?.id) ?? session.workspaces?.[0];
    workspaceId.value = session.workspace?.id ?? activeWs?.id ?? '';
    workspaceName.value = activeWs?.name ?? '';
    isAdmin.value = session.workspace?.role === 'admin';
  } catch {
    // ignore
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const companyNameById = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {};
  for (const item of companyOptions.value) {
    map[item.id] = item.name;
  }
  return map;
});

watch(
  () => form.value.subjectType,
  () => {
    form.value.subjectId = '';
    formError.value = null;
  },
);

async function loadBuyers(): Promise<void> {
  try {
    const collected: Array<{ id: string; name: string }> = [];
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
      const page = await gainosApi.canonicalCompanies({
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const row of page.data ?? []) {
        if (row.id) {
          collected.push({
            id: row.id,
            name: row.name?.trim() || row.domain?.trim() || `#${row.id.slice(0, 8)}`,
          });
        }
      }
      if (!page.page?.has_more || !page.page?.next_cursor) break;
      cursor = page.page.next_cursor;
    }
    companyOptions.value = collected;
  } catch {
    companyOptions.value = [];
  }
}

async function loadRequests(reset = true): Promise<void> {
  if (reset) {
    loadingList.value = true;
  } else {
    loadingMore.value = true;
  }
  listError.value = null;
  try {
    const res = await gainosApi.deletionRequests({
      limit: 20,
      ...(statusFilter.value !== 'ALL' ? { status: statusFilter.value } : {}),
      ...(!reset && nextCursor.value ? { cursor: nextCursor.value } : {}),
    });
    const rows = res.data ?? [];
    if (reset) {
      requests.value = rows;
    } else {
      const seen = new Set(requests.value.map((item) => item.id));
      requests.value = [...requests.value, ...rows.filter((item) => !seen.has(item.id))];
    }
    nextCursor.value = res.page?.next_cursor ?? null;
    hasMore.value = Boolean(res.page?.has_more && res.page?.next_cursor);
  } catch (err) {
    listError.value = failureText(err);
  } finally {
    loadingList.value = false;
    loadingMore.value = false;
  }
}

function onStatusFilterChange(): void {
  nextCursor.value = null;
  hasMore.value = false;
  void loadRequests(true);
}

function statusTone(status?: string): 'danger' | 'info' | 'neutral' | 'success' | 'warning' {
  if (status === 'COMPLETED') return 'success';
  if (status === 'FAILED') return 'danger';
  if (status === 'ERASING' || status === 'FROZEN') return 'warning';
  if (status === 'RECEIVED' || status === 'PENDING') return 'info';
  return 'neutral';
}

function statusLabel(status?: string): string {
  if (status === 'COMPLETED') return $t('gainos.privacy.statusCompleted');
  if (status === 'FAILED') return $t('gainos.privacy.statusFailed');
  if (status === 'ERASING') return $t('gainos.privacy.statusErasing');
  if (status === 'FROZEN') return $t('gainos.privacy.statusFrozen');
  if (status === 'RECEIVED' || status === 'PENDING') return $t('gainos.privacy.statusPending');
  return $t('gainos.privacy.unknownStatus');
}

function subjectTypeLabel(type?: string): string {
  if (type === 'company') return $t('gainos.privacy.subjectCompany');
  if (type === 'contact') return $t('gainos.privacy.subjectContact');
  return type || '—';
}

function subjectDisplayLabel(record: DeletionRequestView): string {
  if (record.subjectType === 'company') {
    return (
      companyNameById.value[record.subjectId] ??
      $t('gainos.privacy.companyFallback', { id: record.subjectId.slice(0, 8) })
    );
  }
  return $t('gainos.privacy.contactFallback', { id: record.subjectId.slice(0, 8) });
}

function shortId(id: string): string {
  return `#${id.slice(0, 8)}`;
}

function fmtTime(value?: string | null): string {
  return formatDateTime(value) || '—';
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
    const msg = $t('gainos.privacy.submitted', { id: created.id.slice(0, 8) });
    notice.value = msg;
    feedback.message.success(msg);
    form.value.subjectId = '';
    form.value.requestRef = '';
    await loadRequests(true);
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
    requests.value = [detail, ...requests.value.filter((item) => item.id !== detail.id)];
    const msg = $t('gainos.privacy.found', { id: detail.id.slice(0, 8) });
    notice.value = msg;
    feedback.message.success(msg);
    lookupId.value = '';
  } catch (err) {
    lookupError.value = failureText(err);
  }
}

function filterCompanyOption(input: string, option: unknown): boolean {
  const label = (option as { label?: string })?.label ?? '';
  return label.toLowerCase().includes(input.toLowerCase());
}

const subjectTypeOptions = computed(() => [
  { value: 'company', label: $t('gainos.privacy.subjectCompany') },
  { value: 'contact', label: $t('gainos.privacy.subjectContact') },
]);

const reasonOptions = computed(() => [
  { value: 'erasure', label: $t('gainos.privacy.reasonErasure') },
  { value: 'objection', label: $t('gainos.privacy.reasonObjection') },
  { value: 'legal', label: $t('gainos.privacy.reasonLegal') },
  { value: 'manual', label: $t('gainos.privacy.reasonManual') },
]);

const statusFilterOptions = computed(() => [
  { value: 'ALL', label: $t('gainos.privacy.statusAll') },
  { value: 'RECEIVED', label: $t('gainos.privacy.statusPending') },
  { value: 'FROZEN', label: $t('gainos.privacy.statusFrozen') },
  { value: 'ERASING', label: $t('gainos.privacy.statusErasing') },
  { value: 'COMPLETED', label: $t('gainos.privacy.statusCompleted') },
  { value: 'FAILED', label: $t('gainos.privacy.statusFailed') },
]);

const columns = computed(() => [
  { key: 'id', dataIndex: 'id', title: $t('gainos.privacy.requestId'), width: 130 },
  { key: 'subject', dataIndex: 'subject', title: $t('gainos.privacy.subject'), width: 220 },
  { key: 'status', dataIndex: 'status', title: $t('gainos.privacy.status'), width: 130 },
  { key: 'receipt', dataIndex: 'receipt', title: $t('gainos.privacy.receipt') },
  { key: 'createdAt', dataIndex: 'createdAt', title: $t('gainos.privacy.createdAt'), width: 170 },
]);

onMounted(() => {
  void loadWorkspaceMeta();
  void loadBuyers();
  void loadRequests(true);
});
</script>

<template>
  <SettingsShell :subtitle="$t('gainos.privacy.subtitle')" :title="$t('gainos.privacy.title')">
    <template #actions>
      <Button :disabled="loadingList" :loading="loadingList" @click="loadRequests(true)">
        {{ loadingList ? $t('gainos.privacy.refreshing') : $t('gainos.common.refresh') }}
      </Button>
    </template>

    <div class="grid grid-cols-1 gap-4 @container" data-gs="privacy-page">
      <Alert v-if="notice" :message="notice" closable role="status" show-icon type="success" @close="notice = null" />

      <GsCard :title="$t('gainos.privacy.autoTitle')">
        <template #extra>
          <GsTag tone="success">{{ $t('gainos.privacy.autoActive') }}</GsTag>
        </template>
        <div class="grid gap-3">
          <p class="m-0 text-sm text-[var(--gs-fg-muted)]">{{ $t('gainos.privacy.autoDesc') }}</p>
          <div class="grid grid-cols-1 gap-3 @min-[780px]:grid-cols-3">
            <div class="grid content-start gap-1 rounded-lg border border-[var(--gs-border)] bg-[var(--gs-surface-2)] p-3">
              <strong class="text-xs font-semibold text-[var(--gs-fg)]">{{ $t('gainos.privacy.pillarScopeTitle') }}</strong>
              <p class="m-0 text-xs leading-relaxed text-[var(--gs-fg-subtle)]">{{ $t('gainos.privacy.pillarScopeDesc') }}</p>
            </div>
            <div class="grid content-start gap-1 rounded-lg border border-[var(--gs-border)] bg-[var(--gs-surface-2)] p-3">
              <strong class="text-xs font-semibold text-[var(--gs-fg)]">{{ $t('gainos.privacy.pillarFooterTitle') }}</strong>
              <p class="m-0 text-xs leading-relaxed text-[var(--gs-fg-subtle)]">{{ $t('gainos.privacy.pillarFooterDesc') }}</p>
            </div>
            <div class="grid content-start gap-1 rounded-lg border border-[var(--gs-border)] bg-[var(--gs-surface-2)] p-3">
              <strong class="text-xs font-semibold text-[var(--gs-fg)]">{{ $t('gainos.privacy.pillarFreezeTitle') }}</strong>
              <p class="m-0 text-xs leading-relaxed text-[var(--gs-fg-subtle)]">{{ $t('gainos.privacy.pillarFreezeDesc') }}</p>
            </div>
          </div>
        </div>
      </GsCard>

      <GsCard :title="$t('gainos.privacy.formTitle')">
        <template #extra>
          <Button data-gs="privacy-toggle-manual" @click="showManualTool = !showManualTool">
            {{ showManualTool ? $t('gainos.privacy.hideManualTool') : $t('gainos.privacy.openManualTool') }}
          </Button>
        </template>
        <div class="grid gap-3">
          <p class="m-0 text-sm text-[var(--gs-fg-muted)]">{{ $t('gainos.privacy.formDesc') }}</p>

          <div
            v-if="showManualTool"
            class="grid grid-cols-1 gap-4 border-t border-dashed border-[var(--gs-border)] pt-4 @min-[780px]:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]"
          >
            <article class="grid content-start gap-2.5 rounded-xl border border-[var(--gs-border)] bg-[var(--gs-surface-2)] p-4">
              <h3 class="m-0 text-sm font-semibold text-[var(--gs-fg)]">{{ $t('gainos.privacy.rightsTitle') }}</h3>
              <ul class="m-0 grid gap-1 pl-4 text-xs leading-relaxed text-[var(--gs-fg-2)]">
                <li>{{ $t('gainos.privacy.rightAccess') }}</li>
                <li>{{ $t('gainos.privacy.rightErasure') }}</li>
                <li>{{ $t('gainos.privacy.rightObjection') }}</li>
                <li>{{ $t('gainos.privacy.rightResponse') }}</li>
              </ul>
              <p class="m-0 text-xs leading-relaxed text-[var(--gs-fg-subtle)]">{{ $t('gainos.privacy.scopeNote') }}</p>
            </article>

            <article class="grid content-start gap-3 rounded-xl border border-[var(--gs-border)] bg-[var(--gs-surface-2)] p-4">
              <Form layout="vertical" @submit.prevent="submit">
                <Form.Item :label="$t('gainos.privacy.subjectType')">
                  <div data-gs="privacy-subject-type">
                    <GsSelect
                      v-model="form.subjectType"
                      :ariaLabel="$t('gainos.privacy.subjectType')"
                      :options="subjectTypeOptions"
                    />
                  </div>
                </Form.Item>
                <Form.Item :label="$t('gainos.privacy.subjectId')">
                  <div v-if="form.subjectType === 'company' && companyOptions.length > 0" data-gs="privacy-buyer-select">
                    <GsSelect
                      v-model="form.subjectId"
                      :ariaLabel="$t('gainos.privacy.subjectId')"
                      :filter-option="filterCompanyOption"
                      :options="companyOptions.map((c) => ({ value: c.id, label: c.name }))"
                      :placeholder="$t('gainos.privacy.subjectIdHint')"
                      show-search
                    />
                  </div>
                  <Input
                    v-else
                    v-model:value="form.subjectId"
                    :placeholder="$t('gainos.privacy.subjectIdHint')"
                    data-gs="privacy-subject-input"
                  />
                </Form.Item>
                <Form.Item :label="$t('gainos.privacy.reason')">
                  <GsSelect
                    v-model="form.reason"
                    :ariaLabel="$t('gainos.privacy.reason')"
                    :options="reasonOptions"
                  />
                </Form.Item>
                <Form.Item :label="$t('gainos.privacy.requestRef')">
                  <Input v-model:value="form.requestRef" :maxlength="200" :placeholder="$t('gainos.privacy.requestRefHint')" />
                </Form.Item>
              </Form>
              <Alert v-if="formError" role="alert" show-icon type="warning">
                <template #message>{{ formError.title }}</template>
                <template v-if="formError.next" #description>{{ formError.next }}</template>
              </Alert>
              <div class="flex flex-wrap items-center gap-3">
                <Button :disabled="submitting" :loading="submitting" data-gs="privacy-submit" type="primary" @click="submit">
                  {{ submitting ? $t('gainos.privacy.submitting') : $t('gainos.privacy.submit') }}
                </Button>
                <span class="text-xs text-[var(--gs-fg-subtle)]">{{ $t('gainos.privacy.asyncNote') }}</span>
              </div>
            </article>
          </div>
        </div>
      </GsCard>

      <GsCard :title="$t('gainos.privacy.trackedTitle')" data-gs="privacy-requests-card">
        <template #extra>
          <div class="flex flex-wrap items-center gap-2">
            <div class="w-[150px]" data-gs="privacy-status-filter">
              <GsSelect
                v-model="statusFilter"
                :ariaLabel="$t('gainos.privacy.statusFilterLabel')"
                :options="statusFilterOptions"
                @change="onStatusFilterChange"
              />
            </div>
            <div class="w-[260px]">
              <Input.Search
                v-model:value="lookupId"
                :aria-label="$t('gainos.privacy.lookupHint')"
                :placeholder="$t('gainos.privacy.lookupHint')"
                enter-button
                @search="lookup"
              />
            </div>
          </div>
        </template>

        <div class="grid gap-3">
          <Alert v-if="listError" role="alert" show-icon type="warning">
            <template #message>{{ listError.title }}</template>
            <template v-if="listError.next" #description>{{ listError.next }}</template>
          </Alert>
          <Alert v-if="lookupError" role="alert" show-icon type="warning">
            <template #message>{{ lookupError.title }}</template>
            <template v-if="lookupError.next" #description>{{ lookupError.next }}</template>
          </Alert>

          <GsEmpty v-if="!loadingList && requests.length === 0" simple :title="$t('gainos.privacy.noTracked')">
            <template #actions>
              <Button type="primary" @click="$router.push('/settings/suppressions')">{{ $t('gainos.menu.suppressions') }}</Button>
              <Button @click="$router.push('/settings/audit')">{{ $t('gainos.audit.title') }}</Button>
            </template>
          </GsEmpty>
          <GsTable
            v-else
            :columns="columns"
            :data-source="requests"
            :loading="loadingList"
            :scroll="{ x: 760 }"
            row-key="id"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'id'">
                <span class="font-mono text-xs text-[var(--gs-fg-2)]" :title="record.id">{{ shortId(record.id) }}</span>
              </template>
              <template v-else-if="column.key === 'subject'">
                <div class="text-xs font-medium text-[var(--gs-fg)]">{{ subjectDisplayLabel(record) }}</div>
                <div class="text-xs text-[var(--gs-fg-subtle)]">{{ subjectTypeLabel(record.subjectType) }}</div>
              </template>
              <template v-else-if="column.key === 'status'">
                <GsTag :tone="statusTone(record.status)">{{ statusLabel(record.status) }}</GsTag>
              </template>
              <template v-else-if="column.key === 'receipt'">
                <span v-if="record.receipt" class="text-xs text-[var(--gs-fg-muted)]">
                  {{
                    $t('gainos.privacy.receiptSummary', {
                      contacts: record.receipt?.contactsErased ?? 0,
                      points: record.receipt?.contactPointsErased ?? 0,
                      evidence: record.receipt?.fieldEvidenceErased ?? 0,
                    })
                  }}
                </span>
                <span v-else class="text-xs text-[var(--gs-fg-subtle)]">—</span>
              </template>
              <template v-else-if="column.key === 'createdAt'">
                <span class="text-xs text-[var(--gs-fg-muted)]">{{ fmtTime(record.createdAt) }}</span>
              </template>
            </template>
          </GsTable>

          <Button v-if="hasMore" :loading="loadingMore" block data-gs="privacy-load-more" @click="loadRequests(false)">
            {{ $t('gainos.privacy.loadMore') }}
          </Button>
          <p class="m-0 text-xs leading-relaxed text-[var(--gs-fg-subtle)]">{{ $t('gainos.privacy.trackedNote') }}</p>
        </div>
      </GsCard>

      <WalletBillingCard :is-admin="isAdmin" />

      <DataExportsCard :is-admin="isAdmin" />

      <WorkspaceOffboardingCard
        :is-admin="isAdmin"
        :workspace-id="workspaceId"
        :workspace-name="workspaceName"
      />
    </div>
  </SettingsShell>
</template>
