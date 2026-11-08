<script lang="ts" setup>
import type { OutreachReplyView } from '#/api/gainos';

import { onMounted, ref } from 'vue';

import { $t } from '#/locales';

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
  return ts ? new Date(ts).toLocaleString() : '—';
}
</script>

<template>
  <div class="rpl" :class="{ 'is-embedded': embedded }">
    <header class="rpl__head">
      <div>
        <h2>{{ $t('gainos.replies.title') }}</h2>
        <p class="rpl__sub">{{ $t('gainos.replies.subtitle') }}</p>
      </div>
      <button class="rpl__refresh" type="button" @click="load">{{ $t('gainos.common.refresh') }}</button>
    </header>

    <p v-if="loading" class="rpl__muted">{{ $t('gainos.common.loading') }}</p>
    <div v-else-if="error" class="rpl__error" role="alert">
      <strong>{{ error.title }}</strong>
      <p v-if="error.next">{{ error.next }}</p>
      <button type="button" @click="load">{{ $t('gainos.common.retry') }}</button>
    </div>
    <section v-else-if="rows.length === 0" class="rpl__empty">
      <p>{{ $t('gainos.replies.empty') }}</p>
    </section>
    <table v-else class="rpl__table">
      <thead>
        <tr>
          <th>{{ $t('gainos.replies.colTime') }}</th>
          <th>{{ $t('gainos.replies.colRecipient') }}</th>
          <th>{{ $t('gainos.replies.colClass') }}</th>
          <th>{{ $t('gainos.replies.colSubject') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id">
          <td>{{ fmtTime(row.receivedAt) }}</td>
          <td>{{ row.recipientEmail ?? '—' }}</td>
          <td>
            <span class="gs-badge" :class="classBadge(row.classification)">{{ classLabel(row.classification) }}</span>
            <span class="rpl__kind">{{ kindLabel(row.kind) }}</span>
          </td>
          <td>
            <span>{{ row.subject ?? '—' }}</span>
            <small v-if="row.snippet" class="rpl__snippet">{{ row.snippet }}</small>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.rpl { padding: clamp(18px, 2.4vw, 32px) clamp(18px, 2.4vw, 34px) clamp(32px, 4vh, 48px); max-width: 1280px; margin: 0 auto; display: grid; gap: 16px; }
.rpl.is-embedded { padding: 0; max-width: none; margin: 0; }
.rpl__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.rpl__head h2 { margin: 0; font-size: 22px; font-weight: 600; color: var(--gs-fg); }
.rpl__sub { margin: 6px 0 0; font-size: 13.5px; line-height: 1.7; color: var(--gs-fg-muted); }
.rpl__refresh { flex: none; border: 1px solid var(--gs-border-strong); background: var(--gs-surface); border-radius: 10px; padding: 8px 16px; font-size: 13px; color: var(--gs-fg-2); cursor: pointer; }
.rpl__muted { color: var(--gs-fg-subtle); font-size: 13px; }
.rpl__error { border: 1px solid var(--gs-danger-border); background: var(--gs-danger-bg); border-radius: 12px; padding: 14px 16px; display: grid; gap: 8px; color: var(--gs-danger); }
.rpl__error button { justify-self: start; border: 1px solid var(--gs-danger-border); background: var(--gs-surface); border-radius: 8px; padding: 6px 14px; cursor: pointer; color: var(--gs-danger); }
.rpl__empty { border: 1px dashed var(--gs-border-dashed); border-radius: 16px; background: var(--gs-surface); padding: 40px 24px; text-align: center; color: var(--gs-fg-muted); font-size: 13.5px; }
.rpl__empty p { margin: 0; }
.rpl__table { width: 100%; border-collapse: collapse; background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px; overflow: hidden; }
.rpl__table th { text-align: left; font-size: 12px; font-weight: 600; color: var(--gs-fg-muted); background: var(--gs-surface-2); padding: 10px 14px; border-bottom: 1px solid var(--gs-border); }
.rpl__table td { padding: 12px 14px; border-bottom: 1px solid var(--gs-divider); font-size: 13.5px; color: var(--gs-fg-2); vertical-align: top; }
.rpl__table tr:last-child td { border-bottom: none; }
.rpl__kind { margin-left: 8px; font-size: 12px; color: var(--gs-fg-subtle); }
.rpl__snippet { display: block; margin-top: 4px; color: var(--gs-fg-subtle); font-size: 12.5px; }
</style>
