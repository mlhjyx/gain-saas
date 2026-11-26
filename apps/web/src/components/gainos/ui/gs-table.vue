<script lang="ts" setup>
/**
 * 数据表（设计系统 §6）：统一 size=middle、13px 正文、无外框、
 * 默认 #emptyText 渲染 GsEmpty，默认分页 20 条/页（单页自动隐藏，>50 条显总数）。
 * 透传 antdv Table 的全部 attrs 与插槽，向后兼容既有调用。
 */
import type { TablePaginationConfig, TableProps } from 'ant-design-vue';

import { computed, useAttrs, useSlots } from 'vue';

import { Table } from 'ant-design-vue';

import { $t } from '#/locales';

import GsEmpty from './gs-empty.vue';

defineOptions({ name: 'GsTable', inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    defaultPageSize?: number;
    emptyDescription?: string;
    emptyTitle?: string;
    loading?: boolean;
    pagination?: false | TableProps['pagination'];
  }>(),
  {
    defaultPageSize: 20,
    emptyDescription: undefined,
    emptyTitle: undefined,
    loading: false,
    pagination: undefined,
  },
);

const attrs = useAttrs();
const slots = useSlots();

const forwardedSlots = computed(() =>
  Object.keys(slots).filter((name) => name !== 'emptyText'),
);

const totalCount = computed(() => {
  if (
    props.pagination &&
    typeof props.pagination === 'object' &&
    typeof props.pagination.total === 'number'
  ) {
    return props.pagination.total;
  }
  const source = attrs.dataSource ?? attrs['data-source'];
  return Array.isArray(source) ? source.length : 0;
});

function formatTotal(total: number): string {
  const translated = $t('gainos.notifications.groupCount', { count: total });
  return translated.includes(String(total)) ? translated : String(total);
}

const resolvedPagination = computed<false | TablePaginationConfig>(() => {
  if (props.pagination === false) return false;
  const userConfig: TablePaginationConfig =
    props.pagination && typeof props.pagination === 'object'
      ? props.pagination
      : {};
  const defaults: TablePaginationConfig = {
    defaultPageSize: props.defaultPageSize,
    hideOnSinglePage: true,
    showSizeChanger: false,
  };
  if (totalCount.value > 50 && !userConfig.showTotal) {
    defaults.showTotal = (total: number) => formatTotal(total);
  }
  return {
    ...defaults,
    ...userConfig,
  };
});
</script>

<template>
  <Table
    v-bind="$attrs"
    :loading="loading"
    :pagination="resolvedPagination"
    :size="'middle'"
    class="gs-table"
    data-gs="table"
  >
    <template #emptyText>
      <slot name="emptyText">
        <GsEmpty
          :description="emptyDescription"
          :title="emptyTitle"
          simple
        />
      </slot>
    </template>
    <template v-for="name in forwardedSlots" :key="name" #[name]="slotData">
      <slot :name="name" v-bind="slotData ?? {}"></slot>
    </template>
  </Table>
</template>

<style scoped>
.gs-table :deep(.ant-table) {
  font-size: 13px;
}
.gs-table :deep(.ant-table-thead > tr > th) {
  font-size: 12px;
  font-weight: 500;
}
</style>
