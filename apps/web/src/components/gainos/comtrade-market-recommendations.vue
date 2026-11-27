<script setup lang="ts">
import type { ComtradeRecommendationBundle } from '@gain-saas/shared';

import { computed, useId } from 'vue';

import { Check, Plus } from '@vben/icons';
import { usePreferences } from '@vben/preferences';
import { Button } from 'ant-design-vue';

import { $t } from '#/locales';
import { regionName } from '#/utils/region-name';

import GsCard from './ui/gs-card.vue';

const props = withDefaults(defineProps<{
  anchorPrefix?: string;
  bundle: ComtradeRecommendationBundle | null;
  disabled?: boolean;
  limitReached?: boolean;
  selectedMarkets: readonly string[];
}>(), { anchorPrefix: 'comtrade' });

const emit = defineEmits<{
  add: [code: string];
  'add-all': [codes: string[]];
}>();

const headingId = useId();
const { locale } = usePreferences();
const compactUsd = new Intl.NumberFormat('en-US', {
  currency: 'USD', maximumFractionDigits: 2, notation: 'compact', style: 'currency',
});
const fullUsd = new Intl.NumberFormat('en-US', {
  currency: 'USD', currencyDisplay: 'code', maximumFractionDigits: 2, style: 'currency',
});
const percent = computed(() => new Intl.NumberFormat(locale.value, {
  maximumFractionDigits: 2, signDisplay: 'exceptZero', style: 'percent',
}));
const selected = computed(() => new Set(props.selectedMarkets.map((code) => code.trim().toUpperCase())));
const recommendations = computed(() => props.bundle?.recommendations ?? []);
const remaining = computed(() => recommendations.value.filter(({ code }) => !selected.value.has(code)).map(({ code }) => code));
const canAdd = computed(() => !props.disabled && !props.limitReached);

const source = computed(() => props.bundle?.dataSource);
const isComtrade = computed(() => source.value === 'un_comtrade_baseline_v1' || source.value === 'un_comtrade_live');
const sourceLabel = computed(() => {
  if (source.value === 'un_comtrade_baseline_v1') return $t('gainosComtrade.baseline');
  if (source.value === 'un_comtrade_live') return $t('gainosComtrade.liveSource');
  return $t('gainosComtrade.sourceUnavailable');
});
const reportingMonth = computed(() => {
  const period = props.bundle?.referencePeriod;
  if (!period) return null;
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(4));
  const monthLabel = locale.value === 'en-US'
    ? new Intl.DateTimeFormat(locale.value, { month: 'long', timeZone: 'UTC' })
      .format(new Date(Date.UTC(year, month - 1, 1)))
    : month;
  return { label: $t('gainosComtrade.month', { year, month: monthLabel }), year };
});
const basis = computed(() => {
  const codes = [...new Set(props.bundle?.basisHsCodes.map(({ code }) => code))].join(', ');
  const period = reportingMonth.value?.label;
  if (period) {
    return codes
      ? $t('gainosComtrade.monthBasis', { codes, period })
      : $t('gainosComtrade.monthOnly', { period });
  }
  const rawYear = props.bundle?.referenceYear;
  const year = rawYear && Number.isInteger(rawYear) && rawYear > 0 ? rawYear : null;
  if (codes && year) return $t('gainos.onboarding.comtradeBasis', { codes, year });
  if (codes) return $t('gainosComtrade.hsOnly', { codes });
  if (year) return $t('gainosComtrade.yearOnly', { year });
  return '';
});
const coverageLabel = computed(() => {
  const count = props.bundle?.coverage;
  if (count === undefined) return '';
  return $t(props.bundle?.shareBasis === 'comparable_reporters'
    ? 'gainosComtrade.comparableCoverage'
    : 'gainosComtrade.coverage', { count });
});
const importLabel = computed(() => {
  if (reportingMonth.value) return 'gainosComtrade.monthlyImport';
  return source.value === 'un_comtrade_baseline_v1'
    ? 'gainos.onboarding.comtradeImportLabel'
    : 'gainosComtrade.import';
});
const rows = computed(() => recommendations.value.map((market) => {
  const fallbackName = regionName(market.code);
  const name = locale.value === 'en-US'
    ? market.labelEn || fallbackName
    : market.name === market.code ? fallbackName : market.name;
  const amount = market.importValueUsd;
  const hasAmount = amount !== null && amount >= 0;
  const growth = market.yoyGrowthPct;
  return {
    amount: hasAmount
      ? $t(importLabel.value, { value: compactUsd.format(amount) })
      : $t('gainosComtrade.importUnavailable'),
    code: market.code,
    fullAmount: hasAmount ? fullUsd.format(amount) : undefined,
    growth: growth === null
      ? $t('gainosComtrade.growthUnavailable')
      : $t('gainos.onboarding.comtradeGrowthLabel', { value: percent.value.format(growth / 100) }),
    label: name === market.code ? name : name + ' (' + market.code + ')',
    selected: selected.value.has(market.code),
  };
}));

function add(code: string): void {
  if (canAdd.value && !selected.value.has(code)) emit('add', code);
}

function addAll(): void {
  if (canAdd.value && remaining.value.length) emit('add-all', remaining.value);
}
</script>

<template>
  <section
    v-if="rows.length"
    :aria-labelledby="headingId"
    :data-gs="anchorPrefix + '-recommendations'"
    class="min-w-0 @container"
  >
    <GsCard padding="12px">
      <div class="grid gap-2">
        <header class="flex flex-wrap items-center justify-between gap-x-3">
          <h3 :id="headingId" class="m-0 text-sm font-semibold">
            {{ $t(isComtrade ? 'gainos.onboarding.comtradeTitle' : 'gainosComtrade.genericTitle') }}
          </h3>
          <Button
            type="link"
            :data-gs="anchorPrefix + '-add-all'"
            :disabled="!canAdd || remaining.length === 0"
            @click="addAll"
          >
            {{ $t('gainos.onboarding.comtradeAdoptAll') }}
          </Button>
        </header>
        <p class="m-0 flex flex-wrap gap-x-3 text-xs leading-relaxed text-[var(--gs-fg-muted)]">
          <span v-if="basis">{{ basis }}</span>
          <span v-if="reportingMonth">{{ $t('gainosComtrade.monthlyComparison', { year: reportingMonth.year - 1 }) }}</span>
          <span v-if="coverageLabel">{{ coverageLabel }}</span>
          <span>{{ sourceLabel }}</span>
        </p>
        <p v-if="bundle?.inferredFrom === 'fallback_general'" class="m-0 text-xs text-[var(--gs-fg-muted)]">
          {{ $t('gainosComtrade.fallback') }}
        </p>
        <div class="grid min-w-0 gap-2 @min-[390px]:grid-cols-2 @min-[660px]:grid-cols-3">
          <Button
            v-for="row in rows"
            :key="row.code"
            :aria-disabled="row.selected || undefined"
            :aria-pressed="row.selected"
            :data-gs="anchorPrefix + '-market-' + row.code"
            :disabled="disabled || (limitReached && !row.selected)"
            block
            class="comtrade-market-card"
            @click="add(row.code)"
          >
            <span class="comtrade-market-card__body">
              <span class="flex items-center gap-1.5 font-semibold">
                <component :is="row.selected ? Check : Plus" aria-hidden="true" :size="14" />
                {{ row.label }}
              </span>
              <span class="text-xs leading-relaxed text-[var(--gs-fg-muted)]">
                <span :title="row.fullAmount">{{ row.amount }}</span>
                <span aria-hidden="true"> · </span>
                <span>{{ row.growth }}</span>
              </span>
            </span>
          </Button>
        </div>
        <p class="m-0 text-xs text-[var(--gs-fg-muted)]">{{ $t('gainos.onboarding.comtradeHint') }}</p>
      </div>
    </GsCard>
  </section>
</template>

<style scoped>
.comtrade-market-card {
  height: 100%;
  min-height: 60px;
  padding: 8px 10px;
  text-align: start;
  white-space: normal;
}
.comtrade-market-card > .comtrade-market-card__body {
  display: grid;
  min-width: 0;
  gap: 2px;
  overflow-wrap: anywhere;
}
.comtrade-market-card[aria-pressed='true'] {
  border-color: var(--gs-accent-fg);
  background: var(--gs-accent-soft);
  color: var(--gs-fg);
  cursor: default;
}
</style>
