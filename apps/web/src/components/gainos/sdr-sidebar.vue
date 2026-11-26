<script lang="ts" setup>
/**
 * GainOS 左侧展示目录（PR-UI1 对标 Linear / Attio）：
 *
 * - 微冷灰侧栏表面（--gs-sidebar-bg：#F7F8FA / #111318）+ 1px 右细线衬出纯白/深墨主画布；
 * - 顶区 48px 企业头与顶栏底线严丝合缝平齐：[G] <workspaceName || 'GainOS'> + 简洁折叠按钮；
 * - 全部图标走 @vben/icons 静态导出与 SdrIcon 静态矢量（0ms 首屏即显，彻底消灭图标闪断）；
 * - 桌面展开 / 桌面折叠窄栏 / 手机抽屉三态共用同一份菜单与账号菜单。
 */
import { computed, ref, watch } from 'vue';

import { Search, Settings, X } from '@vben/icons';
import { preferences, usePreferences } from '@vben/preferences';
import { Drawer, Popover } from 'ant-design-vue';

import { isFlowPath } from '#/composables/use-main-chain-progress';
import { $t } from '#/locales';

import FlowProgressBar from './flow-progress-bar.vue';
import SdrAccountMenu from './sdr-account-menu.vue';
import SdrIcon from './sdr-icon.vue';
import SdrNavPanel from './sdr-nav-panel.vue';
import { useSdrNav } from './use-sdr-nav';

defineOptions({ name: 'SdrSidebar' });

const props = defineProps<{
  logoSrc?: string;
  unreadCount?: number;
  userAvatar?: string;
  userEmail?: string;
  workspaceName?: string;
}>();

/** 手机抽屉开关（汉堡按钮位于 48px 极简顶栏左侧）。 */
const mobileOpen = defineModel<boolean>('open', { default: false });

const emit = defineEmits<{
  logout: [];
  openSearch: [];
  openSettings: [];
  toggleCollapse: [];
  toggleLocale: [];
  toggleTheme: [];
}>();

const { isMobile, sidebarCollapsed } = usePreferences();
const { flatLeaves, go, isActive, route } = useSdrNav();

const navLabel = computed(() => $t('gainosUi1.nav.mainNav'));
const searchLabel = computed(() => $t('gainosUi1.nav.searchPlaceholder'));
const collapseLabel = computed(() => $t('gainosUi1.nav.toggleSidebar'));
const expandLabel = computed(() => $t('gainosUi1.nav.expandSidebar'));
const closeLabel = computed(() => $t('gainosUi1.nav.closeMenu'));
const settingsLabel = computed(() => $t('gainosUi1.nav.settings'));
const showFlowChip = computed(() => isFlowPath(route.path));
const settingsActive = computed(() => route.path.startsWith('/settings'));

const showRail = computed(
  () => !isMobile.value && sidebarCollapsed.value && !preferences.sidebar.hidden,
);
const showFull = computed(
  () =>
    !isMobile.value &&
    !sidebarCollapsed.value &&
    !preferences.sidebar.hidden,
);

const navStyle = computed(() => ({
  width: `${preferences.sidebar.width}px`,
}));

const railStyle = computed(() => ({
  width: `${preferences.sidebar.collapseWidth}px`,
}));

// 路由变化时自动收起手机抽屉。
watch(
  () => route.fullPath,
  () => {
    mobileOpen.value = false;
  },
);

const initial = computed(() =>
  (props.userEmail || props.workspaceName || 'G').trim().slice(0, 1).toUpperCase(),
);

const railAccountOpen = ref(false);
function railAccountAction(action: 'logout' | 'notifications' | 'search' | 'settings') {
  railAccountOpen.value = false;
  if (action === 'logout') emit('logout');
  if (action === 'notifications') go('/notifications');
  if (action === 'search') emit('openSearch');
  if (action === 'settings') emit('openSettings');
}

function fromDrawer(action: 'search' | 'settings') {
  mobileOpen.value = false;
  if (action === 'search') emit('openSearch');
  else emit('openSettings');
}
</script>

<template>
  <!-- 桌面展开侧栏（220px 默认宽，顶区 48px 企业头与顶栏底线平齐） -->
  <nav
    v-if="showFull"
    :aria-label="navLabel"
    :style="navStyle"
    class="sdr-nav"
    data-sdr-nav
  >
    <header class="sdr-brand" data-gs="sidebar-brand">
      <RouterLink
        :title="workspaceName || 'GainOS'"
        class="sdr-brand__identity"
        to="/workspace"
      >
        <img v-if="logoSrc" :src="logoSrc" alt="GainOS" class="sdr-brand__logo" />
        <span class="sdr-brand__name" data-gs="sidebar-workspace-name">
          {{ workspaceName || 'GainOS' }}
        </span>
      </RouterLink>
      <button
        :aria-label="collapseLabel"
        :title="collapseLabel"
        class="sdr-brand__collapse"
        data-gs="sidebar-collapse"
        type="button"
        @click="emit('toggleCollapse')"
      >
        <SdrIcon :size="16" name="lucide:panel-left-close" />
      </button>
    </header>

    <SdrNavPanel
      :unread-count="unreadCount"
      :user-avatar="userAvatar"
      :user-email="userEmail"
      :workspace-name="workspaceName"
      @logout="emit('logout')"
      @open-search="emit('openSearch')"
      @open-settings="emit('openSettings')"
      @toggle-locale="emit('toggleLocale')"
      @toggle-theme="emit('toggleTheme')"
    />
  </nav>

  <!-- 折叠态图标窄栏（60px rail） -->
  <nav
    v-else-if="showRail"
    :aria-label="navLabel"
    :style="railStyle"
    class="sdr-rail"
    data-sdr-nav
  >
    <header class="sdr-rail__brand">
      <RouterLink
        :aria-label="workspaceName || 'GainOS'"
        :title="workspaceName || 'GainOS'"
        class="sdr-rail__logo-link"
        to="/workspace"
      >
        <img v-if="logoSrc" :src="logoSrc" alt="GainOS" class="sdr-brand__logo" />
      </RouterLink>
    </header>

    <div class="sdr-rail__body">
      <button
        :aria-label="searchLabel"
        :title="searchLabel"
        class="sdr-rail__search"
        type="button"
        @click="emit('openSearch')"
      >
        <Search :size="15" aria-hidden="true" />
      </button>

      <div class="sdr-rail__scroll">
        <button
          v-for="item in flatLeaves"
          :key="item.path"
          :aria-current="isActive(item.path) ? 'page' : undefined"
          :aria-label="$t(item.label)"
          :class="{ 'is-active': isActive(item.path) }"
          :title="$t(item.label)"
          class="sdr-rail__item"
          role="menuitem"
          type="button"
          @click="go(item.path)"
        >
          <SdrIcon :name="item.icon" :size="17" />
          <i
            v-if="item.path === '/notifications' && (unreadCount ?? 0) > 0"
            aria-hidden="true"
            class="sdr-rail__dot"
            data-gs="nav-unread"
          ></i>
        </button>
      </div>

      <div class="sdr-rail__footer">
        <FlowProgressBar v-if="showFlowChip" compact />

        <button
          :aria-current="settingsActive ? 'page' : undefined"
          :aria-label="settingsLabel"
          :class="{ 'is-active': settingsActive }"
          :title="settingsLabel"
          class="sdr-rail__item"
          data-gs="nav-settings"
          role="menuitem"
          type="button"
          @click="emit('openSettings')"
        >
          <Settings :size="17" aria-hidden="true" />
        </button>

        <button
          :aria-label="expandLabel"
          :title="expandLabel"
          class="sdr-rail__expand"
          type="button"
          @click="emit('toggleCollapse')"
        >
          <SdrIcon :size="16" name="lucide:panel-left-open" />
        </button>

        <Popover
          v-model:open="railAccountOpen"
          :arrow="false"
          overlay-class-name="gs-account-pop"
          placement="rightBottom"
          trigger="click"
        >
          <template #content>
            <SdrAccountMenu
              :unread-count="unreadCount"
              :user-email="userEmail"
              :workspace-name="workspaceName"
              @logout="railAccountAction('logout')"
              @notifications="railAccountAction('notifications')"
              @search="railAccountAction('search')"
              @settings="railAccountAction('settings')"
              @toggle-locale="emit('toggleLocale')"
              @toggle-theme="emit('toggleTheme')"
            />
          </template>
          <button
            :aria-label="userEmail || workspaceName || $t('gainosUi1.nav.account')"
            :title="userEmail || workspaceName || 'GainOS'"
            class="sdr-rail__account"
            data-gs="account-trigger"
            type="button"
          >
            <img v-if="userAvatar" :src="userAvatar" alt="" />
            <span v-else aria-hidden="true">{{ initial }}</span>
          </button>
        </Popover>
      </div>
    </div>
  </nav>

  <!-- 移动端抽屉（< 768px） -->
  <Drawer
    v-if="isMobile"
    v-model:open="mobileOpen"
    :body-style="{
      background: 'var(--gs-sidebar-bg)',
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
      overflow: 'hidden',
      padding: 0,
    }"
    :closable="false"
    :header-style="{ display: 'none' }"
    placement="left"
    width="min(280px, 84vw)"
  >
    <div id="gainos-mobile-nav" class="sdr-mobile" data-gs="mobile-nav">
      <header class="sdr-brand sdr-mobile__brand">
        <RouterLink
          :title="workspaceName || 'GainOS'"
          class="sdr-brand__identity"
          to="/workspace"
        >
          <img v-if="logoSrc" :src="logoSrc" alt="GainOS" class="sdr-brand__logo" />
          <span class="sdr-brand__name">{{ workspaceName || 'GainOS' }}</span>
        </RouterLink>
        <button
          :aria-label="closeLabel"
          class="sdr-brand__collapse"
          type="button"
          @click="mobileOpen = false"
        >
          <X :size="16" aria-hidden="true" />
        </button>
      </header>
      <SdrNavPanel
        :unread-count="unreadCount"
        :user-avatar="userAvatar"
        :user-email="userEmail"
        :workspace-name="workspaceName"
        @logout="emit('logout')"
        @open-search="fromDrawer('search')"
        @open-settings="fromDrawer('settings')"
        @toggle-locale="emit('toggleLocale')"
        @toggle-theme="emit('toggleTheme')"
      />
    </div>
  </Drawer>
</template>

<style scoped>
.sdr-nav {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  /* 侧栏 aside 自身 z-index=201，覆盖层更高以承接交互，底色与右细线统一由令牌驱动。 */
  z-index: 202;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--gs-border);
  background: var(--gs-sidebar-bg);
  box-sizing: border-box;
  transition: width 0.2s ease-out;
}

/* 顶区企业头：严格 48px 高 + 1px 底细线，与右侧极简顶栏底线水平齐平 */
.sdr-brand {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  height: 48px;
  padding: 0 10px 0 14px;
  border-bottom: 1px solid var(--gs-border);
  box-sizing: border-box;
}

.sdr-brand__identity {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  text-decoration: none;
  color: var(--gs-fg);
}

.sdr-brand__logo {
  width: 22px;
  height: 22px;
  flex: none;
  border-radius: 6px;
  object-fit: contain;
}

.sdr-brand__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--gs-fg);
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: -0.015em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sdr-brand__collapse {
  display: grid;
  place-items: center;
  flex: none;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--gs-fg-subtle);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.sdr-brand__collapse:hover {
  background: var(--gs-sidebar-hover);
  color: var(--gs-fg);
}

.sdr-brand__collapse:focus-visible {
  outline: none;
  box-shadow: var(--gs-shadow-focus);
}

/* 折叠态图标窄栏（60px） */
.sdr-rail {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  z-index: 202;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--gs-border);
  background: var(--gs-sidebar-bg);
  box-sizing: border-box;
}

.sdr-rail__brand {
  display: grid;
  place-items: center;
  flex: none;
  height: 48px;
  border-bottom: 1px solid var(--gs-border);
  box-sizing: border-box;
}

.sdr-rail__logo-link {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 8px;
}

.sdr-rail__body {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: 4px;
  padding: 10px 10px 10px;
}

.sdr-rail__search {
  display: grid;
  place-items: center;
  flex: none;
  height: 34px;
  margin-bottom: 4px;
  border: 1px solid var(--gs-border);
  border-radius: 8px;
  background: var(--gs-surface);
  color: var(--gs-fg-muted);
  cursor: pointer;
}

.sdr-rail__search:hover {
  border-color: var(--gs-border-strong);
  color: var(--gs-fg);
}

.sdr-rail__scroll {
  display: grid;
  gap: 2px;
  align-content: start;
  overflow-y: auto;
  min-height: 0;
  flex: 1;
  scrollbar-width: none;
}

.sdr-rail__item {
  position: relative;
  display: grid;
  place-items: center;
  height: 34px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--gs-fg-subtle);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.sdr-rail__item:hover {
  background: var(--gs-sidebar-hover);
  color: var(--gs-fg);
}

.sdr-rail__item.is-active {
  background: var(--gs-sidebar-active);
  color: var(--gs-fg);
}

.sdr-rail__dot {
  position: absolute;
  top: 6px;
  right: 7px;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--gs-accent);
}

.sdr-rail__footer {
  flex: none;
  display: grid;
  gap: 4px;
  padding-top: 8px;
  border-top: 1px solid var(--gs-border);
}

.sdr-rail__expand {
  display: grid;
  place-items: center;
  height: 32px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--gs-fg-subtle);
  cursor: pointer;
}

.sdr-rail__expand:hover {
  background: var(--gs-sidebar-hover);
  color: var(--gs-fg);
}

.sdr-rail__account {
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  height: 34px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}

.sdr-rail__account:hover {
  background: var(--gs-sidebar-hover);
}

.sdr-rail__account img {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  object-fit: cover;
}

.sdr-rail__account span {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  background: var(--gs-accent);
  color: #ffffff;
  font-size: 11.5px;
  font-weight: 600;
}

/* 手机抽屉 */
.sdr-mobile {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  background: var(--gs-sidebar-bg);
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
}

.sdr-mobile__brand {
  padding-left: 14px;
  padding-right: 10px;
}
</style>
