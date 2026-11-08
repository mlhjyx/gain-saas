<script lang="ts" setup>
/**
 * 设置 · 禁联名单（C2，P6 设计 §3「设置：…禁联名单…」）。
 *
 * 数据走 BFF 既有代理（GET/POST /api/suppressions、DELETE /api/suppressions/:id，admin）。
 * 注意引擎语义：DELETE 是「解除申请」（append-only release request），不会物理删除——
 * 页面文案如实呈现，不给「删除成功」的假象。
 */
import { onMounted, reactive, ref } from 'vue';

import { $t } from '#/locales';

import {
  failureText,
  gainosApi,
  type SuppressionReason,
  type SuppressionRecordView,
  type SuppressionType,
} from '#/api/gainos';

defineOptions({ name: 'SettingsSuppressions' });

const TYPES: SuppressionType[] = ['email', 'domain', 'company_name'];
const REASONS: SuppressionReason[] = ['manual', 'unsubscribe', 'bounce', 'complaint', 'legal'];

const rows = ref<SuppressionRecordView[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const form = reactive<{ reason: SuppressionReason; type: SuppressionType; value: string }>({
  reason: 'manual',
  type: 'email',
  value: '',
});
const adding = ref(false);
const addError = ref<string | null>(null);

const releasing = ref<string | null>(null);

function typeLabel(type: string): string {
  const key = `gainos.suppressions.type.${type}`;
  const value = $t(key);
  return value === key ? type : value;
}

function reasonLabel(reason: string | null): string {
  if (!reason) return '—';
  const key = `gainos.suppressions.reason.${reason}`;
  const value = $t(key);
  return value === key ? '—' : value;
}

function protectionLabel(protection: string): string {
  return protection === 'LEGAL' ? $t('gainos.suppressions.protectionLegal') : $t('gainos.suppressions.protectionPreference');
}

const limit = ref(50);
const hasMore = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const page = await gainosApi.suppressions({ limit: limit.value });
    rows.value = page.data ?? [];
    hasMore.value = Boolean((page as unknown as { page?: { has_more?: boolean } }).page?.has_more);
  } catch (err) {
    error.value = failureText(err).title;
  } finally {
    loading.value = false;
  }
}

function loadMore(): void {
  limit.value += 50;
  void load();
}

async function add(): Promise<void> {
  addError.value = null;
  const value = form.value.trim();
  if (!value) {
    addError.value = $t('gainos.suppressions.errValueRequired');
    return;
  }
  if (form.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    addError.value = $t('gainos.suppressions.errEmail');
    return;
  }
  adding.value = true;
  try {
    await gainosApi.createSuppression({ reason: form.reason, type: form.type, value });
    form.value = '';
    notice.value = $t('gainos.suppressions.added');
    await load();
  } catch (err) {
    addError.value = failureText(err).title;
  } finally {
    adding.value = false;
  }
}

async function release(row: SuppressionRecordView): Promise<void> {
  if (!window.confirm($t('gainos.suppressions.releaseConfirm', { value: row.value }))) return;
  releasing.value = row.id;
  try {
    const result = await gainosApi.requestSuppressionRelease(row.id);
    notice.value = result?.releaseRequested
      ? $t('gainos.suppressions.releaseRequested')
      : $t('gainos.suppressions.released');
    await load();
  } catch (err) {
    error.value = failureText(err).title;
  } finally {
    releasing.value = null;
  }
}

onMounted(load);
</script>

<template>
  <div class="sp">
    <header class="sp__head">
      <div>
        <h1>{{ $t('gainos.suppressions.title') }}</h1>
        <p>{{ $t('gainos.suppressions.subtitle') }}</p>
      </div>
    </header>

    <p v-if="notice" class="sp__notice" role="status">{{ notice }}</p>

    <section class="sp__card">
      <h2>{{ $t('gainos.suppressions.addTitle') }}</h2>
      <div class="sp__form">
        <label>
          <span>{{ $t('gainos.suppressions.typeLabel') }}</span>
          <select v-model="form.type">
            <option v-for="type in TYPES" :key="type" :value="type">{{ typeLabel(type) }}</option>
          </select>
        </label>
        <label class="sp__grow">
          <span>{{ $t('gainos.suppressions.valueLabel') }}</span>
          <input
            v-model="form.value"
            :placeholder="$t(`gainos.suppressions.valuePlaceholder.${form.type}`)"
            maxlength="2048"
            @keyup.enter="add"
          />
        </label>
        <label>
          <span>{{ $t('gainos.suppressions.reasonLabel') }}</span>
          <select v-model="form.reason">
            <option v-for="reason in REASONS" :key="reason" :value="reason">{{ reasonLabel(reason) }}</option>
          </select>
        </label>
        <button class="sp__cta" type="button" :disabled="adding" @click="add">
          {{ adding ? $t('gainos.common.loading') : $t('gainos.suppressions.add') }}
        </button>
      </div>
      <p v-if="addError" class="sp__err" role="alert">{{ addError }}</p>
      <p class="sp__hint">{{ $t('gainos.suppressions.addHint') }}</p>
    </section>

    <div v-if="loading" class="sp__state">{{ $t('gainos.common.loading') }}</div>
    <div v-else-if="error" class="sp__state sp__state--err">
      {{ error }}
      <button type="button" @click="load">{{ $t('gainos.common.retry') }}</button>
    </div>
    <section v-else class="sp__card">
      <h2>{{ $t('gainos.suppressions.listTitle', { count: rows.length }) }}</h2>
      <p v-if="rows.length === 0" class="sp__empty">{{ $t('gainos.suppressions.empty') }}</p>
      <table v-else class="sp__table">
        <thead>
          <tr>
            <th>{{ $t('gainos.suppressions.colValue') }}</th>
            <th>{{ $t('gainos.suppressions.colType') }}</th>
            <th>{{ $t('gainos.suppressions.colReason') }}</th>
            <th>{{ $t('gainos.suppressions.colProtection') }}</th>
            <th>{{ $t('gainos.suppressions.colCreated') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id">
            <td class="sp__value">{{ row.value }}</td>
            <td>{{ typeLabel(row.type) }}</td>
            <td>{{ reasonLabel(row.reason) }}</td>
            <td>
              <span class="gs-badge" :class="row.protectionClass === 'LEGAL' ? 'gs-badge--warning' : 'gs-badge--neutral'">
                {{ protectionLabel(row.protectionClass) }}
              </span>
            </td>
            <td>{{ new Date(row.createdAt).toLocaleDateString() }}</td>
            <td class="sp__row-actions">
              <button
                class="sp__link"
                type="button"
                :disabled="releasing === row.id"
                @click="release(row)"
              >
                {{ $t('gainos.suppressions.release') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
        <p v-if="hasMore" class="sp__hint sp__more">
          <button type="button" class="sp__link" @click="loadMore">{{ $t('gainos.suppressions.loadMore') }}</button>
        </p>
      <p class="sp__hint">{{ $t('gainos.suppressions.releaseHint') }}</p>
    </section>
  </div>
</template>

<style scoped>
.sp { display: grid; gap: 16px; max-width: 1280px; margin: 0 auto; padding: clamp(18px, 2.4vw, 32px) clamp(18px, 2.4vw, 34px) clamp(32px, 4vh, 48px); }
.sp__head h1 { margin: 0; font-size: 20px; font-weight: 650; color: var(--gs-fg); }
.sp__head p { margin: 6px 0 0; font-size: 13.5px; color: var(--gs-fg-muted); line-height: 1.7; }
.sp__notice { margin: 0; padding: 10px 12px; border-radius: 8px; background: var(--gs-accent-soft); color: var(--gs-accent-strong); font-size: 13px; }
.sp__card { background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px; padding: 18px 20px; display: grid; gap: 12px; }
.sp__card h2 { margin: 0; font-size: 15px; font-weight: 650; color: var(--gs-fg); }
.sp__form { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
.sp__form label { display: grid; gap: 4px; font-size: 12.5px; color: var(--gs-fg-muted); }
.sp__form select, .sp__form input { border: 1px solid var(--gs-border-strong); border-radius: 8px; padding: 7px 10px; font-size: 13px; background: var(--gs-surface); color: var(--gs-fg); }
.sp__grow { flex: 1 1 240px; }
.sp__grow input { width: 100%; box-sizing: border-box; }
.sp__cta { border: 1px solid var(--gs-accent); background: var(--gs-accent-cta); color: var(--gs-accent-cta-fg); font-size: 13px; font-weight: 600; border-radius: 9px; padding: 8px 16px; cursor: pointer; }
.sp__cta:disabled { opacity: 0.6; cursor: progress; }
.sp__hint { margin: 0; font-size: 12.5px; color: var(--gs-fg-subtle); line-height: 1.7; }
.sp__err { margin: 0; font-size: 12.5px; color: var(--gs-danger); }
.sp__state { color: var(--gs-fg-muted); font-size: 13px; }
.sp__state--err { color: var(--gs-danger); display: flex; gap: 8px; align-items: center; }
.sp__more { text-align: center; }
.sp__empty { margin: 0; color: var(--gs-fg-muted); font-size: 13px; }
.sp__table { width: 100%; border-collapse: collapse; font-size: 13px; }
.sp__table th { text-align: left; font-size: 12px; font-weight: 600; color: var(--gs-fg-subtle); padding: 6px 10px; border-bottom: 1px solid var(--gs-border); }
.sp__table td { padding: 8px 10px; border-bottom: 1px solid var(--gs-divider); color: var(--gs-fg-2); }
.sp__value { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.sp__row-actions { text-align: right; }
.sp__link { border: none; background: transparent; color: var(--gs-warn); font-size: 13px; cursor: pointer; }
.sp__link:disabled { opacity: 0.5; cursor: progress; }
</style>
