<script lang="ts" setup>
import { computed, reactive, ref } from 'vue';

import { preferences } from '@vben/preferences';
import { useRouter } from 'vue-router';

import { $t } from '#/locales';
import { useAuthStore } from '#/store';

import AuthTools from '#/components/AuthTools.vue';

defineOptions({ name: 'Login' });

/** 英文排版需要独立字号/字距(is-en) */
const isEnglish = computed(() => preferences.app.locale === 'en-US');

const router = useRouter();
const authStore = useAuthStore();

const form = reactive({ email: '', password: '' });
const errors = reactive<{ email?: string; password?: string }>({});
const showPassword = ref(false);
const submitting = ref(false);
const failure = ref<string | null>(null);

const emailValid = computed(() =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()),
);

function validate(): boolean {
  errors.email = !form.email.trim()
    ? $t('gainos.login.errEmailRequired')
    : emailValid.value
      ? undefined
      : $t('gainos.login.errEmailInvalid');
  errors.password = !form.password
    ? $t('gainos.login.errPasswordRequired')
    : form.password.length < 10
      ? $t('gainos.login.errPasswordShort')
      : undefined;
  return !errors.email && !errors.password;
}

async function onSubmit() {
  failure.value = null;
  if (!validate()) return;
  submitting.value = true;
  try {
    await authStore.authLogin({
      username: form.email.trim(),
      password: form.password,
    });
    await router.push('/workspace');
  } catch (error) {
    const detail = (
      error as {
        response?: {
          data?: {
            error?: {
              message?: string;
              userCopy?: { title?: string; next?: string };
            };
          };
        };
      }
    )?.response?.data?.error;
    failure.value = detail?.userCopy
      ? `${detail.userCopy.title}${detail.userCopy.next ? ` — ${detail.userCopy.next}` : ''}`
      : (detail?.message ?? (error as Error)?.message ?? $t('gainos.login.errFailed'));
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="g-login" :class="{ 'is-en': isEnglish }">
    <AuthTools />

    <!-- ── 品牌面板 ─────────────────────────────── -->
    <section class="g-brand" aria-hidden="true">
      <div class="g-brand__glow g-brand__glow--a"></div>
      <div class="g-brand__glow g-brand__glow--b"></div>
      <svg class="g-brand__net" viewBox="0 0 640 640" fill="none" preserveAspectRatio="xMidYMid slice">
        <g class="g-brand__layer g-brand__layer--slow">
          <path d="M80 480 L200 360 L320 420 L440 260 L560 300" stroke="rgba(94,234,212,.20)" stroke-width="1" />
          <path d="M120 200 L240 260 L360 180 L480 240 L600 140" stroke="rgba(52,211,153,.14)" stroke-width="1" />
          <path d="M60 320 L180 300 L300 340 L420 220 L540 180" stroke="rgba(99,102,241,.16)" stroke-width="1" />
          <circle cx="200" cy="360" r="3" fill="#5EEAD4" /><circle cx="320" cy="420" r="2.4" fill="#34D399" opacity=".8" />
          <circle cx="440" cy="260" r="3.6" fill="#00B96B" /><circle cx="240" cy="260" r="2" fill="#5EEAD4" opacity=".7" />
          <circle cx="360" cy="180" r="2.8" fill="#34D399" opacity=".85" /><circle cx="560" cy="300" r="2" fill="#5EEAD4" opacity=".6" />
          <circle cx="480" cy="240" r="3.2" fill="#00B96B" opacity=".9" /><circle cx="120" cy="200" r="2.2" fill="#5EEAD4" opacity=".6" />
          <circle cx="600" cy="140" r="2.6" fill="#34D399" opacity=".7" /><circle cx="180" cy="300" r="2" fill="#818CF8" opacity=".7" />
          <circle cx="60" cy="320" r="2.4" fill="#5EEAD4" opacity=".55" /><circle cx="540" cy="180" r="3" fill="#00B96B" opacity=".75" />
        </g>
        <g class="g-brand__layer g-brand__layer--fast">
          <path d="M40 560 L160 500 L280 540 L400 420 L520 460 L620 380" stroke="rgba(94,234,212,.10)" stroke-width="1" />
          <circle cx="160" cy="500" r="2" fill="#5EEAD4" opacity=".45" /><circle cx="400" cy="420" r="2.6" fill="#34D399" opacity=".5" />
          <circle cx="520" cy="460" r="2" fill="#5EEAD4" opacity=".4" /><circle cx="620" cy="380" r="2.2" fill="#34D399" opacity=".45" />
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
          <span class="g-brand__line">{{ $t('gainos.brand.loginLine1') }}</span>
          <span class="g-brand__line">
            {{ $t('gainos.brand.loginLine2Before') }}<em>{{ $t('gainos.brand.loginLine2Em') }}</em>{{ $t('gainos.brand.loginLine2After') }}
          </span>
        </h1>
        <p class="g-brand__desc">{{ $t('gainos.brand.loginDesc') }}</p>
      </div>

      <footer class="g-brand__steps">
        <div class="g-brand__step">
          <span class="g-brand__num">01</span>
          <div><strong>{{ $t('gainos.brand.step1Title') }}</strong><small>{{ $t('gainos.brand.step1Desc') }}</small></div>
        </div>
        <div class="g-brand__step">
          <span class="g-brand__num">02</span>
          <div><strong>{{ $t('gainos.brand.step2Title') }}</strong><small>{{ $t('gainos.brand.step2Desc') }}</small></div>
        </div>
        <div class="g-brand__step">
          <span class="g-brand__num">03</span>
          <div><strong>{{ $t('gainos.brand.step3Title') }}</strong><small>{{ $t('gainos.brand.step3Desc') }}</small></div>
        </div>
      </footer>
    </section>

    <!-- ── 表单面板 ─────────────────────────────── -->
    <section class="g-panel">
      <div class="g-panel__box">
        <div class="g-panel__head">
          <h2>{{ $t('gainos.login.title') }}</h2>
          <p>{{ $t('gainos.login.subtitle') }}</p>
        </div>

        <form class="g-form" novalidate @submit.prevent="onSubmit">
          <label class="g-field" :class="{ 'g-field--err': errors.email }">
            <span class="g-field__label">{{ $t('gainos.login.email') }}</span>
            <div class="g-field__wrap">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7.5 8 5.5 8-5.5"/></svg>
              <input
                v-model="form.email"
                type="email"
                autocomplete="username"
                placeholder="you@company.com"
                :aria-invalid="!!errors.email"
                @input="errors.email = undefined"
              />
            </div>
            <span v-if="errors.email" class="g-field__err" role="alert">{{ errors.email }}</span>
          </label>

          <label class="g-field" :class="{ 'g-field--err': errors.password }">
            <span class="g-field__label">{{ $t('gainos.login.password') }}</span>
            <div class="g-field__wrap">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="10" width="16" height="10" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
              <input
                v-model="form.password"
                :type="showPassword ? 'text' : 'password'"
                autocomplete="current-password"
                :placeholder="$t('gainos.login.passwordPlaceholder')"
                :aria-invalid="!!errors.password"
                @input="errors.password = undefined"
              />
              <button
                type="button"
                class="g-field__eye"
                :aria-label="showPassword ? $t('gainos.login.hidePassword') : $t('gainos.login.showPassword')"
                @click="showPassword = !showPassword"
              >
                <svg v-if="showPassword" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 3l18 18"/><path d="M10.6 10.7a2.5 2.5 0 0 0 3.5 3.5"/><path d="M6.6 6.8C4.6 8 3 10 2 12c2 4 6 7 10 7 1.5 0 3-.4 4.3-1M10 5.2A9.8 9.8 0 0 1 12 5c4 0 8 3 10 7-.6 1.2-1.4 2.4-2.3 3.4"/></svg>
                <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 12c2-4 6-7 10-7s8 3 10 7c-2 4-6 7-10 7S4 16 2 12Z"/><circle cx="12" cy="12" r="2.6"/></svg>
              </button>
            </div>
            <span v-if="errors.password" class="g-field__err" role="alert">{{ errors.password }}</span>
          </label>

          <Transition name="g-fade">
            <p v-if="failure" class="g-failure" role="alert">{{ failure }}</p>
          </Transition>

          <button class="g-submit" type="submit" :disabled="submitting" :class="{ 'is-loading': submitting }">
            <span v-if="!submitting">{{ $t('gainos.login.submit') }}</span>
            <span v-else class="g-submit__spin" :aria-label="$t('gainos.login.submitting')"></span>
          </button>
        </form>

        <div class="g-panel__alt">
          <span>{{ $t('gainos.login.noAccount') }}</span>
          <RouterLink to="/auth/register">{{ $t('gainos.login.createWorkspace') }}</RouterLink>
        </div>

        <p class="g-panel__foot">{{ $t('gainos.login.terms') }}</p>
      </div>
    </section>
  </div>
</template>

<style scoped src="./auth-brand.css"></style>
