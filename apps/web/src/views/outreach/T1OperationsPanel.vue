<script lang="ts" setup>
/**
 * Phase 3 Track 3C — T1 发信运维与合规工作台：
 * 集中承载发信健康与退信熔断、SPF/DKIM/DMARC/MX 域名体检、周预热清单、
 * 合规模板与法务审查、以及 2–4 轮（Day 0/3/7/14）自动跟进序列规划与硬终止守卫。
 */
import type {
  OutreachDomainDnsCheckView,
  OutreachDraftView,
  OutreachHealthPanelView,
  OutreachLegalReviewView,
  OutreachT1SequenceView,
  OutreachTemplateView,
  OutreachWarmupChecklistView,
} from '#/api/gainos';

import { computed, onMounted, ref, watch } from 'vue';

import { formatDateTime } from '@gain-saas/shared';
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Space,
  TabPane,
  Tabs,
  Tag,
} from 'ant-design-vue';

import GsCard from '#/components/gainos/ui/gs-card.vue';
import GsTag from '#/components/gainos/ui/gs-tag.vue';
import { failureText, gainosApi } from '#/api/gainos';
import { feedback } from '#/feedback';
import { $t } from '#/locales';

defineOptions({ name: 'T1OperationsPanel' });

const props = defineProps<{
  fromDomain?: string | null;
  initialDraft?: OutreachDraftView | null;
}>();

const activeTab = ref<'dns' | 'health' | 'sequence' | 'templates' | 'warmup'>('dns');

// ── 1. SPF / DKIM / DMARC / MX 域名体检 ──────────────────────────────────────
const dnsDomain = ref(props.fromDomain ?? '');
const dnsSelector = ref('google');
const dnsBusy = ref(false);
const dnsError = ref<string | null>(null);
const dnsResult = ref<OutreachDomainDnsCheckView | null>(null);

watch(
  () => props.fromDomain,
  (val) => {
    if (val && !dnsDomain.value) dnsDomain.value = val;
  },
);

async function runDnsCheck(): Promise<void> {
  const domain = dnsDomain.value.trim();
  if (!domain || dnsBusy.value) return;
  dnsBusy.value = true;
  dnsError.value = null;
  try {
    dnsResult.value = await gainosApi.checkOutreachDomainDns({
      domain,
      dkimSelector: dnsSelector.value.trim() || undefined,
    });
  } catch (err) {
    dnsError.value = failureText(err).title;
    dnsResult.value = null;
  } finally {
    dnsBusy.value = false;
  }
}

async function copyDnsTemplate(): Promise<void> {
  const text = dnsResult.value?.template ?? '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    feedback.message.success($t('gainos.outreach.t1.dnsCopied'));
  } catch {
    /* 剪贴板权限被拒时静默降级 */
  }
}

function dnsAdviceText(code: string): string {
  const key = `gainos.outreach.t1.dnsAdvice.${code}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? code : translated;
}

// ── 2. 发信健康与退信熔断看板 ───────────────────────────────────────────────
const healthData = ref<OutreachHealthPanelView | null>(null);
const healthLoading = ref(false);
const healthError = ref<string | null>(null);
const breakerModal = ref<{ action: 'close' | 'recover'; scope: string; scopeRef: string } | null>(null);
const breakerReason = ref('');
const breakerBusy = ref(false);

async function loadHealth(): Promise<void> {
  healthLoading.value = true;
  healthError.value = null;
  try {
    const res = await gainosApi.outreachHealth();
    healthData.value = res && typeof res === 'object' ? res : { breakers: [], events: [] };
  } catch (err) {
    healthError.value = failureText(err).title;
  } finally {
    healthLoading.value = false;
  }
}

async function evaluateHealth(): Promise<void> {
  healthLoading.value = true;
  healthError.value = null;
  try {
    await gainosApi.evaluateOutreachHealth();
    await loadHealth();
  } catch (err) {
    healthError.value = failureText(err).title;
    healthLoading.value = false;
  }
}

async function submitBreakerAction(): Promise<void> {
  if (!breakerModal.value || !breakerReason.value.trim() || breakerBusy.value) return;
  breakerBusy.value = true;
  try {
    if (breakerModal.value.action === 'recover') {
      await gainosApi.recoverOutreachBreaker(
        breakerModal.value.scope,
        breakerModal.value.scopeRef,
        breakerReason.value.trim(),
      );
    } else {
      await gainosApi.closeOutreachBreaker(
        breakerModal.value.scope,
        breakerModal.value.scopeRef,
        breakerReason.value.trim(),
      );
    }
    breakerModal.value = null;
    breakerReason.value = '';
    await loadHealth();
  } catch (err) {
    healthError.value = failureText(err).title;
  } finally {
    breakerBusy.value = false;
  }
}

function healthStateLabel(state: string): string {
  const key = `gainos.outreach.t1.healthState.${state}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? $t('gainos.common.unknownStatus') : translated;
}

function healthStateTone(state: string): 'danger' | 'neutral' | 'success' | 'warning' {
  if (state === 'OPEN') return 'danger';
  if (state === 'HALF_OPEN') return 'warning';
  if (state === 'CLOSED') return 'success';
  return 'neutral';
}

// ── 3. 预热清单 ─────────────────────────────────────────────────────────────
const warmup = ref<OutreachWarmupChecklistView | null>(null);
const warmupLoading = ref(false);
const warmupError = ref<string | null>(null);

async function loadWarmup(): Promise<void> {
  warmupLoading.value = true;
  warmupError.value = null;
  try {
    const res = await gainosApi.outreachWarmupChecklist();
    warmup.value = res && typeof res === 'object' && Array.isArray(res.domains) ? res : null;
  } catch (err) {
    warmupError.value = failureText(err).title;
  } finally {
    warmupLoading.value = false;
  }
}

// ── 4. 合规模板与法务审查 ───────────────────────────────────────────────────
const templates = ref<OutreachTemplateView[]>([]);
const legalReviews = ref<OutreachLegalReviewView[]>([]);
const templatesLoading = ref(false);
const templatesError = ref<string | null>(null);
const createTplOpen = ref(false);
const tplBusy = ref(false);
const tplForm = ref({
  kind: 'email_first',
  jurisdiction: 'ALL',
  language: 'en',
  subject: '',
  body: '',
});

async function loadTemplates(): Promise<void> {
  templatesLoading.value = true;
  templatesError.value = null;
  try {
    const [tpls, reviews] = await Promise.all([
      gainosApi.outreachTemplates().catch(() => []),
      gainosApi.outreachLegalReviews().catch(() => []),
    ]);
    templates.value = Array.isArray(tpls) ? tpls : [];
    legalReviews.value = Array.isArray(reviews) ? reviews : [];
  } catch (err) {
    templatesError.value = failureText(err).title;
  } finally {
    templatesLoading.value = false;
  }
}

async function createTemplate(): Promise<void> {
  if (!tplForm.value.body.trim() || tplBusy.value) return;
  tplBusy.value = true;
  templatesError.value = null;
  try {
    await gainosApi.createOutreachTemplate({
      kind: tplForm.value.kind,
      jurisdiction: tplForm.value.jurisdiction.trim() || 'ALL',
      language: tplForm.value.language.trim() || 'en',
      subject: tplForm.value.subject.trim() || undefined,
      body: tplForm.value.body.trim(),
    });
    createTplOpen.value = false;
    tplForm.value = { kind: 'email_first', jurisdiction: 'ALL', language: 'en', subject: '', body: '' };
    await loadTemplates();
  } catch (err) {
    templatesError.value = failureText(err).title;
  } finally {
    tplBusy.value = false;
  }
}

async function runTemplateAction(
  id: string,
  action: 'activate' | 'retire' | 'submit',
): Promise<void> {
  templatesError.value = null;
  try {
    if (action === 'submit') await gainosApi.submitOutreachTemplateReview(id);
    else if (action === 'activate') await gainosApi.activateOutreachTemplate(id);
    else await gainosApi.retireOutreachTemplate(id);
    await loadTemplates();
  } catch (err) {
    templatesError.value = failureText(err).title;
  }
}

function tplKindLabel(kind: string): string {
  const key = `gainos.outreach.t1.templatesKindLabel.${kind}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? $t('gainos.common.unknownStatus') : translated;
}

function tplStateLabel(state: string): string {
  const key = `gainos.outreach.t1.templatesStateLabel.${state}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? $t('gainos.common.unknownStatus') : translated;
}

// ── 5. 2–4 轮自动跟进序列规划器 ──────────────────────────────────────────────
const sequences = ref<OutreachT1SequenceView[]>([]);
const seqLoading = ref(false);
const seqError = ref<string | null>(null);
const seqBusy = ref(false);
const seqForm = ref({
  contactRef: '',
  recipientEmail: '',
  companyName: '',
  countryCode: '',
  subject: '',
  body: '',
  rounds: 4,
});

const roundOptions = computed(() => [
  { value: 2, label: $t('gainos.outreach.t1.seqRoundOption', { count: 2, days: 'Day 0 / 3' }) },
  { value: 3, label: $t('gainos.outreach.t1.seqRoundOption', { count: 3, days: 'Day 0 / 3 / 7' }) },
  { value: 4, label: $t('gainos.outreach.t1.seqRoundOption', { count: 4, days: 'Day 0 / 3 / 7 / 14' }) },
]);

watch(
  () => props.initialDraft,
  (draft) => {
    if (!draft || seqForm.value.recipientEmail) return;
    seqForm.value = {
      contactRef: draft.contactRef,
      recipientEmail: draft.recipientEmail,
      companyName: draft.companyName ?? '',
      countryCode: (draft.countryCode ?? '').toUpperCase(),
      subject: draft.subject,
      body: draft.body,
      rounds: seqForm.value.rounds,
    };
  },
  { immediate: true },
);

async function loadSequences(): Promise<void> {
  seqLoading.value = true;
  seqError.value = null;
  try {
    const rows = await gainosApi.listOutreachSequences();
    sequences.value = Array.isArray(rows) ? rows : [];
  } catch (err) {
    seqError.value = failureText(err).title;
  } finally {
    seqLoading.value = false;
  }
}

async function createSequence(): Promise<void> {
  if (seqBusy.value) return;
  seqBusy.value = true;
  seqError.value = null;
  try {
    const created = await gainosApi.planOutreachSequence({
      contactRef: seqForm.value.contactRef.trim(),
      recipientEmail: seqForm.value.recipientEmail.trim(),
      companyName: seqForm.value.companyName.trim() || undefined,
      countryCode: seqForm.value.countryCode.trim().toUpperCase(),
      subject: seqForm.value.subject.trim(),
      body: seqForm.value.body.trim(),
      rounds: seqForm.value.rounds,
    });
    sequences.value = [created, ...sequences.value.filter((item) => item.id !== created.id)];
    feedback.message.success($t('gainos.outreach.t1.seqCreated'));
  } catch (err) {
    seqError.value = failureText(err).title;
  } finally {
    seqBusy.value = false;
  }
}

function seqStatusLabel(status: string): string {
  const key = `gainos.outreach.t1.seqStatus.${status}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? $t('gainos.common.unknownStatus') : translated;
}

function seqStopReasonLabel(code: string | null): string {
  if (!code) return '';
  const key = `gainos.outreach.t1.seqStopReason.${code}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? code : translated;
}

function onTabChange(key: number | string): void {
  const tab = String(key) as typeof activeTab.value;
  activeTab.value = tab;
  if (tab === 'health' && !healthData.value) void loadHealth();
  if (tab === 'warmup' && !warmup.value) void loadWarmup();
  if (tab === 'templates' && templates.value.length === 0) void loadTemplates();
  if (tab === 'sequence' && sequences.value.length === 0) void loadSequences();
}

watch(
  () => props.fromDomain,
  (next) => {
    if (next && !dnsDomain.value) dnsDomain.value = next;
  },
  { immediate: true },
);

onMounted(() => {
  if (props.fromDomain && !dnsDomain.value) dnsDomain.value = props.fromDomain;
});
</script>

<template>
  <GsCard :title="$t('gainos.outreach.t1.workbenchTitle')" data-gs="t1-operations-panel">
    <Tabs :active-key="activeTab" size="small" @change="onTabChange">
      <!-- 1. 域名 SPF / DKIM / DMARC / MX 体检 -->
      <TabPane key="dns" :tab="$t('gainos.outreach.t1.tabDns')">
        <div class="t1-stack" data-gs="t1-dns-pane">
          <p class="t1-muted">{{ $t('gainos.outreach.t1.dnsDesc') }}</p>
          <div class="t1-inline">
            <Input
              v-model:value="dnsDomain"
              :placeholder="$t('gainos.outreach.t1.dnsDomainPlaceholder')"
              data-gs="t1-dns-domain"
              style="max-width: 280px"
              @press-enter="runDnsCheck"
            />
            <Input
              v-model:value="dnsSelector"
              :placeholder="$t('gainos.outreach.t1.dnsSelectorPlaceholder')"
              data-gs="t1-dns-selector"
              style="max-width: 190px"
              @press-enter="runDnsCheck"
            />
            <Button
              :disabled="!dnsDomain.trim()"
              :loading="dnsBusy"
              data-gs="t1-dns-check-btn"
              type="primary"
              @click="runDnsCheck"
            >
              {{ $t('gainos.outreach.t1.dnsCheckBtn') }}
            </Button>
          </div>
          <Alert v-if="dnsError" :message="dnsError" show-icon type="error" />
          <div v-if="dnsResult" class="t1-stack" data-gs="t1-dns-result">
            <Alert
              :message="
                dnsResult.advice.ready
                  ? $t('gainos.outreach.t1.dnsReady')
                  : $t('gainos.outreach.t1.dnsNotReady', { score: dnsResult.advice.score })
              "
              :type="dnsResult.advice.ready ? 'success' : 'warning'"
              show-icon
            />
            <div class="t1-dns-grid">
              <div
                v-for="item in dnsResult.advice.items"
                :key="item.key"
                :data-gs="`t1-dns-item-${item.key}`"
                class="t1-dns-tile"
              >
                <div class="t1-row-between">
                  <strong>{{ item.key.toUpperCase() }}</strong>
                  <GsTag :tone="item.severity === 'ok' ? 'success' : item.severity === 'warn' ? 'warning' : 'danger'">
                    {{ item.ok ? 'OK' : '!' }}
                  </GsTag>
                </div>
                <p class="t1-muted">{{ dnsAdviceText(item.adviceCode) }}</p>
              </div>
            </div>
            <div class="t1-template-box">
              <div class="t1-row-between">
                <strong>{{ $t('gainos.outreach.t1.dnsTemplateTitle') }}</strong>
                <Button size="small" @click="copyDnsTemplate">
                  {{ $t('gainos.outreach.t1.dnsCopyTemplate') }}
                </Button>
              </div>
              <pre class="t1-pre">{{ dnsResult.template }}</pre>
            </div>
          </div>
        </div>
      </TabPane>

      <!-- 2. 发信健康与退信熔断看板 -->
      <TabPane key="health" :tab="$t('gainos.outreach.t1.tabHealth')">
        <div class="t1-stack" data-gs="t1-health-pane">
          <div class="t1-row-between">
            <p class="t1-muted">{{ $t('gainos.outreach.t1.healthDesc') }}</p>
            <Space :size="8">
              <Button :loading="healthLoading" size="small" @click="loadHealth">
                {{ $t('gainos.common.refresh') }}
              </Button>
              <Button :loading="healthLoading" data-gs="t1-health-evaluate" size="small" type="primary" @click="evaluateHealth">
                {{ $t('gainos.outreach.t1.healthEvaluateBtn') }}
              </Button>
            </Space>
          </div>
          <Alert v-if="healthError" :message="healthError" show-icon type="error" />
          <p v-else-if="healthLoading && !healthData" class="t1-muted">{{ $t('gainos.common.loading') }}</p>
          <template v-else-if="healthData">
            <p v-if="healthData.breakers.length === 0" class="t1-muted">
              {{ $t('gainos.outreach.t1.healthEmpty') }}
            </p>
            <ul v-else class="t1-list" data-gs="t1-breaker-list">
              <li v-for="b in healthData.breakers" :key="b.id" class="t1-card-row">
                <div>
                  <strong>{{ b.scopeRef }}</strong>
                  <GsTag :tone="healthStateTone(b.state)" class="ml-2">
                    {{ healthStateLabel(b.state) }}
                  </GsTag>
                  <span v-if="b.openedAt" class="t1-muted ml-2">{{ formatDateTime(b.openedAt) }}</span>
                </div>
                <Space :size="6">
                  <Button
                    v-if="b.state === 'OPEN'"
                    data-gs="t1-breaker-recover"
                    size="small"
                    @click="breakerModal = { action: 'recover', scope: b.scope, scopeRef: b.scopeRef }"
                  >
                    {{ $t('gainos.outreach.t1.healthRecoverBtn') }}
                  </Button>
                  <Button
                    v-if="b.state === 'HALF_OPEN'"
                    data-gs="t1-breaker-close"
                    size="small"
                    type="primary"
                    @click="breakerModal = { action: 'close', scope: b.scope, scopeRef: b.scopeRef }"
                  >
                    {{ $t('gainos.outreach.t1.healthCloseBtn') }}
                  </Button>
                </Space>
              </li>
            </ul>
            <div v-if="healthData.events.length > 0" class="t1-stack">
              <strong>{{ $t('gainos.outreach.t1.healthEventsTitle') }}</strong>
              <ul class="t1-list">
                <li v-for="ev in healthData.events.slice(0, 8)" :key="ev.id" class="t1-card-row">
                  <span>{{ ev.scopeRef }} · {{ Math.round(ev.value * 1000) / 10 }}% / {{ Math.round(ev.threshold * 1000) / 10 }}%</span>
                  <span class="t1-muted">{{ formatDateTime(ev.detectedAt) }}</span>
                </li>
              </ul>
            </div>
          </template>
        </div>
      </TabPane>

      <!-- 3. 预热清单 -->
      <TabPane key="warmup" :tab="$t('gainos.outreach.t1.tabWarmup')">
        <div class="t1-stack" data-gs="t1-warmup-pane">
          <div class="t1-row-between">
            <p class="t1-muted">{{ $t('gainos.outreach.t1.warmupDesc') }}</p>
            <Button :loading="warmupLoading" size="small" @click="loadWarmup">
              {{ $t('gainos.common.refresh') }}
            </Button>
          </div>
          <Alert v-if="warmupError" :message="warmupError" show-icon type="error" />
          <p v-else-if="warmupLoading && !warmup" class="t1-muted">{{ $t('gainos.common.loading') }}</p>
          <p v-else-if="!warmup || warmup.domains.length === 0" class="t1-muted">
            {{ $t('gainos.outreach.t1.warmupEmpty') }}
          </p>
          <ul v-else class="t1-list" data-gs="t1-warmup-list">
            <li v-for="dom in warmup.domains" :key="dom.domain" class="t1-domain-box">
              <div class="t1-row-between">
                <strong>{{ dom.domain }}</strong>
                <GsTag :tone="dom.checks.ok ? 'success' : 'warning'">
                  {{ dom.checks.ok ? $t('gainos.outreach.t1.warmupPass') : $t('gainos.outreach.t1.warmupPending') }}
                </GsTag>
              </div>
              <p class="t1-muted">
                <template v-if="dom.lastSeedTest">
                  {{
                    $t('gainos.outreach.t1.warmupSeedStats', {
                      inbox: dom.lastSeedTest.inboxPct ?? '—',
                      spam: dom.lastSeedTest.spamPct ?? '—',
                    })
                  }}
                  · {{ formatDateTime(dom.lastSeedTest.testedAt) }}
                </template>
                <template v-else>{{ $t('gainos.outreach.t1.warmupSeedMissing') }}</template>
              </p>
              <div v-if="dom.mailboxes.length > 0" class="t1-chips">
                <Tag v-for="mb in dom.mailboxes" :key="mb.address" :bordered="false" class="m-0">
                  {{ mb.address }} ·
                  {{
                    $t('gainos.outreach.t1.warmupQuota', {
                      daily: mb.dailySent,
                      dailyCap: mb.dailyCap,
                      weekly: mb.weeklySent,
                      weeklyCap: mb.weeklyCap,
                    })
                  }}
                </Tag>
              </div>
            </li>
          </ul>
        </div>
      </TabPane>

      <!-- 4. 模板与法务审查 -->
      <TabPane key="templates" :tab="$t('gainos.outreach.t1.tabTemplates')">
        <div class="t1-stack" data-gs="t1-templates-pane">
          <div class="t1-row-between">
            <p class="t1-muted">{{ $t('gainos.outreach.t1.templatesDesc') }}</p>
            <Space :size="8">
              <Button :loading="templatesLoading" size="small" @click="loadTemplates">
                {{ $t('gainos.common.refresh') }}
              </Button>
              <Button data-gs="t1-template-new" size="small" type="primary" @click="createTplOpen = true">
                {{ $t('gainos.outreach.t1.templatesNewBtn') }}
              </Button>
            </Space>
          </div>
          <Alert v-if="templatesError" :message="templatesError" show-icon type="error" />
          <p v-if="templates.length === 0 && !templatesLoading" class="t1-muted">
            {{ $t('gainos.outreach.t1.templatesEmpty') }}
          </p>
          <ul v-else class="t1-list" data-gs="t1-templates-list">
            <li v-for="tpl in templates" :key="tpl.id" class="t1-card-row">
              <div>
                <strong>{{ tpl.subject || tplKindLabel(tpl.kind) }}</strong>
                <Tag :bordered="false" class="ml-2">{{ tplKindLabel(tpl.kind) }}</Tag>
                <Tag :bordered="false">{{ tpl.jurisdiction || 'ALL' }} · {{ tpl.language }}</Tag>
                <GsTag :tone="tpl.state === 'ACTIVE' ? 'success' : tpl.state === 'RETIRED' ? 'neutral' : 'warning'" class="ml-1">
                  {{ tplStateLabel(tpl.state) }}
                </GsTag>
              </div>
              <Space :size="6">
                <Button v-if="tpl.state === 'DRAFT'" size="small" @click="runTemplateAction(tpl.id, 'submit')">
                  {{ $t('gainos.outreach.t1.templatesSubmitReview') }}
                </Button>
                <Button v-if="tpl.state === 'APPROVED'" size="small" type="primary" @click="runTemplateAction(tpl.id, 'activate')">
                  {{ $t('gainos.outreach.t1.templatesActivate') }}
                </Button>
                <Button v-if="tpl.state === 'ACTIVE'" danger size="small" @click="runTemplateAction(tpl.id, 'retire')">
                  {{ $t('gainos.outreach.t1.templatesRetire') }}
                </Button>
              </Space>
            </li>
          </ul>
          <div class="t1-stack">
            <strong>{{ $t('gainos.outreach.t1.templatesLegalListTitle') }}</strong>
            <p v-if="legalReviews.length === 0" class="t1-muted">
              {{ $t('gainos.outreach.t1.templatesLegalEmpty') }}
            </p>
            <ul v-else class="t1-list">
              <li v-for="rev in legalReviews" :key="rev.id" class="t1-card-row">
                <span>{{ rev.reviewerName }}（{{ rev.reviewerFirm }}） · {{ rev.scope }}</span>
                <span class="t1-muted">{{ formatDateTime(rev.reviewedAt) }}</span>
              </li>
            </ul>
          </div>
        </div>
      </TabPane>

      <!-- 5. 2–4 轮自动跟进序列规划器 -->
      <TabPane key="sequence" :tab="$t('gainos.outreach.t1.tabSequence')">
        <div class="t1-stack" data-gs="t1-sequence-pane">
          <p class="t1-muted">{{ $t('gainos.outreach.t1.seqDesc') }}</p>
          <div class="t1-seq-form">
            <Input
              v-model:value="seqForm.contactRef"
              :placeholder="$t('gainos.outreach.contactRef')"
              data-gs="t1-seq-contact-ref"
            />
            <Input
              v-model:value="seqForm.recipientEmail"
              :placeholder="$t('gainos.outreach.recipient')"
              data-gs="t1-seq-email"
            />
            <Input
              v-model:value="seqForm.countryCode"
              :maxlength="2"
              :placeholder="$t('gainos.outreach.countryCodePlaceholder')"
              data-gs="t1-seq-country"
            />
            <Select
              v-model:value="seqForm.rounds"
              :options="roundOptions"
              data-gs="t1-seq-rounds"
              style="width: 100%"
            />
            <Input
              v-model:value="seqForm.subject"
              :placeholder="$t('gainos.outreach.subject')"
              class="t1-seq-span2"
              data-gs="t1-seq-subject"
            />
            <Input.TextArea
              v-model:value="seqForm.body"
              :placeholder="$t('gainos.outreach.body')"
              :rows="3"
              class="t1-seq-span2"
              data-gs="t1-seq-body"
            />
            <div class="t1-seq-span2">
              <Button
                :disabled="!seqForm.contactRef.trim() || !seqForm.recipientEmail.trim() || !seqForm.countryCode.trim() || !seqForm.subject.trim() || !seqForm.body.trim()"
                :loading="seqBusy"
                data-gs="t1-seq-create-btn"
                type="primary"
                @click="createSequence"
              >
                {{ $t('gainos.outreach.t1.seqPlanBtn') }}
              </Button>
            </div>
          </div>

          <Alert v-if="seqError" :message="seqError" show-icon type="error" />
          <p v-if="sequences.length === 0 && !seqLoading" class="t1-muted">
            {{ $t('gainos.outreach.t1.seqEmpty') }}
          </p>
          <ul v-else class="t1-list" data-gs="t1-sequence-list">
            <li v-for="seq in sequences" :key="seq.id" class="t1-domain-box" data-gs="t1-sequence-card">
              <div class="t1-row-between">
                <div>
                  <strong>{{ seq.subject }}</strong>
                  <span class="t1-muted ml-2">{{ seq.recipientMasked }} · {{ seq.countryCode }}</span>
                </div>
                <GsTag :tone="seq.plan.stopped ? 'danger' : 'success'" data-gs="t1-seq-badge">
                  {{
                    seq.plan.stopped
                      ? $t('gainos.outreach.t1.seqStoppedBadge')
                      : $t('gainos.outreach.t1.seqActiveBadge', { count: seq.plan.activeRoundCount })
                  }}
                </GsTag>
              </div>
              <Alert
                v-if="seq.plan.stopped && seq.plan.stopReason"
                :message="seqStopReasonLabel(seq.plan.stopReason)"
                data-gs="t1-seq-stop-alert"
                show-icon
                type="warning"
              />
              <div class="t1-chips">
                <Tag
                  v-for="step in seq.plan.steps"
                  :key="step.round"
                  :bordered="false"
                  :color="step.status === 'scheduled' ? 'blue' : step.status === 'sent' ? 'green' : 'red'"
                  class="m-0"
                >
                  {{ $t('gainos.outreach.t1.seqDayLabel', { round: step.round, day: step.dayOffset }) }} ·
                  {{ seqStatusLabel(step.status) }}
                </Tag>
              </div>
            </li>
          </ul>
        </div>
      </TabPane>
    </Tabs>

    <!-- 熔断恢复/关闭理由弹窗 -->
    <Modal
      :confirm-loading="breakerBusy"
      :open="Boolean(breakerModal)"
      :title="breakerModal?.action === 'recover' ? $t('gainos.outreach.t1.healthRecoverBtn') : $t('gainos.outreach.t1.healthCloseBtn')"
      @cancel="breakerModal = null"
      @ok="submitBreakerAction"
    >
      <Input.TextArea
        v-model:value="breakerReason"
        :maxlength="200"
        :placeholder="$t('gainos.outreach.t1.healthReasonPlaceholder')"
        :rows="3"
      />
    </Modal>

    <!-- 新建模板草稿弹窗 -->
    <Modal
      :confirm-loading="tplBusy"
      :open="createTplOpen"
      :title="$t('gainos.outreach.t1.templatesCreateTitle')"
      @cancel="createTplOpen = false"
      @ok="createTemplate"
    >
      <Form layout="vertical">
        <Form.Item :label="$t('gainos.outreach.t1.templatesKind')">
          <Select
            v-model:value="tplForm.kind"
            :options="[
              { value: 'email_first', label: $t('gainos.outreach.t1.templatesKindLabel.email_first') },
              { value: 'email_followup', label: $t('gainos.outreach.t1.templatesKindLabel.email_followup') },
              { value: 'email_footer', label: $t('gainos.outreach.t1.templatesKindLabel.email_footer') },
            ]"
          />
        </Form.Item>
        <div class="t1-inline">
          <Form.Item :label="$t('gainos.outreach.t1.templatesJurisdiction')" style="flex: 1">
            <Input v-model:value="tplForm.jurisdiction" :maxlength="3" />
          </Form.Item>
          <Form.Item :label="$t('gainos.outreach.t1.templatesLanguage')" style="flex: 1">
            <Input v-model:value="tplForm.language" :maxlength="5" />
          </Form.Item>
        </div>
        <Form.Item :label="$t('gainos.outreach.subject')">
          <Input v-model:value="tplForm.subject" :maxlength="300" />
        </Form.Item>
        <Form.Item :label="$t('gainos.outreach.body')">
          <Input.TextArea v-model:value="tplForm.body" :maxlength="20000" :rows="4" />
        </Form.Item>
      </Form>
    </Modal>
  </GsCard>
</template>

<style scoped>
.t1-stack { display: grid; gap: 12px; }
.t1-inline { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.t1-row-between { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; }
.t1-muted { margin: 0; font-size: 12.5px; color: var(--gs-fg-muted); }
.t1-dns-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
.t1-dns-tile { border: 1px solid var(--gs-divider); border-radius: 10px; padding: 10px 12px; display: grid; gap: 6px; background: var(--gs-surface); }
.t1-template-box { border: 1px dashed var(--gs-border-dashed); border-radius: 10px; padding: 10px 12px; display: grid; gap: 8px; }
.t1-pre { margin: 0; font-size: 12px; overflow-x: auto; white-space: pre-wrap; color: var(--gs-fg-2); }
.t1-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.t1-card-row { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; padding: 10px 12px; border: 1px solid var(--gs-divider); border-radius: 10px; background: var(--gs-surface); }
.t1-domain-box { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--gs-divider); border-radius: 10px; background: var(--gs-surface); }
.t1-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.t1-seq-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.t1-seq-span2 { grid-column: span 2; }
@media (max-width: 720px) {
  .t1-seq-form { grid-template-columns: 1fr; }
  .t1-seq-span2 { grid-column: span 1; }
}
</style>
