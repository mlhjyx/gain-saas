<script lang="ts" setup>
/**
 * 错误三层文案块（PRD §14.4；设计 2026-11-08-p5-user-loop §5）：
 * 发生了什么（title）/ 为什么（why）/ 怎么办（next），错误码收进「技术详情」折叠。
 * 数据来自 failureText()（BFF userCopy 或兜底），本组件只负责呈现。
 *
 * 2026-11-23 方案 B：改用 antd Alert 承载（role="alert" 由组件提供），
 * 保留「技术详情」折叠类名 `.error-notice__details`（既有 e2e 依赖）。
 */
import { Alert } from 'ant-design-vue';

defineOptions({ name: 'ErrorNotice' });

defineProps<{
  code?: string | undefined;
  next?: string | undefined;
  title: string;
  why?: string | undefined;
}>();
</script>

<template>
  <Alert
    class="error-notice"
    data-gs="error-notice"
    role="alert"
    show-icon
    type="error"
  >
    <template #message>
      <h3 class="error-notice__title">{{ title }}</h3>
    </template>
    <template #description>
      <p v-if="why" class="error-notice__why">{{ why }}</p>
      <p v-if="next" class="error-notice__next">{{ next }}</p>
      <details v-if="code" class="error-notice__details">
        <summary>{{ $t('gainos.findBuyers.technicalDetails') }}</summary>
        <code>{{ code }}</code>
      </details>
    </template>
  </Alert>
</template>

<style scoped>
.error-notice__title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.error-notice__why,
.error-notice__next {
  margin: 2px 0 0;
  font-size: 12.5px;
}
.error-notice__details {
  margin-top: 6px;
  font-size: 12px;
}
.error-notice__details summary {
  cursor: pointer;
}
</style>
