<script lang="ts" setup>
import type { NotificationItem } from '@vben/layouts';

import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

import { AuthenticationLoginExpiredModal } from '@vben/common-ui';
import { useWatermark } from '@vben/hooks';
import { BasicLayout, LockScreen } from '@vben/layouts';
import { preferences, updatePreferences, usePreferences } from '@vben/preferences';
import { useAccessStore, useUserStore } from '@vben/stores';

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

// pass5：折叠开关也在品牌行（Vben 侧栏左下角按钮已通过 sidebar.collapsedButton=false 关闭）。
const collapseToggleLabel = computed(() =>
  isEnglish.value ? 'Toggle sidebar' : '切换侧边栏',
);
function toggleSidebarCollapse(): void {
  updatePreferences({ sidebar: { collapsed: !sidebarCollapsed.value } });
}

// pass5：顶栏隐藏后 Vben 的移动端抽屉开关（在顶栏里）被一并藏起，
// 这里在标签栏左侧放一个可见按钮，代理点击那个隐藏开关打开抽屉。
const mobileMenuLabel = computed(() =>
  isEnglish.value ? 'Open menu' : '打开菜单',
);
function openMobileDrawer(): void {
  document
    .querySelector(
      "[data-layout-region='header'] [data-layout-action='toggle-sidebar']",
    )
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}
const { destroyWatermark, updateWatermark } = useWatermark();
const { isDark, isMobile, isSideMode, sidebarCollapsed } = usePreferences();
// pass4：主题/语言切换（isDark 见下方的 usePreferences 解构）。
/** 侧栏底部通知行的未读红点数据源（通知部件已从顶栏移除，轮询保留）。 */
const unreadCount = computed(
  () => notifications.value.filter((item) => !item.isRead).length,
);

/** 侧栏底部账号卡展示公司名；人（realName）只出现在问候与水印里（P5b-14）。 */
const companyName = computed(
  () =>
    (userStore.userInfo as GainosUserInfo | null)?.workspaceName ??
    userStore.userInfo?.username ??
    '',
);

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

  <!-- pass4/5：主题/语言/折叠都在侧栏品牌行右侧（AgentSDR 同款位置）。 -->
  <div
    v-if="isSideMode && !isMobile && !sidebarCollapsed && !preferences.sidebar.hidden"
    class="sdr-brandtools"
    :style="{
      left: `${preferences.sidebar.width - 112}px`,
      top: `${Math.max(0, Math.round((preferences.header.height - 1) / 2) - 16)}px`,
    }"
  >
    <button
      type="button"
      class="sdr-brandtools__btn"
      :aria-label="collapseToggleLabel"
      :title="collapseToggleLabel"
      @click="toggleSidebarCollapse"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M9.5 4v16" /></svg>
    </button>
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

  <!-- pass5：移动端抽屉开关（顶栏隐藏后 Vben 的 burger 不可见，代理点击它）。 -->
  <button
    v-if="isMobile"
    type="button"
    class="sdr-mobile-burger"
    :aria-label="mobileMenuLabel"
    :aria-expanded="false"
    @click="openMobileDrawer"
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke-linecap="round" /></svg>
  </button>

  <SdrSidebar
    :unread-count="unreadCount"
    :user-avatar="avatar"
    :user-email="userStore.userInfo?.username ?? ''"
    :workspace-name="companyName"
    @logout="handleLogout"
    @open-search="paletteRef?.open()"
    @toggle-collapse="toggleSidebarCollapse"
  />
  <CommandPalette ref="paletteRef" />
</template>

<style scoped>

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

/* pass5：移动端抽屉开关——贴在标签栏左侧（标签栏高 40，见 gainos.css 让位）。 */
.sdr-mobile-burger {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 202;
  display: grid;
  place-items: center;
  width: 44px;
  height: 40px;
  border: 0;
  background: transparent;
  color: var(--gs-fg-2);
  cursor: pointer;
}
.sdr-mobile-burger svg { width: 20px; height: 20px; }


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
