<script lang="ts" setup>
/**
 * 触达批次（M2 步 11-2）：批次列表、草稿预览/编辑、提交审批与批准/拒绝。
 * 批准只入待发队列；发送通道默认关，本页不触发任何外发。
 */
import type { CanonicalContact, Lead, OutreachBatchDetail, OutreachBatchSummary, OutreachDraftView } from '#/api/gainos';

import { computed, onMounted, ref } from 'vue';

import { Alert, Button, Form, Input, Modal, Select, Table } from 'ant-design-vue';

import { deriveOutreachActions, formatDateTime, glossaryStatus, statusClass } from '@gain-saas/shared';
import { preferences } from '@vben/preferences';

import { $t } from '#/locales';

import PageContainer from '#/components/gainos/page-container.vue';
import PageHeader from '#/components/gainos/page-header.vue';

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
  return formatDateTime(value) || '—';
}

const latestApproval = computed(() => detail.value?.approvals[0] ?? null);
// 按钮可用性统一由共享状态机派生（v3.0 ch07），页面不再自己判断状态。
const flowActions = computed(() =>
  deriveOutreachActions({ status: detail.value?.status, draftCount: detail.value?.drafts.length ?? 0 }),
);
const canEdit = computed(() => flowActions.value.canAddDraft);
const canSubmit = computed(() => flowActions.value.canSubmit);
const canDecide = computed(() => flowActions.value.canApprove && latestApproval.value?.state === 'PENDING');
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

// 从线索选择联系人（审计：触达草稿此前要求手输 contactRef UUID，全站无处可见）。
const pickerOpen = ref(false);
const pickerLeads = ref<Lead[]>([]);
const pickerLeadId = ref('');
const pickerLeadName = ref('');
const pickerContacts = ref<CanonicalContact[]>([]);
const pickerBusy = ref(false);
const pickerError = ref<string | null>(null);

async function togglePicker(): Promise<void> {
  pickerOpen.value = !pickerOpen.value;
  pickerError.value = null;
  if (!pickerOpen.value || pickerLeads.value.length > 0) return;
  try {
    const data = await gainosApi.leads({ queue: 'recommended', limit: 50 });
    pickerLeads.value = Array.isArray(data) ? data : ((data as { data?: Lead[] })?.data ?? []);
  } catch (err) {
    pickerError.value = failureText(err).title;
  }
}

async function loadPickerContacts(): Promise<void> {
  if (!pickerLeadId.value) return;
  pickerBusy.value = true;
  pickerError.value = null;
  try {
    const pkg = await gainosApi.leadPackage(pickerLeadId.value);
    pickerContacts.value = (pkg as unknown as { contacts?: CanonicalContact[] }).contacts ?? [];
    pickerLeadName.value = pkg.company?.name ?? '';
  } catch (err) {
    pickerError.value = failureText(err).title;
    pickerContacts.value = [];
  } finally {
    pickerBusy.value = false;
  }
}

function pickContact(contact: CanonicalContact): void {
  const email = (contact.contactPoints ?? []).find((point) => String(point.type ?? '').toLowerCase() === 'email');
  draftForm.value.contactRef = contact.id;
  if (email?.value) draftForm.value.recipientEmail = email.value;
  if (pickerLeadName.value) draftForm.value.companyName = pickerLeadName.value;
  pickerOpen.value = false;
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

const draftColumns = [
  { key: 'recipient', dataIndex: 'recipientEmail', title: $t('gainos.outreach.recipient') },
  { key: 'company', dataIndex: 'companyName', title: $t('gainos.outreach.company'), width: 180 },
  { key: 'subject', dataIndex: 'subject', title: $t('gainos.outreach.subject') },
  { key: 'status', dataIndex: 'status', title: $t('gainos.outreach.status'), width: 130 },
  { key: 'actions', dataIndex: 'actions', title: '', width: 130 },
];

const leadOptions = computed(() =>
  pickerLeads.value.map((lead) => ({ value: lead.id, label: lead.company?.name ?? lead.id.slice(0, 8) })),
);

onMounted(loadBatches);
</script>

<template>
  <PageContainer :compact="embedded" :class="{ 'ob--embedded': embedded }">
    <PageHeader
      v-if="!embedded"
      :title="$t('gainos.outreach.title')"
      :subtitle="$t('gainos.outreach.subtitle')"
    >
      <template #actions>
        <Button type="primary" @click="showCreate = !showCreate">
          {{ $t('gainos.outreach.newBatch') }}
        </Button>
      </template>
    </PageHeader>
    <div v-else class="ob__embedded-head">
      <p class="ob__sub">{{ $t('gainos.outreach.subtitle') }}</p>
      <Button type="primary" @click="showCreate = !showCreate">
        {{ $t('gainos.outreach.newBatch') }}
      </Button>
    </div>

    <Form v-if="showCreate" class="ob__create" layout="inline" @submit.prevent="createBatch">
      <Form.Item :label="$t('gainos.outreach.nameLabel')">
        <Input v-model:value="batchName" :maxlength="200" :placeholder="$t('gainos.outreach.namePlaceholder')" style="width: 280px" />
      </Form.Item>
      <Button type="primary" :disabled="busy === 'create' || !batchName.trim()" :loading="busy === 'create'" @click="createBatch">
        {{ $t('gainos.outreach.create') }}
      </Button>
      <Button @click="showCreate = false">
        {{ $t('gainos.outreach.cancel') }}
      </Button>
    </Form>

    <Alert v-if="error" :message="`${error.title}${error.why ? ' · ' + error.why : ''}${error.next ? ' · ' + error.next : ''}`" role="alert" show-icon type="error" />
    <Alert v-if="notice" :message="notice" role="status" show-icon type="success" />
    <p v-if="loading" class="ob__muted">{{ $t('gainos.outreach.loading') }}</p>

    <div v-else-if="!error" class="ob__grid">
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
            <Button v-if="canEdit" @click="openCreateDraft">
              {{ $t('gainos.outreach.addDraft') }}
            </Button>
            <Button
              v-if="canSubmit"
              type="primary"
              :disabled="busy === 'submit'"
              :loading="busy === 'submit'"
              @click="submitBatch"
            >
              {{ $t('gainos.outreach.submit') }}
            </Button>
            <Button v-if="canReopen" :loading="busy === 'reopen'" @click="reopen">
              {{ $t('gainos.outreach.reopen') }}
            </Button>
          </div>
        </header>

        <p v-if="detailLoading" class="ob__muted">{{ $t('gainos.outreach.loading') }}</p>

        <section v-if="detail.status === 'PENDING_APPROVAL' && latestApproval" class="ob__approval">
          <h4>{{ $t('gainos.outreach.approvalTitle') }}</h4>
          <p class="ob__muted">
            {{ $t('gainos.outreach.approvalExpires', { at: when(latestApproval.expiresAt) }) }}
          </p>
          <Input v-model:value="decisionReason" :maxlength="500" :placeholder="$t('gainos.outreach.decisionReasonHint')" />
          <div class="ob__actions">
            <Button type="primary" :disabled="!canDecide || busy === 'approve'" :loading="busy === 'approve'" @click="decide('approve')">
              {{ $t('gainos.outreach.approve') }}
            </Button>
            <Button danger :disabled="!canDecide || busy === 'decline'" :loading="busy === 'decline'" @click="decide('decline')">
              {{ $t('gainos.outreach.decline') }}
            </Button>
          </div>
        </section>

        <p v-if="detail.drafts.length === 0" class="ob__muted">{{ $t('gainos.outreach.noDrafts') }}</p>
        <Table
          v-else
          :columns="draftColumns"
          :data-source="detail.drafts"
          :pagination="false"
          :scroll="{ x: 720 }"
          row-key="id"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'company'">{{ record.companyName || '—' }}</template>
            <template v-else-if="column.key === 'status'">
              <span class="gs-badge" :class="tone('outreachDraft', record.status)">
                {{ label('outreachDraft', record.status) }}
              </span>
            </template>
            <template v-else-if="column.key === 'actions'">
              <Button v-if="canEdit" type="link" size="small" @click="openEditDraft(record as OutreachDraftView)">
                {{ $t('gainos.outreach.edit') }}
              </Button>
              <Button v-if="canEdit" danger type="link" size="small" :loading="busy === `remove:${record.id}`" @click="removeDraft(record as OutreachDraftView)">
                {{ $t('gainos.outreach.remove') }}
              </Button>
            </template>
          </template>
        </Table>

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

    <Modal
      :open="Boolean(draftDialog)"
      :cancel-text="$t('gainos.outreach.cancel')"
      :confirm-loading="busy === 'draft'"
      :ok-text="$t('gainos.outreach.save')"
      :title="draftDialog?.mode === 'create' ? $t('gainos.outreach.addDraft') : $t('gainos.outreach.edit')"
      :width="560"
      @cancel="draftDialog = null"
      @ok="saveDraft"
    >
      <Form layout="vertical">
        <Form.Item :label="$t('gainos.outreach.contactRef')">
          <Input v-model:value="draftForm.contactRef" :placeholder="$t('gainos.outreach.contactRefHint')" />
          <Button class="ob__pick-toggle" size="small" @click="togglePicker">
            {{ $t('gainos.outreach.pickContact') }}
          </Button>
          <div v-if="pickerOpen" class="ob__pick">
            <Select
              v-model:value="pickerLeadId"
              :options="leadOptions"
              :placeholder="$t('gainos.outreach.pickLeadPlaceholder')"
              allow-clear
              style="width: 100%"
              @change="loadPickerContacts"
            />
            <p v-if="pickerBusy" class="ob__muted">{{ $t('gainos.common.loading') }}</p>
            <p v-else-if="pickerError" class="ob__error">{{ pickerError }}</p>
            <p v-else-if="pickerLeadId && pickerContacts.length === 0" class="ob__muted">
              {{ $t('gainos.outreach.pickEmpty') }}
            </p>
            <ul v-else class="ob__pick-list">
              <li v-for="contact in pickerContacts" :key="contact.id">
                <span>{{ contact.fullName }}<small v-if="contact.title"> · {{ contact.title }}</small></span>
                <Button type="link" size="small" @click="pickContact(contact)">
                  {{ $t('gainos.outreach.pickUse') }}
                </Button>
              </li>
            </ul>
          </div>
        </Form.Item>
        <Form.Item :label="$t('gainos.outreach.recipient')">
          <Input v-model:value="draftForm.recipientEmail" :maxlength="320" type="email" />
        </Form.Item>
        <Form.Item :label="$t('gainos.outreach.company')">
          <Input v-model:value="draftForm.companyName" :maxlength="200" />
        </Form.Item>
        <Form.Item :label="$t('gainos.outreach.subject')">
          <Input v-model:value="draftForm.subject" :maxlength="300" />
        </Form.Item>
        <Form.Item :label="$t('gainos.outreach.body')">
          <Input.TextArea v-model:value="draftForm.body" :maxlength="20000" :rows="6" />
        </Form.Item>
      </Form>
      <Alert v-if="draftError" :message="draftError" role="alert" show-icon type="error" />
    </Modal>
  </PageContainer>
</template>

<style scoped>
.ob--embedded { padding: 0; max-width: none; margin: 0; gap: 12px; }
.ob__embedded-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.ob__sub { margin: 0; color: var(--gs-fg-muted); font-size: 13px; }
.ob__create { margin-bottom: 4px; }
.ob__grid { display: grid; grid-template-columns: 280px 1fr; gap: 16px; align-items: start; }
.ob__list { display: grid; gap: 8px; }
.ob__item { display: grid; gap: 6px; text-align: left; padding: 12px; border: 1px solid var(--gs-border-strong); border-radius: 10px; background: var(--gs-surface); cursor: pointer; color: var(--gs-fg); font-size: 13px; }
.ob__item.is-active { border-color: var(--gs-accent-cta); box-shadow: 0 0 0 2px var(--gs-accent-soft); }
.ob__item-name { font-weight: 600; }
.ob__item-meta { color: var(--gs-fg-muted); font-size: 12px; }
.ob__detail { border: 1px solid var(--gs-border-strong); border-radius: 10px; padding: 16px; display: grid; gap: 14px; }
.ob__detail-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.ob__detail-head h3 { margin: 0 0 6px; }
.ob__actions { display: flex; gap: 8px; flex-wrap: wrap; }
.ob__pick-toggle { margin-top: 6px; }
.ob__pick { margin-top: 8px; display: grid; gap: 8px; border: 1px dashed var(--gs-border-dashed); border-radius: 10px; padding: 10px 12px; }
.ob__pick-list { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; }
.ob__pick-list li { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
.ob__pick-list small { color: var(--gs-fg-subtle); }
.ob__approval { border: 1px solid var(--gs-warn); background: var(--gs-warn-bg); border-radius: 10px; padding: 12px; display: grid; gap: 8px; }
.ob__timeline h4 { margin: 0 0 6px; font-size: 13.5px; }
.ob__timeline ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.ob__timeline li { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; }
.ob__muted { color: var(--gs-fg-muted); font-size: 12.5px; }
.ob__error { color: var(--gs-danger); margin: 0; }
@media (max-width: 860px) { .ob__grid { grid-template-columns: 1fr; } }
</style>
