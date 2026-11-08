import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { AuditController } from './audit.controller.js';
import type { TenantRequestContext } from './tenant.guard.js';

function tenant(): TenantRequestContext {
  return {
    userId: 'u-1',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    role: 'admin',
    jti: 'j-1',
    exp: 0,
    onboardingCompleted: true,
    onboardingCompanyId: null,
  };
}

function row(index: number) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    realm: 'tenant',
    actorId: 'u-1',
    action: 'auth.login',
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

describe('AuditController（P5b-13：筛选 + 游标分页 + total）', () => {
  it('默认只查本人 tenant 审计，limit+1 探测下一页', async () => {
    const { controller, req, findMany } = fixture([row(1)]);
    const result = await controller.list(req);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { realm: 'tenant', actorId: 'u-1' },
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        take: 101,
      }),
    );
    expect(result.data.total).toBe(42);
    expect(result.data.nextCursor).toBeNull();
    expect(result.data.entries[0]!.at).toMatch(/^2026-11-09T/);
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
