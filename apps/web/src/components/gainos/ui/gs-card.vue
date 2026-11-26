<script lang="ts" setup>
/**
 * 卡片（PR-UI1 去套娃细线表面）：统一 1px solid var(--gs-border) 极细描边 + 轻阴影。
 * `dense` 用于步骤条/工具行这类薄面板（body 12px 24px）。
 */
import { computed } from 'vue';

import { Card } from 'ant-design-vue';

defineOptions({ name: 'GsCard' });

const props = withDefaults(
  defineProps<{ dense?: boolean; padding?: string; title?: string }>(),
  { dense: false, padding: undefined, title: undefined },
);

/** 优先级：显式 padding > dense（薄面板）> 默认 24px。 */
const bodyStyle = computed(() => ({
  padding: props.padding ?? (props.dense ? '12px 24px' : '24px'),
}));
</script>

<template>
  <Card :body-style="bodyStyle" :bordered="false" class="gs-card">
    <template v-if="title || $slots.title" #title>
      <span aria-level="2" class="gs-card__title" role="heading">
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
  border: 1px solid var(--gs-border);
  border-radius: 10px;
  background: var(--gs-surface);
  box-shadow: var(--gs-shadow-card);
}

.gs-card :deep(.ant-card-head) {
  min-height: 48px;
  border-bottom-color: var(--gs-border);
}

.gs-card :deep(.ant-card-head-title) {
  font-size: 15px;
  font-weight: 600;
}

.gs-card__title {
  display: inline-block;
}
</style>
