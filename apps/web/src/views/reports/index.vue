<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue';

import { $t } from '#/locales';

import { failureText, gainosApi, type Icp, type Lead } from '#/api/gainos';

defineOptions({ name: 'WeeklyReport' });

const STEP_KEYS = [
  'gainos.workspace.stepProfile',
  'gainos.workspace.stepIcp',
  'gainos.workspace.stepPlan',
  'gainos.workspace.stepRun',
  'gainos.workspace.stepJudge',
  'gainos.workspace.stepReport',
] as const;
const stepLabels = computed(() => STEP_KEYS.map((key) => $t(key)));

function isoWeek(date: Date): string {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const icps = ref<Icp[]>([]);
const icpId = ref('');
const week = ref(isoWeek(new Date()));
const loading = ref(true);
const error = ref<{ title: string; next?: string } | null>(null);
const notice = ref<string | null>(null);
const downloading = ref(false);
const withheld = ref<{ rights?: string; sanctions?: string; quarantined?: string } | null>(null);
const feedbackFile = ref<File | null>(null);
const feedbackText = ref('');
const feedbackName = ref('');
const uploading = ref(false);
const feedbackResult = ref<{ accepted: number; rejected: Array<{ line: number; reason: string }>; skipped: number } | null>(null);
const feedbackError = ref<{ title: string; next?: string } | null>(null);

const REASON_CODES = [
  'NOT_TARGET_ROLE',
  'WRONG_PRODUCT',
  'TOO_SMALL',
  'TOO_LARGE',
  'ALREADY_KNOWN',
  'NO_IMPORT_SIGNAL',
  'WRONG_COUNTRY',
  'BAD_CONTACT_PATH',
  'DUPLICATE',
  'OTHER',
  'GOOD_FIT',
  'WILL_FOLLOW_UP',
] as const;

const onlineLeads = ref<Lead[]>([]);
const onlineLoading = ref(false);
const onlineError = ref<{ title: string; next?: string } | null>(null);
const outcomeBusy = ref<string | null>(null);
const outcomeResult = ref<Record<string, { tone: 'ok' | 'error'; text: string }>>({});
const outcomeDraft = ref<Record<string, { relevance: string; willing: string; contacted: string; reasonCode: string; note: string }>>({});

const selectedIcp = computed(() => icps.value.find((icp) => icp.id === icpId.value) ?? null);

function weekBounds(value: string): { start: number; end: number } | null {
  const matched = /^(\d{4})-W(\d{2})$/.exec(value);
  if (!matched) return null;
  const year = Number(matched[1]);
  const weekNumber = Number(matched[2]);
  if (!Number.isFinite(year) || !Number.isFinite(weekNumber) || weekNumber < 1 || weekNumber > 53) return null;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const offset = (jan4.getUTCDay() || 7) - 1;
  const start = new Date(Date.UTC(year, 0, 4 - offset + (weekNumber - 1) * 7));
  return { start: start.getTime(), end: start.getTime() + 7 * 86_400_000 };
}

const visibleOnlineLeads = computed(() => {
  const bounds = weekBounds(week.value);
  if (!bounds) return onlineLeads.value;
  return onlineLeads.value.filter((lead) => {
    const stamp = lead.updatedAt ?? lead.createdAt;
    if (!stamp) return false;
    const time = new Date(stamp).getTime();
    return Number.isFinite(time) && time >= bounds.start && time < bounds.end;
  });
});

function companyName(lead: Lead): string {
  return lead.company?.name ?? $t('gainos.leads.unknownCompany');
}

function draftOf(lead: Lead): { relevance: string; willing: string; contacted: string; reasonCode: string; note: string } {
  const id = lead.id;
  if (!outcomeDraft.value[id]) {
    outcomeDraft.value[id] = { relevance: '', willing: '', contacted: '', reasonCode: '', note: '' };
  }
  return outcomeDraft.value[id]!;
}

async function loadOnline(): Promise<void> {
  if (!icpId.value) return;
  onlineLoading.value = true;
  onlineError.value = null;
  try {
    const data = await gainosApi.leads({ icpId: icpId.value, status: 'QUALIFIED', limit: 100 });
    onlineLeads.value = Array.isArray(data) ? data : [];
  } catch (err) {
    onlineError.value = failureText(err);
  } finally {
    onlineLoading.value = false;
  }
}

async function submitOutcome(lead: Lead): Promise<void> {
  const draft = draftOf(lead);
  delete outcomeResult.value[lead.id];
  const input: Record<string, unknown> = { source: 'customer' };
  if (draft.relevance) input.relevance = Number(draft.relevance);
  if (draft.willing) input.willingToContact = draft.willing === 'yes';
  if (draft.contacted) input.contacted = draft.contacted === 'yes';
  if (draft.reasonCode) input.reasonCode = draft.reasonCode;
  if (draft.note.trim()) input.note = draft.note.trim();
  if (Object.keys(input).length === 1) {
    outcomeResult.value[lead.id] = { tone: 'error', text: $t('gainos.reports.outcomeEmpty') };
    return;
  }
  outcomeBusy.value = lead.id;
  try {
    await gainosApi.leadOutcome(lead.id, input);
    outcomeResult.value[lead.id] = { tone: 'ok', text: $t('gainos.reports.outcomeSubmitted') };
    delete outcomeDraft.value[lead.id];
  } catch (err) {
    outcomeResult.value[lead.id] = { tone: 'error', text: failureText(err).title };
  } finally {
    outcomeBusy.value = null;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const data = await gainosApi.icps();
    icps.value = Array.isArray(data) ? data : [];
    if (!icpId.value && icps.value.length > 0) icpId.value = icps.value[0]!.id;
  } catch (err) {
    error.value = failureText(err);
  } finally {
    loading.value = false;
  }
  if (icpId.value) await loadOnline();
}

function reloadOnline(): void {
  void loadOnline();
}

async function download(): Promise<void> {
  if (!icpId.value) return;
  downloading.value = true;
  error.value = null;
  notice.value = null;
  withheld.value = null;
  try {
    const url = new URL('/api/reports/weekly', window.location.origin);
    url.searchParams.set('icpId', icpId.value);
    if (week.value) url.searchParams.set('week', week.value);
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
    }
    const blob = await response.blob();
    if (blob.size === 0) {
      notice.value = $t('gainos.reports.noData');
      return;
    }
    const link = document.createElement('a');
    const objectUrl = URL.createObjectURL(blob);
    link.href = objectUrl;
    link.download = `weekly-report-${week.value}-${icpId.value}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
    withheld.value = {
      rights: response.headers.get('x-report-withheld-rights') ?? undefined,
      sanctions: response.headers.get('x-report-withheld-sanctions') ?? undefined,
      quarantined: response.headers.get('x-report-withheld-quarantined') ?? undefined,
    };
    notice.value = $t('gainos.reports.downloaded');
  } catch (err) {
    error.value = { title: $t('gainos.reports.downloadError'), next: err instanceof Error ? err.message : String(err) };
  } finally {
    downloading.value = false;
  }
}

async function onFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  feedbackFile.value = file;
  feedbackName.value = file?.name ?? '';
  feedbackText.value = file ? await file.text() : '';
  feedbackResult.value = null;
  feedbackError.value = null;
}

async function uploadFeedback(): Promise<void> {
  if (!feedbackText.value) {
    feedbackError.value = { title: $t('gainos.reports.chooseFile'), next: $t('gainos.reports.uploadDesc') };
    return;
  }
  uploading.value = true;
  feedbackError.value = null;
  feedbackResult.value = null;
  try {
    const response = await fetch('/api/reports/weekly/feedback', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'text/csv; charset=utf-8' },
      body: feedbackText.value,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body?.error?.userCopy?.title ?? body?.error?.message ?? `HTTP ${response.status}`);
    }
    feedbackResult.value = body?.data ?? null;
    notice.value = $t('gainos.reports.feedbackAccepted');
  } catch (err) {
    feedbackError.value = { title: $t('gainos.reports.uploadError'), next: err instanceof Error ? err.message : String(err) };
  } finally {
    uploading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="rp">
    <header class="rp__head">
      <div>
        <span class="rp__stage">{{ $t('gainos.reports.stage') }}</span>
        <h1>{{ $t('gainos.reports.title') }}</h1>
        <p>{{ $t('gainos.reports.subtitle') }}</p>
      </div>
      <button class="rp__refresh" type="button" :class="{ 'is-loading': loading }" @click="load">{{ $t('gainos.common.refresh') }}</button>
    </header>

    <ol class="rp__steps" :aria-label="$t('gainos.workspace.stepProgress', { current: 6, total: stepLabels.length })">
      <li v-for="(label, i) in stepLabels" :key="label" class="rp__step" :class="{ 'is-done': i + 1 < 6, 'is-current': i + 1 === 6 }">
        <span class="rp__step-dot">{{ i + 1 }}</span><span>{{ label }}</span>
      </li>
    </ol>

    <p v-if="notice" class="rp__notice" role="status">{{ notice }}</p>
    <div v-if="error" class="rp__error" role="alert"><h3>{{ error.title }}</h3><p v-if="error.next">{{ error.next }}</p></div>

    <p v-if="loading" class="rp__muted">{{ $t('gainos.common.loading') }}</p>
    <section v-else-if="icps.length === 0" class="rp__empty">
      <p class="rp__empty-title">{{ $t('gainos.reports.noIcpTitle') }}</p>
      <p class="rp__empty-desc">{{ $t('gainos.reports.noIcpDesc') }}</p>
      <RouterLink class="rp__cta" to="/find-buyers">{{ $t('gainos.reports.noIcpCta') }}</RouterLink>
    </section>
    <template v-else>
      <section class="rp__filters">
        <label class="rp__field"><span>{{ $t('gainos.reports.icpLabel') }}</span>
          <select v-model="icpId" @change="reloadOnline">
            <option v-for="icp in icps" :key="icp.id" :value="icp.id">{{ icp.name }} · {{ icp.status }}</option>
          </select>
        </label>
        <label class="rp__field"><span>{{ $t('gainos.reports.weekLabel') }}</span><input v-model="week" type="week" @change="reloadOnline" /></label>
        <button class="rp__cta" type="button" :disabled="downloading || !selectedIcp" :class="{ 'is-loading': downloading }" @click="download">
          {{ downloading ? $t('gainos.reports.downloading') : $t('gainos.reports.download') }}
        </button>
      </section>

      <p v-if="withheld?.rights || withheld?.sanctions || withheld?.quarantined" class="rp__withheld">
        {{ $t('gainos.reports.withheld') }}
        <span v-if="withheld?.rights">{{ $t('gainos.reports.withheldRights', { count: withheld.rights }) }}</span>
        <span v-if="withheld?.sanctions">{{ $t('gainos.reports.withheldSanctions', { count: withheld.sanctions }) }}</span>
        <span v-if="withheld?.quarantined">{{ $t('gainos.reports.withheldQuarantined', { count: withheld.quarantined }) }}</span>
      </p>

      <section class="rp__card">
        <h2>{{ $t('gainos.reports.uploadTitle') }}</h2>
        <p class="rp__muted">{{ $t('gainos.reports.uploadDesc') }}</p>
        <div class="rp__upload">
          <input type="file" accept=".csv,text/csv" @change="onFile" />
          <span class="rp__muted">{{ feedbackName || $t('gainos.reports.noFile') }}</span>
          <button class="rp__cta" type="button" :disabled="uploading || !feedbackText" :class="{ 'is-loading': uploading }" @click="uploadFeedback">
            {{ uploading ? $t('gainos.reports.uploading') : $t('gainos.reports.upload') }}
          </button>
        </div>
        <div v-if="feedbackError" class="rp__error" role="alert"><h3>{{ feedbackError.title }}</h3><p v-if="feedbackError.next">{{ feedbackError.next }}</p></div>
        <div v-if="feedbackResult" class="rp__result">
          <p>{{ $t('gainos.reports.accepted', { count: feedbackResult.accepted }) }}</p>
          <p>{{ $t('gainos.reports.skipped', { count: feedbackResult.skipped }) }}</p>
          <p v-if="feedbackResult.rejected.length">{{ $t('gainos.reports.rejectedCount', { count: feedbackResult.rejected.length }) }}</p>
          <ul v-if="feedbackResult.rejected.length" class="rp__list">
            <li v-for="row in feedbackResult.rejected" :key="`${row.line}-${row.reason}`">line {{ row.line }} · {{ row.reason }}</li>
          </ul>
        </div>
      </section>

      <section class="rp__card">
        <div class="rp__card-head">
          <h2>{{ $t('gainos.reports.onlineTitle') }}</h2>
          <span class="rp__muted">{{ $t('gainos.reports.onlineCount', { count: visibleOnlineLeads.length }) }}</span>
        </div>
        <p class="rp__muted">{{ $t('gainos.reports.onlineDesc') }}</p>
        <p v-if="onlineLoading" class="rp__muted">{{ $t('gainos.common.loading') }}</p>
        <div v-else-if="onlineError" class="rp__error" role="alert"><h3>{{ onlineError.title }}</h3><p v-if="onlineError.next">{{ onlineError.next }}</p></div>
        <p v-else-if="visibleOnlineLeads.length === 0" class="rp__muted">{{ $t('gainos.reports.onlineEmpty') }}</p>
        <template v-else>
          <article v-for="lead in visibleOnlineLeads" :key="lead.id" class="rp__lead">
            <header class="rp__lead-head">
              <div>
                <strong>{{ companyName(lead) }}</strong>
                <span class="rp__muted"> · {{ lead.company?.domain || '—' }}</span>
              </div>
              <span class="rp__chip">{{ lead.status }}</span>
            </header>
            <p class="rp__muted">{{ $t('gainos.reports.onlineUpdated', { date: lead.updatedAt ? new Date(lead.updatedAt).toLocaleString() : '—' }) }}</p>
            <div class="rp__outcome-grid">
              <label class="rp__field"><span>{{ $t('gainos.reports.relevance') }}</span>
                <select v-model="draftOf(lead).relevance">
                  <option value="">{{ $t('gainos.reports.relevanceNone') }}</option>
                  <option v-for="value in [1, 2, 3, 4, 5]" :key="value" :value="String(value)">{{ value }}</option>
                </select>
              </label>
              <label class="rp__field"><span>{{ $t('gainos.reports.willing') }}</span>
                <select v-model="draftOf(lead).willing">
                  <option value="">{{ $t('gainos.reports.willingNone') }}</option>
                  <option value="yes">{{ $t('gainos.reports.willingYes') }}</option>
                  <option value="no">{{ $t('gainos.reports.willingNo') }}</option>
                </select>
              </label>
              <label class="rp__field"><span>{{ $t('gainos.reports.contacted') }}</span>
                <select v-model="draftOf(lead).contacted">
                  <option value="">{{ $t('gainos.reports.contactedNone') }}</option>
                  <option value="yes">{{ $t('gainos.reports.contactedYes') }}</option>
                  <option value="no">{{ $t('gainos.reports.contactedNo') }}</option>
                </select>
              </label>
              <label class="rp__field"><span>{{ $t('gainos.reports.reason') }}</span>
                <select v-model="draftOf(lead).reasonCode">
                  <option value="">{{ $t('gainos.reports.reasonNone') }}</option>
                  <option v-for="code in REASON_CODES" :key="code" :value="code">{{ $t(`gainos.leads.reason.${code}`) }}</option>
                </select>
              </label>
              <label class="rp__field rp__field--wide"><span>{{ $t('gainos.reports.note') }}</span>
                <input v-model="draftOf(lead).note" :placeholder="$t('gainos.reports.notePlaceholder')" maxlength="2000" />
              </label>
            </div>
            <div class="rp__lead-actions">
              <button class="rp__cta" type="button" :disabled="outcomeBusy === lead.id" @click="submitOutcome(lead)">
                {{ outcomeBusy === lead.id ? $t('gainos.reports.submittingOutcome') : $t('gainos.reports.submitOutcome') }}
              </button>
              <span v-if="outcomeResult[lead.id]" class="rp__muted" :class="{ 'rp__ok': outcomeResult[lead.id]?.tone === 'ok' }">{{ outcomeResult[lead.id]?.text }}</span>
            </div>
          </article>
        </template>
      </section>
    </template>
  </div>
</template>

<style scoped>
.rp { padding: clamp(18px, 2.4vw, 32px) clamp(18px, 2.4vw, 34px) clamp(32px, 4vh, 48px); max-width: 1080px; margin: 0 auto; display: grid; gap: 18px; }
.rp__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.rp__stage { font-size: 11.5px; font-weight: 700; letter-spacing: .18em; color: var(--gs-accent-strong); }
.rp__head h1 { margin: 6px 0 0; font-size: 24px; font-weight: 700; color: var(--gs-fg); }
.rp__head p { margin: 8px 0 0; font-size: 13.5px; color: var(--gs-fg-muted); max-width: 620px; line-height: 1.7; }
.rp__refresh { border: 1px solid var(--gs-border-strong); background: var(--gs-surface); border-radius: 10px; padding: 8px 16px; font-size: 13px; color: var(--gs-fg-2); cursor: pointer; }
.rp__steps { list-style: none; margin: 0; padding: 0; display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }
.rp__step { display: flex; align-items: center; gap: 6px; flex: none; padding: 6px 10px; border-radius: 999px; font-size: 12px; color: var(--gs-fg-subtle); background: var(--gs-divider); }
.rp__step-dot { width: 19px; height: 19px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--gs-surface); font-size: 10.5px; font-weight: 700; }
.rp__step.is-done { color: var(--gs-accent-strong); background: var(--gs-accent-soft); }
.rp__step.is-current { color: #fff; background: var(--gs-accent); }
.rp__step.is-current .rp__step-dot { background: rgba(255,255,255,.22); color: #fff; }
.rp__notice { margin: 0; padding: 10px 14px; border-radius: 10px; background: var(--gs-accent-soft); color: var(--gs-accent-strong); font-size: 13px; font-weight: 600; }
.rp__error { border: 1px solid var(--gs-warn); background: var(--gs-warn-bg); border-radius: 10px; padding: 12px 14px; display: grid; gap: 4px; }
.rp__error h3 { margin: 0; font-size: 13.5px; color: var(--gs-warn); }
.rp__error p { margin: 0; font-size: 12.5px; color: var(--gs-fg-2); line-height: 1.65; }
.rp__muted { margin: 0; font-size: 12.5px; color: var(--gs-fg-subtle); line-height: 1.7; }
.rp__empty { max-width: 760px; margin: 0 auto; display: grid; place-items: center; gap: 8px; text-align: center; background: var(--gs-surface); border: 1px dashed var(--gs-border-dashed); border-radius: 16px; padding: 48px 24px; }
.rp__empty-title { margin: 0; font-size: 16.5px; font-weight: 600; color: var(--gs-fg); }
.rp__empty-desc { margin: 0 0 10px; font-size: 13.5px; color: var(--gs-fg-muted); max-width: 540px; line-height: 1.75; }
.rp__cta { border: 0; border-radius: 10px; padding: 9px 18px; background: var(--gs-accent); color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
.rp__cta:disabled { opacity: .45; cursor: not-allowed; }
.rp__filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px; padding: 16px 18px; }
.rp__field { display: grid; gap: 5px; font-size: 12.5px; color: var(--gs-fg-2); min-width: 180px; }
.rp__field select, .rp__field input { border: 1px solid var(--gs-border-strong); border-radius: 9px; padding: 9px 11px; font-size: 13px; background: var(--gs-surface); color: var(--gs-fg); }
.rp__withheld { margin: 0; font-size: 12.5px; color: var(--gs-warn); display: flex; gap: 12px; flex-wrap: wrap; }
.rp__card { background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px; padding: 20px 22px; display: grid; gap: 10px; }
.rp__card h2 { margin: 0; font-size: 16px; font-weight: 650; color: var(--gs-fg); }
.rp__upload { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.rp__upload input { font-size: 12.5px; color: var(--gs-fg-2); }
.rp__result { display: grid; gap: 6px; font-size: 13px; color: var(--gs-fg-2); }
.rp__result p { margin: 0; }
.rp__list { margin: 0; padding-left: 18px; font-size: 12.5px; color: var(--gs-warn); }
.rp__card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.rp__lead { border: 1px solid var(--gs-border); border-radius: 12px; padding: 14px 16px; display: grid; gap: 8px; }
.rp__lead-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.rp__chip { border-radius: 999px; padding: 2px 9px; background: var(--gs-accent-soft); color: var(--gs-accent-strong); font-size: 11px; font-weight: 650; }
.rp__outcome-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.rp__field--wide { grid-column: span 2; }
.rp__lead-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.rp__ok { color: var(--gs-accent-strong); font-weight: 600; }
@media (max-width: 720px) { .rp__head { flex-direction: column; } .rp__filters { flex-direction: column; align-items: stretch; } .rp__field--wide { grid-column: auto; } }
</style>
