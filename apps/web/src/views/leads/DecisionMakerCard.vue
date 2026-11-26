<script lang="ts" setup>
/**
 * 联系人（线索档案包 →「联系人」页签，原名「决策人」，2026-11-25 改名；联系人挖掘 M4）。
 *
 * - 数据来自引擎 canonical 公司详情（联系人 + 联系方式 + 字段级证据）；
 * - 三个写操作都先确认再执行，RISKY / 推断邮箱必须二次勾选才能发起验证；
 *   合法依据由 BFF 按租户「数据处理声明」自动注入，这里只读取展示依据引用；
 * - 来源层级按引擎许可区分「索引片段 / 历史档案 / 公开页」，绝不把推断显示成确定。
 *
 * 2026-11-25 排版对齐买家线索卡：每位决策人一张浮起白卡，三列对齐
 * （人 / 联系方式 / 来源），状态用统一药丸；按钮、弹层、提示全部走 antd。
 */
import type {
  CanonicalCompanyDetail,
  CanonicalContact,
  CanonicalContactPoint,
  ComplianceInfoView,
  ContactEnrichmentQualityFactView,
  ContactEnrichmentResultView,
  ContactEvidence,
} from '#/api/gainos';

import { computed, onMounted, reactive, ref, watch } from 'vue';

import { formatDate as formatDateValue, formatDateTime } from '@gain-saas/shared';

import { Alert, Button, Checkbox, Modal, Skeleton, Space, Tag } from 'ant-design-vue';

import ErrorNotice from '#/components/error-notice.vue';
import GsCard from '#/components/gainos/ui/gs-card.vue';
import GsEmpty from '#/components/gainos/ui/gs-empty.vue';
import GsTag from '#/components/gainos/ui/gs-tag.vue';
import { useWorkspaceAccess } from '#/composables/use-workspace-access';
import { feedback } from '#/feedback';
import { $t } from '#/locales';
import { newAttemptId } from '#/utils/attempt-id';

import { failureText, gainosApi } from '#/api/gainos';

defineOptions({ name: 'DecisionMakerCard' });

const props = withDefaults(
  defineProps<{
    companyId: string;
    hideOfficialChannels?: boolean;
  }>(),
  {
    hideOfficialChannels: false,
  },
);

const emit = defineEmits<{
  'enrichment-updated': [];
}>();

const { isAdmin, ensureLoaded } = useWorkspaceAccess();

type DialogKind = 'discover' | 'enrich' | 'guess' | 'verify';
type GsTone = 'danger' | 'info' | 'neutral' | 'success' | 'warning';
type NoticeTone = 'error' | 'info' | 'success' | 'warning';

interface DialogState {
  kind: DialogKind;
  contact?: CanonicalContact;
  point?: CanonicalContactPoint;
}

const detail = ref<CanonicalCompanyDetail | null>(null);
const loading = ref(false);
const loadError = ref<{ code?: string; title: string; next?: string } | null>(null);
const busy = ref<DialogKind | null>(null);
const notice = ref<string | null>(null);
const noticeTone = ref<NoticeTone>('success');
const actionError = ref<{ title: string; next?: string } | null>(null);
const dialog = ref<DialogState | null>(null);
const form = reactive({
  acknowledged: false,
});
/** 2026-11-04 取消租户声明：合法依据由平台统一提供（BFF 自动注入），此处只读取展示依据引用。 */
const platformBasis = ref<ComplianceInfoView['platform'] | null>(null);
let platformBasisLoaded = false;

// ── B1 联系人补强结果与质量事实（仅管理员可调用，防 member 403）────────────────
const enrichmentResults = ref<ContactEnrichmentResultView[]>([]);
const qualityFacts = ref<ContactEnrichmentQualityFactView[]>([]);
const enrichmentLoading = ref(false);
const recoveringOpRef = ref<string | null>(null);
const expandedOpRef = ref<string | null>(null);
const detailLoadingOpRef = ref<string | null>(null);
const enrichmentDetailMap = ref<Record<string, ContactEnrichmentResultView>>({});
const qualityFactDetailMap = ref<Record<string, ContactEnrichmentQualityFactView>>({});

const qualityFactByOp = computed(() => {
  const map = new Map<string, ContactEnrichmentQualityFactView>();
  for (const fact of qualityFacts.value) {
    if (fact?.operationRef) map.set(fact.operationRef, fact);
  }
  return map;
});

function enrichmentStatusText(status?: string): string {
  const normalized = (status ?? 'UNKNOWN').toUpperCase();
  const key = `gainosB4.leadsDetail.enrichment.status.${normalized}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? $t('gainosB4.leadsDetail.enrichment.status.UNKNOWN') : translated;
}

function enrichmentStatusTone(status?: string): GsTone {
  const normalized = (status ?? '').toUpperCase();
  if (normalized === 'COMPLETED') return 'success';
  if (normalized === 'RUNNING' || normalized === 'PREPARED' || normalized === 'APPLY_PENDING') return 'info';
  if (normalized === 'RESULT_UNKNOWN') return 'warning';
  if (normalized === 'FAILED') return 'danger';
  return 'neutral';
}

function enrichmentReasonText(code?: string): string {
  if (!code) return $t('gainosB4.leadsDetail.enrichment.reason.OTHER');
  const key = `gainosB4.leadsDetail.enrichment.reason.${code}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? $t('gainosB4.leadsDetail.enrichment.reason.OTHER') : translated;
}

function enrichmentEntrypointText(entrypoint?: string): string {
  return entrypoint === 'discovery_run'
    ? $t('gainosB4.leadsDetail.enrichment.entrypointDiscovery')
    : $t('gainosB4.leadsDetail.enrichment.entrypointHttp');
}

function isRecoverableEnrichment(status?: string): boolean {
  const normalized = (status ?? '').toUpperCase();
  return normalized === 'FAILED' || normalized === 'RESULT_UNKNOWN' || normalized === 'APPLY_PENDING';
}

function fmtMicrousd(raw?: string | null): string {
  if (raw === null || raw === undefined || raw === '') return '—';
  const n = Number(raw);
  if (!Number.isFinite(n)) return '—';
  return `$${(n / 1_000_000).toFixed(2)}`;
}

async function loadEnrichmentState(): Promise<void> {
  if (!props.companyId || !isAdmin.value) {
    enrichmentResults.value = [];
    qualityFacts.value = [];
    return;
  }
  enrichmentLoading.value = true;
  try {
    const [resultsPage, factsPage] = await Promise.all([
      gainosApi.contactEnrichmentResults(props.companyId).catch(() => ({ data: [] as ContactEnrichmentResultView[] })),
      gainosApi.contactEnrichmentQualityFacts(props.companyId).catch(() => ({ data: [] as ContactEnrichmentQualityFactView[] })),
    ]);
    enrichmentResults.value = Array.isArray(resultsPage?.data) ? resultsPage.data : [];
    qualityFacts.value = Array.isArray(factsPage?.data) ? factsPage.data : [];
  } finally {
    enrichmentLoading.value = false;
  }
}

async function toggleEnrichmentDetail(operationRef: string): Promise<void> {
  if (expandedOpRef.value === operationRef) {
    expandedOpRef.value = null;
    return;
  }
  expandedOpRef.value = operationRef;
  if (!isAdmin.value || enrichmentDetailMap.value[operationRef]) return;
  detailLoadingOpRef.value = operationRef;
  try {
    const [resDetail, factDetail] = await Promise.all([
      gainosApi.contactEnrichmentResultDetail(props.companyId, operationRef).catch(() => null),
      gainosApi.contactEnrichmentQualityFactDetail(props.companyId, operationRef).catch(() => null),
    ]);
    if (resDetail && typeof resDetail === 'object' && 'operationRef' in resDetail) {
      enrichmentDetailMap.value = { ...enrichmentDetailMap.value, [operationRef]: resDetail };
    }
    if (factDetail && typeof factDetail === 'object' && 'operationRef' in factDetail) {
      qualityFactDetailMap.value = { ...qualityFactDetailMap.value, [operationRef]: factDetail };
    }
  } finally {
    if (detailLoadingOpRef.value === operationRef) {
      detailLoadingOpRef.value = null;
    }
  }
}

async function recoverEnrichment(operationRef: string): Promise<void> {
  if (!isAdmin.value || recoveringOpRef.value) return;
  const confirmed = await new Promise<boolean>((resolve) => {
    feedback.confirm({
      title: $t('gainosB4.leadsDetail.enrichment.recoverConfirmTitle'),
      content: $t('gainosB4.leadsDetail.enrichment.recoverConfirmContent'),
      okText: $t('gainosB4.leadsDetail.enrichment.recoverBtn'),
      cancelText: $t('gainos.common.cancel'),
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
  if (!confirmed) return;
  recoveringOpRef.value = operationRef;
  try {
    const recovered = await gainosApi.recoverContactEnrichment(props.companyId, operationRef);
    if (recovered && typeof recovered === 'object' && 'operationRef' in recovered) {
      enrichmentDetailMap.value = { ...enrichmentDetailMap.value, [operationRef]: recovered };
    }
    setNotice($t('gainosB4.leadsDetail.enrichment.recoverSuccess'), 'success');
    await Promise.all([load(), loadEnrichmentState()]);
    emit('enrichment-updated');
  } catch (err) {
    const failure = failureText(err);
    setNotice(failure.title, 'error');
  } finally {
    recoveringOpRef.value = null;
  }
}

function isSwitchboardPlaceholder(contact: CanonicalContact): boolean {
  const name = contact.fullName?.trim().toLowerCase() ?? '';
  const title = contact.title?.trim().toLowerCase() ?? '';
  const dept = contact.department?.trim().toLowerCase() ?? '';
  return (
    dept === 'switchboard' ||
    title === 'switchboard' ||
    name === 'company switchboard' ||
    name.startsWith('company switchboard') ||
    name === 'switchboard'
  );
}

const allContacts = computed<CanonicalContact[]>(() => detail.value?.company.contacts ?? []);
const switchboardContacts = computed<CanonicalContact[]>(() =>
  allContacts.value.filter((contact) => isSwitchboardPlaceholder(contact)),
);
const contacts = computed<CanonicalContact[]>(() =>
  allContacts.value.filter((contact) => !isSwitchboardPlaceholder(contact)),
);

function socialPlatformLabel(platform: string): string {
  const key = `gainos.leads.socialPlatform.${platform.toLowerCase()}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? platform : translated;
}

const officialChannels = computed(() => {
  const emails: Array<{ tag?: string; value: string }> = [];
  const phones: string[] = [];
  const forms: string[] = [];
  const socials: Array<{ label: string; platform: string; url: string }> = [];
  const seenEmails = new Set<string>();
  const seenPhones = new Set<string>();
  const seenForms = new Set<string>();
  const seenSocials = new Set<string>();

  for (const ch of detail.value?.contactChannels ?? []) {
    const val = ch.value?.trim();
    if (!val) continue;
    if (ch.channel === 'email') {
      const key = val.toLowerCase();
      if (!seenEmails.has(key)) {
        seenEmails.add(key);
        emails.push({ value: val, tag: ch.email_type ?? undefined });
      }
    } else if (ch.channel === 'phone') {
      const key = val.replace(/\s+/g, '');
      if (!seenPhones.has(key)) {
        seenPhones.add(key);
        phones.push(val);
      }
    } else if (ch.channel === 'form_url' && safeUrl(val)) {
      if (!seenForms.has(val)) {
        seenForms.add(val);
        forms.push(val);
      }
    }
  }

  for (const pt of detail.value?.contactPoints ?? []) {
    const val = pt.value?.trim();
    if (!val) continue;
    if (safeUrl(val) && !seenForms.has(val)) {
      seenForms.add(val);
      forms.push(val);
    }
  }

  for (const sb of switchboardContacts.value) {
    for (const pt of sb.contactPoints ?? []) {
      const val = pt.value?.trim();
      if (!val || pt.status === 'INVALID') continue;
      if (pt.type === 'email') {
        const key = val.toLowerCase();
        if (!seenEmails.has(key)) {
          seenEmails.add(key);
          emails.push({ value: val });
        }
      } else if (pt.type === 'phone') {
        const key = val.replace(/\s+/g, '');
        if (!seenPhones.has(key)) {
          seenPhones.add(key);
          phones.push(val);
        }
      }
    }
  }

  for (const s of detail.value?.socialProfiles ?? []) {
    const url = safeUrl(s.url);
    if (!url || seenSocials.has(url)) continue;
    seenSocials.add(url);
    socials.push({
      platform: s.platform,
      label: socialPlatformLabel(s.platform),
      url,
    });
  }

  return { emails, phones, forms, socials };
});

const hasOfficialChannels = computed(
  () =>
    officialChannels.value.emails.length > 0 ||
    officialChannels.value.phones.length > 0 ||
    officialChannels.value.forms.length > 0 ||
    officialChannels.value.socials.length > 0,
);

function formatDate(value?: string | null): string {
  return formatDateValue(value);
}

function evidenceOf(contactId: string): ContactEvidence[] {
  return (detail.value?.evidence ?? []).filter((row) => row.entityId === contactId);
}

/** 该联系人的邮箱是否来自猜测（email.guess 证据）——UI 上标为「推断」。 */
function isGuessed(contact: CanonicalContact): boolean {
  return evidenceOf(contact.id).some((row) => row.field === 'email.guess');
}

/**
 * 引擎的 email.guess 证据只挂在联系人上、不带 point id；只有在「该联系人只有一个可用邮箱」时
 * 才能确定这个 RISKY 点就是推断值。多个邮箱时无法归因，按 RISKY 照实显示。
 */
function isGuessedEmailPoint(contact: CanonicalContact, point: CanonicalContactPoint): boolean {
  if (point.type !== 'email' || point.status !== 'RISKY' || !isGuessed(contact)) return false;
  const emails = (contact.contactPoints ?? []).filter(
    (item) => item.type === 'email' && item.status !== 'INVALID',
  );
  return emails.length === 1;
}

/** 状态文案只给业务词：不把引擎枚举码摆给用户（未登记的值才原样回退）。 */
function statusText(status: string): string {
  const key = `gainos.contacts.badge.${status}`;
  const translated = $t(key);
  return translated === key ? status : translated;
}

/** 联系方式状态：VALID / RISKY / 推断 / BLOCKED / INVALID / UNVERIFIED 一律照实显示。 */
function pointLabel(contact: CanonicalContact, point: CanonicalContactPoint): string {
  if (isGuessedEmailPoint(contact, point)) return $t('gainos.contacts.badge.PROBABLE');
  return statusText(point.status);
}

function pointTone(point: CanonicalContactPoint): GsTone {
  if (point.status === 'VALID') return 'success';
  if (point.status === 'RISKY') return 'warning';
  if (point.status === 'BLOCKED') return 'danger';
  return 'neutral';
}

function pointTypeLabel(type: string): string {
  const key = `gainos.contacts.type.${type}`;
  const translated = $t(key);
  return translated === key ? type : translated;
}

function layerLabel(license?: string): string {
  if (!license) return $t('gainos.contacts.layer.unknown');
  const key = `gainos.contacts.layer.${license}`;
  const translated = $t(key);
  return translated === key ? license : translated;
}

function seniorityLabel(seniority?: string | null): string {
  if (!seniority) return '';
  const key = `gainos.contacts.seniority.${seniority}`;
  const translated = $t(key);
  return translated === key ? seniority : translated;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function visiblePoints(contact: CanonicalContact): CanonicalContactPoint[] {
  return (contact.contactPoints ?? []).filter((point) => point.type !== 'external_id');
}

function pointHref(point: CanonicalContactPoint): string {
  if (point.type === 'linkedin' && /^https?:\/\//i.test(point.value)) return point.value;
  return '';
}

/** 链接类联系方式只显示去掉协议头的地址，避免长串 https:// 挤占一整行。 */
function displayValue(point: CanonicalContactPoint): string {
  return point.type === 'linkedin' ? point.value.replace(/^https?:\/\//i, '') : point.value;
}

interface ContactSource {
  key: string;
  url: string;
  layer: string;
  at: string;
}

/** 只把 http(s) 来源渲染成链接；引擎/来源页给的其它协议一律不点。 */
function safeUrl(value: string): string {
  return /^https?:\/\//i.test(value) ? value : '';
}

function evidenceUrlOf(row: ContactEvidence): string {
  const page = row.value?.source_page;
  return safeUrl(row.sourceUrl || (typeof page === 'string' ? page : ''));
}

/**
 * 每个联系人的来源面：优先 sourceUrl，其次 person.profile 的 source_page。
 * 带 URL 的行排在前面——联系点证据本身没有来源页，别让它挤掉唯一的来源链接。
 * 同一层级已有带链接的来源时，丢掉该层级不带链接的行（显示上完全重复，只是少了链接）；
 * 不同链接的来源全部保留。
 */
function contactSources(contact: CanonicalContact): ContactSource[] {
  const rows = evidenceOf(contact.id)
    .filter((row) => ['person.profile', 'email', 'phone', 'linkedin'].includes(row.field))
    .sort((a, b) => Date.parse(b.fetchedAt ?? '') - Date.parse(a.fetchedAt ?? ''));
  const ordered = [...rows.filter((row) => evidenceUrlOf(row)), ...rows.filter((row) => !evidenceUrlOf(row))];
  const out: ContactSource[] = [];
  const linkedLayers = new Set<string>();
  for (const row of ordered) {
    const url = evidenceUrlOf(row);
    const layer = layerLabel(row.license);
    const key = url ? `${url}|${layer}` : `none|${layer}`;
    if (out.some((item) => item.key === key)) continue;
    if (url) {
      linkedLayers.add(layer);
    } else if (linkedLayers.has(layer)) {
      continue;
    }
    out.push({ key, url, layer, at: formatDate(row.fetchedAt) });
    if (out.length >= 3) break;
  }
  return out;
}

function missingEmailCount(): number {
  return contacts.value.filter(
    (contact) =>
      !(contact.contactPoints ?? []).some((point) => point.type === 'email' && point.status === 'VALID'),
  ).length;
}

function enrichStatusLabel(status?: string): string {
  const normalized = (status ?? '').toUpperCase();
  if (normalized === 'COMMITTED') return $t('gainos.contacts.enrichStatus.committed');
  if (normalized === 'PARTIAL') return $t('gainos.contacts.enrichStatus.partial');
  if (normalized === 'NOT_ADMITTED') return $t('gainos.contacts.enrichStatus.notAdmitted');
  if (normalized === 'NO_HIT') return $t('gainos.contacts.enrichStatus.noHit');
  return $t('gainos.contacts.enrichStatus.failed');
}

function roleLine(contact: CanonicalContact): string {
  return [contact.title, contact.department].filter((part): part is string => !!part && part.trim() !== '').join(' · ');
}

/** 渲染行：模板里不再做字符串拼接/状态判断，只负责排版。 */
const rows = computed(() =>
  contacts.value.map((contact) => ({
    contact,
    id: contact.id,
    initials: initials(contact.fullName),
    name: contact.fullName,
    role: roleLine(contact) || $t('gainos.contacts.roleUnknown'),
    seniority: seniorityLabel(contact.seniority),
    points: visiblePoints(contact).map((point) => ({
      action: point.type === 'email',
      href: pointHref(point),
      id: point.id,
      label: pointLabel(contact, point),
      point,
      text: displayValue(point),
      tone: pointTone(point),
      type: pointTypeLabel(point.type),
      verifiedAt: point.verifiedAt ? formatDate(point.verifiedAt) : '',
    })),
    sources: contactSources(contact),
  })),
);

function setNotice(text: string, tone: NoticeTone = 'success'): void {
  notice.value = text;
  noticeTone.value = tone;
}

async function load(): Promise<void> {
  if (!props.companyId) return;
  await ensureLoaded();
  if (!isAdmin.value) {
    detail.value = null;
    enrichmentResults.value = [];
    qualityFacts.value = [];
    return;
  }
  loading.value = true;
  loadError.value = null;
  try {
    detail.value = await gainosApi.canonicalCompany(props.companyId);
    void loadEnrichmentState();
  } catch (error) {
    loadError.value = failureText(error);
    detail.value = null;
  } finally {
    loading.value = false;
  }
}

async function openDialog(kind: DialogKind, contact?: CanonicalContact, point?: CanonicalContactPoint): Promise<void> {
  actionError.value = null;
  notice.value = null;
  form.acknowledged = false;
  dialog.value = { kind, contact, point };
  if (!platformBasisLoaded) {
    try {
      platformBasis.value = (await gainosApi.complianceInfo())?.platform ?? null;
      platformBasisLoaded = true; // 仅成功才缓存；失败允许下次弹窗重试
    } catch {
      platformBasis.value = null;
    }
  }
}

function closeDialog(): void {
  if (busy.value) return;
  dialog.value = null;
  actionError.value = null;
}

/** antd Modal 的 v-model:open：关窗统一走 closeDialog（执行中不允许关）。 */
const dialogOpen = computed({
  get: () => dialog.value !== null,
  set: (open: boolean) => {
    if (!open) closeDialog();
  },
});

const dialogTitle = computed(() => {
  if (!dialog.value) return '';
  if (dialog.value.kind === 'discover') return $t('gainos.contacts.discoverTitle');
  if (dialog.value.kind === 'enrich') return $t('gainos.contacts.enrichTitle');
  if (dialog.value.kind === 'guess') return $t('gainos.contacts.guessTitle');
  return $t('gainos.contacts.verifyTitle');
});

const dialogDesc = computed(() => {
  if (!dialog.value) return '';
  if (dialog.value.kind === 'discover') return $t('gainos.contacts.discoverDesc');
  if (dialog.value.kind === 'enrich') return $t('gainos.contacts.enrichDesc');
  if (dialog.value.kind === 'guess') return $t('gainos.contacts.guessDesc');
  return $t('gainos.contacts.verifyDesc', { email: dialog.value.point?.value ?? '' });
});

const riskyTarget = computed(() => {
  if (!dialog.value || dialog.value.kind !== 'verify' || !dialog.value.point) return false;
  return dialog.value.point.status === 'RISKY';
});

const canSubmit = computed(() => {
  if (!dialog.value || busy.value) return false;
  if (riskyTarget.value && !form.acknowledged) return false;
  return true;
});

const basisText = computed(
  () => `${$t('gainos.contacts.lawfulBasis')}：${$t('gainos.contacts.platformBasis')}`,
);

async function submit(): Promise<void> {
  if (!dialog.value || !canSubmit.value) return;
  const current = dialog.value;
  busy.value = current.kind;
  actionError.value = null;
  try {
    if (current.kind === 'discover') {
      // 合法依据由 BFF 按租户声明自动注入（D6），请求体只带业务参数。
      const result = await gainosApi.discoverContacts(props.companyId, {
        attemptId: newAttemptId(),
      });
      setNotice($t('gainos.contacts.discoverDone', { count: result.contacts?.length ?? 0 }));
    } else if (current.kind === 'enrich') {
      const result = await gainosApi.enrichContacts(props.companyId, {
        attemptId: newAttemptId(),
      });
      if (result.reasonCode === 'NO_CONTACTS') {
        setNotice($t('gainos.contacts.enrichNoContacts'), 'info');
      } else {
        const tone: NoticeTone =
          result.status === 'COMMITTED' ? 'success' : result.status === 'NOT_ADMITTED' ? 'warning' : 'info';
        setNotice(
          $t('gainos.contacts.enrichDone', {
            status: enrichStatusLabel(result.status),
            attempted: result.attempted ?? result.results?.length ?? 0,
          }),
          tone,
        );
      }
    } else if (current.kind === 'guess') {
      const result = await gainosApi.guessEmails(props.companyId, {});
      setNotice(
        $t('gainos.contacts.guessDone', {
          attempted: result.attempted ?? 0,
          persisted: result.persisted ?? 0,
          verified: result.verified ?? 0,
        }),
      );
      if ((result.blocked ?? 0) > 0) {
        setNotice(
          `${notice.value} ${$t('gainos.contacts.guessBlocked', { count: result.blocked ?? 0 })}`,
          'warning',
        );
      }
    } else if (current.point) {
      const result = await gainosApi.verifyContactPoint(current.point.id, {});
      const status = result.verification?.status ?? result.status;
      if (status === 'BLOCKED') {
        setNotice($t('gainos.contacts.verifyBlocked'), 'warning');
      } else {
        setNotice(
          $t('gainos.contacts.verifyDone', { status: statusText(status) }),
          status === 'VALID' ? 'success' : 'warning',
        );
      }
    }
    dialog.value = null;
    await load();
    emit('enrichment-updated');
  } catch (error) {
    const failure = failureText(error);
    // 发现授权只绑定公司(不含 body),同一公司第二次发现必然 GRANT_REUSED;
    // 通用文案的"重新发起"在这里会误导,按事实说明。
    if (failure.code === 'EXECUTION_BUDGET_GRANT_REUSED' && current.kind === 'discover') {
      actionError.value = {
        title: failure.title,
        next: $t('gainos.contacts.discoverOnceHint'),
      };
    } else {
      actionError.value = failure;
    }
  } finally {
    busy.value = null;
  }
}

/**
 * 加载失败里的「授权对接未就绪」需要补一句给管理员的处理说明。
 * 英文界面下，服务端的中文原始说明会被换成按状态码的英文提示，原文只留在技术详情（code）里，
 * 所以标题和技术详情都看，换语言后这句说明不会丢。
 */
const needsScopeHint = computed(() => {
  const failure = loadError.value;
  return Boolean(
    failure?.title.includes('授权对接') || failure?.code?.includes('授权对接'),
  );
});

watch(
  () => [props.companyId, isAdmin.value],
  () => {
    void load();
  },
);

onMounted(() => {
  void load();
});
</script>

<template>
  <section
    aria-labelledby="dm-title"
    class="dm"
    data-gs="decision-makers"
  >
    <header class="dm__head">
      <div class="dm__head-main">
        <h2 class="dm__title" id="dm-title">{{ $t('gainos.contacts.title') }}</h2>
        <p class="dm__subtitle">{{ $t('gainos.contacts.subtitle') }}</p>
      </div>
      <Space :size="8" class="dm__head-actions" wrap>
        <Button
          v-if="contacts.length"
          :disabled="!!busy"
          :loading="busy === 'enrich'"
          data-gs="contacts-enrich"
          type="primary"
          @click="openDialog('enrich')"
        >
          {{ $t('gainos.contacts.enrich') }}
        </Button>
        <Button
          :disabled="!!busy"
          :loading="busy === 'discover'"
          data-gs="contacts-discover"
          :type="contacts.length ? 'default' : 'primary'"
          @click="openDialog('discover')"
        >
          {{ $t('gainos.contacts.discover') }}
        </Button>
      </Space>
    </header>

    <GsCard v-if="loading" data-gs="decision-makers-loading" padding="20px 24px">
      <Skeleton active :avatar="{ size: 44 }" :paragraph="{ rows: 3 }" />
      <span class="dm__sr-only">{{ $t('gainos.common.loading') }}</span>
    </GsCard>

    <div v-else-if="loadError" class="dm__state" data-gs="decision-makers-error">
      <ErrorNotice :next="loadError.next" :title="loadError.title" />
      <p v-if="needsScopeHint" class="dm__hint">{{ $t('gainos.contacts.scopeHint') }}</p>
      <Button class="dm__state-button" @click="load">{{ $t('gainos.common.refresh') }}</Button>
    </div>

    <template v-else>
      <Alert
        v-if="notice"
        :message="notice"
        :type="noticeTone"
        closable
        data-gs="contacts-notice"
        role="status"
        show-icon
        @close="notice = null"
      />

      <!-- 公司官方公开渠道与社媒（当外层线索详情页已独立渲染公开渠道时，避免重复展示） -->
      <GsCard v-if="!hideOfficialChannels && hasOfficialChannels" data-gs="official-channels" padding="18px 24px">
        <div class="dm-official">
          <div>
            <h3 class="dm-official__title">{{ $t('gainos.contacts.officialChannelsTitle') }}</h3>
            <p class="dm-official__subtitle">{{ $t('gainos.contacts.officialChannelsSubtitle') }}</p>
          </div>
          <div class="dm-official__grid">
            <div v-if="officialChannels.emails.length > 0" class="dm-official__group">
              <p class="dm-label">{{ $t('gainos.leads.channelEmailsTitle') }}</p>
              <ul class="dm-official__list">
                <li v-for="item in officialChannels.emails" :key="item.value" class="dm-official__item">
                  <a :href="`mailto:${item.value}`">{{ item.value }}</a>
                  <Tag v-if="item.tag" :bordered="false" class="dm-chip">{{ item.tag }}</Tag>
                </li>
              </ul>
            </div>
            <div v-if="officialChannels.phones.length > 0" class="dm-official__group">
              <p class="dm-label">{{ $t('gainos.leads.channelPhonesTitle') }}</p>
              <ul class="dm-official__list">
                <li v-for="phone in officialChannels.phones" :key="phone" class="dm-official__item">
                  <a :href="`tel:${phone}`">{{ phone }}</a>
                </li>
              </ul>
            </div>
            <div v-if="officialChannels.socials.length > 0" class="dm-official__group">
              <p class="dm-label">{{ $t('gainos.leads.channelSocialsTitle') }}</p>
              <div class="dm-official__socials">
                <a
                  v-for="social in officialChannels.socials"
                  :key="social.url"
                  class="dm-official__social-pill"
                  :href="social.url"
                  rel="noreferrer"
                  target="_blank"
                  :title="social.url"
                >
                  {{ social.label }}
                </a>
              </div>
            </div>
            <div v-if="officialChannels.forms.length > 0" class="dm-official__group">
              <p class="dm-label">{{ $t('gainos.leads.channelFormsTitle') }}</p>
              <ul class="dm-official__list">
                <li v-for="formUrl in officialChannels.forms" :key="formUrl" class="dm-official__item">
                  <a :href="formUrl" rel="noreferrer" target="_blank">{{ formUrl }}</a>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </GsCard>

      <GsCard v-if="rows.length === 0" data-gs="decision-makers-empty" padding="32px 24px">
        <GsEmpty :description="$t('gainos.contacts.emptyDesc')" :title="$t('gainos.contacts.emptyTitle')">
          <template #actions>
            <Button :disabled="!!busy" type="primary" @click="openDialog('discover')">
              {{ $t('gainos.contacts.emptyCta') }}
            </Button>
          </template>
        </GsEmpty>
      </GsCard>

      <template v-else>
        <Alert
          v-if="missingEmailCount() > 0"
          :message="$t('gainos.contacts.missingEmail', { count: missingEmailCount() })"
          data-gs="contacts-missing-email"
          show-icon
          type="info"
        >
          <template #action>
            <Button :disabled="!!busy" size="small" type="link" @click="openDialog('enrich')">
              {{ $t('gainos.contacts.enrich') }}
            </Button>
          </template>
        </Alert>

        <GsCard
          v-for="row in rows"
          :key="row.id"
          class="dm-person-card"
          data-gs="decision-maker"
          padding="18px 24px"
        >
          <!-- 三列网格必须挂在卡片内容的内层：antd Card 会把插槽再包一层 .ant-card-body -->
          <div class="dm-person">
          <!-- 人 -->
          <div class="dm-person__identity">
            <span aria-hidden="true" class="dm-person__avatar">{{ row.initials }}</span>
            <div class="min-w-0">
              <h3 class="dm-person__name">{{ row.name }}</h3>
              <p class="dm-person__role">{{ row.role }}</p>
              <Tag v-if="row.seniority" :bordered="false" class="dm-chip dm-person__seniority">
                {{ row.seniority }}
              </Tag>
            </div>
          </div>

          <!-- 联系方式 -->
          <ul v-if="row.points.length > 0" class="dm-points">
            <li v-for="point in row.points" :key="point.id" class="dm-point">
              <Tag :bordered="false" class="dm-chip dm-point__type">{{ point.type }}</Tag>
              <a
                v-if="point.href"
                class="dm-point__value"
                :href="point.href"
                rel="noreferrer"
                target="_blank"
                :title="point.text"
              >
                {{ point.text }}
              </a>
              <span v-else class="dm-point__value" :title="point.text">{{ point.text }}</span>
              <GsTag class="dm-point__badge" :tone="point.tone">{{ point.label }}</GsTag>
              <!-- 日期位常驻（无日期时留空），保证各行的状态药丸上下对齐 -->
              <span class="dm-point__date">{{ point.verifiedAt }}</span>
              <Button
                v-if="point.action"
                :disabled="!!busy"
                :loading="busy === 'verify'"
                class="dm-point__action"
                size="small"
                type="link"
                @click="openDialog('verify', row.contact, point.point)"
              >
                {{ $t('gainos.contacts.verify') }}
              </Button>
            </li>
          </ul>
          <p v-else class="dm-person__role dm-points">{{ $t('gainos.contacts.noPoints') }}</p>

          <!-- 来源 -->
          <div class="dm-sources">
            <p class="dm-label">{{ $t('gainos.contacts.source') }}</p>
            <template v-if="row.sources.length > 0">
              <p v-for="source in row.sources" :key="source.key" class="dm-source">
                <a v-if="source.url" :href="source.url" rel="noreferrer" target="_blank">
                  {{ source.layer }}
                </a>
                <span v-else>{{ source.layer }}</span>
                <span v-if="source.at" class="dm-source__at">{{ source.at }}</span>
              </p>
            </template>
            <p v-else class="dm-source dm-source--empty">{{ $t('gainos.contacts.sourceUnknown') }}</p>
          </div>
          </div>
        </GsCard>
      </template>

      <!-- B1 联系人补强进度、质量事实摘要与一键恢复（仅管理员可见） -->
      <GsCard
        :title="$t('gainosB4.leadsDetail.enrichment.title')"
        data-gs="enrichment-results-card"
        padding="18px 24px"
      >
        <template #extra>
          <Button
            :loading="enrichmentLoading"
            data-gs="enrichment-refresh-btn"
            size="small"
            @click="loadEnrichmentState"
          >
            {{ $t('gainosB4.leadsDetail.enrichment.refresh') }}
          </Button>
        </template>
        <p class="m-0 text-xs text-[var(--gs-fg-muted)]">
          {{ $t('gainosB4.leadsDetail.enrichment.subtitle') }}
        </p>

        <p v-if="enrichmentLoading && enrichmentResults.length === 0" class="mb-0 mt-3 text-xs text-[var(--gs-fg-subtle)]">
          {{ $t('gainosB4.leadsDetail.enrichment.loading') }}
        </p>
        <p v-else-if="enrichmentResults.length === 0" class="mb-0 mt-3 text-xs text-[var(--gs-fg-subtle)]">
          {{ $t('gainosB4.leadsDetail.enrichment.empty') }}
        </p>
        <ul v-else class="dm-enrich-list" data-gs="enrichment-results-list">
          <li
            v-for="item in enrichmentResults"
            :key="item.operationRef"
            class="dm-enrich-item"
            data-gs="enrichment-result-item"
          >
            <div class="dm-enrich-item__head">
              <Space :size="8" wrap>
                <GsTag :tone="enrichmentStatusTone(item.status)" data-gs="enrichment-item-status">
                  {{ enrichmentStatusText(item.status) }}
                </GsTag>
                <Tag :bordered="false" class="m-0 text-xs">
                  {{ enrichmentEntrypointText(item.entrypoint) }}
                </Tag>
                <span class="text-xs text-[var(--gs-fg-subtle)]">
                  {{ formatDateTime(item.createdAt) || '—' }}
                </span>
              </Space>
              <Space :size="6" wrap>
                <Button
                  v-if="isRecoverableEnrichment(item.status)"
                  :disabled="!!recoveringOpRef"
                  :loading="recoveringOpRef === item.operationRef"
                  data-gs="enrichment-recover-btn"
                  size="small"
                  type="primary"
                  @click="recoverEnrichment(item.operationRef)"
                >
                  {{
                    recoveringOpRef === item.operationRef
                      ? $t('gainosB4.leadsDetail.enrichment.recovering')
                      : $t('gainosB4.leadsDetail.enrichment.recoverBtn')
                  }}
                </Button>
                <Button
                  data-gs="enrichment-detail-btn"
                  size="small"
                  @click="toggleEnrichmentDetail(item.operationRef)"
                >
                  {{
                    expandedOpRef === item.operationRef
                      ? $t('gainosB4.leadsDetail.enrichment.hideDetailBtn')
                      : $t('gainosB4.leadsDetail.enrichment.detailBtn')
                  }}
                </Button>
              </Space>
            </div>

            <p class="dm-enrich-item__summary">
              {{
                $t('gainosB4.leadsDetail.enrichment.metricsSummary', {
                  attempted: item.summary?.physicallyAttemptedUniqueContacts ?? 0,
                  candidates: item.summary?.newCandidatePoints ?? 0,
                  considered: item.summary?.consideredUniqueContacts ?? 0,
                  eligible: item.summary?.eligibleUniqueContacts ?? 0,
                  unresolved: item.summary?.unresolvedUniqueContacts ?? 0,
                })
              }}
            </p>

            <p
              v-if="qualityFactDetailMap[item.operationRef] || qualityFactByOp.get(item.operationRef)"
              class="dm-enrich-item__quality"
              data-gs="enrichment-quality-summary"
            >
              {{
                $t('gainosB4.leadsDetail.enrichment.qualitySummary', {
                  covered: (qualityFactDetailMap[item.operationRef] ?? qualityFactByOp.get(item.operationRef))?.summary?.coveredUniqueContacts ?? 0,
                  org: (qualityFactDetailMap[item.operationRef] ?? qualityFactByOp.get(item.operationRef))?.summary?.organizationChannelContacts ?? 0,
                  unknown: (qualityFactDetailMap[item.operationRef] ?? qualityFactByOp.get(item.operationRef))?.summary?.unknownEmailTypeContacts ?? 0,
                })
              }}
            </p>

            <div v-if="(item.summary?.skippedByReason ?? []).length > 0" class="flex flex-wrap gap-1.5">
              <Tag
                v-for="bucket in item.summary.skippedByReason"
                :key="bucket.reasonCode"
                :bordered="false"
                class="m-0 text-xs"
              >
                {{ enrichmentReasonText(bucket.reasonCode) }} × {{ bucket.count }}
              </Tag>
            </div>

            <p v-if="item.spend" class="dm-enrich-item__spend">
              {{
                $t('gainosB4.leadsDetail.enrichment.spendLabel', {
                  charged: fmtMicrousd(item.spend.knownChargedMicrousd),
                  quoted: fmtMicrousd(item.spend.quotedUpperBoundMicrousd),
                })
              }}
            </p>

            <div
              v-if="expandedOpRef === item.operationRef"
              class="dm-enrich-detail"
              data-gs="enrichment-detail-panel"
            >
              <p v-if="detailLoadingOpRef === item.operationRef" class="m-0 text-xs text-[var(--gs-fg-subtle)]">
                {{ $t('gainosB4.leadsDetail.enrichment.detailLoading') }}
              </p>
              <template v-else>
                <p class="dm-label">{{ $t('gainosB4.leadsDetail.enrichment.detailPerContactTitle') }}</p>
                <ul
                  v-if="(enrichmentDetailMap[item.operationRef]?.perContact ?? item.perContact ?? []).length > 0"
                  class="dm-enrich-per-contact"
                >
                  <li
                    v-for="(row, idx) in (enrichmentDetailMap[item.operationRef]?.perContact ?? item.perContact ?? [])"
                    :key="`${item.operationRef}-${idx}`"
                    class="dm-enrich-per-contact__row"
                  >
                    <span>#{{ idx + 1 }}</span>
                    <Tag :bordered="false" class="m-0 text-xs">{{ enrichmentReasonText(row.reasonCode) }}</Tag>
                    <span class="text-xs text-[var(--gs-fg-muted)]">
                      {{
                        row.newCandidate
                          ? $t('gainosB4.leadsDetail.enrichment.detailNewCandidate')
                          : $t('gainosB4.leadsDetail.enrichment.detailNoNewCandidate')
                      }}
                    </span>
                  </li>
                </ul>
                <p v-else class="m-0 text-xs text-[var(--gs-fg-subtle)]">
                  {{ $t('gainosB4.leadsDetail.enrichment.detailNoContacts') }}
                </p>
                <details class="dm-enrich-tech">
                  <summary>{{ $t('gainosB4.leadsDetail.enrichment.detailTechSummary') }}</summary>
                  <code>{{ item.operationRef }}</code>
                </details>
              </template>
            </div>
          </li>
        </ul>
      </GsCard>
    </template>

    <!-- 发现 / 猜测 / 验证 的确认弹层 -->
    <Modal
      v-model:open="dialogOpen"
      :confirm-loading="busy !== null"
      :mask-closable="!busy"
      :ok-button-props="{ disabled: !canSubmit }"
      :ok-text="$t('gainos.contacts.submit')"
      :title="dialogTitle"
      :width="520"
      data-gs="contacts-modal"
      @ok="submit"
    >
      <div class="dm-dialog">
        <p class="dm-dialog__desc">{{ dialogDesc }}</p>
        <Alert
          v-if="riskyTarget"
          :message="$t('gainos.contacts.riskyWarning')"
          role="alert"
          show-icon
          type="warning"
        />
        <Alert :message="basisText" show-icon type="info">
          <template v-if="platformBasis?.ref" #description>
            {{ platformBasis.ref }}
          </template>
        </Alert>
        <Checkbox v-if="riskyTarget" v-model:checked="form.acknowledged" class="dm-dialog__ack">
          {{ $t('gainos.contacts.acknowledge') }}
        </Checkbox>
        <ErrorNotice
          v-if="actionError"
          :next="actionError.next"
          :title="actionError.title"
        />
      </div>
    </Modal>
  </section>
</template>

<style scoped>
.dm {
  display: grid;
  gap: 12px;
}
.dm__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 4px 0;
}
.dm__head-main {
  min-width: 0;
}
.dm__title {
  margin: 0;
  color: var(--gs-fg);
  font-size: 16px;
  line-height: 24px;
  font-weight: 600;
}
.dm__subtitle {
  margin: 4px 0 0;
  max-width: 720px;
  color: var(--gs-fg-muted);
  font-size: 13px;
  line-height: 20px;
}
.dm__head-actions {
  flex: none;
}
.dm__state {
  display: grid;
  gap: 10px;
}
.dm__state-button {
  justify-self: start;
}
.dm__hint {
  margin: 0;
  color: var(--gs-fg-muted);
  font-size: 12.5px;
  line-height: 1.7;
}
.dm__sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}

.dm-official {
  display: grid;
  gap: 14px;
}
.dm-official__title {
  margin: 0;
  color: var(--gs-fg);
  font-size: 14.5px;
  line-height: 22px;
  font-weight: 600;
}
.dm-official__subtitle {
  margin: 2px 0 0;
  color: var(--gs-fg-muted);
  font-size: 12.5px;
  line-height: 18px;
}
.dm-official__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px 20px;
}
.dm-official__group {
  min-width: 0;
}
.dm-official__list {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dm-official__item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
}
.dm-official__item a {
  color: var(--gs-accent-fg);
  text-decoration: none;
}
.dm-official__item a:hover {
  text-decoration: underline;
}
.dm-official__socials {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.dm-official__social-pill {
  padding: 2px 10px;
  border-radius: 6px;
  background: var(--gs-accent-soft);
  color: var(--gs-accent-fg);
  font-size: 12px;
  line-height: 20px;
  font-weight: 500;
  text-decoration: none;
}
.dm-official__social-pill:hover {
  text-decoration: underline;
}

/* ── 一位决策人 ──────────────────────────────────────────────────────────
   窄屏优先，按内容区实际宽度分级（容器查询）：默认三段竖排（人 / 联系方式 / 来源），
   ≥ 860px 才是「人 / 联系方式 / 来源」三列对齐（卡片内边距 48 + 三列最小 788）。 */
.dm-person {
  display: grid;
  grid-template-areas:
    'identity'
    'points'
    'sources';
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}
.dm-person__identity {
  grid-area: identity;
  display: flex;
  min-width: 0;
  gap: 12px;
  align-items: flex-start;
}
.dm-person__avatar {
  display: grid;
  flex: none;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--gs-accent-soft);
  color: var(--gs-accent-fg);
  font-size: 14px;
  font-weight: 600;
}
.dm-person__name {
  margin: 0;
  color: var(--gs-fg);
  font-size: 15px;
  line-height: 22px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.dm-person__role {
  margin: 2px 0 0;
  color: var(--gs-fg-muted);
  font-size: 12.5px;
  line-height: 18px;
}
.dm-person__seniority {
  margin-top: 6px;
}

.dm-chip {
  flex: none;
  margin: 0;
  padding-inline: 8px;
  border-radius: 6px;
  background: var(--gs-surface-2);
  color: var(--gs-fg-muted);
  font-size: 12px;
  line-height: 22px;
}

.dm-points {
  grid-area: points;
  display: grid;
  gap: 4px;
  min-width: 0;
  margin: 0;
  padding: 12px 0 0;
  border-top: 1px solid var(--gs-divider);
  list-style: none;
}
/* 窄内容区放不下一整行时，状态 / 日期 / 操作折到第二行 */
.dm-point {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
  min-width: 0;
  min-height: 32px;
}
.dm-point__value {
  flex: 1 1 140px;
}
.dm-point__type {
  /* 等宽：邮箱 / 电话 / LinkedIn 后面的值从同一位置起排 */
  box-sizing: border-box;
  width: 68px;
  padding-inline: 0;
  text-align: center;
}
.dm-point__value {
  min-width: 0;
  overflow: hidden;
  color: var(--gs-fg);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
a.dm-point__value {
  color: var(--gs-accent-fg);
  text-decoration: none;
}
a.dm-point__value:hover {
  text-decoration: underline;
}
.dm-point__badge {
  flex: none;
}
.dm-point__date {
  flex: none;
  min-width: 80px;
  color: var(--gs-fg-subtle);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.dm-point__action {
  flex: none;
  padding-inline: 6px;
}

.dm-sources {
  grid-area: sources;
  display: grid;
  align-content: start;
  gap: 2px;
  min-width: 0;
  padding-top: 12px;
  border-top: 1px solid var(--gs-divider);
}
.dm-label {
  margin: 0 0 4px;
  color: var(--gs-fg-muted);
  font-size: 12px;
  line-height: 18px;
}
.dm-source {
  margin: 0;
  color: var(--gs-fg-muted);
  font-size: 12.5px;
  line-height: 20px;
  overflow-wrap: anywhere;
}
.dm-source a {
  color: var(--gs-accent-fg);
  text-decoration: none;
}
.dm-source a:hover {
  text-decoration: underline;
}
.dm-source__at {
  margin-left: 8px;
  color: var(--gs-fg-subtle);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.dm-source--empty {
  color: var(--gs-fg-subtle);
}

/* ── 弹层 ────────────────────────────────────────────────────────────── */
.dm-dialog {
  display: grid;
  gap: 12px;
}
.dm-dialog__desc {
  margin: 0;
  color: var(--gs-fg-muted);
  font-size: 13px;
  line-height: 1.7;
}
.dm-dialog__ack {
  font-size: 13px;
  line-height: 1.6;
}
.dm-enrich-list {
  display: grid;
  gap: 10px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}
.dm-enrich-item {
  display: grid;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--gs-border);
  border-radius: 10px;
  background: var(--gs-surface-2);
}
.dm-enrich-item__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.dm-enrich-item__summary {
  margin: 0;
  font-size: 12.5px;
  color: var(--gs-fg);
}
.dm-enrich-item__quality {
  margin: 0;
  font-size: 12px;
  color: var(--gs-fg-2);
}
.dm-enrich-item__spend {
  margin: 0;
  font-size: 11.5px;
  color: var(--gs-fg-muted);
}
.dm-enrich-detail {
  display: grid;
  gap: 8px;
  margin-top: 6px;
  padding-top: 10px;
  border-top: 1px solid var(--gs-border);
}
.dm-enrich-per-contact {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dm-enrich-per-contact__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--gs-fg);
}
.dm-enrich-tech {
  font-size: 11.5px;
  color: var(--gs-fg-subtle);
}
.dm-enrich-tech summary {
  cursor: pointer;
}
.dm-enrich-tech code {
  display: block;
  margin-top: 4px;
  word-break: break-all;
}

@container (min-width: 860px) {
  .dm-person {
    grid-template-areas: 'identity points sources';
    grid-template-columns: 300px minmax(0, 1fr) 220px;
    column-gap: 24px;
  }
  .dm-points,
  .dm-sources {
    padding-top: 0;
    border-top: 0;
  }
  .dm-point {
    flex-wrap: nowrap;
  }
  .dm-point__value {
    flex: 1 1 auto;
  }
}

</style>
