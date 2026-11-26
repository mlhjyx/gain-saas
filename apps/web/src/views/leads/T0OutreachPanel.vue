<script lang="ts" setup>
/**
 * T0 四通道轻外联工作台（Phase 1）：
 * 无需配置企业发信邮箱，直接基于公司官方渠道与联系人发起 4 条合规轻触达动作：
 * 1) 本地邮箱客户端预填（mailto:）；
 * 2) 领英 Co-Pilot（直达主页/搜索 + 一键复制 ≤300 字破冰话术）；
 * 3) 合规 WhatsApp（wa.me，仅温热白名单市场 + 有效号码 + 非禁联时开放）；
 * 4) 官网联系表单直达 + 一键复制正文；
 * 并提供轻量触达留痕（服务端脱敏落库，已跟进线索同步回写结果）。
 */
import type {
  CanonicalContact,
  LeadPackage,
  T0CheckResult,
  T0TouchRecord,
} from '#/api/gainos';
import type {
  SignalIcebreakerSuggestion,
  T0EvaluationResult,
  T0ChannelKey,
} from '@gain-saas/shared';

import { computed, onMounted, ref, watch } from 'vue';

import {
  buildLinkedInIcebreaker,
  buildMailtoHref,
  buildWhatsappHref,
  evaluateT0Channels,
  formatDateTime,
  insertIcebreakerIntoBody,
  isSafeHttpUrl,
  isSafeLinkedinUrl,
  normalizeIcebreakerSuggestions,
} from '@gain-saas/shared';
import { preferences } from '@vben/preferences';
import { Alert, Button, Input, Space, Tag } from 'ant-design-vue';

import GsCard from '#/components/gainos/ui/gs-card.vue';
import GsSelect from '#/components/gainos/ui/gs-select.vue';
import GsTag from '#/components/gainos/ui/gs-tag.vue';
import { failureText, gainosApi } from '#/api/gainos';
import { feedback } from '#/feedback';
import { $t } from '#/locales';

defineOptions({ name: 'T0OutreachPanel' });

const props = defineProps<{
  draft?: Record<string, unknown> | null;
  isAdmin?: boolean;
  pkg: LeadPackage;
}>();

interface TargetOption {
  contactName: string;
  contactRef: string;
  email: string;
  key: string;
  label: string;
  linkedinUrl: string;
  phone: string;
}

const namedContacts = ref<CanonicalContact[]>([]);
const selectedTargetKey = ref('');
const subject = ref('');
const body = ref('');
const icebreaker = ref('');
const copyDirty = ref(false);

const serverCheck = ref<T0CheckResult | null>(null);
const checking = ref(true);
let complianceCheckSeq = 0;
let mountedReady = false;

const touches = ref<T0TouchRecord[]>([]);
const touchesLoading = ref(false);
const touchChannel = ref<T0ChannelKey>('mailto');
const touchOutcome = ref<'OPENED' | 'REPLIED' | 'SENT'>('SENT');
const touchNote = ref('');
const recordingTouch = ref(false);

const companyName = computed(() => props.pkg.company.name || '');
const countryCode = computed(() => props.pkg.company.country ?? '');
const signalIcebreakers = computed<SignalIcebreakerSuggestion[]>(() =>
  normalizeIcebreakerSuggestions(props.pkg),
);
const signalLang = ref<'en' | 'zh'>(String(preferences.app.locale || '').startsWith('zh') ? 'zh' : 'en');

function signalTypeLabel(signalType: string): string {
  const key = `gainos.leads.signalIcebreaker.type.${signalType}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? $t('gainos.leads.signalIcebreaker.type.DEFAULT') : translated;
}

function insertSignalOpener(item: SignalIcebreakerSuggestion): void {
  if (interactionBlocked.value) return;
  const opener = signalLang.value === 'zh' ? item.openerZh : item.openerEn;
  body.value = insertIcebreakerIntoBody(opener, body.value);
  icebreaker.value = insertIcebreakerIntoBody(opener, icebreaker.value).slice(0, 300);
  copyDirty.value = true;
  feedback.message.success($t('gainos.leads.signalIcebreaker.inserted'));
}
const sanctionsHold = computed(() => {
  const value = props.pkg.sanctions?.status;
  return value === 'potential_match' || value === 'confirmed_true_hit';
});
const leadSuppressed = computed(() => props.pkg.status === 'SUPPRESSED');

const companyLinkedinUrl = computed(() => {
  const match = (props.pkg.social_profiles ?? []).find(
    (item) => item.platform?.toLowerCase() === 'linkedin' && isSafeLinkedinUrl(item.url),
  );
  return match?.url ?? '';
});

const companyWhatsappUrl = computed(() => {
  const match = (props.pkg.social_profiles ?? []).find(
    (item) => item.platform?.toLowerCase() === 'whatsapp' && item.url,
  );
  return match?.url ?? '';
});

const primaryFormUrl = computed(() => {
  for (const ch of props.pkg.company_channels ?? []) {
    if (ch.channel === 'form_url' && isSafeHttpUrl(ch.value)) return ch.value;
  }
  for (const pt of props.pkg.contact_points ?? []) {
    if (isSafeHttpUrl(pt.url)) return pt.url;
  }
  if (props.pkg.suggested_contact_path && isSafeHttpUrl(props.pkg.suggested_contact_path.url)) {
    return props.pkg.suggested_contact_path.url;
  }
  return '';
});

const companyPhones = computed(() =>
  (props.pkg.company_channels ?? [])
    .filter((item) => item.channel === 'phone' && item.value)
    .map((item) => item.value),
);

const companyEmails = computed(() =>
  (props.pkg.company_channels ?? [])
    .filter((item) => item.channel === 'email' && item.value)
    .map((item) => item.value),
);

const targetOptions = computed<TargetOption[]>(() => {
  const options: TargetOption[] = [];
  const seenEmails = new Set<string>();

  for (const contact of namedContacts.value) {
    const points = contact.contactPoints ?? [];
    const usableEmails = points.filter(
      (pt) =>
        String(pt.type ?? '').toLowerCase() === 'email' &&
        pt.value &&
        pt.status !== 'INVALID' &&
        pt.status !== 'BLOCKED',
    );
    const bestEmail =
      usableEmails.find((pt) => pt.status === 'VALID') ?? usableEmails[0] ?? null;
    const phonePt = points.find((pt) => String(pt.type ?? '').toLowerCase() === 'phone' && pt.value);
    const liPt = points.find((pt) => String(pt.type ?? '').toLowerCase() === 'linkedin' && pt.value);
    const email = bestEmail?.value ?? '';
    if (email) seenEmails.add(email.toLowerCase());
    const roleSuffix = contact.title ? ` · ${contact.title}` : '';
    const emailSuffix = email ? ` (${email})` : '';
    options.push({
      key: `contact:${contact.id}`,
      contactRef: contact.id,
      contactName: contact.fullName,
      email,
      phone: phonePt?.value ?? companyPhones.value[0] ?? '',
      linkedinUrl: (liPt?.value && isSafeLinkedinUrl(liPt.value) ? liPt.value : '') || companyLinkedinUrl.value,
      label: `${contact.fullName}${roleSuffix}${emailSuffix}`,
    });
  }

  for (const email of companyEmails.value) {
    if (seenEmails.has(email.toLowerCase())) continue;
    seenEmails.add(email.toLowerCase());
    options.push({
      key: `company-email:${email}`,
      contactRef: props.pkg.lead_id,
      contactName: '',
      email,
      phone: companyPhones.value[0] ?? '',
      linkedinUrl: companyLinkedinUrl.value,
      label: `${$t('gainos.leads.t0.officialEmailPrefix')} · ${email}`,
    });
  }

  if (options.length === 0) {
    options.push({
      key: 'company-fallback',
      contactRef: props.pkg.lead_id,
      contactName: '',
      email: '',
      phone: companyPhones.value[0] ?? '',
      linkedinUrl: companyLinkedinUrl.value,
      label: companyName.value || $t('gainos.leads.unknownCompany'),
    });
  }

  return options;
});

const activeTarget = computed<TargetOption>(() => {
  return (
    targetOptions.value.find((item) => item.key === selectedTargetKey.value) ??
    targetOptions.value[0]!
  );
});

const localEvaluation = computed<T0EvaluationResult>(() =>
  evaluateT0Channels({
    countryCode: countryCode.value,
    companyName: companyName.value,
    contactName: activeTarget.value.contactName,
    email: activeTarget.value.email,
    phone: activeTarget.value.phone,
    whatsappUrl: companyWhatsappUrl.value,
    linkedinUrl: activeTarget.value.linkedinUrl,
    formUrl: primaryFormUrl.value,
    suppressed: leadSuppressed.value,
    sanctionsHold: sanctionsHold.value,
  }),
);

const evaluation = computed<T0EvaluationResult>(() => serverCheck.value ?? localEvaluation.value);
const interactionBlocked = computed(() => checking.value || evaluation.value.blockedAll);
const suppressionReasons = computed(() => serverCheck.value?.suppressionReasons ?? []);

function buildFailClosedResult(): T0CheckResult {
  const evaluated = evaluateT0Channels({
    countryCode: countryCode.value,
    companyName: companyName.value,
    contactName: activeTarget.value.contactName,
    email: activeTarget.value.email,
    phone: activeTarget.value.phone,
    whatsappUrl: companyWhatsappUrl.value,
    linkedinUrl: activeTarget.value.linkedinUrl,
    formUrl: primaryFormUrl.value,
    suppressed: leadSuppressed.value,
    sanctionsHold: sanctionsHold.value,
    dncCheckFailed: true,
  });
  return {
    ...evaluated,
    recommendedSequence: [...evaluated.recommendedSequence],
    consentStatus: 'UNKNOWN',
    suppressionReasons: [],
  };
}

function extractDraftParts(draftRecord?: Record<string, unknown> | null): {
  body: string;
  subject: string;
} {
  if (!draftRecord || typeof draftRecord !== 'object') {
    const name = companyName.value || 'your team';
    return {
      subject: `B2B Supply Inquiry — ${name}`,
      body: `Hello ${name} team,\n\nWe noticed your work in our sector and would be glad to share product specifications, certifications, and lead times for your review.\n\nBest regards,`,
    };
  }
  const subj =
    typeof draftRecord.subject === 'string' && draftRecord.subject.trim()
      ? draftRecord.subject.trim()
      : `B2B Supply Inquiry — ${companyName.value || 'your team'}`;
  const rawBody =
    (typeof draftRecord.body === 'string' && draftRecord.body.trim()) ||
    (typeof draftRecord.text === 'string' && draftRecord.text.trim()) ||
    '';
  return {
    subject: subj,
    body:
      rawBody ||
      `Hello ${companyName.value || 'your team'} team,\n\nWe would be glad to share our product specifications and quotation upon request.\n\nBest regards,`,
  };
}

function hydrateCopy(force = false): void {
  if (copyDirty.value && !force) return;
  const parts = extractDraftParts(props.draft);
  subject.value = parts.subject;
  body.value = parts.body;
  icebreaker.value = buildLinkedInIcebreaker({
    companyName: companyName.value,
    contactName: activeTarget.value.contactName,
    body: parts.body,
  });
}

function reasonCopy(code: string | null): string {
  if (!code) return '';
  const key = `gainos.leads.t0.reason.${code}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? $t('gainos.leads.t0.reason.DEFAULT') : translated;
}

function channelLabel(channel: T0ChannelKey): string {
  return $t(`gainos.leads.t0.channel.${channel}`);
}

const mailtoHref = computed(() => {
  if (!evaluation.value.channels.mailto.allowed || !activeTarget.value.email) return null;
  return buildMailtoHref(activeTarget.value.email, subject.value, body.value);
});

const whatsappHref = computed(() => {
  if (!evaluation.value.channels.whatsapp.allowed) return null;
  const phone =
    evaluation.value.channels.whatsapp.normalizedPhone ??
    companyWhatsappUrl.value ??
    activeTarget.value.phone;
  if (!phone) return null;
  return buildWhatsappHref(phone, body.value);
});

const linkedinHref = computed(() =>
  evaluation.value.channels.linkedin.allowed ? evaluation.value.channels.linkedin.url : null,
);

const formHref = computed(() =>
  evaluation.value.channels.form.allowed ? evaluation.value.channels.form.url : null,
);

const recommendedText = computed(() =>
  evaluation.value.recommendedSequence.map((ch) => channelLabel(ch)).join(' → '),
);

async function copyText(text: string): Promise<boolean> {
  if (!text.trim()) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function runComplianceCheck(): Promise<void> {
  const seq = ++complianceCheckSeq;
  checking.value = true;
  try {
    const res = await gainosApi.checkT0Outreach({
      leadId: props.pkg.lead_id,
      contactRef: activeTarget.value.contactRef,
      countryCode: countryCode.value || undefined,
      companyName: companyName.value || undefined,
      contactName: activeTarget.value.contactName || undefined,
      email: activeTarget.value.email || undefined,
      phone: activeTarget.value.phone || undefined,
      whatsappUrl: companyWhatsappUrl.value || undefined,
      linkedinUrl: activeTarget.value.linkedinUrl || undefined,
      formUrl: primaryFormUrl.value || undefined,
      leadStatus: props.pkg.status,
      sanctionsHold: sanctionsHold.value,
    });
    if (seq !== complianceCheckSeq) return;
    serverCheck.value =
      res && typeof res === 'object' && res.channels && typeof res.channels.mailto?.allowed === 'boolean'
        ? res
        : buildFailClosedResult();
  } catch {
    if (seq !== complianceCheckSeq) return;
    // 严格 fail-closed：服务端 DNC / 合规门禁接口不可用时阻断全部触达动作，不得回落乐观放行。
    serverCheck.value = buildFailClosedResult();
  } finally {
    if (seq === complianceCheckSeq) {
      checking.value = false;
    }
  }
}

async function loadContacts(): Promise<void> {
  if (!props.isAdmin || !props.pkg.company.canonical_company_id) return;
  try {
    const detail = await gainosApi.canonicalCompany(props.pkg.company.canonical_company_id);
    namedContacts.value = detail?.company?.contacts ?? [];
  } catch {
    namedContacts.value = [];
  }
}

async function loadTouches(): Promise<void> {
  touchesLoading.value = true;
  try {
    const rows = await gainosApi.listT0Touches(props.pkg.lead_id);
    touches.value = Array.isArray(rows) ? rows : [];
  } catch {
    touches.value = [];
  } finally {
    touchesLoading.value = false;
  }
}

function targetForChannel(channel: T0ChannelKey): string | undefined {
  if (channel === 'mailto') return activeTarget.value.email || undefined;
  if (channel === 'linkedin') return linkedinHref.value || undefined;
  if (channel === 'whatsapp') return activeTarget.value.phone || companyWhatsappUrl.value || undefined;
  return formHref.value || undefined;
}

async function saveTouch(
  channel: T0ChannelKey,
  outcome: 'COPIED' | 'OPENED' | 'REPLIED' | 'SENT',
  note?: string,
  silent = false,
): Promise<void> {
  if (interactionBlocked.value) return;
  recordingTouch.value = true;
  try {
    const created = await gainosApi.recordT0Touch({
      leadId: props.pkg.lead_id,
      channel,
      target: targetForChannel(channel),
      note: note?.trim() || undefined,
      outcome,
    });
    touches.value = [created, ...touches.value.filter((item) => item.id !== created.id)];
    if (props.pkg.status === 'QUALIFIED') {
      void gainosApi
        .leadOutcome(props.pkg.lead_id, {
          contacted: true,
          note: note?.trim() || `${channelLabel(channel)} (${outcome})`,
        })
        .catch(() => undefined);
    }
    if (!silent) {
      feedback.message.success($t('gainos.leads.t0.touchSaved'));
    }
  } catch (err) {
    if (!silent) {
      feedback.message.error(failureText(err).title);
    }
  } finally {
    recordingTouch.value = false;
  }
}

function openMailto(): void {
  if (interactionBlocked.value || !mailtoHref.value) return;
  touchChannel.value = 'mailto';
  window.location.href = mailtoHref.value;
  void saveTouch('mailto', 'OPENED', undefined, true);
  feedback.message.success($t('gainos.leads.t0.mailtoOpened'));
}

async function openLinkedinCopilot(): Promise<void> {
  if (interactionBlocked.value || !linkedinHref.value) return;
  touchChannel.value = 'linkedin';
  const copiedOk = await copyText(icebreaker.value);
  window.open(linkedinHref.value, '_blank', 'noopener,noreferrer');
  void saveTouch('linkedin', 'OPENED', undefined, true);
  feedback.message.success(
    copiedOk ? $t('gainos.leads.t0.linkedinCopiedAndOpened') : $t('gainos.leads.t0.linkedinOpened'),
  );
}

async function copyIcebreakerOnly(): Promise<void> {
  if (interactionBlocked.value) return;
  const ok = await copyText(icebreaker.value);
  if (ok) feedback.message.success($t('gainos.leads.copied'));
}

function openWhatsapp(): void {
  if (interactionBlocked.value || !whatsappHref.value) return;
  touchChannel.value = 'whatsapp';
  window.open(whatsappHref.value, '_blank', 'noopener,noreferrer');
  void saveTouch('whatsapp', 'OPENED', undefined, true);
  feedback.message.success($t('gainos.leads.t0.whatsappOpened'));
}

async function openFormWithCopy(): Promise<void> {
  if (interactionBlocked.value || !formHref.value) return;
  touchChannel.value = 'form';
  const copiedOk = await copyText(body.value);
  window.open(formHref.value, '_blank', 'noopener,noreferrer');
  void saveTouch('form', 'OPENED', undefined, true);
  feedback.message.success(
    copiedOk ? $t('gainos.leads.t0.formCopiedAndOpened') : $t('gainos.leads.t0.formOpened'),
  );
}

async function submitManualTouch(): Promise<void> {
  if (interactionBlocked.value) return;
  await saveTouch(touchChannel.value, touchOutcome.value, touchNote.value);
  touchNote.value = '';
}

watch(
  () => props.draft,
  () => hydrateCopy(false),
);

watch(
  () => targetOptions.value,
  (options) => {
    if (!options.some((item) => item.key === selectedTargetKey.value)) {
      selectedTargetKey.value = options[0]?.key ?? '';
    }
  },
  { immediate: true },
);

watch(
  () => [props.pkg.lead_id, selectedTargetKey.value],
  () => {
    if (mountedReady) {
      void runComplianceCheck();
    }
    if (!copyDirty.value) {
      icebreaker.value = buildLinkedInIcebreaker({
        companyName: companyName.value,
        contactName: activeTarget.value.contactName,
        body: body.value,
      });
    }
  },
);

onMounted(async () => {
  hydrateCopy(true);
  void loadTouches();
  await loadContacts();
  mountedReady = true;
  await runComplianceCheck();
});
</script>

<template>
  <GsCard id="t0-outreach" data-gs="t0-outreach">
    <template #title>
      <div class="flex flex-wrap items-center gap-2">
        <span>{{ $t('gainos.leads.t0.title') }}</span>
        <GsTag :tone="evaluation.blockedAll ? 'danger' : evaluation.channels.mailto.allowed ? 'success' : 'warning'">
          {{ evaluation.complianceTag }}
        </GsTag>
      </div>
    </template>
    <template #extra>
      <span v-if="recommendedText && !evaluation.blockedAll" class="text-xs text-[var(--gs-fg-subtle)]">
        {{ $t('gainos.leads.t0.recommendedPath', { path: recommendedText }) }}
      </span>
    </template>

    <div class="grid gap-4">
      <p class="m-0 text-xs text-[var(--gs-fg-muted)]">
        {{ $t('gainos.leads.t0.subtitle') }}
      </p>

      <Alert
        v-if="evaluation.blockedAll"
        :description="suppressionReasons.length > 0 ? suppressionReasons.join(' · ') : undefined"
        :message="reasonCopy(evaluation.blockCode)"
        data-gs="t0-blocked-banner"
        role="alert"
        show-icon
        type="error"
      />

      <Alert
        v-else-if="evaluation.channels.mailto.reasonCode === 'JURISDICTION_CONSENT_REQUIRED'"
        :message="$t('gainos.leads.t0.strictCountryBanner', { country: countryCode || '—' })"
        data-gs="t0-jurisdiction-banner"
        role="status"
        show-icon
        type="warning"
      />

      <!-- 触达对象选择 -->
      <div v-if="targetOptions.length > 1" class="grid gap-1.5">
        <label class="text-xs font-medium text-[var(--gs-fg-2)]">
          {{ $t('gainos.leads.t0.targetLabel') }}
        </label>
        <GsSelect
          v-model="selectedTargetKey"
          :ariaLabel="$t('gainos.leads.t0.targetLabel')"
          :options="targetOptions.map((item) => ({ label: item.label, value: item.key }))"
          class="w-full"
          data-gs="t0-target-select"
        />
      </div>

      <!-- Phase 3B：真实信号驱动的零捏造破冰首句 -->
      <div
        v-if="signalIcebreakers.length > 0"
        class="t0-signals"
        data-gs="t0-signal-icebreakers"
      >
        <div class="t0-signals__head">
          <div>
            <span class="text-xs font-semibold text-[var(--gs-fg)]">
              {{ $t('gainos.leads.signalIcebreaker.title') }}
            </span>
            <p class="m-0 text-xs text-[var(--gs-fg-subtle)]">
              {{ $t('gainos.leads.signalIcebreaker.hint') }}
            </p>
          </div>
          <Space :size="4">
            <Button
              :type="signalLang === 'zh' ? 'primary' : 'default'"
              data-gs="t0-signal-lang-zh"
              size="small"
              @click="signalLang = 'zh'"
            >
              {{ $t('gainos.leads.signalIcebreaker.langZh') }}
            </Button>
            <Button
              :type="signalLang === 'en' ? 'primary' : 'default'"
              data-gs="t0-signal-lang-en"
              size="small"
              @click="signalLang = 'en'"
            >
              {{ $t('gainos.leads.signalIcebreaker.langEn') }}
            </Button>
          </Space>
        </div>
        <ul class="t0-signals__list">
          <li
            v-for="(sig, idx) in signalIcebreakers"
            :key="`${sig.signalType}-${idx}`"
            class="t0-signals__item"
            data-gs="t0-signal-item"
          >
            <div class="grid gap-1">
              <Space :size="6" wrap>
                <Tag :bordered="false" class="m-0 text-xs" color="blue">
                  {{ signalTypeLabel(sig.signalType) }}
                </Tag>
                <span class="text-xs font-medium text-[var(--gs-fg)]">{{ sig.signalTitle }}</span>
                <span v-if="sig.detectedAt" class="text-xs text-[var(--gs-fg-subtle)]">
                  {{ formatDateTime(sig.detectedAt) }}
                </span>
                <a
                  v-if="sig.signalUrl"
                  :href="sig.signalUrl"
                  class="text-xs text-[var(--gs-accent)] underline"
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {{ $t('gainos.leads.signalIcebreaker.sourceLink') }}
                </a>
              </Space>
              <p class="m-0 text-xs text-[var(--gs-fg-2)]" data-gs="t0-signal-opener-text">
                {{ signalLang === 'zh' ? sig.openerZh : sig.openerEn }}
              </p>
            </div>
            <Button
              :disabled="interactionBlocked"
              data-gs="t0-insert-icebreaker"
              size="small"
              type="primary"
              @click="insertSignalOpener(sig)"
            >
              {{ $t('gainos.leads.signalIcebreaker.insert') }}
            </Button>
          </li>
        </ul>
      </div>

      <!-- 可编辑外联话术 -->
      <div class="grid gap-3 @min-[760px]:grid-cols-2">
        <div class="grid gap-2">
          <label class="grid gap-1 text-xs font-medium text-[var(--gs-fg-2)]">
            <span>{{ $t('gainos.leads.t0.subjectLabel') }}</span>
            <Input
              v-model:value="subject"
              :disabled="evaluation.blockedAll"
              :maxlength="300"
              data-gs="t0-subject"
              @change="copyDirty = true"
            />
          </label>
          <label class="grid gap-1 text-xs font-medium text-[var(--gs-fg-2)]">
            <span>{{ $t('gainos.leads.t0.bodyLabel') }}</span>
            <Input.TextArea
              v-model:value="body"
              :disabled="evaluation.blockedAll"
              :maxlength="6000"
              :rows="5"
              data-gs="t0-body"
              @change="copyDirty = true"
            />
          </label>
        </div>

        <div class="grid content-start gap-2">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-medium text-[var(--gs-fg-2)]">
              {{ $t('gainos.leads.t0.icebreakerLabel') }}
            </span>
            <span class="text-xs tabular-nums text-[var(--gs-fg-subtle)]">
              {{ icebreaker.length }} / 300
            </span>
          </div>
          <Input.TextArea
            v-model:value="icebreaker"
            :disabled="evaluation.blockedAll"
            :maxlength="300"
            :rows="4"
            data-gs="t0-icebreaker"
            @change="copyDirty = true"
          />
          <div class="flex justify-end">
            <Button
              :disabled="interactionBlocked || !icebreaker.trim()"
              size="small"
              @click="copyIcebreakerOnly"
            >
              {{ $t('gainos.leads.t0.copyIcebreaker') }}
            </Button>
          </div>
        </div>
      </div>

      <!-- 4 条合规轻外联动作 -->
      <div class="grid gap-3 @min-[680px]:grid-cols-2">
        <!-- 1. mailto -->
        <div class="t0-tile" :class="{ 'is-disabled': !evaluation.channels.mailto.allowed || checking }">
          <div class="t0-tile__head">
            <span class="t0-tile__title">{{ $t('gainos.leads.t0.channel.mailto') }}</span>
            <Tag :bordered="false" class="m-0 text-xs">
              {{ activeTarget.email || $t('gainos.leads.t0.noTarget') }}
            </Tag>
          </div>
          <p class="t0-tile__desc">
            {{
              evaluation.channels.mailto.allowed
                ? $t('gainos.leads.t0.mailtoDesc')
                : reasonCopy(evaluation.channels.mailto.reasonCode)
            }}
          </p>
          <Button
            :disabled="!mailtoHref || interactionBlocked"
            data-gs="t0-action-mailto"
            type="primary"
            @click="openMailto"
          >
            {{ $t('gainos.leads.t0.mailtoBtn') }}
          </Button>
        </div>

        <!-- 2. LinkedIn Co-Pilot -->
        <div class="t0-tile" :class="{ 'is-disabled': !evaluation.channels.linkedin.allowed || checking }">
          <div class="t0-tile__head">
            <span class="t0-tile__title">{{ $t('gainos.leads.t0.channel.linkedin') }}</span>
            <Tag :bordered="false" class="m-0 text-xs">
              {{
                evaluation.channels.linkedin.mode === 'direct'
                  ? $t('gainos.leads.t0.linkedinDirect')
                  : $t('gainos.leads.t0.linkedinSearch')
              }}
            </Tag>
          </div>
          <p class="t0-tile__desc">
            {{
              evaluation.channels.linkedin.allowed
                ? $t('gainos.leads.t0.linkedinDesc')
                : reasonCopy(evaluation.channels.linkedin.reasonCode)
            }}
          </p>
          <Button
            :disabled="!linkedinHref || interactionBlocked"
            data-gs="t0-action-linkedin"
            @click="openLinkedinCopilot"
          >
            {{ $t('gainos.leads.t0.linkedinBtn') }}
          </Button>
        </div>

        <!-- 3. Compliant wa.me -->
        <div class="t0-tile" :class="{ 'is-disabled': !evaluation.channels.whatsapp.allowed || checking }">
          <div class="t0-tile__head">
            <span class="t0-tile__title">{{ $t('gainos.leads.t0.channel.whatsapp') }}</span>
            <Tag :bordered="false" class="m-0 text-xs">
              {{ activeTarget.phone || companyWhatsappUrl || $t('gainos.leads.t0.noTarget') }}
            </Tag>
          </div>
          <p class="t0-tile__desc">
            {{
              evaluation.channels.whatsapp.allowed
                ? $t('gainos.leads.t0.whatsappDesc')
                : reasonCopy(evaluation.channels.whatsapp.reasonCode)
            }}
          </p>
          <Button
            :disabled="!whatsappHref || interactionBlocked"
            data-gs="t0-action-whatsapp"
            @click="openWhatsapp"
          >
            {{ $t('gainos.leads.t0.whatsappBtn') }}
          </Button>
        </div>

        <!-- 4. Website Contact Form -->
        <div class="t0-tile" :class="{ 'is-disabled': !evaluation.channels.form.allowed || checking }">
          <div class="t0-tile__head">
            <span class="t0-tile__title">{{ $t('gainos.leads.t0.channel.form') }}</span>
            <Tag :bordered="false" class="m-0 max-w-[200px] truncate text-xs">
              {{ primaryFormUrl || $t('gainos.leads.t0.noTarget') }}
            </Tag>
          </div>
          <p class="t0-tile__desc">
            {{
              evaluation.channels.form.allowed
                ? $t('gainos.leads.t0.formDesc')
                : reasonCopy(evaluation.channels.form.reasonCode)
            }}
          </p>
          <Button
            :disabled="!formHref || interactionBlocked"
            data-gs="t0-action-form"
            @click="openFormWithCopy"
          >
            {{ $t('gainos.leads.t0.formBtn') }}
          </Button>
        </div>
      </div>

      <!-- 轻量触达留痕 -->
      <div class="t0-log" data-gs="t0-touch-logger">
        <div class="t0-log__head">
          <span class="text-xs font-semibold text-[var(--gs-fg)]">
            {{ $t('gainos.leads.t0.logTitle') }}
          </span>
          <span class="text-xs text-[var(--gs-fg-subtle)]">
            {{ $t('gainos.leads.t0.logHint') }}
          </span>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <GsSelect
            v-model="touchChannel"
            :ariaLabel="$t('gainos.leads.t0.logChannel')"
            :disabled="interactionBlocked"
            :options="[
              { label: $t('gainos.leads.t0.channel.mailto'), value: 'mailto' },
              { label: $t('gainos.leads.t0.channel.linkedin'), value: 'linkedin' },
              { label: $t('gainos.leads.t0.channel.whatsapp'), value: 'whatsapp' },
              { label: $t('gainos.leads.t0.channel.form'), value: 'form' },
            ]"
            class="w-[150px]"
          />
          <GsSelect
            v-model="touchOutcome"
            :ariaLabel="$t('gainos.leads.t0.logOutcome')"
            :disabled="interactionBlocked"
            :options="[
              { label: $t('gainos.leads.t0.outcome.SENT'), value: 'SENT' },
              { label: $t('gainos.leads.t0.outcome.OPENED'), value: 'OPENED' },
              { label: $t('gainos.leads.t0.outcome.REPLIED'), value: 'REPLIED' },
            ]"
            class="w-[120px]"
          />
          <Input
            v-model:value="touchNote"
            :disabled="interactionBlocked"
            :maxlength="500"
            :placeholder="$t('gainos.leads.t0.logNotePlaceholder')"
            class="min-w-[200px] flex-1"
            data-gs="t0-touch-note"
            @press-enter="submitManualTouch"
          />
          <Button
            :disabled="interactionBlocked || recordingTouch"
            :loading="recordingTouch"
            data-gs="t0-record-touch"
            type="primary"
            @click="submitManualTouch"
          >
            {{ $t('gainos.leads.t0.logSubmit') }}
          </Button>
        </div>

        <ul v-if="touches.length > 0" class="t0-log__list" data-gs="t0-touch-list">
          <li v-for="item in touches.slice(0, 8)" :key="item.id" class="t0-log__item">
            <Space :size="6" wrap>
              <Tag :bordered="false" class="m-0 text-xs">{{ channelLabel(item.channel) }}</Tag>
              <Tag :bordered="false" class="m-0 text-xs">
                {{ $t(`gainos.leads.t0.outcome.${item.outcome}`) }}
              </Tag>
              <span v-if="item.targetMasked" class="font-mono text-xs text-[var(--gs-fg-muted)]">
                {{ item.targetMasked }}
              </span>
              <span v-if="item.note" class="text-xs text-[var(--gs-fg)]">{{ item.note }}</span>
            </Space>
            <span class="text-xs text-[var(--gs-fg-subtle)]">
              {{ formatDateTime(item.createdAt) }}
            </span>
          </li>
        </ul>
        <p v-else-if="!touchesLoading" class="m-0 text-xs text-[var(--gs-fg-subtle)]">
          {{ $t('gainos.leads.t0.logEmpty') }}
        </p>
      </div>
    </div>
  </GsCard>
</template>

<style scoped>
.t0-tile {
  display: grid;
  gap: 8px;
  align-content: space-between;
  padding: 12px 14px;
  border: 1px solid var(--gs-divider);
  border-radius: 10px;
  background: var(--gs-surface);
}
.t0-tile.is-disabled {
  background: var(--gs-surface-2);
  opacity: 0.85;
}
.t0-tile__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.t0-tile__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--gs-fg);
}
.t0-tile__desc {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--gs-fg-muted);
}
.t0-signals {
  display: grid;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--gs-divider);
  border-radius: 10px;
  background: var(--gs-surface-2);
}
.t0-signals__head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.t0-signals__list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.t0-signals__item {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--gs-divider);
  background: var(--gs-surface);
}
.t0-log {
  display: grid;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px dashed var(--gs-divider);
}
.t0-log__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}
.t0-log__list {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.t0-log__item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--gs-surface-2);
}
</style>
