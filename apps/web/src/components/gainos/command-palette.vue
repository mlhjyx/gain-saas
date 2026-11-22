<script lang="ts" setup>
/**
 * 全局命令面板（pass3 C1，AgentSDR CommandPalette 模式）。
 *
 * ⌘K / Ctrl+K 唤起；模糊搜索「全部页面 + 常用动作」，键盘上下选择回车跳转。
 * 数据纯前端：页面来自 accessMenus（与侧边栏同源，含设置子页），动作是静态
 * 列表且只指向既有路由——不新增任何后端接口 / 字段 / 路由。
 * 内置的 Vben GlobalSearch 已在 preferences.widget.globalSearch=false 关闭，
 * ⌘K 只由本组件注册，不会双开。
 */
import type { MenuRecordRaw } from '@vben/types';

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { preferences } from '@vben/preferences';
import { useAccessStore } from '@vben/stores';

import { useMagicKeys, whenever } from '@vueuse/core';

import { $t } from '#/locales';

defineOptions({ name: 'CommandPalette' });

interface PaletteItem {
  hint: string;
  id: string;
  kind: 'action' | 'page';
  label: string;
  path: string;
  query?: Record<string, string>;
}

const router = useRouter();
const accessStore = useAccessStore();
const isEnglish = computed(() => preferences.app.locale === 'en-US');

const open = ref(false);
const keyword = ref('');
const activeIndex = ref(0);
const inputRef = ref<HTMLInputElement>();
const lastFocus = ref<HTMLElement | null>(null);

/** 静态动作：只指向既有路由（pass3 禁止新增路由）。 */
const actionItems = computed<PaletteItem[]>(() => {
  const t = isEnglish.value
    ? {
        discover: 'Find buyers',
        newCampaign: 'New campaign plan',
        viewLeads: 'View buyer leads',
        invite: 'Invite member',
        notifications: 'View notifications',
        replies: 'Reply inbox',
      }
    : {
        discover: '去发现买家',
        newCampaign: '新建战役计划',
        viewLeads: '查看买家线索',
        invite: '邀请成员',
        notifications: '查看通知',
        replies: '回复收件箱',
      };
  return [
    { hint: t.discover, id: 'act-discover', kind: 'action', label: t.discover, path: '/find-buyers' },
    { hint: t.newCampaign, id: 'act-campaign', kind: 'action', label: t.newCampaign, path: '/campaigns' },
    { hint: t.viewLeads, id: 'act-leads', kind: 'action', label: t.viewLeads, path: '/leads' },
    { hint: t.invite, id: 'act-invite', kind: 'action', label: t.invite, path: '/settings/members' },
    { hint: t.notifications, id: 'act-notify', kind: 'action', label: t.notifications, path: '/notifications' },
    {
      hint: t.replies,
      id: 'act-replies',
      kind: 'action',
      label: t.replies,
      path: '/growth',
      query: { tab: 'replies' },
    },
  ];
});

/** 页面：拍平 accessMenus（分组名作为 hint），与侧边栏同源。 */
const pageItems = computed<PaletteItem[]>(() => {
  const rows: PaletteItem[] = [];
  const walk = (menus: MenuRecordRaw[], hint: string) => {
    for (const menu of menus) {
      if (menu.children?.length) {
        walk(menu.children, menu.name || hint);
        continue;
      }
      if (!menu.path || menu.path.startsWith('__')) continue;
      // 菜单 name 可能是 i18n key（路由 meta 在 i18n 初始化前求值），
      // 统一过 $t 再展示/匹配——与侧边栏同款，避免出现 gainos.menu.* 原文。
      rows.push({
        hint: hint || $t(menu.name),
        id: `page-${menu.path}`,
        kind: 'page',
        label: $t(menu.name),
        path: menu.path,
        query: menu.query as Record<string, string> | undefined,
      });
    }
  };
  walk(accessStore.accessMenus, '');
  return rows;
});

const allItems = computed(() => [...actionItems.value, ...pageItems.value]);

/** 模糊匹配：连续子串 > 非连续子序列；命中字段含 hint。 */
function matchScore(item: PaletteItem, query: string): number {
  const label = item.label.toLowerCase();
  const hint = item.hint.toLowerCase();
  if (label.startsWith(query)) return 3;
  if (label.includes(query)) return 2;
  if (hint.includes(query)) return 1;
  let cursor = -1;
  for (const char of query) {
    cursor = label.indexOf(char, cursor + 1);
    if (cursor < 0) return 0;
  }
  return 1;
}

const results = computed<PaletteItem[]>(() => {
  const query = keyword.value.trim().toLowerCase();
  if (!query) return allItems.value.slice(0, 40);
  return allItems.value
    .map((item) => ({ item, score: matchScore(item, query) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 40)
    .map((row) => row.item);
});

function openPalette(): void {
  lastFocus.value = document.activeElement as HTMLElement | null;
  open.value = true;
  keyword.value = '';
  activeIndex.value = 0;
  void nextTick(() => inputRef.value?.focus());
}

function closePalette(): void {
  open.value = false;
  lastFocus.value?.focus?.();
}

function togglePalette(): void {
  if (open.value) closePalette();
  else openPalette();
}

defineExpose({ close: closePalette, open: openPalette, toggle: togglePalette });

function go(item: PaletteItem): void {
  closePalette();
  void router.push({ path: item.path, query: item.query });
}

function move(delta: number): void {
  if (results.value.length === 0) return;
  activeIndex.value =
    (activeIndex.value + delta + results.value.length) % results.value.length;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    move(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    move(-1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const item = results.value[activeIndex.value];
    if (item) go(item);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closePalette();
  }
}

watch(keyword, () => {
  activeIndex.value = 0;
});

const keys = useMagicKeys();
const cmd = keys['ctrl+k'];
const meta = keys['meta+k'];
if (cmd) whenever(cmd, togglePalette);
if (meta) whenever(meta, togglePalette);

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="cmdk"
      role="dialog"
      aria-modal="true"
      :aria-label="isEnglish ? 'Command palette' : '命令面板'"
      @click.self="closePalette"
    >
      <div class="cmdk__panel">
        <div class="cmdk__input-row">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" />
          </svg>
          <input
            ref="inputRef"
            v-model="keyword"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            :aria-activedescendant="results[activeIndex]?.id"
            :aria-label="isEnglish ? 'Search pages and actions' : '搜索页面与动作'"
            :placeholder="isEnglish ? 'Search pages and actions…' : '搜索页面与动作…'"
            autocomplete="off"
          />
          <kbd>esc</kbd>
        </div>
        <ul id="cmdk-list" class="cmdk__list" role="listbox">
          <li
            v-for="(item, index) in results"
            :id="item.id"
            :key="item.id"
            role="option"
            :aria-selected="index === activeIndex"
            :class="{ 'is-active': index === activeIndex }"
            @click="go(item)"
            @mousemove="activeIndex = index"
          >
            <span class="cmdk__label">{{ item.label }}</span>
            <span class="cmdk__meta">
              <span v-if="item.kind === 'action'" class="cmdk__kind">
                {{ isEnglish ? 'Action' : '动作' }}
              </span>
              <span class="cmdk__hint">{{ item.hint }}</span>
            </span>
          </li>
          <li v-if="results.length === 0" class="cmdk__empty" role="status">
            {{ isEnglish ? 'No matches' : '没有匹配的结果' }}
          </li>
        </ul>
        <footer class="cmdk__foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> {{ isEnglish ? 'navigate' : '选择' }}</span>
          <span><kbd>↵</kbd> {{ isEnglish ? 'open' : '打开' }}</span>
          <span><kbd>esc</kbd> {{ isEnglish ? 'close' : '关闭' }}</span>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cmdk {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 12vh 16px 16px;
  background: var(--gs-mask);
  backdrop-filter: blur(2px);
}

.cmdk__panel {
  display: grid;
  grid-template-rows: auto 1fr auto;
  width: min(560px, 100%);
  max-height: 60vh;
  overflow: hidden;
  border: 1px solid var(--gs-border);
  border-radius: var(--gs-radius-20);
  background: var(--gs-surface);
  box-shadow: var(--gs-shadow-modal);
}

.cmdk__input-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--gs-divider);
}
.cmdk__input-row svg { width: 18px; height: 18px; flex: none; color: var(--gs-fg-subtle); }
.cmdk__input-row input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--gs-fg);
  font-size: 15px;
}
.cmdk__input-row input::placeholder { color: var(--gs-fg-placeholder); }
.cmdk kbd {
  padding: 1px 6px;
  border: 1px solid var(--gs-border);
  border-radius: 6px;
  background: var(--gs-surface-2);
  color: var(--gs-fg-muted);
  font-family: inherit;
  font-size: 11px;
  line-height: 16px;
}

.cmdk__list {
  margin: 0;
  padding: 8px;
  overflow-y: auto;
  list-style: none;
  overscroll-behavior: contain;
}
.cmdk__list li[role='option'] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 12px;
  border-radius: var(--gs-radius-10);
  cursor: pointer;
}
.cmdk__list li[role='option'].is-active {
  background: var(--gs-accent-soft);
}
.cmdk__label { color: var(--gs-fg); font-size: 14px; font-weight: 500; }
.cmdk__meta { display: flex; align-items: center; gap: 8px; flex: none; }
.cmdk__kind {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--gs-accent);
  color: #fff;
  font-size: 10.5px;
  line-height: 15px;
}
.cmdk__hint { color: var(--gs-fg-muted); font-size: 11.5px; }
.cmdk__empty { padding: 24px 12px; color: var(--gs-fg-muted); font-size: 13px; text-align: center; }

.cmdk__foot {
  display: flex;
  gap: 16px;
  padding: 8px 16px;
  border-top: 1px solid var(--gs-divider);
  color: var(--gs-fg-subtle);
  font-size: 11.5px;
}
.cmdk__foot span { display: inline-flex; align-items: center; gap: 4px; }
</style>
