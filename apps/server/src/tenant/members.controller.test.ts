import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
  type ArgumentsHost,
} from '@nestjs/common';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { GlobalHttpExceptionFilter } from '../shared/http-exception.filter.js';
import { MembersController } from './members.controller.js';

const WS_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_USER_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_USER_ID = '33333333-3333-4333-8333-333333333333';
const TARGET_MEMBERSHIP_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_WS_ID = '55555555-5555-4555-8555-555555555555';

function makeReq(userId = ADMIN_USER_ID): Request {
  return {
    tenant: {
      userId,
      workspaceId: WS_ID,
      role: 'admin',
      jti: 'jti-admin',
      exp: 9_999_999_999,
      onboardingCompleted: true,
      onboardingCompanyId: null,
    },
  } as unknown as Request;
}

function runThroughExceptionFilter(err: unknown) {
  const filter = new GlobalHttpExceptionFilter();
  let capturedStatus: number | undefined;
  let capturedBody: unknown;
  const res = {
    status(code: number) {
      capturedStatus = code;
      return {
        json(payload: unknown) {
          capturedBody = payload;
        },
      };
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ headers: {} }),
      getResponse: () => res,
    }),
  } as unknown as ArgumentsHost;
  filter.catch(err, host);
  return { status: capturedStatus, body: capturedBody as { error?: { code?: string; message?: string; userCopy?: { title?: string; why?: string; next?: string } } } };
}

describe('MembersController', () => {
  describe('6 fixed business error status codes (never 401)', () => {
    it('changeRole: invalid role -> 400 BadRequestException VALIDATION_ERROR + userCopy', async () => {
      const controller = new MembersController({} as never, {} as never);
      const err = await controller.changeRole(TARGET_MEMBERSHIP_ID, { role: 'owner' }, makeReq()).catch((e: unknown) => e);

      expect(err).not.toBeInstanceOf(UnauthorizedException);
      expect(err).toBeInstanceOf(BadRequestException);
      const filtered = runThroughExceptionFilter(err);
      expect(filtered.status).toBe(400);
      expect(filtered.body.error?.code).toBe('VALIDATION_ERROR');
      expect(filtered.body.error?.userCopy?.title).toBeTruthy();
    });

    it('changeRole: missing membership -> 404 NotFoundException NOT_FOUND + userCopy', async () => {
      const prisma: Record<string, unknown> = {
        $executeRaw: vi.fn(async () => 0),
        membership: {
          findFirst: vi.fn(async () => null),
        },
        withWorkspace: vi.fn(async (_wid: string, fn: (tx: unknown) => unknown) => fn(prisma)),
      };
      const controller = new MembersController(prisma as never, {} as never);
      const err = await controller.changeRole(TARGET_MEMBERSHIP_ID, { role: 'member' }, makeReq()).catch((e: unknown) => e);

      expect(err).not.toBeInstanceOf(UnauthorizedException);
      expect(err).toBeInstanceOf(NotFoundException);
      const filtered = runThroughExceptionFilter(err);
      expect(filtered.status).toBe(404);
      expect(filtered.body.error?.code).toBe('NOT_FOUND');
      expect(filtered.body.error?.userCopy?.title).toBeTruthy();
    });

    it('changeRole: demoting last admin -> 409 ConflictException LAST_ADMIN + userCopy', async () => {
      const prisma: Record<string, unknown> = {
        $executeRaw: vi.fn(async () => 0),
        membership: {
          findFirst: vi.fn(async () => ({ id: TARGET_MEMBERSHIP_ID, userId: TARGET_USER_ID, workspaceId: WS_ID, role: 'admin', status: 'active' })),
          count: vi.fn(async () => 1),
        },
        withWorkspace: vi.fn(async (_wid: string, fn: (tx: unknown) => unknown) => fn(prisma)),
      };
      const controller = new MembersController(prisma as never, {} as never);
      const err = await controller.changeRole(TARGET_MEMBERSHIP_ID, { role: 'member' }, makeReq()).catch((e: unknown) => e);

      expect(err).not.toBeInstanceOf(UnauthorizedException);
      expect(err).toBeInstanceOf(ConflictException);
      const filtered = runThroughExceptionFilter(err);
      expect(filtered.status).toBe(409);
      expect(filtered.body.error?.code).toBe('LAST_ADMIN');
      expect(filtered.body.error?.userCopy?.title).toBeTruthy();
    });

    it('remove: missing membership -> 404 NotFoundException NOT_FOUND + userCopy', async () => {
      const prisma: Record<string, unknown> = {
        $executeRaw: vi.fn(async () => 0),
        membership: {
          findFirst: vi.fn(async () => null),
        },
        withWorkspace: vi.fn(async (_wid: string, fn: (tx: unknown) => unknown) => fn(prisma)),
      };
      const controller = new MembersController(prisma as never, {} as never);
      const err = await controller.remove(TARGET_MEMBERSHIP_ID, makeReq()).catch((e: unknown) => e);

      expect(err).not.toBeInstanceOf(UnauthorizedException);
      expect(err).toBeInstanceOf(NotFoundException);
      const filtered = runThroughExceptionFilter(err);
      expect(filtered.status).toBe(404);
      expect(filtered.body.error?.code).toBe('NOT_FOUND');
      expect(filtered.body.error?.userCopy?.title).toBeTruthy();
    });

    it('remove: removing self -> 400 BadRequestException SELF_REMOVAL + userCopy', async () => {
      const prisma: Record<string, unknown> = {
        $executeRaw: vi.fn(async () => 0),
        membership: {
          findFirst: vi.fn(async () => ({ id: TARGET_MEMBERSHIP_ID, userId: ADMIN_USER_ID, workspaceId: WS_ID, role: 'admin', status: 'active' })),
        },
        withWorkspace: vi.fn(async (_wid: string, fn: (tx: unknown) => unknown) => fn(prisma)),
      };
      const controller = new MembersController(prisma as never, {} as never);
      const err = await controller.remove(TARGET_MEMBERSHIP_ID, makeReq(ADMIN_USER_ID)).catch((e: unknown) => e);

      expect(err).not.toBeInstanceOf(UnauthorizedException);
      expect(err).toBeInstanceOf(BadRequestException);
      const filtered = runThroughExceptionFilter(err);
      expect(filtered.status).toBe(400);
      expect(filtered.body.error?.code).toBe('SELF_REMOVAL');
      expect(filtered.body.error?.userCopy?.title).toBeTruthy();
    });

    it('remove: removing last admin -> 409 ConflictException LAST_ADMIN + userCopy', async () => {
      const prisma: Record<string, unknown> = {
        $executeRaw: vi.fn(async () => 0),
        membership: {
          findFirst: vi.fn(async () => ({ id: TARGET_MEMBERSHIP_ID, userId: TARGET_USER_ID, workspaceId: WS_ID, role: 'admin', status: 'active' })),
          count: vi.fn(async () => 1),
        },
        withWorkspace: vi.fn(async (_wid: string, fn: (tx: unknown) => unknown) => fn(prisma)),
      };
      const controller = new MembersController(prisma as never, {} as never);
      const err = await controller.remove(TARGET_MEMBERSHIP_ID, makeReq(ADMIN_USER_ID)).catch((e: unknown) => e);

      expect(err).not.toBeInstanceOf(UnauthorizedException);
      expect(err).toBeInstanceOf(ConflictException);
      const filtered = runThroughExceptionFilter(err);
      expect(filtered.status).toBe(409);
      expect(filtered.body.error?.code).toBe('LAST_ADMIN');
      expect(filtered.body.error?.userCopy?.title).toBeTruthy();
    });
  });

  describe('happy paths & transactional session revocation', () => {
    it('changeRole updates role and records audit log', async () => {
      const membership = {
        findFirst: vi.fn(async () => ({ id: TARGET_MEMBERSHIP_ID, userId: TARGET_USER_ID, workspaceId: WS_ID, role: 'member', status: 'active' })),
        update: vi.fn(async () => ({ id: TARGET_MEMBERSHIP_ID, role: 'admin' })),
      };
      const auditLog = {
        create: vi.fn(async () => ({ id: 'audit-1' })),
      };
      const prisma: Record<string, unknown> = {
        $executeRaw: vi.fn(async () => 0),
        membership,
        auditLog,
        withWorkspace: vi.fn(async (_wid: string, fn: (tx: unknown) => unknown) => fn(prisma)),
      };
      const controller = new MembersController(prisma as never, {} as never);
      const result = await controller.changeRole(TARGET_MEMBERSHIP_ID, { role: 'admin' }, makeReq());

      expect(result).toEqual({ data: { id: TARGET_MEMBERSHIP_ID, role: 'admin' } });
      expect(membership.update).toHaveBeenCalledWith({
        where: { id: TARGET_MEMBERSHIP_ID },
        data: { role: 'admin' },
      });
      expect(auditLog.create).toHaveBeenCalledWith({
        data: { realm: 'tenant', actorId: ADMIN_USER_ID, workspaceId: WS_ID, action: 'members.change_role', target: TARGET_MEMBERSHIP_ID, detail: { role: 'admin' } },
      });
    });

    it('remove atomically removes membership, revokes target sessions for current workspace + legacy null (leaving other workspaces intact), and writes audit log', async () => {
      const sessions = [
        { jti: 's-curr', realm: 'tenant', subjectType: 'user', subjectId: TARGET_USER_ID, workspaceId: WS_ID, revokedAt: null as Date | null },
        { jti: 's-legacy', realm: 'tenant', subjectType: 'user', subjectId: TARGET_USER_ID, workspaceId: null, revokedAt: null as Date | null },
        { jti: 's-other-ws', realm: 'tenant', subjectType: 'user', subjectId: TARGET_USER_ID, workspaceId: OTHER_WS_ID, revokedAt: null as Date | null },
        { jti: 's-other-user', realm: 'tenant', subjectType: 'user', subjectId: ADMIN_USER_ID, workspaceId: WS_ID, revokedAt: null as Date | null },
      ];
      const tx = {
        $executeRaw: vi.fn(async () => 0),
        membership: {
          findFirst: vi.fn(async () => ({ id: TARGET_MEMBERSHIP_ID, userId: TARGET_USER_ID, workspaceId: WS_ID, role: 'member', status: 'active' })),
          update: vi.fn(async () => ({ id: TARGET_MEMBERSHIP_ID, status: 'removed' })),
        },
        session: {
          updateMany: vi.fn(async ({ where, data }: { where: { realm: string; subjectType: string; subjectId: string; revokedAt: null; OR: Array<{ workspaceId: string | null }> }; data: { revokedAt: Date } }) => {
            let count = 0;
            for (const row of sessions) {
              const matchesWs = where.OR.some((clause) => row.workspaceId === clause.workspaceId);
              if (row.realm === where.realm && row.subjectType === where.subjectType && row.subjectId === where.subjectId && row.revokedAt === null && matchesWs) {
                row.revokedAt = data.revokedAt;
                count += 1;
              }
            }
            return { count };
          }),
        },
        auditLog: {
          create: vi.fn(async () => ({ id: 'audit-2' })),
        },
      };
      const prisma = {
        withWorkspace: vi.fn(async (_wid: string, fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
      };
      const controller = new MembersController(prisma as never, {} as never);
      const result = await controller.remove(TARGET_MEMBERSHIP_ID, makeReq());

      expect(result).toEqual({ data: { ok: true } });
      expect(prisma.withWorkspace).toHaveBeenCalledWith(WS_ID, expect.any(Function));
      expect(tx.membership.update).toHaveBeenCalledWith({
        where: { id: TARGET_MEMBERSHIP_ID },
        data: { status: 'removed' },
      });
      expect(tx.session.updateMany).toHaveBeenCalledWith({
        where: {
          realm: 'tenant',
          subjectType: 'user',
          subjectId: TARGET_USER_ID,
          revokedAt: null,
          OR: [{ workspaceId: WS_ID }, { workspaceId: null }],
        },
        data: { revokedAt: expect.any(Date) },
      });
      expect(sessions.find((s) => s.jti === 's-curr')?.revokedAt).toBeInstanceOf(Date);
      expect(sessions.find((s) => s.jti === 's-legacy')?.revokedAt).toBeInstanceOf(Date);
      expect(sessions.find((s) => s.jti === 's-other-ws')?.revokedAt).toBeNull();
      expect(sessions.find((s) => s.jti === 's-other-user')?.revokedAt).toBeNull();
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: { realm: 'tenant', actorId: ADMIN_USER_ID, workspaceId: WS_ID, action: 'members.remove', target: TARGET_MEMBERSHIP_ID },
      });
    });
  });
});
