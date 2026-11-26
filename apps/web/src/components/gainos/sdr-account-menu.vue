<script lang="ts" setup>
/**
 * 侧栏底部账号弹出菜单（PR-UI1）：
 * 优雅收纳深浅主题切换、中英文零刷新热切换、快捷键与帮助、设置与退出登录。
 * 全部图标走 @vben/icons 静态导出（零外网 Iconify 拉取）。
 */
import { computed, ref } from 'vue';

import {
  Bell,
  CircleHelp,
  Languages,
  LogOut,
  MoonStar,
  Search,
  Settings,
  Sun,
} from '@vben/icons';
import { preferences, usePreferences } from '@vben/preferences';

import { $t } from '#/locales';

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
  toggleLocale: [];
  toggleTheme: [];
}>();

const { isDark } = usePreferences();
const isEnglish = computed(() => preferences.app.locale === 'en-US');
const helpExpanded = ref(false);

const versionLabel = `${__APP_VERSION__}${
  __APP_COMMIT__ ? ` · ${__APP_COMMIT__}` : ''
}`;

const themeAriaLabel = computed(() =>
  isDark.value
    ? $t('gainosUi1.accountMenu.switchToLight')
    : $t('gainosUi1.accountMenu.switchToDark'),
);

const localeAriaLabel = computed(() =>
  isEnglish.value
    ? $t('gainosUi1.accountMenu.switchToZh')
    : $t('gainosUi1.accountMenu.switchToEn'),
);
</script>

<template>
  <div class="gs-account-menu" data-gs="account-menu" role="menu">
    <div class="gs-account-menu__head">
      <p class="gs-account-menu__name">{{ workspaceName || 'GainOS' }}</p>
      <p class="gs-account-menu__mail">{{ userEmail || '—' }}</p>
    </div>

    <div aria-hidden="true" class="gs-account-menu__sep"></div>

    <!-- 外观主题切换（深浅双主题） -->
    <button
      :aria-label="themeAriaLabel"
      class="gs-account-menu__item"
      data-gs="theme-toggle"
      role="menuitem"
      type="button"
      @click="emit('toggleTheme')"
    >
      <Sun v-if="isDark" :size="16" aria-hidden="true" />
      <MoonStar v-else :size="16" aria-hidden="true" />
      <span class="gs-account-menu__label">
        {{ $t('gainosUi1.accountMenu.themeLabel') }}
      </span>
      <span class="gs-account-menu__pill">
        {{ isDark ? $t('gainosUi1.accountMenu.themeDark') : $t('gainosUi1.accountMenu.themeLight') }}
      </span>
    </button>

    <!-- 中英文零刷新热切换（保留 Wave B3 保草稿能力） -->
    <button
      :aria-label="localeAriaLabel"
      class="gs-account-menu__item"
      data-gs="locale-toggle"
      role="menuitem"
      type="button"
      @click="emit('toggleLocale')"
    >
      <Languages :size="16" aria-hidden="true" />
      <span class="gs-account-menu__label">
        {{ $t('gainosUi1.accountMenu.localeLabel') }}
      </span>
      <span class="gs-account-menu__pill" data-gs="locale-indicator">
        {{ isEnglish ? 'EN' : '中' }}
      </span>
    </button>

    <div aria-hidden="true" class="gs-account-menu__sep"></div>

    <button
      class="gs-account-menu__item"
      role="menuitem"
      type="button"
      @click="emit('notifications')"
    >
      <Bell :size="16" aria-hidden="true" />
      <span class="gs-account-menu__label">
        {{ $t('gainosUi1.accountMenu.notifications') }}
      </span>
      <span
        v-if="(unreadCount ?? 0) > 0"
        class="gs-account-menu__count"
      >
        {{ (unreadCount ?? 0) > 99 ? '99+' : unreadCount }}
      </span>
    </button>

    <button
      class="gs-account-menu__item"
      role="menuitem"
      type="button"
      @click="emit('settings')"
    >
      <Settings :size="16" aria-hidden="true" />
      <span class="gs-account-menu__label">
        {{ $t('gainosUi1.accountMenu.settings') }}
      </span>
    </button>

    <button
      class="gs-account-menu__item"
      role="menuitem"
      type="button"
      @click="emit('search')"
    >
      <Search :size="16" aria-hidden="true" />
      <span class="gs-account-menu__label">
        {{ $t('gainosUi1.accountMenu.search') }}
      </span>
      <kbd class="gs-account-menu__kbd">⌘K</kbd>
    </button>

    <button
      :aria-expanded="helpExpanded"
      class="gs-account-menu__item"
      data-gs="account-help-toggle"
      role="menuitem"
      type="button"
      @click="helpExpanded = !helpExpanded"
    >
      <CircleHelp :size="16" aria-hidden="true" />
      <span class="gs-account-menu__label">
        {{ $t('gainosUi1.accountMenu.help') }}
      </span>
    </button>

    <div v-if="helpExpanded" class="sdr-help" data-gs="account-help-panel">
      <p class="sdr-help__title">{{ $t('gainosUi1.accountMenu.shortcutsTitle') }}</p>
      <p>
        <kbd>⌘K</kbd> / <kbd>Ctrl K</kbd> — {{ $t('gainosUi1.nav.searchPlaceholder') }}
      </p>
      <p class="sdr-help__muted">{{ $t('gainosUi1.accountMenu.shortcutsHint') }}</p>
      <p class="sdr-help__version">v{{ versionLabel }}</p>
    </div>

    <div aria-hidden="true" class="gs-account-menu__sep"></div>

    <button
      class="gs-account-menu__item gs-account-menu__item--danger"
      role="menuitem"
      type="button"
      @click="emit('logout')"
    >
      <LogOut :size="16" aria-hidden="true" />
      <span class="gs-account-menu__label">
        {{ $t('gainosUi1.accountMenu.logout') }}
      </span>
    </button>
  </div>
</template>

<style scoped>
.gs-account-menu {
  display: grid;
  gap: 2px;
  width: 260px;
  padding: 6px;
  border-radius: 12px;
  background: var(--gs-surface);
}

.gs-account-menu__head {
  display: grid;
  gap: 2px;
  padding: 6px 8px;
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
  color: var(--gs-fg-muted);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gs-account-menu__sep {
  height: 1px;
  margin: 4px -6px;
  background: var(--gs-border);
}

.gs-account-menu__item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 34px;
  padding: 0 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--gs-fg);
  font-size: 13px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.gs-account-menu__item :deep(svg) {
  flex: none;
  color: var(--gs-fg-subtle);
  transition: color 0.15s ease;
}

.gs-account-menu__item:hover {
  background: var(--gs-surface-2);
}

.gs-account-menu__item:hover :deep(svg) {
  color: var(--gs-fg);
}

.gs-account-menu__item:focus-visible {
  outline: none;
  box-shadow: var(--gs-shadow-focus);
}

.gs-account-menu__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gs-account-menu__pill {
  flex: none;
  padding: 1px 7px;
  border: 1px solid var(--gs-border);
  border-radius: 6px;
  background: var(--gs-surface-2);
  color: var(--gs-fg-2);
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
}

.gs-account-menu__count {
  flex: none;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--gs-accent);
  color: #ffffff;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.gs-account-menu__kbd,
.sdr-help kbd {
  padding: 0 5px;
  border: 1px solid var(--gs-border);
  border-radius: 5px;
  background: var(--gs-surface-2);
  color: var(--gs-fg-muted);
  font-family: inherit;
  font-size: 10.5px;
  line-height: 16px;
}

.sdr-help {
  display: grid;
  gap: 5px;
  margin: 2px 4px 4px;
  padding: 8px 10px;
  border: 1px solid var(--gs-border);
  border-radius: 8px;
  background: var(--gs-surface-3);
  font-size: 12px;
  color: var(--gs-fg);
}

.sdr-help p {
  margin: 0;
}

.sdr-help__title {
  font-weight: 600;
}

.sdr-help__muted {
  color: var(--gs-fg-muted);
  line-height: 17px;
}

.sdr-help__version {
  color: var(--gs-fg-subtle);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.gs-account-menu__item--danger {
  color: var(--gs-danger-fg);
}

.gs-account-menu__item--danger :deep(svg) {
  color: var(--gs-danger-fg);
}

.gs-account-menu__item--danger:hover {
  background: var(--gs-danger-bg);
}
</style>
