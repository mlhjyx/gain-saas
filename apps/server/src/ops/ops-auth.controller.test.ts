import * as argon2 from 'argon2';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { OpsAuthController } from './ops-auth.controller.js';
import { OPS_SESSION_COOKIE } from './ops-session.service.js';

describe('OpsAuthController cookies', () => {
  it('login sets cookie with sessions.cookieOptions and logout clears cookie with sessions.clearCookieOptions', async () => {
    const passwordHash = await argon2.hash('correct-horse-battery');
    const cookieOpts = { httpOnly: true, sameSite: 'lax' as const, path: '/', secure: true, maxAge: 28_800_000 };
    const clearOpts = { httpOnly: true, sameSite: 'lax' as const, path: '/', secure: true };
    const sessions = {
      ttlSecondsValue: 28_800,
      issue: vi.fn(async () => ({ token: 'ops-jwt', exp: 999999 })),
      verify: vi.fn(async () => ({ opsUserId: 'ops-1', jti: 'jti-ops', exp: 999999 })),
      revoke: vi.fn(async () => undefined),
      cookieOptions: vi.fn(() => cookieOpts),
      clearCookieOptions: vi.fn(() => clearOpts),
    };
    const prisma = {
      opsUser: {
        findUnique: vi.fn(async () => ({ id: 'ops-1', email: 'op@example.com', status: 'active', passwordHash })),
      },
    };
    const audit = { record: vi.fn(async () => undefined) };
    const throttle = {
      check: vi.fn(async () => undefined),
      hit: vi.fn(async () => undefined),
      success: vi.fn(async () => undefined),
    };
    const controller = new OpsAuthController(sessions as never, prisma as never, audit as never, throttle as never);

    const loginRes = { cookie: vi.fn() } as unknown as Response;
    await controller.login(
      { email: 'op@example.com', password: 'correct-horse-battery' },
      { ip: '127.0.0.1' } as unknown as Request,
      loginRes,
    );
    expect(loginRes.cookie).toHaveBeenCalledWith(OPS_SESSION_COOKIE, 'ops-jwt', cookieOpts);

    const logoutRes = { clearCookie: vi.fn() } as unknown as Response;
    await controller.logout(
      {
        cookies: { [OPS_SESSION_COOKIE]: 'ops-jwt' },
        opsUser: { id: 'ops-1', email: 'op@example.com' },
      } as unknown as Request,
      logoutRes,
    );
    expect(sessions.revoke).toHaveBeenCalledWith('jti-ops');
    expect(logoutRes.clearCookie).toHaveBeenCalledWith(OPS_SESSION_COOKIE, clearOpts);
  });
});
