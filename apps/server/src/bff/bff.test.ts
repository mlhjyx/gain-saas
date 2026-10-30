import { describe, expect, it } from 'vitest';
import { EngineHttp } from './engine-http.js';
import { BFF_ROUTES, budgetQuoteRequest } from './routes.js';

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
    expect(engine.toClientStatus(409)).toBe(409);
    const unauthorized = engine.toClientError(401, { error: { code: 'TOKEN_INVALID', message: '' } });
    expect(unauthorized.error.userCopy.title).toContain('授权对接');
    expect(unauthorized.error.userCopy.why).toContain('与你的账号无关');
    const forbidden = engine.toClientError(403, { error: { code: 'SCOPE_REQUIRED', message: '' } });
    expect(forbidden.error.userCopy.title).toContain('授权对接');
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
    const adminOnly = ['claims/:claimId/approve', 'claims/:claimId/reject', 'claims/:claimId/revoke', 'conflicts/:conflictId/resolve', 'leads/:leadId/sanctions-review', 'reports/weekly', 'data-providers'];
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
      const request = budgetQuoteRequest(route, { companyId: 'c', icpId: 'i', planId: 'p', leadId: 'l' }, { website: 'https://x.test' });
      expect(request, `${route.method} ${route.enginePath}`).not.toBeNull();
      expect(request!.operation).toContain('/');
    }
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
