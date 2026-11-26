import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { OpsExportThrottle } from './ops-export-throttle.js';
import { OpsService } from './ops.service.js';

const WS_MATCH = '11111111-1111-4111-8111-111111111111';
const WS_MISMATCH = '22222222-2222-4222-8222-222222222222';
const WS_ONLY_SAAS = '33333333-3333-4333-8333-333333333333';
const WS_ONLY_ENGINE = '44444444-4444-4444-8444-444444444444';
const OPS_ACTOR = 'ops-actor-1';

function createOpsHarness(options: {
  hasOwnerPool?: boolean;
  engineWorkspaces?: Array<{ id: string; name: string; created_at: Date }>;
  saasWorkspaces?: Array<{
    id: string;
    name: string;
    status: string;
    onboardingCompletedAt: Date | null;
    onboardingCompanyId: string | null;
    createdAt: Date;
    updatedAt: Date;
    statusUpdatedAt: Date | null;
    statusUpdatedBy: string | null;
    statusNote: string | null;
  }>;
  memberCounts?: Map<string, bigint>;
  storageQuota?: { workspaceId: string; maxDocumentsPerWorkspace: number; maxDocumentsPerCompany: number; maxBytesPerWorkspace: bigint; maxExportsPerDay: number; updatedBy: string | null; updatedAt: Date } | null;
} = {}) {
  const saasList = options.saasWorkspaces ?? [
    {
      id: WS_MATCH,
      name: 'Matched Co',
      status: 'ACTIVE',
      onboardingCompletedAt: new Date('2026-11-01T00:00:00Z'),
      onboardingCompanyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt: new Date('2026-11-01T00:00:00Z'),
      updatedAt: new Date('2026-11-02T00:00:00Z'),
      statusUpdatedAt: null,
      statusUpdatedBy: null,
      statusNote: null,
    },
    {
      id: WS_MISMATCH,
      name: 'Renamed SaaS Name',
      status: 'ACTIVE',
      onboardingCompletedAt: new Date('2026-11-01T00:00:00Z'),
      onboardingCompanyId: null,
      createdAt: new Date('2026-11-01T00:00:00Z'),
      updatedAt: new Date('2026-11-02T00:00:00Z'),
      statusUpdatedAt: null,
      statusUpdatedBy: null,
      statusNote: null,
    },
    {
      id: WS_ONLY_SAAS,
      name: 'Lazy Unonboarded Co',
      status: 'ACTIVE',
      onboardingCompletedAt: null,
      onboardingCompanyId: null,
      createdAt: new Date('2026-11-05T00:00:00Z'),
      updatedAt: new Date('2026-11-05T00:00:00Z'),
      statusUpdatedAt: null,
      statusUpdatedBy: null,
      statusNote: null,
    },
  ];
  const engineList = options.engineWorkspaces ?? [
    { id: WS_MATCH, name: 'Matched Co', created_at: new Date('2026-11-01T00:00:00Z') },
    { id: WS_MISMATCH, name: 'Stale Engine Name', created_at: new Date('2026-11-01T00:00:00Z') },
    { id: WS_ONLY_ENGINE, name: 'Orphan Dev Wizard', created_at: new Date('2026-10-01T00:00:00Z') },
  ];

  const ownerQuery = vi.fn(async () => engineList);
  const withEngineWorkspace = vi.fn(async (wid: string, fn: (client: { query: (sql: string) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) =>
    fn({
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM workspace')) {
          const found = engineList.find((w) => w.id === wid);
          return { rows: found ? [found] : [] };
        }
        if (sql.includes('seller_document')) {
          return { rows: [{ total: '12', total_bytes: '40960', pending_upload: '1' }] };
        }
        if (sql.includes('company_profile')) {
          return { rows: [{ companies: '2', icps: '3', discovery_runs: '5', canonical_companies: '40', canonical_contacts: '15', leads: '18' }] };
        }
        return { rows: [] };
      }),
    }),
  );

  const db = {
    ownerPool: options.hasOwnerPool === false ? null : {},
    ownerQuery,
    query: vi.fn(async () => []),
    withWorkspace: withEngineWorkspace,
  };
  const database = { db, ready: vi.fn(async () => ({ ok: true, missing: [], checkedAt: '' })) };

  const storageUpsert = vi.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => ({
    workspaceId: WS_MATCH,
    maxDocumentsPerWorkspace: update.maxDocumentsPerWorkspace ?? create.maxDocumentsPerWorkspace,
    maxDocumentsPerCompany: update.maxDocumentsPerCompany ?? create.maxDocumentsPerCompany,
    maxBytesPerWorkspace: update.maxBytesPerWorkspace ?? create.maxBytesPerWorkspace,
    maxExportsPerDay: update.maxExportsPerDay ?? create.maxExportsPerDay,
    updatedBy: update.updatedBy ?? create.updatedBy,
    updatedAt: new Date('2026-11-26T00:00:00Z'),
  }));

  const tx = {
    workspace: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => saasList.find((w) => w.id === where.id) ?? null),
    },
    membership: {
      findMany: vi.fn(async () => [
        { userId: 'u-1', role: 'admin', status: 'active', createdAt: new Date('2026-11-01T00:00:00Z'), user: { email: 'admin@acme.example', status: 'active' } },
      ]),
    },
    workspaceRegistry: {
      findUnique: vi.fn(async () => ({ enabled: true, cursor: '42', lastPulledAt: new Date('2026-11-26T00:00:00Z') })),
    },
    workspaceStorageQuota: {
      findUnique: vi.fn(async () => options.storageQuota ?? null),
      upsert: storageUpsert,
    },
    campaign: { count: vi.fn(async () => 2) },
    qgo: { count: vi.fn(async () => 5) },
    sao: { count: vi.fn(async () => 2) },
    outreachBatch: { count: vi.fn(async () => 3) },
    outreachSend: { count: vi.fn(async () => 12) },
    deletionMirror: { count: vi.fn(async () => 1) },
  };

  const prisma = {
    workspace: {
      findMany: vi.fn(async () => saasList),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => saasList.find((w) => w.id === where.id) ?? null),
    },
    session: {
      count: vi.fn(async () => 2),
    },
    $queryRaw: vi.fn(async () =>
      saasList.map((w) => ({
        id: w.id,
        name: w.name,
        status: w.status,
        status_updated_at: w.statusUpdatedAt,
        status_note: w.statusNote,
        created_at: w.createdAt,
        member_count: options.memberCounts?.get(w.id) ?? 1n,
      })),
    ),
    withWorkspace: vi.fn(async (_wid: string, fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  const audit = { record: vi.fn(async () => undefined) };
  const service = new OpsService(
    {
      OPS_EXPORT_HOURLY_LIMIT: 10,
      WORKSPACE_QUOTA_WINDOW_DAYS: 30,
      WORKSPACE_QUOTA_MAX_RUNS: 30,
      WORKSPACE_QUOTA_MAX_SPEND_MICROS: 15_000_000,
    } as AppConfig,
    database as never,
    {} as never,
    audit as never,
    prisma as never,
    new OpsExportThrottle(10),
  );
  return { service, prisma, tx, db, audit, storageUpsert };
}

describe('OpsService MT-P1 workspace reconcile / detail / quota management', () => {
  it('reconcileWorkspaces reports onlyInSaas, onlyInEngine, nameMismatches, and matched counts when ownerPool is available', async () => {
    const { service } = createOpsHarness({ hasOwnerPool: true });
    const report = await service.reconcileWorkspaces();

    expect(report).toMatchObject({
      complete: true,
      summary: {
        saasTotal: 3,
        engineTotal: 3,
        matchedCount: 2,
        onlyInSaasCount: 1,
        onlyInEngineCount: 1,
        nameMismatchCount: 1,
      },
      onlyInSaas: [expect.objectContaining({ id: WS_ONLY_SAAS, name: 'Lazy Unonboarded Co' })],
      onlyInEngine: [expect.objectContaining({ id: WS_ONLY_ENGINE, name: 'Orphan Dev Wizard' })],
      nameMismatches: [
        expect.objectContaining({
          id: WS_MISMATCH,
          saasName: 'Renamed SaaS Name',
          engineName: 'Stale Engine Name',
        }),
      ],
    });
  });

  it('reconcileWorkspaces degrades gracefully without ownerPool (checks known SaaS workspaces via RLS, flags complete=false)', async () => {
    const { service } = createOpsHarness({ hasOwnerPool: false });
    const report = await service.reconcileWorkspaces();

    expect(report.complete).toBe(false);
    expect(report.onlyInSaas).toHaveLength(1);
    expect(report.nameMismatches).toHaveLength(1);
    expect(report.onlyInEngine).toEqual([]);
  });

  it('workspaceDetail aggregates SaaS metadata, members, active sessions, storage quota, and engine RLS usage', async () => {
    const { service } = createOpsHarness();
    const detail = await service.workspaceDetail(WS_MATCH);

    expect(detail).toMatchObject({
      workspace: expect.objectContaining({ id: WS_MATCH, name: 'Matched Co', status: 'ACTIVE' }),
      members: [expect.objectContaining({ userId: 'u-1', email: 'admin@acme.example', role: 'admin' })],
      activeSessions: 2,
      registry: expect.objectContaining({ enabled: true, cursor: '42' }),
      storageQuota: expect.objectContaining({
        maxDocumentsPerWorkspace: 500,
        maxDocumentsPerCompany: 200,
        maxBytesPerWorkspace: '2147483648',
        maxExportsPerDay: 10,
        isDefault: true,
      }),
      saasCounts: {
        campaigns: 2,
        qgos: 5,
        saos: 2,
        outreachBatches: 3,
        outreachSends30d: 12,
        deletionMirrors: 1,
      },
      engine: expect.objectContaining({
        exists: true,
        name: 'Matched Co',
        sellerDocuments: { total: 12, totalBytes: 40960, pendingUpload: 1 },
      }),
    });

    await expect(service.workspaceDetail('bad-id')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.workspaceDetail(WS_ONLY_ENGINE)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getWorkspaceStorageQuota and updateWorkspaceStorageQuota validate bounds, upsert via withWorkspace, serialize BigInt safely, and audit', async () => {
    const { service, storageUpsert, audit } = createOpsHarness();

    const current = await service.getWorkspaceStorageQuota(WS_MATCH);
    expect(current).toMatchObject({
      workspaceId: WS_MATCH,
      maxDocumentsPerWorkspace: 500,
      maxDocumentsPerCompany: 200,
      maxBytesPerWorkspace: '2147483648',
      maxExportsPerDay: 10,
      isDefault: true,
      usage: { totalDocuments: 12, totalBytes: 40960, pendingUpload: 1 },
    });

    await expect(
      service.updateWorkspaceStorageQuota(
        WS_MATCH,
        { maxDocumentsPerWorkspace: 0, maxDocumentsPerCompany: 10, maxBytesPerWorkspace: '1024', maxExportsPerDay: 5 },
        OPS_ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    const updated = await service.updateWorkspaceStorageQuota(
      WS_MATCH,
      {
        maxDocumentsPerWorkspace: 1000,
        maxDocumentsPerCompany: 300,
        maxBytesPerWorkspace: '5368709120',
        maxExportsPerDay: 25,
      },
      OPS_ACTOR,
    );

    expect(storageUpsert).toHaveBeenCalled();
    expect(updated).toMatchObject({
      workspaceId: WS_MATCH,
      maxDocumentsPerWorkspace: 1000,
      maxDocumentsPerCompany: 300,
      maxBytesPerWorkspace: '5368709120',
      maxExportsPerDay: 25,
      isDefault: false,
    });
    expect(() => JSON.stringify(updated)).not.toThrow();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        realm: 'ops',
        actorId: OPS_ACTOR,
        workspaceId: WS_MATCH,
        action: 'workspace.storage-quota.update',
      }),
    );
  });
});
