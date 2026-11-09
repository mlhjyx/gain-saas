<script lang="ts" setup>
import { Button, Empty, Spin } from 'ant-design-vue';

import { $t } from '#/locales';

/**
 * 异步区块三态（v3.0 ch07 组件层）：loading / error / empty / content 只走一处，
 * 杜绝「错误与空态同时出现」和「错误被写成部署配置」这类分化（审计 二-03/二-07/二-08）。
 * 控件用 antd（Spin/Button/Empty），观感随主题桥继承 GainOS 品牌。
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
    <div v-if="loading" class="gas__loading">
      <Spin :spinning="true" size="small" />
      <span>{{ loadingText ?? $t('gainos.common.loading') }}</span>
    </div>
    <div v-else-if="error" class="gas__error" role="alert">
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
.gas__loading { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 24px 0; color: var(--gs-fg-muted); font-size: 13px; }
.gas__error { border: 1px solid var(--gs-danger-border); background: var(--gs-danger-bg); border-radius: 12px; padding: 14px 16px; display: grid; gap: 8px; color: var(--gs-danger); font-size: 13px; }
.gas__error p { margin: 0; }
.gas__error :deep(.ant-btn) { justify-self: start; color: var(--gs-danger); border-color: var(--gs-danger-border); }
.gas__empty { border: 1px dashed var(--gs-border-dashed); border-radius: 16px; background: var(--gs-surface); padding: 24px; }
</style>
