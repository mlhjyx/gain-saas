<script lang="ts" setup>
/**
 * 统一页面容器（v3.0 组件层）：1280px + clamp 内边距 + 纵向间距。
 * 之前这条规则在 ~15 个视图的 scoped CSS 里各复制一份且互有出入
 * （sources 单值 padding、growth 全幅、ops 无容器）——页面根一律用它。
 */
withDefaults(defineProps<{
  /** 紧凑变体：纵向间距减半，用于嵌套/抽屉内页 */
  compact?: boolean;
  /** 窄幅：680px 居中（表单/详情类内容） */
  narrow?: boolean;
}>(), { compact: false, narrow: false });
</script>

<template>
  <div class="gpc" :class="{ 'gpc--compact': compact, 'gpc--narrow': narrow }">
    <slot></slot>
  </div>
</template>

<style scoped>
.gpc {
  display: grid;
  gap: 18px;
  max-width: 1280px;
  margin: 0 auto;
  padding: clamp(18px, 2.4vw, 32px) clamp(18px, 2.4vw, 34px) clamp(32px, 4vh, 48px);
}

.gpc--compact { gap: 12px; }

.gpc--narrow { max-width: 840px; }
</style>
