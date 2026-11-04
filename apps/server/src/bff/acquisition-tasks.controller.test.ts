import { describe, expect, it, vi } from 'vitest';
import { AcquisitionTasksController } from './acquisition-tasks.controller.js';
import { EngineBudgetQuoteError } from './engine-budget-grant.service.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';
const TASK_RUN_ID = '44444444-4444-4444-8444-444444444444';
const PLAN_ID = '55555555-5555-4555-8555-555555555555';
const ICP_ID = '66666666-6666-4666-8666-666666666666';
const ENGINE_RUN_ID = '77777777-7777-4777-8777-777777777777';

const req = {
  tenant: { userId: USER_ID, workspaceId: WORKSPACE_ID, role: 'admin' },
} as never;

function makeController(overrides: {
  task?: Record<string, unknown> | null;
  engineResponse?: { status: number; body: unknown };
} = {}) {
  const now = new Date('2026-11-04T04:00:00Z');
  const prisma = {
    acquisitionTask: {
      findFirst: vi.fn(async () =>
        overrides.task === null
          ? null
          : overrides.task ?? {
              id: TASK_ID,
              workspaceId: WORKSPACE_ID,
              icpId: ICP_ID,
              name: '德国泵买家',
              status: 'active',
              createdBy: USER_ID,
              lastRunAt: null,
              createdAt: now,
              updatedAt: now,
            },
      ),
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: TASK_ID,
        status: 'active',
        lastRunAt: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      })),
      update: vi.fn(async () => ({})),
    },
    taskRun: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: TASK_RUN_ID,
        status: 'RUNNING',
        startedAt: now,
        finishedAt: null,
        createdAt: now,
        ...data,
      })),
      update: vi.fn(async () => ({})),
    },
    discoveryRunLink: { upsert: vi.fn(async () => ({})) },
  };
  const engine = {
    call: vi.fn(async () => overrides.engineResponse ?? { status: 202, body: { data: { runId: ENGINE_RUN_ID, status: 'RUNNING' } } }),
    toClientStatus: vi.fn((status: number) => (status === 403 ? 403 : 502)),
    toClientError: vi.fn((status: number, body: unknown) => ({
      error: {
        code: ((body as { error?: { code?: string } })?.error?.code) ?? 'MODEL_UPSTREAM_UNUSABLE',
        message: `engine ${status}`,
      },
    })),
  };
  const budget = { issue: vi.fn(async () => 'grant-1') };
  const audit = { record: vi.fn(async () => undefined) };
  const controller = new AcquisitionTasksController(
    prisma as never,
    audit as never,
    engine as never,
    budget as never,
  );
  return { controller, prisma, engine, budget, audit };
}

describe('Run 2.0 任务对象（M0②）', () => {
  it('creates a task scoped to the workspace with an audit entry', async () => {
    const { controller, prisma, audit } = makeController();
    const result = await controller.create(req, { icpId: ICP_ID, name: ' 德国泵买家 ' });
    expect(prisma.acquisitionTask.create).toHaveBeenCalledWith({
      data: {
        workspaceId: WORKSPACE_ID,
        icpId: ICP_ID,
        name: '德国泵买家',
        createdBy: USER_ID,
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'acquisition.task.create', target: TASK_ID }),
    );
    expect(result).toMatchObject({ data: { id: TASK_ID, name: '德国泵买家' } });
  });

  it('starts a task run: taskRun row, engine execute with taskRef, link, lastRunAt', async () => {
    const { controller, prisma, engine, budget } = makeController();
    const result = await controller.startRun(req, TASK_ID, { planId: PLAN_ID });

    expect(prisma.taskRun.create).toHaveBeenCalledWith({
      data: {
        workspaceId: WORKSPACE_ID,
        taskId: TASK_ID,
        requestedBy: USER_ID,
        trigger: 'manual',
      },
    });
    expect(budget.issue).toHaveBeenCalledWith(req.tenant, {
      operation: 'POST /query-plans/:planId/execute',
      planId: PLAN_ID,
    });
    expect(engine.call).toHaveBeenCalledWith(
      req.tenant,
      'POST',
      `/query-plans/${PLAN_ID}/execute`,
      expect.objectContaining({
        body: { taskRef: { taskId: TASK_ID, taskRunId: TASK_RUN_ID } },
        headers: { 'x-execution-budget-grant': 'grant-1' },
      }),
    );
    expect(prisma.taskRun.update).toHaveBeenCalledWith({
      where: { id: TASK_RUN_ID },
      data: { engineRunId: ENGINE_RUN_ID, status: 'RUNNING' },
    });
    expect(prisma.discoveryRunLink.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { runId: ENGINE_RUN_ID },
        create: expect.objectContaining({ workspaceId: WORKSPACE_ID, planId: PLAN_ID, icpId: ICP_ID }),
      }),
    );
    expect(prisma.acquisitionTask.update).toHaveBeenCalledWith({
      where: { id: TASK_ID },
      data: { lastRunAt: expect.any(Date) },
    });
    expect(result).toMatchObject({ data: { taskRunId: TASK_RUN_ID, runId: ENGINE_RUN_ID, status: 'RUNNING' } });
  });

  it('404s an unknown or foreign task before any grant is issued', async () => {
    const { controller, budget } = makeController({ task: null });
    await expect(controller.startRun(req, TASK_ID, { planId: PLAN_ID })).rejects.toMatchObject({
      status: 404,
      response: { error: { code: 'TASK_NOT_FOUND' } },
    });
    expect(budget.issue).not.toHaveBeenCalled();
  });

  it('marks the task run FAILED and maps the engine error when execution is rejected', async () => {
    const { controller, prisma } = makeController({
      engineResponse: { status: 409, body: { error: { code: 'INVALID_STATE', message: 'plan is DRAFT' } } },
    });
    await expect(controller.startRun(req, TASK_ID, { planId: PLAN_ID })).rejects.toMatchObject({
      status: 502,
      response: { error: { code: 'INVALID_STATE' } },
    });
    expect(prisma.taskRun.update).toHaveBeenCalledWith({
      where: { id: TASK_RUN_ID },
      data: expect.objectContaining({ status: 'FAILED' }),
    });
  });

  it('passes an EXECUTION_BUDGET_* quote code through and marks the run failed', async () => {
    const { controller, prisma, budget } = makeController();
    budget.issue.mockRejectedValueOnce(
      new EngineBudgetQuoteError(400, { error: { code: 'EXECUTION_BUDGET_QUOTE_UNAVAILABLE' } }),
    );
    await expect(controller.startRun(req, TASK_ID, { planId: PLAN_ID })).rejects.toMatchObject({
      status: 502,
      response: { error: { code: 'EXECUTION_BUDGET_QUOTE_UNAVAILABLE' } },
    });
    expect(prisma.taskRun.update).toHaveBeenCalledWith({
      where: { id: TASK_RUN_ID },
      data: expect.objectContaining({ status: 'FAILED' }),
    });
  });

  it('rejects malformed ids before any database or engine work', async () => {
    const { controller, prisma, engine } = makeController();
    await expect(controller.startRun(req, TASK_ID, { planId: 'nope' })).rejects.toMatchObject({
      status: 400,
      response: { error: { code: 'VALIDATION_ERROR' } },
    });
    expect(prisma.taskRun.create).not.toHaveBeenCalled();
    expect(engine.call).not.toHaveBeenCalled();
  });
});
