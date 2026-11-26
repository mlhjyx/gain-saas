<script lang="ts" setup>
/**
 * 统一空态（PR-UI1）：极简克制的线条图标空态，替换 AntDV 粗重信箱插画。
 * 保持 props（title / description / simple）与 #actions / #icon 槽位完全向后兼容。
 */
import { Inbox } from '@vben/icons';

defineOptions({ name: 'GsEmpty' });

defineProps<{ description?: string; simple?: boolean; title?: string }>();
</script>

<template>
  <div :class="{ 'gs-empty--simple': simple }" class="gs-empty" data-gs="empty">
    <span aria-hidden="true" class="gs-empty__icon">
      <slot name="icon">
        <Inbox :size="simple ? 16 : 18" />
      </slot>
    </span>
    <p v-if="title" class="gs-empty__title">{{ title }}</p>
    <p v-if="description" class="gs-empty__desc">{{ description }}</p>
    <div v-if="$slots.actions" class="gs-empty__actions">
      <slot name="actions"></slot>
    </div>
  </div>
</template>

<style scoped>
.gs-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 40px 16px;
  text-align: center;
}

.gs-empty--simple {
  padding: 24px 16px;
}

.gs-empty__icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  margin-bottom: 4px;
  border: 1px solid var(--gs-border);
  border-radius: 10px;
  background: var(--gs-surface-2);
  color: var(--gs-fg-subtle);
}

.gs-empty--simple .gs-empty__icon {
  width: 32px;
  height: 32px;
  border-radius: 8px;
}

.gs-empty__title {
  margin: 0;
  color: var(--gs-fg);
  font-size: 14px;
  line-height: 20px;
  font-weight: 500;
}

.gs-empty__desc {
  margin: 0;
  max-width: 420px;
  color: var(--gs-fg-muted);
  font-size: 13px;
  line-height: 20px;
}

.gs-empty__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 10px;
}
</style>
