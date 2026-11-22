<script lang="ts" setup>
/**
 * 设置弹窗（AgentSDR SettingsShell 同款，pass5）。
 *
 * SDR 的侧栏不列设置分组：底部「设置」打开一个浮层，浮层内左侧是设置分区、
 * 右侧是真实设置页。这里照搬该结构：
 * - 侧栏（sdr-sidebar）过滤掉 /settings 分组，底部「设置」改为打开本弹窗；
 * - 直接访问 /settings/* 仍是整页（深链、命令面板、旧链接全部不变）；
 * - 五个设置页复用真实路由组件，标题/图标/权限都取自 accessMenus
 *   （非管理员只会看到「成员与角色」，与服务端权限一致）。
 *
 * 内嵌页通过 SETTINGS_EMBEDDED_KEY 得知自己不在路由页上：
 * 拒绝 URL query 同步（背景路由是用户当前页面），其余行为不变。
 */
import { computed, onBeforeUnmount, provide, ref, watch } from 'vue';
import { defineAsyncComponent } from 'vue';
import { useRoute } from 'vue-router';

import { IconifyIcon } from '@vben/icons';
import { preferences } from '@vben/preferences';
import { useAccessStore } from '@vben/stores';

import { $t } from '#/locales';

import { SETTINGS_EMBEDDED_KEY } from './settings-dialog-context';

defineOptions({ name: 'SettingsDialog' });

const open = defineModel<boolean>('open', { default: false });

const route = useRoute();
const accessStore = useAccessStore();

const isEnglish = computed(() => preferences.app.locale === 'en-US');
const labels = computed(() =>
  isEnglish.value
    ? { close: 'Close settings', title: 'Settings' }
    : { close: '关闭设置', title: '设置' },
);

/** 五个设置页 = 真实路由组件（不做二次封装，行为/权限与整页一致）。 */
const PAGES: Record<string, ReturnType<typeof defineAsyncComponent>> = {
  '/settings/members': defineAsyncComponent(
    () => import('#/views/settings/members.vue'),
  ),
  '/settings/suppressions': defineAsyncComponent(
    () => import('#/views/settings/suppressions.vue'),
  ),
  '/settings/sources': defineAsyncComponent(
    () => import('#/views/settings/sources.vue'),
  ),
  '/settings/privacy': defineAsyncComponent(
    () => import('#/views/settings/privacy.vue'),
  ),
  '/settings/audit': defineAsyncComponent(
    () => import('#/views/settings/audit.vue'),
  ),
};

interface Section {
  icon?: string;
  label: string;
  path: string;
}

/** 分区导航与侧栏同源（accessMenus 的 /settings 子树，已按权限过滤）。 */
const sections = computed<Section[]>(() => {
  const settings = accessStore.accessMenus.find(
    (menu) => menu.path === '/settings',
  );
  return (settings?.children ?? [])
    .filter((menu): menu is typeof menu & { path: string } =>
      Boolean(menu.path && PAGES[menu.path]),
    )
    .map((menu) => ({
      icon: typeof menu.icon === 'string' ? menu.icon : undefined,
      label: menu.name,
      path: menu.path,
    }));
});

const activePath = ref<string>('/settings/members');
const activeComponent = computed(() => PAGES[activePath.value]);

function resetActive(): void {
  // 从 /settings/* 整页打开时落在同一分区，否则默认成员与角色。
  const here = sections.value.find((item) => route.path.startsWith(item.path));
  activePath.value = here?.path ?? sections.value[0]?.path ?? '/settings/members';
}

watch(open, (next) => {
  if (next) resetActive();
});

// 弹窗内页面若把用户带去别的路由（空态链接等），关闭弹窗露出目标页。
watch(
  () => route.path,
  () => {
    if (open.value) open.value = false;
  },
);

provide(SETTINGS_EMBEDDED_KEY, true);

const panelRef = ref<HTMLElement | null>(null);
let restoreFocus: HTMLElement | null = null;

function close(): void {
  open.value = false;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation();
    close();
    return;
  }
  if (event.key !== 'Tab' || !panelRef.value) return;
  const focusables = panelRef.value.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  if (focusables.length === 0) return;
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === panelRef.value)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function onScrimClick(event: MouseEvent): void {
  if (event.target === event.currentTarget) close();
}

watch(open, (next) => {
  if (next) {
    restoreFocus = document.activeElement as HTMLElement | null;
    document.addEventListener('keydown', onKeydown, true);
    queueMicrotask(() => panelRef.value?.focus());
  } else {
    document.removeEventListener('keydown', onKeydown, true);
    restoreFocus?.focus?.();
    restoreFocus = null;
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="gs-settings">
      <div
        v-if="open"
        class="gs-settings"
        role="presentation"
        @mousedown="onScrimClick"
      >
        <section
          ref="panelRef"
          class="gs-settings__panel"
          role="dialog"
          aria-modal="true"
          :aria-label="labels.title"
          tabindex="-1"
          @mousedown.stop
        >
          <aside class="gs-settings__rail">
            <div class="gs-settings__railhead">
              <p class="gs-settings__title">{{ labels.title }}</p>
              <button
                type="button"
                class="gs-settings__close"
                :aria-label="labels.close"
                :title="labels.close"
                @click="close"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" /></svg>
              </button>
            </div>
            <nav class="gs-settings__nav" :aria-label="labels.title">
              <button
                v-for="item in sections"
                :key="item.path"
                type="button"
                class="gs-settings__row"
                :class="{ 'is-active': item.path === activePath }"
                :aria-current="item.path === activePath ? 'page' : undefined"
                @click="activePath = item.path"
              >
                <IconifyIcon :icon="item.icon ?? 'lucide:circle-dot'" />
                <span>{{ $t(item.label) }}</span>
              </button>
            </nav>
          </aside>
          <div class="gs-settings__body">
            <Suspense>
              <component :is="activeComponent" :key="activePath" />
              <template #fallback>
                <div class="gs-settings__loading" aria-hidden="true">
                  <span></span><span></span><span></span>
                </div>
              </template>
            </Suspense>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 遮罩：只压暗、不模糊，保持背景可辨（SDR 同款克制）。 */
.gs-settings {
  position: fixed;
  inset: 0;
  z-index: 800;
  display: grid;
  place-items: center;
  padding: 32px;
  background: rgba(23, 23, 23, 0.32);
}
:global(.dark) .gs-settings {
  background: rgba(0, 0, 0, 0.62);
}

.gs-settings__panel {
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  width: min(1080px, calc(100vw - 64px));
  height: min(780px, calc(100vh - 72px));
  overflow: hidden;
  border: 1px solid var(--gs-border);
  border-radius: 16px;
  background: var(--gs-surface);
  box-shadow: var(--gs-shadow-modal);
  outline: none;
}

/* 左栏：标题 + 分区行（与侧栏行同一套语言：36px / 8px 圆角 / 灰底药丸）。 */
.gs-settings__rail {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  overflow-y: auto;
  border-right: 1px solid var(--gs-border);
  background: var(--gs-surface-3);
}
.gs-settings__railhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 4px 10px 8px;
}
.gs-settings__title {
  margin: 0;
  color: var(--gs-fg);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.011em;
}
.gs-settings__close {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--gs-fg-muted);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.gs-settings__close:hover {
  background: var(--gs-surface-2);
  color: var(--gs-fg);
}
.gs-settings__close svg { width: 16px; height: 16px; }

.gs-settings__nav {
  display: grid;
  gap: 2px;
}
.gs-settings__row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 36px;
  padding: 0 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--gs-fg-muted);
  font-size: 14px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.gs-settings__row :deep(svg) {
  width: 18px;
  height: 18px;
  flex: none;
  color: var(--gs-fg-subtle);
  transition: color 0.15s ease;
}
.gs-settings__row:hover {
  background: var(--gs-surface-2);
  color: var(--gs-fg);
}
.gs-settings__row:hover :deep(svg) { color: var(--gs-fg-muted); }
.gs-settings__row.is-active {
  background: var(--gs-surface-2);
  color: var(--gs-fg);
}
.gs-settings__row.is-active :deep(svg) { color: var(--gs-fg); }
.gs-settings__row:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--gs-surface), 0 0 0 4px var(--gs-accent);
}

/* 右栏：真实设置页（页面自带页头），独立滚动。 */
.gs-settings__body {
  min-width: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--gs-surface);
}

/* 异步页加载占位：三条骨架，不闪空白。 */
.gs-settings__loading {
  display: grid;
  gap: 12px;
  padding: 24px;
}
.gs-settings__loading span {
  height: 16px;
  border-radius: 6px;
  background: var(--gs-surface-2);
}
.gs-settings__loading span:nth-child(1) { width: 40%; height: 24px; }
.gs-settings__loading span:nth-child(2) { width: 70%; }
.gs-settings__loading span:nth-child(3) { width: 55%; }

/* 进出场：遮罩淡入、面板微缩放上浮（180ms，无弹跳）。 */
.gs-settings-enter-active {
  transition: opacity 0.18s ease;
}
.gs-settings-leave-active {
  transition: opacity 0.14s ease;
}
.gs-settings-enter-active .gs-settings__panel {
  transition: transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 0.18s ease;
}
.gs-settings-leave-active .gs-settings__panel {
  transition: transform 0.14s ease, opacity 0.14s ease;
}
.gs-settings-enter-from,
.gs-settings-leave-to {
  opacity: 0;
}
.gs-settings-enter-from .gs-settings__panel,
.gs-settings-leave-to .gs-settings__panel {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}

/* 移动端：全屏浮层，分区导航收成顶部横向条。 */
@media (max-width: 767px) {
  .gs-settings {
    padding: 0;
  }
  .gs-settings__panel {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    width: 100%;
    height: 100%;
    border: 0;
    border-radius: 0;
  }
  .gs-settings__rail {
    flex-direction: row;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    overflow-x: auto;
    border-right: 0;
    border-bottom: 1px solid var(--gs-border);
    scrollbar-width: none;
  }
  .gs-settings__railhead {
    flex: none;
    padding: 0 4px 0 0;
  }
  .gs-settings__title {
    display: none;
  }
  .gs-settings__nav {
    display: flex;
    gap: 2px;
  }
  .gs-settings__row {
    height: 34px;
    white-space: nowrap;
  }
  .gs-settings__row :deep(span) {
    display: none;
  }
  .gs-settings__row.is-active :deep(span) {
    display: inline;
  }
}
</style>
