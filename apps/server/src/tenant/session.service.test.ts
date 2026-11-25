import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { SessionService } from './session.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const WS_1 = '22222222-2222-4222-8222-222222222222';
const WS_2 = '33333333-3333-4333-8333-333333333333';

function makeService(rows: Map<string, {
  jti: string;
  realm: string;
  subjectType: string;
  subjectId: string;
  workspaceId: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
}> = new Map()) {
  const prisma = {
    session: {
      create: vi.fn(async ({ data }: { data: { jti: string; realm: string; subjectType: string; subjectId: string; workspaceId?: string | null; expiresAt: Date } }) => {
        const row = {
          jti: data.jti,
          realm: data.realm,
          subjectType: data.subjectType,
          subjectId: data.subjectId,
          workspaceId: data.workspaceId ?? null,
          expiresAt: data.expiresAt,
          revokedAt: null,
        };
        rows.set(data.jti, row);
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
  const config = {
    SESSION_SECRET: 'test-tenant-session-secret-0123456789abcdef',
    SESSION_TTL_MINUTES: 60,
  } as AppConfig;
  return { service: new SessionService(config, prisma as never), prisma, rows };
}

describe('SessionService', () => {
  it('issue() persists workspaceId on the session row and verify() accepts matching workspaceId', async () => {
    const { service, prisma, rows } = makeService();
    const { token, claims } = await service.issue(USER_ID, WS_1, 'admin');

    expect(claims.workspaceId).toBe(WS_1);
    expect(prisma.session.create).toHaveBeenCalledWith({
      data: {
        jti: claims.jti,
        realm: 'tenant',
        subjectType: 'user',
        subjectId: USER_ID,
        workspaceId: WS_1,
        expiresAt: expect.any(Date),
      },
    });
    expect(rows.get(claims.jti)?.workspaceId).toBe(WS_1);

    const verified = await service.verify(token);
    expect(verified).toMatchObject({ userId: USER_ID, workspaceId: WS_1, role: 'admin', jti: claims.jti });
  });

  it('verify() accepts legacy session rows where workspaceId is null', async () => {
    const { service, rows } = makeService();
    const { token, claims } = await service.issue(USER_ID, WS_1, 'member');
    rows.get(claims.jti)!.workspaceId = null;

    const verified = await service.verify(token);
    expect(verified).toMatchObject({ userId: USER_ID, workspaceId: WS_1, role: 'member', jti: claims.jti });
  });

  it('verify() rejects session when row.workspaceId does not match JWT wid', async () => {
    const { service, rows } = makeService();
    const { token, claims } = await service.issue(USER_ID, WS_1, 'admin');
    rows.get(claims.jti)!.workspaceId = WS_2;

    await expect(service.verify(token)).resolves.toBeNull();
  });

  it('verify() rejects session when row.realm is not tenant', async () => {
    const { service, rows } = makeService();
    const { token, claims } = await service.issue(USER_ID, WS_1, 'admin');
    rows.get(claims.jti)!.realm = 'ops';

    await expect(service.verify(token)).resolves.toBeNull();
  });

  it('verify() rejects revoked or expired sessions', async () => {
    const { service, rows } = makeService();
    const { token, claims } = await service.issue(USER_ID, WS_1, 'member');

    await service.revoke(claims.jti);
    await expect(service.verify(token)).resolves.toBeNull();

    rows.get(claims.jti)!.revokedAt = null;
    rows.get(claims.jti)!.expiresAt = new Date(Date.now() - 1000);
    await expect(service.verify(token)).resolves.toBeNull();
  });
});
