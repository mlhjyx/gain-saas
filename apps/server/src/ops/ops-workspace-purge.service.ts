import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import type { AppConfig } from '../config/configuration.js';
import { AuditService } from '../shared/audit.service.js';
import { APP_CONFIG } from '../shared/config.module.js';
import { PrismaService } from '../shared/prisma.service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_CONTROL_CHARS_RE = /^[^\u0000-\u001f\u007f]+$/;

const PurgeWorkspaceBodySchema = z
  .object({
    idempotencyKey: z
      .string()
      .regex(NO_CONTROL_CHARS_RE, 'idempotencyKey 不能包含控制字符')
      .transform((value) => value.trim())
      .refine((value) => value.length >= 1 && value.length <= 128, 'idempotencyKey 长度须在 1..128 之间')
      .optional(),
    force: z.boolean().optional(),
  })
  .strict();

export interface WorkspacePurgeReceiptDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly idempotencyKey: string;
  readonly status: string;
  readonly requestedBy: string;
  readonly offboardingRequestId: string | null;
  readonly forced: boolean;
  readonly revokedSessions: number;
  readonly deletedCounts: Record<string, number>;
  readonly enginePurgeReceiptId: string | null;
  readonly enginePurgeStatus: string | null;
  readonly errorCode: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

interface PurgeReceiptRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly idempotencyKey: string;
  readonly status: string;
  readonly requestedBy: string;
  readonly offboardingRequestId: string | null;
  readonly forced: boolean;
  readonly revokedSessions: number;
  readonly deletedCounts: unknown;
  readonly campaignPlanJobIds?: unknown;
  readonly enginePurgeReceiptId: string | null;
  readonly enginePurgeStatus: string | null;
  readonly errorCode: string | null;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
}

function parseDeletedCounts(raw: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        counts[key] = value;
      }
    }
  }
  return counts;
}

function mergeDeletedCounts(prevRaw: unknown, next: Record<string, number>): Record<string, number> {
  const merged = parseDeletedCounts(prevRaw);
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (value > 0 || !(key in merged)) {
        merged[key] = (merged[key] ?? 0) + value;
      }
    }
  }
  return merged;
}

function mergeUuidList(prevRaw: unknown, next: string[], limit = 100): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (value: unknown) => {
    if (out.length >= limit) return;
    if (typeof value === 'string' && UUID_RE.test(value) && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  };
  if (Array.isArray(prevRaw)) {
    for (const item of prevRaw) push(item);
  }
  for (const item of next) push(item);
  return out;
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002');
}

function serializeReceipt(row: PurgeReceiptRow): WorkspacePurgeReceiptDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    requestedBy: row.requestedBy,
    offboardingRequestId: row.offboardingRequestId,
    forced: row.forced,
    revokedSessions: row.revokedSessions,
    deletedCounts: parseDeletedCounts(row.deletedCounts),
    enginePurgeReceiptId: row.enginePurgeReceiptId,
    enginePurgeStatus: row.enginePurgeStatus,
    errorCode: row.errorCode,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

/**
 * 运营整空间物理清理服务（MT-P1）：
 * 1. 缺内部服务令牌 fail-closed 503；idempotencyKey 拒绝控制字符；非强制清理须满足 7 天离网冷却期已到期。
 * 2. 在 gain_saas 租户上下文事务（含 workspace 级事务咨询锁）内完成：吊销并清除全部会话、停用 workspace_registry、
 *    归档匿名化 workspace、按外键安全顺序清空全部 50 张租户业务/PII 表、脱敏租户审计日志与离网 reason、落 IN_PROGRESS 回执
 *    （同时持久化无 PII 的 campaignPlanJobIds，确保 FAILED 重试不丢失且累计保留首次真实计数）。
 * 3. 事务外调用引擎 POST /api/v1/internal/workspaces/:id/purge（x-service-token）清理引擎数据与 MinIO。
 * 4. 引擎成功后将回执标 COMPLETED、同步离网申请为 PURGED 并记 ops 审计；引擎失败标 FAILED 并抛 502（可同幂等键重试）。
 */
@Injectable()
export class OpsWorkspacePurgeService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getPurgeReceipt(workspaceId: string): Promise<WorkspacePurgeReceiptDto | null> {
    this.assertUuid(workspaceId);
    const row = await this.prisma.withWorkspace(workspaceId, (tx) =>
      tx.workspacePurgeReceipt.findFirst({
        where: { workspaceId },
        orderBy: { startedAt: 'desc' },
      }),
    );
    if (!row) return null;

    // 若引擎侧物理清理尚未终态且配置了令牌，尝试尽力拉取最新状态（不影响本地只读回执）
    const token = this.config.WORKSPACE_PURGE_INTERNAL_SERVICE_TOKEN?.trim();
    if (
      token &&
      row.status === 'COMPLETED' &&
      row.enginePurgeReceiptId &&
      row.enginePurgeStatus !== 'COMPLETED'
    ) {
      const refreshed = await this.fetchEnginePurgeStatus(workspaceId, token);
      if (refreshed && refreshed !== row.enginePurgeStatus) {
        const updated = await this.prisma.withWorkspace(workspaceId, (tx) =>
          tx.workspacePurgeReceipt.update({
            where: { id: row.id },
            data: { enginePurgeStatus: refreshed },
          }),
        );
        return serializeReceipt(updated);
      }
    }

    return serializeReceipt(row);
  }

  async purgeWorkspace(
    workspaceId: string,
    body: unknown,
    opsActorId: string,
    now: Date = new Date(),
  ): Promise<WorkspacePurgeReceiptDto> {
    this.assertUuid(workspaceId);
    const token = this.config.WORKSPACE_PURGE_INTERNAL_SERVICE_TOKEN?.trim();
    if (!token) {
      throw new ServiceUnavailableException({
        error: {
          code: 'WORKSPACE_PURGE_NOT_CONFIGURED',
          message: '未配置工作空间物理清理服务令牌（WORKSPACE_PURGE_INTERNAL_SERVICE_TOKEN），拒绝执行清理',
        },
      });
    }

    const parsed = PurgeWorkspaceBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: '工作空间物理清理参数不合法' },
      });
    }

    const force = parsed.data.force === true;
    const idempotencyKey = parsed.data.idempotencyKey ?? `purge-${workspaceId}`;

    const phase1 = await this.prisma.withWorkspace(workspaceId, async (tx) => {
      // 串行化同一工作空间的物理清理请求，防止并发击穿唯一索引产生 500
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('workspace-purge'), hashtext(${workspaceId}))`;

      const existing = await tx.workspacePurgeReceipt.findFirst({
        where: { workspaceId, idempotencyKey },
      });
      if (existing) {
        if (existing.status === 'COMPLETED') {
          return { replay: true as const, receipt: serializeReceipt(existing) };
        }
        if (existing.status === 'IN_PROGRESS') {
          throw new ConflictException({
            error: { code: 'WORKSPACE_PURGE_IN_PROGRESS', message: '该工作空间物理清理正在进行中' },
          });
        }
      }

      const isFailedRetry = existing?.status === 'FAILED';

      const workspace = await tx.workspace.findUnique({ where: { id: workspaceId } });
      if (!workspace) {
        throw new NotFoundException({ error: { code: 'WORKSPACE_NOT_FOUND', message: '工作空间不存在' } });
      }

      const offboarding = await tx.workspaceOffboardingRequest.findFirst({
        where: { workspaceId, status: 'SCHEDULED' },
        orderBy: { requestedAt: 'desc' },
      });

      // FAILED 同幂等键重试已于首次通过冷却期校验并完成本地清理，不再重复要求存在 SCHEDULED 申请
      if (!force && !isFailedRetry) {
        if (!offboarding) {
          throw new ConflictException({
            error: {
              code: 'OFFBOARDING_NOT_SCHEDULED',
              message: '该工作空间未发起离网注销申请；如需紧急强制清理请显式传入 force=true',
            },
          });
        }
        if (offboarding.coolOffEndsAt.getTime() > now.getTime()) {
          throw new ConflictException({
            error: {
              code: 'OFFBOARDING_COOL_OFF_ACTIVE',
              message: '该工作空间仍处于 7 天离网冷却期内，冷却期结束前不可物理清理',
            },
          });
        }
      }

      const planJobs = await tx.campaignPlanJob.findMany({
        where: { workspaceId },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      const campaignPlanJobIds = mergeUuidList(
        existing?.campaignPlanJobIds,
        planJobs.map((j) => j.id),
        100,
      );

      // 1. 吊销并清除该工作空间全部会话（先 revoke 统计活跃数，再删会话表行）
      const revoked = await tx.session.updateMany({
        where: { workspaceId, revokedAt: null },
        data: { revokedAt: now },
      });
      const deletedSessions = await tx.session.deleteMany({ where: { workspaceId } });

      // 2. 停用事件消费游标并归档匿名化工作空间壳记录（保留无 PII 壳行以满足 workspace_registry 外键与防重复创建）
      await tx.workspaceRegistry.updateMany({
        where: { workspaceId },
        data: { enabled: false, cursor: null },
      });
      await tx.workspace.update({
        where: { id: workspaceId },
        data: {
          status: 'ARCHIVED',
          name: 'PURGED',
          onboardingCompanyId: null,
          statusNote: 'PURGED',
          statusUpdatedAt: now,
          statusUpdatedBy: opsActorId,
        },
      });

      // 3. 按外键子表先于父表顺序清空全部 50 张租户业务与 PII 表
      const where = { workspaceId };
      const tableDeletions: Array<[string, () => Promise<{ count: number }>]> = [
        ['outreach_send_job', () => tx.outreachSendJob.deleteMany({ where })],
        ['outreach_send', () => tx.outreachSend.deleteMany({ where })],
        ['outreach_bounce_writeback', () => tx.outreachBounceWriteback.deleteMany({ where })],
        ['outreach_draft', () => tx.outreachDraft.deleteMany({ where })],
        ['outreach_batch_approval', () => tx.outreachBatchApproval.deleteMany({ where })],
        ['outreach_batch_event', () => tx.outreachBatchEvent.deleteMany({ where })],
        ['outreach_audit_package', () => tx.outreachAuditPackage.deleteMany({ where })],
        ['outreach_batch', () => tx.outreachBatch.deleteMany({ where })],
        ['outreach_reply', () => tx.outreachReply.deleteMany({ where })],
        ['outreach_unsubscribe_token', () => tx.outreachUnsubscribeToken.deleteMany({ where })],
        ['outreach_consent', () => tx.outreachConsent.deleteMany({ where })],
        ['outreach_call_attempt', () => tx.outreachCallAttempt.deleteMany({ where })],
        ['outreach_call_basis', () => tx.outreachCallBasis.deleteMany({ where })],
        ['outreach_experiment_assignment', () => tx.outreachExperimentAssignment.deleteMany({ where })],
        ['outreach_experiment', () => tx.outreachExperiment.deleteMany({ where })],
        ['outreach_metric_snapshot', () => tx.outreachMetricSnapshot.deleteMany({ where })],
        ['outreach_health_event', () => tx.outreachHealthEvent.deleteMany({ where })],
        ['outreach_breaker', () => tx.outreachBreaker.deleteMany({ where })],
        ['outreach_seed_test', () => tx.outreachSeedTest.deleteMany({ where })],
        ['outreach_mailbox_counter', () => tx.outreachMailboxCounter.deleteMany({ where })],
        ['outreach_mailbox', () => tx.outreachMailbox.deleteMany({ where })],
        ['outreach_domain_counter', () => tx.outreachDomainCounter.deleteMany({ where })],
        ['outreach_domain', () => tx.outreachDomain.deleteMany({ where })],
        ['outreach_template_version', () => tx.outreachTemplateVersion.deleteMany({ where })],
        ['legal_review', () => tx.legalReview.deleteMany({ where })],
        ['opportunity_outcome', () => tx.opportunityOutcome.deleteMany({ where })],
        ['sao', () => tx.sao.deleteMany({ where })],
        ['qgo', () => tx.qgo.deleteMany({ where })],
        ['campaign_plan_job', () => tx.campaignPlanJob.deleteMany({ where })],
        ['campaign_approval', () => tx.campaignApproval.deleteMany({ where })],
        ['campaign_audience', () => tx.campaignAudience.deleteMany({ where })],
        ['campaign_decision_trace', () => tx.campaignDecisionTrace.deleteMany({ where })],
        ['campaign_execution_authorization', () => tx.campaignExecutionAuthorization.deleteMany({ where })],
        ['campaign_revision', () => tx.campaignRevision.deleteMany({ where })],
        ['campaign', () => tx.campaign.deleteMany({ where })],
        ['task_run', () => tx.taskRun.deleteMany({ where })],
        ['acquisition_task', () => tx.acquisitionTask.deleteMany({ where })],
        ['discovery_run_link', () => tx.discoveryRunLink.deleteMany({ where })],
        ['qualified_lead', () => tx.qualifiedLead.deleteMany({ where })],
        ['event_inbox', () => tx.eventInbox.deleteMany({ where })],
        ['notification', () => tx.notification.deleteMany({ where })],
        ['feedback_submission', () => tx.feedbackSubmission.deleteMany({ where })],
        ['idempotency_record', () => tx.idempotencyRecord.deleteMany({ where })],
        ['deletion_mirror', () => tx.deletionMirror.deleteMany({ where })],
        ['cost_ledger', () => tx.costLedger.deleteMany({ where })],
        ['workspace_compliance_declaration', () => tx.workspaceComplianceDeclaration.deleteMany({ where })],
        ['workspace_budget_policy', () => tx.workspaceBudgetPolicy.deleteMany({ where })],
        ['workspace_storage_quota', () => tx.workspaceStorageQuota.deleteMany({ where })],
        ['invitation', () => tx.invitation.deleteMany({ where })],
        ['membership', () => tx.membership.deleteMany({ where })],
      ];

      const freshDeletedCounts: Record<string, number> = {
        session: deletedSessions.count,
      };
      for (const [tableName, runDelete] of tableDeletions) {
        const res = await runDelete();
        if (res.count > 0) {
          freshDeletedCounts[tableName] = res.count;
        }
      }

      // 4. 脱敏该工作空间的租户域审计日志（抹除明文 detail 与 target，保留无 PII 审计骨架）
      const redactedAudit = await tx.auditLog.updateMany({
        where: { workspaceId, realm: 'tenant' },
        data: { detail: { redacted: true }, target: null },
      });
      if (redactedAudit.count > 0) {
        freshDeletedCounts.tenant_audit_redacted = redactedAudit.count;
      }

      // 4b. 充值钱包无 PII 财务留痕与脱敏清理：
      //     - 释放仍在 HELD 的预占单（EXPIRED_RELEASED）并记账，确保 held_credits 归零；
      //     - 冻结 wallet_account（status='FROZEN'），保留不可变财务双录数值用于法定/对账留痕；
      //     - 清空 wallet_credit_lot.note 与 wallet_ledger.note 中的自由文本以消除潜在 PII。
      const walletAccount = await tx.walletAccount.findUnique({ where: { workspaceId } });
      if (walletAccount) {
        const openHolds = await tx.walletHold.findMany({
          where: { workspaceId, status: 'HELD' },
        });
        let runningAvail = walletAccount.availableCredits;
        let runningHeld = walletAccount.heldCredits;
        let releasedHolds = 0;
        for (const hold of openHolds) {
          const refund = hold.heldCredits;
          runningAvail += refund;
          runningHeld = runningHeld >= refund ? runningHeld - refund : 0n;
          await tx.walletHold.update({
            where: { id: hold.id },
            data: {
              status: 'EXPIRED_RELEASED',
              settledCredits: 0n,
              releasedCredits: refund,
              settledAt: now,
            },
          });
          await tx.walletLedger.create({
            data: {
              workspaceId,
              idempotencyKey: `purge-release:${hold.id}`,
              entryType: 'EXPIRE',
              deltaAvailable: refund,
              deltaHeld: -refund,
              balanceAvailable: runningAvail,
              balanceHeld: runningHeld,
              revenueMicros: 0n,
              holdId: hold.id,
              actionCode: hold.actionCode,
              refType: hold.refType,
              refId: hold.refId,
              billableUnits: 0,
              note: null,
              actorId: opsActorId,
            },
          });
          releasedHolds += 1;
        }
        await tx.walletAccount.update({
          where: { workspaceId },
          data: {
            status: 'FROZEN',
            availableCredits: runningAvail,
            heldCredits: runningHeld,
            version: walletAccount.version + 1n,
          },
        });
        const redactedLotNotes = await tx.walletCreditLot.updateMany({
          where: { workspaceId, note: { not: null } },
          data: { note: null },
        });
        const redactedLedgerNotes = await tx.walletLedger.updateMany({
          where: { workspaceId, note: { not: null } },
          data: { note: null },
        });
        freshDeletedCounts.wallet_account_frozen = 1;
        if (releasedHolds > 0) {
          freshDeletedCounts.wallet_holds_released = releasedHolds;
        }
        const totalWalletNotesRedacted = redactedLotNotes.count + redactedLedgerNotes.count;
        if (totalWalletNotesRedacted > 0) {
          freshDeletedCounts.wallet_notes_redacted = totalWalletNotesRedacted;
        }
      }

      // 5. 立即擦除该工作空间全部离网申请历史中的自由文本 reason（防含 PII）；
      //    离网申请状态推进至 PURGED 留待 Phase 2 引擎清理成功后再落终态，避免失败重试语义断裂。
      await tx.workspaceOffboardingRequest.updateMany({
        where: { workspaceId },
        data: { reason: null },
      });

      const totalRevokedSessions = (existing?.revokedSessions ?? 0) + revoked.count;
      const mergedDeletedCounts = isFailedRetry
        ? mergeDeletedCounts(existing?.deletedCounts, freshDeletedCounts)
        : freshDeletedCounts;
      const targetOffboardingId = existing?.offboardingRequestId ?? offboarding?.id ?? null;
      const effectiveForced = (existing?.forced ?? false) || force;

      // 6. 写入或复用（重试 FAILED）无 PII 清理回执（累加保留首次真实清理计数与 campaignPlanJobIds）
      let receiptRow: PurgeReceiptRow;
      if (existing) {
        receiptRow = await tx.workspacePurgeReceipt.update({
          where: { id: existing.id },
          data: {
            status: 'IN_PROGRESS',
            requestedBy: opsActorId,
            offboardingRequestId: targetOffboardingId,
            forced: effectiveForced,
            revokedSessions: totalRevokedSessions,
            deletedCounts: mergedDeletedCounts,
            campaignPlanJobIds,
            errorCode: null,
            completedAt: null,
          },
        });
      } else {
        try {
          receiptRow = await tx.workspacePurgeReceipt.create({
            data: {
              workspaceId,
              idempotencyKey,
              status: 'IN_PROGRESS',
              requestedBy: opsActorId,
              offboardingRequestId: targetOffboardingId,
              forced: effectiveForced,
              revokedSessions: totalRevokedSessions,
              deletedCounts: mergedDeletedCounts,
              campaignPlanJobIds,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new ConflictException({
              error: { code: 'WORKSPACE_PURGE_IN_PROGRESS', message: '该工作空间物理清理正在进行中' },
            });
          }
          throw err;
        }
      }

      return {
        replay: false as const,
        receiptId: receiptRow.id,
        offboardingRequestId: targetOffboardingId,
        forced: effectiveForced,
        revokedSessions: totalRevokedSessions,
        deletedCounts: mergedDeletedCounts,
        campaignPlanJobIds,
      };
    });

    if (phase1.replay) {
      return phase1.receipt;
    }

    // Phase 2（事务外）：调用引擎内部整空间物理清理接口
    const engineResult = await this.invokeEnginePurge(workspaceId, token, {
      idempotencyKey,
      requestedBy: opsActorId,
      campaignPlanJobIds: phase1.campaignPlanJobIds,
    });

    if (!engineResult.ok) {
      await this.prisma.withWorkspace(workspaceId, (tx) =>
        tx.workspacePurgeReceipt.update({
          where: { id: phase1.receiptId },
          data: {
            status: 'FAILED',
            errorCode: engineResult.errorCode,
          },
        }),
      );
      await this.audit.record({
        realm: 'ops',
        actorId: opsActorId,
        workspaceId,
        action: 'workspace.purge.failed',
        target: phase1.receiptId,
        detail: {
          idempotencyKey,
          forced: phase1.forced,
          errorCode: engineResult.errorCode,
        },
      });
      throw new HttpException(
        {
          error: {
            code: engineResult.errorCode,
            message: '引擎侧工作空间物理清理调用失败，已记录失败回执，可携同一幂等键重试',
          },
        },
        502,
      );
    }

    const completedAt = new Date();
    const completed = await this.prisma.withWorkspace(workspaceId, async (tx) => {
      if (phase1.offboardingRequestId) {
        await tx.workspaceOffboardingRequest.update({
          where: { id: phase1.offboardingRequestId },
          data: {
            status: 'PURGED',
            purgedBy: opsActorId,
            purgedAt: completedAt,
            reason: null,
          },
        });
      }
      return tx.workspacePurgeReceipt.update({
        where: { id: phase1.receiptId },
        data: {
          status: 'COMPLETED',
          enginePurgeReceiptId: engineResult.receiptId,
          enginePurgeStatus: engineResult.status,
          errorCode: null,
          completedAt,
        },
      });
    });

    await this.audit.record({
      realm: 'ops',
      actorId: opsActorId,
      workspaceId,
      action: 'workspace.purge',
      target: completed.id,
      detail: {
        idempotencyKey,
        forced: phase1.forced,
        revokedSessions: phase1.revokedSessions,
        enginePurgeReceiptId: engineResult.receiptId,
        enginePurgeStatus: engineResult.status,
      },
    });

    return serializeReceipt(completed);
  }

  private async invokeEnginePurge(
    workspaceId: string,
    token: string,
    payload: {
      readonly idempotencyKey: string;
      readonly requestedBy: string;
      readonly campaignPlanJobIds: string[];
    },
  ): Promise<
    | { readonly ok: true; readonly receiptId: string | null; readonly status: string }
    | { readonly ok: false; readonly errorCode: string }
  > {
    const base = this.config.ENGINE_ORIGIN.replace(/\/$/, '');
    const url = `${base}/api/v1/internal/workspaces/${encodeURIComponent(workspaceId)}/purge`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-service-token': token,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      let parsed: Record<string, unknown> | null = null;
      if (text) {
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          parsed = null;
        }
      }
      if (!response.ok) {
        const errObj = parsed?.error as Record<string, unknown> | undefined;
        const rawCode =
          typeof errObj?.code === 'string' && errObj.code.trim()
            ? errObj.code.trim()
            : `ENGINE_PURGE_HTTP_${response.status}`;
        return { ok: false, errorCode: rawCode.slice(0, 64) };
      }
      const data = (parsed?.data ?? parsed) as Record<string, unknown> | undefined;
      const receiptId = typeof data?.id === 'string' && UUID_RE.test(data.id) ? data.id : null;
      const status =
        typeof data?.status === 'string' && data.status.trim()
          ? data.status.trim().slice(0, 32)
          : 'PENDING';
      return { ok: true, receiptId, status };
    } catch {
      return { ok: false, errorCode: 'ENGINE_PURGE_UNREACHABLE' };
    }
  }

  private async fetchEnginePurgeStatus(workspaceId: string, token: string): Promise<string | null> {
    const base = this.config.ENGINE_ORIGIN.replace(/\/$/, '');
    const url = `${base}/api/v1/internal/workspaces/${encodeURIComponent(workspaceId)}/purge`;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'x-service-token': token },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return null;
      const parsed = (await response.json()) as { data?: { status?: unknown } };
      return typeof parsed?.data?.status === 'string' && parsed.data.status.trim()
        ? parsed.data.status.trim().slice(0, 32)
        : null;
    } catch {
      return null;
    }
  }

  private assertUuid(value: string): void {
    if (!UUID_RE.test(value)) {
      throw new NotFoundException({ error: { code: 'WORKSPACE_NOT_FOUND', message: '工作空间不存在' } });
    }
  }
}
