<script lang="ts" setup>
/**
 * AgentSDR 风格侧边栏导航（pass4 → pass5 → 2026-11-25 响应式）。
 *
 * Vben 的菜单渲染在 packages/ 内（禁改），这里用 fixed 覆盖层在侧栏区域内
 * 渲染 SDR 结构。三处容器共用同一份内容（sdr-nav-panel）：
 * - 桌面展开：分组标签 + 菜单行 + 底部账号区；
 * - 桌面折叠：图标窄栏（rail）+ 底部账号头像；
 * - 手机：从左侧滑出的抽屉，品牌行带主题 / 语言 / 关闭。
 *
 * 手机不再用 Vben 自带抽屉：顶栏隐藏后，那个抽屉里既没有通知 / 设置，
 * 也没有退出登录入口，菜单项还是浅色字落在白底上。这里自己开抽屉，
 * 与桌面完全一致。
 */
import { computed, ref, watch } from 'vue';

import { preferences, usePreferences } from '@vben/preferences';

import { IconifyIcon } from '@vben/icons';

import { Drawer, Popover } from 'ant-design-vue';

import SdrAccountMenu from './sdr-account-menu.vue';
import SdrNavPanel from './sdr-nav-panel.vue';
import { $t } from '#/locales';

import { useSdrNav } from './use-sdr-nav';

defineOptions({ name: 'SdrSidebar' });

const props = defineProps<{
  /** 通知未读数（basic.vue 轮询，>0 显示红点）。 */
  unreadCount?: number;
  /** 用户头像 URL（空则用首字母兜底）。 */
  userAvatar?: string;
  /** 账号（邮箱/用户名），账号卡第二行。 */
  userEmail?: string;
  /** 工作空间名，账号卡第一行。 */
  workspaceName?: string;
  /** 品牌图标（手机抽屉的品牌行用；桌面品牌行由 Vben 的 logo 区渲染）。 */
  logoSrc?: string;
}>();

/** 手机抽屉开关（汉堡按钮在 basic.vue）。 */
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

const isEnglish = computed(() => preferences.app.locale === 'en-US');
const isDark = computed(() => preferences.theme.mode === 'dark');
const searchLabel = computed(() =>
  isEnglish.value ? 'Search or jump to…' : '搜索或跳转…',
);
const navLabel = computed(() => (isEnglish.value ? 'Main navigation' : '主导航'));
const accountLabels = computed(() => ({
  account: isEnglish.value ? 'Account' : '账号',
  close: isEnglish.value ? 'Close menu' : '关闭菜单',
  expand: isEnglish.value ? 'Expand sidebar' : '展开侧栏',
  lang: isEnglish.value ? 'Switch to Chinese' : '切换到 English',
  theme: isDark.value
    ? isEnglish.value
      ? 'Switch to light theme'
      : '切换到浅色主题'
    : isEnglish.value
      ? 'Switch to dark theme'
      : '切换到深色主题',
}));

const showRail = computed(
  () => !isMobile.value && sidebarCollapsed.value && !preferences.sidebar.hidden,
);

/** 侧栏 logo 行高度 = header 高度 - 1（layout-sidebar headerStyle）。 */
const navStyle = computed(() => ({
  top: `${Math.max(0, preferences.header.height - 1)}px`,
  width: `${preferences.sidebar.width}px`,
}));
/** 折叠态宽度跟 Vben 的 collapseWidth（60px）走，否则覆盖层按展开宽度
    渲染会盖住内容区。 */
const railStyle = computed(() => ({
  top: `${Math.max(0, preferences.header.height - 1)}px`,
  width: `${preferences.sidebar.collapseWidth}px`,
}));
const showFull = computed(
  () =>
    !isMobile.value &&
    !sidebarCollapsed.value &&
    !preferences.sidebar.hidden,
);

// 点了菜单 / 通知，或任何原因发生的路由跳转：收起手机抽屉。
watch(
  () => route.fullPath,
  () => {
    mobileOpen.value = false;
  },
);

/** 账号卡首字母兜底（无头像时）。 */
const initial = computed(() =>
  (props.workspaceName || props.userEmail || 'G').trim().slice(0, 1).toUpperCase(),
);

// 窄栏账号菜单（SdrAccountMenu）的动作：先收起浮层再执行。
const railAccountOpen = ref(false);
function railAccountAction(action: 'logout' | 'notifications' | 'search' | 'settings') {
  railAccountOpen.value = false;
  if (action === 'logout') emit('logout');
  if (action === 'notifications') go('/notifications');
  if (action === 'search') emit('openSearch');
  if (action === 'settings') emit('openSettings');
}

/** 抽屉里打开的浮层类动作：先收抽屉，再交给 basic.vue。 */
function fromDrawer(action: 'search' | 'settings') {
  mobileOpen.value = false;
  if (action === 'search') emit('openSearch');
  else emit('openSettings');
}
</script>

<template>
  <!-- 桌面展开：分组标签 + 菜单行（SDR 规格） + 底部账号区 -->
  <nav
    v-if="showFull"
    class="sdr-nav"
    data-sdr-nav
    :style="navStyle"
    :aria-label="navLabel"
  >
    <SdrNavPanel
      :unread-count="unreadCount"
      :user-avatar="userAvatar"
      :user-email="userEmail"
      :workspace-name="workspaceName"
      @logout="emit('logout')"
      @open-search="emit('openSearch')"
      @open-settings="emit('openSettings')"
    />
  </nav>

  <!-- 折叠态：图标窄栏（SDR 68px rail）+ 底部账号头像 -->
  <nav
    v-else-if="showRail"
    class="sdr-rail"
    data-sdr-nav
    :style="railStyle"
    :aria-label="navLabel"
  >
    <button
      type="button"
      class="sdr-rail__search"
      :aria-label="searchLabel"
      @click="emit('openSearch')"
    >
      <IconifyIcon icon="lucide:search" />
    </button>
    <div class="sdr-rail__scroll">
      <button
        v-for="item in flatLeaves"
        :key="item.path"
        type="button"
        class="sdr-rail__item"
        :class="{ 'is-active': isActive(item.path) }"
        role="menuitem"
        :title="$t(item.label)"
        :aria-current="isActive(item.path) ? 'page' : undefined"
        @click="go(item.path)"
      >
        <IconifyIcon :icon="item.icon ?? 'lucide:circle-dot'" />
      </button>
    </div>
    <div class="sdr-rail__footer">
      <!-- 折叠态没有品牌行的折叠按钮，展开入口放这里（Vben 自带按钮已关）。 -->
      <button
        type="button"
        class="sdr-rail__expand"
        :aria-label="accountLabels.expand"
        :title="accountLabels.expand"
        @click="emit('toggleCollapse')"
      >
        <IconifyIcon icon="lucide:panel-left-open" />
      </button>
      <Popover
        v-model:open="railAccountOpen"
        trigger="click"
        placement="rightTop"
        :arrow="false"
        overlay-class-name="gs-account-pop"
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
          />
        </template>
        <button
          type="button"
          class="sdr-rail__account"
          :aria-label="workspaceName || userEmail || 'Account'"
          :title="workspaceName || userEmail"
        >
          <img v-if="userAvatar" :src="userAvatar" alt="" />
          <span v-else aria-hidden="true">{{ initial }}</span>
          <i
            v-if="(unreadCount ?? 0) > 0"
            class="sdr-rail__dot"
            aria-hidden="true"
          ></i>
        </button>
      </Popover>
    </div>
  </nav>

  <!-- 手机：左侧抽屉。品牌行带主题 / 语言切换（桌面放在品牌行右侧，手机上原本没有入口）。 -->
  <Drawer
    v-if="isMobile"
    v-model:open="mobileOpen"
    :body-style="{
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
      overflow: 'hidden',
      padding: 0,
    }"
    :closable="false"
    :header-style="{ display: 'none' }"
    placement="left"
    width="min(300px, 84vw)"
  >
    <!-- 锚点放在内容根上：Drawer 的根是 Teleport，属性不会落到抽屉 DOM 上 -->
    <div class="sdr-mobile" data-gs="mobile-nav">
      <header class="sdr-mobile__brand">
        <img v-if="logoSrc" alt="" class="sdr-mobile__logo" :src="logoSrc" />
        <strong class="sdr-mobile__name">GainOS</strong>
        <div class="sdr-mobile__tools">
          <button
            type="button"
            class="sdr-tool"
            :aria-label="accountLabels.theme"
            :title="accountLabels.theme"
            @click="emit('toggleTheme')"
          >
            <svg
              v-if="isDark"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              viewBox="0 0 24 24"
            >
              <circle cx="12" cy="12" r="4.4" />
              <path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </svg>
            <svg
              v-else
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              viewBox="0 0 24 24"
            >
              <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z" />
            </svg>
          </button>
          <button
            type="button"
            class="sdr-tool sdr-tool--lang"
            :aria-label="accountLabels.lang"
            :title="accountLabels.lang"
            @click="emit('toggleLocale')"
          >
            {{ isEnglish ? 'EN' : '中' }}
          </button>
          <button
            type="button"
            class="sdr-tool"
            :aria-label="accountLabels.close"
            @click="mobileOpen = false"
          >
            <svg
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-width="1.8"
              viewBox="0 0 24 24"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </header>
      <SdrNavPanel
        :unread-count="unreadCount"
        :user-avatar="userAvatar"
        :user-email="userEmail"
        :workspace-name="workspaceName"
        @logout="emit('logout')"
        @open-search="fromDrawer('search')"
        @open-settings="fromDrawer('settings')"
      />
    </div>
  </Drawer>
</template>

<style scoped>
.sdr-nav {
  position: fixed;
  top: var(--sdr-nav-top, 49px);
  left: 0;
  bottom: 0;
  /* 侧栏 aside 自身 z-index=201，覆盖层必须更高才能接收点击。 */
  z-index: 202;
  display: flex;
  flex-direction: column;
  padding: 8px 12px 10px;
  box-sizing: border-box;
  transition: width 0.3s ease-out;
  pointer-events: none;
}

/* 折叠态图标窄栏（SDR 68px rail） */
.sdr-rail {
  position: fixed;
  top: var(--sdr-nav-top, 49px);
  left: 0;
  bottom: 0;
  z-index: 202;
  display: flex;
  flex-direction: column;
  gap: 4px;
  /* 宽度 = Vben collapseWidth(60px)，左右各留 10px → 40px 内容列。 */
  padding: 8px 10px 10px;
  box-sizing: border-box;
  align-items: stretch;
  pointer-events: none;
}
.sdr-rail__scroll {
  display: grid;
  gap: 2px;
  justify-items: stretch;
  overflow-y: auto;
  min-height: 0;
  flex: 1;
  pointer-events: auto;
  scrollbar-width: none;
}
.sdr-rail__search {
  display: grid;
  place-items: center;
  height: 36px;
  margin-bottom: 4px;
  border: 1px solid var(--gs-border);
  border-radius: 8px;
  background: var(--gs-surface);
  color: var(--gs-fg-muted);
  cursor: pointer;
  pointer-events: auto;
}
.sdr-rail__search:hover { border-color: var(--gs-accent); color: var(--gs-accent-strong); }
.sdr-rail__search :deep(svg) { width: 16px; height: 16px; }
.sdr-rail__item {
  display: grid;
  place-items: center;
  height: 36px;
  border-radius: 8px;
  background: transparent;
  color: var(--gs-fg-muted);
  cursor: pointer;
}
.sdr-rail__item :deep(svg) { width: 18px; height: 18px; color: var(--gs-fg-subtle); }
.sdr-rail__item:hover { background: var(--gs-surface-2); color: var(--gs-fg); }
.sdr-rail__item.is-active { background: var(--gs-surface-2); color: var(--gs-fg); }
.sdr-rail__item.is-active :deep(svg) { color: var(--gs-fg); }
.sdr-rail__footer {
  flex: none;
  display: grid;
  gap: 2px;
  padding-top: 8px;
  border-top: 1px solid var(--gs-divider);
  pointer-events: auto;
}
.sdr-rail__expand {
  display: grid;
  place-items: center;
  height: 32px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--gs-fg-muted);
  cursor: pointer;
}
.sdr-rail__expand:hover { background: var(--gs-surface-2); color: var(--gs-fg); }
.sdr-rail__expand :deep(svg) { width: 17px; height: 17px; }
.sdr-rail__dot {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--gs-accent);
}
.sdr-rail__account {
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  height: 36px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}
.sdr-rail__account:hover { background: var(--gs-surface-2); }
.sdr-rail__account img {
  width: 26px;
  height: 26px;
  border-radius: 7px;
  object-fit: cover;
}
.sdr-rail__account span {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: var(--gs-accent);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
}

/* ── 手机抽屉 ────────────────────────────────────────────────────────── */
.sdr-mobile {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  box-sizing: border-box;
  padding: env(safe-area-inset-top) 12px calc(10px + env(safe-area-inset-bottom));
}
.sdr-mobile__brand {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  height: 40px;
  margin-bottom: 8px;
}
.sdr-mobile__logo {
  width: 24px;
  height: 24px;
  flex: none;
}
.sdr-mobile__name {
  color: var(--gs-fg);
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.sdr-mobile__tools {
  display: flex;
  gap: 2px;
  margin-left: auto;
}
.sdr-tool {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--gs-fg-subtle);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.sdr-tool:hover {
  background: var(--gs-surface-2);
  color: var(--gs-fg);
}
.sdr-tool svg {
  width: 17px;
  height: 17px;
}
</style>
