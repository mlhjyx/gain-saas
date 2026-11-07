<script lang="ts" setup>
/**
 * 错误三层文案块（PRD §14.4；设计 2026-11-08-p5-user-loop §5）：
 * 发生了什么（title）/ 为什么（why）/ 怎么办（next），错误码收进「技术详情」折叠。
 * 数据来自 failureText()（BFF userCopy 或兜底），本组件只负责呈现。
 */
defineOptions({ name: 'ErrorNotice' });

defineProps<{
  title: string;
  why?: string | undefined;
  next?: string | undefined;
  code?: string | undefined;
}>();
</script>

<template>
  <div class="error-notice" role="alert">
    <h3>{{ title }}</h3>
    <p v-if="why" class="error-notice__why">{{ why }}</p>
    <p v-if="next" class="error-notice__next">{{ next }}</p>
    <details v-if="code" class="error-notice__details">
      <summary>{{ $t('gainos.findBuyers.technicalDetails') }}</summary>
      <code>{{ code }}</code>
    </details>
  </div>
</template>

<style scoped>
.error-notice {
  border: 1px solid var(--gs-danger-border, #f3c0c0);
  background: var(--gs-danger-bg, #fdf2f2);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 13px;
}

.error-notice h3 {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--gs-fg, inherit);
}

.error-notice__why,
.error-notice__next {
  margin: 4px 0 0;
  color: var(--gs-fg-muted, inherit);
}

.error-notice__details {
  margin-top: 6px;
  font-size: 12px;
  color: var(--gs-fg-subtle, inherit);
}

.error-notice__details summary {
  cursor: pointer;
}

.error-notice__details code {
  display: inline-block;
  margin-top: 4px;
  word-break: break-all;
}
</style>
