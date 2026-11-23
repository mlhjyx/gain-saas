<script lang="ts" setup>
/**
 * 五维判据状态图标（2026-11-23）：对勾 / 差号 / 偏弱 / 证据不足 / 不适用。
 * 用内联 SVG 而不是 emoji：字形在不同系统一致，颜色跟随语义 token。
 */
import { computed } from 'vue';

defineOptions({ name: 'GsStatusIcon' });

const props = withDefaults(
  defineProps<{
    label?: string;
    tone?: 'danger' | 'info' | 'neutral' | 'success' | 'warning';
  }>(),
  { label: 'unclear', tone: 'neutral' },
);

const kind = computed(() =>
  ['fail', 'not_applicable', 'pass', 'unclear', 'weak'].includes(props.label)
    ? props.label
    : 'unclear',
);
</script>

<template>
  <span class="gs-status-icon" :class="`gs-status-icon--${tone}`" aria-hidden="true">
    <svg
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.8"
      viewBox="0 0 16 16"
    >
      <path v-if="kind === 'pass'" d="M3.5 8.5l3 3 6-7" />
      <template v-else-if="kind === 'fail'">
        <path d="M4.5 4.5l7 7" />
        <path d="M11.5 4.5l-7 7" />
      </template>
      <path v-else-if="kind === 'weak'" d="M4 8h8" />
      <template v-else-if="kind === 'unclear'">
        <circle cx="8" cy="8" r="5.5" />
        <path d="M6.4 6.3a1.7 1.7 0 1 1 2.5 1.5c-.5.3-.9.7-.9 1.4" />
        <path d="M8 11.6h.01" />
      </template>
      <path v-else d="M4.5 8h7" />
    </svg>
  </span>
</template>

<style scoped>
.gs-status-icon {
  display: inline-flex;
  flex: none;
  width: 14px;
  height: 14px;
}
.gs-status-icon svg {
  width: 100%;
  height: 100%;
}
.gs-status-icon--success {
  color: var(--gs-success-fg);
}
.gs-status-icon--warning {
  color: var(--gs-warn-fg);
}
.gs-status-icon--danger {
  color: var(--gs-danger-fg);
}
.gs-status-icon--neutral {
  color: var(--gs-fg-subtle);
}
.gs-status-icon--info {
  color: var(--gs-accent-fg);
}
</style>
