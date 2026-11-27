import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import {
  OutreachReplyClassification,
  OutreachReplyKind,
  Prisma,
} from '@prisma/client';
import { AuditService } from '../shared/audit.service.js';
import { PiiCryptoService } from '../shared/pii-crypto.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';
import { OUTREACH_PII_PURPOSE } from './outreach-pii.constants.js';
import { buildReplyCopilotDraft, type ReplyCopilotDraft } from './outreach-reply-copilot.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FREEMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'qq.com',
  'foxmail.com',
  '163.com',
  '126.com',
  'sina.com',
  'gmx.de',
  'gmx.net',
  'web.de',
  't-online.de',
]);

function normalizeCompanyKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const normalized = name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  return normalized.length >= 2 ? normalized : null;
}

function corporateEmailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain || FREEMAIL_DOMAINS.has(domain)) return null;
  return domain;
}

function invalid(code: string, message: string): never {
  throw new BadRequestException({ error: { code, message } });
}

export interface OutreachReplyInput {
  contactRef: string;
  recipientEmail?: string | null;
  kind?: 'REPLY' | 'BOUNCE' | 'UNSUBSCRIBE' | 'COMPLAINT';
  classification?: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'OUT_OF_OFFICE' | 'UNKNOWN';
  subject?: string | null;
  snippet?: string | null;
  externalId?: string | null;
  receivedAt?: string;
  /** 可选：把 REPLY 回写为该 SAO 的 REPLIED outcome（12-3 归因接缝）。 */
  saoId?: string | null;
  /** 可选：从转交回信正文抽取到的新联系人候选邮箱。 */
  referredEmails?: readonly string[];
  /** 可选：触发回信的企业名称（用于收到回信后自动刹停同公司其他待发队列）。 */
  companyName?: string | null;
  /**
   * 是否写 OPT_OUT 同意。未显式传入时按意图判定：
   * UNSUBSCRIBE / COMPLAINT / BOUNCE / NEGATIVE 回复写 OPT_OUT；
   * POSITIVE / NEUTRAL / OUT_OF_OFFICE / UNKNOWN 正常回复绝不误写 OPT_OUT。
   */
  suppress?: boolean;
}

function shouldAutoStopCompanyQueue(
  kind: OutreachReplyKind,
  classification: OutreachReplyClassification,
): boolean {
  if (kind === 'UNSUBSCRIBE' || kind === 'COMPLAINT') return true;
  if (kind === 'REPLY') return classification !== 'OUT_OF_OFFICE';
  return false;
}

function shouldSuppressByDefault(
  kind: OutreachReplyKind,
  classification: OutreachReplyClassification,
): boolean {
  if (kind === 'UNSUBSCRIBE' || kind === 'COMPLAINT' || kind === 'BOUNCE') {
    return true;
  }
  return classification === 'NEGATIVE';
}

/**
 * 入站回复/退信/退订回写（M2 步 11-4 + Phase 1 意图分级止血）。
 * 仅在明确退订、投诉、硬退信或 NEGATIVE 拒联回信时写 OPT_OUT；
 * 正向/中性/休假回信保留联系资格，避免把高意向买家拉黑。
 */
@Injectable()
export class OutreachReplyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() private readonly crypto?: PiiCryptoService,
  ) {}

  private decryptReplyRow<T extends { recipientEmail: string | null }>(
    workspaceId: string,
    row: T,
  ): T {
    if (!this.crypto || !row.recipientEmail) return row;
    return {
      ...row,
      recipientEmail: this.crypto.decryptNullableField(
        workspaceId,
        row.recipientEmail,
        OUTREACH_PII_PURPOSE.REPLY_RECIPIENT_EMAIL,
      ),
    };
  }

  async record(tenant: OutreachTenant, input: OutreachReplyInput) {
    if (!UUID_RE.test(input.contactRef)) {
      invalid('VALIDATION_ERROR', 'contactRef must be a UUID');
    }
    const kind = input.kind ?? 'REPLY';
    if (!Object.values(OutreachReplyKind).includes(kind)) {
      invalid('VALIDATION_ERROR', 'kind must be REPLY, BOUNCE or UNSUBSCRIBE');
    }
    const classification = input.classification ?? 'UNKNOWN';
    if (!Object.values(OutreachReplyClassification).includes(classification)) {
      invalid('VALIDATION_ERROR', 'classification 不合法');
    }
    const recipientEmail = input.recipientEmail?.trim().toLowerCase() ?? null;
    if (recipientEmail && (!EMAIL_RE.test(recipientEmail) || recipientEmail.length > 320)) {
      invalid('VALIDATION_ERROR', '收件邮箱不合法');
    }
    const subject = input.subject?.trim().slice(0, 300) || null;
    const referredEmails = [
      ...new Set(
        (input.referredEmails ?? [])
          .map((addr) => addr.trim().toLowerCase())
          .filter((addr) => EMAIL_RE.test(addr) && addr.length <= 320),
      ),
    ].slice(0, 5);
    const rawSnippet = input.snippet?.trim() || '';
    const missingRefs = referredEmails.filter(
      (addr) => !rawSnippet.toLowerCase().includes(addr),
    );
    const referralTag = missingRefs.length > 0 ? `[referred: ${missingRefs.join(', ')}]` : '';
    const mergedSnippet = [rawSnippet, referralTag].filter(Boolean).join(' ').slice(0, 500) || null;
    const externalId = input.externalId?.trim().slice(0, 256) || null;
    const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();
    if (Number.isNaN(receivedAt.getTime())) {
      invalid('VALIDATION_ERROR', 'receivedAt 不是合法时间');
    }
    const saoId = input.saoId ?? null;
    if (saoId !== null && !UUID_RE.test(saoId)) {
      invalid('VALIDATION_ERROR', 'saoId must be a UUID');
    }
    const shouldSuppress =
      input.suppress !== undefined
        ? input.suppress
        : shouldSuppressByDefault(kind, classification);

    const shouldAutoStop = shouldAutoStopCompanyQueue(kind, classification);
    let stoppedJobsCount = 0;
    let stoppedCompanyDraftsCount = 0;

    const row = await this.prisma.withWorkspace(tenant.workspaceId, async (tx) => {
      if (saoId) {
        const sao = await tx.sao.findFirst({
          where: { id: saoId, workspaceId: tenant.workspaceId },
          select: { id: true },
        });
        if (!sao) invalid('VALIDATION_ERROR', 'saoId 不属于当前工作空间');
      }
      const storedEmail = this.crypto
        ? this.crypto.encryptNullableField(
            tenant.workspaceId,
            recipientEmail,
            OUTREACH_PII_PURPOSE.REPLY_RECIPIENT_EMAIL,
          )
        : recipientEmail;
      const reply = await tx.outreachReply.create({
        data: {
          workspaceId: tenant.workspaceId,
          contactRef: input.contactRef,
          recipientEmail: storedEmail,
          kind,
          classification,
          subject,
          snippet: mergedSnippet,
          externalId,
          receivedAt,
        },
      });
      if (shouldSuppress) {
        await tx.outreachConsent.create({
          data: {
            workspaceId: tenant.workspaceId,
            contactRef: input.contactRef,
            channel: 'email',
            status: 'OPT_OUT',
            source: `reply:${kind.toLowerCase()}`,
            lawfulBasis: 'consent_withdrawal',
            evidence: {
              replyId: reply.id,
              kind,
              classification,
            } as Prisma.InputJsonValue,
          },
        });
      }
      // 收到有效回信/退订/投诉后自动刹停同联系人及同公司其他待发队列，避免多通道撞车打扰买家。
      // 绝不把同公司其他联系人误写入 OPT_OUT 永久拉黑，仅取消在途 PENDING job 与待发 APPROVED 草稿。
      if (
        shouldAutoStop &&
        tx.outreachDraft?.findMany &&
        tx.outreachSendJob?.updateMany
      ) {
        const candidateDrafts = await tx.outreachDraft.findMany({
          where: {
            workspaceId: tenant.workspaceId,
            status: { in: ['DRAFT', 'APPROVED'] },
          },
          select: {
            id: true,
            contactRef: true,
            companyName: true,
            recipientEmail: true,
            status: true,
          },
          take: 500,
        });
        let targetCompanyKey = normalizeCompanyKey(input.companyName);
        if (!targetCompanyKey) {
          const sameContactDraft = candidateDrafts.find(
            (d) => d.contactRef === input.contactRef && normalizeCompanyKey(d.companyName),
          );
          targetCompanyKey = normalizeCompanyKey(sameContactDraft?.companyName);
        }
        if (!targetCompanyKey && tx.outreachDraft.findFirst) {
          const histDraft = await tx.outreachDraft.findFirst({
            where: {
              workspaceId: tenant.workspaceId,
              contactRef: input.contactRef,
              companyName: { not: null },
            },
            orderBy: { createdAt: 'desc' },
            select: { companyName: true },
          });
          targetCompanyKey = normalizeCompanyKey(histDraft?.companyName);
        }
        const targetCorpDomain = corporateEmailDomain(recipientEmail);

        const matchedDraftIds: string[] = [];
        const matchedSiblingApprovedIds: string[] = [];
        for (const d of candidateDrafts) {
          const isSameContact = d.contactRef === input.contactRef;
          const isSameCompany =
            Boolean(targetCompanyKey) && normalizeCompanyKey(d.companyName) === targetCompanyKey;
          let isSameDomain = false;
          if (!isSameContact && !isSameCompany && targetCorpDomain && d.recipientEmail) {
            const plain = this.crypto
              ? this.crypto.decryptNullableField(
                  tenant.workspaceId,
                  d.recipientEmail,
                  OUTREACH_PII_PURPOSE.DRAFT_RECIPIENT_EMAIL,
                )
              : d.recipientEmail;
            isSameDomain = corporateEmailDomain(plain) === targetCorpDomain;
          }
          if (isSameContact || isSameCompany || isSameDomain) {
            matchedDraftIds.push(d.id);
            if (!isSameContact && d.status === 'APPROVED') {
              matchedSiblingApprovedIds.push(d.id);
            }
          }
        }
        if (matchedDraftIds.length > 0) {
          const cancelled = await tx.outreachSendJob.updateMany({
            where: {
              workspaceId: tenant.workspaceId,
              draftId: { in: matchedDraftIds },
              state: 'PENDING',
            },
            data: {
              state: 'CANCELLED',
              claimToken: null,
              lastError:
                matchedSiblingApprovedIds.length > 0
                  ? 'AUTO_STOPPED_COMPANY_REPLIED'
                  : 'AUTO_STOPPED_CONTACT_REPLIED',
            },
          });
          stoppedJobsCount = cancelled.count ?? 0;
        }
        if (matchedSiblingApprovedIds.length > 0 && tx.outreachDraft.updateMany) {
          const skipped = await tx.outreachDraft.updateMany({
            where: {
              workspaceId: tenant.workspaceId,
              id: { in: matchedSiblingApprovedIds },
              status: 'APPROVED',
            },
            data: {
              status: 'SKIPPED',
              rejectionReason: '同公司已有联系人回信，系统已自动停止其他在途跟进避免重复打扰',
            },
          });
          stoppedCompanyDraftsCount = skipped.count ?? 0;
        }
        if ((stoppedJobsCount > 0 || stoppedCompanyDraftsCount > 0) && tx.notification?.create) {
          await tx.notification.create({
            data: {
              workspaceId: tenant.workspaceId,
              type: 'outreach.reply.company_auto_stopped',
              refId: reply.id,
              title: `买家已回信，系统已自动刹停同公司 ${Math.max(stoppedJobsCount, stoppedCompanyDraftsCount)} 条在途跟进，请及时人工回复`,
              titleEn: `Buyer replied — auto-stopped ${Math.max(stoppedJobsCount, stoppedCompanyDraftsCount)} queued same-company follow-up(s)`,
            },
          });
        }
      }
      if (referredEmails.length > 0 && tx.notification?.create) {
        await tx.notification.create({
          data: {
            workspaceId: tenant.workspaceId,
            type: 'outreach.reply.referral',
            refId: reply.id,
            title: `买家回信转交了 ${referredEmails.length} 个新联系人邮箱，请及时跟进`,
            titleEn: `Buyer reply referred ${referredEmails.length} new contact email(s) for follow-up`,
          },
        });
      }
      // 12-3 接缝：只有 REPLY 且显式给了 SAO 时回写弱信号，sourceEventId=reply.id 保证幂等。
      if (saoId && kind === 'REPLY') {
        const existing = await tx.opportunityOutcome.findUnique({
          where: { saoId_sourceEventId: { saoId, sourceEventId: reply.id } },
          select: { id: true },
        });
        if (!existing) {
          await tx.opportunityOutcome.create({
            data: {
              workspaceId: tenant.workspaceId,
              saoId,
              outcome: 'REPLIED',
              occurredAt: receivedAt,
              source: 'SYSTEM',
              evidenceRef: reply.id,
              sourceEventId: reply.id,
              createdBy: tenant.userId,
            },
          });
        }
      }
      return reply;
    });

    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      workspaceId: tenant.workspaceId,
      action: 'outreach.reply.recorded',
      target: input.contactRef,
      detail: {
        replyId: row.id,
        kind,
        classification,
        suppressed: shouldSuppress,
        ...(stoppedJobsCount > 0 ? { stoppedJobsCount } : {}),
        ...(stoppedCompanyDraftsCount > 0 ? { stoppedCompanyDraftsCount } : {}),
        ...(referredEmails.length > 0 ? { referredCount: referredEmails.length } : {}),
      },
    });
    return this.decryptReplyRow(tenant.workspaceId, row);
  }

  async getCopilotDraft(tenant: OutreachTenant, replyId: string): Promise<ReplyCopilotDraft> {
    if (!UUID_RE.test(replyId)) {
      invalid('VALIDATION_ERROR', 'replyId must be a UUID');
    }
    const { reply, draft, workspace } = await this.prisma.withWorkspace(
      tenant.workspaceId,
      async (tx) => {
        const foundReply = await tx.outreachReply.findFirst({
          where: { id: replyId, workspaceId: tenant.workspaceId },
        });
        if (!foundReply) return { reply: null, draft: null, workspace: null };
        const [foundDraft, foundWorkspace] = await Promise.all([
          tx.outreachDraft?.findFirst
            ? tx.outreachDraft.findFirst({
                where: { workspaceId: tenant.workspaceId, contactRef: foundReply.contactRef },
                orderBy: { createdAt: 'desc' },
                select: { companyName: true, countryCode: true },
              })
            : Promise.resolve(null),
          tx.workspace?.findUnique
            ? tx.workspace.findUnique({
                where: { id: tenant.workspaceId },
                select: { name: true },
              })
            : Promise.resolve(null),
        ]);
        return { reply: foundReply, draft: foundDraft, workspace: foundWorkspace };
      },
    );
    if (!reply) {
      throw new NotFoundException({ error: { code: 'NOT_FOUND', message: '回信记录不存在' } });
    }
    const decrypted = this.decryptReplyRow(tenant.workspaceId, reply);
    return buildReplyCopilotDraft({
      replyId: decrypted.id,
      kind: decrypted.kind,
      classification: decrypted.classification,
      subject: decrypted.subject,
      snippet: decrypted.snippet,
      recipientEmail: decrypted.recipientEmail,
      companyName: draft?.companyName ?? null,
      countryCode: draft?.countryCode ?? null,
      sellerCompanyName: workspace?.name ?? null,
    });
  }

  async list(tenant: OutreachTenant, limit = 100) {
    const rows = await this.prisma.withWorkspace(tenant.workspaceId, (tx) =>
      tx.outreachReply.findMany({
        where: { workspaceId: tenant.workspaceId },
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        take: Math.min(Math.max(limit, 1), 200),
      }),
    );
    return rows.map((row) => this.decryptReplyRow(tenant.workspaceId, row));
  }
}
