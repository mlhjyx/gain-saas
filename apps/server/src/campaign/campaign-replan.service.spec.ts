import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../shared/audit.service.js';
import type { PrismaService } from '../shared/prisma.service.js';
import type { CampaignTenant } from './campaign.service.js';
import { CampaignReplanService } from './campaign-replan.service.js';

/**
 * M2.2 人工拒绝触发的自动重生成（D-M2.2-a）单测：无 DB、无 HTTP。
 * 守：仅规划器 revision 触发、maxReplans≥1 才自动、每个链只自动一次、
 * 再被拒 → NEEDS_HUMAN + 轨迹、引擎失败不掩盖拒绝本身。
 */

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CAMPAIGN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REVISION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const JOB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const tenant: CampaignTenant = { userId: 'user-1', workspaceId: WS, role: 'admin' };

function plan(maxReplans: number) {
  return {
    schemaVersion: 'campaign-plan/v0',
    goal: { objective: 'x' },
    audience: { icpIds: ['11111111-1111-4111-8111-111111111111'], sizeCap: 50 },
    motions: [{ type: 'discovery', icpIds: ['11111111-1111-4111-8111-111111111111'] }],
    budget: { capMicros: 1000, currency: 'USD' },
    approvalPolicy: { required: true },
    decisionPolicy: { maxReplans },
  };
}

function buildService(options: {
  revision?: Record<string, unknown> | null;
  job?: Record<string, unknown> | null;
  campaign?: Record<string, unknown> | null;
  createJobError?: Error;
  triggerError?: Error;
}) {
  const prisma = {
    campaignRevision: {
      findFirst: vi.fn(async () => (options.revision === undefined ? { id: REVISION, plan: plan(1) } : options.revision)),
    },
    campaignPlanJob: {
      findFirst: vi.fn(async () => (options.job === undefined ? { id: JOB, replanOfJobId: null } : options.job)),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (options.createJobError) throw options.createJobError;
        return data;
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    campaign: {
      findFirst: vi.fn(async () => (options.campaign === undefined ? { id: CAMPAIGN, objective: '德国找分销商' } : options.campaign)),
    },
    campaignDecisionTrace: { create: vi.fn(async () => ({})) },
  } as unknown as PrismaService;
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  const engine = {
    trigger: vi.fn(async () => {
      if (options.triggerError) throw options.triggerError;
    }),
  };
  const service = new CampaignReplanService(prisma, audit, engine as never);
  return { service, prisma, audit, engine };
}

describe('CampaignReplanService.onApprovalDeclined', () => {
  it('spawns exactly one auto-replan job carrying the previous plan and the decline reason', async () => {
    const { service, prisma, engine, audit } = buildService({});
    await service.onApprovalDeclined({
      tenant,
      campaignId: CAMPAIGN,
      revisionId: REVISION,
      reason: '预算过高',
    });

    expect(prisma.campaignPlanJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: WS,
        campaignId: CAMPAIGN,
        state: 'PENDING',
        replanOfJobId: JOB,
        createdBy: 'user-1',
      }),
    });
    expect(engine.trigger).toHaveBeenCalledWith(
      tenant,
      expect.objectContaining({
        campaignId: CAMPAIGN,
        maxReplans: 0,
        previousPlan: plan(1),
        replanReason: { code: 'HUMAN_DECLINE', detail: '预算过高' },
      }),
    );
    expect(prisma.campaignPlanJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { state: 'RUNNING' } }),
    );
    expect(prisma.campaignDecisionTrace.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        decisionType: 'campaign.replan',
        reasonCode: 'HUMAN_DECLINE',
        stepType: 'campaign.replan.triggered',
      }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'campaign.replan.triggered' }),
    );
  });

  it('marks the auto-regenerated job NEEDS_HUMAN when its plan is declined again', async () => {
    const { service, prisma, engine } = buildService({
      job: { id: JOB, replanOfJobId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
    });
    await service.onApprovalDeclined({
      tenant,
      campaignId: CAMPAIGN,
      revisionId: REVISION,
      reason: '还是不行',
    });

    expect(engine.trigger).not.toHaveBeenCalled();
    expect(prisma.campaignPlanJob.create).not.toHaveBeenCalled();
    expect(prisma.campaignPlanJob.updateMany).toHaveBeenCalledWith({
      where: { id: JOB, workspaceId: WS, state: 'SUCCEEDED' },
      data: { state: 'NEEDS_HUMAN', error: 'CAMPAIGN_PLAN_NEEDS_HUMAN' },
    });
    expect(prisma.campaignDecisionTrace.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ stepType: 'campaign.replan.exhausted' }),
    });
  });

  it('does nothing for human-authored revisions (no plan job)', async () => {
    const { service, engine } = buildService({ job: null });
    await service.onApprovalDeclined({ tenant, campaignId: CAMPAIGN, revisionId: REVISION, reason: 'x' });
    expect(engine.trigger).not.toHaveBeenCalled();
  });

  it('respects a plan whose decisionPolicy.maxReplans is 0', async () => {
    const { service, prisma, engine } = buildService({ revision: { id: REVISION, plan: plan(0) } });
    await service.onApprovalDeclined({ tenant, campaignId: CAMPAIGN, revisionId: REVISION, reason: 'x' });
    expect(engine.trigger).not.toHaveBeenCalled();
    expect(prisma.campaignPlanJob.create).not.toHaveBeenCalled();
  });

  it('does not fight an already-active plan job (unique-index conflict)', async () => {
    const { service, engine } = buildService({
      createJobError: Object.assign(new Error('unique'), { code: 'P2002' }),
    });
    await service.onApprovalDeclined({ tenant, campaignId: CAMPAIGN, revisionId: REVISION, reason: 'x' });
    expect(engine.trigger).not.toHaveBeenCalled();
  });

  it('fails the spawned job but never the decline itself when the engine trigger fails', async () => {
    const { service, prisma, audit } = buildService({ triggerError: new Error('down') });
    await expect(
      service.onApprovalDeclined({ tenant, campaignId: CAMPAIGN, revisionId: REVISION, reason: 'x' }),
    ).resolves.toBeUndefined();
    expect(prisma.campaignPlanJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { state: 'FAILED', error: 'CAMPAIGN_PLAN_TRIGGER_FAILED' } }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'campaign.replan.trigger_failed' }),
    );
  });
});
