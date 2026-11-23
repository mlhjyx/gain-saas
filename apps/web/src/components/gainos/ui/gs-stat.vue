<script lang="ts" setup>
/** KPI 卡（设计系统 §5）：a-card + a-statistic，数字 tabular-nums。 */
import { Card, Statistic } from 'ant-design-vue';

defineOptions({ name: 'GsStat' });

defineProps<{
  label: string;
  loading?: boolean;
  suffix?: string;
  value: number | string;
}>();
</script>

<template>
  <Card class="gs-stat" :body-style="{ padding: '16px 20px' }" data-gs="stat">
    <Statistic :loading="loading" :title="label" :value="value">
      <template v-if="suffix" #suffix>
        <span class="gs-stat__suffix">{{ suffix }}</span>
      </template>
    </Statistic>
  </Card>
</template>

<style scoped>
.gs-stat {
  border-radius: 10px;
  box-shadow: var(--gs-shadow-card);
}
.gs-stat :deep(.ant-statistic-title) {
  color: var(--gs-fg-muted);
  font-size: 12px;
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
