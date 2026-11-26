<script lang="ts" setup>
/**
 * 静态打包图标组件（PR-UI1）：彻底替代依赖外网拉取的 <IconifyIcon icon="lucide:..." />。
 *
 * - 优先直接复用 @vben/icons 静态导出的 Lucide 组件；
 * - @vben/icons 未导出的业务导航图标（building-2 / radar / users / list-checks / send /
 *   handshake / bar-chart-3 / compass / panel-left-close / panel-left-open）内联标准
 *   24×24 Lucide 矢量路径，0ms 同步渲染、离线可见、零外部请求。
 */
import type { Component } from 'vue';

import { computed } from 'vue';

import {
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheckBig,
  CircleHelp,
  Inbox,
  Languages,
  LayoutGrid,
  LogOut,
  Menu,
  MoonStar,
  PanelLeft,
  RotateCw,
  Search,
  Settings,
  Sun,
  X,
} from '@vben/icons';

defineOptions({ name: 'SdrIcon' });

const props = withDefaults(
  defineProps<{
    name?: string;
    size?: number;
  }>(),
  {
    name: 'lucide:circle-dot',
    size: 16,
  },
);

const VBEN_MAP: Record<string, Component> = {
  'lucide:bell': Bell,
  'lucide:check': Check,
  'lucide:chevron-down': ChevronDown,
  'lucide:chevron-right': ChevronRight,
  'lucide:circle': Circle,
  'lucide:circle-check-big': CircleCheckBig,
  'lucide:circle-dot': Circle,
  'lucide:circle-help': CircleHelp,
  'lucide:inbox': Inbox,
  'lucide:languages': Languages,
  'lucide:layout-dashboard': LayoutGrid,
  'lucide:layout-grid': LayoutGrid,
  'lucide:log-out': LogOut,
  'lucide:menu': Menu,
  'lucide:moon': MoonStar,
  'lucide:moon-star': MoonStar,
  'lucide:panel-left': PanelLeft,
  'lucide:rotate-cw': RotateCw,
  'lucide:search': Search,
  'lucide:settings': Settings,
  'lucide:sun': Sun,
  'lucide:x': X,
};

const normalized = computed(() => props.name || 'lucide:circle-dot');
const vbenComponent = computed(() => VBEN_MAP[normalized.value] ?? null);
</script>

<template>
  <component
    :is="vbenComponent"
    v-if="vbenComponent"
    :size="size"
    aria-hidden="true"
    class="sdr-icon"
  />
  <!-- 标准 Lucide 24×24 静态路径（0ms 同步渲染） -->
  <svg
    v-else-if="normalized === 'lucide:building-2'"
    :height="size"
    :width="size"
    aria-hidden="true"
    class="sdr-icon"
    fill="none"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
    stroke-width="1.85"
    viewBox="0 0 24 24"
  >
    <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
    <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
    <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" />
    <path d="M10 6h4" />
    <path d="M10 10h4" />
    <path d="M10 14h4" />
    <path d="M10 18h4" />
  </svg>
  <svg
    v-else-if="normalized === 'lucide:radar'"
    :height="size"
    :width="size"
    aria-hidden="true"
    class="sdr-icon"
    fill="none"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
    stroke-width="1.85"
    viewBox="0 0 24 24"
  >
    <path d="M19.07 4.93A10 10 0 0 0 6.99 3.34" />
    <path d="M4 6h.01" />
    <path d="M2.29 9.62A10 10 0 1 0 21.31 8.35" />
    <path d="M16.24 7.76A6 6 0 1 0 8.23 16.67" />
    <path d="M12 18h.01" />
    <path d="M17.99 11.66A6 6 0 0 1 15.77 16.67" />
    <circle cx="12" cy="12" r="2" />
    <path d="m13.41 10.59 5.66-5.66" />
  </svg>
  <svg
    v-else-if="normalized === 'lucide:users'"
    :height="size"
    :width="size"
    aria-hidden="true"
    class="sdr-icon"
    fill="none"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
    stroke-width="1.85"
    viewBox="0 0 24 24"
  >
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
  <svg
    v-else-if="normalized === 'lucide:list-checks'"
    :height="size"
    :width="size"
    aria-hidden="true"
    class="sdr-icon"
    fill="none"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
    stroke-width="1.85"
    viewBox="0 0 24 24"
  >
    <path d="m3 17 2 2 4-4" />
    <path d="m3 7 2 2 4-4" />
    <path d="M13 6h8" />
    <path d="M13 12h8" />
    <path d="M13 18h8" />
  </svg>
  <svg
    v-else-if="normalized === 'lucide:send'"
    :height="size"
    :width="size"
    aria-hidden="true"
    class="sdr-icon"
    fill="none"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
    stroke-width="1.85"
    viewBox="0 0 24 24"
  >
    <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
    <path d="m21.854 2.147-10.94 10.939" />
  </svg>
  <svg
    v-else-if="normalized === 'lucide:handshake'"
    :height="size"
    :width="size"
    aria-hidden="true"
    class="sdr-icon"
    fill="none"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
    stroke-width="1.85"
    viewBox="0 0 24 24"
  >
    <path d="m11 17 2 2a1 1 0 1 0 3-3" />
    <path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4" />
    <path d="m21 3 1 11h-2" />
    <path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3" />
    <path d="M3 4h8" />
  </svg>
  <svg
    v-else-if="normalized === 'lucide:bar-chart-3'"
    :height="size"
    :width="size"
    aria-hidden="true"
    class="sdr-icon"
    fill="none"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
    stroke-width="1.85"
    viewBox="0 0 24 24"
  >
    <path d="M3 3v16a2 2 0 0 0 2 2h16" />
    <path d="M18 17V9" />
    <path d="M13 17V5" />
    <path d="M8 17v-3" />
  </svg>
  <svg
    v-else-if="normalized === 'lucide:compass'"
    :height="size"
    :width="size"
    aria-hidden="true"
    class="sdr-icon"
    fill="none"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
    stroke-width="1.85"
    viewBox="0 0 24 24"
  >
    <path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z" />
    <circle cx="12" cy="12" r="10" />
  </svg>
  <svg
    v-else-if="normalized === 'lucide:panel-left-close'"
    :height="size"
    :width="size"
    aria-hidden="true"
    class="sdr-icon"
    fill="none"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
    stroke-width="1.85"
    viewBox="0 0 24 24"
  >
    <rect height="18" rx="2" width="18" x="3" y="3" />
    <path d="M9 3v18" />
    <path d="m16 15-3-3 3-3" />
  </svg>
  <svg
    v-else-if="normalized === 'lucide:panel-left-open'"
    :height="size"
    :width="size"
    aria-hidden="true"
    class="sdr-icon"
    fill="none"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
    stroke-width="1.85"
    viewBox="0 0 24 24"
  >
    <rect height="18" rx="2" width="18" x="3" y="3" />
    <path d="M9 3v18" />
    <path d="m14 9 3 3-3 3" />
  </svg>
  <Circle v-else :size="size" aria-hidden="true" class="sdr-icon" />
</template>

<style scoped>
.sdr-icon {
  flex: none;
  display: inline-block;
  vertical-align: middle;
}
</style>
