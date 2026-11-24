<script lang="ts" setup>
/**
 * 目标客户画像卡（找买家列表）。与买家线索卡同一套语言：
 * 五列对齐（画像 / 目标市场 / 寻源方案 / 最近寻源 / 操作），无边框白卡 + 柔和投影。
 *
 * 「寻源方案」「最近寻源」直接摆在卡片上：这一页的目的是发起寻源，
 * 之前要点开弹层才知道某个画像有没有方案、跑没跑过。
 */
import type { IcpCardRow, SummaryState } from './icp-card-types';

import { computed } from 'vue';

import { Button, Tag } from 'ant-design-vue';

import GsCard from '#/components/gainos/ui/gs-card.vue';
import GsTag from '#/components/gainos/ui/gs-tag.vue';
import { $t } from '#/locales';

defineOptions({ name: 'IcpCard' });

const props = defineProps<{ row: IcpCardRow }>();

const emit = defineEmits<{ open: [] }>();

/** 首字母色块：3 个语义色按画像名散列（不用红，避免读成告警）。 */
const LOGO_TONES = ['brand', 'success', 'warning'] as const;
const tileTone = computed(() => {
  let hash = 0;
  for (const char of props.row.name) hash = (hash * 31 + char.codePointAt(0)!) % 997;
  return LOGO_TONES[hash % LOGO_TONES.length]!;
});
const initial = computed(() => Array.from(props.row.name || '?')[0]?.toUpperCase() ?? '?');

/** 摘要列的兜底文案：没取到显示「—」，确实没有才显示「还没有」。 */
function fallbackText(state: SummaryState, noneKey: string): string {
  if (state === 'loading') return $t('gainos.common.loading');
  if (state === 'none') return $t(noneKey);
  return '—';
}
const planFallback = computed(() => fallbackText(props.row.planState, 'gainos.findBuyers.noPlans'));
const runFallback = computed(() => fallbackText(props.row.runState, 'gainos.findBuyers.noRuns'));
</script>

<template>
  <GsCard class="icp-card" data-gs="icp-card" padding="18px 24px">
    <div class="icp-card__grid">
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
          <p class="icp-card__meta">
            {{ row.company }} · {{ $t('gainos.findBuyers.version', { version: row.version }) }}
          </p>
          <div class="icp-card__tags">
            <GsTag :tone="row.statusTone">{{ row.statusLabel }}</GsTag>
            <Tag :bordered="false" class="icp-chip">
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
          <Tag v-for="market in row.markets" :key="market" :bordered="false" class="icp-chip">
            {{ market }}
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
        <p v-else class="icp-card__meta">{{ planFallback }}</p>
      </div>

      <!-- 最近寻源 -->
      <div class="icp-card__cell icp-card__cell--run">
        <p class="icp-label">{{ $t('gainos.findBuyers.latestRun') }}</p>
        <div v-if="row.run" class="icp-card__summary">
          <GsTag :tone="row.run.tone">{{ row.run.label }}</GsTag>
          <span class="icp-card__meta">{{ row.run.startedAt }}</span>
        </div>
        <p v-else class="icp-card__meta">{{ runFallback }}</p>
      </div>

      <!-- 操作 -->
      <div class="icp-card__actions">
        <Button type="primary" @click="emit('open')">{{ $t('gainos.findBuyers.view') }}</Button>
      </div>
    </div>
  </GsCard>
</template>

<style scoped>
.icp-card__grid {
  display: grid;
  grid-template-areas: 'identity markets plan run actions';
  grid-template-columns: minmax(360px, 1.4fr) minmax(140px, 0.8fr) minmax(170px, 0.9fr) minmax(200px, 1fr) auto;
  gap: 12px 24px;
  align-items: start;
}
.icp-card__identity {
  grid-area: identity;
  display: flex;
  min-width: 0;
  gap: 14px;
  align-items: flex-start;
}
.icp-card__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  line-height: 24px;
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
  font-size: 12.5px;
  line-height: 20px;
}
.icp-card__tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}
.icp-card__tags--tight {
  margin-top: 4px;
}
.icp-tile {
  display: grid;
  flex: none;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 12px;
  font-size: 18px;
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
  padding-inline: 8px;
  border-radius: 6px;
  background: var(--gs-surface-2);
  color: var(--gs-fg-muted);
  font-size: 12px;
  line-height: 22px;
}

.icp-card__cell {
  min-width: 0;
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
  font-size: 12px;
  line-height: 18px;
}
.icp-card__summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 26px;
  margin-top: 4px;
}
.icp-card__summary .icp-card__meta {
  margin-top: 0;
  white-space: nowrap;
}

.icp-card__actions {
  grid-area: actions;
  align-self: center;
}

/* ── 中屏：两列。五列最少需要约 1070px 内容宽度（侧栏 224 + 页边距 64 + 卡片内边距 48），
   所以视口窄于 1408px 就换成两行，避免溢出。 ────────────────────────────── */
@media (max-width: 1407px) {
  .icp-card__grid {
    grid-template-areas:
      'identity actions'
      'markets plan'
      'run run';
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .icp-card__actions {
    justify-self: end;
  }
  .icp-card__cell {
    padding-top: 10px;
    border-top: 1px solid var(--gs-divider);
  }
}
@media (max-width: 719px) {
  .icp-card__grid {
    grid-template-areas:
      'identity'
      'markets'
      'plan'
      'run'
      'actions';
    grid-template-columns: minmax(0, 1fr);
  }
  .icp-card__actions {
    justify-self: stretch;
  }
  .icp-card__actions :deep(.ant-btn) {
    width: 100%;
  }
}
</style>
