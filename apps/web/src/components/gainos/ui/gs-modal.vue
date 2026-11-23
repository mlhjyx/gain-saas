<script lang="ts" setup>
/** 弹层（设计系统 §8）：10px 圆角、标准页脚、danger/pending 支持。 */
defineOptions({ name: 'GsModal' });

withDefaults(
  defineProps<{
    cancelText?: string;
    confirmLoading?: boolean;
    danger?: boolean;
    okText?: string;
    title: string;
    width?: number | string;
  }>(),
  { cancelText: undefined, confirmLoading: false, danger: false, okText: undefined, width: 520 },
);

const open = defineModel<boolean>('open', { default: false });
const emit = defineEmits<{ cancel: []; ok: [] }>();
</script>

<template>
  <a-modal
    v-model:open="open"
    :cancel-text="cancelText"
    :confirm-loading="confirmLoading"
    :destroy-on-close="true"
    :mask-closable="!confirmLoading"
    :ok-text="okText"
    :ok-button-props="{ danger }"
    :title="title"
    :width="width"
    data-gs="modal"
    @cancel="emit('cancel')"
    @ok="emit('ok')"
  >
    <slot></slot>
    <template v-if="$slots.footer" #footer>
      <slot name="footer"></slot>
    </template>
  </a-modal>
</template>
