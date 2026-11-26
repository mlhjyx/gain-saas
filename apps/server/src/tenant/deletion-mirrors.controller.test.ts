import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { AdminGuard } from './admin.guard.js';
import { DeletionMirrorsController } from './deletion-mirrors.controller.js';
import { TenantGuard, type TenantRequestContext } from './tenant.guard.js';

const WS_1 = '11111111-1111-4111-8111-111111111111';
const WS_2 = '22222222-2222-4222-8222-222222222222';

function makeTenant(workspaceId = WS_1, role: 'admin' | 'member' = 'admin'): TenantRequestContext {
  return {
    userId: '33333333-3333-4333-8333-333333333333',
    workspaceId,
    role,
    jti: 'jti-1',
    exp: Math.floor(Date.now() / 1000) + 3600,
    onboardingCompleted: true,
    onboardingCompanyId: null,
  };
}

function makeMirrorRow(
  index: number,
  overrides: Partial<{
    workspaceId: string | null;
    engineRequestId: string;
    status: string;
    saasDeleted: number;
    at: Date;
  }> & Record<string, unknown> = {},
) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    workspaceId: overrides.workspaceId === undefined ? WS_1 : overrides.workspaceId,
    engineRequestId: overrides.engineRequestId ?? `dsr-req-${index}`,
    status: overrides.status ?? 'COMPLETED',
    saasDeleted: overrides.saasDeleted ?? index,
    at: overrides.at ?? new Date(Date.UTC(2026, 10, 20, 12, 0, index)),
    ...overrides,
  };
}

function makeFixture(rows: Array<ReturnType<typeof makeMirrorRow>>, total = rows.length) {
  const findMany = vi.fn(async () => rows);
  const count = vi.fn(async () => total);
  const tx = { deletionMirror: { findMany, count } };
  const prisma = {
    withWorkspace: vi.fn(async (_wid: string, fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const controller = new DeletionMirrorsController(prisma as never);
  const req = { tenant: makeTenant() } as unknown as Request;
  return { controller, prisma, req, findMany, count };
}

describe('DeletionMirrorsController (GET /api/deletion-mirrors)', () => {
  it('attaches both TenantGuard and AdminGuard; AdminGuard rejects member with 403 ADMIN_REQUIRED', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, DeletionMirrorsController);
    expect(guards).toEqual([TenantGuard, AdminGuard]);

    const adminGuard = new AdminGuard();
    const memberCtx = {
      switchToHttp: () => ({ getRequest: () => ({ tenant: makeTenant(WS_1, 'member') }) }),
    } as unknown as ExecutionContext;
    const adminCtx = {
      switchToHttp: () => ({ getRequest: () => ({ tenant: makeTenant(WS_1, 'admin') }) }),
    } as unknown as ExecutionContext;

    expect(() => adminGuard.canActivate(memberCtx)).toThrow(ForbiddenException);
    try {
      adminGuard.canActivate(memberCtx);
    } catch (err) {
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        error: { code: 'ADMIN_REQUIRED' },
      });
    }
    expect(adminGuard.canActivate(adminCtx)).toBe(true);
  });

  it('queries strictly inside prisma.withWorkspace(workspaceId) with default limit=50 and explicit safe select', async () => {
    const row = makeMirrorRow(1, { saasDeleted: 4 });
    const { controller, prisma, req, findMany, count } = makeFixture([row], 1);

    const result = await controller.list(req);

    expect(prisma.withWorkspace).toHaveBeenCalledTimes(1);
    expect(prisma.withWorkspace).toHaveBeenCalledWith(WS_1, expect.any(Function));
    expect(findMany).toHaveBeenCalledWith({
      where: { workspaceId: WS_1 },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: 51,
      select: {
        id: true,
        engineRequestId: true,
        status: true,
        saasDeleted: true,
        at: true,
      },
    });
    expect(count).toHaveBeenCalledWith({ where: { workspaceId: WS_1 } });
    expect(result).toEqual({
      data: {
        items: [
          {
            id: row.id,
            engineRequestId: 'dsr-req-1',
            status: 'COMPLETED',
            saasDeleted: 4,
            at: row.at.toISOString(),
          },
        ],
        nextCursor: null,
        hasMore: false,
        total: 1,
      },
    });
  });

  it('redacts / excludes workspaceId and any unexpected sensitive fields from returned items', async () => {
    const leakyRow = makeMirrorRow(2, {
      workspaceId: WS_1,
      internalToken: 'secret-token-xyz',
      apiKeyCipher: 'cipher-abc',
      recipientEmail: 'person@example.com',
    });
    const { controller, req } = makeFixture([leakyRow], 1);

    const result = await controller.list(req);
    const item = result.data.items[0] as unknown as Record<string, unknown>;
    expect(Object.keys(item).sort()).toEqual(['at', 'engineRequestId', 'id', 'saasDeleted', 'status']);
    expect(item).not.toHaveProperty('workspaceId');
    expect(item).not.toHaveProperty('internalToken');
    expect(item).not.toHaveProperty('apiKeyCipher');
    expect(item).not.toHaveProperty('recipientEmail');
  });

  it('isolates rows across workspaces via withWorkspace + workspaceId predicate', async () => {
    const store = [
      makeMirrorRow(1, { workspaceId: WS_1, engineRequestId: 'req-ws1' }),
      makeMirrorRow(2, { workspaceId: WS_2, engineRequestId: 'req-ws2' }),
      makeMirrorRow(3, { workspaceId: null, engineRequestId: 'req-null' }),
    ];
    const tx = {
      deletionMirror: {
        findMany: vi.fn(async ({ where }: { where: { workspaceId: string } }) =>
          store.filter((r) => r.workspaceId === where.workspaceId),
        ),
        count: vi.fn(async ({ where }: { where: { workspaceId: string } }) =>
          store.filter((r) => r.workspaceId === where.workspaceId).length,
        ),
      },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_wid: string, fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const controller = new DeletionMirrorsController(prisma as never);
    const result = await controller.list({ tenant: makeTenant(WS_1) } as unknown as Request);

    expect(prisma.withWorkspace).toHaveBeenCalledWith(WS_1, expect.any(Function));
    expect(result.data.total).toBe(1);
    expect(result.data.items.map((item) => item.engineRequestId)).toEqual(['req-ws1']);
  });

  it('clamps limit to 100 max and normalizes optional status filter', async () => {
    const { controller, req, findMany, count } = makeFixture([], 0);

    await controller.list(req, '500', ' completed ');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: WS_1, status: 'COMPLETED' },
        take: 101,
      }),
    );
    expect(count).toHaveBeenCalledWith({ where: { workspaceId: WS_1, status: 'COMPLETED' } });
  });

  it('supports keyset cursor pagination when results exceed limit', async () => {
    const rows = Array.from({ length: 3 }, (_, idx) => makeMirrorRow(idx + 1));
    const { controller, req, findMany } = makeFixture(rows, 5);

    const first = await controller.list(req, '2');
    expect(first.data.items).toHaveLength(2);
    expect(first.data.hasMore).toBe(true);
    expect(first.data.nextCursor).toBeTruthy();
    expect(first.data.total).toBe(5);

    findMany.mockResolvedValueOnce([rows[2]!]);
    const second = await controller.list(req, '2', undefined, first.data.nextCursor!);
    expect(second.data.hasMore).toBe(false);
    expect(second.data.nextCursor).toBeNull();
    const secondQuery = findMany.mock.calls[1]![0] as { where: { OR?: unknown[] } };
    expect(secondQuery.where.OR).toEqual([
      { at: { lt: rows[1]!.at } },
      { at: rows[1]!.at, id: { lt: rows[1]!.id } },
    ]);
  });

  it.each([
    ['limit=0', '0', undefined, undefined],
    ['limit=-5', '-5', undefined, undefined],
    ['limit=abc', 'abc', undefined, undefined],
    ['limit=1.5', '1.5', undefined, undefined],
    ['invalid status chars', undefined, 'DROP TABLE;', undefined],
    ['invalid cursor', undefined, undefined, 'not-a-valid-cursor'],
  ] as const)('rejects %s with 400 VALIDATION_ERROR without hitting DB', async (_label, limit, status, cursor) => {
    const { controller, prisma, req } = makeFixture([], 0);
    await expect(controller.list(req, limit, status, cursor)).rejects.toMatchObject({
      status: 400,
      response: { error: { code: 'VALIDATION_ERROR' } },
    });
    expect(prisma.withWorkspace).not.toHaveBeenCalled();
  });
});
