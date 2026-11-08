import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { AuditService } from '../shared/audit.service.js';
import type { PrismaService } from '../shared/prisma.service.js';
import { OutreachIngestService } from './outreach-ingest.service.js';
import { OutreachReplyService } from './outreach-reply.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONTACT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DRAFT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const tenant: OutreachTenant = { userId: 'user-a', workspaceId: WS, role: 'admin' };

interface Row {
  [key: string]: unknown;
}

class FakeIngestPrisma {
  replies: Row[] = [];
  consents: Row[] = [];
  sends: Row[] = [];
  drafts: Row[] = [{ id: DRAFT, workspaceId: WS, contactRef: CONTACT }];
  seq = 0;

  private id(): string {
    return `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`;
  }

  readonly outreachReply = {
    findFirst: async ({ where }: { where: Row }) =>
      this.replies.find(
        (row) =>
          row.workspaceId === where.workspaceId && row.externalId === where.externalId,
      ) ?? null,
    create: async ({ data }: { data: Row }) => {
      // 模拟迁移里的部分唯一索引 (workspace_id, external_id) WHERE external_id IS NOT NULL。
      if (
        data.externalId &&
        this.replies.some(
          (row) =>
            row.workspaceId === data.workspaceId && row.externalId === data.externalId,
        )
      ) {
        throw new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
      const row = { id: this.id(), receivedAt: new Date(), createdAt: new Date(), ...data };
      this.replies.push(row);
      return { ...row };
    },
  };

  readonly outreachConsent = {
    create: async ({ data }: { data: Row }) => {
      const row = { id: this.id(), createdAt: new Date(), ...data };
      this.consents.push(row);
      return { ...row };
    },
  };

  readonly outreachSend = {
    findFirst: async ({ where }: { where: Row }) =>
      this.sends.find(
        (row) =>
          row.workspaceId === where.workspaceId &&
          ((where.messageId as { in: string[] }).in as string[]).includes(
            row.messageId as string,
          ),
      ) ?? null,
  };

  readonly outreachDraft = {
    findFirst: async ({ where }: { where: Row }) =>
      this.drafts.find((row) => row.id === where.id) ?? null,
  };

  readonly $transaction = async (
    operations: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>),
  ) => {
    if (typeof operations === 'function') return operations(this);
    return Promise.all(operations);
  };
}

function build() {
  const prisma = new FakeIngestPrisma();
  prisma.sends.push({
    workspaceId: WS,
    draftId: DRAFT,
    messageId: 'sent-1@example.test',
    recipientEmail: 'buyer@example.de',
  });
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  const replies = new OutreachReplyService(prisma as unknown as PrismaService, audit);
  const ingest = new OutreachIngestService(
    prisma as unknown as PrismaService,
    replies,
    audit,
  );
  return { prisma, ingest, audit };
}

function replyRaw(overrides: Row = {}): string {
  const { subject = 'Re: Pumpen', body = 'Klingt interessant, rufen Sie an.', messageId = 'reply-1@ziel.de' } = overrides;
  return [
    'From: Buyer <buyer@ziel.de>',
    'To: outreach@example.test',
    `Subject: ${subject}`,
    `Message-ID: <${messageId}>`,
    'In-Reply-To: <sent-1@example.test>',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');
}

function dsnRaw(status: string): string {
  return [
    'From: MAILER-DAEMON@mx.example.test',
    'To: outreach@example.test',
    'Subject: Undelivered Mail Returned to Sender',
    'Message-ID: <dsn-<status>@mx.example.test>'.replace('<status>', status.replace(/\./g, '-')),
    'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain',
    '',
    'Delivery failed.',
    '--b1',
    'Content-Type: message/delivery-status',
    '',
    'Final-Recipient: rfc822; buyer@example.de',
    'Action: failed',
    `Status: ${status}`,
    'Diagnostic-Code: smtp; 550 5.1.1 user unknown',
    '',
    '--b1',
    'Content-Type: message/rfc822',
    '',
    'Message-ID: <sent-1@example.test>',
    '',
    'original',
    '--b1--',
    '',
  ].join('\r\n');
}

describe('OutreachIngestService（P4-06 回复/退信/投诉 ingest）', () => {
  it('普通回复：归因到发送台账、写 REPLY 行并 OPT_OUT（回复即停）', async () => {
    const { prisma, ingest } = build();
    const result = await ingest.ingest(tenant, replyRaw());
    expect(result).toMatchObject({ outcome: 'REPLY', contactRef: CONTACT });
    expect(prisma.replies[0]).toMatchObject({
      kind: 'REPLY',
      contactRef: CONTACT,
      externalId: 'reply-1@ziel.de',
    });
    expect(prisma.consents[0]).toMatchObject({ status: 'OPT_OUT', source: 'reply:reply' });
  });

  it('幂等：同一封邮件重复 ingest 返回 DUPLICATE，不重复写行', async () => {
    const { prisma, ingest } = build();
    await ingest.ingest(tenant, replyRaw());
    const second = await ingest.ingest(tenant, replyRaw());
    expect(second.outcome).toBe('DUPLICATE');
    expect(prisma.replies).toHaveLength(1);
    expect(prisma.consents).toHaveLength(1);
  });

  it('并发竞态：查重未命中但插入撞唯一索引（P2002）同样按 DUPLICATE 处理', async () => {
    const { prisma, ingest } = build();
    await ingest.ingest(tenant, replyRaw());
    // 模拟两个 ingest 同时通过查重：第二次的查重被绕过，插入时被部分唯一索引拦下。
    const spy = vi.spyOn(prisma.outreachReply, 'findFirst').mockResolvedValue(null);
    const second = await ingest.ingest(tenant, replyRaw());
    spy.mockRestore();
    expect(second.outcome).toBe('DUPLICATE');
    expect(prisma.replies).toHaveLength(1);
    expect(prisma.consents).toHaveLength(1);
  });

  it('硬退信（5.x.x）：写 BOUNCE 行并 OPT_OUT（永久压制）', async () => {
    const { prisma, ingest } = build();
    const result = await ingest.ingest(tenant, dsnRaw('5.1.1'));
    expect(result).toMatchObject({ outcome: 'BOUNCE', hardBounce: true });
    expect(prisma.replies[0]).toMatchObject({ kind: 'BOUNCE', recipientEmail: 'buyer@example.de' });
    expect(prisma.consents[0]).toMatchObject({ status: 'OPT_OUT', source: 'reply:bounce' });
  });

  it('软退信（4.x.x）：只计数不压制——写 BOUNCE 行但无 OPT_OUT', async () => {
    const { prisma, ingest } = build();
    const result = await ingest.ingest(tenant, dsnRaw('4.2.2'));
    expect(result).toMatchObject({ outcome: 'BOUNCE', hardBounce: false });
    expect(prisma.replies).toHaveLength(1);
    expect(prisma.consents).toHaveLength(0);
  });

  it('ARF 投诉：写 COMPLAINT 行并 OPT_OUT', async () => {
    const { prisma, ingest } = build();
    const raw = [
      'From: complaints@isp.example',
      'To: abuse@example.test',
      'Subject: Complaint',
      'Message-ID: <arf-1@isp.example>',
      'Content-Type: multipart/report; report-type=feedback-report; boundary="a1"',
      '',
      '--a1',
      'Content-Type: text/plain',
      '',
      'abuse report',
      '--a1',
      'Content-Type: message/feedback-report',
      '',
      'Feedback-Type: abuse',
      'Original-Rcpt-To: buyer@example.de',
      'Original-Message-ID: <sent-1@example.test>',
      '',
      '--a1--',
      '',
    ].join('\r\n');
    const result = await ingest.ingest(tenant, raw);
    expect(result.outcome).toBe('COMPLAINT');
    expect(prisma.replies[0]).toMatchObject({ kind: 'COMPLAINT' });
    expect(prisma.consents[0]).toMatchObject({ status: 'OPT_OUT', source: 'reply:complaint' });
  });

  it('退订关键词回复识别为 UNSUBSCRIBE', async () => {
    const { prisma, ingest } = build();
    const result = await ingest.ingest(
      tenant,
      replyRaw({ subject: 'Bitte abmelden', body: 'Bitte abmelden.' }),
    );
    expect(result.outcome).toBe('UNSUBSCRIBE');
    expect(prisma.replies[0]).toMatchObject({ kind: 'UNSUBSCRIBE' });
  });

  it('负向：归因不到发送台账时 UNMATCHED，不写任何行', async () => {
    const { prisma, ingest } = build();
    const result = await ingest.ingest(
      tenant,
      replyRaw({ messageId: 'reply-x@ziel.de' }).replace(
        'In-Reply-To: <sent-1@example.test>',
        'In-Reply-To: <unknown@example.test>',
      ),
    );
    expect(result).toMatchObject({ outcome: 'UNMATCHED', reason: 'SEND_NOT_FOUND' });
    expect(prisma.replies).toHaveLength(0);
    expect(prisma.consents).toHaveLength(0);
  });

  it('负向：原文为空或缺少 Message-ID 且无法归因时 UNMATCHED', async () => {
    const { ingest } = build();
    await expect(ingest.ingest(tenant, '  ')).rejects.toSatisfy(
      (error) =>
        (error as { response?: { error?: { code?: string } } }).response?.error?.code ===
        'VALIDATION_ERROR',
    );
    const result = await ingest.ingest(
      tenant,
      ['From: a@b.de', 'Subject: hi', '', 'no headers'].join('\r\n'),
    );
    expect(result).toMatchObject({ outcome: 'UNMATCHED', reason: 'NO_MESSAGE_ID' });
  });
});
