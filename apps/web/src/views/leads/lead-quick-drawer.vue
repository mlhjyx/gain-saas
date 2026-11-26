<script lang="ts" setup>
/**
 * 线索快审抽屉（PR-UI2：520px 右侧 GsDrawer）：
 * 在 /leads 列表页点击任意买家行滑出，不跳页即可查看：
 * 公司摘要 + 总分 + 一句话理由 + C1–C5 逐维判据 + 网页证据摘录 + 公开渠道，
 * 支持快捷「跟进 / 排除」、上一条/下一条连续快审、以及直达完整档案包。
 */
import type { Lead, LeadPackage } from '#/api/gainos';

import { computed, ref, watch } from 'vue';

import { formatDate } from '@gain-saas/shared';
import { ChevronLeft, ChevronRight, ExternalLink } from '@vben/icons';

import { Button, Skeleton, Tag } from 'ant-design-vue';

import { failureText, gainosApi } from '#/api/gainos';
import GsDrawer from '#/components/gainos/ui/gs-drawer.vue';
import GsTag from '#/components/gainos/ui/gs-tag.vue';
import { $t } from '#/locales';

import JudgeDimensions from './judge-dimensions.vue';
import LeadReviewPane from './lead-review-pane.vue';
import { companyContactPaths, companyPublicProfiles, hasPublicContactAccess } from './public-contact-paths';
import {
  displayLeadScore,
  isMachineAggregate,
  judgeCounts,
  keyDimension,
  leadScoreDimension,
  parseJudge,
  scoreGrade,
  shortRationale,
} from './judge';
import { dimName, humanizeRationale, verdictLabel, verdictTone } from './judge-labels';

defineOptions({ name: 'LeadQuickDrawer' });

const props = defineProps<{
  canAct: boolean;
  currentIndex: number;
  inline?: boolean;
  lead: Lead | null;
  totalCount: number;
}>();

const open = defineModel<boolean>('open', { default: false });

const emit = defineEmits<{
  accept: [lead: Lead];
  next: [];
  package: [lead: Lead];
  prev: [];
  promote: [lead: Lead];
  reject: [lead: Lead];
}>();

const pkg = ref<LeadPackage | null>(null);
const pkgLoading = ref(false);
const pkgError = ref<string | null>(null);
let fetchSeq = 0;

async function loadPackage(): Promise<void> {
  const seq = ++fetchSeq;
  const leadId = props.lead?.id;
  pkg.value = null;
  pkgError.value = null;
  pkgLoading.value = Boolean(open.value && leadId);
  if (!open.value || !leadId) return;
  try {
    const data = await gainosApi.leadPackage(leadId);
    if (seq === fetchSeq) pkg.value = data;
  } catch (error) {
    if (seq === fetchSeq) pkgError.value = failureText(error).title;
  } finally {
    if (seq === fetchSeq) pkgLoading.value = false;
  }
}

watch(
  () => [open.value, props.lead?.id] as const,
  loadPackage,
  { immediate: true },
);

const companyName = computed(
  () => props.lead?.company?.name || $t('gainos.leads.unknownCompany'),
);

const subtitle = computed(() =>
  [
    props.lead?.company?.domain,
    props.lead?.company?.country,
    props.lead?.company?.industry,
  ]
    .filter(Boolean)
    .join(' · '),
);

const judge = computed(() => {
  const fromPkg = pkg.value?.fit?.reasons;
  if (fromPkg && fromPkg.length > 0) return parseJudge(fromPkg);
  return parseJudge(props.lead?.fitReasons);
});

const dims = computed(() => judge.value.dims);
const verdict = computed(() => props.lead?.fitVerdict ?? pkg.value?.fit?.verdict ?? judge.value.verdict);

const score = computed(() =>
  displayLeadScore(pkg.value?.scores?.total) ?? displayLeadScore(props.lead?.totalScore),
);
const grade = computed(() => scoreGrade(score.value));

const summaryText = computed(() => {
  const counts = judgeCounts(dims.value);
  return [
    counts.pass ? $t('gainos.leads.criteriaPass', { count: counts.pass }) : '',
    counts.weak ? $t('gainos.leads.criteriaWeak', { count: counts.weak }) : '',
    counts.fail ? $t('gainos.leads.criteriaFail', { count: counts.fail }) : '',
    counts.unclear ? $t('gainos.leads.criteriaUnclear', { count: counts.unclear }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
});

const keyReason = computed(() => {
  const dim = keyDimension(dims.value);
  if (dim) {
    const text = shortRationale(humanizeRationale(dim.rationale), 160);
    return text ? `${dimName(dim.id)}：${text}` : dimName(dim.id);
  }
  const raw = props.lead?.fitReasons;
  if (Array.isArray(raw)) {
    const human = raw.map((item) => String(item)).filter((s) => s && !isMachineAggregate(s));
    if (human.length > 0) return human.slice(0, 2).join(' · ');
  }
  return $t('gainos.leads.reasonNone');
});

const SCORE_FALLBACK_DIMS = ['fit', 'role', 'intent', 'demand_proof', 'reachability'] as const;
const fallbackScoreRows = computed(() => {
  const scores = pkg.value?.scores ?? props.lead?.scores;
  if (!scores || typeof scores !== 'object') return [];
  const record = scores as Record<string, unknown>;
  return SCORE_FALLBACK_DIMS.map((dim) => ({ dim, value: leadScoreDimension(record, dim) }))
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

const evidenceItems = computed(() => {
  const seen = new Set<string>();
  const rows: Array<{ fetchedAt: string; field: string; url: string }> = [];
  for (const item of pkg.value?.evidence ?? []) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const field = typeof rec.field === 'string' ? rec.field.trim() : '';
    const url = typeof rec.source_url === 'string' ? safeHttpUrl(rec.source_url) : '';
    const fetchedAt = typeof rec.fetched_at === 'string' ? rec.fetched_at : '';
    const key = `${field}|${url}`;
    if (!field || seen.has(key)) continue;
    seen.add(key);
    rows.push({ fetchedAt, field, url });
  }
  return rows.slice(0, 5);
});

function safeHttpUrl(value?: null | string): string {
  return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : '';
}

const channels = computed(() => {
  const record = pkg.value;
  if (!record || props.lead?.queue === 'sanctions_hold' || props.lead?.queue === 'suppressed' ||
    !hasPublicContactAccess(record)) {
    return { emails: [], forms: [], phones: [], socials: [] };
  }
  const values = record.company_channels ?? [];
  const emails = new Set(values.filter((item) => item.channel === 'email' && item.value).map((item) => item.value));
  const phones = new Set(values.filter((item) => item.channel === 'phone' && item.value).map((item) => item.value));
  return {
    emails: [...emails].slice(0, 3),
    forms: companyContactPaths(record).slice(0, 2).map((item) => item.url),
    phones: [...phones].slice(0, 2),
    socials: companyPublicProfiles(record).slice(0, 3).map((item) => ({ label: item.platform, url: item.url })),
  };
});

const hasChannels = computed(
  () =>
    channels.value.emails.length > 0 ||
    channels.value.phones.length > 0 ||
    channels.value.forms.length > 0 ||
    channels.value.socials.length > 0,
);
</script>

<template>
  <component
    :is="inline ? LeadReviewPane : GsDrawer"
    v-model:open="open"
    :destroy-on-close="false"
    :subtitle="subtitle"
    :title="companyName"
    width="min(520px, 100vw)"
  >
    <template v-if="totalCount > 1" #extra>
      <div class="qd-pager" data-gs="quick-drawer-pager">
        <span class="qd-pager__text">
          {{ $t('gainosUi2.leads.quickReviewPosition', { current: currentIndex + 1, total: totalCount }) }}
        </span>
        <Button
          :aria-label="$t('gainosUi2.leads.quickReviewPrev')"
          :disabled="currentIndex <= 0"
          data-gs="quick-drawer-prev"
          size="small"
          @click="emit('prev')"
        >
          <template #icon><ChevronLeft :size="14" /></template>
        </Button>
        <Button
          :aria-label="$t('gainosUi2.leads.quickReviewNext')"
          :disabled="currentIndex >= totalCount - 1"
          data-gs="quick-drawer-next"
          size="small"
          @click="emit('next')"
        >
          <template #icon><ChevronRight :size="14" /></template>
        </Button>
      </div>
    </template>

    <div v-if="lead" :class="{ 'qd-body--inline': inline }" class="qd-body" data-gs="lead-quick-drawer">
      <!-- 评分与结论摘要带 -->
      <section class="qd-section qd-summary">
        <div class="qd-summary__top">
          <div class="qd-score">
            <span class="qd-score__val">{{ score ?? '—' }}</span>
            <span class="qd-grade" :class="`qd-grade--${grade}`">
              {{ $t(`gainos.leads.scoreGrade.${grade}`) }}
            </span>
          </div>
          <GsTag :tone="verdictTone(verdict)">{{ verdictLabel(verdict) }}</GsTag>
          <span v-if="summaryText" class="qd-summary__counts">{{ summaryText }}</span>
        </div>
        <p class="qd-summary__reason">{{ keyReason }}</p>
      </section>

      <!-- C1-C5 五维理由 / 评分降级 -->
      <section class="qd-section qd-criteria">
        <h3 class="qd-sec-title">
          {{ dims.length > 0 ? $t('gainos.leads.criteriaTitle') : $t('gainos.leads.scoresTitle') }}
        </h3>
        <JudgeDimensions v-if="dims.length > 0" compact :dims="dims" :show-bars="true" />
        <div v-else-if="fallbackScoreRows.length > 0" class="qd-scores">
          <div v-for="row in fallbackScoreRows" :key="row.id" class="qd-scores__row">
            <span class="qd-scores__name">{{ row.name }}</span>
            <span class="qd-scores__bar">
              <span class="qd-scores__fill" :style="{ width: `${row.value}%` }" />
            </span>
            <span class="qd-scores__val">{{ row.value }}</span>
          </div>
        </div>
        <p v-else class="qd-muted">{{ $t('gainos.leads.criteriaNone') }}</p>
      </section>

      <!-- 核心证据摘录 -->
      <section class="qd-section qd-evidence-section">
        <h3 class="qd-sec-title">{{ $t('gainosUi2.leads.quickReviewEvidence') }}</h3>
        <Skeleton v-if="pkgLoading" active :paragraph="{ rows: 2 }" :title="false" />
        <div v-else-if="pkgError" class="qd-error" role="alert">
          <p>{{ pkgError }}</p>
          <Button size="small" @click="loadPackage">{{ $t('gainos.common.retry') }}</Button>
        </div>
        <ul v-else-if="evidenceItems.length > 0" class="qd-evidence">
          <li v-for="(item, idx) in evidenceItems" :key="idx" class="qd-evidence__item">
            <span aria-hidden="true" class="qd-evidence__dot" />
            <div class="min-w-0 flex-1">
              <a
                v-if="item.url"
                :href="item.url"
                class="qd-evidence__link"
                rel="noreferrer"
                target="_blank"
              >
                {{ item.field }}
              </a>
              <span v-else class="qd-evidence__text">{{ item.field }}</span>
            </div>
            <span v-if="item.fetchedAt" class="qd-evidence__date">
              {{ formatDate(item.fetchedAt) }}
            </span>
          </li>
        </ul>
        <p v-else class="qd-muted">{{ $t('gainosUi2.leads.quickReviewNoEvidence') }}</p>
      </section>

      <!-- 公开渠道摘要 -->
      <section v-if="hasChannels" class="qd-section qd-channel-section" data-gs="quick-public-channels">
        <h3 class="qd-sec-title">{{ $t('gainosUi2.leads.quickReviewChannels') }}</h3>
        <div class="qd-channels">
          <Tag v-for="email in channels.emails" :key="email" :bordered="false" class="qd-chip">
            {{ email }}
          </Tag>
          <Tag v-for="phone in channels.phones" :key="phone" :bordered="false" class="qd-chip">
            {{ phone }}
          </Tag>
          <a
            v-for="social in channels.socials"
            :key="social.url"
            :href="social.url"
            class="qd-social"
            rel="noreferrer"
            target="_blank"
          >
            {{ social.label }}
          </a>
          <a
            v-for="form in channels.forms"
            :key="form"
            :href="form"
            class="qd-social"
            rel="noreferrer"
            target="_blank"
          >
            {{ $t('gainos.leads.channelFormsTitle') }}
          </a>
        </div>
      </section>

      <!-- 技术详情（折叠，仅在含机器聚合串时出现） -->
      <details v-if="judge.raw && isMachineAggregate(judge.raw)" class="qd-tech">
        <summary>{{ $t('gainos.findBuyers.technicalDetails') }}</summary>
        <pre class="qd-tech__raw">{{ judge.raw }}</pre>
      </details>
    </div>

    <template v-if="lead" #footer>
      <div class="qd-footer">
        <Button data-gs="quick-drawer-open-detail" @click="emit('package', lead)">
          <template #icon><ExternalLink :size="14" /></template>
          {{ $t('gainosUi2.leads.quickReviewOpenFull') }}
        </Button>
        <div class="qd-footer__actions">
          <template v-if="canAct">
            <Button danger data-gs="quick-drawer-reject" @click="emit('reject', lead)">
              {{ $t('gainos.leads.cardReject') }}
            </Button>
            <Button data-gs="quick-drawer-accept" type="primary" @click="emit('accept', lead)">
              {{ $t('gainos.leads.cardAccept') }}
            </Button>
          </template>
          <Button
            v-else-if="lead.status === 'QUALIFIED' && lead.queue !== 'sanctions_hold' && lead.queue !== 'suppressed'"
            data-gs="quick-drawer-promote"
            type="primary"
            @click="emit('promote', lead)"
          >
            {{ $t('gainos.leads.promoteQgo') }}
          </Button>
        </div>
      </div>
    </template>
  </component>
</template>

<style scoped>
.qd-pager {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.qd-pager__text {
  color: var(--gs-fg-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.qd-body {
  display: grid;
  gap: 0;
}

.qd-error p {
  margin: 0 0 7px;
  color: var(--gs-danger);
  overflow-wrap: anywhere;
}

@container (min-width: 580px) {
  .qd-body--inline {
    grid-template-areas:
      'summary summary'
      'criteria evidence'
      'criteria channels'
      'criteria .'
      'technical technical';
    grid-template-columns: minmax(0, 1.12fr) minmax(0, 1fr);
    grid-template-rows: auto auto auto 1fr auto;
    column-gap: 22px;
  }

  .qd-body--inline .qd-summary {
    grid-area: summary;
    padding: 13px 0;
  }

  .qd-body--inline .qd-criteria {
    grid-area: criteria;
    align-content: start;
    border-bottom: 0;
  }

  .qd-body--inline .qd-evidence-section {
    grid-area: evidence;
    align-content: start;
  }

  .qd-body--inline .qd-channel-section {
    grid-area: channels;
    align-content: start;
  }

  .qd-body--inline .qd-tech {
    grid-area: technical;
  }
}

.qd-section {
  display: grid;
  gap: 10px;
  padding: 14px 0;
  border-bottom: 1px solid var(--gs-divider);
}

.qd-section:first-child {
  padding-top: 0;
}

.qd-section:last-of-type {
  border-bottom: 0;
}

.qd-summary__top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.qd-score {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}

.qd-score__val {
  color: var(--gs-fg);
  font-size: 26px;
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.qd-grade {
  padding: 1px 7px;
  border-radius: 5px;
  font-size: 11.5px;
  font-weight: 500;
  line-height: 18px;
}

.qd-grade--high {
  background: var(--gs-success-bg);
  color: var(--gs-success-fg);
}

.qd-grade--medium {
  background: var(--gs-accent-soft);
  color: var(--gs-accent-fg);
}

.qd-grade--low,
.qd-grade--none {
  background: var(--gs-surface-2);
  color: var(--gs-fg-muted);
}

.qd-summary__counts {
  color: var(--gs-fg-muted);
  font-size: 12px;
}

.qd-summary__reason {
  margin: 0;
  color: var(--gs-fg-2);
  font-size: 13px;
  line-height: 1.65;
}

.qd-sec-title {
  margin: 0;
  color: var(--gs-fg);
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
}

.qd-muted {
  margin: 0;
  color: var(--gs-fg-muted);
  font-size: 12.5px;
  line-height: 1.6;
}

.qd-scores {
  display: grid;
  gap: 8px;
}

.qd-scores__row {
  display: grid;
  grid-template-columns: 88px 1fr 34px;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
}

.qd-scores__name {
  color: var(--gs-fg-muted);
}

.qd-scores__bar {
  height: 5px;
  border-radius: 9999px;
  background: var(--gs-surface-2);
  overflow: hidden;
}

.qd-scores__fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--gs-accent);
}

.qd-scores__val {
  color: var(--gs-fg);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.qd-evidence {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.qd-evidence__item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12.5px;
}

.qd-evidence__dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: var(--gs-accent);
  transform: translateY(-1px);
}

.qd-evidence__link {
  color: var(--gs-accent-fg);
  text-decoration: none;
  word-break: break-word;
}

.qd-evidence__link:hover {
  text-decoration: underline;
}

.qd-evidence__text {
  color: var(--gs-fg-2);
}

.qd-evidence__date {
  flex: none;
  color: var(--gs-fg-muted);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.qd-channels {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.qd-chip {
  margin: 0;
  border-radius: 6px;
  background: var(--gs-surface-2);
  color: var(--gs-fg-2);
  font-size: 12px;
}

.qd-social {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--gs-accent-soft);
  color: var(--gs-accent-fg);
  font-size: 12px;
  font-weight: 500;
  text-decoration: none;
}

.qd-social:hover {
  text-decoration: underline;
}

.qd-tech {
  padding-top: 10px;
  border-top: 1px solid var(--gs-divider);
  color: var(--gs-fg-muted);
  font-size: 12px;
}

.qd-tech summary {
  cursor: pointer;
}

.qd-tech__raw {
  max-height: 200px;
  margin: 8px 0 0;
  padding: 10px 12px;
  overflow: auto;
  border-radius: 8px;
  background: var(--gs-surface-2);
  color: var(--gs-fg-muted);
  font-size: 11.5px;
  white-space: pre-wrap;
  word-break: break-word;
}

.qd-footer {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.qd-footer__actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
</style>
