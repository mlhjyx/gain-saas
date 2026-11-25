import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { OpsExportThrottle } from './ops-export-throttle.js';
import { OpsService } from './ops.service.js';

const WS_ID = '22222222-2222-4222-8222-222222222222';
const WS_OTHER = '33333333-3333-4333-8333-333333333333';
const MEMBER_1 = '11111111-1111-4111-8111-111111111111';
const NON_MEMBER = '44444444-4444-4444-8444-444444444444';
const OPS_ACTOR = 'ops-actor-1';

function makeHarness(initialStatus: 'ACTIVE' | 'DISABLED' | 'ARCHIVED' = 'ACTIVE', memberIds: string[] = [MEMBER_1]) {
  const workspaceState = {
    id: WS_ID,
    name: 'Acme Export Co',
    status: initialStatus,
    statusUpdatedAt: new Date('2026-11-25T00:00:00Z'),
  };
  const registryState = { workspaceId: WS_ID, enabled: initialStatus === 'ACTIVE' };
  const sessions = [
    { jti: 's-ws-bound', realm: 'tenant', subjectType: 'user', subjectId: MEMBER_1, workspaceId: WS_ID, revokedAt: null as Date | null },
    { jti: 's-member-legacy', realm: 'tenant', subjectType: 'user', subjectId: MEMBER_1, workspaceId: null, revokedAt: null as Date | null },
    { jti: 's-member-other-ws', realm: 'tenant', subjectType: 'user', subjectId: MEMBER_1, workspaceId: WS_OTHER, revokedAt: null as Date | null },
    { jti: 's-outsider-legacy', realm: 'tenant', subjectType: 'user', subjectId: NON_MEMBER, workspaceId: null, revokedAt: null as Date | null },
    { jti: 's-ops', realm: 'ops', subjectType: 'ops_user', subjectId: OPS_ACTOR, workspaceId: null, revokedAt: null as Date | null },
  ];

  const tx = {
    workspace: {
      findUnique: vi.fn(async () => ({ id: workspaceState.id, name: workspaceState.name, status: workspaceState.status })),
      update: vi.fn(async ({ data }: { data: { status: 'ACTIVE' | 'DISABLED' | 'ARCHIVED'; statusUpdatedAt: Date } }) => {
        workspaceState.status = data.status;
        workspaceState.statusUpdatedAt = data.statusUpdatedAt;
        return { ...workspaceState };
      }),
    },
    workspaceRegistry: {
      updateMany: vi.fn(async ({ data }: { data: { enabled: boolean } }) => {
        registryState.enabled = data.enabled;
        return { count: 1 };
      }),
    },
    campaignExecutionAuthorization: {
      updateMany: vi.fn(async () => ({ count: 2 })),
    },
    membership: {
      findMany: vi.fn(async () => memberIds.map((userId) => ({ userId }))),
    },
    session: {
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: {
            realm: string;
            subjectType: string;
            revokedAt: null;
            OR: Array<{ workspaceId: string | null; subjectId?: { in: string[] } }>;
          };
          data: { revokedAt: Date };
        }) => {
          let count = 0;
          for (const row of sessions) {
            const matchesOr = where.OR.some((clause) => {
              if (clause.subjectId?.in) {
                return row.workspaceId === clause.workspaceId && clause.subjectId.in.includes(row.subjectId);
              }
              return row.workspaceId === clause.workspaceId;
            });
            if (row.realm === where.realm && row.subjectType === where.subjectType && row.revokedAt === null && matchesOr) {
              row.revokedAt = data.revokedAt;
              count += 1;
            }
          }
          return { count };
        },
      ),
    },
  };

  const prisma = {
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const service = new OpsService(
    { OPS_EXPORT_HOURLY_LIMIT: 10 } as AppConfig,
    {} as never,
    {} as never,
    audit as never,
    prisma as never,
    new OpsExportThrottle(10),
  );
  return { service, prisma, tx, audit, registryState, sessions };
}

describe('OpsService.setWorkspaceStatus', () => {
  it.each(['DISABLED', 'ARCHIVED'] as const)(
    '%s disables workspaceRegistry, revokes authorizations and tenant sessions (bound + member legacy null) inside $transaction, and audits revokedSessions',
    async (targetStatus) => {
      const { service, prisma, tx, audit, registryState, sessions } = makeHarness('ACTIVE');

      const result = await service.setWorkspaceStatus(WS_ID, targetStatus, OPS_ACTOR, 'incident freeze');

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        workspace: {
          id: WS_ID,
          name: 'Acme Export Co',
          status: targetStatus,
          statusUpdatedAt: expect.any(Date),
        },
      });
      expect(tx.workspaceRegistry.updateMany).toHaveBeenCalledWith({
        where: { workspaceId: WS_ID },
        data: { enabled: false },
      });
      expect(registryState.enabled).toBe(false);
      expect(tx.campaignExecutionAuthorization.updateMany).toHaveBeenCalledWith({
        where: { workspaceId: WS_ID, state: 'ISSUED' },
        data: { state: 'REVOKED', revokedAt: expect.any(Date), revokeReason: `WORKSPACE_${targetStatus}` },
      });
      expect(tx.membership.findMany).toHaveBeenCalledWith({
        where: { workspaceId: WS_ID, status: 'active' },
        select: { userId: true },
      });
      expect(sessions.find((s) => s.jti === 's-ws-bound')?.revokedAt).toBeInstanceOf(Date);
      expect(sessions.find((s) => s.jti === 's-member-legacy')?.revokedAt).toBeInstanceOf(Date);
      expect(sessions.find((s) => s.jti === 's-member-other-ws')?.revokedAt).toBeNull();
      expect(sessions.find((s) => s.jti === 's-outsider-legacy')?.revokedAt).toBeNull();
      expect(sessions.find((s) => s.jti === 's-ops')?.revokedAt).toBeNull();

      expect(audit.record).toHaveBeenCalledWith({
        realm: 'ops',
        actorId: OPS_ACTOR,
        workspaceId: WS_ID,
        action: 'workspace.status',
        target: 'Acme Export Co',
        detail: {
          before: { id: WS_ID, name: 'Acme Export Co', status: 'ACTIVE' },
          after: expect.objectContaining({ id: WS_ID, status: targetStatus }),
          revokedAuthorizations: 2,
          revokedSessions: 2,
        },
      });
    },
  );

  it('DISABLED with zero active members still revokes workspace-bound sessions without passing empty IN list', async () => {
    const { service, tx, sessions } = makeHarness('ACTIVE', []);

    await service.setWorkspaceStatus(WS_ID, 'DISABLED', OPS_ACTOR);

    expect(tx.session.updateMany).toHaveBeenCalledWith({
      where: {
        realm: 'tenant',
        subjectType: 'user',
        revokedAt: null,
        OR: [{ workspaceId: WS_ID }],
      },
      data: { revokedAt: expect.any(Date) },
    });
    expect(sessions.find((s) => s.jti === 's-ws-bound')?.revokedAt).toBeInstanceOf(Date);
    expect(sessions.find((s) => s.jti === 's-member-legacy')?.revokedAt).toBeNull();
  });

  it('ACTIVE re-enables workspaceRegistry.enabled=true without revoking sessions or authorizations', async () => {
    const { service, tx, audit, registryState, sessions } = makeHarness('DISABLED');

    const result = await service.setWorkspaceStatus(WS_ID, 'ACTIVE', OPS_ACTOR, 'restored');

    expect(result.workspace).toMatchObject({ id: WS_ID, status: 'ACTIVE' });
    expect(tx.workspaceRegistry.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: WS_ID },
      data: { enabled: true },
    });
    expect(registryState.enabled).toBe(true);
    expect(tx.campaignExecutionAuthorization.updateMany).not.toHaveBeenCalled();
    expect(tx.session.updateMany).not.toHaveBeenCalled();
    expect(sessions.every((s) => s.revokedAt === null)).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          revokedAuthorizations: 0,
          revokedSessions: 0,
        }),
      }),
    );
  });
});
