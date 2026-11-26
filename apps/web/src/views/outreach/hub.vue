<script lang="ts" setup>
/**
 * 外发与战役工作台（Wave B2 拆解原 /growth 杂烩页）。
 *
 * 3 个与 URL `?tab=campaigns|batches|replies` 同步的 Tab（默认 campaigns），
 * 懒加载对应真实视图；彻底移除页头无条件挂接的运行期/影子期徽标，执行限制按各子区块如实展示。
 */
import { computed, defineAsyncComponent } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { glossaryTerm } from '@gain-saas/shared';
import { preferences } from '@vben/preferences';
import { Tabs } from 'ant-design-vue';

import GsPage from '#/components/gainos/ui/gs-page.vue';
import { $t } from '#/locales';

defineOptions({ name: 'OutreachHub' });

const CampaignsList = defineAsyncComponent(() => import('#/views/campaigns/index.vue'));
const OutreachBatches = defineAsyncComponent(() => import('#/views/outreach/index.vue'));
const OutreachReplies = defineAsyncComponent(() => import('#/views/outreach/replies.vue'));

const TAB_KEYS = ['campaigns', 'batches', 'replies'] as const;
type OutreachHubTab = (typeof TAB_KEYS)[number];
const TAB_SET = new Set<string>(TAB_KEYS);

const route = useRoute();
const router = useRouter();

const activeTab = computed<OutreachHubTab>(() => {
  const raw = Array.isArray(route.query.tab) ? route.query.tab[0] : route.query.tab;
  return typeof raw === 'string' && TAB_SET.has(raw) ? (raw as OutreachHubTab) : 'campaigns';
});

const tabs = computed(() => [
  {
    key: 'campaigns' as const,
    label: glossaryTerm('campaign', preferences.app.locale),
  },
  {
    key: 'batches' as const,
    label: $t('gainosP0.outreachHub.tabBatches'),
  },
  {
    key: 'replies' as const,
    label: $t('gainosP0.outreachHub.tabReplies'),
  },
]);

function onTabChange(key: number | string): void {
  const next = typeof key === 'string' && TAB_SET.has(key) ? (key as OutreachHubTab) : 'campaigns';
  if (next === activeTab.value && route.query.tab === next) return;
  void router.replace({
    path: '/outreach',
    query: { ...route.query, tab: next },
  });
}
</script>

<template>
  <div
    class="mx-auto grid w-full max-w-[var(--gs-page-max)] grid-cols-1 gap-4 px-[var(--gs-page-pad)] py-6 pb-12 @container"
    data-gs="outreach-hub"
  >
    <GsPage
      :hero="false"
      :subtitle="$t('gainosP0.outreachHub.subtitle')"
      :title="$t('gainosP0.outreachHub.title')"
    />

    <div class="min-w-0" data-gs="outreach-hub-tabs">
      <Tabs
        :active-key="activeTab"
        :aria-label="$t('gainosP0.outreachHub.tabsLabel')"
        @change="onTabChange"
      >
        <Tabs.TabPane v-for="tab in tabs" :key="tab.key" :tab="tab.label">
          <div class="min-w-0 pt-2" :data-gs="`outreach-hub-panel-${tab.key}`">
            <CampaignsList v-if="tab.key === 'campaigns' && activeTab === 'campaigns'" embedded />
            <OutreachBatches v-else-if="tab.key === 'batches' && activeTab === 'batches'" embedded />
            <OutreachReplies v-else-if="tab.key === 'replies' && activeTab === 'replies'" embedded />
          </div>
        </Tabs.TabPane>
      </Tabs>
    </div>
  </div>
</template>
