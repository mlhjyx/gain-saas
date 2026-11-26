<script lang="ts" setup>
/**
 * 买家画像卡（PR-UI2：支持左侧 240px 窄栏模式与单画像轻量摘要行模式）。
 * - 严格遵守「全屏唯一 1 个蓝色主按钮」：卡片内操作降级为清晰的描边次按钮；
 * - 修复空版本号穿帮：仅当 version 为有效正数时才拼接「· 第 N 版」。
 */
import type { IcpCardRow, SummaryState } from './icp-card-types';

import { computed } from 'vue';

import { Button, Tag } from 'ant-design-vue';

import GsTag from '#/components/gainos/ui/gs-tag.vue';
import { ICP_ADVANCED_HIDDEN } from '#/feature-flags';
import { $t } from '#/locales';
import { regionName } from '#/utils/region-name';

defineOptions({ name: 'IcpCard' });

const props = withDefaults(
  defineProps<{
    rail?: boolean;
    row: IcpCardRow;
    selected?: boolean;
  }>(),
  { rail: false, selected: false },
);

const emit = defineEmits<{ open: [] }>();

const LOGO_TONES = ['brand', 'success', 'warning'] as const;
const tileTone = computed(() => {
  let hash = 0;
  for (const char of props.row.name) hash = (hash * 31 + char.codePointAt(0)!) % 997;
  return LOGO_TONES[hash % LOGO_TONES.length]!;
});
const initial = computed(() => Array.from(props.row.name || '?')[0]?.toUpperCase() ?? '?');

const validVersion = computed<null | number>(() => {
  const raw = props.row.version;
  if (raw === null || raw === undefined) return null;
  const num = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(num) && num > 0 ? Math.trunc(num) : null;
});

const companyVersionMeta = computed(() => {
  if (validVersion.value !== null) {
    return `${props.row.company} · ${$t('gainos.findBuyers.version', { version: validVersion.value })}`;
  }
  return props.row.company;
});

function fallbackText(state: SummaryState, noneKey: string): string {
  if (state === 'loading') return $t('gainos.common.loading');
  if (state === 'none') return $t(noneKey);
  return '—';
}
const planFallback = computed(() => fallbackText(props.row.planState, 'gainos.findBuyers.noPlans'));
const runFallback = computed(() => fallbackText(props.row.runState, 'gainos.findBuyers.noRuns'));

const inactiveText = computed(() => {
  const status = props.row.icp.status;
  if (status === 'ACTIVE') return '';
  return ['DRAFT', 'HYPOTHESIS', 'VALIDATING'].includes(status)
    ? $t('gainos.findBuyers.planNeedsActive')
    : '—';
});
const planText = computed(() => inactiveText.value || planFallback.value);
const runText = computed(() => inactiveText.value || runFallback.value);
</script>

<template>
  <!-- 多份画像时的左侧 240px 紧凑窄栏项 -->
  <div
    v-if="rail"
    :class="{ 'icp-card--selected': selected }"
    class="icp-rail-item"
    data-gs="icp-card"
    @click="emit('open')"
  >
    <div class="icp-rail-item__top">
      <button class="icp-rail-item__name" type="button" @click.stop="emit('open')">
        {{ row.name }}
      </button>
      <GsTag :tone="row.statusTone">{{ row.statusLabel }}</GsTag>
    </div>
    <p class="icp-rail-item__meta">{{ companyVersionMeta }}</p>
    <div v-if="row.markets.length > 0" class="icp-card__tags icp-card__tags--tight">
      <Tag
        v-for="market in row.markets.slice(0, 3)"
        :key="market"
        :bordered="false"
        class="icp-chip"
        :title="market"
      >
        {{ regionName(market) }}
      </Tag>
    </div>
    <div class="icp-rail-item__foot">
      <span class="icp-rail-item__stat">
        {{ $t('gainos.findBuyers.personasCount', { count: row.personas }) }}
      </span>
      <span v-if="row.plan" class="icp-rail-item__stat">
        {{ row.plan.label }} · {{ $t('gainos.findBuyers.planSearchCount', { count: row.plan.queries }) }}
      </span>
      <span v-else class="icp-rail-item__stat">{{ planText }}</span>
    </div>
  </div>

  <!-- 单份画像时的轻量单行细线概览条（非蓝色主按钮） -->
  <div
    v-else
    :class="{ 'icp-card--selected': selected }"
    class="icp-strip"
    data-gs="icp-card"
  >
    <div class="icp-strip__grid">
      <!-- 画像 -->
      <div class="icp-card__identity">
        <span aria-hidden="true" class="icp-tile" :class="`icp-tile--${tileTone}`">
          {{ initial }}
        </span>
        <div class="min-w-0">
          <h3 class="icp-card__title">
            <button class="icp-card__link" type="button" @click="emit('open')">
              {{ row.name }}
            </button>
          </h3>
          <p class="icp-card__meta">{{ companyVersionMeta }}</p>
          <div class="icp-card__tags">
            <GsTag :tone="row.statusTone">{{ row.statusLabel }}</GsTag>
            <Tag v-if="!ICP_ADVANCED_HIDDEN" :bordered="false" class="icp-chip">
              {{ $t('gainos.findBuyers.rulesCount', { count: row.rules }) }}
            </Tag>
            <Tag :bordered="false" class="icp-chip">
              {{ $t('gainos.findBuyers.personasCount', { count: row.personas }) }}
            </Tag>
          </div>
        </div>
      </div>

      <!-- 目标市场 -->
      <div class="icp-card__cell icp-card__cell--markets">
        <p class="icp-label">{{ $t('gainos.findBuyers.targetMarkets') }}</p>
        <div v-if="row.markets.length > 0" class="icp-card__tags icp-card__tags--tight">
          <Tag
            v-for="market in row.markets"
            :key="market"
            :bordered="false"
            class="icp-chip"
            :title="market"
          >
            {{ regionName(market) }}
          </Tag>
        </div>
        <p v-else class="icp-card__meta">—</p>
      </div>

      <!-- 寻源方案 -->
      <div class="icp-card__cell icp-card__cell--plan">
        <p class="icp-label">{{ $t('gainos.findBuyers.plansTitle') }}</p>
        <div v-if="row.plan" class="icp-card__summary">
          <GsTag :tone="row.plan.tone">{{ row.plan.label }}</GsTag>
          <span class="icp-card__meta">
            {{ $t('gainos.findBuyers.planSearchCount', { count: row.plan.queries }) }}
          </span>
        </div>
        <p v-else class="icp-card__meta">{{ planText }}</p>
      </div>

      <!-- 最近寻源 -->
      <div class="icp-card__cell icp-card__cell--run">
        <p class="icp-label">{{ $t('gainos.findBuyers.latestRun') }}</p>
        <div v-if="row.run" class="icp-card__summary">
          <GsTag :tone="row.run.tone">{{ row.run.label }}</GsTag>
          <span class="icp-card__meta">{{ row.run.startedAt }}</span>
        </div>
        <p v-else class="icp-card__meta">{{ runText }}</p>
      </div>

      <!-- 操作：降级为清晰描边次按钮，不与主 CTA 抢焦点 -->
      <div class="icp-card__actions">
        <Button size="small" @click="emit('open')">{{ $t('gainos.findBuyers.view') }}</Button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 左侧 240px 窄栏模式 */
.icp-rail-item {
  display: grid;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--gs-border);
  border-radius: 10px;
  background: var(--gs-surface);
  cursor: pointer;
  transition:
    border-color 0.14s ease,
    background-color 0.14s ease;
}

.icp-rail-item:hover {
  border-color: var(--gs-border-strong);
  background: var(--gs-surface-3);
}

.icp-rail-item.icp-card--selected {
  border-color: var(--gs-accent);
  background: var(--gs-accent-soft);
}

.icp-rail-item__top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.icp-rail-item__name {
  min-width: 0;
  padding: 0;
  border: 0;
  background: none;
  color: var(--gs-fg);
  font: inherit;
  font-size: 13.5px;
  font-weight: 600;
  line-height: 19px;
  text-align: left;
  cursor: pointer;
  overflow-wrap: anywhere;
}

.icp-rail-item__meta {
  margin: 0;
  color: var(--gs-fg-muted);
  font-size: 12px;
  line-height: 17px;
  overflow-wrap: anywhere;
}

.icp-rail-item__foot {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  padding-top: 6px;
  border-top: 1px solid var(--gs-divider);
}

.icp-rail-item__stat {
  color: var(--gs-fg-muted);
  font-size: 11.5px;
  line-height: 16px;
}

/* 单画像轻量单行细线概览条 */
.icp-strip {
  padding: 14px 18px;
  border: 1px solid var(--gs-border);
  border-radius: 10px;
  background: var(--gs-surface);
}

.icp-strip.icp-card--selected {
  border-color: var(--gs-border-strong);
}

.icp-strip__grid {
  display: grid;
  grid-template-areas:
    'identity'
    'markets'
    'plan'
    'run'
    'actions';
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}

.icp-card__identity {
  grid-area: identity;
  display: flex;
  min-width: 0;
  gap: 12px;
  align-items: flex-start;
}

.icp-card__title {
  margin: 0;
  font-size: 14.5px;
  font-weight: 600;
  line-height: 22px;
}

.icp-card__link {
  display: inline;
  max-width: 100%;
  padding: 0;
  border: 0;
  background: none;
  color: var(--gs-fg);
  font: inherit;
  text-align: left;
  cursor: pointer;
  overflow-wrap: anywhere;
}

.icp-card__link:hover {
  color: var(--gs-accent-fg);
}

.icp-card__link:focus-visible {
  outline: 2px solid var(--gs-accent);
  outline-offset: 2px;
  border-radius: 4px;
}

.icp-card__meta {
  margin: 2px 0 0;
  color: var(--gs-fg-muted);
  font-size: 12px;
  line-height: 18px;
}

.icp-card__tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}

.icp-card__tags--tight {
  margin-top: 2px;
}

.icp-tile {
  display: grid;
  flex: none;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 8px;
  font-size: 16px;
  font-weight: 600;
  line-height: 1;
}

.icp-tile--brand {
  background: var(--gs-accent-soft);
  color: var(--gs-accent-fg);
}

.icp-tile--success {
  background: var(--gs-success-bg);
  color: var(--gs-success-fg);
}

.icp-tile--warning {
  background: var(--gs-warn-bg);
  color: var(--gs-warn-fg);
}

.icp-chip {
  margin: 0;
  padding-inline: 7px;
  border-radius: 5px;
  background: var(--gs-surface-2);
  color: var(--gs-fg-muted);
  font-size: 11.5px;
  line-height: 20px;
}

.icp-card__cell {
  min-width: 0;
  padding-top: 10px;
  border-top: 1px solid var(--gs-divider);
}

.icp-card__cell--markets {
  grid-area: markets;
}

.icp-card__cell--plan {
  grid-area: plan;
}

.icp-card__cell--run {
  grid-area: run;
}

.icp-label {
  margin: 0;
  color: var(--gs-fg-muted);
  font-size: 11.5px;
  line-height: 16px;
}

.icp-card__summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
  margin-top: 4px;
}

.icp-card__summary .icp-card__meta {
  margin-top: 0;
  white-space: nowrap;
}

.icp-card__actions {
  grid-area: actions;
  display: grid;
}

@container (min-width: 560px) {
  .icp-strip__grid {
    grid-template-areas:
      'identity actions'
      'markets plan'
      'run run';
    grid-template-columns: minmax(0, 1fr) auto;
    column-gap: 16px;
  }
  .icp-card__actions {
    display: block;
    justify-self: end;
  }
}

@container (min-width: 1020px) {
  .icp-strip__grid {
    grid-template-areas: 'identity markets plan run actions';
    grid-template-columns: minmax(280px, 1.4fr) minmax(120px, 0.8fr) minmax(150px, 0.9fr) minmax(160px, 1fr) auto;
    column-gap: 20px;
    align-items: center;
  }
  .icp-card__cell {
    padding-top: 0;
    border-top: 0;
  }
}
</style>
