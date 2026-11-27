<script lang="ts" setup>
import type { QueryPlan } from '#/api/gainos';

import { computed } from 'vue';

import { formatDateTime } from '@gain-saas/shared';

import GsTag from '#/components/gainos/ui/gs-tag.vue';
import { $t } from '#/locales';
import { regionName } from '#/utils/region-name';

const props = defineProps<{ plan: QueryPlan }>();

const SOURCES: Record<string, string> = {
  industry_data: 'industryData',
  openfda: 'openFda',
  public_intelligence: 'publicIntelligence',
  public_web: 'publicWeb',
  ted: 'ted',
};
const MARKET_FIELDS = ['country', 'region', 'area_name'];
const FILTERS: Record<string, string> = { area_name: 'area', country: 'country', industry: 'industry', region: 'region', sub_industry: 'subIndustry' };
const INTERNAL_CODE = /(^|[^A-Za-z0-9])[a-z]+(?:_[a-z0-9]+)+(?![A-Za-z0-9])|\b[A-Z][A-Z_]{2,}\b/;

function textList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .map((value) => value.trim());
}

function localized(values: string[]): string {
  return values.map(regionName).join(' · ');
}

function filterItems(filters: Record<string, unknown>) {
  const items = Object.entries(FILTERS).flatMap(([key, label]) => {
    const values = textList(filters[key]);
    if (!values.length) return [];
    return [{ label: $t(`gainos.findBuyers.queryFilter.${label}`), value: MARKET_FIELDS.includes(key) ? localized(values) : values.join(' · ') }];
  });
  const trade = String(filters.trade_side ?? '');
  if (['manufacturer', 'distributor', 'buyer'].includes(trade)) {
    items.push({ label: $t('gainos.findBuyers.queryFilter.tradeSide'), value: $t(`gainos.findBuyers.tradeSide.${trade}`) });
  }
  return items;
}

function splitRationale(value: unknown) {
  const notes: string[] = [];
  const technical: string[] = [];
  if (typeof value !== 'string') return { notes, technical };
  for (const raw of value.replace(/\[source_filter\]/gi, '').split(/[;；。\n]/)) {
    const line = raw.trim();
    if (!line) continue;
    const warning = /^icp_fit_warning\s*[:：]\s*(.+)$/i.exec(line)?.[1];
    if (warning && !/[a-z]+(?:_[a-z0-9]+)+/.test(warning)) {
      notes.push(`${$t('gainos.findBuyers.noteWarning')}：${warning}`);
    } else if (INTERNAL_CODE.test(line)) {
      technical.push(line);
    } else {
      notes.push(line);
    }
  }
  return { notes, technical };
}

const queries = computed(() => (Array.isArray(props.plan.queries) ? props.plan.queries : []));
const groups = computed(() => {
  const grouped = new Map<string, Array<{
    filters: ReturnType<typeof filterItems>;
    keywords: string[];
    priority: string;
    rationale: ReturnType<typeof splitRationale>;
  }>>();
  for (const query of queries.value) {
    const source = SOURCES[String(query.source_class ?? '')] ?? 'other';
    const group = grouped.get(source) ?? [];
    group.push({
      filters: filterItems((query.filters ?? {}) as Record<string, unknown>),
      keywords: textList(query.keywords),
      priority: typeof query.priority === 'number' ? String(query.priority) : '',
      rationale: splitRationale(query.rationale),
    });
    grouped.set(source, group);
  }
  return [...grouped.entries()];
});
const markets = computed(() => [...new Set(queries.value.flatMap((query) => {
  const filters = (query.filters ?? {}) as Record<string, unknown>;
  return MARKET_FIELDS.flatMap((key) => textList(filters[key]).map(regionName));
}))].join(' · '));
const state = computed(() => {
  const status = props.plan.status;
  if (status === 'READY') return { label: $t('gainos.findBuyers.planStatus.READY'), tone: 'info' } as const;
  if (status === 'EXECUTED') return { label: $t('gainos.findBuyers.planStatus.EXECUTED'), tone: 'success' } as const;
  if (status === 'DRAFT') return { label: $t('gainos.findBuyers.planStatus.DRAFT'), tone: 'warning' } as const;
  return { label: $t('gainosBuyerJourney.sourcing.unknownStatus'), tone: 'neutral' } as const;
});
const cost = computed(() => {
  const cents = props.plan.estimatedCostCents;
  return typeof cents === 'number' && Number.isFinite(cents) ? `$${(cents / 100).toFixed(2)}` : '';
});
</script>

<template>
  <article class="plan-summary">
    <header class="plan-summary-head">
      <div>
        <h3>{{ $t('gainos.findBuyers.version', { version: plan.version }) }}</h3>
        <p v-if="plan.createdAt">{{ formatDateTime(plan.createdAt) }}</p>
      </div>
      <GsTag :tone="state.tone">{{ state.label }}</GsTag>
    </header>
    <p>{{ $t('gainos.findBuyers.planLead', { channels: groups.length, queries: queries.length }) }}</p>
    <dl class="plan-summary-data">
      <div>
        <dt>{{ $t('gainosBuyerJourney.sourcing.planFilters') }}</dt>
        <dd data-gs="plan-market-scope">{{ markets || $t('gainosBuyerJourney.sourcing.planFiltersUnknown') }}</dd>
      </div>
      <div v-if="typeof plan.estimatedVolume === 'number'">
        <dt>{{ $t('gainos.findBuyers.planEstimated', { count: plan.estimatedVolume }) }}</dt>
      </div>
      <div v-if="cost">
        <dt>{{ $t('gainosBuyerJourney.sourcing.technicalCost', { value: cost }) }}</dt>
      </div>
    </dl>
    <details v-for="[source, group] in groups" :key="source" class="plan-source">
      <summary>
        <strong>{{ $t(`gainos.findBuyers.querySource.${source}`) }}</strong>
        <span>{{ $t('gainos.findBuyers.planSearchCount', { count: group.length }) }}</span>
      </summary>
      <ol class="plan-queries">
        <li v-for="(query, index) in group" :key="index">
          <p v-if="query.priority">{{ $t('gainos.findBuyers.planPriority', { priority: query.priority }) }}</p>
          <p v-if="query.keywords.length"><strong>{{ query.keywords.join(' · ') }}</strong></p>
          <dl v-if="query.filters.length" class="plan-summary-data">
            <div v-for="entry in query.filters" :key="entry.label">
              <dt>{{ entry.label }}</dt><dd>{{ entry.value }}</dd>
            </div>
          </dl>
          <ul v-if="query.rationale.notes.length">
            <li v-for="(note, i) in query.rationale.notes" :key="i">{{ note }}</li>
          </ul>
          <details v-if="query.rationale.technical.length">
            <summary>{{ $t('gainos.findBuyers.technicalDetails') }}</summary>
            <ul><li v-for="(note, i) in query.rationale.technical" :key="i">{{ note }}</li></ul>
          </details>
        </li>
      </ol>
    </details>
    <details v-if="queries.length">
      <summary>{{ $t('gainos.findBuyers.planRaw') }}</summary>
      <pre>{{ JSON.stringify(queries, null, 2) }}</pre>
    </details>
  </article>
</template>

<style scoped>
.plan-summary { display: grid; gap: 12px; overflow-wrap: anywhere; }
.plan-summary-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.plan-summary h3 { margin: 0; font-size: 16px; font-weight: 600; }
.plan-summary p { margin: 0; color: var(--gs-fg-muted); }
.plan-summary-data { display: grid; gap: 6px; margin: 0; }
.plan-summary-data div { display: flex; flex-wrap: wrap; gap: 4px 10px; }
.plan-summary-data dt { color: var(--gs-fg-muted); }
.plan-summary-data dd { margin: 0; font-weight: 500; }
.plan-source { padding: 8px 12px; border: 1px solid var(--gs-border); border-radius: 8px; }
.plan-summary summary { padding: 4px 0; cursor: pointer; color: var(--gs-accent-fg); }
.plan-source summary span { margin-inline-start: 8px; color: var(--gs-fg-muted); font-size: 12px; }
.plan-queries { display: grid; gap: 10px; margin: 8px 0 0; padding-inline-start: 20px; }
.plan-queries > li { padding: 6px 0; }
.plan-queries > li + li { border-top: 1px solid var(--gs-divider); }
.plan-summary pre { overflow: auto; max-height: 240px; margin: 8px 0 0; padding: 10px; background: var(--gs-surface-2); font-size: 12px; }
</style>
