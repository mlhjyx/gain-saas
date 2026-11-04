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

    const run = await this.prisma.taskRun.create({
      data: {
        workspaceId: tenant.workspaceId,
        taskId: task.id,
        requestedBy: tenant.userId,
        trigger: 'manual',
      },
    });

    let grant: string;
    try {
      // 与 BFF execute 路由同一 quote 口径（operation + planId）。
      grant = await this.budget.issue(tenant, {
        operation: 'POST /query-plans/:planId/execute',
        planId,
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
        body: { taskRef: { taskId: task.id, taskRunId: run.id } },
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
      },
    };
  }

  private async failRun(taskRunId: string): Promise<void> {
    await this.prisma.taskRun
      .update({ where: { id: taskRunId }, data: { status: 'FAILED', finishedAt: new Date() } })
      .catch(() => undefined);
  }
}
