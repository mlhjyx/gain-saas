<script lang="ts" setup>
/** 卡片（设计系统 §4/§5）：白底 + 1px 边 + 10px 圆角 + xs 阴影。 */
defineOptions({ name: 'GsCard' });

defineProps<{ title?: string }>();
</script>

<template>
  <a-card class="gs-card" :bordered="true" :body-style="{ padding: '20px' }">
    <template v-if="title || $slots.title" #title>
      <slot name="title">{{ title }}</slot>
    </template>
    <template v-if="$slots.extra" #extra>
      <slot name="extra"></slot>
    </template>
    <slot></slot>
  </a-card>
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
</style>
