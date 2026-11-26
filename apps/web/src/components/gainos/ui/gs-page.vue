<script lang="ts" setup>
/**
 * 统一紧凑页面头（PR-UI1 对标 Linear / Attio）：
 *
 * - 取消 160px 蓝紫渐变插画大横幅与底部 64px 淡出区；
 * - 保留 art / hero / kicker props 签名向后兼容，全站默认渲染统一克制的 56px 紧凑页头：
 *   20px/600 左对齐标题 + 1 句 13px 淡色副文 + 右侧 #actions 槽位 + 底部 1px 细线。
 */
withDefaults(
  defineProps<{
    /** 保留签名向后兼容；PR-UI1 起全站统一为无插画紧凑页头。 */
    art?: 'company' | 'default' | 'find-buyers' | 'leads';
    /** 保留签名向后兼容；PR-UI1 起统一渲染紧凑页头。 */
    hero?: boolean;
    /** 可选上下文字标 */
    kicker?: string;
    subtitle?: string;
    title: string;
  }>(),
  { art: 'default', hero: true, kicker: undefined, subtitle: undefined },
);
</script>

<template>
  <header class="gs-page" data-gs="page-header">
    <div class="gs-page__main">
      <div class="gs-page__text">
        <p v-if="kicker" class="gs-page__kicker">{{ kicker }}</p>
        <h1 class="gs-page__title">{{ title }}</h1>
        <p v-if="subtitle" class="gs-page__subtitle">{{ subtitle }}</p>
      </div>
    </div>
    <div v-if="$slots.actions" class="gs-page__actions">
      <slot name="actions"></slot>
    </div>
  </header>
</template>

<style scoped>
.gs-page {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  min-height: 56px;
  padding: 16px 0 14px;
  border-bottom: 1px solid var(--gs-border);
}

.gs-page__main {
  display: flex;
  align-items: center;
  min-width: 0;
  flex: 1 1 240px;
}

.gs-page__text {
  min-width: 0;
}

.gs-page__kicker {
  margin: 0 0 2px;
  color: var(--gs-fg-subtle);
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;
}

.gs-page__title {
  margin: 0;
  color: var(--gs-fg);
  font-size: 20px;
  line-height: 28px;
  font-weight: 600;
  letter-spacing: -0.015em;
}

.gs-page__subtitle {
  margin: 2px 0 0;
  max-width: 720px;
  color: var(--gs-fg-muted);
  font-size: 13px;
  line-height: 20px;
}

.gs-page__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
