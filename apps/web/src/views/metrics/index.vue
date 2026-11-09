<script lang="ts" setup>
/**
 * 度量（引擎 ch01 PR-04）：VRIC 成对趋势 + 指标目录 / 观测 / 聚合三类只读表。
 *
 * VRIC 口径（T0-001 STRICT 与 T0-002 PLUS）由引擎成对返回：同一桶某侧缺数据时
 * 该侧为 null，折线在缺数据处断开——界面不用 0 冒充缺失。图表复用 vben 的
 * EchartsUI 封装，颜色取 --gs-* 令牌（深色模式切换时重取并重绘）。
 */
import type { MetricCatalogItem, MetricObservation, MetricRollup, VricBucket } from '#/api/gainos';

import { computed, nextTick, onMounted, ref, watch } from 'vue';

import { formatDate, formatDateTime, glossaryStatus, statusClass } from '@gain-saas/shared';
import { EchartsUI, useEcharts } from '@vben/plugins/echarts';
import { preferences, usePreferences } from '@vben/preferences';

import { $t } from '#/locales';

import { failureText, gainosApi } from '#/api/gainos';

defineOptions({ name: 'GainMetrics' });

// 内嵌在「商机与触达」枢纽时不渲染自己的页头容器。
defineProps<{ embedded?: boolean }>();

type ErrorCopy = { title: string; why?: string; next?: string };
type ChartOption = Parameters<ReturnType<typeof useEcharts>['renderEcharts']>[0];

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function num(value: null | number | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function metricStatus(value: string | undefined | null) {
  return glossaryStatus('metricStatus', value ?? undefined, preferences.app.locale);
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

/**
 * stratum_key 是引擎按 JSONB 规范化的文本（如 {"channel":"email_only","workspace_id":"…"}）。
 * 界面只展示业务维度，绝不把 workspace/icp 等标识原样带上屏（零术语红线）。
 */
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

// ── VRIC 趋势 ───────────────────────────────────────────────────────────────
const granularity = ref<'daily' | 'weekly'>('daily');
const vricBuckets = ref<VricBucket[]>([]);
const vricHasMore = ref(false);
const vricLoading = ref(true);
const vricError = ref<ErrorCopy | null>(null);
const stratum = ref('');

const strata = computed(() => [...new Set(vricBuckets.value.map((bucket) => bucket.stratumKey))].sort());

/** 通道拆分行（stratum 带 channel）是附加项；默认展示不含通道的总行。 */
function isChannelStratum(key: string): boolean {
  try {
    const value = JSON.parse(key) as unknown;
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && 'channel' in (value as Record<string, unknown>);
  } catch {
    return false;
  }
}

function pickDefaultStratum(list: string[]): string {
  return list.find((key) => !isChannelStratum(key)) ?? list[0] ?? '';
}

const chartBuckets = computed(() =>
  vricBuckets.value
    .filter((bucket) => bucket.stratumKey === stratum.value)
    .slice()
    .sort((left, right) => left.bucket.localeCompare(right.bucket)),
);
const latestBucket = computed(() => chartBuckets.value[chartBuckets.value.length - 1] ?? null);
const strictLabel = computed(() => $t('gainos.metrics.strict'));
const plusLabel = computed(() => $t('gainos.metrics.plus'));

function seriesValues(side: 'plus' | 'strict'): Array<null | number> {
  return chartBuckets.value.map((bucket) => bucket[side]?.value ?? null);
}

const chartRef = ref();
const { renderEcharts } = useEcharts(chartRef);
const { isDark } = usePreferences();

function buildChartOption(): ChartOption {
  const axisColor = cssVar('--gs-fg-subtle', '#6b7280');
  const gridColor = cssVar('--gs-divider', '#f3f4f6');
  const strictColor = cssVar('--gs-accent-strong', '#007a47');
  const plusColor = cssVar('--gs-indigo', '#4f46e5');
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

/**
 * 图表容器在 vricLoading=false 且数据非空时才挂载；useEcharts 的 renderEcharts
 * 在容器不可见时按 30ms 重试，所以这里必须 fire-and-forget——await 它会把
 * loading 锁死（等待一个只有 loading 结束才会出现的容器）。
 */
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
// chartBuckets 依赖数据与分层选择：任一变化都重绘（loading 结束后的下一帧容器才存在）。
watch([chartBuckets], () => {
  renderChart();
});
watch(isDark, () => {
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
    : $t('gainos.metrics.chartAria');
});

// ── 指标目录 ────────────────────────────────────────────────────────────────
const catalog = ref<MetricCatalogItem[]>([]);
const catalogLoading = ref(true);
const catalogError = ref<ErrorCopy | null>(null);
const catalogSearch = ref('');
const catalogStatus = ref('');
const catalogTier = ref('');

const catalogTiers = computed(() => [...new Set(catalog.value.map((item) => item.tier))].sort());
/** 同一指标可能有多个版本：筛选项按 metricId 去重。 */
const catalogMetricIds = computed(() => [...new Set(catalog.value.map((item) => item.metricId))]);
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

// ── 观测与聚合（分页只读表）─────────────────────────────────────────────────
const TABLE_TABS = ['catalog', 'observations', 'rollups'] as const;
type TableTab = (typeof TABLE_TABS)[number];
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
const observationNextCursor = ref<string | null>(null);
const observationLoaded = ref(false);

const rollups = ref<MetricRollup[]>([]);
const rollupLoading = ref(false);
const rollupLoadingMore = ref(false);
const rollupError = ref<ErrorCopy | null>(null);
const rollupNextCursor = ref<string | null>(null);
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

watch(activeTable, (tab) => {
  if (tab === 'observations' && !observationLoaded.value) void loadObservations(true);
  if (tab === 'rollups' && !rollupLoaded.value) void loadRollups(true);
});
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

onMounted(() => {
  void loadCatalog();
  void loadVric();
});
</script>

<template>
  <div class="mt" :class="{ 'is-embedded': embedded }">
    <header class="mt__head">
      <div>
        <h2>{{ $t('gainos.metrics.title') }}</h2>
        <p class="mt__sub">{{ $t('gainos.metrics.subtitle') }}</p>
      </div>
      <button class="mt__ghost" type="button" :disabled="vricLoading" @click="loadVric">
        {{ $t('gainos.common.refresh') }}
      </button>
    </header>

    <section class="mt__card" :aria-label="$t('gainos.metrics.vricTitle')">
      <header class="mt__card-head">
        <div>
          <h3>{{ $t('gainos.metrics.vricTitle') }}</h3>
          <p class="mt__hint">{{ $t('gainos.metrics.vricSub') }}</p>
        </div>
        <div class="mt__controls">
          <label class="mt__field">
            <span>{{ $t('gainos.metrics.granularity') }}</span>
            <select v-model="granularity">
              <option value="daily">{{ $t('gainos.metrics.daily') }}</option>
              <option value="weekly">{{ $t('gainos.metrics.weekly') }}</option>
            </select>
          </label>
          <label v-if="strata.length > 1" class="mt__field">
            <span>{{ $t('gainos.metrics.stratum') }}</span>
            <select v-model="stratum">
              <option v-for="key in strata" :key="key" :value="key">{{ stratumLabel(key) }}</option>
            </select>
          </label>
        </div>
      </header>

      <p v-if="vricLoading" class="mt__muted">{{ $t('gainos.common.loading') }}</p>
      <div v-else-if="vricError" class="mt__error" role="alert">
        <strong>{{ vricError.title }}</strong>
        <p v-if="vricError.next">{{ vricError.next }}</p>
        <button class="mt__ghost mt__ghost--sm" type="button" @click="loadVric">
          {{ $t('gainos.common.retry') }}
        </button>
      </div>
      <div v-else-if="chartBuckets.length === 0" class="mt__empty">
        <p class="mt__empty-title">{{ $t('gainos.metrics.vricEmpty') }}</p>
        <p class="mt__muted">{{ $t('gainos.metrics.vricEmptyHint') }}</p>
      </div>
      <template v-else>
        <p class="mt__summary">
          <span>{{ $t('gainos.metrics.latestBucket') }}：{{ latestBucket?.bucket }}</span>
          <span class="gs-badge gs-badge--success">
            {{ strictLabel }} {{ num(latestBucket?.strict?.value) }}
          </span>
          <span class="gs-badge gs-badge--processing">
            {{ plusLabel }} {{ num(latestBucket?.plus?.value) }}
          </span>
          <span v-if="vricHasMore" class="mt__muted">{{ $t('gainos.metrics.windowTruncated') }}</span>
        </p>
        <EchartsUI
          ref="chartRef"
          :aria-label="vricChartLabel"
          class="mt__chart"
          height="340px"
          role="img"
        />
        <p class="mt__hint">{{ $t('gainos.metrics.vricGapNote') }}</p>
      </template>
    </section>

    <section class="mt__card" :aria-label="$t('gainos.metrics.tablesTitle')">
      <nav class="mt__tabs" role="tablist" :aria-label="$t('gainos.metrics.tablesTitle')">
        <button
          v-for="tab in TABLE_TABS"
          :key="tab"
          :aria-selected="activeTable === tab"
          :class="{ 'is-active': activeTable === tab }"
          class="mt__tab"
          role="tab"
          type="button"
          @click="activeTable = tab"
        >
          {{
            tab === 'catalog'
              ? $t('gainos.metrics.tabCatalog')
              : tab === 'observations'
                ? $t('gainos.metrics.tabObservations')
                : $t('gainos.metrics.tabRollups')
          }}
        </button>
      </nav>

      <!-- 指标目录 -->
      <div v-if="activeTable === 'catalog'" role="tabpanel">
        <div class="mt__controls mt__controls--filters">
          <label class="mt__field">
            <span>{{ $t('gainos.metrics.catalogSearch') }}</span>
            <input v-model="catalogSearch" :placeholder="$t('gainos.metrics.catalogSearchPlaceholder')" type="search" />
          </label>
          <label class="mt__field">
            <span>{{ $t('gainos.metrics.colTier') }}</span>
            <select v-model="catalogTier">
              <option value="">{{ $t('gainos.metrics.all') }}</option>
              <option v-for="tier in catalogTiers" :key="tier" :value="tier">{{ tierLabel(tier) }}</option>
            </select>
          </label>
          <label class="mt__field">
            <span>{{ $t('gainos.metrics.colStatus') }}</span>
            <select v-model="catalogStatus">
              <option value="">{{ $t('gainos.metrics.all') }}</option>
              <option value="ACTIVE">{{ metricStatus('ACTIVE')?.label ?? 'ACTIVE' }}</option>
              <option value="DRAFT">{{ metricStatus('DRAFT')?.label ?? 'DRAFT' }}</option>
              <option value="DEPRECATED">{{ metricStatus('DEPRECATED')?.label ?? 'DEPRECATED' }}</option>
              <option value="RETIRED">{{ metricStatus('RETIRED')?.label ?? 'RETIRED' }}</option>
            </select>
          </label>
        </div>

        <p v-if="catalogLoading" class="mt__muted">{{ $t('gainos.common.loading') }}</p>
        <div v-else-if="catalogError" class="mt__error" role="alert">
          <strong>{{ catalogError.title }}</strong>
          <p v-if="catalogError.next">{{ catalogError.next }}</p>
          <button class="mt__ghost mt__ghost--sm" type="button" @click="loadCatalog">
            {{ $t('gainos.common.retry') }}
          </button>
        </div>
        <div v-else-if="catalogRows.length === 0" class="mt__empty">
          <p class="mt__empty-title">{{ $t('gainos.metrics.catalogEmpty') }}</p>
          <p class="mt__muted">{{ $t('gainos.metrics.catalogEmptyHint') }}</p>
        </div>
        <div v-else class="mt__tablewrap">
          <table class="mt__table">
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
                <td class="mt__mono">{{ item.metricId }}</td>
                <td>{{ item.name }}</td>
                <td>{{ tierLabel(item.tier) }}</td>
                <td>{{ unitLabel(item.unit) }}</td>
                <td>
                  <span class="gs-badge" :class="statusClass(metricStatus(item.status)?.tone ?? 'neutral')">
                    {{ metricStatus(item.status)?.label ?? item.status }}
                  </span>
                </td>
                <td>{{ item.owner }}</td>
                <td>{{ formatDate(item.effectiveFrom) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 观测 -->
      <div v-else-if="activeTable === 'observations'" role="tabpanel">
        <form class="mt__controls mt__controls--filters" @submit.prevent="loadObservations(true)">
          <label class="mt__field">
            <span>{{ $t('gainos.metrics.colMetric') }}</span>
            <select v-model="observationFilters.metricId">
              <option value="">{{ $t('gainos.metrics.metricAll') }}</option>
              <option v-for="metricId in catalogMetricIds" :key="metricId" :value="metricId">
                {{ metricId }}
              </option>
            </select>
          </label>
          <label class="mt__field">
            <span>{{ $t('gainos.metrics.from') }}</span>
            <input v-model="observationFilters.from" type="date" />
          </label>
          <label class="mt__field">
            <span>{{ $t('gainos.metrics.to') }}</span>
            <input v-model="observationFilters.to" type="date" />
          </label>
          <div class="mt__actions">
            <button class="mt__primary" type="submit" :disabled="observationLoading">
              {{ $t('gainos.metrics.apply') }}
            </button>
            <button class="mt__ghost" type="button" @click="resetObservationFilters">
              {{ $t('gainos.metrics.reset') }}
            </button>
          </div>
        </form>

        <p v-if="observationLoading" class="mt__muted">{{ $t('gainos.common.loading') }}</p>
        <div v-else-if="observationError" class="mt__error" role="alert">
          <strong>{{ observationError.title }}</strong>
          <p v-if="observationError.next">{{ observationError.next }}</p>
          <button class="mt__ghost mt__ghost--sm" type="button" @click="loadObservations(true)">
            {{ $t('gainos.common.retry') }}
          </button>
        </div>
        <div v-else-if="observations.length === 0" class="mt__empty">
          <p class="mt__empty-title">{{ $t('gainos.metrics.rowsEmpty') }}</p>
          <p class="mt__muted">{{ $t('gainos.metrics.rowsEmptyHint') }}</p>
        </div>
        <template v-else>
          <div class="mt__tablewrap">
            <table class="mt__table">
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
                  <td class="mt__mono">{{ row.metricId }}</td>
                  <td>{{ formatDate(row.windowStart) }} – {{ formatDate(row.windowEnd) }}</td>
                  <td>{{ num(row.value) }}</td>
                  <td>{{ num(row.numerator) }} / {{ num(row.denominator) }}</td>
                  <td>
                    {{ row.ciLow === null && row.ciHigh === null ? '—' : `${num(row.ciLow)} – ${num(row.ciHigh)}` }}
                  </td>
                  <td>{{ num(row.sampleN) }}</td>
                  <td>{{ formatDateTime(row.computedAt) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <button
            v-if="observationNextCursor"
            class="mt__ghost mt__loadmore"
            type="button"
            :disabled="observationLoadingMore"
            @click="loadObservations(false)"
          >
            {{ observationLoadingMore ? $t('gainos.common.loading') : $t('gainos.metrics.loadMore') }}
          </button>
        </template>
      </div>

      <!-- 聚合 -->
      <div v-else role="tabpanel">
        <form class="mt__controls mt__controls--filters" @submit.prevent="loadRollups(true)">
          <label class="mt__field">
            <span>{{ $t('gainos.metrics.granularity') }}</span>
            <select v-model="rollupGranularity">
              <option value="daily">{{ $t('gainos.metrics.daily') }}</option>
              <option value="weekly">{{ $t('gainos.metrics.weekly') }}</option>
            </select>
          </label>
          <label class="mt__field">
            <span>{{ $t('gainos.metrics.colMetric') }}</span>
            <select v-model="rollupFilters.metricId">
              <option value="">{{ $t('gainos.metrics.metricAll') }}</option>
              <option v-for="metricId in catalogMetricIds" :key="metricId" :value="metricId">
                {{ metricId }}
              </option>
            </select>
          </label>
          <label class="mt__field">
            <span>{{ $t('gainos.metrics.from') }}</span>
            <input v-model="rollupFilters.from" type="date" />
          </label>
          <label class="mt__field">
            <span>{{ $t('gainos.metrics.to') }}</span>
            <input v-model="rollupFilters.to" type="date" />
          </label>
          <div class="mt__actions">
            <button class="mt__primary" type="submit" :disabled="rollupLoading">
              {{ $t('gainos.metrics.apply') }}
            </button>
            <button class="mt__ghost" type="button" @click="resetRollupFilters">
              {{ $t('gainos.metrics.reset') }}
            </button>
          </div>
        </form>

        <p v-if="rollupLoading" class="mt__muted">{{ $t('gainos.common.loading') }}</p>
        <div v-else-if="rollupError" class="mt__error" role="alert">
          <strong>{{ rollupError.title }}</strong>
          <p v-if="rollupError.next">{{ rollupError.next }}</p>
          <button class="mt__ghost mt__ghost--sm" type="button" @click="loadRollups(true)">
            {{ $t('gainos.common.retry') }}
          </button>
        </div>
        <div v-else-if="rollups.length === 0" class="mt__empty">
          <p class="mt__empty-title">{{ $t('gainos.metrics.rowsEmpty') }}</p>
          <p class="mt__muted">{{ $t('gainos.metrics.rowsEmptyHint') }}</p>
        </div>
        <template v-else>
          <div class="mt__tablewrap">
            <table class="mt__table">
              <thead>
                <tr>
                  <th scope="col">{{ $t('gainos.metrics.colBucket') }}</th>
                  <th scope="col">{{ $t('gainos.metrics.colMetric') }}</th>
                  <th scope="col">{{ $t('gainos.metrics.colStratum') }}</th>
                  <th scope="col">{{ $t('gainos.metrics.colValue') }}</th>
                  <th scope="col">{{ $t('gainos.metrics.colRatio') }}</th>
                  <th scope="col">{{ $t('gainos.metrics.colSample') }}</th>
                  <th scope="col">{{ $t('gainos.metrics.colRefreshedAt') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in rollups" :key="`${row.bucket}-${row.metricId}-${row.stratumKey}`">
                  <td>{{ row.bucket }}</td>
                  <td class="mt__mono">{{ row.metricId }}</td>
                  <td>{{ stratumLabel(row.stratumKey) }}</td>
                  <td>{{ num(row.value) }}</td>
                  <td>{{ num(row.numerator) }} / {{ num(row.denominator) }}</td>
                  <td>{{ num(row.sampleN) }}</td>
                  <td>{{ formatDateTime(row.refreshedAt) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <button
            v-if="rollupNextCursor"
            class="mt__ghost mt__loadmore"
            type="button"
            :disabled="rollupLoadingMore"
            @click="loadRollups(false)"
          >
            {{ rollupLoadingMore ? $t('gainos.common.loading') : $t('gainos.metrics.loadMore') }}
          </button>
        </template>
      </div>
    </section>
  </div>
</template>

<style scoped>
.mt {
  width: 100%;
  max-width: 1280px;
  margin: 0 auto;
  padding: clamp(18px, 2.4vw, 32px) clamp(18px, 2.4vw, 34px) clamp(32px, 4vh, 48px);
  box-sizing: border-box;
  display: grid;
  gap: 16px;
}
.mt.is-embedded { padding: 0; max-width: none; margin: 0; }
.mt__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.mt__head h2 { margin: 0 0 4px; font-size: 22px; }
.mt__sub { margin: 0; color: var(--gs-fg-muted); font-size: 13px; line-height: 1.6; max-width: 720px; }
.mt__card { border: 1px solid var(--gs-border-strong); border-radius: 16px; background: var(--gs-surface); padding: 18px 20px; display: grid; gap: 12px; min-width: 0; }
.mt__card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.mt__card-head h3 { margin: 0 0 4px; font-size: 17px; }
.mt__hint { margin: 0; font-size: 12.5px; line-height: 1.6; color: var(--gs-fg-subtle); }
.mt__controls { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; }
.mt__controls--filters { margin-bottom: 12px; }
.mt__field { display: grid; gap: 4px; font-size: 12.5px; color: var(--gs-fg-2); }
.mt__field select, .mt__field input { padding: 7px 10px; border: 1px solid var(--gs-border-strong); border-radius: 8px; background: var(--gs-surface); color: var(--gs-fg); font: inherit; min-width: 140px; }
.mt__actions { display: flex; gap: 8px; }
.mt__ghost, .mt__primary { padding: 8px 14px; border-radius: 8px; border: 1px solid transparent; cursor: pointer; font: inherit; }
.mt__ghost { background: var(--gs-surface); border-color: var(--gs-border-strong); color: var(--gs-fg-2); }
.mt__ghost--sm { padding: 6px 10px; font-size: 12.5px; }
.mt__primary { background: var(--gs-accent-cta); color: var(--gs-accent-cta-fg); }
.mt__ghost:disabled, .mt__primary:disabled { opacity: 0.5; cursor: not-allowed; }
.mt__muted { margin: 0; color: var(--gs-fg-subtle); font-size: 13px; }
.mt__summary { margin: 0; display: flex; gap: 12px; flex-wrap: wrap; align-items: center; font-size: 13px; color: var(--gs-fg-2); }
.mt__chart { width: 100%; }
.mt__error { border: 1px solid var(--gs-danger-border); background: var(--gs-danger-bg); border-radius: 12px; padding: 12px 14px; display: grid; gap: 6px; color: var(--gs-danger); font-size: 13px; }
.mt__error p { margin: 0; }
.mt__error button { justify-self: start; }
.mt__empty { border: 1px dashed var(--gs-border-dashed); border-radius: 16px; background: var(--gs-surface-3); padding: 32px 20px; text-align: center; display: grid; gap: 6px; }
.mt__empty-title { margin: 0; font-weight: 600; color: var(--gs-fg-2); }
.mt__tabs { display: inline-flex; gap: 4px; padding: 4px; background: var(--gs-surface-2); border-radius: 12px; width: fit-content; }
.mt__tab { border: none; background: transparent; color: var(--gs-fg-2); font-size: 13px; font-weight: 600; padding: 7px 14px; border-radius: 9px; cursor: pointer; }
.mt__tab.is-active { background: var(--gs-surface); color: var(--gs-fg); box-shadow: var(--gs-shadow-card); }
.mt__tablewrap { overflow-x: auto; border: 1px solid var(--gs-border); border-radius: 12px; }
.mt__table { width: 100%; border-collapse: collapse; font-size: 13px; }
.mt__table th, .mt__table td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--gs-divider); vertical-align: top; }
.mt__table thead th { font-size: 12px; font-weight: 600; color: var(--gs-fg-subtle); }
.mt__table tbody tr:last-child td { border-bottom: none; }
.mt__mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
.mt__loadmore { justify-self: center; margin-top: 10px; }
@media (max-width: 720px) {
  .mt__field select, .mt__field input { min-width: 0; width: 100%; }
  .mt__field { flex: 1 1 140px; }
}
</style>
