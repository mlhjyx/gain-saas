<script lang="ts" setup>
/**
 * 异步区块四态容器（设计系统 §6/§8/§10）：
 * 互斥切换加载骨架 / 三段式错误（保留 `.error-notice__details summary` 契约）+ 重试 / GsEmpty 空态 / 正常内容。
 */
import { computed } from 'vue';

import { Alert, Button, Skeleton } from 'ant-design-vue';

import { $t } from '#/locales';

import GsEmpty from './gs-empty.vue';

defineOptions({ name: 'GsAsyncSection' });

export interface GsAsyncError {
  code?: string;
  next?: string;
  title: string;
  why?: string;
}

const props = withDefaults(
  defineProps<{
    empty?: boolean;
    emptyDescription?: string;
    emptySimple?: boolean;
    emptyTitle?: string;
    error?: GsAsyncError | null | string;
    loading?: boolean;
    loadingText?: string;
    retryable?: boolean;
    retryText?: string;
    skeletonRows?: number;
  }>(),
  {
    empty: false,
    emptyDescription: undefined,
    emptySimple: true,
    emptyTitle: undefined,
    error: null,
    loading: false,
    loadingText: undefined,
    retryable: true,
    retryText: undefined,
    skeletonRows: 4,
  },
);

const emit = defineEmits<{ retry: [] }>();

const normalizedError = computed<GsAsyncError | null>(() => {
  if (!props.error) return null;
  if (typeof props.error === 'string') return { title: props.error };
  return props.error;
});
</script>

<template>
  <div class="grid gap-3 @container" data-gs="async-section">
    <div v-if="loading" class="pt-4 pb-1" role="status">
      <slot name="loading">
        <Skeleton active :paragraph="{ rows: skeletonRows }" :title="false" />
      </slot>
      <span class="sr-only">{{ loadingText ?? $t('gainos.common.loading') }}</span>
    </div>

    <slot
      v-else-if="normalizedError"
      :error="normalizedError"
      :retry="() => emit('retry')"
      name="error"
    >
      <Alert
        class="error-notice"
        data-gs="error-notice"
        role="alert"
        show-icon
        type="error"
      >
        <template #message>
          <h3 class="m-0 text-[13px] font-semibold text-[var(--gs-fg)]">
            {{ normalizedError.title }}
          </h3>
        </template>
        <template #description>
          <p
            v-if="normalizedError.why"
            class="mt-0.5 mb-0 text-[12.5px] text-[var(--gs-fg-muted)]"
          >
            {{ normalizedError.why }}
          </p>
          <p
            v-if="normalizedError.next"
            class="mt-0.5 mb-0 text-[12.5px] text-[var(--gs-fg-muted)]"
          >
            {{ normalizedError.next }}
          </p>
          <details
            v-if="normalizedError.code"
            class="error-notice__details mt-1.5 text-[12px]"
          >
            <summary class="cursor-pointer">
              {{ $t('gainos.findBuyers.technicalDetails') }}
            </summary>
            <code>{{ normalizedError.code }}</code>
          </details>
        </template>
        <template v-if="retryable" #action>
          <Button
            data-gs="async-section-retry"
            size="small"
            @click="emit('retry')"
          >
            {{ retryText ?? $t('gainos.common.retry') }}
          </Button>
        </template>
      </Alert>
    </slot>

    <slot v-else-if="empty" name="empty">
      <GsEmpty
        :description="emptyDescription"
        :simple="emptySimple"
        :title="emptyTitle"
      >
        <template v-if="$slots['empty-actions']" #actions>
          <slot name="empty-actions"></slot>
        </template>
      </GsEmpty>
    </slot>

    <slot v-else></slot>
  </div>
</template>
