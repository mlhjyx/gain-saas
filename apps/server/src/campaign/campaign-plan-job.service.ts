import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PrismaService } from '../shared/prisma.service.js';
import { AuditService } from '../shared/audit.service.js';
import { CampaignService, type CampaignTenant } from './campaign.service.js';
import { CampaignPlanEngineClient } from './campaign-plan-engine.client.js';

/**
 * M2.1：受限 Campaign 规划 job 的编排（docs/superpowers/plans/2026-11-08-campaign-planner-m2-1.md
 * §3/§4.2/§5，本仓侧）。job 是异步的：BFF 触发引擎工作流 → 引擎经内部回调交付原始计划
 * （plan_hash 单一权威在本仓）或回写失败；本服务负责两侧状态机与幂等。
 *
 * 租户隔离沿用 M2.0：所有查询 workspaceId 过滤；跨租户一律 404。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_TOKEN = /^[A-Z][A-Z0-9_]{0,63}$/;
const PLANNER_ACTOR = 'service:campaign-plan';

const createJobBody = z.object({
  objective: z.string().trim().min(1).max(500).optional(),
  icpId: z.string().uuid().optional(),
  audienceSizeCap: z.number().int().min(1).max(1000).optional(),
  budgetCapMicros: z.number().int().min(0).optional(),
});

const completeBody = z.object({
  jobId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  plan: z.unknown(),
});

const jobFailureBody = z.object({
  workspaceId: z.string().uuid(),
  state: z.literal('FAILED'),
  error: z.string().regex(ERROR_TOKEN),
  issues: z
    .array(
      z.object({
        path: z.string().max(200),
        message: z.string().max(300),
      }),
    )
    .max(50)
    .optional(),
});

function campaignNotFound(): never {
  throw new NotFoundException({ error: { code: 'CAMPAIGN_NOT_FOUND', message: 'campaign 不存在' } });
}

function jobNotFound(): never {
  throw new NotFoundException({ error: { code: 'CAMPAIGN_PLAN_JOB_NOT_FOUND', message: '规划 job 不存在' } });
}

function stateConflict(code: string, message: string): never {
  throw new ConflictException({ error: { code, message } });
}

export interface CampaignPlanJobView {
  id: string;
  campaignId: string;
  state: string;
  objective: string;
  error: string | null;
  issues: Prisma.JsonValue | null;
  planHash: string | null;
  revisionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class CampaignPlanJobService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly campaigns: CampaignService,
    private readonly engine: CampaignPlanEngineClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private toView(job: {
    id: string;
    campaignId: string;
    state: string;
    objective: string;
    error: string | null;
    issues: Prisma.JsonValue | null;
    planHash: string | null;
    revisionId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): CampaignPlanJobView {
    return {
      id: job.id,
      campaignId: job.campaignId,
      state: job.state,
      objective: job.objective,
      error: job.error,
      issues: job.issues,
      planHash: job.planHash,
      revisionId: job.revisionId,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  /** POST /api/campaigns/:campaignId/plan-drafts（admin）。同 campaign 同时只允许一个活跃 job。 */
  async createPlanDraft(
    tenant: CampaignTenant,
    campaignId: string,
    body: unknown,
  ): Promise<CampaignPlanJobView> {
    if (!UUID_RE.test(campaignId)) campaignNotFound();
    const parsed = createJobBody.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: '规划参数不合法' },
      });
    }
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId, workspaceId: tenant.workspaceId },
    });
    if (!campaign) campaignNotFound();
    const objective = parsed.data.objective ?? campaign.objective.trim();
    if (objective.length === 0) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: 'objective 必填' },
      });
    }

    const jobId = randomUUID();
    let job;
    try {
      job = await this.prisma.campaignPlanJob.create({
        data: {
          id: jobId,
          workspaceId: tenant.workspaceId,
          campaignId,
          state: 'PENDING',
          objective,
          ...(parsed.data.icpId !== undefined ? { icpId: parsed.data.icpId } : {}),
          engineRunRef: `campaign-plan-${jobId}`,
          createdBy: tenant.userId,
        },
      });
    } catch (error) {
      // 部分唯一索引 (campaign_id) WHERE state IN ('PENDING','RUNNING') → Prisma P2002。
      if (
        error &&
        typeof error === 'object' &&
        (error as { code?: unknown }).code === 'P2002'
      ) {
        stateConflict('CAMPAIGN_PLAN_JOB_ACTIVE', '该 Campaign 已有进行中的规划 job');
      }
      throw error;
    }

    try {
      await this.engine.trigger(tenant, {
        workspaceId: tenant.workspaceId,
        campaignId,
        jobId,
        objective,
        ...(parsed.data.icpId !== undefined ? { icpId: parsed.data.icpId } : {}),
        audienceSizeCap: Math.min(
          parsed.data.audienceSizeCap ?? this.config.CAMPAIGN_AUDIENCE_SIZE_CAP_MAX,
          this.config.CAMPAIGN_AUDIENCE_SIZE_CAP_MAX,
        ),
        ...(parsed.data.budgetCapMicros !== undefined
          ? { budgetCapMicros: parsed.data.budgetCapMicros }
          : {}),
      });
    } catch (error) {
      // 触发失败（quote/引擎拒绝/不可达）：job 立即 FAILED，重试须重新发起（新 jobId + 新 Grant）。
      await this.prisma.campaignPlanJob
        .updateMany({
          where: { id: jobId, workspaceId: tenant.workspaceId, state: 'PENDING' },
          data: {
            state: 'FAILED',
            error: 'CAMPAIGN_PLAN_TRIGGER_FAILED',
            issues: [
              { path: '', message: '引擎触发失败，请重试' },
            ] as unknown as Prisma.InputJsonValue,
          },
        })
        .catch(() => undefined);
      throw error;
    }

    await this.prisma.campaignPlanJob.updateMany({
      where: { id: jobId, workspaceId: tenant.workspaceId, state: 'PENDING' },
      data: { state: 'RUNNING' },
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'campaign.plan_job.created',
      target: `campaign/${campaignId}`,
      detail: { jobId },
    });
    const created = await this.prisma.campaignPlanJob.findFirst({
      where: { id: jobId, workspaceId: tenant.workspaceId },
    });
    return this.toView(created ?? job);
  }

  /** GET /api/campaigns/:campaignId/plan-drafts/:jobId（轮询；跨租户 404）。 */
  async getPlanJob(
    tenant: CampaignTenant,
    campaignId: string,
    jobId: string,
  ): Promise<CampaignPlanJobView> {
    if (!UUID_RE.test(campaignId) || !UUID_RE.test(jobId)) jobNotFound();
    const job = await this.prisma.campaignPlanJob.findFirst({
      where: { id: jobId, campaignId, workspaceId: tenant.workspaceId },
    });
    if (!job) jobNotFound();
    return this.toView(job);
  }

  /**
   * 内部回调：引擎交付原始 CampaignPlan（服务身份）。
   * 幂等：job 已 SUCCEEDED 且 (jobId, plan_hash) 相同 → 返回已存在 revision；
   * 相同 job 不同 plan_hash → 409。校验失败 → 400 CAMPAIGN_PLAN_INVALID（issues 供引擎落 job）。
   */
  async completePlanJob(input: unknown): Promise<{
    revisionId: string;
    revisionNo: number;
    planHash: string;
    state: string;
    idempotent: boolean;
  }> {
    const parsed = completeBody.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException({
        error: { code: 'CAMPAIGN_PLAN_JOB_REPORT_INVALID', message: '回调参数不合法' },
      });
    }
    const { jobId, workspaceId, campaignId, plan } = parsed.data;
    const { plan: validated, planHash } = await this.campaigns.validateRevisionPlan(
      workspaceId,
      plan,
    );

    const existing = await this.prisma.campaignPlanJob.findFirst({
      where: { id: jobId, workspaceId, campaignId },
    });
    if (!existing) jobNotFound();
    if (existing.state === 'SUCCEEDED') {
      if (existing.planHash === planHash && existing.revisionId) {
        const revision = await this.prisma.campaignRevision.findFirst({
          where: { id: existing.revisionId, workspaceId },
        });
        if (revision) {
          return {
            revisionId: revision.id,
            revisionNo: revision.revisionNo,
            planHash,
            state: revision.state,
            idempotent: true,
          };
        }
      }
      stateConflict('CAMPAIGN_PLAN_JOB_CONFLICT', 'job 已完成且计划不同');
    }
    if (existing.state === 'FAILED') {
      stateConflict('CAMPAIGN_PLAN_JOB_CONFLICT', 'job 已失败');
    }

    let revision;
    try {
      revision = await this.prisma.$transaction(async (tx) => {
        const created = await this.campaigns.createRevisionRecord(tx, {
          workspaceId,
          campaignId,
          actorId: PLANNER_ACTOR,
          actorType: 'service',
          plan: validated,
          planHash,
          reasonCode: 'PLANNER_DRAFT_VALIDATED',
        });
        const updated = await tx.campaignPlanJob.updateMany({
          where: { id: jobId, workspaceId, state: { in: ['PENDING', 'RUNNING'] } },
          data: { state: 'SUCCEEDED', planHash, revisionId: created.id },
        });
        if (updated.count !== 1) {
          throw new ConflictException({
            error: { code: 'CAMPAIGN_PLAN_JOB_CONFLICT', message: 'job 状态已变化' },
          });
        }
        return created;
      });
    } catch (error) {
      // 并发回调竞争：以先落库者的结果为准（同 hash 幂等返回，否则 409）。
      const raced = await this.prisma.campaignPlanJob.findFirst({
        where: { id: jobId, workspaceId, campaignId },
      });
      if (raced?.state === 'SUCCEEDED' && raced.planHash === planHash && raced.revisionId) {
        const revision = await this.prisma.campaignRevision.findFirst({
          where: { id: raced.revisionId, workspaceId },
        });
        if (revision) {
          return {
            revisionId: revision.id,
            revisionNo: revision.revisionNo,
            planHash,
            state: revision.state,
            idempotent: true,
          };
        }
      }
      throw error;
    }

    await this.audit.record({
      realm: 'service',
      actorId: PLANNER_ACTOR,
      action: 'campaign.revision.created',
      target: `campaign/${campaignId}`,
      detail: { revisionId: revision.id, planHash, revisionNo: revision.revisionNo, jobId },
    });
    return {
      revisionId: revision.id,
      revisionNo: revision.revisionNo,
      planHash,
      state: revision.state,
      idempotent: false,
    };
  }

  /**
   * 内部回写：引擎把 job 置 FAILED（闭集错误码 + 有界 issues）。
   * 幂等：已 FAILED 且同错误码 → 200 no-op；已终结且状态不同 → 409。
   */
  async reportJobFailure(jobId: string, input: unknown): Promise<CampaignPlanJobView> {
    if (!UUID_RE.test(jobId)) jobNotFound();
    const parsed = jobFailureBody.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException({
        error: { code: 'CAMPAIGN_PLAN_JOB_REPORT_INVALID', message: '回写参数不合法' },
      });
    }
    const { workspaceId, error, issues } = parsed.data;
    const job = await this.prisma.campaignPlanJob.findFirst({
      where: { id: jobId, workspaceId },
    });
    if (!job) jobNotFound();
    if (job.state === 'SUCCEEDED') {
      stateConflict('CAMPAIGN_PLAN_JOB_CONFLICT', 'job 已完成，不能再回写失败');
    }
    if (job.state === 'FAILED') {
      if (job.error === error) return this.toView(job);
      stateConflict('CAMPAIGN_PLAN_JOB_CONFLICT', 'job 已失败且错误码不同');
    }
    const updated = await this.prisma.campaignPlanJob.updateMany({
      where: { id: jobId, workspaceId, state: { in: ['PENDING', 'RUNNING'] } },
      data: {
        state: 'FAILED',
        error,
        ...(issues !== undefined
          ? { issues: issues as unknown as Prisma.InputJsonValue }
          : {}),
      },
    });
    if (updated.count !== 1) {
      const raced = await this.prisma.campaignPlanJob.findFirst({
        where: { id: jobId, workspaceId },
      });
      if (raced?.state === 'FAILED' && raced.error === error) return this.toView(raced);
      stateConflict('CAMPAIGN_PLAN_JOB_CONFLICT', 'job 状态已变化');
    }
    await this.audit.record({
      realm: 'service',
      actorId: PLANNER_ACTOR,
      action: 'campaign.plan_job.failed',
      target: `campaign/${job.campaignId}`,
      detail: { jobId, error },
    });
    const refreshed = await this.prisma.campaignPlanJob.findFirst({
      where: { id: jobId, workspaceId },
    });
    if (!refreshed) jobNotFound();
    return this.toView(refreshed);
  }
}
