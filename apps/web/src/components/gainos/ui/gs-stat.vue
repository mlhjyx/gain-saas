<script lang="ts" setup>
/**
 * KPI 指标卡（设计系统 §2/§4/§5）：对齐 GsCard 浮卡表面，
 * 支持 tabular-nums 数字、语义趋势（AA 对比度）与底部辅助说明。
 */
import { computed } from 'vue';

import { Statistic } from 'ant-design-vue';

import GsCard from './gs-card.vue';

defineOptions({ name: 'GsStat' });

export type GsStatTrendTone = 'danger' | 'neutral' | 'success' | 'warning';

const props = withDefaults(
  defineProps<{
    hint?: string;
    label: string;
    loading?: boolean;
    suffix?: string;
    trend?: string;
    trendTone?: GsStatTrendTone;
    value: number | string;
  }>(),
  {
    hint: undefined,
    loading: false,
    suffix: undefined,
    trend: undefined,
    trendTone: 'neutral',
  },
);

const trendToneClass = computed(() => {
  switch (props.trendTone) {
    case 'danger': {
      return 'text-[var(--gs-danger-fg)]';
    }
    case 'success': {
      return 'text-[var(--gs-success-fg)]';
    }
    case 'warning': {
      return 'text-[var(--gs-warn-fg)]';
    }
    default: {
      return 'text-[var(--gs-fg-muted)]';
    }
  }
});
</script>

<template>
  <GsCard class="gs-stat" data-gs="stat" padding="16px 20px">
    <div class="flex items-start justify-between gap-3">
      <Statistic :loading="loading" :title="label" :value="value">
        <template v-if="suffix" #suffix>
          <span class="gs-stat__suffix">{{ suffix }}</span>
        </template>
      </Statistic>
      <span
        v-if="trend || $slots.trend"
        :class="trendToneClass"
        :data-gs-tone="trendTone"
        class="shrink-0 pt-0.5 text-[12px] font-semibold tabular-nums"
        data-gs="stat-trend"
      >
        <slot name="trend">{{ trend }}</slot>
      </span>
    </div>
    <p
      v-if="hint || $slots.hint"
      class="mt-1.5 mb-0 text-[12px] leading-normal text-[var(--gs-fg-muted)]"
      data-gs="stat-hint"
    >
      <slot name="hint">{{ hint }}</slot>
    </p>
  </GsCard>
</template>

<style scoped>
.gs-stat :deep(.ant-statistic-title) {
  color: var(--gs-fg-muted);
  font-size: 12px;
  font-weight: 500;
}
.gs-stat :deep(.ant-statistic-content) {
  color: var(--gs-fg);
  font-size: 24px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.gs-stat__suffix {
  color: var(--gs-fg-muted);
  font-size: 13px;
  font-weight: 400;
}
</style>
