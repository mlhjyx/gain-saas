import type { ArgumentsHost } from '@nestjs/common';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { GlobalHttpExceptionFilter } from '../shared/http-exception.filter.js';
import { SESSION_COOKIE } from './session.service.js';
import { WorkspacesController } from './workspaces.controller.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const WS_CURR = '22222222-2222-4222-8222-222222222222';
const WS_OTHER = '33333333-3333-4333-8333-333333333333';

function makeController(
  sessions: Array<{
    jti: string;
    realm: string;
    subjectType: string;
    subjectId: string;
    workspaceId: string | null;
    revokedAt: Date | null;
  }>,
  role: 'admin' | 'member' = 'member',
) {
  const sessionUpdateMany = vi.fn(
    async ({
      where,
      data,
    }: {
      where: {
        realm: string;
        subjectType: string;
        subjectId: string;
        workspaceId?: string | null;
        revokedAt: null;
      };
      data: { revokedAt: Date };
    }) => {
      let count = 0;
      for (const row of sessions) {
        if (
          row.realm === where.realm &&
          row.subjectType === where.subjectType &&
          row.subjectId === where.subjectId &&
          row.workspaceId === where.workspaceId &&
          row.revokedAt === null
        ) {
          row.revokedAt = data.revokedAt;
          count += 1;
        }
      }
      return { count };
    },
  );
  const membershipUpdate = vi.fn(async () => ({ id: 'm-1', status: 'left' }));
  const prisma: Record<string, unknown> = {
    $executeRaw: vi.fn(async () => 0),
    workspace: {
      findUnique: vi.fn(async () => ({ status: 'ACTIVE' })),
    },
    membership: {
      findFirst: vi.fn(async () => ({
        id: 'm-1',
        userId: USER_ID,
        workspaceId: WS_CURR,
        role,
        status: 'active',
        workspace: { status: 'ACTIVE' },
      })),
      count: vi.fn(async () => 2),
      update: membershipUpdate,
    },
    session: {
      updateMany: sessionUpdateMany,
    },
    withWorkspace: vi.fn(async (_wid: string, fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    $transaction: vi.fn(async (fn: (tx: { membership: { update: typeof membershipUpdate }; session: { updateMany: typeof sessionUpdateMany } }) => Promise<unknown>) =>
      fn({ membership: { update: membershipUpdate }, session: { updateMany: sessionUpdateMany } }),
    ),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const sessionService = {
    revoke: vi.fn(async (jti: string) => {
      const row = sessions.find((s) => s.jti === jti);
      if (row) row.revokedAt = new Date();
    }),
    clearCookieOptions: vi.fn(() => ({ httpOnly: true, sameSite: 'lax' as const, path: '/', secure: true })),
  };
  const engine = {
    call: vi.fn(async () => ({
      status: 200,
      body: { data: { id: WS_CURR, name: 'Synced Name' } },
      contentType: 'application/json',
      headers: {},
    })),
    toClientStatus: vi.fn((status: number) => (status === 401 || status === 403 ? 502 : status)),
    toClientError: vi.fn((_status: number, body: unknown) => body),
  };
  const controller = new WorkspacesController(prisma as never, audit as never, sessionService as never, engine as never);
  return { controller, prisma, audit, sessionService, sessionUpdateMany, engine };
}

describe('WorkspacesController.leave', () => {
  it('leaving a non-current workspace revokes only sessions bound to that workspaceId (does NOT revoke workspaceId=null or current jti)', async () => {
    const sessions = [
      { jti: 'jti-curr-legacy', realm: 'tenant', subjectType: 'user', subjectId: USER_ID, workspaceId: null, revokedAt: null as Date | null },
      { jti: 'jti-curr-bound', realm: 'tenant', subjectType: 'user', subjectId: USER_ID, workspaceId: WS_CURR, revokedAt: null as Date | null },
      { jti: 'jti-left-ws', realm: 'tenant', subjectType: 'user', subjectId: USER_ID, workspaceId: WS_OTHER, revokedAt: null as Date | null },
    ];
    const { controller, sessionService, sessionUpdateMany } = makeController(sessions);
    const req = { tenant: { userId: USER_ID, workspaceId: WS_CURR, role: 'member', jti: 'jti-curr-legacy', exp: 9_999_999_999 } } as unknown as Request;
    const res = { clearCookie: vi.fn() } as unknown as Response;

    const result = await controller.leave(req, res, WS_OTHER);

    expect(result).toEqual({ data: { left: true, currentWorkspace: false } });
    expect(sessionUpdateMany).toHaveBeenCalledWith({
      where: {
        realm: 'tenant',
        subjectType: 'user',
        subjectId: USER_ID,
        workspaceId: WS_OTHER,
        revokedAt: null,
      },
      data: { revokedAt: expect.any(Date) },
    });
    expect(sessions.find((s) => s.jti === 'jti-left-ws')?.revokedAt).toBeInstanceOf(Date);
    expect(sessions.find((s) => s.jti === 'jti-curr-legacy')?.revokedAt).toBeNull();
    expect(sessions.find((s) => s.jti === 'jti-curr-bound')?.revokedAt).toBeNull();
    expect(sessionService.revoke).not.toHaveBeenCalled();
    expect(res.clearCookie).not.toHaveBeenCalled();
  });

  it('leaving the current workspace revokes all sessions in that workspace, revokes current jti (even if legacy null), and clears cookie', async () => {
    const sessions = [
      { jti: 'jti-curr-legacy', realm: 'tenant', subjectType: 'user', subjectId: USER_ID, workspaceId: null, revokedAt: null as Date | null },
      { jti: 'jti-curr-tab2', realm: 'tenant', subjectType: 'user', subjectId: USER_ID, workspaceId: WS_CURR, revokedAt: null as Date | null },
      { jti: 'jti-other-ws', realm: 'tenant', subjectType: 'user', subjectId: USER_ID, workspaceId: WS_OTHER, revokedAt: null as Date | null },
    ];
    const { controller, sessionService, sessionUpdateMany } = makeController(sessions);
    const req = { tenant: { userId: USER_ID, workspaceId: WS_CURR, role: 'member', jti: 'jti-curr-legacy', exp: 9_999_999_999 } } as unknown as Request;
    const res = { clearCookie: vi.fn() } as unknown as Response;

    const result = await controller.leave(req, res, WS_CURR);

    expect(result).toEqual({ data: { left: true, currentWorkspace: true } });
    expect(sessionUpdateMany).toHaveBeenCalledWith({
      where: {
        realm: 'tenant',
        subjectType: 'user',
        subjectId: USER_ID,
        workspaceId: WS_CURR,
        revokedAt: null,
      },
      data: { revokedAt: expect.any(Date) },
    });
    expect(sessionService.revoke).toHaveBeenCalledWith('jti-curr-legacy');
    expect(res.clearCookie).toHaveBeenCalledWith(SESSION_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: true,
    });
    expect(sessions.find((s) => s.jti === 'jti-curr-legacy')?.revokedAt).toBeInstanceOf(Date);
    expect(sessions.find((s) => s.jti === 'jti-curr-tab2')?.revokedAt).toBeInstanceOf(Date);
    expect(sessions.find((s) => s.jti === 'jti-other-ws')?.revokedAt).toBeNull();
  });

  it('rejects leaving when user is LAST_MEMBER or LAST_ADMIN with bilingual userCopy via GlobalHttpExceptionFilter', async () => {
    const filter = new GlobalHttpExceptionFilter();
    const capture = (err: unknown, lang: string) => {
      const sent: { status?: number; body?: { error?: { code?: string; userCopy?: { title?: string; why?: string; next?: string } } } } = {};
      const host = {
        switchToHttp: () => ({
          getRequest: () => ({ headers: { 'accept-language': lang } }),
          getResponse: () => ({
            status(code: number) {
              sent.status = code;
              return this;
            },
            json(payload: typeof sent.body) {
              sent.body = payload;
              return this;
            },
          }),
        }),
      } as unknown as ArgumentsHost;
      filter.catch(err, host);
      return sent;
    };

    const lastMemberFixture = makeController([], 'member');
    ((lastMemberFixture.prisma.membership as Record<string, unknown>).count as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    const req = { tenant: { userId: USER_ID, workspaceId: WS_CURR, role: 'member', jti: 'jti-1', exp: 9_999_999_999 } } as unknown as Request;
    const lastMemberErr = await lastMemberFixture.controller.leave(req, { clearCookie: vi.fn() } as unknown as Response, WS_CURR).catch((e: unknown) => e);
    const lmZh = capture(lastMemberErr, 'zh-CN');
    const lmEn = capture(lastMemberErr, 'en-US');
    expect(lmZh.status).toBe(400);
    expect(lmZh.body?.error?.code).toBe('LAST_MEMBER');
    expect(lmZh.body?.error?.userCopy?.title).toContain('最后一名成员');
    expect(lmEn.body?.error?.userCopy?.title).toContain('last member');

    const lastAdminFixture = makeController([], 'admin');
    ((lastAdminFixture.prisma.membership as Record<string, unknown>).count as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);
    const adminReq = { tenant: { userId: USER_ID, workspaceId: WS_CURR, role: 'admin', jti: 'jti-2', exp: 9_999_999_999 } } as unknown as Request;
    const lastAdminErr = await lastAdminFixture.controller.leave(adminReq, { clearCookie: vi.fn() } as unknown as Response, WS_CURR).catch((e: unknown) => e);
    const laZh = capture(lastAdminErr, 'zh-CN');
    const laEn = capture(lastAdminErr, 'en-US');
    expect(laZh.status).toBe(400);
    expect(laZh.body?.error?.code).toBe('LAST_ADMIN');
    expect(laZh.body?.error?.userCopy?.title).toContain('管理员');
    expect(laEn.body?.error?.userCopy?.title).toContain('admin');
  });
});

describe('WorkspacesController.rename engine sync (PATCH /api/workspaces/:id)', () => {
  it('syncs workspace name to engine PATCH /api/v1/workspace before updating local DB and records audit', async () => {
    const { controller, prisma, audit, engine } = makeController([], 'admin');
    const workspaceUpdate = vi.fn(async ({ data }: { data: { name: string } }) => ({ id: WS_OTHER, name: data.name }));
    (prisma.workspace as Record<string, unknown>).update = workspaceUpdate;
    const req = {
      tenant: { userId: USER_ID, workspaceId: WS_CURR, role: 'admin', jti: 'jti-1', exp: 9_999_999_999 },
      headers: { 'accept-language': 'zh-CN' },
    } as unknown as Request;

    const result = await controller.rename(req, WS_OTHER, { name: '  Acme Export Co.  ' });

    expect(engine.call).toHaveBeenCalledWith(
      { userId: USER_ID, workspaceId: WS_OTHER, role: 'admin' },
      'PATCH',
      '/workspace',
      { body: { name: 'Acme Export Co.' } },
    );
    expect(workspaceUpdate).toHaveBeenCalledWith({
      where: { id: WS_OTHER },
      data: { name: 'Acme Export Co.' },
    });
    expect(result).toEqual({ data: { id: WS_OTHER, name: 'Acme Export Co.' } });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        realm: 'tenant',
        actorId: USER_ID,
        workspaceId: WS_OTHER,
        action: 'workspaces.rename',
        detail: { name: 'Acme Export Co.', engineSynced: true },
      }),
    );
  });

  it('does not mutate local workspace name when engine PATCH /api/v1/workspace rejects, and maps 401/403 to 502', async () => {
    const { controller, prisma, engine } = makeController([], 'admin');
    const workspaceUpdate = vi.fn();
    (prisma.workspace as Record<string, unknown>).update = workspaceUpdate;
    engine.call.mockResolvedValueOnce({
      status: 403,
      body: { error: { code: 'SCOPE_REQUIRED', message: 'missing acquisition:write' } },
      contentType: 'application/json',
      headers: {},
    });
    const req = {
      tenant: { userId: USER_ID, workspaceId: WS_CURR, role: 'admin', jti: 'jti-1', exp: 9_999_999_999 },
      headers: {},
    } as unknown as Request;

    const err = await controller.rename(req, WS_CURR, { name: 'New Name' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502 });
    expect(workspaceUpdate).not.toHaveBeenCalled();
  });
});

describe('WorkspacesController offboarding routes', () => {
  it('delegates get/request/cancel offboarding to WorkspaceOffboardingService', async () => {
    const offboarding = {
      getStatus: vi.fn(async () => ({ id: 'req-1', status: 'SCHEDULED' })),
      requestOffboarding: vi.fn(async () => ({ id: 'req-1', status: 'SCHEDULED' })),
      cancelOffboarding: vi.fn(async () => ({ id: 'req-1', status: 'CANCELLED' })),
    };
    const controller = new WorkspacesController(
      {} as never,
      {} as never,
      {} as never,
      undefined,
      offboarding as never,
    );
    const req = {
      tenant: { userId: USER_ID, workspaceId: WS_CURR, role: 'admin', jti: 'jti-1', exp: 9_999_999_999 },
    } as unknown as Request;

    expect(await controller.getOffboarding(req, WS_CURR)).toEqual({ data: { id: 'req-1', status: 'SCHEDULED' } });
    expect(await controller.requestOffboarding(req, WS_CURR, { confirmName: 'Acme' })).toEqual({
      data: { id: 'req-1', status: 'SCHEDULED' },
    });
    expect(await controller.cancelOffboarding(req, WS_CURR)).toEqual({
      data: { id: 'req-1', status: 'CANCELLED' },
    });
    expect(offboarding.requestOffboarding).toHaveBeenCalledWith(req.tenant, WS_CURR, { confirmName: 'Acme' });
  });
});
