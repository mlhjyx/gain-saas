<script lang="ts" setup>
import type { NotificationItem } from '@vben/layouts';

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { formatDateTime, navLabel, type NavKey } from '@gain-saas/shared';
import { AuthenticationLoginExpiredModal } from '@vben/common-ui';
import { useRefresh, useWatermark } from '@vben/hooks';
import { ChevronRight, Menu, RotateCw } from '@vben/icons';
import { BasicLayout, LockScreen } from '@vben/layouts';
import { i18n, loadLocaleMessages, type SupportedLanguagesType } from '@vben/locales';
import { preferences, updatePreferences, usePreferences } from '@vben/preferences';
import { useAccessStore, useTabbarStore, useUserStore } from '@vben/stores';
import { useMediaQuery } from '@vueuse/core';

import type { GainosUserInfo } from '#/api/core/user';
import { gainosApi, type AppNotification } from '#/api/gainos';
import CommandPalette from '#/components/gainos/command-palette.vue';
import SdrSidebar from '#/components/gainos/sdr-sidebar.vue';
import { useMenuGroups } from '#/composables/use-menu-groups';
import { $t } from '#/locales';
import { resolveNavTitle } from '#/router/routes/nav';
import { useAuthStore } from '#/store';
import LoginForm from '#/views/_core/authentication/login.vue';

// 侧栏标记显式传入：覆盖 localStorage 里可能残留的旧 logo
const logoGainos = '/logo-gainos.svg?v=pass3';

const notifications = ref<NotificationItem[]>([]);
const notificationLoading = ref(false);
let notificationTimer: ReturnType<typeof setInterval> | null = null;
let notificationPending = false;

const userStore = useUserStore();
const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const accessStore = useAccessStore();
const tabbarStore = useTabbarStore();
const { refresh: refreshActiveRoute } = useRefresh();

// 路由仍是扁平结构；只把 Vben 菜单数据收进新版展示目录分组。
useMenuGroups();

const paletteRef = ref<InstanceType<typeof CommandPalette> | null>(null);
const isEnglish = computed(() => preferences.app.locale === 'en-US');

/** Wave B3：退役双轨设置弹窗，侧栏与账号菜单「设置」统一导航至整页 /settings/account。 */
function openSettings(): void {
  void router.push('/settings/account');
}

function toggleTheme(): void {
  updatePreferences({ theme: { mode: isDark.value ? 'light' : 'dark' } });
}

let suppressLocaleRefresh = false;
async function applyLocaleHotSwitch(next: SupportedLanguagesType): Promise<void> {
  suppressLocaleRefresh = true;
  try {
    await loadLocaleMessages(next);
    await nextTick();
    await nextTick();
  } finally {
    suppressLocaleRefresh = false;
  }
}

async function toggleLocale(): Promise<void> {
  const next: SupportedLanguagesType = isEnglish.value ? 'zh-CN' : 'en-US';
  await applyLocaleHotSwitch(next);
  updatePreferences({ app: { locale: next } });
}

function toggleSidebarCollapse(): void {
  updatePreferences({ sidebar: { collapsed: !sidebarCollapsed.value } });
}

const mobileMenuLabel = computed(() => $t('gainosUi1.nav.openMenu'));
const mobileNavOpen = ref(false);
const { destroyWatermark, updateWatermark } = useWatermark();

// Vben BasicLayout 内置 watch(i18n.global.locale, refreshAll) 会在切换语言时调用
// tabbarStore.refresh() 卸载并重建当前路由组件，导致页面未保存表单草稿丢失。
// 在语言热切换窗口内屏蔽该自动 remount（不影响顶栏手动刷新按钮），实现真正零刷新/零重建。
const originalTabbarRefresh = tabbarStore.refresh.bind(tabbarStore);
tabbarStore.refresh = (async (target: Parameters<typeof originalTabbarRefresh>[0]) => {
  if (suppressLocaleRefresh) return;
  return await originalTabbarRefresh(target);
}) as typeof tabbarStore.refresh;

const refreshing = ref(false);
async function handleRefresh(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    await refreshActiveRoute();
  } finally {
    window.setTimeout(() => {
      refreshing.value = false;
    }, 240);
  }
}

interface BreadcrumbSegment {
  label: string;
  to?: string;
}

const PARENT_NAV_BY_PATH: Record<string, NavKey> = {
  '/analytics': 'analytics',
  '/companies': 'companies',
  '/find-buyers': 'findBuyers',
  '/leads': 'leads',
  '/notifications': 'notifications',
  '/opportunities': 'opportunities',
  '/outreach': 'outreach',
  '/settings': 'settings',
  '/tasks': 'tasks',
  '/workspace': 'workspace',
};

function translateRouteTitle(raw: unknown, locale: string): string {
  if (typeof raw !== 'string' || !raw) return '';
  const navResolved = resolveNavTitle(raw, locale);
  return navResolved !== raw ? navResolved : $t(raw);
}

/** 响应式 48px 顶栏面包屑：随路由与语言实时切换，零刷新更新语种。 */
const breadcrumbs = computed<BreadcrumbSegment[]>(() => {
  // 显式读取 locale + i18n.global.locale，确保切语言时立即重算。
  const locale = preferences.app.locale;
  void i18n.global.locale.value;

  const path = route.path;
  const currentTitle = translateRouteTitle(route.meta?.title, locale);

  // 设置中心：统一展示「设置 / 子页名」（兼容独立注册的 /settings/outreach-mailboxes）
  if (path.startsWith('/settings')) {
    const parentLabel = navLabel('settings', locale);
    if (!currentTitle || currentTitle === parentLabel) {
      return [{ label: parentLabel }];
    }
    return [
      { label: parentLabel, to: '/settings/account' },
      { label: currentTitle },
    ];
  }

  // 带 activePath 的二级详情页：如 /leads/:id -> 买家线索 / 线索档案包，/tasks/:id & /runs/:id -> 寻源记录 / ...
  const activePath =
    typeof route.meta?.activePath === 'string' ? route.meta.activePath : '';
  const parentKey = activePath ? PARENT_NAV_BY_PATH[activePath] : undefined;
  if (parentKey && activePath !== path) {
    const parentLabel = navLabel(parentKey, locale);
    if (currentTitle && currentTitle !== parentLabel) {
      return [
        { label: parentLabel, to: activePath },
        { label: currentTitle },
      ];
    }
    return [{ label: parentLabel }];
  }

  // 一级主菜单页：直接展示当前规范目录名
  const directKey = PARENT_NAV_BY_PATH[path];
  if (directKey) {
    return [{ label: navLabel(directKey, locale) }];
  }

  return currentTitle ? [{ label: currentTitle }] : [{ label: 'GainOS' }];
});

const { isDark, isMobile, isSideMode, sidebarCollapsed } = usePreferences();

// 侧栏最小宽度兜底：防止被 Vben 拖拽缩到 60px 挤压企业名与导航项。
const SIDEBAR_MIN_WIDTH = 220;
watch(
  () => preferences.sidebar.width,
  (width) => {
    if (!isSideMode.value) return;
    if (width < SIDEBAR_MIN_WIDTH) {
      updatePreferences({ sidebar: { width: SIDEBAR_MIN_WIDTH } });
    }
  },
  { immediate: true },
);

// 平板竖屏（768–1023px）自动收成图标窄栏，离开该区间后恢复原偏好。
const isTabletWidth = useMediaQuery('(min-width: 768px) and (max-width: 1023.98px)');
const TABLET_AUTOCOLLAPSE_KEY = 'gainos.sidebar.tabletAutoCollapse.v1';
interface TabletAutoCollapse {
  collapsedBefore: boolean;
}
function readTabletAutoCollapse(): TabletAutoCollapse | null {
  try {
    const raw = localStorage.getItem(TABLET_AUTOCOLLAPSE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<TabletAutoCollapse>) : null;
    return parsed && typeof parsed.collapsedBefore === 'boolean'
      ? { collapsedBefore: parsed.collapsedBefore }
      : null;
  } catch {
    return null;
  }
}
function writeTabletAutoCollapse(value: TabletAutoCollapse | null): void {
  try {
    if (value) localStorage.setItem(TABLET_AUTOCOLLAPSE_KEY, JSON.stringify(value));
    else localStorage.removeItem(TABLET_AUTOCOLLAPSE_KEY);
  } catch {
    /* 本地存储不可用：退化为只在本次会话内恢复 */
  }
}
let clearMarkerTimer: number | undefined;
watch(
  isTabletWidth,
  (tablet) => {
    if (!isSideMode.value) return;
    if (tablet) {
      window.clearTimeout(clearMarkerTimer);
      clearMarkerTimer = undefined;
      if (!readTabletAutoCollapse()) {
        writeTabletAutoCollapse({ collapsedBefore: preferences.sidebar.collapsed });
      }
      if (!preferences.sidebar.collapsed) {
        updatePreferences({ sidebar: { collapsed: true } });
      }
      return;
    }
    const marked = readTabletAutoCollapse();
    if (!marked) return;
    updatePreferences({ sidebar: { collapsed: marked.collapsedBefore } });
    window.clearTimeout(clearMarkerTimer);
    clearMarkerTimer = window.setTimeout(() => {
      clearMarkerTimer = undefined;
      writeTabletAutoCollapse(null);
    }, 600);
  },
  { immediate: true },
);
watch(
  () => preferences.sidebar.collapsed,
  (collapsed) => {
    if (isTabletWidth.value && !collapsed) writeTabletAutoCollapse(null);
  },
);

/** 顶区「通知」入口的未读计数数据源（轮询 + 站内事件即时刷新）。 */
const unreadCount = computed(
  () => notifications.value.filter((item) => !item.isRead).length,
);

/** 侧栏顶区企业头展示工作空间名称（无名时回退 GainOS）。 */
const companyName = computed(
  () =>
    (userStore.userInfo as GainosUserInfo | null)?.workspaceName ??
    userStore.userInfo?.username ??
    '',
);

// Wave B3：4 环节零刷新双语热切换。
watch(
  () => preferences.app.locale,
  async (next, prev) => {
    if (!next || next === prev) return;
    await applyLocaleHotSwitch(next);
    void loadNotifications();
  },
);

const avatar = computed(
  () => userStore.userInfo?.avatar ?? preferences.app.defaultAvatar,
);

function serverTitle(row: AppNotification): string | undefined {
  return preferences.app.locale === 'en-US'
    ? (row.titleEn ?? row.title ?? undefined)
    : (row.title ?? undefined);
}

function notificationTitle(row: AppNotification): string {
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
    case 'SanctionsHoldDetected':
    case 'WorkspaceQuotaWarning':
    case 'WorkspaceQuotaExceeded':
      return withRef(serverTitle(row) ?? $t('gainos.notifications.default'), row);
    default: return withRef(serverTitle(row) ?? '', row);
  }
}

async function loadNotifications(): Promise<void> {
  if (notificationLoading.value) {
    notificationPending = true;
    return;
  }
  notificationLoading.value = true;
  try {
    do {
      notificationPending = false;
      const data = await gainosApi.notifications();
      const page = data as unknown as {
        data?: { items?: AppNotification[] };
        items?: AppNotification[];
      };
      const rows = page.items ?? page.data?.items ?? [];
      notifications.value = rows.map((row) => ({
        avatar: preferences.app.defaultAvatar ?? '/favicon.svg',
        date: formatDateTime(row.createdAt),
        id: row.id,
        isRead: Boolean(row.readAt),
        link: row.link,
        message: notificationMessage(row),
        refId: row.refId,
        title: notificationTitle(row),
        type: row.type,
      }));
    } while (notificationPending);
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
    content: preferences.app.watermarkContent,
    enable: preferences.app.watermark,
    isDark: isDark.value,
  }),
  async ({ content, enable, isDark: isDarkValue }) => {
    if (enable) {
      const watermarkColor = isDarkValue
        ? 'rgba(255, 255, 255, 0.12)'
        : 'rgba(0, 0, 0, 0.12)';

      await updateWatermark({
        advancedStyle: {
          colorStops: [
            { color: watermarkColor, offset: 0 },
            { color: watermarkColor, offset: 1 },
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
  { immediate: true },
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
  tabbarStore.refresh = originalTabbarRefresh;
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
    <!-- PR-UI1：48px 极简面包屑顶栏左侧（移动端汉堡键 + 响应式面包屑） -->
    <template #header-left-1>
      <div class="gs-topbar-left">
        <button
          v-if="isMobile"
          :aria-expanded="mobileNavOpen"
          :aria-label="mobileMenuLabel"
          aria-controls="gainos-mobile-nav"
          aria-haspopup="dialog"
          class="sdr-mobile-burger"
          type="button"
          @click="mobileNavOpen = true"
        >
          <Menu :size="18" aria-hidden="true" />
        </button>

        <nav
          :aria-label="$t('gainosUi1.header.breadcrumbLabel')"
          class="gs-topbar-crumb"
          data-gs="topbar-breadcrumb"
        >
          <ol class="gs-topbar-crumb__list">
            <li
              v-for="(seg, idx) in breadcrumbs"
              :key="`${seg.to ?? seg.label}-${idx}`"
              class="gs-topbar-crumb__item"
            >
              <ChevronRight
                v-if="idx > 0"
                :size="14"
                aria-hidden="true"
                class="gs-topbar-crumb__sep"
              />
              <RouterLink
                v-if="seg.to && idx < breadcrumbs.length - 1"
                :to="seg.to"
                class="gs-topbar-crumb__link"
              >
                {{ seg.label }}
              </RouterLink>
              <span
                v-else
                aria-current="page"
                class="gs-topbar-crumb__current"
              >
                {{ seg.label }}
              </span>
            </li>
          </ol>
        </nav>
      </div>
    </template>

    <!-- PR-UI1：48px 极简顶栏右侧（克制的页面刷新小图标按钮） -->
    <template #header-right-1>
      <button
        :aria-label="$t('gainosUi1.header.refresh')"
        :class="{ 'is-spinning': refreshing }"
        :title="$t('gainosUi1.header.refresh')"
        class="gs-topbar-refresh"
        data-gs="topbar-refresh"
        type="button"
        @click="handleRefresh"
      >
        <RotateCw :size="15" aria-hidden="true" />
      </button>
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

  <SdrSidebar
    v-model:open="mobileNavOpen"
    :logo-src="logoGainos"
    :unread-count="unreadCount"
    :user-avatar="avatar"
    :user-email="userStore.userInfo?.username ?? ''"
    :workspace-name="companyName"
    @logout="handleLogout"
    @open-search="paletteRef?.open()"
    @open-settings="openSettings"
    @toggle-collapse="toggleSidebarCollapse"
    @toggle-locale="toggleLocale"
    @toggle-theme="toggleTheme"
  />
  <CommandPalette ref="paletteRef" />
</template>

<style scoped>
.gs-topbar-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding-left: 8px;
}

.sdr-mobile-burger {
  display: grid;
  place-items: center;
  flex: none;
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--gs-fg-2);
  cursor: pointer;
}

.sdr-mobile-burger:hover {
  background: var(--gs-surface-2);
  color: var(--gs-fg);
}

.gs-topbar-crumb {
  min-width: 0;
}

.gs-topbar-crumb__list {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  min-width: 0;
}

.gs-topbar-crumb__item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.gs-topbar-crumb__sep {
  flex: none;
  color: var(--gs-fg-placeholder);
}

.gs-topbar-crumb__link {
  color: var(--gs-fg-muted);
  font-size: 13px;
  font-weight: 500;
  text-decoration: none;
  white-space: nowrap;
  transition: color 0.15s ease;
}

.gs-topbar-crumb__link:hover {
  color: var(--gs-fg);
}

.gs-topbar-crumb__current {
  color: var(--gs-fg);
  font-size: 13.5px;
  font-weight: 500;
  letter-spacing: -0.011em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gs-topbar-refresh {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  margin-right: 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--gs-fg-subtle);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.gs-topbar-refresh:hover {
  background: var(--gs-surface-2);
  color: var(--gs-fg);
}

.gs-topbar-refresh:focus-visible {
  outline: none;
  box-shadow: var(--gs-shadow-focus);
}

.gs-topbar-refresh.is-spinning :deep(svg) {
  animation: gs-spin 0.45s linear infinite;
}

@keyframes gs-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

<style>
/* PR-UI1：48px 极简顶栏与主画布融合（浅色 #FFFFFF / 深色 #0B0D12 + 1px 底细线），
   同时隐藏 Vben 在移动端自动注入的 toggle-sidebar 按钮（改由 #header-left-1 里的 .sdr-mobile-burger 接管）。 */
[data-layout-region='header'] > header {
  background: var(--gs-bg) !important;
  border-bottom: 1px solid var(--gs-border) !important;
  padding-left: 4px !important;
  padding-right: 4px !important;
}

[data-layout-region='header'] [data-layout-action='toggle-sidebar'] {
  display: none !important;
}

/* 隐藏 Vben 未启用的占位 logo 容器（仅针对首子节点，避免误伤中间 .flex-1 撑开右侧刷新按钮） */
[data-layout-region='header'] > header > div:first-child:empty {
  display: none !important;
}

.dark [data-layout-region='header'] > header.dark.bg-header {
  --header: 223 24% 6%;
}
</style>
