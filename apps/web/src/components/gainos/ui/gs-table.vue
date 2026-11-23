<script lang="ts" setup>
/**
 * 数据表（设计系统 §6）：统一 size=middle、13px 正文、无外框、空态。
 * 透传 a-table 的全部 props/slots（columns/dataSource/rowKey/pagination…）。
 */
import type { TableProps } from 'ant-design-vue';

defineOptions({ name: 'GsTable', inheritAttrs: false });

const props = withDefaults(
  defineProps<{ loading?: boolean; pagination?: false | TableProps['pagination'] }>(),
  { loading: false, pagination: false },
);
</script>

<template>
  <a-table
    v-bind="$attrs"
    :loading="loading"
    :pagination="props.pagination"
    :size="'middle'"
    class="gs-table"
    data-gs="table"
  >
    <template v-for="(_, name) in $slots" #[name]="slotData">
      <slot :name="name" v-bind="slotData ?? {}"></slot>
    </template>
  </a-table>
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
