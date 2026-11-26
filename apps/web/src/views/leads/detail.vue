<script lang="ts" setup>
/**
 * 线索档案包整页（v3.0 ch07 P5b-08）：/leads/:leadId?tab=package|people|draft|outcomes
 * 四个 tab 各自可分享；顶部固定操作条（接受/拒绝/提升商机/去触达）。
 * 数据以引擎 LeadPackage 为准（package 一次拉取），不复制列表页的抽屉状态。
 *
 * 2026-11-23：档案页改为「判断结果」优先——把引擎的五维聚合文本解析成
 * 业务维度（雷达图 + 逐维理由），机器结论码收进折叠的技术详情。
 */
import type {
  ContactEnrichmentResultView,
  LeadDecisionInput,
  LeadPackage,
  PromoteQgoInput,
  QgoView,
  T0TouchRecord,
} from '#/api/gainos';
import type { JudgeSummary, ScoreGrade } from './judge';

import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import {
  Alert,
  Button,
  Descriptions,
  DescriptionsItem,
  Input,
  Modal,
  Space,
  TabPane,
  Tabs,
  Tag,
} from 'ant-design-vue';

import { $t } from '#/locales';

import {
  evaluateT0Channels,
  formatDate,
  formatDateTime,
  mapRejectCodeToFeedbackReason,
} from '@gain-saas/shared';

import ErrorNotice from '#/components/error-notice.vue';
import AsyncSection from '#/components/gainos/async-section.vue';
import GsCard from '#/components/gainos/ui/gs-card.vue';
import GsPage from '#/components/gainos/ui/gs-page.vue';
import GsRadar from '#/components/gainos/ui/gs-radar.vue';
import GsSelect from '#/components/gainos/ui/gs-select.vue';
import GsTag from '#/components/gainos/ui/gs-tag.vue';

import { failureText, gainosApi } from '#/api/gainos';
import { usePendingAction } from '#/composables/use-pending-action';
import { useWorkspaceAccess } from '#/composables/use-workspace-access';
import { feedback } from '#/feedback';
import { GROWTH_PAGE_HIDDEN } from '#/feature-flags';

import DecisionMakerCard from './DecisionMakerCard.vue';
import JudgeDimensions from './judge-dimensions.vue';
import T0OutreachPanel from './T0OutreachPanel.vue';
import {
  isMachineAggregate,
  judgeCounts,
  keyDimension,
  normalizeFitVerdict,
  parseJudge,
  scoreGrade,
  shortRationale,
} from './judge';
import { dimName, humanizeRationale, verdictLabel, verdictTone } from './judge-labels';

defineOptions({ name: 'LeadDetail' });

const TAB_KEYS = ['package', 'people', 'draft', 'outcomes'] as const;
type TabKey = (typeof TAB_KEYS)[number];

const REJECT_CODES = [
  'NOT_TARGET_ROLE',
  'WRONG_PRODUCT',
  'TOO_SMALL',
  'WRONG_COUNTRY',
  'DEAD_COMPANY',
  'BAD_CONTACT_PATH',
  'TOO_LARGE',
  'ALREADY_KNOWN',
  'NO_IMPORT_SIGNAL',
  'DUPLICATE',
  'OTHER',
] as const;
const ACCEPT_CODES = ['GOOD_FIT', 'WILL_FOLLOW_UP', 'OTHER'] as const;

const route = useRoute();
const router = useRouter();
const { isAdmin, loaded: accessLoaded, ensureLoaded } = useWorkspaceAccess();

const leadId = computed(() => String(route.params.leadId ?? ''));
const tab = ref<TabKey>(readTab());

function readTab(): TabKey {
  const raw = route.query.tab;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (TAB_KEYS as readonly string[]).includes(String(value)) ? (value as TabKey) : 'package';
}

watch(
  () => route.query.tab,
  () => (tab.value = readTab()),
);

function selectTab(next: number | string): void {
  const key = (TAB_KEYS as readonly string[]).includes(String(next))
    ? (next as TabKey)
    : 'package';
  tab.value = key;
  void router.replace({ query: { ...route.query, tab: key } });
}

const pkg = ref<LeadPackage | null>(null);
const loading = ref(true);
const error = ref<{ next?: string; title: string } | null>(null);

const draft = ref<Record<string, unknown> | null>(null);
const draftLoading = ref(false);
const draftError = ref<{ next?: string; title: string } | null>(null);
const copied = ref(false);

const decision = ref<'accept' | 'reject' | null>(null);
const reasonCode = ref('');
const reasonNote = ref('');
const actionError = ref<{ next?: string; title: string } | null>(null);
const { pending: submitting, run: runDecision } = usePendingAction();

const promoteOpen = ref(false);
const promoteEvidence = ref<Array<{ support: string; type: string; url: string }>>([
  { type: 'customer_reply', url: '', support: '' },
]);
const promoteNextStep = ref('');
const promoteBusy = ref(false);
const promoteError = ref<{ next?: string; title: string } | null>(null);

const sanctionsBusy = ref(false);
const sanctionsError = ref<{ next?: string; title: string } | null>(null);

const status = computed(() => pkg.value?.status ?? '');
const canDecide = computed(
  () => status.value === 'DISCOVERED' || status.value === 'REVIEW',
);
const sanctionBlocked = computed(() => {
  const value = pkg.value?.sanctions?.status;
  return value === 'potential_match' || value === 'confirmed_true_hit';
});

function statusLabel(status?: string): string {
  if (!status) return $t('gainos.leads.status.DISCOVERED');
  const key = `gainos.leads.status.${status}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? status : translated;
}

const statusTone = computed<'danger' | 'neutral' | 'success' | 'warning'>(() => {
  if (status.value === 'QUALIFIED') return 'success';
  if (status.value === 'REJECTED') return 'danger';
  if (status.value === 'SUPPRESSED') return 'warning';
  return 'neutral';
});

// ── 判断结果：五维聚合解析 ────────────────────────────────────────────────
const judge = computed<JudgeSummary>(() =>
  parseJudge(pkg.value?.fit?.reasons ?? []),
);
const dims = computed(() => judge.value.dims);

const counts = computed(() => judgeCounts(dims.value));
const summaryText = computed(() => {
  const parts = [
    counts.value.pass ? $t('gainos.leads.criteriaPass', { count: counts.value.pass }) : '',
    counts.value.weak ? $t('gainos.leads.criteriaWeak', { count: counts.value.weak }) : '',
    counts.value.fail ? $t('gainos.leads.criteriaFail', { count: counts.value.fail }) : '',
    counts.value.unclear
      ? $t('gainos.leads.criteriaUnclear', { count: counts.value.unclear })
      : '',
  ].filter(Boolean);
  return parts.join(' · ');
});

const keyReason = computed(() => {
  const dim = keyDimension(dims.value);
  if (dim) {
    const text = shortRationale(humanizeRationale(dim.rationale), 180);
    return text ? `${dimName(dim.id)}：${text}` : dimName(dim.id);
  }
  const human = (pkg.value?.fit?.reasons ?? []).filter(
    (reason) => !isMachineAggregate(reason),
  );
  if (human.length > 0) return human.join(' · ');
  return verdictLabel(pkg.value?.fit?.verdict);
});

/** 没有五维明细时，把引擎给的人话理由原样列出（机器聚合串会被过滤掉）。 */
const fitReasonList = computed(() =>
  (pkg.value?.fit?.reasons ?? []).filter((reason) => !isMachineAggregate(reason)),
);

/** 引擎结论可能是 FIT / NOT_FIT / UNKNOWN，也可能缺省；未知时才提示人工判断。 */
const rawVerdict = computed(() => pkg.value?.fit?.verdict ?? judge.value.verdict);
const fitLabel = computed(() => verdictLabel(rawVerdict.value));
const unknownNote = computed(() =>
  dims.value.length > 0 && normalizeFitVerdict(rawVerdict.value) === 'unknown'
    ? $t('gainos.leads.verdictUnknownNote')
    : '',
);

const radarDims = computed(() =>
  dims.value.map((dim) => ({
    id: dim.id,
    label: dim.label,
    name: dimName(dim.id),
    score: dim.score,
  })),
);

/** 总分：引擎 scores.total 是 0–1，列表 total_score 是 0–100，两种都兼容。 */
const totalScore = computed<null | number>(() => {
  const total = pkg.value?.scores?.total;
  if (typeof total !== 'number' || !Number.isFinite(total)) return null;
  const percent = total <= 1 ? total * 100 : total;
  return Math.round(percent);
});
const grade = computed<ScoreGrade>(() => scoreGrade(totalScore.value));
const gradeLabel = computed(() => $t(`gainos.leads.scoreGrade.${grade.value}`));

const reasonOptions = computed(() =>
  (decision.value === 'accept' ? ACCEPT_CODES : REJECT_CODES).map((code) => ({
    code,
    label: $t(`gainos.leads.reason.${code}`),
  })),
);

const decisionOpen = computed({
  get: () => decision.value !== null,
  set: (value: boolean) => {
    if (!value) decision.value = null;
  },
});

const profileRows = computed<Array<{ label: string; value: string }>>(() => {
  const profile = pkg.value?.company_profile;
  if (!profile || typeof profile !== 'object') return [];
  const record = profile as Record<string, unknown>;
  const rows: Array<{ label: string; value: string }> = [];
  const push = (label: string, value: unknown): void => {
    if (typeof value === 'string' && value.trim()) rows.push({ label, value: value.trim() });
  };
  const role = typeof record.trade_role === 'string' && record.trade_role.trim()
    ? record.trade_role.trim() : '';
  const confidence = typeof record.trade_role_confidence === 'number' && Number.isFinite(record.trade_role_confidence)
    ? $t('gainos.leads.profileConfidence', { percent: Math.round(record.trade_role_confidence * 100) })
    : '';
  push($t('gainos.leads.profileTradeRole'), role ? (confidence ? `${role} · ${confidence}` : role) : undefined);
  // carried_brands 是 {name, country} 对象数组：逐个取 name（country 一并展示）
  const brands = Array.isArray(record.carried_brands) ? record.carried_brands : [];
  const brandNames = brands
    .map((brand) => {
      if (!brand || typeof brand !== 'object') return '';
      const entry = brand as Record<string, unknown>;
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      const country = typeof entry.country === 'string' && entry.country.trim() ? entry.country.trim() : '';
      return name ? (country ? `${name}（${country}）` : name) : '';
    })
    .filter(Boolean);
  if (brandNames.length > 0) {
    rows.push({ label: $t('gainos.leads.profileCarriedBrands'), value: brandNames.join(' · ') });
  }
  if (record.own_manufacturing === true) rows.push({ label: $t('gainos.leads.profileOwnManufacturing'), value: $t('gainos.leads.yes') });
  if (record.carries_chinese_brand === true) rows.push({ label: $t('gainos.leads.profileChineseBrand'), value: $t('gainos.leads.yes') });
  if (record.carries_foreign_brand === true) rows.push({ label: $t('gainos.leads.profileForeignBrand'), value: $t('gainos.leads.yes') });
  return rows;
});

/** 引擎合同只回这四个标识键：翻译成业务语言，不把蛇形命名直接上屏。 */
const IDENTIFIER_LABELS: Record<string, () => string> = {
  register_key: () => $t('gainos.leads.identifierRegister'),
  vat_id: () => $t('gainos.leads.identifierVat'),
  lei: () => $t('gainos.leads.identifierLei'),
  fda_reg: () => $t('gainos.leads.identifierFda'),
};

const identifierRows = computed<Array<{ label: string; value: string }>>(() => {
  const identifiers = pkg.value?.identifiers;
  if (!identifiers || typeof identifiers !== 'object') return [];
  return Object.entries(identifiers)
    .filter(([key, value]) => Boolean(IDENTIFIER_LABELS[key]) && typeof value === 'string' && value)
    .map(([key, value]) => ({ label: IDENTIFIER_LABELS[key]!(), value: String(value) }));
});

/** 引擎 evidence 形状是 {field, source_url, fetched_at}（不是提升商机的 {type,url,support}）。 */
const evidenceItems = computed(() => {
  const seen = new Set<string>();
  const rows: Array<{ field: string; url: string; fetchedAt: string }> = [];
  for (const item of pkg.value?.evidence ?? []) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const field = typeof record.field === 'string' ? record.field.trim() : '';
    const url = typeof record.source_url === 'string' ? record.source_url : '';
    const fetchedAt = typeof record.fetched_at === 'string' ? record.fetched_at : '';
    const key = `${field}|${url}`;
    if (!field || seen.has(key)) continue;
    seen.add(key);
    rows.push({ field, url, fetchedAt });
  }
  return rows;
});

/** 八维评分（引擎 snake_case，0–1）：作为五维之外的补充明细保留。 */
const SCORE_DIMS = ['fit', 'role', 'intent', 'demand_proof', 'reachability', 'data_quality', 'engagement'] as const;

const scoreRows = computed(() => {
  const scores = pkg.value?.scores;
  if (!scores || typeof scores !== 'object') return [];
  const record = scores as Record<string, unknown>;
  return SCORE_DIMS
    .map((dim) => ({ dim, value: record[dim] }))
    .filter((row): row is { dim: (typeof SCORE_DIMS)[number]; value: number } =>
      typeof row.value === 'number' && Number.isFinite(row.value));
});

function safeHttpUrl(value?: null | string): string {
  return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : '';
}

function socialPlatformLabel(platform: string): string {
  const key = `gainos.leads.socialPlatform.${platform.toLowerCase()}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? platform : translated;
}

const companyEmails = computed(() =>
  (pkg.value?.company_channels ?? []).filter((item) => item.channel === 'email' && item.value),
);
const companyPhones = computed(() =>
  (pkg.value?.company_channels ?? []).filter((item) => item.channel === 'phone' && item.value),
);
const companySocials = computed(() =>
  (pkg.value?.social_profiles ?? [])
    .map((item) => ({
      platform: item.platform,
      label: socialPlatformLabel(item.platform),
      url: safeHttpUrl(item.url),
    }))
    .filter((item) => Boolean(item.url)),
);
const contactPaths = computed(() => {
  const seen = new Set<string>();
  const out: Array<{ status?: string; url: string }> = [];
  for (const ch of pkg.value?.company_channels ?? []) {
    if (ch.channel !== 'form_url') continue;
    const url = safeHttpUrl(ch.value);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url });
  }
  for (const point of pkg.value?.contact_points ?? []) {
    const url = safeHttpUrl(point.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, status: point.status });
  }
  return out;
});
const hasAnyContactPath = computed(
  () =>
    companyEmails.value.length > 0 ||
    companyPhones.value.length > 0 ||
    companySocials.value.length > 0 ||
    contactPaths.value.length > 0,
);
const contactEmailMailtoAllowed = computed(() => {
  if (!pkg.value) return false;
  return evaluateT0Channels({
    countryCode: pkg.value.company.country,
    companyName: pkg.value.company.name,
    email: companyEmails.value[0]?.value,
    suppressed: status.value === 'SUPPRESSED',
    sanctionsHold: sanctionBlocked.value,
  }).channels.mailto.allowed;
});

function sanctionLabel(value?: null | string): string {
  // 引擎状态未回填时按「未筛查」呈现；文案节是单数 sanction（勿写成 sanctions）。
  if (!value) return $t('gainos.leads.sanction.not_screened');
  const key = `gainos.leads.sanction.${value}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? value : translated;
}

const decisionTitle = computed(() =>
  decision.value === 'accept' ? $t('gainos.leads.acceptTitle') : $t('gainos.leads.rejectTitle'),
);
const decisionDesc = computed(() =>
  decision.value === 'accept' ? $t('gainos.leads.acceptDesc') : $t('gainos.leads.rejectDesc'),
);
const decisionOkText = computed(() =>
  decision.value === 'accept' ? $t('gainos.leads.confirmAccept') : $t('gainos.leads.confirmReject'),
);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    pkg.value = await gainosApi.leadPackage(leadId.value);
    draftError.value = null;
    draft.value = null;
    void loadDraft();
  } catch (err) {
    error.value = failureText(err);
    pkg.value = null;
  } finally {
    loading.value = false;
  }
}

async function loadDraft(): Promise<void> {
  if (!pkg.value) return;
  draftLoading.value = true;
  draftError.value = null;
  try {
    const existing = await gainosApi.outreachDrafts(leadId.value).catch(() => null);
    if (existing && typeof existing === 'object') {
      draft.value = existing as Record<string, unknown>;
    }
  } catch (err) {
    draftError.value = failureText(err);
  } finally {
    draftLoading.value = false;
  }
}

/** 生成草稿是一次付费模型调用：只在用户点击时发生。 */
async function generateDraft(): Promise<void> {
  if (!pkg.value || draftLoading.value) return;
  draftLoading.value = true;
  draftError.value = null;
  try {
    draft.value = await gainosApi.outreachDraft(leadId.value);
  } catch (err) {
    draftError.value = failureText(err);
  } finally {
    draftLoading.value = false;
  }
}

const draftText = computed(() => {
  const record = draft.value;
  if (!record) return '';
  const parts = [record.subject, record.body, record.bodyZh, record.translation, record.body_zh, record.text]
    .filter((part) => typeof part === 'string' && part.trim());
  return [...new Set(parts as string[])].join('\n\n');
});

async function copyDraft(): Promise<void> {
  try {
    await navigator.clipboard.writeText(draftText.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    /* 剪贴板权限被拒时保持原样，用户可手动选择文本 */
  }
}

function openDecision(kind: 'accept' | 'reject'): void {
  decision.value = kind;
  reasonCode.value = '';
  reasonNote.value = '';
  actionError.value = null;
}

async function resolveTargetIcpId(): Promise<string> {
  const pkgRaw = pkg.value as (LeadPackage & { icpId?: string; icp_id?: string }) | null;
  const fromPkg = pkgRaw?.icp_id || pkgRaw?.icpId || '';
  if (fromPkg) return fromPkg;
  const rawState =
    typeof window !== 'undefined'
      ? (window.history.state as { icpId?: unknown } | null)?.icpId
      : undefined;
  if (typeof rawState === 'string' && rawState.trim()) return rawState.trim();
  const rawRoute = Array.isArray(route.query.icp) ? route.query.icp[0] : route.query.icp;
  if (typeof rawRoute === 'string' && rawRoute.trim()) return rawRoute.trim();
  try {
    const icps = await gainosApi.icps();
    const list = Array.isArray(icps) ? icps : [];
    return list.find((item) => item.status === 'ACTIVE')?.id ?? list[0]?.id ?? '';
  } catch {
    return '';
  }
}

async function submitDecision(): Promise<void> {
  if (!decision.value) return;
  if (decision.value === 'reject' && !reasonCode.value) return;
  actionError.value = null;
  const selectedReasonCode = reasonCode.value;
  const noteTrimmed = reasonNote.value.trim();
  const input: LeadDecisionInput = {
    ...(selectedReasonCode ? { reasonCode: selectedReasonCode } : {}),
    ...(noteTrimmed ? { reason: noteTrimmed } : {}),
  };
  const kind = decision.value;
  try {
    // 幂等键由 usePendingAction 管理：双击/重试沿用同键，服务端按幂等重放而非重复执行。
    await runDecision(async (idempotencyKey) => {
      if (kind === 'accept') {
        await gainosApi.acceptLead(leadId.value, input, idempotencyKey);
        feedback.message.success($t('gainos.leads.acceptedNotice'));
      } else {
        await gainosApi.rejectLead(leadId.value, input, idempotencyKey);
        const targetIcpId = await resolveTargetIcpId();
        let synced = false;
        if (targetIcpId && pkg.value) {
          const mappedReason = mapRejectCodeToFeedbackReason(selectedReasonCode);
          await gainosApi
            .recordIcpFeedback(targetIcpId, {
              leadId: leadId.value,
              companyId: pkg.value.company?.canonical_company_id,
              domain: pkg.value.company?.domain ?? undefined,
              companyName: pkg.value.company?.name ?? undefined,
              outcome: 'rejected',
              ...(mappedReason ? { rejectionReason: mappedReason } : {}),
              ...(noteTrimmed ? { note: noteTrimmed } : {}),
            })
            .then(() => {
              synced = true;
            })
            .catch(() => undefined);
        }
        feedback.message.success(
          synced ? $t('gainos.leads.feedbackSyncedNotice') : $t('gainos.leads.rejectedNotice'),
        );
      }
    });
    decision.value = null;
    await load();
  } catch (err) {
    actionError.value = failureText(err);
  }
}

function addEvidenceRow(): void {
  if (promoteEvidence.value.length < 10) {
    promoteEvidence.value.push({ type: 'other', url: '', support: '' });
  }
}

function removeEvidenceRow(index: number): void {
  if (promoteEvidence.value.length > 1) promoteEvidence.value.splice(index, 1);
}

async function submitPromote(): Promise<void> {
  if (promoteBusy.value || !promoteNextStep.value.trim()) return;
  promoteBusy.value = true;
  promoteError.value = null;
  const evidence = promoteEvidence.value
    .filter((row) => row.type.trim())
    .map((row) => ({
      type: row.type.trim(),
      ...(row.url.trim() ? { url: row.url.trim() } : {}),
      ...(row.support.trim() ? { support: row.support.trim() } : {}),
    }));
  const input: PromoteQgoInput = {
    leadRef: leadId.value,
    evidence,
    nextStep: promoteNextStep.value.trim(),
  };
  try {
    await gainosApi.promoteQgo(input);
    promoteOpen.value = false;
    feedback.message.success($t('gainos.leads.promoteDone'));
    void router.push('/opportunities');
  } catch (err) {
    promoteError.value = failureText(err);
  } finally {
    promoteBusy.value = false;
  }
}

async function reviewSanctions(kind: 'cleared_false_positive' | 'confirmed_true_hit'): Promise<void> {
  if (sanctionsBusy.value) return;
  sanctionsBusy.value = true;
  sanctionsError.value = null;
  try {
    await gainosApi.sanctionsReview(leadId.value, kind);
    await load();
  } catch (err) {
    sanctionsError.value = failureText(err);
  } finally {
    sanctionsBusy.value = false;
  }
}

function goOutreach(): void {
  void router.push({ path: '/outreach', query: { tab: 'batches', lead: leadId.value } });
}

// ── ?tab=outcomes 真实聚合时间线（研判 + 制裁 + 联系人补强[管理员] + T0 轻触达 + QGO/SAO/Outcome）──
type TimelineTone = 'danger' | 'info' | 'neutral' | 'success' | 'warning';
interface OutcomeTimelineItem {
  id: string;
  at: string;
  typeLabel: string;
  tone: TimelineTone;
  title: string;
  detail?: string;
}

const outcomesLoading = ref(false);
const outcomesLoaded = ref(false);
const outcomesPartialError = ref(false);
const outcomeTouches = ref<T0TouchRecord[]>([]);
const outcomeEnrichments = ref<ContactEnrichmentResultView[]>([]);
const outcomeQgos = ref<QgoView[]>([]);

function onTouchesUpdated(rows: T0TouchRecord[]): void {
  outcomeTouches.value = Array.isArray(rows) ? rows : [];
}

function enrichmentTimelineStatus(status?: string): string {
  const normalized = (status ?? 'UNKNOWN').toUpperCase();
  const key = `gainosB4.leadsDetail.enrichment.status.${normalized}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? $t('gainosB4.leadsDetail.enrichment.status.UNKNOWN') : translated;
}

function dealOutcomeText(outcome?: string): string {
  const key = `gainosB4.leadsDetail.outcomes.dealOutcome.${outcome ?? ''}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? (outcome ?? '—') : translated;
}

function saoStateText(state?: string): string {
  const key = `gainosB4.leadsDetail.outcomes.saoState.${state ?? ''}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? (state ?? '—') : translated;
}

async function loadOutcomes(): Promise<void> {
  if (!pkg.value) return;
  outcomesLoading.value = true;
  outcomesPartialError.value = false;
  await ensureLoaded();
  const companyId = pkg.value.company?.canonical_company_id;
  const currentLeadId = leadId.value;
  let partial = false;

  const touchesPromise = gainosApi
    .listT0Touches(currentLeadId)
    .then((rows) => (Array.isArray(rows) ? rows : []))
    .catch(() => {
      partial = true;
      return outcomeTouches.value;
    });

  const qgosPromise = gainosApi
    .qgos({ limit: 50 })
    .then(async (rows) => {
      const list = Array.isArray(rows) ? rows : [];
      const matched = list.filter(
        (item) =>
          item.leadRef === currentLeadId ||
          (Boolean(companyId) && item.canonicalCompanyRef === companyId),
      );
      const hydrated = await Promise.all(
        matched.map(async (item) => {
          if (Array.isArray(item.outcomes)) return item;
          try {
            const detailQgo = await gainosApi.qgo(item.id);
            return detailQgo && typeof detailQgo === 'object' ? detailQgo : item;
          } catch {
            return item;
          }
        }),
      );
      return hydrated;
    })
    .catch(() => {
      partial = true;
      return [] as QgoView[];
    });

  // 严格门控：仅管理员查询联系人补强作业，防止 member 触发 403。
  const enrichmentPromise =
    isAdmin.value && companyId
      ? gainosApi
          .contactEnrichmentResults(companyId)
          .then((page) => (Array.isArray(page?.data) ? page.data : []))
          .catch(() => {
            partial = true;
            return [] as ContactEnrichmentResultView[];
          })
      : Promise.resolve([] as ContactEnrichmentResultView[]);

  try {
    const [touchesRows, qgoRows, enrichmentRows] = await Promise.all([
      touchesPromise,
      qgosPromise,
      enrichmentPromise,
    ]);
    outcomeTouches.value = touchesRows;
    outcomeQgos.value = qgoRows;
    outcomeEnrichments.value = enrichmentRows;
    outcomesPartialError.value = partial;
    outcomesLoaded.value = true;
  } finally {
    outcomesLoading.value = false;
  }
}

const outcomeTimeline = computed<OutcomeTimelineItem[]>(() => {
  const items: OutcomeTimelineItem[] = [];
  const currentPkg = pkg.value;
  if (currentPkg) {
    const latestEvidenceAt = (currentPkg.evidence ?? [])
      .map((item) => item.fetched_at)
      .filter((ts): ts is string => typeof ts === 'string' && Boolean(ts))
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0];

    items.push({
      id: `lead-status-${currentPkg.lead_id}`,
      at: latestEvidenceAt ?? currentPkg.sanctions?.screened_at ?? '',
      typeLabel: $t('gainosB4.leadsDetail.outcomes.type.leadDecision'),
      tone: statusTone.value,
      title: $t('gainosB4.leadsDetail.outcomes.leadStatusTitle', {
        status: statusLabel(currentPkg.status),
      }),
      detail: $t('gainosB4.leadsDetail.outcomes.leadScoreDetail', {
        score: totalScore.value ?? '—',
        verdict: fitLabel.value,
      }),
    });

    if (currentPkg.sanctions?.screened_at) {
      items.push({
        id: `sanctions-${currentPkg.lead_id}`,
        at: currentPkg.sanctions.screened_at,
        typeLabel: $t('gainosB4.leadsDetail.outcomes.type.sanctions'),
        tone: sanctionBlocked.value ? 'warning' : 'success',
        title: $t('gainosB4.leadsDetail.outcomes.sanctionsTitle', {
          status: sanctionLabel(currentPkg.sanctions.status),
        }),
      });
    }
  }

  for (const job of outcomeEnrichments.value) {
    const normalized = String(job.status ?? '').toUpperCase();
    const tone: TimelineTone =
      normalized === 'COMPLETED'
        ? 'success'
        : normalized === 'FAILED'
          ? 'danger'
          : normalized === 'RESULT_UNKNOWN'
            ? 'warning'
            : 'info';
    items.push({
      id: `enrich-${job.operationRef}`,
      at: job.createdAt ?? '',
      typeLabel: $t('gainosB4.leadsDetail.outcomes.type.enrichment'),
      tone,
      title: $t('gainosB4.leadsDetail.outcomes.enrichmentTitle', {
        status: enrichmentTimelineStatus(job.status),
      }),
      detail: $t('gainosB4.leadsDetail.outcomes.enrichmentDetail', {
        candidates: job.summary?.newCandidatePoints ?? 0,
        considered: job.summary?.consideredUniqueContacts ?? 0,
      }),
    });
  }

  for (const touch of outcomeTouches.value) {
    const channelText = $t(`gainos.leads.t0.channel.${touch.channel}` as Parameters<typeof $t>[0]);
    const outcomeText = $t(`gainos.leads.t0.outcome.${touch.outcome}` as Parameters<typeof $t>[0]);
    const detailParts = [touch.targetMasked, touch.note].filter(Boolean).join(' · ');
    items.push({
      id: `touch-${touch.id}`,
      at: touch.createdAt ?? '',
      typeLabel: $t('gainosB4.leadsDetail.outcomes.type.t0Touch'),
      tone: touch.outcome === 'REPLIED' ? 'success' : 'info',
      title: $t('gainosB4.leadsDetail.outcomes.t0TouchTitle', {
        channel: channelText,
        outcome: outcomeText,
      }),
      detail: detailParts || undefined,
    });
  }

  for (const qgo of outcomeQgos.value) {
    items.push({
      id: `qgo-${qgo.id}`,
      at: qgo.createdAt ?? '',
      typeLabel: $t('gainosB4.leadsDetail.outcomes.type.qgoPromoted'),
      tone: qgo.state === 'CONVERTED' ? 'success' : qgo.state === 'DROPPED' ? 'danger' : 'info',
      title: $t('gainosB4.leadsDetail.outcomes.qgoTitle', { title: qgo.title }),
      detail: qgo.nextStep
        ? $t('gainosB4.leadsDetail.outcomes.qgoNextStep', { step: qgo.nextStep })
        : undefined,
    });
    if (qgo.sao) {
      items.push({
        id: `sao-${qgo.sao.id}`,
        at: qgo.sao.decidedAt ?? qgo.updatedAt ?? '',
        typeLabel: $t('gainosB4.leadsDetail.outcomes.type.saoDecision'),
        tone: qgo.sao.state === 'ACCEPTED' ? 'success' : qgo.sao.state === 'DECLINED' ? 'danger' : 'neutral',
        title: $t('gainosB4.leadsDetail.outcomes.saoTitle', {
          state: saoStateText(qgo.sao.state),
        }),
        detail: qgo.sao.reason || undefined,
      });
    }
    for (const outcome of qgo.outcomes ?? []) {
      const positive = ['MEETING_BOOKED', 'QUOTE_SENT', 'WON'].includes(outcome.outcome);
      const negative = ['DISQUALIFIED', 'LOST', 'NO_RESPONSE'].includes(outcome.outcome);
      items.push({
        id: `outcome-${outcome.id}`,
        at: outcome.occurredAt || outcome.createdAt || '',
        typeLabel: $t('gainosB4.leadsDetail.outcomes.type.dealOutcome'),
        tone: positive ? 'success' : negative ? 'danger' : 'info',
        title: $t('gainosB4.leadsDetail.outcomes.dealOutcomeTitle', {
          outcome: dealOutcomeText(outcome.outcome),
        }),
        detail: outcome.note || undefined,
      });
    }
  }

  return items.sort((a, b) => {
    const ta = a.at ? Date.parse(a.at) : 0;
    const tb = b.at ? Date.parse(b.at) : 0;
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });
});

onMounted(async () => {
  await Promise.all([ensureLoaded(), load()]);
  if (tab.value === 'outcomes') {
    void loadOutcomes();
  }
});

watch(tab, (next) => {
  if (next === 'draft' && !draft.value) void loadDraft();
  if (next === 'outcomes' && pkg.value) void loadOutcomes();
});

watch(leadId, () => {
  outcomesLoaded.value = false;
  outcomeTouches.value = [];
  outcomeEnrichments.value = [];
  outcomeQgos.value = [];
  void load().then(() => {
    if (tab.value === 'outcomes') void loadOutcomes();
  });
});
</script>

<template>
  <div class="mx-auto grid w-full max-w-[var(--gs-page-max)] grid-cols-1 gap-4 px-[var(--gs-page-pad)] pb-12 @container">
    <GsPage
      :subtitle="pkg ? [pkg.company.country, pkg.company.domain].filter(Boolean).join(' · ') : ''"
      :title="pkg?.company.name || $t('gainos.leads.unknownCompany')"
    >
      <template #actions>
        <Space :size="8" wrap>
          <GsTag v-if="pkg" :tone="statusTone">{{ statusLabel(status) }}</GsTag>
          <Button v-if="canDecide" danger @click="openDecision('reject')">
            {{ $t('gainos.leads.cardReject') }}
          </Button>
          <Button v-if="canDecide" type="primary" @click="openDecision('accept')">
            {{ $t('gainos.leads.cardAccept') }}
          </Button>
          <Button v-if="status === 'QUALIFIED'" type="primary" @click="promoteOpen = true">
            {{ $t('gainos.leads.promoteQgo') }}
          </Button>
          <Button v-if="status === 'QUALIFIED' && !GROWTH_PAGE_HIDDEN" @click="goOutreach">
            {{ $t('gainos.leads.goOutreach') }}
          </Button>
          <Button data-gs="back-to-list" @click="router.push('/leads')">
            {{ $t('gainos.leads.backToList') }}
          </Button>
        </Space>
      </template>
    </GsPage>

    <AsyncSection
      :error="error"
      :loading="loading"
      :loading-text="$t('gainos.common.loading')"
      :retry-text="$t('gainos.common.retry')"
      class="relative z-[1] -mt-13"
      @retry="load"
    >
      <div v-if="pkg" class="grid gap-4">
      <Tabs
        :active-key="tab"
        data-gs="lead-tabs"
        @change="selectTab"
      >
        <TabPane key="package" :tab="$t('gainos.leads.tab.package')">
          <div class="grid gap-4">
            <!-- 判断结果：结论 + 五维雷达 -->
            <GsCard data-gs="judge-hero">
              <div class="grid items-start gap-6 @min-[900px]:grid-cols-[minmax(0,1fr)_360px]">
                <div class="min-w-0">
                  <p class="lead-hero__label">{{ $t('gainos.leads.verdictTitle') }}</p>
                  <div class="flex flex-wrap items-center gap-3">
                    <GsTag :tone="verdictTone(rawVerdict)">{{ fitLabel }}</GsTag>
                    <span class="lead-hero__score">{{ totalScore ?? '—' }}</span>
                    <span class="text-xs text-[var(--gs-fg-muted)]">
                      {{ $t('gainos.leads.scoreLabel') }}
                    </span>
                    <span class="lead-grade" :class="`lead-grade--${grade}`">
                      {{ gradeLabel }}
                    </span>
                  </div>
                  <p v-if="summaryText" class="mt-3 text-[13px] text-[var(--gs-fg-muted)]">
                    {{ summaryText }}
                  </p>
                  <div class="lead-hero__reason-box">
                    <p class="lead-hero__label">{{ $t('gainos.leads.reasonTitle') }}</p>
                    <p class="lead-hero__reason">{{ keyReason }}</p>
                  </div>
                  <p v-if="unknownNote" class="mb-0 mt-2 text-xs text-[var(--gs-fg-subtle)]">
                    {{ unknownNote }}
                  </p>
                  <div v-if="evidenceItems.length > 0" class="lead-hero__evidence">
                    <p class="lead-hero__label">{{ $t('gainos.leads.evidenceHighlight') }}</p>
                    <ul>
                      <li v-for="(item, index) in evidenceItems.slice(0, 3)" :key="index">
                        <span aria-hidden="true" class="lead-hero__dot" />
                        <a
                          v-if="item.url"
                          :href="item.url"
                          rel="noreferrer"
                          target="_blank"
                        >
                          {{ item.field }}
                        </a>
                        <span v-else>{{ item.field }}</span>
                        <span v-if="item.fetchedAt" class="lead-hero__evidence-date">
                          {{ formatDate(item.fetchedAt) }}
                        </span>
                      </li>
                    </ul>
                  </div>
                </div>
                <div v-if="radarDims.length > 0" class="lead-radar">
                  <p class="lead-radar__title">{{ $t('gainos.leads.radarTitle') }}</p>
                  <GsRadar
                    :ariaLabel="`${$t('gainos.leads.radarTitle')}：${summaryText}`"
                    :dims="radarDims"
                  />
                  <p class="lead-radar__hint">{{ $t('gainos.leads.radarHint') }}</p>
                </div>
              </div>
            </GsCard>

            <!-- 五维明细 -->
            <GsCard :title="$t('gainos.leads.criteriaTitle')" data-gs="judge-dimensions">
              <JudgeDimensions v-if="dims.length > 0" :dims="dims" />
              <template v-else>
                <p class="m-0 text-[13px] text-[var(--gs-fg-muted)]">
                  {{ $t('gainos.leads.criteriaNone') }}
                </p>
                <ul
                  v-if="fitReasonList.length > 0"
                  class="mt-3 grid gap-1.5 pl-4 text-[13px] text-[var(--gs-fg-muted)]"
                >
                  <li v-for="(reason, index) in fitReasonList" :key="index">{{ reason }}</li>
                </ul>
              </template>
            </GsCard>

            <div class="grid gap-4 @min-[760px]:grid-cols-2">
              <GsCard :title="$t('gainos.leads.profileTitle')" data-gs="company-profile">
                <Descriptions :column="1" :colon="false" size="small">
                  <DescriptionsItem
                    v-for="row in profileRows"
                    :key="row.label"
                    :label="row.label"
                  >
                    {{ row.value }}
                  </DescriptionsItem>
                  <DescriptionsItem
                    v-if="pkg.registered_address"
                    :label="$t('gainos.leads.address')"
                  >
                    {{ pkg.registered_address }}
                  </DescriptionsItem>
                  <DescriptionsItem
                    v-for="row in identifierRows"
                    :key="`id-${row.label}`"
                    :label="row.label"
                  >
                    <span class="font-mono text-xs">{{ row.value }}</span>
                  </DescriptionsItem>
                  <DescriptionsItem
                    v-if="profileRows.length === 0 && identifierRows.length === 0 && !pkg.registered_address"
                    :label="$t('gainos.leads.profileEmpty')"
                  >
                    —
                  </DescriptionsItem>
                </Descriptions>
              </GsCard>

              <GsCard :title="$t('gainos.leads.contactTitle')" data-gs="contact-paths">
                <div v-if="hasAnyContactPath" class="grid gap-3">
                  <div v-if="companyEmails.length > 0" class="grid gap-1.5">
                    <p class="m-0 text-xs font-medium text-[var(--gs-fg-subtle)]">
                      {{ $t('gainos.leads.channelEmailsTitle') }}
                    </p>
                    <p
                      v-for="(item, index) in companyEmails"
                      :key="`em-${index}`"
                      class="m-0 flex flex-wrap items-center gap-2 text-[13px]"
                    >
                      <a
                        v-if="contactEmailMailtoAllowed"
                        class="break-all text-[var(--gs-accent-fg)]"
                        :href="`mailto:${item.value}`"
                      >
                        {{ item.value }}
                      </a>
                      <span v-else class="break-all text-[var(--gs-fg-muted)]">
                        {{ item.value }}
                      </span>
                      <Tag v-if="item.email_type" :bordered="false" class="m-0 text-xs">
                        {{ item.email_type }}
                      </Tag>
                    </p>
                  </div>

                  <div v-if="companyPhones.length > 0" class="grid gap-1.5">
                    <p class="m-0 text-xs font-medium text-[var(--gs-fg-subtle)]">
                      {{ $t('gainos.leads.channelPhonesTitle') }}
                    </p>
                    <p
                      v-for="(item, index) in companyPhones"
                      :key="`ph-${index}`"
                      class="m-0 flex flex-wrap items-center gap-2 text-[13px]"
                    >
                      <a
                        class="text-[var(--gs-fg)]"
                        :href="`tel:${item.value}`"
                      >
                        {{ item.value }}
                      </a>
                    </p>
                  </div>

                  <div v-if="companySocials.length > 0" class="grid gap-1.5">
                    <p class="m-0 text-xs font-medium text-[var(--gs-fg-subtle)]">
                      {{ $t('gainos.leads.channelSocialsTitle') }}
                    </p>
                    <div class="flex flex-wrap gap-2">
                      <a
                        v-for="(social, index) in companySocials"
                        :key="`soc-${index}`"
                        class="inline-flex items-center rounded-md bg-[var(--gs-accent-soft)] px-2.5 py-0.5 text-xs font-medium text-[var(--gs-accent-fg)] no-underline hover:underline"
                        :href="social.url"
                        rel="noreferrer"
                        target="_blank"
                        :title="social.url"
                      >
                        {{ social.label }}
                      </a>
                    </div>
                  </div>

                  <div v-if="contactPaths.length > 0" class="grid gap-1.5">
                    <p class="m-0 text-xs font-medium text-[var(--gs-fg-subtle)]">
                      {{ $t('gainos.leads.channelFormsTitle') }}
                    </p>
                    <p
                      v-for="(point, index) in contactPaths"
                      :key="`path-${index}`"
                      class="m-0 flex flex-wrap items-baseline gap-2 text-[13px]"
                    >
                      <a
                        class="break-all text-[var(--gs-accent-fg)]"
                        :href="point.url"
                        rel="noreferrer"
                        target="_blank"
                      >
                        {{ point.url }}
                      </a>
                    </p>
                  </div>
                </div>
                <p v-else class="m-0 text-[13px] text-[var(--gs-fg-muted)]">
                  {{ $t('gainos.leads.noContactPath') }}
                </p>
                <p
                  v-if="pkg.suggested_contact_path"
                  class="mb-0 mt-3 text-xs text-[var(--gs-fg-subtle)]"
                >
                  {{ pkg.suggested_contact_path.legal_note }}
                </p>
              </GsCard>
            </div>

            <GsCard :title="$t('gainos.leads.evidenceTitle')" data-gs="evidence">
              <ul v-if="evidenceItems.length > 0" class="m-0 grid list-none gap-2 p-0">
                <li
                  v-for="(item, index) in evidenceItems"
                  :key="index"
                  class="flex flex-wrap items-baseline gap-2 text-[13px]"
                >
                  <Tag :bordered="false" class="m-0">{{ item.field }}</Tag>
                  <a
                    v-if="item.url"
                    class="break-all text-[var(--gs-accent-fg)]"
                    :href="item.url"
                    rel="noreferrer"
                    target="_blank"
                  >
                    {{ item.url }}
                  </a>
                  <span v-if="item.fetchedAt" class="text-xs text-[var(--gs-fg-subtle)]">
                    {{ formatDate(item.fetchedAt) }}
                  </span>
                </li>
              </ul>
              <p v-else class="m-0 text-[13px] text-[var(--gs-fg-muted)]">
                {{ $t('gainos.leads.evidenceEmpty') }}
              </p>

              <h3 class="mb-0 mt-5 text-[13px] font-semibold text-[var(--gs-fg)]">
                {{ $t('gainos.leads.signalsTitle') }}
              </h3>
              <ul v-if="(pkg.signals ?? []).length > 0" class="m-0 mt-2 grid list-none gap-2 p-0">
                <li
                  v-for="(signal, index) in pkg.signals"
                  :key="`sig-${index}`"
                  class="flex flex-wrap items-baseline gap-2 text-[13px]"
                >
                  <Tag :bordered="false" class="m-0">{{ signal.type }}</Tag>
                  <a
                    v-if="signal.url"
                    class="break-all text-[var(--gs-accent-fg)]"
                    :href="signal.url"
                    rel="noreferrer"
                    target="_blank"
                  >
                    {{ signal.url }}
                  </a>
                  <span class="text-xs text-[var(--gs-fg-subtle)]">
                    {{ formatDateTime(signal.at) }}
                  </span>
                </li>
              </ul>
              <p v-else class="m-0 mt-2 text-[13px] text-[var(--gs-fg-muted)]">
                {{ $t('gainos.leads.noSignals') }}
              </p>
            </GsCard>

            <div class="grid gap-4 @min-[760px]:grid-cols-2">
              <GsCard
                :class="{ 'is-warn': sanctionBlocked }"
                :title="$t('gainos.leads.sanctionsTitle')"
                data-gs="sanctions"
              >
                <p
                  class="m-0 text-[13px]"
                  :class="sanctionBlocked ? 'font-semibold text-[var(--gs-warn-fg)]' : 'text-[var(--gs-fg)]'"
                >
                  {{ sanctionLabel(pkg.sanctions?.status) }}
                </p>
                <p
                  v-if="pkg.sanctions?.screened_at"
                  class="mb-0 mt-1 text-xs text-[var(--gs-fg-subtle)]"
                >
                  {{ formatDateTime(pkg.sanctions.screened_at) }}
                </p>
                <Space v-if="isAdmin && sanctionBlocked" class="mt-3" :size="8" wrap>
                  <Button
                    v-if="pkg.sanctions?.status !== 'confirmed_true_hit'"
                    :loading="sanctionsBusy"
                    @click="reviewSanctions('cleared_false_positive')"
                  >
                    {{ $t('gainos.leads.sanctionsClear') }}
                  </Button>
                  <Button
                    v-if="pkg.sanctions?.status !== 'confirmed_true_hit'"
                    danger
                    :loading="sanctionsBusy"
                    @click="reviewSanctions('confirmed_true_hit')"
                  >
                    {{ $t('gainos.leads.sanctionsConfirm') }}
                  </Button>
                </Space>
                <ErrorNotice
                  v-if="sanctionsError"
                  class="mt-3"
                  :next="sanctionsError.next"
                  :title="sanctionsError.title"
                />
                <p
                  v-if="pkg.valid_until"
                  class="mb-0 mt-3 text-xs text-[var(--gs-fg-subtle)]"
                >
                  {{ $t('gainos.leads.validUntil', { date: formatDate(pkg.valid_until) }) }}
                </p>
              </GsCard>

              <GsCard :title="$t('gainos.leads.scoresTitle')" data-gs="score-detail">
                <div v-if="scoreRows.length > 0 || totalScore !== null" class="grid gap-2.5">
                  <div
                    v-for="row in scoreRows"
                    :key="row.dim"
                    class="grid grid-cols-[96px_1fr_40px] items-center gap-3"
                  >
                    <span class="text-xs text-[var(--gs-fg-muted)]">
                      {{ $t(`gainos.leads.dim.${row.dim}`) }}
                    </span>
                    <span class="h-1.5 overflow-hidden rounded-full bg-[var(--gs-surface-2)]">
                      <span
                        class="block h-full rounded-full bg-[var(--gs-accent-cta)]"
                        :style="{ width: `${Math.min(100, Math.max(0, row.value * 100))}%` }"
                      />
                    </span>
                    <span class="text-right text-xs tabular-nums text-[var(--gs-fg)]">
                      {{ Math.round(row.value * 100) }}
                    </span>
                  </div>
                  <p
                    v-if="totalScore !== null"
                    class="mb-0 mt-1 flex items-baseline justify-between border-t border-[var(--gs-divider)] pt-2"
                  >
                    <span class="text-xs text-[var(--gs-fg-muted)]">
                      {{ $t('gainos.leads.dim.total') }}
                    </span>
                    <span class="text-sm font-semibold tabular-nums text-[var(--gs-accent-fg)]">
                      {{ totalScore }}
                    </span>
                  </p>
                </div>
                <p v-else class="m-0 text-[13px] text-[var(--gs-fg-muted)]">
                  {{ $t('gainos.leads.notScored') }}
                </p>
              </GsCard>
            </div>

            <details v-if="judge.raw && isMachineAggregate(judge.raw)" class="lead-tech">
              <summary>{{ $t('gainos.findBuyers.technicalDetails') }}</summary>
              <dl class="lead-tech__grid">
                <template v-if="judge.verdict">
                  <dt>{{ $t('gainos.leads.techVerdict') }}</dt>
                  <dd>{{ judge.verdict }}</dd>
                </template>
                <template v-if="judge.reasonCodes.length > 0">
                  <dt>{{ $t('gainos.leads.techReasonCodes') }}</dt>
                  <dd>{{ judge.reasonCodes.join(' · ') }}</dd>
                </template>
                <template v-if="judge.weightedNote">
                  <dt>{{ $t('gainos.leads.techWeighted') }}</dt>
                  <dd>{{ judge.weightedNote }}</dd>
                </template>
              </dl>
              <pre class="lead-tech__raw">{{ judge.raw }}</pre>
            </details>
          </div>
        </TabPane>

        <TabPane key="people" :tab="$t('gainos.leads.tab.people')">
          <div class="grid gap-4">
            <!-- 公司级公开渠道：全员（含 member）可见，独立于具名决策人权限边界 -->
            <GsCard
              :title="$t('gainosB4.leadsDetail.publicChannelsTitle')"
              data-gs="people-public-channels"
            >
              <p class="m-0 mb-3 text-xs text-[var(--gs-fg-muted)]">
                {{ $t('gainosB4.leadsDetail.publicChannelsDesc') }}
              </p>
              <div v-if="hasAnyContactPath" class="grid gap-3 @min-[700px]:grid-cols-2">
                <div v-if="companyEmails.length > 0" class="grid gap-1.5">
                  <p class="m-0 text-xs font-medium text-[var(--gs-fg-subtle)]">
                    {{ $t('gainos.leads.channelEmailsTitle') }}
                  </p>
                  <p
                    v-for="(item, index) in companyEmails"
                    :key="`pub-em-${index}`"
                    class="m-0 flex flex-wrap items-center gap-2 text-[13px]"
                  >
                    <a
                      v-if="contactEmailMailtoAllowed"
                      class="break-all text-[var(--gs-accent-fg)]"
                      :href="`mailto:${item.value}`"
                    >
                      {{ item.value }}
                    </a>
                    <span v-else class="break-all text-[var(--gs-fg-muted)]">
                      {{ item.value }}
                    </span>
                    <Tag v-if="item.email_type" :bordered="false" class="m-0 text-xs">
                      {{ item.email_type }}
                    </Tag>
                  </p>
                </div>

                <div v-if="companyPhones.length > 0" class="grid gap-1.5">
                  <p class="m-0 text-xs font-medium text-[var(--gs-fg-subtle)]">
                    {{ $t('gainos.leads.channelPhonesTitle') }}
                  </p>
                  <p
                    v-for="(item, index) in companyPhones"
                    :key="`pub-ph-${index}`"
                    class="m-0 flex flex-wrap items-center gap-2 text-[13px]"
                  >
                    <a class="text-[var(--gs-fg)]" :href="`tel:${item.value}`">
                      {{ item.value }}
                    </a>
                  </p>
                </div>

                <div v-if="companySocials.length > 0" class="grid gap-1.5">
                  <p class="m-0 text-xs font-medium text-[var(--gs-fg-subtle)]">
                    {{ $t('gainos.leads.channelSocialsTitle') }}
                  </p>
                  <div class="flex flex-wrap gap-2">
                    <a
                      v-for="(social, index) in companySocials"
                      :key="`pub-soc-${index}`"
                      class="inline-flex items-center rounded-md bg-[var(--gs-accent-soft)] px-2.5 py-0.5 text-xs font-medium text-[var(--gs-accent-fg)] no-underline hover:underline"
                      :href="social.url"
                      rel="noreferrer"
                      target="_blank"
                      :title="social.url"
                    >
                      {{ social.label }}
                    </a>
                  </div>
                </div>

                <div v-if="contactPaths.length > 0" class="grid gap-1.5">
                  <p class="m-0 text-xs font-medium text-[var(--gs-fg-subtle)]">
                    {{ $t('gainos.leads.channelFormsTitle') }}
                  </p>
                  <p
                    v-for="(point, index) in contactPaths"
                    :key="`pub-path-${index}`"
                    class="m-0 flex flex-wrap items-baseline gap-2 text-[13px]"
                  >
                    <a
                      class="break-all text-[var(--gs-accent-fg)]"
                      :href="point.url"
                      rel="noreferrer"
                      target="_blank"
                    >
                      {{ point.url }}
                    </a>
                  </p>
                </div>
              </div>
              <p v-else class="m-0 text-[13px] text-[var(--gs-fg-muted)]">
                {{ $t('gainosB4.leadsDetail.publicChannelsEmpty') }}
              </p>
              <p
                v-if="pkg.suggested_contact_path"
                class="mb-0 mt-3 text-xs text-[var(--gs-fg-subtle)]"
              >
                {{ pkg.suggested_contact_path.legal_note }}
              </p>
            </GsCard>

            <!-- 具名决策人个人联系点与联系人补强操作：严格由 useWorkspaceAccess().isAdmin 门控 -->
            <DecisionMakerCard
              v-if="isAdmin && pkg.company.canonical_company_id"
              :company-id="pkg.company.canonical_company_id"
              hide-official-channels
              @enrichment-updated="loadOutcomes"
            />
            <GsCard
              v-else-if="accessLoaded"
              :title="$t('gainosB4.leadsDetail.decisionMakersAdminTitle')"
              data-gs="decision-makers-admin-only"
            >
              <p class="m-0 text-[13px] font-medium text-[var(--gs-fg)]">
                {{ $t('gainos.leads.peopleAdminOnly') }}
              </p>
              <p class="mb-0 mt-1.5 text-xs text-[var(--gs-fg-muted)]">
                {{ $t('gainosB4.leadsDetail.decisionMakersAdminNote') }}
              </p>
            </GsCard>
          </div>
        </TabPane>

        <TabPane key="draft" :tab="$t('gainos.leads.tab.draft')">
          <div class="grid gap-4">
            <GsCard>
              <template #title>{{ $t('gainos.leads.outreachDraft') }}</template>
            <template #extra>
              <Button
                v-if="status === 'QUALIFIED'"
                :loading="draftLoading"
                size="small"
                @click="generateDraft"
              >
                {{ $t('gainos.leads.outreachDraft') }}
              </Button>
            </template>
            <p class="m-0 text-xs text-[var(--gs-fg-subtle)]">
              {{ $t('gainos.leads.outreachDraftDesc') }}
            </p>
            <ErrorNotice
              v-if="draftError"
              class="mt-3"
              :next="draftError.next"
              :title="draftError.title"
            />
            <template v-else-if="draftText">
              <pre class="lead-draft">{{ draftText }}</pre>
              <Button class="mt-3" @click="copyDraft">
                {{ copied ? $t('gainos.leads.copied') : $t('gainos.leads.copy') }}
              </Button>
            </template>
            <p
              v-else-if="status !== 'QUALIFIED'"
              class="mb-0 mt-3 text-[13px] text-[var(--gs-fg-muted)]"
            >
              {{ $t('gainos.leads.outreachNeedsQualified') }}
            </p>
            <p v-else class="mb-0 mt-3 text-[13px] text-[var(--gs-fg-muted)]">
              {{ $t('gainos.leads.outreachEmpty') }}
            </p>
          </GsCard>
          </div>
        </TabPane>

        <TabPane key="outcomes" :tab="$t('gainos.leads.tab.outcomes')">
          <GsCard
            :title="$t('gainosB4.leadsDetail.outcomes.timelineTitle')"
            data-gs="outcomes-timeline-card"
          >
            <template #extra>
              <Space :size="8" wrap>
                <Button :loading="outcomesLoading" size="small" @click="loadOutcomes">
                  {{ $t('gainosB4.leadsDetail.outcomes.refresh') }}
                </Button>
                <Button size="small" @click="router.push('/opportunities')">
                  {{ $t('gainos.leads.outcomesQgos') }}
                </Button>
                <Button v-if="!GROWTH_PAGE_HIDDEN" size="small" @click="goOutreach">
                  {{ $t('gainos.leads.outcomesOutreach') }}
                </Button>
              </Space>
            </template>

            <p class="m-0 text-xs text-[var(--gs-fg-muted)]">
              {{ $t('gainosB4.leadsDetail.outcomes.timelineSubtitle') }}
            </p>

            <Alert
              v-if="outcomesPartialError"
              :message="$t('gainosB4.leadsDetail.outcomes.partialNotice')"
              class="mt-3"
              data-gs="outcomes-partial-notice"
              show-icon
              type="warning"
            />

            <p v-if="outcomesLoading && !outcomesLoaded" class="mb-0 mt-4 text-[13px] text-[var(--gs-fg-muted)]">
              {{ $t('gainosB4.leadsDetail.outcomes.loading') }}
            </p>

            <ol
              v-else-if="outcomeTimeline.length > 0"
              class="lead-timeline"
              data-gs="outcomes-timeline"
            >
              <li
                v-for="entry in outcomeTimeline"
                :key="entry.id"
                class="lead-timeline__item"
                data-gs="outcomes-timeline-item"
              >
                <div class="lead-timeline__head">
                  <GsTag :tone="entry.tone">{{ entry.typeLabel }}</GsTag>
                  <span v-if="entry.at" class="text-xs text-[var(--gs-fg-subtle)]">
                    {{ formatDateTime(entry.at) }}
                  </span>
                </div>
                <p class="lead-timeline__title">{{ entry.title }}</p>
                <p v-if="entry.detail" class="lead-timeline__detail">{{ entry.detail }}</p>
              </li>
            </ol>

            <p v-else class="mb-0 mt-4 text-[13px] text-[var(--gs-fg-muted)]">
              {{ $t('gainosB4.leadsDetail.outcomes.empty') }}
            </p>
          </GsCard>
        </TabPane>
      </Tabs>

      <!-- 单一受控挂载 T0OutreachPanel：切换任意 Tab 均不销毁/重置草稿与已选渠道 -->
      <T0OutreachPanel
        v-show="tab === 'package' || tab === 'draft'"
        :key="pkg.lead_id"
        :draft="draft"
        :is-admin="isAdmin"
        :pkg="pkg"
        @touches-updated="onTouchesUpdated"
      />
      </div>
    </AsyncSection>

    <!-- 接受/拒绝 -->
    <Modal
      v-model:open="decisionOpen"
      :title="decisionTitle"
      :width="560"
      data-gs="decision-modal"
    >
      <p class="mt-0 text-[13px] text-[var(--gs-fg-muted)]">{{ decisionDesc }}</p>
      <ErrorNotice
        v-if="actionError"
        class="mb-3"
        :next="actionError.next"
        :title="actionError.title"
      />
      <div class="grid gap-3">
        <label class="grid gap-1.5 text-xs font-medium text-[var(--gs-fg-2)]">
          <span>{{ $t('gainos.leads.reasonCode') }}<em v-if="decision === 'reject'"> *</em></span>
          <GsSelect
            v-model="reasonCode"
            :ariaLabel="$t('gainos.leads.reasonCode')"
            :options="reasonOptions.map((option) => ({ label: option.label, value: option.code }))"
            :placeholder="decision === 'reject' ? $t('gainos.leads.reasonSelect') : $t('gainos.leads.reasonOptional')"
            allow-clear
          />
        </label>
        <label class="grid gap-1.5 text-xs font-medium text-[var(--gs-fg-2)]">
          <span>{{ $t('gainos.leads.reasonNote') }}</span>
          <Input.TextArea
            v-model:value="reasonNote"
            :maxlength="500"
            :placeholder="$t('gainos.leads.reasonPlaceholder')"
            :rows="2"
          />
        </label>
      </div>
      <template #footer>
        <Space :size="8">
          <Button @click="decision = null">{{ $t('gainos.common.cancel') }}</Button>
          <Button
            :danger="decision === 'reject'"
            :loading="submitting"
            :disabled="decision === 'reject' && !reasonCode"
            type="primary"
            @click="submitDecision"
          >
            {{ decisionOkText }}
          </Button>
        </Space>
      </template>
    </Modal>

    <!-- 提升为商机 -->
    <Modal
      v-model:open="promoteOpen"
      :confirm-loading="promoteBusy"
      :ok-button-props="{ disabled: promoteBusy || !promoteNextStep.trim() }"
      :ok-text="$t('gainos.leads.promoteSubmit')"
      :title="$t('gainos.leads.promoteTitle')"
      :width="680"
      data-gs="promote-modal"
      @ok="submitPromote"
    >
      <ErrorNotice
        v-if="promoteError"
        class="mb-3"
        :next="promoteError.next"
        :title="promoteError.title"
      />
      <div class="grid gap-3">
        <div class="grid gap-2">
          <span class="text-xs font-medium text-[var(--gs-fg-2)]">
            {{ $t('gainos.leads.promoteEvidence') }}
          </span>
          <div
            v-for="(row, index) in promoteEvidence"
            :key="index"
            class="flex flex-wrap items-center gap-2"
          >
            <GsSelect
              v-model="row.type"
              :ariaLabel="$t('gainos.leads.promoteEvidenceType')"
              :options="[
                'customer_reply',
                'purchase_page',
                'tender_hit',
                'customs_signal',
                'other',
              ].map((type) => ({ label: $t(`gainos.leads.evidenceType.${type}`), value: type }))"
              class="w-[150px]"
            />
            <Input
              v-model:value="row.url"
              :placeholder="$t('gainos.leads.promoteUrlHint')"
              class="min-w-[200px] flex-1"
              type="url"
            />
            <Input
              v-model:value="row.support"
              :maxlength="500"
              :placeholder="$t('gainos.leads.promoteSupportHint')"
              class="min-w-[200px] flex-1"
            />
            <Button
              :disabled="promoteEvidence.length <= 1"
              @click="removeEvidenceRow(index)"
            >
              ×
            </Button>
          </div>
          <Button class="justify-self-start" type="dashed" @click="addEvidenceRow">
            {{ $t('gainos.leads.addEvidence') }}
          </Button>
        </div>
        <label class="grid gap-1.5 text-xs font-medium text-[var(--gs-fg-2)]">
          <span>{{ $t('gainos.leads.promoteNextStep') }}</span>
          <Input.TextArea
            v-model:value="promoteNextStep"
            :maxlength="500"
            :placeholder="$t('gainos.leads.promoteNextStepHint')"
            :rows="2"
          />
        </label>
      </div>
    </Modal>
  </div>
</template>

<style scoped>
.lead-hero__label {
  margin: 0 0 4px;
  color: var(--gs-fg-subtle);
  font-size: 11px;
  line-height: 16px;
}
.lead-hero__score {
  color: var(--gs-fg);
  font-size: 36px;
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.lead-grade {
  padding: 0 8px;
  border-radius: 6px;
  font-size: 11.5px;
  line-height: 20px;
  font-weight: 500;
}
.lead-grade--high {
  background: var(--gs-success-bg);
  color: var(--gs-success-fg);
}
.lead-grade--medium {
  background: var(--gs-accent-soft);
  color: var(--gs-accent-fg);
}
.lead-grade--low {
  background: var(--gs-surface-2);
  color: var(--gs-fg-muted);
}
.lead-grade--none {
  background: var(--gs-surface-2);
  color: var(--gs-fg-subtle);
}
.lead-hero__reason-box {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--gs-divider);
}
.lead-hero__reason {
  margin: 3px 0 0;
  max-width: 760px;
  color: var(--gs-fg-2);
  font-size: 13px;
  line-height: 1.75;
}
.lead-radar {
  padding: 12px 14px 10px;
  border: 1px solid var(--gs-divider);
  border-radius: 10px;
  background: var(--gs-surface-2);
}
.lead-radar__title {
  margin: 0;
  color: var(--gs-fg-muted);
  font-size: 12px;
  font-weight: 500;
}
.lead-radar__hint {
  margin: 0;
  color: var(--gs-fg-subtle);
  font-size: 11px;
  text-align: center;
}
.lead-hero__evidence {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--gs-divider);
}
.lead-hero__evidence ul {
  display: grid;
  gap: 4px;
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}
.lead-hero__evidence li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12.5px;
  color: var(--gs-fg-muted);
}
.lead-hero__evidence a {
  color: var(--gs-accent-fg);
  text-decoration: none;
}
.lead-hero__evidence a:hover {
  text-decoration: underline;
}
.lead-hero__dot {
  display: inline-block;
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--gs-accent-cta);
  transform: translateY(-2px);
}
.lead-hero__evidence-date {
  margin-left: auto;
  color: var(--gs-fg-subtle);
  font-size: 11px;
}
.lead-tech {
  color: var(--gs-fg-subtle);
  font-size: 12px;
}
.lead-tech summary {
  cursor: pointer;
}
.lead-tech__grid {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 8px 0 0;
}
.lead-tech__grid dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.lead-tech__raw {
  max-height: 220px;
  overflow: auto;
  margin: 8px 0 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--gs-surface-2);
  color: var(--gs-fg-muted);
  font-size: 11.5px;
  white-space: pre-wrap;
  word-break: break-word;
}
.lead-draft {
  margin: 12px 0 0;
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--gs-surface-2);
  font-size: 12.5px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 420px;
  overflow: auto;
}
.is-warn {
  border-color: var(--gs-warn);
  background: var(--gs-warn-bg);
}
.lead-timeline {
  display: grid;
  gap: 12px;
  margin: 14px 0 0;
  padding: 0;
  list-style: none;
}
.lead-timeline__item {
  display: grid;
  gap: 4px;
  padding: 10px 14px;
  border: 1px solid var(--gs-border);
  border-radius: 10px;
  background: var(--gs-surface-2);
}
.lead-timeline__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.lead-timeline__title {
  margin: 2px 0 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--gs-fg);
}
.lead-timeline__detail {
  margin: 0;
  font-size: 12px;
  color: var(--gs-fg-muted);
}
</style>
