import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpException,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PrismaService } from '../shared/prisma.service.js';
import { AuditService } from '../shared/audit.service.js';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { EngineHttp } from './engine-http.js';
import { EngineBudgetGrantService, EngineBudgetQuoteError } from './engine-budget-grant.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TASK_NAME = 200;

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
  return {
    id: row.id,
    icpId: row.icpId,
    name: row.name,
    status: row.status,
    createdBy: row.createdBy,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    runs: (row.runs ?? []).map((run) => ({
      id: run.id,
      runId: run.engineRunId,
      planId: run.planId ?? null,
      attempt: run.attempt ?? 1,
      rerunOf: run.rerunOf ?? null,
      trigger: run.trigger,
      status: run.status,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
    })),
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: EngineHttp,
    private readonly budget: EngineBudgetGrantService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  async list(@Req() req: Request, @Query('icpId') icpId?: string) {
    const tenant = req.tenant!;
    if (icpId !== undefined && !UUID.test(icpId)) invalid('icpId 必须是 UUID');
    const rows = await this.prisma.acquisitionTask.findMany({
      where: { workspaceId: tenant.workspaceId, ...(icpId ? { icpId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { runs: { orderBy: { createdAt: 'desc' }, take: 20 } },
    });
    return { data: (rows as unknown as TaskRow[]).map(taskView) };
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
    const task = await this.prisma.acquisitionTask.create({
      data: {
        workspaceId: tenant.workspaceId,
        icpId: (icpId as string | null | undefined) ?? null,
        name,
        createdBy: tenant.userId,
      },
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
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

    const task = await this.prisma.acquisitionTask.findFirst({
      where: { id: taskId, workspaceId: tenant.workspaceId },
    });
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
    const attemptId: string | undefined =
      typeof rawAttemptId === 'string'
        ? rawAttemptId
        : this.config.ENGINE_RETRY_ATTEMPT_ID_ENABLED
          ? randomUUID()
          : undefined;

    // 同键重放（双击/网络重试）：直接返回既有记录，绝不再调引擎（避免双扣费）。
    if (attemptId) {
      const replayed = await this.prisma.taskRun.findFirst({
        where: { taskId: task.id, attemptKey: attemptId },
        select: { id: true, engineRunId: true, status: true },
      });
      if (replayed) {
        return {
          data: { taskRunId: replayed.id, runId: replayed.engineRunId, status: replayed.status, replayed: true },
        };
      }
    }

    const allocated = await this.allocateRun(tenant.workspaceId, task.id, planId, tenant.userId, attemptId);
    if (allocated.replayed) {
      const replayed = allocated.run as { id: string; engineRunId?: string | null; status?: string };
      return {
        data: { taskRunId: replayed.id, runId: replayed.engineRunId ?? null, status: replayed.status ?? 'RUNNING', replayed: true },
      };
    }
    const run = allocated.run as { id: string; attempt?: number };
    const previousAttempt = allocated.previousAttempt;

    // 引擎侧 attempt：开关关闭时剥离（兼容未升级镜像，requestSha256 与旧版一致）。
    const engineAttempt = this.config.ENGINE_RETRY_ATTEMPT_ID_ENABLED ? attemptId : undefined;
    let grant: string;
    try {
      // 与 BFF execute 路由同一 quote 口径（operation + planId + 可选 attemptId）。
      grant = await this.budget.issue(tenant, {
        operation: 'POST /query-plans/:planId/execute',
        planId,
        ...(engineAttempt ? { body: { attemptId: engineAttempt } } : {}),
      });
    } catch (error) {
      await this.failRun(run.id);
      const quoteCode = error instanceof EngineBudgetQuoteError
        ? (error.engineBody as { error?: { code?: unknown } } | null)?.error?.code
        : undefined;
      const code = typeof quoteCode === 'string' && quoteCode.startsWith('EXECUTION_BUDGET_')
        ? quoteCode
        : 'EXECUTION_BUDGET_GRANT_FAILED';
      throw new HttpException({ error: { code, message: '执行预算授权签发失败' } }, 502);
    }

    let response: Awaited<ReturnType<EngineHttp['call']>>;
    try {
      response = await this.engine.call(tenant, 'POST', `/query-plans/${planId}/execute`, {
        body: {
          taskRef: { taskId: task.id, taskRunId: run.id },
          ...(engineAttempt ? { attemptId: engineAttempt } : {}),
        },
        headers: { 'x-execution-budget-grant': grant },
      });
    } catch {
      await this.failRun(run.id);
      throw new HttpException(
        { error: { code: 'MODEL_UPSTREAM_UNUSABLE', message: '引擎不可达' } },
        502,
      );
    }

    const data = (response.body as { data?: { runId?: unknown; status?: unknown } } | null)?.data;
    if (response.status !== 202 || !data || typeof data.runId !== 'string' || !UUID.test(data.runId)) {
      await this.failRun(run.id);
      throw new HttpException(
        this.engine.toClientError(response.status, response.body),
        this.engine.toClientStatus(response.status, response.body),
      );
    }

    const runStatus = typeof data.status === 'string' ? data.status : 'RUNNING';
    await this.prisma.taskRun.update({
      where: { id: run.id },
      data: { engineRunId: data.runId, status: runStatus },
    });
    if (task.icpId) {
      await this.prisma.discoveryRunLink.upsert({
        where: { runId: data.runId },
        create: {
          runId: data.runId,
          workspaceId: tenant.workspaceId,
          planId,
          icpId: task.icpId,
        },
        update: { planId, icpId: task.icpId },
      });
    }
    await this.prisma.acquisitionTask.update({
      where: { id: task.id },
      data: { lastRunAt: new Date() },
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'acquisition.task_run.start',
      target: run.id,
      detail: { taskId: task.id, planId, runId: data.runId },
    });

    return {
      data: {
        taskRunId: run.id,
        runId: data.runId,
        status: runStatus,
        attempt: run.attempt ?? 1,
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
  ): Promise<{ run: Record<string, unknown>; previousAttempt: string | null; replayed?: boolean }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
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
            ...(previous ? { rerunOf: previous.id } : {}),
          },
        });
        return { run: created as unknown as Record<string, unknown>, previousAttempt: previous?.id ?? null };
      });
    } catch (error) {
      if (attemptId && (error as { code?: string } | null)?.code === 'P2002') {
        const replayed = await this.prisma.taskRun.findFirst({
          where: { taskId, attemptKey: attemptId },
          select: { id: true, engineRunId: true, status: true },
        });
        if (replayed) {
          return { run: replayed as unknown as Record<string, unknown>, previousAttempt: null, replayed: true };
        }
      }
      throw error;
    }
  }

  private async failRun(taskRunId: string): Promise<void> {
    await this.prisma.taskRun
      .update({ where: { id: taskRunId }, data: { status: 'FAILED', finishedAt: new Date() } })
      .catch(() => undefined);
  }
}
