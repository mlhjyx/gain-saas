<script lang="ts" setup>
/**
 * 侧栏内容面板（PR-UI1 对标 Linear / Attio）：
 *
 * - 快捷搜索框（⌘K）
 * - 顶区高频核心项（无分组标题：工作台 / 通知 + 未读数字徽标）
 * - 分组 1：获客主线（企业档案 / 买家画像 / 买家线索 / 寻源记录）
 * - 分组 2：触达与转化（外发与战役 / 商机管线 / 成效复盘，受 GROWTH_PAGE_HIDDEN 门控）
 * - 底部固定区：主流程进度芯片（仅主流程页显示）+ 设置 + 紧凑账号条（弹出主题/语言/帮助/退出）
 *
 * 桌面展开侧栏与手机抽屉共用本组件；全部图标使用静态打包组件（零外网 Iconify 拉取）。
 */
import { computed, ref } from 'vue';

import { ChevronDown, Search, Settings } from '@vben/icons';
import { Popover } from 'ant-design-vue';

import { isFlowPath } from '#/composables/use-main-chain-progress';
import { $t } from '#/locales';

import FlowProgressBar from './flow-progress-bar.vue';
import SdrAccountMenu from './sdr-account-menu.vue';
import SdrIcon from './sdr-icon.vue';
import { useSdrNav } from './use-sdr-nav';

defineOptions({ name: 'SdrNavPanel' });

const props = defineProps<{
  /** 通知未读数（>0 在顶区「通知」右侧显示紧凑数字徽标）。 */
  unreadCount?: number;
  /** 用户头像 URL（空则用首字母兜底）。 */
  userAvatar?: string;
  /** 账号邮箱。 */
  userEmail?: string;
  /** 工作空间名称。 */
  workspaceName?: string;
}>();

const emit = defineEmits<{
  logout: [];
  openSearch: [];
  openSettings: [];
  toggleLocale: [];
  toggleTheme: [];
}>();

const { go, isActive, route, sections } = useSdrNav();

const searchLabel = computed(() => $t('gainosUi1.nav.searchPlaceholder'));
const settingsLabel = computed(() => $t('gainosUi1.nav.settings'));
const showFlowChip = computed(() => isFlowPath(route.path));

const initial = computed(() =>
  (props.userEmail || props.workspaceName || 'G').trim().slice(0, 1).toUpperCase(),
);

const settingsActive = computed(() => route.path.startsWith('/settings'));

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
    <!-- 快捷搜索框（⌘K） -->
    <button
      :aria-label="searchLabel"
      class="sdr-search"
      data-gs="nav-search"
      type="button"
      @click="emit('openSearch')"
    >
      <Search :size="14" aria-hidden="true" />
      <span class="sdr-search__label">{{ searchLabel }}</span>
      <kbd>⌘K</kbd>
    </button>

    <div class="sdr-panel__scroll">
      <div
        v-for="section in sections"
        :key="section.items[0]?.path ?? section.label"
        class="sdr-section"
      >
        <p v-if="section.label" class="sdr-section__label">{{ $t(section.label) }}</p>
        <ul class="sdr-section__list">
          <li v-for="item in section.items" :key="item.path">
            <RouterLink
              :aria-current="isActive(item.path) ? 'page' : undefined"
              :class="{ 'is-active': isActive(item.path) }"
              :to="item.path"
              class="sdr-row"
              role="menuitem"
            >
              <SdrIcon :name="item.icon" :size="16" />
              <span class="sdr-row__label">{{ $t(item.label) }}</span>
              <span
                v-if="item.path === '/notifications' && (unreadCount ?? 0) > 0"
                :aria-label="$t('gainosUi1.nav.unreadBadge', { count: unreadCount })"
                class="sdr-row__badge"
                data-gs="nav-unread"
              >
                {{ (unreadCount ?? 0) > 99 ? '99+' : unreadCount }}
              </span>
            </RouterLink>
          </li>
        </ul>
      </div>
    </div>

    <!-- 底部固定区：主流程进度芯片 + 设置 + 紧凑账号条 -->
    <footer class="sdr-footer">
      <FlowProgressBar v-if="showFlowChip" />

      <div :aria-label="settingsLabel" class="sdr-footer__rows" role="menu">
        <button
          :aria-current="settingsActive ? 'page' : undefined"
          :class="{ 'is-active': settingsActive }"
          class="sdr-row sdr-footer__row"
          data-gs="nav-settings"
          role="menuitem"
          type="button"
          @click="emit('openSettings')"
        >
          <Settings :size="16" aria-hidden="true" />
          <span class="sdr-row__label">{{ settingsLabel }}</span>
        </button>
      </div>

      <Popover
        v-model:open="accountOpen"
        :arrow="false"
        overlay-class-name="gs-account-pop"
        placement="topLeft"
        trigger="click"
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
            @toggle-locale="emit('toggleLocale')"
            @toggle-theme="emit('toggleTheme')"
          />
        </template>
        <button
          :aria-expanded="accountOpen"
          :aria-label="userEmail || workspaceName || $t('gainosUi1.nav.account')"
          class="sdr-account"
          data-gs="account-trigger"
          type="button"
        >
          <img v-if="userAvatar" :src="userAvatar" alt="" class="sdr-account__avatar" />
          <span
            v-else
            aria-hidden="true"
            class="sdr-account__avatar sdr-account__avatar--fallback"
          >
            {{ initial }}
          </span>
          <span class="sdr-account__email">{{ userEmail || workspaceName || 'GainOS' }}</span>
          <ChevronDown :size="14" aria-hidden="true" class="sdr-account__more" />
        </button>
      </Popover>
    </footer>
  </div>
</template>

<style scoped>
.sdr-panel {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  width: 100%;
  padding: 10px 10px 10px;
  box-sizing: border-box;
}

.sdr-panel__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

.sdr-search {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 34px;
  margin-bottom: 10px;
  padding: 0 9px;
  border: 1px solid var(--gs-border);
  border-radius: 8px;
  background: var(--gs-surface);
  color: var(--gs-fg-muted);
  font-size: 13px;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    color 0.15s ease;
}

.sdr-search:hover {
  border-color: var(--gs-border-strong);
  color: var(--gs-fg);
}

.sdr-search:focus-visible {
  outline: none;
  box-shadow: var(--gs-shadow-focus);
}

.sdr-search :deep(svg) {
  flex: none;
}

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

.sdr-section {
  margin-top: 14px;
}

.sdr-section:first-child {
  margin-top: 0;
}

.sdr-section__label {
  margin: 0 0 4px;
  padding: 0 8px;
  color: var(--gs-fg-subtle);
  font-size: 11.5px;
  line-height: 18px;
  font-weight: 500;
}

.sdr-section__list {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.sdr-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: 34px;
  padding: 0 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--gs-fg-2);
  font-size: 13.5px;
  font-weight: 500;
  text-decoration: none;
  outline: none;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.sdr-row :deep(svg) {
  flex: none;
  color: var(--gs-fg-subtle);
  transition: color 0.15s ease;
}

.sdr-row:hover {
  background: var(--gs-sidebar-hover);
  color: var(--gs-fg);
}

.sdr-row:hover :deep(svg) {
  color: var(--gs-fg-2);
}

.sdr-row.is-active {
  background: var(--gs-sidebar-active);
  color: var(--gs-fg);
}

.sdr-row.is-active :deep(svg) {
  color: var(--gs-fg);
}

.sdr-row:focus-visible {
  box-shadow: var(--gs-shadow-focus);
}

.sdr-row__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sdr-row__badge {
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
  line-height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.sdr-footer {
  flex: none;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
  gap: 6px;
  margin-top: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--gs-border);
}

.sdr-footer__rows {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
  gap: 2px;
}

.sdr-footer__row {
  height: 32px;
  font-size: 13px;
}

.sdr-account {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 36px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--gs-fg);
  cursor: pointer;
  text-align: left;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease;
}

.sdr-account:hover {
  border-color: var(--gs-border);
  background: var(--gs-surface);
}

.sdr-account:focus-visible {
  outline: none;
  box-shadow: var(--gs-shadow-focus);
}

.sdr-account__avatar {
  width: 24px;
  height: 24px;
  flex: none;
  border-radius: 6px;
  object-fit: cover;
}

.sdr-account__avatar--fallback {
  display: grid;
  place-items: center;
  background: var(--gs-accent);
  color: #ffffff;
  font-size: 11.5px;
  font-weight: 600;
}

.sdr-account__email {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--gs-fg-2);
  font-size: 12.5px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sdr-account:hover .sdr-account__email {
  color: var(--gs-fg);
}

.sdr-account__more {
  flex: none;
  color: var(--gs-fg-subtle);
}
</style>
