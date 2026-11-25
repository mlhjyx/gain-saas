<script lang="ts" setup>
/**
 * 五维判据明细（2026-11-23）：列表展开区与详情页共用。
 * 每行 = 状态图标 + 维度名 + 结论 + 0–10 分 + 模型给出的理由。
 */
import type { JudgeDim } from './judge';

import { computed } from 'vue';

import GsStatusIcon from '#/components/gainos/ui/gs-status-icon.vue';

import { dimName, dimStatus, humanizeRationale } from './judge-labels';

defineOptions({ name: 'JudgeDimensions' });

const props = withDefaults(
  defineProps<{ compact?: boolean; dims: JudgeDim[]; showBars?: boolean }>(),
  { compact: false, showBars: true },
);

function widthOf(score: null | number): string {
  if (typeof score !== 'number' || !Number.isFinite(score)) return '0%';
  return `${Math.min(100, Math.max(0, score * 10))}%`;
}

const rows = computed(() =>
  props.dims.map((dim) => ({
    dim,
    hasScore: typeof dim.score === 'number' && Number.isFinite(dim.score),
    name: dimName(dim.id),
    status: dimStatus(dim),
    why: dim.rationale ? humanizeRationale(dim.rationale) : '',
    width: widthOf(dim.score),
  })),
);
</script>

<template>
  <ul class="jdim" :class="{ 'jdim--compact': compact }">
    <li v-for="row in rows" :key="row.dim.id" class="jdim__row">
      <div class="jdim__head">
        <GsStatusIcon :label="row.dim.label" :tone="row.status.tone" />
        <span class="jdim__name">{{ row.name }}</span>
        <span class="jdim__state" :class="`is-${row.status.tone}`">
          {{ row.status.label }}
        </span>
        <span
          v-if="showBars"
          class="jdim__bar"
          :aria-label="row.name"
          :aria-valuemax="10"
          :aria-valuemin="0"
          :aria-valuenow="row.dim.score ?? undefined"
          :role="row.hasScore ? 'progressbar' : undefined"
        >
          <span
            class="jdim__fill"
            :class="`is-${row.status.tone}`"
            :style="{ width: row.width }"
          />
        </span>
        <span class="jdim__score">
          {{
            row.hasScore
              ? $t('gainos.leads.dimScore', { score: row.dim.score })
              : $t('gainos.leads.dimScoreNone')
          }}
        </span>
      </div>
      <p v-if="row.why" class="jdim__why">{{ row.why }}</p>
    </li>
  </ul>
</template>

<style scoped>
.jdim {
  display: grid;
  gap: 14px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.jdim--compact {
  gap: 10px;
}
.jdim__row {
  display: grid;
  gap: 6px;
}
.jdim__row + .jdim__row {
  padding-top: 12px;
  border-top: 1px solid var(--gs-divider);
}
.jdim__head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.jdim__name {
  color: var(--gs-fg);
  font-size: 13px;
  font-weight: 500;
}
.jdim--compact .jdim__name {
  font-size: 12.5px;
  font-weight: 400;
}
.jdim__state {
  font-size: 12px;
  font-weight: 500;
}
.jdim__state.is-success {
  color: var(--gs-success-fg);
}
.jdim__state.is-warning {
  color: var(--gs-warn-fg);
}
.jdim__state.is-danger {
  color: var(--gs-danger-fg);
}
.jdim__state.is-info {
  color: var(--gs-accent-fg);
}
.jdim__state.is-neutral {
  color: var(--gs-fg-muted);
}
.jdim__score {
  margin-left: auto;
  min-width: 44px;
  text-align: right;
  color: var(--gs-fg-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.jdim__bar {
  display: block;
  flex: 0 0 120px;
  height: 4px;
  margin-left: 10px;
  border-radius: 9999px;
  background: var(--gs-surface-2);
  overflow: hidden;
}
.jdim__fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--gs-border-strong);
}
.jdim__fill.is-success {
  background: var(--gs-success);
}
.jdim__fill.is-warning {
  background: var(--gs-warn);
}
.jdim__fill.is-danger {
  background: var(--gs-danger);
}
.jdim__fill.is-info {
  background: var(--gs-accent-cta);
}
.jdim__why {
  max-width: 900px;
  margin: 0;
  color: var(--gs-fg-muted);
  font-size: 12.5px;
  line-height: 1.7;
}
.jdim--compact .jdim__row + .jdim__row {
  padding-top: 0;
  border-top: 0;
}
.jdim--compact .jdim__why {
  font-size: 12px;
  line-height: 1.65;
}
</style>
