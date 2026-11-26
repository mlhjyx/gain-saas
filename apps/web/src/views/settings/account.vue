<script lang="ts" setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

import {
  Alert,
  Button,
  Form,
  Input,
  InputPassword,
  Progress,
  Skeleton,
} from 'ant-design-vue';

import { useUserStore } from '@vben/stores';
import { creditsToUsd, formatCredits } from '@gain-saas/shared';

import { changePasswordApi } from '#/api/core/auth';
import type { GainosUserInfo } from '#/api/core/user';
import { failureText, gainosApi } from '#/api/gainos';
import {
  fetchWorkspaceUsageSummary,
  type WorkspaceUsageSummaryView,
} from '#/api/settings-account';
import { walletApi, type WalletSummaryView } from '#/api/wallet';
import SettingsShell from '#/components/gainos/settings-shell.vue';
import GsCard from '#/components/gainos/ui/gs-card.vue';
import GsStat from '#/components/gainos/ui/gs-stat.vue';
import GsTag from '#/components/gainos/ui/gs-tag.vue';
import { useWorkspaceAccess } from '#/composables/use-workspace-access';
import { feedback } from '#/feedback';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

defineOptions({ name: 'SettingsAccount' });

interface ErrorBanner {
  next?: string;
  title: string;
  why?: string;
}

const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{10,}$/;

const router = useRouter();
const userStore = useUserStore();
const authStore = useAuthStore();
const { ensureLoaded, isAdmin, loaded: accessLoaded } = useWorkspaceAccess();

// ── 1) 登录密码修改（Review Focus #7：走 baseRequestClient，输错旧密码 401 不登出）──
const pwdForm = reactive({
  confirmPassword: '',
  currentPassword: '',
  newPassword: '',
});
const pwdSubmitting = ref(false);
const pwdError = ref<ErrorBanner | null>(null);
const pwdSuccess = ref<string | null>(null);

async function submitPassword(): Promise<void> {
  pwdError.value = null;
  pwdSuccess.value = null;

  if (!pwdForm.currentPassword) {
    pwdError.value = { title: $t('gainosB3.account.password.errCurrentRequired') };
    return;
  }
  if (!PASSWORD_RULE.test(pwdForm.newPassword)) {
    pwdError.value = { title: $t('gainosB3.account.password.errNewFormat') };
    return;
  }
  if (pwdForm.newPassword === pwdForm.currentPassword) {
    pwdError.value = { title: $t('gainosB3.account.password.errSameAsCurrent') };
    return;
  }
  if (pwdForm.newPassword !== pwdForm.confirmPassword) {
    pwdError.value = { title: $t('gainosB3.account.password.errConfirmMismatch') };
    return;
  }

  pwdSubmitting.value = true;
  try {
    await changePasswordApi({
      currentPassword: pwdForm.currentPassword,
      newPassword: pwdForm.newPassword,
    });
    pwdForm.currentPassword = '';
    pwdForm.newPassword = '';
    pwdForm.confirmPassword = '';
    const msg = $t('gainosB3.account.password.success');
    pwdSuccess.value = msg;
    feedback.message.success(msg);
  } catch (err) {
    const errShape = err as {
      response?: {
        data?: {
          error?: {
            code?: string;
            message?: string;
            userCopy?: { next?: string; title?: string; why?: string };
          };
        };
        status?: number;
      };
    };
    const status = errShape?.response?.status;
    const code = errShape?.response?.data?.error?.code;
    const userCopy = errShape?.response?.data?.error?.userCopy;
    if (userCopy?.title) {
      pwdError.value = {
        next: userCopy.next,
        title: userCopy.title,
        why: userCopy.why,
      };
    } else if (code === 'AUTH_FAILED' || status === 401) {
      pwdError.value = {
        next: $t('gainosB3.account.password.wrongCurrentNext'),
        title: $t('gainosB3.account.password.wrongCurrent'),
      };
    } else {
      const parsed = failureText(err);
      pwdError.value = {
        next: parsed.next,
        title: parsed.title,
        why: parsed.why,
      };
    }
  } finally {
    pwdSubmitting.value = false;
  }
}

// ── 2) 企业空间信息（管理员可内联改名，成员只读）──
const workspaceId = ref('');
const workspaceName = ref('');
const userEmail = ref('');
const editingName = ref(false);
const renameInput = ref('');
const renaming = ref(false);
const renameError = ref<ErrorBanner | null>(null);
const renameNotice = ref<string | null>(null);

async function loadWorkspaceIdentity(): Promise<void> {
  const ctx = await ensureLoaded();
  if (ctx?.workspace?.id) {
    workspaceId.value = ctx.workspace.id;
    workspaceName.value = ctx.workspace.name ?? '';
    userEmail.value = ctx.user?.email ?? userStore.userInfo?.username ?? '';
    return;
  }
  try {
    const session = await gainosApi.session();
    const active =
      session.workspaces?.find((item) => item.id === session.workspace?.id) ??
      session.workspaces?.[0];
    workspaceId.value = session.workspace?.id ?? active?.id ?? '';
    workspaceName.value =
      active?.name ??
      (userStore.userInfo as GainosUserInfo | null)?.workspaceName ??
      '';
    userEmail.value = session.user?.email ?? userStore.userInfo?.username ?? '';
  } catch {
    workspaceName.value =
      (userStore.userInfo as GainosUserInfo | null)?.workspaceName ?? '';
    userEmail.value = userStore.userInfo?.username ?? '';
  }
}

function startRename(): void {
  if (!isAdmin.value) return;
  renameError.value = null;
  renameNotice.value = null;
  renameInput.value = workspaceName.value;
  editingName.value = true;
}

function cancelRename(): void {
  editingName.value = false;
  renameError.value = null;
}

async function saveRename(): Promise<void> {
  if (!isAdmin.value || !workspaceId.value || renaming.value) return;
  renameError.value = null;
  renameNotice.value = null;
  const trimmed = renameInput.value.trim();
  if (!trimmed) {
    renameError.value = { title: $t('gainosB3.account.workspace.errNameRequired') };
    return;
  }
  renaming.value = true;
  try {
    const updated = await gainosApi.renameWorkspace(workspaceId.value, trimmed);
    const nextName = updated?.name?.trim() || trimmed;
    workspaceName.value = nextName;
    editingName.value = false;
    if (userStore.userInfo) {
      userStore.setUserInfo({
        ...userStore.userInfo,
        workspaceName: nextName,
      } as GainosUserInfo);
    }
    void ensureLoaded(true);
    const msg = $t('gainosB3.account.workspace.renameSuccess');
    renameNotice.value = msg;
    feedback.message.success(msg);
  } catch (err) {
    const parsed = failureText(err);
    renameError.value = { next: parsed.next, title: parsed.title, why: parsed.why };
  } finally {
    renaming.value = false;
  }
}

// ── 3) 空间用量与充值钱包概览（复用 PR #215 usage-summary + PR #225 wallet/summary）──
const usageLoading = ref(true);
const usageSummary = ref<WorkspaceUsageSummaryView | null>(null);
const usageError = ref<ErrorBanner | null>(null);
const walletSummary = ref<WalletSummaryView | null>(null);
const walletUnavailable = ref(false);

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const usedBytes = computed(() => Number(usageSummary.value?.sellerDocuments?.totalBytes ?? 0));
const maxBytes = computed(() => {
  const fromSaas = Number(usageSummary.value?.saas?.storageQuota?.maxBytesPerWorkspace ?? 0);
  if (Number.isFinite(fromSaas) && fromSaas > 0) return fromSaas;
  const fromEngine = Number(usageSummary.value?.sellerDocuments?.quota?.maxBytesPerWorkspace ?? 0);
  return Number.isFinite(fromEngine) && fromEngine > 0 ? fromEngine : 2_147_483_648;
});
const storagePercent = computed(() => {
  if (maxBytes.value <= 0) return 0;
  return Math.min(100, Math.round((usedBytes.value / maxBytes.value) * 100));
});

const usedDocs = computed(() => Number(usageSummary.value?.sellerDocuments?.total ?? 0));
const maxDocs = computed(
  () =>
    usageSummary.value?.saas?.storageQuota?.maxDocumentsPerWorkspace ??
    usageSummary.value?.sellerDocuments?.quota?.maxPerWorkspace ??
    500,
);

const alertLevel = computed(() => usageSummary.value?.saas?.alertLevel ?? 'ok');
const alertTone = computed<'danger' | 'success' | 'warning'>(() => {
  if (alertLevel.value === 'critical') return 'danger';
  if (alertLevel.value === 'warning') return 'warning';
  return 'success';
});
const alertLabel = computed(() => {
  if (alertLevel.value === 'critical') return $t('gainosB3.account.usage.alertCritical');
  if (alertLevel.value === 'warning') return $t('gainosB3.account.usage.alertWarning');
  return $t('gainosB3.account.usage.alertOk');
});

const walletStatusTone = computed<'danger' | 'success'>(() =>
  walletSummary.value?.account?.status === 'FROZEN' ? 'danger' : 'success',
);
const walletStatusLabel = computed(() =>
  walletSummary.value?.account?.status === 'FROZEN'
    ? $t('gainosB3.account.wallet.statusFrozen')
    : $t('gainosB3.account.wallet.statusActive'),
);

async function loadUsageAndWallet(): Promise<void> {
  usageLoading.value = true;
  usageError.value = null;
  walletUnavailable.value = false;

  const [usageRes, walletRes] = await Promise.allSettled([
    fetchWorkspaceUsageSummary(),
    walletApi.summary(),
  ]);

  if (usageRes.status === 'fulfilled') {
    usageSummary.value = usageRes.value;
  } else {
    usageSummary.value = null;
    const parsed = failureText(usageRes.reason);
    usageError.value = {
      next: parsed.next ?? $t('gainosB3.account.usage.unavailableNext'),
      title: parsed.title || $t('gainosB3.account.usage.unavailableTitle'),
      why: parsed.why,
    };
  }

  if (walletRes.status === 'fulfilled' && walletRes.value?.account) {
    walletSummary.value = walletRes.value;
  } else {
    walletSummary.value = null;
    walletUnavailable.value = true;
  }

  usageLoading.value = false;
}

// ── 4) 退出当前工作空间（feedback.confirm danger + 三段式 LAST_MEMBER / LAST_ADMIN 错误展示）──
const leaving = ref(false);
const leaveError = ref<ErrorBanner | null>(null);

function requestLeaveWorkspace(): void {
  if (!workspaceId.value || leaving.value) return;
  leaveError.value = null;
  feedback.confirm({
    cancelText: $t('gainos.common.cancel'),
    content: $t('gainosB3.account.leave.confirmContent', {
      name: workspaceName.value || 'GainOS',
    }),
    okText: $t('gainosB3.account.leave.confirmOk'),
    okType: 'danger',
    title: $t('gainosB3.account.leave.confirmTitle'),
    onOk: async () => {
      leaving.value = true;
      leaveError.value = null;
      try {
        const res = await gainosApi.leaveWorkspace(workspaceId.value);
        feedback.message.success($t('gainosB3.account.leave.success'));
        if (res?.currentWorkspace !== false) {
          await authStore.logout(false);
        } else {
          await loadWorkspaceIdentity();
        }
      } catch (err) {
        const parsed = failureText(err);
        leaveError.value = {
          next: parsed.next,
          title: parsed.title,
          why: parsed.why,
        };
      } finally {
        leaving.value = false;
      }
    },
  });
}

onMounted(() => {
  void Promise.all([loadWorkspaceIdentity(), loadUsageAndWallet()]);
});
</script>

<template>
  <SettingsShell
    :subtitle="$t('gainosB3.account.subtitle')"
    :title="$t('gainosB3.account.title')"
  >
    <div class="grid grid-cols-1 gap-4 @container" data-gs="settings-account-page">
      <!-- 1. 登录密码修改 -->
      <GsCard
        :title="$t('gainosB3.account.password.title')"
        data-gs="account-password-card"
      >
        <div class="grid gap-3">
          <p class="m-0 text-sm text-[var(--gs-fg-muted)]">
            {{ $t('gainosB3.account.password.desc') }}
          </p>

          <Alert
            v-if="pwdSuccess"
            :message="pwdSuccess"
            closable
            data-gs="account-password-success"
            role="status"
            show-icon
            type="success"
            @close="pwdSuccess = null"
          />
          <Alert
            v-if="pwdError"
            data-gs="account-password-error"
            role="alert"
            show-icon
            type="error"
          >
            <template #message>{{ pwdError.title }}</template>
            <template v-if="pwdError.why || pwdError.next" #description>
              <div class="grid gap-1">
                <p v-if="pwdError.why" class="m-0">{{ pwdError.why }}</p>
                <p v-if="pwdError.next" class="m-0">{{ pwdError.next }}</p>
              </div>
            </template>
          </Alert>

          <Form layout="vertical" @submit.prevent="submitPassword">
            <div class="grid grid-cols-1 gap-x-4 @min-[700px]:grid-cols-3">
              <Form.Item :label="$t('gainosB3.account.password.currentLabel')">
                <div data-gs="account-current-password">
                  <InputPassword
                    v-model:value="pwdForm.currentPassword"
                    :placeholder="$t('gainosB3.account.password.currentPlaceholder')"
                    autocomplete="current-password"
                  />
                </div>
              </Form.Item>
              <Form.Item :label="$t('gainosB3.account.password.newLabel')">
                <div data-gs="account-new-password">
                  <InputPassword
                    v-model:value="pwdForm.newPassword"
                    :placeholder="$t('gainosB3.account.password.newPlaceholder')"
                    autocomplete="new-password"
                  />
                </div>
              </Form.Item>
              <Form.Item :label="$t('gainosB3.account.password.confirmLabel')">
                <div data-gs="account-confirm-password">
                  <InputPassword
                    v-model:value="pwdForm.confirmPassword"
                    :placeholder="$t('gainosB3.account.password.confirmPlaceholder')"
                    autocomplete="new-password"
                    @press-enter="submitPassword"
                  />
                </div>
              </Form.Item>
            </div>
            <div class="flex flex-wrap items-center gap-3">
              <Button
                :disabled="pwdSubmitting"
                :loading="pwdSubmitting"
                data-gs="account-password-submit"
                html-type="submit"
                type="primary"
              >
                {{
                  pwdSubmitting
                    ? $t('gainosB3.account.password.submitting')
                    : $t('gainosB3.account.password.submit')
                }}
              </Button>
              <span class="text-xs text-[var(--gs-fg-muted)]">
                {{ $t('gainosB3.account.password.newHint') }}
              </span>
            </div>
          </Form>
        </div>
      </GsCard>

      <!-- 2. 企业空间信息 -->
      <GsCard
        :title="$t('gainosB3.account.workspace.title')"
        data-gs="account-workspace-card"
      >
        <template #extra>
          <Button
            v-if="isAdmin && !editingName"
            data-gs="workspace-rename-edit"
            size="small"
            @click="startRename"
          >
            {{ $t('gainosB3.account.workspace.editName') }}
          </Button>
        </template>

        <div class="grid gap-3">
          <p class="m-0 text-sm text-[var(--gs-fg-muted)]">
            {{ $t('gainosB3.account.workspace.desc') }}
          </p>

          <Alert
            v-if="renameNotice"
            :message="renameNotice"
            closable
            data-gs="workspace-rename-success"
            role="status"
            show-icon
            type="success"
            @close="renameNotice = null"
          />
          <Alert
            v-if="renameError"
            data-gs="workspace-rename-error"
            role="alert"
            show-icon
            type="warning"
          >
            <template #message>{{ renameError.title }}</template>
            <template v-if="renameError.why || renameError.next" #description>
              <div class="grid gap-1">
                <p v-if="renameError.why" class="m-0">{{ renameError.why }}</p>
                <p v-if="renameError.next" class="m-0">{{ renameError.next }}</p>
              </div>
            </template>
          </Alert>

          <div class="grid grid-cols-1 gap-3 @min-[640px]:grid-cols-3">
            <div class="grid gap-1 rounded-lg border border-[var(--gs-border)] bg-[var(--gs-surface-2)] p-3">
              <span class="text-xs text-[var(--gs-fg-muted)]">
                {{ $t('gainosB3.account.workspace.emailLabel') }}
              </span>
              <strong class="truncate text-sm font-semibold text-[var(--gs-fg)]" data-gs="account-user-email">
                {{ userEmail || '—' }}
              </strong>
            </div>

            <div class="grid gap-1 rounded-lg border border-[var(--gs-border)] bg-[var(--gs-surface-2)] p-3">
              <span class="text-xs text-[var(--gs-fg-muted)]">
                {{ $t('gainosB3.account.workspace.nameLabel') }}
              </span>
              <template v-if="editingName && isAdmin">
                <div class="flex flex-wrap items-center gap-2 pt-1">
                  <div class="min-w-[160px] flex-1">
                    <Input
                      v-model:value="renameInput"
                      :maxlength="128"
                      :placeholder="$t('gainosB3.account.workspace.namePlaceholder')"
                      data-gs="workspace-rename-input"
                      @press-enter="saveRename"
                    />
                  </div>
                  <Button
                    :disabled="renaming"
                    :loading="renaming"
                    data-gs="workspace-rename-save"
                    size="small"
                    type="primary"
                    @click="saveRename"
                  >
                    {{
                      renaming
                        ? $t('gainosB3.account.workspace.savingName')
                        : $t('gainosB3.account.workspace.saveName')
                    }}
                  </Button>
                  <Button
                    :disabled="renaming"
                    data-gs="workspace-rename-cancel"
                    size="small"
                    @click="cancelRename"
                  >
                    {{ $t('gainosB3.account.workspace.cancelEdit') }}
                  </Button>
                </div>
              </template>
              <strong v-else class="truncate text-sm font-semibold text-[var(--gs-fg)]" data-gs="account-workspace-name">
                {{ workspaceName || '—' }}
              </strong>
            </div>

            <div class="grid gap-1 rounded-lg border border-[var(--gs-border)] bg-[var(--gs-surface-2)] p-3">
              <span class="text-xs text-[var(--gs-fg-muted)]">
                {{ $t('gainosB3.account.workspace.roleLabel') }}
              </span>
              <div>
                <GsTag :tone="isAdmin ? 'info' : 'neutral'" data-gs="account-workspace-role">
                  {{
                    isAdmin
                      ? $t('gainosB3.account.workspace.roleAdmin')
                      : $t('gainosB3.account.workspace.roleMember')
                  }}
                </GsTag>
              </div>
            </div>
          </div>

          <p
            v-if="accessLoaded && !isAdmin"
            class="m-0 text-xs text-[var(--gs-fg-muted)]"
            data-gs="workspace-rename-readonly"
          >
            {{ $t('gainosB3.account.workspace.memberReadonlyHint') }}
          </p>
        </div>
      </GsCard>

      <!-- 3. 空间用量与充值钱包概览 -->
      <GsCard
        :title="$t('gainosB3.account.usage.title')"
        data-gs="account-usage-wallet-card"
      >
        <template #extra>
          <div class="flex flex-wrap items-center gap-2">
            <GsTag v-if="usageSummary" :tone="alertTone" data-gs="account-usage-alert-tag">
              {{ alertLabel }}
            </GsTag>
            <Button
              :disabled="usageLoading"
              :loading="usageLoading"
              data-gs="account-usage-refresh"
              size="small"
              @click="loadUsageAndWallet"
            >
              {{ $t('gainosB3.account.usage.refresh') }}
            </Button>
          </div>
        </template>

        <div class="grid gap-5">
          <p class="m-0 text-sm text-[var(--gs-fg-muted)]">
            {{ $t('gainosB3.account.usage.desc') }}
          </p>

          <Skeleton v-if="usageLoading" active :paragraph="{ rows: 4 }" :title="false" />

          <template v-else>
            <!-- 3a. 实体与存储用量 -->
            <section class="grid gap-3" data-gs="account-usage-section">
              <Alert v-if="usageError" role="alert" show-icon type="warning">
                <template #message>{{ usageError.title }}</template>
                <template v-if="usageError.next" #description>{{ usageError.next }}</template>
              </Alert>

              <template v-else-if="usageSummary">
                <div class="grid gap-2 rounded-xl border border-[var(--gs-border)] bg-[var(--gs-surface-2)] p-4">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <span class="text-sm font-medium text-[var(--gs-fg)]">
                      {{ $t('gainosB3.account.usage.storageTitle') }}
                    </span>
                    <GsTag tone="neutral">
                      {{
                        usageSummary.saas?.storageQuota?.isDefault === false
                          ? $t('gainosB3.account.usage.storageQuotaCustom')
                          : $t('gainosB3.account.usage.storageQuotaDefault')
                      }}
                    </GsTag>
                  </div>
                  <Progress
                    :percent="storagePercent"
                    :status="alertLevel === 'critical' ? 'exception' : 'normal'"
                    size="small"
                  />
                  <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--gs-fg-muted)]">
                    <span data-gs="account-usage-bytes">
                      {{
                        $t('gainosB3.account.usage.storageBytes', {
                          max: formatBytes(maxBytes),
                          used: formatBytes(usedBytes),
                        })
                      }}
                    </span>
                    <span data-gs="account-usage-docs">
                      {{
                        $t('gainosB3.account.usage.storageDocs', {
                          max: maxDocs,
                          used: usedDocs,
                        })
                      }}
                    </span>
                  </div>
                </div>

                <div class="grid grid-cols-1 gap-3 @min-[560px]:grid-cols-2 @min-[900px]:grid-cols-4">
                  <div data-gs="usage-stat-members">
                    <GsStat
                      :label="$t('gainosB3.account.usage.statMembers')"
                      :value="usageSummary.saas?.activeMembers ?? 0"
                    />
                  </div>
                  <div data-gs="usage-stat-companies">
                    <GsStat
                      :label="$t('gainosB3.account.usage.statCompanies')"
                      :value="usageSummary.companies?.total ?? 0"
                    />
                  </div>
                  <div data-gs="usage-stat-profiles">
                    <GsStat
                      :hint="
                        $t('gainosB3.account.usage.statProfilesHint', {
                          active: usageSummary.icps?.active ?? 0,
                        })
                      "
                      :label="$t('gainosB3.account.usage.statProfiles')"
                      :value="usageSummary.icps?.total ?? 0"
                    />
                  </div>
                  <div data-gs="usage-stat-buyers">
                    <GsStat
                      :label="$t('gainosB3.account.usage.statBuyerCompanies')"
                      :value="usageSummary.canonicalCompanies?.total ?? 0"
                    />
                  </div>
                  <div data-gs="usage-stat-contacts">
                    <GsStat
                      :label="$t('gainosB3.account.usage.statBuyerContacts')"
                      :value="usageSummary.canonicalContacts?.total ?? 0"
                    />
                  </div>
                  <div data-gs="usage-stat-campaigns">
                    <GsStat
                      :label="$t('gainosB3.account.usage.statCampaigns')"
                      :value="usageSummary.saas?.campaigns ?? 0"
                    />
                  </div>
                  <div data-gs="usage-stat-opportunities">
                    <GsStat
                      :label="$t('gainosB3.account.usage.statOpportunities')"
                      :value="usageSummary.saas?.qgos ?? 0"
                    />
                  </div>
                  <div data-gs="usage-stat-outreach">
                    <GsStat
                      :label="$t('gainosB3.account.usage.statOutreach30d')"
                      :value="usageSummary.saas?.outreachSent30d ?? 0"
                    />
                  </div>
                </div>
              </template>
            </section>

            <!-- 3b. 积分钱包摘要（直接复用 GET /api/wallet/summary，不另造旧预算接口） -->
            <section
              class="grid gap-3 border-t border-[var(--gs-divider)] pt-4"
              data-gs="account-wallet-section"
            >
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex flex-wrap items-center gap-2">
                  <h3 class="m-0 text-sm font-semibold text-[var(--gs-fg)]">
                    {{ $t('gainosB3.account.wallet.title') }}
                  </h3>
                  <GsTag
                    v-if="walletSummary"
                    :tone="walletStatusTone"
                    data-gs="account-wallet-status"
                  >
                    {{ walletStatusLabel }}
                  </GsTag>
                </div>
                <Button
                  v-if="isAdmin"
                  data-gs="account-goto-wallet-detail"
                  size="small"
                  type="link"
                  @click="router.push('/settings/privacy')"
                >
                  {{ $t('gainosB3.account.wallet.gotoFullBilling') }}
                </Button>
              </div>

              <template v-if="walletSummary">
                <div class="grid grid-cols-1 gap-3 @min-[560px]:grid-cols-2 @min-[900px]:grid-cols-4">
                  <div data-gs="account-wallet-available">
                    <GsStat
                      :label="$t('gainosB3.account.wallet.statAvailable')"
                      :suffix="$t('gainosB3.account.wallet.unitCredits')"
                      :value="formatCredits(walletSummary.account.availableCredits ?? '0')"
                    />
                  </div>
                  <div data-gs="account-wallet-held">
                    <GsStat
                      :label="$t('gainosB3.account.wallet.statHeld')"
                      :suffix="$t('gainosB3.account.wallet.unitCredits')"
                      :value="formatCredits(walletSummary.account.heldCredits ?? '0')"
                    />
                  </div>
                  <div data-gs="account-wallet-bonus">
                    <GsStat
                      :label="$t('gainosB3.account.wallet.statBonus')"
                      :suffix="$t('gainosB3.account.wallet.unitCredits')"
                      :value="formatCredits(walletSummary.lotsSummary?.bonusCredits ?? '0')"
                    />
                  </div>
                  <div data-gs="account-wallet-spent">
                    <GsStat
                      :label="$t('gainosB3.account.wallet.statSpent')"
                      :suffix="$t('gainosB3.account.wallet.unitCredits')"
                      :value="formatCredits(walletSummary.account.lifetimeSpent ?? '0')"
                    />
                  </div>
                </div>
                <p class="m-0 text-xs text-[var(--gs-fg-muted)]">
                  {{
                    $t('gainosB3.account.wallet.balanceNote', {
                      holds: walletSummary.activeHoldsCount ?? 0,
                      paid: formatCredits(walletSummary.lotsSummary?.paidCredits ?? '0'),
                      usd: creditsToUsd(walletSummary.account.availableCredits ?? '0'),
                    })
                  }}
                </p>
              </template>
              <p v-else-if="walletUnavailable" class="m-0 text-xs text-[var(--gs-fg-muted)]">
                {{ $t('gainosB3.account.wallet.unavailable') }}
              </p>
            </section>
          </template>
        </div>
      </GsCard>

      <!-- 4. 退出当前工作空间 -->
      <GsCard
        :title="$t('gainosB3.account.leave.title')"
        data-gs="account-leave-card"
      >
        <div class="grid gap-3">
          <p class="m-0 text-sm text-[var(--gs-fg-muted)]">
            {{ $t('gainosB3.account.leave.desc') }}
          </p>

          <Alert
            v-if="leaveError"
            data-gs="account-leave-error"
            role="alert"
            show-icon
            type="warning"
          >
            <template #message>{{ leaveError.title }}</template>
            <template v-if="leaveError.why || leaveError.next" #description>
              <div class="grid gap-1">
                <p v-if="leaveError.why" class="m-0">{{ leaveError.why }}</p>
                <p v-if="leaveError.next" class="m-0">{{ leaveError.next }}</p>
              </div>
            </template>
          </Alert>

          <div class="flex flex-wrap items-center gap-3">
            <Button
              :disabled="!workspaceId || leaving"
              :loading="leaving"
              danger
              data-gs="account-leave-btn"
              @click="requestLeaveWorkspace"
            >
              {{
                leaving
                  ? $t('gainosB3.account.leave.leaving')
                  : $t('gainosB3.account.leave.button')
              }}
            </Button>
          </div>
        </div>
      </GsCard>
    </div>
  </SettingsShell>
</template>
