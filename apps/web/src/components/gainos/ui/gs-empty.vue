<script lang="ts" setup>
/** 空态（设计系统 §6）：a-empty + 标题/说明/操作槽位。 */
defineOptions({ name: 'GsEmpty' });

defineProps<{ description?: string; title?: string }>();
</script>

<template>
  <div class="gs-empty" data-gs="empty">
    <a-empty>
      <template v-if="title" #description>
        <p class="gs-empty__title">{{ title }}</p>
        <p v-if="description" class="gs-empty__desc">{{ description }}</p>
      </template>
      <template v-if="$slots.actions" #default>
        <div class="gs-empty__actions">
          <slot name="actions"></slot>
        </div>
      </template>
    </a-empty>
  </div>
</template>

<style scoped>
.gs-empty {
  padding: 40px 16px;
}
.gs-empty__title {
  margin: 0;
  color: var(--gs-fg);
  font-size: 14px;
  font-weight: 500;
}
.gs-empty__desc {
  margin: 6px 0 0;
  color: var(--gs-fg-muted);
  font-size: 13px;
}
.gs-empty__actions {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-top: 16px;
}
</style>
