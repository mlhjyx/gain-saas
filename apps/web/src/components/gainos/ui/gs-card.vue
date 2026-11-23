<script lang="ts" setup>
/** 卡片（设计系统 §4/§5）：白底 + 1px 边 + 10px 圆角 + xs 阴影。 */
import { Card } from 'ant-design-vue';

defineOptions({ name: 'GsCard' });

defineProps<{ title?: string }>();
</script>

<template>
  <Card class="gs-card" :bordered="true" :body-style="{ padding: '24px' }">
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
  box-shadow: var(--gs-shadow-card);
}
.gs-card :deep(.ant-card-head) {
  min-height: 48px;
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
