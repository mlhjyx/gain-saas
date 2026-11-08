import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { PrismaService } from '../shared/prisma.service.js';
import type { AuditService } from '../shared/audit.service.js';
import type { CampaignService, CampaignTenant } from './campaign.service.js';
import type { CampaignPlanEngineClient } from './campaign-plan-engine.client.js';
import { CampaignPlanJobService } from './campaign-plan-job.service.js';
import { validPlan } from './campaign-plan.fixtures.js';

/**
 * M2.1 job 编排（幂等/状态机/租户）单测：无 DB、无 HTTP。
 * 守：同 campaign 活跃 job 409、触发失败回写 FAILED、回调 (jobId, plan_hash) 幂等、
 * 同 job 不同 hash / 已失败 job → 409、跨租户 404、失败回写同码幂等。
 */

const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CAMPAIGN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const JOB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REVISION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const tenant: CampaignTenant = { userId: 'user-1', workspaceId: WORKSPACE, role: 'admin' };

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB,
    workspaceId: WORKSPACE,
    campaignId: CAMPAIGN,
    state: 'RUNNING',
    objective: '在德国找 30 家泵类分销商',
    icpId: null,
    engineRunRef: `campaign-plan-${JOB}`,
    planHash: null,
    revisionId: null,
    error: null,
    issues: null,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildService() {
  const tx = {
    campaign: {
      findFirst: vi.fn(async () => ({ id: CAMPAIGN, workspaceId: WORKSPACE, objective: '目标' })),
      update: vi.fn(),
    },
    campaignRevision: {
      findFirst: vi.fn(async () => ({
        id: REVISION,
        revisionNo: 1,
        state: 'DRAFT',
      })),
      create: vi.fn(),
    },
    campaignAudience: { create: vi.fn() },
    campaignPlanJob: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => jobRow({ ...data, state: 'PENDING' })),
      findFirst: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    campaignDecisionTrace: { create: vi.fn() },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  const campaigns = {
    validateRevisionPlan: vi.fn(async (_ws: string, plan: unknown) => ({
      plan,
      planHash: 'a'.repeat(64),
    })),
    createRevisionRecord: vi.fn(async () => ({
      id: REVISION,
      revisionNo: 1,
      state: 'DRAFT',
    })),
  } as unknown as CampaignService;
  const engine = {
    trigger: vi.fn(async () => undefined),
  } as unknown as CampaignPlanEngineClient;
  const config = {
    CAMPAIGN_AUDIENCE_SIZE_CAP_MAX: 1000,
    CAMPAIGN_PLAN_JOB_ENABLED: true,
    CAMPAIGN_PLAN_ENGINE_SERVICE_TOKEN: 'token',
  } as AppConfig;
  const service = new CampaignPlanJobService(prisma, audit, campaigns, engine, config);
  return { service, tx, prisma, audit, campaigns, engine };
}

describe('CampaignPlanJobService.createPlanDraft', () => {
  it('creates a PENDING job, triggers the engine, then marks it RUNNING', async () => {
    const { service, tx, engine, audit } = buildService();
    tx.campaignPlanJob.findFirst.mockResolvedValue(jobRow({ state: 'RUNNING' }));

    const view = await service.createPlanDraft(tenant, CAMPAIGN, {});
    expect(view.state).toBe('RUNNING');
    const createdId = (
      tx.campaignPlanJob.create.mock.calls[0]![0] as { data: { id: string } }
    ).data.id;
    expect(engine.trigger).toHaveBeenCalledWith(
      tenant,
      expect.objectContaining({
        workspaceId: WORKSPACE,
        campaignId: CAMPAIGN,
        jobId: createdId,
        objective: '目标',
        audienceSizeCap: 1000,
      }),
    );
    expect(tx.campaignPlanJob.updateMany).toHaveBeenCalledWith({
      where: { id: createdId, workspaceId: WORKSPACE, state: 'PENDING' },
      data: { state: 'RUNNING' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'campaign.plan_job.created' }),
    );
  });

  it('maps the active-job partial unique violation to 409 CAMPAIGN_PLAN_JOB_ACTIVE', async () => {
    const { service, tx } = buildService();
    tx.campaignPlanJob.create.mockRejectedValue(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );
    await expect(service.createPlanDraft(tenant, CAMPAIGN, {})).rejects.toMatchObject({
      response: { error: { code: 'CAMPAIGN_PLAN_JOB_ACTIVE' } },
    });
  });

  it('marks the job FAILED and rethrows when the engine trigger fails', async () => {
    const { service, tx, engine } = buildService();
    (engine.trigger as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('down'), { code: 'CAMPAIGN_PLAN_ENGINE_UNAVAILABLE' }),
    );
    await expect(service.createPlanDraft(tenant, CAMPAIGN, {})).rejects.toThrow('down');
    const createdId = (
      tx.campaignPlanJob.create.mock.calls[0]![0] as { data: { id: string } }
    ).data.id;
    expect(tx.campaignPlanJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: createdId, state: 'PENDING' }),
        data: expect.objectContaining({
          state: 'FAILED',
          error: 'CAMPAIGN_PLAN_TRIGGER_FAILED',
        }),
      }),
    );
  });

  it('404s a campaign outside the tenant workspace', async () => {
    const { service, tx } = buildService();
    tx.campaign.findFirst.mockResolvedValue(null);
    await expect(service.createPlanDraft(tenant, CAMPAIGN, {})).rejects.toMatchObject({
      response: { error: { code: 'CAMPAIGN_NOT_FOUND' } },
    });
  });
});

describe('CampaignPlanJobService.completePlanJob', () => {
  const body = { jobId: JOB, workspaceId: WORKSPACE, campaignId: CAMPAIGN, plan: validPlan() };

  it('creates a DRAFT revision and marks the job SUCCEEDED', async () => {
    const { service, tx } = buildService();
    tx.campaignPlanJob.findFirst.mockResolvedValue(jobRow());
    const result = await service.completePlanJob(body);
    expect(result).toMatchObject({
      revisionId: REVISION,
      planHash: 'a'.repeat(64),
      state: 'DRAFT',
      idempotent: false,
    });
    expect(tx.campaignPlanJob.updateMany).toHaveBeenCalledWith({
      where: { id: JOB, workspaceId: WORKSPACE, state: { in: ['PENDING', 'RUNNING'] } },
      data: { state: 'SUCCEEDED', planHash: 'a'.repeat(64), revisionId: REVISION },
    });
  });

  it('returns the existing revision for a repeated callback with the same plan hash', async () => {
    const { service, tx } = buildService();
    tx.campaignPlanJob.findFirst.mockResolvedValue(
      jobRow({ state: 'SUCCEEDED', planHash: 'a'.repeat(64), revisionId: REVISION }),
    );
    const result = await service.completePlanJob(body);
    expect(result).toMatchObject({ revisionId: REVISION, idempotent: true });
    expect(tx.campaignRevision.create).not.toHaveBeenCalled();
  });

  it('records replan traces and persists the history when the plan came from a replan loop', async () => {
    const { service, tx } = buildService();
    tx.campaignPlanJob.findFirst.mockResolvedValue(jobRow());
    const replanHistory = [
      { round: 0, reasonCode: 'VALIDATOR_ISSUES', issues: [{ path: 'goal.objective', message: 'x' }] },
    ];
    await service.completePlanJob({ ...body, replanHistory });
    expect(tx.campaignDecisionTrace.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: WORKSPACE,
        campaignId: CAMPAIGN,
        decisionType: 'campaign.replan',
        reasonCode: 'VALIDATOR_ISSUES',
        traceId: `campaign-plan:${JOB}`,
      }),
    });
    expect(tx.campaignPlanJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: 'SUCCEEDED', replanHistory }),
      }),
    );
  });

  it('409s a repeated callback whose plan hash differs', async () => {
    const { service, tx } = buildService();
    tx.campaignPlanJob.findFirst.mockResolvedValue(
      jobRow({ state: 'SUCCEEDED', planHash: 'b'.repeat(64), revisionId: REVISION }),
    );
    await expect(service.completePlanJob(body)).rejects.toMatchObject({
      response: { error: { code: 'CAMPAIGN_PLAN_JOB_CONFLICT' } },
    });
  });

  it('409s a callback against a job that already failed', async () => {
    const { service, tx } = buildService();
    tx.campaignPlanJob.findFirst.mockResolvedValue(jobRow({ state: 'FAILED', error: 'X' }));
    await expect(service.completePlanJob(body)).rejects.toMatchObject({
      response: { error: { code: 'CAMPAIGN_PLAN_JOB_CONFLICT' } },
    });
  });

  it('404s an unknown job (cross-tenant)', async () => {
    const { service, tx } = buildService();
    tx.campaignPlanJob.findFirst.mockResolvedValue(null);
    await expect(service.completePlanJob(body)).rejects.toMatchObject({
      response: { error: { code: 'CAMPAIGN_PLAN_JOB_NOT_FOUND' } },
    });
  });

  it('rejects malformed callbacks and propagates plan validation failures', async () => {
    const { service, campaigns } = buildService();
    await expect(service.completePlanJob({ jobId: 'nope' })).rejects.toMatchObject({
      response: { error: { code: 'CAMPAIGN_PLAN_JOB_REPORT_INVALID' } },
    });
    (campaigns.validateRevisionPlan as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('CAMPAIGN_PLAN_INVALID')),
    );
    await expect(service.completePlanJob(body)).rejects.toThrow('CAMPAIGN_PLAN_INVALID');
  });
});

describe('CampaignPlanJobService.reportJobFailure', () => {
  it('marks a RUNNING job FAILED with a closed error token and issues', async () => {
    const { service, tx, audit } = buildService();
    tx.campaignPlanJob.findFirst
      .mockResolvedValueOnce(jobRow())
      .mockResolvedValueOnce(jobRow({ state: 'FAILED', error: 'SKILL_PLATFORM_DISABLED' }));
    const view = await service.reportJobFailure(JOB, {
      workspaceId: WORKSPACE,
      state: 'FAILED',
      error: 'SKILL_PLATFORM_DISABLED',
      issues: [{ path: '', message: 'disabled' }],
    });
    expect(view.state).toBe('FAILED');
    expect(tx.campaignPlanJob.updateMany).toHaveBeenCalledWith({
      where: { id: JOB, workspaceId: WORKSPACE, state: { in: ['PENDING', 'RUNNING'] } },
      data: {
        state: 'FAILED',
        error: 'SKILL_PLATFORM_DISABLED',
        issues: [{ path: '', message: 'disabled' }],
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'campaign.plan_job.failed' }),
    );
  });

  it('is idempotent for the same error token and 409s a different one', async () => {
    const { service, tx } = buildService();
    tx.campaignPlanJob.findFirst.mockResolvedValue(
      jobRow({ state: 'FAILED', error: 'CAMPAIGN_PLAN_INVALID' }),
    );
    const same = await service.reportJobFailure(JOB, {
      workspaceId: WORKSPACE,
      state: 'FAILED',
      error: 'CAMPAIGN_PLAN_INVALID',
    });
    expect(same.state).toBe('FAILED');
    await expect(
      service.reportJobFailure(JOB, {
        workspaceId: WORKSPACE,
        state: 'FAILED',
        error: 'CAMPAIGN_PLAN_FAILED',
      }),
    ).rejects.toMatchObject({
      response: { error: { code: 'CAMPAIGN_PLAN_JOB_CONFLICT' } },
    });
  });

  it('accepts NEEDS_HUMAN, writes replan traces, and audits the transition', async () => {
    const { service, tx, audit } = buildService();
    tx.campaignPlanJob.findFirst
      .mockResolvedValueOnce(jobRow())
      .mockResolvedValueOnce(jobRow({ state: 'NEEDS_HUMAN', error: 'CAMPAIGN_PLAN_NEEDS_HUMAN' }));
    const replanHistory = [
      { round: 0, reasonCode: 'VALIDATOR_ISSUES', issues: [{ path: 'data', message: 'invalid' }] },
      { round: 1, reasonCode: 'VALIDATOR_ISSUES', issues: [{ path: 'data', message: 'invalid' }] },
    ];
    const view = await service.reportJobFailure(JOB, {
      workspaceId: WORKSPACE,
      state: 'NEEDS_HUMAN',
      error: 'CAMPAIGN_PLAN_NEEDS_HUMAN',
      issues: [{ path: 'data', message: 'invalid' }],
      replanHistory,
    });
    expect(view.state).toBe('NEEDS_HUMAN');
    expect(tx.campaignPlanJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: 'NEEDS_HUMAN',
          error: 'CAMPAIGN_PLAN_NEEDS_HUMAN',
          replanHistory,
        }),
      }),
    );
    expect(tx.campaignDecisionTrace.create).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'campaign.plan_job.needs_human' }),
    );
  });

  it('keeps NEEDS_HUMAN terminal: same state is idempotent, FAILED afterwards is a 409', async () => {
    const { service, tx } = buildService();
    tx.campaignPlanJob.findFirst.mockResolvedValue(
      jobRow({ state: 'NEEDS_HUMAN', error: 'CAMPAIGN_PLAN_NEEDS_HUMAN' }),
    );
    const same = await service.reportJobFailure(JOB, {
      workspaceId: WORKSPACE,
      state: 'NEEDS_HUMAN',
      error: 'CAMPAIGN_PLAN_NEEDS_HUMAN',
    });
    expect(same.state).toBe('NEEDS_HUMAN');
    await expect(
      service.reportJobFailure(JOB, {
        workspaceId: WORKSPACE,
        state: 'FAILED',
        error: 'CAMPAIGN_PLAN_FAILED',
      }),
    ).rejects.toMatchObject({
      response: { error: { code: 'CAMPAIGN_PLAN_JOB_CONFLICT' } },
    });
  });

  it('rejects free-text error codes (closed token only)', async () => {
    const { service } = buildService();
    await expect(
      service.reportJobFailure(JOB, {
        workspaceId: WORKSPACE,
        state: 'FAILED',
        error: 'model exploded: here is the prompt text',
      }),
    ).rejects.toMatchObject({
      response: { error: { code: 'CAMPAIGN_PLAN_JOB_REPORT_INVALID' } },
    });
  });
});
