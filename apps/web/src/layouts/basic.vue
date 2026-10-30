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
const { isDark } = usePreferences();
const showDot = computed(() =>
  notifications.value.some((item) => !item.isRead),
);

const menus = computed(() => []);

const avatar = computed(() => {
  return userStore.userInfo?.avatar ?? preferences.app.defaultAvatar;
});

function notificationTitle(row: AppNotification): string {
  switch (row.type) {
    case 'DiscoveryRunCompleted': return $t('gainos.notifications.runCompleted');
    case 'DiscoveryRunPartial': return $t('gainos.notifications.runPartial');
    case 'DiscoveryRunFailed': return $t('gainos.notifications.runFailed');
    case 'LeadQualified': return $t('gainos.notifications.leadQualified');
    case 'ClaimApproved': return $t('gainos.notifications.claimApproved');
    case 'ClaimRejected': return $t('gainos.notifications.claimRejected');
    default: return row.title ?? $t('gainos.notifications.default');
  }
}

function notificationMessage(row: AppNotification): string {
  switch (row.type) {
    case 'DiscoveryRunCompleted': return $t('gainos.notifications.runCompletedMessage');
    case 'DiscoveryRunPartial': return $t('gainos.notifications.runPartialMessage');
    case 'DiscoveryRunFailed': return $t('gainos.notifications.runFailedMessage');
    case 'LeadQualified': return $t('gainos.notifications.leadQualifiedMessage');
    case 'ClaimApproved': return $t('gainos.notifications.claimApprovedMessage');
    case 'ClaimRejected': return $t('gainos.notifications.claimRejectedMessage');
    default: return row.title ?? '';
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
</template>
