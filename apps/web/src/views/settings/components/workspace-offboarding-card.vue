<script lang="ts" setup>
import { computed, ref, watch } from 'vue';

import { Alert, Button, Form, Input } from 'ant-design-vue';

import { formatDateTime } from '@gain-saas/shared';

import { failureText, gainosApi, type WorkspaceOffboardingView } from '#/api/gainos';
import GsCard from '#/components/gainos/ui/gs-card.vue';
import GsTag from '#/components/gainos/ui/gs-tag.vue';
import { feedback } from '#/feedback';
import { $t } from '#/locales';

defineOptions({ name: 'WorkspaceOffboardingCard' });

const props = defineProps<{
  isAdmin: boolean;
  workspaceId: string;
  workspaceName: string;
}>();

const loading = ref(false);
const submitting = ref(false);
const cancelling = ref(false);
const showForm = ref(false);
const record = ref<WorkspaceOffboardingView | null>(null);
const confirmName = ref('');
const reason = ref('');
const errorBox = ref<{ next?: string; title: string } | null>(null);
const notice = ref<string | null>(null);

const isScheduled = computed(() => record.value?.status === 'SCHEDULED');
const isPurged = computed(() => record.value?.status === 'PURGED');
const isCancelled = computed(() => record.value?.status === 'CANCELLED');

const statusTone = computed<'danger' | 'info' | 'neutral' | 'success' | 'warning'>(() => {
  if (isScheduled.value) return 'warning';
  if (isPurged.value) return 'danger';
  if (isCancelled.value) return 'neutral';
  return 'success';
});

const statusLabel = computed(() => {
  if (isScheduled.value) return $t('gainos.privacy.offboarding.statusScheduled');
  if (isPurged.value) return $t('gainos.privacy.offboarding.statusPurged');
  if (isCancelled.value) return $t('gainos.privacy.offboarding.statusCancelled');
  return $t('gainos.privacy.offboarding.statusActive');
});

function fmtTime(value?: string | null): string {
  return formatDateTime(value) || '—';
}

function confirmDialog(options: {
  content: string;
  danger?: boolean;
  okText: string;
  title: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    feedback.confirm({
      content: options.content,
      okText: options.okText,
      okType: options.danger ? 'danger' : 'primary',
      onCancel: () => resolve(false),
      onOk: () => resolve(true),
      title: options.title,
    });
  });
}

async function loadStatus(): Promise<void> {
  if (!props.workspaceId) return;
  loading.value = true;
  errorBox.value = null;
  try {
    record.value = await gainosApi.workspaceOffboarding(props.workspaceId);
  } catch (err) {
    errorBox.value = failureText(err);
  } finally {
    loading.value = false;
  }
}

async function submitOffboarding(): Promise<void> {
  if (!props.isAdmin || !props.workspaceId || submitting.value) return;
  errorBox.value = null;
  notice.value = null;
  const typed = confirmName.value.trim();
  if (!typed || (props.workspaceName.trim() && typed !== props.workspaceName.trim())) {
    errorBox.value = { title: $t('gainos.privacy.offboarding.confirmNameMismatch') };
    return;
  }
  const ok = await confirmDialog({
    content: $t('gainos.privacy.offboarding.submitConfirmContent', { name: props.workspaceName || typed }),
    danger: true,
    okText: $t('gainos.privacy.offboarding.submitBtn'),
    title: $t('gainos.privacy.offboarding.submitConfirmTitle'),
  });
  if (!ok) return;

  submitting.value = true;
  try {
    record.value = await gainosApi.requestWorkspaceOffboarding(props.workspaceId, {
      confirmName: typed,
      ...(reason.value.trim() ? { reason: reason.value.trim() } : {}),
    });
    confirmName.value = '';
    reason.value = '';
    showForm.value = false;
    const msg = $t('gainos.privacy.offboarding.submitted');
    notice.value = msg;
    feedback.message.success(msg);
  } catch (err) {
    errorBox.value = failureText(err);
  } finally {
    submitting.value = false;
  }
}

async function cancelOffboarding(): Promise<void> {
  if (!props.isAdmin || !props.workspaceId || cancelling.value) return;
  const ok = await confirmDialog({
    content: $t('gainos.privacy.offboarding.cancelConfirmContent'),
    okText: $t('gainos.privacy.offboarding.cancelBtn'),
    title: $t('gainos.privacy.offboarding.cancelConfirmTitle'),
  });
  if (!ok) return;

  cancelling.value = true;
  errorBox.value = null;
  notice.value = null;
  try {
    record.value = await gainosApi.cancelWorkspaceOffboarding(props.workspaceId);
    const msg = $t('gainos.privacy.offboarding.cancelled');
    notice.value = msg;
    feedback.message.success(msg);
  } catch (err) {
    errorBox.value = failureText(err);
  } finally {
    cancelling.value = false;
  }
}

watch(
  () => props.workspaceId,
  (id) => {
    if (id) {
      void loadStatus();
    }
  },
  { immediate: true },
);
</script>

<template>
  <GsCard :title="$t('gainos.privacy.offboarding.title')" data-gs="workspace-offboarding-card">
    <template #extra>
      <div class="flex flex-wrap items-center gap-2">
        <GsTag :tone="statusTone" data-gs="offboarding-status-tag">{{ statusLabel }}</GsTag>
        <Button
          v-if="isAdmin && !isScheduled && !isPurged"
          danger
          data-gs="offboarding-toggle-form"
          @click="showForm = !showForm"
        >
          {{ showForm ? $t('gainos.privacy.offboarding.hideFormBtn') : $t('gainos.privacy.offboarding.openFormBtn') }}
        </Button>
      </div>
    </template>

    <div class="grid gap-3">
      <p class="m-0 text-sm text-[var(--gs-fg-muted)]">{{ $t('gainos.privacy.offboarding.desc') }}</p>

      <Alert v-if="notice" :message="notice" closable role="status" show-icon type="success" @close="notice = null" />
      <Alert v-if="errorBox" role="alert" show-icon type="warning">
        <template #message>{{ errorBox.title }}</template>
        <template v-if="errorBox.next" #description>{{ errorBox.next }}</template>
      </Alert>

      <template v-if="record && isScheduled">
        <Alert
          v-if="record.canCancel"
          :message="
            $t('gainos.privacy.offboarding.scheduledBanner', {
              days: record.remainingDays,
              deadline: fmtTime(record.coolOffEndsAt),
            })
          "
          data-gs="offboarding-scheduled-banner"
          show-icon
          type="warning"
        />
        <Alert
          v-else
          :message="$t('gainos.privacy.offboarding.expiredBanner', { deadline: fmtTime(record.coolOffEndsAt) })"
          data-gs="offboarding-expired-banner"
          show-icon
          type="error"
        />
        <div v-if="isAdmin && record.canCancel" class="flex flex-wrap items-center gap-2">
          <Button
            :disabled="cancelling"
            :loading="cancelling"
            data-gs="offboarding-cancel-btn"
            @click="cancelOffboarding"
          >
            {{ cancelling ? $t('gainos.privacy.offboarding.cancelling') : $t('gainos.privacy.offboarding.cancelBtn') }}
          </Button>
        </div>
      </template>

      <p v-else-if="record && isCancelled" class="m-0 text-xs text-[var(--gs-fg-subtle)]">
        {{ $t('gainos.privacy.offboarding.cancelledNote', { time: fmtTime(record.cancelledAt) }) }}
      </p>
      <p v-else-if="record && isPurged" class="m-0 text-xs text-[var(--gs-fg-subtle)]">
        {{ $t('gainos.privacy.offboarding.purgedNote', { time: fmtTime(record.purgedAt) }) }}
      </p>

      <Alert
        v-if="!isAdmin && !isScheduled"
        :message="$t('gainos.privacy.offboarding.adminOnly')"
        data-gs="offboarding-admin-only"
        show-icon
        type="info"
      />

      <div
        v-if="isAdmin && showForm && !isScheduled && !isPurged"
        class="grid gap-3 rounded-xl border border-dashed border-[var(--gs-border)] bg-[var(--gs-surface-2)] p-4"
        data-gs="offboarding-form"
      >
        <Form layout="vertical" @submit.prevent="submitOffboarding">
          <Form.Item :label="$t('gainos.privacy.offboarding.confirmNameLabel', { name: workspaceName })">
            <Input
              v-model:value="confirmName"
              :maxlength="200"
              :placeholder="$t('gainos.privacy.offboarding.confirmNamePlaceholder')"
              data-gs="offboarding-confirm-name"
            />
          </Form.Item>
          <Form.Item :label="$t('gainos.privacy.offboarding.reasonLabel')">
            <Input
              v-model:value="reason"
              :maxlength="500"
              :placeholder="$t('gainos.privacy.offboarding.reasonPlaceholder')"
              data-gs="offboarding-reason"
            />
          </Form.Item>
        </Form>
        <div class="flex flex-wrap items-center gap-3">
          <Button
            :disabled="submitting || loading"
            :loading="submitting"
            danger
            data-gs="offboarding-submit-btn"
            type="primary"
            @click="submitOffboarding"
          >
            {{ submitting ? $t('gainos.privacy.offboarding.submitting') : $t('gainos.privacy.offboarding.submitBtn') }}
          </Button>
        </div>
      </div>
    </div>
  </GsCard>
</template>
