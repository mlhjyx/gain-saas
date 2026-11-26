<script lang="ts" setup>
import { Button, Empty, Skeleton } from 'ant-design-vue';

import { $t } from '#/locales';

/**
 * 异步区块三态（v3.0 ch07 组件层）：loading / error / empty / content 只走一处，
 * 杜绝「错误与空态同时出现」和「错误被写成部署配置」这类分化（审计 二-03/二-07/二-08）。
 * 控件用 antd；pass3 C2：加载态从 Spin 换成 Skeleton 骨架屏，
 * 文案保留为 sr-only，读屏与 innerText 断言仍然可用。
 */
const props = defineProps<{
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
    <div v-if="loading" class="gas__loading" role="status">
      <Skeleton active :title="false" :paragraph="{ rows: 4 }" />
      <span class="gas__sr-only">{{ loadingText ?? $t('gainos.common.loading') }}</span>
    </div>
    <div v-else-if="error" class="gas__error" data-gs="async-error" role="alert">
      <strong>{{ error.title }}</strong>
      <p v-if="error.next">{{ error.next }}</p>
      <Button size="small" @click="emit('retry')">{{ retryText ?? $t('gainos.common.retry') }}</Button>
    </div>
    <div v-else-if="empty" class="gas__empty">
      <slot name="empty">
        <Empty
          :description="emptyText ?? ''"
          :image="Empty.PRESENTED_IMAGE_SIMPLE"
        />
      </slot>
    </div>
    <slot v-else></slot>
  </div>
</template>

<style scoped>
.gas { display: grid; gap: 12px; }
.gas__loading { padding: 20px 4px 4px; }
.gas__sr-only {
  position: absolute;
  width: 1px; height: 1px;
  margin: -1px; padding: 0; border: 0;
  clip: rect(0 0 0 0); clip-path: inset(50%);
  overflow: hidden; white-space: nowrap;
}
.gas__error { border: 1px solid var(--gs-danger-border); background: var(--gs-danger-bg); border-radius: 12px; padding: 14px 16px; display: grid; gap: 8px; color: var(--gs-danger); font-size: 13px; }
.gas__error p { margin: 0; }
.gas__error :deep(.ant-btn) { justify-self: start; color: var(--gs-danger); border-color: var(--gs-danger-border); }
.gas__empty { border: 1px dashed var(--gs-border-dashed); border-radius: 16px; background: var(--gs-surface); padding: 24px; }
</style>
