<script lang="ts" setup>
/**
 * 整页设置单轨容器（Wave B3）：
 * - 退役双轨 SettingsDialog，所有 /settings/* 统一为「左侧分组子导航 + 右侧内容区」；
 * - 响应式按内容区宽度（@container）：宽屏（>=840px）左栏 224px 分组导航，窄屏（<840px）顶部横向分段条；
 * - 角色门控与后端权限对齐（useWorkspaceAccess fail-closed）：
 *   全员可见「账号与空间」「成员与角色」；admin 额外可见「禁联名单」「数据来源」「隐私与数据」「审计日志」「发信邮箱」。
 */
import { computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';

import { IconifyIcon } from '@vben/icons';

import { useWorkspaceAccess } from '#/composables/use-workspace-access';
import { $t } from '#/locales';

defineOptions({ name: 'SettingsShell' });

defineProps<{ subtitle?: string; title: string }>();

interface SettingsNavItem {
  adminOnly?: boolean;
  icon: string;
  labelKey: string;
  path: string;
}

interface SettingsNavGroup {
  adminOnly?: boolean;
  id: string;
  items: SettingsNavItem[];
  labelKey: string;
}

const NAV_GROUPS: SettingsNavGroup[] = [
  {
    id: 'account',
    items: [
      {
        icon: 'lucide:user-cog',
        labelKey: 'gainosB3.menu.account',
        path: '/settings/account',
      },
      {
        icon: 'lucide:users-round',
        labelKey: 'gainosB3.menu.members',
        path: '/settings/members',
      },
    ],
    labelKey: 'gainosB3.shell.groupAccount',
  },
  {
    adminOnly: true,
    id: 'governance',
    items: [
      {
        adminOnly: true,
        icon: 'lucide:ban',
        labelKey: 'gainosB3.menu.suppressions',
        path: '/settings/suppressions',
      },
      {
        adminOnly: true,
        icon: 'lucide:database',
        labelKey: 'gainosB3.menu.sources',
        path: '/settings/sources',
      },
      {
        adminOnly: true,
        icon: 'lucide:shield-check',
        labelKey: 'gainosB3.menu.privacy',
        path: '/settings/privacy',
      },
      {
        adminOnly: true,
        icon: 'lucide:scroll-text',
        labelKey: 'gainosB3.menu.audit',
        path: '/settings/audit',
      },
      {
        adminOnly: true,
        icon: 'lucide:mail-check',
        labelKey: 'gainosB3.menu.outreachMailboxes',
        path: '/settings/outreach-mailboxes',
      },
    ],
    labelKey: 'gainosB3.shell.groupAdmin',
  },
];

const route = useRoute();
const { ensureLoaded, isAdmin } = useWorkspaceAccess();

const visibleGroups = computed(() =>
  NAV_GROUPS.filter((group) => !group.adminOnly || isAdmin.value).map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.adminOnly || isAdmin.value),
  })),
);

function isActive(path: string): boolean {
  return route.path === path || route.path.startsWith(`${path}/`);
}

onMounted(() => {
  void ensureLoaded();
});
</script>

<template>
  <div class="gss-root @container w-full" data-gs="settings-shell">
    <div
      class="gss-layout mx-auto grid w-full max-w-[1280px] grid-cols-1 gap-5 px-4 py-5 pb-12 @min-[640px]:px-6 @min-[840px]:grid-cols-[224px_minmax(0,1fr)] @min-[840px]:items-start @min-[840px]:gap-6"
    >
      <aside class="min-w-0 @min-[840px]:sticky @min-[840px]:top-4" data-gs="settings-subnav">
        <nav
          :aria-label="$t('gainosB3.shell.navLabel')"
          class="gss-nav rounded-xl border border-[var(--gs-border)] bg-[var(--gs-surface)] p-2 @min-[840px]:p-3"
        >
          <div class="flex items-center gap-1 overflow-x-auto @min-[840px]:grid @min-[840px]:gap-4 @min-[840px]:overflow-visible">
            <section
              v-for="group in visibleGroups"
              :key="group.id"
              class="flex shrink-0 items-center gap-1 @min-[840px]:grid @min-[840px]:gap-1"
            >
              <p
                class="m-0 hidden px-2.5 pb-1 text-[12px] font-medium text-[var(--gs-fg-2)] @min-[840px]:block"
                data-gs="settings-nav-group"
              >
                {{ $t(group.labelKey) }}
              </p>
              <RouterLink
                v-for="item in group.items"
                :key="item.path"
                :aria-current="isActive(item.path) ? 'page' : undefined"
                :class="
                  isActive(item.path)
                    ? 'bg-[var(--gs-surface-2)] font-semibold text-[var(--gs-fg)]'
                    : 'font-medium text-[var(--gs-fg-2)] hover:bg-[var(--gs-surface-2)] hover:text-[var(--gs-fg)]'
                "
                :data-gs-path="item.path"
                :to="item.path"
                class="gss-nav-item flex h-9 shrink-0 items-center gap-2 rounded-lg px-2.5 text-[13.5px] no-underline transition-colors duration-150"
                data-gs="settings-nav-item"
              >
                <IconifyIcon :icon="item.icon" class="size-4 shrink-0" aria-hidden="true" />
                <span class="whitespace-nowrap">{{ $t(item.labelKey) }}</span>
              </RouterLink>
            </section>
          </div>
        </nav>
      </aside>

      <div class="grid min-w-0 content-start gap-4">
        <header class="flex flex-wrap items-start justify-between gap-4">
          <div class="min-w-0">
            <h1 class="m-0 text-[24px] font-medium leading-[32px] tracking-[-0.011em] text-[var(--gs-fg)]">
              {{ title }}
            </h1>
            <p
              v-if="subtitle"
              class="mt-1.5 mb-0 max-w-[680px] text-[15px] leading-[22px] text-[var(--gs-fg-2)]"
            >
              {{ subtitle }}
            </p>
          </div>
          <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2">
            <slot name="actions"></slot>
          </div>
        </header>
        <slot></slot>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gss-nav {
  box-shadow: var(--gs-shadow-xs);
}
.gss-nav-item:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--gs-surface), 0 0 0 4px var(--gs-accent);
}
</style>
