<script lang="ts" setup>
/**
 * 判定维度雷达图（2026-11-23）。
 *
 * 纯 SVG、无第三方图表依赖：五维（或任意 3–8 维）0–10 分画在同心多边形上，
 * 颜色全部走 --gs-* 令牌，明暗主题自动适配。证据不足（score=null）的维度
 * 以 0 分绘制并画空心点，图下给出说明，避免把「没查到」误读成「查到了 0」。
 */
import { computed } from 'vue';

defineOptions({ name: 'GsRadar' });

interface RadarDim {
  id: string;
  label?: string;
  name: string;
  score: number | null;
}

const props = withDefaults(
  defineProps<{ ariaLabel: string; dims: RadarDim[]; max?: number }>(),
  { max: 10 },
);

const W = 360;
const H = 300;
const CX = 180;
const CY = 154;
const R = 96;
const RINGS = [0.2, 0.4, 0.6, 0.8, 1];

const angles = computed(() =>
  props.dims.map(
    (_, index) => -Math.PI / 2 + (index * 2 * Math.PI) / props.dims.length,
  ),
);

function polar(angle: number, radius: number): { x: number; y: number } {
  return { x: CX + radius * Math.cos(angle), y: CY + radius * Math.sin(angle) };
}

function ratio(score: number | null): number {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 0;
  return Math.min(1, Math.max(0, score / props.max));
}

const rings = computed(() =>
  RINGS.map((ring) =>
    angles.value
      .map((angle) => {
        const point = polar(angle, R * ring);
        return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
      })
      .join(' '),
  ),
);

const axes = computed(() => angles.value.map((angle) => polar(angle, R)));

const vertices = computed(() =>
  props.dims.map((dim, index) => {
    const point = polar(angles.value[index]!, R * ratio(dim.score));
    return {
      dim,
      hollow: typeof dim.score !== 'number' || !Number.isFinite(dim.score),
      ...point,
    };
  }),
);

const areaPoints = computed(() =>
  vertices.value.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '),
);

const labels = computed(() =>
  props.dims.map((dim, index) => {
    const angle = angles.value[index]!;
    const point = polar(angle, R + 26);
    const cos = Math.cos(angle);
    const anchor = cos > 0.3 ? 'start' : cos < -0.3 ? 'end' : 'middle';
    return {
      anchor,
      name: dim.name,
      score:
        typeof dim.score === 'number' && Number.isFinite(dim.score)
          ? `${Math.round(dim.score * 10) / 10}`
          : '—',
      x: point.x,
      y: point.y,
    };
  }),
);

const hasUnknown = computed(() =>
  props.dims.some(
    (dim) => typeof dim.score !== 'number' || !Number.isFinite(dim.score),
  ),
);
</script>

<template>
  <figure class="gs-radar" role="img" :aria-label="ariaLabel">
    <svg aria-hidden="true" :viewBox="`0 0 ${W} ${H}`">
      <polygon
        v-for="(ring, index) in rings"
        :key="`ring-${index}`"
        class="gs-radar__ring"
        :class="{ 'gs-radar__ring--outer': index === rings.length - 1 }"
        :points="ring"
      />
      <line
        v-for="(axis, index) in axes"
        :key="`axis-${index}`"
        class="gs-radar__axis"
        :x1="CX"
        :x2="axis.x"
        :y1="CY"
        :y2="axis.y"
      />
      <polygon class="gs-radar__area" :points="areaPoints" />
      <circle
        v-for="vertex in vertices"
        :key="`vertex-${vertex.dim.id}`"
        class="gs-radar__dot"
        :class="{ 'gs-radar__dot--hollow': vertex.hollow }"
        :cx="vertex.x"
        :cy="vertex.y"
        r="3.2"
      />
      <g v-for="(label, index) in labels" :key="`label-${props.dims[index]!.id}`">
        <text
          class="gs-radar__name"
          :text-anchor="label.anchor"
          :x="label.x"
          :y="label.y"
        >
          {{ label.name }}
        </text>
        <text
          class="gs-radar__score"
          :text-anchor="label.anchor"
          :x="label.x"
          :y="label.y + 15"
        >
          {{ label.score }}
        </text>
      </g>
    </svg>
    <figcaption v-if="hasUnknown" class="gs-radar__note">
      {{ $t('gainos.leads.radarUnknown') }}
    </figcaption>
  </figure>
</template>

<style scoped>
.gs-radar {
  margin: 0;
  min-width: 0;
}
.gs-radar svg {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}
.gs-radar__ring {
  fill: none;
  stroke: var(--gs-fg-subtle);
  stroke-opacity: 0.22;
  stroke-width: 1;
}
.gs-radar__ring--outer {
  stroke-opacity: 0.4;
}
.gs-radar__axis {
  stroke: var(--gs-fg-subtle);
  stroke-opacity: 0.18;
  stroke-width: 1;
}
.gs-radar__area {
  fill: var(--gs-accent-soft);
  stroke: var(--gs-accent-cta);
  stroke-linejoin: round;
  stroke-width: 1.5;
}
.gs-radar__dot {
  fill: var(--gs-accent-cta);
  stroke: var(--gs-surface);
  stroke-width: 1;
}
.gs-radar__dot--hollow {
  fill: var(--gs-surface);
  stroke: var(--gs-accent-cta);
  stroke-width: 1.5;
}
.gs-radar__name {
  fill: var(--gs-fg-muted);
  font-size: 11px;
}
.gs-radar__score {
  fill: var(--gs-fg);
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.gs-radar__note {
  margin: 2px 0 0;
  color: var(--gs-fg-subtle);
  font-size: 11px;
  text-align: center;
}
</style>
