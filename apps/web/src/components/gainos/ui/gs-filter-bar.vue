<script lang="ts" setup>
/**
 * 高密度筛选栏（设计系统 §1/§12.3/§15.2）：
 * 容器查询驱动（@container），带前缀搜索框外包普通 div 防止 Tailwind v4 Cascade Layer
 * 被 `.ant-input-affix-wrapper { width: 100% }` 吞掉宽度。
 */
import { computed } from 'vue';

import { Search } from '@vben/icons';

import { Button, Input } from 'ant-design-vue';

import { $t } from '#/locales';

defineOptions({ name: 'GsFilterBar' });

const props = withDefaults(
  defineProps<{
    hasActiveFilters?: boolean;
    resetLabel?: string;
    searchable?: boolean;
    searchAriaLabel?: string;
    searchPlaceholder?: string;
    showReset?: boolean;
  }>(),
  {
    hasActiveFilters: false,
    resetLabel: undefined,
    searchable: true,
    searchAriaLabel: undefined,
    searchPlaceholder: undefined,
    showReset: undefined,
  },
);

const search = defineModel<string>('search', { default: '' });
const emit = defineEmits<{
  reset: [];
  searchSubmit: [value: string];
}>();

const resolvedPlaceholder = computed(
  () => props.searchPlaceholder ?? $t('gainos.companies.searchPlaceholder'),
);

const resolvedAriaLabel = computed(
  () => props.searchAriaLabel ?? resolvedPlaceholder.value,
);

const canShowReset = computed(() => {
  if (props.showReset !== undefined) return props.showReset;
  return props.hasActiveFilters || search.value.trim().length > 0;
});

function onReset(): void {
  search.value = '';
  emit('reset');
}

function onPressEnter(): void {
  emit('searchSubmit', search.value);
}
</script>

<template>
  <div class="gs-filter-bar @container" data-gs="filter-bar">
    <div
      class="flex flex-col gap-2.5 rounded-[10px] bg-[var(--gs-surface)] px-3 py-2 shadow-[var(--gs-shadow-float)] @min-[640px]:flex-row @min-[640px]:flex-wrap @min-[640px]:items-center"
    >
      <div
        v-if="searchable"
        class="w-full shrink-0 @min-[640px]:w-[240px]"
        data-gs="filter-bar-search"
      >
        <Input
          v-model:value="search"
          :aria-label="resolvedAriaLabel"
          :placeholder="resolvedPlaceholder"
          allow-clear
          type="search"
          @press-enter="onPressEnter"
        >
          <template #prefix>
            <Search :size="14" class="text-[var(--gs-fg-muted)]" />
          </template>
        </Input>
      </div>

      <div
        v-if="$slots.filters || $slots.default"
        class="flex min-w-0 flex-wrap items-center gap-2"
      >
        <slot name="filters"></slot>
        <slot></slot>
      </div>

      <Button
        v-if="canShowReset"
        data-gs="filter-bar-reset"
        type="text"
        @click="onReset"
      >
        {{ resetLabel ?? $t('gainos.audit.resetFilters') }}
      </Button>

      <div
        v-if="$slots.actions"
        class="flex flex-wrap items-center gap-2 @min-[640px]:ml-auto"
      >
        <slot name="actions"></slot>
      </div>
    </div>
  </div>
</template>
