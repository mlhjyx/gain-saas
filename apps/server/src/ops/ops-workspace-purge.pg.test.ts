import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import { WorkspaceOffboardingService } from '../tenant/workspace-offboarding.service.js';
import {
  dockerAvailable,
  startDisposablePostgres,
  type DisposablePostgres,
} from './attribution-test-pg.js';
import { OpsWorkspacePurgeService } from './ops-workspace-purge.service.js';

const available = dockerAvailable();

describe.skipIf(!available)('Workspace offboarding & purge PG16 FORCE RLS end-to-end', () => {
  let pg: DisposablePostgres;
  let adminPrisma: PrismaClient;
  let appPrisma: PrismaService;

  const WS_A = randomUUID();
  const WS_B = randomUUID();

  beforeAll(async () => {
    pg = startDisposablePostgres();
    adminPrisma = new PrismaClient({ datasourceUrl: pg.databaseUrl });
    appPrisma = new PrismaService({ datasourceUrl: pg.appDatabaseUrl, enforcePrincipal: true });
    await appPrisma.verifyPrincipal();
  }, 900_000);

  afterAll(async () => {
    await appPrisma?.onModuleDestroy().catch(() => undefined);
    await adminPrisma?.$disconnect().catch(() => undefined);
    pg?.stop();
  }, 120_000);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('schedules 7-day offboarding, purges WS_A completely via gain_saas_app + engine callback, writes non-PII receipt, and keeps WS_B intact', async () => {
    const userA = randomUUID();
    const userB = randomUUID();
    const opsActor = randomUUID();
    const engineReceiptId = randomUUID();

    await adminPrisma.user.createMany({
      data: [
        { id: userA, email: 'admin-a@purge-test.example', passwordHash: 'hash' },
        { id: userB, email: 'admin-b@purge-test.example', passwordHash: 'hash' },
      ],
    });
    await adminPrisma.workspace.createMany({
      data: [
        { id: WS_A, name: 'Purge Target GmbH', onboardingCompletedAt: new Date() },
        { id: WS_B, name: 'Keep Intact AG', onboardingCompletedAt: new Date() },
      ],
    });
    await adminPrisma.membership.createMany({
      data: [
        { userId: userA, workspaceId: WS_A, role: 'admin', status: 'active' },
        { userId: userB, workspaceId: WS_B, role: 'admin', status: 'active' },
      ],
    });
    await adminPrisma.workspaceRegistry.createMany({
      data: [
        { workspaceId: WS_A, enabled: true, cursor: '10' },
        { workspaceId: WS_B, enabled: true, cursor: '20' },
      ],
    });
    await adminPrisma.session.createMany({
      data: [
        {
          jti: `jti-a-${randomUUID()}`,
          realm: 'tenant',
          subjectType: 'user',
          subjectId: userA,
          workspaceId: WS_A,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
        {
          jti: `jti-b-${randomUUID()}`,
          realm: 'tenant',
          subjectType: 'user',
          subjectId: userB,
          workspaceId: WS_B,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      ],
    });

    for (const [wsId, uid, email] of [
      [WS_A, userA, 'pii-a@target.example'],
      [WS_B, userB, 'pii-b@keep.example'],
    ] as const) {
      const batch = await adminPrisma.outreachBatch.create({
        data: { workspaceId: wsId, name: 'Batch', createdBy: uid },
      });
      await adminPrisma.outreachDraft.create({
        data: {
          workspaceId: wsId,
          batchId: batch.id,
          contactRef: randomUUID(),
          recipientEmail: email,
          subject: `Subject ${email}`,
          body: `Body ${email}`,
        },
      });
      const campaign = await adminPrisma.campaign.create({
        data: {
          workspaceId: wsId,
          name: 'Purge Campaign',
          objective: 'Test',
          createdBy: uid,
          updatedBy: uid,
        },
      });
      await adminPrisma.campaignPlanJob.create({
        data: {
          workspaceId: wsId,
          campaignId: campaign.id,
          objective: 'Test plan',
          createdBy: uid,
        },
      });
      await adminPrisma.qgo.create({
        data: {
          workspaceId: wsId,
          leadRef: randomUUID(),
          canonicalCompanyRef: randomUUID(),
          title: 'QGO',
          evidence: [{ kind: 'fit', verdict: 'match' }],
          nextStep: 'Follow up',
          createdBy: uid,
        },
      });
      await adminPrisma.auditLog.create({
        data: {
          realm: 'tenant',
          actorId: uid,
          workspaceId: wsId,
          action: 'test.pii',
          detail: { email },
        },
      });
      await adminPrisma.walletAccount.create({
        data: {
          workspaceId: wsId,
          availableCredits: 80n,
          heldCredits: 20n,
          lifetimeToppedUp: 100n,
        },
      });
      const lot = await adminPrisma.walletCreditLot.create({
        data: {
          workspaceId: wsId,
          sourceType: 'TOPUP_PAID',
          initialCredits: 100n,
          remainingCredits: 100n,
          unitPriceMicros: 10_000n,
          priority: 10,
          externalOrderId: `ord-${wsId}`,
          note: `payer ${email}`,
        },
      });
      const hold = await adminPrisma.walletHold.create({
        data: {
          workspaceId: wsId,
          idempotencyKey: `hold-${wsId}`,
          actionCode: 'DISCOVERY_QUALIFIED_LEAD',
          refType: 'discovery_run',
          refId: randomUUID(),
          heldCredits: 20n,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      await adminPrisma.walletLedger.create({
        data: {
          workspaceId: wsId,
          idempotencyKey: `topup-ord-${wsId}`,
          entryType: 'TOPUP',
          deltaAvailable: 100n,
          deltaHeld: 0n,
          balanceAvailable: 100n,
          balanceHeld: 0n,
          lotId: lot.id,
          holdId: hold.id,
          note: `ledger note ${email}`,
        },
      });
    }

    const audit = new AuditService(appPrisma);
    const config = {
      ENGINE_ORIGIN: 'http://engine.test',
      WORKSPACE_OFFBOARDING_COOL_OFF_DAYS: 7,
      WORKSPACE_PURGE_INTERNAL_SERVICE_TOKEN: 'pg-test-purge-token-123456',
    } as AppConfig;
    const offboarding = new WorkspaceOffboardingService(appPrisma, audit, config);
    const purgeService = new OpsWorkspacePurgeService(config, appPrisma, audit);

    const requestTime = new Date('2026-11-26T00:00:00.000Z');
    const scheduled = await offboarding.requestOffboarding(
      { userId: userA, workspaceId: WS_A, role: 'admin' },
      WS_A,
      { confirmName: 'Purge Target GmbH', reason: 'Offboarding test' },
      requestTime,
    );
    expect(scheduled.status).toBe('SCHEDULED');

    // Cross-tenant RLS check on workspace_offboarding_request: WS_B cannot see WS_A's request
    expect(
      await appPrisma.withWorkspace(WS_B, (tx) => tx.workspaceOffboardingRequest.findMany()),
    ).toEqual([]);

    const wsAPlanJobs = await adminPrisma.campaignPlanJob.findMany({
      where: { workspaceId: WS_A },
      select: { id: true },
    });
    expect(wsAPlanJobs).toHaveLength(1);
    const expectedJobId = wsAPlanJobs[0]!.id;

    // 1st attempt: engine returns 503 -> receipt marked FAILED, throws 502
    let engineCallCount = 0;
    const engineBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL | string, init?: RequestInit) => {
        engineCallCount += 1;
        if (init?.body) {
          engineBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        }
        if (engineCallCount === 1) {
          return new Response(JSON.stringify({ error: { code: 'TEMPORAL_UNAVAILABLE' } }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            data: { id: engineReceiptId, workspaceId: WS_A, status: 'PENDING' },
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const afterCoolOff = new Date('2026-12-04T00:00:00.000Z');
    const purgeKey = `purge-${WS_A}`;
    const firstErr = await purgeService
      .purgeWorkspace(WS_A, { idempotencyKey: purgeKey }, opsActor, afterCoolOff)
      .catch((e: unknown) => e);
    expect((firstErr as { getStatus?: () => number })?.getStatus?.()).toBe(502);

    const failedReceipt = await purgeService.getPurgeReceipt(WS_A);
    expect(failedReceipt).toMatchObject({
      workspaceId: WS_A,
      status: 'FAILED',
      errorCode: 'TEMPORAL_UNAVAILABLE',
      revokedSessions: 1,
    });
    expect(failedReceipt?.deletedCounts.outreach_draft).toBe(1);
    expect(failedReceipt?.deletedCounts.campaign_plan_job).toBe(1);

    // 2nd attempt: retry with SAME idempotencyKey and force=false succeeds, sends original campaignPlanJobIds, preserves counts
    const receipt = await purgeService.purgeWorkspace(
      WS_A,
      { idempotencyKey: purgeKey },
      opsActor,
      new Date('2026-12-04T00:05:00.000Z'),
    );
    expect(engineCallCount).toBe(2);
    expect(engineBodies[1]).toMatchObject({
      idempotencyKey: purgeKey,
      requestedBy: opsActor,
      campaignPlanJobIds: [expectedJobId],
    });
    expect(receipt).toMatchObject({
      workspaceId: WS_A,
      status: 'COMPLETED',
      revokedSessions: 1,
      enginePurgeReceiptId: engineReceiptId,
    });
    expect(receipt.deletedCounts.outreach_draft).toBe(1);
    expect(receipt.deletedCounts.campaign_plan_job).toBe(1);
    const offboardingRowA = await adminPrisma.workspaceOffboardingRequest.findUnique({
      where: { id: scheduled.id },
    });
    expect(offboardingRowA).toMatchObject({ status: 'PURGED', reason: null });
    // Receipt JSON contains zero PII
    expect(JSON.stringify(receipt)).not.toContain('pii-a@target.example');
    expect(JSON.stringify(receipt)).not.toContain('admin-a@purge-test.example');

    // Cross-tenant RLS on workspace_purge_receipt: WS_B cannot see WS_A's receipt
    expect(
      await appPrisma.withWorkspace(WS_B, (tx) => tx.workspacePurgeReceipt.findMany()),
    ).toEqual([]);
    // Idempotent replay with same idempotencyKey returns completed receipt without calling engine again
    const replay = await purgeService.purgeWorkspace(
      WS_A,
      { idempotencyKey: purgeKey },
      opsActor,
      afterCoolOff,
    );
    expect(replay.id).toBe(receipt.id);
    expect(replay.status).toBe('COMPLETED');
    expect(engineCallCount).toBe(2);

    // WS_A wiped, registry disabled, workspace archived & anonymized, sessions revoked
    const wsARow = await adminPrisma.workspace.findUnique({ where: { id: WS_A } });
    expect(wsARow).toMatchObject({ status: 'ARCHIVED', name: 'PURGED', onboardingCompanyId: null });
    const regA = await adminPrisma.workspaceRegistry.findUnique({ where: { workspaceId: WS_A } });
    expect(regA).toMatchObject({ enabled: false, cursor: null });
    expect(await adminPrisma.session.count({ where: { workspaceId: WS_A, revokedAt: null } })).toBe(0);
    expect(await adminPrisma.membership.count({ where: { workspaceId: WS_A } })).toBe(0);
    expect(await adminPrisma.outreachDraft.count({ where: { workspaceId: WS_A } })).toBe(0);
    expect(await adminPrisma.qgo.count({ where: { workspaceId: WS_A } })).toBe(0);
    const tenantAuditA = await adminPrisma.auditLog.findMany({ where: { workspaceId: WS_A, realm: 'tenant' } });
    expect(JSON.stringify(tenantAuditA)).not.toContain('pii-a@target.example');

    // WS_A wallet frozen, open holds released, free-text notes redacted, non-PII ledger figures preserved
    const walletA = await adminPrisma.walletAccount.findUnique({ where: { workspaceId: WS_A } });
    expect(walletA).toMatchObject({ status: 'FROZEN', availableCredits: 100n, heldCredits: 0n });
    expect(await adminPrisma.walletHold.count({ where: { workspaceId: WS_A, status: 'HELD' } })).toBe(0);
    const lotsA = await adminPrisma.walletCreditLot.findMany({ where: { workspaceId: WS_A } });
    expect(lotsA.every((l) => l.note === null)).toBe(true);
    const ledgersA = await adminPrisma.walletLedger.findMany({ where: { workspaceId: WS_A } });
    expect(ledgersA.length).toBeGreaterThanOrEqual(2);
    expect(ledgersA.every((l) => l.note === null)).toBe(true);
    const bigIntReplacer = (_key: string, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value;
    expect(JSON.stringify(lotsA, bigIntReplacer)).not.toContain('pii-a@target.example');
    expect(JSON.stringify(ledgersA, bigIntReplacer)).not.toContain('pii-a@target.example');

    // WS_B untouched
    const wsBRow = await adminPrisma.workspace.findUnique({ where: { id: WS_B } });
    expect(wsBRow).toMatchObject({ status: 'ACTIVE', name: 'Keep Intact AG' });
    const walletB = await adminPrisma.walletAccount.findUnique({ where: { workspaceId: WS_B } });
    expect(walletB).toMatchObject({ status: 'ACTIVE', availableCredits: 80n, heldCredits: 20n });
    expect(await adminPrisma.session.count({ where: { workspaceId: WS_B, revokedAt: null } })).toBe(1);
    expect(await adminPrisma.membership.count({ where: { workspaceId: WS_B } })).toBe(1);
    expect(await adminPrisma.outreachDraft.count({ where: { workspaceId: WS_B } })).toBe(1);
    expect(await adminPrisma.qgo.count({ where: { workspaceId: WS_B } })).toBe(1);
  }, 120_000);
});
