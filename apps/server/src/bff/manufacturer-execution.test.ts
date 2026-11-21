import type { components } from '@gain-saas/engine-client';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { ManufacturerNetworkRevision } from './routes.js';
import { BffHandler } from './bff.module.js';
import { BFF_ROUTES, budgetQuoteRequest, engineRequestBody, isManufacturerNetworkRevision } from './routes.js';

const execute = BFF_ROUTES.find((route) => route.enginePath === '/query-plans/:planId/execute')!;
const planId = '11111111-1111-4111-8111-111111111111';
const attemptId = '22222222-2222-4222-8222-222222222222';
const manufacturerNetworkRevision = 'manufacturer-network/v1';
const enabled = { writeAttemptId: true, manufacturerNetwork: true };

describe('manufacturer execution quote and forwarded request', () => {
  it('uses the generated execution revision type for the runtime predicate', () => {
    type GeneratedRevision = NonNullable<components['schemas']['ExecuteQueryPlanDto']['manufacturerNetworkRevision']>;
    expectTypeOf<ManufacturerNetworkRevision>().toEqualTypeOf<GeneratedRevision>();
    const value: unknown = 'manufacturer-network/v2';
    if (isManufacturerNetworkRevision(value)) expectTypeOf(value).toEqualTypeOf<GeneratedRevision>();
  });
  it('binds the explicit evidence revision and attempt into the normal quote', () => {
    const body = { attemptId, manufacturerNetworkRevision, taskRef: { taskId: planId, taskRunId: attemptId } };
    const forwarded = engineRequestBody(execute, body, enabled);
    expect(forwarded).toEqual(body);
    expect(budgetQuoteRequest(execute, { planId }, forwarded, enabled)).toEqual({
      operation: 'POST /query-plans/:planId/execute', planId,
      body: { attemptId, manufacturerNetworkRevision },
    });
  });

  it('does not silently drop a requested revision on an old engine', () => {
    const body = { attemptId, manufacturerNetworkRevision };
    expect(() => engineRequestBody(execute, body, { writeAttemptId: true })).toThrow();
    expect(() => budgetQuoteRequest(execute, { planId }, body, { writeAttemptId: true })).toThrow();
  });

  it.each(['manufacturer-network/v1', 'manufacturer-network/v2'])('preserves attempts for %s without changing unmarked legacy requests', (manufacturerNetworkRevision) => {
    const options = { manufacturerNetwork: true };
    const body = { attemptId, manufacturerNetworkRevision };
    expect(engineRequestBody(execute, body, options)).toEqual(body);
    expect(budgetQuoteRequest(execute, { planId }, body, options)).toEqual({
      operation: 'POST /query-plans/:planId/execute', planId, body,
    });
    expect(engineRequestBody(execute, { attemptId }, options)).toEqual({});
    expect(budgetQuoteRequest(execute, { planId }, { attemptId }, options)).toEqual({ operation: 'POST /query-plans/:planId/execute', planId });
  });

  it.each([null, '', 'manufacturer-network/v3', true, {}])('rejects unsupported revision %j before quoting', (revision) => {
    expect(() => engineRequestBody(execute, { manufacturerNetworkRevision: revision }, enabled)).toThrow();
    expect(() => budgetQuoteRequest(execute, { planId }, { manufacturerNetworkRevision: revision }, enabled)).toThrow();
  });

  it('keeps old unmarked execute hashes and all unrelated quote routes unchanged', () => {
    expect(budgetQuoteRequest(execute, { planId }, {}, enabled)).toEqual({ operation: 'POST /query-plans/:planId/execute', planId });
    expect(budgetQuoteRequest(execute, { planId }, { attemptId }, enabled)).toEqual({
      operation: 'POST /query-plans/:planId/execute', planId, body: { attemptId },
    });
    const icp = BFF_ROUTES.find((route) => route.enginePath === '/companies/:companyId/icps')!;
    expect(budgetQuoteRequest(icp, { companyId: planId }, { attemptId, manufacturerNetworkRevision }, enabled)).toEqual({
      operation: 'POST /companies/:companyId/icps', companyId: planId, body: { attemptId },
    });
  });
});

describe('normal BFF manufacturer execution wiring', () => {
  async function request(featureEnabled: boolean, revision: unknown, legacyAttemptEnabled = true) {
    const issue = vi.fn(async () => 'test-grant');
    const call = vi.fn(async () => ({ status: 202, body: { data: { runId: planId } }, headers: {}, contentType: 'application/json' }));
    const engine = { call, toClientStatus: (status: number) => status, toClientError: (_status: number, body: unknown) => body };
    const handler = new BffHandler(engine as never, { issue } as never, { record: vi.fn(async () => undefined) } as never,
      { current: async () => null } as never,
      { ENGINE_RETRY_ATTEMPT_ID_ENABLED: legacyAttemptEnabled, ENGINE_MANUFACTURER_NETWORK_ENABLED: featureEnabled } as never);
    const body = { attemptId, manufacturerNetworkRevision: revision };
    const tenant = { userId: 'test-user', workspaceId: 'test-workspace', role: 'admin' };
    const req = { method: 'POST', path: `/api/query-plans/${planId}/execute`, originalUrl: `/api/query-plans/${planId}/execute`,
      headers: {}, body, tenant, get: () => undefined };
    const sent: { status?: number; json?: unknown } = {};
    const res = { status(status: number) { sent.status = status; return this; },
      json(value: unknown) { sent.json = value; return this; }, setHeader() {}, type() { return this; }, send() {} };
    await handler.handle(req as never, res as never);
    return { sent, issue, call, body, tenant };
  }

  it('uses the deployment capability for both normal quote and engine dispatch', async () => {
    const result = await request(true, manufacturerNetworkRevision);
    expect(result.sent.status).toBe(202);
    expect(result.issue).toHaveBeenCalledWith(result.tenant, { operation: 'POST /query-plans/:planId/execute', planId, body: result.body });
    expect(result.call).toHaveBeenCalledWith(result.tenant, 'POST', `/query-plans/${planId}/execute`, expect.objectContaining({
      body: result.body, headers: { 'x-execution-budget-grant': 'test-grant' },
    }));
  });

  it.each(['manufacturer-network/v1', 'manufacturer-network/v2'])('keeps %s through the actual handler when legacy flags are off', async (manufacturerNetworkRevision) => {
    const result = await request(true, manufacturerNetworkRevision, false);
    expect(result.sent.status).toBe(202);
    expect(result.issue).toHaveBeenCalledWith(result.tenant, { operation: 'POST /query-plans/:planId/execute', planId, body: result.body });
    expect(result.call).toHaveBeenCalledWith(result.tenant, 'POST', `/query-plans/${planId}/execute`, expect.objectContaining({ body: result.body }));
  });

  it.each([[false, 'manufacturer-network/v1'], [true, 'manufacturer-network/v3']])('rejects unavailable or unsupported execution before quoting (%s, %s)', async (flag, revision) => {
    const result = await request(flag as boolean, revision);
    expect(result.sent.status).toBe(400);
    expect(result.issue).not.toHaveBeenCalled();
    expect(result.call).not.toHaveBeenCalled();
  });
});
