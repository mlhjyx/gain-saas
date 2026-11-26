<script lang="ts" setup>
/** 统一页头（PR-UI1 与 GsPage 保持一致的 56px 紧凑现代页头规格）。 */
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
.gph {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  min-height: 56px;
  padding: 4px 0 14px;
  border-bottom: 1px solid var(--gs-border);
}

.gph__main {
  min-width: 0;
  flex: 1 1 240px;
}

.gph__kicker {
  margin: 0 0 2px;
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;
  color: var(--gs-fg-subtle);
}

.gph__title {
  margin: 0;
  font-size: 20px;
  line-height: 28px;
  font-weight: 600;
  letter-spacing: -0.015em;
  color: var(--gs-fg);
}

.gph__sub {
  margin: 2px 0 0;
  max-width: 720px;
  font-size: 13px;
  line-height: 20px;
  color: var(--gs-fg-muted);
}

.gph__actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
</style>
