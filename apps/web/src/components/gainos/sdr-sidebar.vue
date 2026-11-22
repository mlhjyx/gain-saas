<script lang="ts" setup>
/**
 * AgentSDR 风格侧边栏导航（pass4 → pass5）。
 *
 * Vben 的菜单渲染在 packages/ 内（禁改），这里用 fixed 覆盖层在侧栏区域内
 * 渲染 SDR 原版结构：分组小标签 + 永远可见的菜单行（36px、8px 圆角、
 * 灰底药丸 active + 近黑文字），hover 同灰底。桌面隐藏 Vben 菜单
 * （gainos.css），移动端抽屉仍走 Vben 菜单。
 * 数据与 use-menu-groups 同源（accessMenus），不新增路由。
 *
 * pass5（AgentSDR Sidebar 同款底部）：分隔线 + 通知/设置/帮助行 +
 * 工作空间账号卡（头像 + 空间名 + 账号，⋮ 菜单含退出登录）。
 * 顶栏已隐藏（header.hidden），全部全局操作都在这里。
 */
import type { MenuRecordRaw } from '@vben/types';

import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { preferences, usePreferences } from '@vben/preferences';
import { useAccessStore } from '@vben/stores';

import { IconifyIcon } from '@vben/icons';

import { Popover } from 'ant-design-vue';

import SdrAccountMenu from './sdr-account-menu.vue';

import { $t } from '#/locales';

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
}>();

const emit = defineEmits<{
  logout: [];
  openSearch: [];
  openSettings: [];
  toggleCollapse: [];
}>();

const route = useRoute();
const router = useRouter();
const accessStore = useAccessStore();
const { isMobile, sidebarCollapsed } = usePreferences();

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

interface NavLeaf {
  icon?: string;
  label: string;
  path: string;
}
interface NavSection {
  items: NavLeaf[];
  label: string;
}

/** 拍平 accessMenus：分组 → 小标签 + 永远可见的行（无折叠手风琴）。 */
const sections = computed<NavSection[]>(() => {
  const rows: NavSection[] = [];
  const fallbackIcon = 'lucide:circle-dot';
  const walk = (label: string, menus: MenuRecordRaw[]) => {
    const items: NavLeaf[] = [];
    for (const menu of menus) {
      if (menu.children?.length) {
        walk(menu.name || label, menu.children);
        continue;
      }
      if (!menu.path || menu.path.startsWith('__')) continue;
      // pass5：设置不再占导航分组——底部「设置」打开设置弹窗（SDR 同款）。
      if (menu.path.startsWith('/settings')) continue;
      items.push({
        icon: typeof menu.icon === 'string' ? menu.icon : fallbackIcon,
        // 存的是 i18n key（模块加载早于 i18n 初始化时）或已译文本；渲染时统一过 $t。
        label: menu.name,
        path: menu.path,
      });
    }
    if (items.length > 0) rows.push({ items, label });
  };
  for (const menu of accessStore.accessMenus) {
    if (menu.children?.length) {
      walk(menu.name || '', menu.children);
    } else if (
      menu.path &&
      !menu.path.startsWith('__') &&
      !menu.path.startsWith('/settings')
    ) {
      walk('', [menu]);
    }
  }
  return rows;
});

const flatLeaves = computed<NavLeaf[]>(() =>
  sections.value.flatMap((section) => section.items),
);

function isActive(path: string): boolean {
  const current = route.path;
  if (current === path) return true;
  // 详情页归属列表页：/leads/x 高亮 /leads。
  return current.startsWith(`${path}/`);
}

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

function go(path: string): void {
  void router.push(path);
}

/** 账号卡首字母兜底（无头像时）。 */
const initial = computed(() =>
  (props.workspaceName || props.userEmail || 'G').trim().slice(0, 1).toUpperCase(),
);

const settingsActive = computed(() => route.path.startsWith('/settings'));

const helpOpen = ref(false);

// 账号菜单（SdrAccountMenu）的动作：先收起浮层再执行。
const accountOpen = ref(false);
const railAccountOpen = ref(false);
function accountAction(action: 'logout' | 'notifications' | 'search' | 'settings') {
  accountOpen.value = false;
  railAccountOpen.value = false;
  if (action === 'logout') emit('logout');
  if (action === 'notifications') go('/notifications');
  if (action === 'search') emit('openSearch');
  if (action === 'settings') emit('openSettings');
}
</script>

<template>
  <!-- 完整侧栏：分组标签 + 菜单行（SDR 规格） + 底部账号区 -->
  <nav
    v-if="showFull"
    class="sdr-nav"
    data-sdr-nav
    :style="navStyle"
    :aria-label="isEnglish ? 'Main navigation' : '主导航'"
  >
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

    <div class="sdr-nav__scroll">
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
  </nav>

  <!-- 折叠态：图标窄栏（SDR 68px rail）+ 底部账号头像 -->
  <nav
    v-else-if="showRail"
    class="sdr-rail"
    data-sdr-nav
    :style="railStyle"
    :aria-label="isEnglish ? 'Main navigation' : '主导航'"
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
            @logout="accountAction('logout')"
            @notifications="accountAction('notifications')"
            @search="accountAction('search')"
            @settings="accountAction('settings')"
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
.sdr-nav__scroll {
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
.sdr-search kbd {
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
.sdr-help kbd {
  padding: 0 5px;
  border: 1px solid var(--gs-border);
  border-radius: 5px;
  background: var(--gs-surface-2);
  font-family: inherit;
  font-size: 10.5px;
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
</style>
