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
  /** P1：服务端是否已支持 attempt 维度（ENGINE_RETRY_ATTEMPT_ID_ENABLED）。 */
  attemptEnabled?: boolean;
  /** 同一能力的既有开关名（ENGINE_DISCOVER_ATTEMPT_ID_ENABLED）——任一为 true 即透传。 */
  discoverAttemptEnabled?: boolean;
  /** taskRun.findFirst 依次返回值（重放查询 → 最近 attempt → 同 plan 上一 TaskRun）。 */
  taskRunFindFirst?: Array<Record<string, unknown> | null>;
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
      findFirst: vi.fn(async () => (overrides.taskRunFindFirst ?? []).shift() ?? null),
    },
    discoveryRunLink: { upsert: vi.fn(async () => ({})) },
    $queryRaw: vi.fn(async () => [{ id: TASK_ID }]),
  };
  (prisma as Record<string, unknown>).$transaction = vi.fn(
    async (callback: (client: typeof prisma) => Promise<unknown>) => callback(prisma),
  );
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
  const config = {
    ENGINE_RETRY_ATTEMPT_ID_ENABLED: overrides.attemptEnabled ?? false,
    ENGINE_DISCOVER_ATTEMPT_ID_ENABLED: overrides.discoverAttemptEnabled ?? false,
  };
  const controller = new AcquisitionTasksController(
    prisma as never,
    audit as never,
    engine as never,
    budget as never,
    config as never,
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
        planId: PLAN_ID,
        attempt: 1,
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

  it('allocates the next attempt and points rerunOf at the previous run of the same plan (P1)', async () => {
    const PREV_RUN_ID = '88888888-8888-4888-8888-888888888888';
    const { controller, prisma } = makeController({
      taskRunFindFirst: [{ attempt: 2 }, { id: PREV_RUN_ID }],
    });
    const result = await controller.startRun(req, TASK_ID, { planId: PLAN_ID });

    expect(prisma.taskRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ attempt: 3, planId: PLAN_ID, rerunOf: PREV_RUN_ID }),
    });
    expect(result).toMatchObject({ data: { attempt: 3, rerunOf: PREV_RUN_ID, replayed: false } });
  });

  it('replays the same attempt key without calling the engine again (P1 双击幂等)', async () => {
    const ATTEMPT_ID = '99999999-9999-4999-8999-999999999999';
    const { controller, prisma, budget, engine } = makeController({
      taskRunFindFirst: [{ id: TASK_RUN_ID, engineRunId: ENGINE_RUN_ID, status: 'RUNNING' }],
    });
    const result = await controller.startRun(req, TASK_ID, { planId: PLAN_ID, attemptId: ATTEMPT_ID });

    expect(budget.issue).not.toHaveBeenCalled();
    expect(engine.call).not.toHaveBeenCalled();
    expect(prisma.taskRun.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ data: { taskRunId: TASK_RUN_ID, replayed: true } });
  });

  it('mints an attemptId server-side when the flag is on and binds it into quote and engine body (P1)', async () => {
    const { controller, prisma, budget, engine } = makeController({ attemptEnabled: true });
    await controller.startRun(req, TASK_ID, { planId: PLAN_ID });

    const quoteRequest = budget.issue.mock.calls[0]![1] as { body?: { attemptId?: string } };
    expect(quoteRequest.body?.attemptId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const engineBody = (engine.call.mock.calls[0]![3] as { body: { attemptId?: string } }).body;
    expect(engineBody.attemptId).toBe(quoteRequest.body?.attemptId);
    expect(prisma.taskRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ attemptKey: quoteRequest.body?.attemptId }),
    });
  });

  it('strips attemptId from quote and engine body when the flag is off but keeps it as the local idempotency key (P1)', async () => {
    const ATTEMPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const { controller, prisma, budget, engine } = makeController();
    await controller.startRun(req, TASK_ID, { planId: PLAN_ID, attemptId: ATTEMPT_ID });

    expect(budget.issue).toHaveBeenCalledWith(req.tenant, {
      operation: 'POST /query-plans/:planId/execute',
      planId: PLAN_ID,
    });
    const engineBody = (engine.call.mock.calls[0]![3] as { body: Record<string, unknown> }).body;
    expect(engineBody).not.toHaveProperty('attemptId');
    expect(prisma.taskRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ attemptKey: ATTEMPT_ID }),
    });
  });

  it('treats the discover attempt flag as the same capability switch (single-switch semantics, 2026-11-04)', async () => {
    const { controller, budget } = makeController({ discoverAttemptEnabled: true });
    await controller.startRun(req, TASK_ID, { planId: PLAN_ID });

    const quoteRequest = budget.issue.mock.calls[0]![1] as { body?: { attemptId?: string } };
    expect(quoteRequest.body?.attemptId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('rejects a malformed attemptId before any database or engine work (P1)', async () => {
    const { controller, prisma, engine } = makeController();
    await expect(
      controller.startRun(req, TASK_ID, { planId: PLAN_ID, attemptId: 'not-a-uuid' }),
    ).rejects.toMatchObject({ status: 400, response: { error: { code: 'VALIDATION_ERROR' } } });
    expect(prisma.taskRun.create).not.toHaveBeenCalled();
    expect(engine.call).not.toHaveBeenCalled();
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
