import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpException,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { TaskRun } from '@prisma/client';
import type { Request } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PrismaService } from '../shared/prisma.service.js';
import { AuditService } from '../shared/audit.service.js';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { DISCOVERY_TASK_RUN_WALLET_REF, DISCOVERY_WALLET_ACTION } from '../wallet/bff-wallet-billing.js';
import { WalletService } from '../wallet/wallet.service.js';
import { EngineHttp } from './engine-http.js';
import { EngineBudgetGrantService, EngineBudgetQuoteError } from './engine-budget-grant.service.js';
import { WorkspaceBudgetQuotaExceededError } from './workspace-budget-policy.service.js';
import { canonicalExecuteBody, isManufacturerNetworkRevision } from './routes.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** task.icpId 为空且引擎未回传 icpId 时的占位 UUID：确保 discovery_run_link 始终落账，封堵 icpId=null 配额绕过。 */
const UNSCOPED_TASK_ICP_ID = '00000000-0000-4000-8000-000000000000';
const MAX_TASK_NAME = 200;
type AcquisitionTaskStatus = 'active' | 'paused' | 'archived';
type TaskRunAllocation =
  | { replayed: true; run: Pick<TaskRun, 'id' | 'engineRunId' | 'status'> }
  | { replayed: false; run: Pick<TaskRun, 'id' | 'attempt'>; previousAttempt: string | null; holdId: string | null };
const TASK_STATUSES = new Set<AcquisitionTaskStatus>(['active', 'paused', 'archived']);
const ALLOWED_PATCH_FIELDS = new Set(['name', 'status']);
const ALLOWED_TASK_STATUS_TRANSITIONS: Record<AcquisitionTaskStatus, ReadonlySet<AcquisitionTaskStatus>> = {
  active: new Set<AcquisitionTaskStatus>(['active', 'paused', 'archived']),
  paused: new Set<AcquisitionTaskStatus>(['active', 'paused', 'archived']),
  archived: new Set<AcquisitionTaskStatus>(['archived']),
};

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}

interface TaskRow {
  id: string;
  icpId: string | null;
  name: string;
  status: string;
  createdBy: string;
  lastRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { runs: number };
  runs?: Array<{
    id: string;
    engineRunId: string | null;
    planId?: string | null;
    attempt?: number;
    rerunOf?: string | null;
    trigger: string;
    status: string;
    startedAt: Date;
    finishedAt: Date | null;
  }>;
}

function taskView(row: TaskRow) {
  const runs = (row.runs ?? []).map((run) => ({
    id: run.id,
    runId: run.engineRunId,
    planId: run.planId ?? null,
    attempt: run.attempt ?? 1,
    rerunOf: run.rerunOf ?? null,
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  }));
  return {
    id: row.id,
    icpId: row.icpId,
    name: row.name,
    status: row.status,
    createdBy: row.createdBy,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    runCount: row._count?.runs ?? runs.length,
    runs,
  };
}

/**
 * Run 2.0（M0②）：挖掘任务对象（AcquisitionTask / TaskRun）。
 *
 * - 任务=挖掘需求，绑定引擎侧 ICP；每次执行创建一条 TaskRun，再经 BFF 的 quote→Grant
 *   流程调用引擎 `POST /query-plans/:id/execute`，并以 `taskRef` 把 (taskId, taskRunId)
 *   带给引擎（引擎写入 discovery_run.task_ref）。
 * - TaskRun.status 镜像引擎 run 状态：事件消费者在 `DiscoveryRunCompleted` 时回写，
 *   这里只在发起时置 RUNNING、失败时置 FAILED。
 */
@Controller('api/tasks')
@UseGuards(TenantGuard)
export class AcquisitionTasksController {
  private readonly logger = new Logger(AcquisitionTasksController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: EngineHttp,
    private readonly budget: EngineBudgetGrantService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly wallet: WalletService,
  ) {}

  @Get()
  async list(@Req() req: Request, @Query('icpId') icpId?: string) {
    const tenant = req.tenant!;
    if (icpId !== undefined && !UUID.test(icpId)) invalid('icpId 必须是 UUID');
    const rows = await this.prisma.withWorkspace(tenant.workspaceId, (tx) =>
      tx.acquisitionTask.findMany({
        where: { workspaceId: tenant.workspaceId, ...(icpId ? { icpId } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: {
          runs: { orderBy: { createdAt: 'desc' }, take: 20 },
          _count: { select: { runs: true } },
        },
      }),
    );
    return { data: (rows as unknown as TaskRow[]).map(taskView) };
  }

  @Get(':taskId')
  async getOne(@Req() req: Request, @Param('taskId') taskId: string) {
    const tenant = req.tenant!;
    if (!UUID.test(taskId)) invalid('taskId 必须是 UUID');
    const task = await this.prisma.withWorkspace(tenant.workspaceId, (tx) =>
      tx.acquisitionTask.findFirst({
        where: { id: taskId, workspaceId: tenant.workspaceId },
        include: {
          runs: { orderBy: { createdAt: 'desc' }, take: 20 },
          _count: { select: { runs: true } },
        },
      }),
    );
    if (!task) {
      throw new NotFoundException({ error: { code: 'TASK_NOT_FOUND', message: '任务不存在' } });
    }
    return { data: taskView(task as unknown as TaskRow) };
  }

  @Patch(':taskId')
  async update(
    @Req() req: Request,
    @Param('taskId') taskId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const tenant = req.tenant!;
    if (!UUID.test(taskId)) invalid('taskId 必须是 UUID');
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      invalid('请求体必须是 JSON 对象');
    }
    const unknownFields = Object.keys(body).filter((key) => !ALLOWED_PATCH_FIELDS.has(key));
    if (unknownFields.length > 0) {
      invalid(`不允许更新的字段：${unknownFields.join(', ')}`);
    }

    let nextName: string | undefined;
    if (Object.prototype.hasOwnProperty.call(body, 'name') && body.name !== undefined) {
      if (typeof body.name !== 'string') {
        invalid(`name 必须是 1–${MAX_TASK_NAME} 个字符`);
      }
      const trimmed = body.name.trim();
      if (trimmed.length < 1 || trimmed.length > MAX_TASK_NAME) {
        invalid(`name 必须是 1–${MAX_TASK_NAME} 个字符`);
      }
      nextName = trimmed;
    }

    let nextStatus: AcquisitionTaskStatus | undefined;
    if (Object.prototype.hasOwnProperty.call(body, 'status') && body.status !== undefined) {
      if (typeof body.status !== 'string' || !TASK_STATUSES.has(body.status as AcquisitionTaskStatus)) {
        invalid('status 必须是 active、paused 或 archived');
      }
      nextStatus = body.status as AcquisitionTaskStatus;
    }

    if (nextName === undefined && nextStatus === undefined) {
      invalid('至少需要提供 name 或 status');
    }

    const { existing, updated } = await this.prisma.withWorkspace(tenant.workspaceId, async (tx) => {
      const current = await tx.acquisitionTask.findFirst({
        where: { id: taskId, workspaceId: tenant.workspaceId },
      });
      if (!current) {
        throw new NotFoundException({ error: { code: 'TASK_NOT_FOUND', message: '任务不存在' } });
      }
      if (nextStatus !== undefined) {
        const currentStatus = current.status as AcquisitionTaskStatus;
        if (!ALLOWED_TASK_STATUS_TRANSITIONS[currentStatus]?.has(nextStatus)) {
          throw new BadRequestException({
            error: { code: 'INVALID_STATE', message: '已归档的任务不允许恢复或暂停' },
          });
        }
      }
      const data: { name?: string; status?: AcquisitionTaskStatus } = {};
      if (nextName !== undefined) data.name = nextName;
      if (nextStatus !== undefined) data.status = nextStatus;

      const saved = await tx.acquisitionTask.update({
        where: { id: current.id },
        data,
        include: {
          runs: { orderBy: { createdAt: 'desc' }, take: 20 },
          _count: { select: { runs: true } },
        },
      });
      return { existing: current, updated: saved };
    });

    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      workspaceId: tenant.workspaceId,
      action: 'acquisition.task.update',
      target: updated.id,
      detail: {
        ...(nextName !== undefined ? { nameChanged: existing.name !== updated.name } : {}),
        ...(nextStatus !== undefined ? { fromStatus: existing.status, toStatus: updated.status } : {}),
      },
    });

    return { data: taskView(updated as unknown as TaskRow) };
  }

  @Post()
  async create(@Req() req: Request, @Body() body: Record<string, unknown>) {
    const tenant = req.tenant!;
    const icpId = body?.icpId;
    if (icpId !== undefined && icpId !== null && (typeof icpId !== 'string' || !UUID.test(icpId))) {
      invalid('icpId 必须是 UUID');
    }
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > MAX_TASK_NAME) {
      invalid(`name 必须是 1–${MAX_TASK_NAME} 个字符`);
    }
    const task = await this.prisma.withWorkspace(tenant.workspaceId, (tx) =>
      tx.acquisitionTask.create({
        data: {
          workspaceId: tenant.workspaceId,
          icpId: (icpId as string | null | undefined) ?? null,
          name,
          createdBy: tenant.userId,
        },
      }),
    );
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      workspaceId: tenant.workspaceId,
      action: 'acquisition.task.create',
      target: task.id,
      detail: { icpId: task.icpId },
    });
    return { data: taskView({ ...task, runs: [] } as unknown as TaskRow) };
  }

  @Post(':taskId/runs')
  async startRun(
    @Req() req: Request,
    @Param('taskId') taskId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const tenant = req.tenant!;
    if (!UUID.test(taskId)) invalid('taskId 必须是 UUID');
    const planId = typeof body?.planId === 'string' ? body.planId : '';
    if (!UUID.test(planId)) invalid('planId 必须是 UUID');

    const task = await this.prisma.withWorkspace(tenant.workspaceId, (tx) =>
      tx.acquisitionTask.findFirst({
        where: { id: taskId, workspaceId: tenant.workspaceId },
      }),
    );
    if (!task) {
      throw new NotFoundException({ error: { code: 'TASK_NOT_FOUND', message: '任务不存在' } });
    }
    if (task.status === 'archived') {
      throw new ConflictException({ error: { code: 'TASK_ARCHIVED', message: '任务已归档，不能发起执行' } });
    }

    // P1 attempt 维度：attemptId 由前端在「用户意图」粒度生成（双击复用同一键）；老客户端不带时，
    // 开关打开则服务端兜底生成一次性 attempt（行为等同现状，但同一计划不再被防重放砖化）。
    const rawAttemptId = body?.attemptId;
    if (rawAttemptId !== undefined && (typeof rawAttemptId !== 'string' || !UUID.test(rawAttemptId))) {
      invalid('attemptId 必须是 UUID');
    }
    // 单一能力语义：任一 attempt 开关打开都视为「引擎镜像已支持 attemptId」——
    // ENGINE_DISCOVER_ATTEMPT_ID_ENABLED 是既有部署里已开启的那个，单独只认新名字会让重试
    // 静默剥离 attemptId 并撞 GRANT_REUSED（2026-11-04 验收阻断复现）。
    const attemptPassthroughEnabled =
      this.config.ENGINE_RETRY_ATTEMPT_ID_ENABLED || this.config.ENGINE_DISCOVER_ATTEMPT_ID_ENABLED ||
      (this.config.ENGINE_MANUFACTURER_NETWORK_ENABLED && isManufacturerNetworkRevision(body?.manufacturerNetworkRevision));
    const attemptId: string | undefined =
      typeof rawAttemptId === 'string'
        ? rawAttemptId
        : attemptPassthroughEnabled
          ? randomUUID()
          : undefined;

    let canonical: ReturnType<typeof canonicalExecuteBody>;
    try {
      canonical = canonicalExecuteBody({ ...body, attemptId }, {
        writeAttemptId: attemptPassthroughEnabled,
        manufacturerNetwork: this.config.ENGINE_MANUFACTURER_NETWORK_ENABLED,
      });
    } catch {
      invalid('当前搜索配置不可用，请刷新后重试');
    }
    const executionRequestSha256 = canonical.manufacturerNetworkRevision
      ? createHash('sha256').update(JSON.stringify({ planId, ...canonical })).digest('hex')
      : undefined;

    // 同键重放（双击/网络重试）：直接返回既有记录，绝不再调引擎（避免双扣费）。
    if (attemptId) {
      const replayed = await this.prisma.withWorkspace(tenant.workspaceId, (tx) =>
        tx.taskRun.findFirst({
          where: { taskId: task.id, attemptKey: attemptId },
          select: { id: true, engineRunId: true, status: true, planId: true, executionRequestSha256: true },
        }),
      );
      if (replayed) {
        this.assertReplayBinding(replayed, planId, executionRequestSha256);
        return {
          data: { taskRunId: replayed.id, runId: replayed.engineRunId, status: replayed.status, replayed: true },
        };
      }
    }

    const allocated = await this.allocateRun(tenant.workspaceId, task.id, planId, tenant.userId, attemptId, executionRequestSha256);
    if (allocated.replayed) {
      const replayed = allocated.run;
      return {
        data: { taskRunId: replayed.id, runId: replayed.engineRunId ?? null, status: replayed.status ?? 'RUNNING', replayed: true },
      };
    }
    const { run, previousAttempt, holdId } = allocated;

    // W2 旁路模式（LEGACY_EXECUTION_BUDGET_MODE=bypass）：跳过二次 /quote 与旧 RS256 Grant 签发，
    // 直接以纯租户身份转发，避免重试撞上 409 GRANT_REUSED。
    const legacyBudgetBypass = this.config.LEGACY_EXECUTION_BUDGET_MODE === 'bypass';
    let grant: string | null = null;
    if (!legacyBudgetBypass) {
      try {
        // 与 BFF execute 路由同一 quote 口径（operation + planId + 可选 attemptId）。
        grant = await this.budget.issue(tenant, {
          operation: 'POST /query-plans/:planId/execute',
          planId,
          ...(Object.keys(canonical).length ? { body: canonical } : {}),
        });
      } catch (error) {
        await this.failRun(tenant, run.id, holdId, 'BUDGET_GRANT_FAILED');
        if (error instanceof WorkspaceBudgetQuotaExceededError) {
          throw new HttpException(
            { error: { code: error.code, message: error.message, details: error.details } },
            error.status,
          );
        }
        const quoteCode = error instanceof EngineBudgetQuoteError
          ? (error.engineBody as { error?: { code?: unknown } } | null)?.error?.code
          : undefined;
        const code = typeof quoteCode === 'string' && quoteCode.startsWith('EXECUTION_BUDGET_')
          ? quoteCode
          : 'EXECUTION_BUDGET_GRANT_FAILED';
        throw new HttpException({ error: { code, message: '执行预算授权签发失败' } }, 502);
      }
    }

    let response: Awaited<ReturnType<EngineHttp['call']>>;
    try {
      response = await this.engine.call(tenant, 'POST', `/query-plans/${planId}/execute`, {
        body: {
          taskRef: { taskId: task.id, taskRunId: run.id },
          ...canonical,
        },
        ...(grant ? { headers: { 'x-execution-budget-grant': grant } } : {}),
      });
    } catch {
      // The engine may have accepted the request. Keep the hold for its completion event.
      await this.failRun(tenant, run.id);
      throw new HttpException(
        { error: { code: 'MODEL_UPSTREAM_UNUSABLE', message: '引擎不可达' } },
        502,
      );
    }

    const data = (response.body as { data?: { runId?: unknown; status?: unknown; icpId?: unknown } } | null)?.data;
    if (response.status !== 202 || !data || typeof data.runId !== 'string' || !UUID.test(data.runId)) {
      const code = (response.body as { error?: { code?: unknown } } | null)?.error?.code;
      const rejectedBeforeStart =
        (response.status >= 400 && response.status < 500 && response.status !== 408)
        || (response.status === 503 && code === 'RUNTIME_ADMISSION_CLOSED');
      await this.failRun(tenant, run.id, rejectedBeforeStart ? holdId : null, `DISPATCH_FAILED_HTTP_${response.status}`);
      throw new HttpException(
        this.engine.toClientError(response.status, response.body),
        this.engine.toClientStatus(response.status, response.body),
      );
    }

    const engineRunId = data.runId;
    const runStatus = typeof data.status === 'string' ? data.status : 'RUNNING';
    const resolvedIcpId =
      task.icpId ??
      (typeof data.icpId === 'string' && UUID.test(data.icpId) ? data.icpId : UNSCOPED_TASK_ICP_ID);
    const persistedStatus = await this.prisma.withWorkspace(tenant.workspaceId, async (tx) => {
      const attempt = { id: run.id, workspaceId: tenant.workspaceId };
      // A completion event can bind the run and report its outcome while the 202 is in flight.
      await tx.taskRun.updateMany({
        where: { ...attempt, engineRunId: null, status: 'RUNNING' },
        data: { engineRunId, status: runStatus },
      });
      const linkedRun = await tx.taskRun.findUnique({
        where: { ...attempt, engineRunId },
        select: { status: true },
      });
      if (!linkedRun) {
        throw new NotFoundException({
          error: { code: 'NOT_FOUND', message: '寻源任务不存在' },
        });
      }
      // 无论 task.icpId 是否为空，均必须登记 discovery_run_link（封堵 icpId=null 绕过月度运行次数配额）；
      // 不泄露 runId 是否属于其他工作空间，统一返回 404 NOT_FOUND。
      const existingLink = await tx.discoveryRunLink.findFirst({ where: { runId: engineRunId } });
      if (existingLink && existingLink.workspaceId !== tenant.workspaceId) {
        throw new NotFoundException({
          error: { code: 'NOT_FOUND', message: '寻源任务不存在' },
        });
      }
      if (existingLink) {
        await tx.discoveryRunLink.update({
          where: { runId: engineRunId },
          data: { planId, icpId: resolvedIcpId },
        });
      } else {
        try {
          await tx.discoveryRunLink.create({
            data: {
              runId: engineRunId,
              workspaceId: tenant.workspaceId,
              planId,
              icpId: resolvedIcpId,
            },
          });
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          if (code === 'P2002' || code === '42501') {
            throw new NotFoundException({
              error: { code: 'NOT_FOUND', message: '寻源任务不存在' },
            });
          }
          throw error;
        }
      }
      await tx.acquisitionTask.update({
        where: { id: task.id },
        data: { lastRunAt: new Date() },
      });
      return linkedRun.status;
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      workspaceId: tenant.workspaceId,
      action: 'acquisition.task_run.start',
      target: run.id,
      detail: { taskId: task.id, planId, runId: data.runId },
    });

    return {
      data: {
        taskRunId: run.id,
        runId: data.runId,
        status: persistedStatus,
        attempt: run.attempt,
        rerunOf: previousAttempt,
        replayed: false,
      },
    };
  }

  /**
   * 事务内串行化 attempt 取号（锁任务行）：attempt=max+1，rerunOf=同任务同 plan 的上一 TaskRun。
   * 并发双击撞 (taskId, attemptKey) 唯一索引（P2002）时读回赢家行，按重放返回。
   */
  private async allocateRun(
    workspaceId: string,
    taskId: string,
    planId: string,
    requestedBy: string,
    attemptId: string | undefined,
    executionRequestSha256: string | undefined,
  ): Promise<TaskRunAllocation> {
    try {
      return await this.prisma.withWorkspace(workspaceId, async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "acquisition_task" WHERE "id" = ${taskId}::uuid FOR UPDATE`;
        const last = await tx.taskRun.findFirst({
          where: { taskId },
          orderBy: { attempt: 'desc' },
          select: { attempt: true },
        });
        const previous = await tx.taskRun.findFirst({
          where: { taskId, planId },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        const created = await tx.taskRun.create({
          data: {
            workspaceId,
            taskId,
            requestedBy,
            trigger: 'manual',
            planId,
            attempt: (last?.attempt ?? 0) + 1,
            ...(attemptId ? { attemptKey: attemptId } : {}),
            ...(executionRequestSha256 ? { executionRequestSha256 } : {}),
            ...(previous ? { rerunOf: previous.id } : {}),
          },
        });
        // WalletService reuses this workspace transaction. An unfunded attempt leaves neither row nor hold.
        // The TaskRun ID exists before dispatch and stays valid if completion beats the engine response.
        const reservation = this.wallet.billingEnabled
          ? await this.wallet.holdCredits(workspaceId, {
            idempotencyKey: `${DISCOVERY_TASK_RUN_WALLET_REF}:${created.id}`,
            actionCode: DISCOVERY_WALLET_ACTION,
            refType: DISCOVERY_TASK_RUN_WALLET_REF,
            refId: created.id,
            actorId: requestedBy,
          })
          : null;
        return { replayed: false, run: created, previousAttempt: previous?.id ?? null, holdId: reservation?.hold?.id ?? null };
      });
    } catch (error) {
      if (attemptId && (error as { code?: string } | null)?.code === 'P2002') {
        const replayed = await this.prisma.withWorkspace(workspaceId, (tx) =>
          tx.taskRun.findFirst({
            where: { taskId, attemptKey: attemptId },
            select: { id: true, engineRunId: true, status: true, planId: true, executionRequestSha256: true },
          }),
        );
        if (replayed) {
          this.assertReplayBinding(replayed, planId, executionRequestSha256);
          return { replayed: true, run: replayed };
        }
      }
      throw error;
    }
  }

  private assertReplayBinding(
    row: { planId: string | null; executionRequestSha256: string | null },
    planId: string,
    executionRequestSha256: string | undefined,
  ): void {
    // PostgreSQL UUID readback is lowercase; preserve the original signed/hash/forward request material.
    if (row.planId?.toLowerCase() !== planId.toLowerCase() || (row.executionRequestSha256 ?? undefined) !== executionRequestSha256) {
      throw new ConflictException({ error: { code: 'TASK_ATTEMPT_REQUEST_CONFLICT', message: '本次操作已绑定另一份搜索配置，请刷新后重试' } });
    }
  }

  private async failRun(
    { workspaceId, userId }: NonNullable<Request['tenant']>,
    taskRunId: string,
    holdId?: string | null,
    reason?: string,
  ): Promise<void> {
    try {
      await this.prisma.withWorkspace(workspaceId, async (tx) => {
        const failed = await tx.taskRun.updateMany({
          where: { id: taskRunId, workspaceId, status: 'RUNNING' },
          data: { status: 'FAILED', finishedAt: new Date() },
        });
        if (failed.count && holdId && reason) {
          await this.wallet.releaseHold(workspaceId, holdId, reason, userId);
        }
      });
    } catch {
      this.logger.warn(`Failed to record dispatch failure for discovery task run ${taskRunId}`);
    }
  }
}
