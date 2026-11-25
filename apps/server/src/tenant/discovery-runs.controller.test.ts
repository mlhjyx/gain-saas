import { NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../shared/audit.service.js';
import type { PrismaService } from '../shared/prisma.service.js';
import { DiscoveryRunsController } from './discovery-runs.controller.js';

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const RUN_ID = '44444444-4444-4444-8444-444444444444';
const PLAN_ID = '55555555-5555-4555-8555-555555555555';
const ICP_ID = '66666666-6666-4666-8666-666666666666';

function makeController(overrides: {
  findFirst?: () => Promise<unknown>;
  create?: () => Promise<unknown>;
  update?: () => Promise<unknown>;
} = {}) {
  const discoveryRunLink = {
    findMany: vi.fn(async () => []),
    findFirst: vi.fn(overrides.findFirst ?? (async () => null)),
    create: vi.fn(
      overrides.create ??
        (async () => ({
          runId: RUN_ID,
          workspaceId: WS_A,
          planId: PLAN_ID,
          icpId: ICP_ID,
          createdAt: new Date('2026-11-26T00:00:00Z'),
        })),
    ),
    update: vi.fn(
      overrides.update ??
        (async () => ({
          runId: RUN_ID,
          workspaceId: WS_A,
          planId: PLAN_ID,
          icpId: ICP_ID,
          createdAt: new Date('2026-11-26T00:00:00Z'),
        })),
    ),
  };
  const prisma: Record<string, unknown> = {
    discoveryRunLink,
    withWorkspace: vi.fn(async (_wid: string, fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  return {
    controller: new DiscoveryRunsController(prisma as unknown as PrismaService, audit),
    discoveryRunLink,
    audit,
  };
}

const req = {
  tenant: {
    userId: USER_ID,
    workspaceId: WS_A,
    role: 'admin',
    jti: 'jti-1',
    exp: 9_999_999_999,
    onboardingCompleted: true,
    onboardingCompanyId: null,
  },
} as unknown as Request;

describe('DiscoveryRunsController.record (no runId oracle)', () => {
  it('returns 404 NOT_FOUND when findFirst sees a runId owned by another workspace', async () => {
    const { controller, discoveryRunLink } = makeController({
      findFirst: async () => ({ runId: RUN_ID, workspaceId: WS_B }),
    });
    const err = await controller
      .record(req, { runId: RUN_ID, planId: PLAN_ID, icpId: ICP_ID })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).getResponse()).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
    expect(discoveryRunLink.create).not.toHaveBeenCalled();
    expect(discoveryRunLink.update).not.toHaveBeenCalled();
  });

  it.each(['P2002', '42501'] as const)(
    'returns 404 NOT_FOUND when FORCE RLS hides foreign row and create fails with %s',
    async (code) => {
      const { controller } = makeController({
        findFirst: async () => null,
        create: async () => {
          throw Object.assign(new Error(`db error ${code}`), { code });
        },
      });
      const err = await controller
        .record(req, { runId: RUN_ID, planId: PLAN_ID, icpId: ICP_ID })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      expect((err as NotFoundException).getResponse()).toMatchObject({
        error: { code: 'NOT_FOUND' },
      });
    },
  );

  it('updates link when runId already belongs to the current workspace', async () => {
    const { controller, discoveryRunLink } = makeController({
      findFirst: async () => ({ runId: RUN_ID, workspaceId: WS_A }),
    });
    const out = await controller.record(req, { runId: RUN_ID, planId: PLAN_ID, icpId: ICP_ID });
    expect(discoveryRunLink.update).toHaveBeenCalledWith({
      where: { runId: RUN_ID },
      data: { planId: PLAN_ID, icpId: ICP_ID },
    });
    expect(out.data.runId).toBe(RUN_ID);
  });
});
