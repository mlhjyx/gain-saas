<script lang="ts" setup>
/**
 * 侧滑抽屉（设计系统 §14.2）：统一 4 档宽度（sm 440 / md 640 / lg 720 / xl min(920px, 100vw)）、
 * 标题与副标题布局、右对齐页脚操作栏以及键盘 Esc 关闭。
 */
import type { DrawerProps } from 'ant-design-vue';

import { computed } from 'vue';

import { Drawer } from 'ant-design-vue';

defineOptions({ name: 'GsDrawer' });

export type GsDrawerSize = 'lg' | 'md' | 'sm' | 'xl';

const DRAWER_WIDTH: Record<GsDrawerSize, number | string> = {
  lg: 720,
  md: 640,
  sm: 440,
  xl: 'min(920px, 100vw)',
};

const props = withDefaults(
  defineProps<{
    closable?: boolean;
    destroyOnClose?: boolean;
    getContainer?: DrawerProps['getContainer'];
    keyboard?: boolean;
    maskClosable?: boolean;
    placement?: DrawerProps['placement'];
    size?: GsDrawerSize;
    subtitle?: string;
    title?: string;
    width?: number | string;
  }>(),
  {
    closable: true,
    destroyOnClose: true,
    getContainer: undefined,
    keyboard: true,
    maskClosable: true,
    placement: 'right',
    size: 'md',
    subtitle: undefined,
    title: undefined,
    width: undefined,
  },
);

const open = defineModel<boolean>('open', { default: false });
const emit = defineEmits<{ close: [event: KeyboardEvent | MouseEvent] }>();

const resolvedWidth = computed<number | string>(
  () => props.width ?? DRAWER_WIDTH[props.size],
);

function onClose(event: KeyboardEvent | MouseEvent): void {
  emit('close', event);
}
</script>

<template>
  <Drawer
    v-model:open="open"
    :closable="closable"
    :destroy-on-close="destroyOnClose"
    :get-container="getContainer"
    :keyboard="keyboard"
    :mask-closable="maskClosable"
    :placement="placement"
    :width="resolvedWidth"
    root-class-name="gs-drawer"
    @close="onClose"
  >
    <template v-if="title || subtitle || $slots.title" #title>
      <div class="flex min-w-0 flex-col gap-0.5">
        <div class="truncate text-[16px] font-semibold leading-snug text-[var(--gs-fg)]">
          <slot name="title">{{ title }}</slot>
        </div>
        <p
          v-if="subtitle"
          class="m-0 text-[12px] font-normal leading-normal text-[var(--gs-fg-muted)]"
        >
          {{ subtitle }}
        </p>
      </div>
    </template>
    <template v-if="$slots.extra" #extra>
      <slot name="extra"></slot>
    </template>
    <div :data-gs-size="size" class="grid gap-4 @container" data-gs="drawer">
      <slot></slot>
    </div>
    <template v-if="$slots.footer" #footer>
      <div class="flex items-center justify-end gap-2">
        <slot name="footer"></slot>
      </div>
    </template>
  </Drawer>
</template>
