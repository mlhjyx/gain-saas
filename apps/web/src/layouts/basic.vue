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
import { preferences, usePreferences } from '@vben/preferences';
import { useAccessStore, useUserStore } from '@vben/stores';

import { $t } from '#/locales';
import { gainosApi, type AppNotification } from '#/api/gainos';
import WorkspaceSwitcher from '#/components/workspace-switcher.vue';
import { useAuthStore } from '#/store';
import LoginForm from '#/views/_core/authentication/login.vue';

// 侧栏标记显式传入:覆盖 localStorage 里可能残留的旧 logo
const logoGainos = '/logo-gainos.svg';

const notifications = ref<NotificationItem[]>([]);
const notificationLoading = ref(false);
let notificationTimer: ReturnType<typeof setInterval> | null = null;

const router = useRouter();
const userStore = useUserStore();
const authStore = useAuthStore();
const accessStore = useAccessStore();
const { destroyWatermark, updateWatermark } = useWatermark();
const { isDark, isMobile, isSideMode, sidebarCollapsed } = usePreferences();
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

// 侧栏/菜单标题在路由模块加载时求值一次，切语言后不会热更新（审计 二-06）。
// 语言切换后整页重载一次，保证导航、页面与通知全部即时切换（URL 与登录态保留）。
watch(
  () => preferences.app.locale,
  (next, prev) => {
    if (prev && next !== prev) {
      window.location.reload();
    }
  },
);

const avatar = computed(() => {
  return userStore.userInfo?.avatar ?? preferences.app.defaultAvatar;
});

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
      date: new Date(row.createdAt).toLocaleString(),
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
  void router.push({
    path: '/workspace',
    query: { panel: 'notifications', t: String(Date.now()) },
  });
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
    :text="userStore.userInfo?.realName"
    logo-text="GainOS"
    @clear-preferences-and-logout="handleLogout"
    @logout="handleLogout"
  >
    <template #user-dropdown>
      <UserDropdown
        :avatar
        :menus
        :text="userStore.userInfo?.realName"
        :description="userStore.userInfo?.username"
        @clear-preferences-and-logout="handleLogout"
        @logout="handleLogout"
      />
    </template>
    <template #header-right-0>
      <WorkspaceSwitcher />
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
</style>
