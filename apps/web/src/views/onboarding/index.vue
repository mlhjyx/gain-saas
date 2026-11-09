<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { preferences, usePreferences } from '@vben/preferences';

import { Button, Input, message, Select } from 'ant-design-vue';

import { $t } from '#/locales';
import {
  gainosApi,
  type OnboardingCompanyInput,
  type OnboardingPreview,
} from '#/api/gainos';
import { useAuthStore } from '#/store';

defineOptions({ name: 'OnboardingWizard' });

const router = useRouter();
const authStore = useAuthStore();
const { locale } = usePreferences();

/**
 * 注册即建档（2026-11-10）：先官网 → 系统理解给出候选 → 客户勾选确认完成建档。
 * 没有官网时走手动填写（同一份草稿档案补齐事实）；理解失败的出口是「重试 / 手动填写」。
 * 旧版三步自由文本向导已由这里取代。
 */
type View = 'start' | 'waiting' | 'preview' | 'failed' | 'manual';

const view = ref<View>('start');
const loading = ref(true);
const submitting = ref(false);
const starting = ref(false);
const errorText = ref('');

const name = ref('');
const website = ref('');
const businessEmail = ref('');
const industryCode = ref<string | undefined>(undefined);
const industryText = ref('');
const products = ref<string[]>([]);
const productDraft = ref('');
const targetMarkets = ref<string[]>([]);
const preview = ref<OnboardingPreview | null>(null);

let pollTimer: ReturnType<typeof setInterval> | undefined;

/** 常用目标市场（ISO 3166-1 alpha-2）；显示名用 Intl.DisplayNames 本地化。 */
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

const industryOptions = computed(() => {
  const rows = preview.value?.industry.options ?? [];
  return rows.map((row) => {
    const codeHint = row.nace?.[0] ?? row.code;
    return { value: row.code, label: `${row.label}（${codeHint}）` };
  });
});
const industrySuggested = computed(() => preview.value?.industry.suggested ?? null);
const marketOptions = computed(() => {
  const base = MARKET_CODES.map((code) => ({
    value: code as string,
    label: `${regionNames.value?.of(code) ?? code} (${code})`,
  }));
  const known = new Set<string>(base.map((option) => option.value));
  const extra = (preview.value?.markets ?? [])
    .filter((item) => !known.has(item.code))
    .map((item) => ({ value: item.code, label: `${item.name} (${item.code})` }));
  return [...base, ...extra];
});

const suggestedMarketNames = computed(() =>
  (preview.value?.markets ?? []).map((item) => item.name).join('、'),
);

const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'icloud.com', 'qq.com', 'foxmail.com', '163.com', '126.com',
  'sina.com', 'sohu.com',
]);

function hostOf(raw: string): string | null {
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

const emailHint = computed(() => {
  const email = businessEmail.value.trim().toLowerCase();
  if (!email.includes('@')) return '';
  const domain = email.split('@')[1] ?? '';
  if (!domain) return '';
  if (FREE_MAIL_DOMAINS.has(domain)) return $t('gainos.onboarding.emailFreeHint');
  const site = hostOf(website.value);
  if (!site) return '';
  const emailHost = domain.replace(/^www\./i, '');
  if (emailHost !== site && !emailHost.endsWith(`.${site}`)) {
    return $t('gainos.onboarding.emailDomainHint');
  }
  return '';
});

const websiteValid = computed(
  () => !website.value.trim() || /^https?:\/\/.+/i.test(website.value.trim()),
);
const startValid = computed(
  () => name.value.trim().length > 0 && website.value.trim().length > 0 && websiteValid.value,
);
const manualValid = computed(
  () =>
    name.value.trim().length > 0 &&
    products.value.length > 0 &&
    products.value.length <= 5 &&
    targetMarkets.value.length > 0,
);
const selectionValid = computed(
  () => products.value.length > 0 && products.value.length <= 5 && targetMarkets.value.length > 0,
);
const step = computed(() => (view.value === 'start' ? 0 : 1));
const steps = computed(() => [
  $t('gainos.onboarding.stepWebsite'),
  $t('gainos.onboarding.stepConfirm'),
]);

function addProduct(value?: string) {
  const next = (value ?? productDraft.value).trim().slice(0, 120);
  if (!next) return;
  if (products.value.length >= 5) {
    message.warning($t('gainos.onboarding.productsLimit'));
    return;
  }
  if (!products.value.includes(next)) products.value.push(next);
  productDraft.value = '';
}

function removeProduct(value: string) {
  products.value = products.value.filter((item) => item !== value);
}

function toggleProduct(value: string) {
  if (products.value.includes(value)) {
    removeProduct(value);
    return;
  }
  addProduct(value);
}

function applyPreview(next: OnboardingPreview) {
  preview.value = next;
  if (!name.value && next.name) name.value = next.name;
  if (next.website && !website.value) website.value = next.website;
  if (next.state === 'ready') {
    const suggested = next.industry.suggested;
    industryCode.value = suggested.code ?? undefined;
    const suggestedProducts = next.products.map((item) => item.name);
    if (products.value.length === 0) {
      products.value = suggestedProducts.slice(0, 5);
    }
    if (targetMarkets.value.length === 0) {
      targetMarkets.value = next.markets.map((item) => item.code).slice(0, 20);
    }
    view.value = 'preview';
    stopPolling();
    return;
  }
  if (next.state === 'failed') {
    view.value = 'failed';
    stopPolling();
    return;
  }
  if (next.state === 'queued' || next.state === 'running') {
    view.value = 'waiting';
    startPolling();
    return;
  }
  // not_started：无官网的名称草稿 → 手动填写（行业词表随预览下发）。
  view.value = 'manual';
  stopPolling();
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => void pollPreview(), 4000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

async function pollPreview() {
  try {
    const state = await gainosApi.onboardingPreview();
    if (!state.started) {
      stopPolling();
      view.value = 'start';
      return;
    }
    preview.value = state.preview;
    if (state.preview.state !== 'queued' && state.preview.state !== 'running') {
      applyPreview(state.preview);
    }
  } catch {
    // 轮询失败不打断页面；下一次继续。
  }
}

async function loadContext() {
  try {
    const context = await gainosApi.workspaceContext();
    if (context?.onboarding?.complete) {
      await router.replace(preferences.app.defaultHomePath);
      return;
    }
    if (!name.value) name.value = context?.workspace?.name ?? '';
    if (context?.onboarding?.companyId) {
      try {
        const state = await gainosApi.onboardingPreview();
        if (state.started) applyPreview(state.preview);
      } catch {
        // 恢复失败时留在官网页，用户可以重新开始。
      }
    }
  } catch {
    // 上下文拉取失败不阻塞；提交时服务端仍会校验。
  } finally {
    loading.value = false;
  }
}

async function startUnderstanding() {
  if (!startValid.value || starting.value) return;
  starting.value = true;
  errorText.value = '';
  try {
    const state = await gainosApi.startOnboardingPreview({
      website: website.value.trim(),
      name: name.value.trim(),
    });
    applyPreview(state.preview);
  } catch (error) {
    handleError(error);
  } finally {
    starting.value = false;
  }
}

async function enterManual() {
  if (!name.value.trim() || starting.value) return;
  starting.value = true;
  errorText.value = '';
  try {
    // 手动模式不带官网：建名称草稿（不触发理解），受控词表随预览响应下发。
    const state = await gainosApi.startOnboardingPreview({ name: name.value.trim() });
    applyPreview(state.preview);
    view.value = 'manual';
  } catch (error) {
    handleError(error);
  } finally {
    starting.value = false;
  }
}

async function retryUnderstanding() {
  if (starting.value) return;
  starting.value = true;
  errorText.value = '';
  try {
    const state = await gainosApi.startOnboardingPreview({
      website: website.value.trim(),
      name: name.value.trim(),
    });
    applyPreview(state.preview);
  } catch (error) {
    handleError(error);
  } finally {
    starting.value = false;
  }
}

function buildPayload(): OnboardingCompanyInput {
  const option = preview.value?.industry.options.find((row) => row.code === industryCode.value);
  return {
    name: name.value.trim(),
    ...(industryCode.value
      ? { industryCode: industryCode.value, industry: option?.label ?? industryText.value.trim() }
      : industryText.value.trim()
        ? { industry: industryText.value.trim() }
        : {}),
    products: [...products.value],
    targetMarkets: [...targetMarkets.value],
    ...(businessEmail.value.trim() ? { businessEmail: businessEmail.value.trim() } : {}),
  };
}

async function submit() {
  const valid = view.value === 'manual' ? manualValid.value : selectionValid.value;
  if (!valid || submitting.value) return;
  submitting.value = true;
  errorText.value = '';
  try {
    await gainosApi.completeOnboarding(buildPayload());
    authStore.markOnboardingCompleted();
    message.success($t('gainos.onboarding.success'));
    await router.replace(preferences.app.defaultHomePath);
  } catch (error) {
    handleError(error);
  } finally {
    submitting.value = false;
  }
}

function handleError(error: unknown) {
  const body = (error as { response?: { data?: { error?: { message?: string } } } })?.response?.data;
  errorText.value = body?.error?.message ?? $t('gainos.onboarding.submitFailed');
}

function failureCopy(): string {
  const stage = preview.value?.failure?.stage;
  if (!stage) return $t('gainos.onboarding.failureDefault');
  const key = `gainos.onboarding.failure.${stage}`;
  const copy = $t(key);
  return copy === key ? $t('gainos.onboarding.failureDefault') : copy;
}

function switchManualFromFailure() {
  view.value = 'manual';
}

async function logout() {
  await authStore.logout();
}

onMounted(loadContext);
onBeforeUnmount(stopPolling);
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
        <!-- 第一步：官网优先 -->
        <section v-if="view === 'start'" class="onboarding-section">
          <label class="field">
            <span class="field-label">{{ $t('gainos.onboarding.companyName') }}</span>
            <Input
              v-model:value="name"
              :maxlength="200"
              :placeholder="$t('gainos.onboarding.companyNamePlaceholder')"
            />
          </label>
          <label class="field">
            <span class="field-label">{{ $t('gainos.onboarding.website') }}</span>
            <Input
              v-model:value="website"
              :placeholder="$t('gainos.onboarding.websitePlaceholder')"
              @press-enter="startUnderstanding"
            />
            <span class="field-hint">{{ $t('gainos.onboarding.websiteHint') }}</span>
          </label>
          <label class="field">
            <span class="field-label">{{ $t('gainos.onboarding.businessEmail') }}</span>
            <Input
              v-model:value="businessEmail"
              :placeholder="$t('gainos.onboarding.businessEmailPlaceholder')"
            />
            <span v-if="emailHint" class="field-hint hint-accent">{{ emailHint }}</span>
          </label>
          <p v-if="errorText" class="onboarding-error">{{ errorText }}</p>
          <div class="onboarding-actions">
            <Button
              :disabled="!startValid"
              :loading="starting"
              class="primary-action"
              type="primary"
              @click="startUnderstanding"
            >
              {{ $t('gainos.onboarding.startUnderstanding') }}
            </Button>
          </div>
          <div class="start-hint">{{ $t('gainos.onboarding.startHint') }}</div>
          <button class="text-link" type="button" @click="enterManual">
            {{ $t('gainos.onboarding.noWebsite') }}
          </button>
        </section>

        <!-- 理解进行中 -->
        <section v-else-if="view === 'waiting'" class="onboarding-section waiting">
          <div class="waiting-spinner" aria-hidden="true"></div>
          <h2 class="waiting-title">{{ $t('gainos.onboarding.progressTitle') }}</h2>
          <p class="waiting-pages">
            {{ $t('gainos.onboarding.progressPages', { count: preview?.pagesAnalyzed ?? 0 }) }}
          </p>
          <p class="section-desc">{{ $t('gainos.onboarding.progressHint') }}</p>
        </section>

        <!-- 理解失败 -->
        <section v-else-if="view === 'failed'" class="onboarding-section">
          <h2 class="waiting-title">{{ $t('gainos.onboarding.failureTitle') }}</h2>
          <p class="section-desc">{{ failureCopy() }}</p>
          <p v-if="errorText" class="onboarding-error">{{ errorText }}</p>
          <div class="onboarding-actions">
            <Button :loading="starting" type="primary" @click="retryUnderstanding">
              {{ $t('gainos.onboarding.retry') }}
            </Button>
            <Button :disabled="starting" @click="switchManualFromFailure">
              {{ $t('gainos.onboarding.switchManual') }}
            </Button>
          </div>
        </section>

        <!-- 预览确认 / 手动填写共用表单 -->
        <section v-else class="onboarding-section">
          <p v-if="view === 'preview'" class="preview-banner">
            {{ $t('gainos.onboarding.previewTitle') }}
          </p>

          <label v-if="view === 'manual'" class="field">
            <span class="field-label">{{ $t('gainos.onboarding.companyName') }}</span>
            <Input v-model:value="name" :maxlength="200" />
          </label>

          <div class="field">
            <span class="field-label">{{ $t('gainos.onboarding.industry') }}</span>
            <Select
              v-if="industryOptions.length > 0"
              v-model:value="industryCode"
              :options="industryOptions"
              allow-clear
              :placeholder="$t('gainos.onboarding.industryPlaceholder')"
              show-search
              style="width: 100%"
            />
            <Input
              v-else
              v-model:value="industryText"
              :maxlength="120"
              :placeholder="$t('gainos.onboarding.industryPlaceholder')"
            />
            <span
              v-if="view === 'preview' && industrySuggested?.matched && industrySuggested.label"
              class="field-hint hint-accent"
            >
              {{ $t('gainos.onboarding.industrySuggested', { name: industrySuggested.label }) }}
            </span>
            <span
              v-else-if="view === 'preview' && preview?.industry.raw"
              class="field-hint"
            >
              {{ $t('gainos.onboarding.industryUnmatched', { name: preview.industry.raw }) }}
            </span>
            <span v-else-if="industryOptions.length > 0" class="field-hint">
              {{ $t('gainos.onboarding.industryEmptyHint') }}
            </span>
          </div>

          <div class="field">
            <span class="field-label">{{ $t('gainos.onboarding.productsLabel') }}</span>
            <p class="section-desc">{{ $t('gainos.onboarding.productsDesc') }}</p>
            <div v-if="preview?.products.length || products.length" class="product-tags">
              <span
                v-for="item in Array.from(new Set([...(preview?.products ?? []).map((p) => p.name), ...products]))"
                :key="item"
                class="tag"
                :class="{ selected: products.includes(item) }"
              >
                <button
                  :aria-pressed="products.includes(item)"
                  class="tag-toggle"
                  type="button"
                  @click="toggleProduct(item)"
                >
                  <span class="tag-check">{{ products.includes(item) ? '✓' : '+' }}</span>
                  {{ item }}
                </button>
                <a
                  v-if="preview?.products.find((p) => p.name === item)?.sourceUrl"
                  :href="preview?.products.find((p) => p.name === item)?.sourceUrl ?? '#'"
                  class="tag-source"
                  rel="noreferrer"
                  target="_blank"
                >{{ $t('gainos.onboarding.sourceLink') }}</a>
              </span>
            </div>
            <div class="product-row">
              <Input
                v-model:value="productDraft"
                :maxlength="120"
                :placeholder="$t('gainos.onboarding.productsPlaceholder')"
                @press-enter="addProduct()"
              />
              <Button @click="addProduct()">{{ $t('gainos.onboarding.addProduct') }}</Button>
            </div>
          </div>

          <div class="field">
            <span class="field-label">{{ $t('gainos.onboarding.marketsLabel') }}</span>
            <p class="section-desc">{{ $t('gainos.onboarding.marketsDesc') }}</p>
            <Select
              v-model:value="targetMarkets"
              :max-tag-count="8"
              :options="marketOptions"
              mode="multiple"
              :placeholder="$t('gainos.onboarding.marketsPlaceholder')"
              style="width: 100%"
            />
            <span
              v-if="view === 'preview' && suggestedMarketNames"
              class="field-hint hint-accent"
            >
              {{ $t('gainos.onboarding.marketsSuggested', { names: suggestedMarketNames }) }}
            </span>
          </div>

          <label class="field">
            <span class="field-label">{{ $t('gainos.onboarding.businessEmail') }}</span>
            <Input
              v-model:value="businessEmail"
              :placeholder="$t('gainos.onboarding.businessEmailPlaceholder')"
            />
            <span v-if="emailHint" class="field-hint hint-accent">{{ emailHint }}</span>
          </label>

          <p v-if="errorText" class="onboarding-error">{{ errorText }}</p>

          <div class="onboarding-actions">
            <Button
              v-if="view === 'preview'"
              :disabled="submitting"
              @click="switchManualFromFailure"
            >
              {{ $t('gainos.onboarding.switchManual') }}
            </Button>
            <Button
              :disabled="view === 'manual' ? !manualValid : !selectionValid"
              :loading="submitting"
              type="primary"
              @click="submit"
            >
              {{ $t('gainos.onboarding.submit') }}
            </Button>
          </div>
        </section>
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
  width: 640px;
  max-width: 100%;
  max-height: calc(100vh - 48px);
  overflow-y: auto;
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
  gap: 16px;
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

.hint-accent {
  color: var(--gs-primary, #2563eb);
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
  gap: 2px;
  padding-right: 10px;
  font-size: 13px;
  color: var(--gs-fg, #111827);
  background: var(--gs-bg-soft, #f5f6f7);
  border: 1px solid transparent;
  border-radius: 999px;
}

.tag.selected {
  color: var(--gs-primary, #2563eb);
  background: color-mix(in srgb, var(--gs-primary, #2563eb) 10%, #fff);
  border-color: var(--gs-primary, #2563eb);
}

.tag-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px 5px 10px;
  font: inherit;
  color: inherit;
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: 999px;
}

.tag-check {
  font-weight: 600;
}

.tag-source {
  font-size: 11px;
  color: var(--gs-fg-subtle, #6b7280);
  text-decoration: underline;
}

.onboarding-error {
  margin: 0;
  font-size: 13px;
  color: var(--gs-danger, #dc2626);
}

.onboarding-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

.primary-action {
  min-width: 160px;
}

.start-hint {
  font-size: 12px;
  color: var(--gs-fg-subtle, #6b7280);
  text-align: right;
}

.text-link {
  align-self: center;
  padding: 0;
  font-size: 13px;
  color: var(--gs-fg-subtle, #6b7280);
  text-decoration: underline;
  cursor: pointer;
  background: none;
  border: 0;
}

.waiting {
  align-items: center;
  justify-content: center;
  text-align: center;
}

.waiting-spinner {
  width: 36px;
  height: 36px;
  border: 3px solid var(--gs-border, #e5e7eb);
  border-top-color: var(--gs-primary, #2563eb);
  border-radius: 50%;
  animation: onboarding-spin 0.9s linear infinite;
}

.waiting-title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}

.waiting-pages {
  margin: 0;
  font-size: 13px;
  color: var(--gs-primary, #2563eb);
}

.preview-banner {
  margin: 0;
  padding: 10px 12px;
  font-size: 13px;
  color: var(--gs-fg, #111827);
  background: color-mix(in srgb, var(--gs-primary, #2563eb) 8%, #fff);
  border-radius: 8px;
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

@keyframes onboarding-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 640px) {
  .onboarding-card {
    padding: 20px;
  }

  .onboarding-steps {
    flex-direction: column;
  }
}
</style>
