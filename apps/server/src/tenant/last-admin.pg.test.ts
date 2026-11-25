import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { Request, Response } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import {
  dockerAvailable,
  startDisposablePostgres,
  type DisposablePostgres,
} from '../ops/attribution-test-pg.js';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import type { AuthService } from './auth.service.js';
import { MembersController } from './members.controller.js';
import { SessionService } from './session.service.js';
import { WorkspacesController } from './workspaces.controller.js';

const available = dockerAvailable();
if (!available) {
  if (process.env.CI === 'true') {
    throw new Error('[last-admin.pg] CI requires docker for PG16 LAST_ADMIN concurrency tests');
  }
  console.warn('[last-admin.pg] docker unavailable, skipping PG16 LAST_ADMIN concurrency tests');
}

describe.skipIf(!available)('PG16 LAST_ADMIN concurrency under pg_advisory_xact_lock', () => {
  let pg: DisposablePostgres;
  let adminPrisma: PrismaClient;
  let appPrisma: PrismaService;
  let membersController: MembersController;
  let workspacesController: WorkspacesController;

  beforeAll(async () => {
    pg = startDisposablePostgres();
    adminPrisma = new PrismaClient({ datasourceUrl: pg.databaseUrl });
    appPrisma = new PrismaService({ datasourceUrl: pg.appDatabaseUrl, enforcePrincipal: true });
    await appPrisma.verifyPrincipal();

    const config = {
      SESSION_SECRET: 's'.repeat(32),
      SESSION_TTL_MINUTES: 60,
      NODE_ENV: 'test',
    } as AppConfig;
    const audit = new AuditService(appPrisma);
    const sessions = new SessionService(config, appPrisma);
    membersController = new MembersController(appPrisma, {} as AuthService);
    workspacesController = new WorkspacesController(appPrisma, audit, sessions);
  }, 900_000);

  afterAll(async () => {
    await appPrisma?.onModuleDestroy().catch(() => undefined);
    await adminPrisma?.$disconnect().catch(() => undefined);
    pg?.stop();
  }, 120_000);

  async function seedTwoAdminWorkspace() {
    const wsId = randomUUID();
    const u1 = randomUUID();
    const u2 = randomUUID();
    const m1 = randomUUID();
    const m2 = randomUUID();
    await adminPrisma.workspace.create({ data: { id: wsId, name: `Concurrency ${wsId.slice(0, 6)}` } });
    await adminPrisma.user.createMany({
      data: [
        { id: u1, email: `a1-${wsId.slice(0, 8)}@example.test`, passwordHash: 'hash' },
        { id: u2, email: `a2-${wsId.slice(0, 8)}@example.test`, passwordHash: 'hash' },
      ],
    });
    await adminPrisma.membership.createMany({
      data: [
        { id: m1, userId: u1, workspaceId: wsId, role: 'admin', status: 'active' },
        { id: m2, userId: u2, workspaceId: wsId, role: 'admin', status: 'active' },
      ],
    });
    return { wsId, u1, u2, m1, m2 };
  }

  function tenantReq(userId: string, workspaceId: string): Request {
    return {
      tenant: {
        userId,
        workspaceId,
        role: 'admin',
        jti: randomUUID(),
        exp: Math.floor(Date.now() / 1000) + 3600,
        onboardingCompleted: true,
        onboardingCompanyId: null,
      },
    } as unknown as Request;
  }

  it('concurrent changeRole to member on both admins leaves >= 1 admin and rejects loser with 409 LAST_ADMIN', async () => {
    const { wsId, u1, u2, m1, m2 } = await seedTwoAdminWorkspace();
    const outcomes = await Promise.allSettled([
      membersController.changeRole(m1, { role: 'member' }, tenantReq(u2, wsId)),
      membersController.changeRole(m2, { role: 'member' }, tenantReq(u1, wsId)),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictException);
    expect((rejected[0].reason as ConflictException).getResponse()).toMatchObject({
      error: { code: 'LAST_ADMIN' },
    });

    const activeAdmins = await adminPrisma.membership.count({
      where: { workspaceId: wsId, role: 'admin', status: 'active' },
    });
    expect(activeAdmins).toBe(1);
  }, 60_000);

  it('concurrent remove + changeRole cannot leave workspace with zero active admins', async () => {
    const { wsId, u1, u2, m1, m2 } = await seedTwoAdminWorkspace();
    const outcomes = await Promise.allSettled([
      membersController.remove(m2, tenantReq(u1, wsId)),
      membersController.changeRole(m1, { role: 'member' }, tenantReq(u2, wsId)),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictException);
    expect((rejected[0].reason as ConflictException).getResponse()).toMatchObject({
      error: { code: 'LAST_ADMIN' },
    });

    const activeAdmins = await adminPrisma.membership.count({
      where: { workspaceId: wsId, role: 'admin', status: 'active' },
    });
    expect(activeAdmins).toBe(1);
  }, 60_000);

  it('concurrent WorkspacesController.leave on both admins leaves >= 1 active admin and rejects loser with LAST_ADMIN', async () => {
    const { wsId, u1, u2 } = await seedTwoAdminWorkspace();
    const u3 = randomUUID();
    await adminPrisma.user.create({
      data: { id: u3, email: `m3-${wsId.slice(0, 8)}@example.test`, passwordHash: 'hash' },
    });
    await adminPrisma.membership.create({
      data: { userId: u3, workspaceId: wsId, role: 'member', status: 'active' },
    });
    const res1 = { clearCookie: vi.fn() } as unknown as Response;
    const res2 = { clearCookie: vi.fn() } as unknown as Response;

    const outcomes = await Promise.allSettled([
      workspacesController.leave(tenantReq(u1, wsId), res1, wsId),
      workspacesController.leave(tenantReq(u2, wsId), res2, wsId),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(BadRequestException);
    expect((rejected[0].reason as BadRequestException).getResponse()).toMatchObject({
      error: { code: 'LAST_ADMIN' },
    });

    const activeAdmins = await adminPrisma.membership.count({
      where: { workspaceId: wsId, role: 'admin', status: 'active' },
    });
    expect(activeAdmins).toBe(1);
  }, 60_000);
});
