import '../shared/load-env.js';
/**
 * P4-15 真实 SMTP 端到端验收（本地 GreenMail 容器，零费用）：
 * 批准批次 → 签发 v2 授权 → 发送执行器真实投递（TLS + DKIM 签名）→ GreenMail 收件箱核对
 * → 回信 ingest 归因（In-Reply-To = 线上 Message-ID）→ 回复即停（OPT_OUT）→ 下一批被拦 → 重复发送拒绝。
 *
 * 前置：本地 GreenMail 容器（SMTPS 3465；IMAPS 3993；仅回环端口）：
 *   docker --context default run -d --rm --name greenmail-smtp-check \
 *     -p 127.0.0.1:3465:3465 -p 127.0.0.1:3993:3993 greenmail/standalone:2.1.0
 * 运行（cwd=apps/server）：
 *   pnpm exec tsx src/scripts/outreach-smtp-live-acceptance.ts
 *
 * 脚本自行设置安全默认 env（回环 SMTPS、关闭影子模式、打开发送开关、生成临时 DKIM 密钥），
 * 已存在的环境变量优先。SMTP 出口必须是回环地址，否则拒绝运行（不发任何外部邮件）。
 * 说明：GreenMail standalone 不提供 SMTP STARTTLS 开关（实测 EHLO 不广告 STARTTLS），
 * 本验收走 SMTPS 直连 TLS；STARTTLS(587) 升级路径的差异见 evidence 限制节。
 * 退出码：0 = 全部断言通过；1 = 配置/前置不满足；2 = 断言失败。
 * 夹具（workspace/domain/mailbox/consent/batch/draft/send/reply/token/authorization）在结束时清理。
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { loadConfig, type AppConfig } from '../config/configuration.js';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import { CampaignTokenSigner } from '../campaign/campaign-token.signer.js';
import { OutreachAuthorizationIssuer } from '../campaign/outreach-authorization.issuer.js';
import { OutreachAuthorizationConsumer } from '../outreach/outreach-authorization.consumer.js';
import type { OutreachTenant } from '../outreach/outreach-consent.service.js';
import { hashOutreachDrafts } from '../outreach/outreach-content.js';
import type { OutreachDncChecker } from '../outreach/outreach-dnc.checker.js';
import { OutreachExperimentsService } from '../outreach/outreach-experiments.service.js';
import { OutreachHealthService } from '../outreach/outreach-health.service.js';
import { OutreachIngestService } from '../outreach/outreach-ingest.service.js';
import { OutreachMailboxService } from '../outreach/outreach-mailbox.service.js';
import { OutreachReplyService } from '../outreach/outreach-reply.service.js';
import { OutreachSendControls } from '../outreach/outreach-send-controls.js';
import { OutreachSendGate } from '../outreach/outreach-send.gate.js';
import { OutreachSendService } from '../outreach/outreach-send.service.js';
import { SmtpOutreachTransport } from '../outreach/outreach-smtp.transport.js';
import { OutreachUnsubscribeService } from '../outreach/outreach-unsubscribe.service.js';
import { ImapFlowClient, OutreachImapPoller } from '../outreach/outreach-imap.poller.js';

const FROM_ADDRESS = 'outreach@example.test';
const RECIPIENT_A = 'lead-a@ziel.de';
const RECIPIENT_B = 'lead-b@ziel.de';

// ── 安全默认 env：只指向本机 GreenMail；显式设置过的环境变量优先。──────────────
const DEFAULT_ENV: Record<string, string> = {
  OUTREACH_SEND_ENABLED: 'true',
  CAMPAIGN_EXECUTION_SHADOW: 'false',
  OUTREACH_SMTP_HOST: '127.0.0.1',
  OUTREACH_SMTP_PORT: '3465',
  OUTREACH_SMTP_SECURE: 'true',
  OUTREACH_SMTP_STARTTLS: 'true',
  OUTREACH_SMTP_TLS_REJECT_UNAUTHORIZED: 'false',
  OUTREACH_SMTP_FROM_ADDRESS: FROM_ADDRESS,
  OUTREACH_SMTP_FROM_NAME: 'GainOS Acceptance',
  OUTREACH_DKIM_DOMAIN: 'example.test',
  OUTREACH_DKIM_SELECTOR: 'acceptance',
  OUTREACH_DKIM_REQUIRED: 'true',
  OUTREACH_SEND_WINDOW_START: '00:00',
  OUTREACH_SEND_WINDOW_END: '23:59',
  OUTREACH_SEND_WEEKDAYS: '1,2,3,4,5,6,7',
  OUTREACH_IMAP_HOST: '127.0.0.1',
  OUTREACH_IMAP_PORT: '3993',
  OUTREACH_IMAP_USER: FROM_ADDRESS,
  OUTREACH_IMAP_PASSWORD: 'pass',
};
for (const [key, value] of Object.entries(DEFAULT_ENV)) {
  if (!process.env[key]) process.env[key] = value;
}
if (!process.env.OUTREACH_DKIM_PRIVATE_KEY && !process.env.OUTREACH_DKIM_PRIVATE_KEY_PATH) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.OUTREACH_DKIM_PRIVATE_KEY = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
}

interface Check {
  name: string;
  ok: boolean;
  detail: unknown;
}

function imapClient(config: AppConfig, user: string): ImapFlow {
  return new ImapFlow({
    host: config.OUTREACH_IMAP_HOST!,
    port: config.OUTREACH_IMAP_PORT!,
    secure: true,
    auth: { user, pass: config.OUTREACH_IMAP_PASSWORD ?? 'pass' },
    tls: { rejectUnauthorized: config.OUTREACH_SMTP_TLS_REJECT_UNAUTHORIZED },
    logger: false,
  });
}

/** GreenMail 在登录时自动创建用户；投递前先确保收件人信箱存在。 */
async function ensureUser(config: AppConfig, user: string): Promise<void> {
  const client = imapClient(config, user);
  await client.connect();
  await client.logout().catch(() => undefined);
}

async function appendToInbox(config: AppConfig, user: string, raw: string): Promise<void> {
  const client = imapClient(config, user);
  await client.connect();
  try {
    await client.append('INBOX', Buffer.from(raw, 'utf8'));
  } finally {
    await client.logout().catch(() => undefined);
  }
}

interface InboxSnapshot {
  total: number;
  messages: Array<{ subject: string; source: string }>;
}

async function readInbox(config: AppConfig, user: string): Promise<InboxSnapshot> {
  const client = imapClient(config, user);
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const messages: InboxSnapshot['messages'] = [];
    for await (const message of client.fetch({}, { envelope: true, source: true })) {
      messages.push({
        subject: message.envelope?.subject ?? '',
        source: message.source?.toString('utf8') ?? '',
      });
    }
    return { total: messages.length, messages };
  } finally {
    lock.release();
    await client.logout().catch(() => undefined);
  }
}

function errorCodeOf(error: unknown): string | null {
  const code = (error as { response?: { error?: { code?: unknown } } })?.response?.error?.code;
  return typeof code === 'string' ? code : null;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const smtpHost = (config.OUTREACH_SMTP_HOST ?? '').toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(smtpHost)) {
    console.error(`SMTP 出口 ${smtpHost || '(空)'} 不是回环地址：本验收只允许本地 GreenMail，拒绝运行`);
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaService();
  await prisma.$connect();
  const audit = new AuditService(prisma);
  const gate = new OutreachSendGate(config);
  const transport = new SmtpOutreachTransport(config);
  // DNC 走引擎 HTTP（本地纯流程验收不启动引擎）：以空名单桩替换，DNC 语义由单测覆盖。
  const dnc: OutreachDncChecker = { check: async () => new Map() };
  const unsubscribe = new OutreachUnsubscribeService(prisma, audit);
  const controls = new OutreachSendControls(prisma, config);
  const authorization = new OutreachAuthorizationConsumer(prisma, config);
  const mailboxes = new OutreachMailboxService(prisma, audit, config);
  const health = new OutreachHealthService(prisma, audit, config);
  const experiments = new OutreachExperimentsService(prisma, audit);
  const issuer = new OutreachAuthorizationIssuer(
    prisma,
    new CampaignTokenSigner(config),
    audit,
    config,
  );
  const send = new OutreachSendService(
    prisma,
    audit,
    gate,
    transport,
    dnc,
    unsubscribe,
    config,
    controls,
    authorization,
    mailboxes,
    health,
    experiments,
  );
  const replies = new OutreachReplyService(prisma, audit);
  const ingest = new OutreachIngestService(prisma, replies, audit);
  const poller = new OutreachImapPoller(prisma, ingest, new ImapFlowClient(config), config);

  const workspaceId = randomUUID();
  const contactA = randomUUID();
  const contactB = randomUUID();
  const tenant: OutreachTenant = { userId: 'acceptance-runner', workspaceId, role: 'admin' };
  const checks: Check[] = [];
  const record = (name: string, ok: boolean, detail: unknown) =>
    checks.push({ name, ok, detail });

  async function createQueuedBatch(input: {
    name: string;
    drafts: Array<{
      contactRef: string;
      recipientEmail: string;
      countryCode: string;
      subject: string;
      body: string;
    }>;
  }): Promise<{ batchId: string; draftIds: string[]; contentHash: string }> {
    const contentHash = hashOutreachDrafts(input.drafts);
    const batch = await prisma.outreachBatch.create({
      data: {
        workspaceId,
        name: input.name,
        status: 'QUEUED',
        contentHash,
        createdBy: 'acceptance',
        submittedAt: new Date(),
        queuedAt: new Date(),
      },
    });
    const draftIds: string[] = [];
    for (const draft of input.drafts) {
      const row = await prisma.outreachDraft.create({
        data: {
          workspaceId,
          batchId: batch.id,
          contactRef: draft.contactRef,
          recipientEmail: draft.recipientEmail,
          countryCode: draft.countryCode,
          subject: draft.subject,
          body: draft.body,
          status: 'APPROVED',
          contentHash,
          approvedBy: 'acceptance',
          approvedAt: new Date(),
        },
      });
      draftIds.push(row.id);
    }
    await prisma.outreachBatchApproval.create({
      data: {
        workspaceId,
        batchId: batch.id,
        contentHash,
        state: 'APPROVED',
        requestedBy: 'acceptance',
        decidedBy: 'acceptance',
        decidedAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    await issuer.issue(tenant, batch.id);
    return { batchId: batch.id, draftIds, contentHash };
  }

  try {
    // ── 夹具 ──────────────────────────────────────────────────────────────
    await ensureUser(config, FROM_ADDRESS);
    await ensureUser(config, RECIPIENT_A);
    await ensureUser(config, RECIPIENT_B);

    await prisma.workspace.create({
      data: { id: workspaceId, name: `smtp-acceptance-${Date.now()}` },
    });
    const domain = await prisma.outreachDomain.create({
      data: { workspaceId, domain: 'example.test', kind: 'catchall_test', state: 'ACTIVE' },
    });
    const mailbox = await prisma.outreachMailbox.create({
      data: {
        workspaceId,
        domainId: domain.id,
        address: FROM_ADDRESS,
        displayName: 'SMTP acceptance',
        provider: 'greenmail',
        warmupStage: 'MATURE',
        dailyCap: 10,
        weeklyCap: 50,
      },
    });
    await prisma.outreachConsent.create({
      data: {
        workspaceId,
        contactRef: contactA,
        channel: 'email',
        status: 'OPT_IN',
        source: 'acceptance:opt-in',
        lawfulBasis: 'consent',
      },
    });

    const subjectA = 'Anfrage: Präzisionspumpen – kurze Rückfrage';
    const bodyA = 'Guten Tag, dies ist ein lokaler Zustelltest (GreenMail, keine echte Mail).';
    const subjectB = 'Anfrage ohne Einwilligung';
    const bodyB = 'Diese Mail darf nicht zugestellt werden (DE ohne OPT_IN).';
    const batch1 = await createQueuedBatch({
      name: 'smtp acceptance #1',
      drafts: [
        { contactRef: contactA, recipientEmail: RECIPIENT_A, countryCode: 'DE', subject: subjectA, body: bodyA },
        { contactRef: contactB, recipientEmail: RECIPIENT_B, countryCode: 'DE', subject: subjectB, body: bodyB },
      ],
    });

    const beforeA = await readInbox(config, RECIPIENT_A);
    const beforeB = await readInbox(config, RECIPIENT_B);

    // ── 真实发送 ──────────────────────────────────────────────────────────
    const summary = await send.sendBatch(tenant, batch1.batchId);
    record('发送汇总：1 封真实投递、1 封法域同意门跳过、0 失败', summary.sent === 1 && summary.skipped === 1 && summary.failed === 0, {
      sent: summary.sent,
      skipped: summary.skipped,
      failed: summary.failed,
      results: summary.results,
    });
    record(
      'DE 无 OPT_IN 联系人：跳过码 JURISDICTION_CONSENT_REQUIRED',
      summary.results.some(
        (item) => item.draftId === batch1.draftIds[1] && item.status === 'SKIPPED' && item.error === 'JURISDICTION_CONSENT_REQUIRED',
      ),
      summary.results,
    );

    // ── 收件箱核对（真实 SMTP 投递 + DKIM）───────────────────────────────
    const afterA = await readInbox(config, RECIPIENT_A);
    const afterB = await readInbox(config, RECIPIENT_B);
    const delivered = afterA.messages[afterA.total - 1];
    record('GreenMail 收件箱：A 新增 1 封、B 没有新增', afterA.total === beforeA.total + 1 && afterB.total === beforeB.total, {
      beforeA: beforeA.total,
      afterA: afterA.total,
      afterB: afterB.total,
    });
    const deliveredBody = (() => {
      if (!delivered) return '';
      const separator = delivered.source.indexOf('\r\n\r\n');
      if (separator === -1) return '';
      const encoded = delivered.source.slice(separator + 4).replace(/\s+/g, '');
      return Buffer.from(encoded, 'base64').toString('utf8');
    })();
    record(
      '投递内容：主题一致、正文含退订页脚、头部带 List-Unsubscribe',
      delivered !== undefined &&
        delivered.subject === subjectA &&
        deliveredBody.includes('Abmelden / Unsubscribe:') &&
        /^List-Unsubscribe:/im.test(delivered.source),
      { subject: delivered?.subject, sourceLength: delivered?.source.length, bodyLength: deliveredBody.length },
    );
    record(
      'DKIM：线上报文带可解析签名（d=example.test, s=acceptance）',
      delivered !== undefined && /DKIM-Signature:\s*v=1/i.test(delivered.source) && delivered.source.includes('d=example.test') && delivered.source.includes('s=acceptance'),
      delivered ? delivered.source.split('\r\n').find((line) => line.startsWith('DKIM-Signature:'))?.slice(0, 200) : null,
    );

    // ── 台账与授权 ────────────────────────────────────────────────────────
    const sentRow = await prisma.outreachSend.findFirst({
      where: { workspaceId, batchId: batch1.batchId, status: 'SENT' },
    });
    record(
      '台账：SENT 行带 250 遥测、延迟与 authorizationUse=1',
      sentRow?.smtpStatusCode === 250 && sentRow?.latencyMs !== null && sentRow?.authorizationUse === 1 && Boolean(sentRow?.messageId?.includes('@')),
      sentRow
        ? { messageId: sentRow.messageId, smtpStatusCode: sentRow.smtpStatusCode, latencyMs: sentRow.latencyMs, authorizationUse: sentRow.authorizationUse }
        : null,
    );
    const authorizationRow = sentRow?.authorizationId
      ? await prisma.campaignExecutionAuthorization.findUnique({ where: { id: sentRow.authorizationId } })
      : null;
    record('执行授权 v2：逐封消费 uses=1', authorizationRow?.uses === 1, authorizationRow ? { uses: authorizationRow.uses, maxUses: authorizationRow.maxUses } : null);
    const draftRows = await prisma.outreachDraft.findMany({ where: { batchId: batch1.batchId } });
    const draftA = draftRows.find((row) => row.id === batch1.draftIds[0]);
    const draftB = draftRows.find((row) => row.id === batch1.draftIds[1]);
    const batchRow = await prisma.outreachBatch.findUnique({ where: { id: batch1.batchId } });
    record(
      '状态机：草稿 SENT/SKIPPED、批次 COMPLETED',
      draftA?.status === 'SENT' && draftB?.status === 'SKIPPED' && batchRow?.status === 'COMPLETED',
      { draftA: draftA?.status, draftB: draftB?.status, batch: batchRow?.status },
    );
    const auditPackage = await prisma.outreachAuditPackage.findFirst({
      where: { workspaceId, batchId: batch1.batchId },
    });
    record('审计包：内容寻址 packageHash 已落库', auditPackage?.packageHash?.length === 64, auditPackage ? { packageHash: auditPackage.packageHash } : null);

    // ── 计数落库 ──────────────────────────────────────────────────────────
    const mailboxCounters = await prisma.outreachMailboxCounter.findMany({ where: { mailboxId: mailbox.id } });
    const domainCounters = await prisma.outreachDomainCounter.findMany({ where: { domainId: domain.id } });
    record(
      '计数：信箱日计数=1、同收件域小时限速计数=1（ziel.de）',
      mailboxCounters.reduce((sum, row) => sum + row.sent, 0) === 1 &&
        domainCounters.filter((row) => row.recipientDomain === 'ziel.de').reduce((sum, row) => sum + row.sent, 0) === 1,
      { mailbox: mailboxCounters.map((row) => row.sent), domain: domainCounters.map((row) => ({ recipientDomain: row.recipientDomain, sent: row.sent })) },
    );

    // ── 回信归因（In-Reply-To = 线上 Message-ID）→ 回复即停 ────────────────
    const replyMessageId = 'reply-acceptance-1@ziel.de';
    const replyRaw = [
      `From: Buyer A <${RECIPIENT_A}>`,
      `To: ${FROM_ADDRESS}`,
      `Subject: Re: ${subjectA}`,
      `Message-ID: <${replyMessageId}>`,
      `In-Reply-To: <${sentRow?.messageId}>`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Danke, bitte keine weiteren Mails.',
    ].join('\r\n');
    await appendToInbox(config, FROM_ADDRESS, replyRaw);
    const polled = await poller.pollOnce();
    record('IMAP 轮询：1 封回复处理成功', polled.processed === 1 && polled.errors === 0, polled);
    const replyRow = await prisma.outreachReply.findFirst({
      where: { workspaceId, externalId: replyMessageId },
    });
    record(
      '回信归因：outreach_reply kind=REPLY 且关联联系人 A（Message-ID 与台账一致）',
      replyRow?.kind === 'REPLY' && replyRow?.contactRef === contactA,
      replyRow ? { kind: replyRow.kind, contactRef: replyRow.contactRef } : null,
    );
    const optOut = await prisma.outreachConsent.findFirst({
      where: { workspaceId, contactRef: contactA, channel: 'email', status: 'OPT_OUT' },
    });
    record('回复即停：email OPT_OUT（source=reply:reply）', optOut?.source === 'reply:reply', optOut ? { source: optOut.source } : null);

    // ── 停发后新批次被拦 ──────────────────────────────────────────────────
    const batch2 = await createQueuedBatch({
      name: 'smtp acceptance #2 (after opt-out)',
      drafts: [
        { contactRef: contactA, recipientEmail: RECIPIENT_A, countryCode: 'DE', subject: 'Folgefrage', body: 'Diese Mail darf nach Opt-out nicht zugestellt werden.' },
      ],
    });
    const summary2 = await send.sendBatch(tenant, batch2.batchId);
    const afterOptOutA = await readInbox(config, RECIPIENT_A);
    record(
      '回复后新批次：0 投递（跳过码 OUTREACH_OPTED_OUT）、收件箱无新增',
      summary2.sent === 0 && summary2.skipped === 1 && summary2.results.some((item) => item.error === 'OUTREACH_OPTED_OUT') && afterOptOutA.total === afterA.total,
      { sent: summary2.sent, skipped: summary2.skipped, results: summary2.results, inbox: afterOptOutA.total },
    );

    // ── 重复发送拒绝 ──────────────────────────────────────────────────────
    let retryCode: string | null = null;
    try {
      await send.sendBatch(tenant, batch1.batchId);
    } catch (error) {
      retryCode = errorCodeOf(error);
    }
    const sendsForBatch1 = await prisma.outreachSend.count({ where: { batchId: batch1.batchId } });
    record('重复发送被拒（OUTREACH_BATCH_ALREADY_COMPLETED）且无新台账', retryCode === 'OUTREACH_BATCH_ALREADY_COMPLETED' && sendsForBatch1 === 2, { retryCode, sendsForBatch1 });
  } finally {
    await prisma.outreachReply.deleteMany({ where: { workspaceId } }).catch(() => undefined);
    await prisma.outreachUnsubscribeToken.deleteMany({ where: { workspaceId } }).catch(() => undefined);
    await prisma.outreachConsent.deleteMany({ where: { workspaceId } }).catch(() => undefined);
    await prisma.campaignExecutionAuthorization.deleteMany({ where: { workspaceId } }).catch(() => undefined);
    await prisma.outreachBatch.deleteMany({ where: { workspaceId } }).catch(() => undefined);
    await prisma.outreachMailbox.deleteMany({ where: { workspaceId } }).catch(() => undefined);
    await prisma.outreachDomain.deleteMany({ where: { workspaceId } }).catch(() => undefined);
    await prisma.workspace.deleteMany({ where: { id: workspaceId } }).catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }

  const ok = checks.every((check) => check.ok);
  console.log(JSON.stringify({ ok, checks }, null, 2));
  process.exitCode = ok ? 0 : 2;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});
