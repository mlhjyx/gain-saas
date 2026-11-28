import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminGuard } from '../tenant/admin.guard.js';
import { SESSION_COOKIE } from '../tenant/session.service.js';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { BffGuard, BffHandler, registerBffMiddleware } from './bff.module.js';
import { EngineBudgetQuoteError } from './engine-budget-grant.service.js';
import { EngineHttp } from './engine-http.js';
import { BFF_ROUTES, budgetQuoteRequest, engineRequestBody } from './routes.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const engine = new EngineHttp({} as never, {} as never);

describe('引擎错误 → 三层文案(PRD §14.4)', () => {
  it('409 SUPPRESSED:禁联文案 + 技术详情进 meta', () => {
    const body = engine.toClientError(409, { error: { code: 'SUPPRESSED', message: 'blocked' } });
    expect(body.error.userCopy.title).toContain('禁联');
    expect(body.error.userCopy.next).toContain('禁联名单');
    expect(body.meta?.engineCode).toBe('SUPPRESSED');
    expect(body.meta?.engineMessage).toBe('blocked');
  });

  it('引擎 401/403 折算为 502 + 对接未就绪文案(绝不能登出用户)', () => {
    expect(engine.toClientStatus(401)).toBe(502);
    expect(engine.toClientStatus(403)).toBe(502);
    expect(engine.toClientStatus(403, { error: { code: 'SCOPE_REQUIRED', message: '' } })).toBe(502);
    expect(engine.toClientStatus(409)).toBe(409);
    const unauthorized = engine.toClientError(401, { error: { code: 'TOKEN_INVALID', message: '' } }, 'zh-CN');
    expect(unauthorized.error.userCopy.title).toBe('服务授权校验暂未通过');
    expect(unauthorized.error.userCopy.why).toContain('不能据此判断你需要重新登录或个人无权');
    expect(unauthorized.error.userCopy.next).not.toContain('你的操作会保留');
    expect(unauthorized.error.userCopy.next).not.toContain('稍后刷新重试即可');
    const forbidden = engine.toClientError(403, { error: { code: 'SCOPE_REQUIRED', message: '' } }, 'en-US');
    expect(forbidden.error.userCopy.title).toBe('Service authorization could not be verified');
    expect(forbidden.error.userCopy.why).toContain('does not show that you need to sign in again');
  });

  it('业务域 403(缺合法性依据)保留 403 + 可执行的合规文案', () => {
    const body = { error: { code: 'CONTACT_DISCOVERY_LAWFUL_BASIS_REQUIRED', message: 'basis required' } };
    expect(engine.toClientStatus(403, body)).toBe(403);
    const client = engine.toClientError(403, body);
    expect(client.error.code).toBe('CONTACT_DISCOVERY_LAWFUL_BASIS_REQUIRED');
    expect(client.error.userCopy.title).toContain('合法性依据');
    expect(client.error.userCopy.next).toContain('发现联系人');
    expect(client.meta?.engineCode).toBe('CONTACT_DISCOVERY_LAWFUL_BASIS_REQUIRED');
  });

  it('执行预算 Grant 的 403 也按业务错误透出,而不是「对接未就绪」', () => {
    for (const code of ['EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH', 'EXECUTION_BUDGET_AUTHORITY_REVOKED']) {
      const body = { error: { code, message: '' } };
      expect(engine.toClientStatus(403, body)).toBe(403);
      expect(engine.toClientError(403, body).error.code).toBe(code);
    }
    expect(engine.toClientError(403, { error: { code: 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH', message: '' } }).error.userCopy.next)
      .toContain('刷新');
  });

  it('未知码走 fallback 且保留技术详情', () => {
    const body = engine.toClientError(500, { error: { code: 'FUTURE_CODE', message: 'boom' } });
    expect(body.error.userCopy.title).toBeTruthy();
    expect(body.meta?.engineCode).toBe('FUTURE_CODE');
  });
});

describe('BFF 路由表(SD7)', () => {
  it('saas 路径不重复(同 method)', () => {
    const seen = new Set<string>();
    for (const r of BFF_ROUTES) {
      const key = `${r.method} ${r.saasPath}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('PRD §2.2 及收紧后的管理员专属端点必须 access=admin', () => {
    const adminOnly: Array<readonly [string, string]> = [
      ['POST', 'claims/:claimId/approve'],
      ['POST', 'claims/:claimId/reject'],
      ['POST', 'claims/:claimId/revoke'],
      ['POST', 'conflicts/:conflictId/resolve'],
      ['POST', 'leads/:leadId/sanctions-review'],
      ['GET', 'canonical-companies/:id'],
      ['POST', 'canonical-companies/:id/discover-contacts'],
      ['POST', 'canonical-companies/:id/enrich-contacts'],
      ['GET', 'canonical-companies/:id/contact-enrichment-results'],
      ['GET', 'canonical-companies/:id/contact-enrichment-results/:operationRef'],
      ['POST', 'canonical-companies/:id/contact-enrichment-results/:operationRef/recover'],
      ['GET', 'canonical-companies/:id/contact-enrichment-quality-facts'],
      ['GET', 'canonical-companies/:id/contact-enrichment-quality-facts/:operationRef'],
      ['POST', 'canonical-companies/:id/guess-emails'],
      ['POST', 'contact-points/:pointId/verify'],
      ['DELETE', 'companies/:companyId'],
      ['DELETE', 'seller-documents/:documentId'],
      ['POST', 'companies/:companyId/confirm'],
      ['DELETE', 'icp-rules/:ruleId'],
      ['GET', 'deletion-requests'],
      ['GET', 'reports/weekly'],
      ['GET', 'reports/battle-csv'],
    ];
    for (const [method, saasPath] of adminOnly) {
      const route = BFF_ROUTES.find((r) => r.method === method && r.saasPath === saasPath);
      expect(route, `${method} ${saasPath}`).toBeDefined();
      expect(route!.access, `${method} ${saasPath}`).toBe('admin');
    }
    expect(BFF_ROUTES.find((r) => r.method === 'GET' && r.saasPath === 'data-providers')).toBeUndefined();
    expect(BFF_ROUTES.find((r) => r.method === 'GET' && r.saasPath === 'discovery-runs/:runId/result-view')?.access).toBe('member');
    expect(BFF_ROUTES.find((r) => r.method === 'POST' && r.saasPath === 'icps/:icpId/feedback/recompute')?.access).toBe('member');
    expect(BFF_ROUTES.find((r) => r.method === 'PATCH' && r.saasPath === 'companies/:companyId')?.access).toBe('member');
    expect(BFF_ROUTES.find((r) => r.method === 'PATCH' && r.saasPath === 'icp-rules/:ruleId')?.access).toBe('member');
  });

  it('BffGuard / registerBffMiddleware 对收紧路由、GET /api/deletion-requests 与联系人补强路由：member 返回 403 ADMIN_REQUIRED，admin 放行', async () => {
    const opRef = 'a'.repeat(64);
    const cases: Array<readonly ['DELETE' | 'POST' | 'GET', string]> = [
      ['DELETE', '/api/companies/c1'],
      ['DELETE', '/api/seller-documents/d1'],
      ['POST', '/api/companies/c1/confirm'],
      ['DELETE', '/api/icp-rules/r1'],
      ['GET', '/api/deletion-requests'],
      ['GET', '/api/canonical-companies/c1/contact-enrichment-results'],
      ['GET', `/api/canonical-companies/c1/contact-enrichment-results/${opRef}`],
      ['POST', `/api/canonical-companies/c1/contact-enrichment-results/${opRef}/recover`],
      ['GET', '/api/canonical-companies/c1/contact-enrichment-quality-facts'],
      ['GET', `/api/canonical-companies/c1/contact-enrichment-quality-facts/${opRef}`],
      ['GET', '/api/reports/weekly'],
    ];
    for (const role of ['member', 'admin'] as const) {
      const call = vi.fn(async () => ({
        status: 200,
        body: { data: { ok: true } },
        contentType: 'application/json',
        headers: {},
      }));
      const handler = new BffHandler(
        { call } as never,
        { issue: vi.fn() } as never,
        { record: vi.fn(async () => undefined) } as never,
        { history: vi.fn() } as never,
        {} as never,
      );
      const claims = {
        userId: '11111111-1111-4111-8111-111111111111',
        workspaceId: '22222222-2222-4222-8222-222222222222',
        role,
        jti: 'jti-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const tenantPrisma: Record<string, unknown> = {
        membership: {
          findFirst: async () => ({
            role,
            workspace: { status: 'ACTIVE', onboardingCompletedAt: new Date(), onboardingCompanyId: 'c1' },
          }),
        },
        withWorkspace: async (_wid: string, fn: (tx: unknown) => Promise<unknown>) => fn(tenantPrisma),
      };
      const tenantGuard = new TenantGuard(
        { verify: async (token: string) => (token === 'tok' ? claims : null), needsRefresh: () => false } as never,
        tenantPrisma as never,
      );
      const guard = new BffGuard(tenantGuard, new AdminGuard());
      let middleware!: (req: unknown, res: unknown, next: () => void) => Promise<void>;
      registerBffMiddleware(
        { use: (fn) => { middleware = fn as typeof middleware; } },
        handler,
        guard,
      );

      for (const [method, path] of cases) {
        call.mockClear();
        const sent: { status?: number; json?: { error?: { code?: string; userCopy?: { title?: string } } } } = {};
        const req = {
          method,
          path,
          originalUrl: path,
          cookies: { [SESSION_COOKIE]: 'tok' },
          headers: {},
          body: method === 'POST' ? {} : undefined,
          get: () => undefined,
        };
        const res = {
          status(code: number) {
            sent.status = code;
            return this;
          },
          json(payload: typeof sent.json) {
            sent.json = payload;
            return this;
          },
          clearCookie: vi.fn(),
          cookie: vi.fn(),
          setHeader: vi.fn(),
          type() {
            return this;
          },
          send: vi.fn(),
        };
        await middleware(req, res, () => undefined);
        if (role === 'member') {
          expect(sent.status, `${role} ${method} ${path}`).toBe(403);
          expect(sent.json?.error?.code).toBe('ADMIN_REQUIRED');
          expect(sent.json?.error?.userCopy?.title).toBeTruthy();
          expect(call).not.toHaveBeenCalled();
        } else {
          expect(sent.status, `${role} ${method} ${path}`).toBe(200);
          expect(call).toHaveBeenCalledTimes(1);
        }
      }
    }
  });

  it('裁决(accept/reject)对 member 开放(acquisition:review)', () => {
    expect(BFF_ROUTES.find((r) => r.saasPath === 'leads/:leadId/accept')?.access).toBe('member');
    expect(BFF_ROUTES.find((r) => r.saasPath === 'leads/:leadId/reject')?.access).toBe('member');
  });

  it('registerBffMiddleware 放行 /api/deletion-mirrors 给 Nest 控制器，且已下线的 GET /api/data-providers 返回 404', async () => {
    const call = vi.fn(async () => ({
      status: 200,
      body: { data: { ok: true } },
      contentType: 'application/json',
      headers: {},
    }));
    const handler = new BffHandler(
      { call } as never,
      { issue: vi.fn() } as never,
      { record: vi.fn(async () => undefined) } as never,
      { history: vi.fn() } as never,
      {} as never,
    );
    const claims = {
      userId: '11111111-1111-4111-8111-111111111111',
      workspaceId: '22222222-2222-4222-8222-222222222222',
      role: 'admin' as const,
      jti: 'jti-1',
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const tenantPrisma: Record<string, unknown> = {
      membership: {
        findFirst: async () => ({
          role: 'admin',
          workspace: { status: 'ACTIVE', onboardingCompletedAt: new Date(), onboardingCompanyId: 'c1' },
        }),
      },
      withWorkspace: async (_wid: string, fn: (tx: unknown) => Promise<unknown>) => fn(tenantPrisma),
    };
    const guard = new BffGuard(
      new TenantGuard(
        { verify: async (token: string) => (token === 'tok' ? claims : null), needsRefresh: () => false } as never,
        tenantPrisma as never,
      ),
      new AdminGuard(),
    );
    let middleware!: (req: unknown, res: unknown, next: () => void) => Promise<void>;
    registerBffMiddleware(
      { use: (fn) => { middleware = fn as typeof middleware; } },
      handler,
      guard,
    );

    const next = vi.fn();
    await middleware(
      { method: 'GET', path: '/api/deletion-mirrors', originalUrl: '/api/deletion-mirrors?limit=20' },
      {},
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(call).not.toHaveBeenCalled();

    const sent: { status?: number; json?: { error?: { code?: string } } } = {};
    const res = {
      status(code: number) {
        sent.status = code;
        return this;
      },
      json(payload: typeof sent.json) {
        sent.json = payload;
        return this;
      },
      clearCookie: vi.fn(),
      cookie: vi.fn(),
      setHeader: vi.fn(),
      type() {
        return this;
      },
      send: vi.fn(),
    };
    await middleware(
      {
        method: 'GET',
        path: '/api/data-providers',
        originalUrl: '/api/data-providers',
        cookies: { [SESSION_COOKIE]: 'tok' },
        headers: {},
        get: () => undefined,
      },
      res,
      vi.fn(),
    );
    expect(sent.status).toBe(404);
    expect(sent.json?.error?.code).toBe('NOT_FOUND');
    expect(call).not.toHaveBeenCalled();
  });
});

describe('执行预算 quote 映射', () => {
  it('每条 grant:true 路由都能生成引擎 quote body', () => {
    for (const route of BFF_ROUTES.filter((r) => r.grant)) {
      const request = budgetQuoteRequest(
        route,
        { id: 'c', companyId: 'c', icpId: 'i', planId: 'p', leadId: 'l', pointId: 'pt', generationId: '11111111-1111-4111-8111-111111111111' },
        route.enginePath === '/market-candidate-generations/:generationId/execute'
          ? { intentDigest: 'a'.repeat(64) }
          : { website: 'https://x.test' },
      );
      expect(request, `${route.method} ${route.enginePath}`).not.toBeNull();
      expect(request!.operation).toContain('/');
    }
  });

  it('决策人写路由把引擎要求的 ID/body 原样绑定进 quote', () => {
    const discover = BFF_ROUTES.find((r) => r.enginePath === '/canonical-companies/:id/discover-contacts')!;
    expect(discover.grant).toBe(true);
    expect(budgetQuoteRequest(discover, { id: 'c-1' }, { lawfulBasis: 'legitimate_interest' })).toEqual({
      operation: 'POST /canonical-companies/:id/discover-contacts',
      companyId: 'c-1',
    });

    // 引擎支持 attemptId 后：每次点击的幂等键并入 quote；旧引擎则从转发体里剥离。
    const discoverBody = {
      lawfulBasis: 'legitimate_interest',
      attemptId: '5a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d',
    };
    expect(
      budgetQuoteRequest(discover, { id: 'c-1' }, discoverBody, { discoverAttemptId: true }),
    ).toEqual({
      operation: 'POST /canonical-companies/:id/discover-contacts',
      companyId: 'c-1',
      body: { attemptId: '5a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d' },
    });
    expect(
      budgetQuoteRequest(discover, { id: 'c-1' }, { lawfulBasis: 'legitimate_interest' }, { discoverAttemptId: true }),
    ).toEqual({
      operation: 'POST /canonical-companies/:id/discover-contacts',
      companyId: 'c-1',
    });
    expect(engineRequestBody(discover, discoverBody)).toEqual({
      lawfulBasis: 'legitimate_interest',
    });
    expect(engineRequestBody(discover, discoverBody, { discoverAttemptId: true })).toEqual(discoverBody);

    const guess = BFF_ROUTES.find((r) => r.enginePath === '/canonical-companies/:id/guess-emails')!;
    const guessBody = { lawfulBasis: 'legitimate_interest', lawfulBasisRef: 'LIA-1', maxContacts: 10 };
    expect(budgetQuoteRequest(guess, { id: 'c-1' }, guessBody)).toEqual({
      operation: 'POST /canonical-companies/:id/guess-emails',
      companyId: 'c-1',
      body: guessBody,
    });

    const verify = BFF_ROUTES.find((r) => r.enginePath === '/contact-points/:pointId/verify')!;
    const verifyBody = { lawfulBasis: 'consent', lawfulBasisRef: 'CONSENT-1', allowPersonalWithoutBasis: false };
    expect(budgetQuoteRequest(verify, { pointId: 'pt-1' }, verifyBody)).toEqual({
      operation: 'POST /contact-points/:pointId/verify',
      pointId: 'pt-1',
      body: verifyBody,
    });
    // 无 body(职能邮箱验证)时不要在 quote 里凭空补 {},否则与业务请求的 requestSha256 不一致。
    expect(budgetQuoteRequest(verify, { pointId: 'pt-1' }, undefined)).toEqual({
      operation: 'POST /contact-points/:pointId/verify',
      pointId: 'pt-1',
    });
  });

  it('POST /companies 透传同一份 body;其它写路由只带 ID', () => {
    const body = { website: 'https://www.hongdamuju.com', name: '宏达' };
    const company = BFF_ROUTES.find((r) => r.method === 'POST' && r.enginePath === '/companies')!;
    expect(budgetQuoteRequest(company, {}, body)).toEqual({ operation: 'POST /companies', body });

    const icp = BFF_ROUTES.find((r) => r.enginePath === '/companies/:companyId/icps')!;
    expect(budgetQuoteRequest(icp, { companyId: 'c-1' }, body)).toEqual({
      operation: 'POST /companies/:companyId/icps',
      companyId: 'c-1',
    });

    const plan = BFF_ROUTES.find((r) => r.enginePath === '/query-plans/:planId/execute')!;
    expect(budgetQuoteRequest(plan, { planId: 'p-1' }, body)).toEqual({
      operation: 'POST /query-plans/:planId/execute',
      planId: 'p-1',
    });
  });

  it('非写路由不生成 quote', () => {
    const read = BFF_ROUTES.find((r) => r.enginePath === '/companies' && r.method === 'GET')!;
    expect(budgetQuoteRequest(read, {}, undefined)).toBeNull();
  });
});

describe('决策人路由的 Grant 接线', () => {
  it('引擎 quote 拒绝时保留原错误码(QUOTE_UNAVAILABLE),不笼统归为 GRANT_FAILED', async () => {
    const engine = new EngineHttp(
      { ENGINE_ORIGIN: 'http://engine.test' } as never,
      { mint: async () => 'token' } as never,
    );
    const issue = vi.fn(async () => {
      throw new EngineBudgetQuoteError(503, {
        error: { code: 'EXECUTION_BUDGET_QUOTE_UNAVAILABLE', message: 'no envelope' },
      });
    });
    const handler = new BffHandler(engine, { issue } as never, { record: vi.fn(async () => undefined) } as never, { current: async () => null } as never, { ENGINE_DISCOVER_ATTEMPT_ID_ENABLED: false } as never);

    const req = {
      method: 'POST',
      path: '/api/canonical-companies/c1/discover-contacts',
      originalUrl: '/api/canonical-companies/c1/discover-contacts',
      body: { lawfulBasis: 'legitimate_interest' },
      tenant: { userId: 'u-1', workspaceId: 'w-1', role: 'admin' },
      get: () => undefined,
    };
    const sent: { status?: number; json?: { error?: { code?: string; userCopy?: { title?: string } } } } = {};
    const res = {
      status(code: number) {
        sent.status = code;
        return this;
      },
      json(payload: typeof sent.json) {
        sent.json = payload;
        return this;
      },
      setHeader: () => undefined,
      type() {
        return this;
      },
      send: () => undefined,
    };

    await handler.handle(req as never, res as never);

    expect(sent.status).toBe(502);
    expect(sent.json?.error?.code).toBe('EXECUTION_BUDGET_QUOTE_UNAVAILABLE');
    expect(sent.json?.error?.userCopy?.title).toContain('执行预算账户');
  });

  it('先按同一份 body 取 quote,再把 Grant 头与同一份 body 透传给引擎', async () => {
    const issue = vi.fn(async () => 'grant-jws');
    const call = vi.fn(async () => ({
      status: 200,
      body: { data: { ok: true } },
      contentType: 'application/json',
      headers: {},
    }));
    const audit = { record: vi.fn(async () => undefined) };
    const handler = new BffHandler({ call } as never, { issue } as never, audit as never, { current: async () => null } as never, { ENGINE_DISCOVER_ATTEMPT_ID_ENABLED: false } as never);

    const body = { lawfulBasis: 'consent', lawfulBasisRef: 'CONSENT-1' };
    const req = {
      method: 'POST',
      path: '/api/contact-points/p1/verify',
      originalUrl: '/api/contact-points/p1/verify',
      body,
      tenant: { userId: 'u-1', workspaceId: 'w-1', role: 'admin' },
      get: () => undefined,
    };
    const sent: { status?: number; json?: unknown } = {};
    const res = {
      status(code: number) {
        sent.status = code;
        return this;
      },
      json(payload: unknown) {
        sent.json = payload;
        return this;
      },
      setHeader: () => undefined,
      type() {
        return this;
      },
      send: () => undefined,
    };

    await handler.handle(req as never, res as never);

    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'w-1', role: 'admin' }),
      { operation: 'POST /contact-points/:pointId/verify', pointId: 'p1', body },
    );
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'w-1' }),
      'POST',
      '/contact-points/p1/verify',
      expect.objectContaining({ body, headers: { 'x-execution-budget-grant': 'grant-jws' } }),
    );
    expect(sent.status).toBe(200);
  });

  it('引擎缺 lawfulBasis 的 403 经 BFF 原样返回,带合规文案而不是 502', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: { code: 'CONTACT_DISCOVERY_LAWFUL_BASIS_REQUIRED', message: 'basis required' },
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const engine = new EngineHttp(
      { ENGINE_ORIGIN: 'http://engine.test' } as never,
      { mint: async () => 'token' } as never,
    );
    const issue = vi.fn(async () => 'grant-jws');
    const audit = { record: vi.fn(async () => undefined) };
    const handler = new BffHandler(engine, { issue } as never, audit as never, { current: async () => null } as never, { ENGINE_DISCOVER_ATTEMPT_ID_ENABLED: false } as never);

    const req = {
      method: 'POST',
      path: '/api/canonical-companies/c1/discover-contacts',
      originalUrl: '/api/canonical-companies/c1/discover-contacts',
      body: { lawfulBasisRef: 'MISSING-BASIS' },
      tenant: { userId: 'u-1', workspaceId: 'w-1', role: 'admin' },
      get: () => undefined,
    };
    const sent: { status?: number; json?: { error?: { code?: string; userCopy?: { title?: string } } } } = {};
    const res = {
      status(code: number) {
        sent.status = code;
        return this;
      },
      json(payload: typeof sent.json) {
        sent.json = payload;
        return this;
      },
      setHeader: () => undefined,
      type() {
        return this;
      },
      send: () => undefined,
    };

    await handler.handle(req as never, res as never);

    expect(sent.status).toBe(403);
    expect(sent.json?.error?.code).toBe('CONTACT_DISCOVERY_LAWFUL_BASIS_REQUIRED');
    expect(sent.json?.error?.userCopy?.title).toContain('合法性依据');
  });
});

describe('资料库上传与文档转 Claim BFF 透传', () => {
  function makeRes() {
    const sent: { status?: number; json?: unknown } = {};
    const res = {
      status(code: number) {
        sent.status = code;
        return this;
      },
      json(payload: unknown) {
        sent.json = payload;
        return this;
      },
      setHeader: () => undefined,
      type() {
        return this;
      },
      send: () => undefined,
    };
    return { res, sent };
  }

  it('PUT .../seller-documents/:documentId/content 以 binaryBody 与 600s timeoutMs 透传', async () => {
    const call = vi.fn(async () => ({
      status: 200,
      body: { data: { id: 'd1', status: 'uploaded' } },
      contentType: 'application/json',
      headers: {},
    }));
    const audit = { record: vi.fn(async () => undefined) };
    const handler = new BffHandler(
      { call } as never,
      { issue: vi.fn() } as never,
      audit as never,
      { history: vi.fn() } as never,
      {} as never,
    );
    const bytes = Buffer.from('%PDF-1.4\ncontent', 'utf8');
    const req = {
      method: 'PUT',
      path: '/api/companies/c1/seller-documents/d1/content',
      originalUrl: '/api/companies/c1/seller-documents/d1/content',
      body: bytes,
      tenant: { userId: 'u-1', workspaceId: 'w-1', role: 'member' },
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/pdf' : undefined),
    };
    const { res, sent } = makeRes();

    await handler.handle(req as never, res as never);

    expect(sent.status).toBe(200);
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'w-1', role: 'member' }),
      'PUT',
      '/companies/c1/seller-documents/d1/content',
      expect.objectContaining({
        binaryBody: bytes,
        binaryContentType: 'application/pdf',
        timeoutMs: 600_000,
      }),
    );
  });

  it('GET .../chunks/:seq、POST .../claim-previews 与 POST .../claim-drafts 无 grant 透传', async () => {
    const call = vi.fn(async () => ({
      status: 200,
      body: { data: { ok: true } },
      contentType: 'application/json',
      headers: {},
    }));
    const issue = vi.fn();
    const audit = { record: vi.fn(async () => undefined) };
    const handler = new BffHandler(
      { call } as never,
      { issue } as never,
      audit as never,
      { history: vi.fn() } as never,
      {} as never,
    );

    const chunkReq = {
      method: 'GET',
      path: '/api/companies/c1/seller-documents/d1/chunks/2',
      originalUrl: '/api/companies/c1/seller-documents/d1/chunks/2',
      tenant: { userId: 'u-1', workspaceId: 'w-1', role: 'member' },
      get: () => undefined,
    };
    const chunkRes = makeRes();
    await handler.handle(chunkReq as never, chunkRes.res as never);
    expect(chunkRes.sent.status).toBe(200);
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'w-1', role: 'member' }),
      'GET',
      '/companies/c1/seller-documents/d1/chunks/2',
      expect.objectContaining({ headers: {} }),
    );

    const previewBody = { reference: 'chunk:2', type: 'certification', statement: 'ISO 9001' };
    const previewReq = {
      method: 'POST',
      path: '/api/companies/c1/seller-documents/d1/claim-previews',
      originalUrl: '/api/companies/c1/seller-documents/d1/claim-previews',
      body: previewBody,
      tenant: { userId: 'u-1', workspaceId: 'w-1', role: 'member' },
      get: () => undefined,
    };
    const previewRes = makeRes();
    await handler.handle(previewReq as never, previewRes.res as never);
    expect(previewRes.sent.status).toBe(200);
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'w-1' }),
      'POST',
      '/companies/c1/seller-documents/d1/claim-previews',
      expect.objectContaining({ body: previewBody, headers: {} }),
    );

    const draftBody = { ...previewBody, requestDigest: 'digest-123' };
    const draftReq = {
      method: 'POST',
      path: '/api/companies/c1/seller-documents/d1/claim-drafts',
      originalUrl: '/api/companies/c1/seller-documents/d1/claim-drafts',
      body: draftBody,
      tenant: { userId: 'u-1', workspaceId: 'w-1', role: 'member' },
      get: (name: string) => (name.toLowerCase() === 'idempotency-key' ? 'idem-1' : undefined),
    };
    const draftRes = makeRes();
    await handler.handle(draftReq as never, draftRes.res as never);
    expect(draftRes.sent.status).toBe(200);
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'w-1' }),
      'POST',
      '/companies/c1/seller-documents/d1/claim-drafts',
      expect.objectContaining({ body: draftBody, headers: { 'idempotency-key': 'idem-1' } }),
    );
    expect(issue).not.toHaveBeenCalled();
  });
});

describe('资料库流式下载代理 (GET /api/seller-documents/:documentId/content)', () => {
  const realFetch = globalThis.fetch;

  function stubEngineFetch(
    handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  ) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.startsWith('http://engine.test')) {
          return handler(url, init);
        }
        return realFetch(input, init);
      }),
    );
  }

  it('openStream 透传查询/鉴权头，200 时直接返回 ReadableStream 不调用 arrayBuffer', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hello-pdf'));
        controller.close();
      },
    });
    const arrayBufferSpy = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 200,
        headers: new Headers({
          'content-type': 'application/pdf',
          'content-disposition': "attachment; filename=\"doc.pdf\"; filename*=UTF-8''doc.pdf",
          'content-length': '9',
        }),
        body: stream,
        arrayBuffer: arrayBufferSpy,
      })),
    );
    const engineHttp = new EngineHttp(
      { ENGINE_ORIGIN: 'http://engine.test' } as never,
      { mint: async () => 'signed-jwt' } as never,
    );
    const result = await engineHttp.openStream(
      { userId: 'u-1', workspaceId: 'w-1', role: 'member' },
      'GET',
      '/seller-documents/doc-1/content',
      { timeoutMs: 180_000 },
    );
    expect(result.status).toBe(200);
    expect(result.bodyStream).toBe(stream);
    expect(arrayBufferSpy).not.toHaveBeenCalled();
  });

  it('真实 HTTP 流式透传：转发字节流与安全响应头', async () => {
    const upstreamChunks = [Buffer.from('%PDF-1.4\n'), Buffer.from('chunk-2')];
    stubEngineFetch(async () => {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const c of upstreamChunks) {
            controller.enqueue(new Uint8Array(c));
            await new Promise((r) => setTimeout(r, 5));
          }
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': "attachment; filename=\"brochure.pdf\"; filename*=UTF-8''%E5%85%AC%E5%8F%B8%E4%BB%8B%E7%BB%8D.pdf",
          'content-length': String(Buffer.concat(upstreamChunks).length),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    });
    const engineHttp = new EngineHttp(
      { ENGINE_ORIGIN: 'http://engine.test' } as never,
      { mint: async () => 'signed-jwt' } as never,
    );
    const handler = new BffHandler(
      engineHttp,
      { issue: vi.fn() } as never,
      { record: vi.fn(async () => undefined) } as never,
      { history: vi.fn() } as never,
      {} as never,
    );

    const app = express();
    app.use((req, res) => {
      req.tenant = { userId: 'u-1', workspaceId: 'w-1', role: 'member', onboardingCompleted: true } as never;
      void handler.handle(req, res);
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/seller-documents/doc-1/content`);
      expect(resp.status).toBe(200);
      expect(resp.headers.get('content-type')).toBe('application/pdf');
      expect(resp.headers.get('content-disposition')).toContain('%E5%85%AC%E5%8F%B8%E4%BB%8B%E7%BB%8D.pdf');
      expect(resp.headers.get('content-length')).toBe(String(Buffer.concat(upstreamChunks).length));
      expect(resp.headers.get('cache-control')).toBe('no-store');
      expect(resp.headers.get('x-content-type-options')).toBe('nosniff');
      const buf = Buffer.from(await resp.arrayBuffer());
      expect(buf.toString('utf8')).toBe('%PDF-1.4\nchunk-2');
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('客户端提前断开连接时中止上游 AbortSignal', async () => {
    let observedSignal: AbortSignal | undefined;
    let aborted = false;
    stubEngineFetch(async (_url, init) => {
      observedSignal = init?.signal ?? undefined;
      observedSignal?.addEventListener('abort', () => {
        aborted = true;
      });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(Buffer.from('first-chunk')));
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    });
    const engineHttp = new EngineHttp(
      { ENGINE_ORIGIN: 'http://engine.test' } as never,
      { mint: async () => 'signed-jwt' } as never,
    );
    const handler = new BffHandler(
      engineHttp,
      { issue: vi.fn() } as never,
      { record: vi.fn(async () => undefined) } as never,
      { history: vi.fn() } as never,
      {} as never,
    );
    const app = express();
    app.use((req, res) => {
      req.tenant = { userId: 'u-1', workspaceId: 'w-1', role: 'member', onboardingCompleted: true } as never;
      void handler.handle(req, res);
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const ac = new AbortController();
      const resp = await fetch(`http://127.0.0.1:${port}/api/seller-documents/doc-1/content`, {
        signal: ac.signal,
      });
      const reader = resp.body!.getReader();
      await reader.read();
      ac.abort();
      await reader.cancel().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 50));
      expect(observedSignal?.aborted || aborted).toBe(true);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    [404, 'NOT_FOUND', 404],
    [409, 'SELLER_DOCUMENT_NOT_READY', 409],
    [503, 'SELLER_DOCUMENTS_STORAGE_UNAVAILABLE', 503],
    [401, 'TOKEN_INVALID', 502],
  ] as const)('上游返回 %i (%s) 时映射为 %i JSON 错误', async (upstreamStatus, code, expectedStatus) => {
    stubEngineFetch(async () =>
      new Response(JSON.stringify({ error: { code, message: 'upstream err' } }), {
        status: upstreamStatus,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const engineHttp = new EngineHttp(
      { ENGINE_ORIGIN: 'http://engine.test' } as never,
      { mint: async () => 'signed-jwt' } as never,
    );
    const handler = new BffHandler(
      engineHttp,
      { issue: vi.fn() } as never,
      { record: vi.fn(async () => undefined) } as never,
      { history: vi.fn() } as never,
      {} as never,
    );
    const app = express();
    app.use((req, res) => {
      req.tenant = { userId: 'u-1', workspaceId: 'w-1', role: 'member', onboardingCompleted: true } as never;
      void handler.handle(req, res);
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/seller-documents/doc-1/content`, {
        headers: { 'accept-language': 'zh-CN' },
      });
      expect(resp.status).toBe(expectedStatus);
      const json = (await resp.json()) as { error?: { code?: string; userCopy?: { title?: string } } };
      expect(json.error?.code).toBe(code);
      expect(json.error?.userCopy?.title).toBeTruthy();
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('headersSent 之后上游流出错时安全销毁响应而不抛 ERR_HTTP_HEADERS_SENT', async () => {
    stubEngineFetch(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(Buffer.from('partial-')));
          setTimeout(() => controller.error(new Error('mid-stream boom')), 10);
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    });
    const engineHttp = new EngineHttp(
      { ENGINE_ORIGIN: 'http://engine.test' } as never,
      { mint: async () => 'signed-jwt' } as never,
    );
    const handler = new BffHandler(
      engineHttp,
      { issue: vi.fn() } as never,
      { record: vi.fn(async () => undefined) } as never,
      { history: vi.fn() } as never,
      {} as never,
    );
    let unhandledError: unknown = null;
    const app = express();
    app.use((req, res) => {
      req.tenant = { userId: 'u-1', workspaceId: 'w-1', role: 'member', onboardingCompleted: true } as never;
      handler.handle(req, res).catch((err) => {
        unhandledError = err;
      });
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/seller-documents/doc-1/content`);
      await resp.arrayBuffer().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 30));
      expect(unhandledError).toBeNull();
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('CSV 报告透传（GET /api/reports/weekly）保留 BOM 与 X-Report-* / Content-Disposition 响应头', async () => {
    const csvBytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('公司名,域名,国家,总分\r\nAcme GmbH,acme.de,DE,0.91\r\n', 'utf8'),
    ]);
    const call = vi.fn(async () => ({
      status: 200,
      body: csvBytes,
      contentType: 'text/csv; charset=utf-8',
      headers: {
        'content-disposition': 'attachment; filename="weekly-report-2026-W48-icp1.csv"',
        'cache-control': 'no-store',
        'x-report-id': 'rep-1',
        'x-report-week': '2026-W48',
        'x-report-rows': '1',
        'x-report-withheld-rights': '0',
        'x-report-withheld-sanctions': '0',
        'x-report-withheld-quarantined': '0',
      },
    }));
    const handler = new BffHandler(
      { call } as never,
      { issue: vi.fn() } as never,
      { record: vi.fn(async () => undefined) } as never,
      { history: vi.fn() } as never,
      {} as never,
    );
    const setHeader = vi.fn();
    const send = vi.fn();
    const res = {
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      setHeader,
      send,
      json: vi.fn(),
    };
    const req = {
      method: 'GET',
      path: '/api/reports/weekly',
      originalUrl: '/api/reports/weekly?icpId=11111111-1111-4111-8111-111111111111',
      headers: {},
      tenant: { userId: 'u-1', workspaceId: 'w-1', role: 'admin' },
      get: () => undefined,
    };
    await handler.handle(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.type).toHaveBeenCalledWith('text/csv; charset=utf-8');
    expect(setHeader).toHaveBeenCalledWith(
      'content-disposition',
      'attachment; filename="weekly-report-2026-W48-icp1.csv"',
    );
    expect(setHeader).toHaveBeenCalledWith('x-report-week', '2026-W48');
    expect(setHeader).toHaveBeenCalledWith('x-report-rows', '1');
    expect(send).toHaveBeenCalledWith(csvBytes);
  });
});
