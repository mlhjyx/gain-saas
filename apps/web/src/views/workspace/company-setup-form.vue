<script setup lang="ts">
import type { ComtradeMarketRecommendation } from '@gain-saas/shared';

import type { OnboardingPreview } from '#/api/gainos';

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { normalizeComtradeRecommendations, parseSellerIntakeSource } from '@gain-saas/shared';
import { usePreferences } from '@vben/preferences';

import { Alert, Button, Input, Radio, RadioGroup, Select } from 'ant-design-vue';

import { AUTH_SESSION_CHANGING_KEY } from '#/api/core/auth';
import { failureText, gainosApi } from '#/api/gainos';
import { formatBytes, validateSellerDocumentFile } from '#/api/seller-documents-upload';
import { $t } from '#/locales';
import { MAX_BATCH_FILES, useUploadQueueStore } from '#/stores/upload-queue';

const props = defineProps<{
  companyId?: string;
  targetMarkets: string[];
  workspaceName: string;
}>();
const emit = defineEmits<{
  draft: [companyId: string | null];
  saved: [payload: { companyId: string; targetMarkets: string[] }];
}>();

const MAX_PRODUCTS = 5;
const MAX_MARKETS = 20;
const MARKET_CODES = [
  'US', 'CA', 'MX', 'BR', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'PL',
  'SE', 'NO', 'DK', 'FI', 'CH', 'AT', 'CZ', 'TR', 'RU', 'IN', 'JP', 'KR',
  'AE', 'SA', 'AU', 'NZ', 'ZA', 'EG', 'VN', 'TH', 'ID', 'MY', 'PH', 'SG',
];
const { locale } = usePreferences();
const uploadQueue = useUploadQueueStore();
const preview = ref<OnboardingPreview | null>(null);
const initialLoading = ref(Boolean(props.companyId));
const editingSource = ref(false);
const starting = ref(false);
const saving = ref(false);
const sessionExpired = ref(false);
const error = ref('');
const previewError = ref('');
const mode = ref<'store' | 'website'>('website');
const name = ref(props.workspaceName);
const url = ref('');
const productBrief = ref('');
const businessEmail = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
const files = ref<File[]>([]);
const dragging = ref(false);
const fileHint = ref('');
const queuedNames = ref<string[]>([]);
const industryCode = ref<string>();
const industry = ref('');
const customIndustry = ref(false);
const productDraft = ref('');
const manualProducts = ref<string[]>([]);
const products = ref<string[]>([]);
const productLimit = ref(false);
const markets = ref([...props.targetMarkets]);
const recommendations = ref<ComtradeMarketRecommendation[]>([]);

let request = 0;
let recommendationRequest = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let industryEdited = false;
let productsEdited = false;
let marketsEdited = false;

function readAuthMarker(): string | null {
  try {
    return window.localStorage.getItem(AUTH_SESSION_CHANGING_KEY);
  } catch {
    return null;
  }
}

const initialAuthMarker = readAuthMarker();
function currentSession(): boolean {
  if (readAuthMarker() !== initialAuthMarker) {
    sessionExpired.value = true;
    files.value = [];
    clearTimeout(timer);
  }
  return !sessionExpired.value;
}

function onAuthChange(event: StorageEvent): void {
  if (event.key === AUTH_SESSION_CHANGING_KEY) currentSession();
}

const normalizedSource = computed(() => parseSellerIntakeSource(url.value));
const sourceValid = computed(() =>
  normalizedSource.value.kind === 'empty' || (
    normalizedSource.value.kind !== 'invalid' &&
    (mode.value === 'website' || normalizedSource.value.kind === 'alibaba_store')
  ),
);
const pending = computed(() =>
  preview.value?.state === 'queued' || preview.value?.state === 'running',
);
const sourceOpen = computed(() => !preview.value || editingSource.value);
const canStart = computed(() => Boolean(
  name.value.trim() && !starting.value && !saving.value && !sessionExpired.value &&
  (pending.value
    ? files.value.length > 0
    : sourceValid.value && (url.value.trim() || productBrief.value.trim() || files.value.length)),
));
const canSave = computed(() => Boolean(
  preview.value && !pending.value && !starting.value && !saving.value && !sessionExpired.value &&
  name.value.trim() && products.value.length &&
  (!businessEmail.value.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(businessEmail.value.trim())),
));
const industryOptions = computed(() => (preview.value?.industry.options ?? []).map((option) => ({
  label: option.labels?.[locale.value] ??
    (locale.value === 'en-US' ? option.labelEn : option.label) ?? option.label,
  value: option.code,
})));
const productOptions = computed(() => {
  const candidates = (preview.value?.products ?? []).slice(0, MAX_PRODUCTS);
  return [...new Map(
    [...candidates, ...manualProducts.value.map((name) => ({ name, sourceUrl: null }))]
      .map((row) => [row.name, row]),
  ).values()];
});
const regionNames = computed(() => new Intl.DisplayNames([locale.value], { type: 'region' }));
const suggestedMarkets = computed(() => (preview.value?.markets ?? []).filter((row) => /^[A-Z]{2}$/.test(row.code)));
const marketOptions = computed(() => [...new Set([
  ...MARKET_CODES, ...suggestedMarkets.value.map((row) => row.code),
  ...recommendations.value.map((row) => row.code), ...markets.value,
])].map((code) => ({
  label: (regionNames.value.of(code) ?? code) + ' (' + code + ')',
  value: code,
})));
const marketSuggestionsLabel = computed(() =>
  suggestedMarkets.value.map((row) => regionNames.value.of(row.code) ?? row.name).join(' / '),
);
const marketLimitReached = ref(false);

watch(() => props.targetMarkets, (value) => {
  if (!marketsEdited) markets.value = [...value];
});

function applyPreview(value: OnboardingPreview, restoreIdentity = false): void {
  preview.value = value;
  if (restoreIdentity) {
    name.value = value.name || props.workspaceName;
    url.value = value.website ?? '';
    mode.value = parseSellerIntakeSource(url.value).kind === 'alibaba_store' ? 'store' : 'website';
    const documents = value.documents?.items ?? [];
    queuedNames.value = documents.map((document) => document.filename);
    uploadQueue.restoreProcessing(value.companyId, documents, value.name);
  }
  if (!industryEdited) {
    const suggested = value.industry.suggested;
    industryCode.value = suggested?.matched ? suggested.code ?? undefined : undefined;
  }
  if (!productsEdited) {
    products.value = (value.products ?? []).slice(0, MAX_PRODUCTS).map((row) => row.name);
  }
}

async function loadMarketRecommendations(id: string): Promise<void> {
  const sequence = ++recommendationRequest;
  try {
    const response = await gainosApi.marketRecommendations(id, { limit: 8 });
    if (!disposed && sequence === recommendationRequest) {
      recommendations.value = normalizeComtradeRecommendations(response)
        .filter((row) => /^[A-Z]{2}$/.test(row.code));
    }
  } catch {
    if (!disposed && sequence === recommendationRequest) recommendations.value = [];
  }
}

function scheduleRefresh(): void {
  clearTimeout(timer);
  if (!disposed && pending.value && !starting.value && !sessionExpired.value) {
    timer = setTimeout(() => { void refreshPreview(); }, 3000);
  }
}

async function refreshPreview(restoreIdentity = false): Promise<void> {
  if (!currentSession()) return;
  const sequence = ++request;
  try {
    const response = await gainosApi.onboardingPreview();
    if (disposed || sequence !== request || !currentSession()) return;
    previewError.value = '';
    if (response?.started) {
      applyPreview(response.preview, restoreIdentity);
      emit('draft', response.preview.companyId);
      if (restoreIdentity) void loadMarketRecommendations(response.preview.companyId);
    } else if (restoreIdentity) {
      preview.value = null;
      emit('draft', null);
    }
  } catch (failure) {
    if (!disposed && sequence === request) previewError.value = failureText(failure).title;
  } finally {
    if (!disposed && sequence === request) {
      initialLoading.value = false;
      scheduleRefresh();
    }
  }
}

onMounted(() => {
  window.addEventListener('storage', onAuthChange);
  if (props.companyId) void refreshPreview(true);
});
watch(() => uploadQueue.lastAssetUpdate, (asset) => {
  if (asset && asset.companyId === preview.value?.companyId && !starting.value && !saving.value) {
    clearTimeout(timer);
    void refreshPreview();
  }
});
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
  window.removeEventListener('storage', onAuthChange);
});

function selectFiles(incoming: FileList | null): void {
  dragging.value = false;
  if (starting.value || !currentSession()) return;
  fileHint.value = '';
  for (const file of Array.from(incoming ?? [])) {
    if (files.value.some((current) => current.name === file.name && current.size === file.size && current.lastModified === file.lastModified)) continue;
    if (files.value.length >= MAX_BATCH_FILES) {
      fileHint.value = $t('gainos.onboarding.brochureMaxCount');
      break;
    }
    const validation = validateSellerDocumentFile(file);
    if (!validation.ok || validation.mime !== 'application/pdf' || file.size === 0) {
      fileHint.value = $t(!validation.ok && validation.code === 'FILE_TOO_LARGE'
        ? 'gainos.onboarding.brochureTooLarge' : 'gainos.onboarding.brochureInvalidType');
      continue;
    }
    files.value.push(file);
  }
}

function queueFiles(id: string): boolean {
  if (!files.value.length) return true;
  const result = uploadQueue.enqueueFiles(id, files.value, { companyName: name.value.trim() });
  if (result.sessionChanged) {
    error.value = $t('gainosOb.companies.uploadSessionChanged');
    return false;
  }
  queuedNames.value = [...new Set([...queuedNames.value, ...result.accepted.map((item) => item.filename)])];
  const rejected = new Set(result.rejected.map((item) => item.filename));
  files.value = files.value.filter((file) => rejected.has(file.name));
  if (rejected.size) error.value = $t('gainosOb.setup.uploadRejected');
  return rejected.size === 0;
}

async function start(manual = false): Promise<void> {
  if (!currentSession() || !name.value.trim() || starting.value || saving.value || (!manual && !canStart.value)) return;
  error.value = '';
  starting.value = true;
  ++request;
  clearTimeout(timer);
  try {
    if (pending.value && preview.value) {
      if (queueFiles(preview.value.companyId)) editingSource.value = false;
      return;
    }
    const source = !manual && url.value.trim() ? normalizedSource.value.normalizedUrl : '';
    const brief = productBrief.value.trim();
    const response = await gainosApi.startOnboardingPreview({
      name: name.value.trim(),
      ...(source ? { website: source } : {}),
      ...(brief ? { productDescription: brief } : {}),
    });
    if (!currentSession()) return;
    if (!response?.preview?.companyId) {
      if (!disposed) error.value = $t('gainosOb.setup.previewFailed');
      return;
    }
    if (disposed) {
      queueFiles(response.preview.companyId);
      return;
    }
    if (source) url.value = source;
    previewError.value = '';
    applyPreview(response.preview);
    emit('draft', response.preview.companyId);
    if (queueFiles(response.preview.companyId)) editingSource.value = false;
    void loadMarketRecommendations(response.preview.companyId);
  } catch (failure) {
    if (!disposed) error.value = failureText(failure).title;
  } finally {
    if (!disposed) {
      starting.value = false;
      scheduleRefresh();
    }
  }
}

function toggleProduct(product: string): void {
  productsEdited = true;
  productLimit.value = false;
  if (products.value.includes(product)) {
    products.value = products.value.filter((value) => value !== product);
  } else if (products.value.length === MAX_PRODUCTS) {
    productLimit.value = true;
  } else {
    products.value = [...products.value, product];
  }
}

function addProduct(): void {
  const value = productDraft.value.trim();
  if (!value || products.value.includes(value)) return;
  toggleProduct(value);
  if (productLimit.value) return;
  if (!productOptions.value.some((row) => row.name === value)) manualProducts.value.push(value);
  productDraft.value = '';
}

function adoptMarkets(codes: string[]): void {
  changeMarkets([...new Set([...markets.value, ...codes])]);
}

function toggleMarket(code: string): void {
  if (markets.value.includes(code)) changeMarkets(markets.value.filter((market) => market !== code));
  else adoptMarkets([code]);
}

function editIndustry(useCustom = customIndustry.value): void {
  industryEdited = true;
  customIndustry.value = useCustom;
}

function changeMarkets(value: unknown): void {
  marketsEdited = true;
  const selected = Array.isArray(value) ? value.filter((code): code is string => typeof code === 'string') : [];
  marketLimitReached.value = selected.length > MAX_MARKETS;
  markets.value = selected.slice(0, MAX_MARKETS);
}

async function save(): Promise<void> {
  const id = preview.value?.companyId;
  if (!id || !canSave.value || !currentSession()) return;
  saving.value = true;
  error.value = '';
  const code = !customIndustry.value ? industryCode.value : undefined;
  const label = code ? industryOptions.value.find((row) => row.value === code)?.label : industry.value.trim();
  const targetMarkets = [...markets.value];
  try {
    await gainosApi.completeOnboarding({
      name: name.value.trim(),
      ...(code ? { industryCode: code } : {}),
      ...(label ? { industry: label } : {}),
      products: [...products.value],
      targetMarkets,
      ...(productBrief.value.trim() ? { productDescription: productBrief.value.trim() } : {}),
      ...(businessEmail.value.trim() ? { businessEmail: businessEmail.value.trim() } : {}),
    });
    if (!disposed) emit('saved', { companyId: id, targetMarkets });
  } catch (failure) {
    if (!disposed) error.value = failureText(failure).title;
  } finally {
    if (!disposed) saving.value = false;
  }
}
</script>

<template>
  <div class="setup-intake" data-gs="setup-intake">
    <Alert v-if="sessionExpired" type="warning" show-icon :message="$t('gainosOb.setup.sessionChanged')" />
    <p v-if="initialLoading" role="status">{{ $t('gainos.onboarding.loading') }}</p>
    <Alert v-if="previewError" type="warning" show-icon :message="$t('gainosOb.setup.previewFailed')">
      <template #action>
        <Button size="small" @click="refreshPreview(!preview)">{{ $t('gainos.common.retry') }}</Button>
      </template>
    </Alert>
    <Alert v-if="error" class="setup-intake__error" data-gs="setup-error" type="error" show-icon :message="error" />

    <form v-if="!initialLoading && sourceOpen" class="setup-intake__block" data-gs="setup-source" @submit.prevent="start()">
      <div class="setup-intake__columns">
        <div class="setup-intake__fields">
          <h3>{{ $t('gainosOb.setup.sourceTitle') }}</h3>
          <label>
            <span>{{ $t('gainos.onboarding.companyName') }}</span>
            <Input v-model:value="name" :maxlength="200" :disabled="pending" data-gs="setup-name" />
          </label>
          <RadioGroup v-model:value="mode" size="small" :disabled="pending" :aria-label="$t('gainosOb.setup.sourceTitle')">
            <Radio value="website" data-gs="intake-mode-website">{{ $t('gainos.onboarding.modeWebsite') }}</Radio>
            <Radio value="store" data-gs="intake-mode-store">{{ $t('gainos.onboarding.modeStore') }}</Radio>
          </RadioGroup>
          <label>
            <span>{{ $t(mode === 'store' ? 'gainos.onboarding.storeUrlLabel' : 'gainosOb.setup.websiteOptional') }}</span>
            <Input v-model:value="url" inputmode="url" :maxlength="2048" :disabled="pending"
              :placeholder="$t(mode === 'store' ? 'gainos.onboarding.storeUrlPlaceholder' : 'gainos.onboarding.websitePlaceholder')"
              data-gs="setup-website" />
          </label>
          <p v-if="url.trim() && !sourceValid" class="setup-intake__warning">
            {{ $t(mode === 'store' ? 'gainos.onboarding.storeUrlInvalid' : 'gainos.onboarding.websiteInvalidHint') }}
          </p>
          <label>
            <span>{{ $t('gainosOb.setup.briefOptional') }}</span>
            <Input.TextArea v-model:value="productBrief" :maxlength="2000" :disabled="pending" :rows="2" data-gs="product-brief-input" />
          </label>
        </div>
        <div class="setup-intake__upload" :class="{ 'is-dragging': dragging }"
          @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="selectFiles($event.dataTransfer?.files ?? null)">
          <div>
            <h3>{{ $t('gainosOb.setup.brochureTitle') }}</h3>
            <p>{{ $t('gainosOb.setup.brochureHint') }}</p>
          </div>
          <input ref="fileInput" type="file" accept=".pdf,application/pdf" multiple hidden data-gs="brochure-file-input"
            @change="selectFiles(($event.target as HTMLInputElement).files); ($event.target as HTMLInputElement).value = ''" />
          <Button data-gs="setup-pick-files" :disabled="sessionExpired || starting" @click="fileInput?.click()">{{ $t('gainos.onboarding.brochurePickBtn') }}</Button>
          <ul v-if="files.length" class="setup-intake__files" data-gs="pending-brochure-list">
            <li v-for="(file, index) in files" :key="file.name + index">
              <span>{{ file.name }} <small>{{ formatBytes(file.size) }}</small></span>
              <Button type="text" size="small" :aria-label="$t('gainos.onboarding.brochureRemoveAria', { name: file.name })"
                @click="files.splice(index, 1)">{{ $t('gainosOb.setup.removeFile') }}</Button>
            </li>
          </ul>
          <p v-if="fileHint" class="setup-intake__warning" role="status">{{ fileHint }}</p>
          <p v-if="files.some((file) => file.size > 30 * 1024 * 1024)" class="setup-intake__warning" role="status">
            {{ $t('gainosOb.companies.largePdfAlertDesc') }}
          </p>
          <p v-if="queuedNames.length" class="setup-intake__muted" data-gs="setup-brochure-summary">
            {{ $t('gainosOb.setup.queueHint', { names: queuedNames.join(', ') }) }}
          </p>
        </div>
      </div>
      <div class="setup-intake__actions">
        <Button type="primary" html-type="submit" :loading="starting" :disabled="!canStart && !starting" data-gs="setup-start">
          {{ $t(pending ? 'gainosOb.setup.uploadMore' : 'gainosOb.setup.start') }}
        </Button>
        <Button v-if="!pending && !preview" type="text" :disabled="!name.trim() || starting || sessionExpired" data-gs="setup-manual" @click="start(true)">
          {{ $t('gainos.onboarding.noWebsite') }}
        </Button>
        <Button v-if="preview" type="text" @click="editingSource = false">{{ $t('gainosOb.setup.backToFacts') }}</Button>
      </div>
    </form>

    <form v-else-if="preview" class="setup-intake__block setup-intake__fields" data-gs="setup-facts" @submit.prevent="save">
      <div class="setup-intake__heading">
        <h3>{{ $t('gainosOb.setup.factsTitle') }}</h3>
        <Button type="text" data-gs="back-to-start-btn" @click="editingSource = true">{{ $t(pending ? 'gainosOb.setup.uploadMore' : 'gainos.onboarding.backToStart') }}</Button>
      </div>
      <p v-if="pending" class="setup-intake__status" role="status">{{ $t('gainosOb.setup.pending') }}</p>
      <p v-else-if="preview.state === 'ready'" class="setup-intake__status">{{ $t('gainos.onboarding.previewTitle') }}</p>
      <Alert v-else-if="preview.state === 'failed'" type="warning" show-icon :message="$t('gainos.onboarding.failureTitle')" :description="$t('gainosOb.setup.failedHint')">
        <template #action>
          <Button size="small" :loading="starting" @click="start()">{{ $t('gainos.onboarding.retry') }}</Button>
        </template>
      </Alert>
      <p v-if="queuedNames.length" class="setup-intake__muted" role="status" data-gs="setup-brochure-summary">
        {{ $t('gainosOb.setup.queueHint', { names: queuedNames.join(', ') }) }}
      </p>
      <div class="setup-intake__columns">
        <label>
          <span>{{ $t('gainos.onboarding.companyName') }}</span>
          <Input v-model:value="name" :maxlength="200" data-gs="setup-name" />
        </label>
        <label>
          <span>{{ $t('gainos.onboarding.businessEmail') }}</span>
          <Input v-model:value="businessEmail" type="email" :maxlength="254" />
        </label>
      </div>
      <div class="setup-intake__fields">
        <label v-if="customIndustry || !industryOptions.length">
          <span>{{ $t('gainos.onboarding.industry') }}</span>
          <Input v-model:value="industry" :maxlength="120" :placeholder="$t('gainos.onboarding.industryCustomPlaceholder')"
            data-gs="custom-industry-input" @change="editIndustry(true)" />
        </label>
        <label v-else>
          <span>{{ $t('gainos.onboarding.industry') }}</span>
          <Select v-model:value="industryCode" :options="industryOptions" allow-clear
            :placeholder="$t('gainos.onboarding.industryPlaceholder')" @change="editIndustry(false)" />
        </label>
        <Button v-if="industryOptions.length" class="setup-intake__inline-link" type="link" size="small" data-gs="toggle-custom-industry"
          @click="editIndustry(!customIndustry)">
          {{ $t(customIndustry ? 'gainos.onboarding.industryUseSelect' : 'gainos.onboarding.industryUseCustom') }}
        </Button>
      </div>
      <div class="setup-intake__fields">
        <label for="setup-product">{{ $t('gainos.onboarding.productsLabel') }}</label>
        <div v-if="productOptions.length" class="setup-intake__choices">
          <div v-for="candidate in productOptions" :key="candidate.name" class="setup-intake__choice">
            <Button size="small"
              :aria-pressed="products.includes(candidate.name)" data-gs="setup-product-option" @click="toggleProduct(candidate.name)">
              {{ candidate.name }}
            </Button>
            <a v-if="candidate.sourceUrl && /^https?:\/\//i.test(candidate.sourceUrl)" :href="candidate.sourceUrl"
              :title="candidate.name" target="_blank" rel="noopener noreferrer">{{ $t('gainos.onboarding.sourceLink') }}</a>
          </div>
        </div>
        <div class="setup-intake__actions setup-intake__product">
          <Input id="setup-product" v-model:value="productDraft" :maxlength="120" :placeholder="$t('gainos.onboarding.productsPlaceholder')"
            data-gs="setup-product-input" @keydown.enter.prevent="addProduct" />
          <Button :disabled="!productDraft.trim()" @click="addProduct">{{ $t('gainos.onboarding.addProduct') }}</Button>
        </div>
        <p v-if="productLimit" class="setup-intake__warning" role="status">{{ $t('gainos.onboarding.productsLimit') }}</p>
      </div>
      <div class="setup-intake__fields">
        <label>
          <span>{{ $t('gainosOb.setup.marketOptional') }}</span>
          <Select :value="markets" mode="multiple" :options="marketOptions" allow-clear
            :placeholder="$t('gainos.onboarding.marketsPlaceholder')" option-filter-prop="label"
            data-gs="setup-markets" @change="changeMarkets" />
        </label>
        <div v-if="suggestedMarkets.length" class="setup-intake__actions">
          <span class="setup-intake__muted">{{ $t('gainos.onboarding.marketsSuggested', { names: marketSuggestionsLabel }) }}</span>
          <Button type="link" size="small" @click="adoptMarkets(suggestedMarkets.map((row) => row.code))">{{ $t('gainos.onboarding.adoptSuggestedMarkets') }}</Button>
        </div>
        <div v-if="recommendations.length" class="setup-intake__actions" data-gs="comtrade-recommendations">
          <span class="setup-intake__muted">{{ $t('gainos.onboarding.comtradeTitle') }}</span>
          <Button v-for="market in recommendations" :key="market.code" size="small"
            :data-gs="'comtrade-market-' + market.code" :aria-pressed="markets.includes(market.code)"
            @click="toggleMarket(market.code)">
            {{ market.name }} ({{ market.code }})</Button>
        </div>
        <p class="setup-intake__muted">{{ $t('gainos.onboarding.marketsOptionalHint') }}</p>
        <p v-if="marketLimitReached" class="setup-intake__warning" role="status">
          {{ $t('gainosOb.setup.marketLimit', { limit: MAX_MARKETS }) }}
        </p>
      </div>
      <div class="setup-intake__actions">
        <Button type="primary" html-type="submit" :disabled="!canSave && !saving" :loading="saving" data-gs="setup-save">
          {{ $t('gainos.onboarding.submit') }}
        </Button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.setup-intake { display: grid; gap: 12px; margin-block-start: 20px; }
.setup-intake__block { padding-block-start: 16px; border-block-start: 1px solid var(--gs-border); }
.setup-intake__columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; }
.setup-intake__fields { display: grid; gap: 10px; min-width: 0; align-items: start; }
.setup-intake__fields > label, .setup-intake__columns > label { display: grid; gap: 5px; font-size: 13px; font-weight: 550; }
.setup-intake__inline-link { justify-self: start; padding-inline: 0; }
.setup-intake h3 { margin: 0; font-size: 16px; font-weight: 650; }
.setup-intake__heading, .setup-intake__actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.setup-intake__heading { justify-content: space-between; }
.setup-intake__block > .setup-intake__actions { margin-block-start: 12px; }
.setup-intake__upload { display: grid; justify-items: start; gap: 12px; min-height: 170px; padding: 16px; border: 1px dashed var(--gs-border-strong); border-radius: 8px; background: var(--gs-surface-3); }
.setup-intake__upload.is-dragging { border-color: var(--gs-accent-fg); background: var(--gs-accent-soft); }
.setup-intake__upload p, .setup-intake__muted, .setup-intake__status, .setup-intake__warning { margin: 0; font-size: 13px; }
.setup-intake__upload p, .setup-intake__muted { color: var(--gs-fg-muted); overflow-wrap: anywhere; }
.setup-intake__warning { color: var(--gs-warn-fg); }
.setup-intake__status { padding: 10px 12px; border-radius: 8px; background: color-mix(in srgb, var(--gs-accent-fg) 7%, var(--gs-surface)); color: var(--gs-accent-fg); }
.setup-intake__files { display: grid; gap: 4px; width: 100%; padding: 0; margin: 0; list-style: none; }
.setup-intake__files li { display: flex; justify-content: space-between; align-items: center; gap: 6px; overflow-wrap: anywhere; }
.setup-intake__files small { color: var(--gs-fg-muted); white-space: nowrap; }
.setup-intake__choices { display: flex; flex-wrap: wrap; gap: 6px 10px; }
.setup-intake__choice { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.setup-intake__choice button.ant-btn:not(:disabled) { max-width: 100%; height: auto; white-space: normal; overflow-wrap: anywhere; color: var(--gs-fg); }
.setup-intake__choice button.ant-btn[aria-pressed='true']:not(:disabled) { background: var(--gs-accent-soft); color: var(--gs-accent-fg); border-color: var(--gs-accent-soft-border); }
.setup-intake__choice a { color: var(--gs-accent-fg); font-size: 12px; }
.setup-intake__choice :is(a, button) { scroll-margin-block: 12px; }
.setup-intake__choice :is(a, button):focus-visible { outline: 2px solid var(--gs-accent-fg); outline-offset: 1px; }
.setup-intake__choice a:focus-visible { box-shadow: 0 0 0 1px var(--gs-surface); }
.setup-intake__product { flex-wrap: nowrap; max-width: 480px; }
.setup-intake__product input { min-width: 0; }
@container (max-width: 620px) {
  .setup-intake__columns { grid-template-columns: minmax(0, 1fr); }
}
</style>
