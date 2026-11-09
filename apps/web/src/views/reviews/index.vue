<script lang="ts" setup>
/**
 * 判定复核队列（引擎 P3 J17，设计 §4.3.8）：按优先级/SLA 排序的待复核任务、
 * 判据与证据抽屉、认领与结论（FIT/NOT_FIT/UNKNOWN + 理由）。
 *
 * 引擎契约：GET /judgment-reviews 返回 {items,nextCursor}；claim 只接受 queued；
 * resolve 只接受 in_review（认领后才可提交结论）。原判定 append-only，复核结论
 * 是一条新记录，界面不提供“改写历史”的假象。
 */
import type {
  JudgmentCriterion,
  JudgmentDetail,
  JudgmentReviewStats,
  JudgmentReviewTask,
  ReviewVerdict,
} from '#/api/gainos';

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { formatDateTime, glossaryStatus, statusClass } from '@gain-saas/shared';
import { preferences } from '@vben/preferences';

import { $t } from '#/locales';

import { failureText, gainosApi } from '#/api/gainos';

defineOptions({ name: 'JudgmentReviews' });

// 内嵌在「商机与触达」枢纽时不渲染自己的页头容器。
defineProps<{ embedded?: boolean }>();

type ErrorCopy = { title: string; why?: string; next?: string };
type StatusDomain = 'reviewTask' | 'reviewPriority' | 'reviewReason' | 'reviewVerdict' | 'criterionLabel' | 'metricStatus';

const tasks = ref<JudgmentReviewTask[]>([]);
const nextCursor = ref<string | null>(null);
const stats = ref<JudgmentReviewStats | null>(null);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref<ErrorCopy | null>(null);
const notice = ref<string | null>(null);
const statusFilter = ref('');
const priorityFilter = ref('');
const nowMs = ref(Date.now());
let clock: ReturnType<typeof setInterval> | null = null;

function entry(domain: StatusDomain, value: number | null | string | undefined) {
  return glossaryStatus(domain, value === null || value === undefined ? undefined : String(value), preferences.app.locale);
}
function toneOf(domain: StatusDomain, value: number | null | string | undefined): string {
  return statusClass(entry(domain, value)?.tone ?? 'neutral');
}
function labelOf(domain: StatusDomain, value: number | null | string | undefined, fallback: string): string {
  return entry(domain, value)?.label ?? fallback;
}

function criterionName(id: string): string {
  const key = `gainos.reviews.criteria.${id}`;
  const text = $t(key);
  return text === key ? $t('gainos.reviews.criteriaOther') : text;
}

const PRIORITY_SLA_HOURS: Record<number, number> = { 0: 24, 1: 72, 2: 120, 3: 168 };

function durationText(ms: number): string {
  const hours = Math.max(1, Math.ceil(ms / 3_600_000));
  if (hours >= 48) {
    const days = Math.floor(hours / 24);
    const rest = hours % 24;
    return rest
      ? $t('gainos.reviews.durationDaysHours', { days, hours: rest })
      : $t('gainos.reviews.durationDays', { days });
  }
  return $t('gainos.reviews.durationHours', { hours });
}

function slaInfo(task: JudgmentReviewTask): { text: string; tone: 'danger' | 'neutral' | 'warning' } {
  if (!task.dueAt) return { text: $t('gainos.reviews.slaNone'), tone: 'neutral' };
  const due = Date.parse(task.dueAt);
  if (Number.isNaN(due)) return { text: '—', tone: 'neutral' };
  const diff = due - nowMs.value;
  if (diff < 0) {
    return { text: $t('gainos.reviews.slaOverdue', { duration: durationText(-diff) }), tone: 'danger' };
  }
  const slaMs = (PRIORITY_SLA_HOURS[task.priority] ?? 24) * 3_600_000;
  const tone = diff < Math.min(6 * 3_600_000, slaMs * 0.2) ? 'warning' : 'neutral';
  return { text: $t('gainos.reviews.slaRemaining', { duration: durationText(diff) }), tone };
}

const rows = computed(() =>
  tasks.value.map((task) => ({
    task,
    priority: entry('reviewPriority', task.priority),
    status: entry('reviewTask', task.status),
    reason: entry('reviewReason', task.reason),
    verdict: entry('reviewVerdict', task.verdictAtJudge),
    sla: slaInfo(task),
  })),
);

const statItems = computed(() => {
  const data = stats.value;
  return [
    {
      key: 'queued',
      label: $t('gainos.reviews.statQueued'),
      value: String(data?.byStatus?.queued ?? 0),
      tone: 'gs-badge--warning',
    },
    {
      key: 'in_review',
      label: $t('gainos.reviews.statInReview'),
      value: String(data?.byStatus?.in_review ?? 0),
      tone: 'gs-badge--processing',
    },
    {
      key: 'resolved',
      label: $t('gainos.reviews.statResolved', { days: data?.windowDays ?? 7 }),
      value: String(data?.overturn?.resolved ?? 0),
      tone: 'gs-badge--success',
    },
    {
      key: 'overturn',
      label: $t('gainos.reviews.statOverturn'),
      value:
        data && data.overturn.rate !== null
          ? $t('gainos.reviews.statOverturnValue', {
              overturned: data.overturn.overturned,
              rate: Math.round(data.overturn.rate * 100),
              resolved: data.overturn.resolved,
            })
          : $t('gainos.reviews.statOverturnNone'),
      tone: 'gs-badge--neutral',
    },
  ];
});

async function load(reset = true): Promise<void> {
  if (reset) loading.value = true;
  else loadingMore.value = true;
  error.value = null;
  try {
    const page = await gainosApi.judgmentReviews({
      status: statusFilter.value || undefined,
      ...(priorityFilter.value === '' ? {} : { priority: Number(priorityFilter.value) }),
      limit: 50,
      ...(reset ? {} : { cursor: nextCursor.value ?? undefined }),
    });
    const items = Array.isArray(page?.items) ? page.items : [];
    tasks.value = reset ? items : [...tasks.value, ...items];
    nextCursor.value = page?.nextCursor ?? null;
  } catch (err) {
    error.value = failureText(err);
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

async function loadStats(): Promise<void> {
  // 概况是辅助信息：失败不打断队列本身（队列自己的错误态仍然完整展示）。
  try {
    stats.value = await gainosApi.judgmentStats(7);
  } catch {
    stats.value = null;
  }
}

function refreshAll(): void {
  notice.value = null;
  void load(true);
  void loadStats();
}

watch([statusFilter, priorityFilter], () => {
  void load(true);
});

// ── 详情抽屉 ────────────────────────────────────────────────────────────────
const selected = ref<JudgmentReviewTask | null>(null);
const detail = ref<JudgmentDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref<ErrorCopy | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
let lastFocused: HTMLElement | null = null;

const criteriaRows = computed(() =>
  (Array.isArray(detail.value?.criteria) ? (detail.value.criteria as JudgmentCriterion[]) : []).map(
    (criterion: JudgmentCriterion) => ({
      criterion,
      label: entry('criterionLabel', criterion.label),
      name: criterionName(criterion.id),
    }),
  ),
);

async function openTask(task: JudgmentReviewTask): Promise<void> {
  lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  selected.value = task;
  detail.value = null;
  detailError.value = null;
  detailLoading.value = true;
  actionError.value = null;
  actionNotice.value = null;
  resolution.value = { verdict: '', note: '' };
  try {
    detail.value = await gainosApi.judgment(task.judgmentRecordId);
  } catch (err) {
    detailError.value = failureText(err);
  } finally {
    detailLoading.value = false;
    await nextTick();
    closeButton.value?.focus();
  }
}

async function reloadDetail(): Promise<void> {
  if (!selected.value) return;
  detailError.value = null;
  detailLoading.value = true;
  try {
    detail.value = await gainosApi.judgment(selected.value.judgmentRecordId);
  } catch (err) {
    detailError.value = failureText(err);
  } finally {
    detailLoading.value = false;
  }
}

function closeDrawer(): void {
  selected.value = null;
  detail.value = null;
  detailError.value = null;
  detailLoading.value = false;
  actionError.value = null;
  actionNotice.value = null;
  void nextTick(() => lastFocused?.focus());
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && selected.value) {
    event.stopPropagation();
    closeDrawer();
  }
}

// ── 认领与结论 ──────────────────────────────────────────────────────────────
const claiming = ref(false);
const actionError = ref<ErrorCopy | null>(null);
const actionNotice = ref<string | null>(null);
const resolution = ref<{ verdict: ReviewVerdict | ''; note: string }>({ verdict: '', note: '' });
const resolving = ref(false);

const canClaim = computed(() => selected.value?.status === 'queued');
const canResolve = computed(() => selected.value?.status === 'in_review');
const canSubmit = computed(() => canResolve.value && resolution.value.verdict !== '' && !resolving.value);

async function claim(): Promise<void> {
  if (!selected.value) return;
  claiming.value = true;
  actionError.value = null;
  actionNotice.value = null;
  try {
    const result = await gainosApi.claimJudgmentReview(selected.value.id);
    selected.value.status = result?.status ?? 'in_review';
    const row = tasks.value.find((task) => task.id === selected.value?.id);
    if (row) row.status = selected.value.status;
    actionNotice.value = $t('gainos.reviews.claimedNotice');
    void loadStats();
  } catch (err) {
    actionError.value = failureText(err);
  } finally {
    claiming.value = false;
  }
}

async function submitResolution(): Promise<void> {
  if (!selected.value || resolution.value.verdict === '') return;
  resolving.value = true;
  actionError.value = null;
  try {
    await gainosApi.resolveJudgmentReview(selected.value.id, {
      verdict: resolution.value.verdict,
      ...(resolution.value.note.trim() ? { note: resolution.value.note.trim() } : {}),
    });
    notice.value = $t('gainos.reviews.resolvedNotice');
    closeDrawer();
    await Promise.all([load(true), loadStats()]);
  } catch (err) {
    actionError.value = failureText(err);
  } finally {
    resolving.value = false;
  }
}

onMounted(() => {
  void load(true);
  void loadStats();
  clock = setInterval(() => {
    nowMs.value = Date.now();
  }, 60_000);
  window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  if (clock) clearInterval(clock);
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div class="rv" :class="{ 'is-embedded': embedded }">
    <header class="rv__head">
      <div>
        <h2>{{ $t('gainos.reviews.title') }}</h2>
        <p class="rv__sub">{{ $t('gainos.reviews.subtitle') }}</p>
      </div>
      <button class="rv__ghost" type="button" :disabled="loading" @click="refreshAll">
        {{ $t('gainos.common.refresh') }}
      </button>
    </header>

    <section class="rv__stats" :aria-label="$t('gainos.reviews.statsTitle')">
      <div v-for="item in statItems" :key="item.key" class="rv__stat">
        <span class="rv__stat-label">{{ item.label }}</span>
        <span class="gs-badge" :class="item.tone">{{ item.value }}</span>
      </div>
    </section>

    <section class="rv__filters" :aria-label="$t('gainos.reviews.filtersTitle')">
      <label class="rv__field">
        <span>{{ $t('gainos.reviews.filterStatus') }}</span>
        <select v-model="statusFilter">
          <option value="">{{ $t('gainos.reviews.all') }}</option>
          <option value="queued">{{ labelOf('reviewTask', 'queued', 'queued') }}</option>
          <option value="in_review">{{ labelOf('reviewTask', 'in_review', 'in_review') }}</option>
          <option value="resolved">{{ labelOf('reviewTask', 'resolved', 'resolved') }}</option>
          <option value="expired">{{ labelOf('reviewTask', 'expired', 'expired') }}</option>
        </select>
      </label>
      <label class="rv__field">
        <span>{{ $t('gainos.reviews.filterPriority') }}</span>
        <select v-model="priorityFilter">
          <option value="">{{ $t('gainos.reviews.all') }}</option>
          <option v-for="priority in [0, 1, 2, 3]" :key="priority" :value="String(priority)">
            {{ labelOf('reviewPriority', priority, `P${priority}`) }}
          </option>
        </select>
      </label>
    </section>

    <p v-if="notice" class="rv__notice" role="status">{{ notice }}</p>

    <p v-if="loading" class="rv__muted">{{ $t('gainos.common.loading') }}</p>

    <div v-else-if="error" class="rv__error" role="alert">
      <strong>{{ error.title }}</strong>
      <p v-if="error.why">{{ error.why }}</p>
      <p v-if="error.next">{{ error.next }}</p>
      <button class="rv__ghost" type="button" @click="refreshAll">{{ $t('gainos.common.retry') }}</button>
    </div>

    <div v-else-if="tasks.length === 0" class="rv__empty">
      <template v-if="statusFilter || priorityFilter">
        <p class="rv__empty-title">{{ $t('gainos.reviews.emptyFiltered') }}</p>
        <p class="rv__muted">{{ $t('gainos.reviews.emptyFilteredHint') }}</p>
      </template>
      <template v-else>
        <p class="rv__empty-title">{{ $t('gainos.reviews.emptyTitle') }}</p>
        <p class="rv__muted">{{ $t('gainos.reviews.emptyDesc') }}</p>
      </template>
    </div>

    <template v-else>
      <div class="rv__tablewrap">
        <table class="rv__table">
          <thead>
            <tr>
              <th scope="col">{{ $t('gainos.reviews.colPriority') }}</th>
              <th scope="col">{{ $t('gainos.reviews.colCompany') }}</th>
              <th scope="col">{{ $t('gainos.reviews.colReason') }}</th>
              <th scope="col">{{ $t('gainos.reviews.colJudgeVerdict') }}</th>
              <th scope="col">{{ $t('gainos.reviews.colStatus') }}</th>
              <th scope="col">{{ $t('gainos.reviews.colSla') }}</th>
              <th scope="col"><span class="rv__sr">{{ $t('gainos.reviews.colActions') }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.task.id">
              <td>
                <span class="gs-badge" :class="toneOf('reviewPriority', row.task.priority)">
                  {{ row.priority?.label ?? `P${row.task.priority}` }}
                </span>
              </td>
              <td>
                <button class="rv__rowlink" type="button" @click="openTask(row.task)">
                  {{ row.task.companyName || $t('gainos.reviews.unknownCompany') }}
                </button>
              </td>
              <td>{{ row.reason?.label ?? '—' }}</td>
              <td>
                <span class="gs-badge" :class="toneOf('reviewVerdict', row.task.verdictAtJudge)">
                  {{ row.verdict?.label ?? row.task.verdictAtJudge }}
                </span>
              </td>
              <td>
                <span class="gs-badge" :class="toneOf('reviewTask', row.task.status)">
                  {{ row.status?.label ?? row.task.status }}
                </span>
              </td>
              <td>
                <span class="gs-badge" :class="statusClass(row.sla.tone)">{{ row.sla.text }}</span>
              </td>
              <td class="rv__row-actions">
                <button class="rv__ghost rv__ghost--sm" type="button" @click="openTask(row.task)">
                  {{ $t('gainos.reviews.open') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <button
        v-if="nextCursor"
        class="rv__ghost rv__loadmore"
        type="button"
        :disabled="loadingMore"
        @click="load(false)"
      >
        {{ loadingMore ? $t('gainos.common.loading') : $t('gainos.reviews.loadMore') }}
      </button>
    </template>

    <div v-if="selected" class="rv__drawer" @click.self="closeDrawer">
      <aside class="rv__card" role="dialog" aria-modal="true" aria-labelledby="rv-drawer-title">
        <header class="rv__card-head">
          <div>
            <h3 id="rv-drawer-title">{{ selected.companyName || $t('gainos.reviews.unknownCompany') }}</h3>
            <p class="rv__sub">{{ $t('gainos.reviews.detailTitle') }}</p>
          </div>
          <button
            ref="closeButton"
            class="rv__ghost rv__ghost--sm"
            type="button"
            :aria-label="$t('gainos.reviews.detailClose')"
            @click="closeDrawer"
          >
            {{ $t('gainos.reviews.detailClose') }}
          </button>
        </header>

        <dl class="rv__meta">
          <div>
            <dt>{{ $t('gainos.reviews.filterReason') }}</dt>
            <dd>{{ labelOf('reviewReason', selected.reason, '—') }}</dd>
          </div>
          <div>
            <dt>{{ $t('gainos.reviews.filterPriority') }}</dt>
            <dd>
              <span class="gs-badge" :class="toneOf('reviewPriority', selected.priority)">
                {{ labelOf('reviewPriority', selected.priority, `P${selected.priority}`) }}
              </span>
            </dd>
          </div>
          <div>
            <dt>{{ $t('gainos.reviews.colStatus') }}</dt>
            <dd>
              <span class="gs-badge" :class="toneOf('reviewTask', selected.status)">
                {{ labelOf('reviewTask', selected.status, selected.status) }}
              </span>
            </dd>
          </div>
          <div>
            <dt>{{ $t('gainos.reviews.colJudgeVerdict') }}</dt>
            <dd>
              <span class="gs-badge" :class="toneOf('reviewVerdict', selected.verdictAtJudge)">
                {{ labelOf('reviewVerdict', selected.verdictAtJudge, selected.verdictAtJudge) }}
              </span>
            </dd>
          </div>
          <div>
            <dt>{{ $t('gainos.reviews.dueAt') }}</dt>
            <dd>{{ selected.dueAt ? formatDateTime(selected.dueAt) : $t('gainos.reviews.slaNone') }}</dd>
          </div>
          <div>
            <dt>{{ $t('gainos.reviews.judgedAt') }}</dt>
            <dd>{{ detail ? formatDateTime(detail.createdAt) : '—' }}</dd>
          </div>
        </dl>

        <section class="rv__block" :aria-label="$t('gainos.reviews.criteriaTitle')">
          <h4>{{ $t('gainos.reviews.criteriaTitle') }}</h4>
          <p v-if="detailLoading" class="rv__muted">{{ $t('gainos.reviews.detailLoading') }}</p>
          <div v-else-if="detailError" class="rv__error" role="alert">
            <strong>{{ detailError.title }}</strong>
            <p v-if="detailError.next">{{ detailError.next }}</p>
            <button class="rv__ghost rv__ghost--sm" type="button" @click="reloadDetail">
              {{ $t('gainos.common.retry') }}
            </button>
          </div>
          <p v-else-if="criteriaRows.length === 0" class="rv__muted">
            {{ $t('gainos.reviews.criteriaEmpty') }}
          </p>
          <ul v-else class="rv__criteria">
            <li v-for="row in criteriaRows" :key="row.criterion.id" class="rv__criterion">
              <div class="rv__criterion-head">
                <span class="rv__criterion-name">{{ row.name }}</span>
                <span class="gs-badge" :class="row.label ? statusClass(row.label.tone) : 'gs-badge--neutral'">
                  {{ row.label?.label ?? row.criterion.label }}
                </span>
                <span class="rv__criterion-score">
                  {{
                    row.criterion.score === null || row.criterion.score === undefined
                      ? $t('gainos.reviews.criteriaScoreNone')
                      : $t('gainos.reviews.criteriaScore', { score: row.criterion.score })
                  }}
                </span>
              </div>
              <p class="rv__criterion-rationale">{{ row.criterion.rationale }}</p>
              <ul v-if="row.criterion.evidence?.length" class="rv__evidence">
                <li v-for="(item, index) in row.criterion.evidence" :key="`${row.criterion.id}-${index}`">
                  <a :href="item.url" rel="noopener noreferrer" target="_blank">
                    {{ item.span || item.url }}
                  </a>
                  <span v-if="item.kind" class="rv__evidence-kind">{{ item.kind }}</span>
                </li>
              </ul>
            </li>
          </ul>
        </section>

        <section class="rv__block" :aria-label="$t('gainos.reviews.actionTitle')">
          <h4>{{ $t('gainos.reviews.actionTitle') }}</h4>
          <p v-if="actionNotice" class="rv__notice" role="status">{{ actionNotice }}</p>
          <div v-if="actionError" class="rv__error" role="alert">
            <strong>{{ actionError.title }}</strong>
            <p v-if="actionError.why">{{ actionError.why }}</p>
            <p v-if="actionError.next">{{ actionError.next }}</p>
          </div>

          <template v-if="canClaim">
            <p class="rv__muted">{{ $t('gainos.reviews.claimHint') }}</p>
            <button class="rv__primary" type="button" :disabled="claiming" @click="claim">
              {{ claiming ? $t('gainos.reviews.claiming') : $t('gainos.reviews.claim') }}
            </button>
          </template>

          <form v-else-if="canResolve" class="rv__resolve" @submit.prevent="submitResolution">
            <p class="rv__muted">{{ $t('gainos.reviews.resolveHint') }}</p>
            <fieldset class="rv__verdicts">
              <legend>{{ $t('gainos.reviews.verdictLabel') }}</legend>
              <label class="rv__verdict">
                <input v-model="resolution.verdict" name="review-verdict" type="radio" value="FIT" />
                <span>{{ $t('gainos.reviews.verdictFit') }}</span>
              </label>
              <label class="rv__verdict">
                <input v-model="resolution.verdict" name="review-verdict" type="radio" value="NOT_FIT" />
                <span>{{ $t('gainos.reviews.verdictNotFit') }}</span>
              </label>
              <label class="rv__verdict">
                <input v-model="resolution.verdict" name="review-verdict" type="radio" value="UNKNOWN" />
                <span>{{ $t('gainos.reviews.verdictUnknown') }}</span>
              </label>
            </fieldset>
            <label class="rv__field">
              <span>{{ $t('gainos.reviews.noteLabel') }}</span>
              <textarea
                v-model="resolution.note"
                maxlength="2000"
                rows="4"
                :placeholder="$t('gainos.reviews.notePlaceholder')"
              />
            </label>
            <button class="rv__primary" type="submit" :disabled="!canSubmit">
              {{ resolving ? $t('gainos.reviews.submitting') : $t('gainos.reviews.submit') }}
            </button>
          </form>

          <p v-else-if="selected.status === 'resolved'" class="rv__muted">
            {{ $t('gainos.reviews.resolvedReadonly') }}
          </p>
          <p v-else class="rv__muted">{{ $t('gainos.reviews.expiredReadonly') }}</p>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.rv {
  width: 100%;
  max-width: 1280px;
  margin: 0 auto;
  padding: clamp(18px, 2.4vw, 32px) clamp(18px, 2.4vw, 34px) clamp(32px, 4vh, 48px);
  box-sizing: border-box;
  display: grid;
  gap: 16px;
}
.rv.is-embedded { padding: 0; max-width: none; margin: 0; }
.rv__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.rv__head h2 { margin: 0 0 4px; font-size: 22px; }
.rv__sub { margin: 0; color: var(--gs-fg-muted); font-size: 13px; line-height: 1.6; }
.rv__stats { display: flex; gap: 10px; flex-wrap: wrap; }
.rv__stat { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border: 1px solid var(--gs-border-strong); border-radius: 12px; background: var(--gs-surface); }
.rv__stat-label { font-size: 12.5px; color: var(--gs-fg-subtle); }
.rv__filters { display: flex; gap: 14px; flex-wrap: wrap; align-items: flex-end; }
.rv__field { display: grid; gap: 4px; font-size: 13px; color: var(--gs-fg-2); }
.rv__field select, .rv__field textarea { padding: 8px 10px; border: 1px solid var(--gs-border-strong); border-radius: 8px; background: var(--gs-surface); color: var(--gs-fg); font: inherit; }
.rv__tablewrap { overflow-x: auto; border: 1px solid var(--gs-border-strong); border-radius: 12px; background: var(--gs-surface); }
.rv__table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.rv__table th, .rv__table td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--gs-divider); vertical-align: middle; }
.rv__table thead th { font-size: 12px; font-weight: 600; color: var(--gs-fg-subtle); letter-spacing: 0.02em; }
.rv__table tbody tr:last-child td { border-bottom: none; }
.rv__rowlink { border: 0; background: none; padding: 0; color: var(--gs-accent-strong); font: inherit; font-weight: 600; cursor: pointer; text-align: left; }
.rv__rowlink:hover { text-decoration: underline; }
.rv__row-actions { text-align: right; }
.rv__ghost, .rv__primary { padding: 8px 14px; border-radius: 8px; border: 1px solid transparent; cursor: pointer; font: inherit; }
.rv__ghost { background: var(--gs-surface); border-color: var(--gs-border-strong); color: var(--gs-fg-2); }
.rv__ghost:disabled, .rv__primary:disabled { opacity: 0.5; cursor: not-allowed; }
.rv__ghost--sm { padding: 6px 10px; font-size: 12.5px; }
.rv__primary { background: var(--gs-accent-cta); color: var(--gs-accent-cta-fg); }
.rv__loadmore { justify-self: center; }
.rv__muted { margin: 0; color: var(--gs-fg-subtle); font-size: 13px; }
.rv__notice { margin: 0; color: var(--gs-accent-strong); font-size: 13px; }
.rv__error { border: 1px solid var(--gs-danger-border); background: var(--gs-danger-bg); border-radius: 12px; padding: 12px 14px; display: grid; gap: 6px; color: var(--gs-danger); font-size: 13px; }
.rv__error p { margin: 0; }
.rv__error button { justify-self: start; }
.rv__empty { border: 1px dashed var(--gs-border-dashed); border-radius: 16px; background: var(--gs-surface); padding: 40px 24px; text-align: center; display: grid; gap: 6px; }
.rv__empty-title { margin: 0; font-weight: 600; color: var(--gs-fg-2); }
.rv__sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.rv__drawer { position: fixed; inset: 0; background: var(--gs-mask); display: flex; justify-content: flex-end; z-index: 40; }
.rv__card { width: min(600px, 100%); height: 100%; overflow: auto; background: var(--gs-surface); padding: 22px clamp(16px, 3vw, 26px) 40px; display: grid; gap: 16px; align-content: start; box-shadow: var(--gs-shadow-modal); }
.rv__card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.rv__card-head h3 { margin: 0 0 4px; font-size: 19px; }
.rv__meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; margin: 0; padding: 12px 14px; border: 1px solid var(--gs-border-strong); border-radius: 12px; background: var(--gs-surface-3); }
.rv__meta dt { font-size: 12px; color: var(--gs-fg-subtle); margin-bottom: 4px; }
.rv__meta dd { margin: 0; font-size: 13.5px; color: var(--gs-fg-2); }
.rv__block { display: grid; gap: 10px; }
.rv__block h4 { margin: 0; font-size: 14.5px; }
.rv__criteria { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.rv__criterion { border: 1px solid var(--gs-border); border-radius: 12px; padding: 12px 14px; display: grid; gap: 8px; background: var(--gs-surface-3); }
.rv__criterion-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rv__criterion-name { font-weight: 600; font-size: 13.5px; color: var(--gs-fg); }
.rv__criterion-score { margin-left: auto; font-size: 12px; color: var(--gs-fg-subtle); }
.rv__criterion-rationale { margin: 0; font-size: 13px; line-height: 1.65; color: var(--gs-fg-2); }
.rv__evidence { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; font-size: 12.5px; }
.rv__evidence a { color: var(--gs-accent-strong); word-break: break-all; }
.rv__evidence-kind { margin-left: 8px; color: var(--gs-fg-subtle); }
.rv__resolve { display: grid; gap: 10px; }
.rv__verdicts { border: 0; margin: 0; padding: 0; display: flex; gap: 10px; flex-wrap: wrap; }
.rv__verdicts legend { font-size: 13px; color: var(--gs-fg-2); margin-bottom: 6px; }
.rv__verdict { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--gs-border-strong); border-radius: 999px; padding: 6px 14px; cursor: pointer; font-size: 13px; color: var(--gs-fg-2); background: var(--gs-surface); }
.rv__verdict:has(input:checked) { border-color: var(--gs-accent-cta); background: var(--gs-accent-soft); color: var(--gs-fg); }
.rv__verdict input { accent-color: var(--gs-accent-cta); }
.rv__primary { justify-self: start; }
@media (max-width: 720px) {
  .rv__meta { grid-template-columns: 1fr; }
  .rv__card { width: 100%; }
}
</style>
