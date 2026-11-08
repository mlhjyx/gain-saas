<script lang="ts" setup>
/**
 * 设置壳（v3.0 ch07 P5b-13 / QW15）：五个设置子页共用同一个起点与栅格。
 * 左侧子导航 + 统一页头 + 内容槽；窄屏时子导航变成横向滚动条。
 * admin 才可见的子项按 accessCodes 过滤（路由守卫仍兜底）。
 */
import { computed } from 'vue';

import { useAccessStore } from '@vben/stores';

import { $t } from '#/locales';

defineProps<{ subtitle?: string; title: string }>();

const accessStore = useAccessStore();

const items = computed(() =>
  [
    { label: $t('gainos.menu.members'), path: '/settings/members' },
    { label: $t('gainos.menu.suppressions'), path: '/settings/suppressions', admin: true },
    { label: $t('gainos.menu.sources'), path: '/settings/sources', admin: true },
    { label: $t('gainos.menu.privacy'), path: '/settings/privacy', admin: true },
    { label: $t('gainos.menu.audit'), path: '/settings/audit', admin: true },
  ].filter((item) => !item.admin || accessStore.accessCodes.includes('ADMIN')),
);
</script>

<template>
  <div class="gss">
    <nav class="gss__nav" :aria-label="$t('gainos.menu.settingsNav')">
      <RouterLink
        v-for="item in items"
        :key="item.path"
        :to="item.path"
        class="gss__link"
      >
        {{ item.label }}
      </RouterLink>
    </nav>
    <section class="gss__main">
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
    </section>
  </div>
</template>

<style scoped>
.gss {
  max-width: 1280px;
  margin: 0 auto;
  padding: clamp(18px, 2.4vw, 32px) clamp(18px, 2.4vw, 34px) clamp(32px, 4vh, 48px);
  display: grid;
  grid-template-columns: 188px minmax(0, 1fr);
  gap: clamp(20px, 2.6vw, 36px);
  align-items: start;
}
.gss__nav {
  position: sticky;
  top: 84px;
  display: grid;
  gap: 4px;
  padding: 6px;
  border: 1px solid var(--gs-border);
  border-radius: 12px;
  background: var(--gs-surface);
}
.gss__link {
  border-radius: 8px;
  padding: 9px 12px;
  font-size: 13.5px;
  color: var(--gs-fg-2);
  text-decoration: none;
}
.gss__link:hover {
  background: var(--gs-surface-2);
}
.gss__link.router-link-active {
  background: var(--gs-accent-soft);
  color: var(--gs-accent-strong);
  font-weight: 600;
}
.gss__main {
  display: grid;
  gap: 16px;
  min-width: 0;
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
  font-weight: 700;
  color: var(--gs-fg);
}
.gss__head p {
  margin: 6px 0 0;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--gs-fg-muted);
  max-width: 680px;
}
.gss__actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

@media (max-width: 900px) {
  .gss {
    grid-template-columns: 1fr;
  }
  .gss__nav {
    position: static;
    display: flex;
    overflow-x: auto;
    gap: 4px;
  }
  .gss__link {
    white-space: nowrap;
  }
}
</style>
