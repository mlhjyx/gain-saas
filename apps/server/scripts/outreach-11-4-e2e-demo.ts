/**
 * TEST-ONLY 端到端演示（M2 步 11-3/11-4）：真实 Prisma + 真实 SMTP → 本地 Mailpit。
 * 绝不连接外网 SMTP；发送出口固定 127.0.0.1。
 *
 * 运行：
 *   DEMO_DATABASE_URL=postgresql://gain_saas:dev@127.0.0.1:5433/gain_saas_11_4_demo \
 *   OUTREACH_DKIM_PRIVATE_KEY_PATH=/tmp/outreach-11-3-evidence/dkim-test20261108.key \
 *   pnpm --filter @gain-saas/server exec tsx scripts/outreach-11-4-e2e-demo.ts
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../src/config/configuration.js';
import type { AuditService } from '../src/shared/audit.service.js';
import { OutreachBatchService } from '../src/outreach/outreach-batch.service.js';
import type { OutreachTenant } from '../src/outreach/outreach-consent.service.js';
import type { OutreachDncChecker } from '../src/outreach/outreach-dnc.checker.js';
import { OutreachPublicController } from '../src/outreach/outreach-public.controller.js';
import { OutreachReplyService } from '../src/outreach/outreach-reply.service.js';
import { OutreachSendGate } from '../src/outreach/outreach-send.gate.js';
import { OutreachSendService } from '../src/outreach/outreach-send.service.js';
import { SmtpOutreachTransport } from '../src/outreach/outreach-smtp.transport.js';
import { OutreachUnsubscribeService } from '../src/outreach/outreach-unsubscribe.service.js';

const databaseUrl = process.env.DEMO_DATABASE_URL;
if (!databaseUrl) throw new Error('缺少 DEMO_DATABASE_URL');
const privateKeyPath = process.env.OUTREACH_DKIM_PRIVATE_KEY_PATH;
if (!privateKeyPath) throw new Error('缺少 OUTREACH_DKIM_PRIVATE_KEY_PATH');

const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:18025';
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const audit = { record: async () => undefined } as unknown as AuditService;

const smtpConfig = {
  OUTREACH_SMTP_HOST: '127.0.0.1',
  OUTREACH_SMTP_PORT: 11025,
  OUTREACH_SMTP_SECURE: false,
  OUTREACH_SMTP_STARTTLS: false,
  OUTREACH_SMTP_FROM_ADDRESS: 'outreach@mail.gainos.test',
  OUTREACH_SMTP_FROM_NAME: 'GainOS TEST',
  OUTREACH_SMTP_TLS_REJECT_UNAUTHORIZED: true,
  OUTREACH_SMTP_TIMEOUT_MS: 15_000,
  OUTREACH_SMTP_ALLOWED_HOSTS: '127.0.0.1',
  OUTREACH_DKIM_REQUIRED: true,
  OUTREACH_DKIM_DOMAIN: 'mail.gainos.test',
  OUTREACH_DKIM_SELECTOR: 'test20261108',
  OUTREACH_DKIM_PRIVATE_KEY: readFileSync(privateKeyPath, 'utf8'),
} as AppConfig;

const appConfig = {
  ...smtpConfig,
  OUTREACH_APPROVAL_TTL_HOURS: 72,
  OUTREACH_SEND_ENABLED: true,
  OUTREACH_SEND_BATCH_LIMIT: 50,
  OUTREACH_UNSUBSCRIBE_BASE_URL: 'http://127.0.0.1:4020',
} as AppConfig;

interface StepResult {
  step: string;
  expected: string;
  actual: unknown;
  pass: boolean;
}

const steps: StepResult[] = [];
function record(step: string, expected: string, actual: unknown, pass: boolean): void {
  steps.push({ step, expected, actual, pass });
}

function errorCode(error: unknown): string {
  return (error as { response?: { error?: { code?: string } } }).response?.error?.code ?? '';
}

async function mailpitMessages(): Promise<
  Array<{ ID: string; To: Array<{ Address: string }>; Subject: string }>
> {
  const res = await fetch(`${MAILPIT}/api/v1/messages`);
  const body = (await res.json()) as {
    messages?: Array<{ ID: string; To: Array<{ Address: string }>; Subject: string }>;
  };
  return body.messages ?? [];
}

async function rawMessage(id: string): Promise<string> {
  const res = await fetch(`${MAILPIT}/api/v1/message/${id}/raw`);
  return res.text();
}

async function main(): Promise<void> {
  // 清空 sink，保证计数只反映本次演示。
  await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' }).catch(() => undefined);

  const workspaceId = randomUUID();
  await prisma.workspace.create({
    data: { id: workspaceId, name: 'M2 11-4 E2E Demo' },
  });
  const tenant: OutreachTenant = {
    userId: randomUUID(),
    workspaceId,
    role: 'admin',
  };
  // 12-3 语境：批次挂 campaign，回复回写同一 campaign 下 SAO 的 REPLIED outcome。
  const campaign = await prisma.campaign.create({
    data: {
      workspaceId,
      name: 'M2 11-4 Demo Campaign',
      objective: 'local sink TEST',
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
  });
  const qgo = await prisma.qgo.create({
    data: {
      workspaceId,
      leadRef: randomUUID(),
      canonicalCompanyRef: randomUUID(),
      campaignId: campaign.id,
      title: 'Demo QGO',
      evidence: [{ source: 'm2-step11-e2e' }],
      nextStep: 'demo',
      createdBy: tenant.userId,
    },
  });
  const sao = await prisma.sao.create({
    data: {
      workspaceId,
      qgoId: qgo.id,
      state: 'ACCEPTED',
      decidedBy: tenant.userId,
      decidedAt: new Date(),
    },
  });

  const batchService = new OutreachBatchService(prisma, audit, appConfig);
  const unsubscribe = new OutreachUnsubscribeService(prisma, audit);
  const replyService = new OutreachReplyService(prisma, audit);
  const transport = new SmtpOutreachTransport(smtpConfig);
  const dncState: {
    hits: Map<string, string[]>;
    fail: boolean;
  } = { hits: new Map(), fail: false };
  const dnc: OutreachDncChecker = {
    check: async () => {
      if (dncState.fail) throw new Error('demo engine down');
      return new Map(dncState.hits);
    },
  };
  const gate = new OutreachSendGate({ OUTREACH_SEND_ENABLED: true } as AppConfig);
  const sendService = new OutreachSendService(
    prisma,
    audit,
    gate,
    transport,
    dnc,
    unsubscribe,
    appConfig,
  );

  const contacts = {
    a1: randomUUID(),
    a2: randomUUID(),
    b1: randomUUID(),
    c1: randomUUID(),
    d1: randomUUID(),
    e1: randomUUID(),
  };
  const emails = {
    a1: 'buyer@example.test',
    a2: 'einkauf@example.test',
    b1: 'buyer@example.test',
    c1: 'reply-stop@example.test',
    d1: 'dnc-hit@example.test',
    e1: 'engine-down@example.test',
  };

  async function approvedBatch(
    name: string,
    drafts: Array<{ contactRef: string; recipientEmail: string; subject: string }>,
  ): Promise<string> {
    const batch = await batchService.createBatch(tenant, { name, campaignId: campaign.id });
    for (const [index, draft] of drafts.entries()) {
      await batchService.addDraft(tenant, batch.id, {
        contactRef: draft.contactRef,
        recipientEmail: draft.recipientEmail,
        companyName: 'Beispiel GmbH',
        subject: draft.subject,
        body: `Guten Tag,\r\n\r\nTEST-Nachricht ${index + 1}. Keine echte Zustellung.\r\n\r\nGainOS Demo ${name}.`,
      });
    }
    const approval = await batchService.submitBatch(tenant, batch.id);
    await batchService.decideApproval(tenant, batch.id, approval.id, {
      decision: 'approve',
      reason: 'demo approval',
    });
    return batch.id;
  }

  // 1) 正常链路：创建→草稿→审批→发送（真实 SMTP → Mailpit）
  const batchA = await approvedBatch('Demo A 正常发送', [
    { contactRef: contacts.a1, recipientEmail: emails.a1, subject: 'TEST A1' },
    { contactRef: contacts.a2, recipientEmail: emails.a2, subject: 'TEST A2' },
  ]);

  // 2) 负向：逐封 L2 —— 未批准不得发
  const draftA1 = await prisma.outreachDraft.findFirst({
    where: { batchId: batchA, contactRef: contacts.a1 },
  });
  await prisma.outreachDraft.update({
    where: { id: draftA1!.id },
    data: { approvedAt: null },
  });
  let l2Code = '';
  try {
    await sendService.sendBatch(tenant, batchA);
  } catch (error) {
    l2Code = errorCode(error);
  }
  record('负向：未批准直发', 'OUTREACH_DRAFT_NOT_APPROVED', l2Code, l2Code === 'OUTREACH_DRAFT_NOT_APPROVED');
  await prisma.outreachDraft.update({
    where: { id: draftA1!.id },
    data: { approvedAt: draftA1!.approvedAt },
  });

  // 3) 正常发送
  const sendA = await sendService.sendBatch(tenant, batchA);
  record('批次 A 发送', 'SENT 2', sendA, sendA.status === 'SENT' && sendA.sent === 2);

  const messages = await mailpitMessages();
  record('Mailpit 收到', '2 封', messages.length, messages.length === 2);
  const first = messages.find((message) =>
    message.To.some((to) => to.Address === emails.a1),
  )!;
  const raw = await rawMessage(first.ID);
  record('DKIM 签名存在', 'DKIM-Signature v=1', /DKIM-Signature: v=1/.test(raw), /DKIM-Signature: v=1/.test(raw));
  record(
    'List-Unsubscribe 头',
    'unsubscribe?token=',
    /List-Unsubscribe: <[^>]*unsubscribe\?token=/.test(raw),
    /List-Unsubscribe: <[^>]*unsubscribe\?token=/.test(raw),
  );
  const tokenMatch = /unsubscribe\?token=([A-Za-z0-9_-]+)/.exec(raw);
  record('退订 token 在邮件中', '存在', tokenMatch?.[1] ? 'present' : 'missing', Boolean(tokenMatch?.[1]));

  // 4) 退订 token 生效（公共端点；平台抑制用记录器代替真实引擎写入）
  const suppressedCalls: unknown[] = [];
  const publicController = new OutreachPublicController(unsubscribe, {
    suppressGlobal: async (_tenant, input) => {
      suppressedCalls.push(input);
    },
  });
  let publicResult: unknown = null;
  await publicController.consume(
    {
      query: { token: tokenMatch![1] },
      body: {},
      accepts: () => 'json',
    } as never,
    {
      type() {
        return this;
      },
      send() {
        return this;
      },
      json(payload: unknown) {
        publicResult = payload;
        return this;
      },
    } as never,
  );
  record('退订消费', 'unsubscribed true', publicResult, Boolean((publicResult as { data?: { unsubscribed?: boolean } })?.data?.unsubscribed));
  const consentA1 = await prisma.outreachConsent.findFirst({
    where: { workspaceId, contactRef: contacts.a1, channel: 'email' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  record('退订写入 OPT_OUT', 'OPT_OUT', consentA1?.status, consentA1?.status === 'OPT_OUT');
  record('平台抑制同步调用', '1 次', suppressedCalls, suppressedCalls.length === 1);

  // 5) 退订后同一联系人再建批次：跳过，不再投递
  const batchB = await approvedBatch('Demo B 退订后', [
    { contactRef: contacts.a1, recipientEmail: emails.b1, subject: 'TEST B1' },
  ]);
  const beforeB = (await mailpitMessages()).length;
  const sendB = await sendService.sendBatch(tenant, batchB);
  const afterB = (await mailpitMessages()).length;
  record(
    '退订后发送跳过',
    'COMPLETED skipped 1, 无新增邮件',
    { sendB, newMessages: afterB - beforeB },
    sendB.status === 'COMPLETED' && sendB.skipped === 1 && afterB === beforeB,
  );

  // 6) 回复分类回写 → 后续批次即停
  await replyService.record(tenant, {
    contactRef: contacts.c1,
    recipientEmail: emails.c1,
    kind: 'REPLY',
    classification: 'NEGATIVE',
    subject: 'Re: TEST',
    snippet: 'Kein Interesse',
    externalId: 'demo-reply-1',
    saoId: sao.id,
  });
  const replies = await replyService.list(tenant);
  record(
    '回复分类回写',
    'NEGATIVE 1 条',
    { count: replies.length, classification: replies[0]?.classification },
    replies.length === 1 && replies[0]?.classification === 'NEGATIVE',
  );
  const outcomes = await prisma.opportunityOutcome.findMany({
    where: { workspaceId, saoId: sao.id, outcome: 'REPLIED' },
  });
  record(
    '回复 → opportunity_outcome.REPLIED',
    'SYSTEM + sourceEventId=reply.id',
    outcomes.map((row) => ({ source: row.source, sourceEventId: row.sourceEventId })),
    outcomes.length === 1 &&
      outcomes[0]?.source === 'SYSTEM' &&
      outcomes[0]?.sourceEventId === replies[0]?.id,
  );
  const batchC = await approvedBatch('Demo C 回复后', [
    { contactRef: contacts.c1, recipientEmail: emails.c1, subject: 'TEST C1' },
  ]);
  const beforeC = (await mailpitMessages()).length;
  const sendC = await sendService.sendBatch(tenant, batchC);
  const afterC = (await mailpitMessages()).length;
  record(
    '回复后发送跳过',
    'COMPLETED skipped 1, 无新增邮件',
    { sendC, newMessages: afterC - beforeC },
    sendC.status === 'COMPLETED' && sendC.skipped === 1 && afterC === beforeC,
  );

  // 7) DNC 命中：跳过并记录原因（DNC checker 在此注入命中；真实 check 端点在 11-1 已接线）
  dncState.hits.set(emails.d1, ['global:unsubscribe']);
  const batchD = await approvedBatch('Demo D DNC 命中', [
    { contactRef: contacts.d1, recipientEmail: emails.d1, subject: 'TEST D1' },
  ]);
  const beforeD = (await mailpitMessages()).length;
  const sendD = await sendService.sendBatch(tenant, batchD);
  const afterD = (await mailpitMessages()).length;
  const dncLedger = await prisma.outreachSend.findFirst({
    where: { batchId: batchD, status: 'SKIPPED' },
  });
  record(
    'DNC 命中跳过并记录原因',
    'SKIPPED + OUTREACH_DNC_BLOCKED',
    { sendD, newMessages: afterD - beforeD, reason: dncLedger?.error },
    sendD.status === 'COMPLETED' &&
      sendD.skipped === 1 &&
      afterD === beforeD &&
      (dncLedger?.error ?? '').includes('OUTREACH_DNC_BLOCKED'),
  );

  // 8) 负向：DNC 查询失败 fail closed
  dncState.fail = true;
  const batchE = await approvedBatch('Demo E 引擎故障', [
    { contactRef: contacts.e1, recipientEmail: emails.e1, subject: 'TEST E1' },
  ]);
  const beforeE = (await mailpitMessages()).length;
  let dncFailCode = '';
  try {
    await sendService.sendBatch(tenant, batchE);
  } catch (error) {
    dncFailCode = errorCode(error);
  }
  const afterE = (await mailpitMessages()).length;
  record(
    'DNC 查询失败 fail closed',
    'OUTREACH_DNC_UNAVAILABLE, 无新增邮件',
    { code: dncFailCode, newMessages: afterE - beforeE },
    dncFailCode === 'OUTREACH_DNC_UNAVAILABLE' && afterE === beforeE,
  );
  dncState.fail = false;

  // 9) 负向：重放已发送批次
  let replayCode = '';
  try {
    await sendService.sendBatch(tenant, batchA);
  } catch (error) {
    replayCode = errorCode(error);
  }
  record('负向：重放已发送批次', 'OUTREACH_BATCH_ALREADY_SENT', replayCode, replayCode === 'OUTREACH_BATCH_ALREADY_SENT');

  // 10) 审计包结构
  const auditPackage = await sendService.getAuditPackage(tenant, batchA);
  const pkg = auditPackage.package as {
    schemaVersion: string;
    approval: { decidedBy: string; decidedAt: string } | null;
    drafts: Array<{ subject: string; body: string; complianceBasis: { consentStatus: string } }>;
    events: Array<{ type: string }>;
  };
  record(
    '审计包结构',
    'schema + approval + drafts + events',
    {
      schemaVersion: pkg.schemaVersion,
      decidedBy: pkg.approval?.decidedBy,
      draftCount: pkg.drafts.length,
      eventTypes: pkg.events.map((event) => event.type),
      packageHash: auditPackage.packageHash,
      persistedAt: auditPackage.persistedAt,
    },
    pkg.schemaVersion === 'outreach-audit-package/v1' &&
      Boolean(pkg.approval?.decidedBy) &&
      pkg.drafts.length === 2 &&
      pkg.events.some((event) => event.type === 'BATCH_SENT') &&
      auditPackage.persistedAt !== null,
  );

  const outDir =
    process.env.DEMO_OUT_DIR ??
    join(process.cwd(), '..', '..', 'docs', 'evidence', 'outreach-11-4');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'mailpit-raw.eml'), raw);
  writeFileSync(
    join(outDir, 'demo-result.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        workspaceId,
        campaignId: campaign.id,
        saoId: sao.id,
        qgoId: qgo.id,
        batchIds: { A: batchA, B: batchB, C: batchC, D: batchD, E: batchE },
        steps,
        auditPackage,
      },
      null,
      2,
    ),
  );

  const failed = steps.filter((step) => !step.pass);
  console.log(
    JSON.stringify(
      {
        pass: failed.length === 0,
        workspaceId,
        campaignId: campaign.id,
        saoId: sao.id,
        steps,
        failed,
      },
      null,
      2,
    ),
  );
  if (failed.length > 0) process.exitCode = 1;
}

void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
