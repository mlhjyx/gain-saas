import { NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../shared/prisma.service.js';
import { ALLOWED_ACTIONS, WorkspaceContextController } from './workspace-context.controller.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const WS_ID = '22222222-2222-4222-8222-222222222222';
const COMPANY_ID = '44444444-4444-4444-8444-444444444444';

function makeTenantReq(role: 'admin' | 'member', onboardingCompleted = true): Request {
  return {
    tenant: {
      userId: USER_ID,
      workspaceId: WS_ID,
      role,
      jti: 'jti-ctx-1',
      exp: 9_999_999_999,
      onboardingCompleted,
      onboardingCompanyId: COMPANY_ID,
    },
    headers: {},
  } as unknown as Request;
}

function makePrisma(membership: unknown, user: unknown): PrismaService {
  const tx = {
    membership: {
      findFirst: vi.fn(async () => membership),
    },
  };
  return {
    withWorkspace: vi.fn(async (_wid: string, fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    user: {
      findUnique: vi.fn(async () => user),
    },
  } as unknown as PrismaService;
}

describe('WorkspaceContextController.context (GET /api/workspace/context)', () => {
  it('returns admin capability list without ghost reports.view while preserving response shape', async () => {
    const prisma = makePrisma(
      { role: 'admin', workspace: { id: WS_ID, name: 'Acme Export Co.' } },
      { id: USER_ID, email: 'admin@acme.example' },
    );
    const controller = new WorkspaceContextController(prisma);

    const res = await controller.context(makeTenantReq('admin', true));

    expect(ALLOWED_ACTIONS.admin).not.toContain('reports.view');
    expect(res).toEqual({
      data: {
        user: { id: USER_ID, email: 'admin@acme.example' },
        workspace: { id: WS_ID, name: 'Acme Export Co.', role: 'admin' },
        onboarding: { complete: true, companyId: COMPANY_ID },
        allowedActions: expect.arrayContaining([
          'workspace.rename',
          'workspace.leave',
          'members.manage',
          'company.manage',
          'acquisition.run',
          'leads.review',
          'qgo.manage',
          't0.outreach',
          'campaigns.view',
          'campaigns.draft',
          'campaigns.manage',
          'campaigns.approve',
          'outreach.view',
          'outreach.draft',
          'outreach.manage',
          'outreach.approve',
          'outreach.send',
          'outreach.warmup.view',
          'onboarding.complete',
        ]),
      },
    });
    expect(res.data.allowedActions).not.toContain('reports.view');
  });

  it('returns exact member read-only capability list aligned with AdminGuard and excludes reports.view', async () => {
    const prisma = makePrisma(
      { role: 'member', workspace: { id: WS_ID, name: 'Acme Export Co.' } },
      { id: USER_ID, email: 'member@acme.example' },
    );
    const controller = new WorkspaceContextController(prisma);

    const res = await controller.context(makeTenantReq('member', false));

    const expectedMemberActions = [
      'workspace.leave',
      'acquisition.run',
      'leads.review',
      'qgo.manage',
      't0.outreach',
      'campaigns.view',
      'outreach.view',
    ];
    expect(ALLOWED_ACTIONS.member).toEqual(expectedMemberActions);
    expect(res).toEqual({
      data: {
        user: { id: USER_ID, email: 'member@acme.example' },
        workspace: { id: WS_ID, name: 'Acme Export Co.', role: 'member' },
        onboarding: { complete: false, companyId: COMPANY_ID },
        allowedActions: expectedMemberActions,
      },
    });
    expect(res.data.allowedActions).not.toContain('reports.view');
    expect(res.data.allowedActions).not.toContain('campaigns.draft');
    expect(res.data.allowedActions).not.toContain('outreach.draft');
    expect(res.data.allowedActions).not.toContain('outreach.warmup.view');
  });

  it('throws NotFoundException when membership or user is missing and fails closed for unknown role', async () => {
    const missingPrisma = makePrisma(null, { id: USER_ID, email: 'ghost@acme.example' });
    const missingController = new WorkspaceContextController(missingPrisma);

    await expect(missingController.context(makeTenantReq('member'))).rejects.toBeInstanceOf(
      NotFoundException,
    );

    const unknownRolePrisma = makePrisma(
      { role: 'guest', workspace: { id: WS_ID, name: 'Acme Export Co.' } },
      { id: USER_ID, email: 'guest@acme.example' },
    );
    const unknownRoleController = new WorkspaceContextController(unknownRolePrisma);
    const res = await unknownRoleController.context(makeTenantReq('member'));

    expect(res.data.allowedActions).toEqual([]);
  });
});
