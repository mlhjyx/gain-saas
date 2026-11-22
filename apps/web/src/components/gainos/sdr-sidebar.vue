<script lang="ts" setup>
/**
 * AgentSDR 风格侧边栏导航（pass4）。
 *
 * Vben 的菜单渲染在 packages/ 内（禁改），这里用 fixed 覆盖层在侧栏区域内
 * 渲染 SDR 原版结构：分组小标签 + 永远可见的菜单行（36px、8px 圆角、
 * 灰底药丸 active + 近黑文字），hover 同灰底。桌面隐藏 Vben 菜单
 * （gainos.css），移动端抽屉仍走 Vben 菜单。
 * 数据与 use-menu-groups 同源（accessMenus），不新增路由。
 */
import type { MenuRecordRaw } from '@vben/types';

import { computed } from 'vue';
import { useRoute } from 'vue-router';

import { preferences, usePreferences } from '@vben/preferences';
import { useAccessStore } from '@vben/stores';

import { IconifyIcon } from '@vben/icons';

import { $t } from '#/locales';

import { useRouter } from 'vue-router';

defineOptions({ name: 'SdrSidebar' });

const emit = defineEmits<{ openSearch: [] }>();

const route = useRoute();
const router = useRouter();
const accessStore = useAccessStore();
const { isMobile, sidebarCollapsed } = usePreferences();

const isEnglish = computed(() => preferences.app.locale === 'en-US');
const searchLabel = computed(() =>
  isEnglish.value ? 'Search or jump to…' : '搜索或跳转…',
);

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
    } else if (menu.path && !menu.path.startsWith('__')) {
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

const showRail = computed(() => !isMobile.value && sidebarCollapsed.value);

/** 侧栏 logo 行高度 = header 高度 - 1（layout-sidebar headerStyle）。 */
const navStyle = computed(() => ({
  top: `${Math.max(0, preferences.header.height - 1)}px`,
  width: `${preferences.sidebar.width}px`,
}));
const showFull = computed(() => !isMobile.value && !sidebarCollapsed.value);

function go(path: string): void {
  void router.push(path);
}
</script>

<template>
  <!-- 完整侧栏：分组标签 + 菜单行（SDR 规格） -->
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
  </nav>

  <!-- 折叠态：图标窄栏（SDR 68px rail），title 作 tooltip -->
  <nav
    v-else-if="showRail"
    class="sdr-rail"
    data-sdr-nav
    :style="navStyle"
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
  </nav>
</template>

<style scoped>
.sdr-nav {
  position: fixed;
  left: 0;
  bottom: 0;
  /* 侧栏 aside 自身 z-index=201，覆盖层必须更高才能接收点击。 */
  z-index: 202;
  display: flex;
  flex-direction: column;
  padding: 8px 12px 44px;
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
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 折叠态图标窄栏（SDR 68px rail） */
.sdr-rail {
  position: fixed;
  left: 0;
  bottom: 0;
  z-index: 202;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 12px 40px;
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
  pointer-events: auto;
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
</style>
