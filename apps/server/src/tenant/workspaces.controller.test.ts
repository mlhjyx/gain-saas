import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
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
  const controller = new WorkspacesController(prisma as never, audit as never, sessionService as never);
  return { controller, prisma, audit, sessionService, sessionUpdateMany };
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
});
