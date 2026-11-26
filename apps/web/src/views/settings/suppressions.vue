<script lang="ts" setup>
/**
 * 设置 · 禁联名单（C2，P6 设计 §3「设置：…禁联名单…」）。
 *
 * 数据走 BFF 既有代理（GET/POST /api/suppressions、DELETE /api/suppressions/:id，admin）。
 * 注意引擎语义：DELETE 是「解除申请」（append-only release request），不会物理删除——
 * 页面文案如实呈现，不给「删除成功」的假象。
 */
import { computed, onMounted, reactive, ref } from 'vue';

import { Alert, Button, Form, Input, Select, Skeleton, Table } from 'ant-design-vue';

import { feedback } from '#/feedback';
import { $t } from '#/locales';

import EmptyState from '#/components/gainos/empty-state.vue';
import SettingsShell from '#/components/gainos/settings-shell.vue';
import GsDrawer from '#/components/gainos/ui/gs-drawer.vue';
import GsEmpty from '#/components/gainos/ui/gs-empty.vue';
import GsTag from '#/components/gainos/ui/gs-tag.vue';

import { formatDate, formatDateTime } from '@gain-saas/shared';

import {
  failureText,
  gainosApi,
  type SuppressionReason,
  type SuppressionRecordView,
  type SuppressionType,
} from '#/api/gainos';
import {
  fetchSuppressionDecisions,
  type SuppressionDecisionView,
} from '#/api/settings-account';

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
    rows.value = page?.data ?? [];
    hasMore.value = Boolean(page?.page?.has_more);
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

function release(row: SuppressionRecordView): void {
  feedback.confirm({
    cancelText: $t('gainos.common.cancel'),
    content: $t('gainos.suppressions.releaseConfirm', { value: row.value }),
    okText: $t('gainos.suppressions.release'),
    okType: 'danger',
    onOk: async () => {
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
    },
  });
}

const typeOptions = computed(() =>
  TYPES.map((type) => ({ value: type, label: typeLabel(type) })),
);
const reasonOptions = computed(() =>
  REASONS.map((reason) => ({ value: reason, label: reasonLabel(reason) })),
);

const columns = computed(() => [
  { key: 'value', dataIndex: 'value', title: $t('gainos.suppressions.colValue') },
  { key: 'type', dataIndex: 'type', title: $t('gainos.suppressions.colType'), width: 130 },
  { key: 'reason', dataIndex: 'reason', title: $t('gainos.suppressions.colReason'), width: 130 },
  { key: 'protectionClass', dataIndex: 'protectionClass', title: $t('gainos.suppressions.colProtection'), width: 140 },
  { key: 'createdAt', dataIndex: 'createdAt', title: $t('gainos.suppressions.colCreated'), width: 130 },
  { key: 'actions', dataIndex: 'actions', title: '', width: 190 },
]);

// ── 解除/更正审批决策历史抽屉（GET /api/suppressions/:id/decisions）──
const decisionsOpen = ref(false);
const decisionsTarget = ref<SuppressionRecordView | null>(null);
const decisionsRows = ref<SuppressionDecisionView[]>([]);
const decisionsLoading = ref(false);
const decisionsLoadingMore = ref(false);
const decisionsError = ref<string | null>(null);
const decisionsCursor = ref<string | null>(null);
const decisionsHasMore = ref(false);

const KNOWN_DECISIONS = new Set([
  'RELEASE_REQUESTED',
  'RELEASE_REQUEST_DENIED',
  'IDENTITY_CORRECTION_REQUESTED',
]);

const KNOWN_DECISION_REASONS = new Set([
  'PREFERENCE_RELEASE',
  'LEGAL_SUPPRESSION_PROTECTED',
  'LEGAL_PROTECTED',
  'IDENTITY_MISMATCH',
  'DUPLICATE_IDENTITY',
  'OPERATOR_REQUEST',
  'ADMIN_REVIEW',
  'MANUAL',
]);

function decisionLabel(decision?: string | null): string {
  const code = decision && KNOWN_DECISIONS.has(decision) ? decision : 'UNKNOWN';
  return $t(`gainosB3.suppressions.decisions.decisionLabel.${code}` as Parameters<typeof $t>[0]);
}

function decisionTone(decision?: string | null): 'danger' | 'info' | 'neutral' | 'warning' {
  if (decision === 'RELEASE_REQUEST_DENIED') return 'danger';
  if (decision === 'RELEASE_REQUESTED') return 'info';
  if (decision === 'IDENTITY_CORRECTION_REQUESTED') return 'warning';
  return 'neutral';
}

function decisionReasonLabel(reasonCode?: string | null): string {
  if (!reasonCode) return $t('gainosB3.suppressions.decisions.reasonLabel.UNKNOWN');
  const normalized = reasonCode.trim().toUpperCase();
  const code = KNOWN_DECISION_REASONS.has(normalized) ? normalized : 'UNKNOWN';
  return $t(`gainosB3.suppressions.decisions.reasonLabel.${code}` as Parameters<typeof $t>[0]);
}

async function loadDecisions(reset = true): Promise<void> {
  const target = decisionsTarget.value;
  if (!target) return;
  if (reset) {
    decisionsLoading.value = true;
    decisionsCursor.value = null;
    decisionsHasMore.value = false;
  } else {
    decisionsLoadingMore.value = true;
  }
  decisionsError.value = null;
  try {
    const page = await fetchSuppressionDecisions(target.id, {
      limit: 50,
      ...(!reset && decisionsCursor.value ? { cursor: decisionsCursor.value } : {}),
    });
    const nextRows = page.data ?? [];
    if (reset) {
      decisionsRows.value = nextRows;
    } else {
      const seen = new Set(decisionsRows.value.map((item) => item.id));
      decisionsRows.value = [
        ...decisionsRows.value,
        ...nextRows.filter((item) => !seen.has(item.id)),
      ];
    }
    decisionsCursor.value = page.page?.next_cursor ?? null;
    decisionsHasMore.value = Boolean(page.page?.has_more && page.page?.next_cursor);
  } catch (err) {
    decisionsError.value = failureText(err).title;
  } finally {
    decisionsLoading.value = false;
    decisionsLoadingMore.value = false;
  }
}

function openDecisions(row: SuppressionRecordView): void {
  decisionsTarget.value = row;
  decisionsRows.value = [];
  decisionsOpen.value = true;
  void loadDecisions(true);
}

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

    <div v-if="loading" class="sp__state" role="status">
      <Skeleton active :title="false" :paragraph="{ rows: 4 }" />
      <span class="sp__state-sr">{{ $t('gainos.common.loading') }}</span>
    </div>
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
      <EmptyState v-if="rows.length === 0" :title="$t('gainos.suppressions.empty')">
        <template #actions>
          <Button type="primary" @click="$router.push('/leads')">{{ $t('gainos.leads.title') }}</Button>
          <Button @click="$router.push('/settings/audit')">{{ $t('gainos.audit.title') }}</Button>
        </template>
      </EmptyState>
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
            <div class="flex flex-wrap items-center gap-1">
              <Button
                data-gs="suppression-decisions-btn"
                size="small"
                type="link"
                @click="openDecisions(record as SuppressionRecordView)"
              >
                {{ $t('gainosB3.suppressions.decisions.button') }}
              </Button>
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
            </div>
          </template>
        </template>
      </Table>
      <p v-if="hasMore" class="sp__hint sp__more">
        <Button type="link" size="small" @click="loadMore">{{ $t('gainos.suppressions.loadMore') }}</Button>
      </p>
      <p class="sp__hint">{{ $t('gainos.suppressions.releaseHint') }}</p>
    </section>

    <GsDrawer
      v-model:open="decisionsOpen"
      :subtitle="
        decisionsTarget
          ? $t('gainosB3.suppressions.decisions.drawerSubtitle', { value: decisionsTarget.value })
          : undefined
      "
      :title="$t('gainosB3.suppressions.decisions.drawerTitle')"
      size="md"
    >
      <div class="grid gap-3" data-gs="suppression-decisions-drawer">
        <p class="m-0 text-xs leading-relaxed text-[var(--gs-fg-muted)]">
          {{ $t('gainosB3.suppressions.decisions.note') }}
        </p>

        <Skeleton v-if="decisionsLoading" active :paragraph="{ rows: 4 }" :title="false" />

        <Alert
          v-else-if="decisionsError"
          :message="decisionsError"
          role="alert"
          show-icon
          type="warning"
        >
          <template #action>
            <Button size="small" @click="loadDecisions(true)">{{ $t('gainos.common.retry') }}</Button>
          </template>
        </Alert>

        <GsEmpty
          v-else-if="decisionsRows.length === 0"
          :title="$t('gainosB3.suppressions.decisions.empty')"
          data-gs="suppression-decisions-empty"
          simple
        />

        <ul v-else class="m-0 grid list-none gap-2.5 p-0" data-gs="suppression-decisions-list">
          <li
            v-for="item in decisionsRows"
            :key="item.id"
            class="grid gap-1.5 rounded-xl border border-[var(--gs-border)] bg-[var(--gs-surface-2)] p-3"
          >
            <div class="flex flex-wrap items-center justify-between gap-2">
              <GsTag :tone="decisionTone(item.decision)">
                {{ decisionLabel(item.decision) }}
              </GsTag>
              <span class="text-xs text-[var(--gs-fg-muted)]">
                {{ formatDateTime(item.createdAt) || '—' }}
              </span>
            </div>
            <div class="text-xs text-[var(--gs-fg)]">
              {{ $t('gainosB3.suppressions.decisions.colReason') }}：{{
                decisionReasonLabel(item.reasonCode ?? item.requestedReasonCode)
              }}
            </div>
            <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--gs-fg-muted)]">
              <span>
                {{ $t('gainosB3.suppressions.decisions.colActor') }}：{{
                  $t('gainosB3.suppressions.decisions.actorAdmin')
                }}
              </span>
              <span v-if="item.requestedDecision && item.requestedDecision !== item.decision">
                {{ $t('gainosB3.suppressions.decisions.colRequested') }}：{{
                  decisionLabel(item.requestedDecision)
                }}
              </span>
            </div>
          </li>
        </ul>

        <Button
          v-if="decisionsHasMore"
          :loading="decisionsLoadingMore"
          block
          data-gs="suppression-decisions-load-more"
          @click="loadDecisions(false)"
        >
          {{ $t('gainosB3.suppressions.decisions.loadMore') }}
        </Button>
      </div>
    </GsDrawer>
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
.sp__state-sr {
  position: absolute;
  width: 1px; height: 1px;
  margin: -1px; padding: 0; border: 0;
  clip: rect(0 0 0 0); clip-path: inset(50%);
  overflow: hidden; white-space: nowrap;
}
</style>
