import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { SessionService } from '../tenant/session.service.js';
import { OpsSessionService } from './ops-session.service.js';

const TENANT_SECRET = 'tenant-session-secret-0123456789abcdef0123';
const OPS_SECRET = 'ops-session-secret-fedcba9876543210fedcba';

function makePrisma() {
  const rows = new Map<
    string,
    {
      jti: string;
      realm: string;
      subjectType: string;
      subjectId: string;
      workspaceId: string | null;
      expiresAt: Date;
      revokedAt: Date | null;
    }
  >();
  const prisma = {
    session: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          jti: data.jti as string,
          realm: data.realm as string,
          subjectType: data.subjectType as string,
          subjectId: data.subjectId as string,
          workspaceId: (data.workspaceId as string | null | undefined) ?? null,
          expiresAt: data.expiresAt as Date,
          revokedAt: null,
        };
        rows.set(row.jti, row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { jti: string } }) => rows.get(where.jti) ?? null),
      updateMany: vi.fn(async ({ where, data }: { where: { jti: string }; data: { revokedAt: Date } }) => {
        const row = rows.get(where.jti);
        if (!row) return { count: 0 };
        row.revokedAt = data.revokedAt;
        return { count: 1 };
      }),
    },
  };
  return { prisma, rows };
}

describe('OpsSessionService', () => {
  it('issue() + verify() works with distinct OPS_SESSION_SECRET and isolates from tenant SessionService', async () => {
    const { prisma } = makePrisma();
    const config = {
      NODE_ENV: 'production',
      SESSION_SECRET: TENANT_SECRET,
      OPS_SESSION_SECRET: OPS_SECRET,
      SESSION_TTL_MINUTES: 60,
      OPS_SESSION_TTL_MINUTES: 480,
    } as AppConfig;

    const opsSessions = new OpsSessionService(config, prisma as never);
    const tenantSessions = new SessionService(config, prisma as never);

    const { token: opsToken } = await opsSessions.issue('ops-1');
    const { token: tenantToken } = await tenantSessions.issue(
      'user-1',
      '11111111-1111-4111-8111-111111111111',
      'admin',
    );

    await expect(opsSessions.verify(opsToken)).resolves.toMatchObject({ opsUserId: 'ops-1' });
    await expect(opsSessions.verify(tenantToken)).resolves.toBeNull();
    await expect(tenantSessions.verify(opsToken)).resolves.toBeNull();
  });

  it('non-prod HKDF fallback isolates ops tokens from raw SESSION_SECRET', async () => {
    const { prisma } = makePrisma();
    const config = {
      NODE_ENV: 'development',
      SESSION_SECRET: TENANT_SECRET,
      OPS_SESSION_SECRET: undefined,
      SESSION_TTL_MINUTES: 60,
      OPS_SESSION_TTL_MINUTES: 480,
    } as AppConfig;

    const opsSessions = new OpsSessionService(config, prisma as never);
    const tenantSessions = new SessionService(config, prisma as never);

    const { token: opsToken } = await opsSessions.issue('ops-1');
    const { token: tenantToken } = await tenantSessions.issue(
      'user-1',
      '11111111-1111-4111-8111-111111111111',
      'admin',
    );

    await expect(opsSessions.verify(opsToken)).resolves.toMatchObject({ opsUserId: 'ops-1' });
    await expect(opsSessions.verify(tenantToken)).resolves.toBeNull();
    await expect(tenantSessions.verify(opsToken)).resolves.toBeNull();
  });

  it('fails closed in production if OPS_SESSION_SECRET is missing, short, or equals SESSION_SECRET', () => {
    const { prisma } = makePrisma();
    expect(
      () =>
        new OpsSessionService(
          { NODE_ENV: 'production', SESSION_SECRET: TENANT_SECRET, OPS_SESSION_TTL_MINUTES: 480 } as AppConfig,
          prisma as never,
        ),
    ).toThrow(/OPS_SESSION_SECRET/);

    expect(
      () =>
        new OpsSessionService(
          {
            NODE_ENV: 'production',
            SESSION_SECRET: TENANT_SECRET,
            OPS_SESSION_SECRET: TENANT_SECRET,
            OPS_SESSION_TTL_MINUTES: 480,
          } as AppConfig,
          prisma as never,
        ),
    ).toThrow(/OPS_SESSION_SECRET/);

    expect(
      () =>
        new OpsSessionService(
          {
            NODE_ENV: 'development',
            SESSION_SECRET: TENANT_SECRET,
            OPS_SESSION_SECRET: TENANT_SECRET,
            OPS_SESSION_TTL_MINUTES: 480,
          } as AppConfig,
          prisma as never,
        ),
    ).toThrow(/OPS_SESSION_SECRET/);
  });

  it('cookieOptions() & clearCookieOptions() return secure=true in production and secure=false otherwise', () => {
    const { prisma } = makePrisma();
    const dev = new OpsSessionService(
      { NODE_ENV: 'development', SESSION_SECRET: TENANT_SECRET, OPS_SESSION_TTL_MINUTES: 480 } as AppConfig,
      prisma as never,
    );
    expect(dev.clearCookieOptions()).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: false,
    });
    expect(dev.cookieOptions(300)).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: false,
      maxAge: 300_000,
    });

    const prod = new OpsSessionService(
      {
        NODE_ENV: 'production',
        SESSION_SECRET: TENANT_SECRET,
        OPS_SESSION_SECRET: OPS_SECRET,
        OPS_SESSION_TTL_MINUTES: 480,
      } as AppConfig,
      prisma as never,
    );
    expect(prod.clearCookieOptions()).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: true,
    });
    expect(prod.cookieOptions(300)).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: true,
      maxAge: 300_000,
    });
  });
});
