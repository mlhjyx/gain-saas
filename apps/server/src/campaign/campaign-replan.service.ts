import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import { CampaignPlanEngineClient } from './campaign-plan-engine.client.js';
import type { CampaignTenant } from './campaign.service.js';

/**
 * M2.2：人工拒绝触发的自动重生成（设计 D-M2.2-a「decline → 再生成 1 次 → 仍被拒 → NEEDS_HUMAN」）。
 *
 * 触发规则：
 *  - 只对**规划器产出**的 revision 生效（存在关联 campaign_plan_job）；人工版本不动。
 *  - 计划自身策略 `decisionPolicy.maxReplans ≥ 1` 才自动重生成（0 = 该计划不要自动重规划）。
 *  - 自动重生成**每个规划链只发生一次**：新 job 以 `replan_of_job_id` 记录来源；该 job 的
 *    revision 再被拒时不再生成，直接把 job 置 NEEDS_HUMAN 并落轨迹。
 *  - 其余轮次预算（`maxReplans - 1`）交给引擎在 job 内做校验反馈重规划（#884）。
 *
 * 失败语义：拒绝已经生效（审批事务已提交），自动重生成是尽力而为的后续动作——
 * 引擎触发失败把新 job 置 FAILED 并留审计，不影响拒绝动作本身。
 */

const PLANNER_ACTOR = 'service:campaign-plan';
const MAX_REASON_CHARS = 500;

interface DeclinedRevisionRow {
  id: string;
  plan: Prisma.JsonValue;
}

@Injectable()
export class CampaignReplanService {
  private readonly logger = new Logger(CampaignReplanService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: CampaignPlanEngineClient,
  ) {}

  /** 审批被拒（DECLINED）后的自动重生成 / 转人工。 */
  async onApprovalDeclined(input: {
    tenant: CampaignTenant;
    campaignId: string;
    revisionId: string;
    reason: string | null;
  }): Promise<void> {
    const { tenant, campaignId, revisionId } = input;
    const revision = await this.prisma.campaignRevision.findFirst({
      where: { id: revisionId, campaignId, workspaceId: tenant.workspaceId },
    });
    if (!revision) return;
    const job = await this.prisma.campaignPlanJob.findFirst({
      where: { revisionId, workspaceId: tenant.workspaceId },
    });
    if (!job) return; // 人工编辑的 revision：没有自动重生成路径

    if (job.replanOfJobId) {
      await this.markNeedsHuman(tenant, campaignId, job.id, revisionId, input.reason);
      return;
    }

    const plan = revision.plan as {
      decisionPolicy?: { maxReplans?: unknown };
      audience?: { icpIds?: unknown; sizeCap?: unknown };
      budget?: { capMicros?: unknown };
    } | null;
    const maxReplansRaw = plan?.decisionPolicy?.maxReplans;
    const maxReplans =
      typeof maxReplansRaw === 'number' && Number.isInteger(maxReplansRaw) ? maxReplansRaw : 0;
    if (maxReplans < 1) return; // 计划策略不允许自动重规划

    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId, workspaceId: tenant.workspaceId },
    });
    if (!campaign) return;

    const icpIds = Array.isArray(plan?.audience?.icpIds)
      ? (plan.audience.icpIds as unknown[]).filter((id): id is string => typeof id === 'string')
      : [];
    const sizeCap = typeof plan?.audience?.sizeCap === 'number' ? plan.audience.sizeCap : undefined;
    const budgetCapMicros =
      typeof plan?.budget?.capMicros === 'number' ? plan.budget.capMicros : undefined;

    const jobId = randomUUID();
    try {
      await this.prisma.campaignPlanJob.create({
        data: {
          id: jobId,
          workspaceId: tenant.workspaceId,
          campaignId,
          state: 'PENDING',
          objective: campaign.objective.trim().slice(0, 500) || 'campaign replan',
          ...(icpIds[0] !== undefined ? { icpId: icpIds[0] } : {}),
          engineRunRef: `campaign-plan-${jobId}`,
          replanOfJobId: job.id,
          createdBy: tenant.userId,
        },
      });
    } catch (error) {
      // 同 campaign 已有活跃 job（部分唯一索引 P2002）：不抢跑，保持拒绝后的静止状态。
      this.logger.warn(`auto replan skipped for campaign ${campaignId}: ${String(error)}`);
      return;
    }

    try {
      await this.engine.trigger(tenant, {
        workspaceId: tenant.workspaceId,
        campaignId,
        jobId,
        objective: campaign.objective,
        ...(icpIds[0] !== undefined ? { icpId: icpIds[0] } : {}),
        ...(sizeCap !== undefined ? { audienceSizeCap: sizeCap } : {}),
        ...(budgetCapMicros !== undefined ? { budgetCapMicros } : {}),
        maxReplans: Math.max(0, Math.min(maxReplans - 1, 2)),
        previousPlan: revision.plan,
        replanReason: {
          code: 'HUMAN_DECLINE',
          ...(input.reason ? { detail: input.reason.slice(0, MAX_REASON_CHARS) } : {}),
        },
      });
    } catch (error) {
      await this.prisma.campaignPlanJob
        .updateMany({
          where: { id: jobId, workspaceId: tenant.workspaceId, state: 'PENDING' },
          data: { state: 'FAILED', error: 'CAMPAIGN_PLAN_TRIGGER_FAILED' },
        })
        .catch(() => undefined);
      await this.audit
        .record({
          realm: 'service',
          actorId: PLANNER_ACTOR,
          action: 'campaign.replan.trigger_failed',
          target: `campaign/${campaignId}`,
          detail: { jobId, fromJobId: job.id },
        })
        .catch(() => undefined);
      this.logger.warn(`auto replan trigger failed for campaign ${campaignId}: ${String(error)}`);
      return;
    }

    await this.prisma.campaignPlanJob.updateMany({
      where: { id: jobId, workspaceId: tenant.workspaceId, state: 'PENDING' },
      data: { state: 'RUNNING' },
    });
    await this.prisma.campaignDecisionTrace
      .create({
        data: {
          workspaceId: tenant.workspaceId,
          campaignId,
          revisionId,
          traceId: `campaign-plan:${jobId}`,
          stepType: 'campaign.replan.triggered',
          actor: tenant.userId,
          actorType: 'user',
          decisionType: 'campaign.replan',
          chosenOption: `from_job:${job.id}`,
          reasonCode: 'HUMAN_DECLINE',
          evidence: {
            jobId,
            fromJobId: job.id,
            revisionId,
            ...(input.reason ? { reason: input.reason.slice(0, MAX_REASON_CHARS) } : {}),
          } as unknown as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
    await this.audit
      .record({
        realm: 'tenant',
        actorId: tenant.userId,
        action: 'campaign.replan.triggered',
        target: `campaign/${campaignId}`,
        detail: { jobId, fromJobId: job.id },
      })
      .catch(() => undefined);
  }

  /** 自动重生成后的 plan 仍被拒：该 job 转入 NEEDS_HUMAN，停在列表等人工编辑。 */
  private async markNeedsHuman(
    tenant: CampaignTenant,
    campaignId: string,
    jobId: string,
    revisionId: string,
    reason: string | null,
  ): Promise<void> {
    const updated = await this.prisma.campaignPlanJob.updateMany({
      where: { id: jobId, workspaceId: tenant.workspaceId, state: 'SUCCEEDED' },
      data: { state: 'NEEDS_HUMAN', error: 'CAMPAIGN_PLAN_NEEDS_HUMAN' },
    });
    if (updated.count !== 1) return;
    await this.prisma.campaignDecisionTrace
      .create({
        data: {
          workspaceId: tenant.workspaceId,
          campaignId,
          revisionId,
          traceId: `campaign-plan:${jobId}`,
          stepType: 'campaign.replan.exhausted',
          actor: 'system',
          actorType: 'service',
          decisionType: 'campaign.replan',
          chosenOption: 'needs_human',
          reasonCode: 'HUMAN_DECLINE',
          evidence: {
            jobId,
            revisionId,
            ...(reason ? { reason: reason.slice(0, MAX_REASON_CHARS) } : {}),
          } as unknown as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
    await this.audit
      .record({
        realm: 'service',
        actorId: PLANNER_ACTOR,
        action: 'campaign.plan_job.needs_human',
        target: `campaign/${campaignId}`,
        detail: { jobId },
      })
      .catch(() => undefined);
  }
}
