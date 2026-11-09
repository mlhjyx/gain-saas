<script lang="ts" setup>
/**
 * 通知页（v3.0 ch07 QW16）：顶栏「查看全部」的落点。
 * 同一对象（type + refId）的多条通知合并成一行并计数，避免 30 秒轮询把
 * 同一件事重复堆十几条；全部已读是危险面操作，二次确认。
 */
import type { AppNotification } from '#/api/gainos';

import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { preferences } from '@vben/preferences';

import { Alert, Button } from 'ant-design-vue';

import { $t } from '#/locales';

import PageContainer from '#/components/gainos/page-container.vue';

import { formatDateTime } from '@gain-saas/shared';

import AsyncSection from '#/components/gainos/async-section.vue';
import PageHeader from '#/components/gainos/page-header.vue';

import { failureText, gainosApi } from '#/api/gainos';

defineOptions({ name: 'Notifications' });

interface NotificationGroup {
  type: string;
  refId: string | null;
  rows: AppNotification[];
  latest: AppNotification;
  unread: number;
}

const router = useRouter();
const items = ref<AppNotification[]>([]);
const unreadCount = ref(0);
const loading = ref(true);
const error = ref<{ title: string; next?: string } | null>(null);
const confirming = ref(false);
const marking = ref(false);
const notice = ref<string | null>(null);

function titleOf(row: AppNotification): string {
  const server = preferences.app.locale === 'en-US' ? (row.titleEn ?? row.title) : row.title;
  if (server) return server;
  const key = `gainos.notifications.${row.type}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? $t('gainos.notifications.default') : translated;
}

const groups = computed<NotificationGroup[]>(() => {
  const map = new Map<string, NotificationGroup>();
  for (const row of items.value) {
    const key = `${row.type}:${row.refId ?? ''}`;
    const existing = map.get(key);
    if (existing) {
      existing.rows.push(row);
      if (!row.readAt) existing.unread += 1;
      if (row.createdAt > existing.latest.createdAt) existing.latest = row;
    } else {
      map.set(key, {
        type: row.type,
        refId: row.refId ?? null,
        rows: [row],
        latest: row,
        unread: row.readAt ? 0 : 1,
      });
    }
  }
  return [...map.values()].sort((a, b) =>
    b.latest.createdAt.localeCompare(a.latest.createdAt),
  );
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const page = (await gainosApi.notifications()) as unknown as {
      data?: { items?: AppNotification[]; unreadCount?: number };
      items?: AppNotification[];
      unreadCount?: number;
    };
    items.value = page.items ?? page.data?.items ?? [];
    unreadCount.value = page.unreadCount ?? page.data?.unreadCount ?? 0;
  } catch (err) {
    error.value = failureText(err);
    items.value = [];
  } finally {
    loading.value = false;
  }
}

async function open(group: NotificationGroup): Promise<void> {
  const row = group.latest;
  const unreadRows = group.rows.filter((item) => !item.readAt);
  if (unreadRows.length > 0) {
    await Promise.all(
      unreadRows.map((item) =>
        gainosApi.readNotification(item.id).catch(() => undefined),
      ),
    );
    const now = new Date().toISOString();
    unreadRows.forEach((item) => (item.readAt = now));
    group.unread = 0;
    unreadCount.value = Math.max(0, unreadCount.value - unreadRows.length);
  }
  if (row.link) {
    if (row.link.startsWith('http://') || row.link.startsWith('https://')) {
      window.open(row.link, '_blank');
      return;
    }
    void router.push(row.link);
  }
}

async function markAllRead(): Promise<void> {
  marking.value = true;
  notice.value = null;
  try {
    await gainosApi.readAllNotifications();
    const now = new Date().toISOString();
    items.value.forEach((row) => (row.readAt = row.readAt ?? now));
    unreadCount.value = 0;
    notice.value = $t('gainos.notifications.markAllDone');
  } catch (err) {
    error.value = failureText(err);
  } finally {
    marking.value = false;
    confirming.value = false;
  }
}

onMounted(load);
</script>

<template>
  <PageContainer>
    <PageHeader
      :subtitle="$t('gainos.notifications.pageSubtitle')"
      :title="$t('gainos.notifications.pageTitle')"
    >
      <template #actions>
        <Button :loading="loading && marking" @click="load">
          {{ $t('gainos.common.refresh') }}
        </Button>
        <template v-if="confirming">
          <Button danger :disabled="marking" :loading="marking" @click="markAllRead">
            {{ $t('gainos.notifications.markAllConfirm') }}
          </Button>
          <Button :disabled="marking" @click="confirming = false">
            {{ $t('gainos.common.cancel') }}
          </Button>
        </template>
        <Button
          v-else
          type="primary"
          :disabled="unreadCount === 0"
          @click="confirming = true"
        >
          {{ $t('gainos.notifications.markAll') }}
          <span v-if="unreadCount > 0" class="nt__count">{{ unreadCount }}</span>
        </Button>
      </template>
    </PageHeader>

    <Alert v-if="notice" :message="notice" role="status" show-icon type="success" />

    <AsyncSection
      :empty="!loading && !error && groups.length === 0"
      :error="error"
      :loading="loading"
      :loading-text="$t('gainos.common.loading')"
      :retry-text="$t('gainos.common.retry')"
      @retry="load"
    >
      <template #empty>
        <p>{{ $t('gainos.notifications.empty') }}</p>
      </template>

      <ol class="nt__list">
        <li v-for="group in groups" :key="`${group.type}:${group.refId ?? ''}`">
          <button
            class="nt__row"
            :class="{ 'is-unread': group.unread > 0 }"
            type="button"
            @click="open(group)"
          >
            <span class="nt__dot" :aria-hidden="group.unread === 0"></span>
            <span class="nt__body">
              <span class="nt__title">
                {{ titleOf(group.latest) }}
                <span v-if="group.rows.length > 1" class="nt__group-count">
                  {{ $t('gainos.notifications.groupCount', { count: group.rows.length }) }}
                </span>
              </span>
              <span v-if="group.latest.title" class="nt__time">
                {{ formatDateTime(group.latest.createdAt) }}
              </span>
            </span>
          </button>
        </li>
      </ol>
    </AsyncSection>
  </PageContainer>
</template>

<style scoped>
.nt__count {
  margin-left: 6px;
  border-radius: 999px;
  padding: 0 7px;
  font-size: 11.5px;
  background: rgba(255, 255, 255, 0.22);
}
.nt__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}
.nt__row {
  width: 100%;
  display: flex;
  gap: 12px;
  align-items: flex-start;
  text-align: left;
  border: 1px solid var(--gs-border);
  border-radius: 12px;
  background: var(--gs-surface);
  padding: 14px 16px;
  cursor: pointer;
}
.nt__row:hover {
  border-color: var(--gs-accent-soft-border);
}
.nt__row.is-unread {
  background: var(--gs-accent-soft);
}
.nt__dot {
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: 50%;
  background: var(--gs-accent-strong);
  flex: none;
}
.nt__dot[aria-hidden='true'] {
  visibility: hidden;
}
.nt__body {
  display: grid;
  gap: 4px;
}
.nt__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--gs-fg);
}
.nt__group-count {
  margin-left: 8px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--gs-fg-muted);
}
.nt__time {
  font-size: 12px;
  color: var(--gs-fg-subtle);
}
</style>
