<script lang="ts" setup>
/**
 * 弹层（设计系统 §8）：10px 圆角、3 档标准宽度（sm 420 / md 520 / lg 720）、
 * 副标题、危险确认样式与右对齐页脚插槽。向后兼容 width 覆盖。
 */
import type { ModalProps } from 'ant-design-vue';

import { computed } from 'vue';

import { Modal } from 'ant-design-vue';

defineOptions({ name: 'GsModal' });

export type GsModalSize = 'lg' | 'md' | 'sm';

const MODAL_WIDTH: Record<GsModalSize, number> = {
  lg: 720,
  md: 520,
  sm: 420,
};

const props = withDefaults(
  defineProps<{
    cancelText?: string;
    confirmLoading?: boolean;
    danger?: boolean;
    getContainer?: ModalProps['getContainer'];
    okText?: string;
    size?: GsModalSize;
    subtitle?: string;
    title: string;
    width?: number | string;
  }>(),
  {
    cancelText: undefined,
    confirmLoading: false,
    danger: false,
    getContainer: undefined,
    okText: undefined,
    size: 'md',
    subtitle: undefined,
    width: undefined,
  },
);

const open = defineModel<boolean>('open', { default: false });
const emit = defineEmits<{ cancel: []; ok: [] }>();

const resolvedWidth = computed<number | string>(
  () => props.width ?? MODAL_WIDTH[props.size],
);
</script>

<template>
  <Modal
    v-model:open="open"
    :cancel-text="cancelText"
    :confirm-loading="confirmLoading"
    :destroy-on-close="true"
    :get-container="getContainer"
    :mask-closable="!confirmLoading"
    :ok-button-props="{ danger }"
    :ok-text="okText"
    :width="resolvedWidth"
    root-class-name="gs-modal"
    @cancel="emit('cancel')"
    @ok="emit('ok')"
  >
    <template #title>
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

    <div
      :data-gs-danger="danger ? 'true' : undefined"
      :data-gs-size="size"
      class="gs-modal__body @container"
      data-gs="modal"
    >
      <slot></slot>
    </div>

    <template v-if="$slots.footer" #footer>
      <div class="flex items-center justify-end gap-2">
        <slot name="footer"></slot>
      </div>
    </template>
  </Modal>
</template>
