<script lang="ts" setup>
/**
 * 触达批次（M2 步 11-2）：批次列表、草稿预览/编辑、提交审批与批准/拒绝。
 * 批准只入待发队列；发送通道默认关，本页不触发任何外发。
 */
import type { OutreachBatchDetail, OutreachBatchSummary, OutreachDraftView } from '#/api/gainos';

import { computed, onMounted, ref } from 'vue';

import { glossaryStatus, statusClass } from '@gain-saas/shared';
import { preferences } from '@vben/preferences';

import { $t } from '#/locales';

import { failureText, gainosApi } from '#/api/gainos';

defineOptions({ name: 'OutreachBatches' });

// 内嵌在「商机与触达」枢纽时不渲染自己的页头。
defineProps<{ embedded?: boolean }>();

const batches = ref<OutreachBatchSummary[]>([]);
const detail = ref<OutreachBatchDetail | null>(null);
const loading = ref(true);
const detailLoading = ref(false);
const error = ref<{ title: string; why?: string; next?: string } | null>(null);
const notice = ref<string | null>(null);
const busy = ref<string | null>(null);

const showCreate = ref(false);
const batchName = ref('');

interface DraftForm {
  contactRef: string;
  recipientEmail: string;
  companyName: string;
  subject: string;
  body: string;
}
const draftDialog = ref<{ mode: 'create' | 'edit'; draftId?: string } | null>(null);
const draftForm = ref<DraftForm>(emptyDraft());
const draftError = ref<string | null>(null);

const decisionReason = ref('');

function emptyDraft(): DraftForm {
  return { contactRef: '', recipientEmail: '', companyName: '', subject: '', body: '' };
}

function label(domain: 'outreachBatch' | 'outreachDraft', value: string | undefined | null): string {
  const entry = glossaryStatus(domain, value ?? undefined, preferences.app.locale);
  return entry?.label ?? $t('gainos.outreach.unknownStatus');
}
function tone(domain: 'outreachBatch' | 'outreachDraft', value: string | undefined | null): string {
  return statusClass(glossaryStatus(domain, value ?? undefined, preferences.app.locale)?.tone ?? 'neutral');
}
function when(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

const latestApproval = computed(() => detail.value?.approvals[0] ?? null);
const canEdit = computed(() => detail.value?.status === 'DRAFT');
const canSubmit = computed(() => canEdit.value && (detail.value?.drafts.length ?? 0) > 0);
const canDecide = computed(
  () => detail.value?.status === 'PENDING_APPROVAL' && latestApproval.value?.state === 'PENDING',
);
const canReopen = computed(
  () => detail.value?.status === 'DECLINED' || detail.value?.status === 'EXPIRED',
);

async function loadBatches(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    batches.value = await gainosApi.outreachBatches();
    if (!detail.value && batches.value[0]) await selectBatch(batches.value[0].id);
  } catch (err) {
    error.value = failureText(err);
  } finally {
    loading.value = false;
  }
}

async function selectBatch(batchId: string): Promise<void> {
  detailLoading.value = true;
  error.value = null;
  notice.value = null;
  try {
    detail.value = await gainosApi.outreachBatch(batchId);
  } catch (err) {
    error.value = failureText(err);
  } finally {
    detailLoading.value = false;
  }
}

async function createBatch(): Promise<void> {
  if (!batchName.value.trim()) return;
  busy.value = 'create';
  error.value = null;
  try {
    const created = await gainosApi.createOutreachBatch({ name: batchName.value.trim() });
    showCreate.value = false;
    batchName.value = '';
    await loadBatches();
    await selectBatch(created.id);
  } catch (err) {
    error.value = failureText(err);
  } finally {
    busy.value = null;
  }
}

function openCreateDraft(): void {
  draftForm.value = emptyDraft();
  draftError.value = null;
  draftDialog.value = { mode: 'create' };
}
function openEditDraft(draft: OutreachDraftView): void {
  draftForm.value = {
    contactRef: draft.contactRef,
    recipientEmail: draft.recipientEmail,
    companyName: draft.companyName ?? '',
    subject: draft.subject,
    body: draft.body,
  };
  draftError.value = null;
  draftDialog.value = { mode: 'edit', draftId: draft.id };
}

async function saveDraft(): Promise<void> {
  if (!detail.value || !draftDialog.value) return;
  draftError.value = null;
  const input = {
    contactRef: draftForm.value.contactRef.trim(),
    recipientEmail: draftForm.value.recipientEmail.trim(),
    ...(draftForm.value.companyName.trim() ? { companyName: draftForm.value.companyName.trim() } : {}),
    subject: draftForm.value.subject.trim(),
    body: draftForm.value.body.trim(),
  };
  if (!input.contactRef || !input.recipientEmail || !input.subject || !input.body) {
    draftError.value = $t('gainos.outreach.draftRequired');
    return;
  }
  busy.value = 'draft';
  try {
    if (draftDialog.value.mode === 'create') {
      await gainosApi.addOutreachDraft(detail.value.id, input);
    } else {
      await gainosApi.updateOutreachDraft(detail.value.id, draftDialog.value.draftId!, input);
    }
    draftDialog.value = null;
    await selectBatch(detail.value.id);
  } catch (err) {
    draftError.value = failureText(err).title;
  } finally {
    busy.value = null;
  }
}

async function removeDraft(draft: OutreachDraftView): Promise<void> {
  if (!detail.value) return;
  busy.value = `remove:${draft.id}`;
  try {
    await gainosApi.removeOutreachDraft(detail.value.id, draft.id);
    await selectBatch(detail.value.id);
  } catch (err) {
    error.value = failureText(err);
  } finally {
    busy.value = null;
  }
}

async function submitBatch(): Promise<void> {
  if (!detail.value) return;
  busy.value = 'submit';
  try {
    await gainosApi.submitOutreachBatch(detail.value.id);
    notice.value = $t('gainos.outreach.submitted');
    await Promise.all([selectBatch(detail.value.id), loadBatches()]);
  } catch (err) {
    error.value = failureText(err);
  } finally {
    busy.value = null;
  }
}

async function decide(decision: 'approve' | 'decline'): Promise<void> {
  if (!detail.value || !latestApproval.value) return;
  busy.value = decision;
  try {
    detail.value = await gainosApi.decideOutreachBatch(
      detail.value.id,
      latestApproval.value.id,
      {
        decision,
        ...(decisionReason.value.trim() ? { reason: decisionReason.value.trim() } : {}),
      },
    );
    decisionReason.value = '';
    notice.value = decision === 'approve' ? $t('gainos.outreach.approved') : $t('gainos.outreach.declined');
    await loadBatches();
  } catch (err) {
    error.value = failureText(err);
  } finally {
    busy.value = null;
  }
}

async function reopen(): Promise<void> {
  if (!detail.value) return;
  busy.value = 'reopen';
  try {
    detail.value = await gainosApi.reopenOutreachBatch(detail.value.id);
    notice.value = $t('gainos.outreach.reopened');
    await loadBatches();
  } catch (err) {
    error.value = failureText(err);
  } finally {
    busy.value = null;
  }
}

function eventLabel(type: string): string {
  const key = `gainos.outreach.event${type}`;
  const text = $t(key);
  return text === key ? $t('gainos.outreach.eventOther') : text;
}

onMounted(loadBatches);
</script>

<template>
  <div class="ob" :class="{ 'is-embedded': embedded }">
    <header class="ob__head">
      <div v-if="!embedded">
        <h2>{{ $t('gainos.outreach.title') }}</h2>
        <p class="ob__sub">{{ $t('gainos.outreach.subtitle') }}</p>
      </div>
      <button class="ob__primary" type="button" @click="showCreate = !showCreate">
        {{ $t('gainos.outreach.newBatch') }}
      </button>
    </header>

    <form v-if="showCreate" class="ob__create" @submit.prevent="createBatch">
      <label>
        {{ $t('gainos.outreach.nameLabel') }}
        <input v-model="batchName" maxlength="200" :placeholder="$t('gainos.outreach.namePlaceholder')" />
      </label>
      <button class="ob__primary" type="submit" :disabled="busy === 'create' || !batchName.trim()">
        {{ $t('gainos.outreach.create') }}
      </button>
      <button class="ob__ghost" type="button" @click="showCreate = false">
        {{ $t('gainos.outreach.cancel') }}
      </button>
    </form>

    <p v-if="error" class="ob__error">
      {{ error.title }}<span v-if="error.why"> · {{ error.why }}</span>
      <span v-if="error.next"> · {{ error.next }}</span>
    </p>
    <p v-if="notice" class="ob__notice">{{ notice }}</p>
    <p v-if="loading" class="ob__muted">{{ $t('gainos.outreach.loading') }}</p>

    <div v-else class="ob__grid">
      <section class="ob__list" :aria-label="$t('gainos.outreach.listTitle')">
        <p v-if="batches.length === 0" class="ob__muted">{{ $t('gainos.outreach.empty') }}</p>
        <button
          v-for="batch in batches"
          :key="batch.id"
          :class="{ 'is-active': detail?.id === batch.id }"
          class="ob__item"
          type="button"
          @click="selectBatch(batch.id)"
        >
          <span class="ob__item-name">{{ batch.name }}</span>
          <span class="gs-badge" :class="tone('outreachBatch', batch.status)">
            {{ label('outreachBatch', batch.status) }}
          </span>
          <span class="ob__item-meta">{{ $t('gainos.outreach.draftCount', { count: batch.draftCount }) }}</span>
        </button>
      </section>

      <section v-if="detail" class="ob__detail">
        <header class="ob__detail-head">
          <div>
            <h3>{{ detail.name }}</h3>
            <span class="gs-badge" :class="tone('outreachBatch', detail.status)">
              {{ label('outreachBatch', detail.status) }}
            </span>
          </div>
          <div class="ob__actions">
            <button v-if="canEdit" class="ob__primary" type="button" @click="openCreateDraft">
              {{ $t('gainos.outreach.addDraft') }}
            </button>
            <button
              v-if="canSubmit"
              class="ob__primary"
              type="button"
              :disabled="busy === 'submit'"
              @click="submitBatch"
            >
              {{ $t('gainos.outreach.submit') }}
            </button>
            <button v-if="canReopen" class="ob__ghost" type="button" @click="reopen">
              {{ $t('gainos.outreach.reopen') }}
            </button>
          </div>
        </header>

        <p v-if="detailLoading" class="ob__muted">{{ $t('gainos.outreach.loading') }}</p>

        <section v-if="detail.status === 'PENDING_APPROVAL' && latestApproval" class="ob__approval">
          <h4>{{ $t('gainos.outreach.approvalTitle') }}</h4>
          <p class="ob__muted">
            {{ $t('gainos.outreach.approvalExpires', { at: when(latestApproval.expiresAt) }) }}
          </p>
          <label>
            {{ $t('gainos.outreach.decisionReason') }}
            <input v-model="decisionReason" maxlength="500" :placeholder="$t('gainos.outreach.decisionReasonHint')" />
          </label>
          <div class="ob__actions">
            <button class="ob__primary" type="button" :disabled="!canDecide || busy === 'approve'" @click="decide('approve')">
              {{ $t('gainos.outreach.approve') }}
            </button>
            <button class="ob__danger" type="button" :disabled="!canDecide || busy === 'decline'" @click="decide('decline')">
              {{ $t('gainos.outreach.decline') }}
            </button>
          </div>
        </section>

        <p v-if="detail.drafts.length === 0" class="ob__muted">{{ $t('gainos.outreach.noDrafts') }}</p>
        <table v-else class="ob__table">
          <thead>
            <tr>
              <th>{{ $t('gainos.outreach.recipient') }}</th>
              <th>{{ $t('gainos.outreach.company') }}</th>
              <th>{{ $t('gainos.outreach.subject') }}</th>
              <th>{{ $t('gainos.outreach.status') }}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="draft in detail.drafts" :key="draft.id">
              <td>{{ draft.recipientEmail }}</td>
              <td>{{ draft.companyName || '—' }}</td>
              <td>{{ draft.subject }}</td>
              <td>
                <span class="gs-badge" :class="tone('outreachDraft', draft.status)">
                  {{ label('outreachDraft', draft.status) }}
                </span>
              </td>
              <td class="ob__row-actions">
                <button v-if="canEdit" class="ob__link" type="button" @click="openEditDraft(draft)">
                  {{ $t('gainos.outreach.edit') }}
                </button>
                <button v-if="canEdit" class="ob__link ob__link--danger" type="button" @click="removeDraft(draft)">
                  {{ $t('gainos.outreach.remove') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>

        <section class="ob__timeline">
          <h4>{{ $t('gainos.outreach.timeline') }}</h4>
          <ul>
            <li v-for="event in detail.events" :key="event.id">
              <span>{{ eventLabel(event.type) }}</span>
              <span class="ob__muted">{{ when(event.createdAt) }}</span>
            </li>
          </ul>
        </section>
      </section>

      <section v-else class="ob__detail ob__muted">{{ $t('gainos.outreach.selectHint') }}</section>
    </div>

    <div v-if="draftDialog" class="ob__dialog" role="dialog" aria-modal="true">
      <form class="ob__dialog-card" @submit.prevent="saveDraft">
        <h3>{{ draftDialog.mode === 'create' ? $t('gainos.outreach.addDraft') : $t('gainos.outreach.edit') }}</h3>
        <label>
          {{ $t('gainos.outreach.contactRef') }}
          <input v-model="draftForm.contactRef" :placeholder="$t('gainos.outreach.contactRefHint')" />
        </label>
        <label>
          {{ $t('gainos.outreach.recipient') }}
          <input v-model="draftForm.recipientEmail" type="email" maxlength="320" />
        </label>
        <label>
          {{ $t('gainos.outreach.company') }}
          <input v-model="draftForm.companyName" maxlength="200" />
        </label>
        <label>
          {{ $t('gainos.outreach.subject') }}
          <input v-model="draftForm.subject" maxlength="300" />
        </label>
        <label>
          {{ $t('gainos.outreach.body') }}
          <textarea v-model="draftForm.body" rows="6" maxlength="20000" />
        </label>
        <p v-if="draftError" class="ob__error">{{ draftError }}</p>
        <div class="ob__actions">
          <button class="ob__primary" type="submit" :disabled="busy === 'draft'">
            {{ $t('gainos.outreach.save') }}
          </button>
          <button class="ob__ghost" type="button" @click="draftDialog = null">
            {{ $t('gainos.outreach.cancel') }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.ob { width: 100%; max-width: 1280px; margin: 0 auto; padding: clamp(18px, 2.4vw, 32px) clamp(18px, 2.4vw, 34px) clamp(32px, 4vh, 48px); box-sizing: border-box; display: grid; gap: 16px; }
.ob.is-embedded { padding: 0; max-width: none; margin: 0; }
.ob__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.ob__head h2 { margin: 0 0 4px; font-size: 22px; }
.ob__sub { margin: 0; color: var(--gs-muted, #667085); }
.ob__create { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; padding: 12px; border: 1px solid #e4e7ec; border-radius: 10px; }
.ob__grid { display: grid; grid-template-columns: 280px 1fr; gap: 16px; align-items: start; }
.ob__list { display: grid; gap: 8px; }
.ob__item { display: grid; gap: 6px; text-align: left; padding: 12px; border: 1px solid #e4e7ec; border-radius: 10px; background: #fff; cursor: pointer; }
.ob__item.is-active { border-color: var(--gs-accent-cta); box-shadow: 0 0 0 2px var(--gs-accent-soft); }
.ob__item-name { font-weight: 600; }
.ob__item-meta { color: var(--gs-muted, #667085); font-size: 12px; }
.ob__detail { border: 1px solid #e4e7ec; border-radius: 10px; padding: 16px; display: grid; gap: 14px; }
.ob__detail-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.ob__detail-head h3 { margin: 0 0 6px; }
.ob__actions { display: flex; gap: 8px; flex-wrap: wrap; }
.ob__primary, .ob__ghost, .ob__danger { padding: 8px 14px; border-radius: 8px; border: 1px solid transparent; cursor: pointer; }
.ob__primary { background: var(--gs-accent-cta); color: var(--gs-accent-cta-fg); }
.ob__primary:disabled { opacity: 0.5; cursor: not-allowed; }
.ob__ghost { background: #fff; border-color: #d0d5dd; }
.ob__danger { background: #d92d20; color: #fff; }
.ob__link { border: 0; background: none; color: var(--gs-accent-strong); cursor: pointer; padding: 0 6px 0 0; }
.ob__link--danger { color: #d92d20; }
.ob__table { width: 100%; border-collapse: collapse; }
.ob__table th, .ob__table td { text-align: left; padding: 8px; border-bottom: 1px solid #f2f4f7; vertical-align: top; }
.ob__row-actions { white-space: nowrap; }
.ob__approval { border: 1px solid #fedf89; background: #fffaeb; border-radius: 10px; padding: 12px; display: grid; gap: 8px; }
.ob__timeline ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.ob__timeline li { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; }
.ob__muted { color: var(--gs-muted, #667085); }
.ob__error { color: #b42318; margin: 0; }
.ob__notice { color: #067647; margin: 0; }
.ob__dialog { position: fixed; inset: 0; background: rgb(16 24 40 / 45%); display: grid; place-items: center; padding: 24px; z-index: 40; }
.ob__dialog-card { background: #fff; border-radius: 12px; padding: 20px; width: min(560px, 100%); display: grid; gap: 10px; max-height: 90vh; overflow: auto; }
.ob__dialog-card label, .ob__create label, .ob__approval label { display: grid; gap: 4px; font-size: 13px; }
.ob__dialog-card input, .ob__dialog-card textarea, .ob__create input, .ob__approval input { padding: 8px; border: 1px solid #d0d5dd; border-radius: 8px; font: inherit; }
@media (max-width: 860px) { .ob__grid { grid-template-columns: 1fr; } }
</style>
