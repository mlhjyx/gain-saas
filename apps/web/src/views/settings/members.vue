<script lang="ts" setup>
import { onMounted, reactive, ref } from 'vue';

import { $t } from '#/locales';

import { failureText, gainosApi, type MembersResponse } from '#/api/gainos';

defineOptions({ name: 'SettingsMembers' });

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
    data.value = await gainosApi.members();
  } catch (err) {
    error.value = failureText(err).title;
  } finally {
    loading.value = false;
  }
}

async function invite(): Promise<void> {
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
    await navigator.clipboard.writeText(inviteLink.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    copied.value = false;
  }
}

async function changeRole(id: string, role: 'admin' | 'member'): Promise<void> {
  try {
    await gainosApi.changeRole(id, role);
    await load();
  } catch (err) {
    error.value = failureText(err).title;
  }
}

async function remove(id: string): Promise<void> {
  if (!window.confirm($t('gainos.members.confirmRemove'))) return;
  try {
    await gainosApi.removeMember(id);
    await load();
  } catch (err) {
    error.value = failureText(err).title;
  }
}

onMounted(load);
</script>

<template>
  <div class="mb">
    <header class="mb__head">
      <div>
        <h1>{{ $t('gainos.members.title') }}</h1>
        <p>{{ $t('gainos.members.subtitle') }}</p>
      </div>
      <button class="mb__cta" type="button" @click="inviteOpen = true; inviteLink = null; inviteForm.email = ''; inviteForm.role = 'member'; inviteError = null">
        {{ $t('gainos.members.invite') }}
      </button>
    </header>

    <div v-if="loading" class="mb__state">{{ $t('gainos.members.loading') }}</div>
    <div v-else-if="error" class="mb__state mb__state--err">{{ error }}<button type="button" @click="load">{{ $t('gainos.common.retry') }}</button></div>

    <template v-else>
      <div v-if="inviteLink" class="mb__tip">
        <span>{{ $t('gainos.members.tipSentHead') }}</span>
        <div class="mb__tipline">
          <code>{{ inviteLink }}</code>
          <button type="button" class="mb__copy" @click="copyLink">{{ copied ? $t('gainos.members.copied') : $t('gainos.members.copy') }}</button>
        </div>
      </div>

      <section class="mb__card">
        <h2>{{ $t('gainos.members.membersHeading') }}</h2>
        <ul class="mb__list">
          <li v-for="m in data.members" :key="m.id" class="mb__row">
            <div class="mb__who">
              <strong>{{ m.email }}</strong>
              <small>{{ m.role === 'admin' ? $t('gainos.members.roleAdmin') : $t('gainos.members.roleMember') }} · {{ $t('gainos.members.joinedAt', { date: m.joinedAt.slice(0, 10) }) }}</small>
            </div>
            <div class="mb__acts">
              <button
                type="button" class="mb__chip" :class="{ 'is-on': m.role === 'member' }"
                @click="m.role === 'admin' && changeRole(m.id, 'member')"
              >{{ $t('gainos.members.roleMember') }}</button>
              <button
                type="button" class="mb__chip" :class="{ 'is-on': m.role === 'admin' }"
                @click="m.role === 'member' && changeRole(m.id, 'admin')"
              >{{ $t('gainos.members.roleAdmin') }}</button>
              <button type="button" class="mb__chip mb__chip--danger" @click="remove(m.id)">{{ $t('gainos.members.remove') }}</button>
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
    <Teleport to="body">
      <div v-if="inviteOpen" class="mb__modal" role="dialog" aria-modal="true">
        <div class="mb__mask" @click="inviteOpen = false"></div>
        <div class="mb__body">
          <header><h2>{{ $t('gainos.members.inviteTitle') }}</h2><button type="button" class="mb__x" aria-label="Close" @click="inviteOpen = false">✕</button></header>
          <form novalidate @submit.prevent="invite">
            <label class="mb__field">
              <span>{{ $t('gainos.members.email') }}</span>
              <input v-model="inviteForm.email" type="email" placeholder="teammate@company.com" />
            </label>
            <div class="mb__field">
              <span>{{ $t('gainos.members.role') }}</span>
              <div class="mb__seg">
                <button type="button" :class="{ 'is-on': inviteForm.role === 'member' }" @click="inviteForm.role = 'member'">{{ $t('gainos.members.roleMemberLong') }}</button>
                <button type="button" :class="{ 'is-on': inviteForm.role === 'admin' }" @click="inviteForm.role = 'admin'">{{ $t('gainos.members.roleAdminLong') }}</button>
              </div>
            </div>
            <p v-if="inviteError" class="mb__err" role="alert">{{ inviteError }}</p>
            <div class="mb__actions">
              <button type="button" class="mb__btn mb__btn--ghost" @click="inviteOpen = false">{{ $t('gainos.common.cancel') }}</button>
              <button type="submit" class="mb__btn mb__btn--primary" :disabled="inviting">{{ inviting ? $t('gainos.members.creating') : $t('gainos.members.create') }}</button>
            </div>
          </form>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.mb {
  /* 页面容器：统一外边距与可读宽度上限(vben 内容区默认 0 内边距) */
  padding: clamp(18px, 2.4vw, 32px) clamp(18px, 2.4vw, 34px) clamp(32px, 4vh, 48px);
  max-width: 1280px;
  margin: 0 auto;
 display: grid; gap: 18px; max-width: 860px; }
.mb__head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; }
.mb__head h1 { margin: 0; font-size: 24px; font-weight: 700; color: var(--gs-fg); }
.mb__head p { margin: 8px 0 0; font-size: 13.5px; color: var(--gs-fg-muted); }
.mb__cta {
  flex: none; border: 0; border-radius: 11px; padding: 11px 18px; cursor: pointer;
  background: var(--gs-accent); color: #fff; font-size: 14px; font-weight: 600;
  box-shadow: 0 8px 18px -6px var(--gs-accent-glow); transition: transform .15s ease;
}
.mb__cta:hover { transform: translateY(-1px); }
.mb__state { background: var(--gs-surface); border: 1px dashed var(--gs-border-dashed); border-radius: 14px; padding: 40px; text-align: center; color: var(--gs-fg-subtle); display: grid; gap: 10px; }
.mb__state--err { color: var(--gs-warn); }
.mb__state button { justify-self: center; border: 1px solid var(--gs-border-strong); background: var(--gs-surface); border-radius: 9px; padding: 8px 20px; cursor: pointer; color: var(--gs-fg-2); }
.mb__tip { display: grid; gap: 10px; font-size: 13px; color: var(--gs-fg-2); background: var(--gs-accent-soft); border: 1px solid var(--gs-accent-soft-border); border-radius: 12px; padding: 12px 16px; line-height: 1.8; }
.mb__tipline { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.mb__tip code { background: rgba(0,185,107,.08); border-radius: 6px; padding: 4px 10px; font-size: 12px; word-break: break-all; }
.mb__copy { flex: none; border: 1px solid var(--gs-accent-soft-border); background: var(--gs-surface); color: var(--gs-accent-strong); border-radius: 8px; padding: 5px 12px; font-size: 12.5px; font-weight: 600; cursor: pointer; }
.mb__card { background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 16px; padding: 20px 22px; }
.mb__card h2 { margin: 0 0 14px; font-size: 15.5px; font-weight: 700; color: var(--gs-fg); }
.mb__list { list-style: none; margin: 0; padding: 0; display: grid; }
.mb__row { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 13px 0; border-bottom: 1px solid var(--gs-divider); }
.mb__row:last-child { border-bottom: 0; }
.mb__who { display: grid; gap: 3px; min-width: 0; }
.mb__who strong { font-size: 14px; color: var(--gs-fg); font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.mb__who small { font-size: 12.5px; color: var(--gs-fg-subtle); }
.mb__acts { display: flex; gap: 8px; flex: none; }
.mb__chip {
  border: 1px solid var(--gs-border-strong); background: var(--gs-surface); color: var(--gs-fg-muted); border-radius: 999px;
  padding: 6px 14px; font-size: 12.5px; font-weight: 600; cursor: pointer; transition: all .15s ease;
}
.mb__chip.is-on { background: var(--gs-accent-soft); border-color: var(--gs-accent-soft-border); color: var(--gs-accent-strong); }
.mb__chip--danger:hover { background: var(--gs-danger-bg); border-color: var(--gs-danger-border); color: var(--gs-danger); }
.mb__modal { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 20px; }
.mb__mask { position: absolute; inset: 0; background: var(--gs-mask); backdrop-filter: blur(3px); }
.mb__body { position: relative; width: min(440px, 100%); background: var(--gs-surface); border-radius: 18px; padding: 24px; box-shadow: 0 28px 70px -20px var(--gs-shadow-modal); }
.mb__body header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.mb__body h2 { margin: 0; font-size: 18px; font-weight: 700; }
.mb__x { border: 0; background: transparent; color: var(--gs-fg-subtle); cursor: pointer; }
.mb__field { display: block; margin-bottom: 16px; }
.mb__field span { display: block; margin-bottom: 7px; font-size: 13px; font-weight: 500; color: var(--gs-fg-2); }
.mb__field input { width: 100%; box-sizing: border-box; border: 1.5px solid var(--gs-border-strong); border-radius: 11px; padding: 11px 14px; font-size: 14.5px; outline: 0; }
.mb__field input:focus { border-color: var(--gs-accent); box-shadow: 0 0 0 4px rgba(0,185,107,.12); }
.mb__seg { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.mb__seg button {
  border: 1.5px solid var(--gs-border-strong); background: var(--gs-surface); border-radius: 11px; padding: 11px 8px;
  font-size: 13px; color: var(--gs-fg-muted); cursor: pointer; transition: all .15s ease; line-height: 1.5;
}
.mb__seg button.is-on { border-color: var(--gs-accent); background: var(--gs-accent-soft); color: var(--gs-accent-strong); font-weight: 600; }
.mb__err { margin: 0 0 12px; font-size: 13px; color: var(--gs-danger); background: var(--gs-danger-bg); border: 1px solid var(--gs-danger-border); border-radius: 9px; padding: 9px 12px; }
.mb__actions { display: flex; justify-content: flex-end; gap: 10px; }
.mb__btn { border-radius: 11px; padding: 11px 20px; font-size: 14px; font-weight: 600; cursor: pointer; border: 0; }
.mb__btn--ghost { background: var(--gs-divider); color: var(--gs-fg-2); }
.mb__btn--primary { background: var(--gs-accent); color: #fff; }
</style>
