<script lang="ts" setup>
import type {
  ComtradeRecommendationBundle,
  ProcurementScenarioCode,
} from '@gain-saas/shared';

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import {
  buildThreeLayerPreview,
  isSellerMarketplaceStoreUrl,
  normalizeComtradeBundle,
  normalizeWebsiteUrl,
  parseSellerIntakeSource,
  PROCUREMENT_SCENARIO_CODES,
} from '@gain-saas/shared';
import { preferences, usePreferences } from '@vben/preferences';

import { Alert, Button, Input, Select, Tag } from 'ant-design-vue';

import ThreeLayerProfileCard from '#/components/gainos/ThreeLayerProfileCard.vue';
import { feedback } from '#/feedback';
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
 * 3 步 ≤3 分钟极速上手（Phase 2 Track 2C）：
 * 1) 多模态冷启动（官网 / 1688·阿里国际站店铺 / PDF 产品画册 / 主营产品简介）；
 * 2) 产品与目标国选择（集成 UN Comtrade 推荐国徽章 + 行内确认建档事实）；
 * 3) 三栏审阅卡片（我是谁 / 我找谁 / 排除谁）→ 一键启动首轮流式寻源。
 *
 * 完整保留原「完成建档」直达工作台出口与「未指定市场也可保存（targetMarkets: []）」契约。
 */
type View = 'start' | 'waiting' | 'preview' | 'failed' | 'manual' | 'review';
type IntakeMode = 'website' | 'store' | 'brochure' | 'brief';

const view = ref<View>('start');
const intakeMode = ref<IntakeMode>('website');
const loading = ref(true);
const submitting = ref(false);
const launching = ref(false);
const launchStageText = ref('');
const starting = ref(false);
const errorText = ref('');
const isAdmin = ref(false);

const name = ref('');
const website = ref('');
const storeUrl = ref('');
const productDescription = ref('');
const businessEmail = ref('');
const industryCode = ref<string | undefined>(undefined);
const industryText = ref('');
const customIndustryMode = ref(false);
const products = ref<string[]>([]);
const productDraft = ref('');
const targetMarkets = ref<string[]>([]);
const preview = ref<OnboardingPreview | null>(null);

// PDF 画册多模态上传态（复用 PR #205 已接通的 seller-documents 链路）
const brochureInputRef = ref<HTMLInputElement | null>(null);
const brochureUploading = ref(false);
const uploadedBrochures = ref<Array<{ id: string; filename: string; status: string }>>([]);

// UN Comtrade 目标国推荐（只读参考，默认绝不自动代选）
const comtradeBundle = ref<ComtradeRecommendationBundle | null>(null);
const comtradeLoading = ref(false);
let comtradeReqSeq = 0;

// 第 3 步三层审阅卡片状态（我找谁 / 排除谁）
const reviewBuyerRoles = ref<string[]>(['distributor', 'epc']);
const reviewScenario = ref<'' | ProcurementScenarioCode>('');
const reviewCustomExclusions = ref<string[]>([]);

// 防异步写覆盖竞态：单调请求序列 + 用户编辑脏标记。
const EMAIL_CACHE_KEY = 'gainos.onboarding.businessEmail.v1';
let previewRequestSeq = 0;
const industryTouched = ref(false);
const productsTouched = ref(false);
const manualChosen = ref(false);

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

/** 词表标签按当前语言取：labels[locale] → labels[短语言] → 英文标签 → 中文标签。 */
function labelFor(row: {
  label?: string;
  labelEn?: string;
  labels?: Record<string, string>;
}): string {
  const lang = locale.value ?? 'zh-CN';
  const short = lang.split('-')[0] ?? 'zh';
  return (
    row.labels?.[lang] ??
    row.labels?.[short] ??
    (short === 'en' ? row.labelEn : undefined) ??
    row.label ??
    row.labelEn ??
    ''
  );
}

const industryOptions = computed(() => {
  const rows = preview.value?.industry.options ?? [];
  return rows.map((row) => {
    const codeHint = row.nace?.[0] ?? row.code;
    return { value: row.code, raw: row, label: `${labelFor(row)}（${codeHint}）` };
  });
});
const industrySuggested = computed(() => preview.value?.industry.suggested ?? null);
const industrySuggestedLabel = computed(() => {
  const suggested = industrySuggested.value;
  if (!suggested) return null;
  const option = preview.value?.industry.options.find((row) => row.code === suggested.code);
  if (option) return labelFor(option);
  return suggested.label ?? suggested.labelEn ?? null;
});
const marketOptions = computed(() => {
  const base = MARKET_CODES.map((code) => ({
    value: code as string,
    label: `${regionNames.value?.of(code) ?? code} (${code})`,
  }));
  const known = new Set<string>(base.map((option) => option.value));
  const extraFromPreview = (preview.value?.markets ?? [])
    .filter((item) => !known.has(item.code))
    .map((item) => {
      known.add(item.code);
      return {
        value: item.code,
        label: `${labelFor({ label: item.name, labelEn: item.labelEn, labels: item.labels })} (${item.code})`,
      };
    });
  const extraFromComtrade = (comtradeBundle.value?.recommendations ?? [])
    .filter((item) => !known.has(item.code))
    .map((item) => {
      known.add(item.code);
      return {
        value: item.code,
        label: `${labelFor({ label: item.name, labelEn: item.labelEn ?? undefined })} (${item.code})`,
      };
    });
  return [...base, ...extraFromPreview, ...extraFromComtrade];
});

const suggestedMarketNames = computed(() =>
  (preview.value?.markets ?? [])
    .map((item) => labelFor({ label: item.name, labelEn: item.labelEn, labels: item.labels }))
    .join('、'),
);

const comtradeItems = computed(() => comtradeBundle.value?.recommendations ?? []);
const comtradeBasisText = computed(() => {
  const bundle = comtradeBundle.value;
  if (!bundle || bundle.basisHsCodes.length === 0) return '';
  const codes = bundle.basisHsCodes.map((item) => item.code).slice(0, 4).join(', ');
  return $t('gainos.onboarding.comtradeBasis', {
    codes,
    year: bundle.referenceYear ?? 2024,
  });
});

function formatCompactUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return '';
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  return `$${Math.round(value / 1_000)}K`;
}

function formatGrowthPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

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

function isValidNormalizedWebsite(raw: string): boolean {
  const parsed = parseSellerIntakeSource(raw);
  return parsed.kind === 'website' || parsed.kind === 'alibaba_store';
}

function normalizeWebsiteField() {
  const trimmed = website.value.trim();
  if (!trimmed) return;
  website.value = normalizeWebsiteUrl(trimmed);
}

function normalizeStoreUrlField() {
  const trimmed = storeUrl.value.trim();
  if (!trimmed) return;
  storeUrl.value = normalizeWebsiteUrl(trimmed);
}

const parsedWebsiteSource = computed(() => parseSellerIntakeSource(website.value));
const websiteValid = computed(
  () => !website.value.trim() || isValidNormalizedWebsite(website.value),
);
const websiteError = computed(() =>
  website.value.trim() && !websiteValid.value
    ? $t('gainos.onboarding.websiteInvalidHint')
    : '',
);
const storeUrlValid = computed(
  () => storeUrl.value.trim().length > 0 && isSellerMarketplaceStoreUrl(storeUrl.value),
);
const storeUrlError = computed(() =>
  storeUrl.value.trim() && !storeUrlValid.value
    ? $t('gainos.onboarding.storeUrlInvalid')
    : '',
);

const startValid = computed(
  () => name.value.trim().length > 0 && website.value.trim().length > 0 && websiteValid.value,
);
const storeStartValid = computed(() => name.value.trim().length > 0 && storeUrlValid.value);
const briefStartValid = computed(
  () => name.value.trim().length > 0 && productDescription.value.trim().length >= 4,
);
const manualValid = computed(
  () =>
    name.value.trim().length > 0 &&
    products.value.length > 0 &&
    products.value.length <= 5,
);
const selectionValid = computed(
  () => products.value.length > 0 && products.value.length <= 5,
);

const step = computed(() => {
  if (view.value === 'start') return 0;
  if (view.value === 'review') return 2;
  return 1;
});
const steps = computed(() => [
  $t('gainos.onboarding.stepWebsite'),
  $t('gainos.onboarding.stepConfirm'),
  $t('gainos.onboarding.stepLaunch'),
]);

const activeIndustryLabel = computed(() => {
  const useCustom = customIndustryMode.value || industryOptions.value.length === 0;
  if (!useCustom && industryCode.value) {
    const option = preview.value?.industry.options.find((row) => row.code === industryCode.value);
    if (option) return labelFor(option);
  }
  return industryText.value.trim() || industrySuggestedLabel.value || '';
});

const sourceSummaryText = computed(() => {
  const parts: string[] = [];
  const channel = preview.value?.websiteChannel;
  if (channel === 'alibaba_1688') parts.push($t('gainos.onboarding.storeChannelBadge1688'));
  else if (channel === 'alibaba_intl') parts.push($t('gainos.onboarding.storeChannelBadgeAlibaba'));
  else if (website.value.trim()) parts.push(website.value.trim());
  const docCount = Math.max(uploadedBrochures.value.length, preview.value?.documents?.total ?? 0);
  if (docCount > 0) parts.push($t('gainos.onboarding.brochureCountHint', { count: docCount }));
  if (productDescription.value.trim()) parts.push($t('gainos.onboarding.modeBrief'));
  return parts.join(' · ');
});

const threeLayerPreview = computed(() =>
  buildThreeLayerPreview({
    companyName: name.value,
    industry: activeIndustryLabel.value,
    products: products.value,
    sourceSummary: sourceSummaryText.value,
    targetMarkets: targetMarkets.value,
    buyerRoles: reviewBuyerRoles.value,
    procurementScenario: reviewScenario.value || null,
    customExclusions: reviewCustomExclusions.value,
  }),
);

function toggleCustomIndustryMode() {
  industryTouched.value = true;
  customIndustryMode.value = !customIndustryMode.value;
  if (customIndustryMode.value) {
    industryCode.value = undefined;
  } else {
    industryText.value = '';
  }
}

function adoptSuggestedMarkets() {
  const suggestedCodes = (preview.value?.markets ?? [])
    .map((item) => item.code?.trim().toUpperCase())
    .filter((code): code is string => Boolean(code && /^[A-Z]{2}$/.test(code)));
  if (suggestedCodes.length === 0) return;
  targetMarkets.value = Array.from(new Set([...targetMarkets.value, ...suggestedCodes]));
}

function toggleComtradeMarket(code: string) {
  const upper = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return;
  if (targetMarkets.value.includes(upper)) {
    targetMarkets.value = targetMarkets.value.filter((item) => item !== upper);
  } else {
    targetMarkets.value = [...targetMarkets.value, upper];
  }
}

function adoptAllComtradeMarkets() {
  const codes = comtradeItems.value
    .slice(0, 5)
    .map((item) => item.code)
    .filter((code) => /^[A-Z]{2}$/.test(code));
  if (codes.length === 0) return;
  targetMarkets.value = Array.from(new Set([...targetMarkets.value, ...codes]));
}

async function loadComtradeRecommendations(companyId?: string | null) {
  if (!companyId) return;
  const seq = ++comtradeReqSeq;
  comtradeLoading.value = true;
  try {
    const raw = await gainosApi.marketRecommendations(companyId, { limit: 8 });
    if (seq !== comtradeReqSeq) return;
    const bundle = normalizeComtradeBundle(raw);
    comtradeBundle.value = bundle.recommendations.length > 0 ? bundle : null;
  } catch {
    if (seq === comtradeReqSeq) comtradeBundle.value = null;
  } finally {
    if (seq === comtradeReqSeq) comtradeLoading.value = false;
  }
}

function addProduct(value?: string) {
  const next = (value ?? productDraft.value).trim().slice(0, 120);
  if (!next) return;
  if (products.value.length >= 5) {
    feedback.message.warning($t('gainos.onboarding.productsLimit'));
    return;
  }
  productsTouched.value = true;
  if (!products.value.includes(next)) products.value.push(next);
  productDraft.value = '';
}

function removeProduct(value: string) {
  productsTouched.value = true;
  products.value = products.value.filter((item) => item !== value);
}

function toggleProduct(value: string) {
  productsTouched.value = true;
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
  if (next.summary && !productDescription.value) productDescription.value = next.summary;
  if (next.documents?.items?.length) {
    uploadedBrochures.value = next.documents.items.map((item) => ({
      id: item.id,
      filename: item.filename,
      status: item.status,
    }));
  }
  if (manualChosen.value) {
    stopPolling();
    view.value = 'manual';
    void loadComtradeRecommendations(next.companyId);
    return;
  }
  if (next.state === 'ready') {
    const suggested = next.industry.suggested;
    if (!industryTouched.value && !customIndustryMode.value) {
      industryCode.value = suggested.code ?? undefined;
    }
    const suggestedProducts = next.products.map((item) => item.name);
    if (!productsTouched.value && products.value.length === 0) {
      products.value = suggestedProducts.slice(0, 5);
    }
    view.value = 'preview';
    stopPolling();
    void loadComtradeRecommendations(next.companyId);
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
  void loadComtradeRecommendations(next.companyId);
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
  const reqSeq = ++previewRequestSeq;
  try {
    const state = await gainosApi.onboardingPreview();
    if (reqSeq !== previewRequestSeq || manualChosen.value) return;
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
    const cachedEmail = sessionStorage.getItem(EMAIL_CACHE_KEY);
    if (cachedEmail && !businessEmail.value) businessEmail.value = cachedEmail;
  } catch {
    // 隐私模式忽略
  }
  const reqSeq = ++previewRequestSeq;
  try {
    const context = await gainosApi.workspaceContext();
    isAdmin.value = context?.workspace?.role === 'admin';
    if (context?.onboarding?.complete) {
      await router.replace(preferences.app.defaultHomePath);
      return;
    }
    if (!name.value) name.value = context?.workspace?.name ?? '';
    if (context?.onboarding?.companyId) {
      try {
        const state = await gainosApi.onboardingPreview();
        if (reqSeq === previewRequestSeq && state.started) applyPreview(state.preview);
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
  normalizeWebsiteField();
  if (!startValid.value || starting.value) return;
  starting.value = true;
  errorText.value = '';
  manualChosen.value = false;
  const reqSeq = ++previewRequestSeq;
  try {
    const state = await gainosApi.startOnboardingPreview({
      website: normalizeWebsiteUrl(website.value),
      name: name.value.trim(),
    });
    if (reqSeq === previewRequestSeq) applyPreview(state.preview);
  } catch (error) {
    handleError(error);
  } finally {
    starting.value = false;
  }
}

async function startStoreUnderstanding() {
  normalizeStoreUrlField();
  if (!storeStartValid.value || starting.value) return;
  starting.value = true;
  errorText.value = '';
  manualChosen.value = false;
  const normalized = normalizeWebsiteUrl(storeUrl.value);
  website.value = normalized;
  const reqSeq = ++previewRequestSeq;
  try {
    const state = await gainosApi.startOnboardingPreview({
      website: normalized,
      name: name.value.trim(),
    });
    if (reqSeq === previewRequestSeq) applyPreview(state.preview);
  } catch (error) {
    handleError(error);
  } finally {
    starting.value = false;
  }
}

async function startBriefOnboarding() {
  if (!briefStartValid.value || starting.value) return;
  starting.value = true;
  errorText.value = '';
  manualChosen.value = true;
  stopPolling();
  const desc = productDescription.value.trim();
  const reqSeq = ++previewRequestSeq;
  try {
    const state = await gainosApi.startOnboardingPreview({
      name: name.value.trim(),
      productDescription: desc,
    });
    if (reqSeq === previewRequestSeq) {
      if (!productsTouched.value && products.value.length === 0) {
        const extracted = desc
          .split(/[、,，;；\n]+/)
          .map((item) => item.trim().slice(0, 60))
          .filter((item) => item.length >= 2);
        if (extracted.length > 0) products.value = extracted.slice(0, 3);
      }
      applyPreview(state.preview);
      view.value = 'manual';
    }
  } catch (error) {
    handleError(error);
  } finally {
    starting.value = false;
  }
}

function triggerBrochurePick() {
  if (!name.value.trim()) {
    errorText.value = $t('gainos.onboarding.brochureNeedName');
    return;
  }
  errorText.value = '';
  brochureInputRef.value?.click();
}

async function onBrochureSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!name.value.trim()) {
    errorText.value = $t('gainos.onboarding.brochureNeedName');
    return;
  }
  const isPdf =
    file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!isPdf) {
    errorText.value = $t('gainos.onboarding.brochureInvalidType');
    return;
  }
  brochureUploading.value = true;
  errorText.value = '';
  try {
    let companyId = preview.value?.companyId ?? '';
    if (!companyId) {
      const state = await gainosApi.startOnboardingPreview({ name: name.value.trim() });
      preview.value = state.preview;
      companyId = state.preview.companyId;
    }
    const signed = await gainosApi.presignSellerDocument(companyId, {
      filename: file.name,
      mime: 'application/pdf',
      size: file.size,
    });
    const put = await fetch(
      `/api/companies/${companyId}/seller-documents/${signed.documentId}/content`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/pdf' },
        body: file,
      },
    );
    if (!put.ok) throw new Error(`upload ${put.status}`);
    const committed = await gainosApi.commitSellerDocument(companyId, signed.documentId);
    uploadedBrochures.value = [
      { id: committed.id ?? signed.documentId, filename: file.name, status: committed.status ?? 'UPLOADED' },
      ...uploadedBrochures.value.filter((item) => item.id !== signed.documentId),
    ];
    feedback.message.success($t('gainos.onboarding.brochureUploaded', { name: file.name }));
    manualChosen.value = true;
    stopPolling();
    view.value = 'manual';
    void loadComtradeRecommendations(companyId);
  } catch (error) {
    handleError(error);
  } finally {
    brochureUploading.value = false;
  }
}

async function enterManual() {
  if (!name.value.trim() || starting.value) return;
  starting.value = true;
  errorText.value = '';
  manualChosen.value = true;
  stopPolling();
  const reqSeq = ++previewRequestSeq;
  try {
    // 手动模式不带官网：建名称草稿（不触发理解），受控词表随预览响应下发。
    const state = await gainosApi.startOnboardingPreview({ name: name.value.trim() });
    if (reqSeq === previewRequestSeq) {
      applyPreview(state.preview);
      view.value = 'manual';
    }
  } catch (error) {
    handleError(error);
  } finally {
    starting.value = false;
  }
}

async function retryUnderstanding() {
  normalizeWebsiteField();
  if (starting.value || !websiteValid.value) return;
  starting.value = true;
  errorText.value = '';
  manualChosen.value = false;
  const reqSeq = ++previewRequestSeq;
  try {
    const state = await gainosApi.startOnboardingPreview({
      website: normalizeWebsiteUrl(website.value),
      name: name.value.trim(),
    });
    if (reqSeq !== previewRequestSeq) return;
    if (state.preview.state === 'failed') {
      preview.value = state.preview;
      view.value = 'waiting';
      startPolling();
    } else {
      applyPreview(state.preview);
    }
  } catch (error) {
    handleError(error);
  } finally {
    starting.value = false;
  }
}

function buildPayload(): OnboardingCompanyInput {
  const option = preview.value?.industry.options.find((row) => row.code === industryCode.value);
  const useCustom = customIndustryMode.value || industryOptions.value.length === 0;
  return {
    name: name.value.trim(),
    ...(!useCustom && industryCode.value
      ? {
          industryCode: industryCode.value,
          industry: option ? labelFor(option) : industryText.value.trim(),
        }
      : industryText.value.trim()
        ? { industry: industryText.value.trim() }
        : {}),
    products: [...products.value],
    targetMarkets: [...targetMarkets.value],
    ...(productDescription.value.trim()
      ? { productDescription: productDescription.value.trim() }
      : {}),
    ...(businessEmail.value.trim() ? { businessEmail: businessEmail.value.trim() } : {}),
  };
}

function enterReviewStep() {
  const valid = view.value === 'manual' ? manualValid.value : selectionValid.value;
  if (!valid || submitting.value) return;
  errorText.value = '';
  view.value = 'review';
}

function backFromReview() {
  view.value = preview.value?.state === 'ready' && !manualChosen.value ? 'preview' : 'manual';
}

function mintAttemptId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `attempt-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

async function submit() {
  const valid = view.value === 'manual' ? manualValid.value : selectionValid.value;
  if (!valid || submitting.value) return;
  submitting.value = true;
  errorText.value = '';
  try {
    await gainosApi.completeOnboarding(buildPayload());
    try {
      sessionStorage.removeItem(EMAIL_CACHE_KEY);
    } catch {
      // ignore
    }
    authStore.markOnboardingCompleted();
    feedback.message.success($t('gainos.onboarding.success'));
    await router.replace(preferences.app.defaultHomePath);
  } catch (error) {
    handleError(error);
  } finally {
    submitting.value = false;
  }
}

/** 第 3 步一键启动：完成建档 → 管理员自动确认建档事实 → 生成并激活三层画像 → 启动首轮流式寻源。 */
async function launchFromOnboarding() {
  if (!selectionValid.value || launching.value) return;
  launching.value = true;
  errorText.value = '';
  launchStageText.value = $t('gainos.onboarding.launchingStepSaving');
  try {
    const completed = await gainosApi.completeOnboarding(buildPayload());
    try {
      sessionStorage.removeItem(EMAIL_CACHE_KEY);
    } catch {
      // ignore
    }
    authStore.markOnboardingCompleted();
    const companyId = completed?.id ?? preview.value?.companyId ?? '';
    if (!companyId) {
      feedback.message.success($t('gainos.onboarding.success'));
      await router.replace('/find-buyers');
      return;
    }

    // 管理员行内自动确认关键建档事实，消除 NO_APPROVED_CLAIMS 阻塞
    if (isAdmin.value) {
      await gainosApi.synthesizeClaimDrafts(companyId).catch(() => undefined);
      const pending = await gainosApi.claims(companyId, 'NEEDS_REVIEW').catch(() => []);
      for (const claim of (Array.isArray(pending) ? pending : []).slice(0, 12)) {
        await gainosApi.approveClaim(claim.id).catch(() => undefined);
      }
    }

    launchStageText.value = $t('gainos.onboarding.launchingStepProfile');
    const icp = await gainosApi.createIcp(companyId, {
      attemptId: mintAttemptId(),
      ...(targetMarkets.value.length > 0 ? { confirmedTargetMarkets: [...targetMarkets.value] } : {}),
      ...(products.value.length > 0 ? { productLines: [...products.value] } : {}),
      ...(reviewBuyerRoles.value.length > 0 ? { buyerRoles: [...reviewBuyerRoles.value] } : {}),
      ...(reviewScenario.value ? { procurementScenario: reviewScenario.value } : {}),
      ...(reviewCustomExclusions.value.length > 0
        ? { peerExclusionNotes: [...reviewCustomExclusions.value] }
        : {}),
    });
    await gainosApi.activateIcp(icp.id, { keepExistingActive: true }).catch(() => undefined);

    launchStageText.value = $t('gainos.onboarding.launchingStepPlan');
    let startedRunId = '';
    try {
      let plan = await gainosApi.createQueryPlan(icp.id, mintAttemptId());
      if (plan.status === 'DRAFT') {
        plan = await gainosApi.confirmQueryPlan(plan.id);
      }
      const task = await gainosApi.createAcquisitionTask({
        icpId: icp.id,
        name: icp.name || name.value.trim(),
      });
      const started = await gainosApi.startAcquisitionTaskRun(task.id, plan.id, mintAttemptId());
      startedRunId = started.runId ?? '';
    } catch {
      // 若预算/计划暂不可用，仍保留已建档+画像结果直接带去找买家页
    }

    feedback.message.success(
      startedRunId ? $t('gainos.onboarding.launchSuccess') : $t('gainos.onboarding.launchPartialFallback'),
    );
    await router.replace({
      path: '/find-buyers',
      query: {
        icp: icp.id,
        ...(startedRunId ? { run: startedRunId } : {}),
      },
    });
  } catch (error) {
    // 若建档本身已成功但下游异常，温和提示并跳转到找买家页
    if (authStore.onboardingCompleted) {
      feedback.message.info($t('gainos.onboarding.launchPartialFallback'));
      await router.replace('/find-buyers');
      return;
    }
    handleError(error);
  } finally {
    launching.value = false;
    launchStageText.value = '';
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
  manualChosen.value = true;
  stopPolling();
  view.value = 'manual';
}

watch(businessEmail, (val) => {
  try {
    if (val.trim()) sessionStorage.setItem(EMAIL_CACHE_KEY, val.trim());
    else sessionStorage.removeItem(EMAIL_CACHE_KEY);
  } catch {
    // ignore
  }
});

async function logout() {
  await authStore.logout();
}

onMounted(loadContext);
onBeforeUnmount(stopPolling);
</script>

<template>
  <div class="onboarding">
    <div class="onboarding-card" :class="{ 'onboarding-card--wide': view === 'review' }">
      <div class="onboarding-brand">
        <img alt="GainOS" class="onboarding-logo" src="/logo-gainos.svg" />
        <h1 class="onboarding-title">{{ $t('gainos.onboarding.title') }}</h1>
        <p class="onboarding-subtitle">{{ $t('gainos.onboarding.subtitle') }}</p>
      </div>

      <ol class="onboarding-steps" data-gs="onboarding-steps">
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
        <!-- 第一步：多模态冷启动（默认公司官网，无缝切换 1688/阿里店铺、PDF 画册、产品简介） -->
        <section v-if="view === 'start'" class="onboarding-section">
          <label class="field">
            <span class="field-label">{{ $t('gainos.onboarding.companyName') }}</span>
            <Input
              v-model:value="name"
              :maxlength="200"
              :placeholder="$t('gainos.onboarding.companyNamePlaceholder')"
            />
          </label>

          <!-- 多模态冷启动方式切换 -->
          <div class="mode-tabs" data-gs="intake-mode-tabs" role="tablist">
            <button
              v-for="mode in (['website', 'store', 'brochure', 'brief'] as const)"
              :key="mode"
              :aria-selected="intakeMode === mode"
              :class="{ active: intakeMode === mode }"
              :data-gs="`intake-mode-${mode}`"
              class="mode-tab"
              role="tab"
              type="button"
              @click="intakeMode = mode; errorText = ''"
            >
              {{
                mode === 'website'
                  ? $t('gainos.onboarding.modeWebsite')
                  : mode === 'store'
                    ? $t('gainos.onboarding.modeStore')
                    : mode === 'brochure'
                      ? $t('gainos.onboarding.modeBrochure')
                      : $t('gainos.onboarding.modeBrief')
              }}
            </button>
          </div>

          <!-- 模式 1：公司官网（默认，保留全部原有选择器与自动补全 https://） -->
          <template v-if="intakeMode === 'website'">
            <label class="field">
              <span class="field-label">{{ $t('gainos.onboarding.website') }}</span>
              <Input
                v-model:value="website"
                :placeholder="$t('gainos.onboarding.websitePlaceholder')"
                @blur="normalizeWebsiteField"
                @press-enter="startUnderstanding"
              />
              <span v-if="websiteError" class="onboarding-error">{{ websiteError }}</span>
              <span
                v-else-if="parsedWebsiteSource.kind === 'alibaba_store'"
                class="field-hint hint-accent"
                data-gs="detected-store-badge"
              >
                {{
                  parsedWebsiteSource.marketplace === '1688'
                    ? $t('gainos.onboarding.storeChannelBadge1688')
                    : $t('gainos.onboarding.storeChannelBadgeAlibaba')
                }} · {{ $t('gainos.onboarding.storeUrlWhitelistHint') }}
              </span>
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
          </template>

          <!-- 模式 2：1688 / 阿里国际站卖家店铺链接 -->
          <template v-else-if="intakeMode === 'store'">
            <label class="field">
              <span class="field-label">{{ $t('gainos.onboarding.storeUrlLabel') }}</span>
              <Input
                v-model:value="storeUrl"
                :placeholder="$t('gainos.onboarding.storeUrlPlaceholder')"
                data-gs="store-url-input"
                @blur="normalizeStoreUrlField"
                @press-enter="startStoreUnderstanding"
              />
              <span v-if="storeUrlError" class="onboarding-error">{{ storeUrlError }}</span>
              <span class="field-hint">{{ $t('gainos.onboarding.storeUrlWhitelistHint') }}</span>
            </label>
            <p v-if="errorText" class="onboarding-error">{{ errorText }}</p>
            <div class="onboarding-actions">
              <Button
                :disabled="!storeStartValid"
                :loading="starting"
                class="primary-action"
                data-gs="store-start-btn"
                type="primary"
                @click="startStoreUnderstanding"
              >
                {{ $t('gainos.onboarding.startUnderstanding') }}
              </Button>
            </div>
          </template>

          <!-- 模式 3：上传 PDF 产品画册 -->
          <template v-else-if="intakeMode === 'brochure'">
            <div class="brochure-box" data-gs="brochure-intake-box">
              <p class="brochure-box__title">{{ $t('gainos.onboarding.brochureTitle') }}</p>
              <p class="section-desc">{{ $t('gainos.onboarding.brochureHint') }}</p>
              <input
                ref="brochureInputRef"
                accept=".pdf,application/pdf"
                class="sr-only-input"
                data-gs="brochure-file-input"
                type="file"
                @change="onBrochureSelected"
              />
              <div class="brochure-box__actions">
                <Button
                  :loading="brochureUploading"
                  data-gs="brochure-upload-btn"
                  type="primary"
                  @click="triggerBrochurePick"
                >
                  {{
                    brochureUploading
                      ? $t('gainos.onboarding.brochureUploading')
                      : $t('gainos.onboarding.brochurePickBtn')
                  }}
                </Button>
              </div>
              <div v-if="uploadedBrochures.length > 0" class="brochure-list" data-gs="brochure-uploaded-badge">
                <Tag v-for="doc in uploadedBrochures" :key="doc.id" :bordered="false">
                  {{ doc.filename }}
                </Tag>
              </div>
            </div>
            <p v-if="errorText" class="onboarding-error">{{ errorText }}</p>
          </template>

          <!-- 模式 4：简短主营产品描述冷启动 -->
          <template v-else>
            <label class="field">
              <span class="field-label">{{ $t('gainos.onboarding.briefLabel') }}</span>
              <Input.TextArea
                v-model:value="productDescription"
                :maxlength="2000"
                :placeholder="$t('gainos.onboarding.briefPlaceholder')"
                :rows="4"
                data-gs="product-brief-input"
              />
              <span class="field-hint">{{ $t('gainos.onboarding.briefHint') }}</span>
            </label>
            <p v-if="errorText" class="onboarding-error">{{ errorText }}</p>
            <div class="onboarding-actions">
              <Button
                :disabled="!briefStartValid"
                :loading="starting"
                class="primary-action"
                data-gs="brief-start-btn"
                type="primary"
                @click="startBriefOnboarding"
              >
                {{ $t('gainos.onboarding.briefStartBtn') }}
              </Button>
            </div>
          </template>
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
          <label class="field">
            <span class="field-label">{{ $t('gainos.onboarding.website') }}</span>
            <Input
              v-model:value="website"
              :placeholder="$t('gainos.onboarding.websitePlaceholder')"
              @blur="normalizeWebsiteField"
            />
            <span v-if="websiteError" class="onboarding-error">{{ websiteError }}</span>
            <span class="field-hint">{{ $t('gainos.onboarding.failureWebsiteHint') }}</span>
          </label>
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

        <!-- 第三步：三栏审阅卡片（我是谁 / 我找谁 / 排除谁）→ 一键启动发现 -->
        <section v-else-if="view === 'review'" class="onboarding-section" data-gs="onboarding-step-review">
          <div>
            <h2 class="waiting-title">{{ $t('gainos.onboarding.reviewTitle') }}</h2>
            <p class="section-desc">{{ $t('gainos.onboarding.reviewSubtitle') }}</p>
          </div>

          <ThreeLayerProfileCard
            :custom-exclusions="reviewCustomExclusions"
            :profile="threeLayerPreview"
            :selected-roles="reviewBuyerRoles"
            editable
            @update:custom-exclusions="reviewCustomExclusions = $event"
            @update:selected-roles="reviewBuyerRoles = $event"
          />

          <label class="field">
            <span class="field-label">{{ $t('gainos.onboarding.reviewScenarioLabel') }}</span>
            <Select
              v-model:value="reviewScenario"
              :options="[
                { value: '', label: $t('gainos.findBuyers.createScenarioAuto') },
                ...PROCUREMENT_SCENARIO_CODES.map((code) => ({
                  value: code,
                  label: $t(`gainos.threeLayer.scenario.${code}`),
                })),
              ]"
              data-gs="review-scenario-select"
              style="width: 100%"
            />
          </label>

          <Alert
            v-if="launchStageText"
            :message="launchStageText"
            show-icon
            type="info"
          />
          <p v-if="errorText" class="onboarding-error">{{ errorText }}</p>

          <div class="onboarding-actions">
            <Button :disabled="launching" data-gs="review-back-btn" @click="backFromReview">
              {{ $t('gainos.onboarding.reviewBack') }}
            </Button>
            <Button
              :disabled="!selectionValid || launching"
              :loading="launching"
              data-gs="onboarding-launch-discovery"
              type="primary"
              @click="launchFromOnboarding"
            >
              {{ $t('gainos.onboarding.launchDiscoveryBtn') }}
            </Button>
          </div>
        </section>

        <!-- 第二步：预览确认 / 手动填写（集成 UN Comtrade 推荐国徽章 + 行内一键事实确认） -->
        <section v-else class="onboarding-section">
          <p v-if="view === 'preview'" class="preview-banner">
            {{ $t('gainos.onboarding.previewTitle') }}
          </p>

          <div v-if="uploadedBrochures.length > 0" class="brochure-list" data-gs="step2-brochure-badges">
            <Tag v-for="doc in uploadedBrochures" :key="doc.id" :bordered="false">
              {{ doc.filename }}
            </Tag>
          </div>

          <label v-if="view === 'manual'" class="field">
            <span class="field-label">{{ $t('gainos.onboarding.companyName') }}</span>
            <Input v-model:value="name" :maxlength="200" />
          </label>

          <div class="field">
            <div class="field-head">
              <span class="field-label">{{ $t('gainos.onboarding.industry') }}</span>
              <button
                v-if="industryOptions.length > 0"
                class="text-link field-toggle"
                data-gs="toggle-custom-industry"
                type="button"
                @click="toggleCustomIndustryMode"
              >
                {{
                  customIndustryMode
                    ? $t('gainos.onboarding.industryUseSelect')
                    : $t('gainos.onboarding.industryUseCustom')
                }}
              </button>
            </div>
            <Select
              v-if="industryOptions.length > 0 && !customIndustryMode"
              v-model:value="industryCode"
              :options="industryOptions"
              allow-clear
              :placeholder="$t('gainos.onboarding.industryPlaceholder')"
              show-search
              style="width: 100%"
              @change="industryTouched = true"
            />
            <Input
              v-else
              v-model:value="industryText"
              :maxlength="120"
              :placeholder="$t('gainos.onboarding.industryCustomPlaceholder')"
              data-gs="custom-industry-input"
              @change="industryTouched = true"
            />
            <span
              v-if="view === 'preview' && industrySuggested?.matched && industrySuggestedLabel"
              class="field-hint hint-accent"
            >
              {{ $t('gainos.onboarding.industrySuggested', { name: industrySuggestedLabel }) }}
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

            <!-- UN Comtrade 出口目标国推荐徽章（只读参考，点击才加入，默认绝不自动选中） -->
            <div
              v-if="comtradeItems.length > 0 && !comtradeLoading"
              class="comtrade-box"
              data-gs="comtrade-recommendations"
            >
              <div class="field-head">
                <span class="comtrade-box__title">{{ $t('gainos.onboarding.comtradeTitle') }}</span>
                <button
                  class="text-link field-toggle"
                  data-gs="adopt-comtrade-markets"
                  type="button"
                  @click="adoptAllComtradeMarkets"
                >
                  {{ $t('gainos.onboarding.comtradeAdoptAll') }}
                </button>
              </div>
              <p v-if="comtradeBasisText" class="field-hint">{{ comtradeBasisText }}</p>
              <div class="comtrade-badges">
                <button
                  v-for="item in comtradeItems.slice(0, 6)"
                  :key="item.code"
                  :aria-pressed="targetMarkets.includes(item.code)"
                  :class="{ selected: targetMarkets.includes(item.code) }"
                  :data-gs="`comtrade-market-${item.code}`"
                  :title="item.reason ?? undefined"
                  class="comtrade-badge"
                  type="button"
                  @click="toggleComtradeMarket(item.code)"
                >
                  <span class="comtrade-badge__head">
                    <strong>{{ targetMarkets.includes(item.code) ? '✓' : '+' }} {{ labelFor({ label: item.name, labelEn: item.labelEn ?? undefined }) }} ({{ item.code }})</strong>
                  </span>
                  <span
                    v-if="formatCompactUsd(item.importValueUsd) || formatGrowthPct(item.yoyGrowthPct)"
                    class="comtrade-badge__meta"
                  >
                    <template v-if="formatCompactUsd(item.importValueUsd)">
                      {{ $t('gainos.onboarding.comtradeImportLabel', { value: formatCompactUsd(item.importValueUsd) }) }}
                    </template>
                    <template v-if="formatGrowthPct(item.yoyGrowthPct)">
                      · {{ $t('gainos.onboarding.comtradeGrowthLabel', { value: formatGrowthPct(item.yoyGrowthPct) }) }}
                    </template>
                  </span>
                </button>
              </div>
              <span class="field-hint">{{ $t('gainos.onboarding.comtradeHint') }}</span>
            </div>

            <div
              v-if="view === 'preview' && suggestedMarketNames"
              class="field-hint-row"
            >
              <span class="field-hint hint-accent">
                {{ $t('gainos.onboarding.marketsSuggested', { names: suggestedMarketNames }) }}
              </span>
              <button
                class="text-link field-toggle"
                data-gs="adopt-suggested-markets"
                type="button"
                @click="adoptSuggestedMarkets"
              >
                {{ $t('gainos.onboarding.adoptSuggestedMarkets') }}
              </button>
            </div>
            <span class="field-hint">{{ $t('gainos.onboarding.marketsOptionalHint') }}</span>
          </div>

          <label class="field">
            <span class="field-label">{{ $t('gainos.onboarding.businessEmail') }}</span>
            <Input
              v-model:value="businessEmail"
              :placeholder="$t('gainos.onboarding.businessEmailPlaceholder')"
            />
            <span v-if="emailHint" class="field-hint hint-accent">{{ emailHint }}</span>
          </label>

          <p v-if="isAdmin" class="field-hint" data-gs="inline-facts-note">
            {{ $t('gainos.onboarding.inlineFactsNote') }}
          </p>

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
              :disabled="(view === 'manual' ? !manualValid : !selectionValid) || submitting"
              data-gs="go-step-review"
              @click="enterReviewStep"
            >
              {{ $t('gainos.onboarding.reviewAndLaunch') }}
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
  border: 1px solid var(--gs-border, var(--gs-border));
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(23,23,23,.06);
  transition: width 0.2s ease;
}

.onboarding-card--wide {
  width: 860px;
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
  color: var(--gs-fg-subtle, var(--gs-fg-muted));
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
  color: var(--gs-fg-subtle, var(--gs-fg-muted));
  background: var(--gs-bg-soft, #f5f6f7);
  border-radius: 8px;
}

.onboarding-steps li.active {
  color: var(--gs-fg, var(--gs-fg));
  background: var(--gs-bg, #fff);
  border: 1px solid var(--gs-primary, var(--gs-accent));
}

.onboarding-steps li.done {
  color: var(--gs-fg, var(--gs-fg));
}

.onboarding-steps .dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  font-size: 12px;
  background: var(--gs-bg-soft, var(--gs-border));
  border-radius: 50%;
}

.onboarding-steps li.active .dot {
  color: #fff;
  background: var(--gs-primary, var(--gs-accent));
}

.onboarding-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 220px;
}

.mode-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.mode-tab {
  padding: 6px 12px;
  border: 1px solid var(--gs-border, #e5e7eb);
  border-radius: 999px;
  background: var(--gs-bg-soft, #f5f6f7);
  color: var(--gs-fg-2, #374151);
  font-size: 12.5px;
  cursor: pointer;
}

.mode-tab.active {
  border-color: var(--gs-primary, var(--gs-accent));
  background: color-mix(in srgb, var(--gs-primary, var(--gs-accent)) 10%, var(--gs-surface, #fff));
  color: var(--gs-fg, #111827);
  font-weight: 600;
}

.brochure-box {
  display: grid;
  gap: 8px;
  padding: 16px;
  border: 1px dashed var(--gs-border, #d1d5db);
  border-radius: 10px;
  background: var(--gs-bg-soft, #f9fafb);
}

.brochure-box__title {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
}

.brochure-box__actions,
.brochure-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.sr-only-input {
  display: none;
}

.comtrade-box {
  display: grid;
  gap: 8px;
  margin-top: 6px;
  padding: 10px 12px;
  border: 1px solid var(--gs-border, #e5e7eb);
  border-radius: 10px;
  background: var(--gs-bg-soft, #f9fafb);
}

.comtrade-box__title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--gs-fg, #111827);
}

.comtrade-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.comtrade-badge {
  display: grid;
  gap: 2px;
  padding: 6px 10px;
  border: 1px solid var(--gs-border, #d1d5db);
  border-radius: 8px;
  background: var(--gs-bg, #fff);
  color: var(--gs-fg, #111827);
  text-align: left;
  font-size: 12px;
  cursor: pointer;
}

.comtrade-badge.selected {
  border-color: var(--gs-primary, var(--gs-accent));
  background: color-mix(in srgb, var(--gs-primary, var(--gs-accent)) 10%, var(--gs-surface, #fff));
}

.comtrade-badge__meta {
  font-size: 11px;
  color: var(--gs-fg-subtle, var(--gs-fg-muted));
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-head,
.field-hint-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.field-toggle {
  font-size: 12px;
  padding: 0;
}

.field-label {
  font-size: 13px;
  font-weight: 500;
}

.field-hint {
  font-size: 12px;
  color: var(--gs-fg-subtle, var(--gs-fg-muted));
}

.hint-accent {
  color: var(--gs-primary, var(--gs-accent));
}

.section-desc {
  margin: 0;
  font-size: 13px;
  color: var(--gs-fg-subtle, var(--gs-fg-muted));
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
  padding-right: 10px;
  font-size: 13px;
  color: var(--gs-fg, var(--gs-fg));
  background: var(--gs-bg-soft, #f5f6f7);
  border: 1px solid transparent;
  border-radius: 999px;
}

.tag.selected {
  color: var(--gs-fg, var(--gs-fg));
  background: color-mix(in srgb, var(--gs-primary, var(--gs-accent)) 10%, var(--gs-surface, #fff));
  border-color: var(--gs-primary, var(--gs-accent));
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
  color: var(--gs-fg-subtle, var(--gs-fg-muted));
  text-decoration: underline;
}

.tag.selected .tag-source {
  color: var(--gs-fg, var(--gs-fg));
}

.tag-source:focus-visible {
  outline: 2px solid var(--gs-fg, var(--gs-fg));
  outline-offset: 2px;
  box-shadow: 0 0 0 2px var(--gs-surface, #ffffff);
  border-radius: 2px;
}

.onboarding-error {
  margin: 0;
  font-size: 13px;
  color: var(--gs-danger, var(--gs-danger));
}

.onboarding-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

.primary-action {
  min-width: 160px;
}

.start-hint {
  font-size: 12px;
  color: var(--gs-fg-subtle, var(--gs-fg-muted));
  text-align: right;
}

.text-link {
  align-self: center;
  padding: 0;
  font-size: 13px;
  color: var(--gs-fg-subtle, var(--gs-fg-muted));
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
  border: 3px solid var(--gs-border, var(--gs-border));
  border-top-color: var(--gs-primary, var(--gs-accent));
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
  color: var(--gs-primary, var(--gs-accent));
}

.preview-banner {
  margin: 0;
  padding: 10px 12px;
  font-size: 13px;
  color: var(--gs-fg, var(--gs-fg));
  background: color-mix(in srgb, var(--gs-primary, var(--gs-accent)) 10%, var(--gs-surface, #fff));
  border: 1px solid color-mix(in srgb, var(--gs-primary, var(--gs-accent)) 28%, transparent);
  border-radius: 8px;
}

.onboarding-loading {
  padding: 48px 0;
  font-size: 14px;
  color: var(--gs-fg-subtle, var(--gs-fg-muted));
  text-align: center;
}

.onboarding-logout {
  display: block;
  margin: 20px auto 0;
  font-size: 12px;
  color: var(--gs-fg-subtle, var(--gs-fg-muted));
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
