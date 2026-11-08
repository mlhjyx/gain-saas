import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PrismaService } from '../shared/prisma.service.js';
import { AuditService } from '../shared/audit.service.js';
import { CampaignTokenSigner } from './campaign-token.signer.js';
import { planHashOf } from './campaign-plan.canonical.js';
import { validateCampaignPlan, type CampaignPlanV0 } from './campaign-plan.schema.js';

export interface CampaignTenant {
  userId: string;
  workspaceId: string;
  role: 'admin' | 'member';
}

export type AuthorizationVerifyResult =
  | { valid: false; reason: string }
  | {
      valid: true;
      authorization: {
        id: string;
        campaignId: string;
        revisionId: string;
        planHash: string;
        scope: unknown;
        remainingUses: number;
      };
    };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function campaignNotFound(): never {
  throw new NotFoundException({ error: { code: 'CAMPAIGN_NOT_FOUND', message: 'campaign 不存在' } });
}

function stateConflict(code: string, message: string): never {
  throw new ConflictException({ error: { code, message } });
}

/**
 * M2.0 Campaign 控制面（docs/technical/campaign-control-plane-m2-0.md）：
 * 计划即数据（revision 不可变 + plan_hash 绑定）、审批状态机（超时=拒绝、旧同意不可复用）、
 * 双钥匙（Grant 管钱 / ExecutionAuthorization 管动作边界，ADR-0001）。
 * 所有查询以 workspaceId 作用域；跨租户一律 404。
 */
@Injectable()
export class CampaignService {
  private readonly approvalTtlMs: number;
  private readonly authzTtlSeconds: number;
  private readonly sizeCapMax: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly signer: CampaignTokenSigner,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.approvalTtlMs = config.CAMPAIGN_APPROVAL_TTL_HOURS * 3600_000;
    this.authzTtlSeconds = config.CAMPAIGN_AUTHZ_TTL_MINUTES * 60;
    this.sizeCapMax = config.CAMPAIGN_AUDIENCE_SIZE_CAP_MAX;
  }

  async createCampaign(tenant: CampaignTenant, input: { name?: unknown; objective?: unknown }) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const objective = typeof input.objective === 'string' ? input.objective.trim() : '';
    if (!name || name.length > 200) {
      throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message: 'name 必填且不超过 200 字' } });
    }
    if (objective.length > 500) {
      throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message: 'objective 不超过 500 字' } });
    }
    const campaign = await this.prisma.campaign.create({
      data: {
        workspaceId: tenant.workspaceId,
        name,
        objective,
        status: 'DRAFT',
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      },
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'campaign.created',
      target: `campaign/${campaign.id}`,
      detail: { workspaceId: tenant.workspaceId },
    });
    return campaign;
  }

  async listCampaigns(tenant: CampaignTenant) {
    const rows = await this.prisma.campaign.findMany({
      where: { workspaceId: tenant.workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { revisions: { orderBy: { revisionNo: 'desc' }, take: 1 } },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      objective: row.objective,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      latestRevision: row.revisions[0]
        ? {
            id: row.revisions[0].id,
            revisionNo: row.revisions[0].revisionNo,
            state: row.revisions[0].state,
            planHash: row.revisions[0].planHash,
          }
        : null,
    }));
  }

  async getCampaignDetail(tenant: CampaignTenant, campaignId: string) {
    if (!UUID_RE.test(campaignId)) campaignNotFound();
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId, workspaceId: tenant.workspaceId },
      include: {
        revisions: { orderBy: { revisionNo: 'desc' }, include: { approvals: true, audience: true } },
      },
    });
    if (!campaign) campaignNotFound();
    const authorizations = await this.prisma.campaignExecutionAuthorization.findMany({
      where: { workspaceId: tenant.workspaceId, campaignId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const traces = await this.prisma.campaignDecisionTrace.findMany({
      where: { workspaceId: tenant.workspaceId, campaignId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
    });
    const now = new Date();
    return {
      id: campaign.id,
      name: campaign.name,
      objective: campaign.objective,
      status: campaign.status,
      createdAt: campaign.createdAt,
      updatedAt: campaign.updatedAt,
      revisions: campaign.revisions.map((revision) => ({
        id: revision.id,
        revisionNo: revision.revisionNo,
        state: revision.state,
        planHash: revision.planHash,
        plan: revision.plan,
        createdAt: revision.createdAt,
        audience: revision.audience
          ? {
              icpIds: revision.audience.icpIds,
              includeFilters: revision.audience.includeFilters,
              excludeFilters: revision.audience.excludeFilters,
              sizeCap: revision.audience.sizeCap,
            }
          : null,
        approvals: revision.approvals.map((approval) => ({
          id: approval.id,
          state:
            approval.state === 'PENDING' && approval.expiresAt <= now ? 'EXPIRED' : approval.state,
          requestedBy: approval.requestedBy,
          decidedBy: approval.decidedBy,
          decidedAt: approval.decidedAt,
          decisionReason: approval.decisionReason,
          expiresAt: approval.expiresAt,
        })),
      })),
      authorizations: authorizations.map((row) => ({
        id: row.id,
        revisionId: row.revisionId,
        planHash: row.planHash,
        scope: row.scope,
        state: row.state === 'ISSUED' && row.expiresAt <= now ? 'EXPIRED' : row.state,
        uses: row.uses,
        maxUses: row.maxUses,
        issuedAt: row.issuedAt,
        expiresAt: row.expiresAt,
      })),
      recentTrace: traces,
    };
  }

  /**
   * M2.1：规划回调与人工提交共用同一套平面校验（zod CampaignPlan v0 + sizeCap 上限 +
   * workspace 预算政策）。失败抛 400 `CAMPAIGN_PLAN_INVALID`（details.issues 可直接落 job）。
   */
  async validateRevisionPlan(
    workspaceId: string,
    planInput: unknown,
  ): Promise<{ plan: CampaignPlanV0; planHash: string }> {
    const validation = validateCampaignPlan(planInput);
    if (!validation.ok) {
      throw new BadRequestException({
        error: { code: 'CAMPAIGN_PLAN_INVALID', message: '计划未通过校验', details: { issues: validation.issues } },
      });
    }
    const plan = validation.plan;
    if (plan.audience.sizeCap > this.sizeCapMax) {
      throw new BadRequestException({
        error: {
          code: 'CAMPAIGN_PLAN_INVALID',
          message: `sizeCap 超过上限 ${this.sizeCapMax}`,
          details: { issues: [{ path: 'audience.sizeCap', message: '超过 workspace 允许上限' }] },
        },
      });
    }
    if (plan.budget.capMicros != null) {
      const policy = await this.prisma.workspaceBudgetPolicy.findUnique({
        where: { workspaceId },
      });
      if (policy?.enabled && BigInt(plan.budget.capMicros) > policy.maxSpendMicros) {
        throw new BadRequestException({
          error: {
            code: 'CAMPAIGN_PLAN_INVALID',
            message: '预算上限超过 workspace 配额上限',
            details: { issues: [{ path: 'budget.capMicros', message: '超过 workspace 配额' }] },
          },
        });
      }
    }
    return { plan, planHash: planHashOf(plan) };
  }

  /**
   * M2.1：在调用方事务内创建 DRAFT revision（含 audience / currentRevisionId / trace）。
   * 人工提交用 actorType=user；规划回调落库用 actorId='service:campaign-plan'、actorType=service。
   */
  async createRevisionRecord(
    tx: Prisma.TransactionClient,
    input: {
      workspaceId: string;
      campaignId: string;
      actorId: string;
      actorType?: 'user' | 'service';
      plan: CampaignPlanV0;
      planHash: string;
      reasonCode?: string;
    },
  ) {
    const plan = input.plan;
    const campaign = await tx.campaign.findFirst({
      where: { id: input.campaignId, workspaceId: input.workspaceId },
    });
    if (!campaign) campaignNotFound();
    const last = await tx.campaignRevision.findFirst({
      where: { campaignId: input.campaignId, workspaceId: input.workspaceId },
      orderBy: { revisionNo: 'desc' },
      select: { revisionNo: true },
    });
    const revisionNo = (last?.revisionNo ?? 0) + 1;
    const created = await tx.campaignRevision.create({
      data: {
        workspaceId: input.workspaceId,
        campaignId: input.campaignId,
        revisionNo,
        plan: plan as unknown as Prisma.InputJsonValue,
        planHash: input.planHash,
        state: 'DRAFT',
        createdBy: input.actorId,
      },
    });
    await tx.campaignAudience.create({
      data: {
        workspaceId: input.workspaceId,
        revisionId: created.id,
        icpIds: plan.audience.icpIds as unknown as Prisma.InputJsonValue,
        ...(plan.audience.includeFilters !== undefined
          ? { includeFilters: plan.audience.includeFilters as Prisma.InputJsonValue }
          : {}),
        ...(plan.audience.excludeFilters !== undefined
          ? { excludeFilters: plan.audience.excludeFilters as Prisma.InputJsonValue }
          : {}),
        sizeCap: plan.audience.sizeCap,
      },
    });
    await tx.campaign.update({
      where: { id: input.campaignId },
      data: { currentRevisionId: created.id, updatedBy: input.actorId },
    });
    await this.writeTrace(tx, {
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      revisionId: created.id,
      stepType: 'revision.created',
      actor: input.actorId,
      ...(input.actorType !== undefined ? { actorType: input.actorType } : {}),
      decisionType: 'create',
      chosenOption: `revision_no:${revisionNo}`,
      reasonCode: input.reasonCode ?? 'PLAN_VALIDATED',
      evidence: [
        { url: 'campaign-plan/v0', retrievedAt: new Date().toISOString(), support: 'schema-validated' },
      ],
    });
    return created;
  }

  async createRevision(tenant: CampaignTenant, campaignId: string, planInput: unknown) {
    if (!UUID_RE.test(campaignId)) campaignNotFound();
    const { plan, planHash } = await this.validateRevisionPlan(tenant.workspaceId, planInput);
    const revision = await this.prisma.$transaction((tx) =>
      this.createRevisionRecord(tx, {
        workspaceId: tenant.workspaceId,
        campaignId,
        actorId: tenant.userId,
        plan,
        planHash,
      }),
    );
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'campaign.revision.created',
      target: `campaign/${campaignId}`,
      detail: { revisionId: revision.id, planHash, revisionNo: revision.revisionNo },
    });
    return revision;
  }

  async submitRevision(tenant: CampaignTenant, campaignId: string, revisionId: string) {
    if (!UUID_RE.test(campaignId) || !UUID_RE.test(revisionId)) campaignNotFound();
    const result = await this.prisma.$transaction(async (tx) => {
      const revision = await tx.campaignRevision.findFirst({
        where: { id: revisionId, campaignId, workspaceId: tenant.workspaceId },
      });
      if (!revision) campaignNotFound();
      if (revision.state !== 'DRAFT') {
        stateConflict('CAMPAIGN_REVISION_STATE_CONFLICT', `revision 状态为 ${revision.state}，不可提交`);
      }
      // 旧同意不可复用：已批准的旧 revision 置 SUPERSEDED，其未过期授权一并撤销。
      const approved = await tx.campaignRevision.findMany({
        where: { campaignId, workspaceId: tenant.workspaceId, state: 'APPROVED' },
        select: { id: true },
      });
      if (approved.length > 0) {
        const ids = approved.map((row) => row.id);
        await tx.campaignRevision.updateMany({ where: { id: { in: ids } }, data: { state: 'SUPERSEDED' } });
        await tx.campaignExecutionAuthorization.updateMany({
          where: { workspaceId: tenant.workspaceId, revisionId: { in: ids }, state: 'ISSUED' },
          data: { state: 'REVOKED', revokedAt: new Date(), revokeReason: 'SUPERSEDED_BY_NEW_REVISION' },
        });
      }
      const updated = await tx.campaignRevision.update({
        where: { id: revisionId },
        data: { state: 'SUBMITTED' },
      });
      const approval = await tx.campaignApproval.create({
        data: {
          workspaceId: tenant.workspaceId,
          revisionId,
          planHash: revision.planHash,
          state: 'PENDING',
          requestedBy: tenant.userId,
          expiresAt: new Date(Date.now() + this.approvalTtlMs),
        },
      });
      await this.writeTrace(tx, {
        workspaceId: tenant.workspaceId,
        campaignId,
        revisionId,
        stepType: 'approval.submitted',
        actor: tenant.userId,
        decisionType: 'submit',
        approvalId: approval.id,
        approvalState: 'PENDING',
        reasonCode: `superseded:${approved.length}`,
      });
      return { revision: updated, approval };
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'campaign.revision.submitted',
      target: `campaign/${campaignId}`,
      detail: { revisionId, approvalId: result.approval.id },
    });
    return result;
  }

  async decideApproval(
    tenant: CampaignTenant,
    campaignId: string,
    approvalId: string,
    input: { decision?: unknown; reason?: unknown },
  ) {
    if (!UUID_RE.test(campaignId) || !UUID_RE.test(approvalId)) campaignNotFound();
    const decision = input.decision;
    if (decision !== 'approve' && decision !== 'decline') {
      throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message: 'decision 必须是 approve 或 decline' } });
    }
    const reason = typeof input.reason === 'string' ? input.reason.slice(0, 500) : null;
    const outcome = await this.prisma.$transaction(async (tx) => {
      const approval = await tx.campaignApproval.findFirst({
        where: { id: approvalId, workspaceId: tenant.workspaceId },
        include: { revision: true },
      });
      if (!approval || approval.revision.campaignId !== campaignId) campaignNotFound();
      if (approval.state !== 'PENDING') {
        stateConflict('CAMPAIGN_APPROVAL_ALREADY_DECIDED', `审批已处于 ${approval.state}，不可重复决定`);
      }
      const now = new Date();
      if (approval.expiresAt <= now) {
        // 超时=拒绝：先落 EXPIRED 再拒绝本次操作（返回标记而非抛错，避免回滚状态迁移）。
        await tx.campaignApproval.update({ where: { id: approvalId }, data: { state: 'EXPIRED' } });
        await tx.campaignRevision.update({ where: { id: approval.revisionId }, data: { state: 'EXPIRED' } });
        await this.writeTrace(tx, {
          workspaceId: tenant.workspaceId,
          campaignId,
          revisionId: approval.revisionId,
          stepType: 'approval.expired',
          actor: 'system',
          actorType: 'service',
          decisionType: 'expire',
          approvalId,
          approvalState: 'EXPIRED',
          reasonCode: 'TIMEOUT_EQUALS_DECLINE',
        });
        return { kind: 'expired' as const };
      }
      const decided = await tx.campaignApproval.update({
        where: { id: approvalId },
        data: {
          state: decision === 'approve' ? 'APPROVED' : 'DECLINED',
          decidedBy: tenant.userId,
          decidedAt: now,
          decisionReason: reason,
        },
      });
      const selfApproval = approval.requestedBy === tenant.userId;
      if (decision === 'decline') {
        await tx.campaignRevision.update({
          where: { id: approval.revisionId },
          data: { state: 'DECLINED' },
        });
        await this.writeTrace(tx, {
          workspaceId: tenant.workspaceId,
          campaignId,
          revisionId: approval.revisionId,
          stepType: 'approval.decided',
          actor: tenant.userId,
          decisionType: 'decision',
          chosenOption: 'decline',
          approvalId,
          approvalState: 'DECLINED',
          reasonCode: selfApproval ? 'SELF_APPROVAL' : 'DECLINED',
        });
        return { kind: 'decided' as const, approval: decided, authorization: null };
      }
      const approvedRevision = await tx.campaignRevision.update({
        where: { id: approval.revisionId },
        data: { state: 'APPROVED' },
      });
      const campaign = await tx.campaign.findFirst({
        where: { id: campaignId, workspaceId: tenant.workspaceId },
      });
      if (campaign && campaign.status === 'DRAFT') {
        await tx.campaign.update({
          where: { id: campaignId },
          data: { status: 'ACTIVE', updatedBy: tenant.userId },
        });
      }
      const plan = approvedRevision.plan as unknown as CampaignPlanV0;
      const scope = {
        actions: plan.motions.map((motion) => ({ type: motion.type, icpIds: [...motion.icpIds] })),
        sizeCap: plan.audience.sizeCap,
      };
      const authorizationId = randomUUID();
      const token = await this.signer.sign(
        {
          authorizationId,
          workspaceId: tenant.workspaceId,
          campaignId,
          revisionId: approval.revisionId,
          planHash: approvedRevision.planHash,
          scope,
        },
        this.authzTtlSeconds,
      );
      const authorization = await tx.campaignExecutionAuthorization.create({
        data: {
          id: authorizationId,
          workspaceId: tenant.workspaceId,
          campaignId,
          revisionId: approval.revisionId,
          planHash: approvedRevision.planHash,
          scope: scope as unknown as Prisma.InputJsonValue,
          token,
          state: 'ISSUED',
          maxUses: 1,
          uses: 0,
          expiresAt: new Date(now.getTime() + this.authzTtlSeconds * 1000),
        },
      });
      await this.writeTrace(tx, {
        workspaceId: tenant.workspaceId,
        campaignId,
        revisionId: approval.revisionId,
        stepType: 'approval.decided',
        actor: tenant.userId,
        decisionType: 'decision',
        chosenOption: 'approve',
        approvalId,
        approvalState: 'APPROVED',
        reasonCode: selfApproval ? 'SELF_APPROVAL' : 'APPROVED',
      });
      await this.writeTrace(tx, {
        workspaceId: tenant.workspaceId,
        campaignId,
        revisionId: approval.revisionId,
        stepType: 'authorization.issued',
        actor: 'system',
        actorType: 'service',
        decisionType: 'issue',
        approvalId,
        chosenOption: authorizationId,
        reasonCode: 'APPROVED_PLAN',
      });
      return { kind: 'decided' as const, approval: decided, authorization };
    });
    if (outcome.kind === 'expired') {
      throw new ConflictException({
        error: { code: 'CAMPAIGN_APPROVAL_EXPIRED', message: '审批已超时（超时=拒绝），请重新提交' },
      });
    }
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'campaign.approval.decided',
      target: `campaign/${campaignId}`,
      detail: {
        approvalId,
        decision,
        authorizationId: outcome.authorization?.id ?? null,
      },
    });
    return outcome;
  }

  async revokeAuthorization(
    tenant: CampaignTenant,
    campaignId: string,
    authorizationId: string,
    reason?: unknown,
  ) {
    if (!UUID_RE.test(campaignId) || !UUID_RE.test(authorizationId)) campaignNotFound();
    const revokeReason =
      typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 200) : 'MANUAL_REVOKE';
    const result = await this.prisma.$transaction(async (tx) => {
      const authorization = await tx.campaignExecutionAuthorization.findFirst({
        where: { id: authorizationId, campaignId, workspaceId: tenant.workspaceId },
      });
      if (!authorization) campaignNotFound();
      if (authorization.state !== 'ISSUED') {
        stateConflict('CAMPAIGN_AUTHORIZATION_INVALID', `授权状态为 ${authorization.state}，不可撤销`);
      }
      const updated = await tx.campaignExecutionAuthorization.update({
        where: { id: authorizationId },
        data: { state: 'REVOKED', revokedAt: new Date(), revokeReason },
      });
      await this.writeTrace(tx, {
        workspaceId: tenant.workspaceId,
        campaignId,
        revisionId: authorization.revisionId,
        stepType: 'authorization.revoked',
        actor: tenant.userId,
        decisionType: 'revoke',
        chosenOption: authorizationId,
        reasonCode: revokeReason,
      });
      return updated;
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'campaign.authorization.revoked',
      target: `campaign/${campaignId}`,
      detail: { authorizationId, reason: revokeReason },
    });
    return result;
  }

  async listTrace(tenant: CampaignTenant, campaignId: string, cursor?: string, limit?: number) {
    if (!UUID_RE.test(campaignId) || (cursor !== undefined && !UUID_RE.test(cursor))) campaignNotFound();
    const take = Math.min(Math.max(limit ?? 50, 1), 200);
    const rows = await this.prisma.campaignDecisionTrace.findMany({
      where: { workspaceId: tenant.workspaceId, campaignId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null };
  }

  /**
   * 授权验证（引擎/M2.1 消费）：验签 → 过期 → DB 状态 → workspace 活跃 → plan_hash 与动作范围匹配。
   * 只读；uses 的消耗由消费方回报（M2.1）。
   */
  async verifyAuthorization(input: {
    token?: unknown;
    planHash?: unknown;
    action?: unknown;
  }): Promise<AuthorizationVerifyResult> {
    const token = typeof input.token === 'string' ? input.token : '';
    const planHash = typeof input.planHash === 'string' ? input.planHash : '';
    const action = input.action as { type?: unknown; icpIds?: unknown } | undefined;
    if (!token || !planHash || typeof action?.type !== 'string') {
      return { valid: false, reason: 'CAMPAIGN_AUTHORIZATION_INVALID' };
    }
    const claims = await this.signer.verify(token);
    if (!claims) return { valid: false, reason: 'CAMPAIGN_AUTHORIZATION_INVALID' };
    const authorization = await this.prisma.campaignExecutionAuthorization.findFirst({
      where: { id: claims.authorizationId, workspaceId: claims.workspaceId },
    });
    if (!authorization) return { valid: false, reason: 'CAMPAIGN_AUTHORIZATION_INVALID' };
    if (authorization.state === 'REVOKED') return { valid: false, reason: 'CAMPAIGN_AUTHORIZATION_REVOKED' };
    if (authorization.state !== 'ISSUED') return { valid: false, reason: 'CAMPAIGN_AUTHORIZATION_INVALID' };
    const now = new Date();
    if (authorization.expiresAt <= now) return { valid: false, reason: 'CAMPAIGN_AUTHORIZATION_EXPIRED' };
    if (authorization.planHash !== planHash || claims.planHash !== planHash) {
      return { valid: false, reason: 'CAMPAIGN_AUTHORIZATION_INVALID' };
    }
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: authorization.workspaceId },
      select: { status: true },
    });
    if (!workspace || workspace.status !== 'ACTIVE') {
      return { valid: false, reason: 'CAMPAIGN_AUTHORIZATION_REVOKED' };
    }
    const scope = authorization.scope as {
      actions?: Array<{ type?: string; icpIds?: string[] }>;
    };
    const matched = (scope.actions ?? []).find((item) => item.type === action.type);
    if (!matched) return { valid: false, reason: 'CAMPAIGN_AUTHORIZATION_INVALID' };
    if (Array.isArray(action.icpIds) && action.icpIds.length > 0) {
      const allowed = new Set(matched.icpIds ?? []);
      for (const icpId of action.icpIds) {
        if (typeof icpId !== 'string' || !allowed.has(icpId)) {
          return { valid: false, reason: 'CAMPAIGN_AUTHORIZATION_INVALID' };
        }
      }
    }
    return {
      valid: true,
      authorization: {
        id: authorization.id,
        campaignId: authorization.campaignId,
        revisionId: authorization.revisionId,
        planHash: authorization.planHash,
        scope: authorization.scope,
        remainingUses: Math.max(authorization.maxUses - authorization.uses, 0),
      },
    };
  }

  /** workspace 停用/归档联动：撤销该空间全部未过期授权（§8 安全与合规）。 */
  async revokeAllIssuedForWorkspace(workspaceId: string, reason: string): Promise<number> {
    const result = await this.prisma.campaignExecutionAuthorization.updateMany({
      where: { workspaceId, state: 'ISSUED' },
      data: { state: 'REVOKED', revokedAt: new Date(), revokeReason: reason.slice(0, 200) },
    });
    return result.count;
  }

  private async writeTrace(
    tx: Prisma.TransactionClient,
    input: {
      workspaceId: string;
      campaignId?: string | null;
      revisionId?: string | null;
      stepType: string;
      actor: string;
      actorType?: string;
      decisionType: string;
      chosenOption?: string | null;
      reasonCode?: string | null;
      gate?: string | null;
      approvalState?: string | null;
      approvalId?: string | null;
      evidence?: unknown;
      rejectedCandidates?: unknown;
      score?: number | null;
    },
  ): Promise<void> {
    await tx.campaignDecisionTrace.create({
      data: {
        workspaceId: input.workspaceId,
        campaignId: input.campaignId ?? null,
        revisionId: input.revisionId ?? null,
        traceId: randomUUID(),
        parentTraceId: null,
        stepType: input.stepType,
        actor: input.actor,
        actorType: input.actorType ?? 'user',
        attempt: 1,
        decisionType: input.decisionType,
        gate: input.gate ?? null,
        policyVersion: 'campaign-control-plane/v0',
        chosenOption: input.chosenOption ?? null,
        score: input.score ?? null,
        reasonCode: input.reasonCode ?? null,
        ...(input.evidence !== undefined
          ? { evidence: input.evidence as Prisma.InputJsonValue }
          : {}),
        ...(input.rejectedCandidates !== undefined
          ? { rejectedCandidates: input.rejectedCandidates as Prisma.InputJsonValue }
          : {}),
        approvalState: input.approvalState ?? null,
        approvalId: input.approvalId ?? null,
      },
    });
  }
}
