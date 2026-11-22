<script lang="ts" setup>
/** 统一页头（AgentSDR 规格）：可选眉题、H1 24/500、副标题 16/24、右侧动作插槽。 */
defineProps<{ title: string; subtitle?: string; kicker?: string }>();
</script>

<template>
  <header class="gph">
    <div class="gph__main">
      <p v-if="kicker" class="gph__kicker">{{ kicker }}</p>
      <h1 class="gph__title">{{ title }}</h1>
      <p v-if="subtitle" class="gph__sub">{{ subtitle }}</p>
    </div>
    <div v-if="$slots.actions" class="gph__actions">
      <slot name="actions"></slot>
    </div>
  </header>
</template>

<style scoped>
.gph { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.gph__main { min-width: 0; }
.gph__kicker {
  margin: 0 0 6px;
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--gs-accent-strong);
}
.gph__title {
  margin: 0;
  font-size: 24px;
  line-height: 32px;
  font-weight: 500;
  letter-spacing: -0.011em;
  color: var(--gs-fg);
}
.gph__sub {
  margin: 6px 0 0;
  max-width: 680px;
  font-size: 16px;
  line-height: 24px;
  letter-spacing: -0.011em;
  color: var(--gs-fg-muted);
}
.gph__actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
</style>
