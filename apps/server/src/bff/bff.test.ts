import { afterEach, describe, expect, it, vi } from 'vitest';
import { BffHandler } from './bff.module.js';
import { EngineBudgetQuoteError } from './engine-budget-grant.service.js';
import { EngineHttp } from './engine-http.js';
import { BFF_ROUTES, budgetQuoteRequest } from './routes.js';

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
    const unauthorized = engine.toClientError(401, { error: { code: 'TOKEN_INVALID', message: '' } });
    expect(unauthorized.error.userCopy.title).toContain('授权对接');
    expect(unauthorized.error.userCopy.why).toContain('与你的账号无关');
    const forbidden = engine.toClientError(403, { error: { code: 'SCOPE_REQUIRED', message: '' } });
    expect(forbidden.error.userCopy.title).toContain('授权对接');
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

  it('PRD §2.2 的管理员专属端点必须 access=admin', () => {
    const adminOnly = ['claims/:claimId/approve', 'claims/:claimId/reject', 'claims/:claimId/revoke', 'conflicts/:conflictId/resolve', 'leads/:leadId/sanctions-review', 'reports/weekly', 'data-providers', 'canonical-companies/:id', 'canonical-companies/:id/discover-contacts', 'canonical-companies/:id/guess-emails', 'contact-points/:pointId/verify'];
    for (const path of adminOnly) {
      const route = BFF_ROUTES.find((r) => r.saasPath === path);
      expect(route, path).toBeDefined();
      expect(route!.access, path).toBe('admin');
    }
  });

  it('裁决(accept/reject)对 member 开放(acquisition:review)', () => {
    expect(BFF_ROUTES.find((r) => r.saasPath === 'leads/:leadId/accept')?.access).toBe('member');
    expect(BFF_ROUTES.find((r) => r.saasPath === 'leads/:leadId/reject')?.access).toBe('member');
  });
});

describe('执行预算 quote 映射', () => {
  it('每条 grant:true 路由都能生成引擎 quote body', () => {
    for (const route of BFF_ROUTES.filter((r) => r.grant)) {
      const request = budgetQuoteRequest(
        route,
        { id: 'c', companyId: 'c', icpId: 'i', planId: 'p', leadId: 'l', pointId: 'pt' },
        { website: 'https://x.test' },
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
    const handler = new BffHandler(engine, { issue } as never, { record: vi.fn(async () => undefined) } as never);

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
    const handler = new BffHandler({ call } as never, { issue } as never, audit as never);

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
    const handler = new BffHandler(engine, { issue } as never, audit as never);

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
