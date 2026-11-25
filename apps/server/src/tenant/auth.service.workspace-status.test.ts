import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../shared/prisma.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { WorkspacesController } from './workspaces.controller.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const WS_DISABLED = '22222222-2222-4222-8222-222222222222';
const WS_ACTIVE = '33333333-3333-4333-8333-333333333333';

function makeAuthHarness(overrides: {
  passwordHash?: string;
  userStatus?: string;
  memberships?: Array<{ id: string; workspace_id: string; role: string; workspace_status: string }>;
  switchMembership?: { role: string; workspace: { status: string } } | null;
  invitation?: {
    id: string;
    workspace_id: string;
    email: string;
    role: string;
    expires_at: Date;
    accepted_at: Date | null;
    workspace_status: string;
  } | null;
} = {}) {
  const prismaObj: Record<string, unknown> = {
    user: {
      findUnique: vi.fn(async () => ({
        id: USER_ID,
        email: 'user@example.test',
        passwordHash: overrides.passwordHash ?? 'hash',
        status: overrides.userStatus ?? 'active',
      })),
      create: vi.fn(),
    },
    membership: {
      findFirst: vi.fn(async () => overrides.switchMembership ?? null),
    },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join(' ');
      if (sql.includes('app_find_login_membership')) {
        return overrides.memberships ?? [];
      }
      if (sql.includes('app_lookup_invitation_by_token')) {
        return overrides.invitation ? [overrides.invitation] : [];
      }
      if (sql.includes('app_list_user_workspaces')) {
        return (overrides.memberships ?? [])
          .filter((m) => m.workspace_status === 'ACTIVE')
          .map((m) => ({
            workspace_id: m.workspace_id,
            workspace_name: 'Active Co',
            workspace_status: m.workspace_status,
            role: m.role,
          }));
      }
      return [];
    }),
  };
  prismaObj.withWorkspace = vi.fn(async (_wid: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn(prismaObj),
  );
  const sessions = {
    issue: vi.fn(async (_uid: string, workspaceId: string, role: string) => ({
      token: 'tok',
      claims: { userId: USER_ID, workspaceId, role, jti: 'jti-new', exp: 9_999_999_999 },
    })),
    revoke: vi.fn(async () => undefined),
    cookieOptions: vi.fn(() => ({})),
    clearCookieOptions: vi.fn(() => ({})),
    ttl: 3600,
  };
  const audit = { record: vi.fn(async () => undefined) };
  const service = new AuthService(
    { INVITE_CODE: undefined } as never,
    prismaObj as unknown as PrismaService,
    sessions as never,
    audit as never,
  );
  return { service, prismaObj, sessions, audit };
}

describe('Auth & Workspaces ACTIVE status enforcement', () => {
  it('login skips DISABLED/ARCHIVED workspace and logs into the ACTIVE workspace', async () => {
    const passwordHash = await argon2.hash('Pass123456!');
    const { service, sessions } = makeAuthHarness({
      passwordHash,
      memberships: [
        { id: 'm-dis', workspace_id: WS_DISABLED, role: 'admin', workspace_status: 'DISABLED' },
        { id: 'm-act', workspace_id: WS_ACTIVE, role: 'member', workspace_status: 'ACTIVE' },
      ],
    });
    const out = await service.login({ email: 'user@example.test', password: 'Pass123456!' });
    expect(out.membership).toEqual({ id: 'm-act', workspaceId: WS_ACTIVE, role: 'member' });
    expect(sessions.issue).toHaveBeenCalledWith(USER_ID, WS_ACTIVE, 'member');
  });

  it('login throws 403 WORKSPACE_DISABLED when all workspaces are DISABLED/ARCHIVED', async () => {
    const passwordHash = await argon2.hash('Pass123456!');
    for (const status of ['DISABLED', 'ARCHIVED'] as const) {
      const { service, sessions } = makeAuthHarness({
        passwordHash,
        memberships: [
          { id: 'm-1', workspace_id: WS_DISABLED, role: 'admin', workspace_status: status },
        ],
      });
      const err = await service
        .login({ email: 'user@example.test', password: 'Pass123456!' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        error: { code: 'WORKSPACE_DISABLED' },
      });
      expect(sessions.issue).not.toHaveBeenCalled();
    }
  });

  it('login preserves 401 AUTH_FAILED on bad password even when workspace is DISABLED', async () => {
    const passwordHash = await argon2.hash('Pass123456!');
    const { service } = makeAuthHarness({
      passwordHash,
      memberships: [
        { id: 'm-1', workspace_id: WS_DISABLED, role: 'admin', workspace_status: 'DISABLED' },
      ],
    });
    const err = await service
      .login({ email: 'user@example.test', password: 'WrongPassword1' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).getResponse()).toMatchObject({
      error: { code: 'AUTH_FAILED' },
    });
  });

  it('switchWorkspace rejects non-ACTIVE workspace with 403 WORKSPACE_DISABLED before revoking current session', async () => {
    const { service, sessions } = makeAuthHarness({
      switchMembership: { role: 'admin', workspace: { status: 'DISABLED' } },
    });
    const err = await service.switchWorkspace(USER_ID, 'jti-curr', WS_DISABLED).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({
      error: { code: 'WORKSPACE_DISABLED' },
    });
    expect(sessions.revoke).not.toHaveBeenCalled();
    expect(sessions.issue).not.toHaveBeenCalled();
  });

  it('acceptInvitation rejects invitation belonging to a DISABLED/ARCHIVED workspace with 403 WORKSPACE_DISABLED', async () => {
    const { service } = makeAuthHarness({
      invitation: {
        id: 'inv-1',
        workspace_id: WS_DISABLED,
        email: 'invitee@example.test',
        role: 'member',
        expires_at: new Date(Date.now() + 60_000),
        accepted_at: null,
        workspace_status: 'ARCHIVED',
      },
    });
    const err = await service
      .acceptInvitation({ token: 'tok-1', password: 'Password1234' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({
      error: { code: 'WORKSPACE_DISABLED' },
    });
  });

  it('AuthController.session and WorkspacesController.list return only ACTIVE memberships via app_list_user_workspaces', async () => {
    const { service, prismaObj, sessions } = makeAuthHarness({
      memberships: [
        { id: 'm-dis', workspace_id: WS_DISABLED, role: 'admin', workspace_status: 'DISABLED' },
        { id: 'm-act', workspace_id: WS_ACTIVE, role: 'admin', workspace_status: 'ACTIVE' },
      ],
    });
    const authCtrl = new AuthController(
      service,
      sessions as never,
      prismaObj as unknown as PrismaService,
      {} as never,
    );
    const req = {
      tenant: {
        userId: USER_ID,
        workspaceId: WS_ACTIVE,
        role: 'admin',
        jti: 'j-1',
        exp: 9_999_999_999,
        onboardingCompleted: true,
        onboardingCompanyId: null,
      },
    } as unknown as Request;
    const sessionRes = await authCtrl.session(req);
    expect(sessionRes.data.workspaces).toEqual([
      { id: WS_ACTIVE, name: 'Active Co', role: 'admin' },
    ]);

    const wsCtrl = new WorkspacesController(
      prismaObj as unknown as PrismaService,
      { record: vi.fn(async () => undefined) } as never,
      sessions as never,
    );
    const listRes = await wsCtrl.list(req);
    expect(listRes.data).toEqual([
      { id: WS_ACTIVE, name: 'Active Co', role: 'admin', current: true },
    ]);
  });

  it('WorkspacesController.rename and leave reject non-ACTIVE workspace with 403 WORKSPACE_DISABLED', async () => {
    const prismaObj: Record<string, unknown> = {
      $executeRaw: vi.fn(async () => 0),
      membership: {
        findFirst: vi.fn(async () => ({
          id: 'm-1',
          userId: USER_ID,
          workspaceId: WS_DISABLED,
          role: 'admin',
          status: 'active',
          workspace: { status: 'DISABLED' },
        })),
      },
    };
    prismaObj.withWorkspace = vi.fn(async (_wid: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn(prismaObj),
    );
    const wsCtrl = new WorkspacesController(
      prismaObj as unknown as PrismaService,
      { record: vi.fn(async () => undefined) } as never,
      { revoke: vi.fn(), clearCookieOptions: vi.fn(() => ({})) } as never,
    );
    const req = {
      tenant: {
        userId: USER_ID,
        workspaceId: WS_ACTIVE,
        role: 'admin',
        jti: 'j-1',
        exp: 9_999_999_999,
        onboardingCompleted: true,
        onboardingCompanyId: null,
      },
    } as unknown as Request;

    await expect(wsCtrl.rename(req, WS_DISABLED, { name: 'New Name' })).rejects.toMatchObject({
      status: 403,
      response: { error: { code: 'WORKSPACE_DISABLED' } },
    });
    await expect(wsCtrl.leave(req, {} as Response, WS_DISABLED)).rejects.toMatchObject({
      status: 403,
      response: { error: { code: 'WORKSPACE_DISABLED' } },
    });
  });
});
