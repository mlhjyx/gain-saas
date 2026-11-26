import { createHash } from 'node:crypto';
import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { InsufficientCreditsError } from '../wallet/wallet.types.js';
import { AcquisitionTasksController } from './acquisition-tasks.controller.js';
import { EngineBudgetQuoteError } from './engine-budget-grant.service.js';
import { WorkspaceBudgetQuotaExceededError } from './workspace-budget-policy.service.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';
const TASK_RUN_ID = '44444444-4444-4444-8444-444444444444';
const PLAN_ID = '55555555-5555-4555-8555-555555555555';
const ICP_ID = '66666666-6666-4666-8666-666666666666';
const ENGINE_RUN_ID = '77777777-7777-4777-8777-777777777777';
const HOLD_ID = '99999999-9999-4999-8999-999999999999';

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
  manufacturerEnabled?: boolean;
  walletEnabled?: boolean;
  legacyBudgetMode?: 'bypass' | 'enforce';
  /** taskRun.findFirst 依次返回值（重放查询 → 最近 attempt → 同 plan 上一 TaskRun）。 */
  taskRunFindFirst?: Array<Record<string, unknown> | null>;
} = {}) {
  const now = new Date('2026-11-04T04:00:00Z');
  const taskRun = {
    id: TASK_RUN_ID,
    workspaceId: WORKSPACE_ID,
    engineRunId: null as string | null,
    status: 'RUNNING',
    finishedAt: null as Date | null,
  };
  type TaskRunFields = Partial<typeof taskRun>;
  const matchesRun = (where: TaskRunFields) =>
    (Object.keys(where) as Array<keyof TaskRunFields>).every((key) => where[key] === taskRun[key]);
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
      updateMany: vi.fn(async ({ where, data }: { where: TaskRunFields; data: TaskRunFields }) => {
        if (!matchesRun(where)) return { count: 0 };
        Object.assign(taskRun, data);
        return { count: 1 };
      }),
      findUnique: vi.fn(async ({ where }: { where: TaskRunFields }) => matchesRun(where) ? taskRun : null),
      findFirst: vi.fn(async () => (overrides.taskRunFindFirst ?? []).shift() ?? null),
    },
    discoveryRunLink: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    },
    $queryRaw: vi.fn(async () => [{ id: TASK_ID }]),
  };
  (prisma as Record<string, unknown>).withWorkspace = vi.fn(
    async (_wid: string, callback: (client: typeof prisma) => Promise<unknown>) => callback(prisma),
  );
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
  const wallet = {
    billingEnabled: overrides.walletEnabled ?? false,
    holdCredits: vi.fn(async () => ({
      free: false, idempotent: false, hold: { id: HOLD_ID },
    })),
    releaseHold: vi.fn(async () => undefined),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const config = {
    ENGINE_RETRY_ATTEMPT_ID_ENABLED: overrides.attemptEnabled ?? false,
    ENGINE_DISCOVER_ATTEMPT_ID_ENABLED: overrides.discoverAttemptEnabled ?? false,
    ENGINE_MANUFACTURER_NETWORK_ENABLED: overrides.manufacturerEnabled ?? false,
    LEGACY_EXECUTION_BUDGET_MODE: overrides.legacyBudgetMode ?? 'enforce',
  };
  const controller = new AcquisitionTasksController(
    prisma as never,
    audit as never,
    engine as never,
    budget as never,
    config as never,
    wallet as never,
  );
  return { controller, prisma, engine, budget, audit, taskRun, wallet };
}

describe('Run 2.0 任务对象（M0②）', () => {
  it('blocks a zero-balance task attempt before any engine dispatch even in legacy-budget bypass', async () => {
    const { controller, engine, budget, wallet } = makeController({
      walletEnabled: true, legacyBudgetMode: 'bypass',
    });
    wallet.holdCredits.mockRejectedValueOnce(new InsufficientCreditsError({
      availableCredits: 0n, requiredCredits: 200n, actionCode: 'DISCOVERY_QUALIFIED_LEAD',
    }));

    await expect(controller.startRun(req, TASK_ID, { planId: PLAN_ID })).rejects.toMatchObject({
      status: 402,
      response: { error: { code: 'INSUFFICIENT_CREDITS' } },
    });
    expect(engine.call).not.toHaveBeenCalled();
    expect(budget.issue).not.toHaveBeenCalled();
  });

  it('reserves the discovery price against the local task run before dispatch', async () => {
    const { controller, engine, wallet } = makeController({ walletEnabled: true });

    await controller.startRun(req, TASK_ID, { planId: PLAN_ID });

    expect(wallet.holdCredits).toHaveBeenCalledExactlyOnceWith(WORKSPACE_ID, {
      idempotencyKey: `discovery_task_run:${TASK_RUN_ID}`,
      actionCode: 'DISCOVERY_QUALIFIED_LEAD',
      refType: 'discovery_task_run',
      refId: TASK_RUN_ID,
      actorId: USER_ID,
    });
    expect(wallet.holdCredits.mock.invocationCallOrder[0]).toBeLessThan(engine.call.mock.invocationCallOrder[0]!);
  });

  it('returns the attempt already in progress without another reservation', async () => {
    const { controller, wallet, engine } = makeController({
      walletEnabled: true,
      taskRunFindFirst: [{ id: TASK_RUN_ID, engineRunId: null, planId: PLAN_ID, status: 'RUNNING' }],
    });

    const result = await controller.startRun(req, TASK_ID, { planId: PLAN_ID, attemptId: HOLD_ID });

    expect(result.data).toMatchObject({ taskRunId: TASK_RUN_ID, runId: null, replayed: true });
    expect(wallet.holdCredits).not.toHaveBeenCalled();
    expect(engine.call).not.toHaveBeenCalled();
  });

  it('releases the reservation if budget authorization fails before dispatch', async () => {
    const { controller, budget, engine, wallet, taskRun } = makeController({ walletEnabled: true });
    budget.issue.mockRejectedValueOnce(new Error('authorization unavailable'));

    await expect(controller.startRun(req, TASK_ID, { planId: PLAN_ID })).rejects.toMatchObject({ status: 502 });

    expect(taskRun.status).toBe('FAILED');
    expect(wallet.releaseHold).toHaveBeenCalledExactlyOnceWith(WORKSPACE_ID, HOLD_ID, 'BUDGET_GRANT_FAILED', USER_ID);
    expect(engine.call).not.toHaveBeenCalled();
  });

  it.each([
    [409, 'INVALID_STATE'],
    [503, 'RUNTIME_ADMISSION_CLOSED'],
  ])('releases the reservation for a definite engine rejection (%s)', async (status, code) => {
    const { controller, wallet, taskRun } = makeController({
      walletEnabled: true, engineResponse: { status, body: { error: { code } } },
    });

    await expect(controller.startRun(req, TASK_ID, { planId: PLAN_ID })).rejects.toBeDefined();

    expect(taskRun.status).toBe('FAILED');
    expect(wallet.releaseHold).toHaveBeenCalledExactlyOnceWith(
      WORKSPACE_ID, HOLD_ID, `DISPATCH_FAILED_HTTP_${status}`, USER_ID,
    );
  });

  it('keeps the reservation eligible for settlement when the start response is lost', async () => {
    const { controller, engine, wallet, taskRun } = makeController({ walletEnabled: true });
    engine.call.mockRejectedValueOnce(new Error('response lost'));

    await expect(controller.startRun(req, TASK_ID, { planId: PLAN_ID })).rejects.toMatchObject({ status: 502 });

    expect(taskRun.status).toBe('FAILED');
    expect(wallet.holdCredits).toHaveBeenCalledOnce();
    expect(wallet.releaseHold).not.toHaveBeenCalled();
  });

  describe('SF1 native UUID replay identity', () => {
    const lowercasePlan = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const originalPlan = lowercasePlan.toUpperCase();
    const originalAttempt = '88888888-8888-4888-8888-888888888888';
    const cases = ['legacy', 'manufacturer-network/v1', 'manufacturer-network/v2'] as const;

    async function originalRequest(revision: typeof cases[number]) {
      const body = { planId: originalPlan, attemptId: originalAttempt,
        ...(revision === 'legacy' ? {} : { manufacturerNetworkRevision: revision }) };
      const first = makeController({ attemptEnabled: true, manufacturerEnabled: true });
      await first.controller.startRun(req, TASK_ID, body);
      const quoted = first.budget.issue.mock.calls[0]![1] as { planId: string; body?: Record<string, unknown> };
      expect(quoted.planId).toBe(originalPlan);
      expect(quoted.body).toEqual({ attemptId: originalAttempt,
        ...(revision === 'legacy' ? {} : { manufacturerNetworkRevision: revision }) });
      expect(first.engine.call).toHaveBeenCalledWith(req.tenant, 'POST', `/query-plans/${originalPlan}/execute`,
        expect.objectContaining({ body: { taskRef: { taskId: TASK_ID, taskRunId: TASK_RUN_ID }, ...quoted.body } }));
      const created = first.prisma.taskRun.create.mock.calls[0]![0].data;
      if (revision === 'legacy') expect(created.executionRequestSha256).toBeUndefined();
      else {
        expect(created.executionRequestSha256).toBe(createHash('sha256').update(JSON.stringify({ planId: originalPlan, ...quoted.body })).digest('hex'));
        expect(created.executionRequestSha256).not.toBe(createHash('sha256').update(JSON.stringify({ planId: lowercasePlan, ...quoted.body })).digest('hex'));
      }
      return { body, hash: created.executionRequestSha256 ?? null };
    }

    for (const path of ['initial', 'P2002'] as const) {
      it.each(cases)(`${path} replay keeps the original uppercase request and accepts native lowercase plan (%s)`, async (revision) => {
        const { body, hash } = await originalRequest(revision);
        const winner = { id: TASK_RUN_ID, engineRunId: ENGINE_RUN_ID, status: 'RUNNING',
          planId: lowercasePlan, executionRequestSha256: hash };
        const replay = makeController({ attemptEnabled: true, manufacturerEnabled: true,
          taskRunFindFirst: path === 'initial' ? [winner] : [null, null, null, winner] });
        if (path === 'P2002') replay.prisma.taskRun.create.mockRejectedValueOnce(Object.assign(new Error('unique constraint'), { code: 'P2002' }));
        expect(await replay.controller.startRun(req, TASK_ID, body)).toMatchObject({ data: { replayed: true, runId: ENGINE_RUN_ID } });
        expect(replay.budget.issue).not.toHaveBeenCalled();
        expect(replay.engine.call).not.toHaveBeenCalled();
      });

      it.each(['different plan', 'different hash'] as const)(`${path} replay still rejects %s with an uppercase original request`, async (drift) => {
        const { body, hash } = await originalRequest('manufacturer-network/v2');
        const winner = { id: TASK_RUN_ID, engineRunId: ENGINE_RUN_ID, status: 'RUNNING',
          planId: drift === 'different plan' ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : lowercasePlan,
          executionRequestSha256: drift === 'different hash' ? '0'.repeat(64) : hash };
        const replay = makeController({ attemptEnabled: true, manufacturerEnabled: true,
          taskRunFindFirst: path === 'initial' ? [winner] : [null, null, null, winner] });
        if (path === 'P2002') replay.prisma.taskRun.create.mockRejectedValueOnce(Object.assign(new Error('unique constraint'), { code: 'P2002' }));
        await expect(replay.controller.startRun(req, TASK_ID, body)).rejects.toMatchObject({ status: 409,
          response: { error: { code: 'TASK_ATTEMPT_REQUEST_CONFLICT' } } });
        expect(replay.budget.issue).not.toHaveBeenCalled();
        expect(replay.engine.call).not.toHaveBeenCalled();
      });
    }
  });

  it.each(['manufacturer-network/v1', 'manufacturer-network/v2'] as const)('quotes %s exactly as forwarded and persists its replay binding', async (revision) => {
    const { controller, prisma, engine, budget } = makeController({ attemptEnabled: true, manufacturerEnabled: true });
    const attemptId = '88888888-8888-4888-8888-888888888888';
    await controller.startRun(req, TASK_ID, { planId: PLAN_ID, attemptId, manufacturerNetworkRevision: revision });
    expect(budget.issue).toHaveBeenCalledWith(req.tenant, {
      operation: 'POST /query-plans/:planId/execute', planId: PLAN_ID,
      body: { attemptId, manufacturerNetworkRevision: revision },
    });
    expect(engine.call).toHaveBeenCalledWith(req.tenant, 'POST', `/query-plans/${PLAN_ID}/execute`, expect.objectContaining({
      body: { taskRef: { taskId: TASK_ID, taskRunId: TASK_RUN_ID }, attemptId, manufacturerNetworkRevision: revision },
    }));
    expect(prisma.taskRun.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      executionRequestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }) }));
  });

  it('does not replay an old attempt as a new evidence execution', async () => {
    const { controller, engine, budget } = makeController({
      attemptEnabled: true, manufacturerEnabled: true,
      taskRunFindFirst: [{ id: TASK_RUN_ID, engineRunId: ENGINE_RUN_ID, status: 'DONE', planId: PLAN_ID, executionRequestSha256: null }],
    });
    await expect(controller.startRun(req, TASK_ID, {
      planId: PLAN_ID, attemptId: '88888888-8888-4888-8888-888888888888', manufacturerNetworkRevision: 'manufacturer-network/v1',
    })).rejects.toMatchObject({ status: 409 });
    expect(engine.call).not.toHaveBeenCalled();
    expect(budget.issue).not.toHaveBeenCalled();
  });

  it('rejects an unavailable evidence feature before allocating a run or quoting', async () => {
    const { controller, prisma, budget } = makeController();
    await expect(controller.startRun(req, TASK_ID, { planId: PLAN_ID, manufacturerNetworkRevision: 'manufacturer-network/v1' }))
      .rejects.toMatchObject({ status: 400 });
    expect(prisma.taskRun.create).not.toHaveBeenCalled();
    expect(budget.issue).not.toHaveBeenCalled();
  });

  it.each(['manufacturer-network/v1', 'manufacturer-network/v2'])('gives %s its normal attempt with old compatibility switches off', async (revision) => {
    const setup = makeController({ manufacturerEnabled: true });
    await setup.controller.startRun(req, TASK_ID, { planId: PLAN_ID, manufacturerNetworkRevision: revision });
    const quoted = setup.budget.issue.mock.calls[0]![1] as { body?: Record<string, unknown> };
    expect(quoted.body?.attemptId).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    const sent = setup.engine.call.mock.calls[0]![3] as { body?: Record<string, unknown> };
    expect(sent.body?.attemptId).toBe(quoted.body?.attemptId);
    expect(quoted.body?.manufacturerNetworkRevision).toBe(revision);
  });

  it('replays the identical evidence request without another quote or engine call', async () => {
    const setup = makeController({ attemptEnabled: true, manufacturerEnabled: true });
    const body = { planId: PLAN_ID, attemptId: '88888888-8888-4888-8888-888888888888', manufacturerNetworkRevision: 'manufacturer-network/v1' };
    await setup.controller.startRun(req, TASK_ID, body);
    const created = setup.prisma.taskRun.create.mock.calls[0]![0].data;
    const replay = makeController({ attemptEnabled: true, manufacturerEnabled: true, taskRunFindFirst: [{
      id: TASK_RUN_ID, engineRunId: ENGINE_RUN_ID, status: 'DONE', planId: PLAN_ID,
      executionRequestSha256: created.executionRequestSha256,
    }] });
    expect(await replay.controller.startRun(req, TASK_ID, body)).toMatchObject({ data: { replayed: true } });
    expect(replay.budget.issue).not.toHaveBeenCalled();
    expect(replay.engine.call).not.toHaveBeenCalled();
  });


  it.each([['manufacturer-network/v1', 'manufacturer-network/v2'], ['manufacturer-network/v2', 'manufacturer-network/v1']] as const)('rejects changing %s to %s on a frozen attempt before another quote', async (original, changed) => {
    const setup = makeController({ manufacturerEnabled: true });
    const attemptId = '88888888-8888-4888-8888-888888888888';
    await setup.controller.startRun(req, TASK_ID, { planId: PLAN_ID, attemptId, manufacturerNetworkRevision: original });
    const created = setup.prisma.taskRun.create.mock.calls[0]![0].data;
    const replay = makeController({ manufacturerEnabled: true, taskRunFindFirst: [{
      id: TASK_RUN_ID, engineRunId: ENGINE_RUN_ID, status: 'DONE', planId: PLAN_ID,
      executionRequestSha256: created.executionRequestSha256,
    }] });
    await expect(replay.controller.startRun(req, TASK_ID, {
      planId: PLAN_ID, attemptId, manufacturerNetworkRevision: changed,
    })).rejects.toMatchObject({ status: 409 });
    expect(replay.budget.issue).not.toHaveBeenCalled();
    expect(replay.engine.call).not.toHaveBeenCalled();
  });

  it('rejects a changed plan on a reused legacy attempt key', async () => {
    const setup = makeController({ taskRunFindFirst: [{
      id: TASK_RUN_ID, engineRunId: ENGINE_RUN_ID, status: 'DONE', planId: ICP_ID, executionRequestSha256: null,
    }] });
    await expect(setup.controller.startRun(req, TASK_ID, { planId: PLAN_ID, attemptId: '88888888-8888-4888-8888-888888888888' }))
      .rejects.toMatchObject({ status: 409 });
    expect(setup.budget.issue).not.toHaveBeenCalled();
  });

  it.each(['manufacturer-network/v1', 'manufacturer-network/v2'] as const)('replays the matching %s race winner without another quote or dispatch', async (revision) => {
    const body = { planId: PLAN_ID, attemptId: '88888888-8888-4888-8888-888888888888', manufacturerNetworkRevision: revision };
    const first = makeController({ manufacturerEnabled: true });
    await first.controller.startRun(req, TASK_ID, body);
    const created = first.prisma.taskRun.create.mock.calls[0]![0].data;
    const race = makeController({ manufacturerEnabled: true, taskRunFindFirst: [null, null, null, {
      id: TASK_RUN_ID, engineRunId: ENGINE_RUN_ID, status: 'RUNNING', planId: PLAN_ID,
      executionRequestSha256: created.executionRequestSha256,
    }] });
    race.prisma.taskRun.create.mockRejectedValueOnce(Object.assign(new Error('unique constraint'), { code: 'P2002' }));
    expect(await race.controller.startRun(req, TASK_ID, body)).toMatchObject({ data: { replayed: true, runId: ENGINE_RUN_ID } });
    expect(race.budget.issue).not.toHaveBeenCalled();
    expect(race.engine.call).not.toHaveBeenCalled();
  });

  it('checks request binding when the concurrent allocation loses its unique-key race', async () => {
    const setup = makeController({ attemptEnabled: true, manufacturerEnabled: true,
      taskRunFindFirst: [null, null, null, { id: TASK_RUN_ID, engineRunId: ENGINE_RUN_ID, status: 'DONE', planId: PLAN_ID, executionRequestSha256: null }],
    });
    setup.prisma.taskRun.create.mockRejectedValueOnce(Object.assign(new Error('unique constraint'), { code: 'P2002' }));
    await expect(setup.controller.startRun(req, TASK_ID, {
      planId: PLAN_ID, attemptId: '88888888-8888-4888-8888-888888888888', manufacturerNetworkRevision: 'manufacturer-network/v1',
    })).rejects.toMatchObject({ status: 409 });
    expect(setup.budget.issue).not.toHaveBeenCalled();
    expect(setup.engine.call).not.toHaveBeenCalled();
  });
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
    expect(prisma.taskRun.updateMany).toHaveBeenCalledWith({
      where: { id: TASK_RUN_ID, workspaceId: WORKSPACE_ID, engineRunId: null, status: 'RUNNING' },
      data: { engineRunId: ENGINE_RUN_ID, status: 'RUNNING' },
    });
    expect(prisma.discoveryRunLink.create).toHaveBeenCalledWith({
      data: { runId: ENGINE_RUN_ID, workspaceId: WORKSPACE_ID, planId: PLAN_ID, icpId: ICP_ID },
    });
    expect(prisma.acquisitionTask.update).toHaveBeenCalledWith({
      where: { id: TASK_ID },
      data: { lastRunAt: expect.any(Date) },
    });
    expect(result).toMatchObject({ data: { taskRunId: TASK_RUN_ID, runId: ENGINE_RUN_ID, status: 'RUNNING' } });
  });

  it.each(['DONE', 'PARTIAL', 'FAILED', 'CANCELLED'])(
    'retains projected %s when the engine 202 arrives after completion',
    async (status) => {
      const { controller, prisma, engine, taskRun } = makeController();
      const finishedAt = new Date('2026-11-04T04:01:00Z');
      engine.call.mockImplementationOnce(async () => {
        // The consumer backfills this attempt using taskRef while the 202 is in flight.
        Object.assign(taskRun, { engineRunId: ENGINE_RUN_ID, status, finishedAt });
        return { status: 202, body: { data: { runId: ENGINE_RUN_ID, status: 'RUNNING' } } };
      });

      const result = await controller.startRun(req, TASK_ID, { planId: PLAN_ID });

      expect(taskRun).toMatchObject({ engineRunId: ENGINE_RUN_ID, status, finishedAt });
      expect(result.data).toMatchObject({ taskRunId: TASK_RUN_ID, runId: ENGINE_RUN_ID, status });
      expect(prisma.discoveryRunLink.create).toHaveBeenCalledOnce();
    },
  );

  it('preserves a projected completion when the engine response is lost', async () => {
    const { controller, engine, taskRun } = makeController();
    const finishedAt = new Date('2026-11-04T04:01:00Z');
    engine.call.mockImplementationOnce(async () => {
      Object.assign(taskRun, { engineRunId: ENGINE_RUN_ID, status: 'DONE', finishedAt });
      throw new Error('response lost');
    });

    await expect(controller.startRun(req, TASK_ID, { planId: PLAN_ID })).rejects.toMatchObject({ status: 502 });
    expect(taskRun).toMatchObject({ engineRunId: ENGINE_RUN_ID, status: 'DONE', finishedAt });
  });

  it('does not associate a late response with a different engine run than the taskRef already linked', async () => {
    const { controller, engine, prisma, taskRun } = makeController();
    const linkedRunId = '88888888-8888-4888-8888-888888888888';
    engine.call.mockImplementationOnce(async () => {
      Object.assign(taskRun, { engineRunId: linkedRunId, status: 'FAILED' });
      return { status: 202, body: { data: { runId: ENGINE_RUN_ID, status: 'RUNNING' } } };
    });

    await expect(controller.startRun(req, TASK_ID, { planId: PLAN_ID })).rejects.toMatchObject({ status: 404 });
    expect(taskRun).toMatchObject({ engineRunId: linkedRunId, status: 'FAILED' });
    expect(prisma.discoveryRunLink.create).not.toHaveBeenCalled();
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
    expect(prisma.taskRun.updateMany).toHaveBeenCalledWith({
      where: { id: TASK_RUN_ID, workspaceId: WORKSPACE_ID, status: 'RUNNING' },
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
    expect(prisma.taskRun.updateMany).toHaveBeenCalledWith({
      where: { id: TASK_RUN_ID, workspaceId: WORKSPACE_ID, status: 'RUNNING' },
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
      taskRunFindFirst: [{ id: TASK_RUN_ID, engineRunId: ENGINE_RUN_ID, status: 'RUNNING', planId: PLAN_ID, executionRequestSha256: null }],
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

  it('preserves HTTP 402 WORKSPACE_BUDGET_EXCEEDED instead of downgrading to 502', async () => {
    const { controller, prisma, budget } = makeController();
    budget.issue.mockRejectedValueOnce(
      new WorkspaceBudgetQuotaExceededError({
        purpose: 'discovery.run',
        windowDays: 30,
        maxRuns: 10,
        usedRuns: 10,
        maxSpendMicros: '15000000',
        usedSpendMicros: '0',
      }),
    );
    await expect(controller.startRun(req, TASK_ID, { planId: PLAN_ID })).rejects.toMatchObject({
      status: 402,
      response: { error: { code: 'WORKSPACE_BUDGET_EXCEEDED' } },
    });
    expect(prisma.taskRun.updateMany).toHaveBeenCalledWith({
      where: { id: TASK_RUN_ID, workspaceId: WORKSPACE_ID, status: 'RUNNING' },
      data: expect.objectContaining({ status: 'FAILED' }),
    });
  });

  it('always writes discoveryRunLink even when task.icpId is null (prevents quota bypass)', async () => {
    const { controller, prisma } = makeController({
      task: {
        id: TASK_ID,
        workspaceId: WORKSPACE_ID,
        icpId: null,
        name: '无绑定 ICP 任务',
        status: 'active',
        createdBy: USER_ID,
        lastRunAt: null,
        createdAt: new Date('2026-11-04T04:00:00Z'),
        updatedAt: new Date('2026-11-04T04:00:00Z'),
      },
    });
    await controller.startRun(req, TASK_ID, { planId: PLAN_ID });
    expect(prisma.discoveryRunLink.create).toHaveBeenCalledWith({
      data: {
        runId: ENGINE_RUN_ID,
        workspaceId: WORKSPACE_ID,
        planId: PLAN_ID,
        icpId: '00000000-0000-4000-8000-000000000000',
      },
    });
  });

  it('returns 404 NOT_FOUND without leaking foreign workspace ownership when runId collides (findFirst or P2002)', async () => {
    const first = makeController();
    first.prisma.discoveryRunLink.findFirst.mockResolvedValueOnce({
      runId: ENGINE_RUN_ID,
      workspaceId: '99999999-9999-4999-8999-999999999999',
    } as never);
    await expect(first.controller.startRun(req, TASK_ID, { planId: PLAN_ID })).rejects.toMatchObject({
      status: 404,
      response: { error: { code: 'NOT_FOUND' } },
    });

    const rlsConflict = makeController();
    rlsConflict.prisma.discoveryRunLink.create.mockRejectedValueOnce(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    );
    await expect(rlsConflict.controller.startRun(req, TASK_ID, { planId: PLAN_ID })).rejects.toMatchObject({
      status: 404,
      response: { error: { code: 'NOT_FOUND' } },
    });
  });
});

describe('AcquisitionTasksController GET/PATCH /api/tasks/:taskId (Wave B1)', () => {
  const memberReq = {
    tenant: { userId: USER_ID, workspaceId: WORKSPACE_ID, role: 'member' },
  } as never;

  it('keeps TenantGuard at controller level without AdminGuard (consistent with list/create/startRun)', () => {
    const classGuards = Reflect.getMetadata(GUARDS_METADATA, AcquisitionTasksController);
    expect(classGuards).toEqual([TenantGuard]);
    expect(Reflect.getMetadata(GUARDS_METADATA, AcquisitionTasksController.prototype.getOne)).toBeUndefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, AcquisitionTasksController.prototype.update)).toBeUndefined();
  });

  it('GET /api/tasks/:taskId returns a workspace task with recent runs and runCount matching list view', async () => {
    const startedAt = new Date('2026-11-05T08:00:00Z');
    const finishedAt = new Date('2026-11-05T08:05:00Z');
    const now = new Date('2026-11-04T04:00:00Z');
    const { controller, prisma } = makeController({
      task: {
        id: TASK_ID,
        workspaceId: WORKSPACE_ID,
        icpId: ICP_ID,
        name: '德国泵买家',
        status: 'active',
        createdBy: USER_ID,
        lastRunAt: finishedAt,
        createdAt: now,
        updatedAt: finishedAt,
        _count: { runs: 3 },
        runs: [
          {
            id: TASK_RUN_ID,
            engineRunId: ENGINE_RUN_ID,
            planId: PLAN_ID,
            attempt: 3,
            rerunOf: null,
            trigger: 'manual',
            status: 'DONE',
            startedAt,
            finishedAt,
          },
        ],
      },
    });

    const result = await controller.getOne(memberReq, TASK_ID);
    expect((prisma as unknown as { withWorkspace: ReturnType<typeof vi.fn> }).withWorkspace).toHaveBeenCalledWith(
      WORKSPACE_ID,
      expect.any(Function),
    );
    expect(prisma.acquisitionTask.findFirst).toHaveBeenCalledWith({
      where: { id: TASK_ID, workspaceId: WORKSPACE_ID },
      include: {
        runs: { orderBy: { createdAt: 'desc' }, take: 20 },
        _count: { select: { runs: true } },
      },
    });
    expect(result).toEqual({
      data: {
        id: TASK_ID,
        icpId: ICP_ID,
        name: '德国泵买家',
        status: 'active',
        createdBy: USER_ID,
        lastRunAt: finishedAt.toISOString(),
        createdAt: now.toISOString(),
        updatedAt: finishedAt.toISOString(),
        runCount: 3,
        runs: [
          {
            id: TASK_RUN_ID,
            runId: ENGINE_RUN_ID,
            planId: PLAN_ID,
            attempt: 3,
            rerunOf: null,
            trigger: 'manual',
            status: 'DONE',
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
          },
        ],
      },
    });
  });

  it('GET /api/tasks/:taskId returns 404 TASK_NOT_FOUND for unknown or cross-tenant task and 400 for malformed UUID', async () => {
    const missing = makeController({ task: null });
    await expect(missing.controller.getOne(memberReq, TASK_ID)).rejects.toMatchObject({
      status: 404,
      response: { error: { code: 'TASK_NOT_FOUND' } },
    });

    const bad = makeController();
    await expect(bad.controller.getOne(memberReq, 'not-a-uuid')).rejects.toMatchObject({
      status: 400,
      response: { error: { code: 'VALIDATION_ERROR' } },
    });
    expect(bad.prisma.acquisitionTask.findFirst).not.toHaveBeenCalled();
  });

  it('PATCH /api/tasks/:taskId renames a task, trims whitespace, and writes audit log (member allowed)', async () => {
    const now = new Date('2026-11-04T04:00:00Z');
    const updatedAt = new Date('2026-11-05T09:00:00Z');
    const { controller, prisma, audit } = makeController();
    prisma.acquisitionTask.update.mockResolvedValueOnce({
      id: TASK_ID,
      workspaceId: WORKSPACE_ID,
      icpId: ICP_ID,
      name: '德国离心泵买家',
      status: 'active',
      createdBy: USER_ID,
      lastRunAt: null,
      createdAt: now,
      updatedAt,
      _count: { runs: 0 },
      runs: [],
    });

    const result = await controller.update(memberReq, TASK_ID, { name: '  德国离心泵买家  ' });
    expect((prisma as unknown as { withWorkspace: ReturnType<typeof vi.fn> }).withWorkspace).toHaveBeenCalledWith(
      WORKSPACE_ID,
      expect.any(Function),
    );
    expect(prisma.acquisitionTask.update).toHaveBeenCalledWith({
      where: { id: TASK_ID },
      data: { name: '德国离心泵买家' },
      include: {
        runs: { orderBy: { createdAt: 'desc' }, take: 20 },
        _count: { select: { runs: true } },
      },
    });
    expect(audit.record).toHaveBeenCalledWith({
      realm: 'tenant',
      actorId: USER_ID,
      workspaceId: WORKSPACE_ID,
      action: 'acquisition.task.update',
      target: TASK_ID,
      detail: { nameChanged: true },
    });
    expect(result).toMatchObject({
      data: { id: TASK_ID, name: '德国离心泵买家', status: 'active', runCount: 0, runs: [] },
    });
  });

  it.each([
    ['active', 'paused'],
    ['paused', 'active'],
    ['active', 'archived'],
    ['paused', 'archived'],
    ['archived', 'archived'],
  ] as const)('PATCH /api/tasks/:taskId allows transition %s -> %s and audits status change', async (fromStatus, toStatus) => {
    const now = new Date('2026-11-04T04:00:00Z');
    const { controller, prisma, audit } = makeController({
      task: {
        id: TASK_ID,
        workspaceId: WORKSPACE_ID,
        icpId: ICP_ID,
        name: '德国泵买家',
        status: fromStatus,
        createdBy: USER_ID,
        lastRunAt: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    prisma.acquisitionTask.update.mockResolvedValueOnce({
      id: TASK_ID,
      workspaceId: WORKSPACE_ID,
      icpId: ICP_ID,
      name: '德国泵买家',
      status: toStatus,
      createdBy: USER_ID,
      lastRunAt: null,
      createdAt: now,
      updatedAt: now,
      _count: { runs: 0 },
      runs: [],
    });

    const result = await controller.update(req, TASK_ID, { status: toStatus });
    expect(prisma.acquisitionTask.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TASK_ID }, data: { status: toStatus } }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'acquisition.task.update',
        target: TASK_ID,
        detail: { fromStatus, toStatus },
      }),
    );
    expect(result.data.status).toBe(toStatus);
  });

  it.each(['active', 'paused'] as const)('PATCH /api/tasks/:taskId rejects archived -> %s with 400 INVALID_STATE', async (nextStatus) => {
    const now = new Date('2026-11-04T04:00:00Z');
    const { controller, prisma, audit } = makeController({
      task: {
        id: TASK_ID,
        workspaceId: WORKSPACE_ID,
        icpId: ICP_ID,
        name: '已归档任务',
        status: 'archived',
        createdBy: USER_ID,
        lastRunAt: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    await expect(controller.update(req, TASK_ID, { status: nextStatus })).rejects.toMatchObject({
      status: 400,
      response: { error: { code: 'INVALID_STATE' } },
    });
    expect(prisma.acquisitionTask.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('PATCH /api/tasks/:taskId returns 404 TASK_NOT_FOUND for unknown or cross-tenant task', async () => {
    const { controller, prisma, audit } = makeController({ task: null });
    await expect(controller.update(req, TASK_ID, { name: '新名称' })).rejects.toMatchObject({
      status: 404,
      response: { error: { code: 'TASK_NOT_FOUND' } },
    });
    expect(prisma.acquisitionTask.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown field workspaceId', { workspaceId: WORKSPACE_ID }],
    ['unknown field icpId', { icpId: ICP_ID }],
    ['unknown field mixed with name', { name: '合法', extra: 1 }],
    ['empty object', {}],
    ['blank name', { name: '   ' }],
    ['too long name', { name: 'a'.repeat(201) }],
    ['non-string name', { name: 123 }],
    ['uppercase ACTIVE status', { status: 'ACTIVE' }],
    ['uppercase PAUSED status', { status: 'PAUSED' }],
    ['unknown status enum', { status: 'deleted' }],
    ['null status', { status: null }],
  ] as const)('PATCH /api/tasks/:taskId rejects %s with 400 VALIDATION_ERROR before DB access', async (_label, body) => {
    const { controller, prisma, audit } = makeController();
    await expect(controller.update(req, TASK_ID, body as Record<string, unknown>)).rejects.toMatchObject({
      status: 400,
      response: { error: { code: 'VALIDATION_ERROR' } },
    });
    expect(prisma.acquisitionTask.findFirst).not.toHaveBeenCalled();
    expect(prisma.acquisitionTask.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('PATCH /api/tasks/:taskId rejects malformed taskId with 400 VALIDATION_ERROR', async () => {
    const { controller, prisma } = makeController();
    await expect(controller.update(req, 'bad-id', { name: 'ok' })).rejects.toMatchObject({
      status: 400,
      response: { error: { code: 'VALIDATION_ERROR' } },
    });
    expect(prisma.acquisitionTask.findFirst).not.toHaveBeenCalled();
  });
});
