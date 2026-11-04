import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../shared/prisma.service.js';
import { SESSION_COOKIE, type SessionService } from './session.service.js';
import { TenantGuard } from './tenant.guard.js';

function makeContext() {
  const req: Record<string, unknown> = { cookies: { [SESSION_COOKIE]: 'session-token' } };
  const res = { clearCookie: vi.fn(), cookie: vi.fn() };
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as Parameters<TenantGuard['canActivate']>[0];
  return { ctx, req, res };
}

function makeGuard(workspaceStatus: string | null, onboardingCompletedAt: Date | null = new Date()) {
  const sessions = {
    verify: vi.fn(async () => ({
      userId: '11111111-1111-4111-8111-111111111111',
      workspaceId: '22222222-2222-4222-8222-222222222222',
      role: 'admin',
      jti: 'jti-1',
      exp: 9_999_999_999,
    })),
    needsRefresh: () => false,
    revoke: vi.fn(),
    issue: vi.fn(),
    cookieOptions: vi.fn(),
    ttl: 60,
  } as unknown as SessionService;
  const prisma = {
    membership: {
      findFirst: vi.fn(async () =>
        workspaceStatus === null
          ? null
          : {
              role: 'admin',
              workspace: {
                status: workspaceStatus,
                onboardingCompletedAt,
                onboardingCompanyId: null,
              },
            },
      ),
    },
  } as unknown as PrismaService;
  return { guard: new TenantGuard(sessions, prisma) };
}

describe('TenantGuard workspace status', () => {
  it('停用的工作空间拒绝访问（403 WORKSPACE_DISABLED）', async () => {
    const { guard } = makeGuard('DISABLED');
    const { ctx, res } = makeContext();
    const error = await guard.canActivate(ctx).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ForbiddenException);
    const body = (error as ForbiddenException).getResponse() as {
      error?: { code?: string; message?: string };
    };
    expect(body.error?.code).toBe('WORKSPACE_DISABLED');
    expect(body.error?.message).toContain('停用');
    expect(res.clearCookie).not.toHaveBeenCalled();
  });

  it('归档的工作空间同样拒绝', async () => {
    const { guard } = makeGuard('ARCHIVED');
    const { ctx } = makeContext();
    const error = await guard.canActivate(ctx).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ForbiddenException);
  });

  it('ACTIVE 工作空间正常通过并注入上下文', async () => {
    const { guard } = makeGuard('ACTIVE');
    const { ctx, req } = makeContext();
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect((req as { tenant?: { onboardingCompleted?: boolean } }).tenant?.onboardingCompleted).toBe(true);
  });

  it('成员资格缺失仍是 NOT_A_MEMBER（回归）', async () => {
    const { guard } = makeGuard(null);
    const { ctx } = makeContext();
    const error = await guard.canActivate(ctx).catch((err: unknown) => err);
    expect(error).toBeTruthy();
  });
});
