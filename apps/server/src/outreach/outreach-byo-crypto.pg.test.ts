import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import {
  dockerAvailable,
  startDisposablePostgres,
  type DisposablePostgres,
} from '../ops/attribution-test-pg.js';
import { CampaignTokenSigner } from '../campaign/campaign-token.signer.js';
import { OutreachAuthorizationIssuer } from '../campaign/outreach-authorization.issuer.js';
import { AuditService } from '../shared/audit.service.js';
import {
  decryptPii,
  extractPiiKeyId,
  isEncryptedPii,
  parsePiiKeyring,
} from '../shared/pii-crypto.js';
import { PiiCryptoService } from '../shared/pii-crypto.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import { backfillOutreachPiiCrypto } from '../scripts/backfill-outreach-pii-crypto.js';
import { OutreachAuthorizationConsumer } from './outreach-authorization.consumer.js';
import { OutreachBatchService } from './outreach-batch.service.js';
import { OutreachCallsService } from './outreach-calls.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';
import { OutreachExperimentsService } from './outreach-experiments.service.js';
import { OutreachHealthService } from './outreach-health.service.js';
import { OutreachMailboxService } from './outreach-mailbox.service.js';
import { OUTREACH_PII_PURPOSE } from './outreach-pii.constants.js';
import { OutreachReplyService } from './outreach-reply.service.js';
import { OutreachSendControls } from './outreach-send-controls.js';
import { OutreachSendGate } from './outreach-send.gate.js';
import { OutreachSendService } from './outreach-send.service.js';
import type { OutreachTransport } from './outreach-smtp.transport.js';
import { OutreachUnsubscribeService } from './outreach-unsubscribe.service.js';

const available = dockerAvailable();
if (!available) {
  if (process.env.CI === 'true') {
    throw new Error('[outreach-byo-crypto.pg] CI requires docker for PG16 outreach crypto tests');
  }
  console.warn('[outreach-byo-crypto.pg] docker unavailable, skipping PG16 outreach crypto tests');
}

const KEY_1 = 'aa'.repeat(32);
const KEY_2 = 'bb'.repeat(32);
const RING_K1 = JSON.stringify({ activeKeyId: 'k1', keys: { k1: KEY_1, k2: KEY_2 } });
const RING_K2 = JSON.stringify({ activeKeyId: 'k2', keys: { k1: KEY_1, k2: KEY_2 } });

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    SESSION_SECRET: 's'.repeat(40),
    PII_KEYRING_JSON: RING_K1,
    OUTREACH_BYO_ALLOW_PRIVATE_HOSTS: false,
    OUTREACH_ENTERPRISE_APPROVAL_REQUIRED: false,
    OUTREACH_SEND_ENABLED: true,
    OUTREACH_SEND_BATCH_LIMIT: 50,
    OUTREACH_APPROVAL_TTL_HOURS: 72,
    OUTREACH_AUTHZ_TTL_MINUTES: 120,
    OUTREACH_AUTHZ_SCHEDULE_DAYS: 7,
    OUTREACH_MAILBOX_DAILY_CAP: 30,
    OUTREACH_MAILBOX_WEEKLY_CAP: 120,
    OUTREACH_DOMAIN_HOURLY_CAP: 5,
    OUTREACH_BATCH_MAX_RECIPIENTS: 50,
    OUTREACH_SEND_WINDOW_START: '00:00',
    OUTREACH_SEND_WINDOW_END: '23:59',
    OUTREACH_SEND_WEEKDAYS: '1,2,3,4,5,6,7',
    OUTREACH_BOUNCE_WINDOW_DAYS: 7,
    OUTREACH_BOUNCE_MIN_SAMPLE: 20,
    OUTREACH_BOUNCE_RATE_HALT: 0.05,
    OUTREACH_COMPLAINT_MIN_SAMPLE: 100,
    OUTREACH_COMPLAINT_RATE_HALT: 0.003,
    OUTREACH_COST_PER_EMAIL_MICROS: 37_000,
    OUTREACH_UNSUBSCRIBE_BASE_URL: 'http://127.0.0.1:4020',
    OUTREACH_US_POSTAL_ADDRESS: 'GainOS Inc., 2261 Market St, San Francisco, CA 94114',
    OUTREACH_FR_SOURCE_NOTICE: 'Vos coordonnées proviennent de sources publiques.',
    CAMPAIGN_EXECUTION_SHADOW: false,
    ...overrides,
  } as AppConfig;
}

describe.skipIf(!available)(
  'PG16 外联 6 表 enc:v2 加密、BYO 凭据 FORCE RLS、密钥轮换回填与跨实例行级发送锁',
  () => {
    let pg: DisposablePostgres;
    let adminPrisma: PrismaClient;
    let appPrisma: PrismaService;

    const WS_A = randomUUID();
    const WS_B = randomUUID();
    const tenantA: OutreachTenant = { userId: randomUUID(), workspaceId: WS_A, role: 'admin' };
    const tenantB: OutreachTenant = { userId: randomUUID(), workspaceId: WS_B, role: 'admin' };

    beforeAll(async () => {
      pg = startDisposablePostgres();
      adminPrisma = new PrismaClient({ datasourceUrl: pg.databaseUrl });
      appPrisma = new PrismaService({ datasourceUrl: pg.appDatabaseUrl, enforcePrincipal: true });
      await appPrisma.verifyPrincipal();
      await adminPrisma.workspace.createMany({
        data: [
          { id: WS_A, name: 'BYO Crypto Tenant A' },
          { id: WS_B, name: 'BYO Crypto Tenant B' },
        ],
      });
    }, 900_000);

    afterAll(async () => {
      await appPrisma?.onModuleDestroy().catch(() => undefined);
      await adminPrisma?.$disconnect().catch(() => undefined);
      pg?.stop();
    }, 120_000);

    it('外联 6 表落库全量 enc:v2 密文、跨租户 AAD 拒绝解密，且服务层透明读取明文', async () => {
      const config = makeConfig();
      const crypto = new PiiCryptoService(config);
      const audit = new AuditService(appPrisma);
      const signer = new CampaignTokenSigner(config);
      const issuer = new OutreachAuthorizationIssuer(appPrisma, signer, audit, config, crypto);
      const batches = new OutreachBatchService(appPrisma, audit, config, issuer, crypto);
      const mailboxes = new OutreachMailboxService(appPrisma, audit, config, crypto);
      const unsub = new OutreachUnsubscribeService(appPrisma, audit, crypto);
      const replies = new OutreachReplyService(appPrisma, audit, crypto);
      const calls = new OutreachCallsService(appPrisma, audit, config, crypto);

      // 配置 BYO 邮箱
      const mb = await mailboxes.createMailbox(tenantA, {
        address: 'outreach@tenant-a.example',
        displayName: 'Tenant A Sales',
      });
      await mailboxes.configureCredentials(tenantA, mb.id, {
        authMode: 'password',
        smtpHost: 'smtp.gmail.com',
        smtpPort: 465,
        smtpSecure: true,
        imapHost: 'imap.gmail.com',
        imapPort: 993,
        imapSecure: true,
        password: 'tenant-a-smtp-secret',
      });

      // 1. Draft + QuickConfirm + Send（覆盖 outreach_draft, outreach_send, outreach_unsubscribe_token）
      const contact1 = randomUUID();
      const batch = await batches.createBatch(tenantA, { name: 'PG Crypto Batch', mailboxId: mb.id });
      await batches.addDraft(tenantA, batch.id, {
        contactRef: contact1,
        recipientEmail: 'ceo@us-buyer.example',
        countryCode: 'US',
        companyName: 'US Buyer Corp',
        subject: 'Hello',
        body: 'Catalog attached.',
      });
      await batches.quickConfirmBatch(tenantA, batch.id, { mailboxId: mb.id });

      const transport: OutreachTransport = {
        ensureConfigured: vi.fn(),
        send: vi.fn(async () => ({ messageId: `pg-msg-${randomUUID()}@tenant-a.example` })),
      };
      const sendSvc = new OutreachSendService(
        appPrisma,
        audit,
        new OutreachSendGate(config),
        transport,
        { check: vi.fn(async () => new Map()) },
        { check: vi.fn(async () => new Map()) } as never,
        { enqueue: vi.fn(async () => undefined) } as never,
        unsub,
        config,
        new OutreachSendControls(appPrisma, config, crypto),
        new OutreachAuthorizationConsumer(appPrisma, config),
        mailboxes,
        new OutreachHealthService(appPrisma, audit, config),
        new OutreachExperimentsService(appPrisma, audit),
        crypto,
      );
      const sendSummary = await sendSvc.sendBatch(tenantA, batch.id);
      expect(sendSummary.sent).toBe(1);

      // 2. Reply（覆盖 outreach_reply）
      const recordedReply = await replies.record(tenantA, {
        contactRef: contact1,
        recipientEmail: 'ceo@us-buyer.example',
        kind: 'REPLY',
        classification: 'POSITIVE',
        summary: 'Interested in quote',
      });
      expect(recordedReply.recipientEmail).toBe('ceo@us-buyer.example');

      // 3. Call Basis + Attempt（覆盖 outreach_call_basis, outreach_call_attempt）
      const legalReview = await adminPrisma.legalReview.create({
        data: {
          workspaceId: WS_A,
          subjectKind: 'phone_script',
          reviewerKind: 'OWNER_RISK_ACCEPTANCE',
          documentHash: 'a'.repeat(64),
          reviewerName: 'Compliance Owner',
          reviewerFirm: 'Internal',
          reviewedAt: new Date(),
          scope: 'US/DE phone script',
          verdict: 'APPROVED',
          documentRef: 'doc:script-v1',
          createdBy: tenantA.userId,
        },
      });
      const scriptTemplate = await adminPrisma.outreachTemplateVersion.create({
        data: {
          workspaceId: WS_A,
          kind: 'phone_script',
          jurisdiction: 'US',
          language: 'en',
          version: 1,
          body: 'Hello, calling regarding industrial pump procurement.',
          contentHash: 'a'.repeat(64),
          legalReviewId: legalReview.id,
          state: 'ACTIVE',
          createdBy: tenantA.userId,
        },
      });
      const basis = await calls.createBasis(tenantA, {
        contactRef: contact1,
        phoneE164: '+14155550199',
        companyName: 'US Buyer Corp',
        triggerType: 'published_buying_role',
        triggerEvidence: { url: 'https://us-buyer.example/procurement' },
        relevanceStatement: 'Published purchasing manager looking for high-pressure industrial pumps for 2026 Q4 project.',
        collectedSourceUrl: 'https://us-buyer.example/procurement',
        collectedAt: new Date().toISOString(),
        scriptTemplateId: scriptTemplate.id,
        legalReviewId: legalReview.id,
        reviewedBy: 'Compliance Owner',
        reviewedAt: new Date().toISOString(),
      });
      expect(basis.phoneE164).toBe('+14155550199');
      const attempt = await calls.createAttempt(tenantA, basis.id, {
        outcome: 'CONNECTED_FOLLOWUP',
        durationSeconds: 45,
        notesRef: 'Call with CFO +14155550199',
      });
      expect(attempt.notesRef).toBe('Call with CFO +14155550199');

      // 4. 直接查询底层 PG16 原始列：全部 6 表必须均为 enc:v2:k1 密文，绝无明文！
      const [rawDraft, rawSend, rawReply, rawUnsub, rawBasis, rawAttempt, rawMailbox] =
        await Promise.all([
          adminPrisma.outreachDraft.findFirstOrThrow({ where: { workspaceId: WS_A } }),
          adminPrisma.outreachSend.findFirstOrThrow({ where: { workspaceId: WS_A } }),
          adminPrisma.outreachReply.findFirstOrThrow({ where: { workspaceId: WS_A } }),
          adminPrisma.outreachUnsubscribeToken.findFirstOrThrow({ where: { workspaceId: WS_A } }),
          adminPrisma.outreachCallBasis.findFirstOrThrow({ where: { workspaceId: WS_A } }),
          adminPrisma.outreachCallAttempt.findFirstOrThrow({ where: { workspaceId: WS_A } }),
          adminPrisma.outreachMailbox.findFirstOrThrow({ where: { id: mb.id } }),
        ]);

      for (const [label, value] of [
        ['draft.recipientEmail', rawDraft.recipientEmail],
        ['send.recipientEmail', rawSend.recipientEmail],
        ['reply.recipientEmail', rawReply.recipientEmail],
        ['unsub.recipientEmail', rawUnsub.recipientEmail],
        ['callBasis.phoneE164', rawBasis.phoneE164],
        ['callAttempt.notesRef', rawAttempt.notesRef],
        ['mailbox.credentialsCiphertext', rawMailbox.credentialsCiphertext],
      ] as const) {
        expect(isEncryptedPii(value), `${label} should be enc:v2`).toBe(true);
        expect(extractPiiKeyId(value!), `${label} keyId`).toBe('k1');
        expect(value).not.toContain('ceo@us-buyer.example');
        expect(value).not.toContain('+14155550199');
        expect(value).not.toContain('tenant-a-smtp-secret');
      }

      // 5. 跨租户 AAD 校验：WS_B 绝不能解密 WS_A 的密文
      const ring = parsePiiKeyring(RING_K1)!;
      expect(() =>
        decryptPii(ring, WS_B, rawDraft.recipientEmail, OUTREACH_PII_PURPOSE.DRAFT_RECIPIENT_EMAIL),
      ).toThrow(/解密失败/);

      // 6. FORCE RLS 隔离：WS_B 查不到 WS_A 的 BYO 信箱与外联表；app_list_byo_imap_mailboxes 仅返回 ACTIVE+IMAP+凭据信箱
      expect(await mailboxes.listMailboxes(tenantB)).toEqual([]);
      const imapRows = await appPrisma.$queryRaw<Array<{ id: string; workspace_id: string }>>`
        SELECT id, workspace_id FROM public.app_list_byo_imap_mailboxes()
      `;
      expect(imapRows.some((r) => r.id === mb.id && r.workspace_id === WS_A)).toBe(true);
    }, 60_000);

    it('存量明文兼容读取 + 回填脚本幂等（dry-run -> --apply -> 零停机 --rotate k1->k2）', async () => {
      const contactLegacy = randomUUID();
      const legacyBatchId = randomUUID();
      await adminPrisma.outreachBatch.create({
        data: {
          id: legacyBatchId,
          workspaceId: WS_B,
          name: 'Legacy Plaintext Batch',
          status: 'DRAFT',
          createdBy: tenantB.userId,
        },
      });
      await adminPrisma.outreachDraft.create({
        data: {
          workspaceId: WS_B,
          batchId: legacyBatchId,
          contactRef: contactLegacy,
          recipientEmail: 'legacy-plain@buyer.example',
          countryCode: 'US',
          subject: 'Legacy',
          body: 'Plaintext row',
        },
      });
      await adminPrisma.outreachReply.create({
        data: {
          workspaceId: WS_B,
          contactRef: contactLegacy,
          recipientEmail: 'legacy-plain@buyer.example',
          kind: 'REPLY',
          classification: 'NEUTRAL',
        },
      });

      const cryptoK1 = new PiiCryptoService(makeConfig({ PII_KEYRING_JSON: RING_K1 }));
      const audit = new AuditService(appPrisma);
      const batches = new OutreachBatchService(
        appPrisma,
        audit,
        makeConfig({ PII_KEYRING_JSON: RING_K1 }),
        {} as never,
        cryptoK1,
      );

      // 迁移期未回填前，服务层依然无缝读取存量明文
      const loaded = await batches.getBatch(tenantB, legacyBatchId);
      expect(loaded.drafts[0]?.recipientEmail).toBe('legacy-plain@buyer.example');

      // dry-run 不改库
      const dryRun = await backfillOutreachPiiCrypto(appPrisma, cryptoK1, {
        apply: false,
        rotate: false,
        workspaceId: WS_B,
      });
      expect(dryRun.tables.find((t) => t.table === 'outreach_draft')?.encrypted).toBe(1);
      const stillPlain = await adminPrisma.outreachDraft.findFirstOrThrow({
        where: { batchId: legacyBatchId },
      });
      expect(stillPlain.recipientEmail).toBe('legacy-plain@buyer.example');

      // --apply 回填为 k1 密文
      const applied = await backfillOutreachPiiCrypto(appPrisma, cryptoK1, {
        apply: true,
        rotate: false,
        workspaceId: WS_B,
      });
      expect(applied.tables.find((t) => t.table === 'outreach_draft')?.encrypted).toBe(1);
      expect(applied.tables.find((t) => t.table === 'outreach_reply')?.encrypted).toBe(1);
      const nowEnc = await adminPrisma.outreachDraft.findFirstOrThrow({
        where: { batchId: legacyBatchId },
      });
      expect(extractPiiKeyId(nowEnc.recipientEmail)).toBe('k1');

      // 幂等重跑：0 加密 0 轮换
      const secondRun = await backfillOutreachPiiCrypto(appPrisma, cryptoK1, {
        apply: true,
        rotate: false,
        workspaceId: WS_B,
      });
      expect(secondRun.tables.find((t) => t.table === 'outreach_draft')?.encrypted).toBe(0);
      expect(secondRun.tables.find((t) => t.table === 'outreach_draft')?.skipped).toBe(1);

      // 切换到 k2 密钥环并执行 --rotate：无停机轮换到 k2，业务读取仍为明文
      const cryptoK2 = new PiiCryptoService(makeConfig({ PII_KEYRING_JSON: RING_K2 }));
      const rotated = await backfillOutreachPiiCrypto(appPrisma, cryptoK2, {
        apply: true,
        rotate: true,
        workspaceId: WS_B,
      });
      expect(rotated.tables.find((t) => t.table === 'outreach_draft')?.rotated).toBe(1);
      const afterRotate = await adminPrisma.outreachDraft.findFirstOrThrow({
        where: { batchId: legacyBatchId },
      });
      expect(extractPiiKeyId(afterRotate.recipientEmail)).toBe('k2');

      const batchesK2 = new OutreachBatchService(
        appPrisma,
        audit,
        makeConfig({ PII_KEYRING_JSON: RING_K2 }),
        {} as never,
        cryptoK2,
      );
      const loadedAfterRotate = await batchesK2.getBatch(tenantB, legacyBatchId);
      expect(loadedAfterRotate.drafts[0]?.recipientEmail).toBe('legacy-plain@buyer.example');
    }, 60_000);

    it('跨实例数据库行级发送租约锁：2 个独立 OutreachSendService 实例并发抢发同一批次，1 胜 1 拒（409），且过期僵尸锁可自动恢复', async () => {
      const config = makeConfig();
      const crypto = new PiiCryptoService(config);
      const audit = new AuditService(appPrisma);
      const signer = new CampaignTokenSigner(config);
      const issuer = new OutreachAuthorizationIssuer(appPrisma, signer, audit, config, crypto);
      const batches = new OutreachBatchService(appPrisma, audit, config, issuer, crypto);
      const mailboxes = new OutreachMailboxService(appPrisma, audit, config, crypto);
      const unsub = new OutreachUnsubscribeService(appPrisma, audit, crypto);

      const batch = await batches.createBatch(tenantA, { name: 'Concurrent Lock Race Batch' });
      await batches.addDraft(tenantA, batch.id, {
        contactRef: randomUUID(),
        recipientEmail: 'race@us-buyer.example',
        countryCode: 'US',
        companyName: 'Race Corp',
        subject: 'Race test',
        body: 'Ensure only one pod sends.',
      });
      await batches.quickConfirmBatch(tenantA, batch.id);

      let releaseSlowSend!: () => void;
      const enteredSlowSend = new Promise<void>((resolve) => {
        const waitGate = new Promise<void>((res) => {
          releaseSlowSend = res;
        });
        void waitGate;
        resolve();
      });
      void enteredSlowSend;

      let notifySendStarted!: () => void;
      const sendStarted = new Promise<void>((resolve) => {
        notifySendStarted = resolve;
      });
      let finishSend!: () => void;
      const allowSendFinish = new Promise<void>((resolve) => {
        finishSend = resolve;
      });

      const slowTransport: OutreachTransport = {
        ensureConfigured: vi.fn(),
        send: vi.fn(async () => {
          notifySendStarted();
          await allowSendFinish;
          return { messageId: `race-${randomUUID()}@tenant-a.example` };
        }),
      };

      const makeInstance = (t: OutreachTransport) =>
        new OutreachSendService(
          appPrisma,
          audit,
          new OutreachSendGate(config),
          t,
          { check: vi.fn(async () => new Map()) },
          { check: vi.fn(async () => new Map()) } as never,
          { enqueue: vi.fn(async () => undefined) } as never,
          unsub,
          config,
          new OutreachSendControls(appPrisma, config, crypto),
          new OutreachAuthorizationConsumer(appPrisma, config),
          mailboxes,
          new OutreachHealthService(appPrisma, audit, config),
          new OutreachExperimentsService(appPrisma, audit),
          crypto,
        );

      // 两个完全独立的 OutreachSendService 实例（模拟两台 API Pod）
      const pod1 = makeInstance(slowTransport);
      const pod2 = makeInstance({
        ensureConfigured: vi.fn(),
        send: vi.fn(async () => ({ messageId: 'should-never-send' })),
      });

      const firstPromise = pod1.sendBatch(tenantA, batch.id);
      await sendStarted;

      // Pod 2 并发调用必须被数据库行级锁拦截为 409 OUTREACH_BATCH_SEND_IN_PROGRESS
      const pod2Err = await pod2.sendBatch(tenantA, batch.id).catch((e: unknown) => e);
      expect((pod2Err as { response?: { error?: { code?: string } } })?.response?.error?.code).toBe(
        'OUTREACH_BATCH_SEND_IN_PROGRESS',
      );

      finishSend();
      const firstResult = await firstPromise;
      expect(firstResult.sent).toBe(1);

      // 发送结束后行级租约锁应已释放
      const afterLockRow = await adminPrisma.outreachBatch.findUniqueOrThrow({
        where: { id: batch.id },
      });
      expect(afterLockRow.sendLockToken).toBeNull();
      expect(afterLockRow.sendLockedUntil).toBeNull();

      // 僵尸租约自动恢复测试：人为写入已过期锁，随后新批次仍可被正常抢占并发送
      const batch2 = await batches.createBatch(tenantA, { name: 'Expired Lease Recovery Batch' });
      await batches.addDraft(tenantA, batch2.id, {
        contactRef: randomUUID(),
        recipientEmail: 'recover@us-buyer.example',
        countryCode: 'US',
        companyName: 'Recover Corp',
        subject: 'Recover',
        body: 'Recover after crash.',
      });
      await batches.quickConfirmBatch(tenantA, batch2.id);
      await adminPrisma.outreachBatch.update({
        where: { id: batch2.id },
        data: {
          sendLockToken: randomUUID(),
          sendLockedUntil: new Date(Date.now() - 60_000),
        },
      });
      const recovered = await makeInstance({
        ensureConfigured: vi.fn(),
        send: vi.fn(async () => ({ messageId: `rec-${randomUUID()}@tenant-a.example` })),
      }).sendBatch(tenantA, batch2.id);
      expect(recovered.sent).toBe(1);
    }, 60_000);
  },
);
