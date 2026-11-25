<script lang="ts" setup>
/**
 * 工具栏/筛选行（设计系统 §3）：白色浮起面板，统一 8/12px 间距与换行行为。
 * 左侧放页签/筛选，右侧放搜索与操作。
 */
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
  padding: 8px 12px 8px 8px;
  border-radius: 10px;
  background: var(--gs-surface);
  box-shadow: var(--gs-shadow-float);
}
</style>
