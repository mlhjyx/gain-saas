<script lang="ts" setup>
/** 统一页头（v3.0 ch07 组件层）：可选眉题、H1 24/700、副标题 13.5、右侧动作插槽。 */
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
.gph__kicker { margin: 0 0 6px; font-size: 11.5px; font-weight: 700; letter-spacing: .18em; color: var(--gs-accent-strong); }
.gph__title { margin: 0; font-size: 24px; font-weight: 700; color: var(--gs-fg); }
.gph__sub { margin: 6px 0 0; font-size: 13.5px; line-height: 1.7; color: var(--gs-fg-muted); max-width: 680px; }
.gph__actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
</style>
