<script lang="ts" setup>
import { onMounted, reactive, ref } from 'vue';

import { Alert, Button, Form, Input, Modal, RadioGroup, RadioButton, Skeleton } from 'ant-design-vue';

import { feedback } from '#/feedback';
import { $t } from '#/locales';

import EmptyState from '#/components/gainos/empty-state.vue';
import SettingsShell from '#/components/gainos/settings-shell.vue';

import { failureText, gainosApi, type MembersResponse } from '#/api/gainos';
import { useWorkspaceAccess } from '#/composables/use-workspace-access';
import { copyText } from '#/utils/clipboard';

defineOptions({ name: 'SettingsMembers' });

const { ensureLoaded, isAdmin, loaded: accessLoaded } = useWorkspaceAccess();

const loading = ref(true);
const error = ref<string | null>(null);
const data = ref<MembersResponse>({ members: [], invitations: [] });

const inviteOpen = ref(false);
const inviteForm = reactive({ email: '', role: 'member' as 'admin' | 'member' });
const inviteError = ref<string | null>(null);
const inviting = ref(false);
const inviteLink = ref<string | null>(null);
const copied = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    data.value = (await gainosApi.members()) ?? { members: [], invitations: [] };
  } catch (err) {
    error.value = failureText(err).title;
  } finally {
    loading.value = false;
  }
}

function openInvite(): void {
  if (!isAdmin.value) return;
  inviteLink.value = null;
  inviteForm.email = '';
  inviteForm.role = 'member';
  inviteError.value = null;
  inviteOpen.value = true;
}

async function invite(): Promise<void> {
  if (!isAdmin.value) return;
  inviteError.value = null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteForm.email.trim())) {
    inviteError.value = $t('gainos.members.errEmail');
    return;
  }
  inviting.value = true;
  try {
    const created = await gainosApi.inviteMember(inviteForm.email.trim(), inviteForm.role);
    inviteOpen.value = false;
    inviteLink.value = `${location.origin}${created.invitePath}`;
    await load();
  } catch (err) {
    inviteError.value = failureText(err).title;
  } finally {
    inviting.value = false;
  }
}

async function copyLink(): Promise<void> {
  if (!inviteLink.value) return;
  try {
    await copyText(inviteLink.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    copied.value = false;
    // 邀请链接只在这一次弹出里出现，复制失败了必须说出来，不能让用户以为已经复制。
    feedback.message.error($t('gainos.common.copyFailed'));
  }
}

async function changeRole(id: string, role: 'admin' | 'member'): Promise<void> {
  if (!isAdmin.value) return;
  try {
    await gainosApi.changeRole(id, role);
    await load();
  } catch (err) {
    error.value = failureText(err).title;
  }
}

function remove(id: string): void {
  if (!isAdmin.value) return;
  feedback.confirm({
    cancelText: $t('gainos.common.cancel'),
    content: $t('gainos.members.confirmRemove'),
    okText: $t('gainos.members.remove'),
    okType: 'danger',
    onOk: async () => {
      try {
        await gainosApi.removeMember(id);
        await load();
      } catch (err) {
        error.value = failureText(err).title;
      }
    },
  });
}

onMounted(() => {
  void Promise.all([ensureLoaded(), load()]);
});
</script>

<template>
  <SettingsShell :subtitle="$t('gainos.members.subtitle')" :title="$t('gainos.members.title')">
    <template #actions>
      <Button v-if="isAdmin" data-gs="members-invite-btn" type="primary" @click="openInvite">
        {{ $t('gainos.members.invite') }}
      </Button>
    </template>

    <Alert
      v-if="accessLoaded && !isAdmin"
      :message="$t('gainosB3.members.readonlyHint')"
      data-gs="members-readonly-hint"
      show-icon
      type="info"
    />

    <div v-if="loading" class="mb__state" role="status">
      <Skeleton active :title="false" :paragraph="{ rows: 4 }" />
      <span class="mb__state-sr">{{ $t('gainos.common.loading') }}</span>
    </div>
    <Alert
      v-else-if="error"
      :message="error"
      show-icon
      type="warning"
    >
      <template #action>
        <Button size="small" @click="load">{{ $t('gainos.common.retry') }}</Button>
      </template>
    </Alert>

    <template v-else>
      <Alert v-if="inviteLink" class="mb__tip" type="success">
        <template #message>
          <span>{{ $t('gainos.members.tipSentHead') }}</span>
          <div class="mb__tipline">
            <code>{{ inviteLink }}</code>
            <Button size="small" @click="copyLink">{{ copied ? $t('gainos.members.copied') : $t('gainos.members.copy') }}</Button>
          </div>
        </template>
      </Alert>

      <section class="mb__card">
        <h2>{{ $t('gainos.members.membersHeading') }}</h2>
        <EmptyState
          v-if="data.members.length === 0"
          :title="$t('gainos.members.emptyTitle')"
        >
          <template #actions>
            <Button v-if="isAdmin" type="primary" @click="openInvite">{{ $t('gainos.members.invite') }}</Button>
            <Button @click="$router.push('/workspace')">{{ $t('gainos.menu.groupWorkspace') }}</Button>
          </template>
        </EmptyState>
        <ul v-else class="mb__list">
          <li v-for="m in data.members" :key="m.id" class="mb__row">
            <div class="mb__who">
              <strong>{{ m.email }}</strong>
              <small>{{ m.role === 'admin' ? $t('gainos.members.roleAdmin') : $t('gainos.members.roleMember') }} · {{ $t('gainos.members.joinedAt', { date: m.joinedAt.slice(0, 10) }) }}</small>
            </div>
            <div v-if="isAdmin" class="mb__acts">
              <Button
                size="small"
                :type="m.role === 'member' ? 'primary' : 'default'"
                @click="m.role === 'admin' && changeRole(m.id, 'member')"
              >{{ $t('gainos.members.roleMember') }}</Button>
              <Button
                size="small"
                :type="m.role === 'admin' ? 'primary' : 'default'"
                @click="m.role === 'member' && changeRole(m.id, 'admin')"
              >{{ $t('gainos.members.roleAdmin') }}</Button>
              <Button danger size="small" @click="remove(m.id)">{{ $t('gainos.members.remove') }}</Button>
            </div>
          </li>
        </ul>
      </section>

      <section v-if="data.invitations.length" class="mb__card">
        <h2>{{ $t('gainos.members.pendingHeading') }}</h2>
        <ul class="mb__list">
          <li v-for="i in data.invitations" :key="i.id" class="mb__row">
            <div class="mb__who">
              <strong>{{ i.email }}</strong>
              <small>{{ i.role === 'admin' ? $t('gainos.members.willJoinAdmin') : $t('gainos.members.willJoinMember') }} · {{ $t('gainos.members.expiresAt', { date: i.expiresAt.slice(0, 10) }) }}</small>
            </div>
          </li>
        </ul>
      </section>
    </template>

    <!-- 邀请弹层 -->
    <Modal
      v-model:open="inviteOpen"
      :cancel-text="$t('gainos.common.cancel')"
      :confirm-loading="inviting"
      :ok-text="inviting ? $t('gainos.members.creating') : $t('gainos.members.create')"
      :title="$t('gainos.members.inviteTitle')"
      :width="440"
      @ok="invite"
    >
      <Form layout="vertical">
        <Form.Item :label="$t('gainos.members.email')">
          <Input v-model:value="inviteForm.email" placeholder="teammate@company.com" type="email" />
        </Form.Item>
        <Form.Item :label="$t('gainos.members.role')">
          <RadioGroup v-model:value="inviteForm.role" button-style="solid">
            <RadioButton value="member">{{ $t('gainos.members.roleMemberLong') }}</RadioButton>
            <RadioButton value="admin">{{ $t('gainos.members.roleAdminLong') }}</RadioButton>
          </RadioGroup>
        </Form.Item>
      </Form>
      <Alert v-if="inviteError" :message="inviteError" role="alert" show-icon type="error" />
    </Modal>
  </SettingsShell>
</template>

<style scoped>
.mb__state { background: var(--gs-surface); border: 1px dashed var(--gs-border-dashed); border-radius: 14px; padding: 40px; text-align: center; display: grid; gap: 10px; place-items: center; }
.mb__tip { line-height: 1.8; }
.mb__tipline { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
.mb__tip code { background: rgba(51,92,255,.10); border-radius: 6px; padding: 4px 10px; font-size: 12px; word-break: break-all; color: var(--gs-fg-2); }
.mb__card { background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 16px; padding: 20px 22px; }
.mb__card h2 { margin: 0 0 14px; font-size: 15.5px; font-weight: 700; color: var(--gs-fg); }
.mb__list { list-style: none; margin: 0; padding: 0; display: grid; }
.mb__row { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 13px 0; border-bottom: 1px solid var(--gs-divider); }
.mb__row:last-child { border-bottom: 0; }
.mb__who { display: grid; gap: 3px; min-width: 0; }
.mb__who strong { font-size: 14px; color: var(--gs-fg); font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.mb__who small { font-size: 12.5px; color: var(--gs-fg-subtle); }
.mb__acts { display: flex; gap: 8px; flex: none; }
.mb__state-sr {
  position: absolute;
  width: 1px; height: 1px;
  margin: -1px; padding: 0; border: 0;
  clip: rect(0 0 0 0); clip-path: inset(50%);
  overflow: hidden; white-space: nowrap;
}
</style>
