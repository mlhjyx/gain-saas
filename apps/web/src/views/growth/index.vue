<script lang="ts" setup>
/**
 * 「商机与触达」合并入口（P6 设计 D-14-a）：一个一级导航，页内三 tab。
 * 14-2：战役计划 / 商机两个 tab 直接内嵌各自真实页面（M2.1 审批列表、步 10 QGO 管线），
 * 触达 tab 在步 11 落地上线前保持如实占位（不提供假交互）。
 * tab 与 URL `?tab=` 同步，可深链；独立路由 /campaigns、/qgos 仍保留给通知与线索页的深链。
 */
import { computed, defineAsyncComponent } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { glossaryTerm } from '@gain-saas/shared';
import { preferences } from '@vben/preferences';

import { $t } from '#/locales';

defineOptions({ name: 'Growth' });

// 内嵌的真实页面按 tab 懒加载：切换 tab 才拉数据，首屏不付出两份页面的代价。
const CampaignsList = defineAsyncComponent(() => import('#/views/campaigns/index.vue'));
const QgosList = defineAsyncComponent(() => import('#/views/qgos/index.vue'));
const OutreachBatches = defineAsyncComponent(() => import('#/views/outreach/index.vue'));

const route = useRoute();
const router = useRouter();

const TABS = computed(() => [
  { key: 'campaigns', label: glossaryTerm('campaign', preferences.app.locale) },
  { key: 'opportunities', label: glossaryTerm('qgo', preferences.app.locale) },
  { key: 'outreach', label: glossaryTerm('outreach', preferences.app.locale) },
]);

const TAB_KEYS = new Set(['campaigns', 'opportunities', 'outreach']);
const active = computed(() => {
  const tab = route.query.tab;
  return typeof tab === 'string' && TAB_KEYS.has(tab) ? tab : 'campaigns';
});

function select(key: string): void {
  void router.replace({ path: '/growth', query: { ...route.query, tab: key } });
}

</script>

<template>
  <div class="gr">
    <div class="gr__bar">
      <header class="gr__head">
        <div class="gr__head-main">
          <h1>{{ $t('gainos.growth.title') }}</h1>
          <p class="gr__sub">{{ $t('gainos.growth.subtitle') }}</p>
        </div>
        <span class="gs-badge gs-badge--processing">{{ $t('gainos.growth.shadowBadge') }}</span>
      </header>

      <nav class="gr__tabs" role="tablist" :aria-label="$t('gainos.growth.title')">
        <button
          v-for="tab in TABS"
          :key="tab.key"
          :aria-selected="active === tab.key"
          :class="{ 'is-active': active === tab.key }"
          class="gr__tab"
          role="tab"
          type="button"
          @click="select(tab.key)"
        >
          {{ tab.label }}
        </button>
      </nav>
    </div>

    <section v-if="active === 'campaigns'" class="gr__panel" role="tabpanel">
      <CampaignsList />
    </section>

    <section v-else-if="active === 'opportunities'" class="gr__panel" role="tabpanel">
      <QgosList />
    </section>

    <section v-else class="gr__panel" role="tabpanel">
      <OutreachBatches />
    </section>
  </div>
</template>

<style scoped>
.gr {
  display: grid;
  gap: 0;
}

/* 页头与 tab 跟内嵌页面共用同一容器宽度（1080 + 24 内边距），避免双重缩进 */
.gr__bar {
  width: 100%;
  max-width: 1280px;
  margin: 0 auto;
  padding: 24px 24px 6px;
  box-sizing: border-box;
  display: grid;
  gap: 14px;
}

/* 枢纽页头保持克制：真正的页面主标题由各 tab 内嵌的真实页面承担 */
.gr__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.gr__head-main h1 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
  color: var(--gs-fg-2);
  letter-spacing: 0.01em;
}

.gr__sub {
  margin: 4px 0 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--gs-fg-subtle);
  max-width: 640px;
}

.gr__tabs {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  background: var(--gs-surface-2);
  border-radius: 12px;
  width: fit-content;
}

.gr__tab {
  border: none;
  background: transparent;
  color: var(--gs-fg-2);
  font-size: 13.5px;
  font-weight: 600;
  padding: 7px 16px;
  border-radius: 9px;
  cursor: pointer;
  transition: background 140ms ease-out, color 140ms ease-out;
}

.gr__tab:hover {
  color: var(--gs-accent-strong);
}

.gr__tab.is-active {
  background: var(--gs-surface);
  color: var(--gs-fg);
  box-shadow: var(--gs-shadow-card);
}

.gr__panel {
  /* 块级流：内嵌页面（max-width + margin:auto）在块级父容器里才会撑满到 1080；
     若这里是 grid，auto 外边距会让页面收缩成 fit-content，与页头/tab 对不齐。 */
  display: block;
}

/* 触达占位不是整页组件，自己补齐与页面一致的容器 */
.gr__panel--inner {
  width: 100%;
  max-width: 1280px;
  margin: 0 auto;
  padding: 18px 24px 48px;
  box-sizing: border-box;
}

.gr__card {
  background: var(--gs-surface);
  border: 1px solid var(--gs-border);
  border-radius: 16px;
  padding: 22px 24px;
  display: grid;
  gap: 12px;
}

.gr__card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.gr__card-head h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
  color: var(--gs-fg);
}

.gr__legend {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.gr__desc {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.75;
  color: var(--gs-fg-2);
  max-width: 720px;
}

.gr__points {
  margin: 0;
  padding-left: 18px;
  display: grid;
  gap: 6px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--gs-fg-muted);
}

.gr__note {
  margin: 0;
  font-size: 12.5px;
  color: var(--gs-fg-subtle);
}

.gr__actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 2px;
}

.gr__cta {
  border: 1px solid var(--gs-accent-cta);
  background: var(--gs-accent-cta);
  color: var(--gs-accent-cta-fg);
  font-size: 13px;
  font-weight: 600;
  border-radius: 10px;
  padding: 9px 16px;
  cursor: pointer;
}

.gr__cta:hover {
  background: var(--gs-accent-cta-hover);
  border-color: var(--gs-accent-cta-hover);
}

.gr__ghost {
  border: 1px dashed var(--gs-border-dashed);
  background: var(--gs-surface);
  color: var(--gs-fg-subtle);
  font-size: 13px;
  border-radius: 10px;
  padding: 9px 16px;
  cursor: not-allowed;
}

.gr__ghost--link {
  border-style: solid;
  border-color: var(--gs-border-strong);
  color: var(--gs-fg-2);
  cursor: pointer;
}

.gr__ghost--link:hover {
  border-color: var(--gs-accent);
  color: var(--gs-accent-strong);
}
</style>
