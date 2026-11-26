<script lang="ts" setup>
/**
 * 成效复盘（PR-UI2：原「度量」全面白话化与视觉统一）：
 * - 页面主标题统一为「成效复盘」（与左侧栏菜单和顶栏面包屑完全一致）；
 * - 全部原生 <select> 替换为 GsSelect，全部按钮统一 AntDV Button（8px 圆角，清零 9999px 胶囊）；
 * - 消除「大白卡套虚线圆角框」双层套娃，统一单层 1px 细线表面与 GsEmpty；
 * - 面向外贸管理者的主表面改写为业务白话，将 VRIC / 聚合桶等工程口径收入折叠「数据口径说明」区；
 * - 保持缺侧 null 断线语义（不以 0 冒充缺失）与明暗双主题 ECharts 联动。
 */
import type { MetricCatalogItem, MetricObservation, MetricRollup, VricBucket } from '#/api/gainos';

import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { formatDate, formatDateTime, glossaryStatus } from '@gain-saas/shared';
import { RotateCw, Search } from '@vben/icons';
import { EchartsUI, useEcharts } from '@vben/plugins/echarts';
import { preferences, usePreferences } from '@vben/preferences';

import { Button, Input, Skeleton, TabPane, Tabs } from 'ant-design-vue';

import ErrorNotice from '#/components/error-notice.vue';
import GsEmpty from '#/components/gainos/ui/gs-empty.vue';
import GsPage from '#/components/gainos/ui/gs-page.vue';
import GsSelect from '#/components/gainos/ui/gs-select.vue';
import GsTag from '#/components/gainos/ui/gs-tag.vue';
import { $t } from '#/locales';

import { failureText, gainosApi } from '#/api/gainos';

defineOptions({ name: 'GainMetrics' });

// 内嵌在其他页面时不渲染自己的页头容器。
defineProps<{ embedded?: boolean }>();

const router = useRouter();

type ErrorCopy = { next?: string; title: string; why?: string };
type ChartOption = Parameters<ReturnType<typeof useEcharts>['renderEcharts']>[0];
type GsTone = 'danger' | 'info' | 'neutral' | 'success' | 'warning';

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function num(value: null | number | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function metricStatus(value: null | string | undefined) {
  return glossaryStatus('metricStatus', value ?? undefined, preferences.app.locale);
}

function metricTone(value: null | string | undefined): GsTone {
  const tone = metricStatus(value)?.tone ?? 'neutral';
  return tone === 'processing' ? 'info' : tone;
}

function tierLabel(tier: string): string {
  const key = `gainos.metrics.tiers.${tier}`;
  const text = $t(key);
  return text === key ? tier : text;
}

function unitLabel(unit: string): string {
  const key = `gainos.metrics.units.${unit}`;
  const text = $t(key);
  return text === key ? unit : text;
}

const STRATUM_DIMENSIONS = [
  'country',
  'industry',
  'source_class',
  'provider_key',
  'verifier',
  'persona_role',
  'employee_band',
] as const;

function stratumLabel(key: string): string {
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(key) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }
  const parts: string[] = [];
  if (typeof parsed.channel === 'string') {
    const channelKey = `gainos.metrics.channels.${parsed.channel}`;
    const text = $t(channelKey);
    parts.push(text === channelKey ? parsed.channel : text);
  }
  for (const dimension of STRATUM_DIMENSIONS) {
    const value = parsed[dimension];
    if (typeof value === 'string' || typeof value === 'number') parts.push(String(value));
  }
  if (parts.length > 0) return parts.join(' · ');
  const hasOtherKeys = Object.keys(parsed).some((name) => name !== 'workspace_id' && name !== 'icp_id');
  return hasOtherKeys ? $t('gainos.metrics.stratumOther') : $t('gainos.metrics.stratumDefault');
}

// ── 寻源可达与转化趋势（VRIC 双口径）────────────────────────────────────────
const granularity = ref<'daily' | 'weekly'>('daily');
const vricBuckets = ref<VricBucket[]>([]);
const vricHasMore = ref(false);
const vricLoading = ref(true);
const vricError = ref<ErrorCopy | null>(null);
const stratum = ref('');

const granularityOptions = computed(() => [
  { label: $t('gainos.metrics.daily'), value: 'daily' },
  { label: $t('gainos.metrics.weekly'), value: 'weekly' },
]);

const strata = computed(() => [...new Set(vricBuckets.value.map((bucket) => bucket.stratumKey))].sort());
const stratumOptions = computed(() =>
  strata.value.map((key) => ({ label: stratumLabel(key), value: key })),
);

function stratumDimensions(key: string): string[] {
  try {
    const value = JSON.parse(key) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    return Object.keys(value as Record<string, unknown>).filter(
      (name) => name !== 'workspace_id' && name !== 'icp_id',
    );
  } catch {
    return [];
  }
}

function pickDefaultStratum(list: string[]): string {
  return (
    list.find((key) => stratumDimensions(key).length === 0) ??
    list.find((key) => !stratumDimensions(key).includes('channel')) ??
    list[0] ??
    ''
  );
}

const chartBuckets = computed(() =>
  vricBuckets.value
    .filter((bucket) => bucket.stratumKey === stratum.value)
    .slice()
    .sort((left, right) => left.bucket.localeCompare(right.bucket)),
);
const latestBucket = computed(() => chartBuckets.value[chartBuckets.value.length - 1] ?? null);
const strictLabel = computed(() => $t('gainosUi2.analytics.strictShort'));
const plusLabel = computed(() => $t('gainosUi2.analytics.plusShort'));

function seriesValues(side: 'plus' | 'strict'): Array<null | number> {
  return chartBuckets.value.map((bucket) => bucket[side]?.value ?? null);
}

const chartRef = ref();
const { renderEcharts } = useEcharts(chartRef);
const { isDark } = usePreferences();

function buildChartOption(): ChartOption {
  const axisColor = cssVar('--gs-fg-muted', '#5C5C5C');
  const gridColor = cssVar('--gs-divider', '#F0F0F0');
  const strictColor = cssVar('--gs-accent', '#335CFF');
  const plusColor = cssVar('--gs-success', '#1A7544');
  return {
    tooltip: { trigger: 'axis' },
    legend: { data: [strictLabel.value, plusLabel.value], textStyle: { color: axisColor } },
    grid: { bottom: 8, containLabel: true, left: 8, right: 18, top: 42 },
    xAxis: {
      axisLabel: { color: axisColor },
      axisLine: { lineStyle: { color: gridColor } },
      boundaryGap: false,
      data: chartBuckets.value.map((bucket) => bucket.bucket),
      type: 'category',
    },
    yAxis: {
      axisLabel: { color: axisColor },
      splitLine: { lineStyle: { color: gridColor } },
      type: 'value',
    },
    series: [
      {
        connectNulls: false,
        data: seriesValues('strict'),
        itemStyle: { color: strictColor },
        lineStyle: { color: strictColor, width: 2 },
        name: strictLabel.value,
        symbolSize: 6,
        type: 'line',
      },
      {
        connectNulls: false,
        data: seriesValues('plus'),
        itemStyle: { color: plusColor },
        lineStyle: { color: plusColor, width: 2 },
        name: plusLabel.value,
        symbolSize: 6,
        type: 'line',
      },
    ],
  } as ChartOption;
}

function renderChart(): void {
  if (chartBuckets.value.length === 0) return;
  void nextTick(() => {
    void renderEcharts(buildChartOption());
  });
}

async function loadVric(): Promise<void> {
  vricLoading.value = true;
  vricError.value = null;
  try {
    const result = await gainosApi.vricSeries({ granularity: granularity.value, limit: 30 });
    vricBuckets.value = Array.isArray(result.data) ? result.data : [];
    vricHasMore.value = Boolean(result.page?.has_more);
    const available = strata.value;
    if (!available.includes(stratum.value)) {
      stratum.value = pickDefaultStratum(available);
    }
  } catch (err) {
    vricBuckets.value = [];
    vricError.value = failureText(err);
  } finally {
    vricLoading.value = false;
  }
}

watch([granularity], () => {
  void loadVric();
});
watch([chartBuckets], () => {
  renderChart();
});
watch([isDark, strictLabel, plusLabel], () => {
  renderChart();
});

const vricChartLabel = computed(() => {
  const latest = latestBucket.value;
  return latest
    ? $t('gainos.metrics.chartAriaLatest', {
        bucket: latest.bucket,
        plus: num(latest.plus?.value),
        strict: num(latest.strict?.value),
      })
    : $t('gainosUi2.analytics.trendTitle');
});

// ── 指标口径 ────────────────────────────────────────────────────────────────
const catalog = ref<MetricCatalogItem[]>([]);
const catalogLoading = ref(true);
const catalogError = ref<ErrorCopy | null>(null);
const catalogSearch = ref('');
const catalogStatus = ref('');
const catalogTier = ref('');

const catalogTiers = computed(() => [...new Set(catalog.value.map((item) => item.tier))].sort());
const catalogMetricIds = computed(() => [...new Set(catalog.value.map((item) => item.metricId))]);

const catalogTierOptions = computed(() => [
  { label: $t('gainos.metrics.all'), value: '' },
  ...catalogTiers.value.map((tier) => ({ label: tierLabel(tier), value: tier })),
]);
const catalogStatusOptions = computed(() => [
  { label: $t('gainos.metrics.all'), value: '' },
  { label: metricStatus('ACTIVE')?.label ?? 'ACTIVE', value: 'ACTIVE' },
  { label: metricStatus('DRAFT')?.label ?? 'DRAFT', value: 'DRAFT' },
  { label: metricStatus('DEPRECATED')?.label ?? 'DEPRECATED', value: 'DEPRECATED' },
  { label: metricStatus('RETIRED')?.label ?? 'RETIRED', value: 'RETIRED' },
]);
const metricIdOptions = computed(() => [
  { label: $t('gainos.metrics.metricAll'), value: '' },
  ...catalogMetricIds.value.map((metricId) => ({ label: metricId, value: metricId })),
]);

const catalogRows = computed(() => {
  const needle = catalogSearch.value.trim().toLowerCase();
  return catalog.value.filter((item) => {
    if (catalogStatus.value && item.status !== catalogStatus.value) return false;
    if (catalogTier.value && item.tier !== catalogTier.value) return false;
    if (!needle) return true;
    return `${item.metricId} ${item.name}`.toLowerCase().includes(needle);
  });
});

async function loadCatalog(): Promise<void> {
  catalogLoading.value = true;
  catalogError.value = null;
  try {
    const result = await gainosApi.metricCatalog();
    catalog.value = Array.isArray(result.data) ? result.data : [];
  } catch (err) {
    catalogError.value = failureText(err);
  } finally {
    catalogLoading.value = false;
  }
}

// ── 周期明细与汇总报表 ──────────────────────────────────────────────────────
type TableTab = 'catalog' | 'observations' | 'rollups';
const activeTable = ref<TableTab>('catalog');

interface TableFilters {
  from: string;
  metricId: string;
  to: string;
}
const observationFilters = ref<TableFilters>({ from: '', metricId: '', to: '' });
const rollupFilters = ref<TableFilters>({ from: '', metricId: '', to: '' });
const rollupGranularity = ref<'daily' | 'weekly'>('daily');

const observations = ref<MetricObservation[]>([]);
const observationLoading = ref(false);
const observationLoadingMore = ref(false);
const observationError = ref<ErrorCopy | null>(null);
const observationNextCursor = ref<null | string>(null);
const observationLoaded = ref(false);

const rollups = ref<MetricRollup[]>([]);
const rollupLoading = ref(false);
const rollupLoadingMore = ref(false);
const rollupError = ref<ErrorCopy | null>(null);
const rollupNextCursor = ref<null | string>(null);
const rollupLoaded = ref(false);

function filterParams(filters: TableFilters): Record<string, string> {
  return {
    ...(filters.metricId ? { metricId: filters.metricId } : {}),
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
  };
}

async function loadObservations(reset = true): Promise<void> {
  if (reset) observationLoading.value = true;
  else observationLoadingMore.value = true;
  observationError.value = null;
  try {
    const result = await gainosApi.metricObservations({
      ...filterParams(observationFilters.value),
      limit: 50,
      ...(reset ? {} : { cursor: observationNextCursor.value ?? undefined }),
    });
    const rows = Array.isArray(result.data) ? result.data : [];
    observations.value = reset ? rows : [...observations.value, ...rows];
    observationNextCursor.value = result.page?.next_cursor ?? null;
    observationLoaded.value = true;
  } catch (err) {
    observationError.value = failureText(err);
  } finally {
    observationLoading.value = false;
    observationLoadingMore.value = false;
  }
}

async function loadRollups(reset = true): Promise<void> {
  if (reset) rollupLoading.value = true;
  else rollupLoadingMore.value = true;
  rollupError.value = null;
  try {
    const result = await gainosApi.metricRollups({
      ...filterParams(rollupFilters.value),
      granularity: rollupGranularity.value,
      limit: 50,
      ...(reset ? {} : { cursor: rollupNextCursor.value ?? undefined }),
    });
    const rows = Array.isArray(result.data) ? result.data : [];
    rollups.value = reset ? rows : [...rollups.value, ...rows];
    rollupNextCursor.value = result.page?.next_cursor ?? null;
    rollupLoaded.value = true;
  } catch (err) {
    rollupError.value = failureText(err);
  } finally {
    rollupLoading.value = false;
    rollupLoadingMore.value = false;
  }
}

function onTableTabChange(next: number | string): void {
  const key = String(next) as TableTab;
  activeTable.value = key;
  if (key === 'observations' && !observationLoaded.value) void loadObservations(true);
  if (key === 'rollups' && !rollupLoaded.value) void loadRollups(true);
}

watch(rollupGranularity, () => {
  if (activeTable.value === 'rollups') void loadRollups(true);
});

function resetObservationFilters(): void {
  observationFilters.value = { from: '', metricId: '', to: '' };
  void loadObservations(true);
}

function resetRollupFilters(): void {
  rollupFilters.value = { from: '', metricId: '', to: '' };
  void loadRollups(true);
}

function refreshAll(): void {
  void loadVric();
  void loadCatalog();
  if (activeTable.value === 'observations' && observationLoaded.value) void loadObservations(true);
  if (activeTable.value === 'rollups' && rollupLoaded.value) void loadRollups(true);
}

onMounted(() => {
  void loadCatalog();
  void loadVric();
});
</script>

<template>
  <div
    :class="
      embedded
        ? 'grid grid-cols-1 gap-4 @container'
        : 'mx-auto grid w-full max-w-[var(--gs-page-max)] grid-cols-1 gap-4 px-[var(--gs-page-pad)] pb-12 @container'
    "
    data-gs="analytics-page"
  >
    <GsPage
      v-if="!embedded"
      :subtitle="$t('gainosUi2.analytics.subtitle')"
      :title="$t('gainosUi2.analytics.title')"
    >
      <template #actions>
        <Button :loading="vricLoading" data-gs="analytics-refresh" size="small" @click="refreshAll">
          <template v-if="!vricLoading" #icon>
            <RotateCw :size="14" />
          </template>
          {{ $t('gainos.common.refresh') }}
        </Button>
      </template>
    </GsPage>
    <div v-else class="flex items-center justify-between gap-3">
      <div>
        <h2 class="m-0 text-[18px] font-semibold text-[var(--gs-fg)]">
          {{ $t('gainosUi2.analytics.title') }}
        </h2>
        <p class="m-0 mt-0.5 text-[13px] text-[var(--gs-fg-muted)]">
          {{ $t('gainosUi2.analytics.subtitle') }}
        </p>
      </div>
      <Button :loading="vricLoading" size="small" @click="refreshAll">
        <template v-if="!vricLoading" #icon>
          <RotateCw :size="14" />
        </template>
        {{ $t('gainos.common.refresh') }}
      </Button>
    </div>

    <!-- 寻源可达与转化趋势（单层 1px 细线表面，0 虚线套娃） -->
    <section
      :aria-label="$t('gainosUi2.analytics.trendTitle')"
      class="an-surface"
      data-gs="analytics-trend"
    >
      <header class="an-surface__head">
        <div class="min-w-0">
          <h2 class="an-surface__title">{{ $t('gainosUi2.analytics.trendTitle') }}</h2>
          <p class="an-surface__sub">{{ $t('gainosUi2.analytics.trendSubtitle') }}</p>
        </div>
        <div class="an-controls">
          <div class="w-[116px]" data-gs="analytics-granularity">
            <GsSelect
              v-model="granularity"
              :aria-label="$t('gainosUi2.analytics.granularity')"
              :ariaLabel="$t('gainosUi2.analytics.granularity')"
              :options="granularityOptions"
              class="w-full"
              size="small"
            />
          </div>
          <div v-if="strata.length > 1" class="w-[168px]" data-gs="analytics-stratum">
            <GsSelect
              v-model="stratum"
              :aria-label="$t('gainosUi2.analytics.stratum')"
              :ariaLabel="$t('gainosUi2.analytics.stratum')"
              :options="stratumOptions"
              class="w-full"
              size="small"
            />
          </div>
        </div>
      </header>

      <Skeleton v-if="vricLoading" active :paragraph="{ rows: 4 }" />
      <div v-else-if="vricError" class="grid gap-3">
        <ErrorNotice :next="vricError.next" :title="vricError.title" />
        <Button class="justify-self-start" size="small" @click="loadVric">
          {{ $t('gainos.common.retry') }}
        </Button>
      </div>
      <GsEmpty
        v-else-if="chartBuckets.length === 0"
        :description="$t('gainosUi2.analytics.emptyDesc')"
        :title="$t('gainosUi2.analytics.emptyTitle')"
      >
        <template #actions>
          <Button type="primary" @click="router.push('/leads')">
            {{ $t('gainosUi2.analytics.emptyPrimaryCta') }}
          </Button>
          <Button @click="router.push('/leads?view=reviews')">
            {{ $t('gainosUi2.analytics.emptySecondaryCta') }}
          </Button>
        </template>
      </GsEmpty>
      <template v-else>
        <div class="mt__summary an-summary" data-gs="analytics-summary">
          <span class="an-summary__item">
            <span class="an-summary__label">{{ $t('gainosUi2.analytics.latestDate') }}</span>
            <strong class="an-summary__val">{{ latestBucket?.bucket }}</strong>
          </span>
          <span aria-hidden="true" class="an-summary__sep" />
          <span class="an-summary__item">
            <span aria-hidden="true" class="an-dot an-dot--brand" />
            <span class="an-summary__label">{{ strictLabel }}</span>
            <strong class="an-summary__val">{{ num(latestBucket?.strict?.value) }}</strong>
          </span>
          <span aria-hidden="true" class="an-summary__sep" />
          <span class="an-summary__item">
            <span aria-hidden="true" class="an-dot an-dot--success" />
            <span class="an-summary__label">{{ plusLabel }}</span>
            <strong class="an-summary__val">{{ num(latestBucket?.plus?.value) }}</strong>
          </span>
          <span v-if="vricHasMore" class="text-xs text-[var(--gs-fg-muted)]">
            {{ $t('gainos.metrics.windowTruncated') }}
          </span>
        </div>
        <EchartsUI
          ref="chartRef"
          :aria-label="vricChartLabel"
          class="mt__chart w-full"
          height="320px"
          role="img"
        />
      </template>

      <!-- 工程口径说明（默认折叠，VRIC 与聚合桶术语不干扰主视觉） -->
      <details class="an-methodology" data-gs="analytics-methodology">
        <summary>{{ $t('gainosUi2.analytics.methodologyTitle') }}</summary>
        <ul class="an-methodology__list">
          <li>{{ $t('gainosUi2.analytics.methodologyVric') }}</li>
          <li>{{ $t('gainosUi2.analytics.methodologyGap') }}</li>
          <li>{{ $t('gainosUi2.analytics.methodologyRollup') }}</li>
        </ul>
      </details>
    </section>

    <!-- 指标明细与口径（单层 1px 细线容器 + AntDV Tabs + GsSelect） -->
    <section
      :aria-label="$t('gainosUi2.analytics.tablesTitle')"
      class="an-surface"
      data-gs="analytics-tables"
    >
      <div class="an-surface__head">
        <h2 class="an-surface__title">{{ $t('gainosUi2.analytics.tablesTitle') }}</h2>
      </div>

      <Tabs :active-key="activeTable" class="an-tabs" @change="onTableTabChange">
        <!-- 指标口径 -->
        <TabPane key="catalog" :tab="$t('gainosUi2.analytics.tabCatalog')">
          <div class="an-filters">
            <div class="w-[220px] @max-[640px]:w-full">
              <Input
                v-model:value="catalogSearch"
                :aria-label="$t('gainosUi2.analytics.searchPlaceholder')"
                :placeholder="$t('gainosUi2.analytics.searchPlaceholder')"
                allow-clear
                size="small"
                type="search"
              >
                <template #prefix><Search :size="13" /></template>
              </Input>
            </div>
            <div class="w-[140px]" data-gs="analytics-catalog-tier">
              <GsSelect
                v-model="catalogTier"
                :aria-label="$t('gainos.metrics.colTier')"
                :ariaLabel="$t('gainos.metrics.colTier')"
                :options="catalogTierOptions"
                class="w-full"
                size="small"
              />
            </div>
            <div class="w-[140px]" data-gs="analytics-catalog-status">
              <GsSelect
                v-model="catalogStatus"
                :aria-label="$t('gainos.metrics.colStatus')"
                :ariaLabel="$t('gainos.metrics.colStatus')"
                :options="catalogStatusOptions"
                class="w-full"
                size="small"
              />
            </div>
          </div>

          <Skeleton v-if="catalogLoading" active :paragraph="{ rows: 3 }" />
          <div v-else-if="catalogError" class="grid gap-3">
            <ErrorNotice :next="catalogError.next" :title="catalogError.title" />
            <Button class="justify-self-start" size="small" @click="loadCatalog">
              {{ $t('gainos.common.retry') }}
            </Button>
          </div>
          <GsEmpty
            v-else-if="catalogRows.length === 0"
            :description="$t('gainosUi2.analytics.catalogEmptyDesc')"
            :title="$t('gainosUi2.analytics.catalogEmptyTitle')"
            simple
          />
          <div v-else class="an-tablewrap">
            <table class="an-table">
              <thead>
                <tr>
                  <th scope="col">{{ $t('gainos.metrics.colMetric') }}</th>
                  <th scope="col">{{ $t('gainos.metrics.colName') }}</th>
                  <th scope="col">{{ $t('gainos.metrics.colTier') }}</th>
                  <th scope="col">{{ $t('gainos.metrics.colUnit') }}</th>
                  <th scope="col">{{ $t('gainos.metrics.colStatus') }}</th>
                  <th scope="col">{{ $t('gainos.metrics.colOwner') }}</th>
                  <th scope="col">{{ $t('gainos.metrics.colEffective') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in catalogRows" :key="`${item.metricId}-${item.version}`">
                  <td class="an-mono">{{ item.metricId }}</td>
                  <td>{{ item.name }}</td>
                  <td>{{ tierLabel(item.tier) }}</td>
                  <td>{{ unitLabel(item.unit) }}</td>
                  <td>
                    <GsTag :tone="metricTone(item.status)">
                      {{ metricStatus(item.status)?.label ?? $t('gainos.common.unknownStatus') }}
                    </GsTag>
                  </td>
                  <td>{{ item.owner }}</td>
                  <td class="an-num">{{ formatDate(item.effectiveFrom) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </TabPane>

        <!-- 周期明细（观测） -->
        <TabPane key="observations" :tab="$t('gainosUi2.analytics.tabObservations')">
          <form class="an-filters" @submit.prevent="loadObservations(true)">
            <div class="w-[168px]" data-gs="analytics-obs-metric">
              <GsSelect
                v-model="observationFilters.metricId"
                :aria-label="$t('gainos.metrics.colMetric')"
                :ariaLabel="$t('gainos.metrics.colMetric')"
                :options="metricIdOptions"
                class="w-full"
                size="small"
              />
            </div>
            <div class="w-[144px]">
              <Input
                v-model:value="observationFilters.from"
                :aria-label="$t('gainos.metrics.from')"
                size="small"
                type="date"
              />
            </div>
            <div class="w-[144px]">
              <Input
                v-model:value="observationFilters.to"
                :aria-label="$t('gainos.metrics.to')"
                size="small"
                type="date"
              />
            </div>
            <Button :loading="observationLoading" html-type="submit" size="small" type="primary">
              {{ $t('gainos.metrics.apply') }}
            </Button>
            <Button size="small" @click="resetObservationFilters">
              {{ $t('gainos.metrics.reset') }}
            </Button>
          </form>

          <Skeleton v-if="observationLoading" active :paragraph="{ rows: 3 }" />
          <div v-else-if="observationError" class="grid gap-3">
            <ErrorNotice :next="observationError.next" :title="observationError.title" />
            <Button class="justify-self-start" size="small" @click="loadObservations(true)">
              {{ $t('gainos.common.retry') }}
            </Button>
          </div>
          <GsEmpty
            v-else-if="observations.length === 0"
            :description="$t('gainosUi2.analytics.rowsEmptyDesc')"
            :title="$t('gainosUi2.analytics.rowsEmptyTitle')"
            simple
          />
          <template v-else>
            <div class="an-tablewrap">
              <table class="an-table">
                <thead>
                  <tr>
                    <th scope="col">{{ $t('gainos.metrics.colMetric') }}</th>
                    <th scope="col">{{ $t('gainos.metrics.colWindow') }}</th>
                    <th scope="col">{{ $t('gainos.metrics.colValue') }}</th>
                    <th scope="col">{{ $t('gainos.metrics.colRatio') }}</th>
                    <th scope="col">{{ $t('gainos.metrics.colCi') }}</th>
                    <th scope="col">{{ $t('gainos.metrics.colSample') }}</th>
                    <th scope="col">{{ $t('gainos.metrics.colComputedAt') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in observations" :key="row.id">
                    <td class="an-mono">{{ row.metricId }}</td>
                    <td class="an-num">{{ formatDate(row.windowStart) }} – {{ formatDate(row.windowEnd) }}</td>
                    <td class="an-num">{{ num(row.value) }}</td>
                    <td class="an-num">{{ num(row.numerator) }} / {{ num(row.denominator) }}</td>
                    <td class="an-num">
                      {{ row.ciLow === null && row.ciHigh === null ? '—' : `${num(row.ciLow)} – ${num(row.ciHigh)}` }}
                    </td>
                    <td class="an-num">{{ num(row.sampleN) }}</td>
                    <td class="an-num">{{ formatDateTime(row.computedAt) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-if="observationNextCursor" class="mt-3 flex justify-center">
              <Button :loading="observationLoadingMore" size="small" @click="loadObservations(false)">
                {{ observationLoadingMore ? $t('gainos.common.loading') : $t('gainos.metrics.loadMore') }}
              </Button>
            </div>
          </template>
        </TabPane>

        <!-- 汇总报表（聚合） -->
        <TabPane key="rollups" :tab="$t('gainosUi2.analytics.tabRollups')">
          <form class="an-filters" @submit.prevent="loadRollups(true)">
            <div class="w-[116px]" data-gs="analytics-rollup-granularity">
              <GsSelect
                v-model="rollupGranularity"
                :aria-label="$t('gainosUi2.analytics.granularity')"
                :ariaLabel="$t('gainosUi2.analytics.granularity')"
                :options="granularityOptions"
                class="w-full"
                size="small"
              />
            </div>
            <div class="w-[168px]" data-gs="analytics-rollup-metric">
              <GsSelect
                v-model="rollupFilters.metricId"
                :aria-label="$t('gainos.metrics.colMetric')"
                :ariaLabel="$t('gainos.metrics.colMetric')"
                :options="metricIdOptions"
                class="w-full"
                size="small"
              />
            </div>
            <div class="w-[144px]">
              <Input
                v-model:value="rollupFilters.from"
                :aria-label="$t('gainos.metrics.from')"
                size="small"
                type="date"
              />
            </div>
            <div class="w-[144px]">
              <Input
                v-model:value="rollupFilters.to"
                :aria-label="$t('gainos.metrics.to')"
                size="small"
                type="date"
              />
            </div>
            <Button :loading="rollupLoading" html-type="submit" size="small" type="primary">
              {{ $t('gainos.metrics.apply') }}
            </Button>
            <Button size="small" @click="resetRollupFilters">
              {{ $t('gainos.metrics.reset') }}
            </Button>
          </form>

          <Skeleton v-if="rollupLoading" active :paragraph="{ rows: 3 }" />
          <div v-else-if="rollupError" class="grid gap-3">
            <ErrorNotice :next="rollupError.next" :title="rollupError.title" />
            <Button class="justify-self-start" size="small" @click="loadRollups(true)">
              {{ $t('gainos.common.retry') }}
            </Button>
          </div>
          <GsEmpty
            v-else-if="rollups.length === 0"
            :description="$t('gainosUi2.analytics.rowsEmptyDesc')"
            :title="$t('gainosUi2.analytics.rowsEmptyTitle')"
            simple
          />
          <template v-else>
            <div class="an-tablewrap">
              <table class="an-table">
                <thead>
                  <tr>
                    <th scope="col">{{ $t('gainosUi2.analytics.colPeriod') }}</th>
                    <th scope="col">{{ $t('gainos.metrics.colMetric') }}</th>
                    <th scope="col">{{ $t('gainosUi2.analytics.colSegment') }}</th>
                    <th scope="col">{{ $t('gainos.metrics.colValue') }}</th>
                    <th scope="col">{{ $t('gainos.metrics.colRatio') }}</th>
                    <th scope="col">{{ $t('gainos.metrics.colSample') }}</th>
                    <th scope="col">{{ $t('gainos.metrics.colRefreshedAt') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in rollups"
                    :key="`${row.bucket}-${row.metricId}-${row.metricVersion}-${row.stratumKey}`"
                  >
                    <td class="an-num">{{ row.bucket }}</td>
                    <td class="an-mono">{{ row.metricId }}</td>
                    <td>{{ stratumLabel(row.stratumKey) }}</td>
                    <td class="an-num">{{ num(row.value) }}</td>
                    <td class="an-num">{{ num(row.numerator) }} / {{ num(row.denominator) }}</td>
                    <td class="an-num">{{ num(row.sampleN) }}</td>
                    <td class="an-num">{{ formatDateTime(row.refreshedAt) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-if="rollupNextCursor" class="mt-3 flex justify-center">
              <Button :loading="rollupLoadingMore" size="small" @click="loadRollups(false)">
                {{ rollupLoadingMore ? $t('gainos.common.loading') : $t('gainos.metrics.loadMore') }}
              </Button>
            </div>
          </template>
        </TabPane>
      </Tabs>
    </section>
  </div>
</template>

<style scoped>
.an-surface {
  display: grid;
  gap: 14px;
  min-width: 0;
  padding: 18px 20px;
  border: 1px solid var(--gs-border);
  border-radius: 10px;
  background: var(--gs-surface);
}

.an-surface__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.an-surface__title {
  margin: 0;
  color: var(--gs-fg);
  font-size: 14.5px;
  font-weight: 600;
  line-height: 22px;
}

.an-surface__sub {
  margin: 2px 0 0;
  max-width: 720px;
  color: var(--gs-fg-muted);
  font-size: 12.5px;
  line-height: 19px;
}

.an-controls,
.an-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.an-filters {
  margin-bottom: 12px;
}

.an-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 16px;
  padding: 10px 14px;
  border: 1px solid var(--gs-divider);
  border-radius: 8px;
  background: var(--gs-surface-3);
  font-size: 12.5px;
}

.an-summary__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.an-summary__label {
  color: var(--gs-fg-muted);
}

.an-summary__val {
  color: var(--gs-fg);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.an-summary__sep {
  width: 1px;
  height: 14px;
  background: var(--gs-border);
}

.an-dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  flex: none;
}

.an-dot--brand {
  background: var(--gs-accent);
}

.an-dot--success {
  background: var(--gs-success);
}

.an-methodology {
  padding-top: 10px;
  border-top: 1px solid var(--gs-divider);
  color: var(--gs-fg-muted);
  font-size: 12px;
}

.an-methodology summary {
  cursor: pointer;
  font-weight: 500;
}

.an-methodology__list {
  display: grid;
  gap: 4px;
  margin: 8px 0 0;
  padding-left: 18px;
  line-height: 1.65;
}

.an-tabs :deep(.ant-tabs-nav) {
  margin-bottom: 14px;
}

.an-tablewrap {
  width: 100%;
  overflow-x: auto;
  border: 1px solid var(--gs-border);
  border-radius: 8px;
}

.an-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.an-table th,
.an-table td {
  padding: 9px 12px;
  border-bottom: 1px solid var(--gs-divider);
  text-align: left;
  vertical-align: middle;
}

.an-table thead tr {
  background: var(--gs-table-head);
}

.an-table thead th {
  color: var(--gs-fg-muted);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}

.an-table tbody tr:last-child td {
  border-bottom: 0;
}

.an-mono {
  font-family: var(--gs-font-mono);
  font-size: 12px;
}

.an-num {
  font-variant-numeric: tabular-nums;
}
</style>
