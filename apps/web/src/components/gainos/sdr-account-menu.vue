<script lang="ts" setup>
/**
 * 左下角账号菜单（AgentSDR Dropdown 同款，pass5 精修）。
 *
 * SDR 的账号卡点开后是：抬头（名称 + 邮箱）→ 分隔线 → 带图标的分区条目
 * （设置 / 搜索或跳转 ⌘K）→ 分隔线 → 退出登录（红色 + 红色 hover）。
 * 这里用同一套语言，标题/图标/分隔线/危险态全部对齐。
 */
import { computed } from 'vue';

import { IconifyIcon } from '@vben/icons';
import { preferences } from '@vben/preferences';

defineOptions({ name: 'SdrAccountMenu' });

defineProps<{
  unreadCount?: number;
  userEmail?: string;
  workspaceName?: string;
}>();

const emit = defineEmits<{
  logout: [];
  notifications: [];
  search: [];
  settings: [];
}>();

const isEnglish = computed(() => preferences.app.locale === 'en-US');
const labels = computed(() =>
  isEnglish.value
    ? {
        logout: 'Sign out',
        notifications: 'Notifications',
        search: 'Search or jump to',
        settings: 'Settings',
      }
    : {
        logout: '退出登录',
        notifications: '通知',
        search: '搜索或跳转',
        settings: '设置',
      },
);
</script>

<template>
  <div class="gs-account-menu" role="menu">
    <div class="gs-account-menu__head">
      <p class="gs-account-menu__name">{{ workspaceName || 'GainOS' }}</p>
      <p class="gs-account-menu__mail">{{ userEmail || '—' }}</p>
    </div>

    <div class="gs-account-menu__sep" aria-hidden="true"></div>

    <button
      type="button"
      class="gs-account-menu__item"
      role="menuitem"
      @click="emit('notifications')"
    >
      <IconifyIcon icon="lucide:bell" />
      <span class="gs-account-menu__label">{{ labels.notifications }}</span>
      <span
        v-if="(unreadCount ?? 0) > 0"
        class="gs-account-menu__dot"
        aria-hidden="true"
      ></span>
    </button>
    <button
      type="button"
      class="gs-account-menu__item"
      role="menuitem"
      @click="emit('settings')"
    >
      <IconifyIcon icon="lucide:settings" />
      <span class="gs-account-menu__label">{{ labels.settings }}</span>
    </button>
    <button
      type="button"
      class="gs-account-menu__item"
      role="menuitem"
      @click="emit('search')"
    >
      <IconifyIcon icon="lucide:search" />
      <span class="gs-account-menu__label">{{ labels.search }}</span>
      <kbd class="gs-account-menu__kbd">⌘K</kbd>
    </button>

    <div class="gs-account-menu__sep" aria-hidden="true"></div>

    <button
      type="button"
      class="gs-account-menu__item gs-account-menu__item--danger"
      role="menuitem"
      @click="emit('logout')"
    >
      <IconifyIcon icon="lucide:log-out" />
      <span class="gs-account-menu__label">{{ labels.logout }}</span>
    </button>
  </div>
</template>

<style scoped>
/* SDR：rounded-2xl + p-2 + ring-1 + 中阴影；条目 36px、圆角 8、图标 18。 */
.gs-account-menu {
  display: grid;
  gap: 2px;
  width: 264px;
  padding: 8px;
  border-radius: 16px;
  background: var(--gs-surface);
}

.gs-account-menu__head {
  display: grid;
  gap: 2px;
  padding: 4px 8px 8px;
}
.gs-account-menu__name {
  margin: 0;
  overflow: hidden;
  color: var(--gs-fg);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.011em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gs-account-menu__mail {
  margin: 0;
  overflow: hidden;
  color: var(--gs-fg-subtle);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gs-account-menu__sep {
  height: 1px;
  margin: 4px -8px;
  background: var(--gs-border);
}

.gs-account-menu__item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 36px;
  padding: 0 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--gs-fg);
  font-size: 13.5px;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.gs-account-menu__item :deep(svg) {
  width: 18px;
  height: 18px;
  flex: none;
  color: var(--gs-fg-subtle);
  transition: color 0.15s ease;
}
.gs-account-menu__item:hover {
  background: var(--gs-surface-2);
}
.gs-account-menu__item:hover :deep(svg) {
  color: var(--gs-fg-muted);
}
.gs-account-menu__item:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--gs-surface), 0 0 0 4px var(--gs-accent);
}

.gs-account-menu__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gs-account-menu__dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--gs-accent);
}
.gs-account-menu__kbd {
  padding: 0 5px;
  border: 1px solid var(--gs-border);
  border-radius: 5px;
  background: var(--gs-surface-2);
  color: var(--gs-fg-subtle);
  font-family: inherit;
  font-size: 10.5px;
  line-height: 16px;
}

/* 危险条目：红字 + 红色 hover 底（AlignUI destructive 同款）。 */
.gs-account-menu__item--danger {
  color: var(--gs-danger);
}
.gs-account-menu__item--danger :deep(svg) {
  color: var(--gs-danger);
}
.gs-account-menu__item--danger:hover {
  background: var(--gs-danger-bg);
}
</style>
