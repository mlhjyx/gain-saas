<script lang="ts" setup>
/**
 * 页面头（设计系统 §3）：H1 20/600 + 可选阶段标签/副标题 + 右侧操作。
 * 全站页面统一用它，替代各页自绘的 __head。
 */
defineOptions({ name: 'GsPage' });

defineProps<{
  /** 阶段/上下文字标，例如「第 5 步 · 判断线索」 */
  kicker?: string;
  subtitle?: string;
  title: string;
}>();
</script>

<template>
  <header class="gs-page" data-gs="page-header">
    <div class="gs-page__main">
      <p v-if="kicker" class="gs-page__kicker">{{ kicker }}</p>
      <h1 class="gs-page__title">{{ title }}</h1>
      <p v-if="subtitle" class="gs-page__subtitle">{{ subtitle }}</p>
    </div>
    <div v-if="$slots.actions" class="gs-page__actions">
      <slot name="actions"></slot>
    </div>
  </header>
</template>

<style scoped>
.gs-page {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.gs-page__main {
  min-width: 0;
}
.gs-page__kicker {
  margin: 0 0 6px;
  color: var(--gs-accent-strong);
  font-size: 12px;
  font-weight: 500;
}
.gs-page__title {
  margin: 0;
  color: var(--gs-fg);
  font-size: 20px;
  line-height: 28px;
  font-weight: 600;
  letter-spacing: -0.011em;
}
.gs-page__subtitle {
  margin: 6px 0 0;
  max-width: 720px;
  color: var(--gs-fg-muted);
  font-size: 13px;
  line-height: 20px;
}
.gs-page__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
