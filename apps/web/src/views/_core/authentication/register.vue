<script lang="ts" setup>
import { computed, reactive, ref } from 'vue';

import { preferences } from '@vben/preferences';
import { useRoute, useRouter } from 'vue-router';

import { useAccessStore, useUserStore } from '@vben/stores';

import { $t } from '#/locales';

import { acceptInviteApi, registerApi } from '#/api/core/auth';
import { gainosApi } from '#/api/gainos';
import { useAuthStore } from '#/store';

import AuthTools from '#/components/AuthTools.vue';

defineOptions({ name: 'Register' });

/** 英文排版需要独立字号/字距(is-en) */
const isEnglish = computed(() => preferences.app.locale === 'en-US');

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

/** 邀请模式:链接带 ?invite=token 时只设密码即加入对方工作空间(A4) */
const inviteToken = computed(() =>
  typeof route.query.invite === 'string' ? route.query.invite : '',
);

const form = reactive({
  companyName: '',
  email: '',
  password: '',
  inviteCode: '',
});
const errors = reactive<Record<string, string | undefined>>({});
const submitting = ref(false);
const failure = ref<string | null>(null);

const emailValid = computed(() =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()),
);
const passwordValid = computed(
  () =>
    form.password.length >= 10 &&
    /[a-zA-Z]/.test(form.password) &&
    /\d/.test(form.password),
);

function validate(): boolean {
  if (inviteToken.value) {
    errors.password = passwordValid.value
      ? undefined
      : $t('gainos.register.errPassword');
    return !errors.password;
  }
  errors.companyName =
    form.companyName.trim().length >= 2
      ? undefined
      : $t('gainos.register.errCompanyRequired');
  errors.email = !form.email.trim()
    ? $t('gainos.register.errEmailRequired')
    : emailValid.value
      ? undefined
      : $t('gainos.register.errEmailInvalid');
  errors.password = passwordValid.value
    ? undefined
    : $t('gainos.register.errPassword');
  return !errors.companyName && !errors.email && !errors.password;
}

function errText(error: unknown): string {
  const detail = (
    error as {
      response?: {
        data?: {
          error?: { userCopy?: { title?: string; next?: string }; message?: string };
        };
      };
    }
  )?.response?.data?.error;
  if (detail?.userCopy?.title) {
    return `${detail.userCopy.title}${detail.userCopy.next ? ` — ${detail.userCopy.next}` : ''}`;
  }
  return detail?.message ?? ((error as Error)?.message ?? $t('gainos.register.errFailed'));
}

async function onSubmit() {
  failure.value = null;
  if (!validate()) return;
  submitting.value = true;
  try {
    if (inviteToken.value) {
      // 接受邀请时后端已直接下发会话 cookie,无需再登录一次
      await acceptInviteApi({ token: inviteToken.value, password: form.password });
      const session = await gainosApi.session();
      const workspaceName =
        session.workspaces.find((w) => w.id === session.workspace.id)?.name ??
        'Workspace';
      useUserStore().setUserInfo({
        userId: session.user.id,
        username: session.user.email,
        realName: workspaceName,
        roles: [session.workspace.role],
        avatar: '',
        desc: '',
        homePath: '/workspace',
        token: '',
      });
      const accessStore = useAccessStore();
      accessStore.setAccessToken('cookie-session');
      accessStore.setAccessCodes(
        session.workspace.role === 'admin' ? ['ADMIN'] : [],
      );
    } else {
      await registerApi({
        companyName: form.companyName.trim(),
        email: form.email.trim(),
        password: form.password,
        inviteCode: form.inviteCode.trim() || undefined,
      });
      await authStore.authLogin({
        username: form.email.trim(),
        password: form.password,
      });
    }
    await router.push('/workspace');
  } catch (error) {
    failure.value = errText(error);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="g-login" :class="{ 'is-en': isEnglish }">
    <AuthTools />

    <!-- 品牌面板(与登录同构,信息密度更低) -->
    <section class="g-brand" aria-hidden="true">
      <div class="g-brand__glow g-brand__glow--a"></div>
      <div class="g-brand__glow g-brand__glow--b"></div>
      <svg class="g-brand__net" viewBox="0 0 640 640" fill="none" preserveAspectRatio="xMidYMid slice">
        <g class="g-brand__layer g-brand__layer--slow">
          <path d="M100 460 L220 340 L340 400 L460 240 L580 280" stroke="rgba(94,234,212,.18)" stroke-width="1" />
          <circle cx="220" cy="340" r="3" fill="#5EEAD4" /><circle cx="340" cy="400" r="2.4" fill="#34D399" opacity=".8" />
          <circle cx="460" cy="240" r="3.6" fill="#00B96B" /><circle cx="580" cy="280" r="2" fill="#5EEAD4" opacity=".6" />
        </g>
      </svg>
      <header class="g-brand__mark">
        <img class="g-brand__mark-img" src="/logo-mark.svg" alt="" width="44" height="44" />
        <div class="g-brand__mark-text">
          <span class="g-brand__word">Gain<em>OS</em></span>
          <span class="g-brand__sub">{{ $t('gainos.brand.tagline') }}</span>
        </div>
      </header>
      <div class="g-brand__hero">
        <h1 class="g-brand__title">
          <span class="g-brand__line">{{ $t('gainos.brand.registerLine1') }}</span>
          <span class="g-brand__line">
            {{ $t('gainos.brand.registerLine2Before') }}<em>{{ $t('gainos.brand.registerLine2Em') }}</em>{{ $t('gainos.brand.registerLine2After') }}
          </span>
        </h1>
        <p class="g-brand__desc">{{ $t('gainos.brand.registerDesc') }}</p>
      </div>
      <footer class="g-brand__steps">
        <div class="g-brand__step"><span class="g-brand__num">01</span><div><strong>{{ $t('gainos.brand.regStep1Title') }}</strong><small>{{ $t('gainos.brand.regStep1Desc') }}</small></div></div>
        <div class="g-brand__step"><span class="g-brand__num">02</span><div><strong>{{ $t('gainos.brand.regStep2Title') }}</strong><small>{{ $t('gainos.brand.regStep2Desc') }}</small></div></div>
        <div class="g-brand__step"><span class="g-brand__num">03</span><div><strong>{{ $t('gainos.brand.regStep3Title') }}</strong><small>{{ $t('gainos.brand.regStep3Desc') }}</small></div></div>
      </footer>
    </section>

    <!-- 表单面板 -->
    <section class="g-panel">
      <div class="g-panel__box">
        <div class="g-panel__head">
          <h2>{{ inviteToken ? $t('gainos.register.inviteTitle') : $t('gainos.register.title') }}</h2>
          <p>{{ inviteToken ? $t('gainos.register.inviteSubtitle') : $t('gainos.register.subtitle') }}</p>
        </div>

        <form class="g-form" novalidate @submit.prevent="onSubmit">
          <template v-if="!inviteToken">
            <label class="g-field" :class="{ 'g-field--err': errors.companyName }">
              <span class="g-field__label">{{ $t('gainos.register.company') }}</span>
              <div class="g-field__wrap">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 21V8l8-4.5L20 8v13"/><path d="M9.5 21v-6h5v6"/></svg>
                <input v-model="form.companyName" type="text" :placeholder="$t('gainos.register.companyPlaceholder')" @input="errors.companyName = undefined" />
              </div>
              <span v-if="errors.companyName" class="g-field__err" role="alert">{{ errors.companyName }}</span>
            </label>

            <label class="g-field" :class="{ 'g-field--err': errors.email }">
              <span class="g-field__label">{{ $t('gainos.register.email') }}</span>
              <div class="g-field__wrap">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7.5 8 5.5 8-5.5"/></svg>
                <input v-model="form.email" type="email" autocomplete="username" placeholder="you@company.com" @input="errors.email = undefined" />
              </div>
              <span v-if="errors.email" class="g-field__err" role="alert">{{ errors.email }}</span>
            </label>
          </template>

          <label class="g-field" :class="{ 'g-field--err': errors.password }">
            <span class="g-field__label">{{ $t('gainos.register.password') }}</span>
            <div class="g-field__wrap">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="10" width="16" height="10" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
              <input v-model="form.password" type="password" autocomplete="new-password" :placeholder="$t('gainos.register.passwordPlaceholder')" @input="errors.password = undefined" />
            </div>
            <span v-if="errors.password" class="g-field__err" role="alert">{{ errors.password }}</span>
          </label>

          <label v-if="!inviteToken" class="g-field">
            <span class="g-field__label">
              {{ $t('gainos.register.inviteCode') }}
              <em class="g-field__optional">{{ $t('gainos.register.inviteCodeOptional') }}</em>
            </span>
            <div class="g-field__wrap">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M15 4a4 4 0 1 1 3.3 6.3L11 17.6a2.5 2.5 0 1 1-4.6-4.6l7.3-7.3"/></svg>
              <input v-model="form.inviteCode" type="text" :placeholder="$t('gainos.register.inviteCodePlaceholder')" />
            </div>
          </label>

          <Transition name="g-fade">
            <p v-if="failure" class="g-failure" role="alert">{{ failure }}</p>
          </Transition>

          <button class="g-submit" type="submit" :disabled="submitting">
            <span v-if="!submitting">{{ inviteToken ? $t('gainos.register.submitInvite') : $t('gainos.register.submit') }}</span>
            <span v-else class="g-submit__spin" :aria-label="$t('gainos.register.submitting')"></span>
          </button>
        </form>

        <div class="g-panel__alt">
          <span>{{ $t('gainos.register.haveAccount') }}</span>
          <RouterLink to="/auth/login">{{ $t('gainos.register.goLogin') }}</RouterLink>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped src="./auth-brand.css"></style>
<style scoped>
.g-field__optional { font-style: normal; font-weight: 400; color: #9ca3af; margin-left: 6px; font-size: 12px; }
</style>
