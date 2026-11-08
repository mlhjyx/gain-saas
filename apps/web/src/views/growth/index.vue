<script lang="ts" setup>
/**
 * 「商机与触达」合并入口（P6 设计 D-14-a）：一个一级导航，页内三 tab。
 * 14-1 为空壳与语义落位；14-2 按 M2.1（战役计划/审批）、步 10（商机）、步 11（触达）的 API 挂接。
 * 页面用语一律走 glossary（tab 名）与 gainos.growth.*（句子），状态图例用 glossary 状态表。
 */
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import type { StatusTone } from '@gain-saas/shared';

import {
  APPROVAL_STATE,
  CAMPAIGN_STATUS,
  glossaryTerm,
  QGO_STATE,
  statusClass,
} from '@gain-saas/shared';
import { preferences } from '@vben/preferences';

import { $t } from '#/locales';

defineOptions({ name: 'Growth' });

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

interface LegendItem {
  key: string;
  label: string;
  tone: StatusTone;
}

function legend(
  table: Record<string, { en: string; tone: string; zh: string }>,
  keys: string[],
): LegendItem[] {
  return keys.map((key) => {
    const entry = table[key]!;
    return {
      key,
      label: preferences.app.locale === 'en-US' ? entry.en : entry.zh,
      tone: entry.tone,
    };
  });
}

const campaignLegend = legend(CAMPAIGN_STATUS, ['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED']);
const qgoLegend = legend(QGO_STATE, ['OPEN', 'CONVERTED', 'DROPPED']);
const approvalLegend = legend(APPROVAL_STATE, ['PENDING', 'APPROVED', 'DECLINED', 'EXPIRED']);
</script>

<template>
  <div class="gr">
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

    <section v-if="active === 'campaigns'" class="gr__panel" role="tabpanel">
      <div class="gr__shadow">
        <strong>{{ $t('gainos.growth.shadowTitle') }}</strong>
        <p>{{ $t('gainos.growth.shadowDesc') }}</p>
      </div>
      <article class="gr__card">
        <div class="gr__card-head">
          <h2>{{ $t('gainos.growth.campaignTitle') }}</h2>
          <div class="gr__legend">
            <span
              v-for="item in campaignLegend"
              :key="item.key"
              class="gs-badge"
              :class="statusClass(item.tone)"
            >
              {{ item.label }}
            </span>
          </div>
        </div>
        <p class="gr__desc">{{ $t('gainos.growth.campaignDesc') }}</p>
        <ul class="gr__points">
          <li>{{ $t('gainos.growth.campaignPoint1') }}</li>
          <li>{{ $t('gainos.growth.campaignPoint2') }}</li>
          <li>{{ $t('gainos.growth.campaignPoint3') }}</li>
        </ul>
        <div class="gr__actions">
          <button class="gr__cta" type="button" @click="router.push('/find-buyers')">
            {{ $t('gainos.growth.campaignCta') }}
          </button>
          <button class="gr__ghost" type="button" disabled>
            {{ $t('gainos.growth.campaignDisabled') }}
          </button>
        </div>
      </article>
    </section>

    <section v-else-if="active === 'opportunities'" class="gr__panel" role="tabpanel">
      <article class="gr__card">
        <div class="gr__card-head">
          <h2>{{ $t('gainos.growth.qgoTitle') }}</h2>
          <div class="gr__legend">
            <span
              v-for="item in qgoLegend"
              :key="item.key"
              class="gs-badge"
              :class="statusClass(item.tone)"
            >
              {{ item.label }}
            </span>
          </div>
        </div>
        <p class="gr__desc">{{ $t('gainos.growth.qgoDesc') }}</p>
        <ul class="gr__points">
          <li>{{ $t('gainos.growth.qgoPoint1') }}</li>
          <li>{{ $t('gainos.growth.qgoPoint2') }}</li>
          <li>{{ $t('gainos.growth.qgoPoint3') }}</li>
        </ul>
        <div class="gr__actions">
          <button class="gr__cta" type="button" @click="router.push('/leads')">
            {{ $t('gainos.growth.qgoCta') }}
          </button>
          <button class="gr__ghost" type="button" disabled>
            {{ $t('gainos.growth.qgoDisabled') }}
          </button>
        </div>
      </article>
    </section>

    <section v-else class="gr__panel" role="tabpanel">
      <article class="gr__card">
        <div class="gr__card-head">
          <h2>{{ $t('gainos.growth.outreachTitle') }}</h2>
          <div class="gr__legend">
            <span
              v-for="item in approvalLegend"
              :key="item.key"
              class="gs-badge"
              :class="statusClass(item.tone)"
            >
              {{ item.label }}
            </span>
          </div>
        </div>
        <p class="gr__desc">{{ $t('gainos.growth.outreachDesc') }}</p>
        <ul class="gr__points">
          <li>{{ $t('gainos.growth.outreachPoint1') }}</li>
          <li>{{ $t('gainos.growth.outreachPoint2') }}</li>
          <li>{{ $t('gainos.growth.outreachPoint3') }}</li>
        </ul>
        <p class="gr__note">{{ $t('gainos.growth.outreachNote') }}</p>
        <div class="gr__actions">
          <button class="gr__cta" type="button" @click="router.push('/leads')">
            {{ $t('gainos.growth.outreachCta') }}
          </button>
          <button class="gr__ghost" type="button" disabled>
            {{ $t('gainos.growth.outreachDisabled') }}
          </button>
        </div>
      </article>
    </section>
  </div>
</template>

<style scoped>
.gr {
  max-width: 1080px;
  margin: 0 auto;
  padding: 24px 20px 48px;
  display: grid;
  gap: 16px;
}

.gr__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.gr__head-main h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 650;
  color: var(--gs-fg);
  letter-spacing: -0.01em;
}

.gr__sub {
  margin: 6px 0 0;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--gs-fg-muted);
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
  display: grid;
  gap: 14px;
}

.gr__shadow {
  border: 1px solid var(--gs-border);
  border-left: 3px solid var(--gs-accent);
  background: var(--gs-surface-3);
  border-radius: 12px;
  padding: 14px 16px;
}

.gr__shadow strong {
  font-size: 13.5px;
  color: var(--gs-fg);
}

.gr__shadow p {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--gs-fg-muted);
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
  border: 1px solid var(--gs-accent);
  background: var(--gs-accent);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  border-radius: 10px;
  padding: 9px 16px;
  cursor: pointer;
}

.gr__cta:hover {
  background: var(--gs-accent-strong);
  border-color: var(--gs-accent-strong);
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
</style>
