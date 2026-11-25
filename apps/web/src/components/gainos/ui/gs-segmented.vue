<script lang="ts" setup>
/**
 * 药丸页签（单选）：文字项 + 选中态浅蓝药丸 + 计数。
 *
 * antdv 4.2.6 的 Segmented 只吃全局 token（选中态固定是白底滑块），Tabs /
 * Radio.Group 也没有可令牌化的「浅底药丸」形态，所以这是设计系统自有的最小
 * 原语：一组 toggle button（aria-pressed）+ group 标签。Tab 逐个聚焦、
 * Enter/Space 触发，不依赖方向键，axe 的 A/AA 规则全部覆盖。
 */
defineOptions({ name: 'GsSegmented' });

defineProps<{
  ariaLabel: string;
  options: Array<{ count?: number | string; label: string; value: string }>;
}>();

const model = defineModel<string>({ default: '' });
</script>

<template>
  <div class="gs-segmented" role="group" :aria-label="ariaLabel">
    <button
      v-for="option in options"
      :key="option.value"
      :aria-pressed="model === option.value"
      class="gs-segmented__item"
      :class="{ 'is-active': model === option.value }"
      type="button"
      @click="model = option.value"
    >
      <span>{{ option.label }}</span>
      <span v-if="option.count !== undefined" class="gs-segmented__count">
        {{ option.count }}
      </span>
    </button>
  </div>
</template>

<style scoped>
.gs-segmented {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
}
.gs-segmented__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--gs-fg-muted);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}
.gs-segmented__item:hover {
  background: var(--gs-surface-2);
  color: var(--gs-fg);
}
.gs-segmented__item.is-active {
  background: var(--gs-accent-soft);
  color: var(--gs-accent-fg);
}
.gs-segmented__item:focus-visible {
  outline: 2px solid var(--gs-accent);
  outline-offset: 1px;
}
.gs-segmented__count {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
</style>
