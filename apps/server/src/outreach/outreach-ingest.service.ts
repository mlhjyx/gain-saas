import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';
import {
  looksLikeUnsubscribe,
  parseArf,
  parseDsn,
  parseEmail,
} from './outreach-email-ingest.js';
import { OutreachReplyService } from './outreach-reply.service.js';

const MAX_RAW_BYTES = 256 * 1024;

export type OutreachIngestOutcome =
  | {
      outcome: 'REPLY' | 'UNSUBSCRIBE' | 'BOUNCE' | 'COMPLAINT';
      replyId: string;
      contactRef: string;
      /** 仅 BOUNCE：SMTP 状态 5.x.x=true（硬退，永久压制）；4.x.x=false（软退，只计数）。 */
      hardBounce?: boolean;
    }
  | { outcome: 'DUPLICATE'; externalId: string }
  | { outcome: 'UNMATCHED'; reason: string };

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}

function fromAddress(value: string | null): string | null {
  if (!value) return null;
  const match = /<([^<>\s]+@[^<>\s]+)>/.exec(value);
  if (match) return match[1].toLowerCase();
  const bare = /[^\s<>;,]+@[^\s<>;,]+/.exec(value);
  return bare ? bare[0].toLowerCase() : null;
}

/**
 * 入站邮件 ingest（P4-06）：解析 → 归因（In-Reply-To/References/DSN/ARF 的原始邮件 id →
 * outreach_send.messageId）→ 写 outreach_reply（经 OutreachReplyService，保持「回复即停」语义）。
 * 幂等键：入站邮件的 Message-ID（缺失时退化为原文 SHA-256）。
 * 软退信（4.x.x）只计数不写 OPT_OUT；硬退信/投诉/回复/退订都写 OPT_OUT 并跨批次停发。
 */
@Injectable()
export class OutreachIngestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly replies: OutreachReplyService,
    private readonly audit: AuditService,
  ) {}

  async ingest(tenant: OutreachTenant, raw: string): Promise<OutreachIngestOutcome> {
    if (typeof raw !== 'string' || !raw.trim()) invalid('邮件原文不能为空');
    if (Buffer.byteLength(raw, 'utf8') > MAX_RAW_BYTES) {
      invalid('邮件原文超过 256KB 上限');
    }
    const email = parseEmail(raw);
    const externalId =
      email.messageId ?? createHash('sha256').update(raw, 'utf8').digest('hex');

    const duplicate = await this.prisma.outreachReply.findFirst({
      where: { workspaceId: tenant.workspaceId, externalId },
      select: { id: true },
    });
    if (duplicate) return { outcome: 'DUPLICATE', externalId };

    const dsn = parseDsn(email);
    const arf = parseArf(email);
    const kind = arf
      ? 'COMPLAINT'
      : dsn
        ? 'BOUNCE'
        : looksLikeUnsubscribe(email)
          ? 'UNSUBSCRIBE'
          : 'REPLY';
    const hardBounce = dsn ? dsn.hard : undefined;

    const candidates = [
      ...new Set(
        [dsn?.messageId, arf?.messageId, email.inReplyTo, ...email.references].filter(
          (value): value is string => Boolean(value),
        ),
      ),
    ];
    if (candidates.length === 0) {
      await this.recordUnmatched(tenant, externalId, 'NO_MESSAGE_ID');
      return { outcome: 'UNMATCHED', reason: 'NO_MESSAGE_ID' };
    }
    const send = await this.prisma.outreachSend.findFirst({
      where: {
        workspaceId: tenant.workspaceId,
        messageId: { in: candidates },
      },
      select: { draftId: true, recipientEmail: true },
    });
    if (!send) {
      await this.recordUnmatched(tenant, externalId, 'SEND_NOT_FOUND');
      return { outcome: 'UNMATCHED', reason: 'SEND_NOT_FOUND' };
    }
    const draft = await this.prisma.outreachDraft.findFirst({
      where: { id: send.draftId, workspaceId: tenant.workspaceId },
      select: { contactRef: true },
    });
    if (!draft) {
      await this.recordUnmatched(tenant, externalId, 'DRAFT_NOT_FOUND');
      return { outcome: 'UNMATCHED', reason: 'DRAFT_NOT_FOUND' };
    }

    const recipientEmail =
      dsn?.recipient ??
      arf?.recipient ??
      fromAddress(email.from) ??
      send.recipientEmail;
    const reply = await this.replies.record(tenant, {
      contactRef: draft.contactRef,
      recipientEmail,
      kind,
      classification: 'UNKNOWN',
      subject: email.subject,
      snippet: email.textBody.slice(0, 500) || null,
      externalId,
      // 软退信只计数：不写 OPT_OUT，重试仍可能送达。
      suppress: kind === 'BOUNCE' && !hardBounce ? false : true,
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'outreach.reply.ingested',
      target: reply.id,
      detail: {
        kind,
        hardBounce: hardBounce ?? null,
        externalId,
        matchedMessageId:
          candidates.find((candidate) => candidate === email.inReplyTo) ?? candidates[0],
      },
    });
    return {
      outcome: kind,
      replyId: reply.id,
      contactRef: draft.contactRef,
      ...(kind === 'BOUNCE' ? { hardBounce } : {}),
    };
  }

  private async recordUnmatched(
    tenant: OutreachTenant,
    externalId: string,
    reason: string,
  ): Promise<void> {
    await this.audit
      .record({
        realm: 'tenant',
        actorId: tenant.userId,
        action: 'outreach.reply.ingest_unmatched',
        target: externalId,
        detail: { reason },
      })
      .catch(() => undefined);
  }
}
