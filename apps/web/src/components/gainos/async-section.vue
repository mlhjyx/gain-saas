<script lang="ts" setup>
/**
 * 异步区块三态（v3.0 ch07 组件层）：loading / error / empty / content 只走一处，
 * 杜绝「错误与空态同时出现」和「错误被写成部署配置」这类分化（审计 二-03/二-07/二-08）。
 */
defineProps<{
  loading?: boolean;
  error?: { title: string; next?: string } | null;
  empty?: boolean;
  emptyText?: string;
  loadingText?: string;
  retryText?: string;
}>();

const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <div class="gas">
    <p v-if="loading" class="gas__muted">{{ loadingText ?? '加载中…' }}</p>
    <div v-else-if="error" class="gas__error" role="alert">
      <strong>{{ error.title }}</strong>
      <p v-if="error.next">{{ error.next }}</p>
      <button type="button" @click="emit('retry')">{{ retryText ?? '重试' }}</button>
    </div>
    <div v-else-if="empty" class="gas__empty">
      <slot name="empty"><p>{{ emptyText }}</p></slot>
    </div>
    <slot v-else></slot>
  </div>
</template>

<style scoped>
.gas { display: grid; gap: 12px; }
.gas__muted { margin: 0; color: var(--gs-fg-subtle); font-size: 13px; }
.gas__error { border: 1px solid var(--gs-danger-border); background: var(--gs-danger-bg); border-radius: 12px; padding: 14px 16px; display: grid; gap: 8px; color: var(--gs-danger); font-size: 13px; }
.gas__error p { margin: 0; }
.gas__error button { justify-self: start; border: 1px solid var(--gs-danger-border); background: var(--gs-surface); border-radius: 8px; padding: 6px 14px; cursor: pointer; color: var(--gs-danger); }
.gas__empty { border: 1px dashed var(--gs-border-dashed); border-radius: 16px; background: var(--gs-surface); padding: 40px 24px; text-align: center; color: var(--gs-fg-muted); font-size: 13.5px; }
.gas__empty :deep(p) { margin: 0; }
</style>
