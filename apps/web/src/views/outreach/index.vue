<script lang="ts" setup>
/**
 * 触达批次（M2 步 11-2 + Phase 1 断点修复）：
 * - 修复联系人选择器：拉取线索档案 + canonicalCompany 具名联系人与公司官方职能邮箱（不再读恒空的 pkg.contacts）；
 * - 草稿新增/编辑支持 countryCode（自动从线索国家带入）并在模态框提示 D3 法域合规；
 * - 编辑草稿保留 contactPointId（仅当收件邮箱被手工修改且未重选联系人时清空，避免退信错挂）；
 * - 支持读取 route.query.lead 预选线索，一键预填到当前草稿批次或引导先建批次。
 */
import type {
  CanonicalContact,
  Lead,
  OutreachBatchDetail,
  OutreachBatchSummary,
  OutreachDraftInput,
  OutreachDraftView,
} from '#/api/gainos';

import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import { Alert, Button, Form, Input, Modal, Select, Table, Tag } from 'ant-design-vue';

import {
  deriveOutreachActions,
  formatDateTime,
  glossaryStatus,
  resolveD3JurisdictionPolicy,
  statusClass,
} from '@gain-saas/shared';
import { preferences } from '@vben/preferences';

import { $t } from '#/locales';

import PageContainer from '#/components/gainos/page-container.vue';
import PageHeader from '#/components/gainos/page-header.vue';

import { failureText, gainosApi } from '#/api/gainos';

defineOptions({ name: 'OutreachBatches' });

// 内嵌在「商机与触达」枢纽时不渲染自己的页头。
defineProps<{ embedded?: boolean }>();

const route = useRoute();

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
  contactPointId: string;
  recipientEmail: string;
  companyName: string;
  countryCode: string;
  subject: string;
  body: string;
}

interface PickerCandidate {
  key: string;
  contactRef: string;
  contactPointId: string;
  name: string;
  title?: string | null;
  email: string;
  emailStatus?: string;
  kind: 'contact' | 'company_channel';
}

interface PreselectedLeadContext {
  leadId: string;
  companyName: string;
  countryCode: string;
  candidates: PickerCandidate[];
  draftSubject: string;
  draftBody: string;
}

const draftDialog = ref<{
  mode: 'create' | 'edit';
  draftId?: string;
  originalRecipientEmail?: string;
  originalContactPointId?: string;
} | null>(null);
const draftForm = ref<DraftForm>(emptyDraft());
const draftError = ref<string | null>(null);

const decisionReason = ref('');

const preselectedLead = ref<PreselectedLeadContext | null>(null);
const preselectLoading = ref(false);
const autoOpenAfterCreate = ref(false);

function emptyDraft(): DraftForm {
  return {
    contactRef: '',
    contactPointId: '',
    recipientEmail: '',
    companyName: '',
    countryCode: '',
    subject: '',
    body: '',
  };
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

const draftJurisdictionPolicy = computed(() => {
  const cc = draftForm.value.countryCode.trim().toUpperCase();
  if (!cc) return 'REVIEW_REQUIRED';
  return resolveD3JurisdictionPolicy(cc, { companyName: draftForm.value.companyName });
});

async function resolveLeadCandidates(leadId: string): Promise<PreselectedLeadContext> {
  const pkg = await gainosApi.leadPackage(leadId);
  const canonicalId = pkg.company?.canonical_company_id;
  const [canonicalDetail, existingDraft] = await Promise.all([
    canonicalId ? gainosApi.canonicalCompany(canonicalId).catch(() => null) : Promise.resolve(null),
    gainosApi.outreachDrafts(leadId).catch(() => null),
  ]);

  const contacts: CanonicalContact[] = [
    ...(canonicalDetail?.company?.contacts ?? []),
    ...((pkg as unknown as { contacts?: CanonicalContact[] }).contacts ?? []),
  ];
  const seenContactIds = new Set<string>();
  const seenEmails = new Set<string>();
  const candidates: PickerCandidate[] = [];

  for (const contact of contacts) {
    if (!contact?.id || seenContactIds.has(contact.id)) continue;
    seenContactIds.add(contact.id);
    const emailPoints = (contact.contactPoints ?? []).filter(
      (pt) =>
        String(pt.type ?? '').toLowerCase() === 'email' &&
        pt.value &&
        pt.status !== 'INVALID' &&
        pt.status !== 'BLOCKED',
    );
    const best = emailPoints.find((pt) => pt.status === 'VALID') ?? emailPoints[0];
    if (best?.value) seenEmails.add(best.value.toLowerCase());
    candidates.push({
      key: `contact:${contact.id}`,
      contactRef: contact.id,
      contactPointId: best?.id ?? '',
      name: contact.fullName,
      title: contact.title,
      email: best?.value ?? '',
      emailStatus: best?.status,
      kind: 'contact',
    });
  }

  for (const ch of pkg.company_channels ?? []) {
    if (ch.channel !== 'email' || !ch.value) continue;
    const normalized = ch.value.trim().toLowerCase();
    if (seenEmails.has(normalized)) continue;
    seenEmails.add(normalized);
    candidates.push({
      key: `channel:${normalized}`,
      contactRef: pkg.lead_id,
      contactPointId: '',
      name: ch.email_type || $t('gainos.outreach.officialInbox'),
      title: pkg.company?.name ?? '',
      email: ch.value.trim(),
      emailStatus: ch.status,
      kind: 'company_channel',
    });
  }

  const draftObj =
    existingDraft && typeof existingDraft === 'object'
      ? (existingDraft as Record<string, unknown>)
      : null;
  const draftSubject =
    typeof draftObj?.subject === 'string' && draftObj.subject.trim()
      ? draftObj.subject.trim()
      : '';
  const draftBody =
    (typeof draftObj?.body === 'string' && draftObj.body.trim()) ||
    (typeof draftObj?.text === 'string' && draftObj.text.trim()) ||
    '';

  return {
    leadId: pkg.lead_id,
    companyName: pkg.company?.name ?? '',
    countryCode: (pkg.company?.country ?? '').trim().toUpperCase(),
    candidates,
    draftSubject,
    draftBody,
  };
}

async function loadBatches(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    batches.value = await gainosApi.outreachBatches();
    if (!detail.value && batches.value[0]) {
      const preferred =
        batches.value.find((item) => item.status === 'DRAFT') ?? batches.value[0];
      await selectBatch(preferred.id);
    }
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
    if (autoOpenAfterCreate.value && preselectedLead.value) {
      autoOpenAfterCreate.value = false;
      openPrefilledDraftFromLead(preselectedLead.value);
    }
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

function openPrefilledDraftFromLead(ctx: PreselectedLeadContext): void {
  const best = ctx.candidates.find((item) => item.email) ?? ctx.candidates[0] ?? null;
  draftForm.value = {
    contactRef: best?.contactRef ?? ctx.leadId,
    contactPointId: best?.contactPointId ?? '',
    recipientEmail: best?.email ?? '',
    companyName: ctx.companyName,
    countryCode: ctx.countryCode,
    subject: ctx.draftSubject,
    body: ctx.draftBody,
  };
  pickerLeadId.value = ctx.leadId;
  pickerLeadName.value = ctx.companyName;
  pickerLeadCountry.value = ctx.countryCode;
  pickerCandidates.value = ctx.candidates;
  draftError.value = null;
  draftDialog.value = { mode: 'create' };
}

function applyPreselectedLead(): void {
  const ctx = preselectedLead.value;
  if (!ctx) return;
  if (detail.value && canEdit.value) {
    openPrefilledDraftFromLead(ctx);
    return;
  }
  const editableBatch = batches.value.find((item) => item.status === 'DRAFT');
  if (editableBatch) {
    void selectBatch(editableBatch.id).then(() => {
      if (canEdit.value) openPrefilledDraftFromLead(ctx);
    });
    return;
  }
  batchName.value = ctx.companyName ? `${ctx.companyName}` : '';
  showCreate.value = true;
  autoOpenAfterCreate.value = true;
}

// 从线索选择联系人（同时拉具名联系人与公司官方职能邮箱，并自动带入国家代码）。
const pickerOpen = ref(false);
const pickerLeads = ref<Lead[]>([]);
const pickerLeadId = ref('');
const pickerLeadName = ref('');
const pickerLeadCountry = ref('');
const pickerCandidates = ref<PickerCandidate[]>([]);
const pickerBusy = ref(false);
const pickerError = ref<string | null>(null);

async function togglePicker(): Promise<void> {
  pickerOpen.value = !pickerOpen.value;
  pickerError.value = null;
  if (!pickerOpen.value || pickerLeads.value.length > 0) return;
  try {
    const [recommended, review] = await Promise.all([
      gainosApi.leads({ queue: 'recommended', limit: 50 }).catch(() => []),
      gainosApi.leads({ queue: 'needs_review', limit: 30 }).catch(() => []),
    ]);
    const listA = Array.isArray(recommended) ? recommended : ((recommended as { data?: Lead[] })?.data ?? []);
    const listB = Array.isArray(review) ? review : ((review as { data?: Lead[] })?.data ?? []);
    const seen = new Set<string>();
    const merged: Lead[] = [];
    for (const item of [...listA, ...listB]) {
      if (!item?.id || seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }
    pickerLeads.value = merged;
  } catch (err) {
    pickerError.value = failureText(err).title;
  }
}

async function loadPickerContacts(): Promise<void> {
  if (!pickerLeadId.value) {
    pickerCandidates.value = [];
    return;
  }
  pickerBusy.value = true;
  pickerError.value = null;
  try {
    const ctx = await resolveLeadCandidates(pickerLeadId.value);
    pickerCandidates.value = ctx.candidates;
    pickerLeadName.value = ctx.companyName;
    pickerLeadCountry.value = ctx.countryCode;
  } catch (err) {
    pickerError.value = failureText(err).title;
    pickerCandidates.value = [];
  } finally {
    pickerBusy.value = false;
  }
}

function pickCandidate(candidate: PickerCandidate): void {
  draftForm.value.contactRef = candidate.contactRef;
  // 引擎 contact_point id：发送前可触达性预检与退信回写（bounce-events）的寻址键
  draftForm.value.contactPointId = candidate.contactPointId;
  if (candidate.email) draftForm.value.recipientEmail = candidate.email;
  if (pickerLeadName.value) draftForm.value.companyName = pickerLeadName.value;
  if (pickerLeadCountry.value) draftForm.value.countryCode = pickerLeadCountry.value;
  pickerOpen.value = false;
}

function openEditDraft(draft: OutreachDraftView): void {
  draftForm.value = {
    contactRef: draft.contactRef,
    contactPointId: draft.contactPointId ?? '',
    recipientEmail: draft.recipientEmail,
    companyName: draft.companyName ?? '',
    countryCode: (draft.countryCode ?? '').trim().toUpperCase(),
    subject: draft.subject,
    body: draft.body,
  };
  draftError.value = null;
  draftDialog.value = {
    mode: 'edit',
    draftId: draft.id,
    originalRecipientEmail: draft.recipientEmail,
    originalContactPointId: draft.contactPointId ?? '',
  };
}

async function saveDraft(): Promise<void> {
  if (!detail.value || !draftDialog.value) return;
  draftError.value = null;
  const emailTrimmed = draftForm.value.recipientEmail.trim();
  const countryNormalized = draftForm.value.countryCode.trim().toUpperCase();
  if (countryNormalized && !/^[A-Z]{2}$/.test(countryNormalized)) {
    draftError.value = $t('gainos.outreach.countryInvalid');
    return;
  }

  let effectivePointId = draftForm.value.contactPointId.trim();
  if (
    draftDialog.value.mode === 'edit' &&
    draftDialog.value.originalRecipientEmail &&
    emailTrimmed.toLowerCase() !== draftDialog.value.originalRecipientEmail.trim().toLowerCase() &&
    effectivePointId === (draftDialog.value.originalContactPointId ?? '')
  ) {
    // 人工改了收件邮箱且未重选新联系人，清空旧 contactPointId 避免退信错挂。
    effectivePointId = '';
  }

  const input: OutreachDraftInput = {
    contactRef: draftForm.value.contactRef.trim(),
    ...(effectivePointId ? { contactPointId: effectivePointId } : {}),
    recipientEmail: emailTrimmed,
    ...(draftForm.value.companyName.trim() ? { companyName: draftForm.value.companyName.trim() } : {}),
    ...(countryNormalized ? { countryCode: countryNormalized } : {}),
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

const draftColumns = computed(() => [
  { key: 'recipient', dataIndex: 'recipientEmail', title: $t('gainos.outreach.recipient') },
  { key: 'company', dataIndex: 'companyName', title: $t('gainos.outreach.company'), width: 170 },
  { key: 'country', dataIndex: 'countryCode', title: $t('gainos.outreach.countryCode'), width: 88 },
  { key: 'subject', dataIndex: 'subject', title: $t('gainos.outreach.subject') },
  { key: 'status', dataIndex: 'status', title: $t('gainos.outreach.status'), width: 120 },
  { key: 'actions', dataIndex: 'actions', title: '', width: 130 },
]);

const leadOptions = computed(() =>
  pickerLeads.value.map((lead) => ({
    value: lead.id,
    label: [lead.company?.name ?? lead.id.slice(0, 8), lead.company?.country]
      .filter(Boolean)
      .join(' · '),
  })),
);

function routeLeadId(): string {
  const raw = route.query.lead;
  const val = Array.isArray(raw) ? raw[0] : raw;
  return typeof val === 'string' ? val.trim() : '';
}

async function hydrateLeadFromRoute(): Promise<void> {
  const id = routeLeadId();
  if (!id) {
    preselectedLead.value = null;
    return;
  }
  preselectLoading.value = true;
  try {
    const ctx = await resolveLeadCandidates(id);
    preselectedLead.value = ctx;
    if (!pickerLeads.value.some((lead) => lead.id === id)) {
      pickerLeads.value = [
        { id, company: { name: ctx.companyName, country: ctx.countryCode } },
        ...pickerLeads.value,
      ];
    }
    pickerLeadId.value = id;
    pickerLeadName.value = ctx.companyName;
    pickerLeadCountry.value = ctx.countryCode;
    pickerCandidates.value = ctx.candidates;
  } catch {
    preselectedLead.value = null;
  } finally {
    preselectLoading.value = false;
  }
}

watch(
  () => route.query.lead,
  () => void hydrateLeadFromRoute(),
);

onMounted(async () => {
  await Promise.all([loadBatches(), hydrateLeadFromRoute()]);
});
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

    <Alert
      v-if="preselectedLead"
      :message="
        $t('gainos.outreach.preselectedLeadBanner', {
          company: preselectedLead.companyName || preselectedLead.leadId.slice(0, 8),
          country: preselectedLead.countryCode || '—',
          count: preselectedLead.candidates.length,
        })
      "
      data-gs="preselected-lead-banner"
      show-icon
      type="info"
    >
      <template #action>
        <Button
          :loading="preselectLoading"
          data-gs="apply-preselected-lead"
          size="small"
          type="primary"
          @click="applyPreselectedLead"
        >
          {{ $t('gainos.outreach.prefillIntoDraft') }}
        </Button>
      </template>
    </Alert>

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
        <div v-if="batches.length === 0" class="ob__empty">
          <p class="ob__muted">{{ $t('gainos.outreach.empty') }}</p>
          <div class="ob__empty-actions">
            <RouterLink class="ob__secondary" to="/growth?tab=replies">{{ $t('gainos.replies.tab') }}</RouterLink>
            <RouterLink class="ob__secondary" to="/leads">{{ $t('gainos.leads.title') }}</RouterLink>
          </div>
        </div>
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
            <Button v-if="canEdit" data-gs="add-draft" @click="openCreateDraft">
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
          :scroll="{ x: 780 }"
          row-key="id"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'company'">{{ record.companyName || '—' }}</template>
            <template v-else-if="column.key === 'country'">{{ record.countryCode || '—' }}</template>
            <template v-else-if="column.key === 'status'">
              <span class="gs-badge" :class="tone('outreachDraft', record.status)">
                {{ label('outreachDraft', record.status) }}
              </span>
            </template>
            <template v-else-if="column.key === 'actions'">
              <Button v-if="canEdit" data-gs="edit-draft" type="link" size="small" @click="openEditDraft(record as OutreachDraftView)">
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
      :width="600"
      data-gs="draft-modal"
      @cancel="draftDialog = null"
      @ok="saveDraft"
    >
      <Form layout="vertical">
        <Form.Item :label="$t('gainos.outreach.contactRef')">
          <Input v-model:value="draftForm.contactRef" :placeholder="$t('gainos.outreach.contactRefHint')" />
          <Button class="ob__pick-toggle" data-gs="pick-contact-toggle" size="small" @click="togglePicker">
            {{ $t('gainos.outreach.pickContact') }}
          </Button>
          <div v-if="pickerOpen" class="ob__pick" data-gs="contact-picker">
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
            <p v-else-if="pickerLeadId && pickerCandidates.length === 0" class="ob__muted">
              {{ $t('gainos.outreach.pickEmpty') }}
            </p>
            <ul v-else class="ob__pick-list">
              <li v-for="candidate in pickerCandidates" :key="candidate.key">
                <span class="ob__pick-label">
                  {{ candidate.name }}
                  <small v-if="candidate.title"> · {{ candidate.title }}</small>
                  <small v-if="candidate.email"> · {{ candidate.email }}</small>
                  <Tag v-if="candidate.kind === 'company_channel'" :bordered="false" class="m-0 ml-1 text-xs">
                    {{ $t('gainos.outreach.officialInboxTag') }}
                  </Tag>
                </span>
                <Button data-gs="pick-candidate-use" type="link" size="small" @click="pickCandidate(candidate)">
                  {{ $t('gainos.outreach.pickUse') }}
                </Button>
              </li>
            </ul>
          </div>
        </Form.Item>
        <div class="ob__row-2">
          <Form.Item :label="$t('gainos.outreach.recipient')">
            <Input v-model:value="draftForm.recipientEmail" :maxlength="320" data-gs="draft-email" type="email" />
          </Form.Item>
          <Form.Item :label="$t('gainos.outreach.countryCode')">
            <Input
              v-model:value="draftForm.countryCode"
              :maxlength="2"
              :placeholder="$t('gainos.outreach.countryCodePlaceholder')"
              data-gs="draft-country"
            />
          </Form.Item>
        </div>
        <Alert
          v-if="draftJurisdictionPolicy === 'CONSENT_REQUIRED'"
          :message="$t('gainos.outreach.countryConsentWarning')"
          class="mb-3"
          show-icon
          type="warning"
        />
        <Alert
          v-else-if="draftJurisdictionPolicy === 'REVIEW_REQUIRED'"
          :message="$t('gainos.outreach.countryMissingWarning')"
          class="mb-3"
          show-icon
          type="info"
        />
        <Form.Item :label="$t('gainos.outreach.company')">
          <Input v-model:value="draftForm.companyName" :maxlength="200" data-gs="draft-company" />
        </Form.Item>
        <Form.Item :label="$t('gainos.outreach.subject')">
          <Input v-model:value="draftForm.subject" :maxlength="300" data-gs="draft-subject" />
        </Form.Item>
        <Form.Item :label="$t('gainos.outreach.body')">
          <Input.TextArea v-model:value="draftForm.body" :maxlength="20000" :rows="6" data-gs="draft-body" />
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
.ob__pick-label { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; }
.ob__pick-list small { color: var(--gs-fg-subtle); }
.ob__row-2 { display: grid; grid-template-columns: minmax(0, 1fr) 120px; gap: 12px; }
.ob__approval { border: 1px solid var(--gs-warn); background: var(--gs-warn-bg); border-radius: 10px; padding: 12px; display: grid; gap: 8px; }
.ob__timeline h4 { margin: 0 0 6px; font-size: 13.5px; }
.ob__timeline ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.ob__timeline li { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; }
.ob__muted { color: var(--gs-fg-muted); font-size: 12.5px; }
.ob__empty { display: grid; gap: 10px; }
.ob__empty-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.ob__secondary {
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--gs-border); border-radius: 999px; padding: 7px 16px;
  background: var(--gs-surface); color: var(--gs-fg-2); font-size: 13px; text-decoration: none;
}
.ob__secondary:hover { border-color: var(--gs-accent); color: var(--gs-accent-strong); }
.ob__error { color: var(--gs-danger); margin: 0; }
@media (max-width: 860px) {
  .ob__grid { grid-template-columns: 1fr; }
  .ob__row-2 { grid-template-columns: 1fr; }
}
</style>
