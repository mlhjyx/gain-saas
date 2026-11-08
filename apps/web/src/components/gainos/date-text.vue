<script lang="ts" setup>
/**
 * 统一时间展示（v3.0 ch07 QW14）：视图里不再直接调用浏览器的 toLocale 系列方法。
 * mode=date → YYYY-MM-DD；默认 datetime → YYYY-MM-DD HH:mm；seconds → 带秒。
 */
import { computed } from 'vue';

import {
  formatDate,
  formatDateTime,
  formatDateTimeSeconds,
  type DateInput,
} from '@gain-saas/shared';

const props = withDefaults(
  defineProps<{
    mode?: 'date' | 'datetime' | 'seconds';
    placeholder?: string;
    value?: DateInput;
  }>(),
  { mode: 'datetime', placeholder: '—', value: undefined },
);

const text = computed(() => {
  const raw =
    props.mode === 'date'
      ? formatDate(props.value)
      : props.mode === 'seconds'
        ? formatDateTimeSeconds(props.value)
        : formatDateTime(props.value);
  return raw || props.placeholder;
});

const iso = computed(() => {
  const value = props.value;
  if (value === null || value === undefined || value === '') return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
});
</script>

<template>
  <time v-if="iso" :datetime="iso">{{ text }}</time>
  <span v-else class="gdt__empty">{{ text }}</span>
</template>

<style scoped>
.gdt__empty {
  color: var(--gs-fg-subtle);
}
</style>
