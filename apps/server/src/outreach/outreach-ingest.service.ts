import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';
import {
  classifyReplyIntent,
  isAutoReplyOrOoo,
  looksLikeUnsubscribe,
  parseArf,
  parseDsn,
  parseEmail,
  type OutreachReplyIntent,
} from './outreach-email-ingest.js';
import { OutreachReplyService } from './outreach-reply.service.js';
import { OutreachBounceWritebackService } from './outreach-bounce-writeback.service.js';

const MAX_RAW_BYTES = 256 * 1024;

export type OutreachIngestOutcome =
  | {
      outcome: 'REPLY' | 'UNSUBSCRIBE' | 'BOUNCE' | 'COMPLAINT';
      replyId: string;
      contactRef: string;
      /** 仅 BOUNCE：SMTP 状态 5.x.x=true（硬退，永久压制）；4.x.x=false（软退，只计数）。 */
      hardBounce?: boolean;
      /** 归因到的已接受商机 SAO id（若命中）。 */
      saoId?: string;
      /** 仅 REPLY：细粒度回复意图（转交新联系人 / 要规格书报价 / 正向兴趣 / 延后联系 / 拒联 / 休假）。 */
      replyIntent?: OutreachReplyIntent;
      /** 仅 REPLY 且命中转交/提及新联系人时提取到的新联系人候选邮箱。 */
      referredEmails?: readonly string[];
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
    private readonly writeback: OutreachBounceWritebackService,
  ) {}

  async ingest(
    tenant: OutreachTenant,
    raw: string,
    opts?: { saoId?: string | null },
  ): Promise<OutreachIngestOutcome> {
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
    const autoReply = !arf && !dsn && isAutoReplyOrOoo(email);
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
      select: { contactRef: true, contactPointId: true },
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
    const intentAnalysis =
      kind === 'REPLY'
        ? classifyReplyIntent(email, [
            recipientEmail,
            send.recipientEmail,
            fromAddress(email.from),
          ])
        : null;
    const derivedClassification =
      kind === 'REPLY'
        ? (intentAnalysis?.classification ?? (autoReply ? 'OUT_OF_OFFICE' : 'UNKNOWN'))
        : 'UNKNOWN';
    const resolvedSaoId =
      kind === 'REPLY'
        ? (opts?.saoId ?? (await this.resolveAcceptedSaoId(tenant, draft.contactRef)))
        : null;
    const shouldSuppress =
      kind === 'UNSUBSCRIBE' ||
      kind === 'COMPLAINT' ||
      (kind === 'BOUNCE' && Boolean(hardBounce)) ||
      (kind === 'REPLY' && derivedClassification === 'NEGATIVE');
    const referredEmails = intentAnalysis?.referredEmails ?? [];
    let reply: { id: string };
    try {
      reply = await this.replies.record(tenant, {
        contactRef: draft.contactRef,
        recipientEmail,
        kind,
        classification: derivedClassification,
        subject: email.subject,
        snippet: email.textBody.slice(0, 500) || null,
        externalId,
        saoId: resolvedSaoId,
        referredEmails,
        // 仅明确退订/投诉/硬退/NEGATIVE 拒联写 OPT_OUT；正向/中性/休假/软退不误拉黑买家。
        suppress: shouldSuppress,
      });
    } catch (error) {
      // 并发 ingest（HTTP 端点 + IMAP 轮询/双 poller）在查重与插入之间竞态：
      // 数据库的部分唯一索引兜底，输家按 DUPLICATE 处理，与查重路径一致。
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { outcome: 'DUPLICATE', externalId };
      }
      throw error;
    }
    // 退信回写（缺口 3）：DSN 退信 → 引擎账本（hard→INVALID；soft ×3→UNKNOWN+24h 重验）。
    // legacy 草稿无 contactPointId 时跳过（无法寻址）。
    if (kind === 'BOUNCE' && draft.contactPointId && this.writeback) {
      await this.writeback
        .enqueue(tenant, {
          contactPointId: draft.contactPointId,
          event: hardBounce ? 'hard_bounce' : 'soft_bounce',
          messageId: externalId,
          receivedAt: new Date(),
        })
        .catch(() => undefined);
    }
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      workspaceId: tenant.workspaceId,
      action: 'outreach.reply.ingested',
      target: reply.id,
      detail: {
        kind,
        hardBounce: hardBounce ?? null,
        externalId,
        ...(resolvedSaoId ? { saoId: resolvedSaoId } : {}),
        ...(intentAnalysis && intentAnalysis.intent !== 'NONE'
          ? {
              replyIntent: intentAnalysis.intent,
              referredEmails,
            }
          : referredEmails.length > 0
            ? { referredEmails }
            : {}),
        matchedMessageId:
          candidates.find((candidate) => candidate === email.inReplyTo) ?? candidates[0],
      },
    });
    return {
      outcome: kind,
      replyId: reply.id,
      contactRef: draft.contactRef,
      ...(kind === 'BOUNCE' ? { hardBounce } : {}),
      ...(resolvedSaoId ? { saoId: resolvedSaoId } : {}),
      ...(intentAnalysis && intentAnalysis.intent !== 'NONE'
        ? {
            replyIntent: intentAnalysis.intent,
          }
        : {}),
      ...(referredEmails.length > 0 ? { referredEmails } : {}),
    };
  }

  private async resolveAcceptedSaoId(
    tenant: OutreachTenant,
    contactRef: string,
  ): Promise<string | null> {
    if (!this.prisma.sao?.findFirst) return null;
    const matched = await this.prisma.sao
      .findFirst({
        where: {
          workspaceId: tenant.workspaceId,
          state: 'ACCEPTED',
          qgo: {
            OR: [{ leadRef: contactRef }, { canonicalCompanyRef: contactRef }],
          },
        },
        orderBy: { decidedAt: 'desc' },
        select: { id: true },
      })
      .catch(() => null);
    return matched?.id ?? null;
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
        workspaceId: tenant.workspaceId,
        action: 'outreach.reply.ingest_unmatched',
        target: externalId,
        detail: { reason },
      })
      .catch(() => undefined);
  }
}
