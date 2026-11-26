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
 * 3 步 ≤3 分钟极速上手（Phase 2 Track 2C + 组合资料入口）：
 * 1) 主来源（官网 / 1688·阿里国际站店铺 / 主营产品简介）+ 可选附带 PDF 产品画册（可组合提交，也可仅凭画册建档）；
 * 2) 产品与目标国选择（集成 UN Comtrade 推荐国徽章 + 行内确认建档事实 + 支持返回修改资料）；
 * 3) 三栏审阅卡片（我是谁 / 我找谁 / 排除谁）→ 一键启动首轮流式寻源。
 *
 * 完整保留原「完成建档」直达工作台出口与「未指定市场也可保存（targetMarkets: []）」契约。
 */
type View = 'start' | 'waiting' | 'preview' | 'failed' | 'manual' | 'review';
type IntakeMode = 'website' | 'store' | 'brief';

const MAX_BROCHURES = 5;
const MAX_BROCHURE_BYTES = 50 * 1024 * 1024;
const LARGE_BROCHURE_HINT_BYTES = 30 * 1024 * 1024;

type BrochureTransferState = 'queued_upload' | 'uploading' | 'committing' | 'failed' | 'cancelled';

interface BrochureTransfer {
  localId: string;
  file: File;
  filename: string;
  size: number;
  state: BrochureTransferState;
  loadedBytes: number;
  percent: number;
  speedBps: number;
  error?: string;
  abort?: () => void;
}

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

// PDF 画册附件与后台双轨上传态（不阻塞跳转，实时进度条 + 取消/重试 + 解析状态轮询）
const brochureInputRef = ref<HTMLInputElement | null>(null);
const pendingBrochures = ref<Array<{ localId: string; file: File; filename: string; size: number }>>([]);
const brochureTransfers = ref<BrochureTransfer[]>([]);
const uploadedBrochures = ref<Array<{ id: string; filename: string; status: string; chunkCount?: number }>>([]);
let localBrochureSeq = 0;
let uploadQueueRunning = false;
let docPollTimer: ReturnType<typeof setInterval> | undefined;

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
  return rows.map((row) => ({ value: row.code, raw: row, label: labelFor(row) }));
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

const activeBrochureTransfers = computed(() =>
  brochureTransfers.value.filter(
    (item) => item.state === 'queued_upload' || item.state === 'uploading' || item.state === 'committing',
  ),
);
const brochureUploading = computed(() => activeBrochureTransfers.value.length > 0);
const hasAnyBrochure = computed(
  () =>
    pendingBrochures.value.length > 0 ||
    activeBrochureTransfers.value.length > 0 ||
    uploadedBrochures.value.length > 0,
);
const totalBrochureCount = computed(
  () =>
    pendingBrochures.value.length +
    activeBrochureTransfers.value.length +
    uploadedBrochures.value.length,
);
const totalPendingBrochureBytes = computed(() =>
  pendingBrochures.value.reduce((sum, item) => sum + item.size, 0),
);
const extractedDocClaims = computed(() => preview.value?.documents?.extractedClaims ?? []);
const parsingBrochureCount = computed(
  () =>
    uploadedBrochures.value.filter(
      (doc) =>
        doc.status === 'queued' ||
        doc.status === 'processing' ||
        doc.status === 'UPLOADED' ||
        doc.status === 'committing',
    ).length,
);
const readyBrochureCount = computed(
  () => uploadedBrochures.value.filter((doc) => doc.status === 'ready').length,
);
const hasBrochurePanel = computed(
  () =>
    brochureTransfers.value.length > 0 ||
    uploadedBrochures.value.length > 0 ||
    extractedDocClaims.value.length > 0,
);
const waitingBrochureTotal = computed(
  () => activeBrochureTransfers.value.length + uploadedBrochures.value.length,
);

const startValid = computed(() => {
  if (!name.value.trim()) return false;
  if (website.value.trim().length > 0) return websiteValid.value;
  return hasAnyBrochure.value;
});
const storeStartValid = computed(() => {
  if (!name.value.trim()) return false;
  if (storeUrl.value.trim().length > 0) return storeUrlValid.value;
  return hasAnyBrochure.value;
});
const briefStartValid = computed(() => {
  if (!name.value.trim()) return false;
  if (productDescription.value.trim().length > 0) {
    return productDescription.value.trim().length >= 4;
  }
  return hasAnyBrochure.value;
});

const websitePrimaryLabel = computed(() => {
  if (website.value.trim().length > 0) {
    return pendingBrochures.value.length > 0
      ? $t('gainos.onboarding.startUnderstandingWithBrochure')
      : $t('gainos.onboarding.startUnderstanding');
  }
  if (pendingBrochures.value.length > 0) return $t('gainos.onboarding.startWithBrochure');
  if (uploadedBrochures.value.length > 0 || activeBrochureTransfers.value.length > 0) {
    return $t('gainos.onboarding.continueWithBrochure');
  }
  return $t('gainos.onboarding.startUnderstanding');
});

const storePrimaryLabel = computed(() => {
  if (storeUrl.value.trim().length > 0) {
    return pendingBrochures.value.length > 0
      ? $t('gainos.onboarding.startUnderstandingWithBrochure')
      : $t('gainos.onboarding.startUnderstanding');
  }
  if (pendingBrochures.value.length > 0) return $t('gainos.onboarding.startWithBrochure');
  if (uploadedBrochures.value.length > 0 || activeBrochureTransfers.value.length > 0) {
    return $t('gainos.onboarding.continueWithBrochure');
  }
  return $t('gainos.onboarding.startUnderstanding');
});

const briefPrimaryLabel = computed(() => {
  if (productDescription.value.trim().length > 0) return $t('gainos.onboarding.briefStartBtn');
  if (pendingBrochures.value.length > 0) return $t('gainos.onboarding.startWithBrochure');
  if (uploadedBrochures.value.length > 0 || activeBrochureTransfers.value.length > 0) {
    return $t('gainos.onboarding.continueWithBrochure');
  }
  return $t('gainos.onboarding.briefStartBtn');
});

function formatBrochureSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatTransferSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '';
  if (bytesPerSec >= 1024 * 1024) return ` · ${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
  return ` · ${Math.max(1, Math.round(bytesPerSec / 1024))} KB/s`;
}

function transferStatusText(item: BrochureTransfer): string {
  if (item.state === 'queued_upload') return $t('gainos.onboarding.brochureStatusQueuedUpload');
  if (item.state === 'uploading') {
    return $t('gainos.onboarding.brochureStatusUploading', {
      percent: item.percent,
      loaded: formatBrochureSize(item.loadedBytes),
      total: formatBrochureSize(item.size),
      speed: formatTransferSpeed(item.speedBps),
    });
  }
  if (item.state === 'committing') return $t('gainos.onboarding.brochureStatusCommitting');
  if (item.state === 'cancelled') return $t('gainos.onboarding.brochureStatusCancelled');
  return $t('gainos.onboarding.brochureStatusFailed', {
    reason: item.error || $t('gainos.onboarding.submitFailed'),
  });
}

function serverDocStatusText(doc: { status: string; chunkCount?: number }): string {
  if (doc.status === 'ready') {
    return doc.chunkCount && doc.chunkCount > 0
      ? $t('gainos.onboarding.brochureStatusServerReady', { chunks: doc.chunkCount })
      : $t('gainos.onboarding.brochureStatusServerReadyNoCount');
  }
  if (doc.status === 'processing') return $t('gainos.onboarding.brochureStatusServerProcessing');
  if (doc.status === 'failed_terminal' || doc.status === 'rejected') {
    return $t('gainos.onboarding.brochureStatusServerFailed');
  }
  return $t('gainos.onboarding.brochureStatusServerQueued');
}

function claimTypeLabel(type: string): string {
  const known = new Set([
    'certification',
    'param',
    'capability',
    'moq',
    'lead_time',
    'market',
    'company_fact',
  ]);
  const key = known.has(type) ? type : 'other';
  return $t(`gainos.onboarding.brochureClaimType.${key}`);
}
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

function syncDocumentsFromPreview(next: OnboardingPreview) {
  const serverItems = next.documents?.items ?? [];
  if (serverItems.length === 0) return;
  const byId = new Map<
    string,
    { id: string; filename: string; status: string; chunkCount?: number }
  >();
  for (const existing of uploadedBrochures.value) {
    byId.set(existing.id, existing);
  }
  for (const item of serverItems) {
    byId.set(item.id, {
      id: item.id,
      filename: item.filename,
      status: item.status,
      chunkCount: item.chunkCount,
    });
  }
  uploadedBrochures.value = Array.from(byId.values());
}

function applyPreview(next: OnboardingPreview) {
  preview.value = next;
  if (!name.value && next.name) name.value = next.name;
  if (next.website && !website.value) website.value = next.website;
  if (next.summary && !productDescription.value) productDescription.value = next.summary;
  syncDocumentsFromPreview(next);
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

function stopDocPolling() {
  if (docPollTimer) {
    clearInterval(docPollTimer);
    docPollTimer = undefined;
  }
}

async function pollDocumentsOnly() {
  if (view.value !== 'preview' && view.value !== 'manual') {
    stopDocPolling();
    return;
  }
  if (parsingBrochureCount.value === 0) {
    stopDocPolling();
    return;
  }
  try {
    const state = await gainosApi.onboardingPreview();
    if (!state.started) return;
    if (preview.value) {
      preview.value = {
        ...preview.value,
        documents: state.preview.documents,
      };
    } else {
      preview.value = state.preview;
    }
    syncDocumentsFromPreview(state.preview);
  } catch {
    // 后台状态轮询失败不打断当前表单操作
  }
}

function syncDocPolling() {
  const shouldPoll =
    (view.value === 'preview' || view.value === 'manual') && parsingBrochureCount.value > 0;
  if (shouldPoll && !docPollTimer) {
    docPollTimer = setInterval(() => void pollDocumentsOnly(), 5000);
  } else if (!shouldPoll && docPollTimer) {
    stopDocPolling();
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
    syncDocumentsFromPreview(state.preview);
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

function putFileWithProgress(
  url: string,
  file: File,
  onProgress: (loaded: number, total: number, speedBps: number) => void,
): { promise: Promise<void>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const startedAt = Date.now();
  const promise = new Promise<void>((resolve, reject) => {
    xhr.open('PUT', url, true);
    xhr.withCredentials = true;
    xhr.setRequestHeader('content-type', 'application/pdf');
    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable && event.total > 0 ? event.total : file.size;
      const elapsedSec = Math.max(0.25, (Date.now() - startedAt) / 1000);
      onProgress(event.loaded, total, event.loaded / elapsedSec);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(file.size, file.size, 0);
        resolve();
        return;
      }
      let message = `HTTP ${xhr.status}`;
      try {
        const parsed = JSON.parse(xhr.responseText) as {
          error?: { message?: string; userCopy?: { title?: string } };
        };
        message = parsed?.error?.userCopy?.title ?? parsed?.error?.message ?? message;
      } catch {
        // ignore non-json response
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error('network error'));
    xhr.onabort = () => reject(Object.assign(new Error('cancelled'), { cancelled: true }));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

function updateTransfer(localId: string, patch: Partial<BrochureTransfer>) {
  brochureTransfers.value = brochureTransfers.value.map((item) =>
    item.localId === localId ? { ...item, ...patch } : item,
  );
}

function enqueuePendingBrochures(companyId: string) {
  if (pendingBrochures.value.length === 0) return;
  const queued: BrochureTransfer[] = pendingBrochures.value.map((item) => ({
    localId: item.localId,
    file: item.file,
    filename: item.filename,
    size: item.size,
    state: 'queued_upload',
    loadedBytes: 0,
    percent: 0,
    speedBps: 0,
  }));
  brochureTransfers.value = [...brochureTransfers.value, ...queued];
  pendingBrochures.value = [];
  void drainBrochureUploadQueue(companyId);
}

async function drainBrochureUploadQueue(companyId: string) {
  if (uploadQueueRunning) return;
  uploadQueueRunning = true;
  let completedCount = 0;
  try {
    while (true) {
      const next = brochureTransfers.value.find((item) => item.state === 'queued_upload');
      if (!next) break;
      const localId = next.localId;
      updateTransfer(localId, {
        state: 'uploading',
        loadedBytes: 0,
        percent: 0,
        speedBps: 0,
        error: undefined,
      });
      try {
        const signed = await gainosApi.presignSellerDocument(companyId, {
          filename: next.filename,
          mime: 'application/pdf',
          size: next.size,
        });
        const currentAfterPresign = brochureTransfers.value.find((item) => item.localId === localId);
        if (!currentAfterPresign || currentAfterPresign.state === 'cancelled') continue;

        const transfer = putFileWithProgress(
          `/api/companies/${companyId}/seller-documents/${signed.documentId}/content`,
          next.file,
          (loaded, total, speedBps) => {
            const pct = total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : 0;
            updateTransfer(localId, { loadedBytes: loaded, percent: pct, speedBps });
          },
        );
        updateTransfer(localId, { abort: transfer.abort });
        await transfer.promise;

        updateTransfer(localId, { state: 'committing', percent: 100, abort: undefined });
        const committed = await gainosApi.commitSellerDocument(companyId, signed.documentId);
        const docId = committed.id ?? signed.documentId;
        uploadedBrochures.value = [
          {
            id: docId,
            filename: next.filename,
            status: committed.status ?? 'queued',
            chunkCount: 0,
          },
          ...uploadedBrochures.value.filter((doc) => doc.id !== docId),
        ];
        brochureTransfers.value = brochureTransfers.value.filter((item) => item.localId !== localId);
        completedCount += 1;
        syncDocPolling();
      } catch (err) {
        const isCancelled = Boolean((err as { cancelled?: boolean } | null)?.cancelled);
        if (isCancelled) {
          updateTransfer(localId, { state: 'cancelled', abort: undefined });
          continue;
        }
        const body = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data;
        const reason =
          body?.error?.message ?? (err instanceof Error ? err.message : $t('gainos.onboarding.submitFailed'));
        updateTransfer(localId, { state: 'failed', error: reason, abort: undefined });
      }
    }
    if (completedCount > 0) {
      feedback.message.success(
        $t('gainos.onboarding.brochureUploadedCount', { count: completedCount }),
      );
    }
  } finally {
    uploadQueueRunning = false;
  }
}

function cancelBrochureTransfer(localId: string) {
  const target = brochureTransfers.value.find((item) => item.localId === localId);
  if (!target) return;
  if (target.state === 'uploading') {
    target.abort?.();
  }
  updateTransfer(localId, { state: 'cancelled', abort: undefined });
}

function retryBrochureTransfer(localId: string) {
  const companyId = preview.value?.companyId;
  if (!companyId) return;
  updateTransfer(localId, {
    state: 'queued_upload',
    loadedBytes: 0,
    percent: 0,
    speedBps: 0,
    error: undefined,
  });
  void drainBrochureUploadQueue(companyId);
}

function dismissBrochureTransfer(localId: string) {
  brochureTransfers.value = brochureTransfers.value.filter((item) => item.localId !== localId);
}

async function startUnderstanding() {
  normalizeWebsiteField();
  if (!startValid.value || starting.value) return;
  const hasWebsite = website.value.trim().length > 0;
  starting.value = true;
  errorText.value = '';
  manualChosen.value = !hasWebsite;
  if (!hasWebsite) stopPolling();
  const reqSeq = ++previewRequestSeq;
  try {
    const state = await gainosApi.startOnboardingPreview({
      name: name.value.trim(),
      ...(hasWebsite ? { website: normalizeWebsiteUrl(website.value) } : {}),
    });
    if (reqSeq !== previewRequestSeq) return;
    preview.value = state.preview;
    enqueuePendingBrochures(state.preview.companyId);
    applyPreview(state.preview);
    if (!hasWebsite) view.value = 'manual';
  } catch (error) {
    handleError(error);
  } finally {
    starting.value = false;
  }
}

async function startStoreUnderstanding() {
  normalizeStoreUrlField();
  if (!storeStartValid.value || starting.value) return;
  const hasStore = storeUrl.value.trim().length > 0;
  starting.value = true;
  errorText.value = '';
  manualChosen.value = !hasStore;
  if (!hasStore) stopPolling();
  const normalized = hasStore ? normalizeWebsiteUrl(storeUrl.value) : '';
  if (hasStore) website.value = normalized;
  const reqSeq = ++previewRequestSeq;
  try {
    const state = await gainosApi.startOnboardingPreview({
      name: name.value.trim(),
      ...(hasStore ? { website: normalized } : {}),
    });
    if (reqSeq !== previewRequestSeq) return;
    preview.value = state.preview;
    enqueuePendingBrochures(state.preview.companyId);
    applyPreview(state.preview);
    if (!hasStore) view.value = 'manual';
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
      ...(desc ? { productDescription: desc } : {}),
    });
    if (reqSeq !== previewRequestSeq) return;
    preview.value = state.preview;
    enqueuePendingBrochures(state.preview.companyId);
    if (desc && !productsTouched.value && products.value.length === 0) {
      const extracted = desc
        .split(/[、,，;；\n]+/)
        .map((item) => item.trim().slice(0, 60))
        .filter((item) => item.length >= 2);
      if (extracted.length > 0) products.value = extracted.slice(0, 3);
    }
    applyPreview(state.preview);
    view.value = 'manual';
  } catch (error) {
    handleError(error);
  } finally {
    starting.value = false;
  }
}

function triggerBrochurePick() {
  if (totalBrochureCount.value >= MAX_BROCHURES) {
    errorText.value = $t('gainos.onboarding.brochureMaxCount');
    return;
  }
  errorText.value = '';
  brochureInputRef.value?.click();
}

function removePendingBrochure(localId: string) {
  pendingBrochures.value = pendingBrochures.value.filter((item) => item.localId !== localId);
  errorText.value = '';
}

function onBrochureSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (files.length === 0) return;
  errorText.value = '';
  for (const file of files) {
    const isPdf =
      file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      errorText.value = $t('gainos.onboarding.brochureInvalidType');
      continue;
    }
    if (file.size > MAX_BROCHURE_BYTES) {
      errorText.value = $t('gainos.onboarding.brochureTooLarge');
      continue;
    }
    const alreadyPending = pendingBrochures.value.some(
      (item) => item.filename === file.name && item.size === file.size,
    );
    if (alreadyPending) continue;
    if (totalBrochureCount.value >= MAX_BROCHURES) {
      errorText.value = $t('gainos.onboarding.brochureMaxCount');
      break;
    }
    pendingBrochures.value = [
      ...pendingBrochures.value,
      {
        localId: `brochure-${++localBrochureSeq}`,
        file,
        filename: file.name,
        size: file.size,
      },
    ];
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
    // 手动模式不带官网：建名称草稿（不触发理解），若有已选画册则后台并行上传，受控词表随预览响应下发。
    const state = await gainosApi.startOnboardingPreview({ name: name.value.trim() });
    if (reqSeq !== previewRequestSeq) return;
    preview.value = state.preview;
    enqueuePendingBrochures(state.preview.companyId);
    applyPreview(state.preview);
    view.value = 'manual';
  } catch (error) {
    handleError(error);
  } finally {
    starting.value = false;
  }
}

function backToStart() {
  stopPolling();
  stopDocPolling();
  previewRequestSeq += 1;
  manualChosen.value = false;
  errorText.value = '';
  view.value = 'start';
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
    preview.value = state.preview;
    enqueuePendingBrochures(state.preview.companyId);
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

watch([view, parsingBrochureCount], syncDocPolling);

onMounted(loadContext);
onBeforeUnmount(() => {
  stopPolling();
  stopDocPolling();
  for (const item of brochureTransfers.value) {
    item.abort?.();
  }
});
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
        <!-- 第一步：主来源（官网 / 1688·阿里店铺 / 主营产品简介）+ 可选附带 PDF 产品画册 -->
        <section v-if="view === 'start'" class="onboarding-section">
          <label class="field">
            <span class="field-label">{{ $t('gainos.onboarding.companyName') }}</span>
            <Input
              v-model:value="name"
              :maxlength="200"
              :placeholder="$t('gainos.onboarding.companyNamePlaceholder')"
            />
          </label>

          <!-- 主资料来源切换 -->
          <div class="mode-tabs" data-gs="intake-mode-tabs" role="tablist">
            <button
              v-for="mode in (['website', 'store', 'brief'] as const)"
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
          </template>

          <!-- 模式 3：简短主营产品描述冷启动 -->
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
          </template>

          <!-- 常驻可选附件区：PDF 产品画册（可与官网/店铺/简介组合提交，也可不填主来源直接附画册继续） -->
          <div class="brochure-box" data-gs="brochure-intake-box">
            <div class="brochure-box__head">
              <p class="brochure-box__title">{{ $t('gainos.onboarding.brochureTitle') }}</p>
              <Button
                :disabled="starting || totalBrochureCount >= MAX_BROCHURES"
                data-gs="brochure-upload-btn"
                size="small"
                @click="triggerBrochurePick"
              >
                {{ $t('gainos.onboarding.brochurePickBtn') }}
              </Button>
            </div>
            <p class="section-desc">{{ $t('gainos.onboarding.brochureHint') }}</p>
            <input
              ref="brochureInputRef"
              accept=".pdf,application/pdf"
              class="sr-only-input"
              data-gs="brochure-file-input"
              multiple
              type="file"
              @change="onBrochureSelected"
            />
            <div
              v-if="pendingBrochures.length > 0"
              class="brochure-list"
              data-gs="pending-brochure-list"
            >
              <span
                v-for="item in pendingBrochures"
                :key="item.localId"
                class="brochure-chip brochure-chip--pending"
              >
                <span class="brochure-chip__name">{{ item.filename }}</span>
                <span class="brochure-chip__meta">
                  {{ formatBrochureSize(item.size) }} · {{ $t('gainos.onboarding.brochurePendingTag') }}
                </span>
                <button
                  :aria-label="$t('gainos.onboarding.brochureRemoveAria', { name: item.filename })"
                  :disabled="starting"
                  class="brochure-chip__remove"
                  type="button"
                  @click="removePendingBrochure(item.localId)"
                >
                  ×
                </button>
              </span>
            </div>
            <p
              v-if="totalPendingBrochureBytes > LARGE_BROCHURE_HINT_BYTES"
              class="brochure-large-hint"
              data-gs="brochure-large-hint"
            >
              {{
                $t('gainos.onboarding.brochureLargeHint', {
                  size: formatBrochureSize(totalPendingBrochureBytes),
                })
              }}
            </p>
            <div
              v-if="brochureTransfers.length > 0"
              class="brochure-list"
              data-gs="start-brochure-transfers"
            >
              <span
                v-for="item in brochureTransfers"
                :key="item.localId"
                class="brochure-chip"
              >
                <span class="brochure-chip__name">{{ item.filename }}</span>
                <span class="brochure-chip__meta">{{ transferStatusText(item) }}</span>
              </span>
            </div>
            <div
              v-if="uploadedBrochures.length > 0"
              class="brochure-list"
              data-gs="brochure-uploaded-badge"
            >
              <Tag v-for="doc in uploadedBrochures" :key="doc.id" :bordered="false" color="blue">
                {{ doc.filename }} · {{ serverDocStatusText(doc) }}
              </Tag>
            </div>
          </div>

          <p v-if="errorText" class="onboarding-error">{{ errorText }}</p>

          <!-- 主操作按钮区（按当前主来源模式；提交后立即进入下一步，画册在后台继续上传与解析） -->
          <template v-if="intakeMode === 'website'">
            <div class="onboarding-actions">
              <Button
                :disabled="!startValid"
                :loading="starting"
                class="primary-action"
                data-gs="website-start-btn"
                type="primary"
                @click="startUnderstanding"
              >
                {{ websitePrimaryLabel }}
              </Button>
            </div>
            <div v-if="website.trim().length > 0" class="start-hint">
              {{ $t('gainos.onboarding.startHint') }}
            </div>
            <button class="text-link" type="button" @click="enterManual">
              {{ $t('gainos.onboarding.noWebsite') }}
            </button>
          </template>

          <template v-else-if="intakeMode === 'store'">
            <div class="onboarding-actions">
              <Button
                :disabled="!storeStartValid"
                :loading="starting"
                class="primary-action"
                data-gs="store-start-btn"
                type="primary"
                @click="startStoreUnderstanding"
              >
                {{ storePrimaryLabel }}
              </Button>
            </div>
          </template>

          <template v-else>
            <div class="onboarding-actions">
              <Button
                :disabled="!briefStartValid"
                :loading="starting"
                class="primary-action"
                data-gs="brief-start-btn"
                type="primary"
                @click="startBriefOnboarding"
              >
                {{ briefPrimaryLabel }}
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
          <p
            v-if="waitingBrochureTotal > 0"
            class="field-hint hint-accent"
            data-gs="waiting-brochure-hint"
          >
            {{ $t('gainos.onboarding.waitingBrochureLinked', { count: waitingBrochureTotal }) }}
          </p>
          <p class="section-desc">{{ $t('gainos.onboarding.progressHint') }}</p>

          <div
            v-if="hasBrochurePanel"
            class="brochure-panel"
            data-gs="brochure-progress-panel"
          >
            <div class="brochure-panel__head">
              <span class="brochure-panel__title">{{ $t('gainos.onboarding.brochurePanelTitle') }}</span>
              <span class="brochure-panel__summary">
                <span v-if="activeBrochureTransfers.length > 0" class="brochure-pill brochure-pill--active">
                  {{ $t('gainos.onboarding.brochurePanelUploading', { count: activeBrochureTransfers.length }) }}
                </span>
                <span v-if="parsingBrochureCount > 0" class="brochure-pill brochure-pill--parsing">
                  {{ $t('gainos.onboarding.brochurePanelParsing', { count: parsingBrochureCount }) }}
                </span>
                <span v-if="readyBrochureCount > 0" class="brochure-pill brochure-pill--ready">
                  {{ $t('gainos.onboarding.brochurePanelReady', { count: readyBrochureCount }) }}
                </span>
              </span>
            </div>

            <div v-if="brochureTransfers.length > 0" class="brochure-rows">
              <div
                v-for="item in brochureTransfers"
                :key="item.localId"
                class="brochure-row"
                :class="`brochure-row--${item.state}`"
                data-gs="brochure-transfer-row"
              >
                <div class="brochure-row__top">
                  <span class="brochure-row__name" :title="item.filename">{{ item.filename }}</span>
                  <span class="brochure-row__actions">
                    <button
                      v-if="item.state === 'queued_upload' || item.state === 'uploading'"
                      class="brochure-row__btn"
                      data-gs="brochure-cancel-btn"
                      type="button"
                      @click="cancelBrochureTransfer(item.localId)"
                    >
                      {{ $t('gainos.onboarding.brochureCancelBtn') }}
                    </button>
                    <button
                      v-if="item.state === 'failed' || item.state === 'cancelled'"
                      class="brochure-row__btn brochure-row__btn--primary"
                      data-gs="brochure-retry-btn"
                      type="button"
                      @click="retryBrochureTransfer(item.localId)"
                    >
                      {{ $t('gainos.onboarding.brochureRetryBtn') }}
                    </button>
                    <button
                      v-if="item.state === 'failed' || item.state === 'cancelled'"
                      class="brochure-row__btn"
                      type="button"
                      @click="dismissBrochureTransfer(item.localId)"
                    >
                      {{ $t('gainos.onboarding.brochureDismissBtn') }}
                    </button>
                  </span>
                </div>
                <div
                  v-if="item.state === 'queued_upload' || item.state === 'uploading' || item.state === 'committing'"
                  class="brochure-progress"
                  role="progressbar"
                  :aria-valuenow="item.percent"
                  aria-valuemin="0"
                  aria-valuemax="100"
                >
                  <div class="brochure-progress__bar" :style="{ width: `${item.percent}%` }"></div>
                </div>
                <span class="brochure-row__status">{{ transferStatusText(item) }}</span>
              </div>
            </div>

            <div v-if="uploadedBrochures.length > 0" class="brochure-docs">
              <div
                v-for="doc in uploadedBrochures"
                :key="doc.id"
                class="brochure-doc"
                data-gs="brochure-server-doc"
              >
                <span class="brochure-row__name" :title="doc.filename">{{ doc.filename }}</span>
                <span
                  class="brochure-doc__status"
                  :class="{
                    'brochure-doc__status--ready': doc.status === 'ready',
                    'brochure-doc__status--failed': doc.status === 'failed_terminal' || doc.status === 'rejected',
                  }"
                >
                  {{ serverDocStatusText(doc) }}
                </span>
              </div>
            </div>
          </div>
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

          <div
            v-if="brochureUploading"
            class="brochure-warn"
            data-gs="brochure-active-upload-warn"
          >
            {{ $t('gainos.onboarding.brochureActiveUploadWarn', { count: activeBrochureTransfers.length }) }}
          </div>

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

        <!-- 第二步：预览确认 / 手动填写（集成 UN Comtrade 推荐国徽章 + 画册实时上传/解析面板） -->
        <section v-else class="onboarding-section">
          <p v-if="view === 'preview'" class="preview-banner">
            {{ $t('gainos.onboarding.previewTitle') }}
          </p>

          <div
            v-if="hasBrochurePanel"
            class="brochure-panel"
            data-gs="brochure-progress-panel"
          >
            <div class="brochure-panel__head">
              <span class="brochure-panel__title">{{ $t('gainos.onboarding.brochurePanelTitle') }}</span>
              <span class="brochure-panel__summary">
                <span v-if="activeBrochureTransfers.length > 0" class="brochure-pill brochure-pill--active">
                  {{ $t('gainos.onboarding.brochurePanelUploading', { count: activeBrochureTransfers.length }) }}
                </span>
                <span v-if="parsingBrochureCount > 0" class="brochure-pill brochure-pill--parsing">
                  {{ $t('gainos.onboarding.brochurePanelParsing', { count: parsingBrochureCount }) }}
                </span>
                <span v-if="readyBrochureCount > 0" class="brochure-pill brochure-pill--ready">
                  {{ $t('gainos.onboarding.brochurePanelReady', { count: readyBrochureCount }) }}
                </span>
              </span>
            </div>

            <div v-if="brochureTransfers.length > 0" class="brochure-rows">
              <div
                v-for="item in brochureTransfers"
                :key="item.localId"
                class="brochure-row"
                :class="`brochure-row--${item.state}`"
                data-gs="brochure-transfer-row"
              >
                <div class="brochure-row__top">
                  <span class="brochure-row__name" :title="item.filename">{{ item.filename }}</span>
                  <span class="brochure-row__actions">
                    <button
                      v-if="item.state === 'queued_upload' || item.state === 'uploading'"
                      class="brochure-row__btn"
                      data-gs="brochure-cancel-btn"
                      type="button"
                      @click="cancelBrochureTransfer(item.localId)"
                    >
                      {{ $t('gainos.onboarding.brochureCancelBtn') }}
                    </button>
                    <button
                      v-if="item.state === 'failed' || item.state === 'cancelled'"
                      class="brochure-row__btn brochure-row__btn--primary"
                      data-gs="brochure-retry-btn"
                      type="button"
                      @click="retryBrochureTransfer(item.localId)"
                    >
                      {{ $t('gainos.onboarding.brochureRetryBtn') }}
                    </button>
                    <button
                      v-if="item.state === 'failed' || item.state === 'cancelled'"
                      class="brochure-row__btn"
                      type="button"
                      @click="dismissBrochureTransfer(item.localId)"
                    >
                      {{ $t('gainos.onboarding.brochureDismissBtn') }}
                    </button>
                  </span>
                </div>
                <div
                  v-if="item.state === 'queued_upload' || item.state === 'uploading' || item.state === 'committing'"
                  class="brochure-progress"
                  role="progressbar"
                  :aria-valuenow="item.percent"
                  aria-valuemin="0"
                  aria-valuemax="100"
                >
                  <div class="brochure-progress__bar" :style="{ width: `${item.percent}%` }"></div>
                </div>
                <span class="brochure-row__status">{{ transferStatusText(item) }}</span>
              </div>
            </div>

            <div
              v-if="uploadedBrochures.length > 0"
              class="brochure-docs"
              data-gs="step2-brochure-badges"
            >
              <div
                v-for="doc in uploadedBrochures"
                :key="doc.id"
                class="brochure-doc"
                data-gs="brochure-server-doc"
              >
                <span class="brochure-row__name" :title="doc.filename">{{ doc.filename }}</span>
                <span
                  class="brochure-doc__status"
                  :class="{
                    'brochure-doc__status--ready': doc.status === 'ready',
                    'brochure-doc__status--failed': doc.status === 'failed_terminal' || doc.status === 'rejected',
                  }"
                >
                  {{ serverDocStatusText(doc) }}
                </span>
              </div>
            </div>

            <div
              v-if="extractedDocClaims.length > 0"
              class="brochure-claims"
              data-gs="brochure-extracted-claims"
            >
              <p class="brochure-claims__title">
                {{ $t('gainos.onboarding.brochureClaimsTitle', { count: extractedDocClaims.length }) }}
              </p>
              <ul class="brochure-claims__list">
                <li
                  v-for="claim in extractedDocClaims.slice(0, 8)"
                  :key="claim.claimId"
                  class="brochure-claim"
                >
                  <Tag :bordered="false" class="brochure-claim__type">{{ claimTypeLabel(claim.type) }}</Tag>
                  <span class="brochure-claim__text">{{ claim.statement }}</span>
                  <span v-if="claim.filename" class="brochure-claim__src" :title="claim.filename">
                    {{ claim.filename }}
                  </span>
                </li>
              </ul>
            </div>
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

          <div
            v-if="brochureUploading"
            class="brochure-warn"
            data-gs="brochure-active-upload-warn"
          >
            {{ $t('gainos.onboarding.brochureActiveUploadWarn', { count: activeBrochureTransfers.length }) }}
          </div>

          <div class="onboarding-actions">
            <Button
              :disabled="submitting"
              data-gs="back-to-start-btn"
              @click="backToStart"
            >
              {{ $t('gainos.onboarding.backToStart') }}
            </Button>
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
  align-items: flex-start;
  justify-content: center;
  min-height: 100vh;
  padding: 32px 24px;
  background: var(--gs-bg-soft, #f5f6f7);
}

.onboarding-card {
  width: 640px;
  max-width: 100%;
  margin: auto 0;
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
  padding: 14px 16px;
  border: 1px dashed var(--gs-border, #d1d5db);
  border-radius: 10px;
  background: var(--gs-bg-soft, #f9fafb);
}

.brochure-box__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
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

.brochure-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 4px 8px 4px 10px;
  border: 1px solid var(--gs-border, #d1d5db);
  border-radius: 999px;
  background: var(--gs-bg, #fff);
  color: var(--gs-fg, #111827);
  font-size: 12px;
}

.brochure-chip--pending {
  border-color: color-mix(in srgb, var(--gs-primary, var(--gs-accent)) 45%, var(--gs-border, #d1d5db));
}

.brochure-chip__name {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.brochure-chip__meta {
  color: var(--gs-fg-subtle, var(--gs-fg-muted));
  font-size: 11px;
  white-space: nowrap;
}

.brochure-chip__remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--gs-fg-subtle, var(--gs-fg-muted));
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.brochure-chip__remove:hover {
  background: var(--gs-bg-soft, #f3f4f6);
  color: var(--gs-fg, #111827);
}

.sr-only-input {
  display: none;
}

.brochure-large-hint {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--gs-warn, #d97706) 35%, var(--gs-border, #e5e7eb));
  border-radius: 8px;
  background: color-mix(in srgb, var(--gs-warn, #d97706) 8%, var(--gs-surface, #fff));
  color: var(--gs-fg, #111827);
  font-size: 12px;
  line-height: 1.5;
}

.brochure-panel {
  width: 100%;
  display: grid;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--gs-border, #e5e7eb);
  border-radius: 10px;
  background: var(--gs-bg-soft, #f9fafb);
  text-align: left;
}

.brochure-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.brochure-panel__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--gs-fg, #111827);
}

.brochure-panel__summary {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.brochure-pill {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 500;
}

.brochure-pill--active,
.brochure-pill--parsing {
  color: var(--gs-primary, var(--gs-accent));
  background: color-mix(in srgb, var(--gs-primary, var(--gs-accent)) 12%, var(--gs-surface, #fff));
}

.brochure-pill--ready {
  color: var(--gs-success, #15803d);
  background: color-mix(in srgb, var(--gs-success, #15803d) 12%, var(--gs-surface, #fff));
}

.brochure-rows,
.brochure-docs {
  display: grid;
  gap: 8px;
}

.brochure-row,
.brochure-doc {
  display: grid;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--gs-border, #e5e7eb);
  border-radius: 8px;
  background: var(--gs-bg, #fff);
}

.brochure-doc {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.brochure-row__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.brochure-row__name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--gs-fg, #111827);
}

.brochure-row__actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.brochure-row__btn {
  padding: 2px 8px;
  border: 1px solid var(--gs-border, #d1d5db);
  border-radius: 6px;
  background: transparent;
  color: var(--gs-fg-subtle, var(--gs-fg-muted));
  font-size: 11.5px;
  cursor: pointer;
}

.brochure-row__btn:hover {
  color: var(--gs-fg, #111827);
  border-color: var(--gs-fg-subtle, #9ca3af);
}

.brochure-row__btn--primary {
  border-color: var(--gs-primary, var(--gs-accent));
  color: var(--gs-primary, var(--gs-accent));
}

.brochure-progress {
  height: 6px;
  width: 100%;
  overflow: hidden;
  border-radius: 999px;
  background: var(--gs-bg-soft, #e5e7eb);
}

.brochure-progress__bar {
  height: 100%;
  border-radius: 999px;
  background: var(--gs-primary, var(--gs-accent));
  transition: width 0.2s ease;
}

.brochure-row__status,
.brochure-doc__status {
  font-size: 11.5px;
  color: var(--gs-fg-subtle, var(--gs-fg-muted));
}

.brochure-row--failed .brochure-row__status,
.brochure-doc__status--failed {
  color: var(--gs-danger, #dc2626);
}

.brochure-doc__status--ready {
  color: var(--gs-success, #15803d);
  font-weight: 500;
}

.brochure-claims {
  display: grid;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px dashed var(--gs-border, #e5e7eb);
}

.brochure-claims__title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--gs-fg, #111827);
}

.brochure-claims__list {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.brochure-claim {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--gs-fg, #111827);
}

.brochure-claim__type {
  flex-shrink: 0;
  margin-inline-end: 0;
}

.brochure-claim__text {
  flex: 1;
  min-width: 0;
}

.brochure-claim__src {
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--gs-fg-subtle, var(--gs-fg-muted));
}

.brochure-warn {
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--gs-warn, #d97706) 40%, var(--gs-border, #e5e7eb));
  border-radius: 8px;
  background: color-mix(in srgb, var(--gs-warn, #d97706) 10%, var(--gs-surface, #fff));
  color: var(--gs-fg, #111827);
  font-size: 12px;
  line-height: 1.5;
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
