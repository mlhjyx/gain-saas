<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue';

import { $t } from '#/locales';
import ErrorNotice from '#/components/error-notice.vue';
import {
  failureText,
  gainosApi,
  type QgoOutcomeValue,
  type QgoView,
} from '#/api/gainos';

/**
 * 商机（QGO）列表与详情（M2 步 10-3）。刻意不进 P6 导航：
 * 入口在线索页头部与已接受线索卡片上；路由 /qgos hideInMenu。
 * 证据卡展示「为什么是商机」；接受/拒绝即 SAO；结果登记 append-only。
 */
defineOptions({ name: 'Qgos' });

const OUTCOME_VALUES: QgoOutcomeValue[] = [
  'REPLIED',
  'MEETING_BOOKED',
  'QUOTE_SENT',
  'WON',
  'LOST',
  'NO_RESPONSE',
  'DISQUALIFIED',
];

const STATE_TABS = ['', 'OPEN', 'CONVERTED', 'DROPPED'] as const;

const rows = ref<QgoView[]>([]);
const loading = ref(true);
const loadError = ref<ReturnType<typeof failureText> | null>(null);
const stateFilter = ref<string>('');

const selected = ref<QgoView | null>(null);
const detailLoading = ref(false);
const detailError = ref<ReturnType<typeof failureText> | null>(null);
const actionBusy = ref(false);
const actionError = ref<ReturnType<typeof failureText> | null>(null);
const notice = ref<string | null>(null);
const declineReason = ref('');
const declineArmed = ref(false);

const outcomeValue = ref<QgoOutcomeValue>('REPLIED');
const outcomeNote = ref('');
const outcomeOccurredAt = ref('');

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    const data = await gainosApi.qgos({
      limit: 100,
      ...(stateFilter.value ? { state: stateFilter.value } : {}),
    });
    rows.value = Array.isArray(data) ? data : ((data as unknown as { data?: QgoView[] })?.data ?? []);
  } catch (error) {
    loadError.value = failureText(error);
    rows.value = [];
  } finally {
    loading.value = false;
  }
}

async function openDetail(id: string): Promise<void> {
  detailLoading.value = true;
  detailError.value = null;
  actionError.value = null;
  notice.value = null;
  declineArmed.value = false;
  declineReason.value = '';
  try {
    selected.value = await gainosApi.qgo(id);
  } catch (error) {
    detailError.value = failureText(error);
    selected.value = null;
  } finally {
    detailLoading.value = false;
  }
}

function closeDetail(): void {
  if (actionBusy.value) return;
  selected.value = null;
}

async function refreshDetail(): Promise<void> {
  if (!selected.value) return;
  await openDetail(selected.value.id);
  await load();
}

async function accept(): Promise<void> {
  if (!selected.value || actionBusy.value) return;
  actionBusy.value = true;
  actionError.value = null;
  try {
    await gainosApi.acceptQgo(selected.value.id);
    notice.value = $t('gainos.qgos.acceptedNotice');
    await refreshDetail();
  } catch (error) {
    actionError.value = failureText(error);
  } finally {
    actionBusy.value = false;
  }
}

async function decline(): Promise<void> {
  if (!selected.value || actionBusy.value) return;
  if (!declineArmed.value) {
    declineArmed.value = true;
    return;
  }
  actionBusy.value = true;
  actionError.value = null;
  try {
    await gainosApi.declineQgo(selected.value.id, declineReason.value.trim());
    notice.value = $t('gainos.qgos.declinedNotice');
    declineArmed.value = false;
    await refreshDetail();
  } catch (error) {
    actionError.value = failureText(error);
  } finally {
    actionBusy.value = false;
  }
}

async function submitOutcome(): Promise<void> {
  const sao = selected.value?.sao;
  if (!sao || sao.state !== 'ACCEPTED' || actionBusy.value) return;
  actionBusy.value = true;
  actionError.value = null;
  try {
    await gainosApi.addQgoOutcome(sao.id, {
      outcome: outcomeValue.value,
      ...(outcomeNote.value.trim() ? { note: outcomeNote.value.trim() } : {}),
      ...(outcomeOccurredAt.value ? { occurredAt: new Date(outcomeOccurredAt.value).toISOString() } : {}),
    });
    notice.value = $t('gainos.qgos.outcomeSaved');
    outcomeNote.value = '';
    outcomeOccurredAt.value = '';
    await refreshDetail();
  } catch (error) {
    actionError.value = failureText(error);
  } finally {
    actionBusy.value = false;
  }
}

const hasSaoAccepted = computed(() => selected.value?.sao?.state === 'ACCEPTED');

function stateLabel(state: string): string {
  return $t(`gainos.qgos.state.${state}` as Parameters<typeof $t>[0]);
}

function outcomeLabel(value: string): string {
  return $t(`gainos.qgos.outcome.${value}` as Parameters<typeof $t>[0]);
}

function evidenceTypeLabel(value: string): string {
  const key = `gainos.leads.evidenceType.${value}` as Parameters<typeof $t>[0];
  const label = $t(key);
  return label === key ? value : label;
}

function fmt(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

onMounted(load);
</script>

<template>
  <div class="qg">
    <header class="qg__head">
      <div>
        <span class="qg__stage">{{ $t('gainos.qgos.stage') }}</span>
        <h1>{{ $t('gainos.qgos.title') }}</h1>
        <p>{{ $t('gainos.qgos.subtitle') }}</p>
      </div>
      <div class="qg__head-actions">
        <router-link class="qg__link" to="/leads">{{ $t('gainos.qgos.backToLeads') }}</router-link>
        <button class="qg__btn" type="button" :class="{ 'is-loading': loading }" @click="load">
          {{ loading ? $t('gainos.common.refreshing') : $t('gainos.common.refresh') }}
        </button>
      </div>
    </header>

    <nav class="qg__tabs" :aria-label="$t('gainos.qgos.stateFilter')">
      <button
        v-for="state in STATE_TABS"
        :key="state || 'ALL'"
        type="button"
        class="qg__tab"
        :class="{ 'is-active': stateFilter === state }"
        @click="stateFilter = state; load()"
      >
        {{ state ? stateLabel(state) : $t('gainos.qgos.all') }}
      </button>
    </nav>

    <p v-if="notice" class="qg__notice" role="status">{{ notice }}</p>
    <ErrorNotice v-if="loadError" :title="loadError.title" :why="loadError.why" :next="loadError.next" :code="loadError.code" />

    <section v-if="loading" class="qg__state">{{ $t('gainos.common.loading') }}</section>
    <section v-else-if="rows.length === 0" class="qg__empty">
      <p class="qg__empty-title">{{ $t('gainos.qgos.emptyTitle') }}</p>
      <p class="qg__empty-desc">{{ $t('gainos.qgos.emptyDesc') }}</p>
      <router-link class="qg__btn" to="/leads">{{ $t('gainos.qgos.emptyCta') }}</router-link>
    </section>

    <ol v-else class="qg__list">
      <li v-for="row in rows" :key="row.id" class="qg__card" @click="openDetail(row.id)">
        <header class="qg__card-head">
          <h2>{{ row.title }}</h2>
          <span class="qg__state-badge" :class="`qg__state-badge--${row.state.toLowerCase()}`">{{ stateLabel(row.state) }}</span>
        </header>
        <p class="qg__next">{{ $t('gainos.qgos.nextStep') }}：{{ row.nextStep }}</p>
        <div class="qg__meta">
          <span v-if="typeof row.score === 'number'">{{ $t('gainos.qgos.score', { score: Math.round(row.score * 100) }) }}</span>
          <span>{{ $t('gainos.qgos.evidenceCount', { count: row.evidence.length }) }}</span>
          <span>{{ fmt(row.createdAt) }}</span>
        </div>
      </li>
    </ol>

    <div v-if="selected || detailLoading" class="qg__overlay" @click.self="closeDetail">
      <section class="qg__drawer" role="dialog" aria-modal="true" :aria-label="$t('gainos.qgos.detailTitle')">
        <header class="qg__drawer-head">
          <div>
            <span class="qg__stage">{{ $t('gainos.qgos.detailTitle') }}</span>
            <h2>{{ selected?.title ?? $t('gainos.common.loading') }}</h2>
          </div>
          <button type="button" class="qg__close" :aria-label="$t('gainos.common.cancel')" @click="closeDetail">×</button>
        </header>

        <div class="qg__drawer-body">
          <p v-if="detailLoading" class="qg__state">{{ $t('gainos.common.loading') }}</p>
          <ErrorNotice v-else-if="detailError" :title="detailError.title" :why="detailError.why" :next="detailError.next" :code="detailError.code" />
          <template v-else-if="selected">
            <div class="qg__block">
              <h3>{{ $t('gainos.qgos.nextStep') }}</h3>
              <p>{{ selected.nextStep }}</p>
            </div>

            <div class="qg__block">
              <h3>{{ $t('gainos.qgos.evidenceTitle') }}</h3>
              <ul class="qg__evidence">
                <li v-for="(item, i) in selected.evidence" :key="i" class="qg__evidence-card">
                  <span class="qg__evidence-type">{{ evidenceTypeLabel(item.type) }}</span>
                  <a v-if="item.url" :href="item.url" target="_blank" rel="noreferrer noopener">{{ item.url }}</a>
                  <p v-if="item.support">{{ item.support }}</p>
                  <small v-if="item.retrievedAt">{{ fmt(item.retrievedAt) }}</small>
                </li>
              </ul>
            </div>

            <div class="qg__block">
              <h3>{{ $t('gainos.qgos.saoTitle') }}</h3>
              <p v-if="!selected.sao" class="qg__muted">{{ $t('gainos.qgos.saoPending') }}</p>
              <template v-else>
                <p>
                  <span class="qg__state-badge" :class="selected.sao.state === 'ACCEPTED' ? 'qg__state-badge--converted' : 'qg__state-badge--dropped'">
                    {{ selected.sao.state === 'ACCEPTED' ? $t('gainos.qgos.saoAccepted') : $t('gainos.qgos.saoDeclined') }}
                  </span>
                  <span class="qg__muted"> · {{ fmt(selected.sao.decidedAt) }}</span>
                </p>
                <p v-if="selected.sao.reason" class="qg__muted">{{ $t('gainos.qgos.declineReason') }}：{{ selected.sao.reason }}</p>
              </template>
            </div>

            <div v-if="selected.state === 'OPEN'" class="qg__block">
              <h3>{{ $t('gainos.qgos.decideTitle') }}</h3>
              <div v-if="declineArmed" class="qg__decline">
                <input v-model="declineReason" type="text" maxlength="1000" :placeholder="$t('gainos.qgos.declineReasonHint')" />
              </div>
              <div class="qg__actions">
                <button type="button" class="qg__btn qg__btn--primary" :disabled="actionBusy" @click="accept">
                  {{ actionBusy ? $t('gainos.common.loading') : $t('gainos.qgos.accept') }}
                </button>
                <button
                  type="button"
                  class="qg__btn qg__btn--danger"
                  :disabled="actionBusy || (declineArmed && !declineReason.trim())"
                  @click="decline"
                >
                  {{ declineArmed ? $t('gainos.qgos.declineConfirm') : $t('gainos.qgos.decline') }}
                </button>
              </div>
            </div>

            <div v-if="hasSaoAccepted" class="qg__block">
              <h3>{{ $t('gainos.qgos.outcomeTitle') }}</h3>
              <div class="qg__outcome-form">
                <select v-model="outcomeValue" :aria-label="$t('gainos.qgos.outcomeTitle')">
                  <option v-for="value in OUTCOME_VALUES" :key="value" :value="value">{{ outcomeLabel(value) }}</option>
                </select>
                <input v-model="outcomeOccurredAt" type="datetime-local" :aria-label="$t('gainos.qgos.occurredAt')" />
                <input v-model="outcomeNote" type="text" maxlength="2000" :placeholder="$t('gainos.qgos.outcomeNoteHint')" />
                <button type="button" class="qg__btn qg__btn--primary" :disabled="actionBusy" @click="submitOutcome">
                  {{ actionBusy ? $t('gainos.common.loading') : $t('gainos.qgos.outcomeSubmit') }}
                </button>
              </div>
              <ul v-if="selected.outcomes?.length" class="qg__outcomes">
                <li v-for="outcome in selected.outcomes" :key="outcome.id">
                  <span class="qg__outcome-badge">{{ outcomeLabel(outcome.outcome) }}</span>
                  <span class="qg__muted">{{ fmt(outcome.occurredAt) }} · {{ outcome.source }}</span>
                  <p v-if="outcome.note">{{ outcome.note }}</p>
                </li>
              </ul>
            </div>

            <ErrorNotice v-if="actionError" :title="actionError.title" :why="actionError.why" :next="actionError.next" :code="actionError.code" />
          </template>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.qg {
  padding: clamp(18px, 2.4vw, 32px) clamp(18px, 2.4vw, 34px) clamp(32px, 4vh, 48px);
  max-width: 1280px;
  margin: 0 auto;
  display: grid;
  gap: 16px;
}

.qg__head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
.qg__stage { font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--gs-fg-subtle); }
.qg__head h1 { margin: 6px 0 4px; font-size: 24px; }
.qg__head p { margin: 0; color: var(--gs-fg-muted); font-size: 13.5px; }
.qg__head-actions { display: flex; gap: 8px; align-items: center; }

.qg__btn,
.qg__link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--gs-border);
  background: var(--gs-bg);
  color: var(--gs-fg);
  font-size: 13px;
  cursor: pointer;
  text-decoration: none;
}

.qg__btn--primary { background: var(--gs-accent, #2563eb); border-color: transparent; color: #fff; }
.qg__btn--danger { color: var(--gs-danger); border-color: var(--gs-danger-border); }
.qg__btn:disabled { opacity: 0.55; cursor: not-allowed; }

.qg__tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.qg__tab { padding: 6px 12px; border-radius: 999px; border: 1px solid var(--gs-border); background: transparent; color: var(--gs-fg-muted); cursor: pointer; font-size: 13px; }
.qg__tab.is-active { background: var(--gs-divider); color: var(--gs-fg); font-weight: 600; }

.qg__notice { margin: 0; padding: 10px 12px; border-radius: 8px; background: var(--gs-divider); font-size: 13px; }
.qg__state { color: var(--gs-fg-muted); }
.qg__empty { display: grid; gap: 6px; padding: 40px 0; text-align: center; }
.qg__empty-title { margin: 0; font-size: 16px; font-weight: 600; }
.qg__empty-desc { margin: 0; color: var(--gs-fg-muted); font-size: 13.5px; }
.qg__empty .qg__btn { margin: 12px auto 0; }

.qg__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.qg__card { border: 1px solid var(--gs-border); border-radius: 12px; padding: 14px 16px; cursor: pointer; background: var(--gs-bg); }
.qg__card:hover { border-color: var(--gs-accent, #2563eb); }
.qg__card-head { display: flex; justify-content: space-between; gap: 10px; align-items: center; }
.qg__card-head h2 { margin: 0; font-size: 16px; }
.qg__next { margin: 8px 0 6px; font-size: 13.5px; color: var(--gs-fg); }
.qg__meta { display: flex; gap: 12px; font-size: 12px; color: var(--gs-fg-subtle); }

.qg__state-badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; background: var(--gs-divider); color: var(--gs-fg-muted); }
.qg__state-badge--open { background: rgba(37, 99, 235, 0.12); color: var(--gs-accent, #2563eb); }
.qg__state-badge--converted { background: rgba(22, 163, 74, 0.14); color: #15803d; }
.qg__state-badge--dropped { background: var(--gs-danger-bg); color: var(--gs-danger); }

.qg__overlay { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex; justify-content: flex-end; z-index: 60; }
.qg__drawer { width: min(560px, 94vw); height: 100%; background: var(--gs-bg); display: flex; flex-direction: column; box-shadow: -12px 0 32px rgba(15, 23, 42, 0.18); }
.qg__drawer-head { display: flex; justify-content: space-between; align-items: flex-start; padding: 18px 20px; border-bottom: 1px solid var(--gs-divider); }
.qg__drawer-head h2 { margin: 6px 0 0; font-size: 18px; }
.qg__close { border: none; background: none; font-size: 20px; color: var(--gs-fg-muted); cursor: pointer; }
.qg__drawer-body { padding: 16px 20px 32px; overflow-y: auto; display: grid; gap: 16px; }

.qg__block h3 { margin: 0 0 8px; font-size: 14px; }
.qg__block p { margin: 4px 0; font-size: 13.5px; }
.qg__muted { color: var(--gs-fg-muted); font-size: 12.5px; }

.qg__evidence { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.qg__evidence-card { border: 1px solid var(--gs-border); border-radius: 10px; padding: 10px 12px; display: grid; gap: 4px; }
.qg__evidence-type { font-size: 12px; color: var(--gs-fg-subtle); text-transform: uppercase; letter-spacing: 0.05em; }
.qg__evidence-card a { font-size: 12.5px; word-break: break-all; color: var(--gs-accent, #2563eb); }
.qg__evidence-card p { margin: 0; font-size: 13px; }
.qg__evidence-card small { color: var(--gs-fg-subtle); }

.qg__actions { display: flex; gap: 8px; }
.qg__decline { margin-bottom: 8px; }
.qg__decline input { width: 100%; padding: 8px 10px; border: 1px solid var(--gs-border); border-radius: 8px; background: var(--gs-bg); color: var(--gs-fg); }

.qg__outcome-form { display: grid; gap: 8px; }
.qg__outcome-form select,
.qg__outcome-form input { padding: 8px 10px; border: 1px solid var(--gs-border); border-radius: 8px; background: var(--gs-bg); color: var(--gs-fg); }
.qg__outcomes { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 8px; }
.qg__outcomes li { border-left: 3px solid var(--gs-border); padding-left: 10px; }
.qg__outcome-badge { font-weight: 600; font-size: 13px; margin-right: 8px; }
</style>
