import { randomUUID } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { ComplianceDeclarationService } from '../service/compliance-declaration.service.js';
import { EngineBudgetGrantSigner, type WorkspaceTechnicalQuote } from '../service/engine-budget-grant.signer.js';
import { JwksController } from '../service/service.module.js';
import type { AuditService } from '../shared/audit.service.js';
import type { OpsDatabase } from '../ops/ops-database.service.js';
import { OpsService } from '../ops/ops.service.js';
import type { WalletService } from '../wallet/wallet.service.js';
import { InsufficientCreditsError } from '../wallet/wallet.types.js';
import { AcquisitionTasksController } from './acquisition-tasks.controller.js';
import { BffHandler } from './bff.module.js';
import { EngineBudgetGrantService } from './engine-budget-grant.service.js';
import { EngineHttp } from './engine-http.js';
import { OnboardingController } from './onboarding.controller.js';

function mockRes() {
  let statusCode = 200;
  let jsonBody: unknown = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: unknown) {
      jsonBody = body;
      return res;
    },
    setHeader: vi.fn(),
    type: vi.fn().mockReturnThis(),
    send: vi.fn(),
  } as unknown as Response;
  return { res, getStatus: () => statusCode, getBody: () => jsonBody };
}

describe('LEGACY_EXECUTION_BUDGET_MODE=bypass 旁路开关', () => {
  const wsId = randomUUID();
  const userId = randomUUID();

  function makeBffHandler(opts: {
    mode: 'enforce' | 'bypass';
    engineCall: ReturnType<typeof vi.fn>;
    budgetIssue?: ReturnType<typeof vi.fn>;
    wallet?: Partial<WalletService>;
  }) {
    const engine = new EngineHttp({} as never, {} as never);
    engine.call = opts.engineCall as unknown as EngineHttp['call'];
    const budgetIssue = opts.budgetIssue ?? vi.fn(async () => 'grant-jws');
    const budget = { issue: budgetIssue } as unknown as EngineBudgetGrantService;
    const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
    const compliance = { history: vi.fn(async () => []) } as unknown as ComplianceDeclarationService;
    const config = {
      LEGACY_EXECUTION_BUDGET_MODE: opts.mode,
      ENGINE_DISCOVER_ATTEMPT_ID_ENABLED: false,
      ENGINE_RETRY_ATTEMPT_ID_ENABLED: false,
      ENGINE_MANUFACTURER_NETWORK_ENABLED: false,
    } as AppConfig;
    const handler = new BffHandler(
      engine,
      budget,
      audit,
      compliance,
      config,
      opts.wallet as WalletService | undefined,
    );
    return { handler, budgetIssue };
  }

  function makeReq(path: string, body: unknown = {}, idempotencyKey?: string): Request {
    return {
      method: 'POST',
      path,
      originalUrl: path,
      body,
      headers: { 'accept-language': 'zh-CN' },
      tenant: { userId, workspaceId: wsId, role: 'admin' },
      get: (name: string) => (name.toLowerCase() === 'idempotency-key' ? idempotencyKey : undefined),
    } as unknown as Request;
  }

  it('bypass 模式下 BFF 写路由零 /quote、零 Grant 签发、不注入 x-execution-budget-grant，且重复重试绝不触发 GRANT_REUSED', async () => {
    const planId = randomUUID();
    const runId1 = randomUUID();
    const runId2 = randomUUID();
    const engineCall = vi
      .fn()
      .mockResolvedValueOnce({ status: 500, body: { error: { code: 'TRANSIENT', message: 'retry me' } }, contentType: 'application/json' })
      .mockResolvedValueOnce({ status: 202, body: { data: { id: runId1 } }, contentType: 'application/json' })
      .mockResolvedValueOnce({ status: 202, body: { data: { id: runId2 } }, contentType: 'application/json' });

    const { handler, budgetIssue } = makeBffHandler({ mode: 'bypass', engineCall });

    const r1 = mockRes();
    await handler.handle(makeReq(`/api/query-plans/${planId}/execute`, {}, 'idem-1'), r1.res);
    expect(r1.getStatus()).toBe(500);

    // 同 planId 重试（即使 ENGINE_RETRY_ATTEMPT_ID_ENABLED=false 也不走 Grant，绝不撞 409 GRANT_REUSED）
    const r2 = mockRes();
    await handler.handle(makeReq(`/api/query-plans/${planId}/execute`, {}, 'idem-2'), r2.res);
    expect(r2.getStatus()).toBe(202);

    const r3 = mockRes();
    await handler.handle(makeReq(`/api/query-plans/${planId}/execute`, {}, 'idem-3'), r3.res);
    expect(r3.getStatus()).toBe(202);

    expect(budgetIssue).not.toHaveBeenCalled();
    expect(engineCall).toHaveBeenCalledTimes(3);
    for (const callArgs of engineCall.mock.calls) {
      const options = callArgs[3] as { headers?: Record<string, string> };
      expect(options.headers).not.toHaveProperty('x-execution-budget-grant');
    }
  });

  it('bypass + WALLET_BILLING_ENABLED=true 协同跑通：预占 → 纯租户转发 → 成功按实扣费 / 失败全额退点 / 余额不足 402', async () => {
    const holdAsync = randomUUID();
    const holdValid = randomUUID();
    const holdInvalid = randomUUID();
    const holdFailed = randomUUID();
    const runId = randomUUID();

    const holdCredits = vi
      .fn()
      .mockResolvedValueOnce({ free: false, idempotent: false, hold: { id: holdAsync }, account: {} })
      .mockResolvedValueOnce({ free: false, idempotent: false, hold: { id: holdValid }, account: {} })
      .mockResolvedValueOnce({ free: false, idempotent: false, hold: { id: holdInvalid }, account: {} })
      .mockResolvedValueOnce({ free: false, idempotent: false, hold: { id: holdFailed }, account: {} })
      .mockRejectedValueOnce(
        new InsufficientCreditsError({
          availableCredits: 0n,
          requiredCredits: 50n,
          actionCode: 'CONTACT_VALID_EMAIL',
        }),
      );
    const attachHoldRef = vi.fn(async () => undefined);
    const settleHold = vi.fn(async () => ({}) as never);
    const releaseHold = vi.fn(async () => ({}) as never);

    const engineCall = vi
      .fn()
      .mockResolvedValueOnce({ status: 202, body: { data: { id: runId } }, contentType: 'application/json' })
      .mockResolvedValueOnce({ status: 200, body: { data: { status: 'VALID' } }, contentType: 'application/json' })
      .mockResolvedValueOnce({ status: 200, body: { data: { status: 'INVALID' } }, contentType: 'application/json' })
      .mockResolvedValueOnce({ status: 503, body: { error: { code: 'UPSTREAM_DOWN', message: 'down' } }, contentType: 'application/json' });

    const { handler, budgetIssue } = makeBffHandler({
      mode: 'bypass',
      engineCall,
      wallet: { billingEnabled: true, holdCredits, attachHoldRef, settleHold, releaseHold },
    });

    // 1. 异步发现：预占 → 转发(无 Grant 头) → 绑定 runId
    const resAsync = mockRes();
    await handler.handle(makeReq(`/api/query-plans/${randomUUID()}/execute`, {}, 'k-async'), resAsync.res);
    expect(resAsync.getStatus()).toBe(202);
    expect(attachHoldRef).toHaveBeenCalledWith(wsId, holdAsync, runId);

    // 2. 同步校验 VALID：实扣 1 单位
    const resValid = mockRes();
    await handler.handle(makeReq(`/api/contact-points/${randomUUID()}/verify`, {}, 'k-valid'), resValid.res);
    expect(resValid.getStatus()).toBe(200);
    expect(settleHold).toHaveBeenNthCalledWith(1, wsId, expect.objectContaining({ holdId: holdValid, billableUnits: 1 }));

    // 3. 同步校验 INVALID：实扣 0 单位（自动全额退还差额）
    const resInvalid = mockRes();
    await handler.handle(makeReq(`/api/contact-points/${randomUUID()}/verify`, {}, 'k-invalid'), resInvalid.res);
    expect(resInvalid.getStatus()).toBe(200);
    expect(settleHold).toHaveBeenNthCalledWith(2, wsId, expect.objectContaining({ holdId: holdInvalid, billableUnits: 0 }));

    // 4. 引擎 503 失败：立即全额退还预占
    const resFailed = mockRes();
    await handler.handle(makeReq(`/api/contact-points/${randomUUID()}/verify`, {}, 'k-fail'), resFailed.res);
    expect(resFailed.getStatus()).toBe(503);
    expect(releaseHold).toHaveBeenCalledWith(wsId, holdFailed, 'DISPATCH_FAILED_HTTP_503', userId);

    // 5. 余额不足：直接 402，不转发引擎
    const res402 = mockRes();
    await handler.handle(makeReq(`/api/contact-points/${randomUUID()}/verify`, {}, 'k-402'), res402.res);
    expect(res402.getStatus()).toBe(402);

    expect(budgetIssue).not.toHaveBeenCalled();
    expect(engineCall).toHaveBeenCalledTimes(4);
    for (const callArgs of engineCall.mock.calls) {
      const options = callArgs[3] as { headers?: Record<string, string> };
      expect(options.headers).not.toHaveProperty('x-execution-budget-grant');
    }
  });

  it('enforce 默认模式回归不变：仍调用 quote/Grant 并注入 x-execution-budget-grant', async () => {
    const engineCall = vi.fn(async () => ({ status: 201, body: { data: { id: 'c1' } }, contentType: 'application/json' }));
    const { handler, budgetIssue } = makeBffHandler({ mode: 'enforce', engineCall });

    const r = mockRes();
    await handler.handle(makeReq('/api/companies', { name: 'Acme', website: 'https://acme.example' }), r.res);
    expect(r.getStatus()).toBe(201);
    expect(budgetIssue).toHaveBeenCalledTimes(1);
    expect(engineCall).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: wsId }),
      'POST',
      '/companies',
      expect.objectContaining({ headers: { 'x-execution-budget-grant': 'grant-jws' } }),
    );
  });

  it('EngineBudgetGrantSigner & EngineBudgetGrantService & JwksController 在 bypass 无密钥态安全初始化且拒绝误签', async () => {
    const bypassConfig = {
      LEGACY_EXECUTION_BUDGET_MODE: 'bypass',
      ENGINE_BUDGET_GRANT_TTL_SECONDS: 240,
    } as AppConfig;

    const signer = new EngineBudgetGrantSigner(bypassConfig);
    await expect(signer.init()).resolves.toBeUndefined();
    expect(signer.hasPublicJwks).toBe(false);
    await expect(signer.mint({} as WorkspaceTechnicalQuote, wsId)).rejects.toThrow(/bypass/);

    const engineCall = vi.fn();
    const grantService = new EngineBudgetGrantService(
      { call: engineCall } as unknown as EngineHttp,
      signer,
      { assertGrantAllowed: vi.fn() } as never,
      bypassConfig,
    );
    expect(grantService.isBypassed).toBe(true);
    await expect(
      grantService.issue({ userId, workspaceId: wsId, role: 'admin' }, { operation: 'POST /companies' }),
    ).rejects.toThrow(/bypass/);
    expect(engineCall).not.toHaveBeenCalled();

    const jwksController = new JwksController(
      { publicJwks: async () => ({ keys: [] }) } as never,
      signer,
      bypassConfig,
    );
    try {
      jwksController.executionBudgetJwks();
      throw new Error('should throw 503');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect((err as ServiceUnavailableException).getResponse()).toMatchObject({
        error: { code: 'LEGACY_EXECUTION_BUDGET_BYPASSED', mode: 'bypass' },
      });
    }
  });

  it('AcquisitionTasksController.startRun 在 bypass 模式跳过 quote/Grant 且不带 x-execution-budget-grant 头', async () => {
    const taskId = randomUUID();
    const planId = randomUUID();
    const runId = randomUUID();
    const taskRunId = randomUUID();
    const now = new Date();
    const prisma = {
      acquisitionTask: {
        findFirst: vi.fn(async () => ({ id: taskId, workspaceId: wsId, icpId: randomUUID(), name: 'T', status: 'active' })),
        update: vi.fn(async () => ({})),
      },
      taskRun: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async () => ({ id: taskRunId, attempt: 1, status: 'RUNNING', startedAt: now })),
        update: vi.fn(async () => ({})),
      },
      discoveryRunLink: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async () => ({})),
      },
      $queryRaw: vi.fn(async () => [{ id: taskId }]),
    };
    (prisma as Record<string, unknown>).withWorkspace = vi.fn(async (_w: string, fn: (c: typeof prisma) => Promise<unknown>) => fn(prisma));
    const engine = {
      call: vi.fn(async () => ({ status: 202, body: { data: { runId, status: 'RUNNING' } } })),
      toClientStatus: vi.fn((s: number) => s),
      toClientError: vi.fn((_s: number, b: unknown) => b),
    };
    const budget = { issue: vi.fn(async () => 'should-not-mint') };
    const audit = { record: vi.fn(async () => undefined) };
    const controller = new AcquisitionTasksController(
      prisma as never,
      audit as never,
      engine as never,
      budget as never,
      {
        LEGACY_EXECUTION_BUDGET_MODE: 'bypass',
        ENGINE_RETRY_ATTEMPT_ID_ENABLED: false,
        ENGINE_DISCOVER_ATTEMPT_ID_ENABLED: false,
        ENGINE_MANUFACTURER_NETWORK_ENABLED: false,
      } as AppConfig,
    );

    const result = await controller.startRun(
      { tenant: { userId, workspaceId: wsId, role: 'admin' } } as never,
      taskId,
      { planId },
    );
    expect(result.data.runId).toBe(runId);
    expect(budget.issue).not.toHaveBeenCalled();
    expect(engine.call).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: wsId }),
      'POST',
      `/query-plans/${planId}/execute`,
      expect.objectContaining({
        body: expect.objectContaining({ taskRef: { taskId, taskRunId } }),
      }),
    );
    const engineCallOpts = engine.call.mock.calls[0]?.[3] as { headers?: Record<string, string> };
    expect(engineCallOpts.headers).toBeUndefined();
  });

  it('OnboardingController 在 bypass 模式下跳过建档与重试理解的 quote/Grant，保留幂等键', async () => {
    const engine = new EngineHttp({} as never, {} as never);
    const call = vi.fn(async (_tenant: unknown, method: string, path: string) => {
      if (method === 'POST' && path === '/companies') return { status: 201, body: { data: { id: 'co-1' } }, contentType: 'application/json', headers: {} };
      if (method === 'GET' && path === '/companies/co-1/understanding-preview') {
        return {
          status: 200,
          body: {
            data: {
              companyId: 'co-1',
              name: 'Acme',
              website: 'https://acme.example',
              status: 'DRAFT',
              state: 'queued',
              failure: null,
              pagesAnalyzed: 0,
              industry: { raw: null, suggested: { raw: null, code: null, label: null, labelEn: null, matched: false }, options: [] },
              products: [],
              markets: [],
            },
          },
          contentType: 'application/json',
          headers: {},
        };
      }
      return { status: 200, body: { data: { id: 'co-1' } }, contentType: 'application/json', headers: {} };
    });
    engine.call = call as unknown as EngineHttp['call'];
    const budget = { issue: vi.fn(async () => 'should-not-mint') };
    const controller = new OnboardingController(
      { workspace: { update: vi.fn(async () => ({})) } } as never,
      { record: vi.fn(async () => undefined) } as never,
      engine,
      budget as never,
      { LEGACY_EXECUTION_BUDGET_MODE: 'bypass' } as AppConfig,
    );

    const req = {
      tenant: {
        userId,
        workspaceId: wsId,
        role: 'admin',
        jti: 'j-1',
        exp: 0,
        onboardingCompleted: false,
        onboardingCompanyId: null,
      },
    } as unknown as Request;

    const preview = await controller.startPreview(req, { name: 'Acme', website: 'https://acme.example' });
    expect(preview.data.started).toBe(true);
    expect(budget.issue).not.toHaveBeenCalled();

    const postCompanyCall = call.mock.calls.find((c) => c[1] === 'POST' && c[2] === '/companies');
    expect(postCompanyCall).toBeDefined();
    const postHeaders = (postCompanyCall?.[3] as { headers?: Record<string, string> })?.headers;
    expect(postHeaders?.['idempotency-key']).toMatch(/^onboarding-preview:/);
    expect(postHeaders).not.toHaveProperty('x-execution-budget-grant');
  });

  it('OpsService.budget() 在 bypass 模式下返回兼容结构与清晰说明，旧表不可查也不崩溃', async () => {
    const db = {
      ownerPool: null,
      query: vi.fn(async () => {
        throw new Error('relation tool_budget_account does not exist');
      }),
    };
    const ops = new OpsService(
      { LEGACY_EXECUTION_BUDGET_MODE: 'bypass', PLATFORM_AUTHORITY_MODE: 'internal_db' } as AppConfig,
      { db } as unknown as OpsDatabase,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await ops.budget();
    expect(result).toMatchObject({
      mode: 'bypass',
      legacyBudgetBypassed: true,
      accounts: [],
      authorities: [],
    });
    expect(String(result.note)).toContain('LEGACY_EXECUTION_BUDGET_MODE=bypass');
  });
});
