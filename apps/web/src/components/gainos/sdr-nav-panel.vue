<script lang="ts" setup>
/**
 * 侧栏内容：搜索 + 分组导航 + 底部账号区（AgentSDR Sidebar 同款）。
 *
 * 桌面覆盖层与手机抽屉共用这一份，所以手机上同样有通知 / 设置 / 帮助，
 * 以及带「退出登录」的工作空间账号卡。容器（固定覆盖层 / 抽屉）由 sdr-sidebar 提供，
 * 这里只要求父级是纵向 flex 且高度受限：滚动区 flex:1，底部账号区常驻。
 */
import { computed, ref } from 'vue';

import { preferences } from '@vben/preferences';

import { IconifyIcon } from '@vben/icons';

import { Popover } from 'ant-design-vue';

import SdrAccountMenu from './sdr-account-menu.vue';
import { $t } from '#/locales';

import { useSdrNav } from './use-sdr-nav';

defineOptions({ name: 'SdrNavPanel' });

const props = defineProps<{
  /** 通知未读数（basic.vue 轮询，>0 显示红点）。 */
  unreadCount?: number;
  /** 用户头像 URL（空则用首字母兜底）。 */
  userAvatar?: string;
  /** 账号（邮箱/用户名），账号卡第二行。 */
  userEmail?: string;
  /** 工作空间名，账号卡第一行。 */
  workspaceName?: string;
}>();

const emit = defineEmits<{
  logout: [];
  openSearch: [];
  openSettings: [];
}>();

const { go, isActive, route, sections } = useSdrNav();

const isEnglish = computed(() => preferences.app.locale === 'en-US');
const searchLabel = computed(() =>
  isEnglish.value ? 'Search or jump to…' : '搜索或跳转…',
);

const footerLabels = computed(() =>
  isEnglish.value
    ? { help: 'Help', notifications: 'Notifications', settings: 'Settings' }
    : { help: '帮助', notifications: '通知', settings: '设置' },
);
const accountLabels = computed(() => ({
  expand: isEnglish.value ? 'Expand sidebar' : '展开侧栏',
  shortcuts: isEnglish.value ? 'Shortcuts' : '快捷键',
}));

const versionLabel = `${__APP_VERSION__}${
  __APP_COMMIT__ ? ` · ${__APP_COMMIT__}` : ''
}`;

/** 账号卡首字母兜底（无头像时）。 */
const initial = computed(() =>
  (props.workspaceName || props.userEmail || 'G').trim().slice(0, 1).toUpperCase(),
);

const settingsActive = computed(() => route.path.startsWith('/settings'));

const helpOpen = ref(false);

// 账号菜单（SdrAccountMenu）的动作：先收起浮层再执行。
const accountOpen = ref(false);
function accountAction(action: 'logout' | 'notifications' | 'search' | 'settings') {
  accountOpen.value = false;
  if (action === 'logout') emit('logout');
  if (action === 'notifications') go('/notifications');
  if (action === 'search') emit('openSearch');
  if (action === 'settings') emit('openSettings');
}
</script>

<template>
  <div class="sdr-panel">
    <!-- SDR「Jump to」搜索框（⌘K） -->
    <button
      type="button"
      class="sdr-search"
      :aria-label="searchLabel"
      @click="emit('openSearch')"
    >
      <IconifyIcon icon="lucide:search" />
      <span class="sdr-search__label">{{ searchLabel }}</span>
      <kbd>⌘K</kbd>
    </button>

    <div class="sdr-panel__scroll">
      <div
        v-for="section in sections"
        :key="section.label + section.items[0]?.path"
        class="sdr-section"
      >
        <p v-if="section.label" class="sdr-section__label">{{ $t(section.label) }}</p>
        <ul class="sdr-section__list">
          <li v-for="item in section.items" :key="item.path">
            <RouterLink
              :to="item.path"
              class="sdr-row"
              :class="{ 'is-active': isActive(item.path) }"
              role="menuitem"
              :aria-current="isActive(item.path) ? 'page' : undefined"
            >
              <IconifyIcon :icon="item.icon ?? 'lucide:circle-dot'" />
              <span class="sdr-row__label">{{ $t(item.label) }}</span>
            </RouterLink>
          </li>
        </ul>
      </div>
    </div>

    <!-- ── 底部：通知 / 设置 / 帮助 + 工作空间账号卡（AgentSDR 同款布局）── -->
    <footer class="sdr-footer">
      <div class="sdr-footer__rows" role="menu" :aria-label="footerLabels.settings">
        <RouterLink
          to="/notifications"
          class="sdr-row sdr-footer__row"
          role="menuitem"
        >
          <IconifyIcon icon="lucide:bell" />
          <span class="sdr-row__label">{{ footerLabels.notifications }}</span>
          <span
            v-if="(unreadCount ?? 0) > 0"
            class="sdr-footer__dot"
            aria-hidden="true"
          ></span>
        </RouterLink>
        <!-- pass5：设置打开设置弹窗（SDR 的 SettingsShell），不再占导航分组。 -->
        <button
          type="button"
          class="sdr-row sdr-footer__row"
          :class="{ 'is-active': settingsActive }"
          role="menuitem"
          :aria-current="settingsActive ? 'page' : undefined"
          @click="emit('openSettings')"
        >
          <IconifyIcon icon="lucide:settings" />
          <span class="sdr-row__label">{{ footerLabels.settings }}</span>
        </button>
        <Popover v-model:open="helpOpen" placement="rightTop" trigger="click">
          <template #content>
            <div class="sdr-help">
              <p class="sdr-help__title">{{ accountLabels.shortcuts }}</p>
              <p><kbd>⌘K</kbd> / <kbd>Ctrl K</kbd> — {{ searchLabel }}</p>
              <p class="sdr-help__muted">
                {{ isEnglish ? 'Theme, language and account live in the sidebar.' : '主题、语言与账号都在侧边栏。' }}
              </p>
              <p class="sdr-help__version">v{{ versionLabel }}</p>
            </div>
          </template>
          <button type="button" class="sdr-row sdr-footer__row" role="menuitem">
            <IconifyIcon icon="lucide:circle-help" />
            <span class="sdr-row__label">{{ footerLabels.help }}</span>
          </button>
        </Popover>
      </div>

      <Popover
        v-model:open="accountOpen"
        trigger="click"
        placement="topLeft"
        :arrow="false"
        overlay-class-name="gs-account-pop"
      >
        <template #content>
          <SdrAccountMenu
            :unread-count="unreadCount"
            :user-email="userEmail"
            :workspace-name="workspaceName"
            @logout="accountAction('logout')"
            @notifications="accountAction('notifications')"
            @search="accountAction('search')"
            @settings="accountAction('settings')"
          />
        </template>
        <button
          type="button"
          class="sdr-account"
          :aria-label="workspaceName || userEmail || 'Account'"
        >
          <img v-if="userAvatar" class="sdr-account__avatar" :src="userAvatar" alt="" />
          <span v-else class="sdr-account__avatar sdr-account__avatar--fallback" aria-hidden="true">
            {{ initial }}
          </span>
          <span class="sdr-account__body">
            <strong class="sdr-account__name">{{ workspaceName || 'GainOS' }}</strong>
            <small class="sdr-account__email">{{ userEmail || '—' }}</small>
          </span>
          <svg class="sdr-account__more" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none" />
            <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
            <circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none" />
          </svg>
        </button>
      </Popover>
    </footer>
  </div>
</template>

<style scoped>
/* 父级是纵向 flex：滚动区吃掉剩余高度，底部账号区常驻。 */
.sdr-panel {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  width: 100%;
}
.sdr-panel__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  pointer-events: auto;
  scrollbar-width: thin;
}

/* SDR「Jump to」搜索框：h-9 ring-1 白底 subtle 阴影 */
.sdr-search {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 36px;
  margin-bottom: 8px;
  padding: 0 10px;
  border: 1px solid var(--gs-border);
  border-radius: 8px;
  background: var(--gs-surface);
  color: var(--gs-fg-muted);
  font-size: 13px;
  cursor: pointer;
  box-shadow: var(--gs-shadow-xs);
  pointer-events: auto;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.sdr-search:hover {
  border-color: var(--gs-accent);
  color: var(--gs-accent-strong);
}
.sdr-search :deep(svg) { width: 15px; height: 15px; flex: none; }
.sdr-search__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sdr-search kbd,
.sdr-help kbd {
  padding: 0 5px;
  border: 1px solid var(--gs-border);
  border-radius: 5px;
  background: var(--gs-surface-2);
  color: var(--gs-fg-subtle);
  font-family: inherit;
  font-size: 10.5px;
  line-height: 15px;
}

/* 分组：小标签（SDR 12px 灰）+ 行列表 */
.sdr-section { margin-top: 12px; }
.sdr-section:first-child { margin-top: 0; }
.sdr-section__label {
  margin: 0 0 2px;
  padding: 0 8px;
  color: var(--gs-fg-subtle);
  font-size: 12px;
  line-height: 20px;
  font-weight: 500;
}
.sdr-section__list {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* SDR 菜单行：h-9 / rounded-lg(8px) / px-2 / 500 */
.sdr-row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 36px;
  padding: 0 8px;
  border-radius: 8px;
  color: var(--gs-fg-muted);
  font-size: 14px;
  font-weight: 500;
  text-decoration: none;
  outline: none;
  background: transparent;
  border: 0;
  width: 100%;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.sdr-row :deep(svg) {
  width: 18px;
  height: 18px;
  flex: none;
  color: var(--gs-fg-subtle);
  transition: color 0.15s ease;
}
.sdr-row:hover {
  background: var(--gs-surface-2);
  color: var(--gs-fg);
}
.sdr-row:hover :deep(svg) { color: var(--gs-fg-muted); }
/* SDR active：灰底药丸 + 近黑文字 + 实心图标（无彩条） */
.sdr-row.is-active {
  background: var(--gs-surface-2);
  color: var(--gs-fg);
}
.sdr-row.is-active :deep(svg) { color: var(--gs-fg); }
.sdr-row:focus-visible {
  box-shadow: 0 0 0 2px var(--gs-surface), 0 0 0 4px var(--gs-accent);
}
.sdr-row__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 底部账号区（AgentSDR：分隔线 + 固定行 + 工作空间卡）── */
.sdr-footer {
  flex: none;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--gs-divider);
  display: grid;
  gap: 8px;
  pointer-events: auto;
}
.sdr-footer__rows { display: grid; gap: 2px; }
.sdr-footer__row { height: 32px; font-size: 13px; }
.sdr-footer__row :deep(svg) { width: 16px; height: 16px; }
.sdr-footer__dot {
  flex: none;
  width: 7px;
  height: 7px;
  margin-right: 2px;
  border-radius: 50%;
  background: var(--gs-accent);
}
.sdr-account {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 8px;
  border: 1px solid var(--gs-border);
  border-radius: 12px;
  background: var(--gs-surface);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.sdr-account:hover {
  border-color: var(--gs-border-strong);
  background: var(--gs-surface-2);
}
.sdr-account__avatar {
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: 8px;
  object-fit: cover;
}
.sdr-account__avatar--fallback {
  display: grid;
  place-items: center;
  background: var(--gs-accent);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
}
.sdr-account__body {
  display: grid;
  gap: 1px;
  min-width: 0;
  flex: 1;
}
.sdr-account__name {
  overflow: hidden;
  color: var(--gs-fg);
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sdr-account__email {
  overflow: hidden;
  color: var(--gs-fg-subtle);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sdr-account__more {
  width: 16px;
  height: 16px;
  flex: none;
  color: var(--gs-fg-subtle);
}
.sdr-help {
  display: grid;
  gap: 6px;
  max-width: 250px;
  font-size: 12.5px;
}
.sdr-help p { margin: 0; }
.sdr-help__title { font-weight: 600; }
.sdr-help__muted { color: var(--gs-fg-muted); }
.sdr-help__version { color: var(--gs-fg-subtle); font-size: 11px; }
</style>
