import {
  BadRequestException,
  ConflictException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { AuditService } from '../shared/audit.service.js';
import type { PrismaService } from '../shared/prisma.service.js';
import { OpsWorkspacePurgeService } from './ops-workspace-purge.service.js';

const WS_ID = '33333333-3333-4333-8333-333333333333';
const OPS_ACTOR = '55555555-5555-4555-8555-555555555555';
const OFFBOARD_ID = '66666666-6666-4666-8666-666666666666';
const JOB_1 = '77777777-7777-4777-8777-777777777777';
const ENGINE_RECEIPT_ID = '88888888-8888-4888-8888-888888888888';

function makeTx(options: {
  workspaceExists?: boolean;
  offboarding?: { id: string; status: string; coolOffEndsAt: Date } | null;
  existingReceipt?: Record<string, unknown> | null;
} = {}) {
  const del = () => ({ deleteMany: vi.fn(async () => ({ count: 1 })) });
  let createdReceipt: Record<string, unknown> | null = options.existingReceipt ?? null;
  return {
    $executeRaw: vi.fn(async () => 0),
    workspace: {
      findUnique: vi.fn(async () =>
        options.workspaceExists === false ? null : { id: WS_ID, name: 'Acme Co', status: 'ACTIVE' },
      ),
      update: vi.fn(async () => ({ id: WS_ID, name: 'PURGED', status: 'ARCHIVED' })),
    },
    workspaceRegistry: {
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    workspaceOffboardingRequest: {
      findFirst: vi.fn(async () => options.offboarding ?? null),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: OFFBOARD_ID, ...data })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    workspacePurgeReceipt: {
      findFirst: vi.fn(async () => options.existingReceipt ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        createdReceipt = {
          id: '99999999-9999-4999-8999-999999999999',
          startedAt: new Date('2026-12-04T00:00:00Z'),
          completedAt: null,
          ...data,
        };
        return createdReceipt;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        createdReceipt = {
          id: '99999999-9999-4999-8999-999999999999',
          workspaceId: WS_ID,
          idempotencyKey: 'purge-k1',
          requestedBy: OPS_ACTOR,
          offboardingRequestId: OFFBOARD_ID,
          forced: false,
          revokedSessions: 0,
          deletedCounts: {},
          enginePurgeReceiptId: null,
          enginePurgeStatus: null,
          errorCode: null,
          startedAt: new Date('2026-12-04T00:00:00Z'),
          completedAt: null,
          ...createdReceipt,
          ...data,
        };
        return createdReceipt;
      }),
    },
    campaignPlanJob: {
      findMany: vi.fn(async () => [{ id: JOB_1 }]),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    membership: {
      findMany: vi.fn(async () => [{ userId: 'u-1' }]),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    session: {
      updateMany: vi.fn(async () => ({ count: 2 })),
      deleteMany: vi.fn(async () => ({ count: 2 })),
    },
    auditLog: {
      updateMany: vi.fn(async () => ({ count: 3 })),
    },
    walletAccount: {
      findUnique: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
    },
    walletHold: {
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
    },
    walletCreditLot: {
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    walletLedger: {
      create: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    outreachSendJob: del(),
    outreachSend: del(),
    outreachBounceWriteback: del(),
    outreachDraft: del(),
    outreachBatchApproval: del(),
    outreachBatchEvent: del(),
    outreachAuditPackage: del(),
    outreachBatch: del(),
    outreachReply: del(),
    outreachUnsubscribeToken: del(),
    outreachConsent: del(),
    outreachCallAttempt: del(),
    outreachCallBasis: del(),
    outreachExperimentAssignment: del(),
    outreachExperiment: del(),
    outreachMetricSnapshot: del(),
    outreachHealthEvent: del(),
    outreachBreaker: del(),
    outreachSeedTest: del(),
    outreachMailboxCounter: del(),
    outreachMailbox: del(),
    outreachDomainCounter: del(),
    outreachDomain: del(),
    outreachTemplateVersion: del(),
    legalReview: del(),
    opportunityOutcome: del(),
    sao: del(),
    qgo: del(),
    campaignApproval: del(),
    campaignAudience: del(),
    campaignDecisionTrace: del(),
    campaignExecutionAuthorization: del(),
    campaignRevision: del(),
    campaign: del(),
    taskRun: del(),
    acquisitionTask: del(),
    discoveryRunLink: del(),
    qualifiedLead: del(),
    eventInbox: del(),
    notification: del(),
    feedbackSubmission: del(),
    idempotencyRecord: del(),
    deletionMirror: del(),
    costLedger: del(),
    workspaceComplianceDeclaration: del(),
    workspaceBudgetPolicy: del(),
    workspaceStorageQuota: del(),
    invitation: del(),
  };
}

function makeService(options: {
  token?: string;
  txOptions?: Parameters<typeof makeTx>[0];
} = {}) {
  const tx = makeTx(options.txOptions);
  const prisma = {
    withWorkspace: vi.fn(async (_wid: string, fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  const config = {
    ENGINE_ORIGIN: 'http://engine.test',
    WORKSPACE_PURGE_INTERNAL_SERVICE_TOKEN: options.token,
  } as AppConfig;
  const service = new OpsWorkspacePurgeService(config, prisma, audit);
  return { service, tx, audit };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpsWorkspacePurgeService (POST /api/ops/workspaces/:id/purge)', () => {
  it('fails closed with 503 when WORKSPACE_PURGE_INTERNAL_SERVICE_TOKEN is not configured', async () => {
    const { service } = makeService({ token: undefined });
    await expect(service.purgeWorkspace(WS_ID, {}, OPS_ACTOR)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('rejects purge while 7-day cooling-off period is active unless force=true is explicitly passed', async () => {
    const { service } = makeService({
      token: 'purge-secret-token-123456',
      txOptions: {
        offboarding: {
          id: OFFBOARD_ID,
          status: 'SCHEDULED',
          coolOffEndsAt: new Date('2026-12-10T00:00:00Z'),
        },
      },
    });
    await expect(
      service.purgeWorkspace(WS_ID, {}, OPS_ACTOR, new Date('2026-12-01T00:00:00Z')),
    ).rejects.toBeInstanceOf(ConflictException);

    // Non-boolean force rejected strictly
    await expect(
      service.purgeWorkspace(WS_ID, { force: 'yes' }, OPS_ACTOR, new Date('2026-12-01T00:00:00Z')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('executes full purge after cooling-off: revokes sessions, disables registry, wipes gain_saas tables, invokes engine purge, and writes non-PII receipt', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: { id: ENGINE_RECEIPT_ID, workspaceId: WS_ID, status: 'PENDING' },
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { service, tx, audit } = makeService({
      token: 'purge-secret-token-123456',
      txOptions: {
        offboarding: {
          id: OFFBOARD_ID,
          status: 'SCHEDULED',
          coolOffEndsAt: new Date('2026-12-03T00:00:00Z'),
        },
      },
    });

    const receipt = await service.purgeWorkspace(
      WS_ID,
      { idempotencyKey: 'purge-k1' },
      OPS_ACTOR,
      new Date('2026-12-04T00:00:00Z'),
    );

    expect(tx.workspace.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: WS_ID },
        data: expect.objectContaining({ status: 'ARCHIVED', name: 'PURGED', onboardingCompanyId: null }),
      }),
    );
    expect(tx.workspaceRegistry.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: WS_ID },
      data: { enabled: false, cursor: null },
    });
    expect(tx.session.updateMany).toHaveBeenCalled();
    expect(tx.outreachDraft.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: WS_ID } });
    expect(tx.qgo.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: WS_ID } });
    expect(tx.membership.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: WS_ID } });
    expect(tx.auditLog.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: WS_ID, realm: 'tenant' },
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    expect(String(url)).toBe(`http://engine.test/api/v1/internal/workspaces/${WS_ID}/purge`);
    expect((init.headers as Record<string, string>)['x-service-token']).toBe('purge-secret-token-123456');
    expect(JSON.parse(String(init.body))).toEqual({
      idempotencyKey: 'purge-k1',
      requestedBy: OPS_ACTOR,
      campaignPlanJobIds: [JOB_1],
    });

    expect(receipt).toMatchObject({
      workspaceId: WS_ID,
      status: 'COMPLETED',
      enginePurgeReceiptId: ENGINE_RECEIPT_ID,
      enginePurgeStatus: 'PENDING',
      revokedSessions: 2,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ realm: 'ops', action: 'workspace.purge', workspaceId: WS_ID }),
    );
  });

  it('marks receipt FAILED and throws 502 if engine purge returns upstream error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { code: 'TEMPORAL_UNAVAILABLE' } }), { status: 503 })),
    );
    const { service, tx } = makeService({
      token: 'purge-secret-token-123456',
      txOptions: {
        offboarding: {
          id: OFFBOARD_ID,
          status: 'SCHEDULED',
          coolOffEndsAt: new Date('2026-12-03T00:00:00Z'),
        },
      },
    });

    const err = await service
      .purgeWorkspace(WS_ID, { idempotencyKey: 'purge-k2' }, OPS_ACTOR, new Date('2026-12-04T00:00:00Z'))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(502);
    expect(tx.workspacePurgeReceipt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED', errorCode: 'TEMPORAL_UNAVAILABLE' }),
      }),
    );
  });

  it('allows force=true to bypass cooling-off, replays COMPLETED receipt idempotently, and refreshes engine status in getPurgeReceipt', async () => {
    const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      if (init?.method === 'GET') {
        return new Response(JSON.stringify({ data: { id: ENGINE_RECEIPT_ID, status: 'COMPLETED' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ data: { id: ENGINE_RECEIPT_ID, status: 'PENDING' } }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const forceH = makeService({
      token: 'purge-secret-token-123456',
      txOptions: {
        offboarding: {
          id: OFFBOARD_ID,
          status: 'SCHEDULED',
          coolOffEndsAt: new Date('2026-12-10T00:00:00Z'),
        },
      },
    });
    const forcedReceipt = await forceH.service.purgeWorkspace(
      WS_ID,
      { idempotencyKey: 'force-k1', force: true },
      OPS_ACTOR,
      new Date('2026-12-01T00:00:00Z'),
    );
    expect(forcedReceipt).toMatchObject({ status: 'COMPLETED', forced: true });
    expect(forceH.tx.workspaceOffboardingRequest.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: WS_ID },
      data: { reason: null },
    });

    // Replay on COMPLETED receipt does not call engine POST again
    fetchMock.mockClear();
    const replayH = makeService({
      token: 'purge-secret-token-123456',
      txOptions: {
        existingReceipt: {
          id: '99999999-9999-4999-8999-999999999999',
          workspaceId: WS_ID,
          idempotencyKey: 'force-k1',
          status: 'COMPLETED',
          requestedBy: OPS_ACTOR,
          offboardingRequestId: OFFBOARD_ID,
          forced: true,
          revokedSessions: 2,
          deletedCounts: { membership: 1 },
          enginePurgeReceiptId: ENGINE_RECEIPT_ID,
          enginePurgeStatus: 'PENDING',
          errorCode: null,
          startedAt: new Date('2026-12-01T00:00:00Z'),
          completedAt: new Date('2026-12-01T00:00:05Z'),
        },
      },
    });
    const replayed = await replayH.service.purgeWorkspace(WS_ID, { idempotencyKey: 'force-k1' }, OPS_ACTOR);
    expect(replayed.status).toBe('COMPLETED');
    expect(fetchMock).not.toHaveBeenCalled();

    const refreshed = await replayH.service.getPurgeReceipt(WS_ID);
    expect(refreshed?.enginePurgeStatus).toBe('COMPLETED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects idempotencyKey containing ASCII control characters with 400 BEFORE touching DB, and translates P2002 to 409', async () => {
    const h = makeService({ token: 'purge-secret-token-123456' });
    await expect(
      h.service.purgeWorkspace(WS_ID, { idempotencyKey: 'bad\nkey' }, OPS_ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      h.service.purgeWorkspace(WS_ID, { idempotencyKey: '\tbad-key' }, OPS_ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.tx.workspace.update).not.toHaveBeenCalled();

    const p2002H = makeService({
      token: 'purge-secret-token-123456',
      txOptions: {
        offboarding: {
          id: OFFBOARD_ID,
          status: 'SCHEDULED',
          coolOffEndsAt: new Date('2026-12-03T00:00:00Z'),
        },
      },
    });
    p2002H.tx.workspacePurgeReceipt.create.mockRejectedValueOnce(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    );
    await expect(
      p2002H.service.purgeWorkspace(WS_ID, { idempotencyKey: 'race-k1' }, OPS_ACTOR, new Date('2026-12-04T00:00:00Z')),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(p2002H.tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('allows FAILED receipt retry with same idempotencyKey (force=false), preserves campaignPlanJobIds and original deletion/session counts', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: { id: ENGINE_RECEIPT_ID, status: 'PENDING' } }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const retryH = makeService({
      token: 'purge-secret-token-123456',
      txOptions: {
        offboarding: null,
        existingReceipt: {
          id: '99999999-9999-4999-8999-999999999999',
          workspaceId: WS_ID,
          idempotencyKey: 'retry-k1',
          status: 'FAILED',
          requestedBy: OPS_ACTOR,
          offboardingRequestId: OFFBOARD_ID,
          forced: false,
          revokedSessions: 2,
          deletedCounts: { session: 2, outreach_draft: 5, campaign_plan_job: 1 },
          campaignPlanJobIds: [JOB_1],
          enginePurgeReceiptId: null,
          enginePurgeStatus: null,
          errorCode: 'TEMPORAL_UNAVAILABLE',
          startedAt: new Date('2026-12-04T00:00:00Z'),
          completedAt: null,
        },
      },
    });
    // Subsequent local deletes return 0 since first attempt already wiped gain_saas tables
    retryH.tx.campaignPlanJob.findMany.mockResolvedValueOnce([]);
    retryH.tx.session.updateMany.mockResolvedValueOnce({ count: 0 });
    retryH.tx.session.deleteMany.mockResolvedValueOnce({ count: 0 });
    retryH.tx.outreachDraft.deleteMany.mockResolvedValueOnce({ count: 0 });
    retryH.tx.campaignPlanJob.deleteMany.mockResolvedValueOnce({ count: 0 });

    const completed = await retryH.service.purgeWorkspace(
      WS_ID,
      { idempotencyKey: 'retry-k1' },
      OPS_ACTOR,
      new Date('2026-12-04T00:05:00Z'),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      idempotencyKey: 'retry-k1',
      requestedBy: OPS_ACTOR,
      campaignPlanJobIds: [JOB_1],
    });
    expect(completed).toMatchObject({
      status: 'COMPLETED',
      revokedSessions: 2,
      offboardingRequestId: OFFBOARD_ID,
      enginePurgeReceiptId: ENGINE_RECEIPT_ID,
    });
    expect(completed.deletedCounts.outreach_draft).toBe(5);
    expect(completed.deletedCounts.campaign_plan_job).toBe(1);
    expect(retryH.tx.workspaceOffboardingRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: OFFBOARD_ID },
        data: expect.objectContaining({ status: 'PURGED' }),
      }),
    );
  });
});
