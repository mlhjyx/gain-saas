<script lang="ts" setup>
/**
 * 批量操作浮条（设计系统 §10/§15.2）：
 * 仅在 selectedCount > 0 时渲染，带 role="region" 与 aria-live="polite"；
 * 采用 sticky 定位以兼容 @container 页面根容器。
 */
import { computed } from 'vue';

import { X } from '@vben/icons';

import { Button } from 'ant-design-vue';

import { $t } from '#/locales';

defineOptions({ name: 'GsBulkActionBar' });

export type GsBulkActionBarPlacement = 'bottom' | 'inline' | 'top';

const props = withDefaults(
  defineProps<{
    ariaLabel?: string;
    clearLabel?: string;
    placement?: GsBulkActionBarPlacement;
    selectedCount: number;
    selectedLabel?: string;
    totalCount?: number;
  }>(),
  {
    ariaLabel: undefined,
    clearLabel: undefined,
    placement: 'bottom',
    selectedLabel: undefined,
    totalCount: undefined,
  },
);

const emit = defineEmits<{ clear: [] }>();

const summaryText = computed(
  () =>
    props.selectedLabel ??
    $t('gainos.companies.selectedCount', { count: props.selectedCount }),
);

const positionClass = computed(() => {
  switch (props.placement) {
    case 'inline': {
      return '';
    }
    case 'top': {
      return 'sticky top-3 z-20';
    }
    default: {
      return 'sticky bottom-3 z-20';
    }
  }
});
</script>

<template>
  <div
    v-if="selectedCount > 0"
    :aria-label="ariaLabel ?? summaryText"
    :class="positionClass"
    aria-live="polite"
    class="gs-bulk-action-bar @container"
    data-gs="bulk-action-bar"
    role="region"
  >
    <div
      class="flex flex-col gap-2 rounded-[10px] border border-[var(--gs-accent-soft-border)] bg-[var(--gs-surface)] px-4 py-2.5 shadow-[var(--gs-shadow-modal)] @min-[520px]:flex-row @min-[520px]:flex-wrap @min-[520px]:items-center @min-[520px]:justify-between"
    >
      <div
        class="flex flex-wrap items-center gap-2 text-[13px] font-medium text-[var(--gs-fg)]"
      >
        <span
          class="inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-[var(--gs-accent-soft)] px-1.5 text-[12px] font-semibold tabular-nums text-[var(--gs-accent-fg)]"
          data-gs="bulk-action-count"
        >
          {{ selectedCount }}
        </span>
        <slot :count="selectedCount" :total="totalCount" name="summary">
          <span>{{ summaryText }}</span>
        </slot>
        <Button
          data-gs="bulk-action-clear"
          size="small"
          type="link"
          @click="emit('clear')"
        >
          <template #icon>
            <X :size="13" />
          </template>
          {{ clearLabel ?? $t('gainos.common.cancel') }}
        </Button>
      </div>

      <div
        v-if="$slots.actions || $slots.default"
        class="flex flex-wrap items-center gap-2"
      >
        <slot name="actions"></slot>
        <slot></slot>
      </div>
    </div>
  </div>
</template>
