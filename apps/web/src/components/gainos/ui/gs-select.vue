<script lang="ts" setup>
/**
 * Select 薄封装（190 行 antdv 之上的 10 行修补）。
 *
 * antdv 4.2.6 的 combobox 输入缺 `aria-expanded`，且在关闭态引用不存在的
 * `aria-controls/owns/activedescendant`（axe: aria-required-attr /
 * aria-valid-attr-value / label 三条 critical）。这里在挂载与开关/更新时
 * 同步补齐，其余 props/slots 全部透传给 a-select。
 */
import type { SelectProps } from 'ant-design-vue';

import { nextTick, onMounted, onUpdated, ref } from 'vue';

import { Select } from 'ant-design-vue';

defineOptions({ name: 'GsSelect', inheritAttrs: false });

const props = defineProps<{
  /** 无可见 label 时提供可读名称（写到 combobox 输入上）。 */
  ariaLabel?: string;
}>();

const model = defineModel<SelectProps['value']>({ default: undefined });
const dropdownOpen = ref(false);
const root = ref<InstanceType<typeof Select> | null>(null);

function syncAria(): void {
  const host = root.value?.$el as HTMLElement | undefined;
  const input = host?.querySelector<HTMLInputElement>(
    'input[role="combobox"]',
  );
  if (!input) return;
  input.setAttribute('aria-expanded', String(dropdownOpen.value));
  if (props.ariaLabel) input.setAttribute('aria-label', props.ariaLabel);
  if (dropdownOpen.value) return;
  // 关闭态：listbox 未挂载，引用它会被 axe 判为无效值
  input.removeAttribute('aria-activedescendant');
  input.removeAttribute('aria-controls');
  input.removeAttribute('aria-owns');
}

function onOpenChange(open: boolean): void {
  dropdownOpen.value = open;
  void nextTick(syncAria);
}

onMounted(() => void nextTick(syncAria));
onUpdated(syncAria);
</script>

<template>
  <Select
    ref="root"
    v-model:value="model"
    v-bind="$attrs"
    :open="dropdownOpen"
    data-gs="select"
    @dropdown-visible-change="onOpenChange"
  >
    <template v-for="(_, name) in $slots" #[name]="slotData">
      <slot :name="name" v-bind="slotData ?? {}"></slot>
    </template>
  </Select>
</template>
