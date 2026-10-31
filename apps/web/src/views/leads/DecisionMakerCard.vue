<script lang="ts" setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue';

import { $t } from '#/locales';

import {
  failureText,
  gainosApi,
  type CanonicalCompanyDetail,
  type CanonicalContact,
  type CanonicalContactPoint,
  type ContactEvidence,
  type LawfulBasisKind,
} from '#/api/gainos';

/**
 * 决策人卡片（联系人挖掘 M4）。
 *
 * - 数据来自引擎 canonical 公司详情（联系人 + 联系方式 + 字段级证据）；
 * - 三个写操作都先让操作者声明 GDPR Art.6 合法性依据，BFF 再按引擎合同签一次性预算 Grant；
 * - RISKY / 推断（猜测）邮箱必须二次确认才能发起验证；
 * - 来源层级按引擎许可区分「索引片段 / 历史档案 / 公开页」，绝不把推断显示成确定。
 */
defineOptions({ name: 'DecisionMakerCard' });

const props = defineProps<{ companyId: string }>();

type DialogKind = 'discover' | 'guess' | 'verify';

interface DialogState {
  kind: DialogKind;
  contact?: CanonicalContact;
  point?: CanonicalContactPoint;
}

const LAW = ['legitimate_interest', 'consent', 'contract', 'legal_obligation'] as const;

const detail = ref<CanonicalCompanyDetail | null>(null);
const loading = ref(false);
const loadError = ref<{ title: string; next?: string } | null>(null);
const busy = ref<DialogKind | null>(null);
const notice = ref<string | null>(null);
const actionError = ref<{ title: string; next?: string } | null>(null);
const dialog = ref<DialogState | null>(null);
const dialogRoot = ref<HTMLElement | null>(null);
const form = reactive({
  basis: '' as '' | LawfulBasisKind,
  ref: '',
  note: '',
  acknowledged: false,
});
let lastBasis: { basis: LawfulBasisKind; ref: string; note: string } | null = null;

const contacts = computed<CanonicalContact[]>(() => detail.value?.company.contacts ?? []);

function formatDate(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}

function evidenceOf(contactId: string): ContactEvidence[] {
  return (detail.value?.evidence ?? []).filter((row) => row.entityId === contactId);
}

/** 该联系人的邮箱是否来自猜测（email.guess 证据）——UI 上标为「推断（PROBABLE）」。 */
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

interface PointBadge {
  label: string;
  tone: 'ok' | 'warn' | 'danger' | 'muted';
}

/** 状态徽标：VALID / RISKY / PROBABLE（推断）/ BLOCKED / INVALID / UNVERIFIED 一律照实显示。 */
function pointBadge(contact: CanonicalContact, point: CanonicalContactPoint): PointBadge {
  if (point.status === 'VALID') return { label: $t('gainos.contacts.status.VALID'), tone: 'ok' };
  if (point.status === 'RISKY') {
    return isGuessedEmailPoint(contact, point)
      ? { label: $t('gainos.contacts.status.PROBABLE'), tone: 'warn' }
      : { label: $t('gainos.contacts.status.RISKY'), tone: 'warn' };
  }
  if (point.status === 'BLOCKED') return { label: $t('gainos.contacts.status.BLOCKED'), tone: 'danger' };
  if (point.status === 'INVALID') return { label: $t('gainos.contacts.status.INVALID'), tone: 'muted' };
  return { label: $t('gainos.contacts.status.UNVERIFIED'), tone: 'muted' };
}

function pointTypeLabel(type: string): string {
  const key = `gainos.contacts.type.${type}`;
  const translated = $t(key);
  return translated === key ? type : translated;
}

function statusLabel(status: string): string {
  const key = `gainos.contacts.status.${status}`;
  const translated = $t(key);
  return translated === key ? status : translated;
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
 * 每个联系人的来源面：优先 sourceUrl，其次 person.profile 的 source_page；按许可去重。
 * 带 URL 的行排在前面——联系点证据本身没有来源页，别让它挤掉唯一的来源链接。
 */
function contactSources(contact: CanonicalContact): ContactSource[] {
  const rows = evidenceOf(contact.id)
    .filter((row) => ['person.profile', 'email', 'phone', 'linkedin'].includes(row.field))
    .sort((a, b) => Date.parse(b.fetchedAt ?? '') - Date.parse(a.fetchedAt ?? ''));
  const ordered = [...rows.filter((row) => evidenceUrlOf(row)), ...rows.filter((row) => !evidenceUrlOf(row))];
  const out: ContactSource[] = [];
  for (const row of ordered) {
    const url = evidenceUrlOf(row);
    const key = `${url}|${row.license ?? ''}`;
    if (out.some((item) => item.key === key)) continue;
    out.push({ key, url, layer: layerLabel(row.license), at: formatDate(row.fetchedAt) });
    if (out.length >= 3) break;
  }
  return out;
}

function missingEmailCount(): number {
  return contacts.value.filter(
    (contact) =>
      !(contact.contactPoints ?? []).some((point) => point.type === 'email' && point.status !== 'INVALID'),
  ).length;
}

function roleLine(contact: CanonicalContact): string {
  return [contact.title, contact.department].filter((part): part is string => !!part && part.trim() !== '').join(' · ');
}

async function load(): Promise<void> {
  if (!props.companyId) return;
  loading.value = true;
  loadError.value = null;
  try {
    detail.value = await gainosApi.canonicalCompany(props.companyId);
  } catch (error) {
    loadError.value = failureText(error);
    detail.value = null;
  } finally {
    loading.value = false;
  }
}

function openDialog(kind: DialogKind, contact?: CanonicalContact, point?: CanonicalContactPoint): void {
  actionError.value = null;
  notice.value = null;
  form.basis = lastBasis?.basis ?? '';
  form.ref = lastBasis?.ref ?? '';
  form.note = lastBasis?.note ?? '';
  form.acknowledged = false;
  dialog.value = { kind, contact, point };
  // 把焦点移进弹窗,键盘用户不会继续停在背景卡片上。
  void nextTick(() => dialogRoot.value?.focus());
}

function closeDialog(): void {
  if (busy.value) return;
  dialog.value = null;
  actionError.value = null;
}

const dialogTitle = computed(() => {
  if (!dialog.value) return '';
  if (dialog.value.kind === 'discover') return $t('gainos.contacts.discoverTitle');
  if (dialog.value.kind === 'guess') return $t('gainos.contacts.guessTitle');
  return $t('gainos.contacts.verifyTitle');
});

const dialogDesc = computed(() => {
  if (!dialog.value) return '';
  if (dialog.value.kind === 'discover') return $t('gainos.contacts.discoverDesc');
  if (dialog.value.kind === 'guess') return $t('gainos.contacts.guessDesc');
  return $t('gainos.contacts.verifyDesc', { email: dialog.value.point?.value ?? '' });
});

const riskyTarget = computed(() => {
  if (!dialog.value || dialog.value.kind !== 'verify' || !dialog.value.point) return false;
  return dialog.value.point.status === 'RISKY';
});

const canSubmit = computed(() => {
  if (!dialog.value || busy.value) return false;
  if (!form.basis) return false;
  if (riskyTarget.value && !form.acknowledged) return false;
  return true;
});

function basisHint(): string {
  if (!form.basis) return $t('gainos.contacts.noBasis');
  return $t(`gainos.contacts.basisHint.${form.basis}`);
}

function complianceInput(): { lawfulBasis: LawfulBasisKind; lawfulBasisRef?: string; lawfulBasisNote?: string } {
  return {
    lawfulBasis: form.basis as LawfulBasisKind,
    ...(form.ref.trim() ? { lawfulBasisRef: form.ref.trim() } : {}),
    ...(form.note.trim() ? { lawfulBasisNote: form.note.trim() } : {}),
  };
}

async function submit(): Promise<void> {
  if (!dialog.value || !canSubmit.value) return;
  const current = dialog.value;
  busy.value = current.kind;
  actionError.value = null;
  try {
    if (current.kind === 'discover') {
      const result = await gainosApi.discoverContacts(props.companyId, complianceInput());
      notice.value = $t('gainos.contacts.discoverDone', { count: result.contacts?.length ?? 0 });
    } else if (current.kind === 'guess') {
      const result = await gainosApi.guessEmails(props.companyId, complianceInput());
      notice.value = $t('gainos.contacts.guessDone', {
        attempted: result.attempted ?? 0,
        persisted: result.persisted ?? 0,
        verified: result.verified ?? 0,
      });
    } else if (current.point) {
      const result = await gainosApi.verifyContactPoint(current.point.id, complianceInput());
      const status = result.verification?.status ?? result.status;
      notice.value =
        status === 'BLOCKED'
          ? $t('gainos.contacts.verifyBlocked')
          : $t('gainos.contacts.verifyDone', { status: statusLabel(status) });
    }
    lastBasis = { basis: form.basis as LawfulBasisKind, ref: form.ref.trim(), note: form.note.trim() };
    dialog.value = null;
    await load();
  } catch (error) {
    actionError.value = failureText(error);
  } finally {
    busy.value = null;
  }
}

/** 合法性依据弹窗打开时先截住 Escape,避免把外层的线索档案包一起关掉。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !dialog.value) return;
  event.stopPropagation();
  event.preventDefault();
  closeDialog();
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown, true);
  void load();
});
onUnmounted(() => window.removeEventListener('keydown', onKeydown, true));
</script>

<template>
  <section class="dm">
    <header class="dm__head">
      <div>
        <h3>{{ $t('gainos.contacts.title') }}</h3>
        <p class="dm__subtitle">{{ $t('gainos.contacts.subtitle') }}</p>
      </div>
      <div class="dm__head-actions">
        <button v-if="contacts.length" type="button" class="dm__action" :disabled="!!busy" @click="openDialog('guess')">
          {{ $t('gainos.contacts.guess') }}
        </button>
        <button type="button" class="dm__action dm__action--primary" :disabled="!!busy" @click="openDialog('discover')">
          {{ $t('gainos.contacts.discover') }}
        </button>
      </div>
    </header>

    <p v-if="loading" class="dm__muted">{{ $t('gainos.common.loading') }}</p>
    <div v-else-if="loadError" class="dm__error" role="alert">
      <h4>{{ loadError.title }}</h4>
      <p v-if="loadError.next">{{ loadError.next }}</p>
      <p v-if="loadError.title.includes('授权对接')" class="dm__muted">{{ $t('gainos.contacts.scopeHint') }}</p>
      <button type="button" class="dm__action" @click="load">{{ $t('gainos.common.refresh') }}</button>
    </div>
    <template v-else>
      <p v-if="notice" class="dm__notice" role="status">{{ notice }}</p>

      <div v-if="!contacts.length" class="dm__empty">
        <p class="dm__empty-title">{{ $t('gainos.contacts.emptyTitle') }}</p>
        <p class="dm__muted">{{ $t('gainos.contacts.emptyDesc') }}</p>
        <button type="button" class="dm__action dm__action--primary" :disabled="!!busy" @click="openDialog('discover')">
          {{ $t('gainos.contacts.emptyCta') }}
        </button>
      </div>

      <ul v-else class="dm__list">
        <li v-for="contact in contacts" :key="contact.id" class="dm__person">
          <div class="dm__person-head">
            <span class="dm__avatar" aria-hidden="true">{{ initials(contact.fullName) }}</span>
            <div class="dm__person-id">
              <p class="dm__name">{{ contact.fullName }}</p>
              <p class="dm__role">{{ roleLine(contact) || $t('gainos.contacts.roleUnknown') }}</p>
            </div>
            <span v-if="contact.seniority" class="dm__seniority">{{ seniorityLabel(contact.seniority) }}</span>
          </div>

          <ul v-if="visiblePoints(contact).length" class="dm__points">
            <li v-for="point in visiblePoints(contact)" :key="point.id" class="dm__point">
              <span class="dm__point-type">{{ pointTypeLabel(point.type) }}</span>
              <a v-if="pointHref(point)" class="dm__value" :href="pointHref(point)" target="_blank" rel="noreferrer">{{ point.value }}</a>
              <span v-else class="dm__value">{{ point.value }}</span>
              <span class="dm__badge" :class="`dm__badge--${pointBadge(contact, point).tone}`">
                {{ pointBadge(contact, point).label }}
              </span>
              <span v-if="point.verifiedAt" class="dm__date">{{ formatDate(point.verifiedAt) }}</span>
              <button
                v-if="point.type === 'email'"
                type="button"
                class="dm__verify"
                :disabled="!!busy"
                @click="openDialog('verify', contact, point)"
              >
                {{ $t('gainos.contacts.verify') }}
              </button>
            </li>
          </ul>
          <p v-else class="dm__muted">{{ $t('gainos.contacts.noPoints') }}</p>

          <div class="dm__sources">
            <span class="dm__sources-label">{{ $t('gainos.contacts.source') }}</span>
            <template v-if="contactSources(contact).length">
              <span v-for="source in contactSources(contact)" :key="source.key" class="dm__source">
                <a v-if="source.url" :href="source.url" target="_blank" rel="noreferrer">{{ source.layer }}</a>
                <span v-else>{{ source.layer }}</span>
                <time v-if="source.at">· {{ source.at }}</time>
              </span>
            </template>
            <span v-else class="dm__muted">{{ $t('gainos.contacts.sourceUnknown') }}</span>
          </div>
        </li>
      </ul>

      <p v-if="contacts.length && missingEmailCount()" class="dm__muted">
        {{ $t('gainos.contacts.missingEmail', { count: missingEmailCount() }) }}
      </p>
    </template>

    <div v-if="dialog" class="dm__overlay" @click.self="closeDialog">
      <section ref="dialogRoot" class="dm__dialog" role="dialog" aria-modal="true" tabindex="-1" :aria-label="dialogTitle">
        <header class="dm__dialog-head">
          <h4>{{ dialogTitle }}</h4>
          <button type="button" class="dm__close" :aria-label="$t('gainos.contacts.closeDialog')" @click="closeDialog">×</button>
        </header>
        <p class="dm__muted">{{ dialogDesc }}</p>

        <p v-if="riskyTarget" class="dm__warning" role="alert">{{ $t('gainos.contacts.riskyWarning') }}</p>

        <label class="dm__field">
          <span>{{ $t('gainos.contacts.lawfulBasis') }}<em> *</em></span>
          <select v-model="form.basis">
            <option value="">{{ $t('gainos.contacts.lawfulBasisPlaceholder') }}</option>
            <option v-for="kind in LAW" :key="kind" :value="kind">{{ $t(`gainos.contacts.basis.${kind}`) }}</option>
          </select>
        </label>
        <p class="dm__basis-hint" :class="{ 'is-warn': !form.basis }">{{ basisHint() }}</p>

        <label class="dm__field">
          <span>{{ $t('gainos.contacts.lawfulBasisRef') }}</span>
          <input v-model="form.ref" type="text" maxlength="512" :placeholder="$t('gainos.contacts.lawfulBasisRefPlaceholder')" />
        </label>
        <label class="dm__field">
          <span>{{ $t('gainos.contacts.lawfulBasisNote') }}</span>
          <input v-model="form.note" type="text" maxlength="1000" />
        </label>

        <label v-if="riskyTarget" class="dm__ack">
          <input v-model="form.acknowledged" type="checkbox" />
          <span>{{ $t('gainos.contacts.acknowledge') }}</span>
        </label>

        <div v-if="actionError" class="dm__error" role="alert">
          <h4>{{ actionError.title }}</h4>
          <p v-if="actionError.next">{{ actionError.next }}</p>
        </div>

        <div class="dm__dialog-actions">
          <button type="button" class="dm__action" :disabled="!!busy" @click="closeDialog">{{ $t('gainos.common.cancel') }}</button>
          <button type="button" class="dm__action dm__action--primary" :disabled="!canSubmit" @click="submit">
            {{ busy ? $t('gainos.contacts.submitting') : $t('gainos.contacts.submit') }}
          </button>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.dm { display: grid; gap: 10px; border-top: 1px solid var(--gs-border); padding-top: 16px; }
.dm__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.dm__head h3 { margin: 0 0 4px; font-size: 13px; font-weight: 650; color: var(--gs-fg); }
.dm__subtitle { margin: 0; font-size: 12px; color: var(--gs-fg-subtle); line-height: 1.65; max-width: 560px; }
.dm__head-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.dm__action {
  border: 1px solid var(--gs-border-strong); background: var(--gs-surface); color: var(--gs-fg-2);
  border-radius: 9px; padding: 7px 13px; font-size: 12.5px; cursor: pointer; font-family: inherit;
}
.dm__action:hover:not(:disabled) { border-color: var(--gs-accent); color: var(--gs-accent-strong); }
.dm__action:disabled { opacity: .55; cursor: not-allowed; }
.dm__action--primary { background: var(--gs-accent); border-color: var(--gs-accent); color: #fff; font-weight: 600; }
.dm__action--primary:hover:not(:disabled) { color: #fff; }
.dm__muted { margin: 0; font-size: 12.5px; color: var(--gs-fg-subtle); line-height: 1.7; }
.dm__notice { margin: 0; padding: 8px 12px; border-radius: 9px; background: var(--gs-accent-soft); color: var(--gs-accent-strong); font-size: 12.5px; font-weight: 600; }
.dm__error { border: 1px solid var(--gs-warn); background: var(--gs-warn-bg); border-radius: 10px; padding: 10px 12px; display: grid; gap: 4px; justify-items: start; }
.dm__error h4 { margin: 0; font-size: 13px; color: var(--gs-warn); }
.dm__error p { margin: 0; font-size: 12.5px; color: var(--gs-fg-2); line-height: 1.65; }
.dm__empty {
  border: 1px dashed var(--gs-border-dashed); border-radius: 12px; padding: 20px 16px;
  display: grid; gap: 6px; justify-items: start;
}
.dm__empty-title { margin: 0; font-size: 13.5px; font-weight: 650; color: var(--gs-fg); }
.dm__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.dm__person { border: 1px solid var(--gs-border); border-radius: 12px; padding: 12px 14px; display: grid; gap: 8px; background: var(--gs-surface); }
.dm__person-head { display: flex; align-items: center; gap: 10px; }
.dm__avatar {
  width: 34px; height: 34px; border-radius: 50%; flex: none; display: inline-flex; align-items: center; justify-content: center;
  background: var(--gs-accent-soft); color: var(--gs-accent-strong); font-size: 12px; font-weight: 700;
}
.dm__person-id { min-width: 0; flex: 1 1 auto; }
.dm__name { margin: 0; font-size: 13.5px; font-weight: 650; color: var(--gs-fg); }
.dm__role { margin: 2px 0 0; font-size: 12px; color: var(--gs-fg-subtle); }
.dm__seniority { flex: none; font-size: 11px; font-weight: 600; color: var(--gs-fg-2); background: var(--gs-divider); border-radius: 999px; padding: 2px 8px; }
.dm__points { list-style: none; margin: 0; padding: 0; display: grid; gap: 5px; }
.dm__point { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; }
.dm__point-type { flex: none; font-size: 11px; color: var(--gs-fg-subtle); min-width: 44px; }
.dm__value { color: var(--gs-fg-2); overflow-wrap: anywhere; }
a.dm__value { color: var(--gs-accent-strong); text-decoration: underline; }
.dm__badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--gs-divider); color: var(--gs-fg-2); }
.dm__badge--ok { background: var(--gs-accent-soft); color: var(--gs-accent-strong); }
.dm__badge--warn { background: var(--gs-warn-bg); color: var(--gs-warn); }
.dm__badge--danger { background: var(--gs-warn-bg); color: var(--gs-danger); }
.dm__badge--muted { background: var(--gs-divider); color: var(--gs-fg-subtle); }
.dm__date { font-size: 11px; color: var(--gs-fg-subtle); font-variant-numeric: tabular-nums; }
.dm__verify {
  border: 0; background: transparent; color: var(--gs-accent-strong); font-size: 12px; cursor: pointer;
  padding: 0; text-decoration: underline; font-family: inherit;
}
.dm__verify:disabled { opacity: .55; cursor: not-allowed; }
.dm__sources { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 11.5px; color: var(--gs-fg-subtle); }
.dm__sources-label { font-weight: 600; }
.dm__source { display: inline-flex; gap: 4px; align-items: center; }
.dm__source a { color: var(--gs-accent-strong); text-decoration: underline; }
.dm__overlay {
  position: fixed; inset: 0; z-index: 1020; background: rgba(15, 23, 42, .58); backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center; padding: 20px;
}
.dm__dialog {
  width: min(520px, 100%); max-height: calc(100dvh - 40px); overflow-y: auto; box-sizing: border-box;
  background: var(--gs-surface); border-radius: 16px; padding: 18px 20px 20px; display: grid; gap: 10px;
  box-shadow: 0 24px 60px -20px rgba(15, 23, 42, .4); outline: none;
}
.dm__dialog-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.dm__dialog-head h4 { margin: 0; font-size: 15px; font-weight: 700; color: var(--gs-fg); }
.dm__close { border: 0; background: transparent; font-size: 22px; line-height: 1; color: var(--gs-fg-subtle); cursor: pointer; padding: 0 4px; }
.dm__warning { margin: 0; padding: 9px 12px; border-radius: 9px; background: var(--gs-warn-bg); border: 1px solid var(--gs-warn); color: var(--gs-warn); font-size: 12.5px; line-height: 1.65; }
.dm__field { display: grid; gap: 5px; font-size: 12.5px; color: var(--gs-fg-2); }
.dm__field em { color: var(--gs-warn); font-style: normal; }
.dm__field select, .dm__field input {
  width: 100%; box-sizing: border-box; border: 1px solid var(--gs-border-strong); border-radius: 9px; background: var(--gs-surface);
  color: var(--gs-fg); padding: 8px 10px; font-size: 13px; font-family: inherit;
}
.dm__basis-hint { margin: 0; font-size: 12px; color: var(--gs-fg-subtle); line-height: 1.6; }
.dm__basis-hint.is-warn { color: var(--gs-warn); }
.dm__ack { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; color: var(--gs-fg-2); line-height: 1.55; }
.dm__ack input { margin-top: 2px; }
.dm__dialog-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; flex-wrap: wrap; }
@media (max-width: 720px) {
  .dm__head { flex-direction: column; }
  .dm__dialog-actions { flex-direction: column-reverse; }
  .dm__dialog-actions .dm__action { width: 100%; }
}
</style>
