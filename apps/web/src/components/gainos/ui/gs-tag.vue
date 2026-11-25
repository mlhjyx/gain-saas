<script lang="ts" setup>
/** 状态标签（设计系统 §5）：状态色只出现在这里。 */
import { computed } from 'vue';

import { Tag } from 'ant-design-vue';

defineOptions({ name: 'GsTag' });

const props = withDefaults(
  defineProps<{ tone?: 'danger' | 'info' | 'neutral' | 'success' | 'warning' }>(),
  { tone: 'neutral' },
);

const color = computed(() => {
  switch (props.tone) {
    case 'danger': {
      return 'error';
    }
    case 'info': {
      return 'processing';
    }
    case 'success': {
      return 'success';
    }
    case 'warning': {
      return 'warning';
    }
    default: {
      return undefined;
    }
  }
});
</script>

<template>
  <Tag :bordered="false" :color="color" class="gs-tag" data-gs="tag">
    <slot></slot>
  </Tag>
</template>

<style scoped>
.gs-tag {
  margin-inline-end: 0;
  font-size: 12px;
  line-height: 20px;
}
</style>
