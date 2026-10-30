<script lang="ts" setup>
import { onMounted, ref } from 'vue';

import { $t } from '#/locales';

import { failureText, gainosApi, type DeletionRequestView } from '#/api/gainos';

defineOptions({ name: 'SettingsPrivacy' });

const STORAGE_KEY = 'gainos.dsr.requests.v1';

interface TrackedRequest {
  id: string;
  subjectType: string;
  subjectId: string;
  createdAt: string;
}

const form = ref({
  subjectType: 'company' as 'company' | 'contact',
  subjectId: '',
  reason: 'erasure',
  requestRef: '',
});
const submitting = ref(false);
const formError = ref<{ title: string; next?: string } | null>(null);
const notice = ref<string | null>(null);

const tracked = ref<TrackedRequest[]>([]);
const details = ref<Record<string, DeletionRequestView>>({});
const refreshing = ref(false);

const lookupId = ref('');
const lookupError = ref<{ title: string; next?: string } | null>(null);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function statusTone(status?: string): string {
  if (status === 'COMPLETED') return 'is-ok';
  if (status === 'FAILED') return 'is-bad';
  if (status === 'ERASING' || status === 'FROZEN') return 'is-warn';
  return 'is-muted';
}

function fmtTime(value?: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tracked.value.slice(0, 50)));
  } catch {
    /* 本地记录失败不影响服务端请求 */
  }
}

function remember(id: string, subjectType: string, subjectId: string, createdAt: string): void {
  if (!tracked.value.some((item) => item.id === id)) {
    tracked.value.unshift({ id, subjectType, subjectId, createdAt });
    persist();
  }
}

async function refresh(): Promise<void> {
  refreshing.value = true;
  const results = await Promise.allSettled(
    tracked.value.map(async (item) => ({ id: item.id, detail: await gainosApi.deletionRequest(item.id) })),
  );
  for (const result of results) {
    if (result.status === 'fulfilled') details.value[result.value.id] = result.value.detail;
  }
  refreshing.value = false;
}

async function submit(): Promise<void> {
  formError.value = null;
  notice.value = null;
  const subjectId = form.value.subjectId.trim();
  if (!UUID.test(subjectId)) {
    formError.value = { title: $t('gainos.privacy.invalidId'), next: $t('gainos.privacy.invalidIdHint') };
    return;
  }
  submitting.value = true;
  try {
    const created = await gainosApi.createDeletionRequest({
      subjectType: form.value.subjectType,
      subjectId,
      reason: form.value.reason,
      ...(form.value.requestRef.trim() ? { requestRef: form.value.requestRef.trim() } : {}),
    });
    details.value[created.id] = created;
    remember(created.id, created.subjectType, created.subjectId, created.createdAt);
    notice.value = $t('gainos.privacy.submitted', { id: created.id });
    form.value.subjectId = '';
    form.value.requestRef = '';
    await refresh();
  } catch (err) {
    formError.value = failureText(err);
  } finally {
    submitting.value = false;
  }
}

async function lookup(): Promise<void> {
  lookupError.value = null;
  const id = lookupId.value.trim();
  if (!UUID.test(id)) {
    lookupError.value = { title: $t('gainos.privacy.invalidId'), next: $t('gainos.privacy.invalidIdHint') };
    return;
  }
  try {
    const detail = await gainosApi.deletionRequest(id);
    details.value[id] = detail;
    remember(detail.id, detail.subjectType, detail.subjectId, detail.createdAt);
    notice.value = $t('gainos.privacy.found', { id });
    lookupId.value = '';
  } catch (err) {
    lookupError.value = failureText(err);
  }
}

onMounted(() => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) tracked.value = JSON.parse(raw) as TrackedRequest[];
  } catch {
    tracked.value = [];
  }
  void refresh();
});
</script>

<template>
  <div class="pv">
    <header class="pv__head">
      <div>
        <h1>{{ $t('gainos.privacy.title') }}</h1>
        <p>{{ $t('gainos.privacy.subtitle') }}</p>
      </div>
      <button class="pv__refresh" type="button" :disabled="refreshing" @click="refresh">
        {{ refreshing ? $t('gainos.privacy.refreshing') : $t('gainos.common.refresh') }}
      </button>
    </header>

    <p v-if="notice" class="pv__notice" role="status">{{ notice }}</p>

    <section class="pv__grid">
      <article class="pv__card">
        <h2>{{ $t('gainos.privacy.rightsTitle') }}</h2>
        <ul class="pv__list">
          <li>{{ $t('gainos.privacy.rightAccess') }}</li>
          <li>{{ $t('gainos.privacy.rightErasure') }}</li>
          <li>{{ $t('gainos.privacy.rightObjection') }}</li>
          <li>{{ $t('gainos.privacy.rightResponse') }}</li>
        </ul>
        <p class="pv__muted">{{ $t('gainos.privacy.scopeNote') }}</p>
      </article>

      <article class="pv__card">
        <h2>{{ $t('gainos.privacy.formTitle') }}</h2>
        <p class="pv__muted">{{ $t('gainos.privacy.formDesc') }}</p>
        <form class="pv__form" @submit.prevent="submit">
          <label class="pv__field"><span>{{ $t('gainos.privacy.subjectType') }}</span>
            <select v-model="form.subjectType">
              <option value="company">{{ $t('gainos.privacy.subjectCompany') }}</option>
              <option value="contact">{{ $t('gainos.privacy.subjectContact') }}</option>
            </select>
          </label>
          <label class="pv__field"><span>{{ $t('gainos.privacy.subjectId') }}</span>
            <input v-model="form.subjectId" :placeholder="$t('gainos.privacy.subjectIdHint')" />
          </label>
          <label class="pv__field"><span>{{ $t('gainos.privacy.reason') }}</span>
            <select v-model="form.reason">
              <option value="erasure">{{ $t('gainos.privacy.reasonErasure') }}</option>
              <option value="objection">{{ $t('gainos.privacy.reasonObjection') }}</option>
              <option value="legal">{{ $t('gainos.privacy.reasonLegal') }}</option>
              <option value="manual">{{ $t('gainos.privacy.reasonManual') }}</option>
            </select>
          </label>
          <label class="pv__field"><span>{{ $t('gainos.privacy.requestRef') }}</span>
            <input v-model="form.requestRef" :placeholder="$t('gainos.privacy.requestRefHint')" maxlength="200" />
          </label>
          <div v-if="formError" class="pv__error" role="alert"><strong>{{ formError.title }}</strong><span v-if="formError.next">{{ formError.next }}</span></div>
          <div class="pv__actions">
            <button class="pv__cta" type="submit" :disabled="submitting">{{ submitting ? $t('gainos.privacy.submitting') : $t('gainos.privacy.submit') }}</button>
            <span class="pv__muted">{{ $t('gainos.privacy.asyncNote') }}</span>
          </div>
        </form>
      </article>
    </section>

    <section class="pv__card">
      <div class="pv__row">
        <h2>{{ $t('gainos.privacy.trackedTitle') }}</h2>
        <form class="pv__lookup" @submit.prevent="lookup">
          <input v-model="lookupId" :placeholder="$t('gainos.privacy.lookupHint')" />
          <button class="pv__secondary" type="submit">{{ $t('gainos.privacy.lookup') }}</button>
        </form>
      </div>
      <p v-if="lookupError" class="pv__error" role="alert"><strong>{{ lookupError.title }}</strong><span v-if="lookupError.next">{{ lookupError.next }}</span></p>
      <p v-if="tracked.length === 0" class="pv__muted">{{ $t('gainos.privacy.noTracked') }}</p>
      <table v-else class="pv__table">
        <thead>
          <tr><th>{{ $t('gainos.privacy.requestId') }}</th><th>{{ $t('gainos.privacy.subject') }}</th><th>{{ $t('gainos.privacy.status') }}</th><th>{{ $t('gainos.privacy.receipt') }}</th><th>{{ $t('gainos.privacy.createdAt') }}</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in tracked" :key="item.id">
            <td class="pv__mono">{{ item.id }}</td>
            <td>{{ item.subjectType }}<br /><span class="pv__mono pv__muted">{{ item.subjectId }}</span></td>
            <td>
              <span v-if="details[item.id]" class="pv__badge" :class="statusTone(details[item.id]?.status)">{{ details[item.id]?.status }}</span>
              <span v-else class="pv__muted">{{ $t('gainos.privacy.unknownStatus') }}</span>
            </td>
            <td>
              <template v-if="details[item.id]?.receipt">
                <span class="pv__muted">{{ $t('gainos.privacy.receiptSummary', {
                  contacts: details[item.id]?.receipt?.contactsErased ?? 0,
                  points: details[item.id]?.receipt?.contactPointsErased ?? 0,
                  evidence: details[item.id]?.receipt?.fieldEvidenceErased ?? 0,
                }) }}</span>
              </template>
              <span v-else class="pv__muted">—</span>
            </td>
            <td>{{ fmtTime(details[item.id]?.createdAt ?? item.createdAt) }}</td>
          </tr>
        </tbody>
      </table>
      <p class="pv__muted">{{ $t('gainos.privacy.trackedNote') }}</p>
    </section>
  </div>
</template>

<style scoped>
.pv {
  padding: clamp(18px, 2.4vw, 32px) clamp(18px, 2.4vw, 34px) clamp(32px, 4vh, 48px);
  max-width: 1280px; margin: 0 auto; display: grid; gap: 16px;
}
.pv__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.pv__head h1 { margin: 0; font-size: 22px; color: var(--gs-fg); }
.pv__head p { margin: 6px 0 0; font-size: 13px; color: var(--gs-fg-muted); line-height: 1.7; max-width: 680px; }
.pv__refresh { border: 1px solid var(--gs-border-strong); background: var(--gs-surface); border-radius: 9px; padding: 7px 14px; font-size: 12.5px; cursor: pointer; }
.pv__grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); gap: 14px; }
.pv__card { background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px; padding: 18px 20px; display: grid; gap: 10px; align-content: start; }
.pv__card h2 { margin: 0; font-size: 15px; font-weight: 650; color: var(--gs-fg); }
.pv__list { margin: 0; padding-left: 18px; color: var(--gs-fg-2); font-size: 13px; line-height: 1.9; }
.pv__muted { margin: 0; color: var(--gs-fg-subtle); font-size: 12.5px; line-height: 1.7; }
.pv__notice { margin: 0; padding: 10px 14px; border-radius: 10px; background: var(--gs-accent-soft); color: var(--gs-accent-strong); font-size: 13px; font-weight: 600; word-break: break-all; }
.pv__form { display: grid; gap: 10px; }
.pv__field { display: grid; gap: 5px; font-size: 12.5px; color: var(--gs-fg-2); }
.pv__field select, .pv__field input, .pv__lookup input { border: 1px solid var(--gs-border-strong); border-radius: 9px; padding: 8px 10px; font-size: 13px; background: var(--gs-surface); color: var(--gs-fg); }
.pv__actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.pv__cta { border: 0; border-radius: 10px; padding: 9px 18px; background: var(--gs-accent); color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; }
.pv__cta:disabled { opacity: .45; cursor: not-allowed; }
.pv__secondary { border: 1px solid var(--gs-border-strong); background: var(--gs-surface); border-radius: 9px; padding: 8px 14px; font-size: 12.5px; cursor: pointer; }
.pv__error { display: grid; gap: 2px; font-size: 12.5px; color: var(--gs-warn); }
.pv__row { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.pv__lookup { display: flex; gap: 8px; }
.pv__lookup input { min-width: 280px; }
.pv__table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.pv__table th, .pv__table td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--gs-border); vertical-align: top; }
.pv__table th { color: var(--gs-fg-muted); font-weight: 600; background: var(--gs-bg-soft, #f8fafc); white-space: nowrap; }
.pv__table tr:last-child td { border-bottom: 0; }
.pv__mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; word-break: break-all; }
.pv__badge { border-radius: 999px; padding: 2px 9px; font-size: 11px; font-weight: 650; background: #f1f5f9; color: #475569; }
.pv__badge.is-ok { background: #e8f9f0; color: #008f52; }
.pv__badge.is-warn { background: #fef3c7; color: #b45309; }
.pv__badge.is-bad { background: #fee2e2; color: #b91c1c; }
@media (max-width: 900px) { .pv__grid { grid-template-columns: 1fr; } .pv__head { flex-direction: column; } .pv__lookup { width: 100%; } .pv__lookup input { min-width: 0; flex: 1; } }
</style>
