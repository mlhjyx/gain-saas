<script lang="ts" setup>
import type { OutreachReplyView } from '#/api/gainos';

import { onMounted, ref } from 'vue';

import { Button, Table } from 'ant-design-vue';

import { $t } from '#/locales';

import { formatDateTime } from '@gain-saas/shared';

import AsyncSection from '#/components/gainos/async-section.vue';
import PageContainer from '#/components/gainos/page-container.vue';
import PageHeader from '#/components/gainos/page-header.vue';

import { failureText, gainosApi } from '#/api/gainos';

/**
 * 回复收件箱（v3.0 第 7 章：回复要有落点）。
 * 任何回复/退信/退订都会在此出现；回复即停与退订由后端保证，这里只做可见与可核对。
 */
defineOptions({ name: 'OutreachReplies' });

defineProps<{ embedded?: boolean }>();

const rows = ref<OutreachReplyView[]>([]);
const loading = ref(false);
const error = ref<{ title: string; next?: string } | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const page = await gainosApi.outreachReplies();
    rows.value = page.data ?? [];
  } catch (err) {
    error.value = failureText(err);
    rows.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const CLASS_TONE: Record<string, string> = {
  POSITIVE: 'success',
  NEGATIVE: 'danger',
  NEUTRAL: 'neutral',
  OUT_OF_OFFICE: 'warning',
  UNKNOWN: 'neutral',
};

function classLabel(value?: string | null): string {
  const key = `gainos.replies.class.${value ?? 'UNKNOWN'}`;
  const text = $t(key);
  return text === key ? ($t('gainos.replies.class.UNKNOWN') as string) : text;
}

function classBadge(value?: string | null): string {
  return `gs-badge--${CLASS_TONE[value ?? 'UNKNOWN'] ?? 'neutral'}`;
}

function kindLabel(value?: string | null): string {
  const key = `gainos.replies.kind.${value ?? 'REPLY'}`;
  const text = $t(key);
  return text === key ? (value ?? '—') : text;
}

function fmtTime(ts?: string | null): string {
  return formatDateTime(ts) || '—';
}

const columns = [
  { key: 'receivedAt', dataIndex: 'receivedAt', title: $t('gainos.replies.colTime'), width: 170 },
  { key: 'recipientEmail', dataIndex: 'recipientEmail', title: $t('gainos.replies.colRecipient'), width: 240 },
  { key: 'classification', dataIndex: 'classification', title: $t('gainos.replies.colClass'), width: 190 },
  { key: 'subject', dataIndex: 'subject', title: $t('gainos.replies.colSubject') },
];
</script>

<template>
  <PageContainer :compact="embedded" :class="{ 'rpl--embedded': embedded }">
    <PageHeader :subtitle="$t('gainos.replies.subtitle')" :title="$t('gainos.replies.title')">
      <template #actions>
        <Button :loading="loading" @click="load">{{ $t('gainos.common.refresh') }}</Button>
      </template>
    </PageHeader>

    <AsyncSection
      :error="error"
      :empty="!loading && !error && rows.length === 0"
      :loading="loading"
      :loading-text="$t('gainos.common.loading')"
      :retry-text="$t('gainos.common.retry')"
      @retry="load"
    >
      <template #empty>
        <p>{{ $t('gainos.replies.empty') }}</p>
      </template>
      <Table
        :columns="columns"
        :data-source="rows"
        :pagination="false"
        :scroll="{ x: 720 }"
        row-key="id"
        size="middle"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'receivedAt'">{{ fmtTime(record.receivedAt) }}</template>
          <template v-else-if="column.key === 'recipientEmail'">{{ record.recipientEmail ?? '—' }}</template>
          <template v-else-if="column.key === 'classification'">
            <span class="gs-badge" :class="classBadge(record.classification)">{{ classLabel(record.classification) }}</span>
            <span class="rpl__kind">{{ kindLabel(record.kind) }}</span>
          </template>
          <template v-else-if="column.key === 'subject'">
            <span>{{ record.subject ?? '—' }}</span>
            <small v-if="record.snippet" class="rpl__snippet">{{ record.snippet }}</small>
          </template>
        </template>
      </Table>
    </AsyncSection>
  </PageContainer>
</template>

<style scoped>
.rpl--embedded { padding: 0; max-width: none; margin: 0; gap: 12px; }
.rpl__kind { margin-left: 8px; font-size: 12px; color: var(--gs-fg-subtle); }
.rpl__snippet { display: block; margin-top: 4px; color: var(--gs-fg-subtle); font-size: 12.5px; }
</style>
