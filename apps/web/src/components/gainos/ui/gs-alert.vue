<script lang="ts" setup>
/**
 * 语义提示横幅（设计系统 §5/§8）：info / success / warning / danger 四态映射到 AntDV Alert，
 * 颜色随 ConfigProvider AA 令牌自动适配明暗主题。
 */
import { computed, useSlots } from 'vue';

import { Alert } from 'ant-design-vue';

defineOptions({ name: 'GsAlert' });

export type GsAlertTone = 'danger' | 'info' | 'success' | 'warning';

const TONE_MAP: Record<GsAlertTone, 'error' | 'info' | 'success' | 'warning'> = {
  danger: 'error',
  info: 'info',
  success: 'success',
  warning: 'warning',
};

const props = withDefaults(
  defineProps<{
    banner?: boolean;
    closable?: boolean;
    description?: string;
    showIcon?: boolean;
    title?: string;
    tone?: GsAlertTone;
  }>(),
  {
    banner: false,
    closable: false,
    description: undefined,
    showIcon: true,
    title: undefined,
    tone: 'info',
  },
);

const emit = defineEmits<{ close: [event: MouseEvent] }>();
const slots = useSlots();

const alertType = computed(() => TONE_MAP[props.tone]);
const ariaRole = computed(() =>
  props.tone === 'danger' || props.tone === 'warning' ? 'alert' : 'status',
);
const hasTitle = computed(() => Boolean(props.title || slots.title));
const hasDescription = computed(() =>
  Boolean(props.description || slots.description || (hasTitle.value && slots.default)),
);

function onClose(event: MouseEvent): void {
  emit('close', event);
}
</script>

<template>
  <div :data-gs-tone="tone" class="gs-alert" data-gs="alert">
    <Alert
      :banner="banner"
      :closable="closable"
      :role="ariaRole"
      :show-icon="showIcon"
      :type="alertType"
      @close="onClose"
    >
      <template #message>
        <span v-if="hasTitle" class="text-[13px] font-semibold">
          <slot name="title">{{ title }}</slot>
        </span>
        <span v-else class="text-[13px] font-medium">
          <slot></slot>
        </span>
      </template>
      <template v-if="hasDescription" #description>
        <div class="text-[12.5px] leading-relaxed">
          <slot name="description">
            <template v-if="description">{{ description }}</template>
            <slot v-else></slot>
          </slot>
        </div>
      </template>
      <template v-if="$slots.action" #action>
        <slot name="action"></slot>
      </template>
    </Alert>
  </div>
</template>
