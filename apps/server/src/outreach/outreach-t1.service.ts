import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { resolveMx, resolveTxt } from 'node:dns/promises';
import {
  evaluateDomainDnsAdvice,
  maskEmailLocalPart,
  planT1FollowUpSequence,
  type DomainDnsAdviceResult,
  type T0ConsentState,
  type T1AttachmentRef,
  type T1FollowUpSequencePlan,
} from '@gain-saas/shared';
import type { AppConfig } from '../config/configuration.js';
import { APP_CONFIG } from '../shared/config.module.js';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import { OutreachBatchService } from './outreach-batch.service.js';
import {
  OUTREACH_DNC_CHECKER,
  type OutreachTenant,
} from './outreach-consent.service.js';
import type { OutreachDncChecker } from './outreach-dnc.checker.js';
import {
  dnsRecordTemplate,
  inspectSenderDomain,
  type DnsResolver,
  type DomainDnsReport,
} from './outreach-domain-dns.js';
import { normalizeCountry, outreachJurisdictionPolicy } from './outreach-jurisdiction.js';
import { OutreachSendGate } from './outreach-send.gate.js';
import { OutreachSendService } from './outreach-send.service.js';

export const OUTREACH_DNS_RESOLVER = Symbol('OUTREACH_DNS_RESOLVER');

export const NODE_DNS_RESOLVER: DnsResolver = {
  resolveTxt: (name) => resolveTxt(name),
  resolveMx: (name) => resolveMx(name),
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const DKIM_SELECTOR_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/i;
const RESERVED_TLDS = new Set(['local', 'internal', 'localhost', 'arpa', 'lan', 'home']);
const SEQUENCE_ACTION = 'outreach.t1.sequence';

function isValidEmailAddress(email: string): boolean {
  if (!email || email.length > 320 || /\s/.test(email)) return false;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return false;
  const domain = email.slice(at + 1);
  if (!domain || domain.startsWith('.') || domain.endsWith('.')) return false;
  const labels = domain.split('.');
  return labels.length >= 2 && labels.every((label) => label.length > 0 && label.length <= 63);
}

function isValidPublicDomain(domain: string): boolean {
  if (!domain || domain.length > 253 || IPV4_RE.test(domain)) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  const tld = labels[labels.length - 1] ?? '';
  if (RESERVED_TLDS.has(tld)) return false;
  return labels.every((label) => DOMAIN_LABEL_RE.test(label));
}

function invalid(code: string, message: string): never {
  throw new BadRequestException({ error: { code, message } });
}

function conflict(code: string, message: string): never {
  throw new ConflictException({ error: { code, message } });
}

export interface OutreachT1Readiness {
  sendEnabled: boolean;
  shadowMode: boolean;
  smtpConfigured: boolean;
  fromDomain: string | null;
}

export interface OutreachDomainDnsCheckResult {
  report: DomainDnsReport;
  advice: DomainDnsAdviceResult;
  template: string;
}

export interface PlanT1SequenceInput {
  contactRef: string;
  recipientEmail: string;
  companyName?: string | null;
  contactName?: string | null;
  countryCode: string;
  subject: string;
  body: string;
  rounds?: number;
  startAt?: string;
}

export interface SavedT1SequenceView {
  id: string;
  contactRef: string;
  recipientMasked: string;
  companyName: string | null;
  countryCode: string;
  subject: string;
  createdAt: string;
  plan: T1FollowUpSequencePlan;
}

export interface CreateReferralDraftInput {
  batchId: string;
  replyId?: string;
  sourceContactRef: string;
  referredEmail: string;
  companyName?: string | null;
  countryCode: string;
  subject: string;
  body: string;
  attachments?: readonly T1AttachmentRef[];
}

/**
 * Phase 3 Track 3C — T1 完整外联服务层（零 schema 迁移，全部读写经 withWorkspace 守卫）：
 * 1. 发信通道就绪态只读检查（绝不回传 SMTP 凭据）；
 * 2. 发信域 SPF / DKIM / DMARC / MX 实时 DNS 体检（注入 Node dns/promises，单测 mock）；
 * 3. 2–4 轮自动跟进序列规划与实时硬终止重算（任何回信 / OPT_OUT / BOUNCE / SUPPRESSED / D3 立即停）；
 * 4. 转交联系人（REFERRAL）合规建稿（先走 fail-closed DNC + D3 法域校验，再写入草稿批次）。
 */
@Injectable()
export class OutreachT1Service {
  private readonly dns: DnsResolver;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly gate: OutreachSendGate,
    private readonly batches: OutreachBatchService,
    private readonly sends: OutreachSendService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OUTREACH_DNC_CHECKER) private readonly dnc: OutreachDncChecker,
    @Optional() @Inject(OUTREACH_DNS_RESOLVER) dnsResolver?: DnsResolver,
  ) {
    this.dns = dnsResolver ?? NODE_DNS_RESOLVER;
  }

  getReadiness(): OutreachT1Readiness {
    const fromAddr = (this.config.OUTREACH_SMTP_FROM_ADDRESS ?? '').trim();
    const fromDomain = fromAddr.includes('@') ? fromAddr.split('@')[1]!.toLowerCase() : null;
    return {
      sendEnabled: this.gate.enabled(),
      shadowMode: this.sends.isShadowMode(),
      smtpConfigured: Boolean(
        (this.config.OUTREACH_SMTP_HOST ?? '').trim() && fromAddr,
      ),
      fromDomain,
    };
  }

  async checkDomainDns(
    rawDomain: string,
    rawSelector?: string,
  ): Promise<OutreachDomainDnsCheckResult> {
    let domain = rawDomain.trim().toLowerCase();
    while (domain.endsWith('.')) domain = domain.slice(0, -1);
    if (!isValidPublicDomain(domain)) {
      invalid('VALIDATION_ERROR', '请输入合法的公网发信域名（例如 mail.example.com）');
    }
    const selector = (rawSelector ?? 'google').trim() || 'google';
    if (!DKIM_SELECTOR_RE.test(selector)) {
      invalid('VALIDATION_ERROR', 'DKIM selector 格式不合法');
    }
    const report = await inspectSenderDomain(domain, this.dns, { dkimSelector: selector });
    const advice = evaluateDomainDnsAdvice(report);
    const template = dnsRecordTemplate(domain, { dkimSelector: selector });
    return { report, advice, template };
  }

  async planSequence(
    tenant: OutreachTenant,
    input: PlanT1SequenceInput,
  ): Promise<SavedT1SequenceView> {
    if (!UUID_RE.test(input.contactRef)) invalid('VALIDATION_ERROR', 'contactRef must be a UUID');
    const recipientEmail = input.recipientEmail.trim().toLowerCase();
    if (!isValidEmailAddress(recipientEmail)) {
      invalid('VALIDATION_ERROR', '收件邮箱不合法');
    }
    const countryCode = normalizeCountry(input.countryCode);
    if (!countryCode) {
      invalid('VALIDATION_ERROR', 'countryCode 必须是 ISO 3166-1 两位国家代码');
    }
    const subject = input.subject.trim();
    const body = input.body.trim();
    if (!subject || subject.length > 300 || !body || body.length > 20_000) {
      invalid('VALIDATION_ERROR', '主题与正文必填且须在长度限制内');
    }
    const rounds = Math.min(4, Math.max(2, Math.trunc(Number(input.rounds ?? 3))));
    const startAt = input.startAt ?? new Date().toISOString();
    const companyName = input.companyName?.trim().slice(0, 200) || null;
    const contactName = input.contactName?.trim().slice(0, 200) || null;

    let suppressed = false;
    let dncCheckFailed = false;
    try {
      const hits = await this.dnc.check(tenant, [recipientEmail]);
      suppressed = (hits.get(recipientEmail)?.length ?? 0) > 0;
    } catch {
      dncCheckFailed = true;
    }

    const { latestConsent, replies } = await this.prisma.withWorkspace(
      tenant.workspaceId,
      async (tx) => {
        const [consentRow, replyRows] = await Promise.all([
          tx.outreachConsent.findFirst({
            where: {
              workspaceId: tenant.workspaceId,
              contactRef: input.contactRef,
              channel: 'email',
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          }),
          tx.outreachReply.findMany({
            where: {
              workspaceId: tenant.workspaceId,
              contactRef: input.contactRef,
            },
            orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
            take: 20,
          }),
        ]);
        return { latestConsent: consentRow, replies: replyRows };
      },
    );

    const consentStatus: T0ConsentState =
      (latestConsent?.status as T0ConsentState | undefined) ?? 'MISSING';

    const plan = planT1FollowUpSequence({
      companyName,
      contactName,
      countryCode,
      subject,
      body,
      rounds,
      startAt,
      consentStatus,
      suppressed,
      dncCheckFailed,
      events: replies.map((r) => ({
        kind: r.kind,
        classification: r.classification,
        receivedAt: r.receivedAt instanceof Date ? r.receivedAt.toISOString() : String(r.receivedAt),
      })),
    });

    const recipientMasked = maskEmailLocalPart(recipientEmail);
    const saved = await this.prisma.withWorkspace(tenant.workspaceId, (tx) =>
      tx.auditLog.create({
        data: {
          realm: 'tenant',
          actorId: tenant.userId,
          workspaceId: tenant.workspaceId,
          action: SEQUENCE_ACTION,
          target: input.contactRef,
          detail: {
            workspaceId: tenant.workspaceId,
            recipientMasked,
            companyName,
            contactName,
            countryCode,
            subject,
            body: body.slice(0, 4000),
            rounds,
            startAt,
            suppressedAtCreate: suppressed,
            dncFailedAtCreate: dncCheckFailed,
          } as Prisma.InputJsonValue,
        },
      }),
    );

    return {
      id: saved.id,
      contactRef: input.contactRef,
      recipientMasked,
      companyName,
      countryCode,
      subject,
      createdAt: saved.at instanceof Date ? saved.at.toISOString() : String(saved.at),
      plan,
    };
  }

  async listSequences(tenant: OutreachTenant): Promise<SavedT1SequenceView[]> {
    return this.prisma.withWorkspace(tenant.workspaceId, async (tx) => {
      const rows = await tx.auditLog.findMany({
        where: {
          realm: 'tenant',
          workspaceId: tenant.workspaceId,
          action: SEQUENCE_ACTION,
        },
        orderBy: { at: 'desc' },
        take: 30,
      });

      const out: SavedT1SequenceView[] = [];
      for (const row of rows) {
        const detail = (row.detail ?? null) as Record<string, unknown> | null;
        const contactRef = row.target ?? '';
        if (!detail || detail.workspaceId !== tenant.workspaceId || !UUID_RE.test(contactRef)) {
          continue;
        }
        const [latestConsent, replies] = await Promise.all([
          tx.outreachConsent.findFirst({
            where: { workspaceId: tenant.workspaceId, contactRef, channel: 'email' },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          }),
          tx.outreachReply.findMany({
            where: { workspaceId: tenant.workspaceId, contactRef },
            orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
            take: 20,
          }),
        ]);
        const consentStatus: T0ConsentState =
          (latestConsent?.status as T0ConsentState | undefined) ?? 'MISSING';
        const countryCode = String(detail.countryCode ?? '');
        const companyName = typeof detail.companyName === 'string' ? detail.companyName : null;
        const subject = String(detail.subject ?? '');
        const body = String(detail.body ?? '');
        const rounds = Number(detail.rounds ?? 3);
        const startAt = typeof detail.startAt === 'string' ? detail.startAt : undefined;
        const plan = planT1FollowUpSequence({
          companyName,
          contactName: typeof detail.contactName === 'string' ? detail.contactName : null,
          countryCode,
          subject,
          body,
          rounds,
          startAt,
          consentStatus,
          suppressed: Boolean(detail.suppressedAtCreate),
          dncCheckFailed: Boolean(detail.dncFailedAtCreate),
          events: replies.map((r) => ({
            kind: r.kind,
            classification: r.classification,
            receivedAt:
              r.receivedAt instanceof Date ? r.receivedAt.toISOString() : String(r.receivedAt),
          })),
        });
        out.push({
          id: row.id,
          contactRef,
          recipientMasked: String(detail.recipientMasked ?? '***'),
          companyName,
          countryCode,
          subject,
          createdAt: row.at instanceof Date ? row.at.toISOString() : String(row.at),
          plan,
        });
      }
      return out;
    });
  }

  async createReferralDraft(tenant: OutreachTenant, input: CreateReferralDraftInput) {
    if (!UUID_RE.test(input.batchId)) invalid('VALIDATION_ERROR', 'batchId must be a UUID');
    if (!UUID_RE.test(input.sourceContactRef)) {
      invalid('VALIDATION_ERROR', 'sourceContactRef must be a UUID');
    }
    if (input.replyId !== undefined && !UUID_RE.test(input.replyId)) {
      invalid('VALIDATION_ERROR', 'replyId must be a UUID');
    }
    const referredEmail = input.referredEmail.trim().toLowerCase();
    if (!isValidEmailAddress(referredEmail)) {
      invalid('VALIDATION_ERROR', '转交联系人邮箱不合法');
    }
    const countryCode = normalizeCountry(input.countryCode);
    if (!countryCode) {
      invalid('VALIDATION_ERROR', 'countryCode 必须是 ISO 3166-1 两位国家代码');
    }

    // 1) DNC 禁联预检（严格 fail-closed）
    let dncReasons: string[] = [];
    try {
      const hits = await this.dnc.check(tenant, [referredEmail]);
      dncReasons = hits.get(referredEmail) ?? [];
    } catch {
      throw new ServiceUnavailableException({
        error: {
          code: 'DNC_CHECK_FAILED',
          message: '禁联名单校验暂不可用，已阻断转交联系人建稿（fail-closed）',
        },
      });
    }
    if (dncReasons.length > 0) {
      conflict(
        'OUTREACH_REFERRED_SUPPRESSED',
        `该转交邮箱命中禁联名单（${dncReasons.join(' / ')}），不可创建外联草稿`,
      );
    }

    // 2) D3 法域合规门禁：新转交联系人尚无 OPT_IN 同意记录，严格同意国阻断直发冷邮
    const jurisdictionPolicy = outreachJurisdictionPolicy(countryCode, {
      companyName: input.companyName,
    });
    if (jurisdictionPolicy !== 'OPT_OUT') {
      conflict(
        'OUTREACH_JURISDICTION_CONSENT_REQUIRED',
        `${countryCode} 属于严格同意法域（${jurisdictionPolicy}），转交联系人尚未登记明确同意，请优先改走领英或官网表单触达`,
      );
    }

    const newContactRef = randomUUID();
    const draft = await this.batches.addDraft(tenant, input.batchId, {
      contactRef: newContactRef,
      recipientEmail: referredEmail,
      companyName: input.companyName?.trim() || undefined,
      countryCode,
      subject: input.subject.trim(),
      body: input.body.trim(),
      attachments: input.attachments,
    });

    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      workspaceId: tenant.workspaceId,
      action: 'outreach.t1.referral_draft_created',
      target: input.batchId,
      detail: {
        draftId: draft.id,
        sourceContactRef: input.sourceContactRef,
        newContactRef,
        replyId: input.replyId ?? null,
        referredEmailMasked: maskEmailLocalPart(referredEmail),
        countryCode,
      },
    });

    return {
      draft,
      newContactRef,
      jurisdictionPolicy,
    };
  }
}
