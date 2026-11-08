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
  kind?: 'REPLY' | 'BOUNCE' | 'UNSUBSCRIBE';
  classification?: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'OUT_OF_OFFICE' | 'UNKNOWN';
  subject?: string | null;
  snippet?: string | null;
  externalId?: string | null;
  receivedAt?: string;
}

/**
 * 入站回复/退信/退订回写（M2 步 11-4）。
 * 「回复即停」：任何 REPLY/BOUNCE/UNSUBSCRIBE 都写一条 OPT_OUT 同意，
 * 后续批次在发送前按最新同意跳过，而不是依赖操作者记得取消。
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
    const snippet = input.snippet?.trim().slice(0, 500) || null;
    const externalId = input.externalId?.trim().slice(0, 256) || null;
    const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();
    if (Number.isNaN(receivedAt.getTime())) {
      invalid('VALIDATION_ERROR', 'receivedAt 不是合法时间');
    }

    const row = await this.prisma.$transaction(async (tx) => {
      const reply = await tx.outreachReply.create({
        data: {
          workspaceId: tenant.workspaceId,
          contactRef: input.contactRef,
          recipientEmail,
          kind,
          classification,
          subject,
          snippet,
          externalId,
          receivedAt,
        },
      });
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
      return reply;
    });

    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'outreach.reply.recorded',
      target: input.contactRef,
      detail: { replyId: row.id, kind, classification },
    });
    return row;
  }

  async list(tenant: OutreachTenant, limit = 100) {
    return this.prisma.outreachReply.findMany({
      where: { workspaceId: tenant.workspaceId },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(limit, 1), 200),
    });
  }
}
