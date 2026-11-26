<script lang="ts" setup>
/**
 * 结构化键值对详情展示（设计系统 §2/§15.2）：
 * 支持 grid / compact 两档布局、空值温和占位（—）、numeric 启用 tabular-nums 与单字段复制。
 */
import { computed, onBeforeUnmount, ref } from 'vue';

import { Check, Copy } from '@vben/icons';

import { Button } from 'ant-design-vue';

import { $t } from '#/locales';

defineOptions({ name: 'GsKeyValue' });

export interface GsKeyValueItem {
  copyable?: boolean;
  copyValue?: string;
  key?: string;
  label: string;
  mono?: boolean;
  numeric?: boolean;
  span?: 1 | 2;
  value?: null | number | string;
}

const props = withDefaults(
  defineProps<{
    columns?: 1 | 2 | 3;
    copyLabel?: string;
    emptyPlaceholder?: string;
    items: GsKeyValueItem[];
    layout?: 'compact' | 'grid';
  }>(),
  {
    columns: 2,
    copyLabel: undefined,
    emptyPlaceholder: '—',
    layout: 'grid',
  },
);

const emit = defineEmits<{
  copy: [payload: { item: GsKeyValueItem; value: string }];
}>();

const copiedId = ref<null | string>(null);
let copiedTimer: null | ReturnType<typeof setTimeout> = null;

onBeforeUnmount(() => {
  if (copiedTimer) clearTimeout(copiedTimer);
});

const listClass = computed(() => {
  if (props.layout === 'compact') {
    return 'm-0 grid grid-cols-1 divide-y divide-[var(--gs-divider)] @container';
  }
  const cols =
    props.columns === 1
      ? 'grid-cols-1'
      : props.columns === 3
        ? 'grid-cols-1 @min-[520px]:grid-cols-2 @min-[840px]:grid-cols-3'
        : 'grid-cols-1 @min-[520px]:grid-cols-2';
  return `m-0 grid gap-x-6 gap-y-4 ${cols} @container`;
});

function itemId(item: GsKeyValueItem, index: number): string {
  return item.key ?? `${item.label}-${index}`;
}

function isEmptyValue(value: GsKeyValueItem['value']): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' && value.trim().length === 0) return true;
  return false;
}

function displayValueOf(item: GsKeyValueItem): string {
  if (isEmptyValue(item.value)) return props.emptyPlaceholder;
  return String(item.value);
}

function copyTextOf(item: GsKeyValueItem): string {
  if (item.copyValue !== undefined) return item.copyValue;
  return isEmptyValue(item.value) ? '' : String(item.value);
}

async function onCopy(item: GsKeyValueItem, id: string): Promise<void> {
  const value = copyTextOf(item);
  if (!value) return;

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    }
  } catch {
    // 剪贴板权限受限时仍向上抛出事件，由调用方按需反馈
  }

  copiedId.value = id;
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copiedId.value = null;
  }, 1500);

  emit('copy', { item, value });
}
</script>

<template>
  <dl
    :class="listClass"
    :data-gs-layout="layout"
    class="gs-key-value"
    data-gs="key-value"
  >
    <div
      v-for="(item, index) in items"
      :key="itemId(item, index)"
      :class="[
        layout === 'compact'
          ? 'grid grid-cols-1 gap-1 py-2.5 first:pt-0 last:pb-0 @min-[420px]:grid-cols-[minmax(120px,34%)_1fr] @min-[420px]:items-baseline @min-[420px]:gap-3'
          : 'flex min-w-0 flex-col gap-1',
        layout === 'grid' && item.span === 2 ? '@min-[520px]:col-span-2' : '',
      ]"
    >
      <dt
        class="m-0 text-[12px] font-medium leading-normal text-[var(--gs-fg-muted)]"
      >
        {{ item.label }}
      </dt>
      <dd
        :class="[
          'm-0 flex min-w-0 items-center gap-1.5 text-[14px] leading-snug break-words',
          isEmptyValue(item.value)
            ? 'text-[var(--gs-fg-subtle)]'
            : 'text-[var(--gs-fg)]',
          item.numeric ? 'font-medium tabular-nums' : '',
          item.mono ? 'font-mono text-[13px]' : '',
        ]"
      >
        <span class="min-w-0 flex-1">
          <slot
            :display-value="displayValueOf(item)"
            :is-empty="isEmptyValue(item.value)"
            :item="item"
            name="value"
          >
            {{ displayValueOf(item) }}
          </slot>
        </span>
        <Button
          v-if="item.copyable && !isEmptyValue(item.value)"
          :aria-label="`${copyLabel ?? $t('gainos.leads.copy')} ${item.label}`"
          data-gs="key-value-copy"
          size="small"
          type="text"
          @click="onCopy(item, itemId(item, index))"
        >
          <template #icon>
            <Check
              v-if="copiedId === itemId(item, index)"
              :size="13"
              class="text-[var(--gs-success-fg)]"
            />
            <Copy v-else :size="13" class="text-[var(--gs-fg-muted)]" />
          </template>
        </Button>
      </dd>
    </div>
  </dl>
</template>
