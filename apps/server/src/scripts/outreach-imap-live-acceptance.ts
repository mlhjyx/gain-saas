import '../shared/load-env.js';
/**
 * P4-13 真实 IMAP 验收（本地 GreenMail 容器，零费用）：
 * 「取未读 → ingest（归因/幂等/停发联动）→ 标记已读」整链，跑真实 IMAP 协议 + dev 数据库。
 *
 * 前置：本地 GreenMail 容器（IMAPS 127.0.0.1:3993，用户 outreach@example.test / pass）。
 * 运行（cwd=apps/server，env 覆盖优先于 .env）：
 *   OUTREACH_IMAP_HOST=127.0.0.1 OUTREACH_IMAP_PORT=3993 \
 *   OUTREACH_IMAP_USER=outreach@example.test OUTREACH_IMAP_PASSWORD=pass \
 *   OUTREACH_SMTP_TLS_REJECT_UNAUTHORIZED=false OUTREACH_IMAP_ENABLED=false \
 *   pnpm exec tsx src/scripts/outreach-imap-live-acceptance.ts
 *
 * 退出码：0 = 全部断言通过；1 = 配置缺失；2 = 断言失败。
 * 夹具（workspace/mailbox/batch/draft/send/reply/consent）在结束时清理。
 */
import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { loadConfig } from '../config/configuration.js';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import { OutreachIngestService } from '../outreach/outreach-ingest.service.js';
import { OutreachReplyService } from '../outreach/outreach-reply.service.js';
import { ImapFlowClient, OutreachImapPoller } from '../outreach/outreach-imap.poller.js';

const MATCHED_MESSAGE_ID = 'check-reply-1@example.test';
const ORPHAN_MESSAGE_ID = 'check-orphan-1@example.test';
const DSN_MESSAGE_ID = 'check-dsn-1@example.test';
const SENT_MESSAGE_ID = 'sent-imap-check@example.test';

interface Check {
  name: string;
  ok: boolean;
  detail: unknown;
}

function connectedClient(): ImapFlow {
  const config = loadConfig();
  return new ImapFlow({
    host: config.OUTREACH_IMAP_HOST,
    port: config.OUTREACH_IMAP_PORT,
    secure: true,
    auth: { user: config.OUTREACH_IMAP_USER!, pass: config.OUTREACH_IMAP_PASSWORD! },
    tls: { rejectUnauthorized: config.OUTREACH_SMTP_TLS_REJECT_UNAUTHORIZED },
    logger: false,
  });
}

async function appendRaw(raw: string): Promise<void> {
  const client = connectedClient();
  await client.connect();
  try {
    await client.append('INBOX', Buffer.from(raw, 'utf8'));
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function seenCounts(): Promise<{ total: number; unseen: number }> {
  const client = connectedClient();
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    let total = 0;
    let unseen = 0;
    for await (const _message of client.fetch({}, { uid: true })) total += 1;
    for await (const _message of client.fetch({ seen: false }, { uid: true })) unseen += 1;
    return { total, unseen };
  } finally {
    lock.release();
    await client.logout().catch(() => undefined);
  }
}

const REPLY_RAW = [
  'From: Buyer <buyer@ziel.de>',
  'To: outreach@example.test',
  'Subject: Re: Anfrage',
  `Message-ID: <${MATCHED_MESSAGE_ID}>`,
  `In-Reply-To: <${SENT_MESSAGE_ID}>`,
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Danke für die Info, klingt interessant.',
].join('\r\n');

const ORPHAN_RAW = [
  'From: Someone <someone@example.org>',
  'To: outreach@example.test',
  'Subject: unrelated',
  `Message-ID: <${ORPHAN_MESSAGE_ID}>`,
  'Content-Type: text/plain; charset=utf-8',
  '',
  'no reference header',
].join('\r\n');

const DSN_RAW = [
  'From: MAILER-DAEMON@mx.example.test',
  'To: outreach@example.test',
  'Subject: Undelivered Mail Returned to Sender',
  `Message-ID: <${DSN_MESSAGE_ID}>`,
  'Content-Type: multipart/report; report-type=delivery-status; boundary="dsn-bound"',
  '',
  '--dsn-bound',
  'Content-Type: text/plain',
  '',
  'Delivery failed.',
  '--dsn-bound',
  'Content-Type: message/delivery-status',
  '',
  'Final-Recipient: rfc822; buyer@ziel.de',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550 5.1.1 user unknown',
  '',
  '--dsn-bound',
  'Content-Type: message/rfc822',
  '',
  `Message-ID: <${SENT_MESSAGE_ID}>`,
  '',
  'original',
  '--dsn-bound--',
  '',
].join('\r\n');

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.OUTREACH_IMAP_HOST || !config.OUTREACH_IMAP_USER) {
    console.error('缺少 OUTREACH_IMAP_HOST/USER');
    process.exit(1);
  }
  const prisma = new PrismaService();
  await prisma.$connect();
  const audit = new AuditService(prisma);
  const replies = new OutreachReplyService(prisma, audit);
  const ingest = new OutreachIngestService(prisma, replies, audit);
  const poller = new OutreachImapPoller(
    prisma,
    ingest,
    new ImapFlowClient(config),
    config,
  );

  const workspaceId = randomUUID();
  const contactRef = randomUUID();
  const checks: Check[] = [];
  try {
    await prisma.workspace.create({
      data: { id: workspaceId, name: `imap-acceptance-${Date.now()}` },
    });
    const domain = await prisma.outreachDomain.create({
      data: { workspaceId, domain: 'example.test', kind: 'catchall_test', state: 'ACTIVE' },
    });
    await prisma.outreachMailbox.create({
      data: {
        workspaceId,
        domainId: domain.id,
        address: config.OUTREACH_IMAP_USER!,
        displayName: 'IMAP acceptance',
        provider: 'greenmail',
        warmupStage: 'MATURE',
        dailyCap: 10,
        weeklyCap: 50,
      },
    });
    const batch = await prisma.outreachBatch.create({
      data: {
        workspaceId,
        name: 'imap acceptance',
        status: 'SENT',
        contentHash: 'a'.repeat(64),
        createdBy: 'acceptance',
      },
    });
    const draft = await prisma.outreachDraft.create({
      data: {
        workspaceId,
        batchId: batch.id,
        contactRef,
        recipientEmail: 'buyer@ziel.de',
        countryCode: 'DE',
        subject: 'Anfrage',
        body: 'Guten Tag',
        status: 'SENT',
        contentHash: 'a'.repeat(64),
        approvedBy: 'acceptance',
        approvedAt: new Date(),
      },
    });
    await prisma.outreachSend.create({
      data: {
        workspaceId,
        batchId: batch.id,
        draftId: draft.id,
        attempt: 1,
        recipientEmail: 'buyer@ziel.de',
        subjectHash: 'b'.repeat(64),
        bodyHash: 'c'.repeat(64),
        mailboxAddress: config.OUTREACH_IMAP_USER!,
        messageId: SENT_MESSAGE_ID,
        status: 'SENT',
        sentAt: new Date(),
      },
    });

    const before = await seenCounts();
    checks.push({ name: 'fixture: INBOX 初始为空', ok: before.total === 0, detail: before });

    await appendRaw(REPLY_RAW);
    await appendRaw(ORPHAN_RAW);
    await appendRaw(DSN_RAW);

    const first = await poller.pollOnce();
    checks.push({
      name: 'run1: 取未读→ingest（1 归因回复 + 1 硬退 + 1 未归因）',
      ok:
        first.processed === 2 &&
        first.unmatched === 1 &&
        first.duplicates === 0 &&
        first.errors === 0,
      detail: first,
    });

    const reply = await prisma.outreachReply.findFirst({
      where: { workspaceId, externalId: MATCHED_MESSAGE_ID },
    });
    checks.push({
      name: 'ingest 归因：outreach_reply 关联 contactRef 且 kind=REPLY',
      ok: reply?.kind === 'REPLY' && reply?.contactRef === contactRef,
      detail: reply ? { id: reply.id, kind: reply.kind, contactRef: reply.contactRef } : null,
    });
    const consent = await prisma.outreachConsent.findFirst({
      where: { workspaceId, contactRef, channel: 'email', status: 'OPT_OUT' },
    });
    checks.push({
      name: '停发联动：回复写入 email OPT_OUT（source=reply:reply）',
      ok: consent?.source === 'reply:reply',
      detail: consent ? { id: consent.id, source: consent.source } : null,
    });
    const bounce = await prisma.outreachReply.findFirst({
      where: { workspaceId, externalId: DSN_MESSAGE_ID },
    });
    checks.push({
      name: 'DSN 硬退：outreach_reply kind=BOUNCE（5.1.1）',
      ok: bounce?.kind === 'BOUNCE' && bounce?.contactRef === contactRef,
      detail: bounce ? { id: bounce.id, kind: bounce.kind } : null,
    });

    const second = await poller.pollOnce();
    checks.push({
      name: 'run2: 已读后不再重复处理（processed=0, duplicates=0）',
      ok: second.processed === 0 && second.duplicates === 0 && second.unmatched === 0,
      detail: second,
    });
    const after = await seenCounts();
    checks.push({
      name: '\\Seen 标记：三封邮件均已标记已读',
      ok: after.total === 3 && after.unseen === 0,
      detail: after,
    });
  } finally {
    await prisma.outreachSend.deleteMany({ where: { workspaceId } }).catch(() => undefined);
    await prisma.outreachDraft.deleteMany({ where: { workspaceId } }).catch(() => undefined);
    await prisma.outreachBatch.deleteMany({ where: { workspaceId } }).catch(() => undefined);
    await prisma.outreachMailbox.deleteMany({ where: { workspaceId } }).catch(() => undefined);
    await prisma.outreachDomain.deleteMany({ where: { workspaceId } }).catch(() => undefined);
    await prisma.workspace.deleteMany({ where: { id: workspaceId } }).catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }

  const ok = checks.every((check) => check.ok);
  console.log(JSON.stringify({ ok, checks }, null, 2));
  process.exit(ok ? 0 : 2);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
