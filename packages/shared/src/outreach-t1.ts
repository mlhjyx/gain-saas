/**
 * Phase 3 Track 3C 共享纯逻辑（浏览器 + 服务端共用，零外部依赖）：
 * - T1 2–4 轮自动跟进序列规划与硬终止判定（Day 0 / Day 3 / Day 7 / Day 14）；
 * - 卖家画册 PDF / HTML 附件引用校验（仅 ready 状态、合法 MIME 与 ≤10MB 上限）；
 * - 转交联系人（REFERRAL）从回复记录中抽取与去重；
 * - Track 3B 信号破冰首句（LeadPackage.icebreakerSuggestions）规范化与幂等插入；
 * - Track 3B 真实反馈自进化回路 DTO（#87）映射与摘要规范化；
 * - 发信域 SPF / DKIM / DMARC / MX DNS 体检建议生成。
 */

import {
  isSafeHttpUrl,
  resolveD3JurisdictionPolicy,
  type D3JurisdictionPolicy,
  type T0ConsentState,
} from './outreach-t0.js';

export const T1_SEQUENCE_DAY_OFFSETS = [0, 3, 7, 14] as const;
export const T1_MAX_ATTACHMENTS = 3;
export const T1_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const T1_ALLOWED_ATTACHMENT_MIMES = new Set(['application/pdf', 'text/html']);

export type T1SequenceStopReason =
  | 'REPLY_RECEIVED'
  | 'OPT_OUT'
  | 'HARD_BOUNCE'
  | 'COMPLAINT'
  | 'SUPPRESSED'
  | 'JURISDICTION_BLOCKED'
  | 'DNC_UNAVAILABLE';

export type T1SequenceStepStatus = 'sent' | 'scheduled' | 'stopped' | 'blocked';

export interface T1SequenceEventLike {
  kind: 'REPLY' | 'BOUNCE' | 'UNSUBSCRIBE' | 'COMPLAINT' | string;
  classification?: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'OUT_OF_OFFICE' | 'UNKNOWN' | string | null;
  receivedAt?: string | null;
}

export interface T1SequenceStep {
  round: number;
  dayOffset: number;
  scheduledAt: string;
  subject: string;
  body: string;
  status: T1SequenceStepStatus;
  stopReason: T1SequenceStopReason | null;
}

export interface T1FollowUpSequenceInput {
  companyName?: string | null;
  contactName?: string | null;
  countryCode?: string | null;
  subject: string;
  body: string;
  /** 2–4 轮（默认 3 轮：Day 0 / Day 3 / Day 7）。 */
  rounds?: number;
  /** 已发轮次（用于已有触达进展后重算剩余轮次）。 */
  sentRounds?: number;
  startAt?: string | Date;
  consentStatus?: T0ConsentState | null;
  suppressed?: boolean;
  dncCheckFailed?: boolean;
  events?: readonly T1SequenceEventLike[];
  /** 可选自定义每一轮文案（索引 0 对应第 1 轮）。 */
  customSteps?: ReadonlyArray<{ subject?: string; body?: string }>;
}

export interface T1FollowUpSequencePlan {
  rounds: number;
  jurisdictionPolicy: D3JurisdictionPolicy;
  stopped: boolean;
  stopReason: T1SequenceStopReason | null;
  activeRoundCount: number;
  steps: T1SequenceStep[];
}

function buildFollowUpBody(round: number, companyName: string, contactName: string, initialBody: string): string {
  const greeting = contactName ? `Hi ${contactName},` : companyName ? `Hello ${companyName} team,` : 'Hello,';
  if (round === 1) return initialBody;
  if (round === 2) {
    return `${greeting}\n\nFollowing up briefly on my note below — happy to send our product datasheet, certifications, and indicative FOB/CIF pricing if helpful.\n\nBest regards,`;
  }
  if (round === 3) {
    return `${greeting}\n\nWanted to check whether you or a colleague on the purchasing team handles supplier evaluations for this category. Glad to coordinate a short technical intro.\n\nBest regards,`;
  }
  return `${greeting}\n\nClosing the loop on my earlier messages so I don't crowd your inbox. Please let me know anytime if you'd like updated specifications or samples.\n\nBest regards,`;
}

function normalizeFollowUpSubject(round: number, baseSubject: string): string {
  const trimmed = baseSubject.trim() || 'B2B Supply Inquiry';
  if (round === 1) return trimmed;
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

/** 评估序列硬终止原因：任何回信 / OPT_OUT / BOUNCE / COMPLAINT / SUPPRESSED / D3 红线立即硬停。 */
export function evaluateT1SequenceStopReason(input: {
  countryCode?: string | null;
  companyName?: string | null;
  consentStatus?: T0ConsentState | null;
  suppressed?: boolean;
  dncCheckFailed?: boolean;
  events?: readonly T1SequenceEventLike[];
}): { jurisdictionPolicy: D3JurisdictionPolicy; stopReason: T1SequenceStopReason | null } {
  const jurisdictionPolicy = resolveD3JurisdictionPolicy(input.countryCode, {
    companyName: input.companyName,
  });
  if (input.dncCheckFailed) {
    return { jurisdictionPolicy, stopReason: 'DNC_UNAVAILABLE' };
  }
  if (input.suppressed) {
    return { jurisdictionPolicy, stopReason: 'SUPPRESSED' };
  }
  if (input.consentStatus === 'OPT_OUT') {
    return { jurisdictionPolicy, stopReason: 'OPT_OUT' };
  }
  for (const ev of input.events ?? []) {
    const kind = String(ev.kind ?? '').toUpperCase();
    if (kind === 'COMPLAINT') return { jurisdictionPolicy, stopReason: 'COMPLAINT' };
    if (kind === 'UNSUBSCRIBE') return { jurisdictionPolicy, stopReason: 'OPT_OUT' };
    if (kind === 'BOUNCE') return { jurisdictionPolicy, stopReason: 'HARD_BOUNCE' };
    if (kind === 'REPLY') return { jurisdictionPolicy, stopReason: 'REPLY_RECEIVED' };
  }
  if (
    (jurisdictionPolicy === 'CONSENT_REQUIRED' || jurisdictionPolicy === 'REVIEW_REQUIRED') &&
    input.consentStatus !== 'OPT_IN'
  ) {
    return { jurisdictionPolicy, stopReason: 'JURISDICTION_BLOCKED' };
  }
  return { jurisdictionPolicy, stopReason: null };
}

/** 生成 2–4 轮（Day 0 / Day 3 / Day 7 / Day 14）自动跟进序列规划，并叠加全部合规/回信硬终止门禁。 */
export function planT1FollowUpSequence(input: T1FollowUpSequenceInput): T1FollowUpSequencePlan {
  const rounds = Math.min(4, Math.max(2, Math.trunc(Number(input.rounds ?? 3))));
  const sentRounds = Math.min(rounds, Math.max(0, Math.trunc(Number(input.sentRounds ?? 0))));
  const startDate = input.startAt instanceof Date ? input.startAt : new Date(input.startAt ?? Date.now());
  const baseMs = Number.isNaN(startDate.getTime()) ? Date.now() : startDate.getTime();
  const companyName = (input.companyName ?? '').trim();
  const contactName = (input.contactName ?? '').trim();

  const { jurisdictionPolicy, stopReason } = evaluateT1SequenceStopReason({
    countryCode: input.countryCode,
    companyName: input.companyName,
    consentStatus: input.consentStatus,
    suppressed: input.suppressed,
    dncCheckFailed: input.dncCheckFailed,
    events: input.events,
  });

  const stopped = stopReason !== null;
  const blockedByGate =
    stopReason === 'JURISDICTION_BLOCKED' || stopReason === 'DNC_UNAVAILABLE';

  const steps: T1SequenceStep[] = [];
  for (let i = 0; i < rounds; i += 1) {
    const round = i + 1;
    const dayOffset = T1_SEQUENCE_DAY_OFFSETS[i] ?? i * 3;
    const scheduledAt = new Date(baseMs + dayOffset * 86_400_000).toISOString();
    const custom = input.customSteps?.[i];
    const subject =
      custom?.subject?.trim() || normalizeFollowUpSubject(round, input.subject);
    const body =
      custom?.body?.trim() || buildFollowUpBody(round, companyName, contactName, input.body.trim());

    let status: T1SequenceStepStatus;
    let stepStop: T1SequenceStopReason | null = null;
    if (round <= sentRounds) {
      status = 'sent';
    } else if (stopped) {
      status = blockedByGate ? 'blocked' : 'stopped';
      stepStop = stopReason;
    } else {
      status = 'scheduled';
    }

    steps.push({
      round,
      dayOffset,
      scheduledAt,
      subject,
      body,
      status,
      stopReason: stepStop,
    });
  }

  return {
    rounds,
    jurisdictionPolicy,
    stopped,
    stopReason,
    activeRoundCount: steps.filter((s) => s.status === 'scheduled').length,
    steps,
  };
}

// ── PDF / HTML 画册附件引用校验 ──────────────────────────────────────────────

export interface T1AttachmentRef {
  documentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
}

export interface T1AttachmentValidationError {
  documentId: string;
  code:
    | 'ATTACHMENT_LIMIT_EXCEEDED'
    | 'ATTACHMENT_DUPLICATE'
    | 'ATTACHMENT_NOT_READY'
    | 'ATTACHMENT_MIME_NOT_ALLOWED'
    | 'ATTACHMENT_TOO_LARGE'
    | 'ATTACHMENT_INVALID';
  message: string;
}

export interface T1AttachmentValidationResult {
  ok: boolean;
  valid: T1AttachmentRef[];
  errors: T1AttachmentValidationError[];
}

export function validateT1Attachments(
  attachments: readonly T1AttachmentRef[] | null | undefined,
): T1AttachmentValidationResult {
  const list = Array.isArray(attachments) ? attachments : [];
  const valid: T1AttachmentRef[] = [];
  const errors: T1AttachmentValidationError[] = [];
  const seen = new Set<string>();

  if (list.length > T1_MAX_ATTACHMENTS) {
    errors.push({
      documentId: list[T1_MAX_ATTACHMENTS]?.documentId ?? '',
      code: 'ATTACHMENT_LIMIT_EXCEEDED',
      message: `单封草稿最多关联 ${T1_MAX_ATTACHMENTS} 份画册附件`,
    });
  }

  for (const item of list) {
    const id = String(item?.documentId ?? '').trim();
    const filename = String(item?.filename ?? '').trim();
    const mimeType = String(item?.mimeType ?? '').trim().toLowerCase().split(';')[0] ?? '';
    const sizeBytes = Number(item?.sizeBytes ?? 0);
    const status = String(item?.status ?? '').trim().toLowerCase();

    if (!id || !filename) {
      errors.push({
        documentId: id,
        code: 'ATTACHMENT_INVALID',
        message: '附件标识与文件名不能为空',
      });
      continue;
    }
    if (seen.has(id)) {
      errors.push({
        documentId: id,
        code: 'ATTACHMENT_DUPLICATE',
        message: `重复选择附件：${filename}`,
      });
      continue;
    }
    seen.add(id);

    if (status !== 'ready') {
      errors.push({
        documentId: id,
        code: 'ATTACHMENT_NOT_READY',
        message: `附件 ${filename} 尚未解析就绪（当前状态：${status || 'unknown'}）`,
      });
      continue;
    }
    if (!T1_ALLOWED_ATTACHMENT_MIMES.has(mimeType)) {
      errors.push({
        documentId: id,
        code: 'ATTACHMENT_MIME_NOT_ALLOWED',
        message: `附件 ${filename} 类型不支持（仅允许 PDF 或 HTML）`,
      });
      continue;
    }
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > T1_MAX_ATTACHMENT_BYTES) {
      errors.push({
        documentId: id,
        code: 'ATTACHMENT_TOO_LARGE',
        message: `附件 ${filename} 体积须大于 0 且不超过 10 MB`,
      });
      continue;
    }
    if (valid.length < T1_MAX_ATTACHMENTS) {
      valid.push({
        documentId: id,
        filename,
        mimeType,
        sizeBytes,
        status: 'ready',
      });
    }
  }

  return {
    ok: errors.length === 0,
    valid,
    errors,
  };
}

// ── 转交联系人（REFERRAL）抽取 ───────────────────────────────────────────────

export interface OutreachReplyLike {
  id: string;
  contactRef: string;
  recipientEmail?: string | null;
  kind?: string | null;
  classification?: string | null;
  subject?: string | null;
  snippet?: string | null;
  referredEmails?: readonly string[] | null;
  receivedAt?: string | null;
}

export interface ReferredContactLead {
  replyId: string;
  contactRef: string;
  sourceEmail: string | null;
  referredEmail: string;
  subject: string | null;
  snippet: string | null;
  receivedAt: string | null;
}

function isPlausibleEmail(token: string): boolean {
  if (!token || token.length > 320) return false;
  const at = token.indexOf('@');
  if (at <= 0 || at !== token.lastIndexOf('@')) return false;
  const local = token.slice(0, at);
  const domain = token.slice(at + 1);
  if (!local || !domain || domain.startsWith('.') || domain.endsWith('.')) return false;
  for (let i = 0; i < local.length; i += 1) {
    const ch = local[i]!;
    if (!/[a-z0-9._%+-]/i.test(ch)) return false;
  }
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  const tld = labels[labels.length - 1]!;
  if (tld.length < 2 || !/^[a-z]{2,63}$/i.test(tld)) return false;
  return labels.every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9-]+$/i.test(label));
}

function extractEmailsFromReferredTags(snippet: string): string[] {
  const found: string[] = [];
  const lower = snippet.toLowerCase();
  const marker = '[referred:';
  let cursor = 0;
  while (cursor < snippet.length) {
    const start = lower.indexOf(marker, cursor);
    if (start === -1) break;
    const end = snippet.indexOf(']', start + marker.length);
    if (end === -1) break;
    const segment = snippet.slice(start + marker.length, end);
    const tokens = segment.split(/[\s,;<>"'()]+/);
    for (const raw of tokens) {
      const cleaned = raw.trim().toLowerCase();
      if (isPlausibleEmail(cleaned)) {
        found.push(cleaned);
      }
    }
    cursor = end + 1;
  }
  return found;
}

export function extractReferredContacts(
  replies: readonly OutreachReplyLike[] | null | undefined,
): ReferredContactLead[] {
  if (!Array.isArray(replies) || replies.length === 0) return [];
  const results: ReferredContactLead[] = [];
  const seenEmails = new Set<string>();

  for (const reply of replies) {
    const kind = String(reply?.kind ?? 'REPLY').toUpperCase();
    if (kind !== 'REPLY') continue;
    const sourceEmail = reply.recipientEmail?.trim().toLowerCase() || null;
    const candidates: string[] = [];

    if (Array.isArray(reply.referredEmails)) {
      for (const addr of reply.referredEmails) {
        if (typeof addr === 'string' && addr.trim()) {
          const cleaned = addr.trim().toLowerCase();
          if (isPlausibleEmail(cleaned)) candidates.push(cleaned);
        }
      }
    }
    const snippet = typeof reply.snippet === 'string' ? reply.snippet : '';
    if (snippet) {
      candidates.push(...extractEmailsFromReferredTags(snippet));
    }

    for (const email of candidates) {
      if (!email || email.length > 320) continue;
      if (sourceEmail && email === sourceEmail) continue;
      if (seenEmails.has(email)) continue;
      seenEmails.add(email);
      results.push({
        replyId: reply.id,
        contactRef: reply.contactRef,
        sourceEmail,
        referredEmail: email,
        subject: reply.subject ?? null,
        snippet: reply.snippet ?? null,
        receivedAt: reply.receivedAt ?? null,
      });
    }
  }

  return results;
}

// ── Track 3B 信号破冰首句（#87） ─────────────────────────────────────────────

export interface SignalIcebreakerSuggestion {
  signalType: string;
  signalTitle: string;
  signalUrl: string | null;
  detectedAt: string | null;
  openerZh: string;
  openerEn: string;
}

export function normalizeIcebreakerSuggestions(raw: unknown): SignalIcebreakerSuggestion[] {
  if (!raw || typeof raw !== 'object') return [];
  const container = raw as Record<string, unknown>;
  const source = Array.isArray(raw)
    ? raw
    : Array.isArray(container.icebreakerSuggestions)
      ? container.icebreakerSuggestions
      : Array.isArray(container.icebreaker_suggestions)
        ? container.icebreaker_suggestions
        : [];

  const out: SignalIcebreakerSuggestion[] = [];
  for (const item of source) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const signalType = String(row.signalType ?? row.signal_type ?? '').trim();
    const signalTitle = String(row.signalTitle ?? row.signal_title ?? '').trim();
    const rawUrl = typeof (row.signalUrl ?? row.signal_url) === 'string'
      ? String(row.signalUrl ?? row.signal_url).trim()
      : '';
    const signalUrl = rawUrl && isSafeHttpUrl(rawUrl) ? rawUrl : null;
    const detectedAtRaw = row.detectedAt ?? row.detected_at;
    const detectedAt = typeof detectedAtRaw === 'string' && detectedAtRaw.trim() ? detectedAtRaw.trim() : null;
    const openerZh = String(row.openerZh ?? row.opener_zh ?? '').trim();
    const openerEn = String(row.openerEn ?? row.opener_en ?? '').trim();
    if (!signalType || (!openerZh && !openerEn)) continue;
    out.push({
      signalType,
      signalTitle: signalTitle || signalType,
      signalUrl,
      detectedAt,
      openerZh: openerZh || openerEn,
      openerEn: openerEn || openerZh,
    });
    if (out.length >= 3) break;
  }
  return out;
}

/** 将信号破冰首句幂等插入外联正文开头（已包含该句时不重复插入）。 */
export function insertIcebreakerIntoBody(opener: string, existingBody: string): string {
  const cleanOpener = opener.trim();
  if (!cleanOpener) return existingBody;
  const cleanBody = existingBody.trim();
  if (!cleanBody) return cleanOpener;
  if (cleanBody.includes(cleanOpener)) return existingBody;
  return `${cleanOpener}\n\n${cleanBody}`;
}

// ── Track 3B 真实反馈自进化回路（#87） ──────────────────────────────────────

export type FeedbackOutcomeCode =
  | 'rejected'
  | 'replied_positive'
  | 'booked_meeting'
  | 'opt_out'
  | 'wrong_contact'
  | 'bounced';

export type FeedbackRejectionReasonCode =
  | 'wrong_role_peer'
  | 'wrong_industry'
  | 'too_small'
  | 'wrong_country'
  | 'dead_company'
  | 'bounced_unreachable';

export const PHASE3_REJECTION_REASON_CODES: readonly FeedbackRejectionReasonCode[] = [
  'wrong_role_peer',
  'wrong_industry',
  'too_small',
  'wrong_country',
  'dead_company',
  'bounced_unreachable',
] as const;

export interface IcpFeedbackRecordInput {
  leadId?: string;
  companyId?: string;
  domain?: string;
  companyName?: string;
  industry?: string;
  outcome: FeedbackOutcomeCode;
  rejectionReason?: FeedbackRejectionReasonCode;
  excludedKeywords?: string[];
  note?: string;
}

export interface IcpFeedbackCounterExample {
  domain: string | null;
  companyName: string | null;
  industry: string | null;
  outcome: FeedbackOutcomeCode;
  reason: FeedbackRejectionReasonCode | 'unspecified';
  note: string | null;
  recordedAt: string;
}

export interface IcpFeedbackPositiveExample {
  domain: string | null;
  companyName: string | null;
  industry: string | null;
  outcome: 'replied_positive' | 'booked_meeting';
  recordedAt: string;
}

export interface IcpFeedbackSummaryDto {
  icpId: string;
  icpName: string;
  icpVersion: number;
  excludedDomains: string[];
  excludedKeywords: string[];
  excludedBusinessModels: string[];
  counterExamples: IcpFeedbackCounterExample[];
  positiveExamples: IcpFeedbackPositiveExample[];
  stats: {
    totalRecorded: number;
    outcomeCounts: Record<string, number>;
    rejectionReasonCounts: Record<string, number>;
    lastRecordedAt: string | null;
  };
}

export interface IcpFeedbackRecordResult {
  icpId: string;
  icpVersion: number;
  recorded: {
    outcome: FeedbackOutcomeCode;
    rejectionReason: FeedbackRejectionReasonCode | null;
    domain: string | null;
    companyId: string | null;
    leadId: string | null;
    recordedAt: string;
  };
  appliedRules: {
    addedExcludedDomain: string | null;
    addedExcludedKeywords: string[];
    addedCounterExample: boolean;
  };
  summary: IcpFeedbackSummaryDto;
}

const REJECT_CODE_TO_FEEDBACK: Record<string, FeedbackRejectionReasonCode> = {
  NOT_TARGET_ROLE: 'wrong_role_peer',
  WRONG_ROLE_PEER: 'wrong_role_peer',
  WRONG_PRODUCT: 'wrong_industry',
  WRONG_INDUSTRY: 'wrong_industry',
  TOO_SMALL: 'too_small',
  WRONG_COUNTRY: 'wrong_country',
  DEAD_COMPANY: 'dead_company',
  BAD_CONTACT_PATH: 'bounced_unreachable',
  BOUNCED_UNREACHABLE: 'bounced_unreachable',
};

export function mapRejectCodeToFeedbackReason(
  code?: string | null,
): FeedbackRejectionReasonCode | undefined {
  if (!code) return undefined;
  const upper = code.trim().toUpperCase();
  return REJECT_CODE_TO_FEEDBACK[upper];
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((v) => String(v ?? '').trim()).filter(Boolean))];
}

function asCountRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) out[k] = Math.trunc(n);
  }
  return out;
}

/** 规范化 Track 3B `GET /icps/:icpId/feedback/summary`（兼容 #87 完整结构与部分字段降级）。 */
export function normalizeIcpFeedbackSummary(raw: unknown): IcpFeedbackSummaryDto {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const statsRaw =
    obj.stats && typeof obj.stats === 'object' ? (obj.stats as Record<string, unknown>) : {};

  const counterExamples: IcpFeedbackCounterExample[] = Array.isArray(obj.counterExamples)
    ? obj.counterExamples
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .slice(0, 5)
        .map((item) => ({
          domain: typeof item.domain === 'string' && item.domain.trim() ? item.domain.trim() : null,
          companyName:
            typeof item.companyName === 'string' && item.companyName.trim()
              ? item.companyName.trim()
              : null,
          industry:
            typeof item.industry === 'string' && item.industry.trim() ? item.industry.trim() : null,
          outcome: (String(item.outcome ?? 'rejected') as FeedbackOutcomeCode),
          reason: (String(item.reason ?? item.rejectionReason ?? 'unspecified') as
            | FeedbackRejectionReasonCode
            | 'unspecified'),
          note: typeof item.note === 'string' && item.note.trim() ? item.note.trim() : null,
          recordedAt: typeof item.recordedAt === 'string' ? item.recordedAt : '',
        }))
    : [];

  const positiveExamples: IcpFeedbackPositiveExample[] = Array.isArray(obj.positiveExamples)
    ? obj.positiveExamples
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .slice(0, 5)
        .map((item) => ({
          domain: typeof item.domain === 'string' && item.domain.trim() ? item.domain.trim() : null,
          companyName:
            typeof item.companyName === 'string' && item.companyName.trim()
              ? item.companyName.trim()
              : null,
          industry:
            typeof item.industry === 'string' && item.industry.trim() ? item.industry.trim() : null,
          outcome:
            item.outcome === 'booked_meeting' ? 'booked_meeting' : 'replied_positive',
          recordedAt: typeof item.recordedAt === 'string' ? item.recordedAt : '',
        }))
    : [];

  return {
    icpId: typeof obj.icpId === 'string' ? obj.icpId : '',
    icpName: typeof obj.icpName === 'string' ? obj.icpName : '',
    icpVersion: Number.isFinite(Number(obj.icpVersion)) ? Number(obj.icpVersion) : 1,
    excludedDomains: asStringArray(obj.excludedDomains),
    excludedKeywords: asStringArray(obj.excludedKeywords),
    excludedBusinessModels: asStringArray(obj.excludedBusinessModels),
    counterExamples,
    positiveExamples,
    stats: {
      totalRecorded: Number.isFinite(Number(statsRaw.totalRecorded ?? obj.totalFeedback))
        ? Math.max(0, Math.trunc(Number(statsRaw.totalRecorded ?? obj.totalFeedback)))
        : counterExamples.length + positiveExamples.length,
      outcomeCounts: asCountRecord(statsRaw.outcomeCounts),
      rejectionReasonCounts: asCountRecord(statsRaw.rejectionReasonCounts ?? obj.reasonCounts),
      lastRecordedAt: typeof statsRaw.lastRecordedAt === 'string' ? statsRaw.lastRecordedAt : null,
    },
  };
}

// ── 发信域 SPF / DKIM / DMARC / MX DNS 体检建议 ─────────────────────────────

export interface DomainDnsReportLike {
  domain: string;
  mx: Array<{ exchange: string; priority: number }>;
  spf: { present: boolean; record: string | null; qualifier: string | null };
  dmarc: { present: boolean; record: string | null; policy: string | null; pct: number | null; hasRua: boolean };
  dkim: { present: boolean; selector: string };
  ok: { spf: boolean; dmarc: boolean; dkim: boolean; mx: boolean };
  ready: boolean;
}

export interface DomainDnsAdviceItem {
  key: 'spf' | 'dkim' | 'dmarc' | 'mx';
  ok: boolean;
  severity: 'ok' | 'warn' | 'error';
  adviceCode: string;
}

export interface DomainDnsAdviceResult {
  score: number;
  ready: boolean;
  items: DomainDnsAdviceItem[];
}

export function evaluateDomainDnsAdvice(report: DomainDnsReportLike): DomainDnsAdviceResult {
  const spfItem: DomainDnsAdviceItem = !report.ok.spf
    ? { key: 'spf', ok: false, severity: 'error', adviceCode: 'SPF_MISSING' }
    : report.spf.qualifier === '-all' || report.spf.qualifier === '~all'
      ? { key: 'spf', ok: true, severity: 'ok', adviceCode: 'SPF_OK' }
      : { key: 'spf', ok: true, severity: 'warn', adviceCode: 'SPF_WEAK_QUALIFIER' };

  const dkimItem: DomainDnsAdviceItem = report.ok.dkim
    ? { key: 'dkim', ok: true, severity: 'ok', adviceCode: 'DKIM_OK' }
    : { key: 'dkim', ok: false, severity: 'error', adviceCode: 'DKIM_MISSING' };

  const dmarcItem: DomainDnsAdviceItem = !report.ok.dmarc
    ? { key: 'dmarc', ok: false, severity: 'error', adviceCode: 'DMARC_MISSING' }
    : !report.dmarc.hasRua
      ? { key: 'dmarc', ok: true, severity: 'warn', adviceCode: 'DMARC_NO_RUA' }
      : report.dmarc.policy === 'none'
        ? { key: 'dmarc', ok: true, severity: 'warn', adviceCode: 'DMARC_MONITOR_ONLY' }
        : { key: 'dmarc', ok: true, severity: 'ok', adviceCode: 'DMARC_OK' };

  const mxItem: DomainDnsAdviceItem = report.ok.mx
    ? { key: 'mx', ok: true, severity: 'ok', adviceCode: 'MX_OK' }
    : { key: 'mx', ok: false, severity: 'error', adviceCode: 'MX_MISSING' };

  const items = [spfItem, dkimItem, dmarcItem, mxItem];
  const score = items.filter((item) => item.ok).length;
  return {
    score,
    ready: Boolean(report.ready && score === 4),
    items,
  };
}
