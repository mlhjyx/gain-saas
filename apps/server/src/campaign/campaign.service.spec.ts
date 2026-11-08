import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { PrismaService } from '../shared/prisma.service.js';
import type { AuditService } from '../shared/audit.service.js';
import { CampaignService, type CampaignTenant } from './campaign.service.js';
import type { CampaignTokenSigner } from './campaign-token.signer.js';
import { validPlan } from './campaign-plan.fixtures.js';

const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CAMPAIGN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REVISION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const APPROVAL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const AUTHORIZATION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ICP = '11111111-1111-4111-8111-111111111111';

const tenant: CampaignTenant = { userId: 'user-1', workspaceId: WORKSPACE, role: 'admin' };

function buildService() {
  const tx = {
    campaign: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: CAMPAIGN,
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      findFirst: vi.fn(),
      findMany: vi.fn(async () => []),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: CAMPAIGN, ...data })),
    },
    campaignRevision: {
      findFirst: vi.fn(),
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: REVISION,
        ...data,
        createdAt: new Date(),
      })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: REVISION,
        plan: validPlan(),
        planHash: 'h',
        ...data,
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    campaignAudience: { create: vi.fn(async () => ({ id: 'aud-1' })) },
    campaignApproval: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: APPROVAL,
        ...data,
        createdAt: new Date(),
      })),
      findFirst: vi.fn(),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: APPROVAL, ...data })),
    },
    campaignExecutionAuthorization: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: AUTHORIZATION, ...data })),
      findFirst: vi.fn(),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: AUTHORIZATION, ...data })),
      updateMany: vi.fn(async () => ({ count: 2 })),
    },
    campaignDecisionTrace: {
      create: vi.fn(async () => ({ id: 'trace-1' })),
      findMany: vi.fn(async () => []),
    },
    workspaceBudgetPolicy: { findUnique: vi.fn(async () => null) },
    workspace: { findUnique: vi.fn(async () => ({ status: 'ACTIVE' })) },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  const signer = {
    sign: vi.fn(async () => 'signed-token'),
    verify: vi.fn(),
  } as unknown as CampaignTokenSigner;
  const config = {
    CAMPAIGN_APPROVAL_TTL_HOURS: 72,
    CAMPAIGN_AUTHZ_TTL_MINUTES: 30,
    CAMPAIGN_AUDIENCE_SIZE_CAP_MAX: 1000,
    SESSION_SECRET: 'x'.repeat(32),
  } as AppConfig;
  const replan = { onApprovalDeclined: vi.fn(async () => undefined) };
  const service = new CampaignService(prisma, audit, signer, replan as never, config);
  return { service, tx, signer, audit, replan };
}

function pendingApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: APPROVAL,
    workspaceId: WORKSPACE,
    revisionId: REVISION,
    planHash: 'plan-hash',
    state: 'PENDING',
    requestedBy: 'user-1',
    expiresAt: new Date(Date.now() + 3600_000),
    revision: {
      id: REVISION,
      campaignId: CAMPAIGN,
      workspaceId: WORKSPACE,
      plan: validPlan(),
      planHash: 'plan-hash',
      state: 'SUBMITTED',
    },
    ...overrides,
  };
}

describe('CampaignService', () => {
  it('createRevision：合法计划 → 建 revision + audience + trace，指纹稳定', async () => {
    const { service, tx } = buildService();
    tx.campaign.findFirst.mockResolvedValue({ id: CAMPAIGN, status: 'DRAFT' });
    tx.campaignRevision.findFirst.mockResolvedValue(null);
    const revision = await service.createRevision(tenant, CAMPAIGN, validPlan());
    expect(revision.id).toBe(REVISION);
    expect(tx.campaignRevision.create).toHaveBeenCalledTimes(1);
    expect(tx.campaignAudience.create).toHaveBeenCalledTimes(1);
    expect(tx.campaignDecisionTrace.create).toHaveBeenCalledTimes(1);
    const createArg = tx.campaignRevision.create.mock.calls[0][0];
    expect(createArg.data.planHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('createRevision：非法计划 → CAMPAIGN_PLAN_INVALID（不落库）', async () => {
    const { service, tx } = buildService();
    await expect(
      service.createRevision(tenant, CAMPAIGN, validPlan({ audience: { icpIds: [ICP], sizeCap: 999999 } })),
    ).rejects.toMatchObject({ response: { error: { code: 'CAMPAIGN_PLAN_INVALID' } } });
    expect(tx.campaignRevision.create).not.toHaveBeenCalled();
  });

  it('createRevision：预算上限超过 workspace 配额 → 拒绝', async () => {
    const { service, tx } = buildService();
    tx.workspaceBudgetPolicy.findUnique.mockResolvedValue({
      enabled: true,
      maxSpendMicros: 500n,
    });
    await expect(
      service.createRevision(tenant, CAMPAIGN, validPlan({ budget: { capMicros: 1000, currency: 'USD' } })),
    ).rejects.toMatchObject({ response: { error: { code: 'CAMPAIGN_PLAN_INVALID' } } });
  });

  it('submitRevision：DRAFT → SUBMITTED + 建 PENDING 审批 + 旧批准 SUPERSEDED 且旧授权撤销', async () => {
    const { service, tx } = buildService();
    tx.campaignRevision.findFirst.mockResolvedValue({
      id: REVISION,
      campaignId: CAMPAIGN,
      workspaceId: WORKSPACE,
      state: 'DRAFT',
      planHash: 'plan-hash',
    });
    tx.campaignRevision.findMany.mockResolvedValue([{ id: 'old-rev' }]);
    const result = await service.submitRevision(tenant, CAMPAIGN, REVISION);
    expect(result.revision.state).toBe('SUBMITTED');
    expect(result.approval.state).toBe('PENDING');
    expect(tx.campaignRevision.updateMany).toHaveBeenCalled();
    expect(tx.campaignExecutionAuthorization.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: 'REVOKED', revokeReason: 'SUPERSEDED_BY_NEW_REVISION' }),
      }),
    );
  });

  it('submitRevision：非 DRAFT → 409', async () => {
    const { service, tx } = buildService();
    tx.campaignRevision.findFirst.mockResolvedValue({
      id: REVISION,
      campaignId: CAMPAIGN,
      workspaceId: WORKSPACE,
      state: 'APPROVED',
      planHash: 'plan-hash',
    });
    await expect(service.submitRevision(tenant, CAMPAIGN, REVISION)).rejects.toMatchObject({
      response: { error: { code: 'CAMPAIGN_REVISION_STATE_CONFLICT' } },
    });
  });

  it('decideApproval(approve)：审批通过 + 签发授权 + 自审留痕', async () => {
    const { service, tx, signer } = buildService();
    tx.campaignApproval.findFirst.mockResolvedValue(pendingApproval());
    tx.campaign.findFirst.mockResolvedValue({ id: CAMPAIGN, status: 'DRAFT' });
    const result = await service.decideApproval(tenant, CAMPAIGN, APPROVAL, { decision: 'approve' });
    expect(result.approval.state).toBe('APPROVED');
    expect(result.authorization?.state).toBe('ISSUED');
    expect(signer.sign).toHaveBeenCalledTimes(1);
    // 自审：requestedBy 与操作者相同 → trace reasonCode=SELF_APPROVAL
    const traceCalls = tx.campaignDecisionTrace.create.mock.calls;
    const decidedTrace = traceCalls.find(
      (call: [{ data: { stepType: string } }]) => call[0].data.stepType === 'approval.decided',
    );
    expect(decidedTrace[0].data.reasonCode).toBe('SELF_APPROVAL');
  });

  it('decideApproval(decline)：拒绝不签发授权，并触发 M2.2 自动重生成钩子', async () => {
    const { service, tx, signer, replan } = buildService();
    tx.campaignApproval.findFirst.mockResolvedValue(pendingApproval());
    const result = await service.decideApproval(tenant, CAMPAIGN, APPROVAL, {
      decision: 'decline',
      reason: '预算过高',
    });
    expect(result.approval.state).toBe('DECLINED');
    expect(result.authorization).toBeNull();
    expect(signer.sign).not.toHaveBeenCalled();
    expect(replan.onApprovalDeclined).toHaveBeenCalledWith({
      tenant,
      campaignId: CAMPAIGN,
      revisionId: REVISION,
      reason: '预算过高',
    });
  });

  it('decideApproval：超时 → 落 EXPIRED 并拒绝（超时=拒绝）', async () => {
    const { service, tx } = buildService();
    tx.campaignApproval.findFirst.mockResolvedValue(
      pendingApproval({ expiresAt: new Date(Date.now() - 1000) }),
    );
    await expect(
      service.decideApproval(tenant, CAMPAIGN, APPROVAL, { decision: 'approve' }),
    ).rejects.toMatchObject({ response: { error: { code: 'CAMPAIGN_APPROVAL_EXPIRED' } } });
    expect(tx.campaignApproval.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { state: 'EXPIRED' } }),
    );
  });

  it('decideApproval：非 PENDING → ALREADY_DECIDED（旧同意不可复用）', async () => {
    const { service, tx } = buildService();
    tx.campaignApproval.findFirst.mockResolvedValue(pendingApproval({ state: 'APPROVED' }));
    await expect(
      service.decideApproval(tenant, CAMPAIGN, APPROVAL, { decision: 'approve' }),
    ).rejects.toMatchObject({ response: { error: { code: 'CAMPAIGN_APPROVAL_ALREADY_DECIDED' } } });
  });

  it('revokeAuthorization：ISSUED → REVOKED + trace', async () => {
    const { service, tx } = buildService();
    tx.campaignExecutionAuthorization.findFirst.mockResolvedValue({
      id: AUTHORIZATION,
      campaignId: CAMPAIGN,
      workspaceId: WORKSPACE,
      revisionId: REVISION,
      state: 'ISSUED',
    });
    const result = await service.revokeAuthorization(tenant, CAMPAIGN, AUTHORIZATION, '测试撤销');
    expect(result.state).toBe('REVOKED');
    expect(tx.campaignDecisionTrace.create).toHaveBeenCalledTimes(1);
  });

  it('verifyAuthorization：签名/状态/hash/范围全对 → valid', async () => {
    const { service, prismaRow } = await (async () => {
      const built = buildService();
      (built.signer.verify as ReturnType<typeof vi.fn>).mockResolvedValue({
        authorizationId: AUTHORIZATION,
        workspaceId: WORKSPACE,
        campaignId: CAMPAIGN,
        revisionId: REVISION,
        planHash: 'plan-hash',
        scope: {},
      });
      built.tx.campaignExecutionAuthorization.findFirst.mockResolvedValue({
        id: AUTHORIZATION,
        workspaceId: WORKSPACE,
        campaignId: CAMPAIGN,
        revisionId: REVISION,
        planHash: 'plan-hash',
        state: 'ISSUED',
        expiresAt: new Date(Date.now() + 600_000),
        maxUses: 1,
        uses: 0,
        scope: { actions: [{ type: 'discovery', icpIds: [ICP] }], sizeCap: 50 },
      });
      return { service: built.service, prismaRow: built.tx };
    })();
    void prismaRow;
    const result = await service.verifyAuthorization({
      token: 'signed-token',
      planHash: 'plan-hash',
      action: { type: 'discovery', icpIds: [ICP] },
    });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.authorization.remainingUses).toBe(1);
  });

  it('verifyAuthorization：plan_hash 不匹配 → invalid（范围变化必须重新审批）', async () => {
    const { service, signer, tx } = buildService();
    (signer.verify as ReturnType<typeof vi.fn>).mockResolvedValue({
      authorizationId: AUTHORIZATION,
      workspaceId: WORKSPACE,
      campaignId: CAMPAIGN,
      revisionId: REVISION,
      planHash: 'old-hash',
      scope: {},
    });
    tx.campaignExecutionAuthorization.findFirst.mockResolvedValue({
      id: AUTHORIZATION,
      workspaceId: WORKSPACE,
      planHash: 'old-hash',
      state: 'ISSUED',
      expiresAt: new Date(Date.now() + 600_000),
      maxUses: 1,
      uses: 0,
      scope: { actions: [{ type: 'discovery', icpIds: [ICP] }] },
    });
    const result = await service.verifyAuthorization({
      token: 'signed-token',
      planHash: 'new-hash',
      action: { type: 'discovery' },
    });
    expect(result.valid).toBe(false);
  });

  it('verifyAuthorization：已撤销 → REVOKED', async () => {
    const { service, signer, tx } = buildService();
    (signer.verify as ReturnType<typeof vi.fn>).mockResolvedValue({
      authorizationId: AUTHORIZATION,
      workspaceId: WORKSPACE,
      campaignId: CAMPAIGN,
      revisionId: REVISION,
      planHash: 'plan-hash',
      scope: {},
    });
    tx.campaignExecutionAuthorization.findFirst.mockResolvedValue({
      id: AUTHORIZATION,
      workspaceId: WORKSPACE,
      state: 'REVOKED',
      planHash: 'plan-hash',
      expiresAt: new Date(Date.now() + 600_000),
      maxUses: 1,
      uses: 0,
      scope: { actions: [] },
    });
    const result = await service.verifyAuthorization({
      token: 'signed-token',
      planHash: 'plan-hash',
      action: { type: 'discovery' },
    });
    expect(result).toMatchObject({ valid: false, reason: 'CAMPAIGN_AUTHORIZATION_REVOKED' });
  });

  it('verifyAuthorization：ICP 不在授权范围 → invalid', async () => {
    const { service, signer, tx } = buildService();
    (signer.verify as ReturnType<typeof vi.fn>).mockResolvedValue({
      authorizationId: AUTHORIZATION,
      workspaceId: WORKSPACE,
      campaignId: CAMPAIGN,
      revisionId: REVISION,
      planHash: 'plan-hash',
      scope: {},
    });
    tx.campaignExecutionAuthorization.findFirst.mockResolvedValue({
      id: AUTHORIZATION,
      workspaceId: WORKSPACE,
      state: 'ISSUED',
      planHash: 'plan-hash',
      expiresAt: new Date(Date.now() + 600_000),
      maxUses: 1,
      uses: 0,
      scope: { actions: [{ type: 'discovery', icpIds: [ICP] }] },
    });
    const result = await service.verifyAuthorization({
      token: 'signed-token',
      planHash: 'plan-hash',
      action: { type: 'discovery', icpIds: ['99999999-9999-4999-8999-999999999999'] },
    });
    expect(result.valid).toBe(false);
  });

  it('revokeAllIssuedForWorkspace：批量撤销', async () => {
    const { service, tx } = buildService();
    tx.campaignExecutionAuthorization.updateMany.mockResolvedValue({ count: 2 });
    const count = await service.revokeAllIssuedForWorkspace(WORKSPACE, 'WORKSPACE_DISABLED');
    expect(count).toBe(2);
    expect(tx.campaignExecutionAuthorization.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: WORKSPACE, state: 'ISSUED' },
        data: expect.objectContaining({ state: 'REVOKED', revokeReason: 'WORKSPACE_DISABLED' }),
      }),
    );
  });
});
