<script lang="ts" setup>
/**
 * 买家线索高密度紧凑表（PR-UI2：对标 Attio / Clay / Stripe）：
 * - 单行 52–56px，1440×900 首屏轻松呈现 8–10+ 家海外买家；
 * - 五维判据压炼为 5 颗紧凑色格 + Tooltip 悬停全览（绝不上屏机器码）；
 * - 状态改用 Vercel/Linear 式 6px 语义圆点 + 白话文案；
 * - 行尾操作平时克制无边框弱显，Hover / 键盘聚焦时清晰浮现；
 * - 点击任意行打开右侧 520px 快审抽屉，支持连续研判。
 */
import type { Lead } from '#/api/gainos';

import { computed } from 'vue';

import { Button, Checkbox, Tooltip } from 'ant-design-vue';

import { $t } from '#/locales';

import {
  JUDGE_DIM_ORDER,
  displayLeadScore,
  judgeCounts,
  leadScoreDimension,
  parseJudge,
  scoreGrade,
  shortRationale,
  type JudgeDim,
} from './judge';
import { dimName, dimStatus, humanizeRationale, type GsTone } from './judge-labels';

defineOptions({ name: 'LeadCompactTable' });

const props = defineProps<{
  activeLeadId?: null | string;
  allSelected: boolean;
  canAct: (lead: Lead) => boolean;
  leads: Lead[];
  selectedIds: Set<string>;
  someSelected: boolean;
}>();

const emit = defineEmits<{
  accept: [lead: Lead];
  package: [lead: Lead];
  preview: [lead: Lead];
  promote: [lead: Lead];
  reject: [lead: Lead];
  select: [leadId: string, checked: boolean];
  selectAll: [checked: boolean];
}>();

const LOGO_TONES = ['brand', 'success', 'warning'] as const;
const SCORE_FALLBACK_DIMS = ['fit', 'role', 'intent', 'demand_proof', 'reachability'] as const;

interface MicroCell {
  id: string;
  name: string;
  rationale: string;
  scoreText: string;
  statusLabel: string;
  tone: GsTone;
}

interface RowModel {
  canAct: boolean;
  companyMeta: string;
  companyName: string;
  dimsPassText: string;
  grade: ReturnType<typeof scoreGrade>;
  gradeLabel: string;
  hasDims: boolean;
  initial: string;
  isActive: boolean;
  isSelected: boolean;
  lead: Lead;
  logoTone: (typeof LOGO_TONES)[number];
  microCells: MicroCell[];
  score: null | number;
  statusDotTone: GsTone;
  statusLabel: string;
  verifiedEmailCount: number;
}

function logoToneOf(lead: Lead): (typeof LOGO_TONES)[number] {
  const name = lead.company?.name ?? lead.id;
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) % 997;
  return LOGO_TONES[hash % LOGO_TONES.length]!;
}

function leadStatusDisplay(lead: Lead): { label: string; tone: GsTone } {
  if (lead.queue === 'sanctions_hold') {
    return { label: $t('gainos.leads.queueSanctions'), tone: 'warning' };
  }
  const status = lead.status ?? 'DISCOVERED';
  const key = `gainos.leads.status.${status}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  const label = translated === key ? $t('gainos.leads.status.DISCOVERED') : translated;
  if (status === 'QUALIFIED') return { label, tone: 'success' };
  if (status === 'REVIEW') return { label, tone: 'warning' };
  if (status === 'QUALIFYING') return { label, tone: 'info' };
  if (status === 'REJECTED' || status === 'SUPPRESSED') return { label, tone: 'danger' };
  return { label, tone: 'neutral' };
}

function buildMicroCells(lead: Lead): {
  cells: MicroCell[];
  hasDims: boolean;
  passText: string;
} {
  const judge = parseJudge(lead.fitReasons);
  if (judge.dims.length > 0) {
    const dimMap = new Map<string, JudgeDim>(judge.dims.map((d) => [d.id, d]));
    const ordered: JudgeDim[] = [];
    for (const id of JUDGE_DIM_ORDER) {
      const hit = dimMap.get(id);
      if (hit) ordered.push(hit);
    }
    for (const dim of judge.dims) {
      if (!ordered.some((item) => item.id === dim.id)) ordered.push(dim);
    }
    const cells: MicroCell[] = ordered.slice(0, 5).map((dim) => {
      const st = dimStatus(dim);
      return {
        id: dim.id,
        name: dimName(dim.id),
        rationale: dim.rationale ? shortRationale(humanizeRationale(dim.rationale), 72) : '',
        scoreText: typeof dim.score === 'number' && Number.isFinite(dim.score) ? `${dim.score}/10` : '—',
        statusLabel: st.label,
        tone: st.tone,
      };
    });
    const counts = judgeCounts(judge.dims);
    return {
      cells,
      hasDims: true,
      passText: $t('gainosUi2.leads.dimsPassCount', {
        pass: counts.pass,
        total: judge.dims.length,
      }),
    };
  }

  // 降级：历史线索仅含八维评分，取前五项绘制微格
  const scores = lead.scores;
  if (scores && typeof scores === 'object') {
    const record = scores as Record<string, unknown>;
    const valid = SCORE_FALLBACK_DIMS.map((key) => ({ key, val: leadScoreDimension(record, key) })).filter(
      (item): item is { key: (typeof SCORE_FALLBACK_DIMS)[number]; val: number } =>
        typeof item.val === 'number' && Number.isFinite(item.val),
    );
    if (valid.length > 0) {
      const cells: MicroCell[] = valid.map((item) => {
        const pct = Math.round(Math.min(1, Math.max(0, item.val)) * 100);
        const tone: GsTone = pct >= 75 ? 'success' : pct >= 50 ? 'warning' : 'neutral';
        return {
          id: item.key,
          name: $t(`gainos.leads.dim.${item.key}`),
          rationale: '',
          scoreText: String(pct),
          statusLabel: `${pct}`,
          tone,
        };
      });
      return { cells, hasDims: false, passText: '' };
    }
  }

  return { cells: [], hasDims: false, passText: '' };
}

const rows = computed<RowModel[]>(() =>
  props.leads.map((lead) => {
    const score = displayLeadScore(lead.totalScore);
    const grade = scoreGrade(score);
    const status = leadStatusDisplay(lead);
    const { cells, hasDims, passText } = buildMicroCells(lead);
    const companyName = lead.company?.name || $t('gainos.leads.unknownCompany');
    const companyMeta = [lead.company?.domain, lead.company?.country, lead.company?.industry]
      .filter(Boolean)
      .join(' · ');
    return {
      canAct: props.canAct(lead),
      companyMeta,
      companyName,
      dimsPassText: passText,
      grade,
      gradeLabel: $t(`gainos.leads.scoreGrade.${grade}`),
      hasDims,
      initial: Array.from(companyName)[0]?.toUpperCase() ?? '?',
      isActive: props.activeLeadId === lead.id,
      isSelected: props.selectedIds.has(lead.id),
      lead,
      logoTone: logoToneOf(lead),
      microCells: cells,
      score,
      statusDotTone: status.tone,
      statusLabel: status.label,
      verifiedEmailCount: lead.channelSummary?.verifiedEmailCount ?? 0,
    };
  }),
);
</script>

<template>
  <div class="lt-wrap" data-gs="leads-table">
    <table class="lt-table">
      <thead>
        <tr>
          <th class="lt-col-check" scope="col">
            <Checkbox
              :aria-label="$t('gainosUi2.leads.selectAllAria')"
              :checked="allSelected"
              :indeterminate="someSelected"
              data-gs="leads-select-all"
              @change="
                (e: { target?: { checked?: boolean } }) =>
                  emit('selectAll', Boolean(e?.target?.checked))
              "
            />
          </th>
          <th class="lt-col-company" scope="col">{{ $t('gainosUi2.leads.colCompany') }}</th>
          <th class="lt-col-score" scope="col">{{ $t('gainosUi2.leads.colScore') }}</th>
          <th class="lt-col-dims" scope="col">{{ $t('gainosUi2.leads.colDimensions') }}</th>
          <th class="lt-col-status" scope="col">{{ $t('gainosUi2.leads.colStatus') }}</th>
          <th class="lt-col-actions" scope="col">{{ $t('gainosUi2.leads.colActions') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="row.lead.id"
          :class="{ 'is-active': row.isActive, 'is-selected': row.isSelected }"
          :data-lead-id="row.lead.id"
          class="lt-row"
          data-gs="lead-row"
          tabindex="0"
          @click="emit('preview', row.lead)"
          @keydown.enter.self="emit('preview', row.lead)"
        >
          <!-- 多选 -->
          <td class="lt-col-check" @click.stop>
            <Checkbox
              :aria-label="$t('gainosB4.leadsBulk.selectLeadAria', { name: row.companyName })"
              :checked="row.isSelected"
              data-gs="lead-select-checkbox"
              @change="
                (e: { target?: { checked?: boolean } }) =>
                  emit('select', row.lead.id, Boolean(e?.target?.checked))
              "
            />
          </td>

          <!-- 公司名 + 域名 + 国家/行业微字 -->
          <td class="lt-col-company">
            <div class="lt-company">
              <span aria-hidden="true" class="lt-avatar" :class="`lt-avatar--${row.logoTone}`">
                {{ row.initial }}
              </span>
              <div class="lt-company__text">
                <div class="lt-company__top">
                  <span class="lt-company__name" :title="row.companyName">
                    {{ row.companyName }}
                  </span>
                  <span
                    v-if="row.verifiedEmailCount > 0"
                    class="lt-verified"
                    :title="$t('gainosUi2.leads.verifiedEmailShort', { count: row.verifiedEmailCount })"
                  >
                    {{ $t('gainosUi2.leads.verifiedEmailShort', { count: row.verifiedEmailCount }) }}
                  </span>
                </div>
                <p v-if="row.companyMeta" class="lt-company__meta" :title="row.companyMeta">
                  {{ row.companyMeta }}
                </p>
              </div>
            </div>
          </td>

          <!-- 匹配分 -->
          <td class="lt-col-score">
            <div class="lt-score">
              <span class="lt-score__num">{{ row.score ?? '—' }}</span>
              <span class="lt-grade" :class="`lt-grade--${row.grade}`">
                {{ row.gradeLabel }}
              </span>
            </div>
          </td>

          <!-- 五维微格指示器 + Tooltip -->
          <td class="lt-col-dims">
            <Tooltip
              v-if="row.microCells.length > 0"
              :overlay-style="{ maxWidth: '340px' }"
              placement="top"
            >
              <template #title>
                <div class="lt-tip">
                  <p class="lt-tip__title">
                    {{
                      row.hasDims
                        ? $t('gainosUi2.leads.dimsTooltipTitle')
                        : $t('gainosUi2.leads.dimsTooltipFallback')
                    }}
                  </p>
                  <ul class="lt-tip__list">
                    <li v-for="cell in row.microCells" :key="cell.id" class="lt-tip__item">
                      <div class="lt-tip__row">
                        <span class="lt-tip__dot" :class="`is-${cell.tone}`" />
                        <span class="lt-tip__name">{{ cell.name }}</span>
                        <span class="lt-tip__state">{{ cell.statusLabel }}</span>
                        <span class="lt-tip__score">{{ cell.scoreText }}</span>
                      </div>
                      <p v-if="cell.rationale" class="lt-tip__why">{{ cell.rationale }}</p>
                    </li>
                  </ul>
                </div>
              </template>
              <div
                class="lt-micro"
                data-gs="lead-dims-micro"
                tabindex="0"
                @click.stop="emit('preview', row.lead)"
              >
                <span class="lt-micro__bars" aria-hidden="true">
                  <span
                    v-for="cell in row.microCells"
                    :key="cell.id"
                    class="lt-micro__cell"
                    :class="`is-${cell.tone}`"
                  />
                </span>
                <span v-if="row.dimsPassText" class="lt-micro__count">
                  {{ row.dimsPassText }}
                </span>
              </div>
            </Tooltip>
            <span v-else class="lt-empty-dash" data-gs="lead-dims-micro">—</span>
          </td>

          <!-- Vercel/Linear 式 6px 状态微点 + 白话 -->
          <td class="lt-col-status">
            <span class="lt-status" data-gs="lead-status-dot">
              <span aria-hidden="true" class="lt-status__dot" :class="`is-${row.statusDotTone}`" />
              <span class="lt-status__label">{{ row.statusLabel }}</span>
            </span>
          </td>

          <!-- 行尾操作：平时克制无边框弱显，Hover / 聚焦时清晰浮现 -->
          <td class="lt-col-actions" @click.stop>
            <div class="lt-actions">
              <template v-if="row.canAct">
                <Button
                  class="lt-act lt-act--accept"
                  data-gs="lead-accept"
                  size="small"
                  type="text"
                  @click="emit('accept', row.lead)"
                >
                  {{ $t('gainos.leads.cardAccept') }}
                </Button>
                <Button
                  class="lt-act lt-act--reject"
                  data-gs="lead-reject"
                  size="small"
                  type="text"
                  @click="emit('reject', row.lead)"
                >
                  {{ $t('gainos.leads.cardReject') }}
                </Button>
              </template>
              <Button
                v-else-if="row.lead.status === 'QUALIFIED'"
                class="lt-act lt-act--accept"
                data-gs="lead-promote"
                size="small"
                type="text"
                @click="emit('promote', row.lead)"
              >
                {{ $t('gainos.leads.promoteQgo') }}
              </Button>
              <Button
                :aria-label="$t('gainos.leads.viewPackage')"
                class="lt-act lt-act--detail"
                data-gs="lead-package"
                size="small"
                type="text"
                @click="emit('package', row.lead)"
              >
                {{ $t('gainosUi2.leads.detailShort') }}
              </Button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.lt-wrap {
  width: 100%;
  min-width: 0;
  overflow-x: auto;
  border: 1px solid var(--gs-border);
  border-radius: 10px;
  background: var(--gs-surface);
}

.lt-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 13px;
}

.lt-table thead tr {
  background: var(--gs-table-head);
  border-bottom: 1px solid var(--gs-border);
}

.lt-table th {
  height: 36px;
  padding: 0 10px;
  color: var(--gs-fg-muted);
  font-size: 12px;
  font-weight: 500;
  text-align: left;
  white-space: nowrap;
}

.lt-table td {
  height: 54px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--gs-divider);
  vertical-align: middle;
}

.lt-table tbody tr:last-child td {
  border-bottom: 0;
}

.lt-col-check {
  width: 40px;
  text-align: center !important;
  padding-inline: 8px !important;
}

.lt-col-company {
  width: auto;
  min-width: 220px;
}

.lt-col-score {
  width: 118px;
}

.lt-col-dims {
  width: 148px;
}

.lt-col-status {
  width: 104px;
}

.lt-col-actions {
  width: 168px;
  text-align: right !important;
}

.lt-row {
  cursor: pointer;
  transition: background-color 0.12s ease;
}

.lt-row:hover {
  background: var(--gs-surface-3);
}

.lt-row.is-selected {
  background: var(--gs-accent-soft);
}

.lt-row.is-active {
  background: var(--gs-accent-soft);
}

.lt-company {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.lt-avatar {
  display: grid;
  flex: none;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
}

.lt-avatar--brand {
  background: var(--gs-accent-soft);
  color: var(--gs-accent-fg);
}

.lt-avatar--success {
  background: var(--gs-success-bg);
  color: var(--gs-success-fg);
}

.lt-avatar--warning {
  background: var(--gs-warn-bg);
  color: var(--gs-warn-fg);
}

.lt-company__text {
  min-width: 0;
  flex: 1;
}

.lt-company__top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.lt-company__name {
  overflow: hidden;
  color: var(--gs-fg);
  font-size: 13.5px;
  font-weight: 600;
  line-height: 19px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lt-verified {
  flex: none;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--gs-success-bg);
  color: var(--gs-success-fg);
  font-size: 11px;
  font-weight: 500;
  line-height: 17px;
  white-space: nowrap;
}

.lt-company__meta {
  margin: 1px 0 0;
  overflow: hidden;
  color: var(--gs-fg-muted);
  font-size: 12px;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lt-score {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.lt-score__num {
  min-width: 22px;
  color: var(--gs-fg);
  font-size: 14px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.lt-grade {
  padding: 1px 6px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 500;
  line-height: 17px;
}

.lt-grade--high {
  background: var(--gs-success-bg);
  color: var(--gs-success-fg);
}

.lt-grade--medium {
  background: var(--gs-accent-soft);
  color: var(--gs-accent-fg);
}

.lt-grade--low,
.lt-grade--none {
  background: var(--gs-surface-2);
  color: var(--gs-fg-muted);
}

.lt-micro {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 4px 2px;
  border-radius: 4px;
}

.lt-micro__bars {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.lt-micro__cell {
  display: inline-block;
  width: 16px;
  height: 6px;
  border-radius: 2px;
  background: var(--gs-border-strong);
}

.lt-micro__cell.is-success {
  background: var(--gs-success);
}

.lt-micro__cell.is-warning {
  background: var(--gs-warn);
}

.lt-micro__cell.is-danger {
  background: var(--gs-danger);
}

.lt-micro__cell.is-info {
  background: var(--gs-accent);
}

.lt-micro__count {
  color: var(--gs-fg-muted);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.lt-empty-dash {
  color: var(--gs-fg-muted);
}

.lt-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.lt-status__dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: var(--gs-fg-muted);
}

.lt-status__dot.is-success {
  background: var(--gs-success);
}

.lt-status__dot.is-warning {
  background: var(--gs-warn);
}

.lt-status__dot.is-danger {
  background: var(--gs-danger);
}

.lt-status__dot.is-info {
  background: var(--gs-accent);
}

.lt-status__label {
  color: var(--gs-fg);
  font-size: 12.5px;
  font-weight: 500;
}

/* 行尾操作：静默态克制弱显（AA 对比度达标），Hover/聚焦时凸显主次动作 */
.lt-actions {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
}

.lt-act {
  height: 28px;
  padding-inline: 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--gs-fg-muted);
  font-size: 12.5px;
  font-weight: 500;
  transition:
    background-color 0.12s ease,
    border-color 0.12s ease,
    color 0.12s ease;
}

.lt-row:hover .lt-act--accept,
.lt-row:focus-within .lt-act--accept,
.lt-row.is-active .lt-act--accept {
  background: var(--gs-accent-soft);
  border-color: var(--gs-accent-soft-border);
  color: var(--gs-accent-fg);
}

.lt-row:hover .lt-act--reject,
.lt-row:focus-within .lt-act--reject,
.lt-row.is-active .lt-act--reject {
  border-color: var(--gs-border-strong);
  color: var(--gs-fg);
}

.lt-act--reject:hover {
  border-color: var(--gs-danger-border) !important;
  background: var(--gs-danger-bg) !important;
  color: var(--gs-danger-fg) !important;
}

.lt-row:hover .lt-act--detail,
.lt-row:focus-within .lt-act--detail,
.lt-row.is-active .lt-act--detail {
  color: var(--gs-fg);
}

/* Tooltip 内容（跟随 spotlight 颜色，明暗自动高对比） */
.lt-tip {
  display: grid;
  gap: 6px;
  padding: 2px 0;
  font-size: 12px;
}

.lt-tip__title {
  margin: 0;
  font-weight: 600;
}

.lt-tip__list {
  display: grid;
  gap: 5px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.lt-tip__item {
  display: grid;
  gap: 1px;
}

.lt-tip__row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.lt-tip__dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: currentColor;
  flex: none;
}

.lt-tip__dot.is-success {
  background: var(--gs-success);
}

.lt-tip__dot.is-warning {
  background: var(--gs-warn);
}

.lt-tip__dot.is-danger {
  background: var(--gs-danger);
}

.lt-tip__dot.is-info {
  background: var(--gs-accent);
}

.lt-tip__name {
  font-weight: 500;
}

.lt-tip__state {
  opacity: 0.85;
}

.lt-tip__score {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
}

.lt-tip__why {
  margin: 0 0 0 12px;
  font-size: 11.5px;
  line-height: 1.45;
  opacity: 0.85;
}

/* 窄容器自适应：隐藏次级列，避免移动端/平板挤压 */
@container (max-width: 820px) {
  .lt-col-dims {
    display: none;
  }
}

@container (max-width: 640px) {
  .lt-table {
    table-layout: auto;
  }
  .lt-col-status {
    display: none;
  }
  .lt-col-company {
    min-width: 160px;
  }
  .lt-col-score {
    width: auto;
  }
  .lt-col-actions {
    width: auto;
  }
  .lt-verified {
    display: none;
  }
}
</style>
