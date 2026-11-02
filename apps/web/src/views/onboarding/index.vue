<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { preferences, usePreferences } from '@vben/preferences';
import { useAccessStore, useUserStore } from '@vben/stores';

import { Button, Input, message, Select } from 'ant-design-vue';

import { $t } from '#/locales';
import { gainosApi, type OnboardingCompanyInput } from '#/api/gainos';
import { useAuthStore } from '#/store';

defineOptions({ name: 'OnboardingWizard' });

const router = useRouter();
const userStore = useUserStore();
const authStore = useAuthStore();
const accessStore = useAccessStore();
const { locale } = usePreferences();

/**
 * 注册引导（SD11/D10）：轻注册后的强制向导。
 * 三步收集卖家事实（基本信息 / 核心产品 / 目标市场），一次性经 BFF 建档到引擎。
 */
const STEP_KEYS = [
  'gainos.onboarding.stepBasics',
  'gainos.onboarding.stepProducts',
  'gainos.onboarding.stepMarkets',
] as const;
const steps = computed(() => STEP_KEYS.map((key) => $t(key)));

const step = ref(0);
const loading = ref(true);
const submitting = ref(false);
const errorText = ref('');

const name = ref('');
const website = ref('');
const industry = ref('');
const businessEmail = ref('');
const products = ref<string[]>([]);
const productDraft = ref('');
const targetMarkets = ref<string[]>([]);

/** 常用目标市场（ISO 3166-1 alpha-2）；显示名用 Intl.DisplayNames 本地化，免维护两份名单。 */
const MARKET_CODES = [
  'US', 'CA', 'MX', 'BR', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL',
  'BE', 'PL', 'SE', 'NO', 'DK', 'FI', 'CH', 'AT', 'CZ', 'TR',
  'RU', 'IN', 'JP', 'KR', 'AE', 'SA', 'AU', 'NZ', 'ZA', 'EG',
  'VN', 'TH', 'ID', 'MY', 'PH', 'SG',
] as const;
const regionNames = computed(() => {
  try {
    return new Intl.DisplayNames([locale.value], { type: 'region' });
  } catch {
    return null;
  }
});
const marketOptions = computed(() =>
  MARKET_CODES.map((code) => ({
    value: code,
    label: `${regionNames.value?.of(code) ?? code} (${code})`,
  })),
);

const stepValid = computed(() => {
  if (step.value === 0) {
    if (!name.value.trim()) return false;
    if (website.value.trim() && !/^https?:\/\/.+/i.test(website.value.trim())) return false;
    if (businessEmail.value.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(businessEmail.value.trim())) return false;
    return true;
  }
  if (step.value === 1) return products.value.length > 0;
  return targetMarkets.value.length > 0;
});

function addProduct() {
  const value = productDraft.value.trim().slice(0, 120);
  if (!value) return;
  if (products.value.length >= 5) {
    message.warning($t('gainos.onboarding.productsLimit'));
    return;
  }
  if (!products.value.includes(value)) products.value.push(value);
  productDraft.value = '';
}

function removeProduct(value: string) {
  products.value = products.value.filter((item) => item !== value);
}

function next() {
  if (!stepValid.value || step.value >= steps.value.length - 1) return;
  step.value += 1;
}

function back() {
  if (step.value > 0) step.value -= 1;
}

async function loadContext() {
  try {
    const context = await gainosApi.workspaceContext();
    if (context?.onboarding?.complete) {
      await router.replace(preferences.app.defaultHomePath);
      return;
    }
    if (!name.value) name.value = context?.workspace?.name ?? userStore.userInfo?.realName ?? '';
  } catch {
    // 上下文拉取失败不阻塞；提交时服务端仍会校验。
    if (!name.value) name.value = userStore.userInfo?.realName ?? '';
  } finally {
    loading.value = false;
  }
}

async function submit() {
  if (!stepValid.value || submitting.value) return;
  submitting.value = true;
  errorText.value = '';
  const payload: OnboardingCompanyInput = {
    name: name.value.trim(),
    ...(website.value.trim() ? { website: website.value.trim() } : {}),
    ...(industry.value.trim() ? { industry: industry.value.trim() } : {}),
    products: [...products.value],
    targetMarkets: [...targetMarkets.value],
    ...(businessEmail.value.trim() ? { businessEmail: businessEmail.value.trim() } : {}),
  };
  try {
    await gainosApi.completeOnboarding(payload);
    authStore.markOnboardingCompleted();
    message.success($t('gainos.onboarding.success'));
    await router.replace(preferences.app.defaultHomePath);
  } catch (error) {
    const body = (error as { response?: { data?: { error?: { message?: string } } } })?.response?.data;
    errorText.value = body?.error?.message ?? $t('gainos.onboarding.submitFailed');
  } finally {
    submitting.value = false;
  }
}

async function logout() {
  await authStore.logout();
}

onMounted(loadContext);
</script>

<template>
  <div class="onboarding">
    <div class="onboarding-card">
      <div class="onboarding-brand">
        <img alt="GainOS" class="onboarding-logo" src="/logo-gainos.svg" />
        <h1 class="onboarding-title">{{ $t('gainos.onboarding.title') }}</h1>
        <p class="onboarding-subtitle">{{ $t('gainos.onboarding.subtitle') }}</p>
      </div>

      <ol class="onboarding-steps">
        <li
          v-for="(label, index) in steps"
          :key="label"
          :class="{ active: index === step, done: index < step }"
        >
          <span class="dot">{{ index + 1 }}</span>
          <span class="label">{{ label }}</span>
        </li>
      </ol>

      <div v-if="loading" class="onboarding-loading">{{ $t('gainos.onboarding.loading') }}</div>

      <template v-else>
        <section v-if="step === 0" class="onboarding-section">
          <label class="field">
            <span class="field-label">{{ $t('gainos.onboarding.companyName') }}</span>
            <Input v-model:value="name" :maxlength="200" :placeholder="$t('gainos.onboarding.companyNamePlaceholder')" />
          </label>
          <label class="field">
            <span class="field-label">{{ $t('gainos.onboarding.website') }}</span>
            <Input v-model:value="website" :placeholder="$t('gainos.onboarding.websitePlaceholder')" />
            <span class="field-hint">{{ $t('gainos.onboarding.websiteHint') }}</span>
          </label>
          <label class="field">
            <span class="field-label">{{ $t('gainos.onboarding.industry') }}</span>
            <Input v-model:value="industry" :maxlength="120" :placeholder="$t('gainos.onboarding.industryPlaceholder')" />
          </label>
          <label class="field">
            <span class="field-label">{{ $t('gainos.onboarding.businessEmail') }}</span>
            <Input v-model:value="businessEmail" :placeholder="$t('gainos.onboarding.businessEmailPlaceholder')" />
          </label>
        </section>

        <section v-else-if="step === 1" class="onboarding-section">
          <p class="section-desc">{{ $t('gainos.onboarding.productsDesc') }}</p>
          <div class="product-row">
            <Input
              v-model:value="productDraft"
              :maxlength="120"
              :placeholder="$t('gainos.onboarding.productsPlaceholder')"
              @press-enter="addProduct"
            />
            <Button @click="addProduct">{{ $t('gainos.onboarding.addProduct') }}</Button>
          </div>
          <div class="product-tags">
            <span v-for="item in products" :key="item" class="tag">
              {{ item }}
              <button class="tag-remove" type="button" @click="removeProduct(item)">×</button>
            </span>
          </div>
        </section>

        <section v-else class="onboarding-section">
          <p class="section-desc">{{ $t('gainos.onboarding.marketsDesc') }}</p>
          <Select
            v-model:value="targetMarkets"
            :max-tag-count="8"
            :options="marketOptions"
            mode="multiple"
            :placeholder="$t('gainos.onboarding.marketsPlaceholder')"
            style="width: 100%"
          />
        </section>

        <p v-if="errorText" class="onboarding-error">{{ errorText }}</p>

        <div class="onboarding-actions">
          <Button v-if="step > 0" :disabled="submitting" @click="back">
            {{ $t('gainos.onboarding.back') }}
          </Button>
          <Button v-if="step < steps.length - 1" :disabled="!stepValid" type="primary" @click="next">
            {{ $t('gainos.onboarding.next') }}
          </Button>
          <Button
            v-else
            :disabled="!stepValid"
            :loading="submitting"
            type="primary"
            @click="submit"
          >
            {{ $t('gainos.onboarding.submit') }}
          </Button>
        </div>
      </template>

      <button class="onboarding-logout" type="button" @click="logout">
        {{ $t('gainos.onboarding.logout') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.onboarding {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 24px;
  background: var(--gs-bg-soft, #f5f6f7);
}

.onboarding-card {
  width: 560px;
  max-width: 100%;
  padding: 32px;
  background: var(--gs-bg, #fff);
  border: 1px solid var(--gs-border, #e5e7eb);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgb(0 0 0 / 6%);
}

.onboarding-brand {
  margin-bottom: 20px;
  text-align: center;
}

.onboarding-logo {
  width: 40px;
  height: 40px;
}

.onboarding-title {
  margin: 12px 0 4px;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.onboarding-subtitle {
  margin: 0;
  font-size: 14px;
  color: var(--gs-fg-subtle, #6b7280);
}

.onboarding-steps {
  display: flex;
  gap: 8px;
  padding: 0;
  margin: 20px 0 24px;
  list-style: none;
}

.onboarding-steps li {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  font-size: 13px;
  color: var(--gs-fg-subtle, #6b7280);
  background: var(--gs-bg-soft, #f5f6f7);
  border-radius: 8px;
}

.onboarding-steps li.active {
  color: var(--gs-fg, #111827);
  background: var(--gs-bg, #fff);
  border: 1px solid var(--gs-primary, #2563eb);
}

.onboarding-steps li.done {
  color: var(--gs-fg, #111827);
}

.onboarding-steps .dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  font-size: 12px;
  background: var(--gs-bg-soft, #e5e7eb);
  border-radius: 50%;
}

.onboarding-steps li.active .dot {
  color: #fff;
  background: var(--gs-primary, #2563eb);
}

.onboarding-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 220px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 13px;
  font-weight: 500;
}

.field-hint {
  font-size: 12px;
  color: var(--gs-fg-subtle, #6b7280);
}

.section-desc {
  margin: 0;
  font-size: 13px;
  color: var(--gs-fg-subtle, #6b7280);
}

.product-row {
  display: flex;
  gap: 8px;
}

.product-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 13px;
  background: var(--gs-bg-soft, #f5f6f7);
  border-radius: 999px;
}

.tag-remove {
  padding: 0;
  font-size: 14px;
  color: var(--gs-fg-subtle, #6b7280);
  cursor: pointer;
  background: none;
  border: 0;
}

.onboarding-error {
  margin: 12px 0 0;
  font-size: 13px;
  color: var(--gs-danger, #dc2626);
}

.onboarding-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}

.onboarding-loading {
  padding: 48px 0;
  font-size: 14px;
  color: var(--gs-fg-subtle, #6b7280);
  text-align: center;
}

.onboarding-logout {
  display: block;
  margin: 20px auto 0;
  font-size: 12px;
  color: var(--gs-fg-subtle, #6b7280);
  cursor: pointer;
  background: none;
  border: 0;
}
</style>
