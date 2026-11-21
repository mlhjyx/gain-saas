<script lang="ts" setup>
/**
 * 设置页统一容器：页头 + 内容槽。
 * 五个设置子页的导航已在主侧栏「设置」分组中，这里不再重复一份二级导航。
 */
defineProps<{ subtitle?: string; title: string }>();
</script>

<template>
  <div class="gss">
    <header class="gss__head">
      <div>
        <h1>{{ title }}</h1>
        <p v-if="subtitle">{{ subtitle }}</p>
      </div>
      <div v-if="$slots.actions" class="gss__actions">
        <slot name="actions"></slot>
      </div>
    </header>
    <slot></slot>
  </div>
</template>

<style scoped>
.gss {
  display: grid;
  gap: 16px;
  max-width: var(--gs-page-max, 1280px);
  margin: 0 auto;
  padding: var(--gs-page-pad, 24px);
  padding-bottom: clamp(32px, 4vh, 48px);
}
.gss__head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
}
.gss__head h1 {
  margin: 0;
  font-size: 24px;
  line-height: 32px;
  font-weight: 500;
  letter-spacing: -0.011em;
  color: var(--gs-fg);
}
.gss__head p {
  margin: 6px 0 0;
  max-width: 680px;
  font-size: 16px;
  line-height: 24px;
  letter-spacing: -0.011em;
  color: var(--gs-fg-muted);
}
.gss__actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
</style>
