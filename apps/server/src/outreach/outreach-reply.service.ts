import { BadRequestException, Injectable } from '@nestjs/common';
import {
  OutreachReplyClassification,
  OutreachReplyKind,
  Prisma,
} from '@prisma/client';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  /**
   * 是否写 OPT_OUT 同意。未显式传入时按意图判定：
   * UNSUBSCRIBE / COMPLAINT / BOUNCE / NEGATIVE 回复写 OPT_OUT；
   * POSITIVE / NEUTRAL / OUT_OF_OFFICE / UNKNOWN 正常回复绝不误写 OPT_OUT。
   */
  suppress?: boolean;
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
  ) {}

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

    const row = await this.prisma.withWorkspace(tenant.workspaceId, async (tx) => {
      if (saoId) {
        const sao = await tx.sao.findFirst({
          where: { id: saoId, workspaceId: tenant.workspaceId },
          select: { id: true },
        });
        if (!sao) invalid('VALIDATION_ERROR', 'saoId 不属于当前工作空间');
      }
      const reply = await tx.outreachReply.create({
        data: {
          workspaceId: tenant.workspaceId,
          contactRef: input.contactRef,
          recipientEmail,
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
        ...(referredEmails.length > 0 ? { referredCount: referredEmails.length } : {}),
      },
    });
    return row;
  }

  async list(tenant: OutreachTenant, limit = 100) {
    return this.prisma.withWorkspace(tenant.workspaceId, (tx) =>
      tx.outreachReply.findMany({
        where: { workspaceId: tenant.workspaceId },
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        take: Math.min(Math.max(limit, 1), 200),
      }),
    );
  }
}
