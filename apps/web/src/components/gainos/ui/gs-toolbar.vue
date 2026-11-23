<script lang="ts" setup>
/** 工具栏/筛选行（设计系统 §3）：统一 8/12px 间距与换行行为。 */
defineOptions({ name: 'GsToolbar' });
</script>

<template>
  <div class="gs-toolbar" data-gs="toolbar">
    <slot></slot>
  </div>
</template>

<style scoped>
.gs-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 16px;
  border: 1px solid var(--gs-border);
  border-radius: 10px;
  background: var(--gs-surface);
}
</style>
