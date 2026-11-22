<script lang="ts" setup>
import type { NotificationItem } from '@vben/layouts';

import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { AuthenticationLoginExpiredModal } from '@vben/common-ui';
import { useWatermark } from '@vben/hooks';
import {
  BasicLayout,
  LockScreen,
  Notification,
  UserDropdown,
} from '@vben/layouts';
import { preferences, updatePreferences, usePreferences } from '@vben/preferences';
import { useAccessStore, useUserStore } from '@vben/stores';

import { Popover } from 'ant-design-vue';

import { $t } from '#/locales';
import { gainosApi, type AppNotification } from '#/api/gainos';
import type { GainosUserInfo } from '#/api/core/user';
import CommandPalette from '#/components/gainos/command-palette.vue';
import SdrSidebar from '#/components/gainos/sdr-sidebar.vue';
import { useMenuGroups } from '#/composables/use-menu-groups';
import { useAuthStore } from '#/store';
import { formatDateTime } from '@gain-saas/shared';
import LoginForm from '#/views/_core/authentication/login.vue';

// 侧栏标记显式传入:覆盖 localStorage 里可能残留的旧 logo
const logoGainos = '/logo-gainos.svg?v=pass3';

const notifications = ref<NotificationItem[]>([]);
const notificationLoading = ref(false);
let notificationTimer: ReturnType<typeof setInterval> | null = null;

const router = useRouter();
const userStore = useUserStore();
const authStore = useAuthStore();
const accessStore = useAccessStore();
// 路由仍是扁平结构；只把 Vben 的菜单数据收进 6 个业务组（工作空间/获客/线索/活动/增长/设置）。
useMenuGroups();

// pass3 C1：命令面板（⌘K）。pass4：搜索入口移入 SDR 侧栏，顶栏不再承载搜索。
const paletteRef = ref<InstanceType<typeof CommandPalette> | null>(null);
const isEnglish = computed(() => preferences.app.locale === 'en-US');

// pass4：主题 / 语言切换从顶栏移入侧栏品牌行（AgentSDR 同款位置）。
const themeToggleLabel = computed(() => (isDark.value ? 'light' : 'dark'));
function toggleTheme(): void {
  updatePreferences({ theme: { mode: isDark.value ? 'light' : 'dark' } });
}
const langToggleLabel = computed(() =>
  isEnglish.value ? 'Switch to Chinese' : '切换到 English',
);
function toggleLocale(): void {
  void preferences.app.locale;
  updatePreferences({ app: { locale: isEnglish.value ? 'zh-CN' : 'en-US' } });
}
const { destroyWatermark, updateWatermark } = useWatermark();
const { isDark, isMobile, isSideMode, sidebarCollapsed } = usePreferences();
// pass4：主题/语言切换（isDark 见下方的 usePreferences 解构）。
const appVersion = __APP_VERSION__;
const appCommit = __APP_COMMIT__;
const versionLabel = computed(() =>
  appCommit ? `v${appVersion} · ${appCommit}` : `v${appVersion}`,
);
const versionTitle = computed(() =>
  appCommit ? `GainOS v${appVersion} · ${appCommit}` : `GainOS v${appVersion}`,
);
const showDot = computed(() =>
  notifications.value.some((item) => !item.isRead),
);

const menus = computed(() => []);

/** 顶栏展示公司名；人（realName）只出现在问候与水印里（P5b-14）。 */
const companyName = computed(
  () =>
    (userStore.userInfo as GainosUserInfo | null)?.workspaceName ??
    userStore.userInfo?.username ??
    '',
);

// 侧栏/菜单标题在路由模块加载时求值一次，切语言后不会热更新（审计 二-06）。
// 语言切换后整页重载一次，保证导航、页面与通知全部即时切换（URL 与登录态保留）。
// 2026-11-22：reload 必须等偏好持久化落盘——updatePreferences 的保存是 150ms
// debounce，立即 reload 会在定时器触发前卸载页面，缓存仍是旧语言，重载后回退
// （用户实测：切语言整页刷新且切换失败）。延迟 300ms（2×debounce）先存后刷。
watch(
  () => preferences.app.locale,
  (next, prev) => {
    if (prev && next !== prev) {
      window.setTimeout(() => window.location.reload(), 300);
    }
  },
);

const avatar = computed(
  () => userStore.userInfo?.avatar ?? preferences.app.defaultAvatar,
);

/** 服务端标题按界面语言选择（en 优先 titleEn，历史行回落中文）。 */
function serverTitle(row: AppNotification): string | undefined {
  return preferences.app.locale === 'en-US' ? (row.titleEn ?? row.title ?? undefined) : (row.title ?? undefined);
}

function notificationTitle(row: AppNotification): string {
  // 服务端标题已带结果与建议（信息契约审计 §5.9）；本地映射只作旧数据/未知类型的回退。
  const server = serverTitle(row);
  if (server) return server;
  switch (row.type) {
    case 'DiscoveryRunCompleted': return $t('gainos.notifications.runCompleted');
    case 'DiscoveryRunPartial': return $t('gainos.notifications.runPartial');
    case 'DiscoveryRunFailed': return $t('gainos.notifications.runFailed');
    case 'DiscoveryRunCancelled': return $t('gainos.notifications.runCancelled');
    case 'LeadQualified': return $t('gainos.notifications.leadQualified');
    case 'ClaimApproved': return $t('gainos.notifications.claimApproved');
    case 'ClaimRejected': return $t('gainos.notifications.claimRejected');
    case 'SanctionsHoldDetected': return $t('gainos.notifications.sanctionsHold');
    case 'WorkspaceQuotaWarning': return $t('gainos.notifications.quotaWarning');
    case 'WorkspaceQuotaExceeded': return $t('gainos.notifications.quotaExceeded');
    default: return $t('gainos.notifications.default');
  }
}

function withRef(text: string, row: AppNotification): string {
  return row.refId ? `${text} · #${row.refId.slice(0, 8)}` : text;
}

function notificationMessage(row: AppNotification): string {
  switch (row.type) {
    case 'DiscoveryRunCompleted': return withRef($t('gainos.notifications.runCompletedMessage'), row);
    case 'DiscoveryRunPartial': return withRef($t('gainos.notifications.runPartialMessage'), row);
    case 'DiscoveryRunFailed': return withRef($t('gainos.notifications.runFailedMessage'), row);
    case 'DiscoveryRunCancelled': return withRef($t('gainos.notifications.runCancelledMessage'), row);
    case 'LeadQualified': return withRef($t('gainos.notifications.leadQualifiedMessage'), row);
    case 'ClaimApproved': return withRef($t('gainos.notifications.claimApprovedMessage'), row);
    case 'ClaimRejected': return withRef($t('gainos.notifications.claimRejectedMessage'), row);
    // 服务端标题带计数/额度明细（无 PII），优先按界面语言展示。
    case 'SanctionsHoldDetected':
    case 'WorkspaceQuotaWarning':
    case 'WorkspaceQuotaExceeded':
      return withRef(serverTitle(row) ?? $t('gainos.notifications.default'), row);
    default: return withRef(serverTitle(row) ?? '', row);
  }
}

async function loadNotifications(): Promise<void> {
  if (notificationLoading.value) return;
  notificationLoading.value = true;
  try {
    const data = await gainosApi.notifications();
    const page = (data as unknown as { items?: AppNotification[]; data?: { items?: AppNotification[] } });
    const rows = page.items ?? page.data?.items ?? [];
    notifications.value = rows.map((row) => ({
      id: row.id,
      avatar: preferences.app.defaultAvatar ?? '/favicon.svg',
      title: notificationTitle(row),
      message: notificationMessage(row),
      date: formatDateTime(row.createdAt),
      isRead: Boolean(row.readAt),
      link: row.link,
      type: row.type,
      refId: row.refId,
    }));
  } catch {
    // 未登录/会话切换期间静默失败，不打扰主界面。
  } finally {
    notificationLoading.value = false;
  }
}

async function handleLogout() {
  await authStore.logout(false);
}

async function handleNoticeClear() {
  notifications.value = [];
  await gainosApi.readAllNotifications().catch(() => undefined);
}

async function markRead(id: number | string) {
  const item = notifications.value.find((item) => item.id === id);
  if (!item || item.isRead) return;
  await gainosApi.readNotification(String(id)).catch(() => undefined);
  item.isRead = true;
}

async function remove(id: number | string) {
  await gainosApi.deleteNotification(String(id)).catch(() => undefined);
  notifications.value = notifications.value.filter((item) => item.id !== id);
}

async function handleMakeAll() {
  notifications.value.forEach((item) => (item.isRead = true));
  await gainosApi.readAllNotifications().catch(() => undefined);
}

const viewAll = () => {
  void router.push('/notifications');
};

const handleClick = async (item: NotificationItem) => {
  await markRead(item.id);
  // 如果通知项有链接，点击时跳转
  if (item.link) {
    navigateTo(item.link, item.query, item.state);
  }
};

function navigateTo(
  link: string,
  query?: Record<string, any>,
  state?: Record<string, any>,
) {
  if (link.startsWith('http://') || link.startsWith('https://')) {
    // 外部链接，在新标签页打开
    window.open(link, '_blank');
  } else {
    // 内部路由链接，支持 query 参数和 state
    const resolved = router.resolve(link);
    router.push({
      path: resolved.path,
      query: { ...resolved.query, ...(query || {}) },
      state,
    });
  }
}

watch(
  () => ({
    enable: preferences.app.watermark,
    content: preferences.app.watermarkContent,
    isDark: isDark.value,
  }),
  async ({ enable, content, isDark: isDarkValue }) => {
    if (enable) {
      const watermarkColor = isDarkValue
        ? 'rgba(255, 255, 255, 0.12)'
        : 'rgba(0, 0, 0, 0.12)';

      await updateWatermark({
        advancedStyle: {
          colorStops: [
            {
              color: watermarkColor,
              offset: 0,
            },
            {
              color: watermarkColor,
              offset: 1,
            },
          ],
          type: 'linear',
        },
        content:
          content ||
          `${userStore.userInfo?.username} - ${userStore.userInfo?.realName}`,
      });
    } else {
      destroyWatermark();
    }
  },
  {
    immediate: true,
  },
);

const onNotificationsChanged = () => {
  void loadNotifications();
};

onMounted(() => {
  window.addEventListener('gainos:notifications-changed', onNotificationsChanged);
  void loadNotifications();
  notificationTimer = setInterval(() => void loadNotifications(), 30_000);
});

onUnmounted(() => {
  window.removeEventListener('gainos:notifications-changed', onNotificationsChanged);
  if (notificationTimer) clearInterval(notificationTimer);
});
</script>

<template>
  <BasicLayout
    :avatar
    :logo-src="logoGainos"
    :logo-src-dark="logoGainos"
    :text="companyName"
    logo-text="GainOS"
    @clear-preferences-and-logout="handleLogout"
    @logout="handleLogout"
  >
    <template #user-dropdown>
      <UserDropdown
        :avatar
        :menus
        :text="companyName"
        :description="userStore.userInfo?.username"
        @clear-preferences-and-logout="handleLogout"
        @logout="handleLogout"
      />
    </template>
    <template #notification>
      <Notification
        :dot="showDot"
        :notifications="notifications"
        @clear="handleNoticeClear"
        @read="(item) => item.id && markRead(item.id)"
        @remove="(item) => item.id && remove(item.id)"
        @make-all="handleMakeAll"
        @on-click="handleClick"
        @view-all="viewAll"
      />
    </template>
    <template #extra>
      <AuthenticationLoginExpiredModal
        v-model:open="accessStore.loginExpired"
        :avatar
      >
        <LoginForm />
      </AuthenticationLoginExpiredModal>
    </template>
    <template #lock-screen>
      <LockScreen :avatar @to-login="handleLogout" />
    </template>
  </BasicLayout>
  <div
    v-if="isSideMode && !isMobile && !sidebarCollapsed && !preferences.sidebar.hidden"
    class="app-version"
    :style="{ width: `${preferences.sidebar.width}px` }"
    :title="versionTitle"
  >
    {{ versionLabel }}
  </div>

  <!-- pass3 B2：侧栏底部帮助入口（折叠开关是 Vben 内置的左下按钮）。 -->
  <div
    v-if="isSideMode && !isMobile && !sidebarCollapsed && !preferences.sidebar.hidden"
    class="app-help"
    :style="{ left: `${preferences.sidebar.width - 44}px` }"
  >
    <Popover placement="topRight" trigger="click">
      <template #content>
        <div class="app-help__panel">
          <p class="app-help__title">{{ isEnglish ? 'Shortcuts' : '快捷键' }}</p>
          <p><kbd>⌘K</kbd> / <kbd>Ctrl K</kbd> — {{ isEnglish ? 'Command palette' : '命令面板' }}</p>
          <p class="app-help__muted">
            {{ isEnglish ? 'Theme and language live in the top bar.' : '主题与语言切换在顶栏右侧。' }}
          </p>
        </div>
      </template>
      <button
        type="button"
        class="app-help__btn"
        :aria-label="isEnglish ? 'Help' : '帮助'"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <circle cx="12" cy="12" r="9" /><path d="M9.6 9.2a2.5 2.5 0 0 1 4.9.6c0 1.7-2.5 2.1-2.5 3.6" /><circle cx="12" cy="17" r=".4" fill="currentColor" />
        </svg>
      </button>
    </Popover>
  </div>

  <!-- pass4：主题/语言切换放在侧栏品牌行右侧（AgentSDR 同款位置）。 -->
  <div
    v-if="isSideMode && !isMobile && !sidebarCollapsed && !preferences.sidebar.hidden"
    class="sdr-brandtools"
    :style="{
      left: `${preferences.sidebar.width - 78}px`,
      top: `${Math.max(0, Math.round((preferences.header.height - 1) / 2) - 16)}px`,
    }"
  >
    <button
      type="button"
      class="sdr-brandtools__btn"
      :aria-label="themeToggleLabel"
      :title="themeToggleLabel"
      @click="toggleTheme"
    >
      <svg v-if="isDark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4.4" /><path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
      <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z"/></svg>
    </button>
    <button
      type="button"
      class="sdr-brandtools__btn sdr-brandtools__lang"
      :aria-label="langToggleLabel"
      :title="langToggleLabel"
      @click="toggleLocale"
    >
      {{ isEnglish ? 'EN' : '中' }}
    </button>
  </div>

  <SdrSidebar @open-search="paletteRef?.open()" />
  <CommandPalette ref="paletteRef" />
</template>

<style scoped>
/* 侧栏底部（折叠/固定按钮之间）显示产品版本与构建 SHA；折叠或移动端隐藏。
   侧栏 aside 自身 z-index=201，fixed 标签必须高于它才不会被侧栏底色盖住。 */
.app-version {
  position: fixed;
  bottom: 10px;
  left: 0;
  z-index: 202;
  box-sizing: border-box;
  padding: 0 44px;
  overflow: hidden;
  font-size: 10px;
  line-height: 16px;
  color: hsl(var(--muted-foreground));
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0.75;
  transition: width 0.3s;
}

/* pass4：侧栏品牌行右侧的主题/语言切换（AgentSDR 同款位置）。 */
.sdr-brandtools {
  position: fixed;
  z-index: 202;
  display: flex;
  gap: 2px;
  align-items: center;
  transition: left 0.3s;
}
.sdr-brandtools__btn {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--gs-fg-subtle);
  cursor: pointer;
}
.sdr-brandtools__btn:hover {
  background: var(--gs-surface-2);
  color: var(--gs-fg);
}
.sdr-brandtools__btn svg { width: 17px; height: 17px; }
.sdr-brandtools__lang { font-size: 12px; font-weight: 500; }

/* pass3 B2：侧栏底部帮助按钮（折叠开关在左下，帮助在右下）。 */
.app-help { position: fixed; bottom: 6px; z-index: 202; transition: left 0.3s; }
.app-help__btn {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--gs-fg-subtle);
  cursor: pointer;
}
.app-help__btn:hover { background: var(--gs-surface-2); color: var(--gs-fg); }
.app-help__btn svg { width: 16px; height: 16px; }
.app-help__panel { display: grid; gap: 6px; max-width: 260px; font-size: 12.5px; }
.app-help__panel p { margin: 0; }
.app-help__title { font-weight: 500; }
.app-help__muted { color: var(--gs-fg-muted); }
.app-help__panel kbd {
  padding: 0 5px;
  border: 1px solid var(--gs-border);
  border-radius: 5px;
  background: var(--gs-surface-2);
  font-family: inherit;
  font-size: 10.5px;
}

/* AgentSDR 侧栏规格（2026-11-22 pass2）
   Vben 只暴露一组菜单高度变量；这里用组件级 :deep 收敛：
   一级 36px / 二级 32px / 组标签 11px / active 蓝左条 + 蓝字 + 浅灰底。 */
:deep(.vben-menu) {
  --menu-font-size: 14px;
  --menu-item-height: 36px;
  --menu-item-padding-y: 0px;
  --menu-item-padding-x: 8px;
  --menu-item-margin-y: 2px;
  --menu-item-margin-x: 6px;
  --menu-item-radius: 8px;
  --menu-item-color: var(--gs-fg-2);
  --menu-item-hover-background-color: var(--gs-surface-2);
  --menu-item-hover-color: var(--gs-fg);
  --menu-item-active-background-color: var(--gs-surface-2);
  --menu-item-active-color: var(--gs-fg);
}
:deep(.vben-sub-menu .vben-menu) {
  --menu-item-height: 32px;
}
:deep(.vben-menu-item) {
  font-weight: 500;
}
:deep(.vben-menu-item.is-active) {
  font-weight: 500;
}
:deep(.vben-sub-menu > .vben-sub-menu-content) {
  display: flex;
  align-items: center;
  height: 36px;
  min-height: 36px;
  margin: 6px 6px 0;
  padding: 0 8px;
  border-radius: 6px;
  color: var(--gs-fg-subtle);
  background: transparent;
}
:deep(.vben-menu > .vben-sub-menu:first-child > .vben-sub-menu-content) {
  margin-top: 0;
}
:deep(.vben-sub-menu-content__title) {
  color: inherit;
  font-size: 11px !important;
  line-height: 16px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
:deep(.vben-sub-menu > .vben-sub-menu-content > .vben-menu__icon),
:deep(.vben-sub-menu > .vben-sub-menu-content > .vben-sub-menu-content__icon-arrow) {
  display: none;
}
:deep(.vben-sub-menu-content:hover) {
  color: var(--gs-fg-2);
  background: transparent;
}
:deep(.vben-sub-menu-content.is-active) {
  color: var(--gs-fg-subtle);
  background: transparent;
}
</style>
