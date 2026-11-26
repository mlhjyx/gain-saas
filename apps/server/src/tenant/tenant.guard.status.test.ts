import { ForbiddenException, HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../shared/prisma.service.js';
import { SESSION_COOKIE, type SessionService } from './session.service.js';
import { TenantGuard } from './tenant.guard.js';

function makeContext(
  overrides: { method?: string; path?: string; originalUrl?: string; url?: string } = {},
) {
  const req: Record<string, unknown> = {
    method: overrides.method ?? 'GET',
    cookies: { [SESSION_COOKIE]: 'session-token' },
    path: overrides.path ?? '/api/campaigns',
    originalUrl: overrides.originalUrl ?? overrides.path ?? '/api/campaigns',
    url: overrides.url ?? overrides.path ?? '/api/campaigns',
  };
  const res = { clearCookie: vi.fn(), cookie: vi.fn() };
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as Parameters<TenantGuard['canActivate']>[0];
  return { ctx, req, res };
}

function makeGuard(
  workspaceStatus: string | null,
  onboardingCompletedAt: Date | null = new Date(),
  needsRefresh = false,
  onboardingCompanyId: string | null = null,
) {
  const clearOpts = { httpOnly: true, sameSite: 'lax' as const, path: '/', secure: true };
  const sessions = {
    verify: vi.fn(async () => ({
      userId: '11111111-1111-4111-8111-111111111111',
      workspaceId: '22222222-2222-4222-8222-222222222222',
      role: 'admin',
      jti: 'jti-1',
      exp: 9_999_999_999,
    })),
    needsRefresh: () => needsRefresh,
    revoke: vi.fn(),
    issue: vi.fn(),
    cookieOptions: vi.fn(),
    clearCookieOptions: vi.fn(() => clearOpts),
    ttl: 60,
  } as unknown as SessionService;
  const prismaObj: Record<string, unknown> = {
    membership: {
      findFirst: vi.fn(async () =>
        workspaceStatus === null
          ? null
          : {
              role: 'admin',
              workspace: {
                status: workspaceStatus,
                onboardingCompletedAt,
                onboardingCompanyId,
              },
            },
      ),
    },
    withWorkspace: vi.fn(async (_wid: string, fn: (tx: unknown) => Promise<unknown>) => fn(prismaObj)),
  };
  return { guard: new TenantGuard(sessions, prismaObj as unknown as PrismaService), sessions };
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

  it('成员资格缺失仍是 NOT_A_MEMBER（回归），且 clearCookie 携带 clearCookieOptions', async () => {
    const { guard } = makeGuard(null);
    const { ctx, res } = makeContext();
    const error = await guard.canActivate(ctx).catch((err: unknown) => err);
    expect(error).toBeTruthy();
    expect(res.clearCookie).toHaveBeenCalledWith(SESSION_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: true,
    });
  });

  it('停用空间或失效成员即使命中滑动续期窗口也绝不签发新会话 cookie', async () => {
    const sessions = {
      verify: vi.fn(async () => ({
        userId: '11111111-1111-4111-8111-111111111111',
        workspaceId: '22222222-2222-4222-8222-222222222222',
        role: 'admin',
        jti: 'jti-1',
        exp: 100,
      })),
      needsRefresh: () => true,
      revoke: vi.fn(),
      issue: vi.fn(),
      cookieOptions: vi.fn(),
      ttl: 60,
    } as unknown as SessionService;
    const prismaObj: Record<string, unknown> = {
      membership: {
        findFirst: vi.fn(async () => ({
          role: 'admin',
          workspace: { status: 'DISABLED', onboardingCompletedAt: new Date(), onboardingCompanyId: null },
        })),
      },
      withWorkspace: vi.fn(async (_wid: string, fn: (tx: unknown) => Promise<unknown>) => fn(prismaObj)),
    };
    const prisma = prismaObj as unknown as PrismaService;
    const guard = new TenantGuard(sessions, prisma);
    const { ctx, res } = makeContext();
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    expect(sessions.issue).not.toHaveBeenCalled();
    expect(sessions.revoke).not.toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('onboardingCompleted=false allows active-workspace business routes (soft onboarding) while preserving onboardingCompleted=false on req.tenant', async () => {
    const businessPaths = [
      '/api/tasks',
      '/api/runs/run-1',
      '/api/campaigns',
      '/api/outreach/batches',
      '/api/qgos',
      '/api/saos',
      '/api/companies',
    ];
    for (const path of businessPaths) {
      const { guard } = makeGuard('ACTIVE', null, false);
      const { ctx, req } = makeContext({ path, originalUrl: path, url: path });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect((req as { tenant?: { onboardingCompleted?: boolean; onboardingCompanyId?: string | null } }).tenant).toMatchObject({
        onboardingCompleted: false,
        onboardingCompanyId: null,
      });
    }
  });

  it('onboardingCompleted=false still rejects DISABLED/ARCHIVED workspaces with 403 WORKSPACE_DISABLED without refreshing cookie', async () => {
    for (const status of ['DISABLED', 'ARCHIVED'] as const) {
      const { guard, sessions } = makeGuard(status, null, true);
      const { ctx, res } = makeContext({ path: '/api/companies', originalUrl: '/api/companies', url: '/api/companies' });
      const err = await guard.canActivate(ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        error: { code: 'WORKSPACE_DISABLED' },
      });
      expect(sessions.issue).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
    }
  });

  it('onboardingCompleted=false allows all 7 allowlisted onboarding/account route prefixes', async () => {
    const allowedRequests = [
      { path: '/api/auth/session' },
      { path: '/api/onboarding/company' },
      { path: '/api/workspaces' },
      { path: '/api/workspaces/22222222-2222-4222-8222-222222222222/leave' },
      { path: '/api/workspace/context' },
      { path: '/api/notifications' },
      { path: '/api/members' },
      { path: '/api/audit', originalUrl: '/api/audit?limit=20', url: '/api/audit?limit=20' },
    ];
    for (const target of allowedRequests) {
      const { guard } = makeGuard('ACTIVE', null, false);
      const { ctx, req } = makeContext({
        path: target.path,
        originalUrl: target.originalUrl ?? target.path,
        url: target.url ?? target.path,
      });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect((req as { tenant?: { onboardingCompleted?: boolean } }).tenant?.onboardingCompleted).toBe(false);
    }
  });

  it('onboardingCompleted=false allows draft-company brochure (including multipart) and market-recommendation routes with onboardingCompanyId', async () => {
    const draftId = '6020b505-2bee-40e5-908c-708a270b7b3e';
    const docId = '99999999-9999-4999-8999-999999999999';
    const allowedDraftRequests = [
      { method: 'GET', path: `/api/companies/${draftId}/seller-documents` },
      { method: 'GET', path: `/api/companies/${draftId}/market-recommendations`, originalUrl: `/api/companies/${draftId}/market-recommendations?limit=8` },
      { method: 'POST', path: `/api/companies/${draftId}/seller-documents/presign` },
      { method: 'PUT', path: `/api/companies/${draftId}/seller-documents/${docId}/content` },
      { method: 'POST', path: `/api/companies/${draftId}/seller-documents/${docId}/multipart/init` },
      { method: 'PUT', path: `/api/companies/${draftId}/seller-documents/${docId}/parts/1` },
      { method: 'POST', path: `/api/companies/${draftId}/seller-documents/${docId}/multipart/complete` },
      { method: 'POST', path: `/api/companies/${draftId}/seller-documents/${docId}/commit` },
      { method: 'POST', path: `/api/companies/${draftId}/seller-documents/${docId}/claim-previews` },
      { method: 'POST', path: `/api/companies/${draftId}/seller-documents/${docId}/claim-drafts` },
    ];
    for (const target of allowedDraftRequests) {
      const { guard } = makeGuard('ACTIVE', null, false, draftId);
      const { ctx, req } = makeContext({
        method: target.method,
        path: target.path,
        originalUrl: target.originalUrl ?? target.path,
        url: target.originalUrl ?? target.path,
      });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect((req as { tenant?: { onboardingCompanyId?: string | null } }).tenant?.onboardingCompanyId).toBe(draftId);
    }
  });
});
