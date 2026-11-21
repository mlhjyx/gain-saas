<script lang="ts" setup>
/**
 * 统一空状态（AgentSDR EmptyState）：图标 chip + 一句话标题 + 一句说明 + 2–3 条真实起步路径。
 *
 * 空状态是入口，不是终点：调用方必须通过 #actions 提供至少一条可执行路径；
 * 不要只写“暂无数据”。图标用 #icon 插槽传入，避免组件绑定具体图标库。
 */
withDefaults(
  defineProps<{
    /** 紧凑变体：用于侧栏/卡片内部 */
    compact?: boolean;
    /** 说明下一步能做什么，保持一句话 */
    description?: string;
    /** 缺什么，用一句话说清 */
    title: string;
  }>(),
  { compact: false },
);
</script>

<template>
  <div class="gse" :class="{ 'gse--compact': compact }">
    <span v-if="$slots.icon" class="gse__icon" aria-hidden="true">
      <slot name="icon"></slot>
    </span>
    <p class="gse__title">{{ title }}</p>
    <p v-if="description" class="gse__desc">{{ description }}</p>
    <div v-if="$slots.actions" class="gse__actions">
      <slot name="actions"></slot>
    </div>
  </div>
</template>

<style scoped>
.gse {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 48px 24px;
  text-align: center;
}
.gse__icon {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  margin-bottom: 4px;
  border: 1px solid var(--gs-border);
  border-radius: var(--gs-radius-10);
  background: var(--gs-surface-2);
  color: var(--gs-fg-muted);
}
.gse__title {
  margin: 0;
  color: var(--gs-fg);
  font-size: 14px;
  line-height: 20px;
  font-weight: 500;
}
.gse__desc {
  margin: 0;
  max-width: 420px;
  color: var(--gs-fg-muted);
  font-size: 13px;
  line-height: 20px;
}
.gse__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 8px;
}
.gse--compact { padding: 24px 16px; }
</style>
