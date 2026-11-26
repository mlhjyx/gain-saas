<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue';

import { Alert, Button, Form, Input, InputNumber, Modal, Popconfirm, Switch } from 'ant-design-vue';

import { formatDateTime } from '@gain-saas/shared';

import {
  outreachByoApi,
  type ByoMailboxView,
  type MailboxConnectionTestResult,
  type OAuthStartResult,
  type SenderDomainView,
  type VerifyDomainDnsResult,
} from '#/api/outreach-byo';
import GsCard from '#/components/gainos/ui/gs-card.vue';
import GsEmpty from '#/components/gainos/ui/gs-empty.vue';
import GsSelect from '#/components/gainos/ui/gs-select.vue';
import GsTable from '#/components/gainos/ui/gs-table.vue';
import GsTag from '#/components/gainos/ui/gs-tag.vue';
import { feedback } from '#/feedback';
import { $t } from '#/locales';

defineOptions({ name: 'ByoMailboxPanel' });

const props = withDefaults(
  defineProps<{
    isAdmin?: boolean;
  }>(),
  {
    isAdmin: true,
  },
);

const loading = ref(false);
const mailboxes = ref<ByoMailboxView[]>([]);
const domains = ref<SenderDomainView[]>([]);
const errorMessage = ref<string | null>(null);
const oauthLinkResult = ref<OAuthStartResult | null>(null);
const lastConnResult = ref<MailboxConnectionTestResult | null>(null);
const latestDnsResult = ref<VerifyDomainDnsResult | null>(null);

const creating = ref(false);
const createForm = ref({
  address: '',
  displayName: '',
  warmupStage: 'W1' as 'MATURE' | 'W1' | 'W2' | 'W3',
});

const credModalOpen = ref(false);
const savingCreds = ref(false);
const activeMailbox = ref<ByoMailboxView | null>(null);
const credForm = ref({
  imapHost: '',
  imapPort: 993 as number | undefined,
  imapSecure: true,
  password: '',
  smtpHost: '',
  smtpPort: 465 as number | undefined,
  smtpSecure: true,
  username: '',
});

const testingId = ref<string | null>(null);
const oauthLoadingId = ref<string | null>(null);
const deletingId = ref<string | null>(null);
const verifyingDomainId = ref<string | null>(null);
const dkimSelectors = ref<Record<string, string>>({});

function extractErrorMessage(err: unknown): string {
  const apiMsg = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data
    ?.error?.message;
  if (typeof apiMsg === 'string' && apiMsg.trim()) return apiMsg;
  if (err instanceof Error && err.message.trim()) return err.message;
  return $t('outreach-byo.actionFailed');
}

async function loadAll(): Promise<void> {
  loading.value = true;
  errorMessage.value = null;
  try {
    const [mbList, domList] = await Promise.all([
      outreachByoApi.listMailboxes(),
      outreachByoApi.listDomains(),
    ]);
    mailboxes.value = Array.isArray(mbList) ? mbList : [];
    domains.value = Array.isArray(domList) ? domList : [];
    for (const dom of domains.value) {
      if (!dkimSelectors.value[dom.id]) {
        dkimSelectors.value[dom.id] = dom.dkimSelector || 'google';
      }
    }
  } catch (err) {
    errorMessage.value = extractErrorMessage(err);
  } finally {
    loading.value = false;
  }
}

async function createMailbox(): Promise<void> {
  const address = createForm.value.address.trim().toLowerCase();
  const displayName = createForm.value.displayName.trim();
  if (!address || !address.includes('@') || !displayName) {
    feedback.message.warning($t('outreach-byo.validationAddress'));
    return;
  }
  creating.value = true;
  errorMessage.value = null;
  try {
    await outreachByoApi.createMailbox({
      address,
      displayName,
      warmupStage: createForm.value.warmupStage,
    });
    createForm.value.address = '';
    createForm.value.displayName = '';
    feedback.message.success($t('outreach-byo.createMailboxSuccess'));
    await loadAll();
  } catch (err) {
    errorMessage.value = extractErrorMessage(err);
  } finally {
    creating.value = false;
  }
}

function openCredModal(mb: ByoMailboxView): void {
  activeMailbox.value = mb;
  credForm.value = {
    imapHost: mb.imapHost ?? '',
    imapPort: mb.imapPort ?? 993,
    imapSecure: mb.imapSecure ?? true,
    password: '',
    smtpHost: mb.smtpHost ?? '',
    smtpPort: mb.smtpPort ?? 465,
    smtpSecure: mb.smtpSecure ?? true,
    username: mb.address,
  };
  credModalOpen.value = true;
}

async function saveCredentials(): Promise<void> {
  if (!activeMailbox.value) return;
  const smtpHost = credForm.value.smtpHost.trim();
  const smtpPort = Number(credForm.value.smtpPort);
  const password = credForm.value.password;
  if (!smtpHost || !Number.isInteger(smtpPort) || smtpPort < 1 || !password.trim()) {
    feedback.message.warning($t('outreach-byo.validationCreds'));
    return;
  }
  savingCreds.value = true;
  errorMessage.value = null;
  try {
    const imapHost = credForm.value.imapHost.trim();
    await outreachByoApi.configureCredentials(activeMailbox.value.id, {
      authMode: 'password',
      imapHost: imapHost || null,
      imapPort: imapHost ? Number(credForm.value.imapPort || 993) : null,
      imapSecure: credForm.value.imapSecure,
      password,
      smtpHost,
      smtpPort,
      smtpSecure: credForm.value.smtpSecure,
      username: credForm.value.username.trim() || activeMailbox.value.address,
    });
    credForm.value.password = '';
    credModalOpen.value = false;
    feedback.message.success($t('outreach-byo.saveCredSuccess'));
    await loadAll();
  } catch (err) {
    errorMessage.value = extractErrorMessage(err);
  } finally {
    savingCreds.value = false;
  }
}

async function testConnection(mb: ByoMailboxView): Promise<void> {
  testingId.value = mb.id;
  errorMessage.value = null;
  try {
    const result = await outreachByoApi.testConnection(mb.id);
    lastConnResult.value = result;
    if (result.ready) {
      feedback.message.success(
        $t('outreach-byo.testConnSuccess', { smtpMs: result.smtp.latencyMs ?? 0 }),
      );
    } else {
      feedback.message.warning($t('outreach-byo.testConnNotPassed'));
    }
    await loadAll();
  } catch (err) {
    errorMessage.value = extractErrorMessage(err);
  } finally {
    testingId.value = null;
  }
}

async function startOAuth(mb: ByoMailboxView, provider: 'google' | 'm365'): Promise<void> {
  oauthLoadingId.value = `${mb.id}:${provider}`;
  errorMessage.value = null;
  try {
    const res = await outreachByoApi.startOAuth(mb.id, provider);
    oauthLinkResult.value = res;
    feedback.message.success(
      $t('outreach-byo.oauthReadyNotice', {
        provider: provider === 'google' ? 'Google Workspace' : 'Microsoft 365',
      }),
    );
  } catch (err) {
    errorMessage.value = extractErrorMessage(err);
  } finally {
    oauthLoadingId.value = null;
  }
}

async function removeMailbox(mb: ByoMailboxView): Promise<void> {
  deletingId.value = mb.id;
  errorMessage.value = null;
  try {
    await outreachByoApi.deleteMailbox(mb.id);
    feedback.message.success($t('outreach-byo.deleteSuccess'));
    await loadAll();
  } catch (err) {
    errorMessage.value = extractErrorMessage(err);
  } finally {
    deletingId.value = null;
  }
}

async function verifyDomain(domain: SenderDomainView): Promise<void> {
  verifyingDomainId.value = domain.id;
  errorMessage.value = null;
  try {
    const selector = dkimSelectors.value[domain.id]?.trim() || 'google';
    const result = await outreachByoApi.verifyDomainDns(domain.id, selector);
    latestDnsResult.value = result;
    feedback.message.success($t('outreach-byo.dnsVerifySuccess', { domain: domain.domain }));
    await loadAll();
  } catch (err) {
    errorMessage.value = extractErrorMessage(err);
  } finally {
    verifyingDomainId.value = null;
  }
}

async function copyRecordValue(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    feedback.message.success($t('outreach-byo.copiedSuccess'));
  } catch {
    feedback.message.info(value);
  }
}

function authModeLabel(mode?: string): string {
  if (mode === 'oauth_google') return $t('outreach-byo.authModeGoogle');
  if (mode === 'oauth_m365') return $t('outreach-byo.authModeM365');
  return $t('outreach-byo.authModePassword');
}

function verifyTone(status?: string | null): 'danger' | 'neutral' | 'success' {
  if (status === 'OK') return 'success';
  if (status) return 'danger';
  return 'neutral';
}

function verifyLabel(status?: string | null): string {
  if (status === 'OK') return $t('outreach-byo.verifyOk');
  if (status) return $t('outreach-byo.verifyNotPassed');
  return $t('outreach-byo.verifyPending');
}

function fmtTime(val?: string | null): string {
  return formatDateTime(val) || '—';
}

const warmupOptions = computed(() => [
  { label: $t('outreach-byo.warmupW1'), value: 'W1' },
  { label: $t('outreach-byo.warmupW2'), value: 'W2' },
  { label: $t('outreach-byo.warmupW3'), value: 'W3' },
  { label: $t('outreach-byo.warmupMature'), value: 'MATURE' },
]);

const mailboxColumns = computed(() => [
  { dataIndex: 'address', key: 'address', title: $t('outreach-byo.colAddress'), width: 220 },
  { dataIndex: 'authMode', key: 'authMode', title: $t('outreach-byo.colAuthMode'), width: 170 },
  { dataIndex: 'quota', key: 'quota', title: $t('outreach-byo.colQuota'), width: 130 },
  {
    dataIndex: 'verify',
    key: 'verify',
    title: $t('outreach-byo.colVerifyStatus'),
    width: 170,
  },
  { dataIndex: 'actions', key: 'actions', title: $t('outreach-byo.colActions'), width: 320 },
]);

const domainColumns = computed(() => [
  { dataIndex: 'domain', key: 'domain', title: $t('outreach-byo.colDomain'), width: 190 },
  {
    dataIndex: 'dkimSelector',
    key: 'dkimSelector',
    title: $t('outreach-byo.colDkimSelector'),
    width: 150,
  },
  { dataIndex: 'status', key: 'status', title: $t('outreach-byo.colDnsStatus'), width: 120 },
  { dataIndex: 'details', key: 'details', title: $t('outreach-byo.colDnsDetails'), width: 240 },
  { dataIndex: 'checkedAt', key: 'checkedAt', title: $t('outreach-byo.colDnsTime'), width: 160 },
  { dataIndex: 'actions', key: 'actions', title: $t('outreach-byo.colActions'), width: 140 },
]);

onMounted(() => {
  void loadAll();
});
</script>

<template>
  <div class="grid grid-cols-1 gap-4 @container" data-gs="byo-mailbox-panel">
    <Alert
      :description="$t('outreach-byo.securityBannerDesc')"
      :message="$t('outreach-byo.securityBannerTitle')"
      show-icon
      type="info"
    />

    <Alert
      v-if="!props.isAdmin"
      :message="$t('outreach-byo.adminOnlyNotice')"
      show-icon
      type="warning"
    />

    <Alert
      v-if="errorMessage"
      :message="errorMessage"
      closable
      role="alert"
      show-icon
      type="error"
      @close="errorMessage = null"
    />

    <Alert
      v-if="oauthLinkResult"
      :message="
        $t('outreach-byo.oauthReadyNotice', {
          provider: oauthLinkResult.provider === 'google' ? 'Google Workspace' : 'Microsoft 365',
        })
      "
      closable
      data-gs="byo-oauth-banner"
      show-icon
      type="success"
      @close="oauthLinkResult = null"
    >
      <template #action>
        <Button
          :href="oauthLinkResult.authorizeUrl"
          rel="noopener noreferrer"
          size="small"
          target="_blank"
          type="primary"
        >
          {{ $t('outreach-byo.openOAuthLink') }}
        </Button>
      </template>
    </Alert>

    <GsCard
      v-if="props.isAdmin"
      :title="$t('outreach-byo.addMailboxTitle')"
      data-gs="byo-create-card"
    >
      <Form layout="vertical" @submit.prevent="createMailbox">
        <div class="grid grid-cols-1 gap-3 @min-[760px]:grid-cols-3">
          <Form.Item :label="$t('outreach-byo.addressLabel')">
            <Input
              v-model:value="createForm.address"
              :placeholder="$t('outreach-byo.addressPlaceholder')"
              data-gs="byo-create-address"
            />
          </Form.Item>
          <Form.Item :label="$t('outreach-byo.displayNameLabel')">
            <Input
              v-model:value="createForm.displayName"
              :placeholder="$t('outreach-byo.displayNamePlaceholder')"
              data-gs="byo-create-display-name"
            />
          </Form.Item>
          <Form.Item :label="$t('outreach-byo.warmupStageLabel')">
            <GsSelect
              v-model="createForm.warmupStage"
              :ariaLabel="$t('outreach-byo.warmupStageLabel')"
              :options="warmupOptions"
            />
          </Form.Item>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Button
            :loading="creating"
            data-gs="byo-create-submit"
            type="primary"
            @click="createMailbox"
          >
            {{ $t('outreach-byo.createMailboxBtn') }}
          </Button>
          <Button :loading="loading" data-gs="byo-refresh-btn" @click="loadAll">
            {{ $t('outreach-byo.refresh') }}
          </Button>
        </div>
      </Form>
    </GsCard>

    <GsCard :title="$t('outreach-byo.mailboxListTitle')" data-gs="byo-mailbox-list-card">
      <GsEmpty
        v-if="!loading && mailboxes.length === 0"
        :description="$t('outreach-byo.emptyMailboxesDesc')"
        :title="$t('outreach-byo.emptyMailboxesTitle')"
        simple
      />
      <GsTable
        v-else
        :columns="mailboxColumns"
        :data-source="mailboxes"
        :loading="loading"
        :scroll="{ x: 960 }"
        row-key="id"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'address'">
            <div class="text-xs font-medium text-[var(--gs-fg)]">{{ record.address }}</div>
            <div class="text-xs text-[var(--gs-fg-subtle)]">
              {{ record.displayName }} · {{ record.smtpHost || '—' }}
            </div>
          </template>
          <template v-else-if="column.key === 'authMode'">
            <div class="flex flex-wrap items-center gap-1">
              <GsTag tone="info">{{ authModeLabel(record.authMode) }}</GsTag>
              <GsTag :tone="record.hasCredentials ? 'success' : 'warning'">
                {{
                  record.hasCredentials
                    ? $t('outreach-byo.credConfigured')
                    : $t('outreach-byo.credNotConfigured')
                }}
              </GsTag>
            </div>
          </template>
          <template v-else-if="column.key === 'quota'">
            <span class="text-xs text-[var(--gs-fg-2)]">
              {{ record.dailyCap }} / {{ record.weeklyCap }} · {{ record.warmupStage }}
            </span>
          </template>
          <template v-else-if="column.key === 'verify'">
            <div class="grid gap-0.5">
              <GsTag :tone="verifyTone(record.lastVerifyStatus)">
                {{ verifyLabel(record.lastVerifyStatus) }}
              </GsTag>
              <span v-if="record.lastVerifiedAt" class="text-xs text-[var(--gs-fg-subtle)]">
                {{ fmtTime(record.lastVerifiedAt) }}
              </span>
            </div>
          </template>
          <template v-else-if="column.key === 'actions'">
            <div v-if="props.isAdmin" class="flex flex-wrap items-center gap-1.5">
              <Button
                data-gs="byo-config-cred-btn"
                size="small"
                @click="openCredModal(record as ByoMailboxView)"
              >
                {{ $t('outreach-byo.configureCredBtn') }}
              </Button>
              <Button
                :disabled="!record.hasCredentials"
                :loading="testingId === record.id"
                data-gs="byo-test-conn-btn"
                size="small"
                @click="testConnection(record as ByoMailboxView)"
              >
                {{ $t('outreach-byo.testConnBtn') }}
              </Button>
              <Button
                :loading="oauthLoadingId === `${record.id}:google`"
                data-gs="byo-oauth-google-btn"
                size="small"
                @click="startOAuth(record as ByoMailboxView, 'google')"
              >
                {{ $t('outreach-byo.connectGoogleBtn') }}
              </Button>
              <Button
                :loading="oauthLoadingId === `${record.id}:m365`"
                data-gs="byo-oauth-m365-btn"
                size="small"
                @click="startOAuth(record as ByoMailboxView, 'm365')"
              >
                {{ $t('outreach-byo.connectM365Btn') }}
              </Button>
              <Popconfirm
                :description="$t('outreach-byo.deleteConfirmDesc')"
                :title="$t('outreach-byo.deleteConfirmTitle')"
                @confirm="removeMailbox(record as ByoMailboxView)"
              >
                <Button
                  :loading="deletingId === record.id"
                  danger
                  data-gs="byo-delete-btn"
                  size="small"
                >
                  {{ $t('outreach-byo.deleteBtn') }}
                </Button>
              </Popconfirm>
            </div>
          </template>
        </template>
      </GsTable>
    </GsCard>

    <GsCard :title="$t('outreach-byo.domainsTitle')" data-gs="byo-domains-card">
      <GsEmpty
        v-if="!loading && domains.length === 0"
        :description="$t('outreach-byo.emptyDomainsDesc')"
        :title="$t('outreach-byo.emptyDomainsTitle')"
        simple
      />
      <GsTable
        v-else
        :columns="domainColumns"
        :data-source="domains"
        :loading="loading"
        :scroll="{ x: 880 }"
        row-key="id"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'domain'">
            <span class="font-mono text-xs font-medium text-[var(--gs-fg)]">{{
              record.domain
            }}</span>
          </template>
          <template v-else-if="column.key === 'dkimSelector'">
            <Input
              v-model:value="dkimSelectors[record.id]"
              :disabled="!props.isAdmin"
              data-gs="byo-dkim-selector"
              size="small"
            />
          </template>
          <template v-else-if="column.key === 'status'">
            <GsTag
              :tone="
                record.dnsVerifiedAt ? (record.dnsReady ? 'success' : 'warning') : 'neutral'
              "
            >
              {{
                record.dnsVerifiedAt
                  ? record.dnsReady
                    ? $t('outreach-byo.dnsReady')
                    : $t('outreach-byo.dnsNeedsFix')
                  : $t('outreach-byo.dnsUnchecked')
              }}
            </GsTag>
          </template>
          <template v-else-if="column.key === 'details'">
            <div v-if="record.dnsReport?.ok" class="flex flex-wrap gap-1">
              <GsTag :tone="record.dnsReport.ok.spf ? 'success' : 'danger'">SPF</GsTag>
              <GsTag :tone="record.dnsReport.ok.dkim ? 'success' : 'warning'">DKIM</GsTag>
              <GsTag :tone="record.dnsReport.ok.dmarc ? 'success' : 'warning'">DMARC</GsTag>
              <GsTag :tone="record.dnsReport.ok.mx ? 'success' : 'danger'">MX</GsTag>
            </div>
            <span v-else class="text-xs text-[var(--gs-fg-subtle)]">—</span>
          </template>
          <template v-else-if="column.key === 'checkedAt'">
            <span class="text-xs text-[var(--gs-fg-muted)]">{{
              fmtTime(record.dnsVerifiedAt)
            }}</span>
          </template>
          <template v-else-if="column.key === 'actions'">
            <Button
              v-if="props.isAdmin"
              :loading="verifyingDomainId === record.id"
              data-gs="byo-verify-dns-btn"
              size="small"
              type="primary"
              @click="verifyDomain(record as SenderDomainView)"
            >
              {{ $t('outreach-byo.verifyDnsBtn') }}
            </Button>
          </template>
        </template>
      </GsTable>

      <div
        v-if="latestDnsResult?.template"
        class="mt-4 grid gap-2 rounded-lg border border-[var(--gs-border)] bg-[var(--gs-surface-2)] p-3"
        data-gs="byo-dns-template"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-xs font-semibold text-[var(--gs-fg)]">
            {{ $t('outreach-byo.dnsTemplateTitle', { domain: latestDnsResult.domain.domain }) }}
          </span>
          <Button size="small" @click="copyRecordValue(latestDnsResult.template)">
            {{ $t('outreach-byo.copyValueBtn') }}
          </Button>
        </div>
        <pre
          class="m-0 overflow-x-auto whitespace-pre-wrap rounded border border-[var(--gs-border)] bg-[var(--gs-surface-1)] p-3 font-mono text-xs text-[var(--gs-fg-2)]"
        >{{ latestDnsResult.template }}</pre>
      </div>
    </GsCard>

    <Modal
      v-model:open="credModalOpen"
      :confirm-loading="savingCreds"
      :ok-text="$t('outreach-byo.saveCredBtn')"
      :title="$t('outreach-byo.credModalTitle')"
      @ok="saveCredentials"
    >
      <div class="grid gap-3 pt-2" data-gs="byo-cred-modal">
        <Alert :message="$t('outreach-byo.credSecurityHint')" show-icon type="info" />
        <Form layout="vertical">
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Form.Item :label="$t('outreach-byo.smtpHostLabel')">
              <Input
                v-model:value="credForm.smtpHost"
                :placeholder="$t('outreach-byo.smtpHostPlaceholder')"
                data-gs="byo-cred-smtp-host"
              />
            </Form.Item>
            <Form.Item :label="$t('outreach-byo.smtpPortLabel')">
              <InputNumber
                v-model:value="credForm.smtpPort"
                :max="65535"
                :min="1"
                class="w-full"
                data-gs="byo-cred-smtp-port"
              />
            </Form.Item>
          </div>
          <Form.Item :label="$t('outreach-byo.smtpSecureLabel')">
            <Switch v-model:checked="credForm.smtpSecure" />
          </Form.Item>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Form.Item :label="$t('outreach-byo.imapHostLabel')">
              <Input
                v-model:value="credForm.imapHost"
                :placeholder="$t('outreach-byo.imapHostPlaceholder')"
                data-gs="byo-cred-imap-host"
              />
            </Form.Item>
            <Form.Item :label="$t('outreach-byo.imapPortLabel')">
              <InputNumber
                v-model:value="credForm.imapPort"
                :max="65535"
                :min="1"
                class="w-full"
                data-gs="byo-cred-imap-port"
              />
            </Form.Item>
          </div>
          <Form.Item :label="$t('outreach-byo.usernameLabel')">
            <Input v-model:value="credForm.username" data-gs="byo-cred-username" />
          </Form.Item>
          <Form.Item :label="$t('outreach-byo.passwordLabel')">
            <Input.Password
              v-model:value="credForm.password"
              :placeholder="$t('outreach-byo.passwordPlaceholder')"
              autocomplete="new-password"
              data-gs="byo-cred-password"
            />
          </Form.Item>
        </Form>
      </div>
    </Modal>
  </div>
</template>
