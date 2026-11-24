<script lang="ts" setup>
/**
 * 卡片（设计系统 §4/§5）：白卡浮于画布——不画线边框，靠 1px 环 + 柔和投影
 * 分层。`dense` 用于步骤条/工具行这类薄面板（body 12px 24px）。
 */
import { computed } from 'vue';

import { Card } from 'ant-design-vue';

defineOptions({ name: 'GsCard' });

const props = withDefaults(defineProps<{ dense?: boolean; title?: string }>(), {
  dense: false,
  title: undefined,
});

const bodyStyle = computed(() => ({ padding: props.dense ? '12px 24px' : '24px' }));
</script>

<template>
  <Card class="gs-card" :bordered="false" :body-style="bodyStyle">
    <template v-if="title || $slots.title" #title>
      <span class="gs-card__title" role="heading" aria-level="2">
        <slot name="title">{{ title }}</slot>
      </span>
    </template>
    <template v-if="$slots.extra" #extra>
      <slot name="extra"></slot>
    </template>
    <slot></slot>
  </Card>
</template>

<style scoped>
.gs-card {
  border-radius: 10px;
  box-shadow: var(--gs-shadow-float);
}
.gs-card :deep(.ant-card-head) {
  min-height: 52px;
  border-bottom-color: var(--gs-divider);
}
.gs-card :deep(.ant-card-head-title) {
  font-size: 16px;
  font-weight: 600;
}
.gs-card__title {
  display: inline-block;
}
</style>
