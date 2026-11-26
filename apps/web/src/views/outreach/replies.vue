<script lang="ts" setup>
import type { OutreachBatchSummary, OutreachReplyView } from '#/api/gainos';
import type { ReferredContactLead } from '@gain-saas/shared';

import { computed, onMounted, ref } from 'vue';

import { Alert, Button, Form, Input, Modal, Select, Space, Table, Tag } from 'ant-design-vue';

import { $t } from '#/locales';

import {
  extractReferredContacts,
  formatDateTime,
  resolveD3JurisdictionPolicy,
} from '@gain-saas/shared';

import AsyncSection from '#/components/gainos/async-section.vue';
import EmptyState from '#/components/gainos/empty-state.vue';
import PageContainer from '#/components/gainos/page-container.vue';
import PageHeader from '#/components/gainos/page-header.vue';
import GsCard from '#/components/gainos/ui/gs-card.vue';

import { failureText, gainosApi } from '#/api/gainos';
import { useWorkspaceAccess } from '#/composables/use-workspace-access';
import { feedback } from '#/feedback';

/**
 * 回复收件箱（v3.0 第 7 章 + Phase 3 转交联系人一键建稿）：
 * - 任何回复/退信/退订/投诉都会在此出现；回复即停与退订由后端保证；
 * - 自动从回信中提取被转交的新联系人邮箱（REFERRAL），支持过 DNC + D3 预检后一键创建跟进草稿。
 */
defineOptions({ name: 'OutreachReplies' });

defineProps<{ embedded?: boolean }>();

const { isAdmin, can, loaded: accessLoaded, ensureLoaded } = useWorkspaceAccess();
const canDraftOutreach = computed(() => isAdmin.value || can('outreach.draft'));
const showReadOnlyHint = computed(
  () => accessLoaded.value && !isAdmin.value && !canDraftOutreach.value,
);

const rows = ref<OutreachReplyView[]>([]);
const loading = ref(false);
const error = ref<{ title: string; next?: string } | null>(null);

const referredLeads = computed<ReferredContactLead[]>(() => extractReferredContacts(rows.value));

// 转交联系人建稿弹窗
const referralModal = ref<ReferredContactLead | null>(null);
const draftBatches = ref<OutreachBatchSummary[]>([]);
const referralBusy = ref(false);
const referralError = ref<string | null>(null);
const referralForm = ref({
  batchId: '',
  countryCode: 'IT',
  companyName: '',
  subject: '',
  body: '',
});

const referralJurisdictionPolicy = computed(() => {
  const cc = referralForm.value.countryCode.trim().toUpperCase();
  if (!cc) return 'REVIEW_REQUIRED';
  return resolveD3JurisdictionPolicy(cc, { companyName: referralForm.value.companyName });
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const page = await gainosApi.outreachReplies();
    rows.value = Array.isArray(page) ? page : (page?.data ?? []);
  } catch (err) {
    error.value = failureText(err);
    rows.value = [];
  } finally {
    loading.value = false;
  }
}

async function openReferralDraft(lead: ReferredContactLead): Promise<void> {
  if (!canDraftOutreach.value) return;
  referralModal.value = lead;
  referralError.value = null;
  referralForm.value = {
    batchId: '',
    countryCode: 'IT',
    companyName: '',
    subject: lead.subject
      ? `Re: ${lead.subject.toLowerCase().startsWith('re:') ? lead.subject.slice(3).trimStart() : lead.subject}`
      : 'Following up on your colleague referral',
    body: `Hello,\n\nYour colleague (${lead.sourceEmail ?? 'your team'}) kindly suggested I reach out regarding our product supply and technical specifications.\n\nWould you be open to a quick review this week?\n\nBest regards,`,
  };
  try {
    const allBatches = await gainosApi.outreachBatches();
    draftBatches.value = (Array.isArray(allBatches) ? allBatches : []).filter(
      (item) => item.status === 'DRAFT',
    );
    referralForm.value.batchId = draftBatches.value[0]?.id ?? '';
  } catch {
    draftBatches.value = [];
  }
}

async function submitReferralDraft(): Promise<void> {
  if (!canDraftOutreach.value) return;
  const lead = referralModal.value;
  if (!lead || referralBusy.value) return;
  if (!referralForm.value.batchId) {
    referralError.value = $t('gainos.replies.referralNoDraftBatch');
    return;
  }
  const cc = referralForm.value.countryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) {
    referralError.value = $t('gainos.outreach.countryInvalid');
    return;
  }
  referralBusy.value = true;
  referralError.value = null;
  try {
    await gainosApi.createReferralFollowUpDraft({
      batchId: referralForm.value.batchId,
      replyId: lead.replyId,
      sourceContactRef: lead.contactRef,
      referredEmail: lead.referredEmail,
      companyName: referralForm.value.companyName.trim() || undefined,
      countryCode: cc,
      subject: referralForm.value.subject.trim(),
      body: referralForm.value.body.trim(),
    });
    referralModal.value = null;
    feedback.message.success($t('gainos.replies.referralCreated'));
  } catch (err) {
    referralError.value = failureText(err).title;
  } finally {
    referralBusy.value = false;
  }
}

onMounted(() => {
  void ensureLoaded();
  void load();
});

const CLASS_TONE: Record<string, string> = {
  POSITIVE: 'success',
  NEGATIVE: 'danger',
  NEUTRAL: 'neutral',
  OUT_OF_OFFICE: 'warning',
  UNKNOWN: 'neutral',
};

function classLabel(value?: string | null): string {
  const key = `gainos.replies.class.${value ?? 'UNKNOWN'}`;
  const text = $t(key);
  return text === key ? ($t('gainos.replies.class.UNKNOWN') as string) : text;
}

function classBadge(value?: string | null): string {
  return `gs-badge--${CLASS_TONE[value ?? 'UNKNOWN'] ?? 'neutral'}`;
}

function kindLabel(value?: string | null): string {
  const key = `gainos.replies.kind.${value ?? 'REPLY'}`;
  const text = $t(key);
  return text === key ? (value ?? '—') : text;
}

function fmtTime(ts?: string | null): string {
  return formatDateTime(ts) || '—';
}

const columns = [
  { key: 'receivedAt', dataIndex: 'receivedAt', title: $t('gainos.replies.colTime'), width: 170 },
  { key: 'recipientEmail', dataIndex: 'recipientEmail', title: $t('gainos.replies.colRecipient'), width: 240 },
  { key: 'classification', dataIndex: 'classification', title: $t('gainos.replies.colClass'), width: 190 },
  { key: 'subject', dataIndex: 'subject', title: $t('gainos.replies.colSubject') },
];
</script>

<template>
  <PageContainer :compact="embedded" :class="{ 'rpl--embedded': embedded }">
    <PageHeader v-if="!embedded" :subtitle="$t('gainos.replies.subtitle')" :title="$t('gainos.replies.title')">
      <template #actions>
        <Button :loading="loading" @click="load">{{ $t('gainos.common.refresh') }}</Button>
      </template>
    </PageHeader>
    <div v-else class="rpl__embedded-head">
      <p class="rpl__sub">{{ $t('gainos.replies.subtitle') }}</p>
      <Button :loading="loading" @click="load">{{ $t('gainos.common.refresh') }}</Button>
    </div>

    <Alert
      v-if="showReadOnlyHint"
      :message="$t('gainosP0.access.outreachReadonlyHint')"
      data-gs="outreach-readonly-hint"
      role="status"
      show-icon
      type="info"
    />

    <GsCard
      v-if="referredLeads.length > 0"
      :title="$t('gainos.replies.referralTitle')"
      data-gs="referral-leads-card"
    >
      <p class="rpl__ref-desc">{{ $t('gainos.replies.referralDesc') }}</p>
      <ul class="rpl__ref-list">
        <li
          v-for="item in referredLeads"
          :key="`${item.replyId}-${item.referredEmail}`"
          class="rpl__ref-item"
          data-gs="referral-lead-row"
        >
          <div class="rpl__ref-meta">
            <Space :size="6" wrap>
              <strong>{{ item.referredEmail }}</strong>
              <Tag v-if="item.sourceEmail" :bordered="false" class="m-0 text-xs">
                {{ $t('gainos.replies.referralSource') }}: {{ item.sourceEmail }}
              </Tag>
              <span v-if="item.receivedAt" class="rpl__ref-time">{{ fmtTime(item.receivedAt) }}</span>
            </Space>
            <small v-if="item.subject" class="rpl__snippet">{{ item.subject }}</small>
          </div>
          <Button
            v-if="canDraftOutreach"
            data-gs="referral-create-draft"
            size="small"
            type="primary"
            @click="openReferralDraft(item)"
          >
            {{ $t('gainos.replies.referralCreateDraft') }}
          </Button>
        </li>
      </ul>
    </GsCard>

    <AsyncSection
      :error="error"
      :empty="!loading && !error && rows.length === 0"
      :loading="loading"
      :loading-text="$t('gainos.common.loading')"
      :retry-text="$t('gainos.common.retry')"
      @retry="load"
    >
      <template #empty>
        <EmptyState :title="$t('gainos.replies.empty')">
          <template #actions>
            <Button type="primary" @click="$router.push('/outreach?tab=batches')">
              {{ $t('gainos.outreach.title') }}
            </Button>
            <Button @click="$router.push('/leads')">
              {{ $t('gainos.leads.title') }}
            </Button>
          </template>
        </EmptyState>
      </template>
      <Table
        :columns="columns"
        :data-source="rows"
        :pagination="false"
        :scroll="{ x: 720 }"
        row-key="id"
        size="middle"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'receivedAt'">{{ fmtTime(record.receivedAt) }}</template>
          <template v-else-if="column.key === 'recipientEmail'">{{ record.recipientEmail ?? '—' }}</template>
          <template v-else-if="column.key === 'classification'">
            <span class="gs-badge" :class="classBadge(record.classification)">{{ classLabel(record.classification) }}</span>
            <span class="rpl__kind">{{ kindLabel(record.kind) }}</span>
          </template>
          <template v-else-if="column.key === 'subject'">
            <span>{{ record.subject ?? '—' }}</span>
            <small v-if="record.snippet" class="rpl__snippet">{{ record.snippet }}</small>
          </template>
        </template>
      </Table>
    </AsyncSection>

    <Modal
      v-if="canDraftOutreach"
      :confirm-loading="referralBusy"
      :open="Boolean(referralModal)"
      :title="$t('gainos.replies.referralModalTitle')"
      :width="560"
      data-gs="referral-draft-modal"
      @cancel="referralModal = null"
      @ok="submitReferralDraft"
    >
      <Form layout="vertical">
        <Form.Item :label="$t('gainos.replies.referralEmailLabel')">
          <Input :value="referralModal?.referredEmail ?? ''" disabled />
        </Form.Item>
        <Form.Item :label="$t('gainos.replies.referralBatchLabel')">
          <Select
            v-if="draftBatches.length > 0"
            v-model:value="referralForm.batchId"
            :options="draftBatches.map((b) => ({ label: b.name, value: b.id }))"
            data-gs="referral-batch-select"
            style="width: 100%"
          />
          <Alert v-else :message="$t('gainos.replies.referralNoDraftBatch')" show-icon type="warning" />
        </Form.Item>
        <div class="rpl__row-2">
          <Form.Item :label="$t('gainos.replies.referralCompanyLabel')">
            <Input v-model:value="referralForm.companyName" :maxlength="200" data-gs="referral-company" />
          </Form.Item>
          <Form.Item :label="$t('gainos.replies.referralCountryLabel')">
            <Input v-model:value="referralForm.countryCode" :maxlength="2" data-gs="referral-country" />
          </Form.Item>
        </div>
        <Alert
          v-if="referralJurisdictionPolicy !== 'OPT_OUT'"
          :message="$t('gainos.outreach.countryConsentWarning')"
          class="mb-3"
          show-icon
          type="warning"
        />
        <Form.Item :label="$t('gainos.replies.referralSubjectLabel')">
          <Input v-model:value="referralForm.subject" :maxlength="300" data-gs="referral-subject" />
        </Form.Item>
        <Form.Item :label="$t('gainos.replies.referralBodyLabel')">
          <Input.TextArea v-model:value="referralForm.body" :maxlength="20000" :rows="5" data-gs="referral-body" />
        </Form.Item>
      </Form>
      <Alert v-if="referralError" :message="referralError" role="alert" show-icon type="error" />
    </Modal>
  </PageContainer>
</template>

<style scoped>
.rpl--embedded { padding: 0; max-width: none; margin: 0; gap: 12px; }
.rpl__embedded-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.rpl__sub { margin: 0; font-size: 13px; color: var(--gs-fg-muted); }
.rpl__kind { margin-left: 8px; font-size: 12px; color: var(--gs-fg-subtle); }
.rpl__snippet { display: block; margin-top: 4px; color: var(--gs-fg-subtle); font-size: 12.5px; }
.rpl__ref-desc { margin: 0 0 10px; font-size: 12.5px; color: var(--gs-fg-muted); }
.rpl__ref-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.rpl__ref-item { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--gs-divider); border-radius: 10px; background: var(--gs-surface); }
.rpl__ref-meta { display: grid; gap: 2px; }
.rpl__ref-time { font-size: 12px; color: var(--gs-fg-subtle); }
.rpl__row-2 { display: grid; grid-template-columns: minmax(0, 1fr) 150px; gap: 10px; }
@media (max-width: 640px) { .rpl__row-2 { grid-template-columns: 1fr; } }
</style>
