import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { BffHandler } from '../bff/bff.module.js';
import type { EngineBudgetGrantService } from '../bff/engine-budget-grant.service.js';
import { EngineHttp } from '../bff/engine-http.js';
import type { AppConfig } from '../config/configuration.js';
import type { ComplianceDeclarationService } from '../service/compliance-declaration.service.js';
import { EventConsumerService } from '../service/event-consumer.service.js';
import type { AuditService } from '../shared/audit.service.js';
import type { PrismaService } from '../shared/prisma.service.js';
import {
  extractDiscoveryBillableUnits,
  extractDiscoveryRunId,
  extractSyncBillableUnits,
  resolveBffWalletAction,
} from './bff-wallet-billing.js';
import type { WalletService } from './wallet.service.js';
import { InsufficientCreditsError } from './wallet.types.js';

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

describe('bff-wallet-billing pure mapping', () => {
  it('keeps company creation, understanding, ICP, and query-plan generation free (null)', () => {
    expect(resolveBffWalletAction('POST', '/companies')).toBeNull();
    expect(resolveBffWalletAction('POST', '/companies/:companyId/understanding/retry')).toBeNull();
    expect(resolveBffWalletAction('POST', '/companies/:companyId/icps')).toBeNull();
    expect(resolveBffWalletAction('POST', '/icps/:icpId/query-plans')).toBeNull();
    expect(resolveBffWalletAction('GET', '/leads')).toBeNull();
  });

  it('maps the 4 core billable BFF routes to wallet actions & modes', () => {
    expect(resolveBffWalletAction('POST', '/query-plans/:planId/execute')).toEqual({
      actionCode: 'DISCOVERY_QUALIFIED_LEAD',
      refType: 'discovery_run',
      mode: 'async',
      refParam: 'planId',
    });
    expect(resolveBffWalletAction('POST', '/contact-points/:pointId/verify')).toEqual({
      actionCode: 'CONTACT_VALID_EMAIL',
      refType: 'contact_verify',
      mode: 'sync',
      refParam: 'pointId',
    });
    expect(resolveBffWalletAction('POST', '/canonical-companies/:id/discover-contacts')).toEqual({
      actionCode: 'CONTACT_DISCOVER',
      refType: 'contact_discover',
      mode: 'sync',
      refParam: 'id',
    });
    expect(resolveBffWalletAction('POST', '/canonical-companies/:id/enrich-contacts')).toEqual({
      actionCode: 'CONTACT_ENRICH',
      refType: 'contact_enrich',
      mode: 'sync',
      refParam: 'id',
    });
  });

  it('extracts billable units matching real engine wire schemas (verify, discover, enrich stored-only, discovery stats)', () => {
    expect(extractSyncBillableUnits('CONTACT_VALID_EMAIL', { data: { status: 'VALID' } })).toBe(1);
    expect(extractSyncBillableUnits('CONTACT_VALID_EMAIL', { data: { state: 'VALID' } })).toBe(1);
    expect(
      extractSyncBillableUnits('CONTACT_VALID_EMAIL', {
        data: { verification: { status: 'VALID' } },
      }),
    ).toBe(1);
    expect(extractSyncBillableUnits('CONTACT_VALID_EMAIL', { data: { status: 'INVALID' } })).toBe(0);
    expect(extractSyncBillableUnits('CONTACT_VALID_EMAIL', { data: { status: 'UNKNOWN' } })).toBe(0);
    expect(extractSyncBillableUnits('CONTACT_VALID_EMAIL', { data: { status: 'RISKY' } })).toBe(0);

    expect(extractSyncBillableUnits('CONTACT_DISCOVER', { data: { contacts: [{ id: '1' }, { id: '2' }] } })).toBe(2);
    expect(extractSyncBillableUnits('CONTACT_DISCOVER', { data: { contacts: [] } })).toBe(0);

    // 真实引擎 enrich-contacts 响应：仅 status==='stored' 新落库计费，'reused' 缓存命中不收费
    expect(
      extractSyncBillableUnits('CONTACT_ENRICH', {
        data: {
          companyId: randomUUID(),
          tier: 'standard',
          attempted: 4,
          costMicrousd: 1500,
          deadlineHit: false,
          results: [
            { contactId: 'c1', status: 'stored' },
            { contactId: 'c2', status: 'reused' },
            { contactId: 'c3', status: 'stored' },
            { contactId: 'c4', status: 'not_found' },
          ],
        },
      }),
    ).toBe(2);
    expect(
      extractSyncBillableUnits('CONTACT_ENRICH', {
        data: {
          attempted: 2,
          results: [
            { contactId: 'c1', status: 'reused' },
            { contactId: 'c2', status: 'failed' },
          ],
        },
      }),
    ).toBe(0);
    expect(extractSyncBillableUnits('CONTACT_ENRICH', { data: { validEmailCount: 3 } })).toBe(3);

    // 真实引擎 DiscoveryRunCompleted：Run 2.0 stats.quickScan.leads / Run 1.0 stats.fit.match
    expect(
      extractDiscoveryBillableUnits('DONE', {
        planId: randomUUID(),
        status: 'DONE',
        stats: { quickScan: { leads: 12 } },
      }),
    ).toBe(12);
    expect(
      extractDiscoveryBillableUnits('PARTIAL', {
        planId: randomUUID(),
        status: 'PARTIAL',
        stats: { fit: { match: 7, weak: 3, mismatch: 2 } },
      }),
    ).toBe(7);
    expect(
      extractDiscoveryBillableUnits('FAILED', {
        planId: randomUUID(),
        status: 'FAILED',
        stats: { quickScan: { leads: 12 } },
      }),
    ).toBe(0);
    expect(
      extractDiscoveryBillableUnits('CANCELLED', {
        planId: randomUUID(),
        status: 'CANCELLED',
        stats: { fit: { match: 7 } },
      }),
    ).toBe(0);

    const runId = randomUUID();
    expect(extractDiscoveryRunId({ data: { id: runId } })).toBe(runId);
    expect(extractDiscoveryRunId({ data: { runId } })).toBe(runId);
    expect(extractDiscoveryRunId({ id: runId })).toBe(runId);
  });
});

describe('BffHandler wallet integration', () => {
  const wsId = randomUUID();
  const userId = randomUUID();
  const baseConfig = {
    ENGINE_DISCOVER_ATTEMPT_ID_ENABLED: false,
    ENGINE_RETRY_ATTEMPT_ID_ENABLED: false,
    ENGINE_MANUFACTURER_NETWORK_ENABLED: false,
  } as AppConfig;

  function makeHandler(opts: {
    engineCall: ReturnType<typeof vi.fn>;
    wallet?: Partial<WalletService>;
  }) {
    const engine = new EngineHttp({} as never, {} as never);
    engine.call = opts.engineCall as unknown as EngineHttp['call'];
    const budget = {
      issue: vi.fn(async () => 'grant-jwt'),
    } as unknown as EngineBudgetGrantService;
    const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
    const compliance = { history: vi.fn(async () => []) } as unknown as ComplianceDeclarationService;
    return new BffHandler(
      engine,
      budget,
      audit,
      compliance,
      baseConfig,
      opts.wallet as WalletService | undefined,
    );
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

  it('returns 402 INSUFFICIENT_CREDITS without calling engine when balance is insufficient', async () => {
    const engineCall = vi.fn();
    const holdCredits = vi.fn(async () => {
      throw new InsufficientCreditsError({
        availableCredits: 5n,
        requiredCredits: 200n,
        actionCode: 'DISCOVERY_QUALIFIED_LEAD',
      });
    });
    const handler = makeHandler({
      engineCall,
      wallet: { billingEnabled: true, holdCredits },
    });
    const { res, getStatus, getBody } = mockRes();
    await handler.handle(makeReq(`/api/query-plans/${randomUUID()}/execute`, {}), res);

    expect(getStatus()).toBe(402);
    expect(engineCall).not.toHaveBeenCalled();
    expect(getBody()).toMatchObject({
      error: {
        code: 'INSUFFICIENT_CREDITS',
        userCopy: { title: expect.stringContaining('积分余额不足') },
      },
    });
  });

  it('holds -> settles 1 unit on VALID email and settles 0 units (100% refund) on INVALID email', async () => {
    const holdId1 = randomUUID();
    const holdId2 = randomUUID();
    const settleHold = vi.fn(async () => ({}) as never);
    const releaseHold = vi.fn(async () => ({}) as never);
    let calls = 0;
    const holdCredits = vi.fn(async () => ({
      free: false,
      idempotent: false,
      hold: { id: ++calls === 1 ? holdId1 : holdId2 } as never,
      account: {} as never,
    }));
    const engineCall = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, body: { data: { status: 'VALID' } }, contentType: 'application/json' })
      .mockResolvedValueOnce({ status: 200, body: { data: { status: 'INVALID' } }, contentType: 'application/json' });

    const handler = makeHandler({
      engineCall,
      wallet: { billingEnabled: true, holdCredits, settleHold, releaseHold },
    });

    const r1 = mockRes();
    await handler.handle(makeReq(`/api/contact-points/${randomUUID()}/verify`, {}, 'k-1'), r1.res);
    expect(r1.getStatus()).toBe(200);
    expect(settleHold).toHaveBeenNthCalledWith(1, wsId, expect.objectContaining({ holdId: holdId1, billableUnits: 1 }));

    const r2 = mockRes();
    await handler.handle(makeReq(`/api/contact-points/${randomUUID()}/verify`, {}, 'k-2'), r2.res);
    expect(r2.getStatus()).toBe(200);
    expect(settleHold).toHaveBeenNthCalledWith(2, wsId, expect.objectContaining({ holdId: holdId2, billableUnits: 0 }));
    expect(releaseHold).not.toHaveBeenCalled();
  });

  it('releases hold immediately when engine returns 500 or throws network error', async () => {
    const holdId = randomUUID();
    const releaseHold = vi.fn(async () => ({}) as never);
    const holdCredits = vi.fn(async () => ({
      free: false,
      idempotent: false,
      hold: { id: holdId } as never,
      account: {} as never,
    }));
    const engineCall = vi.fn(async () => ({
      status: 500,
      body: { error: { code: 'INTERNAL', message: 'boom' } },
      contentType: 'application/json',
    }));

    const handler = makeHandler({
      engineCall,
      wallet: { billingEnabled: true, holdCredits, releaseHold },
    });
    const r = mockRes();
    await handler.handle(makeReq(`/api/query-plans/${randomUUID()}/execute`, {}), r.res);
    expect(r.getStatus()).toBe(500);
    expect(releaseHold).toHaveBeenCalledWith(wsId, holdId, 'DISPATCH_FAILED_HTTP_500', userId);
  });

  it('attaches engine runId to hold on async discovery execute success', async () => {
    const holdId = randomUUID();
    const runId = randomUUID();
    const attachHoldRef = vi.fn(async () => undefined);
    const holdCredits = vi.fn(async () => ({
      free: false,
      idempotent: false,
      hold: { id: holdId } as never,
      account: {} as never,
    }));
    const engineCall = vi.fn(async () => ({
      status: 202,
      body: { data: { id: runId } },
      contentType: 'application/json',
    }));

    const handler = makeHandler({
      engineCall,
      wallet: { billingEnabled: true, holdCredits, attachHoldRef },
    });
    const r = mockRes();
    await handler.handle(makeReq(`/api/query-plans/${randomUUID()}/execute`, {}), r.res);
    expect(r.getStatus()).toBe(202);
    expect(attachHoldRef).toHaveBeenCalledWith(wsId, holdId, runId);
  });

  it('skips wallet completely when WALLET_BILLING_ENABLED=false or route is free (POST /companies)', async () => {
    const holdCredits = vi.fn();
    const engineCall = vi.fn(async () => ({ status: 201, body: { data: { id: 'c1' } }, contentType: 'application/json' }));

    const disabledHandler = makeHandler({
      engineCall,
      wallet: { billingEnabled: false, holdCredits },
    });
    const r1 = mockRes();
    await disabledHandler.handle(makeReq(`/api/query-plans/${randomUUID()}/execute`, {}), r1.res);
    expect(r1.getStatus()).toBe(201);
    expect(holdCredits).not.toHaveBeenCalled();

    const enabledHandler = makeHandler({
      engineCall,
      wallet: { billingEnabled: true, holdCredits },
    });
    const r2 = mockRes();
    await enabledHandler.handle(makeReq('/api/companies', { name: 'Acme', website: 'https://acme.example' }), r2.res);
    expect(r2.getStatus()).toBe(201);
    expect(holdCredits).not.toHaveBeenCalled();
  });

  it('does NOT release or settle existing in-flight HELD hold when duplicate Idempotency-Key hits 409/500/network error', async () => {
    const existingHoldId = randomUUID();
    const releaseHold = vi.fn(async () => ({}) as never);
    const settleHold = vi.fn(async () => ({}) as never);
    const attachHoldRef = vi.fn(async () => undefined);
    const holdCredits = vi.fn(async () => ({
      free: false,
      idempotent: true,
      hold: { id: existingHoldId, status: 'HELD' } as never,
      account: {} as never,
    }));

    const engineCall = vi
      .fn()
      .mockResolvedValueOnce({
        status: 409,
        body: { error: { code: 'DISCOVERY_RUN_ALREADY_RUNNING', message: 'already running' } },
        contentType: 'application/json',
      })
      .mockResolvedValueOnce({
        status: 500,
        body: { error: { code: 'INTERNAL', message: 'boom' } },
        contentType: 'application/json',
      })
      .mockRejectedValueOnce(new Error('ECONNRESET'));

    const handler = makeHandler({
      engineCall,
      wallet: { billingEnabled: true, holdCredits, releaseHold, settleHold, attachHoldRef },
    });

    const r409 = mockRes();
    await handler.handle(makeReq(`/api/query-plans/${randomUUID()}/execute`, {}, 'dup-key-1'), r409.res);
    expect(r409.getStatus()).toBe(409);

    const r500 = mockRes();
    await handler.handle(makeReq(`/api/query-plans/${randomUUID()}/execute`, {}, 'dup-key-1'), r500.res);
    expect(r500.getStatus()).toBe(500);

    const rNet = mockRes();
    await handler.handle(makeReq(`/api/canonical-companies/${randomUUID()}/enrich-contacts`, {}, 'dup-key-2'), rNet.res);
    expect(rNet.getStatus()).toBe(502);

    expect(releaseHold).not.toHaveBeenCalled();
    expect(settleHold).not.toHaveBeenCalled();
    expect(attachHoldRef).not.toHaveBeenCalled();
  });

  it('EventConsumerService settles discovery_run hold by real engine stats (quickScan.leads & fit.match) and 0 on FAILED', async () => {
    const runV2 = randomUUID();
    const runV1 = randomUUID();
    const runFail = randomUUID();
    const settleHoldByRef = vi.fn(async () => null);
    const consumer = new EventConsumerService(
      { EVENT_CONSUMER_ENABLED: true } as AppConfig,
      {} as never,
      {} as PrismaService,
      { billingEnabled: true, settleHoldByRef } as unknown as WalletService,
    );
    const tx = {
      taskRun: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUnique: vi.fn(async () => null),
      },
      notification: { create: vi.fn(async () => ({})) },
    };

    const derive = (consumer as unknown as {
      derive: (t: unknown, ev: Record<string, unknown>) => Promise<void>;
    }).derive.bind(consumer);

    await derive(tx, {
      eventId: randomUUID(),
      workspaceId: wsId,
      type: 'DiscoveryRunCompleted',
      aggregateId: runV2,
      occurredAt: new Date(),
      projectionAttempts: 0,
      payload: {
        planId: randomUUID(),
        status: 'DONE',
        stats: { quickScan: { leads: 14 } },
        cost: { totalUsd: 0.42 },
      },
    });
    expect(settleHoldByRef).toHaveBeenNthCalledWith(
      1,
      wsId,
      'discovery_run',
      runV2,
      14,
      'DiscoveryRunCompleted:DONE',
      'system:event-consumer',
    );

    await derive(tx, {
      eventId: randomUUID(),
      workspaceId: wsId,
      type: 'DiscoveryRunCompleted',
      aggregateId: runV1,
      occurredAt: new Date(),
      projectionAttempts: 0,
      payload: {
        planId: randomUUID(),
        status: 'PARTIAL',
        stats: { fit: { match: 6, weak: 2, mismatch: 5 } },
      },
    });
    expect(settleHoldByRef).toHaveBeenNthCalledWith(
      2,
      wsId,
      'discovery_run',
      runV1,
      6,
      'DiscoveryRunCompleted:PARTIAL',
      'system:event-consumer',
    );

    await derive(tx, {
      eventId: randomUUID(),
      workspaceId: wsId,
      type: 'DiscoveryRunCompleted',
      aggregateId: runFail,
      occurredAt: new Date(),
      projectionAttempts: 0,
      payload: {
        planId: randomUUID(),
        status: 'FAILED',
        stats: { quickScan: { leads: 5 } },
      },
    });
    expect(settleHoldByRef).toHaveBeenNthCalledWith(
      3,
      wsId,
      'discovery_run',
      runFail,
      0,
      'DiscoveryRunCompleted:FAILED',
      'system:event-consumer',
    );
  });
});
