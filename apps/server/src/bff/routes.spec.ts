import { describe, expect, it } from 'vitest';
import { BFF_ROUTES, budgetQuoteRequest, engineRequestBody } from './routes.js';

describe('understanding retry BFF route', () => {
  const route = BFF_ROUTES.find(
    (candidate) => candidate.saasPath === 'companies/:companyId/understanding/retry',
  );

  it('is registered as a member write that needs an Execution Budget Grant', () => {
    expect(route).toBeDefined();
    expect(route).toMatchObject({
      method: 'POST',
      enginePath: '/companies/:companyId/understanding/retry',
      access: 'member',
      grant: true,
    });
  });

  it('maps to the engine quote operation for the addressed company', () => {
    expect(
      budgetQuoteRequest(route!, { companyId: 'c1' }, {
        attemptId: '5a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d',
      }),
    ).toEqual({
      operation: 'POST /companies/:companyId/understanding/retry',
      companyId: 'c1',
      body: { attemptId: '5a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d' },
    });
  });
});

describe('company profile edit / delete / website candidates BFF routes', () => {
  const find = (method: string, saasPath: string) =>
    BFF_ROUTES.find((route) => route.method === method && route.saasPath === saasPath);

  it('registers PATCH/DELETE companies and a website-candidates search as member routes without grants', () => {
    const patch = find('PATCH', 'companies/:companyId');
    const del = find('DELETE', 'companies/:companyId');
    const candidates = find('POST', 'companies/:companyId/website-candidates');
    expect(patch).toMatchObject({ enginePath: '/companies/:companyId', access: 'member' });
    expect(del).toMatchObject({ enginePath: '/companies/:companyId', access: 'member' });
    expect(candidates).toMatchObject({
      enginePath: '/companies/:companyId/website-candidates',
      access: 'member',
    });
    for (const route of [patch, del, candidates]) {
      expect(route?.grant).toBeUndefined();
      expect(budgetQuoteRequest(route!, { companyId: 'c1' }, {})).toBeNull();
    }
  });
});

describe('seller documents BFF routes', () => {
  const find = (method: string, saasPath: string) =>
    BFF_ROUTES.find((route) => route.method === method && route.saasPath === saasPath);

  it('registers the document lifecycle as member passthroughs without grants', () => {
    const expected: Array<[string, string]> = [
      ['POST', 'companies/:companyId/seller-documents/presign'],
      ['PUT', 'companies/:companyId/seller-documents/:documentId/content'],
      ['POST', 'companies/:companyId/seller-documents/:documentId/commit'],
      ['GET', 'companies/:companyId/seller-documents'],
      ['GET', 'companies/:companyId/seller-documents/search'],
      ['GET', 'seller-documents/:documentId'],
      ['GET', 'seller-documents/:documentId/download-url'],
      ['POST', 'seller-documents/:documentId/retry'],
      ['DELETE', 'seller-documents/:documentId'],
    ];
    for (const [method, saasPath] of expected) {
      const route = find(method, saasPath);
      expect(route, `${method} ${saasPath}`).toMatchObject({ access: 'member' });
      expect(route?.grant).toBeUndefined();
    }
    expect(find('PUT', 'companies/:companyId/seller-documents/:documentId/content')).toMatchObject({
      binary: true,
    });
  });
});

describe('P1 attempt 维度：三类写路由的 attemptId 透传与剥离', () => {
  const find = (saasPath: string) =>
    BFF_ROUTES.find((route) => route.method === 'POST' && route.saasPath === saasPath);
  const ATTEMPT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const cases: Array<[string, Record<string, string>]> = [
    ['companies/:companyId/icps', { companyId: 'c1' }],
    ['icps/:icpId/query-plans', { icpId: 'i1' }],
    ['query-plans/:planId/execute', { planId: 'p1' }],
  ];

  it.each(cases)('quotes the attempt body only when the flag is on (%s)', (saasPath, params) => {
    const route = find(saasPath);
    expect(route).toBeDefined();
    expect(budgetQuoteRequest(route!, params, { attemptId: ATTEMPT })).not.toHaveProperty('body');
    expect(budgetQuoteRequest(route!, params, { attemptId: ATTEMPT }, { writeAttemptId: true })).toMatchObject({
      body: { attemptId: ATTEMPT },
    });
    expect(budgetQuoteRequest(route!, params, {}, { writeAttemptId: true })).not.toHaveProperty('body');
  });

  it('strips attemptId from the forwarded engine body only when the flag is off', () => {
    const route = find('query-plans/:planId/execute');
    const body = { taskRef: { taskId: 't1', taskRunId: 'r1' }, attemptId: ATTEMPT };
    expect(engineRequestBody(route!, body)).toEqual({ taskRef: { taskId: 't1', taskRunId: 'r1' } });
    expect(engineRequestBody(route!, body, { writeAttemptId: true })).toEqual(body);
  });
});
