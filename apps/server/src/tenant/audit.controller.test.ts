import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { AuditController } from './audit.controller.js';
import type { TenantRequestContext } from './tenant.guard.js';

const WS_1 = '11111111-1111-4111-8111-111111111111';
const WS_2 = '22222222-2222-4222-8222-222222222222';

function tenant(workspaceId = WS_1, userId = 'u-1'): TenantRequestContext {
  return {
    userId,
    workspaceId,
    role: 'admin',
    jti: 'j-1',
    exp: 0,
    onboardingCompleted: true,
    onboardingCompanyId: null,
  };
}

function row(index: number, overrides: Partial<{ realm: string; actorId: string; workspaceId: string | null; action: string }> = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    realm: overrides.realm ?? 'tenant',
    actorId: overrides.actorId ?? 'u-1',
    workspaceId: overrides.workspaceId === undefined ? WS_1 : overrides.workspaceId,
    action: overrides.action ?? 'auth.login',
    target: null,
    detail: null,
    at: new Date(Date.UTC(2026, 10, 9, 12, 0, index)),
  };
}

function fixture(rows: ReturnType<typeof row>[]) {
  const findMany = vi.fn(async () => rows);
  const count = vi.fn(async () => 42);
  const prisma = {
    auditLog: { findMany, count },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const controller = new AuditController(prisma as never);
  const req = { tenant: tenant() } as unknown as Request;
  return { controller, req, findMany, count };
}

describe('AuditController（P5b-13：筛选 + 游标分页 + total + workspace 隔离）', () => {
  it('默认按 workspaceId 查当前工作空间 tenant 审计，limit+1 探测下一页', async () => {
    const { controller, req, findMany } = fixture([row(1)]);
    const result = await controller.list(req);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { realm: 'tenant', workspaceId: WS_1 },
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        take: 101,
      }),
    );
    expect(result.data.total).toBe(42);
    expect(result.data.nextCursor).toBeNull();
    expect(result.data.entries[0]!.at).toMatch(/^2026-11-09T/);
  });

  it('同工作空间不同成员的审计均可见，其他工作空间与 null 审计被隔离排除', async () => {
    const store = [
      row(1, { actorId: 'u-1', workspaceId: WS_1, action: 'auth.login' }),
      row(2, { actorId: 'u-2', workspaceId: WS_1, action: 'campaign.created' }),
      row(3, { actorId: 'u-1', workspaceId: WS_2, action: 'auth.login' }),
      row(4, { actorId: 'u-1', workspaceId: null, action: 'auth.logout' }),
      row(5, { realm: 'ops', actorId: 'ops-1', workspaceId: WS_1, action: 'workspace.status' }),
    ];
    const prisma = {
      auditLog: {
        findMany: vi.fn(async ({ where }: { where: { realm: string; workspaceId: string } }) =>
          store.filter((r) => r.realm === where.realm && r.workspaceId === where.workspaceId),
        ),
        count: vi.fn(async ({ where }: { where: { realm: string; workspaceId: string } }) =>
          store.filter((r) => r.realm === where.realm && r.workspaceId === where.workspaceId).length,
        ),
      },
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    const controller = new AuditController(prisma as never);
    const result = await controller.list({ tenant: tenant(WS_1, 'u-1') } as unknown as Request);
    expect(result.data.total).toBe(2);
    expect(result.data.entries.map((e) => e.actorId)).toEqual(['u-1', 'u-2']);
  });

  it('action 精确过滤；日期只给日期时 from 取当天开始、to 取当天结束', async () => {
    const { controller, req, findMany } = fixture([]);
    await controller.list(req, '50', 'member.invite', '2026-11-01', '2026-11-08');
    const args = findMany.mock.calls[0]![0] as {
      where: { action?: string; at?: { gte?: Date; lte?: Date } };
      take: number;
    };
    expect(args.where.action).toBe('member.invite');
    expect(args.where.at?.gte?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(args.where.at?.lte?.toISOString()).toBe('2026-11-08T23:59:59.999Z');
    expect(args.take).toBe(51);
  });

  it('满页时返回 nextCursor，第二页用 at+id 复合键续拉', async () => {
    const rows = Array.from({ length: 101 }, (_, index) => row(index));
    const { controller, req, findMany } = fixture(rows);
    const first = await controller.list(req, '100');
    expect(first.data.entries).toHaveLength(100);
    expect(first.data.nextCursor).toBeTruthy();

    findMany.mockResolvedValueOnce([row(200)]);
    await controller.list(req, '100', undefined, undefined, undefined, first.data.nextCursor!);
    const args = findMany.mock.calls[1]![0] as {
      where: { OR?: unknown[] };
      take: number;
    };
    expect(args.take).toBe(101);
    expect(args.where.OR).toEqual([
      { at: { lt: expect.any(Date) } },
      { at: expect.any(Date), id: { lt: rows[99]!.id } },
    ]);
  });

  it('非法 cursor 与非法日期被忽略，不抛错', async () => {
    const { controller, req, findMany } = fixture([]);
    await controller.list(req, '100', undefined, 'not-a-date', 'not-a-date', 'not-base64');
    const args = findMany.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(args.where.at).toBeUndefined();
    expect(args.where.OR).toBeUndefined();
  });
});
