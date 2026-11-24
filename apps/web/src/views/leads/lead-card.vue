<script lang="ts" setup>
/**
 * 买家线索卡（参考商业名录卡片：公司 / 评分 / 判断结果 / 判定维度 / 操作）。
 *
 * 卡片自己解析引擎的聚合文本（C1–C5），只把业务语言放上屏；聚合原文与
 * 机器码收进「技术详情」折叠区。页面只负责数据、队列与动作，不持有卡片样式。
 *
 * 宽屏五列并排；≤1511px 时判定维度折成一行横排放到卡片底部；手机单列。
 */
import type { MenuProps } from 'ant-design-vue';
import type { Lead } from '#/api/gainos';

import { computed } from 'vue';

import { Ellipsis } from '@vben/icons';

import { Button, Dropdown, Menu, Tag } from 'ant-design-vue';

import GsCard from '#/components/gainos/ui/gs-card.vue';
import GsStatusIcon from '#/components/gainos/ui/gs-status-icon.vue';
import GsTag from '#/components/gainos/ui/gs-tag.vue';
import { $t } from '#/locales';

import JudgeDimensions from './judge-dimensions.vue';
import {
  isMachineAggregate,
  judgeCounts,
  keyDimension,
  parseJudge,
  scoreGrade,
  shortRationale,
} from './judge';
import {
  dimName,
  dimStatus,
  humanizeRationale,
  verdictLabel,
  verdictTone,
} from './judge-labels';

defineOptions({ name: 'LeadCard' });

const props = defineProps<{
  basisLabel?: string;
  /** 当前队列/状态是否允许裁决（与列表页 canAct 同口径）。 */
  canAct: boolean;
  expanded: boolean;
  lead: Lead;
}>();

const emit = defineEmits<{
  accept: [];
  copy: [];
  package: [];
  promote: [];
  reject: [];
  toggle: [];
}>();

const judge = computed(() => parseJudge(props.lead.fitReasons));
const dims = computed(() => judge.value.dims);

/** 机器结论：列表字段优先，缺省时回退到聚合文本里的 verdict。 */
const verdict = computed(() => props.lead.fitVerdict ?? judge.value.verdict);

function reasonsOf(): string[] {
  const raw = props.lead.fitReasons;
  if (Array.isArray(raw)) return raw.map((item) => String(item)).filter(Boolean);
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    for (const field of ['reasons', 'matched', 'notes']) {
      const value = record[field];
      if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
    }
    const text = record.summary ?? record.reason;
    if (typeof text === 'string' && text.trim()) return [text];
  }
  return [];
}

/** 判断原因：优先引用决定性维度的人话理由，绝不把机器聚合原文直接上屏。 */
const humanReasons = computed(() =>
  reasonsOf().filter((item) => !isMachineAggregate(item)),
);
const reason = computed(() => {
  const dim = keyDimension(dims.value);
  if (dim) {
    const text = shortRationale(humanizeRationale(dim.rationale));
    return text ? `${dimName(dim.id)}：${text}` : dimName(dim.id);
  }
  if (humanReasons.value.length > 0) return humanReasons.value.slice(0, 2).join(' · ');
  return $t('gainos.leads.reasonNone');
});

/** 「1 项符合 · 3 项不符 · 1 项证据不足」——只列非零项。 */
const summary = computed(() => {
  const counts = judgeCounts(dims.value);
  return [
    counts.pass ? $t('gainos.leads.criteriaPass', { count: counts.pass }) : '',
    counts.weak ? $t('gainos.leads.criteriaWeak', { count: counts.weak }) : '',
    counts.fail ? $t('gainos.leads.criteriaFail', { count: counts.fail }) : '',
    counts.unclear
      ? $t('gainos.leads.criteriaUnclear', { count: counts.unclear })
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
});

const score = computed<null | number>(() => {
  const total = props.lead.totalScore;
  return typeof total === 'number' && Number.isFinite(total) ? Math.round(total) : null;
});
const grade = computed(() => scoreGrade(score.value));

/** 没有 logo 数据时用首字母牌位：3 个语义色按公司名散列（不用红，避免读成告警）。 */
const LOGO_TONES = ['brand', 'success', 'warning'] as const;
const logoTone = computed(() => {
  const name = props.lead.company?.name ?? props.lead.id;
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) % 997;
  return LOGO_TONES[hash % LOGO_TONES.length]!;
});
const initial = computed(
  () => Array.from(props.lead.company?.name ?? '?')[0]?.toUpperCase() ?? '?',
);
const meta = computed(() =>
  [props.lead.company?.country, props.lead.company?.domain].filter(Boolean).join(' · '),
);
const tags = computed(() =>
  [
    props.lead.company?.industry ?? '',
    props.lead.company?.employeeCount ? `${props.lead.company.employeeCount} 人` : '',
  ].filter(Boolean),
);

/**
 * 没有 C1–C5 聚合文本时的降级：用引擎八维评分的前五项画小条。
 * （新线索通常有聚合文本；历史线索可能只有 scores，不能让这一列空着。）
 */
const SCORE_FALLBACK_DIMS = ['fit', 'role', 'intent', 'demand_proof', 'reachability'] as const;
const scoreRows = computed(() => {
  const scores = props.lead.scores;
  if (!scores || typeof scores !== 'object') return [];
  const record = scores as Record<string, unknown>;
  return SCORE_FALLBACK_DIMS.map((dim) => ({ dim, value: record[dim] }))
    .filter(
      (row): row is { dim: (typeof SCORE_FALLBACK_DIMS)[number]; value: number } =>
        typeof row.value === 'number' && Number.isFinite(row.value),
    )
    .map((row) => ({
      id: row.dim,
      name: $t(`gainos.leads.dim.${row.dim}`),
      value: Math.round(Math.min(1, Math.max(0, row.value)) * 100),
    }));
});
const dimsLabel = computed(() =>
  dims.value.length > 0
    ? $t('gainos.leads.criteriaTitle')
    : $t('gainos.leads.scoresTitle'),
);

type MenuItem = NonNullable<MenuProps['items']>[number];
type MenuClickInfo = Parameters<NonNullable<MenuProps['onClick']>>[0];

/** 「⋯」里的次要动作：打开档案包、复制官网（主动作已在卡片上，这里不重复）。 */
const menuItems = computed<MenuItem[]>(() => {
  const items: MenuItem[] = [{ key: 'package', label: $t('gainos.leads.viewPackage') }];
  if (props.lead.company?.domain) {
    items.push({ key: 'copy', label: $t('gainos.leads.copyDomain') });
  }
  return items;
});

function onMenu(info: MenuClickInfo): void {
  const key = String(info.key);
  if (key === 'package') emit('package');
  if (key === 'copy') emit('copy');
}
</script>

<template>
  <GsCard class="lead-card" data-gs="lead-card">
    <div class="lead-card__grid">
      <!-- 公司 -->
      <div class="lead-card__identity">
        <span aria-hidden="true" class="lead-logo" :class="`lead-logo--${logoTone}`">
          {{ initial }}
        </span>
        <div class="min-w-0">
          <h2 class="lead-card__title">
            <RouterLink :to="{ name: 'LeadDetail', params: { leadId: lead.id } }">
              {{ lead.company?.name || $t('gainos.leads.unknownCompany') }}
            </RouterLink>
          </h2>
          <p v-if="meta" class="lead-card__meta">
            <svg
              aria-hidden="true"
              class="lead-card__pin"
              fill="none"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="1.5"
              viewBox="0 0 16 16"
            >
              <path d="M8 14s4.5-4.2 4.5-7.5a4.5 4.5 0 1 0-9 0C3.5 9.8 8 14 8 14z" />
              <circle cx="8" cy="6.5" r="1.6" />
            </svg>
            <span>{{ meta }}</span>
          </p>
          <div v-if="tags.length > 0" class="lead-card__tags">
            <Tag v-for="tag in tags" :key="tag" :bordered="false" class="lead-tag">
              {{ tag }}
            </Tag>
          </div>
        </div>
      </div>

      <!-- 评分 -->
      <div class="lead-score">
        <div class="lead-score__value">{{ score ?? '—' }}</div>
        <div class="lead-score__label">{{ $t('gainos.leads.scoreLabel') }}</div>
        <span class="lead-grade" :class="`lead-grade--${grade}`">
          {{ $t(`gainos.leads.scoreGrade.${grade}`) }}
        </span>
      </div>

      <!-- 判断结果 / 原因 -->
      <div class="lead-verdict">
        <p class="lead-block-label">{{ $t('gainos.leads.verdictTitle') }}</p>
        <div class="lead-verdict__row">
          <GsTag :tone="verdictTone(verdict)">{{ verdictLabel(verdict) }}</GsTag>
          <span v-if="basisLabel" class="lead-verdict__basis">{{ basisLabel }}</span>
        </div>
        <p class="lead-block-label lead-block-label--spaced">
          {{ $t('gainos.leads.reasonTitle') }}
        </p>
        <p class="lead-reason" :title="reason">{{ reason }}</p>
        <button
          v-if="dims.length > 0"
          :aria-controls="`lead-dims-${lead.id}`"
          :aria-expanded="expanded"
          class="lead-expand"
          type="button"
          @click="emit('toggle')"
        >
          {{ expanded ? $t('gainos.leads.collapse') : $t('gainos.leads.expand') }}
          <svg
            aria-hidden="true"
            class="lead-expand__chevron"
            fill="none"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.6"
            viewBox="0 0 16 16"
          >
            <path d="M3.5 6l4.5 4 4.5-4" />
          </svg>
        </button>
      </div>

      <!-- 判定维度（缺聚合文本时降级为八维评分前五项） -->
      <div class="lead-dims">
        <p class="lead-block-label">{{ dimsLabel }}</p>
        <ul v-if="dims.length > 0" class="lead-dims__list">
          <li v-for="dim in dims" :key="dim.id" class="lead-dims__row">
            <GsStatusIcon :label="dim.label" :tone="dimStatus(dim).tone" />
            <span class="lead-dims__name">{{ dimName(dim.id) }}</span>
            <span class="lead-dims__state" :class="`is-${dimStatus(dim).tone}`">
              {{ dimStatus(dim).label }}
            </span>
            <span class="lead-dims__score">{{ dim.score ?? '—' }}</span>
          </li>
        </ul>
        <ul v-else-if="scoreRows.length > 0" class="lead-dims__list">
          <li v-for="row in scoreRows" :key="row.id" class="lead-dims__row">
            <span class="lead-dims__name">{{ row.name }}</span>
            <span aria-hidden="true" class="lead-dims__bar">
              <span class="lead-dims__bar-fill" :style="{ width: `${row.value}%` }" />
            </span>
            <span class="lead-dims__score">{{ row.value }}</span>
          </li>
        </ul>
        <p v-else class="lead-card__meta m-0">{{ $t('gainos.leads.criteriaNone') }}</p>
      </div>

      <!-- 操作 -->
      <div class="lead-actions">
        <template v-if="canAct">
          <Button
            class="lead-actions__btn"
            data-gs="lead-accept"
            type="primary"
            @click="emit('accept')"
          >
            {{ $t('gainos.leads.cardAccept') }}
          </Button>
          <Button class="lead-actions__btn" data-gs="lead-reject" @click="emit('reject')">
            {{ $t('gainos.leads.cardReject') }}
          </Button>
        </template>
        <Button
          v-else-if="lead.status === 'QUALIFIED'"
          class="lead-actions__btn"
          type="primary"
          @click="emit('promote')"
        >
          {{ $t('gainos.leads.promoteQgo') }}
        </Button>
        <!-- antdv 的 Dropdown 没有 menu 属性（那是 React 版的 API）：菜单必须走 #overlay -->
        <Dropdown :trigger="['click']" placement="bottomRight">
          <Button :aria-label="$t('gainos.leads.moreActions')" class="lead-actions__more" type="text">
            <Ellipsis :size="18" />
          </Button>
          <template #overlay>
            <Menu :items="menuItems" @click="onMenu" />
          </template>
        </Dropdown>
      </div>
    </div>

    <!-- 展开：完整五维理由 + 技术详情（机器码只进折叠区） -->
    <div
      v-if="expanded"
      :id="`lead-dims-${lead.id}`"
      class="lead-detail"
      data-gs="lead-detail"
    >
      <p class="lead-block-label">{{ summary }}</p>
      <JudgeDimensions compact :dims="dims" :show-bars="false" />
      <details v-if="judge.raw" class="lead-tech">
        <summary>{{ $t('gainos.findBuyers.technicalDetails') }}</summary>
        <dl class="lead-tech__grid">
          <template v-if="judge.verdict">
            <dt>{{ $t('gainos.leads.techVerdict') }}</dt>
            <dd>{{ judge.verdict }}</dd>
          </template>
          <template v-if="judge.reasonCodes.length > 0">
            <dt>{{ $t('gainos.leads.techReasonCodes') }}</dt>
            <dd>{{ judge.reasonCodes.join(' · ') }}</dd>
          </template>
          <template v-if="judge.weightedNote">
            <dt>{{ $t('gainos.leads.techWeighted') }}</dt>
            <dd>{{ judge.weightedNote }}</dd>
          </template>
        </dl>
        <pre class="lead-tech__raw">{{ judge.raw }}</pre>
      </details>
    </div>
  </GsCard>
</template>

<style scoped>
/* ── 五列：公司 / 评分 / 判断结果 / 判定维度 / 操作 ─────────────────────── */
.lead-card__grid {
  display: grid;
  grid-template-areas: 'identity score verdict dims actions';
  grid-template-columns: minmax(240px, 1.2fr) 104px minmax(280px, 1.3fr) minmax(210px, 1fr) auto;
  gap: 12px 24px;
  align-items: start;
}
.lead-card__identity {
  grid-area: identity;
  display: flex;
  min-width: 0;
  gap: 14px;
  align-items: flex-start;
}
.lead-card__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  line-height: 24px;
}
.lead-card__title a {
  color: var(--gs-fg);
  text-decoration: none;
}
.lead-card__title a:hover {
  color: var(--gs-accent-fg);
}
.lead-card__meta {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 2px 0 0;
  color: var(--gs-fg-muted);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.lead-card__pin {
  flex: none;
  width: 12px;
  height: 12px;
  color: var(--gs-fg-subtle);
}
.lead-card__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.lead-logo {
  display: grid;
  flex: none;
  place-items: center;
  width: 56px;
  height: 56px;
  border-radius: 12px;
  font-size: 20px;
  font-weight: 600;
  line-height: 1;
}
.lead-logo--brand {
  background: var(--gs-accent-soft);
  color: var(--gs-accent-fg);
}
.lead-logo--success {
  background: var(--gs-success-bg);
  color: var(--gs-success-fg);
}
.lead-logo--warning {
  background: var(--gs-warn-bg);
  color: var(--gs-warn-fg);
}
.lead-tag {
  margin: 0;
  padding-inline: 8px;
  border-radius: 6px;
  background: var(--gs-surface-2);
  color: var(--gs-fg-muted);
  font-size: 12px;
  line-height: 22px;
}

.lead-score {
  grid-area: score;
  display: grid;
  justify-items: start;
  gap: 2px;
}
.lead-score__value {
  color: var(--gs-fg);
  font-size: 28px;
  font-weight: 600;
  line-height: 32px;
  font-variant-numeric: tabular-nums;
}
.lead-score__label {
  color: var(--gs-fg-muted);
  font-size: 12px;
  line-height: 18px;
}
.lead-grade {
  margin-top: 4px;
  padding: 0 8px;
  border-radius: 6px;
  font-size: 11.5px;
  line-height: 20px;
  font-weight: 500;
}
.lead-grade--high {
  background: var(--gs-success-bg);
  color: var(--gs-success-fg);
}
.lead-grade--medium {
  background: var(--gs-accent-soft);
  color: var(--gs-accent-fg);
}
.lead-grade--low {
  background: var(--gs-surface-2);
  color: var(--gs-fg-muted);
}
.lead-grade--none {
  background: var(--gs-surface-2);
  color: var(--gs-fg-subtle);
}

.lead-block-label {
  margin: 0;
  color: var(--gs-fg-muted);
  font-size: 12px;
  line-height: 18px;
}
.lead-block-label--spaced {
  margin-top: 10px;
}
.lead-verdict {
  grid-area: verdict;
  min-width: 0;
}
.lead-verdict__row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 26px;
  margin-top: 4px;
}
.lead-verdict__basis {
  color: var(--gs-fg-subtle);
  font-size: 12px;
}
.lead-reason {
  margin: 2px 0 0;
  overflow: hidden;
  color: var(--gs-fg-muted);
  font-size: 12.5px;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lead-expand {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-top: 2px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--gs-fg-muted);
  font: inherit;
  font-size: 12px;
  line-height: 20px;
  cursor: pointer;
}
.lead-expand:hover {
  color: var(--gs-accent-fg);
}
.lead-expand:focus-visible {
  outline: 2px solid var(--gs-accent);
  outline-offset: 2px;
  border-radius: 4px;
}
.lead-expand__chevron {
  width: 14px;
  height: 14px;
  transition: transform 0.15s ease;
}
.lead-expand[aria-expanded='true'] .lead-expand__chevron {
  transform: rotate(180deg);
}

.lead-dims {
  grid-area: dims;
  min-width: 0;
}
.lead-dims__list {
  display: grid;
  gap: 1px;
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}
.lead-dims__row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12.5px;
  line-height: 20px;
}
.lead-dims__name {
  color: var(--gs-fg);
  white-space: nowrap;
}
.lead-dims__state {
  font-size: 12px;
}
.lead-dims__state.is-success {
  color: var(--gs-success-fg);
}
.lead-dims__state.is-warning {
  color: var(--gs-warn-fg);
}
.lead-dims__state.is-danger {
  color: var(--gs-danger-fg);
}
.lead-dims__state.is-info {
  color: var(--gs-accent-fg);
}
.lead-dims__state.is-neutral {
  color: var(--gs-fg-subtle);
}
.lead-dims__score {
  min-width: 16px;
  color: var(--gs-fg-subtle);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.lead-dims__bar {
  display: block;
  flex: 1 1 40px;
  max-width: 96px;
  height: 4px;
  margin-left: auto;
  border-radius: 9999px;
  background: var(--gs-surface-2);
  overflow: hidden;
}
.lead-dims__bar-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--gs-accent-cta);
}
.lead-dims__bar + .lead-dims__score {
  margin-left: 8px;
}

.lead-actions {
  grid-area: actions;
  display: flex;
  align-items: center;
  gap: 8px;
  align-self: center;
}
.lead-actions__btn {
  min-width: 68px;
}
.lead-actions__more {
  flex: none;
  padding-inline: 8px;
}

.lead-detail {
  display: grid;
  gap: 14px;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--gs-divider);
}
.lead-tech {
  color: var(--gs-fg-subtle);
  font-size: 12px;
}
.lead-tech summary {
  cursor: pointer;
}
.lead-tech__grid {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 8px 0 0;
}
.lead-tech__grid dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.lead-tech__raw {
  max-height: 220px;
  overflow: auto;
  margin: 8px 0 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--gs-surface-2);
  color: var(--gs-fg-muted);
  font-size: 11.5px;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ── 中屏（内容区 < ~1200px）：四列 + 判定维度横排到底部，给判断原因留出整行 ── */
@media (max-width: 1511px) {
  .lead-card__grid {
    grid-template-areas:
      'identity score verdict actions'
      'dims dims dims dims';
    grid-template-columns: minmax(220px, 1.3fr) 104px minmax(200px, 1fr) auto;
  }
  .lead-actions {
    justify-self: end;
  }
  .lead-dims {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--gs-divider);
  }
  .lead-dims__list {
    display: flex;
    flex: 1 1 0;
    flex-wrap: wrap;
    gap: 2px 20px;
    margin-top: 0;
  }
  .lead-dims__row {
    flex: 0 1 auto;
  }
  .lead-dims__score {
    min-width: 18px;
    margin-left: 2px;
  }
  .lead-dims__bar {
    flex: 0 0 56px;
    max-width: none;
    margin-left: 0;
  }
}

/* ── 手机：单列 ──────────────────────────────────────────────────────── */
@media (max-width: 719px) {
  .lead-card__grid {
    grid-template-areas:
      'identity'
      'score'
      'verdict'
      'dims'
      'actions';
    grid-template-columns: minmax(0, 1fr);
  }
  .lead-reason {
    white-space: normal;
  }
  .lead-dims {
    display: block;
  }
  .lead-actions {
    justify-self: stretch;
  }
  .lead-actions__btn {
    flex: 1 1 0;
  }
}
</style>
