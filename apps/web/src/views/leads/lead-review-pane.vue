<script lang="ts" setup>
defineOptions({ inheritAttrs: false });

defineProps<{
  open: boolean;
  subtitle?: string;
  title: string;
}>();
</script>

<template>
  <section v-if="open" aria-labelledby="lead-review-name" class="review-pane" data-gs="lead-review-pane">
    <header class="review-pane__header">
      <div class="min-w-0">
        <h2 id="lead-review-name">{{ title }}</h2>
        <p v-if="subtitle">{{ subtitle }}</p>
      </div>
      <slot name="extra" />
    </header>
    <div class="review-pane__body">
      <slot />
    </div>
    <footer class="review-pane__footer">
      <slot name="footer" />
    </footer>
  </section>
</template>

<style scoped>
.review-pane {
  min-width: 0;
  border: 1px solid var(--gs-divider);
  border-radius: 9px;
  background: var(--gs-surface-1, var(--gs-bg));
}

.review-pane__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 17px;
  border-bottom: 1px solid var(--gs-divider);
}

.review-pane__header h2 {
  margin: 0;
  overflow-wrap: anywhere;
  font-size: 19px;
  font-weight: 650;
}

.review-pane__header p {
  margin: 3px 0 0;
  color: var(--gs-fg-muted);
  font-size: 12px;
}

.review-pane__body {
  container-type: inline-size;
  padding: 0 17px;
}

.review-pane__footer {
  position: sticky;
  z-index: 1;
  bottom: 0;
  padding: 9px 17px;
  border-top: 1px solid var(--gs-divider);
  border-radius: 0 0 9px 9px;
  background: var(--gs-surface-1, var(--gs-bg));
}
</style>
