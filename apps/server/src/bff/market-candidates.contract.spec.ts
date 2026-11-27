import { Logger } from '@nestjs/common';
import type { components } from '@gain-saas/engine-client';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BffGuard, BffHandler, registerBffMiddleware } from './bff.module.js';
import { EngineHttp } from './engine-http.js';
import { EngineBudgetGrantService } from './engine-budget-grant.service.js';
import { WorkspaceBudgetPolicyService } from './workspace-budget-policy.service.js';
import type { WorkspaceTechnicalQuote } from '../service/engine-budget-grant.signer.js';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { AdminGuard } from '../tenant/admin.guard.js';
import { SESSION_COOKIE } from '../tenant/session.service.js';
import { ENGINE_SPEC_PATH, loadJson } from './openapi-coverage.js';

const pinned = loadJson<{ paths: Record<string, Record<string, { operationId: string }>> }>(ENGINE_SPEC_PATH);

// B1 already exists in the base pin; the regression is the four missing B2 operations.
describe('market candidate complete pinned contract', () => {
  it('retains all five existing B1 operations', () => {
    for (const [method, path] of [
      ['get', '/api/v1/companies/{companyId}/market-candidate-sets/latest'],
      ['get', '/api/v1/market-candidate-sets/{setId}'],
      ['get', '/api/v1/market-candidate-sets/{setId}/revisions'],
      ['get', '/api/v1/market-candidate-sets/{setId}/revisions/{revision}'],
      ['post', '/api/v1/market-candidate-sets/{setId}/candidates/{candidateId}/feedback'],
    ]) expect(pinned.paths[path]?.[method], `${method} ${path}`).toBeDefined();
  });

  it.each([
    ['post', '/api/v1/companies/{companyId}/market-candidate-generations', 'MarketCandidateGenerationsController_prepare_v1'],
    ['get', '/api/v1/market-candidate-generations/{generationId}', 'MarketCandidateGenerationsController_get_v1'],
    ['post', '/api/v1/market-candidate-generations/{generationId}/execute', 'MarketCandidateGenerationsController_execute_v1'],
    ['post', '/api/v1/market-candidate-generations/{generationId}/recover', 'MarketCandidateGenerationsController_recover_v1'],
  ])('contains the generation operation %s %s', (method, path, operationId) => {
    expect(pinned.paths[path]?.[method], `${method} ${path}`).toMatchObject({ operationId });
  });
});


const USER = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const COMPANY = '33333333-3333-4333-8333-333333333333';
const GENERATION = '44444444-4444-4444-8444-444444444444';
const SET = '55555555-5555-4555-8555-555555555555';
const CANDIDATE = '66666666-6666-4666-8666-666666666666';
const OFFERING = '77777777-7777-4777-8777-777777777777';
const INTENT = '88888888-8888-4888-8888-888888888888';
const ALTERNATE = '99999999-9999-4999-8999-999999999999';
const KEY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DIGEST = 'a'.repeat(64);
const INITIAL_HASH = 'b'.repeat(64);
const CURRENT_HASH = 'c'.repeat(64);
const AT = '2026-11-21T00:00:00Z';
type Generation = components['schemas']['MarketCandidateGenerationDto'];

function generation(phase: Generation['phase'] = 'PREPARED', reasonCode: Generation['reasonCode'] = null): Generation {
  return {
    generationId: GENERATION, companyId: COMPANY, intentId: INTENT, intentDigest: DIGEST,
    phase, reasonCode, preparedAt: AT, updatedAt: AT,
    set: phase === 'PERSISTED' ? { setId: SET, revision: 1, documentHash: INITIAL_HASH } : null,
    execution: phase === 'PERSISTED' ? {
      operationId: ALTERNATE, resultSchema: 'market-candidates-generation/v1', resultDigest: DIGEST, ackId: 'e'.repeat(64),
    } : null,
  };
}

const statement = (knowledgeState: components['schemas']['MarketCandidateStatementDto']['knowledgeState'], text: string): components['schemas']['MarketCandidateStatementDto'] => ({
  text, knowledgeState, basisKeys: [`OFFERING:${OFFERING}`], impact: 'synthetic unresolved condition',
});
const candidate: components['schemas']['MarketCandidateDto'] = {
  candidateId: CANDIDATE,
  proposal: {
    supplyOrCapability: { offeringId: OFFERING, description: 'synthetic supply, not a verified buyer' },
    buyerOrganizationCountry: null, projectCountry: 'FR',
    application: statement('INFERENCE', 'synthetic application hypothesis'),
    organizationRole: statement('UNKNOWN', 'organization role is not a named person'),
    fitExplanation: statement('CONFLICT', 'both conflicting source claims remain visible'),
    entryConditions: [statement('UNKNOWN', 'certification not independently verified')],
    support: [statement('SELLER_ASSERTION', 'seller claim'), statement('REVIEWED_SOURCE_FACT', 'source fact, not market validation')],
    counterEvidence: [statement('CONFLICT', 'synthetic counterevidence')],
    gaps: [statement('UNKNOWN', 'missing evidence')],
    recommendation: { status: 'NOT_RECOMMENDED', reason: 'synthetic negative conclusion must not be removed' },
    nextVerification: ['check the source before any independent action'],
  },
  corrections: { buyerOrganizationCountry: null, projectCountry: 'DE' },
  feedback: 'PENDING_EVIDENCE', needsReassessment: true, impactScope: 'UNKNOWN',
};
function revision(empty = false, historical = false, number = 1): components['schemas']['MarketCandidateRevisionDto'] {
  return {
    document: {
      schemaVersion: 'market-candidate-set/v1', setId: SET, companyId: COMPANY, revision: number,
      basisSnapshot: { company: { companyId: COMPANY, version: 1 }, sources: [{
        kind: 'OFFERING', sourceId: OFFERING, key: `OFFERING:${OFFERING}`, version: 1, status: 'ACTIVE',
        digest: 'd'.repeat(64), contentHash: null, parentId: null, parentContentHash: null, position: null, sourceDate: null,
      }] },
      generationOutcome: empty ? 'COMPLETED_EMPTY' : 'CANDIDATES_PROPOSED', candidates: empty ? [] : [candidate],
    },
    documentHash: number === 1 ? INITIAL_HASH : CURRENT_HASH, createdBy: USER, createdAt: AT, historical,
    basisAvailability: [{ key: `OFFERING:${OFFERING}`, status: 'UNAVAILABLE', reason: 'SOURCE_UNAVAILABLE' }],
  };
}
function feedback(action: components['schemas']['MarketCandidateFeedbackInputDto']['action']): components['schemas']['MarketCandidateFeedbackResultDto'] {
  return {
    feedbackId: ALTERNATE, setId: SET, candidateId: CANDIDATE, recordedRevision: 3, documentHash: CURRENT_HASH,
    action, reason: null, correction: action === 'CORRECT' ? { projectCountry: 'DE' } : null,
    before: candidate, after: { ...candidate, feedback: action === 'CORRECT' ? 'CORRECTED' : action === 'CONFIRM' ? 'CONFIRMED' : action === 'REJECT' ? 'REJECTED' : 'PENDING_EVIDENCE' },
    actorId: USER, createdAt: AT, replayed: true, basisAvailability: revision().basisAvailability,
  };
}

interface HarnessOptions {
  language?: string;
  session?: boolean;
  membership?: boolean;
  onboarding?: boolean;
  role?: 'admin' | 'member';
  quoteWorkspace?: string;
  expiredQuote?: boolean;
  denyGeneration?: boolean;
  spent?: number;
  businessFailure?: 'TimeoutError' | 'TypeError';
}

// Real middleware, TenantGuard, BffGuard, handler, budget service, HTTP and quota.
// Only external session/persistence/fetch and the cryptographic issuer boundary are synthetic.
// The issuer double never creates a JWT or a runtime-valid budget grant.
function harness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const wires: Array<{ path: string; method: string; query: Record<string, string>; body: unknown; headers: Record<string, string> }> = [];
  const identityClaims: unknown[] = [];
  const mintedQuotes: WorkspaceTechnicalQuote[] = [];
  let issued = 0;
  let mintAttempts = 0;
  let runQueries = 0;
  let spendQueries = 0;
  let responseStatus = 200;
  let responseBody: unknown = { data: generation() };
  const tx = {
    workspaceBudgetPolicy: { upsert: async () => {
      events.push('quota');
      return { workspaceId: WORKSPACE, windowDays: 30, maxRuns: 1, maxSpendMicros: 1_000_000n, enabled: true };
    } },
    $queryRaw: async () => { events.push('quota-lock'); return [{ lock: 1 }]; },
    discoveryRunLink: { count: async () => { runQueries += 1; return 999; } },
    costLedger: { aggregate: async () => { spendQueries += 1; events.push('spend'); return { _sum: { amountMicros: options.spent ?? 0 } }; } },
  };
  const quotaPrisma = {
    withWorkspace: async (_wid: string, fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const quota = new WorkspaceBudgetPolicyService({
    WORKSPACE_QUOTA_ENFORCE: true, WORKSPACE_QUOTA_WINDOW_DAYS: 30,
    WORKSPACE_QUOTA_MAX_RUNS: 1, WORKSPACE_QUOTA_MAX_SPEND_MICROS: 1_000_000,
  } as never, quotaPrisma as never);
  const engine = new EngineHttp({ ENGINE_ORIGIN: 'http://synthetic-engine.invalid' } as never, {
    mint: async (claims: unknown) => { identityClaims.push(claims); events.push('identity'); return 'synthetic-identity-only'; },
  } as never);
  const budget = new EngineBudgetGrantService(engine, {
    mint: async (quote: WorkspaceTechnicalQuote, workspaceId: string) => {
      mintAttempts += 1; events.push('budget-mint-attempt');
      // Controlled issuer refusal tests the consumer boundary, not real key or signature acceptance.
      if (quote.workspaceId !== workspaceId || Date.parse(quote.expiresAt) <= Date.now()) throw new Error('synthetic issuer rejects invalid quote binding');
      mintedQuotes.push(quote); issued += 1; events.push('budget-issued');
      return 'synthetic-budget-grant-not-valid-at-runtime';
    },
  } as never, quota);
  const issue = vi.spyOn(budget, 'issue'); // Observes the real method; no mock return value.
  const handler = new BffHandler(engine, budget, { record: async () => undefined } as never,
    { history: async () => [] } as never, {
      ENGINE_DISCOVER_ATTEMPT_ID_ENABLED: false, ENGINE_RETRY_ATTEMPT_ID_ENABLED: false, ENGINE_MANUFACTURER_NETWORK_ENABLED: false,
    } as never);
  const claims = { userId: USER, workspaceId: WORKSPACE, role: options.role ?? 'member', jti: 'synthetic-session-id', exp: Math.floor(Date.now() / 1000) + 3600 };
  const tenantPrisma: Record<string, unknown> = {
    membership: { findFirst: async () => options.membership === false ? null : {
      role: options.role ?? 'member', workspace: { status: 'ACTIVE', onboardingCompletedAt: options.onboarding === false ? null : new Date(AT), onboardingCompanyId: COMPANY },
    } },
    withWorkspace: async (_wid: string, fn: (tx: unknown) => Promise<unknown>) => fn(tenantPrisma),
  };
  const tenant = new TenantGuard({ verify: async (token: string) => token === 'synthetic-session' ? claims : null, needsRefresh: () => false } as never, tenantPrisma as never);
  const guard = new BffGuard(tenant, new AdminGuard());
  let middleware!: (req: Request, res: Response, next: () => void) => void;
  registerBffMiddleware({ use: (fn) => { middleware = fn; } }, handler, guard);
  const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== 'http://synthetic-engine.invalid') throw new Error('unexpected synthetic destination');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    const path = url.pathname.replace(/^\/api\/v1/, '');
    wires.push({ path, method: init?.method ?? 'GET', query: Object.fromEntries(url.searchParams), body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (path === '/execution-budget/workspace-technical-quote') {
      events.push('quote');
      const nested = body?.body;
      const valid = body && Object.keys(body).sort().join(',') === 'body,generationId,operation' &&
        body.operation === 'POST /market-candidate-generations/:generationId/execute' &&
        typeof body.generationId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/.test(body.generationId) &&
        nested && typeof nested === 'object' && !Array.isArray(nested) && Object.keys(nested).join(',') === 'intentDigest' &&
        typeof (nested as Record<string, unknown>).intentDigest === 'string' && /^[0-9a-f]{64}$/.test((nested as Record<string, string>).intentDigest);
      if (!valid) return respond(400, { error: { code: 'EXECUTION_BUDGET_REQUEST_INVALID', message: 'synthetic strict closed quote rejection' } });
      if (options.denyGeneration) return respond(403, { error: { code: 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH', message: 'synthetic generation not owned' } });
      const quote: WorkspaceTechnicalQuote = {
        schemaVersion: 'execution-budget-technical-quote/v1', authorityKind: 'WORKSPACE_GRANT',
        operation: 'POST /market-candidate-generations/:generationId/execute', workspaceId: options.quoteWorkspace ?? WORKSPACE,
        purpose: 'market.candidates.generate', subjectType: 'market_candidate_generation', subjectId: String(body!.generationId),
        requestSha256: 'f'.repeat(64), currency: 'USD', unit: 'microusd', requiredCapMicrousd: '800000', policyRevision: 'synthetic-policy/v1',
        expiresAt: new Date(Date.now() + (options.expiredQuote ? -60_000 : 60_000)).toISOString(),
      };
      return respond(200, { data: quote });
    }
    events.push('business');
    if (options.businessFailure) throw Object.assign(new Error('synthetic lost response'), { name: options.businessFailure });
    return respond(responseStatus, responseBody);
  });
  async function request(method: string, path: string, body?: unknown, reply: unknown = { data: generation() }, status = 200) {
    responseBody = reply; responseStatus = status;
    const sent: { status: number; body?: unknown; cleared: string[]; next: number } = { status: 0, cleared: [], next: 0 };
    const headers = { 'accept-language': options.language, 'idempotency-key': KEY, authorization: 'Bearer client-forgery', 'x-execution-budget-grant': 'client-forgery', 'x-workspace-id': ALTERNATE };
    const req = { method, path: path.split('?')[0], originalUrl: path, body, headers,
      cookies: options.session === false ? {} : { [SESSION_COOKIE]: 'synthetic-session' },
      tenant: { userId: ALTERNATE, workspaceId: ALTERNATE, role: 'admin' },
      get: (name: string) => headers[name.toLowerCase() as keyof typeof headers],
    };
    const res = { status(value: number) { sent.status = value; return this; }, json(value: unknown) { sent.body = value; return this; },
      clearCookie(name: string) { sent.cleared.push(name); return this; }, cookie() { return this; }, setHeader() {}, type() { return this; }, send(value: unknown) { sent.body = value; return this; } };
    await middleware(req as never, res as never, () => { sent.next += 1; });
    return sent;
  }
  return { request, events, wires, identityClaims, mintedQuotes, issue,
    counters: () => ({ issued, mintAttempts, runQueries, spendQueries }) };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const nonExecute = [
  ['GET', `/api/companies/${COMPANY}/market-candidate-sets/latest`, undefined, { data: { status: 'AVAILABLE', result: revision() } }],
  ['GET', `/api/market-candidate-sets/${SET}`, undefined, { data: revision() }],
  ['GET', `/api/market-candidate-sets/${SET}/revisions?cursor=3&limit=1`, undefined, { data: { revisions: [{ revision: 2, documentHash: CURRENT_HASH, createdBy: USER, createdAt: AT }], nextCursor: '2' } }],
  ['GET', `/api/market-candidate-sets/${SET}/revisions/1`, undefined, { data: revision(false, true) }],
  ['POST', `/api/market-candidate-sets/${SET}/candidates/${CANDIDATE}/feedback`, { expectedRevision: 2, action: 'CONFIRM' }, { data: feedback('CONFIRM') }],
  ['POST', `/api/companies/${COMPANY}/market-candidate-generations`, { intentId: INTENT }, { data: generation() }],
  ['GET', `/api/market-candidate-generations/${GENERATION}`, undefined, { data: generation('RESULT_UNKNOWN', 'RESULT_UNKNOWN') }],
  ['POST', `/api/market-candidate-generations/${GENERATION}/recover`, {}, { data: generation('PERSISTED') }],
] as const;

describe('real thin market consumer C01-C12', () => {
  it.each(nonExecute)('forwards %s %s without quote, budget issue or spend query', async (method, path, body, reply) => {
    const h = harness(); const sent = await h.request(method, path, body, reply);
    expect(sent.status).toBe(200); expect(sent.body).toEqual(reply); expect(sent.next).toBe(0);
    expect(h.issue).not.toHaveBeenCalled();
    expect(h.wires).toHaveLength(1); expect(h.wires[0].path).toBe(path.split('?')[0].replace(/^\/api/, ''));
    expect(h.wires[0].method).toBe(method); expect(h.wires[0].body).toEqual(body);
    expect(h.wires[0].headers['x-execution-budget-grant']).toBeUndefined();
    expect(h.identityClaims).toEqual([{ subjectId: USER, workspaceId: WORKSPACE, roles: ['saas-member'] }]);
    expect(h.counters()).toEqual({ issued: 0, mintAttempts: 0, runQueries: 0, spendQueries: 0 });
  });

  it.each([GENERATION, ALTERNATE])('executes only the addressed generation with the exact body (%s)', async (id) => {
    const h = harness(); const body = { intentDigest: DIGEST }; const reply = { data: generation('RUNNING') };
    const sent = await h.request('POST', `/api/market-candidate-generations/${id}/execute`, body, reply, 202);
    expect(sent.status).toBe(202); expect(sent.body).toEqual(reply);
    expect(h.wires.map((wire) => wire.path)).toEqual(['/execution-budget/workspace-technical-quote', `/market-candidate-generations/${id}/execute`]);
    expect(h.wires[0].body).toEqual({ operation: 'POST /market-candidate-generations/:generationId/execute', generationId: id, body: { intentDigest: DIGEST } });
    expect(h.wires[1].body).toEqual({ intentDigest: DIGEST });
    expect(h.wires[1].headers['x-execution-budget-grant']).toBe('synthetic-budget-grant-not-valid-at-runtime');
    expect(h.wires[1].headers.authorization).toBe('Bearer synthetic-identity-only');
    expect(h.mintedQuotes[0]).toMatchObject({ workspaceId: WORKSPACE, purpose: 'market.candidates.generate', subjectType: 'market_candidate_generation', subjectId: id, requiredCapMicrousd: '800000' });
    expect(h.counters()).toEqual({ issued: 1, mintAttempts: 1, runQueries: 0, spendQueries: 1 });
    expect(h.identityClaims).toHaveLength(2);
    expect(h.events).toEqual(['identity', 'quote', 'quota', 'quota-lock', 'spend', 'budget-mint-attempt', 'budget-issued', 'identity', 'business']);
  });

  it.each([{ intentDigest: DIGEST, actor: ALTERNATE }, { intentDigest: DIGEST, attemptId: KEY }, { intentDigest: DIGEST, cap: '1' }, {}, { intentDigest: 'A'.repeat(64) }, { intentDigest: 'bad' }, null, undefined])('does not launder invalid execute input %j into an issued grant', async (body) => {
    const h = harness(); const sent = await h.request('POST', `/api/market-candidate-generations/${GENERATION}/execute`, body);
    expect(sent.status).toBe(502); expect(sent.body).toMatchObject({ meta: { engineCode: 'EXECUTION_BUDGET_REQUEST_INVALID' } });
    expect(h.wires).toHaveLength(1); expect(h.wires[0].path).toBe('/execution-budget/workspace-technical-quote');
    if (body && typeof body === 'object') expect((h.wires[0].body as Record<string, unknown>).body).toEqual(body);
    expect(h.counters()).toEqual({ issued: 0, mintAttempts: 0, runQueries: 0, spendQueries: 0 });
  });

  it('passes an invalid generationId to the closed quote and never dispatches execution', async () => {
    const h = harness(); const sent = await h.request('POST', '/api/market-candidate-generations/not-a-uuid/execute', { intentDigest: DIGEST });
    expect(sent.status).toBe(502); expect(h.wires).toHaveLength(1);
    expect(h.wires[0].body).toMatchObject({ generationId: 'not-a-uuid' }); expect(h.counters().issued).toBe(0);
  });

  it('stops at the original engine ownership refusal without minting or forwarding', async () => {
    const h = harness({ denyGeneration: true }); const sent = await h.request('POST', `/api/market-candidate-generations/${ALTERNATE}/execute`, { intentDigest: DIGEST });
    expect(sent.status).toBe(502); expect(sent.body).toMatchObject({ meta: { engineCode: 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH' } });
    expect(h.wires).toHaveLength(1); expect(h.counters().issued).toBe(0);
  });

  it.each([{ quoteWorkspace: ALTERNATE }, { expiredQuote: true }])('honours controlled issuer refusal with zero issued grants %j', async (options) => {
    const h = harness(options); const sent = await h.request('POST', `/api/market-candidate-generations/${GENERATION}/execute`, { intentDigest: DIGEST });
    expect(sent.status).toBe(502); expect(h.wires).toHaveLength(1);
    expect(h.counters()).toEqual({ issued: 0, mintAttempts: 1, runQueries: 0, spendQueries: 1 });
  });

  it('enforces actual workspace spend policy for the new purpose without counting discovery runs', async () => {
    const h = harness({ spent: 1_000_000 }); const sent = await h.request('POST', `/api/market-candidate-generations/${GENERATION}/execute`, { intentDigest: DIGEST });
    expect(sent.status).toBe(402); expect(sent.body).toMatchObject({ error: { code: 'WORKSPACE_BUDGET_EXCEEDED' } });
    expect(h.wires).toHaveLength(1); expect(h.counters()).toEqual({ issued: 0, mintAttempts: 0, runQueries: 0, spendQueries: 1 });
  });

  it.each([{ session: false }, { membership: false }])('uses real ordinary guards before any quote or execution %j', async (options) => {
    const h = harness(options); const sent = await h.request('POST', `/api/market-candidate-generations/${GENERATION}/execute`, { intentDigest: DIGEST });
    expect(sent.status).toBe(401);
    expect(h.wires).toHaveLength(0); expect(h.issue).not.toHaveBeenCalled(); expect(h.counters().issued).toBe(0);
  });

  it('allows authenticated active-workspace member even when onboardingCompleted=false (soft onboarding)', async () => {
    const h = harness({ onboarding: false }); const sent = await h.request('GET', `/api/market-candidate-generations/${GENERATION}`);
    expect(sent.status).toBe(200);
    expect(h.wires).toHaveLength(1);
  });

  it.each(['member', 'admin'] as const)('derives identity from the trusted tenant for %s, not client headers or tenant values', async (role) => {
    const h = harness({ role }); const sent = await h.request('GET', `/api/market-candidate-generations/${GENERATION}`);
    expect(sent.status).toBe(200);
    expect(h.identityClaims).toEqual([{ subjectId: USER, workspaceId: WORKSPACE, roles: [role === 'admin' ? 'saas-admin' : 'saas-member'] }]);
    expect(h.wires[0].headers.authorization).toBe('Bearer synthetic-identity-only');
    expect(h.wires[0].headers['x-workspace-id']).toBeUndefined(); expect(sent.cleared).toEqual([]);
  });

  it.each(['TimeoutError', 'TypeError'] as const)('does not reissue or re-execute after a lost business response (%s)', async (businessFailure) => {
    const h = harness({ businessFailure }); const sent = await h.request('POST', `/api/market-candidate-generations/${GENERATION}/execute`, { intentDigest: DIGEST });
    expect(sent.status).toBe(502); expect(h.wires).toHaveLength(2); expect(h.counters().issued).toBe(1);
    expect(h.wires.filter((wire) => wire.path.endsWith('/execute'))).toHaveLength(1);
  });

  it.each(['CONFIRM', 'CORRECT', 'KEEP_PENDING', 'REJECT'] as const)('preserves feedback %s, original key, expected revision and replay response', async (action) => {
    const h = harness(); const body: components['schemas']['MarketCandidateFeedbackInputDto'] = { expectedRevision: 2, action, reason: null, ...(action === 'CORRECT' ? { correction: { projectCountry: 'DE' } } : {}) };
    const reply = { data: feedback(action) }; const sent = await h.request('POST', `/api/market-candidate-sets/${SET}/candidates/${CANDIDATE}/feedback`, body, reply);
    expect(sent.status).toBe(200); expect(sent.body).toEqual(reply); expect(h.wires[0].body).toEqual(body);
    expect(h.wires[0].headers['idempotency-key']).toBe(KEY); expect(h.wires).toHaveLength(1); expect(h.counters().issued).toBe(0);
  });

  it('preserves cursor, limit, historical data and nextCursor without producing a new generation', async () => {
    const h = harness(); const reply = { data: { revisions: [{ revision: 2, documentHash: CURRENT_HASH, createdBy: USER, createdAt: AT }], nextCursor: '2' } };
    const sent = await h.request('GET', `/api/market-candidate-sets/${SET}/revisions?cursor=3&limit=1`, undefined, reply);
    expect(sent.status).toBe(200); expect(sent.body).toEqual(reply); expect(h.wires[0].query).toEqual({ cursor: '3', limit: '1' });
    const historical = { data: revision(false, true) }; expect((await h.request('GET', `/api/market-candidate-sets/${SET}/revisions/1`, undefined, historical)).body).toEqual(historical);
    expect(h.counters().issued).toBe(0);
  });

  it('keeps the immutable initial generation reference distinct from a later feedback revision', async () => {
    const h = harness(); const initial = { data: generation('PERSISTED') }; const current = { data: revision(false, false, 3) };
    expect((await h.request('GET', `/api/market-candidate-generations/${GENERATION}`, undefined, initial)).body).toEqual(initial);
    expect((await h.request('GET', `/api/market-candidate-sets/${SET}`, undefined, current)).body).toEqual(current);
    expect(initial.data.set).toMatchObject({ revision: 1, documentHash: INITIAL_HASH });
    expect(current.data.document.revision).toBe(3); expect(current.data.documentHash).toBe(CURRENT_HASH); expect(h.counters().issued).toBe(0);
  });

  it.each([{ status: 'NOT_ANALYZED', result: null }, { status: 'AVAILABLE', result: revision(true) }, { status: 'AVAILABLE', result: revision() }])('does not conflate absence, completed empty and candidate content %s', async (data) => {
    const h = harness(); const sent = await h.request('GET', `/api/companies/${COMPANY}/market-candidate-sets/latest`, undefined, { data });
    expect(sent.status).toBe(200); expect(sent.body).toEqual({ data }); expect(h.counters().issued).toBe(0);
  });

  it.each([{ intentId: INTENT }, { intentId: INTENT, offeringIds: [], claimIds: [] }])('does not add selections, country or role while preparing %j', async (body) => {
    const h = harness(); const sent = await h.request('POST', `/api/companies/${COMPANY}/market-candidate-generations`, body);
    expect(sent.status).toBe(200); expect(h.wires[0].body).toEqual(body); expect(h.counters().issued).toBe(0);
  });

  it.each([
    [503, 'RUNTIME_ADMISSION_CLOSED', 'zh-CN', '获客服务暂时无法接受新的操作'],
    [503, 'RUNTIME_ADMISSION_CLOSED', 'en-US', 'The acquisition service cannot accept new actions right now'],
    [409, 'IDEMPOTENCY_CONFLICT', 'zh-CN', '这次操作使用了不同的提交内容'],
    [409, 'IDEMPOTENCY_CONFLICT', 'en-US', 'The request differs from an earlier submission'],
  ] as const)('explains prepare rejection %s %s in %s without starting execution', async (status, code, language, title) => {
    const h = harness({ language });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const sent = await h.request('POST', `/api/companies/${COMPANY}/market-candidate-generations`, { intentId: INTENT }, {
      error: { code, message: 'synthetic prepare rejection' },
    }, status);

    expect(sent.status).toBe(status);
    expect(sent.body).toMatchObject({ error: { code, userCopy: { title } }, meta: { engineCode: code } });
    expect(h.wires).toHaveLength(1);
    expect(h.issue).not.toHaveBeenCalled();
    expect(sent.cleared).toEqual([]);
    expect(warn.mock.calls).toEqual([[
      { path: '/companies/:companyId/market-candidate-generations', status, code },
    ]]);
  });

  it('records only a bounded diagnostic for unregistered upstream failures on prepare', async () => {
    const h = harness();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const rejection = { error: { code: 'SYNTHETIC_UNREGISTERED_CODE', message: 'synthetic upstream detail' } };
    await h.request('POST', `/api/companies/${COMPANY}/market-candidate-generations`, { intentId: INTENT }, rejection, 502);
    await h.request('GET', `/api/market-candidate-generations/${GENERATION}`, undefined, rejection, 502);

    expect(warn.mock.calls).toEqual([[
      { path: '/companies/:companyId/market-candidate-generations', status: 502, code: 'UNKNOWN' },
    ]]);
  });

  it('records a prepare transport failure while leaving execution unstarted', async () => {
    const h = harness({ businessFailure: 'TimeoutError' });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const sent = await h.request('POST', `/api/companies/${COMPANY}/market-candidate-generations`, { intentId: INTENT });

    expect(sent.status).toBe(502);
    expect(sent.body).toMatchObject({ error: { code: 'MODEL_UPSTREAM_UNUSABLE' } });
    expect(h.wires).toHaveLength(1);
    expect(h.issue).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([[
      { path: '/companies/:companyId/market-candidate-generations', status: 502, code: 'MODEL_UPSTREAM_UNUSABLE' },
    ]]);
  });

  it.each([['GET', ''], ['POST', '/recover']] as const)('preserves all generation phases through %s without a budget action', async (method, suffix) => {
    const h = harness();
    for (const [phase, reason, status] of [
      ['PREPARED', null, 200], ['RUNNING', null, 202], ['RESULT_UNKNOWN', 'RESULT_UNKNOWN', 202],
      ['RESULT_READY', 'SAVE_PENDING', 202], ['PERSISTED', null, 200], ['FAILED', 'OUTPUT_INVALID', 200], ['NOT_APPLIED', 'SUPERSEDED', 200],
    ] as const) {
      const reply = { data: generation(phase, reason) }; const sent = await h.request(method, `/api/market-candidate-generations/${GENERATION}${suffix}`, undefined, reply, status);
      expect(sent.status).toBe(status); expect(sent.body).toEqual(reply);
    }
    expect(h.wires).toHaveLength(7); expect(h.counters().issued).toBe(0); expect(h.issue).not.toHaveBeenCalled();
  });

  it.each([401, 403, 409])('retains the established engine error mapping without logout or new execution (%s)', async (status) => {
    const h = harness(); const sent = await h.request('GET', `/api/market-candidate-generations/${GENERATION}`, undefined, { error: { code: 'SYNTHETIC_SAFE_ERROR', message: 'synthetic rejection' } }, status);
    expect(sent.status).toBe(status === 409 ? 409 : 502); expect(sent.body).toMatchObject({ meta: { engineCode: 'SYNTHETIC_SAFE_ERROR', engineMessage: 'synthetic rejection' } });
    expect(sent.cleared).toEqual([]); expect(h.wires).toHaveLength(1); expect(h.counters().issued).toBe(0);
  });
});


describe('market recovery and feedback refusal boundaries', () => {
  it('forwards a nonempty recover body unchanged for the engine to reject, without a budget grant', async () => {
    const h = harness(); const body = { force: true, actor: ALTERNATE };
    const sent = await h.request('POST', `/api/market-candidate-generations/${GENERATION}/recover`, body,
      { error: { code: 'VALIDATION_ERROR', message: 'synthetic nonempty recovery rejected' } }, 400);
    expect(sent.status).toBe(400); expect(sent.body).toMatchObject({ meta: { engineCode: 'VALIDATION_ERROR' } });
    expect(h.wires).toHaveLength(1); expect(h.wires[0].body).toEqual(body); expect(h.issue).not.toHaveBeenCalled(); expect(h.counters().issued).toBe(0);
  });

  it('repeatedly recovers the original unknown operation without preparing or buying another one', async () => {
    const h = harness(); const reply = { data: generation('RESULT_UNKNOWN', 'RESULT_UNKNOWN') };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const sent = await h.request('POST', `/api/market-candidate-generations/${GENERATION}/recover`, {}, reply, 202);
      expect(sent.status).toBe(202); expect(sent.body).toEqual(reply);
    }
    expect(h.wires.map((wire) => wire.path)).toEqual(Array(3).fill(`/market-candidate-generations/${GENERATION}/recover`));
    expect(h.issue).not.toHaveBeenCalled(); expect(h.counters().issued).toBe(0);
  });

  it.each(['VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT'])('does not replace a feedback key or revision after %s', async (code) => {
    const h = harness(); const body = { expectedRevision: 2, action: 'CORRECT', correction: { projectCountry: 'DE' } };
    const sent = await h.request('POST', `/api/market-candidate-sets/${SET}/candidates/${CANDIDATE}/feedback`, body,
      { error: { code, message: 'synthetic conflicting revision or operation' } }, 409);
    expect(sent.status).toBe(409); expect(sent.body).toMatchObject({ meta: { engineCode: code } });
    expect(h.wires).toHaveLength(1); expect(h.wires[0].body).toEqual(body); expect(h.wires[0].headers['idempotency-key']).toBe(KEY);
    expect(h.issue).not.toHaveBeenCalled(); expect(h.counters().issued).toBe(0);
  });
});
