import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { AuditService } from '../shared/audit.service.js';
import type { PrismaService } from '../shared/prisma.service.js';
import { WorkspaceOffboardingService } from './workspace-offboarding.service.js';

const USER_ADMIN = '11111111-1111-4111-8111-111111111111';
const USER_MEMBER = '22222222-2222-4222-8222-222222222222';
const WS_ID = '33333333-3333-4333-8333-333333333333';
const REQ_ID = '44444444-4444-4444-8444-444444444444';

function makeHarness(options: {
  role?: 'admin' | 'member';
  workspaceStatus?: 'ACTIVE' | 'DISABLED' | 'ARCHIVED';
  workspaceName?: string;
  existingRequest?: {
    id: string;
    workspaceId: string;
    status: string;
    requestedBy: string;
    reason: string | null;
    requestedAt: Date;
    coolOffEndsAt: Date;
    cancelledBy: string | null;
    cancelledAt: Date | null;
    purgedBy: string | null;
    purgedAt: Date | null;
  } | null;
} = {}) {
  const createdRows: Array<Record<string, unknown>> = [];
  const tx = {
    membership: {
      findFirst: vi.fn(async () => ({
        id: 'm-1',
        userId: options.role === 'member' ? USER_MEMBER : USER_ADMIN,
        workspaceId: WS_ID,
        role: options.role ?? 'admin',
        status: 'active',
        workspace: {
          id: WS_ID,
          name: options.workspaceName ?? 'Acme Export Co',
          status: options.workspaceStatus ?? 'ACTIVE',
        },
      })),
    },
    workspaceOffboardingRequest: {
      findFirst: vi.fn(async () => options.existingRequest ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: REQ_ID,
          ...data,
          cancelledBy: null,
          cancelledAt: null,
          purgedBy: null,
          purgedAt: null,
          updatedAt: new Date(),
        };
        createdRows.push(row);
        return row;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...options.existingRequest,
        ...data,
        updatedAt: new Date(),
      })),
    },
  };
  const prisma = {
    withWorkspace: vi.fn(async (_wid: string, fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  const config = { WORKSPACE_OFFBOARDING_COOL_OFF_DAYS: 7 } as AppConfig;
  const service = new WorkspaceOffboardingService(prisma, audit, config);
  return { service, tx, audit, createdRows };
}

describe('WorkspaceOffboardingService (7-day cooling-off)', () => {
  it('allows workspace admin to schedule offboarding with a 7-day cooling-off window and records audit', async () => {
    const { service, tx, audit } = makeHarness({ role: 'admin', workspaceName: 'Acme Export Co' });
    const now = new Date('2026-11-26T10:00:00.000Z');

    const result = await service.requestOffboarding(
      { userId: USER_ADMIN, workspaceId: WS_ID, role: 'admin' },
      WS_ID,
      { confirmName: 'Acme Export Co', reason: 'Contract ended' },
      now,
    );

    expect(tx.workspaceOffboardingRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: WS_ID,
        status: 'SCHEDULED',
        requestedBy: USER_ADMIN,
        reason: 'Contract ended',
        requestedAt: now,
        coolOffEndsAt: new Date('2026-12-03T10:00:00.000Z'),
      }),
    });
    expect(result).toMatchObject({
      id: REQ_ID,
      workspaceId: WS_ID,
      status: 'SCHEDULED',
      coolOffEndsAt: '2026-12-03T10:00:00.000Z',
      canCancel: true,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        realm: 'tenant',
        actorId: USER_ADMIN,
        workspaceId: WS_ID,
        action: 'workspaces.offboarding.request',
      }),
    );
  });

  it('rejects member role (403), mismatched confirmName (400), and duplicate active request (409)', async () => {
    const memberH = makeHarness({ role: 'member' });
    await expect(
      memberH.service.requestOffboarding({ userId: USER_MEMBER, workspaceId: WS_ID, role: 'member' }, WS_ID, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const mismatchH = makeHarness({ role: 'admin', workspaceName: 'Acme Export Co' });
    await expect(
      mismatchH.service.requestOffboarding(
        { userId: USER_ADMIN, workspaceId: WS_ID, role: 'admin' },
        WS_ID,
        { confirmName: 'Wrong Name' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    const dupH = makeHarness({
      role: 'admin',
      existingRequest: {
        id: REQ_ID,
        workspaceId: WS_ID,
        status: 'SCHEDULED',
        requestedBy: USER_ADMIN,
        reason: null,
        requestedAt: new Date('2026-11-26T00:00:00Z'),
        coolOffEndsAt: new Date('2026-12-03T00:00:00Z'),
        cancelledBy: null,
        cancelledAt: null,
        purgedBy: null,
        purgedAt: null,
      },
    });
    await expect(
      dupH.service.requestOffboarding({ userId: USER_ADMIN, workspaceId: WS_ID, role: 'admin' }, WS_ID, {}),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('cancels a SCHEDULED request within the cooling-off window and rejects cancel after cooling-off expires', async () => {
    const scheduled = {
      id: REQ_ID,
      workspaceId: WS_ID,
      status: 'SCHEDULED',
      requestedBy: USER_ADMIN,
      reason: 'Closing',
      requestedAt: new Date('2026-11-26T00:00:00Z'),
      coolOffEndsAt: new Date('2026-12-03T00:00:00Z'),
      cancelledBy: null,
      cancelledAt: null,
      purgedBy: null,
      purgedAt: null,
    };

    const withinH = makeHarness({ role: 'admin', existingRequest: scheduled });
    const cancelled = await withinH.service.cancelOffboarding(
      { userId: USER_ADMIN, workspaceId: WS_ID, role: 'admin' },
      WS_ID,
      new Date('2026-11-30T00:00:00Z'),
    );
    expect(cancelled).toMatchObject({ id: REQ_ID, status: 'CANCELLED', canCancel: false });
    expect(withinH.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workspaces.offboarding.cancel' }),
    );

    const expiredH = makeHarness({ role: 'admin', existingRequest: scheduled });
    await expect(
      expiredH.service.cancelOffboarding(
        { userId: USER_ADMIN, workspaceId: WS_ID, role: 'admin' },
        WS_ID,
        new Date('2026-12-04T00:00:00Z'),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const noneH = makeHarness({ role: 'admin', existingRequest: null });
    await expect(
      noneH.service.cancelOffboarding({ userId: USER_ADMIN, workspaceId: WS_ID, role: 'admin' }, WS_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getStatus returns null when no request exists and exposes cooling-off metadata when scheduled', async () => {
    const emptyH = makeHarness({ role: 'member', existingRequest: null });
    expect(await emptyH.service.getStatus({ userId: USER_MEMBER, workspaceId: WS_ID, role: 'member' }, WS_ID)).toBeNull();

    const activeH = makeHarness({
      role: 'member',
      existingRequest: {
        id: REQ_ID,
        workspaceId: WS_ID,
        status: 'SCHEDULED',
        requestedBy: USER_ADMIN,
        reason: 'Done',
        requestedAt: new Date('2026-11-26T00:00:00Z'),
        coolOffEndsAt: new Date('2026-12-03T00:00:00Z'),
        cancelledBy: null,
        cancelledAt: null,
        purgedBy: null,
        purgedAt: null,
      },
    });
    const status = await activeH.service.getStatus(
      { userId: USER_MEMBER, workspaceId: WS_ID, role: 'member' },
      WS_ID,
      new Date('2026-11-28T00:00:00Z'),
    );
    expect(status).toMatchObject({
      id: REQ_ID,
      status: 'SCHEDULED',
      canCancel: true,
      remainingDays: 5,
    });
  });
});
